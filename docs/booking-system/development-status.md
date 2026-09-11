# Booking V3 — 开发状态

更新：2026-09-11。此页记录实际代码、开发店联调与验证证据；完整范围仍以 `implementation-backlog.md` 为准。

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
| M5 Storefront 首个 slice | Theme App Extension app embed、Home/Programs 共享 mount、公开 Session App Proxy、七日 Browse、Class/Coach 筛选、Details、登录提示、loading/empty/error、移动端布局 | 开发店已授权 App Proxy 并启用 app embed；Home 的真实 Browse/Details/Login UI 已联调，后续交易 UI 规范已冻结；本轮已接服务器 Attempt 与真实占位计算，本轮已交付 31 天 Full Calendar、新 Pass selection/Review；已有 Pass、真实客户登录完成/返回验收及 Checkout 仍未完成 |

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
- Home / Programs × 320/390/430/1440px：8 组真实浏览器 fixture 检查；另覆盖桌面 popup 返回、手机同页返回、手机禁用 storage 后返回。证据位于 `output/playwright/booking-login/results.json`。
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
- Home / Programs 共用 Skyra 登录弹窗。桌面通过用户点击打开 Shopify 官方登录窗口；手机采用同页 Shopify 登录，桌面保留拦截时的同页备选。
- 实现关闭/Escape/背景点击、焦点圈定与归还、重复点击保护、延迟响应取消、失败重试，以及返回后的 Shopify 身份复核。
- 保留原课程、日期和筛选；暂用 30 分钟 sessionStorage UI selection，不能作为登录凭据、Booking Attempt 或 Seat Hold。登录成功只进入现有 Select a Pass 占位状态。
- 修复长课程名使手机筛选框撑出屏幕的问题；改动只在 Booking extension CSS，未改 `shopify-theme/assets/skyra.css`。
- 本轮本地验证：13 个登录接口测试；Home / Programs × 320/390/430/1440px 的浏览器 fixture 检查（弹窗、键盘、取消、延迟响应、重试、返回恢复、无横向溢出），另含桌面 popup / 手机同页登录的模拟跳转返回；TypeScript、ESLint、生产构建；Shopify 官方 extension 5 文件校验。
- 浏览器证据位于 `output/playwright/booking-login/`，这些是带测试数据的本地 UI 检查，不能当作真实 Shopify 登录成功或下单成功的证据。
- 当前没有运行中的 9292 本地主题预览；本轮尚未重启开发店登录联调、部署正式店、Git commit 或 push。

## 下一阶段执行顺序

1. M3-09 / M3-10：实现 Entitlement grant/reserve/consume/release ledger、余额/有效期/服务匹配与 Intro 资格。当前基础 Hold 不能代替已有 Pass 确认。
2. M5-04 / M5-05：Full Calendar 与 Programs 共享视觉已完成；补直接前后周导航、完整 policy、关闭/未开放文案及 Details 返回位置验收。
3. M5-07 / M5-08：新 Pass 实时本地同步价格与 Review 双栏/单栏 UI 已完成；接已有 Pass 余额/有效期、Drop-in、Customer 摘要及最终 Shopify 可售资格校验。
4. M5-09：已有 Pass 原子确认、credit reserve、Booking 事件与 CONFIRMED；不走 A$0 Checkout。
5. M4 + M5-10 / M5-11：Review 后创建 Hold + Shopify Cart，接入 `orders/paid`、Entitlement、确认/过期付款恢复与 Needs Attention。
6. M5-06 / M5-13：启动开发店 App/Theme 联调，实测真实客户登录/退出、跨域 cookie/弹窗返回，创建 Programs 页面资源并完成两入口 E2E。当前 HTTP 和浏览器 fixture 不能替代这一验收。

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
