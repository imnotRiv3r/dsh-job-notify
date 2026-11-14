# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.3.2] - 2026-11-13

### 新增

- 浏览器通知（`dsh web`）：Host 通过 `GET /api/job-notify/events` 以 SSE 推送任务与轮次事件，浏览器半弹出系统通知。鉴权复用 Host 的信任围栏，未通过校验的请求拿不到流。
- 非安全上下文（`http://192.168.x.x:3080` 这类局域网明文地址）下自动退回页面内提示条：这类地址浏览器恒定 `Notification.permission === 'denied'`，任何代码都弹不出系统通知。
- 配置页新增「浏览器通知」分区，实时显示**当前标签页**的通知状态，未授权时提供「允许通知」按钮（只在用户点击时请求，避免被浏览器判为骚扰）。
- 新增配置项 `notifyWeb`（默认开）、`webFallback`（默认开）。
- 页面可见且**有焦点**时，完成类通知不弹；等待决策类照弹。只看 `visibilityState` 不够——被别的窗口盖住时它仍是 `visible`。
- 新增三组**无需任何权限**的提醒信号，系统通知不可用时一并触发：标签页标题闪烁并显示未读数、Web Audio 合成提示音、Favicon 红点角标。回到标签页时自动复原。
- 非安全上下文（`http://` 局域网地址）下不再只是静默的提示条：标题闪烁和提示音让后台标签页也能被注意到。

### 变更

- 桌面 Toast 与浏览器通知两条通道互相独立：Host 是 Linux 服务器时只有浏览器通道可用，Windows 桌面没开浏览器时只有 Toast 可用。原先在非 Windows 平台整个插件直接退出，现在只关闭 Toast 通道。
- 浏览器通道用 `ctx.inject(['webServer', 'connection'])` 注册路由，webServer 晚于插件激活也能挂上（`ctx.get` 在 apply 阶段取不到它）。
- 新增 `lib/notify-hub.js`（SSE 广播、心跳、客户端上限）与 `buildWebNotification`（把 toast payload 投影成浏览器线格式，含 `tag` 去重）。

### 修复

- Loader 行的 `name` 与包名不一致：`cordis.patch.yml` 里写的是 `@local/dsh-job-notify`，而 `package.json` 已改为 `dsh-job-notify`，导致 Host 侧启动时报 `ERR_MODULE_NOT_FOUND: Cannot find package '@local/dsh-job-notify'`，插件完全无法加载。现改为与包名一致，`link:` 安装与 npm 安装两条路径都恢复可用。
- 浏览器半的 `__ModuleLoader__.load({ id })` 同步改为包名；配置命名空间查找保留 `@local/dsh-job-notify` 作为兼容别名，旧安装不会丢配置。
- README 中「本项目不发布到 npm」与实际已发布 `dsh-job-notify@1.3.1` 不符，安装示例里的 `@local/` 前缀一并更正。

### 文档

- README 重写：默认语言改为英文（`README.md`），中文移至 `README.zh-CN.md`，两版逐节对齐；移除 `README.en.md`，`package.json` 的 `files` 与 `docs/PUBLISHING.md` 的提交示例同步更新。
- 补齐此前未写进文档的行为：退出码优先的成败判定表、文案拼装规则与截断预算（标题 80 / 标签 140 / 细节 90 / 节选 200 字素）、耗时格式、空正文轮次的回退文案、通知队列上限 8 与单条 10 秒超时、`toast failed` 日志的含义。
- 新增：六种通知的形态预览、配置分组表与四组预设、事件接线表、兼容性矩阵、三列故障排查表、卸载步骤、目录链接。

## [1.3.1] - 2026-11-11

### 变更

- 将 `@deepseek-ai/schemastery` 从 `dependencies` 移到 `peerDependencies`，并作为本地开发依赖保留；符合 DSH 插件市场对官方包的依赖约定。
- 安装说明改为 `npm install --no-package-lock`；从市场安装时 peer 由 Harness 提供。

## [1.3.0] - 2026-11-11

### 新增

- agent 通过 `ask_user_question` 等你选择时发送「需要你选择」通知：正文带会话名、第一个问题和问题总数。
- 工具调用等待审批时发送「需要你批准」通知：正文带会话名、工具名和审批原因。
- 配置项 `notifyQuestions`、`notifyApprovals`，两者默认开启，可独立关闭。

### 变更

- 问题通知通过 `user-questions/request` waterfall 以只读观察者接入，始终 `next()` 委托，不回答也不拦截问题。
- 审批通知读取 `approval/asked` 会话事件，不改变审批结果。

## [1.2.0] - 2026-11-11

### 新增

- 配置页新增「启用通知」总开关，此前只能通过配置补丁关闭插件。
- 对话轮次通知显示本轮耗时，`showDuration` 现在同时作用于任务与轮次。
- 轮次因错误结束时，通知正文优先显示错误原因；因输出上限结束时显示明确提示。
- 纯函数与服务层单元测试（`npm test`），覆盖格式化、事件判定与通知队列。

### 修复

- 连续快速点击配置开关时，第二次写入因 revision 过期被 Host 拒绝。现在写入串行化，并在每次写入前读取最新 revision。
- AppUserModelID 未校验，非法值会传到 `ToastNotificationManager` 并静默失败。现在前后端都会校验并回退到 `com.deepseek.dsh`。
- 通知截断按 UTF-16 码元切分，可能把 emoji 切成两半。现在按字素截断。
- 通知队列无上限、PowerShell 无超时，极端情况下会积压或永久阻塞。现在队列上限 8 条、单条 10 秒超时。
- 长任务耗时显示为 `65 分`，现在显示为 `1 小时 5 分`。
- 退出码解析支持负数与 `[exit code: N]` 形式。
- `plainText` 不再破坏 `snake_case` 等普通文本。
- 会话销毁时清理消息与计时缓存。
- 空正文的轮次通知回退为「本轮已完成」/「本轮达到输出上限」，不再显示空白通知。

### 变更

- Host 侧拆分为 `lib/format.js`（纯格式化与判定）与 `lib/toast.js`（PowerShell 发送与队列），`index.js` 只做装配。
- 声明 `dsh.compatibility`（`>=0.2.0-rc.1 <0.3.0-0`）与 Node `>=20`。
- 补充 `.gitignore`、`LICENSE`、`CHANGELOG.md`、GitHub Actions CI。

## [1.1.0]

- 新增整轮对话结束提醒（会话标题 + 最后一条回答节选）。
- 通知正文支持逐项开关：任务标签、耗时、退出码/失败原因。

## [1.0.0]

- 首个版本：后台任务结算时弹出 Windows 原生通知。
- 只提醒无人等待的后台任务；前台命令保持安静。
