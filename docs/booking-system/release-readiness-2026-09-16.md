# Coach、Reports 与正式发布前收口

更新：2026-09-16。此文件是本批 Coach / Admin Reports 的最新状态与整站发布前行动清单；旧文档中“Karen 未核验”“课程仍为 DRAFT”“33 文件 / 371 项”的描述均由本文取代。

## 本批已经完成

- Coach Portal 已收敛为 Today、Monday–Sunday 周课表和课程名册；手机按日显示，桌面按周显示。
- 名册可查看对应 Customer 的 Training profile 与本次 Booking note；不展示地址、付款、订单或营销资料。
- Coach 不 Check in。Booking 默认会出席；课程结束后可标记 No-show，系统退回 1 次已预留 Pass，并给 Admin 建立提醒。24 小时窗口后仍未标记的 Booking 自动结算为 Attended。
- Customer Booking 确认会建立 Customer、对应 Coach、Admin 三方站内通知；邮件任务和可选投递 adapter 已实现。
- Coach 登录页已支持 Coach 自己填写姓名和邮箱提交账号申请。申请不会直接取得权限；Admin 在 People → Coach account requests 选择现有 Coach（例如 Karen）并批准后，才绑定登录邮箱。
- Admin Reports 已按 `wireframes.html` 的两块结构实现：Customer spending 与 Purchased Passes with unused classes；支持日期、Customer 筛选、单份 CSV 和双报告 ZIP。
- Reports 当前不会伪造 Shopify refund：尚未同步的 Refund 显示未连接；全店 Shopify 订单/折扣/退款不是当前 Booking 报表数据源。

## Karen / Add coach 的 Dev 数据证据

2026-09-16 使用已登录 Render CLI，在现有 `skyra-booking-web` Dev 服务内部运行只读查询；没有开放数据库公网白名单，也没有输出 Karen 邮箱或客户数据。

- 店铺：`skyra-booking-dev.myshopify.com`，记录存在。
- Coach：Karen，状态 `ACTIVE`，ID `e7153b5c-67dc-4e46-8422-399b42d49aa8`。
- 排课：`[DEV] Aerial Foundations`，`PUBLISHED`，容量 8。
- 开始：数据库 `2026-09-18T00:00:00Z`，即 Australia/Sydney 2026-09-18 10:00。

结论：People 页的 Add coach 已成功写入 Render Dev PostgreSQL，Weekly Schedule 也通过 `coachId` 外键绑定到这条 Karen 记录。之前本地查询没有 Karen，是因为 `.env` 指向 `127.0.0.1:55432/skyra_booking` 的独立本地数据库，不是 Render Dev；不能据此判断 Add coach 失败。

## 当前登录与邮件流程

1. Karen 打开 `/coach/login`，填写自己的姓名和登录邮箱，提交申请。
2. 申请只写入待审批队列，不创建第二个 Coach、不自动授权、不返回登录凭据。
3. Admin 打开 Booking App → People → Coach account requests，选择已有 Karen，点击 Approve login。
4. 审批把申请邮箱绑定到 Karen 的 `loginEmail` 和通知邮箱；首次 magic link 验证后激活，之后继续无密码登录。
5. 旧的 Authorized login email 控件保留作人工改绑/撤销；主流程以申请队列审批为准。

`hello@skyrastudio.com.au` 只在 `.env.example` 中作为 `SKYRA_MAIL_FROM` 建议值。Shopify Settings → Notifications 的 Sender email 只负责 Shopify 自己的通知，不会自动授权 Booking App 发信。当前没有在 Render 配置事务邮件 provider、API secret 和发信域名，因此本批没有真实发送邮件；fixture/mock 邮件通过不等于 Karen 已收到邮件。

## 2026-09-16 验证证据

- 专用 PostgreSQL 测试库：20 条 migration，无待执行 migration。
- 全量回归：35 个测试文件、379 项测试全部通过。
- `npm.cmd run check`：主 TypeScript、Customer Account TypeScript、ESLint、production build 全部通过。
- Worker production bundle：通过。
- Coach 核心浏览器流程：390px / 1440px 均通过登录、站内通知、周课表、Training profile、No-show 退回课次、退出和无横向溢出；`pageErrors=[]`。
- 注册/审批/登录/Reports 模拟流程：390px / 1440px 均通过；Admin 审批和 magic link 使用 mock transport，`realEmailSent=false`、`realKarenUat=false`。
- 双报告 ZIP 已由 Windows 标准 `System.IO.Compression.ZipFile` 打开；每个 ZIP 含 spending CSV 与 unused Pass CSV 两项。
- Dev Karen 只读诊断任务 `job-dal61adg1s2s73ec4rk0` 成功；第一次仅因诊断脚本 import 语法失败的任务 `job-dal60jqd0e5s738m1evg` 未写数据库。

## 正式发布前仍未完成

### 必须阻塞正式开放交易

1. **Shopify Payments 与银行**：由真实商户负责人在正式店完成身份、企业资料、两步验证、银行账户和 payout 检查；不要把证件或银行号码写入本仓库或聊天。
2. **真实支付闭环 UAT**：在开发/测试模式分别签收 Drop-in、新 Pass、已有 Pass：Checkout → `orders/paid` → Worker → Entitlement/Reserve → Confirmed Booking → Customer/Coach/Admin 可见。订单成功本身不等于 Booking 闭环成功。
3. **真实 Customer Account UAT**：新老 Customer 登录、返回原课程、My Skyra、取消/改期、Pass 余额，在手机和桌面真实账号完成。
4. **真实 Coach 邮件/UAT**：选定事务邮件 provider，认证 `hello@skyrastudio.com.au` 发信域名，在 Render 配置 secrets；Karen 提交申请、Admin 批准、真实收件、首次登录、退出、重复/过期链接、手机/桌面全部签收。
5. **能力开关**：`SKYRA_BOOKING_CHECKOUT_ENABLED`、online bookings、owned Pass 只能在以上交易 UAT 和回滚准备完成后按既定顺序开启；不得因为自动化通过而直接开放。

### 上线运维必须补齐

- Render PostgreSQL 备份与恢复演练、Worker 单实例/重启验证、失败队列和告警、日志留存、迁移回滚方案。
- `orders/paid` 漏消息 reconciliation 和 Needs Attention 的人工处理闭环。
- 正式店安装/权限、App Proxy、Customer Account 与 Theme App Extension 版本复核；移除仍对外可见的旧 Mindbody/静态预约入口。
- 取消/Late Cancel/No-show 时间窗和退款线下流程由业务负责人最终签字；当前 No-show 为退回 Pass，退款仍由 Admin 线下处理。
- 如承接旧系统，先 dry-run 导入客户、未来预约和未用课次并对账，再演练切换/回滚。

### 可延期但必须明确不是首发能力

- Shopify 全店订单、discount/refund 财务同步到 Reports；当前 Reports 是 Booking 运营口径。
- Customer protected email resolver、课前 Reminder、调课/取消邮件、bounce/delivery webhook。
- Coach recurring availability、time off、本人统计，以及 Waitlist/Course 整期报名等增强项。

## 你现在去连接银行卡时要准备

- 由适格的实际经营者/负责人登录正式店 Shopify Admin → Settings → Payments。
- 准备真实经营主体、ABN/ACN（适用时）、负责人身份证明、业务地址、联系电话、AUD 收款账户名称、BSB 和账号。
- 开启 Shopify 账号两步验证；核对 Shopify Payments、Shop Pay、Apple Pay / Google Pay 的可用状态和 payout schedule。
- 银行账户只在 Shopify 后台填写，不发给开发人员，不截图保存到项目文档。
- 同时确认 `hello@skyrastudio.com.au` 与 DNS 管理账号可登录；Shopify 通知发件认证和 Booking App 事务邮件 provider 是两套配置，都要分别验收。

## 本批交付状态

当前代码与文档仍位于本地 `bookingdev` 工作区；待提交、GitHub CI、Render pre-deploy migration、Dev health、Coach 登录页和 Admin 页面部署验证完成后，在本节追加 commit / run / deploy 证据。没有发布正式店、没有开启付款开关、没有发送真实邮件。
