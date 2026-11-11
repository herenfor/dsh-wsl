# 按会话分流：每个任务在 Windows 或 WSL 中运行

状态：已实现；真实 Desktop 上的端到端任务已跑通（2026-11-11）。按用户反馈调整后的界面已同步，等用户在 Desktop 上确认。

## 决定（2026-11-11）

1. **按文件夹判断**：WSL 里的文件夹（在文件夹选择框里选 `\\wsl.localhost\Ubuntu\...`）是 WSL 文件夹，里面的任务全部在 WSL 中运行。
2. **侧栏标注**：WSL 文件夹和在 WSL 运行的任务，标题后面加一个 Linux 小企鹅图标；Windows 的保持原样。
3. **Windows 文件夹也可以在 WSL 中运行**：新建任务页有"运行位置：Windows / WSL"开关。选 WSL 时提示跨文件系统读写较慢，建议把常在 WSL 运行的项目放进 WSL。

## 用户看到的

- 侧栏：
  - 两边的文件夹和任务都正常列出。
  - Windows 文件夹里可以同时有 Windows 任务和 WSL 任务（后者带企鹅）。
  - WSL 文件夹单独一行，带企鹅。
- 新建任务页（参照 Claude Code 的新建对话界面，2026-11-11 按用户反馈调整）：
  - 输入框正下方左侧有一个灰色的环境选择器，显示"Windows ⌄"或"🐧 Ubuntu ⌄"。点开是下拉菜单，可以勾选"Windows：在本机运行"或"Ubuntu：在 WSL 中运行"。
    - 内容从官方插槽 `conversation.hero.options` 挂入，用 React portal 渲染到输入框所在那一列的末尾。
    - 只在新建任务页出现；任务开始后不再显示，侧栏的企鹅已经标出它在哪运行。
  - Windows 文件夹的选择按文件夹记住，保存在 Desktop 端的 `~/.dsh-wsl/run-targets.json`；切换后，当前的空白任务换成另一边新建的空白任务。
  - WSL 文件夹的菜单里，Windows 一项是灰的，注明"这个文件夹在 WSL 中，只能在 WSL 运行"。
  - 选 WSL 且文件夹在 Windows 磁盘上（WSL 路径以 `/mnt/` 开头）时，选择器右边用灰色小字提示读写较慢，建议把项目放进 WSL。
  - WSL 端未连接或版本不同时，Ubuntu 一项不能选。
- 添加文件夹（侧栏和新建任务页两个入口）：先问"Windows 文件夹"还是"WSL 文件夹（Ubuntu）"。
  - 原因：Desktop 用 Electron 的 `showOpenDialog` 打开系统选择框，没有传起始目录，而用户的系统选择框导航栏里看不到 Linux，只能手动输入 `\\wsl.localhost\...`。
  - Windows：照常打开系统选择框。
  - WSL：打开我们自己的目录浏览框。内容由 WSL 端的 `directoryPicker/list` 列出，经 `/wsl-bridge/dirs` 转发；可以逐级浏览、新建文件夹、显示隐藏文件夹。选中后以 `\\wsl.localhost\<发行版>\...` 交给官方流程，再由服务端转给 WSL。
  - 实现：在两个 `directoryFlow` 单项插槽里用 `priority: -1` 注册，盖住原生选择框（插槽规则是数值最小的显示）；选 Windows 时调用原生选择框原来的 `pick`。
- 模式（预设）：
  - 模式列表合并两边。只有 WSL 端有的（例如 dsh-runtime-tuning 的"调优"）显示为"调优 · WSL"。
  - 在 Windows 运行的任务选这种模式时，返回"「调优」模式来自 WSL 中的插件，只能用于在 WSL 中运行的任务。请在输入框下方把运行位置切换到 WSL。"
  - 原因：`agentPresets/list` 不带会话 ID，服务端分不出是哪个任务要的，所以只能合并两边。

- Creator 模式（"创建你的插件"）：
  - 跟着任务走（2026-11-11 用户决定）：在 Windows 运行的任务里创建的插件装在 Windows 的 Desktop，在 WSL 运行的装在 WSL。官方入口用当前文件夹新建任务，分流规则照常生效，不需要另外判断。
  - 在新建任务页切换运行位置时，新的空白任务保留原来的模式和输入框里的文字。如果另一边没有这个模式（只装在一边的插件提供的模式），就用默认模式。
  - 两边的 Creator 是同一份预设，只有平台相关的部分不同：
    - Windows 的 Creator 用 PowerShell 工具，WSL 用 bash。
    - Windows 的 Creator 读技能模板时，模板在 `app.asar` 里，只能用文件读取工具；WSL 里是普通文件。
    - 插件管理工具装插件时，装到它自己所在的 Host。
  - WSL 的 Creator 查页面端接口（`cordis_inspect_query` 的 Client 部分）、请求运行带页面部分的插件时，WSL 端通过 `$events` 发请求，页面再调用 `dynamicCordisRunner/*` 回答。这些回答按会话 ID、请求 ID 和插件运行 ID 转回 WSL。页面上报的接口清单两边各发一份，WSL 端重连后会补发。

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

## 真实 Desktop 上的验证（2026-11-11，0.2.2-rc.1）

- 用户在 Desktop 中添加了 WSL 文件夹 `dsh-test`，发了"这是一个测试，汇报一下运行的位置"。
  - agent 在 WSL 中执行了 `pwd; hostname; whoami; uname -srm`，工作目录为 `/home/s/dsh-test`。
  - 模型调用用的是经凭据代理取到的 Desktop 账号，WSL 端日志有 `[llm-deepseek-account] model listing … loaded 2 model(s)`。
- 用户的反馈与调整：
  - 系统选择框里看不到 Linux → 加了"添加文件夹时先选 Windows 或 WSL"和 WSL 目录浏览框；
  - 右上角橙色框太显眼 → 改为输入框下方的灰色环境选择器；
  - WSL 插件的"调优"模式不在模式列表里 → 合并两边的模式列表。
- 以上调整已在 WSL 内用无头浏览器验证：浏览框能选中 WSL 目录并建好文件夹；环境选择器和输入框左对齐，能来回切换；模式列表里有"调优 · WSL"；Windows 任务选它时出现上面的提示。

## 还没做

- 审批、提问等 Host 发给页面的请求（`$events` 的 `waterfall`）只做了 ID 改写，还没有实际触发过。
- "在应用中打开"（`session/openWorkspacePath`）对 WSL 任务会在 WSL 端执行，应改为在 Desktop 端用 `\\wsl.localhost\...` 路径打开。
- 删除 Windows 文件夹时，它在 WSL 端对应的文件夹没有一起删除。
- WSL 里的 Creator 实际查页面端接口：分流已验证（带 `wsl:` 前缀的回答由 WSL 端接收），完整流程等在 Desktop 上用 Creator 时确认。
