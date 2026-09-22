# Skyra Booking 正式店上线交接（2026-09-21）

> 2026-09-21 本次实现更新：独立正式店 gate、首次课程激活/日历月、Mindbody 幂等 importer 与本地测试已推进。以 [实现记录与操作手册](production-implementation-2026-09-21.md) 的最新证据为准；以下“当前尚无 importer/只允许开发店”描述属于本轮开始前的交接基线。正式安装、真实 UAT、最终 cutoff 和公开放行仍需逐项验收。

> 2026-09-22 更新：正式店已完成全量 286 位 Mindbody 注册客户及源表剩余权益、已有预约的迁移。店主接受已使用快照，后续购买自行核对；已应用 manifest 保持冻结，不再改 cutoff 重导。后续由 Admin 用现有 20 门课程配置老师、价格和具体课次，无需完整未来 Mindbody 课表导出。排课日期选择范围为 2026-01-01 至 2099-12-31，不自动生成多年课次。以下旧 delta/未导入描述仅保留为历史计划。最新证据见 [正式迁移记录](mindbody-production-import-2026-09-22.md) 和 [Admin 排课准备](admin-scheduling-preparation-2026-09-22.md)；真实登录、付款/webhook、Resend 与公开放行仍须验收。

## 当前结论

现在可以开始把 Skyra Booking 安装和配置到 Shopify 正式店，但暂时不能开放真实付款和公开预约入口。

正式开放前仍需完成生产店开关、Pass 激活与有效期规则、Mindbody 幂等导入、正式店扩展配置、Resend 邮件和真实用户全流程验收。公开入口应在这些检查全部通过后最后切换。

## 新会话先读取

1. `docs/booking-system/launch-status-2026-09-20.md`
2. `docs/booking-system/mindbody-data-migration-2026-09-21.md`
3. `D:\Skyra-migration-private\mindbody-2026-09-21\Skyra_Mindbody_Booking_Reconciliation_2026-09-21.xlsx`

第三个文件包含客户数据，必须继续保留在 Git 仓库外。

## 已验证状态

- 工作区：`D:\Skyra`
- 分支：`bookingdev`
- 当前提交：`b2880f7d4b9c4782782818981248228f29147f4b`
- 远端 `origin/bookingdev` 与当前提交一致。
- GitHub CI 已通过：<https://github.com/robber-857/Skyra/actions/runs/35570126477>
- `npm.cmd run check` 已通过，包括类型检查、lint 和生产构建。
- `npm.cmd run test:db` 已通过：42 个测试文件、403 个测试。
- `npm.cmd run build:worker` 已通过。
- `shopify.cmd app build --path D:\Skyra\booking-app` 已通过。
- Render `/health` 返回 HTTP 200。
- Shopify CLI 版本为 4.8.0。
- 当前应用仍连接开发店 `skyra-booking-dev.myshopify.com`。
- 正式店为 `mf0n6s-zg.myshopify.com`。
- 当前 Shopify App 活跃版本仍为 `skyra-booking-13`，晚于该版本的代码尚未发布为新的 App 版本。
- 正式店当前主题：
  - Live：`155942944935`，`Skyra Website – Managed`
  - Unpublished：`156227535015`，`Copy of Skyra Website – Managed`
  - Unpublished：`156252799143`，`Copy`
- 公开网站仍显示现有 Mindbody 流程；`/pages/programs` 当前返回 404，尚未挂载新的 Booking 入口。

## 上线前 P0 阻断项

### 1. 正式店能力开关

`booking-app/app/services/commerce-capabilities.server.ts` 当前只允许开发店。正式店会得到：

- `checkoutAvailable=false`
- `ownedPassesAvailable=false`

需要实现明确的正式店 allowlist/release gate，并保留紧急关闭开关。不要把测试店环境变量直接改成正式店来绕过限制。

### 2. Pass 激活与有效期

当前新权益仍按 Shopify `purchasedAt` 和 `validityDays` 计算。正式规则应改为：

- Pass 从客户第一次实际预约的课程日期开始激活；购买时不开始倒计时。
- 有效期按日历月计算，并保证重复 webhook、重复导入或重试不会重复激活。
- Aerial 5 次：首次上课起 2 个月。
- Aerial 10 次：首次上课起 6 个月。
- Aerial 30 次：首次上课起 10 个月。
- SKYRA Lifestyle：每月 12 次；已确认的 3 笔 `$299` 是连续 3 个月，每月一个独立 12-credit tranche。
- Dance 10 次：首次上课起 3 个月。
- Dance 20 次：首次上课起 6 个月。
- Dance Monthly：每月 4 次。
- No-show 和已使用的 Drop-in 不退 credit/款项。

### 3. Mindbody 幂等迁移

当前代码还没有正式迁移导入器及完整来源键。需要加入：

- `sourceSystem`、`externalKey` 或等价的唯一来源键。
- migration batch、dry-run、导入结果和失败重试记录。
- 客户、Pass opening balance、未来预约、课程/教练/地点映射。
- 重跑导入时不得重复创建客户、权益、预约或 reserved credit。
- 为旧数据补充私教 10 次、私教 5 次、MV Filming Project 限定权益和 Lifestyle 月份 tranche 映射。

迁移底表已核对：

- 63 条 Visits Remaining 原始记录。
- 以 2026-09-21 为基准，20 条当前/未来激活余额记录。
- 调整陈旧的私教 Absent 后为 161 available credits + 8 future reserved credits。
- 2 个 Intro Pass 于 2026-09-21 到期；按到期后切点则为 18 条、155 available + 8 reserved。
- 8 条未来 Reserved 预约已全部匹配到具体 Pass。
- 正式导入前必须再做一次最终 cutoff delta，并先备份正式数据库。

### 4. 正式店安装和 Shopify 配置

在未发布主题上先完成：

- 将 App 安装/OAuth 到 `mf0n6s-zg.myshopify.com`。
- 核对 offline session、授权 scopes、App Proxy 和 `orders/paid` webhook。
- 启用 Theme App Extension 和 Customer Account Extension。
- 建立正式 Location、Coach、Services、Passes。
- 同步正式店 Product/Variant 映射；不得复制开发店 GID 或测试数据。
- 完成 `orders/paid` 对账与 Needs Attention 人工处理闭环。
- 代码修改、测试、CI 和 Render 发布完成后，再执行新的 `shopify app deploy` 并确认新版本为 active。

### 5. Resend 与邮件

本地环境目前没有检测到下列配置；现有项目文档也记录 Render 邮件尚未完成配置：

- `SKYRA_MAIL_ENABLED`
- `SKYRA_MAIL_PROVIDER`
- `RESEND_API_KEY`
- `SKYRA_MAIL_FROM`
- `SKYRA_BOOKING_MAIL_SHOP`
- `SKYRA_COACH_LOGIN_SHOP`
- `SKYRA_COACH_MAIL_KEY`

正式店安装后配置 `hello@skyrastudio.com.au`，再验证 customer、admin、coach、登录邮件和课前 12 小时提醒。必须核对真实收件箱、垃圾箱、退信和发送日志；Preview 不能代替真实送达验证。

## 建议执行顺序

1. 实现正式店 release gate 和紧急关闭开关。
2. 完成 Pass 首次课程激活、日历月有效期及幂等测试。
3. 实现迁移 schema、映射、dry-run 和正式 importer。
4. 提交并推送代码与文档，等待 CI 通过。
5. 发布 Render，并部署新的 Shopify App 版本。
6. 在未发布主题上安装并配置正式店 App、Proxy、webhook 和 extensions。
7. 建立正式课程、Pass、Coach、Location、Product/Variant 映射。
8. 配置 Resend 和生产邮件变量。
9. 导入 Shopify 客户，再执行 Mindbody dry-run；核对客户、未来预约和 opening balance。
10. 在正式数据库备份后执行最终 cutoff delta 和正式导入。
11. 完成真实付款、Customer Account、Coach、Admin、邮件和移动端 UAT。
12. 最后发布主题并把 Mindbody 入口切换到 Skyra Booking；保留旧主题作为回滚入口。

## 必须通过的真实 UAT

1. Drop-in 付款 → `orders/paid` → 创建预约。
2. 新 Pass 购买 → 创建 entitlement → 首次预约激活 → reserved credit 正确。
3. 迁移 Pass 预约 → 余额扣减 → 取消/No-show 规则正确。
4. Customer Account 登录、余额、历史、取消和改期。
5. Coach 登录、名单、签到和 No-show。
6. Admin 通知、分页、报告和 Needs Attention。
7. Customer/Admin/Coach/课前提醒真实邮件送达。
8. 手机和桌面的 Home、Programs、My Account 全流程。
9. Shopify Payments 的测试模式、身份验证、2FA、银行账户和 payout 设置由店主确认。
10. Worker、队列、邮件失败告警及上线首日人工对账可用。

## 开放条件

以下条件全部满足后才可开放真实付款和公开预约入口：

- 正式店能力开关已安全启用，并保留紧急关闭。
- 正式店安装、App Proxy、webhook、extensions 均已验收。
- Pass 激活和有效期规则已通过自动化测试与真实 UAT。
- Mindbody dry-run 无阻断异常，最终导入总数和余额已签字核对。
- Shopify Payments 与 Resend 真实流程已验证。
- 公开主题切换方案和回滚方案均已准备。

## 当前未提交文件

本轮迁移与上线文档仍在本地工作区，下一会话应先复核并单独提交：

- `docs/booking-system/README.md`
- `docs/booking-system/launch-status-2026-09-20.md`
- `docs/booking-system/mindbody-data-migration-2026-09-21.md`
- `docs/booking-system/handoff-2026-09-21-production-launch.md`

不要把 `D:\Skyra-migration-private` 中的任何文件加入 Git。
