# 首次安装与 WSL 端设置

状态：已实现，在 WSL 内用模拟的 wsl.exe 走过首次安装流程。2026-11-11。

## 决定（2026-11-11）

1. **没装 WSL**：输入框下方的环境选择器照常显示，Ubuntu 一项灰掉。点击它打开设置窗口，里面写清楚怎么安装 WSL。
2. **装了 WSL，但 WSL 端缺东西**：插件不自动下载安装。理由是 DSH 官方可能有破坏性更新，用户的网络环境也各不相同。设置窗口给出要在 WSL 终端运行的命令；也可以一键新建一个在 Windows 运行的任务，命令写在提示词里，交给 Windows 端的 DSH 去装。
3. **WSL 端的 DSH**：默认装一份插件专用的，放在 `~/.dsh-wsl/dsh`，不影响用户自己在 WSL 里装的 dsh。会话和文件夹记录仍放在默认的 `~/.dsh`，和用户自己的 WSL DSH 共用。以后如果要搬会话，守护进程已经留好 `--dsh-home` 参数。

## 用户看到的

- 环境选择器里的 Ubuntu 一项，按 WSL 端的情况显示：
  - 没装 WSL：“这台电脑没有安装 WSL，点击查看”
  - 没有发行版：“WSL 里还没有 Linux 发行版”
  - WSL 1：“这个发行版是 WSL 1，需要 WSL 2”
  - 缺 DSH：“WSL 里还没有装 DSH”
  - 版本不同：“WSL 里的 DSH 版本和 Desktop 不同”
  - 启动失败：“WSL 端启动失败”
  - 启动中：“正在启动 WSL 端…”
- 添加文件夹：没装 WSL 时直接打开系统选择框，和官方一样；装了 WSL 但还没设置好时，“WSL 文件夹”一项打开设置窗口。
- 设置窗口（“设置 WSL 运行环境”）：
  - 没装 WSL：`wsl --install`（管理员 PowerShell），装完重启，设置 Linux 用户名后回来点“重新检查”。
  - 没有发行版：`wsl --install -d Ubuntu`。
  - WSL 1：`wsl --set-version <发行版> 2`。
  - 缺 Node 或 DSH、版本不同：
    - 给出 WSL 终端里要运行的命令，带“复制”按钮。WSL 里没有 Node 24.9 以上时，先装一份 Node 到 `~/.dsh-wsl/node`；DSH 用 `npm install --prefix ~/.dsh-wsl/dsh @deepseek-ai/dsh@<Desktop 的版本>` 安装。
    - 提示：npm 找不到这个版本，说明还没发布，要等发布。
    - “交给 DSH 安装”：在 Windows 文件夹里新建任务，输入框预填提示词，用户检查后发送。提示词要求通过 `wsl.exe -d <发行版> -- bash -lc` 执行命令，不用 sudo，不改动别的东西，装好后核对版本；找不到版本就停下来报告。
  - 启动失败：错误原文和 WSL 里日志的位置。
  - 有多个发行版时可以切换。
  - “重新检查”：重新检测；就绪后立即连接，不用重启 Desktop。

## 实现

| 部分 | 文件 | 做法 |
|---|---|---|
| 检测 | `mirror/setup.mjs` | `wsl.exe --list --verbose`（UTF-16 输出）列出发行版和 WSL 版本；在选定的发行版里用一段 sh 脚本查 home、架构、可用的 Node（`~/.dsh-wsl/node`、`~/.local/bin`、PATH、`/usr/local/bin`、`/usr/bin`）、`~/.dsh-wsl/dsh` 里 DSH 的版本。`evaluate` 是纯函数，给出状态；`commandsFor`、`promptFor` 生成命令和提示词 |
| 连接文件 | `setup.mjs` 的 `installBridgeFiles` | 插件自带 `transport/`（daemon.mjs、mux.mjs）和 `agent/`（WSL 端插件）。就绪时经 `\\wsl.localhost\<发行版>\...` 复制到 `~/.dsh-wsl/bridge/`，按内容戳 `STAMP` 判断要不要复制 |
| 按需连接 | `transport/client.mjs` | `startBridge({ resolve })`：每次连接前先问 `resolve`；返回 null 时不连，等 `retry()`。`restart()` 用于切换发行版 |
| 守护进程 | `transport/daemon.mjs` | 新增 `--dsh`、`--stamp`、`--dsh-home` 参数。启动 DSH 前，如果 `desktop-wsl` 配置不存在，就用 web 模板创建（`dsh desktop-wsl --from-default-profile web --dump-config`）；如果配置里没有 `dsh-wsl-agent`，就加进去（`dsh plugin --profile desktop-wsl add link:~/.dsh-wsl/bridge/agent`），两步都不联网。连接文件、DSH 或 DSH home 变了时，新连接会替换旧的守护进程，旧的 DSH Host 随之停止 |
| 设置接口 | `mirror/index.mjs` | `/wsl-bridge/setup`：GET 返回状态、命令、提示词；POST `{action:'recheck'}` 重新检查并连接，POST `{distro}` 切换发行版并记到 `~/.dsh-wsl/config.json`。`run-target`、`install-target` 也带上状态 |
| 页面 | `mirror/client.js` | `SetupDialog`；环境选择器和“添加文件夹”按状态显示 |

开发用的覆盖：入口配置或 `~/.dsh-wsl/bridge.json` 里写了连接命令时，跳过检测，直接用它（目前开发机就是这样）。`DSH_WSL_COMMAND` 指定另一个 wsl.exe，测试用，同时忽略 bridge.json。

## 验证（WSL 内，模拟的 wsl.exe，临时 home，0.2.2-rc.1）

| 检查 | 结果 |
|---|---|
| 临时 home 里没有 DSH | 状态“缺 DSH”；识别出 WSL 里已有 Node 24.22，只给出 DSH 一条命令 |
| 照设置窗口的命令真的安装 | `npm install --prefix ~/.dsh-wsl/dsh @deepseek-ai/dsh@0.2.2-rc.1` 成功；约 5 分钟，装好后 907 MB，npm 缓存 253 MB |
| 点“重新检查” | 复制连接文件；守护进程用模板建好 `desktop-wsl`、加上 `dsh-wsl-agent`（`link:~/.dsh-wsl/bridge/agent`），启动 DSH，状态变为“已连接”，版本相同 |
| 连接文件更新（插件升级） | 新连接替换旧守护进程：旧的 DSH 先退出，新的启动，只剩一个守护进程 |
| 守护进程起不来（socket 路径超长） | 设置窗口显示“WSL 端启动失败”和错误原文，不再一直显示“正在启动” |
| WSL 里 DSH 版本旧 | 状态“版本不同”，环境菜单显示“WSL 里的 DSH 版本和 Desktop 不同，点击查看”，设置窗口给出更新命令 |
| “交给 DSH 安装” | 设置窗口关闭，在 Windows 文件夹里新建任务，输入框里是安装提示词 |

单元测试：`node --test tests/setup.test.mjs`（5 个），覆盖 `wsl.exe` 的 UTF-16 输出、检测结果、状态、命令和提示词、连接文件复制。

## 还没做

- 插件本身的发布方式（现在从 `C:\Users\S\dsh-wsl-test\mirror` 用 link: 安装）。
- 开发机切换到正式流程：删除 `C:\Users\S\.dsh-wsl\bridge.json` 后，按设置窗口的命令在 `~/.dsh-wsl` 装一份 DSH。这会改动用户的环境，要先问用户。
