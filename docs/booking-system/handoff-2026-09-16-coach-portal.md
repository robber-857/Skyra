# 开发交接：Coach 个人中心

更新：2026-09-16。下一会话从本文件开始；Customer 与交易历史见 [2026-09-15 交接](handoff-2026-09-15.md)。

## 收口复核（优先于下方较早快照）

最新完成项、Karen Render Dev 只读证据、35 文件 / 379 项全量回归、真实邮件边界与正式发布关口见 [Coach、Reports 与正式发布前收口](release-readiness-2026-09-16.md)。Karen 已确认是 Dev 数据库中的 `ACTIVE` Coach，并绑定一节 2026-09-18 10:00 Australia/Sydney、状态 `PUBLISHED` 的 `[DEV] Aerial Foundations`；People 的 Add coach 已生效。下文“Karen 未核验 / 课程 DRAFT / 33 文件 371 项”是本轮较早快照，不再代表当前状态。

## 身份与登录结论

- 用户最新要求已取代“只能邀请”的旧方向：本地已实现 Admin 在 People 授权独立 `loginEmail`，Coach 在 `/coach/login` 自助申请单次邮件链接，首次验证自动激活，后续无密码登录。未知邮箱不创建 Coach 权限；notificationEmail 仍只是通知收件地址。
- 可选 Resend transport、加密登录 outbox、Worker 登录邮件和 Coach/Admin Booking 邮件投递代码已实现，但真实 provider/DNS/secrets 未配置，默认关闭；Customer 邮件解析与真实收件 UAT 未完成。Coach 不复用 Shopify Customer Account，也不需要 Shopify Admin 权限。
- Customer 没有 Skyra 自建注册密码。Shopify Customer Accounts 使用邮箱一次性验证码；新邮箱首次成功登录时 Shopify 自动创建 Customer profile。
- 主页底部 `Join community` 是 newsletter `customer` form：建立/更新 Shopify Customer profile 与 marketing consent，但不会登录、不会创建 Booking/Pass、不会授予 Coach 权限。以后用同一邮箱完成验证码登录时可匹配已有 profile。
- 详细代码入口、流程与未完成项见 [身份、登录与主页邮箱关系](identity-login-and-email.md)。

## 2026-09-16 本轮续开发结果（本地、未交付）

最新自助身份、hello 发信说明、Dev/Karen 核验边界与下一步以 [Coach 自助激活与邮件](coach-self-service-and-email-2026-09-16.md) 为准。迁移 018 已应用本地开发库/测试库，Render 未应用；完整测试更新为 33 文件/371 项，check 与 390/1440px fixture smoke 通过，无真实发送、commit/push/deploy。Render health 本轮为 200，但原 Dev DB 与部署 SHA 未直接核验。用户截图 Karen 的 9 月 18 日 10:00 课程为 DRAFT，当前不显示在正式 Coach 日历，未擅自发布。

- Booking confirmation 现为 Customer / 对应 Coach / Admin 三条幂等通知；Coach Portal 与 Admin Overview 均有持久站内通知、未读数与 Mark read。People/Settings 可保存 Coach/Admin 通知邮箱，但真实邮件 provider 与 Worker 投递未接。
- Admin Overview 已按运营设计实现四步入口、今日课程/容量、待处理付款事件、30 天内到期 Pass、今日课表、到期明细、Booking 通知和 No-show credit returned。
- Admin Reports 已实现按日期/Customer 筛选的 validated booking spend、NEW_PASS revenue、逐 Customer 消费、逐 Pass 购买/已用/剩余/到期，以及两类安全 CSV。Refund 尚未同步，页面明确显示 Not synced。

- Coach Portal 已收敛为 Today 与 My schedule；Week 是 Monday–Sunday 七列日历，支持前后翻周，手机显示逐日日程。Month / custom 仍为列表。
- Session roster 已接 Booking App Training profile：preferred name、头像、签名、训练目标与本次 Booking note。没有读取 Shopify Customer GID、订单、支付、地址或营销资料。
- Coach 不再 Check in 或标记 Attended，只能在课程结束后 Mark no-show。No-show 会以原 reservation key 释放 1 次课回 Customer available Pass，并写 `BOOKING_NO_SHOW`；Admin Overview 仅对确有 `RELEASE` 账本的 No-show 显示提醒。
- Worker 以课程结束后 24 小时为 No-show 窗口；窗口结束仍为 `CONFIRMED` 的 Booking 自动结算 `ATTENDED` 并消费预留课次，写 `SYSTEM / AUTO_COMPLETE` 与 `BOOKING_AUTO_COMPLETE`，并抑制过时的待发送 Booking confirmation。
- 新迁移：`202609160015_coach_default_attendance`、`202609160016_internal_booking_notifications`、`202609160017_admin_booking_notification_recipient`。均已应用本地开发库与专用测试库，未应用 Render。
- 本地证据：`npm.cmd run check` 通过；专用 `skyra_booking_test` 32 个文件、363 项测试通过；390px / 1440px production-build smoke 覆盖站内通知、周日历、Training profile、No-show `RELEASE=1 / CONSUME=0` 与无横向溢出，`pageErrors=[]`。
- 当前本地开发库只有 Development Coach（3 个 Session），没有 Karen；Karen 截图所在环境尚待确认，所以本轮自动化不是 Karen 的真实账号 UAT。详细记录见 [Coach/Admin 通知、Overview 与 Reports](coach-admin-notifications-reports-2026-09-16.md)。
- 当前改动尚未 commit / push / deploy，也未发布 Shopify App version；以上不是正式 Coach 账号 UAT。

## 接手基线

- 分支：`bookingdev`。本轮开始时 HEAD 与 `origin/bookingdev` 均为 `e7dd9094c1293274d6ad19a40395295bbf736ddf`；本文件上方列出的 Coach 改动尚未提交。
- Customer Account 当前已发布 `skyra-booking-11`，version ID `1129745678337`。Customer 顶层为 Overview、My passes、Bookings、Training profile；最新横向导航、头像右置和响应式修复已通过完整 check、390/1440px fixture、官方 Customer Account validator 与 GitHub CI。
- Customer 的真实账号视觉 UAT、订单 `#1001` 后端闭环、私教/Workshop 交易及跨类型拒绝仍未签收。这些不阻止先开发 Coach UI，但不能在 Coach 会话中误标为完成。
- 开始新会话时先重新核对分支、工作树与当前部署，不要把上述 SHA 当作永远不变的线上状态。

## Coach 系统边界

Coach 个人中心是 Booking App 自己的受限 Portal，不是 Shopify Customer Account，也不应要求 Coach 成为 Shopify Customer。当前主流程只要求 Coach 查看自己的课程/私教和对应名册：

- 不得看到其他 Coach 的排期或名册。
- 不得看到全店销售、Shopify 订单、支付方式、地址、营销资料或完整客户财务信息。
- Customer 的每次预约留言可在对应名册查看；当前产品决定是不做聊天和 Coach 回复。
- Booking 默认视为会来；Coach 不做 Check-in / Attended，只在课后记录 No-show。No-show 必须退回已预留的 1 次 Pass，并提醒 Admin。
- 私教由 Customer 使用匹配的 Private Pass 或完成 Shopify 支付后直接确认，不增加 Coach/Admin 审批步骤。
- 所有读取和写入继续按 shop、coach、session/booking 做服务端授权，关键操作保留审计。

## 已有实现

- `/coach/login`、`/coach`、`/coach/classes/:id` 与 logout 路由已经存在。
- 已有一次性 15 分钟登录链接、8 小时 HttpOnly / SameSite=Lax Coach session、单次 token hash、停用/撤销检查和未授权拒绝。
- 开发店 Admin 可在 People 中生成 Coach 测试入口；该入口只用于指定开发环境，说明见 [Coach 测试入口](coach-test-access.md)。
- Today 页面已有当日课程/私教；Coach Schedule 已有周日历、Month / custom 范围和前后翻周。
- Session detail 已有本人场次名册、Training profile、Customer 预约留言和课后 No-show。
- No-show 释放 reservation、24 小时默认 Attendance settlement、权限、时限、credit ledger 幂等/并发保护与审计已有测试。
- 后端已经隔离其他 Coach 与其他店铺。

## 尚未完成

1. Coach 自助邮箱身份代码已实现；真实 provider、域名/secrets、边缘限流与 Karen 真实收件/登录 UAT 仍待完成。详见上方最新文档。
2. Coach 桌面与手机真实账号 UAT 尚未完成。
3. 24 小时 No-show 窗口是本轮为完成默认 Attendance 结算而记录的假设；若业务要改时限，应集中修改 service 常量、UI 文案与测试。
4. 015/016/017 Migration 已应用本地开发库与测试库，尚未应用 Render；Worker 与 Admin/Coach 通知也未在部署环境验证。
5. Recurring availability、单日例外、time off、Reports / Account 和 Session 调课通知尚未实现，并已从当前主流程导航移除；继续开发前应重新确认产品优先级。
6. 可选 provider 与 Coach/Admin Worker 投递代码已接，实际配置/收件验收仍未完成，Customer protected email resolver 尚未接。PENDING 不代表已发送。
7. Admin Reports 尚未同步 Shopify 全店订单、discount/refund；Refund 明确标记 Not synced。

## 下一会话推荐顺序

1. **先确认边界和现状**：读取本文件、[开发状态](development-status.md)、[Backlog](implementation-backlog.md) 的 M6，以及现有 Coach routes/services/tests；运行 `npm.cmd run check` 和 Coach 定向测试，确认不是在旧分支上开发。
2. **先确认 Karen 环境**：本地 DB 没有 Karen；查明她位于 Render、另一份本地 DB 或 CLI 临时环境，再在原环境做真实 UAT，避免复制错误数据。
3. **部署前复核数据与运维**：确认 24 小时 No-show 窗口，备份并应用 015/016/017，验证 Worker 单实例/并发行为、Overview/Reports 与通知权限；分别记录本地、CI、Render 证据。
4. **配置正式邮件与 Coach 身份**：确认 provider/Karen 邮箱、验证发信域名/secrets；部署已经实现的 loginEmail、自助激活、加密 outbox 与 Worker。补 Customer protected email resolver、边缘限流和回执/对账，再完成 Karen 真实收件/390px/1440px UAT。Provider 默认关闭，不把 PENDING 当发送成功。
5. **再确认扩展范围**：只有产品仍需要时才开发 Availability / time off、Reports / Account 和调课通知；Admin Weekly Schedule 继续是排课运营真相。

## 建议验收标准

- 登录 token 只能使用一次；Coach 停用、会话过期或撤销后立即失效。
- Coach A 无法读取或修改 Coach B 的 session、booking、availability 或 report。
- Today / Schedule / Session detail 在 390px 与 1440px 无重叠、裁切或横向滚动。
- 名册只展示运营所需 Customer 信息，不展示订单、支付、地址和营销资料。
- Coach 页面没有 Check-in / Attended；No-show 只能课后提交，重复/并发保持幂等，且正好释放 1 个 reservation，不产生 CONSUME。
- 未在 24 小时窗口内 No-show 的 Booking 由 Worker 正好自动消费 1 次并变为 Attended；失败可观察且不会部分提交。
- Admin 只提醒确实产生 RELEASE 账本的 No-show。
- 私教仍然是 Customer 付款/Pass 后直接确认；Coach Portal 不新增审批状态。
- 自动化、fixture、CI、Render deploy 与真实 Coach 登录/UAT 分别记录，不能互相替代。

## 代码入口

- Routes：`booking-app/app/routes/coach.tsx`、`coach_.login.tsx`、`coach_.classes.$id.tsx`、`coach_.logout.ts`
- Components：`booking-app/app/components/coach-portal-shell.tsx`、`today-bookings.tsx`、`coach-schedule.tsx`、`booking-actions.tsx`
- Services：`booking-app/app/services/coach-auth.server.ts`、`coach-schedule.server.ts`、`coach-test-access.server.ts`、`today-bookings.server.ts`、`booking-lifecycle.server.ts`、`booking-notifications.server.ts`、`in-app-notifications.server.ts`、`admin-overview.server.ts`、`booking-reports.server.ts`
- Worker / migration：`booking-app/scripts/worker.ts`、`booking-app/prisma/migrations/202609160015_coach_default_attendance/`、`202609160016_internal_booking_notifications/`、`202609160017_admin_booking_notification_recipient/`
- Styles：`booking-app/app/styles/coach.css`
- Tests：`booking-app/tests/coach-portal.test.ts`、`coach-test-access.test.ts`
- Wireframe reference：`docs/booking-system/wireframes.html` 仅作早期视觉参考；其中 Check in、Availability、Reports 等 Coach 画面不再代表最新产品行为，以本交接和运行代码为准。

## 新会话可直接使用的任务说明

> 在 `D:\\Skyra` 的 `bookingdev` 分支继续 Coach 个人中心。先阅读本交接，核对工作树、远端、migration 和完整测试；不要恢复旧 wireframe 中的 Coach Check-in / Attended。Coach 只看本人周课表与相应 Customer Training profile，课后只可 No-show；No-show 退回 1 次 Pass 并提醒 Admin，24 小时窗口后其余 Booking 由 Worker 默认结算 Attended。先完成正式邀请/真实账号 UAT 与部署验证，再由产品确认是否继续 Availability / Reports。
