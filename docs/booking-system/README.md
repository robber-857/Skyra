# Skyra Booking System

## 最新交接入口（2026-09-16）

本批最新的完成项、Karen Render Dev 数据证据、35 文件 / 379 项全量回归，以及正式发布前必须补齐的支付、邮件、真实账号和运维关口，统一见 [Coach、Reports 与正式发布前收口](release-readiness-2026-09-16.md)。该文件优先于下方同日较早快照。

Coach 本轮实现、测试证据和剩余工作见 [Coach 个人中心交接](handoff-2026-09-16-coach-portal.md) 与 [Coach/Admin 通知、Overview 与 Reports](coach-admin-notifications-reports-2026-09-16.md)；Customer 与交易阻塞历史见 [2026-09-15 交接](handoff-2026-09-15.md)。Coach 已有统一响应式 Portal、Today、Monday–Sunday 周日历、Training profile roster、课后 No-show、Pass credit release、Admin 提醒与 24 小时默认 Attended settlement；Admin/Coach 站内 Booking notification、Admin Overview 与两类 Reports/CSV 已部署到 Render Dev。运行 SHA `06468757b36688826519b516b25996f8a2f3f57b`，CI run `35080110796` 与 Render deploy `dep-dal64seq1p3s73ekc8bg` 成功，015–019 已应用。

最新 [Coach 自助激活与邮件](coach-self-service-and-email-2026-09-16.md) 已实现 Coach 自己提交姓名/邮箱申请、Admin 审批到已有 Coach 后的首次激活。Customer 仍用 Shopify 验证码，主页填写邮箱只是营销订阅，见 [身份、登录与主页邮箱关系](identity-login-and-email.md)。Karen Dev 数据已确认，但真实邮件配置、Customer 邮箱解析和 Karen 真实收件/登录 UAT 尚未完成。

## 2026-09-14：Git 交付与 Coach 测试入口

Appointment/留言/Today 与登录、排课保存修复已提交并推送 `698f7c2` 至 bookingdev，远程 SHA 一致，[CI 34812945622](https://github.com/robber-857/Skyra/actions/runs/34812945622) 通过。以下旧日期的“尚未提交”仅保留当时状态。

随后补充开发店 Admin 专用 Coach 测试登录：People → Create test sign-in link → Open coach test portal → Continue to my schedule。15 分钟单次链接、受限 Coach 会话；正式环境与其他店铺不可签发。Buffer 增加页面说明，并修复 Coach POST 经过本地代理的 Origin 校验。**336 项完整测试、类型/lint/构建以及 Coach 手机/桌面浏览器流程通过**。详细使用方法与边界见 [Coach 测试入口](coach-test-access.md)。

真实老师邮箱邀请、稳定部署、完整真实账号/付款验收仍未完成。本轮没有正式店发布或开放付款；后台测试入口不等于正式老师认证已接通。

## 2026-09-14：My account 修复与 Admin 测试入口

My account 原先使用相对 /account，本地预览把 Shopify 认证请求送到 localhost，出现 404/401。现已将 Booking 区块与 Skyra 页面头部/底部统一指向 Shopify 托管账户地址；实际浏览器已到达 Shopify “Sign in - Skyra Booking Dev”，未代用户提交邮箱或验证码。Admin 使用独立的店主/员工入口，顾客登录不授予后台权限。

新增验证：24 文件 / **314 项测试通过**，TypeScript、ESLint、生产构建、Shopify app build、8 个 Liquid 文件官方验证与 16 组浏览器回归通过。真实账号登录/退出/返回仍未验收，30 组真实 UAT 仍待签收。修复只同步开发预览，未正式发布或开通云服务器，未再次提交 GitHub。

后台链接、添加课程/排期步骤、登录边界及 Railway/Render/Vercel 成本见 [账户入口与低成本部署](account-access-and-hosting.md)。以便宜为主，优先评估 Railway 测试环境；US$5 是最低用量，整套 App/Worker/DB/Redis 费用需按实测核算。

## 2026-09-14：接口恢复与测试版准备

课表代理 500 已恢复：旧临时隧道失效，普通重启仍出现 Cloudflare 1033；切换到经核实 Booking 代理的独立 HTTP2/IPv4 隧道后，6 项健康检查各连续 3 次通过。本轮只恢复开发预览，未正式发布或开放交易。当前未来 7 天没有已发布课程，空列表不表示接口故障。

本地尚余 6 组功能工作；第一版真实账号 + Shopify 模拟付款验收先补 4 个关口，不需等全部运营增强完成。原因、证据、清单和当前启动方式见 [2026-09-14 交接](handoff-2026-09-14.md)。旧批次 308 项自动化通过不替代真实 UAT；30 组真实验收仍待执行。

这是当前唯一有效的 Booking System 文档入口。以下文件共同组成已经批准的 V3 开发基线；历史 Mindbody 页面和仓库中的静态排课内容只作为视觉参考，不再作为产品流程或数据来源。

- Shopify：Customer Account、Product/Variant、Cart、Checkout、Order、Payment、Discount、Refund。
- Booking App：Service、Schedule、Session、Capacity、Booking、Waitlist、Pass entitlement、Coach Portal、Admin workflow。
- PostgreSQL：预约、排期、次数权益和运营状态的唯一可信来源。

## 当前开发进度

已创建并绑定 **Skyra Booking**。目前已实现团课预约/付款回调/课次账本的本地闭环、客户个人中心与取消改期、Coach Today/周课表/Training profile roster/No-show、Admin/Coach 站内 Booking 通知、Admin Overview、预约管理与逐 Customer/Pass Reports/CSV。Coach 不做 Check-in / Attended；No-show 释放 1 次预留 Pass 并提醒 Admin，其余 Booking 在 24 小时窗口后由 Worker 默认结算。真实 Customer 登录与 Checkout UAT、正式 Coach email invitation、真实邮件投递、Shopify refund 财务同步、异常人工处理、动态 availability 和生产运行仍待完成。请优先阅读 [开发状态](development-status.md)、[Coach 交接](handoff-2026-09-16-coach-portal.md) 和 [身份登录说明](identity-login-and-email.md)。

## 推荐阅读顺序

1. [身份、登录与主页邮箱关系](./identity-login-and-email.md)
2. [系统架构与 Shopify 实现边界](./architecture.md)
3. [Booking、Pass、Checkout 与同步流程](./booking-pass-flow.md)
4. [三端低保真交互原型](./wireframes.html)（早期参考；Coach 操作以最新交接和代码为准）
5. [数据库模型与 ERD](./data-model.md)
6. [MVP 开发任务与顺序](./implementation-backlog.md)

## 各文档职责

| 文件                        | 用途                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `architecture.md`           | 系统边界、三端页面、Shopify 能力、部署架构和数据归属                                                                    |
| `identity-login-and-email.md` | Customer/Coach/Admin 身份、Shopify 登录、Coach 邀请现状与主页 newsletter 关系                                          |
| `booking-pass-flow.md`      | 登录、选择 Pass、Checkout、付款回调、扣次、通知与数据同步                                                               |
| `wireframes.html`           | Customer、Admin、Coach 三端可点击低保真原型；Home 与 Programs 复用同一个 Booking section 状态机；Admin 保持六个日常入口 |
| `data-model.md`             | 核心表、关系、约束、状态和数据所有权                                                                                    |
| `implementation-backlog.md` | 当前唯一执行计划：MVP/P1/P2 范围、开发顺序、文件迁移和验收任务                                                          |
| `coach-admin-notifications-reports-2026-09-16.md` | Coach/Admin 通知、Overview、Reports 数据口径、验证证据与未完成邮件/部署工作 |

## 核心实现原则

1. 客户只使用 Shopify Customer Account，不创建第二套客户密码。
2. Admin 使用 Shopify Embedded App；Coach 使用独立、受限的 Portal。Coach 由 Admin 邀请已存在记录，不自助注册，也不复用 Shopify Customer Account。
3. Pass 在 Shopify 中是可购买商品，在 Booking DB 中是可消费权益。
4. 已有 Pass 预约不进入 Checkout；购买新 Pass 才进入 Shopify Checkout。
5. 付款后通过幂等 Webhook 创建权益并确认 Booking。
6. 课程容量、Seat Hold 和 Pass 扣次必须在 PostgreSQL 事务中处理。
7. Shopify 与 Booking DB 之间使用 Webhook、Outbox 和定期 reconciliation 同步。
8. Admin 保存 Class/Pass 后由 Worker 用 `productSet` 同步稳定的 Shopify Product/Variant；Weekly Session 只存在 Booking DB，不按课次创建商品。
9. 留言仅由客户在每次 Booking 填写并保存于 Booking DB；本人、对应 Coach 和获授权 Admin 可看。不开发老师回复或其他留言系统。
10. Home 与 Programs 不复制两套 Booking 代码：两个主题占位节点由同一个 Theme App Extension app embed 挂载。
11. 浏览、课程详情、Pass 选择、已有 Pass 确认和结果状态都在当前 Booking section 内切换；登录和付款分别使用 Shopify Customer Account 与 Shopify Checkout，完成后返回原 section 并恢复 Booking attempt。
12. Book 必须即时验证 Shopify Customer Account 登录；未登录显示 Skyra 登录提示，并用当前顶层页面进入 Shopify 托管登录，返回原课程后重新验证。当前已接服务端 opaque Attempt、不可换绑的 Shopify 客户身份和固定返回路径；真实开发店 Customer 全流程 UAT 尚未签收。
13. 本轮 Find a Class、Select a pass 和交易摘要参考图只定义 Home / Programs 的下单 UI；Customer Account 的 My Bookings / My Passes 已完成本地实现，真实账号接通待验收。

## 已清理的旧假设

- 不再使用“Home 只有三条静态 Preview、Programs 的 Book 按钮跳 Mindbody”的方案。
- 不再设计独立的 Class Details、Select a Pass、Cart 或 Confirm Payment 页面；它们是同一区块内的状态，支付表单只属于 Shopify Checkout。
- 不为每周的每一场 Session 创建 Shopify Product。Class/Pass 定义可同步 Product/Variant，实际排课只进入 Booking DB。
- `shopify-theme/sections/skyra-home.liquid` 和 `shopify-theme/sections/skyra-programs.liquid` 已替换为共享挂载节点；根目录静态 HTML 原型不作为后端实现依据。

## 测试与交接

参见 [开发预览与测试](preview-testing.md)、[真实 UAT 清单](launch-readiness-and-uat.md) 和 [2026-09-13 交接](handoff-2026-09-13.md)。
