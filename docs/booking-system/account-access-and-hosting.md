# 账户入口与低成本测试部署

更新：2026-09-14。此页区分已修复的本地导航、需要本人完成的登录，以及尚未采购/部署的云服务。

## My account 登录修复

截图中的失败请求发往 `127.0.0.1:9292/customer_authentication/login`。Booking 区块此前把 My account 写死成 `/account`，其他 Skyra 页面使用相对账户路径；本地主题代理把认证请求留在 localhost，进入 Shopify 404 页面/登录弹层后最终返回 401。这不是银行卡或收款认证导致的问题，也不能仅凭截图判定用户账号无效。

已将 Booking 区块、Skyra 页面头部和底部账户入口改为 Shopify 托管地址：保留 Liquid `routes.account_url` 的原生绝对地址；相对路径使用 `shop.permanent_domain` 补全，不由本机接收 Shopify 认证。`Book` 的带课程返回登录仍保留原来的 Attempt/预览主题返回流程。

真实浏览器从本地 Home 点击 My account 后，已到达 `https://shopify.com` 的 “Sign in - Skyra Booking Dev” 页面。未提交邮箱或验证码，未完成 Continue with Shop、退出、账号切换或 Booking 返回验收。此结果不能标记为真实登录 E2E 通过。

- 刷新 [本地 Home](http://127.0.0.1:9292/#skyra-booking-home) 或 [Programs](http://127.0.0.1:9292/pages/programs#skyra-booking-programs)，重新点击 My account；不要刷新截图中旧的 localhost 认证错误页。
- 可直接打开 [Shopify 顾客账户](https://skyra-booking-dev.myshopify.com/account)，由本人完成验证码。
- 顾客账户不提供 Admin 权限。自定义 Booking 客户页面的 Customer Account 导航、稳定 api_url 与真实账号联调仍未完成，登录成功不代表已能访问全部自定义预约页面。
- 根域名未带开发主题参数时仍可能看到 Horizon；开发预览没有发布为正式主题。

官方依据：[Liquid routes](https://shopify.dev/docs/api/liquid/objects/routes)、[主题顾客登录](https://shopify.dev/docs/storefronts/themes/sign-in)。

## Admin 测试入口与顺序

用已经登录 Shopify 的浏览器打开 [Skyra Booking Admin](https://admin.shopify.com/store/skyra-booking-dev/apps/c9d266a38e2f11a1240139974253b3a1)。或进入开发店 Shopify Admin → Apps → Skyra Booking。需要该开发店的店主或有应用权限的员工账号；不能用顾客 My account 登录代替。

1. **People**：检查 Coach 和 Location 测试资料。
2. **Classes & Passes**：创建或编辑团课/Appointment 服务与 Pass。Appointment 使用容量为 1 的固定时段。
3. **Weekly Schedule**：选择未来日期、课程、Coach、地点与时间，保存并发布场次；只有已发布且在查询范围内的课程才出现在前台。当前未来 7 天查询为空，需要先发布未来测试课。
4. **Overview / Bookings**：检查 Today、预约列表和详情。当前没有完成真实预约，空名单本身不代表故障。

这些后台课程/排期操作不依赖银行卡绑定。当前 App 仍依赖本机开发服务与临时隧道在线。本轮已提供应用入口，但独立自动化浏览器没有店主 Cookie，被 Shopify 登录/挑战页拦截；没有冒充店主访问，也没有宣称已替用户完成新增/发布课程。等待用户在本人浏览器反馈 Admin 访问结果。

## 低成本托管选择

Shopify 托管商店与原生 Checkout；本项目的自定义 App、后台 Worker、PostgreSQL 和 Redis 需要另外运行。网站主题继续留在 Shopify，不需要为了 Booking 再买一份 Vercel 前端托管。

以下为 2026-09-14 查询的美元价格，不含税；部署尚未执行，也未开通付费服务。

| 方案 | 费用与适配 | 建议 |
| --- | --- | --- |
| Railway | Hobby 每月最低 US$5，包含 US$5 用量，超出按实际资源收费。按低流量 App + Worker + PostgreSQL + Redis 暂估 US$10–20/月作为初期预算；这是估算，不是整套固定报价，需部署后核对用量。 | 优先作为低成本测试环境候选；正式运营另核实备份、资源和团队方案。 |
| Render | 按 App Starter US$7 + Worker Starter US$7 + Postgres Basic US$6 + Key Value Starter US$10，独立付费服务约 US$30/月，再加适用的存储/流量。最终规格与价格以创建服务时为准。 | 用户已有经验，成本更容易按实例估算，也可继续用。 |
| Vercel | Pro 平台费 US$20/月，数据库、队列和持续运行 Worker 仍需另配；Hobby 限个人非商业使用。 | 当前 Node/队列 Worker 架构下不作为最省钱的第一选择。 |

Render 免费 Web 空闲 15 分钟休眠，唤醒约需一分钟；免费 PostgreSQL 30 天后过期，因此不能把免费组合当稳定 Booking 服务器。需要可靠接收付款 Webhook 与持续处理任务，不能依靠本机或休眠服务完成上线验收。

来源：[Railway 价格](https://railway.com/pricing)、[Render 价格](https://render.com/pricing)、[Render 免费限制](https://render.com/docs/free)、[Vercel Hobby](https://vercel.com/docs/plans/hobby)、[Vercel Pro](https://vercel.com/docs/plans/pro-plan)。

服务器确定后仍需固定 HTTPS 地址、持久数据/备份、Worker 与队列配置，然后更新 Shopify App URL/回调/App Proxy，配置订单权限与真实 orders/paid 订阅，补 Checkout 前端并用测试网关验收。真实支付资料与发件邮箱由经营者填写；本轮不开放支付开关。

## 本轮验证与交付边界

- 24 个测试文件 / 314 项测试全部通过，含新增 6 项账户 URL 回归。
- TypeScript、Customer extension 类型检查、ESLint、生产构建与 Shopify app build 通过。
- 官方 Liquid validator revision 2：共享 snippet 与 7 个修改的 Skyra section 全部通过。
- Home/Programs 的 16 组浏览器场景通过；其中 API fixture 流程不等同于真实 Shopify 登录/付款。
- 顺带修复已有 Checkout 过期 Hold 测试的时间抖动：同一次数据库时钟计算 createdAt/expiresAt，避免两个时钟读数让 15 分钟窗口超出约束。没有放宽生产规则。
- 本地开发主题/扩展已同步；没有正式主题发布、持续云部署、真实支付或邮件投递。本轮与此前 Appointment 批次的工作区修改尚未再次提交 GitHub。
- 证据：`output/booking-next/account-all-tests.log`、`account-check.log`、`account-browser.log`、`account-liquid-validation.log`、`account-app-build.log`。托管登录页面证据为 `hosted-account-snapshot.log`；其中临时认证查询参数不应写入公开文档或提交仓库。

## 2026-09-14 后续修复

真实 Admin 已可进入 Weekly Schedule；随后发现 Save draft 因代理 Origin 校验返回 400，现已修复并完成 322 项测试。开发店本身免费，不增加第二份正式店基础订阅，但不能真实收款；真实支付须安装配置到现有正式店。见 [保存草稿修复与费用说明](schedule-save-fix.md)。
