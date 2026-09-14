# 整站上线准备与真实验收清单

## 2026-09-14：接口恢复与测试版准备

课表代理 500 已恢复：旧临时隧道失效，普通重启仍出现 Cloudflare 1033；切换到经核实 Booking 代理的独立 HTTP2/IPv4 隧道后，6 项健康检查各连续 3 次通过。本轮只恢复开发预览，未正式发布或开放交易。当前未来 7 天没有已发布课程，空列表不表示接口故障。

本地尚余 6 组功能工作；第一版真实账号 + Shopify 模拟付款验收先补 4 个关口，不需等全部运营增强完成。原因、证据、清单和当前启动方式见 [2026-09-14 交接](handoff-2026-09-14.md)。旧批次 308 项自动化通过不替代真实 UAT；30 组真实验收仍待执行。

## 2026-09-13 新进度

客户个人中心（Upcoming/History/My Passes）、取消/改期、Coach 名册/签到/出席、Admin 预约管理与基础 Reports 已完成本地实现。本轮新增私教固定时段直接确认、客户逐次留言、Admin/Coach Today；12 条迁移已应用。经营者以后补银行、身份和邮箱配置。下表中的早期缺口按本段更新；真实 UAT 的 30 组仍全部待实际账号签收，自动化通过不替代真实签收。详细边界见 [本轮说明](appointment-and-comments.md) 与 [交接](handoff-2026-09-13.md)。

更新：2026-09-13。本轮已重新执行自动化与浏览器测试；未配置真实支付、邮箱或真实客户账号页面。

## 如何理解剩余工作

当前 308 项自动化测试通过，Coach 和 Customer 各 2 个尺寸、Home/Programs 16 组场景均在本轮通过。它们主要覆盖当前已实现逻辑与本地 fixture，不等于整站或真实 Shopify 支付/邮件验收。Backlog 的旧勾选项存在“代码已实现但完整交付未签收”，不能简单统计未勾选项或用测试数量计算完成百分比。

当前完整原定 MVP 尚有 8 类工作：

| 类别 | 当前已有 | 尚需完成 |
| --- | --- | --- |
| Shopify 实际交易 | Cart 编排、验签、paid Worker、权益/Booking、恢复查询 | 订单权限/订阅、真实登录、Checkout 跳转/返回、测试交易、正式支付配置 |
| Customer 与取消改期 | Home/Programs 选课/确认，Account 预约历史/Pass，取消/改期 | Overview 聚合、客户真实资料、日历、真实账号接通；逐次留言已实现；My Passes/History、取消/改期已实现 |
| Coach 日常操作 | 安全登录、7/30 天及自定义统计、名册/签到/出席/No-show 与审计 | 真邮箱邀请、真实姓名解析、Availability；Today 和每节课客户留言已实现 |
| Admin 运营 | Class/Pass 和周排课、预约详情/取消豁免/改期/课次流水/历史、基础 Reports | Customer People、手工预约、可操作异常队列、线下处理记录、逐客户报告/导出、完整 Settings |
| 邮件通知 | Customer/Coach 确认模板、事务任务、预览和重试接口 | provider、收件人解析/邮箱验证、真实投递、回执和提醒；取消模板与改期旧取消/新确认任务已实现 |
| Appointment 与扩展排期 | 固定单人时段、直接确认、取消改期、逐次留言、通知任务；Coach/Location/buffer 冲突 | 周期 availability/time off、动态 slots、独立资源管理、真实整链路；不需要审批 |
| 可靠性与部署 | 本地 DB/Redis/Worker、CI、并发/幂等/身份校验 | reconciliation、告警、生产持久服务/域名/Secrets、备份恢复、负载和完整真实角色验收 |
| 旧系统数据与上线切换 | 迁移规划 | 如承接旧数据：导出、客户去重映射、余额/未来预约导入与对账、切换/回滚演练 |

自动客户退款明确延期，Admin 线下处理；取消、释放课次、线下处理记录仍是独立功能。Course 整期报名/Waitlist 等原定 P1 与自动续费等 P2 不混入此处完成率。

## 30 条真实验收基线

以下是本次整理的验收场景组，每组可能包含多个测试用例；不是“剩余自动化测试总数”，后续功能实现还会新增测试。当前均待完整环境和真实角色的整链路签收；有本地证据的项目不能据此标记真实验收通过。

| 编号 | 场景 | 验收内容 | 状态 |
| --- | --- | --- | --- |
| UAT-01 | 网站 · 全站页面与链接 | 逐页检查现有网站页面、导航、图片、Contact、My account、Booking 入口、旧 Mindbody 链接及空/错误页。 | 待整链路签收 |
| UAT-02 | 网站 · 手机与桌面效果 | iPhone Safari、Android Chrome、桌面浏览器检查排版、触控、焦点、返回、刷新、加载与错误恢复。 | 待整链路签收 |
| UAT-03 | 网站 · Home/Programs 一致性 | 同一课程在两入口的时间、Coach、价格、容量、筛选和确认结果一致。 | 待整链路签收 |
| UAT-04 | 身份 · 新客户登录 | 真实客户完成 Shopify 登录、验证码/Continue with Shop 和原页面返回。 | 待整链路签收 |
| UAT-05 | 身份 · 退出与会话过期 | 退出后重新预约要求验证身份；过期/无 storage 的返回仍可恢复或明确提示。 | 待整链路签收 |
| UAT-06 | 身份 · 账户切换与隔离 | 两客户/两 Coach 互不可读写他人的 Pass、Booking、排期或预约留言。 | 待整链路签收 |
| UAT-07 | 支付预约 · Drop-in | 选课→登录→Shopify 测试付款→Webhook→预约→客户/Coach 查看；金额和身份核对。 | 待整链路签收 |
| UAT-08 | 支付预约 · 购买新 Pass | 购买次数卡后只发一次权益、只预留一课次、剩余次数和到期日期正确。 | 待整链路签收 |
| UAT-09 | 支付预约 · 已有 Pass | 预约无需再次付款；课次/名额变化和重复点击处理正确。 | 待整链路签收 |
| UAT-10 | 支付失败 · 拒付和重试 | Shopify 测试拒付→同一流程重试；未付费不生成成功 Booking/邮件。 | 待整链路签收 |
| UAT-11 | 支付失败 · 离开 Checkout | 客户关闭/取消/返回 Checkout；Hold 到期释放，不误报付款或预约成功。 | 待整链路签收 |
| UAT-12 | 支付失败 · 过期后付款 | Hold 到期后分别有位/满员/课程变更；正确确认或 Needs Attention，保留权益事实。 | 待整链路签收 |
| UAT-13 | 恢复 · 重复消息与丢失响应 | 重复 Webhook、重复点击、确认提交后断网均无重复权益/Booking/通知。 | 待整链路签收 |
| UAT-14 | 恢复 · 漏消息对账 | 漏 Webhook 可被 reconciliation 发现并安全处理，人工处理有审计。 | 待整链路签收 |
| UAT-15 | 恢复 · 服务故障恢复 | Worker 重启、短暂 DB/网络故障、UNKNOWN Cart 不盲目创建新订单。 | 待整链路签收 |
| UAT-16 | Customer · 个人中心 | My Overview / My Passes / Bookings & History 的余额、预留、到期、历史与日历入口正确。 | 待整链路签收 |
| UAT-17 | Customer · 取消政策 | 提前取消、Late Cancel 边界；预约状态/名额/课次结果一致，无自动资金退款。 | 待整链路签收 |
| UAT-18 | Customer · 改期 | 新课程预约成功才释放旧课；失败保留原预约，邮件与历史一致。 | 待整链路签收 |
| UAT-19 | Coach · 真实邀请与登录 | Coach 真邮箱收到邀请，登录/退出/停用/一次性链接和角色权限正确。 | 待整链路签收 |
| UAT-20 | Coach · 报名统计 | 未来 7 天、30 天、自定义首尾日期、Sydney DST、空课/满课的课程人数与数据库一致。 | 待整链路签收 |
| UAT-21 | Coach · 名册和签到 | Roster、Attended、No-show、对应客户本次预约留言及 Today 名单；课次结算与隔离一致。 | 待整链路签收 |
| UAT-22 | Admin · 配置与排课 | 真实使用 Classes & Passes / Weekly Schedule 建课、配价、指定 Coach、冲突、复制、发布。 | 待整链路签收 |
| UAT-23 | Admin · 客户及异常处理 | People / Bookings 管理客户、人工预约、异常处理、取消/恢复课次与线下处理记录。 | 待整链路签收 |
| UAT-24 | Admin · 报表与审计 | 消费/未使用课次报表与订单/ledger 对账；关键操作记录操作者、时间与原因。 | 待整链路签收 |
| UAT-25 | 邮件 · 客户和 Coach 确认 | 真实收到正确课程/时间/地点的邮件；收件人不串，Reply-To 可回信。 | 待整链路签收 |
| UAT-26 | 邮件 · 提醒、改期、取消 | 正确事件和时点发送通知，旧排期不继续发送错误提醒。 | 待整链路签收 |
| UAT-27 | 邮件 · 投递故障 | 明确拒绝、退信、UNKNOWN、provider 重复回执的重试/人工处理不重复发信。 | 待整链路签收 |
| UAT-28 | Appointment · 私教完整流程 | 发布的单人时段、有效 Pass/Shopify 测试付款后直接确认、容量/Coach/Location/buffer 冲突、留言、取消/改期、通知；动态 availability 为扩展项。 | 待整链路签收 |
| UAT-29 | 上线环境 · 部署、备份与收款 | 正式域名/HTTPS、持久 Worker、告警、备份恢复；预发布通过后再由用户授权小额真实订单和到账核对。 | 待整链路签收 |
| UAT-30 | 迁移 · 旧数据与切换 | 如需承接旧系统，dry-run 对账客户、未用课次和未来预约，演练最终增量、切换和回滚。 | 待整链路签收 |

每次执行记录环境、日期、账号角色、设备/浏览器、预期、实际、截图/订单/Booking 引用和缺陷。测试日志不存身份证、银行卡、登录凭据等敏感资料。

## 给用户的三阶段体验

1. 开发期间分模块看效果，缺陷及时改；功能开发仍由自动化/数据库/浏览器回归伴随验证。
2. 核心功能完成后，在受保护测试环境用真实 Customer/Coach 登录和实际邮箱，从 Admin 排课到客户预约、Coach 统计/签到、取消改期完整使用。付款使用 Shopify 测试网关或测试模式，不需要真实扣款。非测试订单不得在此阶段误用。
3. 正式店配置和验收通过后，再由用户明确授权有限真实交易，核对真实支付和银行到账，再正式切换入口。开发店与正式店分开，身份资料和真实收款账户在正式商户账号配置。

Shopify 支持测试网关/Shopify Payments test mode，测试订单不产生实际收费；可用条件按店铺类型/计划确定，开发店单独核对。正式店开启 test mode 会影响真实下单，届时需要安排测试窗口。[官方测试订单说明](https://help.shopify.com/en/manual/checkout-settings/test-orders)。

## 你需要在 Shopify 准备什么

由商户所有者在正式店 Shopify 后台完成；若你只是技术管理员，Payments 的代表人须为适格的实际经营者/负责人，不自动使用技术管理员身份。

| 项目 | 准备资料 / 入口 |
| --- | --- |
| 商户与身份 | Settings → Payments → Shopify Payments → Activate Shopify Payments：按真实业务类型填写法定姓名、出生日期、住址、邮箱/电话；Sole Trader/Company 填注册名称、ABN，公司适用时 ACN、负责人/所有人信息；按后台要求补有效护照/驾照、地址或企业证明 |
| 银行收款 | 审核后 Settings → Payments → Shopify Payments → Connect a bank account；准备账户名称、BSB、账号，账户须满足澳洲 AUD/BECS 要求。这是接收销售款的银行账户，和支付 Shopify 套餐费用的 Billing 方式分开 |
| 支付方式 | 同页 Shopify Payments / Manage 检查卡支付、Shop Pay、Apple Pay、Google Pay；其他 provider 如需启用，由 Shopify 后台另行连接，Booking 不实现独立支付网关 |
| 账号安全 | 启用 Shopify 两步验证；Payments 所需身份和证件直接在 Shopify 后台安全入口提交 |
| 商家资料 | 正式业务名称、地址、电话、AUD 币种和实际经营内容；客户可见账单联系方式与真实业务一致 |
| 邮箱 | Settings → Notifications → Sender email 填 hello@skyrastudio.com.au；完成 Email domain authentication；在实际 DNS 托管处按 Shopify 给出的 CNAME 认证 SPF/DKIM，并检查 DMARC |
| 域名/登录 | 正式域名可管理、GoDaddy/DNS 和邮箱账号可登录；客户登录入口、Customer Account 和 Skyra Booking 安装权限由开发联调后验收 |

身份证明和银行详情由本人直接填 Shopify，不发到聊天或写入项目文档。具体验证要求随业务类型和后台审核结果决定，并非所有证件都必须一次上传。[澳洲信息要求](https://help.shopify.com/en/manual/payments/shopify-payments/supported-countries/australia/requirements)、[开通及银行绑定入口](https://help.shopify.com/en/manual/payments/shopify-payments/onboarding/account-setup)、[两步验证要求](https://help.shopify.com/en/manual/payments/shopify-payments/onboarding)。

## 邮箱不需要搬家

上轮只读 DNS 得到 Microsoft 365 MX；GoDaddy 购买渠道仍未登录核对。hello@skyrastudio.com.au 可继续由现有服务商收信。Shopify 负责订单邮件发件认证；Booking App 另接事务邮件 provider 和相应发信认证，同一品牌 From/Reply-To 可复用。Shopify 的发件认证不会自动授予 Booking App 发信权限。Coach 另需自己的真实收件邮箱。

Shopify 对第三方域名提供自动或手工认证，实际记录以后台为准；GoDaddy 买域名不代表现在 DNS 一定托管在 GoDaddy，也不代表邮件已完成 Shopify 发件认证。[官方发件邮箱设置](https://help.shopify.com/en/manual/intro-to-shopify/initial-setup/setup-your-email)。

## 当前即可准备，不依赖后续代码

确认正式经营主体/ABN（如适用）、谁是 Shopify 所有者和商户负责人、合适的收款银行账户、能登录的 hello 邮箱与 DNS 管理账号，以及用于验收的一名 Coach 和两个 Customer 账号。业务资料如价格、Pass 次数/期限、课程表、取消规则和旧系统数据范围也需要最终确认。当前不要求你在聊天里提供敏感号码或上传证件。
