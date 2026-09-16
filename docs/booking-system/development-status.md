# Booking V3 — 开发状态

## 最新：发布前收口复核（2026-09-16）

专用测试库全量回归现为 **35 个文件 / 379 项全部通过**；完整 check、Worker build、Coach 与注册/Reports 的 390px / 1440px 浏览器模拟和标准 ZIP 读取均通过。Render Dev 只读诊断已确认 Karen 为 `ACTIVE` Coach，且绑定的 `[DEV] Aerial Foundations` 已 `PUBLISHED`；People 的 Add coach 没有失败。提交 `06468757b36688826519b516b25996f8a2f3f57b` 已推送，CI `35080110796` success，Render deploy `dep-dal64seq1p3s73ekc8bg` Live，015–019 与 Web/Worker/health 验证通过。真实事务邮件仍未配置/发送，Karen 真实收件登录、Customer 真实账号和支付闭环仍未签收。最新证据与正式发布前清单见 [Coach、Reports 与正式发布前收口](release-readiness-2026-09-16.md)；下方同日较早数字与 Karen 未核验结论均为历史快照。

## 最新：Coach 自助身份与邮件投递代码（2026-09-16，本地）

本地已实现 Admin 授权独立 loginEmail → Coach 自助申请邮件链接 → 首次验证自动激活/后续无密码登录，邮箱变更撤销旧链接/session；未知邮箱无权限。可选 Resend transport、加密登录 outbox、Worker 登录与 Coach/Admin Booking 邮件投递代码已接，但发信默认关闭，provider/DNS/secrets 和 Customer protected email resolver 未配置，未发送真实邮件。迁移 018 已应用本地开发库/测试库，未应用 Render；33 文件/371 项测试、check、390/1440px fixture smoke 通过。原 Dev/Karen DB 与部署 SHA 未直接核验，用户截图课程是 DRAFT；未发布课程、commit/push/deploy。详见 [最新实施与未完成清单](coach-self-service-and-email-2026-09-16.md)。下方旧身份结论仅为历史快照，以本节为准。

## 2026-09-16：Coach/Admin Booking 通知、Admin Overview 与 Reports（本地）

Booking confirmation 已从 Customer + Coach 扩展为 Customer + 对应 Coach + Admin 三条幂等通知。Coach Portal 与 Admin Overview 新增持久站内通知、未读状态和 Booking 入口；People/Settings 可保存 Coach notification email 与 Admin operations email。地址配置与登录身份分离，正式邮件 provider、Worker 投递和真实收件验收仍未接，当前 PENDING 只表示任务已建立。

Admin Overview 已按运营设计实现今日课程/容量、待处理付款事件、30 天到期 Pass、今日课表、到期明细、站内通知与 No-show credit returned。Reports 已实现日期与 Customer 筛选、validated booking spend、NEW_PASS revenue、逐 Customer 明细、逐 Pass purchased/used/remaining/expiry 及两类 CSV；Refund 和全店 Shopify 财务同步尚未实现，页面明确标记 Not synced。

迁移 015/016/017 已应用本地开发库和专用测试库，未应用 Render。`npm.cmd run check` 通过；专用测试库 32 文件/363 项通过；390px/1440px production-build Coach smoke 覆盖站内通知、周日历、Training profile、No-show credit release、退出与无横向溢出，`pageErrors=[]`。当前本地开发库没有 Karen，只有 Development Coach（3 个 Session），因此不能把 fixture smoke 写成 Karen 的真实 UAT。完整实施/未完成清单见 [Coach/Admin 通知、Overview 与 Reports](coach-admin-notifications-reports-2026-09-16.md)。

## 2026-09-16：身份、登录与主页邮箱边界（已核对）

当前没有一套混合的“Skyra 注册”：Customer、Coach、Admin 和 newsletter 是四条独立链路。Customer 使用 Shopify Customer Accounts 的邮箱一次性验证码；新邮箱首次成功登录时由 Shopify 自动建立 Customer profile，Booking App 只在验证 session token 后按 Customer GID 建立最小投影。主页 `Join community` 使用 Liquid `customer` newsletter form，会建立/更新 Shopify Customer profile 和营销订阅，但不验证登录、不创建 Booking/Pass，也不授予 Coach 权限。

Coach 当前也不是自助注册。Admin 在 People 创建的 `Coach` 只有 public name、状态和 buffer，没有 email；开发店 Admin 可以生成 15 分钟单次测试链接，兑换为最长 8 小时 session。正式 Coach email、邀请/重发/撤销、provider 与真实收件 UAT 尚未实现。正式产品方向应保持 Admin 邀请已存在 Coach、Coach 不自助注册，也不复用 Shopify Customer Account 或 Shopify Admin 权限。

完整现状、代码入口、已完成/未完成及 newsletter 关系见 [身份、登录与主页邮箱关系](identity-login-and-email.md)。本轮只补开发文档，没有修改 live storefront 文案、数据库 schema、Coach 正式认证或部署配置。

## 2026-09-16：Coach 周课表、Training profile 与 No-show（本地）

Coach Portal 已按最新产品范围收敛为两个顶层入口：Today 与 My schedule。`/coach` 和 `/coach/classes/:id` 共用桌面/手机外壳、Coach 身份、退出与服务端本人范围授权；Roster 继续从具体 Session 进入。My schedule 的 Week 视图现在是 Monday–Sunday 七列周日历，支持前后翻周；手机降级为逐日日程。Month 与自定义日期范围保留为列表视图。

Session roster 只读取 Booking App Training profile 所需的 preferred name、头像、签名和训练目标，并保留本次 Booking note；不读取或展示 Shopify Customer GID、订单、支付、地址和营销资料。Coach 不再 Check in 或手工标记 Attended：Booking 默认视为会来，课后只可点击 No-show。No-show 原子地把该 Booking 预留的 1 次课释放回 Customer 的 available Pass，并写 `BOOKING_NO_SHOW` 审计；Admin Overview 仅对存在 `RELEASE` 账本的 No-show 显示提醒。

为避免永远保留 reservation，Worker 采用本轮明确记录的产品假设：课程结束后保留 24 小时 No-show 窗口；窗口结束仍为 `CONFIRMED` 的 Booking 自动改为 `ATTENDED` 并消费原预留课次。该操作使用 Session/Booking 行锁、唯一 settlement key、`SYSTEM / AUTO_COMPLETE` 变更记录和 `BOOKING_AUTO_COMPLETE` 审计，同时抑制已经过时的待发送确认通知。迁移 `202609160015_coach_default_attendance` 只应用于专用 `skyra_booking_test`，未应用开发库或 Render。

本地证据：`npm.cmd run check` 通过；专用 `skyra_booking_test` **30 个文件、361 项测试通过**（其中 Coach / lifecycle 定向 3 个文件、38 项）；更新后的 `scripts/coach-booking-smoke.mjs` 在 390px 与 1440px 覆盖一次性登录、周日历、Month 筛选、Training profile、只显示 No-show、`RELEASE=1 / CONSUME=0`、Admin 审计、空状态、退出、失效后拒绝和无横向溢出，两种宽度均 `pageErrors=[]`。以上仍是本地 fixture / 测试库证据，不是真实 Coach 账号 UAT。

本批未提交、未推送、未部署 Render，也未发布 Shopify App version。尚未完成正式 Coach 邀请/邮件与真实账号 UAT；Availability、time off、Reports / Account 已从当前主流程导航移除，是否继续开发应由产品范围再次确认。


## 2026-09-16：Coach 个人中心下一阶段交接

Customer Account 最新 UI 已随 `skyra-booking-11` 发布，Customer 代码、自动化、官方 validator 与 CI 证据已经收口；真实账号全尺寸视觉 UAT、订单 `#1001` 后端闭环和 Private/Workshop 交易仍保留为独立未完成项。下一开发会话转入 Coach 个人中心，不把 Customer 未签收项错误标记为完成，也不要求 Coach 使用 Shopify Customer Account。

现有 Coach 基础不是空白：受限登录/登出、一次性 15 分钟测试链接、8 小时 HttpOnly 会话、Today、本人 7/30 天及自定义 Schedule、本人 Session roster、Customer 逐次预约留言、check-in / attended / no-show、权限隔离、ledger 幂等和审计均已实现并有测试。当前缺口集中在正式 Coach 邀请/邮件身份、统一响应式 Portal shell、真实 Customer 最小显示资料、Day/Week 日历、recurring availability、time off、本人 reports 与真实桌面/手机 UAT。

下一阶段顺序已固定为：先复核现有 auth/权限与测试基线；再做 Today / My schedule / Availability / Reports / Account 的统一桌面和手机外壳；随后完善 schedule/roster 的真实显示、availability/time off、reports；最后接正式邀请登录并做真实 Coach UAT。Roster 从具体 Session 进入，不新增重复顶层页面；私教继续由 Customer 使用匹配 Pass 或 Shopify 支付后直接确认，不增加 Coach 审批；Coach 不得看到其他老师、全店销售、Shopify 订单/支付/地址/营销资料。完整接手说明见 [Coach 个人中心交接](handoff-2026-09-16-coach-portal.md)。

本批只更新开发、进度与交接文档，没有修改运行代码、Render 配置或 Shopify App version。开始新会话时必须重新核对 `bookingdev` 工作树、远端 SHA、CI 和实际部署，分别记录本地、CI、Render 与真实账号证据。

## 2026-09-16：Customer Account 信息架构与客户语言修正（已发布）

用户对已发布 `skyra-booking-9` 做真实账号验收后确认首轮响应式修复仍不够清晰：六个大按钮造成拥挤，独立 History 含义不明确，App 内 Profile 与 Shopify 原生 Profile 重名，Pass 直接展示 reserved 和 Ledger delta 等内部术语。本轮已重构为四个短入口：Overview、My passes、Bookings、Training profile；History 收进 Bookings 内的 `Past & cancelled`，私教也统一在 Bookings 中以 badge 区分并保留改期/取消，因此不再需要独立 Appointments 顶层入口。Training profile 只保存头像、preferred name、签名和训练目标；Shopify Profile 继续管理正式姓名、邮箱和地址。

Pass 文案已改成客户语言：available 显示为 ready to book，reserved 显示为“assigned to upcoming bookings”，Recent credit activity 不再显示 available/reserved/used 的内部增减值。含义不变：reserved 是已经分配给未来 Booking 的课次，用来防止同一 credit 重复预约；按时取消会退回 available，完成课程后转为 used。Bookings 空状态也明确说明新预约在 Checkout 处理完成后出现，不再使用容易误解的“Confirmed activity”措辞。

同时补齐错误恢复：取消/改期或读取状态不确定时，错误区现在提供真实 `Refresh` 操作重新读取账户，不要求客户刷新整个 Shopify 页面。完整 `npm.cmd run check` 通过；390px 与 1440px 浏览器回归均通过 navigationNoOverlap、noDuplicateProfile、分页、改期、取消不确定恢复、Past & cancelled、Pass 余额、读取错误恢复及 fresh token 检查，pageErrors=[]。最终分支 SHA `41ded11f59503fa3717fbf6e92f03c46f8958db8` 与远端一致，[GitHub Actions 34982148962](https://github.com/robber-857/Skyra/actions/runs/34982148962) success。

`skyra-booking-10` 完成四入口与客户语言首发。用户随后要求进一步整理真实页面：导航改为 `s-stack direction="inline"` 横向排列并在窄屏安全换行，入口改为 `Training profile`，Overview 默认说明文字移除，Overview 与 Training profile 的头像统一移至右侧。代码与回归提交已推送至 `bookingdev` SHA `9865ee8e8914bbf35f0af5d16e5a093b86b53677`；完整 `npm.cmd run check` 与 390/1440px 浏览器回归通过，桌面导航保持同一横行、两端无重叠、pageErrors=[]。用户明确授权后，Shopify 官方 validator 对 artifact `skyra-customer-layout-0916` revision 1 返回 `VALID`，CLI 配置校验为 `valid: true`、`issues: []`。`skyra-booking-11` 已发布并复核为 `active`，version ID `1129745678337`，`skyra-booking-10` 已为 inactive。[Shopify version dashboard](https://dev.shopify.com/dashboard/232832637/apps/420648878081/versions/1129745678337)。本次只更新 Shopify App extensions，不需要重新部署 Render。

## 2026-09-16：真实免单订单、Customer Account 接入与响应式 UI 发布

开发店的原生 Cart handoff 已完成一次真实下单：用户确认订单 `#1001` 成功创建、总额 A$0，并收到 Shopify 订单确认邮件。该结果证明开发店密码解锁后的同源 Cart、原生 Checkout、指定测试折扣 `SKYRAUATFREE915` 与 Shopify 订单/通知链路能够工作；但尚未读取并签收该订单对应的 Webhook Receipt、Outbox/Worker、Entitlement、Hold 转换和 confirmed Booking，因此不能把订单成功等同于 Booking 交易闭环完成。

Customer Account Full-page Extension 已加入开发店当前 Active 的 Checkout/Customer Accounts 配置，并在 `customer-account-main-menu` 中新增 `My Skyra` 入口。扩展设置已填写 Booking API `https://skyra-booking-web.onrender.com` 和 Find a class `https://skyra-booking-dev.myshopify.com/pages/programs#skyra-booking-programs`。真实已登录 Customer Account 能打开 My Skyra 并读取 Appointments；编辑器内曾出现的红色 API 提示没有复现在真实账号页面。

真实桌面截图发现六个页签在窄内容区发生 `Appointments` / `Profile` 重叠。提交 `8c82b442536f845e1579f2811c9bbd83a73c9ddf` 已改为 container-query 响应式布局：桌面 3 列、窄屏 2 列，Overview、Passes 与 Private appointments 内容也按容器宽度切换单列/多列并统一卡片层级、留白和空状态。`npm.cmd run typecheck:customer` 与完整 `npm.cmd run check` 通过；[GitHub Actions 34977446726](https://github.com/robber-857/Skyra/actions/runs/34977446726) success。本地与 `origin/bookingdev` SHA 一致。

经用户明确批准，Shopify App `skyra-booking-9` 已发布；CLI 复核状态为 `active`，version ID `1129655271425`，`skyra-booking-8` 已变为 inactive。[Shopify version dashboard](https://dev.shopify.com/dashboard/232832637/apps/420648878081/versions/1129655271425)。发布构建成功生成 Customer Account 与 Theme extension；官方独立 Customer Account validator 仍因其隔离环境不能解析项目的 `@shopify/ui-extensions/customer-account.page.render` / `preact/jsx-runtime` 模块而无法完成，最小组件复测得到相同环境错误，本地类型检查、生产构建和 Shopify CLI extension build 均通过。

仍未完成：强制刷新真实 My Skyra 后，对 320/390/430/1440px 做桌面与手机视觉验收；逐项签收 Overview、Pass 到期、Bookings 内的 Upcoming / Past & cancelled / Private booking、Training profile 保存及头像上传/移除、Find a class 返回；把 Shopify 原生菜单 Label `Profile` 手动改为 `Information`；核对订单 `#1001` 的 Receipt/Outbox/Worker/Entitlement/Hold/Booking 证据；再执行 Group Class、Private、Workshop 的正向交易与跨类型拒绝测试。

## 2026-09-15：开发店原生 Cart handoff 与免单回调校验

已实现仅对 `skyra-booking-dev.myshopify.com` 生效的 Online Store 原生 Cart handoff。服务器仍先完成登录、三重开发门控、课程/价格/商品复核、15 分钟 Hold 和随机 booking reference；浏览器随后使用已通过开发店密码页的同源会话调用 Shopify Ajax Cart API。购物车只允许空状态或完全匹配的单一预约行；如有其他商品、数量、价格、币种或 reference 不一致，流程停止并要求测试者手动清空，不会删除现有购物车。旧 `UNKNOWN` Checkout 仍不可重放。正式店继续使用原服务器端 Storefront Cart API，不会要求正式客户输入店铺密码。

新增迁移 `202609150014_native_cart_handoff`，把不可变 `handoffMode` 固定为 `STOREFRONT_API` 或 `ONLINE_STORE_NATIVE`，并允许后者在不保存 Storefront Cart ID 的情况下进入 `READY`。`orders/paid` 仍严格核对店铺、Customer、Product、Variant、quantity=1、AUD、原价和单一订单行；只有配置的开发店、且唯一折扣码精确为 `SKYRAUATFREE915`、折扣金额等于原价、subtotal/final 都为 0 时，才接受免单 UAT。生产订单没有金额放宽。

验证：专用 `skyra_booking_test` 已应用 15 条迁移；30 个测试文件 / **360 项测试全部通过**。新增覆盖原生 handoff 幂等、空/污染购物车、同源 locale route、开发店域名隔离和指定 100% 折扣。主 TypeScript、Customer Extension TypeScript、ESLint、生产构建通过；Shopify 官方 full-theme validator 对重建后的 `assets/transaction.js` 通过。另修复通知入队使用应用时钟、Worker 领取使用数据库时钟造成的约 90ms 边界竞争，统一使用数据库时钟。

交付：运行实现提交为 `bee92214b170939c0610cd40ce830ed7b7fef11d`，进度文档提交为 `5c18d6e861ee8788cb701ee3ab7e7599c6c40102`，均已推送到 `origin/bookingdev` 且远程 SHA 一致；[GitHub Actions 34968368453](https://github.com/robber-857/Skyra/actions/runs/34968368453) success。用户已确认 Render deploy `5c18d6e` 为 Live，Pre-deploy 成功应用 `202609150014_native_cart_handoff`。经用户明确批准，Shopify App `skyra-booking-8` 已发布并核对为 active，包含 Theme 与 Customer Account Extension。真实开发店新 Attempt、Checkout 和测试订单仍未执行。正式店密码状态不是此 UAT 的依赖；对外开放前应按正式营业计划关闭正式店密码。

## 2026-09-15：团课、私教与 Workshop 类型隔离

三个开发店预约开关已由用户在 Render 与 Skyra Booking Settings 依次开启。当前只适用于 `skyra-booking-dev.myshopify.com`；本轮只读复核 Render `/health` 返回 200。开关开启是测试前提，不等于已经完成测试付款或创建 Booking。

本批完成 `CLASS` 普通团课、`APPOINTMENT` 私教和 `COURSE` Workshop 的完整后台与公开预约路径：Classes & Passes 可创建 Workshop，Weekly Schedule 可排 Workshop，Home/Programs 可展示并进入 Workshop 预约，课程卡和详情显示明确类型。私教继续由服务器强制容量为 1，Workshop 保留配置容量。

Pass 现在只能选择同一种 Service kind 的 Eligible classes；团课 Pass 不能混入私教或 Workshop。应用服务在保存时返回 `PASS_TYPE_MISMATCH`，数据库迁移 `202609150012_service_type_pass_isolation` 同时增加允许值约束、跨类型 Eligibility 拒绝和已关联 Pass 的 Service 类型锁，防止绕过 Admin UI。顾客购买 Review、已有 Pass 确认和 paid Worker 仍按准确的 `serviceId` 再次校验，浏览器不能指定可用资格。

验证：专用 `skyra_booking_test` 已应用 13 条迁移；28 个测试文件 / **350 项测试全部通过**。TypeScript、Customer Extension、ESLint、生产构建、Prisma schema 与 diff 检查通过。Home/Programs 16 组 320/390/430/1440px 浏览器 fixture 回归通过，包含登录、恢复、Drop-in、已有 Pass 与无横向溢出。fixture 不等于真实 Shopify 顾客登录或测试付款。

交付：提交 `49bb1d9be78edfd2d0da2cfdd4a9be3f4ebc2596` 已推送至 `origin/bookingdev`，远程 SHA 一致；[GitHub CI 34859591792](https://github.com/robber-857/Skyra/actions/runs/34859591792) success。Render 已提供本提交的新 `app.catalog` 资源且 `/health` 为 200。用户随后明确批准 release；Shopify CLI 以 `--allow-updates`、不允许删除的方式成功发布 `skyra-booking-6`。开发店前台仍需通过 storefront password 后完成真实页面与交易验收。

仍未完成：真实开发店 Drop-in → Shopify 测试 Checkout → `orders/paid` → Worker → Entitlement/Booking E2E；随后是新 Pass 测试付款和已有 Pass 预约。Customer Profile 可选个人签名/训练目标尚未实现。

## 2026-09-14：开发店三个预约开关安全门控（本地）

已把 Checkout 与已有 Pass 的硬编码关闭改为显式 Render 环境门控，并将目标域名固定为 `skyra-booking-dev.myshopify.com`；正式店域名不能通过环境变量误开启。Booking App Settings 新增第三个在线预约规则控制，只有开发店 ADMIN、两个 Render 门控均已开启且预约窗口规则已批准时才能启用，并写 `DEVELOPMENT_BOOKING_ENABLED` / `DEVELOPMENT_BOOKING_DISABLED` 审计。前台只有三个开关全部开启时才会显示可用 Checkout/已有 Pass 操作。

本批次验证：28 个测试文件 / 348 项全部通过，TypeScript、Customer Extension 类型检查、ESLint 和生产构建通过。代码仍在本地，Render 配置默认 false，数据库和线上行为没有变化；提交、部署和真实模拟付款尚未执行。操作与回滚见 [开发店三个预约开关](development-store-release.md)。同时记录新范围：团课、私教、Workshop 类型隔离，以及 Customer Profile 可选个人签名/训练目标；后两项功能尚未实现。

## 2026-09-14：Weekly Schedule 周日历与场次编辑

Admin Weekly Schedule 已从单列课程清单升级为七天周日历：桌面按 Morning / Afternoon / Evening 展示，手机切换为逐日日程；支持按 Coach 筛选，并在课程卡显示时间、课程、Coach、已占用/容量和 DRAFT/PUBLISHED 状态。点击任一课程卡可打开编辑区，修改课程类型、Coach、日期时间和容量；已有预约或有效 Checkout Hold 时课程类型锁定。

后端新增事务化 `updateSession`：仅允许未来 DRAFT/PUBLISHED 场次，重新校验课程/Coach 资格、悉尼时区和 Coach/Location 冲突；有效 Hold 阻止编辑，容量不得低于确认预约，版本号阻止并发覆盖，成功写入 `SESSION_UPDATED` 审计。现有复制上周、草稿、发布和移除草稿流程保留。

本地验证：`npm.cmd run check` 通过；专用 `skyra_booking_test` 数据库 **26 个测试文件 / 339 项测试全部通过**，新增覆盖冲突回滚、成功更新时间/容量、审计、旧版本拒绝和跨店拒绝。提交 `4405b31` 已推送且远程 SHA 一致，Render deploy `dep-dajus7tckfvc73a6tos0` 已 live。1440/390px 本地 Playwright 视觉检查通过：桌面周日历与手机日程按断点切换、点击课程显示编辑区、pageErrors=[]、页面无横向溢出。已登录 Shopify 开发店的真实点击验收仍待完成；未开放正式店付款或预约开关。

## 2026-09-14：Git 交付与 Coach 测试入口

Appointment/留言/Today 与登录、排课保存修复已提交并推送 `698f7c2` 至 bookingdev，远程 SHA 一致，[CI 34812945622](https://github.com/robber-857/Skyra/actions/runs/34812945622) 通过。以下旧日期的“尚未提交”仅保留当时状态。

随后补充开发店 Admin 专用 Coach 测试登录：People → Create test sign-in link → Open coach test portal → Continue to my schedule。15 分钟单次链接、受限 Coach 会话；正式环境与其他店铺不可签发。Buffer 增加页面说明，并修复 Coach POST 经过本地代理的 Origin 校验。**336 项完整测试、类型/lint/构建以及 Coach 手机/桌面浏览器流程通过**。详细使用方法与边界见 [Coach 测试入口](coach-test-access.md)。

真实老师邮箱邀请、稳定部署、完整真实账号/付款验收仍未完成。本轮没有正式店发布或开放付款；后台测试入口不等于正式老师认证已接通。

## 2026-09-14：Save draft 400 已修复

Weekly Schedule 的 POST 被 React Router 7.18.3 的来源校验拦在业务 action 之前：公网 HTTPS Origin 与代理后的本机 request URL 不一致。新增 react-router.config.ts，仅允许 SHOPIFY_APP_URL 的精确 host；保留陌生来源拦截和 Shopify/Staff 认证。当前开发进程已加载修复，测试库实际保存草稿与重复提交去重通过。

**25 文件 / 322 项完整测试通过**，类型/lint/生产构建通过，6 项健康检查各 3 次通过。公网可信来源的未认证提交仍为 401，陌生来源为 400；本人 Admin Save draft 重试仍待用户反馈。本轮无 commit/push、正式部署或付款开关变更。

Cloudflare 日志证实曾短暂失联，随后自动重连；本轮未更换隧道。另已核实 dev 店本身免费，不增加第二份正式店基础月租；只能模拟支付，真实收款应在现有正式店完成。详见 [保存草稿修复与费用说明](schedule-save-fix.md)。

## 2026-09-14：My account 修复与 Admin 测试入口

My account 原先使用相对 /account，本地预览把 Shopify 认证请求送到 localhost，出现 404/401。现已将 Booking 区块与 Skyra 页面头部/底部统一指向 Shopify 托管账户地址；实际浏览器已到达 Shopify “Sign in - Skyra Booking Dev”，未代用户提交邮箱或验证码。Admin 使用独立的店主/员工入口，顾客登录不授予后台权限。

新增验证：24 文件 / **314 项测试通过**，TypeScript、ESLint、生产构建、Shopify app build、8 个 Liquid 文件官方验证与 16 组浏览器回归通过。真实账号登录/退出/返回仍未验收，30 组真实 UAT 仍待签收。修复只同步开发预览，未正式发布或开通云服务器，未再次提交 GitHub。

后台链接、添加课程/排期步骤、登录边界及 Railway/Render/Vercel 成本见 [账户入口与低成本部署](account-access-and-hosting.md)。以便宜为主，优先评估 Railway 测试环境；US$5 是最低用量，整套 App/Worker/DB/Redis 费用需按实测核算。

## 2026-09-14：接口恢复与测试版准备

课表代理 500 已恢复：旧临时隧道失效，普通重启仍出现 Cloudflare 1033；切换到经核实 Booking 代理的独立 HTTP2/IPv4 隧道后，6 项健康检查各连续 3 次通过。本轮只恢复开发预览，未正式发布或开放交易。当前未来 7 天没有已发布课程，空列表不表示接口故障。

本地尚余 6 组功能工作；第一版真实账号 + Shopify 模拟付款验收先补 4 个关口，不需等全部运营增强完成。原因、证据、清单和当前启动方式见 [2026-09-14 交接](handoff-2026-09-14.md)。旧批次 308 项自动化通过不替代真实 UAT；30 组真实验收仍待执行。

## 最新功能批次：Appointment 直接确认、逐次留言与 Today（2026-09-13）

按用户最新决定，Appointment 无需 Admin/Coach 审批。Admin 发布容量为 1 的私教时段，用户使用有效 Pass 或经 Shopify 付款验证后直接确认。用户在每次 Booking Review 填写可选留言，老师在对应课程名册查看；不开发聊天、老师回复或课前/课后消息系统。Admin/Coach 首页新增 Today 课程与预约名单，目前使用内部客户引用，真实姓名仍待 Shopify 客户资料接通。

已先将上一批提交并推送至 bookingdev：`75ccf976d2946790a4a0d5ce3f2e2849cc09b9ea`，远程 SHA 一致，[CI 34742951745](https://github.com/robber-857/Skyra/actions/runs/34742951745) success。本轮 Appointment/留言/Today 代码仍在本地，尚未再次提交。

验证：23 个测试文件 / **308 项测试通过**；TypeScript、ESLint、生产构建、Prisma、Shopify app build 和 Customer UI validator revision 5 通过。开发/测试库均已应用 **12 条迁移**。Home/Programs 16 组浏览器场景，以及 Coach/Customer 390/1440px 检查通过；这些不是 Shopify 真实账号、支付或邮件验收。

当前边界：使用 Admin 预发布的固定私教时段；Coach recurring availability/time off、动态时段和独立资源管理未完成。确认会生成 Customer/Coach 邮件任务，但 provider 与真实收件人未接通。Checkout/online bookings/owned Pass 三个公开开关仍关闭。银行、商户身份和邮箱由经营者之后配置；支付只使用 Shopify，资金退款由 Admin 线下处理。

详见 [Appointment 与课程留言](appointment-and-comments.md)、[最新交接](handoff-2026-09-13.md)、[真实 UAT](launch-readiness-and-uat.md)。以下旧日期段落为历史记录，旧“未提交/未实现”以本节为准。

## 当前进度：已有 Pass 确认与结果恢复（2026-09-13）

- 已按“先提交，再继续”推送上一批 Webhook/Worker/邮件基础/Coach 个人中心：`a372b1103cae1a2c472b9aad26ea38f3e4888812`，分支 `bookingdev`，本地与远程 SHA 一致；[CI 34697492538](https://github.com/robber-857/Skyra/actions/runs/34697492538) success。
- 此后的本轮新增代码仍在本地，尚未再次 commit/push。已完成：已有 Pass 列表/Review、同事务预约与 1 credit RESERVE、Customer/Coach 通知任务、签名 App Proxy 的 confirm/result 接口、Home/Programs 同区块 CONFIRMED/PROCESSING/NEEDS_ATTENTION/UNKNOWN 恢复。不创建 A$0 订单；新 Pass/Drop-in 继续使用 Shopify 原生 Cart/Checkout。
- 验证：16 文件、255 项完整测试通过；TypeScript、ESLint、生产构建、Prisma validate、本地 Theme Check（0 findings）通过；9 条迁移已应用本地开发库与测试库。Playwright 16 组场景通过，其中新增 Home/Programs × 390/1440px 的已有 Pass、丢失确认响应、过期付款恢复、UNKNOWN 重试；截图已检查。
- 三个公开能力开关仍关闭。浏览器新流程使用确定性 API fixture，数据库事务使用专用测试库；不代表真实 Shopify 登录、支付或邮件已验收。
- 用户最新范围：自动客户退款不做，由 Admin 线下退款。后续补取消/课次释放、可审计人工处理和对账，但不由 Booking App 划款或自动标记“已退款”。收款账户尚未绑定；Payment methods 由 Shopify 管理，不自建卡号/支付表单。

下一轮入口与剩余工作见 [2026-09-13 交接](handoff-2026-09-13.md)。以下带日期的旧段落保留历史事实；旧的“尚未 commit/Worker 未实现”等表述不覆盖此节。

## 最新续开发：付款确认、邮件与 Coach（2026-09-12）

已在本地接通 ORDER_PAID_RECEIVED Worker：冻结购买条款、NEW_PASS/Drop-in 权益、原子 GRANT/RESERVE/CONFIRMED、PaidBookingResult 的 Checkout/Order-Line 去重、可恢复过期 Hold 的容量重查与 Needs Attention。预约确认同时生成 Customer + 对应 Coach 两条幂等通知；含邮件模板、预览、投递 adapter 接口和重试/UNKNOWN 状态，**尚未配置或发送真实邮件**。

新增独立受保护的 Coach 只读个人中心 /coach，按上课日期筛选未来 7 天、30 天和自定义区间，显示报名人次/容量及出席、取消、No-show。单次链接/会话/退出服务和页面已实现；真实 Coach 邮箱绑定、邀请发信和真实账号验收仍未完成。Admin Bookings 现可只读查看 Needs Attention、近期预约和邮件预览，不能执行退款/人工重新确认。

当前实现和边界详见 [Booking 邮件与 Coach](notifications-and-coach.md)。下方早期记录属于历史快照，最新代码/测试以本节及本轮验证记录为准。三个公开交易开关仍关闭；没有真实付款、Booking、发信、正式部署或 Git commit/push。

更新：2026-09-12。此页记录实际代码、开发店联调与验证证据；完整范围仍以 `implementation-backlog.md` 为准。

最新状态：Hold → Cart 已以 `b67694271cbe5ddee75d3a6484c59e23c04eab39` 推送 `bookingdev`，远程 SHA 一致，GitHub CI run 34679489160 已触发。其后已完成 `orders/paid` 的验签路由、Webhook ID 幂等收件、订单归属/商品/数量/AUD 金额/付款状态校验和 Outbox 分类；212 项测试、类型/lint/构建通过。真实订阅、`read_orders` 权限、Worker 权益发放、Booking 确认、付款后恢复和公开 Checkout 仍关闭。Continue with Shop 真实账户复测仍未完成。

### 本轮最终验证（2026-09-12 23:03 Australia/Sydney）

- 全套 14 个测试文件、240 项测试通过（上一轮 212 + 本轮 28），包括重复 delivery/worker、两笔过期付款争抢最后名额、全事务回滚、权益冻结、通知重试/UNKNOWN，以及 Coach 跨店/跨教练隔离、一次链接并发消费、退出/停用、DST 和日期边界。
- TypeScript、ESLint、生产构建与 Prisma validate 通过；测试库和本地开发库全部 8 条迁移已应用。
- 生产构建 + 专用测试库的 Playwright：390/1440px，登录、月度筛选、自定义空状态、退出通过；两视口均 noHorizontalOverflow=true、pageErrors=[]。已检查截图。
- 证据：output/playwright/coach-booking/{results.json,coach-390.png,coach-1440.png,customer-email.html,coach-email.html}；重跑使用 booking-app/scripts/coach-booking-smoke.mjs，需测试 DATABASE_URL 和已安装的 PLAYWRIGHT_MODULE，通过 tsx 运行。测试过程没有真实发信或 Shopify 支付。
- 已恢复 App/Worker，原 Theme dev 继续运行；preview:check 的 Home、Programs、App host、Booking API、Shopify upstream 均通过 HTTP 200 检查。这不代表真实客户登录/支付 E2E。
- 本地开发店 holds=0、bookings=0、notifications=0；onlineBookingsEnabled=false、checkoutAvailable=false、ownedPassesAvailable=false。
- 保留上一轮未提交 Webhook 批次；本轮没有 commit/push、真实收款/发信或正式店发布。

## 已创建与已绑定

- Shopify App：**Skyra Booking**，组织 Skyra（232832637）。
- Client ID：`c9d266a38e2f11a1240139974253b3a1`；这是公开标识，不是 Secret。
- 开发店：`skyra-booking-dev.myshopify.com`，App 已安装并完成离线/在线 OAuth 会话交换。
- 已发布 App 配置版本 `v3-m1-20260909-3`，包含权限、Product Metafield 定义和 Theme App Extension。
- `booking-app/`：官方 Shopify React Router + TypeScript 工程；PostgreSQL 17、Redis 7 使用独立本地容器。

## 已完成代码

| 范围                     | 已完成                                                                                                                                                             | 当前边界                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 工程                  | Prisma schema/migration、测试库、seed、连接池、官方 Admin 认证、店主初始化 ADMIN、RBAC、审计、健康接口、Redis/BullMQ Worker、根目录 CI                             | Customer JWT、Coach OTP、托管环境、监控和备份未完成                                                                                                                                                                                                                              |
| M2 Classes & Passes      | Class/Pass 创建与编辑、跨店校验、Coach/Location、Coach 与 Pass eligibility、乐观版本检查                                                                           | Category/Resource、Appointment/Course 完整表单未完成；Admin iframe 尚未做完整人工视觉验收                                                                                                                                                                                        |
| M2 商品同步              | 事务 Outbox、`productSet`、稳定 Product/Variant 映射、`metafieldsSet`、app-owned Service content definition 自愈、Metaobject upsert/read-back、重试和状态刷新      | Coach public Metaobject 与 `products/update` 对账尚未实现                                                                                                                                                                                                                        |
| M2 Weekly Schedule       | 按周日期/时间/教练、草稿、发布、删除草稿、4/8/13 周生成、复制上周、时区/DST 校验                                                                                   | 持久化 Series 编辑、资源分配、Appointment slots、教练可用时间例外未完成                                                                                                                                                                                                          |
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
3. Late Cancel 扣除次数；2026-09-16 最新决定覆盖此前规则：No-show 释放预留次数回 available Pass，并提醒 Admin。
4. Pass 从购买日开始有效，上课日期必须处于有效期内。
5. 新 Pass Checkout 创建 15 分钟 Seat Hold。
6. 付款完成但 Hold 已失效时禁止超卖；有空位则安全确认，满员则进入 Needs Attention。
7. 确认预约时 reserve；完成或 Late Cancel 时 consume；免费取消或 No-show 时 release。

Appointment 已按 2026-09-13 决定直接确认；Any available coach、通知时间与初始 Service ↔ Pass 商品范围仍按相应模块确认；这些项目不阻塞 Class Booking Engine 开发。

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

- Customer Account full-page：My Overview、My Passes、Bookings & History、取消/改期与逐次客户留言（当前已实现，见顶部状态）。
- Coach Portal、签到和查看本节客户留言（当前已实现，见顶部状态）。
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
- App/Worker 和 9292 Theme 预览已恢复；本轮无主题前端改动、无 App deploy 或正式店变更。此批已提交并推送 `b67694271cbe5ddee75d3a6484c59e23c04eab39`，远程 ref 已核对。

## 最新交付：orders/paid 收件箱与严格订单分类（2026-09-12）

- 新增 `/webhooks/orders/paid`：先由 Shopify React Router SDK 验证 HMAC，再读取原始字节计算 SHA-256；只接受 orders/paid 主题。认证失败不确认，认证成功的业务异常被持久化后快速返回 200，避免在五秒 Webhook 窗口内直接发权益或确认预约。
- `webhook_receipts` 以 `(shopId, webhookId)` 唯一约束去重；10 路并发重试只生成一条 Receipt 和一条 Outbox。相同 delivery ID 但不同 payload/topic 记为冲突且不重新处理。新增状态/哈希数据库约束和 `status + receivedAt` 运维索引。
- 仅从订单载荷提取最小必要字段，不保存原始订单、邮箱、地址或 Customer GID 到 Outbox。无 `_skyra_booking_ref` 的普通订单标记已处理并忽略；畸形或多 Booking line 进入 `ORDER_PAID_REVIEW`。
- 对命中的 Checkout 严格验证同店 reference、READY 状态、Customer、Product、Variant、单行 quantity=1、AUD、line/subtotal/final amount、paid 状态及未取消。全部通过才投递 `ORDER_PAID_RECEIVED`；任一不匹配进入 Needs Attention，不发 Pass、不写 Booking。
- 专用测试库迁移成功，12 个测试文件共 212 项通过；`npm.cmd run check` 的类型、lint、生产构建通过，本地开发库 6 条迁移 up to date。官方 schema 验证了后续 Order 对账查询，但它需要订单/客户/商品读取权限，因此本轮未扩大 App scopes、未注册真实订阅。
- 尚未完成：Outbox Worker 的 grant → reserve → Booking Confirmed、过期 Hold 付款恢复、乱序/重复业务处理、真实 webhook 注册/触发、退款/取消与 reconciliation。三个能力开关保持 false，本轮没有真实订单、付款、权益或预约。

## 本轮收尾验证（2026-09-13 Australia/Sydney）

App/Worker 已恢复，Theme dev 保持运行。preview:check 对 Home、Programs、App host、Booking API 和 Shopify upstream 各检查三次，全部 HTTP 200。只读核对开发店 holds=0、bookings=0、notifications=0、onlineBookingsEnabled=false；本地开发数据库已完成 9 条迁移。当前预览 App 端口 54099，入口使用原来的 9292/9293；端口和 tunnel 会随下次启动变化。

## 2026-09-13 整站验收准备

新增 [上线准备与真实验收清单](launch-readiness-and-uat.md)：8 类未完成工作、30 条待签收验收场景、Shopify 商户/银行/身份/邮箱配置入口。30 条是验收基线，不是剩余自动化测试数量；最近已通过测试仍为 255 项，本次未重新执行测试。

## 最新交付：Customer 个人中心与 Cart 阻塞定位（2026-09-15）

- Customer Account Full-page Extension 已按设计整合 Overview、My passes、Bookings、History、Appointments 与 Profile。顾客可查看 Pass 余额/到期/适用范围、未来预约、历史与状态；私教预约保留取消/改期入口。
- Find a class 不复制新排课页面，使用扩展设置的 `booking_url` 跳转到 storefront Programs 页的 `#skyra-booking-programs`，继续复用 Home/Programs 同一 Booking section。设置为空时按钮禁用并给商户配置提示。
- Profile 增加 preferred name、头像、签名和训练目标。头像限制 PNG/JPEG/WebP、文件头校验、512 KiB；文本限制 80/160/1000 字符并拒绝控制字符。API 使用 Customer Account session token，只按店铺 + Shopify Customer GID 读写本人记录；Shopify 继续管理正式姓名、邮箱、电话、地址与认证。
- 新增 `202609150013_customer_profile` 迁移和数据库 bytes/MIME/类型/大小约束；Profile 设计已同步到可点击线框。
- 最终独立全量数据库测试为 29 文件 / 355 项全部通过；Customer Extension typecheck、主 TypeScript、ESLint、production build、Prisma generate/format 与 `shopify app build` 通过。Shopify 官方组件校验器重试 3 次均因其隔离环境缺少 `customer-account.page.render` 类型模块而失败；本地 `2026.7.0` 包解析与 typecheck 正常，仍需真实 extension 发布/UAT。
- Cart 失败根因已确认：Checkout scope 已 release/批准且线上运行时具备所需权限，但开发店返回 `Online Store channel is locked.`。安全日志只记录 `ACCESS_DENIED` 等分类字段，不输出 token、Cart secret、PII 或完整响应。
- 尚未完成：开发店原生 Cart handoff、全新 Attempt 的零金额测试订单、paid Webhook/Worker/Entitlement/Booking 签收、Customer Extension 新版本发布、`booking_url` 配置和真实 Customer Account 桌面/手机验收。Shopify 官方确认 Dev Store 密码页不能移除；不再把关闭密码列为用户待操作。
- Git/部署状态：Customer 实现 `0dc6ef6` 与首轮状态文档 `1d31dc6` 已推送。功能运行版本 `1d31dc611cbc25376f727172cda86accd21b717b` 的 GitHub Actions run `34965029824` success；Render deploy `dep-dakivp942hec73cpbpr0` 已在相同 SHA live，pre-deploy migration 完成且 `/health` 为 200。后续纯文档提交不改变运行版本证据。
