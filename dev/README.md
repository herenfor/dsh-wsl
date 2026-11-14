# 开发用测试环境

没有 Windows 也能端到端测试：用 Linux 上的一个 `dsh web` 冒充 Windows 版 Desktop，用一个假的 `wsl.exe`（`fakewsl/wsl`）把"WSL"指到本机的另一个家目录。Desktop 端插件从本仓库复制到测试 HOME 中的 `wsl-bridge-fixture`，仅这个私有副本允许 Linux 平台模拟；发布包始终只允许 Windows。改了代码重新运行启动脚本即可更新副本。

所有测试都在这里做，**不要碰真实的 Desktop 和真实的 WSL 端**（真实的 `~/.dsh`、`~/.dsh-wsl`、正在运行的真实 daemon）。

## 两个目录

| 目录（默认） | 环境变量 | 是什么 |
|---|---|---|
| `~/dshwsl-desk` | `DSH_WSL_DEV_DESK_HOME` | 测试 Desktop 的 HOME。`.dsh/` 是它的 DSH_HOME（profile `web` 里 link 了私有测试副本）；`.dsh-wsl/` 是插件眼里的"Windows 端"目录（`config.json`、`setup-probe.log`、`bridge.log`）；`desktop.log`、`routing-debug.log` 是日志；`projects/website` 是 Windows 端的演示文件夹 |
| `~/dshwsl-fh` | `DSH_WSL_DEV_FAKE_HOME` | 假 WSL 发行版的家目录。WSL 端的 daemon、`~/.dsh`（profile `web` 和 `desktop-wsl`）、`~/.dsh-wsl/bridge` 都在这里 |

其他设置见 `env.sh`（端口默认 47102，`DSH_WSL_DEV_PORT`）。

## 常用操作

```bash
dev/start-test-desktop.sh                 # 启动（先停掉旧的），打印页面 token
dev/stop-test-desktop.sh
DEEPSEEK_API_KEY=sk-demo-not-a-real-key dev/start-test-desktop.sh   # 不弹登录框，模型名正常显示
```

打开 `http://127.0.0.1:47102/?token=<token>`。

- **运行方式**：`~/dshwsl-desk/.dsh-wsl/config.json`。写 `{"mode":"reuse"}` 是复用假 WSL 里的 dsh（跟随它的 `web` profile），`{"mode":"private"}` 是插件专用一份；删掉这个文件，切到 WSL 时会弹首次设置窗口。改完要重启测试 Desktop。
- **直接调 WSL 端**：`HOME=~/dshwsl-fh node dev/bridge-call.mjs '[["session/list", {"_request": {}}]]'`。它照着正在运行的 daemon 记下的身份（`run/desktop-wsl/daemon.json` 里的 STAMP、`--follow` 等）加入，不会顶掉它；也不会在真实 HOME 下运行。自己写脚本用 `dev/wsl-host.mjs` 的 `connectWslHost()`。
- **跨两边兼容扫描**：`dev/scan/run.sh`（只读：`run.sh read`），结果在 `~/dshwsl-desk/scan/`；说明见 [docs/cross-host-scan.md](../docs/cross-host-scan.md)，报告在 `dev/scan/report-*.md`。
- **截图**：`node dev/shot.mjs <url> <输出目录> <steps.json>`（Chromium 无头浏览器，环境变量 `DARK=1`、`LOCALE`、`PRELOAD`、`FIRST_WAIT`）。`PRELOAD=dev/preload-wsl.js` 会把插件的 ctx 挂到 `window.__wslctx`，可以 `__wslctx.locale.setLocale('en')` 切语言。
- **README 截图**：`dev/screenshots/make.sh`（见下）。

## 日志

| 文件 | 内容 |
|---|---|
| `~/dshwsl-desk/desktop.log` | 测试 Desktop 的 Host 输出 |
| `~/dshwsl-desk/routing-debug.log` | 按会话分流的调试日志（`DSH_WSL_DEBUG`） |
| `~/dshwsl-desk/.dsh-wsl/setup-probe.log`、`bridge.log` | 探测 WSL 的完整输出；WSL 端来不及写日志就失败时的报错 |
| `~/dshwsl-fh/.dsh-wsl/run/desktop-wsl/daemon.log` | WSL 端 daemon（启动、跟随同步、退出） |

## 假 WSL 里现在有什么

- dsh：用的是本机全局装的 `dsh`（`~/.local/bin/dsh`）。另有一份用 pnpm 装在 `~/dshwsl-fh/.local/share/dsh-cli` 的，专门测"dsh 装在项目文件夹里"的情况（设置窗口里填它的位置）。
- profile `web`（"你自己的 dsh"）：dsh-runtime-tuning（link 到所有者本机的仓库，打开了 `tuned` 预设，扫描要用它当"只在 WSL 才有的预设"）、dsh-pet。复用模式下 `desktop-wsl` 跟着它走。
- profile `desktop-wsl`：dsh-wsl-agent，加上只在 Desktop 中的 ds-bot、dsh-claude-style（停用）。
- `~/dshwsl-fh/.dsh/dsh-pet/main-config.jsonc`：把桌宠设成只在页面里显示。**不设的话 dsh-pet 会在 WSL 里下载 Electron，用 WSLg 在屏幕上开一个真窗口。**
- 演示数据：`~/projects/inventory-api`，两个任务；DS Bot 的主 Bot「Chief」。

## 从零搭起来

1. 装好全局 `dsh`（0.2.x，Node ≥ 24.9）。截图还要 Playwright 的 chromium headless shell（`npx playwright install chromium-headless-shell`）。
2. `echo '{"mode":"reuse"}' > ~/dshwsl-desk/.dsh-wsl/config.json`（目录不存在先建），再 `dev/start-test-desktop.sh`。第一次会在 `~/dshwsl-desk/.dsh` 建 profile 并 link 私有测试副本；打开页面后 WSL 端会在 `~/dshwsl-fh` 里建 `desktop-wsl` 并拷 bridge 文件。
3. 给假 WSL 的 `web` 装插件：`HOME=~/dshwsl-fh dsh plugin --profile web add dsh-pet`，然后写上面那份 dsh-pet 配置（`{"trayEnabled": false, "pets": [{… "display": "web" …}]}`，字段见 dsh-pet 包里的 `assets/config.jsonc`）。
4. Windows 端演示数据：`node dev/demo-data.mjs <token>`。
5. WSL 端演示数据：
   ```bash
   mkdir -p ~/dshwsl-fh/projects/inventory-api
   HOME=~/dshwsl-fh node dev/bridge-call.mjs '[["workspace/create", {"request": {"path": "'$HOME'/dshwsl-fh/projects/inventory-api"}}], ["session/create", {"request": {"workspaceId": "$0.workspace.workspaceId"}}], ["session/rename", {"request": {"sessionId": "$1.sessionId", "title": "Fix the failing integration tests"}}], ["session/prompt", {"request": {"requestId": "demo-1", "sessionId": "$1.sessionId", "mode": "queue", "content": [{"type": "text", "text": "The integration tests fail on CI. Find out why and fix them."}]}}, 3000]]'
   ```
   （没有真 key，这一轮会失败，但任务不再是空白的，侧栏才会列出它。）

## README 截图

`dev/screenshots/make.sh [main|first|bot]` 依次截 `home`、`picker`、`plugins`、`detail`、`setup`、`bot`（中英文，深色），拷进 `docs/screenshots/`。它会临时改 `config.json` 和假 WSL 里 DS Bot 的数据，结束时还原。

- `steps.mjs`：每组截图的页面脚本，按中英文的可见文字找按钮。
- `mock-llm.mjs`：DS Bot 那张用的本地假模型（Anthropic 消息格式，`DEEPSEEK_BASE_URL` 指过去）。回复是写死的；问题里有"这台机器 / this machine"时，它让 Bot 调用 WSL 里真实的 `bash` 工具，表格引用命令的真实输出。README 里注明了这一点，改脚本时保留这条说明。
- 截图里出现的第三方插件只要是开源许可就可以，README 写明"仅作展示"并署名（作者、链接、许可证）。

## 容易踩的坑

- 测试 Desktop 启动 60 秒之后才加载到的插件版本，会进入"需要重启"模式（`DSH_WSL_HOT_LOAD_SECONDS`）。改了插件代码就重启测试 Desktop，不要指望热加载。
- 测试 Desktop 用的是测试 HOME 中私有副本的 `link:` 安装，路径里没有 `node_modules`。和安装路径有关的问题（比如 0.1.4 的 bridge 文件没拷），要把 npm 包解到一个 `node_modules` 里再测。
- 没有 `DEEPSEEK_API_KEY` 时页面会弹「开始使用」登录框，它的透明遮罩会挡住侧栏点击。
- ds-bot 会记住窗口显示它自己的界面还是 DSH 的界面（localStorage `ds-bot:surface` = `bot` / `agent`），新的浏览器配置默认进 DS Bot。
- `pkill -f <模式>` 会匹配到执行它的那条 shell 命令本身，把自己杀掉；用 `ps … | awk` 精确匹配，或像 `env.sh` 里的 `desk_pids` 那样写。
- `start-test-desktop.sh --real` 会让 WSL 端跑在你真实的家目录，顶掉真实的 daemon。只在所有者同意时用。
