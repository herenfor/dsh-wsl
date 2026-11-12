# 给接手的 agent

这个仓库是 dsh-wsl：给 Windows 版 DeepSeek Harness（Desktop）加一个 WSL 运行模式，npm 包 `@herenfor/dsh-wsl`。先读 [README.zh.md](README.zh.md)（工作方式、仓库结构），再读这里。和所有者交流用中文。

## 现在的状态

- npm 上最新是 **0.1.8**。main 上还没发的：DS Bot 截图、`dev/` 测试工具、这份说明，随 0.1.9 一起发。
- 测过 DSH 0.2.2-rc.1 和 rc.2；Desktop 和 WSL 里的 DSH 版本前两段必须一样。
- 每个版本修了什么、为什么，见 [docs/deployment.md](docs/deployment.md) 后半部分（一个 bug 一节）。设计决定见 `docs/` 其他文档。

## 代码入口

| 文件 | 内容 |
|---|---|
| `experiments/mirror/mirror/index.mjs` | Desktop 端插件：启动桥、按会话分流、合并两边的侧栏/界面模块/设置、`/wsl-bridge/*` 路由 |
| `experiments/mirror/mirror/setup.mjs` | 探测 WSL（一次登录 shell：Node、dsh、版本管理器、项目内安装）、首次设置、拷 bridge 文件 |
| `experiments/mirror/mirror/client.js` | 页面代码：运行位置选择、设置窗口、WSL 插件标签页和详情页；界面文字在里面的 DICT（中、英） |
| `experiments/mirror/mirror/merge.mjs` | 两边界面模块图的合并规则（官方组件只允许被 WSL 里的第三方插件替换） |
| `experiments/mirror/agent/` | WSL 端插件 dsh-wsl-agent：上报界面模块和插件归属（`owner`）、凭据代理、`follow.mjs`（复用模式下 `desktop-wsl` 跟随你的 profile） |
| `experiments/transport/` | `wsl.exe` 上的多路复用连接；`daemon.mjs` 是 WSL 端常驻进程 |

`experiments/transport` 和 `experiments/mirror/agent` 是源文件；`scripts/assemble.sh` 把它们拷进插件包（`experiments/mirror/mirror/transport`、`agent`），拷出来的副本也提交。改了源文件要跑 assemble（发布脚本会自动跑）。

## 常用命令

```bash
node --test experiments/mirror/tests/*.test.mjs   # 单元测试，改完必跑
scripts/assemble.sh                               # 把 transport 和 agent 拷进插件包
scripts/release.sh 0.1.9 --dry-run                # 发布预演：测试、组装、检查包内容，不改任何东西
```

端到端测试、截图、日志位置见 [dev/README.md](dev/README.md)：Linux 上的 `dsh web` 冒充 Desktop，假 `wsl.exe` 把 WSL 指到 `~/dshwsl-fh`。

## 规则（所有者定的，必须遵守）

- **官方 DSH 不接受 PR**：一切都用插件和外部组件实现，不改官方代码。
- **发布到 npm 由所有者操作**：agent 把 main 准备好、跑通 `--dry-run`，把 `scripts/release.sh <版本> --local` 交给所有者运行（要 npm 登录和两步验证）。不要自己发布。
- **不做后台自动更新**：插件只能由用户在插件页里更新，以免打断 WSL 里正在跑的任务。
- **凭据只走代理**：WSL 用模型时向 Desktop 要，API Key 和登录信息不写进 WSL 磁盘。
- **不写死发行版名**：发行版名一律来自检测，界面里显示真实名字。
- **不碰所有者的真实环境**：真实 Desktop、真实 WSL 端（`~/.dsh`、`~/.dsh-wsl`、正在运行的 daemon）动之前先问。测试一律用 `dev/` 的测试环境；`dev/bridge-call.mjs` 只在假 HOME 下运行，并读 STAMP 加入现有 daemon。
- **`scripts/sync-windows.sh` 要明确给目标目录**，而且只在所有者同意时用：拷过去会替换掉 link 这个目录的 Desktop 正在运行的插件。所有者机器上有一个旧的 Windows 测试目录（`dsh-wsl-test`），不要往那里拷。
- **宣传截图只在测试环境截**：出现的第三方插件只要是开源许可即可，写明"仅作展示"并署名；模拟出来的部分（比如假模型的回复）要写清楚。
- **复用模式下插件跟着用户自己的 dsh 走，插件专用模式下插件独立**（0.1.7 起）。模型、主题、语言等 Desktop 设置不写进用户的 profile。
- **README 中英文同步改**（仓库根目录和插件包里各两份）；`docs/` 用中文。界面文字中英两套都要加。
- 提交信息用英文，写清楚为什么；`gh` 命令带 `-R herenfor/dsh-wsl`。

## 还没做的

- npm Trusted Publisher：所有者在 npmjs.com 上给 `@herenfor/dsh-wsl` 配好后，推版本标签就能由 GitHub Actions 发布（`.github/workflows/publish.yml`），不用再 `--local`。
- 插件专用模式和复用模式之间搬任务。
- "重启 WSL 端"按钮（装了需要重启的 WSL 插件时，不用重启整个 Desktop）。
- 已知限制见插件说明的「已知限制」一节，比如 WSL 插件用补丁改官方组件配置，在 Desktop 窗口里不生效。
