# 按会话分流：每个任务在 Windows 或 WSL 中运行

状态：已实现，在 WSL 内两个 DSH 之间验证通过。真实 Desktop 上的端到端验证要等凭据代理完成：没有凭据，WSL 里的任务无法调用模型。2026-11-11。

## 决定（2026-11-11）

1. **按文件夹判断**：WSL 里的文件夹（在文件夹选择框里选 `\\wsl.localhost\Ubuntu\...`）是 WSL 文件夹，里面的任务全部在 WSL 中运行。
2. **侧栏标注**：WSL 文件夹和在 WSL 运行的任务，标题后面加一个 Linux 小企鹅图标；Windows 的保持原样。
3. **Windows 文件夹也可以在 WSL 中运行**：新建任务页有"运行位置：Windows / WSL"开关。选 WSL 时提示跨文件系统读写较慢，建议把常在 WSL 运行的项目放进 WSL。

## 用户看到的

- 侧栏：
  - 两边的文件夹和任务都正常列出。
  - Windows 文件夹里可以同时有 Windows 任务和 WSL 任务（后者带企鹅）。
  - WSL 文件夹单独一行，带企鹅。
- 新建任务页（官方插槽 `conversation.hero.options`）：
  - Windows 文件夹显示"运行位置：Windows"，点击切换到"运行位置：WSL（Ubuntu）"。切换后，当前的空白任务换成另一边新建的空白任务。
  - 这个选择按文件夹记住，之后在该文件夹新建任务都用它，直到切回。保存在 Desktop 端的 `~/.dsh-wsl/run-targets.json`。
  - 选 WSL 且文件夹在 Windows 磁盘上（WSL 路径以 `/mnt/` 开头）时，下面用橙色字提示读写会明显变慢，建议把项目放到 WSL 内，例如 `~/code`。
  - WSL 文件夹显示"在 WSL（Ubuntu）中运行"，不能切换。
- WSL 端未连接或版本不同时，开关不能切到 WSL；已在 WSL 中的文件夹和任务继续显示上次看到的内容。

## 实现

全部在 Desktop 端 Host 的 Node 进程里完成（mirror 插件），页面代码不变，因此官方页面的所有调用天然走同一套分流。分流思路和 ID 字段表参考 dsh-ssh-workspaces（MIT，已在 `ids.mjs` 注明出处）。不同的是，它在浏览器端接管调用、远端流经 HTTP 轮询中转；我们在服务端分流，远端流直接走桥接上的 WebSocket。

| 部分 | 文件 | 做法 |
|---|---|---|
| ID | `ids.mjs` | WSL 端的会话、工作区、事件等 ID 在页面上加 `wsl:` 前缀；调用参数里只含 WSL ID 的发往 WSL，混用两边 ID 的直接报错 |
| 单次调用 | `routing.mjs` 的 `call` | 通过 client-connection 的 `connection/request` 钩子：`session/list`、`session/search` 两边合并；`session/create` 按运行位置放置；`workspace/create` 遇到 `\\wsl.localhost\...` 发往 WSL；`$events/result` 按事件 ID 分流；文件上传按 `sessionId` 分流；其余按 ID 分流 |
| 流 | `routing.mjs` 包装网关的 `openWireStream` | `workspace/follow`、`session/control`、`$events` 合并两边；其余带 WSL ID 的流（`session/follow`、终端、任务等）整条转给 WSL |
| WSL 端的流 | `remote-mux.mjs` | 经桥接向 WSL Host 的 `/api/remote.mux` 发起 WebSocket 升级。WebSocket 客户端自己实现（只有文本帧和心跳），不依赖 Desktop 安装目录里的 `ws` 包 |
| 合并 | `sessions.mjs` | Windows 文件夹在 WSL 端有对应的文件夹（`D:\code\proj` ↔ `/mnt/d/code/proj`），侧栏只显示 Windows 那一行，把对应文件夹的任务并进来。WSL 文件夹的路径显示为 `\\wsl.localhost\<发行版>\...` |
| 页面 | `client.js` | 侧栏企鹅用 CSS 属性选择器（`data-row-key` 以 `workspace:wsl:` / `session:wsl:` 开头）；运行位置开关在 `conversation.hero.options` |

细节：

- 在 Windows 文件夹里新建 WSL 任务时，如果 WSL 端还没有对应的文件夹，会先在 WSL 端创建（`workspace/create /mnt/d/...`），再在其中创建任务。
- 页面复用空白任务时，可能把另一边的空白任务交给 `session/create`；服务端按运行位置决定，不是这一边的就不复用。
- 侧栏的第一帧最多等 WSL 端 1.5 秒，避免侧栏先只显示 Windows 的内容、随后再补上 WSL 的。会话控制流只能有一个初始快照，最多等 WSL 端 3 秒；WSL 端重连后会结束这条流，由页面重新订阅。

## 验证（WSL 内，A 扮演 Desktop，B 为 `desktop-wsl`，0.2.2-rc.1）

| 检查 | 结果 |
|---|---|
| 新建 WSL 文件夹 `\\wsl.localhost\Ubuntu\home\s\wsltest-proj` | 建在 B，页面看到的 ID 为 `wsl:…`，路径保持 UNC 形式 |
| 在 WSL 文件夹新建任务 | 建在 B；`session/state`、`session/follow`（快照帧）经 A 正常返回 |
| Windows 文件夹，运行位置 WSL | 自动在 B 建对应文件夹，任务建在 B；切回 Windows 后新任务建在 A |
| 侧栏工作区流 | Windows 文件夹一行同时含 A 和 B 的任务；WSL 文件夹单独一行 |
| `session/list` / `session/control` | 含两边的会话（control 快照 5 个，其中 4 个来自 B） |
| `$events` | A 的 ready 帧先到，B 的事件加前缀后转发 |
| `workspace/delete wsl:…` | 删除的是 B 上的文件夹 |
| 页面（无头浏览器） | WSL 文件夹和 WSL 任务后面有企鹅；点击"运行位置：Windows"后变为"运行位置：WSL（Ubuntu）"，当前任务换成 B 上新建的空白任务 |

单元测试：`node --test tests/sessions.test.mjs`（7 个）。

## 还没做

- 在 WSL 任务里实际发消息：B 没有凭据，要等凭据代理（`credentials.md` 做法 3）。
- 审批、提问等 Host 发给页面的请求（`$events` 的 `waterfall`）只做了 ID 改写，还没有实际触发过。
- "在应用中打开"（`session/openWorkspacePath`）对 WSL 任务会在 WSL 端执行，应改为在 Desktop 端用 `\\wsl.localhost\...` 路径打开。
- 删除 Windows 文件夹时，它在 WSL 端对应的文件夹没有一起删除。
- Creator 模式（"让 agent 创建插件"）的会话放在哪边。
