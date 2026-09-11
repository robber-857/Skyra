# Skyra Booking System

这是当前唯一有效的 Booking System 文档入口。以下文件共同组成已经批准的 V3 开发基线；历史 Mindbody 页面和仓库中的静态排课内容只作为视觉参考，不再作为产品流程或数据来源。

- Shopify：Customer Account、Product/Variant、Cart、Checkout、Order、Payment、Discount、Refund。
- Booking App：Service、Schedule、Session、Capacity、Booking、Waitlist、Pass entitlement、Coach Portal、Admin workflow。
- PostgreSQL：预约、排期、次数权益和运营状态的唯一可信来源。

## 当前开发进度

已创建并绑定 **Skyra Booking** App；工程和第一轮 Admin Catalog/Schedule 代码位于 [booking-app](../../booking-app/README.md)。实际验证、待确认规则和未完成项见 [开发状态](./development-status.md)。2026-09-10 已完成 Class Booking 基础：服务器 Attempt、真实容量、15 分钟 Hold、幂等/过期和防超售数据库锁。尚未完成 Pass/Review、权益账本、付款与确认闭环，也未部署正式主题。

## 推荐阅读顺序

1. [系统架构与 Shopify 实现边界](./architecture.md)
2. [Booking、Pass、Checkout 与同步流程](./booking-pass-flow.md)
3. [三端低保真交互原型](./wireframes.html)（Customer Booking 可在同一区块切换步骤）
4. [数据库模型与 ERD](./data-model.md)
5. [MVP 开发任务与顺序](./implementation-backlog.md)

## 各文档职责

| 文件 | 用途 |
| --- | --- |
| `architecture.md` | 系统边界、三端页面、Shopify 能力、部署架构和数据归属 |
| `booking-pass-flow.md` | 登录、选择 Pass、Checkout、付款回调、扣次、通知与数据同步 |
| `wireframes.html` | Customer、Admin、Coach 三端可点击低保真原型；Home 与 Programs 复用同一个 Booking section 状态机；Admin 保持六个日常入口 |
| `data-model.md` | 核心表、关系、约束、状态和数据所有权 |
| `implementation-backlog.md` | 当前唯一执行计划：MVP/P1/P2 范围、开发顺序、文件迁移和验收任务 |

## 核心实现原则

1. 客户只使用 Shopify Customer Account，不创建第二套客户密码。
2. Admin 使用 Shopify Embedded App；Coach 使用独立、受限的 Portal。
3. Pass 在 Shopify 中是可购买商品，在 Booking DB 中是可消费权益。
4. 已有 Pass 预约不进入 Checkout；购买新 Pass 才进入 Shopify Checkout。
5. 付款后通过幂等 Webhook 创建权益并确认 Booking。
6. 课程容量、Seat Hold 和 Pass 扣次必须在 PostgreSQL 事务中处理。
7. Shopify 与 Booking DB 之间使用 Webhook、Outbox 和定期 reconciliation 同步。
8. Admin 保存 Class/Pass 后由 Worker 用 `productSet` 同步稳定的 Shopify Product/Variant；Weekly Session 只存在 Booking DB，不按课次创建商品。
9. 老师留言属于 Booking DB，并区分 `CUSTOMER_VISIBLE` 与 `INTERNAL`；只有前者显示在 Shopify Customer Account。
10. Home 与 Programs 不复制两套 Booking 代码：两个主题占位节点由同一个 Theme App Extension app embed 挂载。
11. 浏览、课程详情、Pass 选择、已有 Pass 确认和结果状态都在当前 Booking section 内切换；登录和付款分别使用 Shopify Customer Account 与 Shopify Checkout，完成后返回原 section 并恢复 Booking attempt。
12. Book 必须即时验证 Shopify Customer Account 登录；未登录弹出 Skyra 登录提示，桌面打开 Shopify 登录窗口，手机/受限浏览器同页登录，返回原课程并重新验证。当前已接服务端 opaque Attempt、不可换绑的 Shopify 客户身份和固定返回路径；真实开发店客户登录联调尚未完成。
13. 本轮 Find a Class、Select a pass 和交易摘要参考图只定义 Home / Programs 的下单 UI；Customer Account 的 My Bookings / My Passes 是独立后续范围。

## 已清理的旧假设

- 不再使用“Home 只有三条静态 Preview、Programs 的 Book 按钮跳 Mindbody”的方案。
- 不再设计独立的 Class Details、Select a Pass、Cart 或 Confirm Payment 页面；它们是同一区块内的状态，支付表单只属于 Shopify Checkout。
- 不为每周的每一场 Session 创建 Shopify Product。Class/Pass 定义可同步 Product/Variant，实际排课只进入 Booking DB。
- `shopify-theme/sections/skyra-home.liquid` 和 `shopify-theme/sections/skyra-programs.liquid` 已替换为共享挂载节点；根目录静态 HTML 原型不作为后端实现依据。


## 当前测试入口（2026-09-11）

参见 [开发预览与测试指南](preview-testing.md)：Home/Booking Admin 入口、当前可测试范围、启动命令及 Shopify 商品和支付分工。先体验当前阶段，再继续未完成交易功能。

当前交付包含共享 Programs 样式、Full Calendar、新 Pass 选择和 Review；支付及已有 Pass 确认未开放。详见 [开发状态](development-status.md)。
