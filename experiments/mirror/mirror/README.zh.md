# DSH WSL 运行模式

[English](README.md) | 中文

让 Windows 版 DeepSeek Harness（Desktop）在 WSL 里运行任务。选了 WSL 的任务，agent、命令、文件读写和插件都在 WSL 里的 DSH 中运行，界面仍然是 Desktop 的窗口。

> 测试版。目前在 DSH 0.2.2-rc.1 和 0.2.2-rc.2 上测试过。遇到问题欢迎到 [GitHub](https://github.com/herenfor/dsh-wsl/issues) 反馈。

## 能做什么

- **每个任务自己选在哪里运行**：在新任务页的输入框下方选「Windows」或「WSL（发行版名）」。WSL 里的文件夹（`\\wsl.localhost\…`）总是在 WSL 中运行。
- **添加 WSL 文件夹**：添加文件夹时先选 Windows 文件夹或 WSL 文件夹。选 WSL 文件夹会在 Desktop 里直接浏览 Linux 文件系统。
- **两边的任务列在一起**：侧栏同时列出 Windows 和 WSL 的文件夹和任务，WSL 的带小企鹅标记。审批、提问、子智能体、标题实时更新，都和普通任务一样。
- **WSL 里的插件单独管理**：插件页多一个「WSL（发行版名）」标签页，可以安装、启用、停用、卸载 WSL 里的插件，点进去能看说明和每个组件的运行状态。官方的「已安装」页仍然只管 Windows，两边互不影响。只装在 WSL 里的插件，包括改界面的插件，也能在 Desktop 窗口里使用。
- **用 Desktop 的模型凭据**：WSL 里的任务调用模型时，向 Desktop 取凭据，API Key 和登录信息不会写进 WSL 的磁盘。在 WSL 里自己填过 API Key 的，用 WSL 自己的。
- **设置以 Desktop 为准**：模型、主题、语言等 Desktop 上能调的设置，单向同步到 WSL；只有 WSL 里的插件才有的设置，留在 WSL。
- **跟着 Desktop 启停**：打开 Desktop 时自动启动 WSL 端，关闭 Desktop 约 5 秒后 WSL 端退出。
- **界面语言跟随 DSH**：目前有中文和英文，其他语言显示英文。

## 需要什么

- Windows 10 或 11 上的 DSH Desktop 0.2.x。
- WSL 2 和一个 Linux 发行版。Ubuntu、Debian 等都可以，用你装的那个。
- WSL 里一份 DSH，版本号前两段要和 Desktop 相同（例如都是 0.2.x）。没有的话，插件会列出安装命令，可以一键安装，也可以交给 Windows 端的 DSH 去装，见下面第 3 步。

## 安装

1. Desktop → 插件 → 添加插件 → 安装第三方插件，填 `@herenfor/dsh-wsl`，然后安装。
2. 完全退出 Desktop（如果它还在系统托盘里运行，也要在托盘里退出），等 5 秒以上再打开。不重启的话插件不会开始工作，侧栏底部会提示「重启 Desktop 后生效」。
3. 在新任务页，把输入框下方的运行位置切到 WSL。第一次会弹出「设置 WSL 运行环境」，选一种方式：
   - **复用你装的 dsh**：WSL 里已经装了 dsh 时可以选。Desktop 和你在 WSL 里自己用的 dsh 共用数据，任务互相看得到；更新时两边一起更新。插件会在 PATH（包括登录 shell 的 PATH）、`~/.local/bin`、`/usr/local/bin`、`/usr/bin`，以及 nvm、fnm、pnpm、bun、`~/.npm-global` 的全局目录里找 `dsh`。装在别处的（比如装在某个项目文件夹里，或者由你自己的脚本启动），在设置窗口里填它的位置：命令、`@deepseek-ai/dsh` 包文件夹，或包里的 `lib/bin.js`。
   - **插件专用一份**：装在 `~/.dsh-wsl/dsh`，数据放在 `~/.dsh-wsl/home`，不影响你自己的 dsh。要下载约 250 MB，装好后约占 900 MB。

   缺 Node.js 或 DSH 时，窗口里会列出要运行的命令，「查过的位置」里列出检查过哪些地方。Node.js 的版本要满足你那份 DSH 的要求（DSH 0.2 要 24.9 或更新）；用 nvm、fnm、asdf、mise、Volta 装的 Node 也能找到，用 nvm 的话也可以自己 `nvm install 24`，再点「重新检查」。你可以点「自动安装」，点「交给 DSH 安装」让 Windows 端的 DSH 去执行，或者自己在 WSL 终端里运行。插件不会自己在后台下载。
4. 连上之后，侧栏底部的加载提示会消失，WSL 的文件夹和任务出现在侧栏里。

### 其他安装方式

第 1 步的安装框也接受下面两种写法，但这样装的不能在插件页里更新：

- 从 GitHub 安装：`github:herenfor/dsh-wsl#path:/experiments/mirror/mirror`。指定版本时写成 `github:herenfor/dsh-wsl#v0.1.0&path:/experiments/mirror/mirror`。
- 从本地文件夹安装：把仓库下载到 Windows 上，填 `experiments/mirror/mirror` 文件夹的完整路径。

## 在 WSL 里装插件

插件 →「WSL（发行版名）」→ 在安装框里填 npm 包名、git 地址或本地文件夹路径 → 检查 → 安装。Windows 路径会自动换成 WSL 路径。提示需要重启的，完全退出 Desktop，等 5 秒以上再打开。

## 更新

- 插件本身：不会在后台自动更新，以免打断正在 WSL 里运行的任务。到「插件 → 已安装 → WSL 运行模式」里检查和更新，最好选在 WSL 里没有任务运行的时候；更新后完全退出并重新打开 Desktop，在那之前侧栏会提示重启。设置窗口底部会显示当前版本。
- WSL 里的 DSH：版本跟着 Desktop。Desktop 升级后，设置窗口会提示更新 WSL 端。复用的 dsh 如果不是 npm 全局安装的（装在项目文件夹里，或用 pnpm 装的），插件不替你更新，以免在旁边装出第二份，请用你自己的方式更新。

## 卸载

1. Desktop → 插件 → 已安装 → 卸载「WSL 运行模式」，然后重启 Desktop。
2. WSL 里留下的文件需要手动删除：
   - `~/.dsh-wsl`：连接文件、日志，以及插件专用模式下的 DSH 和数据。
   - 复用模式下还有 `~/.dsh/profiles/desktop-wsl`，这是插件建的 profile。任务数据在 `~/.dsh` 里，和你自己的 dsh 共用，**不要删整个 `~/.dsh`**。

## 出问题时

- 侧栏底部显示「启动失败」时，点它可以看到错误信息。
- 找不到你的 dsh 或 Node.js 时，设置窗口会列出查过的位置。最近一次检查的完整输出在 Windows 上的 `%USERPROFILE%\.dsh-wsl\setup-probe.log`。
- 选了复用、之后那份 dsh 找不到了（被移走或删除），WSL 端不会启动，设置窗口会请你填它的新位置；插件不会自己改用插件专用的一份。
- WSL 端日志在 `~/.dsh-wsl/run/desktop-wsl/daemon.log`。WSL 端还没来得及写这个日志就失败时，报错在 Windows 上的 `%USERPROFILE%\.dsh-wsl\bridge.log`。
- 反馈：<https://github.com/herenfor/dsh-wsl/issues>

## 已知限制

- 只在 DSH 0.2.2-rc.1 和 0.2.2-rc.2 上测试过。Desktop 和 WSL 里的 DSH，版本号前两段必须相同。
- 插件专用模式下，WSL 的任务和你自己的 dsh 不互通，目前也不能在两种方式之间搬任务。
- 复用你的 dsh 时，插件直接用 Node 运行那份 DSH 包，数据在 `~/.dsh`；不经过你自己的启动脚本或包装器，那里设置的环境变量、端口、`DSH_HOME` 都不会生效。
- WSL 里的插件如果用补丁改了官方组件的配置（而不是关掉它），这个改动在 Desktop 窗口里不生效。
- WSL 里插件的界面加载在整个 Desktop 窗口里，不只出现在 WSL 任务中。
- 关闭 Desktop 后 WSL 端也会退出，WSL 任务不会在后台继续运行。

## 许可证

MIT。会话 ID 字段表改编自 [dsh-ssh-workspaces](https://github.com/czp0312/dsh-ssh-workspace)（MIT），版权声明见 `LICENSE`。
