# Appointment、逐次课程留言与 Today — 2026-09-13

## 用户确认的规则与本轮实现

- Appointment 无需 Admin/Coach 审批。Admin 创建 Private appointment 服务并在 Weekly Schedule 发布固定单人时段；用户通过有效 Pass 或 Shopify 付款验证后直接确认。付款、名额和预约窗口仍必须校验，未付款不算预约成功。
- 私教服务和场次容量固定为 1；老师 busy buffer 与地点冲突受现有数据库约束保护。已排期的 Service 不可更改 kind。复制周排期/周期生成沿用现有功能。
- 用户在 Booking Review 的 Note for your coach 填本次目标，最多 1000 字符，可留空/清空。Save note 保存，已有 Pass 的 Confirm 会先保存再确认。只做本次课程留言，不做聊天、老师回复或 PRE/POST 消息。
- 老师在对应课程名册查看留言，Admin 在预约详情查看，Customer Account 只显示本人留言。按纯文本显示，不解释 HTML。
- Admin/Coach Today 按店铺时区显示今日课程、人数/容量和 CONFIRMED / ATTENDED / NO_SHOW 预约及详情链接。目前显示内部 Customer/Booking 引用；真实姓名尚未接通。Coach 未来 7/30 天和自定义日期筛选继续可用。
- 确认产生 Customer/Coach 两条幂等通知任务；Shopify 负责订单/支付邮件，Booking 系统负责预约通知。provider 与真实收件人未配置，没有真实发信。

## 数据与权限

新增 POST `/apps/skyra-booking/comment`，经签名 App Proxy、当前登录客户、Attempt 归属验证。`BookingAttempt.customerComment` 保存草稿；仅 STARTED、未过期且尚无 Hold 时允许修改，相同值重试幂等。确认时复制至 `Booking.customerComment`，DB trigger 保护快照不可变；改期新 Booking 保留原留言。

留言正文不进入 Shopify、订单属性、Outbox、邮件、审计 metadata 或 Today 列表。Coach 只能读取自己所带课程；客户只能看本人留言。第 12 条迁移 `202609130011_appointment_comments` 同时保护容量为 1 和已排期服务类型不可变。

## 验证

- 23 文件 / 308 项完整测试通过；新增 6 组数据库测试覆盖 paid Worker 十次并发、已有 Pass 十次确认、唯一 Booking/通知、最后名额、Coach/地点冲突、容量/类型/快照约束、留言归属/长度/冻结/清空、改期继承和 Today 角色过滤。
- 开发库及专用测试库均应用 12 条迁移，无 reset。TypeScript、ESLint、生产构建、Prisma validate、Shopify app build 通过；Customer 官方 UI validator revision 5 VALID，关闭源码遥测。
- Home/Programs 16 组浏览器场景通过，包括私教标识、留言、已有 Pass 和响应丢失恢复；Coach、Customer 各 390/1440px 通过。Coach 名册验证 HTML 作为文本显示。Customer 为本地交互夹具，不是 Shopify-hosted 真实组件验收。
- 日志/截图在 `output/booking-next/appointment-*.log` 与 `output/playwright/{booking-login,coach-booking,customer-account}`。

另外修复满 1000 字留言经 JSON 转义后的请求长度（该路由上限 8192，其他预约接口保持 2048）及通知主机/数据库时钟偏差。通知领取、重试、接受和过期判断统一数据库时间；新增长留言与主机时钟过快/过慢两项回归。

## 当前边界

当前使用 Admin 预发布私教时段，Coach recurring hours/time off、动态时段计算、独立 Resource 管理尚未实现。Checkout 实际跳转/返回、订单权限和真实订阅、Customer Account 页面/导航/api_url、真实登录/姓名仍待接通。Checkout/online bookings/owned Pass 三个公开开关仍关闭。

银行、商户身份、邮箱认证/provider 留给实际经营者；资金退款由 Admin 线下处理。Needs Attention 人工处理、线下记录、漏单 reconciliation、生产部署和备份仍待完成。

当前可分模块体验本地页面。完整真实角色测试应先接通 Shopify 登录 → 测试 Checkout → Webhook → Booking → Admin/Coach；测试支付可用 Shopify test gateway，不必等真实银行卡。真实扣款/到账和真实邮件则需经营者配置。[Shopify 测试网关说明](https://help.shopify.com/en/manual/checkout-settings/test-orders/payments-test-mode)

30 组真实 UAT 尚未签收，详见 [验收清单](launch-readiness-and-uat.md)。Git 边界与下一步见 [交接](handoff-2026-09-13.md)。
