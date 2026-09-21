# Skyra Booking 上线状态、迁移与正式部署（更新 2026-09-21）

> 2026-09-21 本次实现更新：独立正式店 gate、首次课程激活/日历月、Mindbody 幂等 importer 与本地测试已推进。以 [实现记录与操作手册](production-implementation-2026-09-21.md) 的最新证据为准；以下“当前尚无 importer/只允许开发店”描述属于本轮开始前的交接基线。正式安装、真实 UAT、最终 cutoff 和公开放行仍需逐项验收。

目标日期：2026-09-21（Australia/Sydney）。本页是当前上线判断和正式部署顺序的唯一入口；旧文档保留历史过程，发生冲突时以本页和后续真实验收记录为准。Mindbody 文件审计、字段缺口和导入对账规则见 [Mindbody 数据迁移审计与执行方案](mindbody-data-migration-2026-09-21.md)。

## 当前结论

**目前可以开始正式店安装、目录配置和迁移 dry-run，但不能直接开放正式付费预约。** 数据基线与未来预约的 Pass 来源已经核清，但 production store gate 仍被代码明确关闭，迁移 importer、legacy entitlement 映射、真实邮件、Customer Account、Shopify 测试支付闭环、正式店安装与公开入口切换仍未签收。可以先部署代码和后台，保持正式交易入口关闭；完成下方 P0 后再开放付费预约。

2026-09-20 部署后核对：提醒提交 `f6c16d3` 已通过 GitHub CI 并在 Render 成为 `live`，pre-deploy migration 完成，Web 与 Worker 均已启动，公开 `/health` 返回 200。开发店有 4 节未来 `PUBLISHED` 课程；Checkout、Owned Pass 环境开关和数据库 `onlineBookingsEnabled` 都为开启，实际离线授权已有 `read_customers`、`read_orders` 与 Storefront 商品/Checkout 权限。该能力只允许 `skyra-booking-dev.myshopify.com`，适合今天做真实 UAT，不代表正式店已经上线。

2026-09-21 文档核对时，`bookingdev` 当前提交为 `b2880f7`。`commerce-capabilities.server.ts` 仍只接受开发店，Admin Settings 也明确显示 production stores blocked。不能把 `SKYRA_BOOKING_TEST_SHOP` 改成正式店作为绕过；必须先实现并测试独立的 production release gate。

## 2026-09-21 Mindbody 导出审计

- 客户主档仍可关联：287 个 Client ID，286 行有邮箱、281 个唯一邮箱。
- 最新 Schedule 已确认 8 条未来 `Reserved` Booking、7 位客户，最后一节为 2026-09-27；全年 Visits Remaining 已将 8 次 reservation 全部映射到具体 Pricing Option。
- 全年 Visits Remaining 有 63 条：43 条已过期，20 条在 2026-09-21 尚未到期或未来激活。扣除一条过去私教 Absent 的 stale reserved 后，参考基线为 161 available、8 future reserved；两条 Intro Pass 当天到期，cutoff 晚于当日时再减 6 available。
- 一条多出的 reserved 已定位到过去的 Absent 私教 Visit；按 No-show 消费，迁移为 available 7、reserved 0、consumed 3，不创建未来 Booking。
- 该私教产品虽然旧名称含 Single Pass，实际上是 legacy 10-session Pass；迁移为不可售私教旧权益，避免变成 1-credit Pass。
- 新 Pass 有效期从首次报名课程对应的上课日期开始，不从购买时间开始；截图中的购买日、Activation date 与首节课程日期再次验证了该规则。
- 唯一 Location 已确认为 `1202, 180-186 Burwood Road, Burwood NSW 2134`。普通团课 Pass 用于所属类别普通课，1:1 为 Appointment/私教课并使用独立 Pass。
- 本次迁移优先保住客户、最终未来 Booking 与全部未完成 Pass 余额；课程 duration/capacity 保持 Admin 可编辑，未校对 Session 不公开。

## 正式部署与切换顺序

正式店目标以主题配置中的 `mf0n6s-zg.myshopify.com` 为准。开发店数据不复制到正式店，开发店 Product/Variant GID 也不复用。

### 1. 发布前代码关口

1. 为正式店实现独立 production shop allowlist 和 Checkout/Owned Pass gate；保留紧急关闭能力。
2. 把 Pass 有效期从“购买时间 + validityDays”改为“首次 Booking 对应课程日期 + 天/自然月”，并保证首次激活幂等。
3. 补迁移 importer：默认 dry-run、正式 shop 锁定、Mindbody source mapping、稳定外部键、重跑幂等、批次审计、禁止导入时发信。
4. 为客户去重、旧 Pass opening balance、未来 Booking + RESERVE、首次激活并发和 Drop-in 编写数据库测试。
5. 执行 `npm.cmd run check`、专用 PostgreSQL 测试、Worker build 和 Shopify config validation。
6. 提交、推送并等待 GitHub CI 成功后，Render 才允许自动部署。

### 2. 安装正式 Shopify App

1. 在正式店安装同一 Skyra Booking App，完成 OAuth 和当前 scopes 授权。
2. 回读正式店离线 Session、`read_customers`、`read_orders`、App Proxy 和 `orders/paid` webhook。
3. 确认安装产生独立正式 Shop 记录；不得复制开发 Shop 行或 Session token。
4. 配置 Customer Account Extension 和 Theme App Extension，但暂不发布对外 Booking 入口。

### 3. 正式目录和 Shopify 商品

1. 创建唯一正式 Location `1202, 180-186 Burwood Road, Burwood NSW 2134`、Coach、Service 和 PassPlan。
2. 补齐 duration、capacity、有效期数值/单位、首次课程激活规则、eligible services 和 CLASS/APPOINTMENT/COURSE 类型。
3. 启动 Worker，让正式记录创建新的 Shopify Product/Variant/ProductMapping。
4. 确认所有待售 mapping 为 `SYNCED`，价格、币种、标题、metafield ownership 和 Online Store publication 正确。
5. 不复制 `[DEV]` 商品或开发店 mapping ID。

### 4. 客户和 Mindbody 数据

1. 导入去重后的 Shopify Customer CSV。
2. 在正式 Booking Admin 执行 `Sync Shopify clients`，建立 CustomerProfile。
3. 按 [Mindbody 数据迁移方案](mindbody-data-migration-2026-09-21.md) 完成 Pass/Booking dry-run；当前缺口未补齐前停止在此步骤。
4. 备份正式 PostgreSQL，再执行批准的 migration batch。
5. 对账 remaining、available、reserved、Session 和 Booking；不要迁移 Sales/Attendance 到交易模型。

### 5. Resend 和角色邮箱

正式店安装完成后再配置：

- `SKYRA_MAIL_ENABLED=true`
- `SKYRA_MAIL_PROVIDER=resend`
- `RESEND_API_KEY` 使用 Render secret
- `SKYRA_MAIL_FROM=hello@skyrastudio.com.au`
- `SKYRA_BOOKING_MAIL_SHOP=mf0n6s-zg.myshopify.com`
- `SKYRA_COACH_LOGIN_SHOP=mf0n6s-zg.myshopify.com`
- `SKYRA_COACH_MAIL_KEY` 使用独立 32-byte AES key，不复用 Shopify secret

在 Admin Settings 保存 operations email，在 People 保存 Coach notification/login email。分别验收 Customer、Coach、Admin confirmation、取消和 12 小时提醒。`ACCEPTED` 只表示 Resend 接受请求，还需确认 Inbox、Spam 和退信情况。

### 6. 正式 UAT

保持公开交易入口关闭，完成：

1. Drop-in：登录 → Checkout → 测试支付 → `orders/paid` → Booking。
2. 新 Pass：付款后只创建一次 Entitlement，只为目标 Booking 预留一次 credit；startsAt 使用首次课程日期，重试不移动到期日。
3. 已有 Pass：不进入 Checkout，预约和取消/No-show ledger 正确。
4. Customer Account：余额、未来预约、历史、取消和改期。
5. Coach：真实邮件激活、Today、Roster、No-show、退出和撤销。
6. Admin：Booking、通知、Needs Attention、客户搜索和 Reports。
7. 手机和桌面：Home、Programs、My account、返回原课程和错误恢复。

### 7. 主题和公开入口切换

1. 在正式主题副本验证 Theme App Extension、Home、Programs 和 My account。
2. 发布 `shopify-theme` 中已经批准的移动 Hero/CSS 和 Booking 挂载代码。
3. 移除或隐藏旧 Mindbody Booking 链接前，保留可快速恢复的旧主题版本。
4. 经营者确认 Shopify Payments、payout、2FA、银行和 test mode 已处于正确状态。
5. 先开启 production capability environment gate，再由 Admin 最后开启 `onlineBookingsEnabled`。
6. 发布主题并进行一笔受控真实小额交易；确认订单、Booking、邮件和 payout 证据后再全面开放。

### 8. 上线后监控和回滚

- 首日逐笔对账 Shopify paid orders、WebhookReceipt、Outbox、Entitlement、Booking 和邮件状态。
- 检查 Render Web/Worker、PostgreSQL、Redis、队列重试、Needs Attention 和 `/health`。
- 任一支付、身份、Worker、余额或邮件异常，立即关闭 production capability 和 `onlineBookingsEnabled`，恢复上一个正式主题或 Mindbody 入口。
- 不删除订单、Booking、Entitlement、ledger 或 webhook 证据；按 migration batch 和数据库恢复点处理。

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
| 未完成 | Mindbody 数据迁移 | 全年 Visits/Sales 与最新 Schedule 已建立基线：20 条当前/未来余额记录、8 条 Booking，旧三份报表已删除；三笔 SKYRA Lifestyle 已确认为连续三个月、每月 12 次。剩余工作是处理 cutoff 到期变化，并完成 importer、legacy 映射、首次课程激活改造和 dry-run 签收。 |

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
