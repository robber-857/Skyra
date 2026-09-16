# Coach 测试登录与 Buffer 说明

更新：2026-09-14。

> 2026-09-16 澄清：本页描述的是开发店测试入口，不是正式 Coach 注册。当前 `Coach` 表没有 email，Admin 只创建 Coach 记录并临时生成测试链接；Coach 不可自助注册。正式方向为 Admin 向已存在 Coach 的已验证邮箱发送邀请，尚未实现。Customer 的 Shopify 登录及主页 newsletter 与 Coach 登录无关。完整边界见 [身份、登录与主页邮箱关系](identity-login-and-email.md)。

## Buffer before / after

- Buffer before 是该老师每节课之前的准备时间，单位为分钟。
- Buffer after 是该老师每节课之后的休息、收尾或交接时间。
- 例：课程 10:00–11:00，前后各 10 分钟，老师的占用时间为 9:50–11:10。客户仍看到 10:00–11:00，课程时长不会增加，也不会因此提前关闭客户预约。
- 排另一节课时，两节课各自的 Buffer 都参与冲突检查。例如同一老师两节课都设前后 10 分钟，第一节 11:00 结束，下一节最早 11:20 开始；这样第一节课后与第二节课前的两段占用不重叠。
- 当前这些字段在创建 Coach 时填写；需要连续无间隔授课可设为 0。People 尚未实现既有 Coach 的编辑表单，不把页面误写成支持修改。Buffer 作用于老师排期冲突，场地仍按实际课程时间检查；不代表独立场地周转规则。

## 如何进入 Coach 后台测试

1. 在已登录店主/Admin 的浏览器打开 [Skyra Booking → People](https://admin.shopify.com/store/skyra-booking-dev/apps/c9d266a38e2f11a1240139974253b3a1)，刷新页面。
2. 找到要测试的老师，例如 Development Coach。点击其旁边 **Create test sign-in link**。
3. 页面提示生成成功后，点击 **Open coach test portal**，新标签页打开该老师登录页。
4. 点击 **Continue to my schedule**，进入 Coach 后台。链接 15 分钟有效且只能用一次，登录会话最长 8 小时；退出或过期后回 People 重新生成。
5. 在 **My schedule** 查看本周 Monday–Sunday 日历、Month 或自定义日期；进入 **View roster** 查看该节课的 Training profile、预约留言，并在课后按需要记录 No-show。Coach 不做 Check-in / Attended。

老师必须先在 Classes & Passes 关联可教授课程，再在 Weekly Schedule 把场次分配给他。没有分配课程或日期范围不包含课程时，Coach 显示空列表；没有客户预约就没有留言或人数。测试本身不会创建客户预约，公开预约/付款开关保持关闭。

这是 Admin 在本地开发环境的受限测试入口，不是正式老师邮箱登录。真实 Coach 邮箱维护、验证、邀请投递和重发仍未接通。不要将 Shopify 顾客 My account 当作 Coach 登录，也不要给老师 Shopify 店主权限。正式上线前需完成受验证的老师邀请流程。

## 实现和验证边界

- 测试入口仅在 NODE_ENV=development、当前店为 skyra-booking-dev.myshopify.com、Actor=ADMIN 时提供；服务端重复校验，不依赖按钮隐藏。测试链接不会在生产环境签发。
- 复用已有 Coach LOGIN→SESSION 单次交换，保留店铺/老师状态校验、审计与过期控制；数据库只存 token hash。链接 credential 放在 fragment，消费前清除，不放查询参数。Admin 响应 private/no-store/no-referrer。
- Coach 登录/退出/到课表单允许配置的精确 SHOPIFY_APP_URL Origin 经本机代理到达，保留其他来源拒绝；没有关闭框架 CSRF 或 Coach 认证。
- 新增 14 项回归覆盖开发环境、Admin、跨店、停用老师、链接单次使用/审计、非法 URL 与代理来源。完整 **26 个文件 / 336 项测试通过**；TypeScript、Customer extension 类型、ESLint、生产构建通过。
- Playwright 390/1440px Coach 登录、月度筛选、名册/留言、签到/完成、空日期、退出通过，pageErrors=[]，无横向溢出。浏览器使用专用测试库，不冒充真实 Shopify 管理员。
- 真实公网 Coach 登录 POST：合法 App Origin + 无效凭据为 401，并显示链接失效文案；外部 Origin 为 400。Admin 本人点击新测试按钮仍需用户验收。
- 证据：output/booking-next/coach-access-all-tests.log、coach-access-check.log、coach-access-browser.log、coach-origin-live.log；截图在 output/playwright/coach-booking。没有真实发信或支付，没有正式店发布。

## Git 交付

此前 Appointment/comments/Today、My account 和 Save draft 修复已以 `698f7c27bd4adb76e32abf56edd47157d2f3bd3c` 推送 bookingdev，本地与远程 SHA 一致，[CI 34812945622](https://github.com/robber-857/Skyra/actions/runs/34812945622) success。本页与 Coach 测试入口作为后续提交交付；GitHub 推送不等于稳定服务器上线。
