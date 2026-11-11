# 凭据：WSL 会话怎么用 Desktop 的 API Key 和账号登录

状态：已决定采用做法 3（凭据代理），放在桥接阶段实现（需要 WSL → Desktop 方向的请求通道）。2026-11-11。

## 要求

- WSL 会话默认使用 Desktop 的 API Key 或账号登录。
- 保留用户在 WSL 单独填写 API Key 的功能；单独填了的，就用 WSL 自己的。

## 成熟产品的做法

| 产品 | 做法 | 密钥在 WSL 落盘吗 |
|---|---|---|
| Git Credential Manager（微软官方 WSL 教程推荐） | WSL 里的 git 把 `credential.helper` 指向 Windows 的 `git-credential-manager.exe`，每次需要凭据时调用 Windows 侧取回 | 不落盘 |
| VS Code Remote - WSL | 文档建议同上，与 Windows 的凭据管理器共享 git 凭据 | 不落盘 |
| 1Password SSH（官方 WSL 集成） | WSL 把 SSH 请求转给 Windows 上的 1Password，私钥不离开 1Password，WSL 只拿到签名；授权只对当前 WSL 会话有效 | 不落盘，私钥也不进 WSL 内存 |
| Docker Desktop | WSL 里的 docker 通过 `credsStore: desktop` 调用 Windows 的 `docker-credential-desktop.exe` 取凭据 | 不落盘 |
| Claude Code 桌面端的 WSL 模式（本机观察） | WSL 里 `~/.claude` 没有任何凭据文件，只有桌面端与 WSL 常驻进程之间的连接令牌 `daemon.token`；环境变量 `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` 表明登录由桌面端持有并负责刷新 | 不落盘 |
| GitHub CLI（`gh`） | WSL 里单独登录，自己存一份（`~/.config/gh/hosts.yml`） | 落盘（各自一份，不是复制） |

结论：成熟做法几乎都是**凭据留在 Windows，WSL 用的时候向 Windows 要**（凭据代理），没有一个是把 Windows 的密钥复制一份到 WSL 磁盘。需要在 WSL 落盘时，做法是让用户在 WSL 里单独登录（gh），而不是复制。

## DSH 自身的结构（0.2.2-rc.1）

- 设置里只存密钥的**引用名**（例如 `apiKeyEnv: DEEPSEEK_API_KEY`），真正的值由 `ctx.credentials` 服务（抽象类 `CredentialProvider`）提供。
- 使用方**每次操作时才解析一次**，所以凭据变了，下一次操作就会生效，不需要重启插件。
- 官方实现是 `credentials-local`（`LocalCredentialProvider`）：
  - API Key 等引用通过 `resolve(ref)` 解析，来源依次是自己的存储（`~/.dsh/.credentials.yaml`）、环境变量等；
  - 账号登录等记录通过 `readRecord(key)` 和 `modifyRecord(key, …)` 读写，刷新令牌时会写回。

所以 DSH 已经留好了"换一个凭据提供者"的位置，凭据代理在结构上可行。

## 可选做法

| 做法 | 说明 | 优点 | 缺点 |
|---|---|---|---|
| 1. 复制到 WSL 磁盘 | 把 Desktop 的 Key 和登录记录写进 WSL 的 `~/.dsh/.credentials.yaml`（权限 600） | 最简单，Desktop 关掉后 WSL 也能用 | 密钥存在两处；Desktop 改了要再复制；WSL 里同用户的任何程序都能读；账号令牌刷新后两边会不一致 |
| 2. 启动时注入内存 | 启动 WSL Host 时把 Key 放进环境变量 `DEEPSEEK_API_KEY` | 不落盘，DSH 原生支持 | 只适用于 API Key，账号登录不行；agent 在 WSL 里跑的命令可能继承这个环境变量，用 `env` 就能看到 |
| 3. 凭据代理（推荐） | WSL 的 DSH 换上我们的凭据提供者：先看用户在 WSL 自己填的；没有时通过桥接向 Desktop 要，账号令牌的刷新也交给 Desktop | 与 GCM、1Password、Claude Code 相同的思路；不落盘；Desktop 改了立即生效；账号令牌只有 Desktop 一份 | 要替换 WSL 一侧的官方 `credentials` 服务（依赖其接口）；需要 WSL → Desktop 方向的请求通道（正式的单通道传输天然支持）；Desktop 关闭时 WSL 会话无法调用模型 |
| 4. 模型请求经 Desktop 转发 | WSL 的模型请求发给 Desktop，由 Desktop 加上凭据再发出 | 密钥连 WSL 内存都不进 | 要处理流式响应、官方请求头和计费标识，工作量最大，最容易随版本失效 |

推荐 **3**。密钥在 WSL 一侧只在单次请求期间存在于 DSH 进程内存中，不落盘，也不进 agent 运行命令的环境。

## 来源

- [Get started using Git on WSL（Microsoft Learn）](https://learn.microsoft.com/windows/wsl/tutorials/wsl-git)
- [Developing in WSL（VS Code 文档）](https://code.visualstudio.com/docs/remote/wsl)
- [1Password SSH：WSL 集成](https://www.1password.dev/ssh/integrations/wsl)
- [docker-credential-desktop.exe 在 WSL2 中（Docker 论坛）](https://forums.docker.com/t/docker-credential-desktop-exe-executable-file-not-found-in-path-using-wsl2/100225)
