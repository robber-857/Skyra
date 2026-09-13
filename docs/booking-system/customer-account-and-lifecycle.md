# Customer Account、取消改期与到课结算

更新：2026-09-13。以下是已实现的本地功能；不等于真实 Shopify 客户登录、付款、发信或正式上线验收。

## 本轮功能

- Shopify Customer Account full-page 扩展 `skyra-customer-account`，目标 `customer-account.page.render`，API 2026-07。包含 Upcoming bookings、Booking history、My passes、分页、刷新、空状态、错误恢复、取消和改期。
- 每次请求前重新调用 Session Token API。后端使用 Shopify SDK 验签，再明确验证当前 App audience、有效期、Customer GID 与规范店铺域名。官方 Customer Account token 的 `dest` 可以是裸 `*.myshopify.com` 域名，`iss` 不是必需字段。拒绝浏览器自行指定身份。
- Pass 显示 Available / Reserved / Used、起止时间、适用 Class 和最近 20 条账本记录；更多账本活动明确提示联系 Studio。Pass/预约分页每页 25 条。不是全店购买历史。
- Customer 可以管理自己的预约；Coach 仅能查看被分配课程的名册并记录签到、出席或 No-show；Admin/Operations 可取消、按政策豁免课次、改期和查看账本/操作历史。
- Reports 已替换占位页：近 7 天、30 天、自定义日期；按上课日汇总预约当前状态，按系统处理日汇总已验证预约购买，当前有效 Pass 剩余和 Reserved 课次。购买值不扣线下退款、不包括全店其他订单，不替代财务 reconciliation。

## 已实现的 Class 规则

| 操作 | 条件 | 课次处理 |
| --- | --- | --- |
| 正常取消 | 上课前，且未签到 | 提前至少 12 小时 RELEASE；不足 12 小时 LATE_CANCEL 并 CONSUME |
| Admin 豁免取消 | ADMIN/OPERATIONS、原因必填、尚未结算 | RELEASE；不执行资金退款 |
| 改期 | 原课至少提前 12 小时、未签到、同一 Class 类型、目标处于预约窗口且 Pass 有效 | 锁住两个 Session；在一个事务中释放旧预留并预留新课；失败全部回滚 |
| 签到 | 上课开始后至结束前 | 只记录 checkedInAt；仍保留 Reserved |
| 出席完成 | 课程结束后 | ATTENDED，CONSUME 一次 |
| No-show | 课程结束后，未签到 | NO_SHOW，CONSUME 一次 |

提前取消/改期不延长 Pass 原到期日。Drop-in 仍截止于原课程结束，因此不保证可以改到更晚日期。目标课满员、权益过期/不适用、旧表单、重复/竞争操作均由服务端再次校验。已有预约的管理不依赖新购买发布开关。

每次修改带 expectedVersion 和 idempotencyKey。BookingChange 不可更新/删除。改期创建新 Booking 和不可修改的 BookingReschedule 关联，原 Booking 变 CANCELLED；原 Session、Checkout、Order/Line 和 ownedAttempt 来源保持原值。客户历史显示 Rescheduled 及新编号，后台可以查看新旧关联。此实现更新 data-model.md 早期“直接重指向 Booking Session”的设计：当前数据库已锁定来源，采用新旧记录关联更可靠。

## 邮件与 Coach

- 确认后生成 Customer + Coach 两个任务；取消后生成取消通知并抑制尚未发送的旧确认。
- 改期生成旧课取消通知和新课确认通知；目前不是单封合并的改期模板。
- 取消模板明确是否恢复课次、原有效期不变、此处未进行资金退款。
- 没有配置 provider、受保护客户联系方式或 Coach 验证邮箱；没有真实发信。Reminder、投递回执和自动邀请尚未完成。
- Coach 可以按未来 7/30 天、自定义日期查看课程人数并打开 Roster。当前名册只显示内部客户引用与预约编号，真实姓名/邮箱解析仍待受保护数据权限和联系资料接通。
- Coach cookie 使用 `skyra_coach_session_v2`、Path=/。原 Path=/coach 不会随 React Router 的 `/coach.data` 请求发送，会导致返回列表重新登录；此次已修复。旧 cookie 不再识别，需要重新登录。

## Shopify 接通条件

1. 实际店铺安装/更新 App，取得所需 protected customer data 权限；没有 Customer sub 的 token 会被拒绝。
2. 在客户账号页面编辑器添加此 full-page 扩展和导航入口；把扩展 `api_url` 设置为实际 HTTPS App host。不要填 storefront URL。
3. 当前仅构建了扩展，尚未完成真实客户账号页面安装、配置和登录验收。网络访问能力已声明。必须测试权限拒绝、过期登录和真实 Customer 数据隔离。
4. 本机 Shopify CLI 的模板服务要求 Preact、CLI 参数枚举仍为旧 flavor；因此按官方结构手动创建扩展。已通过 `shopify app build`。
5. 正式 host、数据库/Worker、订单权限/真实 webhook、Checkout 返回链路仍需后续接通。银行及邮箱资料由实际经营者之后填写。

官方依据：[Session Token API 2026-07](https://shopify.dev/docs/api/customer-account-ui-extensions/2026-07/target-apis/platform-apis/session-token-api)。使用官方 AI Toolkit 组件 validator 时设置 `OPT_OUT_INSTRUMENTATION=true`；本地验证成功，不上传源码遥测。

## 验证入口

- `npm run check`：应用与客户扩展 TypeScript、ESLint、生产构建。
- `npm test`：专用 `skyra_booking_test` 库，串行测试文件。
- `shopify app build`：Theme Check 和 Customer Account bundle。
- `scripts/coach-booking-smoke.mjs`：生产构建 + 测试库，390/1440px，登录、日期筛选、Roster、签到、出席、返回列表、退出。
- `scripts/customer-account-smoke.mjs`：390/1440px 本地交互夹具，分页、保留预约、改期确认、取消响应丢失恢复、历史、余额、API 错误恢复与 fresh token。不是 Shopify-hosted 原生组件视觉/真实账号验收。
- Home/Programs 现有 16 组浏览器场景保留；真实用户 UAT 30 组仍待经营者签收。
