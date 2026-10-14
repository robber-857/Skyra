# 家庭账号与独立学员 Client

本轮范围从 2026-10-14 开始，按用户确认的规则实现：家长登录一个 Shopify Customer Account，在 Booking 中管理两个或更多孩子；每个孩子是真实、独立的 Shopify Customer 和 Booking Client，Admin 可以分别预约、修改资料及管理 Pass。

**发布状态：本地代码与验证阶段，尚未部署本轮家庭账号变更。** 本地测试、浏览器 fixture、Shopify API schema 验证与正式店真实用户验收分别记录。历史文档中的已部署状态不代表家庭账号功能已经上线。

## 已确认的产品规则

| 项目 | 行为 |
| --- | --- |
| 登录身份 | 家长继续使用原 Shopify 托管登录，不增加 Skyra 密码或孩子密码 |
| 家庭成员 | 每个孩子创建独立 Shopify Customer GID 与 `CustomerProfile`，并显式关联家长 |
| 孩子邮箱 | 基于家长邮箱生成唯一别名，如 `parent+child1@example.com`、`parent+child2@example.com` |
| 预约与名额 | 每个孩子单独创建 Booking；两个孩子参加同一节课占两个名额 |
| Pass 与课次 | Pass、余额、预留、扣次、有效期和续订按孩子分别归属，家庭成员之间不共享 |
| Admin 权限 | ADMIN / OPERATIONS 使用现有 Client 操作管理每个孩子；COACH 无权新增家庭关系或编辑 Client |
| 通知邮箱 | 孩子的 Booking / Pass 通知发送至家长当前的 Shopify 联系邮箱，正文保留孩子姓名 |
| 家庭关系 | 不通过相同邮箱、别名前缀、姓名或手机号推断；不把已存在的陌生 Client 自动挂到家长下 |

家长也保留自己的 Client，可以为自己预约或持有 Pass。直接使用孩子别名登录时，仅能访问该孩子自己的资料与记录，不能访问家长或兄弟姐妹，也不能再创建下一级家庭成员。

## 家长使用流程

1. 使用家长原邮箱完成 Shopify 登录。
2. 在家庭成员入口添加孩子，填写名字、可选姓氏、邮箱前缀及可选电话。
3. 系统为孩子创建新的 Client；添加第二个孩子时使用不同前缀。
4. Booking 的 **Booking for** 选择实际参加课程的人，再使用该成员自己的 Pass，或为其购买新的 Pass。
5. 个人中心及 Membership 页面按选中的成员显示其预约、资料、Pass 与续订状态。

成员切换会重新加载对应资料。已开始的预约或付款保留原参加人；不会因为切换页面选项而把现有预约、Pass 或付款转给另一个孩子。

## Admin 操作

1. 打开 **Clients**，找到家长的 Client 详情。若家长没有联系邮箱，先通过 **Edit client** 保存家长邮箱。
2. 在家长详情的 **Family members** 区域选择 **Add family member**。
3. 填写孩子名字与 **Email prefix**，查看生成的 Account email，提交 **Create family member**。电话可以留空。
4. 创建后进入孩子自己的 Client 详情。家庭区域可返回家长或打开其他家庭成员。
5. 使用孩子详情中的 **Book class** 为孩子预约；使用 **Manage Passes** 或该页已有 Pass / credit 操作独立管理孩子权益。
6. 使用 **Edit** 修改孩子姓名、preferred name、电话等资料。孩子邮箱别名为只读，不能通过资料编辑解除家庭身份或改成另一个 Client 的邮箱。

Clients 目录同时列出家长和孩子，并在孩子行显示家长关联。孩子详情的课程记录、统计、Pass 页码与余额均只包含该孩子自己的记录；Family 区域提供跳转，不合并账本。

## 邮箱与电话规则

- 前缀会去除首尾空格并转为小写，长度为 1–40 个字符，以字母或数字开头，其余可使用字母、数字、短横线。
- 别名格式是 `家长完整邮箱 local-part + "+" + 前缀 + "@域名"`。已有 plus-address 会保留，例如 `parent+home@example.com` 生成 `parent+home+child1@example.com`。
- 合并后的邮箱 local-part 最长 64 个字符；太长时需要使用更短的前缀。
- 生成后孩子的 Shopify GID、别名和家庭关系独立保留。修改家长邮箱不会改写孩子的身份；发送新的通知时重新读取家长当前邮箱。
- 应用的家庭通知直接解析至家长联系邮箱，家庭通知投递不依赖邮箱服务是否转发 plus-address。若选择用孩子别名独立登录，Shopify 登录邮件能否收到仍取决于该邮箱服务的别名投递能力。
- 电话为可选项；填写时需包含国家代码，例如 `+61 412 345 678`，保存为规范化号码。不会自动把家长手机号复制给孩子；Shopify 对重复手机号的限制仍适用。

## 数据与授权

`CustomerProfile.familyParentId` 是可空的自关联，复合外键使用 `shopId + familyParentId` 指向同店 `shopId + id`。数据库同时阻止自己成为自己的家长、跨店关联、孩子成为家长、父级转成孩子，以及已建立家庭关系的移除或改绑。

所有公开成员选择先验证 Shopify App Proxy 或 Customer Account token，再把请求中的 `familyMemberId` 解析为该已认证家长自己的 Client 或其直接子成员。浏览器提供的成员 ID 只表达选择意图，不授予权限。另一个家庭、另一个店铺、陌生 Client 和孙级成员均不能被选择。

`familyAccountData` 返回家长账号摘要、SELF / CHILD 成员以及 `canAddMembers`。首次登录但尚无本地 profile 的家长按已签名的 Shopify Customer GID 创建最小投影；可从 Shopify 刷新当前姓名、邮箱和电话。孩子直接登录时返回 SELF，`canAddMembers` 为 false。

Shopify import / refresh 按已记录的 Customer GID 更新联系资料，保留 `familyParentId`、本地 preferred name、训练目标、预约与权益，不从 alias 自动恢复或重新推断家庭关系。

主要实现入口：

- `booking-app/app/services/family-accounts.server.ts`：家庭查询、成员授权、别名生成与创建。
- `booking-app/app/services/family-request.server.ts`：对已认证请求解析成员选择。
- `booking-app/app/services/admin-clients.server.ts`、`client-contacts.server.ts`：Admin 家庭信息与独立 Client 编辑。
- `booking-app/app/services/customer-notification-email.server.ts`：按显式家庭关系读取家长当前通知邮箱。
- `booking-app/prisma/migrations/20261014000000_family_accounts/migration.sql`：新增字段、创建意图、租户外键和身份约束。

## 创建失败与安全重试

`FamilyMemberCreation` 持久保存 `shopId + parentId + idempotencyKey`、输入摘要、保留邮箱、创建状态及已确认的 Shopify Customer GID。一个请求只能用于完全相同的成员资料；同一店内的生成邮箱也会保留唯一性。

创建 Shopify Customer 时写入随机意图 tag。若 Shopify 已创建客户但响应丢失，使用原请求重试时只能认领带该意图 tag 的 Customer；发现同 alias 的其他客户会报冲突，不会自动关联到家庭。Shopify 身份与本地家庭关系最终在数据库事务中落库，创建租约在本地提交完成前保留。

- 网络中断、保存结果不确定或请求正在处理：保留原资料与原请求 key，使用页面的重试操作。
- 前缀已被占用或输入校验失败：修改前缀或资料后发起新请求。
- 取消后重新填写不是确认旧请求已失败；遇到结果不确定时先使用原请求恢复，避免增加另一个孩子 Client。

## 参加人与付款人

选择孩子后，`BookingActor.customerGid` 始终是孩子，决定预约和 Pass 归属；已认证家长 GID 保存在服务端的 `accountCustomerGid`，用于付款人与条款确认。

`BookingCheckout`、`PassPurchase` 与 `PassMembership` 保留原始 `payerCustomerGid`，数据库禁止事后改写。已验证的支付 webhook 对比原付款人，同时将 Booking / Entitlement 留给实际孩子。后续续订沿用原购买的付款上下文；孩子自己的登录不能继续家长启动的 checkout。迁移前 NULL 付款人使用原 Client 的 Shopify GID 作为兼容解释，不把旧付款归属转给新选择的家庭成员。

## 验证与发布边界

本轮的服务测试覆盖首次登录、两个独立孩子、同店家庭授权、跨店拒绝、孩子 SELF 访问、创建冲突、响应丢失后的恢复、并发重试、Shopify 同步保留关系、独立 Admin 编辑、家长当前邮箱及独立 Pass / Booking 余额。另有家庭预约、付款归属与请求授权测试，以及本地浏览器 fixture。

2026-10-15 本地验证结果：

- 专用 `skyra_booking_test` 数据库成功应用 `20261014000000_family_accounts`；全量 **80 个测试文件 / 1103 项测试通过**。
- `npm run check` 通过：应用与 Customer Account TypeScript、ESLint、应用生产构建。
- `npm run build:theme-extension` 与 `shopify app build` 通过：最终 Theme App Extension、Customer Account extension 与 checkout guard 均完成本地构建。
- 390px / 1440px 浏览器 fixture 通过：Admin 添加、取消、失败恢复、独立 Client 编辑/预约/Pass 入口；家长创建成员、切换资料/余额、取消/改期；同课两名孩子分别预约、仅 token 的恢复、未决付款锁定成员、分别购买 Pass。
- 修复并验证迁移前 NULL payer checkout 的重试兼容：继续读取原购物车、不创建新付款、不改写原付款人。
- 浏览器证据：`output/playwright/family-admin/results.json`、`output/playwright/customer-account/results.json`、`output/playwright/family-storefront/results.json`。
- 三条家庭 GraphQL 操作通过 Shopify Admin API 2026-07 schema 验证。独立的官方 UI 组件验证器受其隔离类型缓存缺少 Customer Account / Preact 依赖影响，三次修复尝试后未能完成；项目内固定 SDK 类型检查和 Shopify extension build 已通过。

工具记录：第一次 `shopify app build` 成功后，CLI 自带更新流程将本机 Shopify CLI 从 4.8.5 更新至 4.9.4；随后最终 extension build 也成功。没有执行 app deploy 或 theme push。

**自动化测试通过不等于真实 Shopify 家长登录、实际创建两个孩子、真实邮件收件或支付 UAT 完成。** 本轮没有创建或编辑正式客户，没有发送真实通知，也没有部署线上变更。

部署本轮功能时，必须把数据库 migration、App / Worker、Theme App Extension 与 Customer Account extension 作为同一发布范围，并验证现有购买与续订的兼容性。本文件不授权生产迁移、发布主题、真实付款、邮件群发或修改现有正式客户资料。
