# Save draft 来源校验修复与开发店收费 — 2026-09-14

## 问题、原因与修复

用户在 Weekly Schedule 点击 Save draft，看到 React Router singleFetchAction 的 Bad Request；另一次出现 Cloudflare Tunnel 无法解析页面。这是两个独立的失败层，不能把所有失败归因于排期字段或隧道。

1. **保存草稿 400**：安装版本 React Router 7.18.3 在 singleFetchAction 进入业务 action 前校验 Origin。Shopify CLI 把公网 HTTPS 请求转发到本机，服务器看到的 request URL 与公网 Origin 不同。仓库没有 react-router.config.ts 的允许来源配置，合法提交被框架拦截，未执行 addSessions。通过本地代理和真实公网各发送无有效凭据的 POST，修复前均返回 400 / Bad Request，复现了截图。
2. **Cloudflare 短暂断连**：独立 cloudflared 日志在 2026-09-14 05:45:26 UTC 记录 lost connection，随后 TLS handshake 被关闭和连接超时，05:47:06 UTC 注册重连成功。本轮检查时原进程与域名已恢复，没有重建隧道或更换 URL。网络断开的更底层原因没有足够证据，不断言是防火墙或用户操作。

新增 `booking-app/react-router.config.ts`，从 SHOPIFY_APP_URL（兼容 CLI 的 HOST）读取精确 host 到 allowedActionOrigins；无配置时保持空列表。没有关闭 CSRF，没有允许所有 trycloudflare.com / shopify.com 子域，没有改 OAuth、Staff 校验或预约写入规则。此设置是框架构建配置：部署必须在构建/启动开发服务前配置实际 App URL；地址变更应重新构建/启动，不能把临时域名写死进生产代码。

官方依据：[React Router 配置](https://reactrouter.com/api/framework-conventions/react-router.config.ts#allowedactionorigins)。具体行为同时核对了本项目安装版本源代码。

## 验证

- 新增 8 项真实 React Router 请求处理器回归：旧配置复现；可信公网来源调用实际 Schedule action 并在专用测试库保存 DRAFT；相同请求重试只生成一条草稿；另一个临时域名、伪装后缀、Shopify Admin 域名、不同端口及陌生域名被拦截；认证失败继续拒绝。只有测试替身模拟管理员，运行中的 App 没有任何认证绕过。
- 完整 **25 文件 / 322 项测试通过**；TypeScript、Customer extension 类型检查、ESLint、生产构建通过。
- 真实运行中的本地代理和公网 POST：当前 App Origin 不再触发 Bad Request，无有效身份时为 401；陌生 Origin 仍为 400。未携带或提取用户会话，没有在开发店创建实际测试课程。
- Home、Programs、App host、课表代理、Shopify upstream、公网 App health 六项各 3 次 HTTP 200 / 内容校验通过。
- 用户已经能进入真实 Admin 并打开 Weekly Schedule，但本轮是否能在本人会话成功 Save draft 仍待用户重试反馈。需重新打开应用或刷新页面；不把自动化替身测试标为本人 UAT 通过。
- 证据：`output/booking-next/schedule-origin-before.log`、`schedule-origin-after.log`、`schedule-all-tests.log`、`schedule-check.log`、`schedule-health.log`。早期单文件测试日志记录测试钩子返回 mock 函数的问题；最终完整测试日志为准。

## 用户重试

打开 [Skyra Booking Admin](https://admin.shopify.com/store/skyra-booking-dev/apps/c9d266a38e2f11a1240139974253b3a1) → Weekly Schedule，刷新后重新选择未来时段并 Save draft。成功应显示 `1 draft session(s) saved.`，对应周列表为 DRAFT；前台展示还需要 Publish week。如提示具体的老师/地点冲突或日期已过去，应按提示调整排期，不绕过规则。原页面因错误丢失的未保存表单不会被自动恢复。

## 开发店费用和真实付款边界

截图右上角 Skyra Booking Dev 的 dev 标记与项目开发店用途一致。Shopify 官方明确 dev store 是免费开发测试店，因此此店本身不会额外产生第二份正式店铺基础订阅。本轮没有打开用户账单，不将此说明当作全部应用/域名等账单审计。

计划是保留免费开发店做测试，将完成的 Booking 系统安装配置到现有正式店。正式店原有订阅继续；Booking App 外部服务器/数据库和以后使用的邮件服务费用另算。没有开通第二个付费店铺或新增 Shopify 应用收费。

**开发店仅支持测试网关/支付测试模式，不能真实扣款，当前 Dev store 也不能转换为生产店。** 经营者后续的银行资料、商户身份、真实支付设置应在现有正式店处理；开发店负责模拟成功、拒付、取消、重复通知等集成验收。先前文档中“经营者配置后测试真实卡支付”的泛指应理解为正式店，不能在这个 Dev 店执行。

来源：[Shopify 免费开发店](https://shopify.dev/docs/storefronts/themes/tools/development-stores)、[Dev stores 的交易与转换限制](https://shopify.dev/docs/apps/build/stores/development-stores#limitations)。

## 交付状态

修复已由本地开发服务加载；尚未再次 Git commit/push、正式发布或采购云服务。三个公开交易能力开关仍关闭。临时隧道仍可能掉线，持久测试服务器工作仍待完成；本轮来源配置修复不能替代持续云部署。
