# Skyra 课程与 Pass 适用范围（2026-09-22）

本文件根据 Mindbody 课程与 Pricing 截图整理，用于正式店建档和 Mindbody 迁移映射。截图只用于识别现有品类，不作为客户余额来源；客户剩余额度仍以迁移核对工作簿为准。

## 强制业务规则

1. 普通 Aerial Pass 只能用于普通 Aerial 课程。
2. Dance Pass 只能用于普通 Dance 课程。
3. 普通 Aerial Pass 和 Dance Pass 都不能用于私教课程。
4. `1:1`、`2:1`、`Private` 和 `Private Group` 课程必须使用对应私教 Pass。
5. Workshop、特殊主题课程和 Invitation Based Membership 默认不接受普通 Pass，必须在后台明确配置适用范围后才能开放预约。
6. No-show 不退还已扣 credit；已参加或已使用的 Drop-in 不退款。
7. 多次 Pass 从客户第一次预约的实际课程日期激活，不从购买日期激活。

## 课程分类

### 普通 Aerial 课程

| Mindbody 课程名称 | 新系统建议名称 | 排课 | 允许 Pass |
|---|---|---:|---|
| Aerial Flow Basic+ ( Beginner+Level) | Aerial Flow Basic+ (Beginner+ Level) | 6 | Aerial Regular |
| Aerial Flow x Stretching x Inversions (Open Level) | Aerial Flow × Stretching × Inversions (Open Level) | 4 | Aerial Regular |
| Aerial Pilates | Aerial Pilates | 5 | Aerial Regular |
| Aerial Tone & Stretch | Aerial Tone & Stretch | 7 | Aerial Regular |
| Beginner Aerial Yoga | Beginner Aerial Yoga | 5 | Aerial Regular |
| Cardio Aerial Yoga | Cardio Aerial Yoga | 0 | Aerial Regular |

### Aerial 私教课程

| Mindbody 课程名称 | 新系统建议名称 | 排课 | 允许 Pass |
|---|---|---:|---|
| 1:1 Private Aerial Yoga Training | 1:1 Private Aerial Yoga Training | 1 | Aerial Private 1:1 |
| Aerial Yoga Private Goup Class | Aerial Yoga Private Group Class | 0 | Aerial Private Group |

正式店建档时应把 `Goup` 修正为 `Group`。

### 特殊 Aerial 课程

| 课程名称 | 排课 | 默认处理 |
|---|---:|---|
| SKYRA Workshop | 0 | Special/Workshop；不自动接受普通 Aerial Pass |

### 普通 Dance 课程

| 课程名称 | 排课 | 允许 Pass |
|---|---:|---|
| Boy Group Cover | 1 | Dance Regular |
| Chinese Fusion Dance | 0 | Dance Regular |
| Dance Conditioning (Fitness) | 0 | Dance Regular |
| Girl Group Cover | 0 | Dance Regular |
| Heels | 0 | Dance Regular |
| Hip-Hop Choreo (Beginner Friendly) | 0 | Dance Regular |
| Jazz Beginner | 0 | Dance Regular |
| Jazz Choreo | 0 | Dance Regular |
| K-Pop Beginner | 0 | Dance Regular |
| K-Pop Performance | 0 | Dance Regular |

## Pass 分类

### 普通 Aerial Pass

| Mindbody Pricing 名称 | 价格 | Credits | 有效期/激活规则 | 可用于 |
|---|---:|---:|---|---|
| ClassPass | A$49 | 1 | 单次；截图未显示 Sold Online | Aerial Regular |
| Drop In Yoga 1 class | A$49 | 1 | 单次 | Aerial Regular |
| Aerial stretching & relaxation for MEN | A$69 | 1 | 单次主题课 | 指定 Aerial Service |
| 5 Aerial Access | A$220 | 5 | 第一次预约起 2 个日历月 | Aerial Regular |
| 10 Aerial Classes | A$420 | 10 | 第一次预约起 6 个日历月 | Aerial Regular |
| SKYRA Aerial Signature 30 classes | A$1,080 | 30 | 第一次预约起 10 个日历月 | Aerial Regular |
| SKYRA Lifestyle | A$299 | 12/月 | 每个订阅月 12 次；迁移中的 3 笔为连续 3 个独立月份 | Aerial Regular |
| Aerial Intro offer 2 person x3 pass (Sep Edition) | A$220 | 3 | 第一次预约起 21 天；Intro Offer | Aerial Regular；2 人方案 |
| Bring you Buddy intro offer ( 2 people x3 classes) | A$220 | 3 | 第一次预约起 21 天；Intro Offer | Aerial Regular；2 人方案 |

### Aerial 私教 Pass

| Mindbody Pricing 名称 | 价格 | Credits | 可用于 |
|---|---:|---:|---|
| 1:1 Private Aerial Intro offer | A$120 | 1 | Aerial Private 1:1；Intro Offer |
| 1:1 Private Aerial Yoga Single Pass | A$140 | 1 | Aerial Private 1:1 |
| 2:1 Private Aerial Yoga Single Pass | A$170 | 1 | Aerial Private 2:1 |

迁移数据中存在历史私教 5 次或 10 次余额。它们应作为 `legacy private entitlement` 导入，适用范围仍必须限定为私教课程，不能映射到普通 Aerial Pass。

### Dance Pass

| Mindbody Pricing 名称 | 价格 | Credits | 有效期/激活规则 | 可用于 |
|---|---:|---:|---|---|
| Drop In Class (1) | A$39 | 1 | 单次 | Dance Regular |
| 10 Dance Class Access | A$360 | 10 | 第一次预约起 3 个日历月 | Dance Regular |
| 20 Dance Classes Access | A$680 | 20 | 第一次预约起 6 个日历月 | Dance Regular |
| Monthly Access | A$149 | 4/月 | 每个订阅月 4 次 | Dance Regular |

### 暂不自动映射

| 类别 | 处理方式 |
|---|---|
| Invitation Based Membership | 保留为独立、仅邀请类型；确认权益后再建立 Pass |
| SKYRA Workshop | 建立专用 Workshop Pass，或由 Admin 明确允许某个 Pass |
| MV Filming Project | 建立限定 Service 的专用 entitlement，不接受普通 Aerial/Dance Pass |

## 新系统适用范围代码

预约权限不应依靠课程名称字符串判断。Service 和 Pass 应保存明确 scope：

| Scope code | 含义 |
|---|---|
| `AERIAL_REGULAR` | 普通空中课程 |
| `DANCE_REGULAR` | 普通舞蹈课程 |
| `AERIAL_PRIVATE_1_1` | 1:1 空中私教 |
| `AERIAL_PRIVATE_2_1` | 2:1 空中私教 |
| `AERIAL_PRIVATE_GROUP` | 私教小组课 |
| `WORKSHOP` | Workshop/特殊活动 |
| `MV_PROJECT` | MV Filming Project 限定服务 |
| `INVITATION_ONLY` | 邀请制会员/课程 |

一个 Pass 可以保存一个或多个允许的 scope；预约时必须验证 Service scope 在 Pass 的允许范围内。迁移 Pass 没有可信映射时进入人工核对，不得默认授予全部课程权限。

## 待正式建档时确认

1. `Aerial stretching & relaxation for MEN` 是独立主题课，还是允许预约全部 Aerial Regular。
2. `Aerial Yoga Private Group Class` 使用人数、价格及专用 Pass。
3. `SKYRA Workshop` 的价格、人数和是否允许普通 Pass 补差价预约。
4. Invitation Based Membership 的实际权益。
5. Intro Offer 是否仍允许现有客户购买；Mindbody 历史设置可能允许新老客户。
