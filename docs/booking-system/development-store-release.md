# 开发店三个预约开关

更新：2026-09-14。本文只适用于 `skyra-booking-dev.myshopify.com`，不适用于正式店。

## 三个开关

1. Render `SKYRA_BOOKING_CHECKOUT_ENABLED=true`：允许新 Pass 和 Drop-in 创建 Shopify Checkout。
2. Render `SKYRA_BOOKING_OWNED_PASSES_ENABLED=true`：允许客户使用已有 Pass 直接确认预约。
3. Booking 数据库 `shop.rules.onlineBookingsEnabled=true`：允许该店创建 Hold、扣用 Pass 和确认 Booking。

代码还要求 Render 的 `SKYRA_BOOKING_TEST_SHOP` 精确等于 `skyra-booking-dev.myshopify.com`。正式店域名硬编码拒绝开发开关，不能通过复制环境变量误开启。

## 开启前检查

- Render `/health` 返回 `status=ok`，Web 和 Worker 使用同一版本。
- Shopify 开发店已批准 Skyra Booking 的 `read_orders` 更新权限，`orders/paid` 订阅处于当前 App 版本。
- Redis/Valkey 和 PostgreSQL 正常，Worker 没有持续失败或积压。
- 至少有一节未来、已发布课程；对应 Drop-in/Pass ProductMapping 为 `SYNCED`，开发店商品仍使用测试商品。
- Shopify 开发店使用测试支付；不要在正式店开启 test mode。
- 团课 Pass 的 Eligible classes 只能选择 `CLASS` 团课，私教 Pass 只能选择 `APPOINTMENT` 私教，Workshop Pass 后续只选择 `COURSE`。当前 Workshop 公开预约尚未完成，不纳入本次开关验收。

## 安全开启顺序

1. 先部署本文件对应代码，保持两个 Render 功能开关为 `false`，确认健康和 Admin 页面正常。
2. 在 Render 的 `skyra-booking-web` 环境变量中把 Checkout 和已有 Pass 两个开关改为 `true`，等待新部署健康。
3. 打开 Shopify 开发店 → Apps → Skyra Booking → Settings。确认页面只显示开发店域名，前两个状态均为 `open`。
4. 由店主点击 `Enable development bookings`。系统会再次验证预约规则、环境门控和店铺域名，然后设置第三个开关并写 `DEVELOPMENT_BOOKING_ENABLED` 审计。
5. 先做一笔 Drop-in 测试付款，再做一笔新 Pass 测试付款，最后用已发放 Pass 预约另一节符合资格的课程。

只有 Shopify 验证付款后的 `orders/paid`、Worker 结果和数据库 Booking 状态可以证明预约成功。Checkout 返回 URL、浏览器画面或 Review 页面不能作为成功依据。

## 紧急关闭

1. Shopify 开发店 → Skyra Booking → Settings → `Disable development bookings`。
2. Render 把两个功能开关都改回 `false` 并等待部署健康。
3. 保留 Receipt、Outbox、Booking、Entitlement 和 AuditLog 供排查，不删除交易证据。

## 已记录的后续业务规则

- 课程类型：普通团课=`CLASS`，私教=`APPOINTMENT`，Workshop=`COURSE`。
- Pass 权限必须由服务器按课程类型及明确的 Eligible classes 校验；团课 Pass 不能预约私教或 Workshop。
- Customer Profile 增加可选的个人签名/训练目标字段；不填写不影响登录、购课或预约。该内容属于 Booking 运营资料，计划保存在现有 `CustomerProfile`，不为了此字段扩大 Shopify Customer 写权限。
