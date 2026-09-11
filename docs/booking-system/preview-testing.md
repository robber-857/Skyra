# Booking 开发预览与测试

更新日期：2026-09-11。当前测试阶段先体验已实现的页面，再继续下一阶段开发。

## 打开入口

- 本机 Home：[Find a Class](http://127.0.0.1:9292/#skyra-booking-home)。需要 App dev 和 Theme dev 两个进程保持运行。
- Booking Admin：[Skyra Booking](https://admin.shopify.com/store/skyra-booking-dev/apps/skyra-booking/app)。使用有开发店访问权限的 Shopify 员工账号登录；顾客账号不能访问 Admin。
- 开发主题 ID：`192227082532`。远程预览可从 Theme dev 输出的分享链接打开；本轮已验证未登录浏览器会进入开发店密码页，需要开发店 storefront password，并且本机 App tunnel 在线。它不是独立部署的网站。
- `index.html` 和 `docs/booking-system/wireframes.html` 是静态原型，不连接当前 Booking 数据库。
- Programs 已有共享组件挂载代码；开发店 `/pages/programs` 页面资源尚待配置与验证，当前先从 Home 测试。

## 当前可测试的内容

1. Home 的 Find a Class 选择 **2026-09-12**：测试课 `[DEV] Aerial Foundations`，18:30，Development Coach，60 分钟。
2. 切换日期、Class type 和 Instructor；查看空状态、剩余名额与 Details。
3. 未登录时点击 Book / Continue to booking，检查登录弹层和 Shopify 登录入口。完成真实顾客登录及返回恢复仍待用户联调，不代表已验收。
4. Admin 测试 Settings、People、Classes & Passes、Weekly Schedule。编辑开发数据后，观察 Shopify 商品同步状态。
5. 窄屏检查日期横滑、信息换行、详情和登录弹层。完整 Pass/Review 的桌面与手机 UI 尚未完成。

当前不能完整选 Pass、支付、扣课、确认预约或操作 Customer/Coach 个人中心。`onlineBookingsEnabled` 保持关闭；内部 15 分钟 Hold 与并发容量已通过数据库测试，但尚未开放付款流程。

## 重启预览

先在 `booking-app` 运行 `docker compose up -d`，然后分别保留两个终端：

```powershell
# 终端一，D:/Skyra/booking-app
shopify app dev --store skyra-booking-dev.myshopify.com --theme 192227082532
```

```powershell
# 终端二，D:/Skyra/shopify-theme
shopify theme dev --store skyra-booking-dev.myshopify.com --port 9292 --ignore assets/skyra.css
```

`config/settings_data.json` 已由 `.shopifyignore` 排除，以保留开发主题已保存的 app embed。启动时显式指定 `--theme 192227082532`，避免 App CLI 选择默认初始化主题。开发店根域名打开当前发布的 Horizon，不是 Booking 开发主题；测试本项目页面请使用上面的 Home 入口。首次请求如果正遇到 App 启动或隧道刷新，等服务 Ready 后点击 Try again。

## Shopify 与 Booking 的职责

- **Booking Admin 已实现**：课程名称、介绍、时长、价格、容量、地点、教练；Pass 名称、价格、次数、有效期及适用课程；实际日期排课与发布。
- **商品同步已实现**：保存课程/Pass → outbox/worker → Shopify Product + Variant。名称、价格和状态同步；课程介绍另有 Metaobject。商品设置为无需配送、不跟踪 Shopify 实物库存。通常无需手工重复上传商品。
- **模型约定**：单次课程购买项和 Pass 是商品；某一天某一场课程是 PostgreSQL Session，不为每场课复制 Shopify Product。座位由 Booking/Hold 管理。
- **还需接入**：商品渠道可售验证、Cart Variant/Attempt 关联、Shopify Checkout、`orders/paid` 幂等处理、权益发放/扣减、预约确认，以及退款/取消对账。当前 `SYNCED` 只表示商品同步成功，不表示 Cart 已可购买。
- **店铺配置**：启用 Shopify Customer Accounts；配置 Shopify Payments 或店铺可用支付服务、币种/税务、通知与订单政策。先用开发店测试支付完成验收，再接正式店。
- **可选能力**：折扣码、礼品卡；如果后续需要自动续费会员，再单独接入订阅能力。次数卡不等于订阅。
- **已有 Pass**：核验余额与资格后直接确认并扣课，不进入 A$0 Checkout。

官方依据：[productSet 商品同步](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet)、[Cart API](https://shopify.dev/docs/api/ajax/reference/cart)、[本地 App 预览](https://shopify.dev/docs/apps/build/cli-for-apps/test-apps-locally)。
