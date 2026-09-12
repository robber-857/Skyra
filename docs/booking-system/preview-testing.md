# Booking 开发预览与测试

更新日期：2026-09-12。Home 和 Programs 开发主题已配置；本轮单次 HTTP 检查双页面及课表接口均 200，两个测试商品的真实可售检查已通过。仍避免连续刷新；完整页面稳定性与真实顾客登录/Review 尚待验收。

## 打开入口

- 本机 Home：[Find a Class](http://127.0.0.1:9292/#skyra-booking-home)。
- 本机 Programs：[Find a Class](http://127.0.0.1:9292/pages/programs#skyra-booking-programs)。
- App 自带预览：[Home 9293](http://127.0.0.1:9293/#skyra-booking-home)。两个本地入口都依赖开发进程和网络。
- 远程开发主题：[Home](https://skyra-booking-dev.myshopify.com/?preview_theme_id=192227082532#skyra-booking-home)、[Programs](https://skyra-booking-dev.myshopify.com/pages/programs?preview_theme_id=192227082532#skyra-booking-programs)。新浏览器可能要求开发店 storefront password，Booking API 仍依赖本机 App tunnel。
- Booking Admin：[Skyra Booking](https://admin.shopify.com/store/skyra-booking-dev/apps/c9d266a38e2f11a1240139974253b3a1?dev-console=show)。使用开发店员工账号；顾客账号不能访问 Admin。
- 开发主题 ID `192227082532`；根域名未带预览参数时仍是发布中的 Horizon。没有部署正式主题。
- Programs Page 已通过 Shopify CLI 创建：`gid://shopify/Page/167140557092`，handle=`programs`，templateSuffix=`programs`。已验证 HTTP 200 和共享组件挂载标记；旧的 404 / 内容授权阻塞已解决。
- `index.html`、wireframes 是静态原型，不连接当前数据库。

## 当前可测试

1. 选择 **2026-09-12**：`[DEV] Aerial Foundations`，18:30，Development Coach，60 分钟。按规则 16:30 起关闭预约；后续日期请先检查 Weekly Schedule，不要重复 seed 或绕过关闭窗口。
2. 月份标题、前后 7 天、未来 31 天 Full Calendar、Class type / Instructor、剩余名额和 Details；未开放与已关闭文案区分。
3. 未登录 Book 显示弹层，桌面/手机统一当前标签页进入 Shopify 托管登录，保留课程 Attempt/预览主题返回。Continue with Shop 完成登录、退出和签名返回仍待真实账户复测。
4. 登录后选择新 Pass 或 Single class (Drop-in)，Continue 进入 Review 前执行 Shopify Admin + 澳洲 Storefront 实时检查。两个测试商品现已通过检查，可在有效预约窗口内复测真实账号 Review；Checkout 仍未开发/开放。Drop-in 仅覆盖当前场次。
5. 测试临时断线重试、attempt 过期重新选课、商品变更重新选择，以及登录失效后重新认证。上述异常流程已用本地 fixture 验证。
6. Admin 可编辑 Classes & Passes、People、Settings、Weekly Schedule；在 Classes & Passes 点击 Check availability 查看每个商品的可售问题和检查时间。

**当前不能支付、扣课或确认预约。** onlineBookingsEnabled=false、checkoutAvailable=false；公开 Checkout route 会在任何 Hold/Cart 写入前返回 CHECKOUT_NOT_AVAILABLE。内部 NEW_PASS/DROP_IN 的 Review → Hold → Cart 编排已完成，但没有接入前端或真实 Shopify Checkout。Entitlement 台账、有效 Pass 选择和保守 Intro 资格已完成；orders/paid、Booking 确认、付款后恢复、已有 Pass UI/原子确认及 Customer/Coach 个人中心尚未完成。

## 商品检查与已完成配置

从 D:/Skyra/booking-app 运行 npm.cmd run preview:purchasability。需要已登录且绑定 Skyra Booking 的 Shopify CLI；脚本只在子进程载入凭据，SDK 刷新离线会话，不改 .env。诊断模式：npm.cmd run preview:purchasability -- -Diagnostics。

2026-09-12 05:34:57–58 UTC 最新真实结果：Class A$49 / Pass A$220 均 ready=true、issues=[]。用户授权后已应用商品读取 scope、恢复两个 App Booking 字段并发布到开发店 Online Store。修复 scope 缓存陈旧与 onlineStoreUrl=null 误报；现在使用有效发布时间并独立验证认证 AU Storefront。缺权限、未发布或市场不可售仍拒绝。未认证店铺访问依然返回 /password，未移除保护。操作证据、维护命令及前置条件见 [Commerce 配置与恢复](commerce-readiness.md)；不要重复发布或提前开放付款。

## 启动或恢复开发预览

Docker Desktop 运行后，在 `D:/Skyra/booking-app`：

```powershell
docker compose up -d
```

分别保留两个开发终端：

```powershell
npm run preview:app
```

```powershell
npm run preview:theme
```

脚本固定开发店和主题，显式指定项目目录；Theme 排除原有 `assets/skyra.css`，使用 `--nodelete`，`.shopifyignore` 保留远程 app embed 设置。重启前先关闭对应开发终端，避免重复占用端口。

本轮捕获 Node 24.14.0 的连接失败：IPv4 在 250ms 地址选择窗口超时，随后 IPv6 `ENETUNREACH`。2 秒窗口仍有不足；采用 IPv4 优先、关闭地址竞速后，10 次独立新连接成功。开发启动脚本现在附加 `--dns-result-order=ipv4first --no-network-family-autoselection`，仅作用于子进程，不改系统 IPv6、不禁用 TLS。官方参数见 [Node CLI](https://nodejs.org/api/cli.html#--no-network-family-autoselection)。这不能保证网络拥塞或 Shopify 上游 503 永不发生。

网络正常后，可运行一次：

```powershell
npm run preview:check
```

该命令分别对 Theme、App host、Booking sessions、Programs 和 Shopify 上游采样 3 次，输出每次结果，任何一项失败均返回非零退出码。Programs 现在是必须通过的检查。网络慢时不要反复运行或刷新页面。

## Shopify 与 Booking 的职责

- Booking Admin 编辑课程名称、介绍、时长、价格、容量、地点、教练和排期；Pass 编辑价格、次数、有效期及适用课程。
- 保存课程/Pass 后由 outbox/worker 同步 Shopify Product + Variant，通常无需手工重复上传。单次课程商品与 Pass 是购买项，某日场次保留在 PostgreSQL，不为每场课复制商品。
- 当前 `SYNCED` 只代表商品同步成功；开发店两个测试商品现已通过实时检查，但每次交易仍须重新核验。内部 Cart/Attempt/Hold 关联已完成；接下来需实现 `orders/paid` 幂等处理、权益发放/扣减、预约确认和付款后恢复，之后再开放前端 Shopify Checkout，最后处理退款/取消对账。
- 付款使用 Shopify Checkout；不自建支付表单。已有 Pass 应直接确认并扣课，不进入 A$0 Checkout。
- 店铺还需 Customer Accounts、支付服务/测试支付、币种税务、订单通知与政策配置；折扣/礼品卡按业务需要启用，自动续费订阅另行接入。

## 验证边界

最新数据库/接口测试 200 项通过，类型/lint/构建通过；新增 Cart mutation/read query 通过官方 Storefront schema 校验。BookingCheckout 迁移已应用测试库和本地开发库，App/Worker 与 Theme 预览恢复运行。上一轮 12 项浏览器 fixture 本轮未重跑，因为没有前端资源改动。真实 Continue with Shop、Cart/Checkout/支付及后台按钮人工视觉验收仍未完成；当前不要尝试付款。
