# DSH WSL 运行模式：桥接方案记录

状态：设计记录，未实现。2026-11-11 整理。插件管理方式先于桥接确定，见 `plugin-management.md`（界面镜像已实验跑通）。

## 目标

在官方 Windows 版 DeepSeek Harness（Desktop）里，让**某个项目或会话**选择 WSL 内的文件夹或"WSL 运行模式"后，agent、会话和插件都在 WSL 内的 DSH Host 里运行。

- 不用浏览器：界面就是 Desktop 的窗口，我们通过插件往里加管理界面。
- Linux 插件原样可用：插件在 WSL 的 Host 里运行，不做逐个接口的适配。
- 本机项目照常在 Windows Host 运行，两种项目在同一个窗口里并存。
- 只用插件和外部组件，不改官方代码（官方目前不接受 PR）。

## 已确定的原则

- **凭据**：不复制 API Key 和账号 token。WSL 端由用户自己配 API Key，或在 WSL Host 里走官方网页登录。请求如实标为 `x-client-platform: web`，这是官方网页版自己的值，服务器支持，且该请求头由 provider 生成、无法覆盖。
- **版本**：以 Desktop 为准，WSL 端自动部署同一个精确版本；升级前后检查插件兼容，失败时可回退。
- **下载源**：支持 npmmirror 等镜像（Node 和 DSH 都要）。
- **失败处理**：WSL 侧出错时明确报错，不静默回退到本机执行；任何问题都不能让 Desktop 打不开。

## 参考实现

### czp0312/dsh-ssh-workspace（npm `dsh-ssh-workspaces`，MIT）

已在 DSH 0.2.2-rc.1 Windows Desktop 上验证"全量模式"：按项目把 agent 放到 WSL / SSH / Docker 内的 DSH。

- 部署：Python 脚本在 WSL 装 DSH 到 `~/.local/share/dsh-ssh-workspaces/dsh-<版本>`，必要时从 nodejs.org 下 Node 24.12；运行 `dsh web --host 127.0.0.1 --port 0`，从日志取端口和令牌。
- 连接：Windows 本地开端口，**每个 TCP 连接起一个 `wsl.exe`**，用 Python 转发原始字节；Windows Host 用令牌换 cookie，调用远端 `/api` 和 `/api/remote.mux`。
- 分流：在客户端替换 `connection.rpc.call/open`；远端 ID 改写成 `dsh-remote:<后端>:<id>`，按 ID 分流；上传、导航也有挂钩。
- 不足：
  - `plugins/`、`pluginManager/`、`pluginMarket/` 等被写死为只走本机，**WSL 项目里无法管理 WSL 插件**；
  - DSH 版本写死为 `0.2.2-rc.1`，不跟随 Desktop；
  - 无镜像源；
  - 远端直接用 `~/.dsh` 的 `web` profile，可能和用户自己跑的 `dsh web` 同时读写同一目录；
  - 流用长轮询 RPC 转发。

### Claude Code 桌面端的 WSL 模式（本机观察）

```
~/.claude/remote/
  srv/<哈希>/server          桌面端部署，哈希标识版本
  ccd-cli/<版本>-<哈希>      agent CLI，版本由桌面端决定
  run/<id>/rpc.sock          常驻进程的 Unix socket（700）
  run/<id>/daemon.token      认证令牌（600）
  run/<id>/children/         每个会话一个子进程
```

- `wsl.exe` 启动 `server --bridge`，在**一条 stdio 上复用所有通信**，另一端连 Unix socket；
- 常驻进程 `server --serve` 和转发分开，断开后可重连；
- WSL 内不开 TCP 端口；
- 界面是自家原生的（解析 stream-json），这一层 DSH 学不了。

## 选定方案

| 层 | 来源 |
|---|---|
| 按项目/会话分流（RPC 替换、ID 改写、流、上传） | 取自 dsh-ssh-workspace，MIT 署名，后续修复手动挑选 |
| 传输：单条 `wsl.exe` stdio 复用、常驻进程、Unix socket + 令牌文件 | 参照 Claude Code，重写 |
| 部署：Desktop 决定版本、按版本目录部署、镜像源 | 参照 Claude Code，重写 |
| 插件管理 | 自己写，核心 |
| Desktop 内的界面（WSL 环境、插件、版本状态） | 自己写，客户端插件 |

形式：新建自己的仓库（不是形式上的 fork），`THIRD_PARTY_NOTICES.md` 保留原 MIT 声明；给原作者开 issue 说明。

## 风险

- DSH 的 `/api`、`remote.mux` 是网页客户端内部接口，不承诺稳定；必须锁定版本，每个版本实测。
- 客户端 RPC 替换依赖 DSH 内部结构（如 0.2.2-rc.1 的 Gateway mux 行为），升级可能失效。
- 插件界面通过镜像 WSL Host 的模块清单进入 Desktop，依赖 `clientModules` 的私有成员（见 `plugin-management.md`）。
