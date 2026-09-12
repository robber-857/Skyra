# Booking 邮件与 Coach 课程报名

更新：2026-09-12。本页区分业务合同、已实现代码和仍需配置的真实服务。

## 通知由谁负责

- Shopify：继续发送订单/付款相关通知。购买 Pass 的订单成功不等于课程名额已经确认；订单邮件不能提前写成 Booking confirmed。
- Skyra Booking：数据库成功完成 `Entitlement GRANT → RESERVE → Booking CONFIRMED` 后，在同一事务内为 Customer 和该 Session 当前分配的 Coach 各生成一条 `BookingNotification`。
- 已有 Pass 将来调用相同的确认/通知服务，不创建 A$0 订单，因此不能只靠 Shopify 新订单触发通知。
- Shopify Flow 的 Send internal email 可用于内部邮件，但自定义 App 的 Flow 扩展仅适用于 Plus；本项目不把 Flow 作为预约通知的必需依赖。

官方依据：[Shopify Store notifications](https://help.shopify.com/en/manual/fulfillment/setup/notifications)、[Flow Send internal email](https://help.shopify.com/en/manual/shopify-flow/reference/actions/send-email)、[Flow 自定义 App 限制](https://shopify.dev/docs/apps/build/flow)。

## 已定义的两封邮件

| 收件人 | 触发时机 | 内容 |
| --- | --- | --- |
| Customer | Booking 确认事务提交后 | Booking confirmed、课程、日期、时间、时区、Coach、地点、预约编号、提前 12 小时免费取消规则 |
| 对应 Coach | 同一个 Booking 确认事务提交后 | New booking、课程、日期/时间/时区、地点、预约编号、准备邮件当时的已确认人数/容量 |

异常付款、满员、取消、尚未付款和临时 Hold 均不得生成成功确认邮件。邮件发送失败不撤销已确认 Booking。人数是准备邮件时的快照，个人中心查询才是当前状态。

邮件为英文，HTML + 纯文本双版本；动态内容转义，时间使用 Session timezone。当前没有可用的取消/个人中心链接，因此模板不放无法工作的操作按钮。客户姓名/邮箱解析、Coach 联系邮箱、管理预约链接属于接通真实发信服务时的后续工作。

## 当前实现

- `BookingNotification` 按 shop + booking + recipient kind/id + template 唯一去重；仅存内部 UUID，不存邮箱、Customer GID、订单原文或渲染后的邮件正文。
- 提供 `BookingMailAdapter` 投递接口；适配器按内部收件人 ID 查询当前已验证地址，不能接受浏览器指定的邮箱。
- 原子 claim 防止并发重发；明确拒绝可退避重试，最多 5 次；网络结果不确定或过期 SENDING 进入 UNKNOWN，需 provider 对账，不能盲目重发。
- 状态 `ACCEPTED` 只表示 provider 接受，不能声称已进入收件箱；DELIVERED/bounce 回执尚未实现。
- Admin → Bookings 可查看通知状态，打开 HTML/纯文本预览。尚未接发信 provider；Worker 不会主动发任何真实邮件。
- Reminder、改期、取消、候补以及付款异常客户通知模板仍待后续定义，不标为完成。

## Coach 个人中心

独立只读 `/coach` 页面，沿用原规划的 Coach 单次链接登录，无 Shopify Admin 访问权。

- 默认未来 7 天；另有未来 30 天和自定义日期。7/30 指从今天起的本地日历日，不是本周/自然月。
- 按 Session 上课日期筛选，不按客户下单日期；自定义首尾日期均包含；数据库用 UTC 半开区间，按 Shop timezone 解释筛选，每节课使用自己的 timezone 显示。
- 显示课程、日期、时段、地点、状态、报名数/容量、已确认、已出席、取消、Late Cancel 和 No-show；汇总显示课程数、报名人次和容量利用率。
- 报名是“人次”，一人参加三场记三次；包括 CONFIRMED / ATTENDED / NO_SHOW，排除 CANCELLED / LATE_CANCEL / 未付款 Hold；取消的 Session 不进入汇总。
- 只读当前身份被分配的 Session，查询参数不能指定其他 coachId/shopId；不返回客户邮箱、订单、金额或 Customer GID，查询有审计。
- 登录链接有效 15 分钟、一次性消费；会话有效 8 小时，HttpOnly/SameSite cookie，生产 Secure；退出撤销服务端会话，Coach/Shop 停用即拒绝访问。
- 登录凭证放在 URL fragment（#token=...），不进入 HTTP URL；页面读取后清除 fragment，并支持停留登录页时打开新的链接。GET 不消费链接，用户点击 Continue 后才交换。Referrer-Policy=same-origin；登录/退出 POST 保留框架及应用的同源校验。

已实现内部受 Operations 权限保护的 `issueCoachLogin`，以及登录交换/会话/退出页面。**真实邀请发送、Coach 已验证邮箱维护、自助重发入口和真实 Coach 身份验收仍未完成**。本轮浏览器验证使用专用测试库临时凭证，不代表真实 Coach 已能收信登录。

## 付款确认的新增约束

- Checkout 创建时冻结次数、有效天数、课程/时间/地点/Coach 等购买条款；之后不可修改。旧 Checkout 没有快照时进入 REVIEW，不能从当前商品反推已购权益。
- Pass 按订单 `processed_at` 作为购买时间，按课程时区的日历日计算有效期；这不是支付捕获时间。缺失/畸形/早于 Checkout 的时间进入 REVIEW，不能用 Worker 运行时间延长权益。
- Drop-in 为绑定 Service 的一次权益，使用窗口结束于原 Session 结束；只确认所关联的课程。
- `PaidBookingResult` 同时约束单 Checkout 和单 Shopify Order/Line；不同 Webhook ID 的同订单重放不再发权益/确认/生成邮件。
- 合法已付款订单在可恢复的过期 Hold 场景重新检查窗口与容量；满员等情况保留已购权益、无 RESERVE/Booking/成功邮件，进入 Needs Attention。
- Attempt 自身到期、显式释放、课程变更/停用、报名关闭等进入恢复，不自动分配其他课程。异常的外部订单校验仍由已有收件服务拒绝。
- 新增确认事务不依赖“允许新预约”的开关，因为已经收款的历史事件也必须处理；公开创建 Checkout 的三项 gate 继续关闭。
- 退款/取消/争议乱序、订单 reconciliation、UNKNOWN Cart 的人工操作仍未实现，不能启用真实支付闭环。

## 用户提供的品牌邮箱

用户于本轮提供 `hello@skyrastudio.com.au`，拟作为品牌发件地址（From），并建议同地址作为 Reply-To；这不是已验证的 provider 配置。仍需确认邮箱托管商、事务发信服务和域名认证，未读取邮箱凭据，未修改 DNS、邮箱或 Shopify Notifications。

Shopify 的配置位置为 Settings → Notifications → Sender email；按该后台提供的记录完成域名认证。原邮箱收信继续由现有邮箱托管服务承担；Booking App 需要单独连接事务发信服务，Shopify 发件地址设置不会自动授权 App 发信。官方说明：https://help.shopify.com/en/manual/intro-to-shopify/initial-setup/setup-your-email 。

## 接通真实邮件前的剩余配置

选择事务邮件 provider 与品牌发信地址，完成发信域名验证；连接受保护的 Customer 联系方式读取和 Coach 验证邮箱；实现 provider adapter/幂等策略、回执及 UNKNOWN 对账；接入 Worker 的实际投递；验证真实 Customer/Coach 收信和登录。凭据留在部署环境，不写入 Git。

### 本轮最终验证（2026-09-12 23:03 Australia/Sydney）

- 全套 14 个测试文件、240 项测试通过（上一轮 212 + 本轮 28），包括重复 delivery/worker、两笔过期付款争抢最后名额、全事务回滚、权益冻结、通知重试/UNKNOWN，以及 Coach 跨店/跨教练隔离、一次链接并发消费、退出/停用、DST 和日期边界。
- TypeScript、ESLint、生产构建与 Prisma validate 通过；测试库和本地开发库全部 8 条迁移已应用。
- 生产构建 + 专用测试库的 Playwright：390/1440px，登录、月度筛选、自定义空状态、退出通过；两视口均 noHorizontalOverflow=true、pageErrors=[]。已检查截图。
- 证据：output/playwright/coach-booking/{results.json,coach-390.png,coach-1440.png,customer-email.html,coach-email.html}；重跑使用 booking-app/scripts/coach-booking-smoke.mjs，需测试 DATABASE_URL 和已安装的 PLAYWRIGHT_MODULE，通过 tsx 运行。测试过程没有真实发信或 Shopify 支付。
- 已恢复 App/Worker，原 Theme dev 继续运行；preview:check 的 Home、Programs、App host、Booking API、Shopify upstream 均通过 HTTP 200 检查。这不代表真实客户登录/支付 E2E。
- 本地开发店 holds=0、bookings=0、notifications=0；onlineBookingsEnabled=false、checkoutAvailable=false、ownedPassesAvailable=false。
- 保留上一轮未提交 Webhook 批次；本轮没有 commit/push、真实收款/发信或正式店发布。

