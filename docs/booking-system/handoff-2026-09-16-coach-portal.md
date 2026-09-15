# 开发交接：Coach 个人中心

更新：2026-09-16。下一会话从本文件开始；Customer 与交易历史见 [2026-09-15 交接](handoff-2026-09-15.md)。

## 接手基线

- 分支：`bookingdev`。本交接前远端基线为 `11db8acbc99ef330504feff57b6b7d6342aebd4a`，工作树当时干净。
- Customer Account 当前已发布 `skyra-booking-11`，version ID `1129745678337`。Customer 顶层为 Overview、My passes、Bookings、Training profile；最新横向导航、头像右置和响应式修复已通过完整 check、390/1440px fixture、官方 Customer Account validator 与 GitHub CI。
- Customer 的真实账号视觉 UAT、订单 `#1001` 后端闭环、私教/Workshop 交易及跨类型拒绝仍未签收。这些不阻止先开发 Coach UI，但不能在 Coach 会话中误标为完成。
- 本轮只更新文档，不修改运行代码、Render 或 Shopify App version。开始新会话时先重新核对分支、工作树与当前部署，不要把上述 SHA 当作永远不变的线上状态。

## Coach 系统边界

Coach 个人中心是 Booking App 自己的受限 Portal，不是 Shopify Customer Account，也不应要求 Coach 成为 Shopify Customer。Coach 只能看到自己的课程、私教、名册、可用时间和个人报表：

- 不得看到其他 Coach 的排期或名册。
- 不得看到全店销售、Shopify 订单、支付方式、地址、营销资料或完整客户财务信息。
- Customer 的每次预约留言可在对应名册查看；当前产品决定是不做聊天和 Coach 回复。
- 私教由 Customer 使用匹配的 Private Pass 或完成 Shopify 支付后直接确认，不增加 Coach/Admin 审批步骤。
- 所有读取和写入继续按 shop、coach、session/booking 做服务端授权，关键操作保留审计。

## 已有实现

- `/coach/login`、`/coach`、`/coach/classes/:id` 与 logout 路由已经存在。
- 已有一次性 15 分钟登录链接、8 小时 HttpOnly / SameSite=Lax Coach session、单次 token hash、停用/撤销检查和未授权拒绝。
- 开发店 Admin 可在 People 中生成 Coach 测试入口；该入口只用于指定开发环境，说明见 [Coach 测试入口](coach-test-access.md)。
- Today 页面已有当日课程/私教和预约动作；Coach Schedule 支持未来 7 天、30 天和自定义日期范围的只读数据。
- Session detail 已有本人场次名册、Customer 预约留言、check-in / attended / no-show 操作。
- Attendance 权限、时限、credit ledger 幂等/并发保护与 Coach 行为审计已有测试。
- 后端已经隔离其他 Coach 与其他店铺。

## 尚未完成

1. 正式 Coach 邀请与身份验证：真实 Coach 邮箱维护、邀请邮件 provider、自助重发、失效/撤销和真实账号登录 UAT。
2. Coach 个人中心的信息架构与统一响应式外壳仍需成型；现有页面是功能入口，不是最终设计。
3. 名册仍以内部 Customer 引用为主，真实显示姓名和最少必要联系方式尚未接通；接通时必须坚持最小披露。
4. Schedule 当前是范围列表，真正的 Day / Week 日历视图与手机布局尚未完成。
5. Recurring availability、单日例外与 time off 尚未实现。
6. Coach 自己的课程/出勤/No-show 报表界面尚未完成。
7. Session 调课通知、真实邮件投递和收件人解析尚未完成。
8. Coach 桌面与手机真实 UAT 尚未完成。

## 下一会话推荐顺序

1. **先确认边界和现状**：读取本文件、[开发状态](development-status.md)、[Backlog](implementation-backlog.md) 的 M6，以及现有 Coach routes/services/tests；运行 `npm.cmd run check` 和 Coach 定向测试，确认不是在旧分支上开发。
2. **先做统一 Portal shell**：建立清楚的横向/移动端安全导航。建议入口为 Today、My schedule、Availability、Reports、Account；Roster 保持从具体 Session 进入，避免顶层重复。若要给 Coach 增加照片、简介或公开 bio，先确定字段归 Booking App 还是 Shopify 内容，再改 schema。
3. **完善 Today 与 My schedule**：保留现有业务逻辑，优先改善信息层级、空状态、日期切换、课程类型 badge、容量/报名数和手机布局；不要在 UI 重写授权规则。
4. **完善 Session detail / Roster**：接入最少必要的真实 Customer 显示信息，保留留言、签到、Attended、No-show；验证 Coach 无法枚举非本人 session。
5. **实现 Availability 与 time off**：先做每周 recurring availability，再做单日 exception/time off；由 Admin 排课继续作为运营真相，避免把 Coach Portal 变成第二套复杂排课系统。
6. **完成 Reports 与 Account**：只做本人课程/出勤统计和必要账户信息；生产邀请/登录接入放在 UI 与权限稳定之后。
7. **最后做真实 UAT**：至少 390px 与 1440px，无重叠/横向溢出；测试登录、过期、撤销、跨 Coach 拒绝、名册、出勤、私教留言、availability 和 reports。

## 建议验收标准

- 登录 token 只能使用一次；Coach 停用、会话过期或撤销后立即失效。
- Coach A 无法读取或修改 Coach B 的 session、booking、availability 或 report。
- Today / Schedule / Session detail 在 390px 与 1440px 无重叠、裁切或横向滚动。
- 名册只展示运营所需 Customer 信息，不展示订单、支付、地址和营销资料。
- Check-in / attended / no-show 重复提交保持幂等，credit ledger 不重复扣减。
- Availability/time off 有时区、冲突、边界和审计测试。
- 私教仍然是 Customer 付款/Pass 后直接确认；Coach Portal 不新增审批状态。
- 自动化、fixture、CI、Render deploy 与真实 Coach 登录/UAT 分别记录，不能互相替代。

## 代码入口

- Routes：`booking-app/app/routes/coach.tsx`、`coach_.login.tsx`、`coach_.classes.$id.tsx`、`coach_.logout.ts`
- Components：`booking-app/app/components/today-bookings.tsx`、`coach-schedule.tsx`、`booking-actions.tsx`
- Services：`booking-app/app/services/coach-auth.server.ts`、`coach-schedule.server.ts`、`coach-test-access.server.ts`、`today-bookings.server.ts`
- Styles：`booking-app/app/styles/coach.css`
- Tests：`booking-app/tests/coach-portal.test.ts`、`coach-test-access.test.ts`
- Wireframe reference：`docs/booking-system/wireframes.html` 中的 coach-today、coach-roster、coach-availability、coach-session、coach-report。

## 新会话可直接使用的任务说明

> 在 `D:\\Skyra` 的 `bookingdev` 分支继续 Coach 个人中心。先阅读 `docs/booking-system/handoff-2026-09-16-coach-portal.md`，核对工作树、远端和当前测试；不要重做已存在的 Coach auth、Today、Schedule、Roster、Attendance 与审计。先按现有 wireframe 和权限边界实现统一的桌面/手机 Portal shell，再完善 Today 与 My schedule。每个阶段说明已完成、未完成、验证层级和部署状态，并同步开发状态、Backlog 与交接文档。
