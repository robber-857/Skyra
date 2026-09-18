# People 教练分页与邮箱激活（2026-09-18）

Coaches 服务端每页 8 条，按 name / id 升序稳定排序，按店铺隔离。Previous / Next、当前页 / 总页数、Go 或 Enter 跳转；coachPage 保存到 URL，保留 shop / host 等上下文，刷新、返回、表单提交后保持当前页。无效页回第一页，越界页取最后一页，空列表不显示分页。Admin 账号审批中的 Existing coach record 仍列出同店全部 ACTIVE 教练，不能被列表分页截断；只加载其 id / name。

原 Not activated 实际判断 loginVerifiedAt 是否存在，与 Coach.status 的 ACTIVE 排课状态分开。现在显示 Not authorized（无 loginEmail）、Awaiting email verification（已授权但未验证）、Verified（已验证）。

激活顺序：Admin 在 People 输入真实登录邮箱，点击 Authorize login email；Coach 在 /coach/login 输入相同邮箱，申请邮件链接，打开邮件链接完成验证登录，exchangeCoachLogin 自动写入 loginVerifiedAt。右侧 Booking-notification email 只接收预约更新，不授权登录，也不会完成验证。Admin 不手动设置 loginVerifiedAt；开发测试链接也不证明邮箱所有权。修改／清空已授权邮箱仍撤销旧访问。

线上公开 /coach/login 当前显示 Email activation is not connected yet，说明邮件激活服务未就绪。配置入口是 Render 运行环境，不是 People 的 Active 开关：Coach 邮件能力需 SKYRA_COACH_MAIL_KEY（64 位十六进制密钥）、有效 HTTPS SHOPIFY_APP_URL、SKYRA_COACH_LOGIN_SHOP，以及事务邮件所需 SKYRA_MAIL_ENABLED、SKYRA_MAIL_PROVIDER=resend、RESEND_API_KEY、SKYRA_MAIL_FROM；邮件供应商须有可用发件人，Worker 负责队列发送。本轮不配置凭据、不启用发送、不发送邮件。

本地 npm run check 和专用数据库全量 37 文件 / 383 项通过；新增数据库测试覆盖 17 条教练、8/8/1、同名稳定排序、越界和无效页、空店铺、跨店隔离、角色权限、审批选项完整且排除非 ACTIVE。实际组件 UI fixture 在 1280px / 390px 验证分页、Go / Enter、刷新、返回、保存通知邮箱保留页码、全部审批选项、三种登录状态和激活说明，pageErrors=[]、无横向溢出。fixture 不是 Shopify 已登录后台或真实邮件投递 UAT。无数据库迁移。
