# Coach / Admin 通知、Overview 与 Reports 实施记录

更新：2026-09-16。状态：**本地已实现并验证，未 commit / push / deploy**。

## 本轮产品决定

- Customer 的 Booking 确认后，系统为 Customer、该 Session 的 Coach、当前 Shop 的 Admin 各建立一条幂等通知记录。
- Coach 与 Admin 的“App 提醒”定义为 Booking App 内持久通知中心，可单独标记已读；不是手机 OS push notification。
- Coach 继续只看自己的课程和通知；Admin 看当前 Shop 的运营通知。两者都不能读取其他 Shop 的数据。
- Coach 不做 Check-in / Attended；课后只记录 No-show。No-show 释放原 Booking 预留的 1 次课回 Customer available Pass，并继续在 Admin Overview 显示可复核提醒。
- 报表不使用设计稿中的示例数字。消费来自 Booking App 已验证的 Checkout / PaidBookingResult；Pass 剩余次数来自 immutable entitlement ledger。

## 已完成

### Booking 通知

- `BookingNotification` 的收件人从 Customer / Coach 扩展为 Customer / Coach / Admin；同一 Booking、模板和收件人继续由数据库唯一键保证幂等。
- 新增 `readAt`，Admin Overview 与 Coach Portal 都显示最近通知、未读数量、Booking/Class 入口、邮件任务状态和 Mark read。
- People 可为 Coach 保存 `notificationEmail`；Settings 可保存 Shop 的 `operationsEmail`。这些是运营通知地址，不是 Coach 登录身份。
- Admin 和 Coach 通知读取、已读写入均在服务端按 `shopId + recipientKind + recipientId` 限定。
- 邮件模板支持 Admin 版本；Admin Bookings 的邮件预览列表能正确区分 Admin、Coach 和 Customer。

### Admin Overview

- 实现 Define → Schedule → Operate → Review 四步工作入口。
- “Classes today”来自当前 Shop 时区内已发布/已完成 Session，并显示报名位数 / 总容量。
- “Bookings needing action”来自 `WebhookReceipt` 的 `NEEDS_ATTENTION / FAILED`。
- “Passes expiring in 30 days”只统计已开始、未过期、active 且仍有 available / reserved 课次的 Entitlement。
- Today’s classes 与 Pass expiry alerts 使用真实查询；保留 No-show credit returned 与 Booking 通知区。

### Admin Reports

- 日期范围：最近 7 天、最近 30 天或自定义最多 366 天；支持按 Customer 筛选。
- Customer spending：统计本 Booking App 处理的 validated booking spend、其中 NEW_PASS revenue、购买次数与最近购买日。
- Purchased Passes with unused classes：显示 Customer、Pass、purchased、used、available、reserved、remaining 和 expiry。
- 支持两类 UTF-8 CSV 导出，并对以 `= + - @` 开头的单元格做 spreadsheet formula injection 防护。
- Refund 当前明确显示 `Not synced`，不把未知退款错误显示成 0；全店 Shopify 订单和退款仍应在 Shopify 做财务对账。

## 数据库变更

- `202609160016_internal_booking_notifications`
  - `Shop.operationsEmail`
  - `Coach.notificationEmail`
  - `BookingNotification.readAt` 与收件箱索引
- `202609160017_admin_booking_notification_recipient`
  - 将 `BookingNotification_recipientKind_check` 扩展为 `CUSTOMER / COACH / ADMIN`
- 两条迁移已应用于本地 `skyra_booking` 与专用 `skyra_booking_test`；**尚未应用 Render**。

## Coach 测试结果

- 当前本地开发库 `skyra_booking` 只有 `Development Coach`，共 3 个 Session；没有名为 Karen 的 Coach。因此用户截图中的 Karen 很可能位于另一个运行环境，本轮不能声称完成 Karen 的真实账号 UAT。
- 使用专用测试库 fixture 重跑 production-build Coach smoke：390px 与 1440px 均通过一次性登录、Coach 站内 Booking notification、Monday–Sunday 周日历、Month 筛选、Training profile、No-show `RELEASE=1 / CONSUME=0`、空状态、退出、无横向溢出；两种宽度 `pageErrors=[]`。
- 证据：`output/playwright/coach-booking/results.json` 及同目录截图/邮件预览。

## 尚未完成

- 没有选择或配置事务邮件 provider，Worker 也没有真实投递 adapter；当前只建立幂等 email job、模板、地址配置与状态模型，**没有真实发送 Coach/Admin 邮件**。
- `notificationEmail` / `operationsEmail` 尚未做邮箱所有权验证；也不用于 Coach 登录。
- Karen 不在本地数据库；需要先确认她所在的是 Render、另一份本地数据库还是 Shopify CLI 临时环境，再在同一环境生成单次入口做真实 UAT。
- 正式 Coach Invite / Resend / Revoke、邮箱 magic link 登录、会话续期与真实收件验收未完成。
- Shopify 全店 customer spend、discount、refund 同步未实现；当前 Reports 只覆盖 Booking App 可证明的交易范围。
- 未做真实 Admin embedded browser UAT、Render migration/deploy、CI、commit 或 push。
- 手机 OS push、浏览器 push、SMS、waitlist 和 schedule-change notification 都不在本轮范围。

## 主要代码入口

- Notifications：`app/services/booking-notifications.server.ts`、`in-app-notifications.server.ts`、`app/components/booking-notification-list.tsx`
- Coach：`app/routes/coach.tsx`、`app/routes/coach_.classes.$id.tsx`
- Admin：`app/routes/app._index.tsx`、`app/routes/app.people.tsx`、`app/routes/app.settings.tsx`
- Reports：`app/services/booking-reports.server.ts`、`app/routes/app.reports.tsx`、`app/routes/app.reports.export.tsx`
- Overview data：`app/services/admin-overview.server.ts`
- Tests：`tests/in-app-notifications.test.ts`、`tests/admin-overview.test.ts`、`tests/booking-reports.test.ts`、`scripts/coach-booking-smoke.mjs`

## 下一步顺序

1. 确认 Karen 所在环境并补真实 Coach 登录/页面 UAT，不复制 Coach 记录到错误数据库。
2. 选择事务邮件 provider，验证 From domain，定义 Customer/Coach/Admin verified recipient 解析并接 Worker 实际投递与回执对账。
3. 在部署前备份并应用 016/017 migrations，完成 Admin embedded UI 和 Coach 真实账号 UAT。
4. 单独设计 Shopify 全店订单/退款同步后，再把 Reports 的 Customer spending 扩成财务口径；在此之前保留当前来源说明。
5. 完整记录 local、CI、Render、真实收件与真实账号证据后才允许把对应项目标记完成。
