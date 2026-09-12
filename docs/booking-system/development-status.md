# Booking V3 — 开发状态

更新：2026-09-12。此页记录实际代码、开发店联调与验证证据；完整范围仍以 `implementation-backlog.md` 为准。

最新状态：commerce readiness 已以 `eb1fd6a` 推送且 CI 成功。下一轮已完成 Review → Hold → Cart 的内部安全编排和 BookingCheckout 数据约束；200 项测试、类型/lint/构建通过。公开 Checkout 路由仍由能力开关关闭，开发店未创建真实 Cart/订单、未收款。下一步先实现 orders/paid 幂等处理、Booking 确认与付款后恢复，再开放前端 Checkout。Continue with Shop 真实账户复测仍未完成。

## 已创建与已绑定

- Shopify App：**Skyra Booking**，组织 Skyra（232832637）。
- Client ID：`c9d266a38e2f11a1240139974253b3a1`；这是公开标识，不是 Secret。
- 开发店：`skyra-booking-dev.myshopify.com`，App 已安装并完成离线/在线 OAuth 会话交换。
- 已发布 App 配置版本 `v3-m1-20260909-3`，包含权限、Product Metafield 定义和 Theme App Extension。
- `booking-app/`：官方 Shopify React Router + TypeScript 工程；PostgreSQL 17、Redis 7 使用独立本地容器。

## 已完成代码

| 范围 | 已完成 | 当前边界 |
| --- | --- | --- |
| M1 工程 | Prisma schema/migration、测试库、seed、连接池、官方 Admin 认证、店主初始化 ADMIN、RBAC、审计、健康接口、Redis/BullMQ Worker、根目录 CI | Customer JWT、Coach OTP、托管环境、监控和备份未完成 |
| M2 Classes & Passes | Class/Pass 创建与编辑、跨店校验、Coach/Location、Coach 与 Pass eligibility、乐观版本检查 | Category/Resource、Appointment/Course 完整表单未完成；Admin iframe 尚未做完整人工视觉验收 |
| M2 商品同步 | 事务 Outbox、`productSet`、稳定 Product/Variant 映射、`metafieldsSet`、app-owned Service content definition 自愈、Metaobject upsert/read-back、重试和状态刷新 | Coach public Metaobject 与 `products/update` 对账尚未实现 |
| M2 Weekly Schedule | 按周日期/时间/教练、草稿、发布、删除草稿、4/8/13 周生成、复制上周、时区/DST 校验 | 持久化 Series 编辑、资源分配、Appointment slots、教练可用时间例外未完成 |
| M5 Storefront 首个 slice | Theme App Extension app embed、Home/Programs 共享 mount、公开 Session App Proxy、七日 Browse、Class/Coach 筛选、Details、登录提示、loading/empty/error、移动端布局 | 开发店已授权 App Proxy 并启用 app embed；Home 的真实 Browse/Details/Login UI 已联调，后续交易 UI 规范已冻结；本轮已接服务器 Attempt 与真实占位计算，本轮已交付 31 天 Full Calendar、新 Pass / Drop-in selection/Review；已有 Pass、真实客户登录完成/返回验收及 Checkout 仍未完成 |

## 本轮交付：M3 Class Booking 基础（2026-09-10）

- 新增 CustomerProfile、BookingAttempt、BookingHold、Booking 容量投影表；新增迁移已应用到独立测试库和本地开发库。没有改变正式数据库。
- Attempt：32 字节随机 opaque token，数据库仅存 SHA-256；HOME / PROGRAMS 固定返回路径；默认 30 分钟恢复窗口；登录后原子绑定 Shopify Customer，绑定后不可换人、换店或换场次。
- 前端：Book 调用签名 App Proxy `/start`；登录返回用 `/attempt` 从服务器恢复课程、状态与当前容量。浏览器只缓存恢复 token，日期/筛选仍可本地保存，但不能作为预约或身份依据。即使 sessionStorage 被禁用，同页登录仍可通过返回 URL 恢复。
- Availability：`capacity − CONFIRMED Booking − 尚未到期的 ACTIVE Hold`，不再显示 capacity 原值；接口 no-store；服务端校验提前 14 天开放、开课前 2 小时关闭及地点时区/DST。
- Hold：已登录、已绑定的客户才能调用内部创建服务；校验店铺开关、适用且已同步的 Pass、有效期。占位 15 分钟；重复请求复用原 Hold 且不延长截止时间；同客户同场次不能重复占位。
- 防超售：请求事务按 Session → Attempt 顺序加锁；数据库触发器覆盖 Hold/Booking 直接写入、同客户重复预约和容量下调。跨店外键、不可换绑约束和追加式审计同时生效。
- 过期/释放：到期 Hold 立即不计入名额，Worker 每 30 秒标记到期并写审计；释放可重试且不重复计数。当前只实现 Attempt/Hold 事件，完整 Booking 事件与权益账本尚未完成。

**当前边界：** Hold 是内部 commerce primitive，尚无公开创建 Hold/Checkout 的入口；真实开发店 `onlineBookingsEnabled=false`。登录、浏览、创建 Attempt 不占座、不扣次。Booking 表目前只提供容量投影，不能等同于已经实现下单确认。Intro Pass 历史资格在权益账本完成前拒绝占位；Shopify 商品实时购买资格最终仍需 M4 校验。

### 本轮验证证据

- `npm run test:db`：57 项通过，其中新增 17 项真实 PostgreSQL Booking Engine 测试、9 项 App Proxy transport 测试；原 18 项基础集成测试与 13 项登录测试保持通过。
- 20 个客户同时抢最后 1 个名额：仅 1 个 Hold 成功。20 个直接数据库 Booking 写入：同样仅 1 个成功。20 次相同请求：返回同一个 Hold，15 分钟到期时间一致。
- 跨店/跨客户、两个客户抢同一匿名 Attempt、重复请求、过期未清理、过期重试、手动释放、关闭窗口、DST、无效 Pass、未开启预约和不可变绑定均有覆盖。
- 生产构建后的 HTTP 冒烟通过真实 Shopify SDK 验签：错误签名 400、匿名 start、签名身份绑定、跨客户 403、禁止伪造输入、真实 Hold 对 availability 的影响和 Hold 恢复。使用的是本地测试签名及测试店铺，不是开发店托管登录联调。
- Home / Programs × 320/390/430/1440px：8 组真实浏览器 fixture 检查；登录 hand-off 更新后另覆盖桌面同页返回、手机同页返回、禁用 storage 后返回及本地预览 canonical shop/preview-theme return，共 12 个场景。证据位于 `output/playwright/booking-login/results.json`。
- TypeScript、ESLint、生产构建及 Shopify 官方 Theme App Extension 6 文件校验通过；booking.js、login.js、attempt.js 均低于 10,000 B。
- 本地开发店预约开关仍关闭，未创建开发店活动 Hold；未部署 Shopify 新版本或正式主题，未 commit/push，现有 `shopify-theme/assets/skyra.css` 校验和保持不变。

## Shopify 开发店联调结果

- 真实 Admin 认证请求通过；Shop 状态为 ACTIVE，店主 ADMIN 初始化成功。
- 新 OAuth Session 实际获授 `write_products`、`write_metaobjects`、`write_metaobject_definitions`、`write_app_proxy`（对应 read 权限由 Shopify 合并授予）。
- Worker 与 Web App 可由 `shopify app dev` 同时启动；补齐 BullMQ 6 所需的 `ioredis` 运行时依赖。
- Worker 冒烟测试：Service 保存版本 `10` 异步同步为 Shopify 版本 `10`，状态 `SYNCED`，Product GID 保持稳定。
- Service 最终映射：Product `gid://shopify/Product/10798362362148`，Variant `gid://shopify/ProductVariant/56232880144676`，价格 A$49，ACTIVE。
- Pass 最终映射：Product `gid://shopify/Product/10798362427684`，Variant `gid://shopify/ProductVariant/56232880210212`，价格 A$220，ACTIVE。
- app-owned Service content definition 已创建并读回：`app--420648878081--booking_service_content_v1`；Metaobject upsert/read-back 已随 Service 同步通过。
- 两个测试商品都以 `[DEV]` 开头，只存在于开发店；未写入正式店。

## 之前阶段验证记录（保留历史边界）

- 18 项 PostgreSQL 集成测试通过；测试库被强制限制为 `skyra_booking_test`。
- 20 个重叠排课并发请求只有 1 个成功；该测试验证排课冲突，不代表最后一个 Booking 名额争抢。
- 跨店引用、Coach 权限、过期版本、重复 Session、复制上周、整批回滚、不可变审计和悉尼 DST 测试通过。
- Outbox 旧版本跳过、失败记录、definition 缺失创建、同步重放幂等测试通过。
- TypeScript、ESLint、生产 build、Shopify config validate、App build 和 Theme Check 通过。最新 storefront 改动再次通过完整主题 369 文件和 extension 2 文件的本地 Theme Check。
- 7 份 Shopify Admin GraphQL operations 已使用官方 schema validator 校验。
- npm audit：0 vulnerabilities。
- Home 开发主题已完成真实浏览器联调：Browse 读取公开 Session、日期切换显示测试课程、Details 与登录提示均在原 section 内切换；390px 视口无横向溢出。Programs 模板代码已接入共享 mount，但开发店尚未创建 `/pages/programs` 页面资源。
- Theme extension 发布 JS 由可维护源码构建；登录阶段拆为 booking.js 与 login.js；当前新增 attempt.js，各自通过 Shopify 的 10,000 B 文件限制。
- 开发数据已通过 Schedule service 创建并发布一节 [DEV] Aerial Foundations Session，时间为 2026-09-10 18:30 Australia/Sydney。
- GitHub CI 尚未远程执行。

## M0 规则状态

Class Booking 开发基线已于 2026-09-09 确认：

1. 最早提前 14 天预约，开课前 2 小时停止预约。
2. 开课前 12 小时可免费取消并恢复预留次数。
3. Late Cancel / No-show 扣除次数。
4. Pass 从购买日开始有效，上课日期必须处于有效期内。
5. 新 Pass Checkout 创建 15 分钟 Seat Hold。
6. 付款完成但 Hold 已失效时禁止超卖；有空位则安全确认，满员则进入 Needs Attention。
7. 确认预约时 reserve；完成、Late Cancel 或 No-show 时 consume；免费取消时 release。

Appointment 审批方式、Any available coach、通知时间与初始 Service ↔ Pass 商品范围将在相应模块开始前确认；这些项目不阻塞 Class Booking Engine 开发。

## 本轮确认的前端范围

- 本轮截图用于 Home / Programs 内嵌 Booking 下单模块，不用于 Customer Account 的 My Bookings、My Passes 或历史页面。
- BROWSE 以现有 Programs 的 Find a Class 为视觉基线：月/七日日期条、筛选、Full calendar、课程行、Show details 和 Book。
- PASS_SELECTION 采用 Pass cards + Booking Details 双栏桌面结构；REVIEW 采用 Customer + Booking + Pass/价格摘要。两者都在当前 Booking section 内切换。
- Existing Pass 不进入 A$0 Checkout；New Pass/Drop-in 在 REVIEW 确认后创建 15 分钟 Hold，再进入原生 Shopify Checkout。
- 手机端使用单列、横滑日期条、全宽 Book/Continue、可折叠 Booking Details、44px touch targets 和零横向溢出。
- 参考图中的 Mindbody 品牌、独立页面假设和支付表单不会进入 Skyra 实现。

## 上一阶段登录校验交付（2026-09-09，历史记录）

以下是上一阶段状态；sessionStorage-only 恢复已被上方 2026-09-10 的服务器 Attempt 替代。

- 新增 `GET /apps/skyra-booking/auth`：先验证 Shopify App Proxy 签名，再读取 `logged_in_customer_id`；只返回 authenticated boolean，private/no-store，拒绝重复身份参数和不可用店铺。
- 修正此前前端从公开 Session 响应读取不存在的 authenticated 字段的问题；每次 Book / Details Continue 都独立校验最新 Shopify 登录。
- Home / Programs 共用 Skyra 登录 modal。此历史实现原为桌面弹窗、手机同页；2026-09-12 已被文末记录的全端同页顶层 Shopify hand-off 取代。
- 实现关闭/Escape/背景点击、焦点圈定与归还、重复点击保护、延迟响应取消、失败重试，以及返回后的 Shopify 身份复核。
- 保留原课程、日期和筛选；暂用 30 分钟 sessionStorage UI selection，不能作为登录凭据、Booking Attempt 或 Seat Hold。登录成功只进入现有 Select a Pass 占位状态。
- 修复长课程名使手机筛选框撑出屏幕的问题；改动只在 Booking extension CSS，未改 `shopify-theme/assets/skyra.css`。
- 本阶段原始验证包含 13 个登录接口测试和桌面弹窗/手机同页 fixture；当前导航合同及最新验证以文末 2026-09-12 登录顶层跳转记录为准。
- 浏览器证据位于 `output/playwright/booking-login/`，这些是带测试数据的本地 UI 检查，不能当作真实 Shopify 登录成功或下单成功的证据。
- 当前没有运行中的 9292 本地主题预览；本轮尚未重启开发店登录联调、部署正式店、Git commit 或 push。

## 下一阶段执行顺序（2026-09-12 更新）

1. 由用户在当前 Shopify 托管登录页复测 **Continue with Shop**，再验收 Home / Programs 的登录完成、退出和签名返回；Programs Page 已创建，不再重复创建。
2. 登录修复已推送 e8d0b2b，CI 34672286983 通过。可售检查提交/CI 以当前 bookingdev HEAD 为准。
3. M4 + M5-10：开发店商品读取权限、归属恢复及两个测试商品的 Online Store 发布已完成，真实可售检查已通过。继续公开 Review → Hold → Cart/Checkout；交易时仍须重新检查，不能将本次 ready 结果作为持久授权。
4. orders/paid 幂等处理、权益生成、Booking 确认和过期付款恢复；M5-09 已有 Pass 原子确认，不走 A$0 Checkout。
5. Confirmation、付款后 Recovery / Needs Attention；完整链路验收后再开启 onlineBookingsEnabled。

详细交接、证据和启动命令见 [2026-09-12 交接文档](handoff-2026-09-12.md)。

## 后续独立范围

- Customer Account full-page：My Overview、My Passes、Bookings & History、取消/改期和老师留言。
- Coach Portal、签到和老师留言。
- 完整 People/Bookings/Reports、通知、旧系统迁移、托管部署与上线。
上一轮 Theme App Extension 的开发预览曾用 storefront password 启动（本轮未运行）。开发店已批准 `write_app_proxy`，Shopify API 权限检查返回 200，App Proxy 与 app embed 已在 `Development (4a1680-elton)` 主题联调通过。Home/Programs 本地主题代码已替换；正式店未部署，现有未提交的 `shopify-theme/assets/skyra.css` 未修改。没有 Git commit 或 push。
## 2026-09-11 开发交接

- 按用户要求准备独立 `bookingdev` 分支保存当前 Booking 工作；生产店未部署，无关 `shopify-theme/assets/skyra.css` 不纳入提交。
- 已重启开发店 App（含 Worker）和 9292 Theme 预览；Home 可读取真实课表并显示 Details。之前“没有运行中预览”的记录为上一轮状态。
- 已发布 2026-09-12 18:30 的开发测试课 `[DEV] Aerial Foundations`。下一步先由用户体验当前页面，暂不继续未完成交易功能。
- 新增 [开发预览与测试指南](preview-testing.md)，明确手工测试入口、尚未完成的 Pass/Checkout/确认流程，以及 Admin 自动同步 Shopify 商品的职责。

- 提交前复核：57 项测试通过，TypeScript、ESLint、生产构建通过。开发预览默认主题与 Skyra 模板的入口混淆已定位，启动指南已显式指定开发主题。真实 Shopify 登录完成与返回仍待联调验收。

## 本轮交付：共享 UI、Full Calendar、Pass / Review（2026-09-11）

- 已将基础提交 `7c3ff67` 推送至用户指定的 `https://github.com/robber-857/Skyra.git` / `bookingdev`；远程 SHA 与本地一致。
- 修复 Home 的旧 `.schedule` 两栏父容器，使 Booking 不再只占左栏；两页共用 `skyra-booking-section` 容器、同一个组件和 API。显式隔离首页展示字体，使用 Programs 的衬线标题、圆日期、暖色按钮、横向课表。
- Full Calendar：在区块内按月选择未来 31 天日期，支持跨月，七日条随所选日期切换；超过预约开放期仍由服务端窗口规则拒绝 Book。
- 新增签名 App Proxy `POST /apps/skyra-booking/pass-options`，读取已绑定客户的当前 Attempt；校验跨店/跨客户、过期、课程窗口和名额，只返回适用且 ACTIVE/SYNCED、价格/版本一致、有效期覆盖课程的非 Intro Pass。
- 新 Pass 选择：真实数据库配置的 Pass cards、价格、次数、有效期，未选时 Continue 禁用。Review 再次从服务端验证名额和价格，支持 Edit Pass。桌面主栏加右侧 Booking Details，手机单栏加可折叠 Details。
- 保留登录后的服务器 Attempt token 用于选 Pass 和恢复；浏览器不持有可用于伪造身份/价格的授权字段。
- 当前 `checkoutAvailable=false`，所有选择与 Review 请求均不创建 Hold/Cart，不收款、不扣课，不宣称预约确认；已有 Pass、Intro 历史资格与 Drop-in 尚未接入。
- 验证：61 项数据库/接口单元测试通过；类型、ESLint、生产构建通过；官方 Shopify 扩展 8 文件校验通过（关闭验证遥测）；UI 机械检查无发现。
- 浏览器 fixture：Home/Programs × 320/390/430/1440px，含真实模板父容器、Full Calendar、Review 价格刷新/Edit、禁用 Checkout、登录取消/恢复；另有 3 项模拟登录导航验证。
- 真实开发主题 Home：1440px 内容宽 1082px、390px 内容宽 328px，标题字体正确、课表正常、均无横向溢出。截图与结果在 `output/playwright/booking-live-*`。真实顾客登录后的 Pass/Review 仍需人工 E2E，不以 fixture 代替。
- 开发店 `/pages/programs` 当前仍返回 404：主题模板已就绪，但 Shopify Page 资源尚未创建，未完成该真实入口验收。
- 仅更新开发预览，生产主题未部署；原 `shopify-theme/assets/skyra.css` 修改保持原样、未纳入 Booking 提交。

## 最新交付：预览诊断、翻周与付款前 Recovery（2026-09-11）

- 用户报告 `9292` storefront 502；本轮检查时已自行恢复，未重启进程、修改网络配置或声称修复 Shopify CLI 根因。连续 5 轮 Home / sessions 均为 200；新增诊断又对 9292、9293、sessions 和 Shopify 上游各检查 3 次，均通过。上游根域名仍是 Horizon，不能据此判断 Booking App 正常。
- 新增 `npm run preview:check`，分开检查本地 Theme、App host、签名代理返回的 sessions、Programs Page 与 Shopify 上游；输出所有采样，不隐藏间歇失败。Programs 404 单独标记 `NOT_READY`。
- 新增 `preview:app` / `preview:theme` 命令，固定开发店和主题 `192227082532`。Theme 命令排除原有 `assets/skyra.css` 并使用 `--nodelete`；不启动到发布中的 Horizon。
- Home / Programs 共用月份标题和前后 7 天导航，覆盖未来 31 天、跨月与最后不足一周；首尾按钮禁用。尚未开放的课程显示 `Opens 14 days before`，与已关闭状态区分。
- 修复 Pass / Review 的 `Back to schedule`：现在返回课表并恢复 Book 焦点，保留当前日期和筛选。
- 付款前 Recovery：临时网络/服务错误保留 attempt token 供重试；登录失效提供重新登录；Pass 变更重新选择；满员、过期、不可用或跨账号错误提供重新选课。登录返回收到终态 attempt 时退出登录重试循环，清理失效 token。
- 仍不创建公开 Hold / Cart，不收款、扣课或确认预约。本轮 Recovery 不包含付款后处理，也不等于 Needs Attention 已完成。
- 验证：`npm run check` 通过；最终修改再次 lint 和官方 8 文件扩展校验通过。11 项浏览器 fixture 场景通过，覆盖 Home/Programs × 320/390/430/1440px、3 种登录导航，以及翻周边界、断线恢复、过期、Pass 变更与重新登录。真实 Home 1440/390px 课表正常、无横向溢出。
- Programs 真实入口仍未完成：Shopify Page 资源缺失，CLI `store auth` 的内容权限 OAuth 回调等待超时，未获得页面写入权限、未创建页面；不是代码模板缺失，也不是自动审批拒绝。Page 查询/创建 GraphQL 已通过官方 schema 校验，但没有执行 mutation。

下一阶段：完成开发店 Programs 页面内容授权与 Page 创建 → 两个入口的真实 Shopify 顾客登录/退出/返回验收 → 商品渠道可售校验、Cart/Checkout 交接与 Hold → `orders/paid` 幂等处理和权益台账 → 已有 Pass 原子确认、Confirmation、付款后 Recovery / Needs Attention。保持 `onlineBookingsEnabled=false`，直到完整交易链路验收。

## 最新交付：Programs 入口、Drop-in 与开发网络兼容（2026-09-12）

- Shopify 内容 OAuth 已成功，使用官方 CLI 创建 Page `167140557092`，handle/templateSuffix 均为 `programs`；页面 HTTP 200 且包含共享组件 mount。9 月 11 日记录的 404/授权超时为历史问题，当前已解除；Booking App 正式 scopes 未扩大。
- `/pass-options` 新增 `purchaseKind=DROP_IN` 与 `dropIn` 选项。Service 从 attempt 的 Session 推导，拒绝客户端 Service/Variant/price 字段及 Drop-in 与 passPlanId 混用。只显示 ACTIVE/SYNCED 且价格与版本一致的课程商品。
- UI 将单次课与新 Pass 放在同一选择区，选择键包含 kind 和 id；Review 分别展示单次课说明或次数/有效期，并重新校验服务端价格和可用性。Drop-in 商品变更提供重新选择出口。
- 公开流程仍不创建 Hold/Cart/订单。内部 Hold 随后已支持 Drop-in；最终渠道可售验证、支付与 Booking 确认闭环仍未接入。
- Docker / PostgreSQL / Redis 曾停止，现已恢复。App CLI 曾因 Shopify 开发 GraphQL 连接失败退出，清理了本项目残留 worker 后重启。
- 复现并捕获 `AggregateError ETIMEDOUT`：IPv4 250ms 超时后 IPv6 `ENETUNREACH`。2 秒窗口仍出现失败；IPv4 优先且禁用地址竞速的 10 次独立连接通过。已将官方 Node 兼容参数放入本项目开发脚本和诊断脚本，不修改系统网络/TLS；上游 503 及网络拥塞仍可能影响预览。
- 验证：64 项测试通过（增加 3 个 Drop-in 数据库用例），类型/lint/构建通过；官方 8 文件扩展校验通过，公共 schema 刷新失败时使用官方缓存。11 项浏览器 fixture 场景覆盖双 surface 的 Drop-in repricing/Edit/unavailable 和原有恢复流程。
- 最终 Home/Programs 真实完整页面验证中出现网络加载超时/502；用户反馈网络很卡后，停止连续网络测试、页面刷新并暂缓本轮 GitHub 推送。之前 `743e242` 已推送且 GitHub CI 通过。不能声称本轮真实客户登录、付款或最终网络稳定性已经验收。
- 下一步：网络恢复后验证双入口与真实 Shopify 登录/退出/返回，推送本轮提交；随后接商品渠道可售校验、Drop-in Hold 模型、Cart/Checkout、orders/paid 与权益台账、已有 Pass 确认、付款后 Recovery / Needs Attention。

## 交接完成（2026-09-12）

已整理 [新会话交接文档](handoff-2026-09-12.md)，包含实际完成项、未完成交易链路、测试证据、服务/主题入口、下一步顺序及 Git 保护项。最后启动日志确认 App / Worker 就绪且无待执行迁移。此为启动状态，不代表最终 Shopify 登录或网络稳定性验收；本轮本地提交后暂缓推送。

## 最新交付：Entitlement 台账与 Drop-in Hold 基础（2026-09-12）

- 新增 Entitlement 与不可变 Ledger，使用 available/reserved/consumed 三个 delta 显式完成 grant → reserve → consume/release，支持带原因的 adjust、expire/revoke；Shopify Order + Line Item 来源和每个操作键均幂等。
- 数据库在写 Ledger 时锁定 Entitlement 并拒绝负余额；Ledger UPDATE/DELETE、同一 reservation 重复 reserve 或重复 terminal settlement 均被数据库约束拒绝。内部有效 Pass 查询按店铺/客户/Service/有效期/余额过滤并按最早到期排序。
- Intro 采用保守首次客户规则：已有非待处理权益或非取消 Booking 即不再符合；当前规则已接新 Pass options 与内部 Hold。若业务要细分退款/取消/Drop-in 历史，需在开放交易前确认。
- BookingHold 现在用 purchaseKind 区分 NEW_PASS 与 DROP_IN；Drop-in 不保存客户端 Service/Variant/价格，仍从 Attempt 的 Session → Service 映射验证。原 15 分钟、Session → Attempt 锁顺序、幂等和防超售保持不变。
- `npm.cmd run test:db` 为 71/71，通过权益最后 1 次的 10 路并发、Ledger 不可变/非负、资格/到期排序、Intro、Drop-in Hold 幂等与非法目标；`npm.cmd run check` 的类型、lint、生产构建通过。
- 这些仍是内部后端基础：没有公开 Hold endpoint、Cart/Checkout、orders/paid、Booking 确认、已有 Pass UI/确认或付款后 Recovery；`onlineBookingsEnabled=false`、`checkoutAvailable=false`、`ownedPassesAvailable=false` 保持不变。

## 最新交付：Shopify 登录顶层跳转修复（2026-09-12）

- 用户截图确认已进入 Shopify 托管 Sign in 页面，但反馈紫色 **Continue with Shop** 点击后疑似无响应。该问题已加入流程、Backlog、状态和交接文档；当前状态为“已规避嵌套弹窗风险，待真实账户复测”，不标记为 Shopify 登录已完整验收。
- 移除桌面 `window.open`、窗口关闭轮询和 popup-blocked fallback；Home / Programs、桌面/手机统一由当前标签页打开 Shopify 官方 customer authentication 地址。跳转前继续保存服务器 opaque Attempt，返回后只接受签名 App Proxy 重新验证的身份。
- 修复本地主题预览中相对登录地址落到 `http://127.0.0.1:9292/customer_authentication/login` 并返回 401 的问题。前端现在校验 Liquid 提供的 canonical `*.myshopify.com` 域名，读取 Shopify 运行时 theme id，并把 `preview_theme_id` 安全加入相对 `return_to`。
- 浏览器 fixture 12/12 通过：Home / Programs × 320/390/430/1440、桌面/手机同页返回、禁用 storage 恢复、canonical shop + preview-theme return。真实浏览器已在同一标签页到达 `shopify.com/authentication/.../login`，页面标题为 `Sign in - Skyra Booking Dev`。
- 仍未用用户个人账号完成 **Continue with Shop**、验证码/账户授权、退出和返回后的 `logged_in_customer_id` 验收；这一步需要用户在 Shopify 托管页操作。此次未收款、未创建 Booking，也未打开交易能力开关。

## 最新交付：实时商品可售检查与 Review 防护（2026-09-12）

- 登录修复 e8d0b2b5711611d18e06d02cc7f5ef3636f960dc 已推送 origin/bookingdev，远程 SHA 一致；[CI 34672286983](https://github.com/robber-857/Skyra/actions/runs/34672286983) 通过。
- Classes & Passes 每个商品新增 **Check availability**，只读查询当前 Shopify 数据并给出检查时间与问题。检查本地同步版本、产品/唯一变体映射、App 归属、ACTIVE、Online Store 发布、可售状态、AUD 价格，以及澳洲 Storefront 可见性/价格/配送/订阅/Bundle 限制。
- 客户点击 Pass/Drop-in 的 Continue 时先验证签名身份、Attempt 和资格，再执行实时检查，随后复核 Attempt、课程状态、余位和价格。网络调用不占用 Session/Attempt 数据库锁；结果不持久化为交易授权。列表仍展示同步数据，实际交易入口必须重新检查。
- 新增 npm.cmd run preview:purchasability（可附加 -- -Diagnostics）。固定 Skyra Booking 和开发店，通过 CLI 在子进程中载入 App 环境，官方 SDK 刷新现有离线会话；凭据不输出、不写入 .env。检查不写商品/Cart/Hold；会话刷新会更新本地 Session。
- 真实开发店：两个测试商品 Admin 为 ACTIVE、变体可售、价格 A$49/A$220，但 onlineStoreUrl=null；当前 App 未读到 booking_owner_id/entitlement_kind。Storefront HTTP 400 返回 “Online Store channel is locked.”。后台分别报告 ONLINE_STORE_UNPUBLISHED、OWNER_MISMATCH、STOREFRONT_LOCKED，公开 Review 返回恢复提示。未解除店铺保护、发布商品或重写归属。
- 验证：专用测试库 vitest run 104/104（新增 33 项），覆盖权限隔离、数据库/远端价格变化、上下架、锁定渠道、配送/订阅/Bundle、接口故障、检查期间编辑与课程取消；类型/lint/生产构建通过。Admin 与 Storefront 查询通过官方 schema 校验。12 项浏览器 fixture 是上一轮布局/恢复证据，本轮未宣称真实支付或后台人工视觉验收。
- 无新迁移。公开 Hold/Cart/Checkout、orders/paid、权益发放/预约确认、已有 Pass UI/确认、付款后 Recovery 尚未交付；三个能力开关保持 false。下一轮先解决上述商品/Storefront 阻塞，再继续 Cart。

## 上一轮交付：认证 Storefront 与安全归属恢复（2026-09-12，授权前快照）

- 后台、Review 和开发店诊断改用官方 SDK 的离线认证 Storefront；验证同店铺、离线会话、精确商品读取 scope，缺权限返回 STOREFRONT_ACCESS_REQUIRED，不退回 tokenless。SDK 负责 token 刷新和私有传输，不新增明文凭据配置。
- 新增仅 ADMIN 可用的单商品恢复服务和显式 -RestoreOwnership / -MappingId 脚本参数。先核对 App、店铺、TOML 定义、同步映射、稳定 handle、唯一 Variant 与价格；只补不存在的字段，以 compareDigest:null 防止并发覆盖，回读后写审计；已存在正确值时幂等，无冲突覆盖。
- 真实诊断确认 App Client ID 正确；当前两个 Product Booking 字段定义/值仍未读到，缺 unauthenticated_read_product_listings，两个测试商品未发布 Online Store。只确认 API 当前状态，未断言历史删除原因。新增权益类型检查分别要求 DROP_IN/PACK。
- 验证：139 项测试通过（新增 35），类型/lint/构建通过，4 个最终 GraphQL 操作官方校验通过，现有 TOML CLI 校验 valid=true。无迁移、无主题/浏览器 UI 改动，未重新运行历史浏览器 fixture。
- 待用户确认仅开发店权限和测试商品可见性变更，随后按 [Commerce 配置与恢复](commerce-readiness.md) 操作。本轮未改 scopes、未恢复真实字段、未发布商品、未移除密码，三个交易能力开关保持 false；Cart/Checkout 和真实登录验收仍未完成。
- 上一轮 fa06784 已推送且 CI 34673814637 成功；本轮改动已保存在工作区，未再次 commit/push，不把本地测试当作新的 GitHub CI 结果。

## 最新交付：开发店授权配置与真实可售通过（2026-09-12）

- 用户明确授权仅开发店加商品读取 scope、恢复归属和发布两个测试商品；App dev 配置已应用，未执行全局 App deploy 或正式店部署。原有两个 TOML Product 定义现已读回。
- 新增显式 -RefreshSessionScopes：读取 Shopify 已授予 scopes，核对 App、店铺和离线 Session，只在 accessToken 快照仍一致时更新本地 scope 缓存，不授予权限、不替换/输出 token。
- 两个商品均已恢复 booking_owner_id / entitlement_kind，CAS 防覆盖、回读和 2 条审计通过。只发布到已核对的 Online Store publication 324415521060，未发布到 Shop/POS，未改价格或变体。
- 修复 onlineStoreUrl=null 的发布误报：实际 publishedOnPublication=true 且 publishedAt 有效；运行校验改用 Online Store 发布时间并独立验证认证 AU Storefront。缺失/未来/无效日期或市场不可售仍拒绝；URL 为空的原因未确认。
- 最终检查时间为 05:34:57–58 UTC：Class A$49、Pass A$220 均 ready=true、issues=[]。密码页依旧有效；开发店 onlineBookingsEnabled=false，Hold/Booking 均为 0，Checkout/已有 Pass UI 能力仍关闭。
- 154 项测试通过（139 + scope 缓存 11 + 发布回归 4），类型/lint/生产构建通过；最终 8 个 GraphQL 操作官方脚本校验通过，TOML valid=true。无迁移或前端资源改动。Home/Programs/API 单次 HTTP 200，双页面有 Booking mount；不是浏览器/真实登录 E2E。
- 下一项 M4-01/M5-10 为 Review → 公开 Hold → Cart/Checkout，之后 paid webhook、权益与 Booking 确认、已有 Pass/付款后恢复。Continue with Shop 真实账号完成/退出/签名返回仍未验收。
- 开发文档、流程、进度、交接和预览指南已同步更新；本轮修改未 commit/push，远程仍以已推送 fa06784 为基线。

## 最新交付：Hold → Shopify Cart 内部安全编排（2026-09-12）

- 上一轮 22 个 commerce readiness 文件已提交 `eb1fd6a7bf9941d27e6635d8b8923e226857b20b` 并推送 `origin/bookingdev`；远程 ref 一致，[CI 34676536279](https://github.com/robber-857/Skyra/actions/runs/34676536279) 成功。
- 新增 BookingCheckout 表与迁移，冻结 shop/Hold/ProductMapping/Product/Variant/价格/catalog fingerprint。每个 Hold 只能有一个创建记录，状态只允许 CREATING → READY/UNKNOWN/REJECTED/INVALIDATED；上下文、已知 Cart ID 和历史删除均受数据库保护。
- 内部 `prepareBookingCheckout` 串联实时商品检查、15 分钟 Hold、`cartCreate`、完整响应核对和已知 Cart 回读。网络请求不持锁；返回后重新检查身份、课程窗口、容量、Pass/Drop-in 资格与版本。重复请求复用原 Hold 和 Cart，不延长截止时间。
- Cart line 只写服务器随机 `_skyra_booking_ref`，不含 Customer GID/PII，也不复用浏览器 Attempt token；完整 Cart ID 含 secret，仅服务器保存，API/审计不返回。创建结果未知时禁止自动二次创建。
- 新增签名 `/apps/skyra-booking/checkout` 路由，但 `checkoutAvailable=false` 在调用编排前拒绝；`onlineBookingsEnabled=false` 和 `ownedPassesAvailable=false` 不变。因此本轮没有真实 Cart、Checkout、Hold、订单、扣课或 Booking。
- 专用测试库 200 项串行通过（原 154 + 新增 46）；新覆盖 NEW_PASS/DROP_IN、10 路并发、两客户最后一席、跨店/跨账号、恶意输入、响应变更、超时和数据库不可变。`npm.cmd run check`、Prisma validate、两项 Storefront GraphQL 官方校验通过。迁移已应用测试库和本地开发库。
- App/Worker 和 9292 Theme 预览已恢复；本轮无主题前端改动、无 App deploy 或正式店变更。本轮 Cart 修改及文档尚未 commit/push。
