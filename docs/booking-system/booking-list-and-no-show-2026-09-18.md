# Booking 列表、邮件与 No-show（2026-09-18）

本次由用户明确变更 No-show 规则。下述规则覆盖 2026-09-16 的 No-show 退回课次决定，历史账本不重写、不追扣已退课次。

## Recent bookings

- 服务端每页 8 条；按 createdAt / id 倒序稳定排序，统计同店全部 Booking，不再截断于最近 50 条。
- Previous / Next、当前页 / 总页数、Go to page（Go 或 Enter），首尾页自动禁用对应按钮。
- bookingPage 写入 URL；保留 shop / host 等既有查询参数，刷新、浏览器返回保留页码。越界页取最后一页，无效页回第一页。

## Booking emails

每行是同店一个 Booking、recipient kind / id 与 template 的唯一通知。不同 Booking 或确认／取消通知会增加新行；同一通知重试增加 attempts，不复制新行。当前页面只展示最新 50 条 Booking 确认和取消通知，不包括 Coach login 邮件、Shopify 订单邮件或未实现的提醒／No-show 独立邮件。

- PENDING：等待尝试发送；0 attempts 表示从未尝试。
- SENDING：发送程序已领取通知。
- ACCEPTED：供应商接受请求，不证明进收件箱。
- FAILED：发送被拒绝；UNKNOWN：结果不确定，需要核对；SUPPRESSED：通知已过时，不再发送。

状态由 Worker / 发信程序自动更新，此页面没有手动改状态入口。Admin 地址来自 Settings 的 operations email；Coach 地址来自 People 的 notification email。服务器须配置并启用 Resend、发件人和指定店铺。未启用或缺少可用收件地址时可以保持 PENDING / 0 attempts。Customer 的受保护 Shopify 收件地址解析仍未接入，不会真实发送 Customer 确认邮件。未改变任何邮件开关或凭据，未发送真实邮件。

Preview email 根据当前有效 Booking 和收件对象生成预览，不会发送，不是已发送原文存档。Booking / Coach 已变更时可能不能再预览；SUPPRESSED 行不再显示失效预览链接。列表新增通知类型、创建时间与 Booking 引用，便于区分多个 Admin notification。

## Attendance / No-show

- 预约确认后默认预期参加，确认邮件的接收与否不控制预约或 attendance。
- Coach 课后只能 Mark no-show；Admin / Operations 也可以记录 No-show。
- No-show 原子地将预留的 1 次课 CONSUME，不 RELEASE。Pass 不恢复 available credit；Drop-in 的单次 entitlement 被消费，不发起 Shopify 退款。
- 未标记 No-show 的 CONFIRMED Booking，在课程结束后既有 24 小时窗口过去后由 Worker 默认结算 ATTENDED，并且消费一次。
- Session / Booking 行锁、settlement key、版本和幂等保护沿用。重复或并发请求只消费一次。
- 免费取消和有理由的 staff exception 的原规则继续生效；已结算为 No-show 的 Booking 不能再从此操作入口免费取消／豁免。
- Admin Overview 显示 No-show bookings；新记录提示 Credit used / No refund，旧 RELEASE 记录明确标记 Earlier policy，不追扣历史客户。

## 验证边界

真实账本测试涵盖 Pass / Drop-in 的十路并发重试、无 RELEASE、一次 CONSUME、订单来源不变、自动结算不重复、staff No-show。分页测试覆盖 57 条稳定排序、8 页、越界、无效输入、跨店权限和空列表。本地 UI 使用实际组件与模拟数据验证分页、Enter、刷新和查询上下文；这些证据不替代 Shopify 已登录后台 UAT、真实支付或收件箱投递验收。

本轮本地验证结果：npm run check 通过；专用测试库全量 36 个文件 / 382 项全部通过；production-build Coach smoke 在 390px / 1440px 的登录、站内通知、周课表、Month、Training profile、No-show CONSUME、空列表与退出均通过，pageErrors=[]、无横向溢出。Booking 组件 UI fixture 在 1280px / 390px 的 17 条记录分页（8/8/1）、Previous/Next、Go/Enter、无效页码、刷新和 shop 查询参数保留验证通过，控制台无错误／警告。此轮不增加数据库迁移。
