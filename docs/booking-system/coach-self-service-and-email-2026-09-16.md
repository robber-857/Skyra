# Coach 自助激活、Dev 核验与品牌邮件

更新：2026-09-16。分支 `bookingdev`；运行提交 `06468757b36688826519b516b25996f8a2f3f57b` 已推送并部署 Render Dev，CI `35080110796` 与 deploy `dep-dal64seq1p3s73ekc8bg` 成功。

> 最新复核：产品主流程已更新为 Coach 自己在 `/coach/login` 提交姓名/邮箱申请，Admin 在 People 的 Coach account requests 中把申请批准到已有 Coach；不是先由 Admin 猜测并填写邮箱。Render Dev 已确认 Karen 与其 `PUBLISHED` 课程存在，完整回归为 35 文件 / 379 项，015–019 已部署。Karen 当前仍未绑定 login/notification email，Render 真实邮件配置全为空，因此没有真实发送。详见 [Coach、Reports 与正式发布前收口](release-readiness-2026-09-16.md)；下文保留了实现过程中的较早描述。

## 产品决定与实际使用方式

用户本轮要求 Coach 自动注册和登录，取代旧文档中的“只能 Admin 邀请、不支持自助申请”方向。当前实现为 **Admin 授权邮箱后的自助激活和密码less登录**，不是公开注册后直接成为 Coach。

1. Admin 在 People 创建 Coach 排课资料（Karen 已由用户在 Dev 创建）。这一步仅创建可分配课程的记录，不是完成账号认证。
2. Admin 在该 Coach 的 **Authorized login email** 授权真实邮箱。它与 **Booking-notification email** 分开，后者绝不授予登录权限。
3. 邮件配置与部署完成后，Coach 打开 App host 的 `/coach/login`，输入获授权的邮箱，点击 **Email me a sign-in link**。
4. Coach 在邮件中打开 15 分钟单次链接，点击 Continue。首次验证自动激活已有 Coach 身份，以后同一路径登录，不设置密码，不需要 Shopify Admin/Customer Account。
5. 成功后是最长 8 小时 HttpOnly/SameSite session；退出、过期、停用或改绑邮箱失效。邮箱变更撤销旧 token/session，清除 verifiedAt，待重新验证。

未知邮箱和仅用于通知的邮箱得到相同的通用响应，不创建 Coach、不返回凭据、不授予名册权限。当前没有“未知邮箱先申请、Admin 审批新 Coach”工作台，也没有用户设置密码或自动获得 Coach 身份的开放注册。

Customer 登录和主页 newsletter 没有改动：Customer 仍使用 Shopify 托管邮箱验证码；主页订阅只记录营销同意，不登录、不创建预约/Pass、不授予 Coach 权限。

## 本轮已实现（本地代码）

- `Coach.loginEmail` 按店铺唯一且规范化，`loginVerifiedAt` 记录邮箱验证；Admin-only 绑定、跨店拒绝、重复邮箱拒绝、换邮箱撤销与审计。
- 自助申请登录邮件，1 分钟冷却、每 Coach 每小时最多 5 次、每店每小时最多 100 次；数据库锁保护并发。正式开放前仍需边缘/IP 级滥用防护。
- 登录邮件 durable outbox，token hash 与 AES-256-GCM 加密投递载荷分开存储，AAD 绑定 tokenId；投递结束/过期后清除加密载荷。token 不进入 URL query、服务端页面或日志。
- 可选 Resend HTTP transport 和 Worker 登录邮件 sweep；默认关闭，不创建 provider 账号、不改 DNS、不使用 Shopify API secret 作为加密 key。
- Coach/Admin 预约确认与取消邮件的 Worker 投递代码已接该 transport，按内部 recipient ID 解析当前授权通知地址，只处理显式配置的店铺。
- 接受结果记录 `ACCEPTED` 与 provider message ID；超时/不明确结果记录 `UNKNOWN`，不自动盲重发。`ACCEPTED` 不等于邮件进入收件箱。
- 登录页增加 activate/sign-in 说明和邮箱申请表；邮件未配置时明确说明不可用。People 显示登录邮箱授权与激活状态。
- 修正确认邮件：No-show 返回预留 credit 并通知 Admin，不再误写 No-show 消费课次。
- 修正 Overview 的到期统计不再被前 50 条明细截断；明细仍最多显示 50 条。CSV 购买/到期日期使用 report 店铺时区，不截 UTC 日期。
- 新增只读 `booking-app/scripts/coach-environment-check.ts`，可在目标环境输出 Karen 与课程状态，邮箱仅显示是否配置，不打印密码/API key。

## Dev 与数据库：本轮核验到什么

| 检查 | 证据与结论 |
| --- | --- |
| 源码分支 | `bookingdev`，上述 HEAD；dirty tree 已保留，无 commit/push/deploy |
| App 配置 | `shopify.app.toml` App URL 为 `https://skyra-booking-web.onrender.com`；它是配置证据，不是浏览器当前 iframe host 证明 |
| Render 健康 | 本轮只读请求 `/health` HTTP 200、`{"status":"ok"}`；接口仅执行 SELECT 1，不返回部署 SHA 或 Coach 数据 |
| Render 登录页 | `/coach/login` 本轮 HTTP 200，仍包含旧 secure sign-in link 提示，未包含新 activation 说明；新自助登录尚未部署到该 host |
| 当前本地 DB | `127.0.0.1` / `skyra_booking`，Dev shop 存在，Karen 查询结果为空；不可替代 Render DB 检查 |
| 用户 Dev 截图 | People 有 Karen；9 月 18 日 10:00 `[DEV] Aerial Foundations`、0/8、DRAFT；这是用户提供的 UI 证据，不是本轮直接 SQL 核验 |
| 原 Dev DB / 部署版本 | 未获得可用的 Render 数据库会话或部署 SHA；浏览器连接工具两次启动失败。本轮没有直接核验 Karen 在原库的身份、邮箱或 Session ID |

**DRAFT 不会显示在 Coach 正式课表。** 当前 Coach query 只包含本人的 PUBLISHED / COMPLETED / CANCELLED 场次。没有替用户发布课程、复制 Karen 到本地或改动她的排课状态。

拿到目标 Render Shell 后，用该环境现有 DATABASE_URL 运行只读检查（不要把凭据粘贴进文档）：

```powershell
node --import tsx scripts/coach-environment-check.ts
```

本地运行增加 `--env-file=.env`。脚本有新字段，因此旧部署需先完成迁移 018；没有 Shell/数据库权限时，可以先在真实 Dev People/Weekly Schedule 人工核对。Render revision 有值时仅打印该环境的 `RENDER_GIT_COMMIT`。

## hello@skyrastudio.com.au 怎么发预约邮件

主商店 Settings → Notifications → Sender email 影响 **Shopify 自己发送的通知/订单邮件**。按 Shopify 后台给出的记录完成发件人认证；它不会给 Booking App 一套 SMTP/API 凭据，也不会自动配置 Dev 店。

Skyra Booking 的 Pass 预约可只发生在 Booking DB，不产生新 Shopify Order。预约确认、私教 appointment、课前 reminder、Coach 登录都是 Booking 业务事件，应由 Booking Worker + transactional provider 发送，而不是把订单确认当成预约确认。

本项目不要求 Email Workflow。Shopify Messaging 自动化主要用于营销；Flow 的 Send internal email 面向固定员工收件人，不能直接动态替代每次预约对应 Coach/Customer 的通知。Flow connector 不是本轮完成范围。

官方依据：[Sender email](https://help.shopify.com/en/manual/intro-to-shopify/initial-setup/setup-your-email)、[Store notifications](https://help.shopify.com/en/manual/fulfillment/setup/notifications)、[Flow Send internal email](https://help.shopify.com/en/manual/shopify-flow/reference/actions/send-email)、[Shopify Messaging automations](https://help.shopify.com/en/manual/promoting-marketing/create-marketing/shopify-messaging/marketing-automations/create)。

当前提供 Resend 可选 adapter，不代表经营者已选购该服务；可在确认后替换 transport。真实发信需要 provider 账号、验证发信域名和 API key。收信邮箱可以继续留在现有邮箱服务，不需要改 MX 来切换发信。

安全配置入口在 `booking-app/.env.example`：

- `SKYRA_MAIL_ENABLED=false` 是默认；只有确认 provider/DNS/收件人、旧 PENDING 队列与发送范围后再设 true。
- `SKYRA_MAIL_PROVIDER=resend`、`RESEND_API_KEY`、`SKYRA_MAIL_FROM=hello@skyrastudio.com.au`。
- `SKYRA_COACH_MAIL_KEY`：独立随机 32-byte AES key、64 位小写 hex，放 secret manager，禁止入库/日志/Git。换 key 会使旧未投递载荷不能解密，需要重新申请。
- `SKYRA_COACH_LOGIN_SHOP` 与 `SKYRA_BOOKING_MAIL_SHOP`：显式选择目标店，不自动启用所有租户。
- People 的 notification email 是 Coach 收件人；Settings 的 operations email 是 Admin 收件人；From 与收件人不同概念。

Resend 官方接口与幂等说明：[Send Email](https://resend.com/docs/api-reference/emails/send-email)、[Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys)。本轮所有 provider 测试均为 mock，没有向 hello/Karen/Customer 发出真实邮件。

## 未完成与下一步顺序

1. 在原 Dev/Render 环境直接核验 Karen、课程、部署 SHA 和迁移状态。确认备份/上线步骤后部署本轮代码与迁移 015–018；不要只升级 App extension 而漏后端/Worker。
2. 经营者提供 Karen 应获授权的真实邮箱并确认 provider；配置 secrets、发信 DNS 与 sender verification。不要在对话或 Git 中提交 API key。
3. Customer 邮件仍缺 Shopify 受保护的真实邮箱解析/权限/验收；**Customer notification 仍为 PENDING，不会由本轮 internal adapter 投递**。Coach/Admin 也只有代码接通，真实配置未启用。
4. Reminder、Reschedule/Session 变更邮件、provider delivery/bounce webhook、UNKNOWN 对账/人工恢复和真实收件验收未完成；No-show 的 Admin 站内提醒已有，但独立 No-show 邮件未实现。
5. 邮箱公开申请需增加边缘/IP 限流与安全评审，完成 Karen 首次激活、重申请、退出、过期、撤销、手机/桌面真实账号 UAT。
6. 全店 Shopify order/discount/refund 财务同步、Admin 真实账号 Overview/Reports UAT 与完整真实支付 UAT 仍未完成。

## 验证证据

- 新迁移 `202609160018_coach_self_service_login` 已应用本地开发库与专用测试库，未应用 Render。
- `npm.cmd run check` 通过（typecheck / Customer typecheck / lint / production build）；最终 lint 无错误/警告，`npm.cmd run build:worker` 通过。
- `npm.cmd run test:db`：33 文件、371 项通过；新测试覆盖获授权邮箱首次验证、通知邮箱无权限、并发申请冷却、Admin-only/跨店/唯一性、改绑撤销、过期抑制、UNKNOWN 不重发和 Mock Coach/Admin Booking 发信。
- production-build smoke：390px / 1440px 的受限登录、站内通知、周日历、Month 筛选、Training profile、No-show RELEASE、空状态和 logout 通过，`pageErrors=[]`，无横向溢出。
- 上述浏览器流程使用 fixture/内部测试 token，**不等于自助邮件收件 E2E 或 Karen 真实 Dev UAT**。
