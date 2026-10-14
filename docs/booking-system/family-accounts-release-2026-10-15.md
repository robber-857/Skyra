# 家庭账号上线记录

2026-10-15，经用户明确要求“上线”后发布。

## 发布结果

- 后端提交：[3600e08](https://github.com/robber-857/Skyra/commit/3600e08cead9585444dcf273e36b6f6726c24244)，已推送至 `bookingdev`。
- [GitHub CI 38652665042](https://github.com/robber-857/Skyra/actions/runs/38652665042) 成功：数据库 setup、应用与客户扩展类型检查、lint、生产构建、1103 项 Vitest、Worker 构建及 8 项 Python 测试通过。
- [Render 部署 dep-db80or5g1s2s73f3gn8g](https://dashboard.render.com/web/srv-dajsoofqj5pc73euugi0/deploys/dep-db80or5g1s2s73f3gn8g) 成功，状态 `Live`，来源提交为 `3600e08`。
- Render pre-deploy 日志确认 `20261014000000_family_accounts` 成功应用；Web 与内置 Worker 使用同一发布镜像，`/health` 返回 HTTP 200 / `{"status":"ok"}`。
- Shopify 配置 `basic-memberships` 通过官方 config validate。沿用当前会员权限、订阅 webhook 及两个已有 UI 扩展；没有切回较旧默认配置或调整业务发布开关。
- Shopify 版本 [skyra-family-accounts-20261015 / 1167572566017](https://dev.shopify.com/dashboard/232832637/apps/420648878081/versions/1167572566017) 先上传为 inactive，待后端就绪且 CI 成功后激活；随后通过 versions list 确认 `active`。
- 正式店 `mf0n6s-zg.myshopify.com` / 正式主题 `155942944935`（Skyra Website – Managed）只上传 `assets/skyra-memberships.js`，使用 `--only` 和 `--nodelete`，未覆盖其他主题文件。

## 线上验证

- 三个 Admin 文件（目录/详情脚本与 CSS）与本地通过验证的构建 SHA-256 一致。
- 公开首页与会员页正在加载 `skyra-family-accounts-20261015` 的 `attempt.js` / `transaction.js`，内容 SHA-256 与本地扩展资产一致。
- 会员页 `skyra-memberships.js` SHA-256 为 `9F914777F6B75787F87CC0843A6D0C48580EB4BB17D765DDE37EC5BE4454FDA1`，与本地发布文件一致。
- 发布前会员脚本已备份；其 SHA-256 与上一个已提交版本一致，确认没有覆盖未同步的商家修改。
- 正式 App Proxy 的匿名 `POST /apps/skyra-booking/family` 返回 HTTP 401 / `LOGIN_REQUIRED`，没有暴露家庭资料。
- 通过现有已登录 Shopify Admin 打开真实 Client：Family members、Add family member、新成员表单及 Cancel 正常；Cancel 关闭表单。没有提交表单、创建孩子、预约课程、调整 Pass 或修改正式客户资料。

本地验证与界面规则见 [家庭账号说明](family-accounts-2026-10-14.md)。本轮本地手机/桌面 fixture 均通过；真实家长登录后添加两个孩子、家长邮件实际收件、真实购买及续订仍需使用具体家庭进行验收。

## 证据与恢复

本地运行证据保存在 Git 外的 `output/family-release-2026-10-15/`：发布目标、后端文件校验、公开资产校验和发布前会员脚本备份。备份与证据不包含正式客户资料。

本轮迁移是新增字段、表和约束，保留历史数据。若需回退前端，可恢复上一 Shopify 版本 `skyra-purchase-modes-20261005` 并从已备份的会员脚本恢复该单文件；后端可在 Render 回退至 `6ec5f57`。保留新增数据库结构，不删除家庭关系、创建意图或付款身份记录；生产回退仍应按当时实际状态执行。
