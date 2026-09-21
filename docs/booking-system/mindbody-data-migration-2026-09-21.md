# Mindbody 数据迁移审计与执行方案（2026-09-21）

> 2026-09-21 本次实现更新：独立正式店 gate、首次课程激活/日历月、Mindbody 幂等 importer 与本地测试已推进。以 [实现记录与操作手册](production-implementation-2026-09-21.md) 的最新证据为准；以下“当前尚无 importer/只允许开发店”描述属于本轮开始前的交接基线。正式安装、真实 UAT、最终 cutoff 和公开放行仍需逐项验收。

本文件记录 2026-09-21 对 Mindbody 导出文件的本地只读检查，并定义迁移到正式 Skyra Booking 的执行边界。原始文件含个人信息，只保存在仓库外；本文件只记录字段、数量、缺口和操作步骤。

## 当前结论

**最新全年 Visits Remaining、全年 Sales 和当前 Schedule 已足够建立迁移 dry-run 基线：20 条在 2026-09-21 尚未到期或未来激活的余额记录、8 条未来 Reserved Booking。SKYRA Lifestyle 三笔 $299 已确认为连续三个月、每月 12 次；生产写入前只需按 cutoff 排除已到期权益，并完成 importer、legacy 映射、首次课程激活和幂等改造。**

主要阻塞项：

1. 最新 Schedule 已确认 8 条未来 Booking、7 位客户，全部为 `Reserved`；全年 Visits Remaining 已为这 7 位客户逐一找到唯一当前余额记录，8 次 reservation 全部可以映射到具体 Pricing Option。
2. 全年 Visits Remaining 有 63 条余额记录：43 条在 2026-09-21 前已到期，只存档；20 条在当天尚未到期或因未来课程待激活。20 条原始合计为 170 unused、161 unbooked、9 reserved。
3. 9 次原始 reserved 中有 1 次属于已经发生的私教 `Absent`。按 Skyra No-show 政策改为 consumed 后，2026-09-21 的迁移基线为 161 available、8 future reserved、合计 169 unused。
4. 另有 2 条 Intro Pass 在 2026-09-21 当天到期，共 6 available。若 cutoff 在当日结束后，基线变为 18 条余额记录、155 available、8 reserved、合计 163 unused；正式数值必须在 cutoff 时重算。
5. 当前应用没有 Mindbody 批量 importer，也没有 Mindbody 外部 ID、迁移批次和 opening balance 的幂等约束。
6. 当前新 Pass 从 Shopify `purchasedAt` 开始计算，并且只存 `validityDays`；这与“从首次报名课程的上课日期开始、按自然月计算”的规则不一致。
7. Attendance 文件是 19 行按上课时间汇总的分析报表，不是逐客户 Attendance、Cancelled、Late Cancel 或 No-show 明细，只能归档，不能重建完整个人历史。

这批文件现在可支持第一阶段迁移 dry-run：Shopify 客户、当前有效 Pass 余额和现有未来预约。历史 Attendance 与 Sales 只做只读存档；正式写入仍以 cutoff delta 和人工签收的异常表为准。

## 已检查文件

| 文件 | 只读检查结果 | 迁移用途 |
| --- | --- | --- |
| `Mailing_List.xls` | 实际为 HTML table；287 个唯一客户 ID；286 行有邮箱、281 个唯一邮箱；重复邮箱涉及 9 行（比唯一数多 5 行），1 行缺邮箱 | 生成 Shopify Customer 导入文件和 `Mindbody Client ID → Shopify Customer GID` 映射 |
| `Visits Remaining Report 1-01-2026 - 31-12-2026.xlsx` | 63 条余额记录、63 位客户；43 条在 2026-09-21 前已到期，20 条尚未到期或未来激活；原始 170 unused / 161 unbooked / 9 reserved | 当前 Pass opening balance 权威来源；按 cutoff 过滤并应用异常调整 |
| `Visits Remaining Report 1-06-2026 - 21-09-2026.xlsx` | 只有 16 条，漏掉当前和未来激活 Pass | 已删除，不再作为来源 |
| `ScheduleAtAGlance Report 1-06-2026 - 30-09-2026.xlsx` | 430 条总记录；8 条未来 `Reserved`、7 位客户、3 个课程、3 位 Coach；实际末日为 2026-09-27 | 当前未来 Session/Booking 的权威来源；cutoff 前仍执行最终 delta |
| `ScheduleAtAGlance Report 1-06-2026 - 1-01-2027.xlsx` | 旧快照有 10 条未来 `Reserved`，其中 2 条后来已取消/移除 | 已删除，不再作为来源 |
| `Sales Report 1-01-2026 - 31-12-2026.xlsx` | 142 行、117 个客户、140 个 Sale ID、12 个 Item name，实际日期为 2026-05-04 至 2026-09-21 | 当前 Sales 审计来源；不写入正式 Booking 订单/收款表 |
| `Sales Report 1-06-2026 - 21-09-2026.xlsx` | 141 行，缺少一笔较早 Sale，已被全年报表完整覆盖 | 已删除，不再作为来源 |
| `AttendanceAnalysis Report 1-06-2026 - 21-09-2026.xlsx` | 19 行，只有按 Service Time 汇总的 visits、clients、sessions 和 average | 经营分析存档；不能还原个人 Attendance/Cancelled/No-show |
| `Skyra_Mindbody_Course_Catalog_2026-09-21.xlsx` | 3 个业务分类、20 个 Service/Class 记录、17 个 Pricing Options；主要 Multiple sessions Pass 的次数/有效期和默认 Burwood Location 已补，课程时长、容量、eligible services 和其他项目规则可继续编辑 | Mindbody → Skyra Service/Pass 人工映射工作簿 |

最新 Schedule 文件名覆盖到 2026-09-30，实际最新记录为 2026-09-27，与经营者确认的最后一次未来预约一致。该文件已排除旧快照中两条取消/移除记录，可作为当前 8 条未来 Booking 的来源；cutoff 前如 Mindbody 继续发生变化，仍须做最终 delta。

## 关联与一致性检查

- Schedule、Visits Remaining 和 Sales 中出现的 Client ID 都能在 Mailing List 找到；客户主档关联仍可用。
- 旧 Schedule 有 10 条未来记录；最新 Schedule 已确认只剩 8 条，应排除旧表中已消失的 2 条。
- 最新 Schedule 的 8 条未来 Booking 已全部通过 Client ID 关联到全年 Visits Remaining 中的唯一当前余额记录；7 位客户的 reserved 合计恰好为 8。
- Schedule 本身只有 1 条 Membership 非空；最终 Pricing Option 映射来自全年 Visits Remaining 的 `Next Scheduled Visit`、`Visits Remaining - Unbooked` 与人工 Client Visits 证据。
- 全年 Visits Remaining 证明旧 16 条快照不完整。新的 20 条当前/未来余额记录中，6 条为 `10 Aerial Classes`；43 条已过期记录只进入历史存档。
- 一条旧快照中的额外 reserved 已关联到 2026-09-20 的 `Absent` 私教 Visit。按 No-show 消费规则，迁移 opening balance 为 7 available、0 reserved、3 consumed，并保留 2026-12-23 到期日；不创建未来 Booking。
- 该私教权益实际是 10-session legacy Pass，虽然旧 Pricing Option 名称含 `Single Pass`。迁移时建立不可售的 legacy 10-session private Pass 映射，不能错误映射成 1-credit 单次 Pass。
- 新截图还显示该客户存在 A$100 account debit。它属于财务异常/存档，不写入 Pass ledger；是否迁移为 Shopify 欠款不在本批范围。
- 全年 Visits Remaining 覆盖 62 条 `Aerial Movement` 和 1 条 `MV Filming Project`，当前/未来余额中为 19 条 Aerial、1 条 MV；没有 Dance 当前余额记录。MV 项目剩余 4 credits 必须保留为受限 legacy entitlement，不能映射到普通课程。
- 最新 Schedule 与经营者确认一致：2026-09-27 是当前最后一次未来预约。cutoff 前如数据变化，仍需再次执行最终 delta。

## 当前 Pass 余额基线（2026-09-21）

以下数字来自全年 Visits Remaining，并已把过去私教 Absent 的 1 次 stale reserved 调整为 consumed。这里的“记录”是报表余额行，不一定等于独立购买次数；Mindbody 会把相同 Pricing Option 的多笔购买合并。

| Pricing Option | 余额记录 | Adjusted available | Future reserved | 处理 |
| --- | ---: | ---: | ---: | --- |
| `10 Aerial Classes` | 6 | 42 | 4 | 按实际 expiry 迁移 |
| `SKYRA Aerial Signature 30 classes` | 2 | 51 | 1 | 按实际 expiry 迁移 |
| `5 Aerial Access` | 2 | 7 | 1 | 按实际 expiry 迁移 |
| `Bring you Buddy intro offer` | 2 | 2 | 2 | 按实际 expiry 迁移 |
| `Aerial Yoga intro` | 2 | 6 | 0 | 两条均在 2026-09-21 到期；cutoff 后排除 |
| `Drop In Yoga 1 class` | 2 | 2 | 0 | 保留为未使用单次权益 |
| `1:1 Private Aerial Yoga Single Pass` | 2 | 11 | 0 | 实际分别为 legacy 10-session 与 5-session 私教包，不能按 Single Pass 导入 |
| `SKYRA Lifestyle` | 1 个合并源记录 / 3 个月度权益 | 36 | 0 | 已确认三笔 $299 = 连续三个月，每月 12 次 |
| `Skyra K-Pop MV Project` | 1 | 4 | 0 | 保留为受限 legacy 项目权益 |
| **合计** | **20** | **161** | **8** | **169 unused；cutoff 晚于 9 月 21 日时为 18 条 / 155 available / 8 reserved** |

8 条 future reserved 已全部映射：`10 Aerial Classes` 4 次、`Bring you Buddy intro offer` 2 次、`5 Aerial Access` 1 次、`SKYRA Aerial Signature 30 classes` 1 次。

## 在 Mindbody 查看和导出当前 Pass

单个客户核对：

1. 进入 `Clients → Lookup Client`，搜索客户。
2. 打开 `Account Details → Summary`。
3. 在 `Available for Use` 查看 `Pricing Option`、`Scheduled`、`Remaining`、`Activation date` 和 `Expiration Date`。
4. 再打开 `Visits`，把日期范围覆盖到未来最后一节课；未来 `Reserved` 记录的 `Pricing Option` 是该 Booking 实际使用的 Pass。
5. `Schedule` 只证明客户仍有未来预约，不一定显示支付来源；最终以 `Visits → Pricing Option` 和 `Account Details` 交叉核对。

全体客户导出：

1. 进入 `Reports → Clients → Visits Remaining`。
2. 选择 `Show All Dates`；如必须使用日期范围，结束日至少设为 `2027-03-27`。
3. 选择 `All Service Categories` 和全部 Location，不只选择 Aerial Movement。
4. 如有合并/汇总选项，保持每个客户的每个 Pricing Option 独立成行，以保留 Activation、Expiration、Scheduled 和 Remaining。
5. 导出 XLSX，保存在仓库外的私密迁移目录。

旧报表截止于 2026-09-21 且只有 16 条，已经删除。全年报表包含 2027 年到期以及 9 月 26、27 日未来激活的 Pass；正式导入仍要在 cutoff 后重新跑 delta，因为当天到期、取消、新预约或新购买会改变 opening balance。

## 已确认的 Pass 规则（2026-09-21）

`Multiple sessions` / `Multiple Classes` 在新系统统一建模为 Pass。有效期不从购买或付款时间开始，而是从客户**首次成功报名课程所对应的上课日期**开始；后续实现需以 Australia/Sydney 的课程日期计算自然月，不能简单近似为固定 30 天。

| 旧 Pricing Option | 新系统类型 | 次数 | 有效期 | 激活点 / 适用范围 |
| --- | --- | ---: | --- | --- |
| `5 Aerial Access` | Aerial Pass | 5 | 2 个自然月 | 首次报名的 Aerial 课程日期 |
| `10 Aerial Classes` | Aerial Pass | 10 | 6 个自然月 | 首次报名的 Aerial 课程日期 |
| `SKYRA Aerial Signature 30 classes` | Aerial Pass | 30 | 10 个自然月 | 首次报名的 Aerial 课程日期 |
| `SKYRA Lifestyle` | Aerial 月卡 | 12 | 1 个自然月 | 普通 Aerial 课程；次数以后允许 Admin 编辑 |
| `10 Dance Class Access` | Dance Pass | 10 | 3 个自然月 | 首次报名的 Dance 课程日期 |
| `20 Dance Classes Access` | Dance Pass | 20 | 6 个自然月 | 首次报名的 Dance 课程日期 |
| `Monthly Access` | Dance 月卡 | 4 | 1 个自然月 | Dance Classes；次数以后允许 Admin 编辑 |
| `Aerial Intro offer 2 person x3 pass (Sep Edition)` | Aerial Intro Pass | 3 | 21 天 | 截图为 first visit 起算；新旧客户均可购买一次 |
| `Bring you Buddy intro offer (2 people x3 classes)` | Aerial Intro Pass | 3 | 21 天 | 截图为 first visit 起算；新旧客户均可购买一次 |

`SKYRA Lifestyle` 的标准目录规则是 12-credit / 1-month Pass，不自动续费。全年 Sales 在同一 Sale ID 下出现三条 $299，经营者已确认它们代表连续三个月预付，而不是重复销售。迁移时拆成三个 start-inclusive / end-exclusive 的 12-credit 月度权益：2026-09-17–10-17、2026-10-17–11-17、2026-11-17–12-17；不能建成一个月内可用 36 次的单一权益。若未来需要自动续费会员，应单独设计 Shopify subscription、续费失败和暂停规则。

迁移旧余额时保留 Mindbody 当前页面/最终导出的实际到期日，不根据上述标准时长重新计算，以免改变现有客户权益。人工证据再次确认激活日等于首次报名课程日期：购买日在先、Activation date 与首节未来课程日期一致。对新购买 Pass，首次 Booking 的课程日期、激活和 RESERVE 必须在同一事务中确定；相同 Booking/订单重试不能重复激活或移动到期日。

## 已确认的 Location、课程类型与迁移优先级

- 当前只有一个 Location：`1202, 180-186 Burwood Road, Burwood NSW 2134`。本批未来 Session 统一使用该 Location。
- 当前普通团课 Pass 可预约所属类别的普通团课；同一批课程也允许客户使用对应的单次 Drop-in 购买。
- 1:1 课程属于 Appointment / 私教课，不使用普通团课 Pass。
- 后续 Aerial、Dance 和 Appointment 三种课程都需要各自的 Pass；本次迁移只保留 Mindbody 已存在的客户、未来 Booking 和未完成 Pass 权益，不把当前目录当成最终产品配置。
- `duration` 与 `capacity` 必须保留为 Admin 可编辑字段。最新 8 条 Booking 的 Start/End 均为 55 分钟；迁移时按 Schedule 的实际 Start/End 建 Session，临时 capacity 至少等于该 Session 已有 Booking 数，并保持公开预约关闭，待 Admin 修改后再发布。
- 迁移优先级依次为：客户 Client ID 映射 → 本周/未来 Schedule 与 Booking → Pass remaining/unbooked/reserved/expiration → 可后续编辑的课程与 Pass 目录。

## 正式模型要求

当前 Skyra Booking 模型要求：

- `CustomerProfile` 必须先有正式店 Shopify Customer GID。
- `Service` 必须有 kind、duration、capacity、Location、价格和状态；Appointment 容量必须为 1。
- `PassPlan` 必须有 credits、有效期数值/单位、激活规则、价格、状态和 eligible services，且不能跨 CLASS/APPOINTMENT/COURSE 类型。
- `ClassSession` 必须有 Service、Coach、Location、开始/结束时间、容量、时区和状态。
- `Entitlement` 必须绑定正式店的 ProductMapping，并保留不可重复的来源标识。
- Pass Booking 必须有与 Booking 关联的 `RESERVE` ledger entry；取消、No-show、Attended 和改期依赖该记录。只导入 Booking、不导入 reservation ledger 会破坏课次结算。

### 当前代码与新规则的差异

- `PassPlan` 当前只有 `validityDays`，不能准确表示 2、3、6、10 个自然月；需要增加有效期数值/单位，或采用等价且可审计的月历计算策略。
- `paid-booking.server.ts` 当前把 `Entitlement.startsAt` 设为 `purchasedAt`，到期日也是从购买时间加天数；需要改为首次 Booking 对应的 Session 日期，并调整 entitlement eligibility/reservation 检查。
- `Entitlement` 当前强制要求 Shopify Order/Line Item 和 ProductMapping；Mindbody opening balance 需要正式的 `sourceSystem=MIND_BODY`、稳定 external key 和唯一约束，不能伪造 Shopify GID。
- 首次激活必须锁定 Entitlement，并以稳定的 Booking key 幂等写入。并发两次首次预约只能有一个激活基准；取消或重试不能静默移动 startsAt/expiresAt。

开发店的 Shop、ProductMapping、Product/Variant GID、客户、Pass、Booking 和测试订单不得复制到正式店。正式店安装后产生独立 Shop 记录，所有导入都必须显式锁定正式店 domain 和 shop ID。

## 还需要补齐的最小资料

上线导入前完成以下项目：

1. 为已确认的三个月 `SKYRA Lifestyle` 建立三个连续、每月 12-credit 的 opening-balance entitlement；不得合并成单月 36-credit。
2. cutoff 时重新导出或执行 delta，排除已到期余额；特别检查 2026-09-21 到期的两条 Intro Pass。
3. 为 private legacy 10-session、private legacy 5-session 和 MV Filming Project 建立不可售、受限的迁移映射，不能套用当前 Single Pass 或普通 Aerial Pass。
4. 把全年余额表中的每个旧 Pricing Option 映射到具体 PassPlan；8 条未来 Booking 已有候选映射，但 importer 仍须逐条校验唯一 Entitlement。
5. 如需逐客户历史审计，另导出含 Client ID、课程日期和 Attendance/Cancelled/No-show 状态的明细报表。该项不阻塞未来预约和余额迁移。

Location 已确认；duration 和 capacity 作为可编辑目录字段，不再阻塞数据保全迁移。导入产生的 Session 在 Admin 完成校对前保持不公开。

## 迁移顺序

### 1. 建立正式店目录

1. 在正式店 Booking Admin 创建唯一 Location `1202, 180-186 Burwood Road, Burwood NSW 2134` 和现有 Coach。
2. 根据映射表创建 Service，确认 CLASS、APPOINTMENT、COURSE 类型。
3. 创建 PassPlan，填写 credits、有效期数值/单位、首次课程激活规则和 eligible services。
4. 让 Worker 在正式店创建对应 Shopify Product/Variant 和 ProductMapping。
5. 回读 ProductMapping，确认全部目标记录为 `SYNCED`，不使用开发店 Product GID。

### 2. 导入 Shopify 客户

1. 从 Mailing List 生成 Shopify Customer CSV，只保留迁移所需字段。
2. 用 Client ID 作为迁移映射键，不使用姓名作为唯一键。
3. 邮箱统一 trim 和小写比较；重复邮箱涉及的 9 行必须人工决定合并到哪个 Client ID。
4. 缺邮箱客户不能自动获得 Customer Account；保留在异常清单，由 Admin 补邮箱或决定不迁移。
5. 导入 Shopify 后，在 Skyra Booking → People 执行 `Sync Shopify clients`，取得正式店 Shopify Customer GID。
6. 生成对账表：Mindbody Client ID、Shopify Customer GID、导入状态和异常原因。对账表包含个人信息，仍放在仓库外。

### 3. Dry-run Pass 余额

1. 将旧 Pricing Option 映射到正式 PassPlan；未知、停用或命名错误项目进入人工清单。
2. 每条余额记录计算：
   - available = `Unbooked` 或当前 Account Details 的 Remaining
   - reserved = Scheduled/未来 Reserved Visits
   - consumed = 原始 credits - available - reserved（若原始 credits 可确定）
3. 全年报表的 63 条中，43 条已过期，只存档；2026-09-21 基线为 20 条当前/未来余额记录。
4. 原始 170 unused / 161 unbooked / 9 reserved 经私教 Absent 调整后为 161 available / 8 future reserved / 169 unused。
5. 若 cutoff 晚于 2026-09-21，两条当日到期 Intro Pass 不再导入，参考基线变为 18 条、155 available、8 reserved、163 unused；实际以 cutoff delta 为准。
6. 对过去的 Absent/No-show credit 先按 Skyra 政策结算为 consumed；不能迁移成未来 reserved。
7. 迁移旧余额直接保留每条记录的实际 expiration date，不根据标准 Pass 时长重算；被报表合并的 legacy 产品按私密对账表中的修正值处理。

### 4. Dry-run Future Session 与 Booking

1. 按 Service + Sydney 本地日期时间 + Coach + Location 建立 Session dedupe key。
2. 只迁移最终导出时仍为 Reserved/Confirmed 的未来预约；旧 Schedule 中已从当前 Client Schedule 消失的记录不迁移。
3. 以 Mindbody Client ID 关联正式 CustomerProfile。
4. 最新 Schedule 确认 8 条未来 Booking；每条完成 Pass 来源核对后，在同一事务创建 Booking 和唯一 RESERVE ledger。
5. 每条 Booking 必须能关联最终余额表中的具体 Pricing Option/Entitlement；不允许 importer 静默猜测。
6. Dry-run 目标为 8 条未来 Booking、3 个课程、7 位客户；cutoff 前如有新增或取消，以最终 delta 更新目标。
7. Location 使用唯一 Burwood 地址；Session 保持不公开，直到 duration/capacity 校对完成。

### 5. 正式导入

Importer 必须先实现并通过专用测试库验证，要求：

- 默认 `--dry-run`，没有显式 production shop 参数时禁止写入。
- 明确拒绝 `skyra-booking-dev.myshopify.com` 的源/目标混用。
- 增加 migration batch 与 source mapping：Mindbody Client ID、Pass/余额记录、Session 和 Booking 都要有 `sourceSystem + externalKey` 唯一约束。
- 使用 Mindbody Client ID、Sale ID、日期时间和 Pricing Option 生成稳定外部键；重跑不得重复创建 Customer、Entitlement、Session、Booking 或 ledger。
- opening balance 的 GRANT、迁移 Booking 的 RESERVE 和首次激活分别使用稳定幂等键；同一输入重跑必须返回原记录，字段冲突必须报 `IDEMPOTENCY_CONFLICT`。
- Pass 的首次课程日期只允许原子写入一次；并发或 Worker/Webhook 重试不得把有效期向后移动。
- 一个批次在事务内写入；失败时回滚该批次并输出无 PII 的计数和错误代码。
- 原始文件只读，不能覆盖或改名。
- 写 AuditLog，记录 migration batch、目标 shop、记录数量、执行者和时间。
- 导入时禁止发送确认邮件和 12 小时提醒；完成对账并由经营者确认后，再只对未来适用预约启用后续提醒。

当前仓库还没有满足以上条件的 importer，因此本文不授权直接运行 SQL 或 Prisma seed 写正式数据库。

## 切换日执行

1. 关闭 Skyra 正式交易开关，保留 Mindbody 为现行入口。
2. 对正式 PostgreSQL 做备份并记录恢复点。
3. 在 Mindbody 停止新增/修改预约，记录 cutoff time（Australia/Sydney）。
4. 重新导出 Mailing List、Visits Remaining 和 cutoff 之后的未来 Reservations，执行最终 delta dry-run。
5. 导入并对账：客户、Pass remaining/available/reserved、Session、Booking。
6. 经营者逐条确认异常清单；不确定记录不导入。
7. 完成 Customer、Coach、支付、邮件和取消/No-show UAT。
8. 最后发布正式主题入口并开启 Booking 开关。

## 验收与回滚

导入后必须同时满足：

- Shopify 客户导入数、唯一邮箱数、缺邮箱数和重复处理数与批准的对账表一致。
- 正式 Booking DB 的 Pass 行数和 available/reserved/consumed 合计必须等于 cutoff delta 与人工签收结果；2026-09-21 参考值为 20 条余额记录、161 available、8 reserved，若 cutoff 晚于当日则先排除两条到期 Intro Pass。
- 未来 Booking 数量、每节 Session 人数、Coach、时间和 Location 与最终 Mindbody 导出一致。
- 每个 Pass Booking 只有一条未结算 RESERVE；Drop-in 没有错误扣减 Pass。
- Customer Account 显示的余额、未来预约和到期日抽查通过。
- 开关开启前完成数据库备份、恢复步骤和人工对账负责人安排。

需要回滚时，先关闭 `onlineBookingsEnabled` 和交易能力，不删除 Entitlement/Booking/ledger。恢复旧 Mindbody 入口，保存迁移批次与审计证据，再根据备份和批次边界恢复。不可用手工删除 ledger 的方式回滚。

## 个人信息处理

- 原始 `.xlsx` / `.xls`、转换 CSV、客户映射表和异常表不得加入 Git。
- 不在 issue、CI 日志、Render 日志或文档中输出姓名、邮箱、电话、生日、地址或完整 Client ID。
- 只在本地受控目录处理，迁移结束后保留经营审计需要的加密副本并清理临时转换文件。
- Sales 和 Attendance 原始导出仅作为只读存档，不写入正式 Booking 交易模型。
