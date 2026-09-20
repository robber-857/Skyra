# Skyra Booking 上线状态与 12 小时课前提醒（2026-09-20）

目标日期：2026-09-21（Australia/Sydney）。本页是当前上线判断的唯一入口；旧文档保留历史过程，发生冲突时以本页和后续真实验收记录为准。

## 当前结论

**目前不建议在 2026-09-21 直接开放正式付费预约。** 代码主体已接近可验收，但真实邮件、真实 Customer Account、真实 Shopify 测试支付闭环、正式店安装与公开入口切换仍未签收。可以先发布代码和迁移，保持正式交易入口关闭；完成下方 P0 后再开放付费预约。

2026-09-20 现场核对：Render `/health` 返回 200，当前运行提交仍为 `654a30a`；开发店有 4 节未来 `PUBLISHED` 课程。开发店的 Checkout、Owned Pass 环境开关和数据库 `onlineBookingsEnabled` 都为开启，实际离线授权已有 `read_customers`、`read_orders` 与 Storefront 商品/Checkout 权限。该能力只允许 `skyra-booking-dev.myshopify.com`，适合今天做真实 UAT，不代表正式店已经上线。

## 本轮完成：Booking 后 12 小时课前提醒

- 确认 Booking 时额外建立一个 Customer `BOOKING_REMINDER_V1` 任务，发送时间为 `session.startsAt - 12 hours`。
- 如果 Customer 在开课前不足 12 小时才预约，提醒立即进入可发送队列；不会安排到过去。
- 每个 Booking 最多一条 Customer reminder，数据库唯一键和 upsert 防止 Worker/Webhook 重试产生重复提醒。
- 取消、Late Cancel、改期、No-show、Attended 或默认结算会作废尚未发送的旧提醒；改期为新 Booking 重新计算时间。
- Worker 每 30 秒扫描到期任务，通过 Shopify Admin API 以受保护 Customer GID 在发送时解析默认邮箱；不接受浏览器提交的收件地址，也不把邮箱写入通知任务。
- 邮件主题为 `Class reminder: <class>`，包含课程、日期、时间、Coach、地点、Booking reference，以及 No-show / Pass credit / Drop-in no-refund 规则。
- Admin → Bookings → Booking emails 会显示 `Customer reminder · 12-hour reminder`；仍按收件人分类、每页 8 条，并支持前后页、页数和跳转。
- Shopify Admin 2026-07 Customer query 已用官方 validator 验证，要求 `read_customers`。
- 新迁移 `202609200021_booking_reminders` 扩展允许的通知模板；本地专用 PostgreSQL 已成功应用。
- 本地验证：`npm run check` 通过；40 个测试文件、397 项全部通过。自动化不等于真实邮箱收件或真实支付 UAT。

## 已完成的产品能力

- Admin：Classes & Passes、Weekly Schedule、Coach/People、Client directory、Booking 管理、基础 Reports、通知分类和各列表分页。
- Customer：Home/Programs 共用 Booking 组件、Shopify 登录交接、Booking Review、Drop-in / 新 Pass / 已有 Pass 的服务器端流程、My bookings / Pass / profile、取消与改期代码。
- Coach：自助申请、Admin 审批、magic-link 登录代码、Today、周课表、Session roster、Training profile、No-show。
- 交易后端：Hold、Cart、`orders/paid` 验签/幂等、Worker、Entitlement ledger、Booking confirmation、异常状态和恢复查询。
- 出席政策：默认参加；No-show 消费已预留的 1 次课，Pass credit 不退，Drop-in 不自动退款；未标记者在窗口后结算 Attended。
- 通知：Customer / Coach / Admin 确认与取消任务、预览、重试/UNKNOWN/SUPPRESSED 状态，以及本轮 Customer 12 小时提醒。
- 部署基础：Render Web 同一容器启动 Web + Worker，PostgreSQL、Redis、pre-deploy migration 和 `/health` 已存在；GitHub Booking App CI 最近提交均通过。

## P0：开放正式付费预约前必须完成

| 状态 | 项目 | 当前证据 / 下一步 |
| --- | --- | --- |
| 未完成 | Resend 与发件域名 | Render 当前 `SKYRA_MAIL_ENABLED=false`，Provider、API key、From、Coach/Booking shop、Coach 加密 key 均未配置。先在 Resend 验证 `skyrastudio.com.au`，再把 secrets 写入 Render。 |
| 未完成 | 收件地址与真实邮件 UAT | Render 店铺没有 Admin operations email。配置 Admin 和 Karen notification/login email；真实签收 Admin、Coach、Customer confirmation、取消和 12 小时提醒。`ACCEPTED` 只代表 Resend 接受，不代表进 Inbox。 |
| 未完成 | 正式 Shopify 店安装与授权 | 开发店实际已有 `read_customers`；正式店仍需安装/重新授权、App Proxy、Customer Account、Theme App Extension 和 webhook 复核。 |
| 未完成 | 三条真实交易闭环 | 在开发店分别验收 Drop-in、新 Pass、已有 Pass：真实登录 → Checkout/测试支付 → `orders/paid` → Worker → Entitlement/Reserve → Booking → 三方页面和邮件。当前数据库只有 2 条历史 `ATTENDED`，不足以证明该闭环。 |
| 未完成 | 真实 Customer Account UAT | 新/老 Customer 在手机和桌面验收登录、返回原课程、My Skyra、余额、取消和改期。 |
| 未完成 | 真实 Coach UAT | Karen 申请 → Admin 审批 → 真实邮件 → 首次激活 → Roster / No-show → 退出、过期链接、撤销和重申请。 |
| 未完成 | 公开网站切换 | 2026-09-20 `skyrastudio.com.au` 首页仍包含 Mindbody 内容，`/pages/programs` 返回 404。正式开放前建立正确 Programs 页面，发布 Theme App Extension，检查 Home/Programs/My account 导航并移除旧入口。 |
| 经营者确认 | Shopify Payments / payout | 商户本人完成身份、2FA、银行账户、测试模式与 payout 检查；不把证件或银行资料写进仓库。 |
| 未完成 | 生产恢复与告警 | 完成 PostgreSQL 备份与恢复演练、Worker 重启、邮件/队列失败告警、日志留存和迁移回滚步骤。 |
| 未完成 | 漏单对账 | `orders/paid` reconciliation 和 Needs Attention 的人工处理闭环尚未完成；首发期间至少需要每日人工订单/Booking 对账。 |
| 视业务需要 | 旧系统迁移 | 如需接 Mindbody 旧客户、未来预约或未用课次，先 dry-run、去重、导入、对账和回滚演练。 |

## 2026-09-20 今天的执行顺序

1. 合入并部署本轮 Reminder 代码与 migration；确认 CI、pre-deploy migration、Web/Worker 和 `/health`。
2. 在 Resend 完成域名 DNS 验证；Render 配置邮件变量，Admin Settings 保存 operations email，People 保存 Karen notification email。
3. 用一个真实 Customer 和一节明天/后天的开发课程做真实邮件验收。测试时可把该 reminder 的 `availableAt` 调整到当前时间，但必须记录为测试数据，不能把生产规则改成短间隔。
4. 完成 Drop-in、新 Pass、已有 Pass 三条测试付款与 Customer/Coach/Admin 页面验收。
5. 完成 Karen 真实登录与 No-show 流程；确认 No-show 不退 Pass credit、不自动退 Drop-in。
6. 修复并发布 Home/Programs 正式入口，完成手机和桌面检查；正式交易开关最后开启。
7. 设置备份、告警和首日人工对账负责人，记录回滚方式。

## 2026-09-21 上线判断

- **可以发布代码/后台预览**：CI、migration、Render health 通过，正式交易开关保持关闭。
- **可以开放开发店 UAT**：开发店现有三个能力开关已开，可用于今天的真实测试。
- **可以开放正式付费预约**：只有上表 P0 全部有真实证据，并完成公开入口切换、支付/邮件/角色 UAT、备份和首日对账安排后才是 Go。
- 任一真实支付、Customer 登录、Worker、邮件或公开入口未通过时，结论为 No-Go；继续保留旧预约入口或只做软发布。

## 已知首发后增强项

- Resend delivery/bounce webhook 与邮件状态回写。
- 自动 `orders/paid` reconciliation、可操作 Needs Attention 和审计化人工处理。
- 完整 Shopify refund/discount 财务同步；当前 Reports 是 Booking 运营口径。
- Waitlist、Course 整期报名、周期 Availability、Time off 与 Coach 个人统计。
