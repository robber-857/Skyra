# 开发店 Commerce 配置与归属恢复

更新：2026-09-12 15:35 Australia/Sydney。本页记录真实配置和安全恢复顺序，不是上线许可。

## 当前结果：开发店商品准备已通过

用户已明确授权增加开发店 Storefront 商品读取权限、恢复两个测试商品的 Booking 归属，并将它们发布到 Online Store；保持密码保护，不修改正式店。

- 店铺：`skyra-booking-dev.myshopify.com`；App **Skyra Booking**；公开 Client ID `c9d266a38e2f11a1240139974253b3a1`。
- App 开发配置已增加 `unauthenticated_read_product_listings`，并通过现有 CLI App dev 流程应用。未发布全局 App 正式版本，未增加订单、客户或付款权限。
- 原有 TOML Product 字段定义刷新后可读，命名空间 `app--420648878081`，类型均为 `single_line_text_field`。定义 ID 分别为 `281002672420`（booking_owner_id）和 `281002705188`（entitlement_kind）。初次查询为空的历史原因未断言。
- 两个商品缺失字段均已使用 `compareDigest:null` 补写、回读并生成 `CATALOG_OWNERSHIP_RESTORED` 审计，共 2 条；未改标题、价格、变体或覆盖已有字段。
- 已核对 Online Store 渠道的 catalog/app 标识，仅发布到 `gid://shopify/Publication/324415521060`，未发布到 Shop 或 POS。两次 mutation 均无 userErrors，并返回 `publishedOnPublication=true`。
- 2026-09-12 05:34:57–58 UTC 的最终只读检查：两个商品均 `ready=true`、`issues=[]`。Admin 和认证 AU Storefront 的唯一 Variant、AUD 价格、可售状态、归属/权益类型一致，均无需配送、订阅或 bundle。
- 未认证访问店铺根路径仍转到 `/password`，HTTP 200 且存在密码表单；保护未解除。开发店 `onlineBookingsEnabled=false`，Hold/Booking 数量均为 0；代码中 `checkoutAvailable=false`、`ownedPassesAvailable=false`。

| 对象 | Product / Variant ID | Mapping ID | 发布时刻 UTC |
| --- | --- | --- | --- |
| [DEV] Aerial Foundations · A$49 | 10798362362148 / 56232880144676 | 7fc8abc0-3123-4b5d-b57a-bc06e62b0a98 | 2026-09-12 05:27:25 |
| [DEV] Five Class Pass · A$220 | 10798362427684 / 56232880210212 | bb60d549-8727-40c2-a676-fa301a6b2673 | 2026-09-12 05:27:29 |

Class 的 owner 为 `3d1cd3ff-4e68-415c-9dd5-a2d64c7503b7`，权益类型 DROP_IN；Pass 的 owner 为 `da2a0132-fea9-4834-b72d-6e3c3bbfb934`，类型 PACK。稳定 handle 均为 `skyra-booking-<owner UUID>`。

## 本轮修复与代码边界

- `storefront-access.server.ts`：从已认证 Admin/App Proxy 的 DB 店铺域名取得官方 SDK 离线 Storefront 客户端，核对同店铺、离线会话及精确商品 scope；缺权限拒绝，不退回 tokenless。SDK 负责私有传输和 token 刷新。
- `offline-scopes.server.ts`：处理“Shopify 已授予权限、本地 Session.scope 仍旧”的情况。显式读取 Shopify 实际 granted scopes，验证 App/店铺/离线 Session，按原 accessToken 快照条件更新 scope 缓存；并发换 token 则拒绝，不自行授予权限、不修改或输出凭据。
- `catalog-ownership.server.ts`：仅 ADMIN、单 mapping；核对 App、定义、稳定 handle、Product/唯一 Variant、同步版本和价格。只补不存在字段，CAS 防止并发覆盖，回读后写审计。存在错误归属时必须停下。
- 恢复使用 Shop catalog 锁，每个远端请求 6 秒截止、事务 30 秒截止。远端写入后超时/回读失败，不声称 Shopify 已回滚；先检查再决定是否重试。
- `shopify-purchasability.server.ts`：新增权益类型校验；修复以 `onlineStoreUrl` 非空判断发布状态的误报。真实发布结果为 true 且有 `publishedAt`，但 URL 仍为空。现使用有效且不晚于当前时间的 Online Store `publishedAt`，并独立要求认证 AU Storefront 校验通过。没有通过放宽价格、市场、身份或商品结构检查来绕过失败；URL 为空的根因尚未确认。

## 后续复查与恢复顺序

以下是维护说明，不代表可以重复执行可见性变更；本轮两商品恢复/发布均已完成。

从 `D:\Skyra\booking-app` 执行：

```powershell
# 默认只读商品检查；SDK 生命周期可能刷新本地离线 Session
npm.cmd run preview:purchasability
npm.cmd run preview:purchasability -- -Diagnostics

# 只有远端已批准 scope、本地缓存仍旧时显式使用
npm.cmd run preview:purchasability -- -RefreshSessionScopes -Diagnostics

# 仅在字段确实缺失、定义与商品身份已核对时，一次恢复一个商品
npm.cmd run preview:purchasability -- -RestoreOwnership -MappingId 7fc8abc0-3123-4b5d-b57a-bc06e62b0a98
npm.cmd run preview:purchasability -- -RestoreOwnership -MappingId bb60d549-8727-40c2-a676-fa301a6b2673
```

1. 先看最新诊断；保持正确 App、开发店与主题，不能移除密码来通过检查。
2. 定义缺失时先用现有 TOML 开发流程应用并回读，不能跳过保护另建 merchant-owned 字段。修改 scope 后核对 Shopify granted scopes；必要时重连/刷新本地缓存。
3. 恢复只针对经用户授权的具体 mapping。脚本固定开发店与 Client ID，凭据仅进入子进程，不写 .env、不打印。恢复后检查全部商品，非零可能表示其他配置仍未就绪，不能据此盲目重复写入。
4. 新的渠道发布属于可见性变更，需核对用户授权和确切目标。`scripts/dev-store-publications.graphql` 为只读渠道/商品核对；`scripts/dev-store-publish.graphql` 是有副作用的单商品 mutation，不作为自动修复执行。
5. 本轮通过 Shopify CLI store auth 取得渠道读/写权限，仅用于开发店发布操作；没有把 `write_publications` 加入运行 App 的 scopes。用 query-file / variable-file 避免 Windows 多行 GraphQL 参数被截断。发布前核对店铺、两个 [DEV] 商品和 Online Store catalog；发布后检查 userErrors、publication 状态并运行商品检查。

## 验证与尚未完成

- 专用 PostgreSQL 测试库 **154 项通过**（上一轮 139 + scope 缓存保护 11 + 发布判断 4）；类型、lint、生产构建通过。无新 migration。
- 本轮最终 8 个 Admin/Storefront 操作通过官方脚本校验；运行前新增查询/发布 mutation 也通过官方 AI Toolkit 校验。App TOML CLI `valid=true`。
- Home、Programs、Booking sessions 单次 HTTP 检查均 200，双页面包含 Booking mount；这不是完整浏览器 E2E。未重跑上一轮 12 项布局/恢复 fixture。
- **Continue with Shop** 完成、退出和签名身份返回仍需真实账号复测；此前同页顶层跳转修复不等于真实登录闭环验收。
- M4-01 / M5-10 的内部 Review → Hold → 单 Cart 编排已完成并测试，公开路由/前端仍关闭。下一开发项是 orders/paid 收件、幂等处理、订单与 booking reference 校验、权益发放/Booking 确认及过期付款恢复；具备该闭环后才开放真实 Checkout。
- 本轮没有收款、扣课、创建预约或部署正式店；未再次 commit/push。检查通过仅代表当时商品可售，不是支付或预约授权。

官方依据：[Storefront 认证](https://shopify.dev/docs/api/storefront/2026-07)、[Product publishedAt](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Product#field-Product.fields.publishedAt)、[商品渠道发布](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)、[字段定义](https://shopify.dev/docs/apps/build/metafields/definitions)、[metafieldsSet 比较写入](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/metafieldsSet)。
