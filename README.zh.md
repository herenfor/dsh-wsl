# dsh-wsl

[English](README.md) | 中文

给 Windows 版 DeepSeek Harness（Desktop）加一个 **WSL 运行模式**：每个任务可以选在 Windows 还是 WSL 里运行。选了 WSL 的任务，agent、命令、文件读写和插件都在 WSL 里的 DSH 中运行，界面仍然是 Desktop 的窗口。Linux 插件装在 WSL 里原样可用，包括改界面的插件，在 Desktop 的插件页单独管理。

只用插件和外部组件实现，不改官方代码。

状态：测试版，npm 包名 `@herenfor/dsh-wsl`。目前只在 DSH 0.2.2-rc.1 上测试过。

## 使用

安装、功能、更新、卸载和已知限制，见插件说明：[experiments/mirror/mirror/README.zh.md](experiments/mirror/mirror/README.zh.md)。

简单说：Desktop → 插件 → 添加插件 → 安装第三方插件，填 `@herenfor/dsh-wsl`，安装后完全重启 Desktop，再在新任务页把运行位置切到 WSL，按提示完成设置。

## 工作方式

```
Windows                                    WSL
Desktop（DSH Host + 页面）                 DSH Host（profile desktop-wsl）
  └ 插件 @herenfor/dsh-wsl                    └ 插件 dsh-wsl-agent
      ├ 按任务分流：WSL 任务的请求转给 WSL       ├ 上报 WSL 的界面模块、路由和插件
      ├ 合并两边的侧栏、界面模块和设置          └ 凭据代理：用的时候向 Desktop 要
      └ 一条 wsl.exe 连接  ◄──────────────►  常驻进程（daemon），Desktop 关闭 5 秒后退出
```

- 传输：`wsl.exe` 的标准输入输出上跑一条多路复用连接，WSL 端是常驻进程，和 Claude Code 桌面版的 WSL 模式同一种思路。
- 会话 ID：WSL 的会话和文件夹在页面上带 `wsl:` 前缀，请求转发时按字段和按值改写。
- 凭据：不复制到 WSL，WSL 端换上凭据代理，用的时候向 Desktop 要。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `experiments/mirror/mirror/` | Desktop 端插件，也就是发布到 npm 的包：分流、合并、设置窗口、WSL 插件页、页面代码 `client.js` |
| `experiments/mirror/agent/` | WSL 端插件 `dsh-wsl-agent`，随 Desktop 端插件一起带进 WSL |
| `experiments/transport/` | `wsl.exe` 连接：多路复用（`mux.mjs`）、Desktop 端（`client.mjs`）、WSL 常驻进程（`daemon.mjs`） |
| `experiments/mirror/tests/` | 单元测试 |
| `scripts/assemble.sh` | 把 transport 和 agent 拷进插件包（发布前运行） |
| `scripts/sync-windows.sh` | 开发用：组装后再拷到 Windows 测试目录 |
| `docs/` | 设计和实验记录（中文） |

## 开发

```bash
node --test experiments/mirror/tests/*.test.mjs
```

发布前先运行 `scripts/assemble.sh`，把 `experiments/transport` 和 `experiments/mirror/agent` 的最新文件拷进插件包的 `transport/` 和 `agent/`，再在 `experiments/mirror/mirror` 里 `npm publish`。（`scripts/sync-windows.sh` 是开发用的：它还会把插件包拷到 Desktop 用 link 安装的 Windows 测试目录。）

## 文档

- [docs/bridge-plan.md](docs/bridge-plan.md)：桥接方案（传输、部署、按会话分流）。
- [docs/session-routing.md](docs/session-routing.md)：按会话分流，每个任务在 Windows 或 WSL 中运行，侧栏列出两边。
- [docs/plugin-management.md](docs/plugin-management.md)：插件管理方式和界面镜像。
- [docs/panel.md](docs/panel.md)：插件页（现在是 Windows 和 WSL 分开的两个标签页）。
- [docs/credentials.md](docs/credentials.md)：WSL 会话怎么使用 Desktop 的凭据。
- [docs/deployment.md](docs/deployment.md)：首次设置、版本规则、插件自动更新、界面语言。

## 许可证

MIT，见 [LICENSE](LICENSE)。`experiments/mirror/mirror/ids.mjs` 中的 ID 字段表改编自 [dsh-ssh-workspaces](https://github.com/czp0312/dsh-ssh-workspace)（MIT），其版权声明随插件包一起分发（`experiments/mirror/mirror/LICENSE`）。
