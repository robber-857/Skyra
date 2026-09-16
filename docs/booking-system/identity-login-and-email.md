# 身份、登录与主页邮箱关系

## 2026-09-16 最新 Coach 账号入口

Coach 现在先在 `/coach/login` 自己填写姓名和邮箱提交账号申请；该申请不授予权限。Admin 在 People → Coach account requests 选择当前店已有 Coach（例如 Karen）并批准，系统才绑定登录邮箱并进入 magic-link 首次验证。People 中旧的 Authorized login email 控件仍可用于人工改绑/撤销，但不是新 Coach 的首选授权流程。该流程已部署 Render Dev；Karen 与 `PUBLISHED` 课程已确认，但她尚未提交/获批邮箱，真实事务邮件/provider 也尚未配置。完整证据见 [发布前收口](release-readiness-2026-09-16.md)。

更新：2026-09-16。

本文明确区分 Customer、Coach、Admin 与主页邮件订阅。它们可以在 Shopify 中共享同一个邮箱字符串，但不是同一种身份、权限或登录流程。

## 一句话结论

| 入口 | 当前身份来源 | 当前创建方式 | 是否已正式可用 |
| --- | --- | --- | --- |
| Customer Account | Shopify Customer profile / Customer Account session | Customer 在 Shopify 托管登录页输入邮箱和一次性验证码；不存在 Skyra 自建密码注册 | 身份链路与 Booking App token 验证已实现；真实账号完整 UAT 仍未签收 |
| Coach Portal | Booking App `Coach.loginEmail` + `CoachAccessToken` | Admin 授权邮箱后，Coach 自助申请链接；首次验证自动激活，无密码 | 本地代码已接；provider/部署与真实收件 UAT 未完成 |
| Admin App | Shopify Admin App session | Shopify 店主/员工权限 | 已有 Admin 认证边界，不与 Customer/Coach 共用 |
| 主页底部邮箱 | Shopify newsletter/customer form | 访客提交 `contact[email]`，标记为 newsletter / email marketing | 是营销订阅，不是登录，不授予 Booking 或 Coach 权限 |

## Customer 现在所见的“注册 / 登录”是什么

当前店铺使用 Shopify Customer Accounts，不实现 Skyra 自己的注册表、密码或找回密码：

1. Header 的 account component 或 Booking 中的 **Sign in with Shopify** 打开 Shopify 托管的 Customer Account 登录。
2. Customer 输入邮箱并使用 Shopify 发出的 6 位一次性验证码；不设置 Skyra 密码。
3. 若该邮箱已对应 Shopify Customer profile，Shopify 登录到该 profile；若不存在，Shopify 新版 Customer Accounts 会在首次成功登录时自动创建 profile，因此没有独立“先注册再登录”步骤。
4. 登录完成后，Customer Account extension 获取短期 session token。Booking 后端验证 Shopify 签名、有效期、App audience、shop destination 与 Customer GID，不信任浏览器直接提交的 customer id。
5. Booking App 只按 `shopId + shopifyCustomerGid` 建立最小 `CustomerProfile` 投影；preferred name、头像、签名、训练目标归 Booking App，正式姓名、邮箱、电话、地址和认证继续归 Shopify。

代码入口：

- Theme account 入口：`shopify-theme/snippets/header-actions.liquid`
- Booking 登录 hand-off：`booking-app/theme-extension-src/login.js` 与 `booking-app/extensions/skyra-booking-embed/assets/attempt.js`
- Customer Account token 验证：`booking-app/app/services/customer-account-auth.server.ts`
- Booking profile 映射：`booking-app/app/services/booking.server.ts`、`customer-profile.server.ts`

Shopify 参考：[Customer accounts](https://help.shopify.com/en/manual/customers/customer-accounts/new-customer-accounts)、[Customer Account API](https://shopify.dev/docs/api/customer/2026-07)。

## 主页下方填写邮箱是什么

Home 的 **Move with us, in your inbox / Join community** 使用 Shopify Liquid `{% form 'customer' %}`，提交 `contact[email]`，并带 `newsletter` tag。它的作用是建立或更新 Shopify Customer profile，并记录 email marketing consent。

它不会：

- 验证访客已经拥有该邮箱；
- 建立 Customer Account 登录 session；
- 创建 Booking、Pass 或 Training profile；
- 创建 Coach 账号或授予任何 Coach/Admin 权限。

它与 Customer Account 唯一可能的关联是邮箱匹配：如果访客以后用同一个邮箱完成 Shopify 验证码登录，Shopify 会登录到已有的 Customer profile，而不是再创建重复 profile。订阅本身仍然不等于已经登录。

Home custom template 会关闭全局 `footer-group`，因此主页实际使用 `shopify-theme/sections/skyra-home.liquid` 中的 community newsletter；普通非 Skyra custom template 可使用 `shopify-theme/blocks/email-signup.liquid`。两者都是营销收集，不是账号注册。

Shopify 参考：[Email consent](https://shopify.dev/docs/storefronts/themes/customer-engagement/email-consent)、[Liquid `customer` form](https://shopify.dev/docs/api/liquid/tags/form#form-customer)。

## Coach 当前怎么登录

用户最新要求改为支持 Coach 自助激活/登录。本地已实现独立 `Coach.loginEmail` 和 `loginVerifiedAt`，`notificationEmail` 仍只是通知收件地址，不等于身份。原 Dev 部署尚未升级，不能把本地实现当成 Karen 已可收件登录：

1. Admin 在 Booking App 的 **People** 中填写 public name、课前/课后 buffer，并可填写 Booking notification email，创建 `Coach` 记录。
2. Admin 为已有 active Coach 授权唯一、规范化的登录邮箱；仅通知地址或 Shopify Customer 同名邮箱不自动获得权限。
3. 配置/部署完成后，Coach 在 `/coach/login` 输入获授权邮箱申请 15 分钟单次链接。首次验证自动激活，兑换最长 8 小时的 HttpOnly session。token 保存 hash；未投递邮件载荷单独加密，终态/过期清除。
4. Coach 使用该 session 查看自己的 Today、周课表与本人 Session roster；退出、过期、撤销、Coach 停用后访问失效。

当前准确说法是：**支持 Admin 授权后的自助激活/无密码登录，尚未配置真实发信或部署到 Dev；未知邮箱不创建 Coach 权限，也没有开放注册后自动成为老师的流程。**

本轮身份流程与剩余配置：

1. Admin 创建 Coach，并填写唯一、规范化、可验证的工作邮箱。
2. Coach 自助申请，Booking App 向获授权地址投递 magic link；未知邮箱获得相同通用提示，但不建 Coach、不返回凭据。正式环境需补边缘/IP 防滥用。
3. Coach 首次兑换后进入本人 Portal，以后重新申请登录；Admin 改绑/清空邮箱会撤销旧会话与链接并要求重新验证。专用 Invite/Revoke 工作台尚未实现。
4. Coach 不使用 Shopify Customer Account，也不需要 Shopify Admin 权限。

代码入口：`booking-app/app/routes/app.people.tsx`、`coach_.login.tsx`、`booking-app/app/services/coach-auth.server.ts`、`coach-self-service.server.ts`、`transactional-mail.server.ts`；完整配置/Dev 证据见 [本轮自助登录与邮件](coach-self-service-and-email-2026-09-16.md)。旧 development-only 测试链接仍保留，不等于真实邮箱验收。

## 已完成

- Customer 使用 Shopify 托管 Customer Account 身份；Booking App 不保存 Customer 密码。
- Customer Account session token 的签名、时间、audience、destination、shop 与 Customer GID 校验。
- Customer Booking profile 与 Shopify Customer GID 的最小映射和本人范围隔离。
- Coach 记录由 Admin 创建；Coach Portal 与 Customer/Admin 身份隔离。
- Admin-only 登录邮箱绑定、Coach 自助申请与首次验证激活、换邮箱撤销、申请冷却/并发防重、加密投递 outbox 和默认关闭的可选 provider 已在本地实现。
- Coach 单次 15 分钟测试链接、8 小时 session、hash 存储、单次消费、撤销/停用检查和审计。
- Coach Today、周课表、Training profile roster、课后 No-show，以及 No-show 退回 Pass / Admin 提醒。
- 主页 community newsletter 与 Customer Account 登录保持为两个独立入口。

## 尚未完成

- 真实 provider 账号、域名/发件人认证、secrets、Dev 原数据库/部署和实际收件验收未完成；可选 provider 与 Worker 已有代码，默认不投递。
- Customer protected email resolver、课前 Reminder/调课通知与 delivery/bounce webhook 未完成；Customer 邮件任务仍为 PENDING。
- Karen 真实邮箱授权、自助激活/登录 UAT、边缘/IP 防滥用未完成。当前测试使用 fixture/mock，非真实收信。
- Admin 专用 Invite/Revoke 工作台、未知邮箱申请审批/公开注册、自动 session 续期未实现；当前换邮箱撤销已实现，链接 15 分钟/session 8 小时。
- Customer Account 仍需真实账号 320/390/430/1440px UAT；本地 fixture 和 token 测试不等于真实 Shopify 登录签收。
- Home newsletter 的当前文案可能让访客误以为是账号“注册”；如需降低误解，后续可改为 **Subscribe for updates** 并增加 **Marketing emails only — this does not sign you in**。本轮只记录，没有改 storefront 文案。

## 不应混用的规则

- Newsletter Customer profile 不等于已验证的 Customer Account session。
- Shopify Customer Account 不等于 Coach Portal 身份。
- Coach email 即使与某个 Shopify Customer email 相同，也不能因此自动获得 Coach 权限。
- Admin 必须给当前店已有 active Coach 授权登录邮箱；公开申请只对该绑定发邮件，不接受 coachId/姓名授予权限，不向浏览器返回登录凭据。
