# 首次安装与 WSL 端设置

状态：已实现，在 WSL 内用模拟的 wsl.exe 走过首次安装、复用、插件专用、自动安装。2026-11-12。

## 决定（2026-11-11）

1. **没装 WSL**：输入框下方的环境选择器照常显示，Ubuntu 一项灰掉。点击它打开设置窗口，里面写清楚怎么安装 WSL。
2. **装了 WSL，但 WSL 端缺东西**：插件不自动下载安装。理由是 DSH 官方可能有破坏性更新，用户的网络环境也各不相同。设置窗口给出要在 WSL 终端运行的命令；也可以一键新建一个在 Windows 运行的任务，命令写在提示词里，交给 Windows 端的 DSH 去装。
3. **WSL 端的 DSH**：默认装一份插件专用的，放在 `~/.dsh-wsl/dsh`，不影响用户自己在 WSL 里装的 dsh。以后如果要搬会话，守护进程已经留好 `--dsh-home` 参数。

更新（2026-11-12，用户决定）：

4. **WSL 里已有可用的 dsh 时，让用户选**：
   - 复用：用用户自己的 dsh 和它的数据（`~/.dsh`）。Desktop 里的 WSL 任务和用户自己用 dsh 时互相看得到；更新时一起更新用户自己的 dsh。
   - 插件专用：程序和数据都单独一份（`~/.dsh-wsl/dsh`、`~/.dsh-wsl/home`），互相看不到。数据分开，是因为两个不同版本的 DSH 读写同一份数据，新版本可能把它改成旧版本读不了的格式。这一条取代了决定 3 里“会话仍共用 `~/.dsh`”。
   - 设置窗口里写清楚两种方式下会话会不会同步，以后可以改。
5. **“自动安装 / 自动更新”按钮**：用户点了才下载安装，补充决定 2。命令和“交给 DSH 安装”仍然保留。
6. **Desktop 比 WSL 旧时**：不降级 WSL，要求先升级 Desktop。
7. **放宽版本**：前两段版本号相同（如 0.2.x）就能连。最后一段或预发布不同时照常使用，设置窗口提示，并可以一键更新 WSL 到一致的版本。
8. **插件本身自动更新**：发布到 npm，用 DSH 自带的插件更新功能；仓库已公开（2026-11-12）。真正发布前确认包名、账号和许可证。

## 用户看到的

- 环境选择器里的 Ubuntu 一项，按 WSL 端的情况显示：
  - 没装 WSL：“这台电脑没有安装 WSL，点击查看”
  - 没有发行版：“WSL 里还没有 Linux 发行版”
  - WSL 1：“这个发行版是 WSL 1，需要 WSL 2”
  - 有用户自己的 dsh、还没选方式：“还没有选择在 WSL 里怎么运行 DSH”
  - 缺 DSH：“WSL 里还没有装 DSH”
  - WSL 太旧：“WSL 里的 DSH 版本较旧，需要更新”
  - Desktop 太旧：“Desktop 版本较旧，需要先升级 Desktop”
  - 安装中：“正在安装 WSL 端的 DSH…”
  - 启动失败：“WSL 端启动失败”
  - 启动中：“正在启动 WSL 端…”
- 下拉菜单底部始终有“WSL 运行环境设置…”，已连接时也能打开设置窗口（更改运行方式、对齐版本）。
- 添加文件夹：没装 WSL 时直接打开系统选择框，和官方一样；装了 WSL 但还没设置好时，“WSL 文件夹”一项打开设置窗口。
- 设置窗口（“设置 WSL 运行环境”）：
  - 没装 WSL：`wsl --install`（管理员 PowerShell），装完重启，设置 Linux 用户名后回来点“重新检查”。
  - 没有发行版：`wsl --install -d Ubuntu`。
  - WSL 1：`wsl --set-version <发行版> 2`。
  - 选择运行方式：两张卡片“复用你装的 dsh（版本）”“插件专用一份”，各自写明会话是否同步、版本谁来管、要不要下载。
  - 缺 Node 或 DSH、WSL 太旧：
    - 给出 WSL 终端里要运行的命令，带“复制”按钮。WSL 里没有 Node 24.9 以上时，先装一份 Node 到 `~/.dsh-wsl/node`。插件专用：`npm install --prefix ~/.dsh-wsl/dsh @deepseek-ai/dsh@<Desktop 的版本>`；复用：`npm install -g --prefix <用户的前缀> @deepseek-ai/dsh@<Desktop 的版本>`。
    - “自动安装 / 自动更新到 X”：在 WSL 里运行这些命令，先停掉 WSL 端，显示最后几行输出，完成后自动连接。npm 找不到版本、网络失败时给出说明。
    - “交给 DSH 安装”：在 Windows 文件夹里新建任务，输入框预填提示词，用户检查后发送。提示词要求通过 `wsl.exe -d <发行版> -- bash -lc` 执行命令，不用 sudo，不改动别的东西，装好后核对版本；找不到版本就停下来报告。
  - Desktop 太旧：请先升级 Desktop；复用时也可以改用插件专用。
  - 已连接：版本略有不同时说明情况；WSL 较旧时可以“更新 WSL 到 X”。下方显示运行方式和“更改”。
  - 启动失败：错误原文和 WSL 里日志的位置。
  - 有多个发行版时可以切换。
  - “重新检查”：重新检测；就绪后立即连接，不用重启 Desktop。

## 实现

| 部分 | 文件 | 做法 |
|---|---|---|
| 检测 | `mirror/setup.mjs` | `wsl.exe --list --verbose`（UTF-16 输出）列出发行版和 WSL 版本；在选定的发行版里用一段 sh 脚本查 home、架构、可用的 Node（`~/.dsh-wsl/node`、`~/.local/bin`、PATH、`/usr/local/bin`、`/usr/bin`）、`~/.dsh-wsl/dsh` 里 DSH 的版本。`evaluate` 是纯函数，给出状态；`commandsFor`、`promptFor` 生成命令和提示词 |
| 连接文件 | `setup.mjs` 的 `installBridgeFiles` | 插件自带 `transport/`（daemon.mjs、mux.mjs）和 `agent/`（WSL 端插件）。就绪时经 `\\wsl.localhost\<发行版>\...` 复制到 `~/.dsh-wsl/bridge/`，按内容戳 `STAMP` 判断要不要复制 |
| 按需连接 | `transport/client.mjs` | `startBridge({ resolve })`：每次连接前先问 `resolve`；返回 null 时不连，等 `retry()`。`restart()` 用于切换发行版 |
| 守护进程 | `transport/daemon.mjs` | 新增 `--dsh`、`--stamp`、`--dsh-home` 参数。启动 DSH 前，如果 `desktop-wsl` 配置不存在，就用 web 模板创建（`dsh desktop-wsl --from-default-profile web --dump-config`）；如果配置里没有 `dsh-wsl-agent`，就加进去（`dsh plugin --profile desktop-wsl add link:~/.dsh-wsl/bridge/agent`），两步都不联网。连接文件、DSH 或 DSH home 变了时，新连接会替换旧的守护进程，旧的 DSH Host 随之停止。没有 Desktop 连着超过 5 秒（`DSH_WSL_IDLE_MS`）就停掉 DSH 并退出：退出 Desktop，WSL 端也跟着关；插件重载时桥在几秒内重连，不受影响 |
| 设置接口 | `mirror/index.mjs` | `/wsl-bridge/setup`：GET 返回状态、命令、提示词、安装进度；POST `{action:'recheck'}` 重新检查并连接，POST `{distro}` / `{mode}` 切换发行版、运行方式并记到 `~/.dsh-wsl/config.json`，POST `{action:'install'}` 在 WSL 里运行 `installScript`（先停守护进程，再安装），期间不连接，完成后自动连接。`run-target`、`install-target` 也带上状态 |
| 版本 | `merge.mjs` 的 `compatibleReleases`、`setup.mjs` 的 `compareVersions` | 前两段相同即可连接；semver 顺序（预发布排在正式版前，数字段按数字比较） |
| 插件自动更新 | `mirror/selfupdate.mjs` | 启动一分钟后检查一次，之后每 6 小时一次：`pluginManager.listBundles` 确认自己是从仓库安装的（`updatable`），`listVersions` 列出新版本，`pickUpdate` 选最新的、声明了组合包、不被 `engines.dsh` 拒绝、没有弃用、且不是预发布（除非当前就是预发布）的版本，`updateBundle` 替换。失败时 DSH 会装回旧版本。WSL 端插件和连接文件随之在下次连接时更新（STAMP）。`config.json` 的 `autoUpdate: false` 关闭；设置窗口底部显示插件版本、状态、“检查更新”和开关 |
| 版本范围 | `mirror/package.json` | `engines.dsh: ">=0.2.0-0 <0.3.0-0"`。DSH 按 `includePrerelease` 比较，所以 0.2.x 的预发布也在范围内，0.3 的预发布不在 |
| 用户自己的 dsh | `setup.mjs` 的探测脚本 | `bash -lc 'command -v dsh'`、`~/.local/bin/dsh`、`/usr/local/bin/dsh`、`/usr/bin/dsh`，顺着真实路径找到 `@deepseek-ai/dsh` 的 package.json；npm 全局安装时推出前缀，用于更新命令 |
| 页面 | `mirror/client.js` | `SetupDialog`；环境选择器和“添加文件夹”按状态显示 |

开发用的覆盖：入口配置或 `~/.dsh-wsl/bridge.json` 里写了连接命令时，跳过检测，直接用它（目前开发机就是这样）。`DSH_WSL_COMMAND` 指定另一个 wsl.exe，测试用，同时忽略 bridge.json。

## 验证（WSL 内，模拟的 wsl.exe，临时 home，0.2.2-rc.1）

| 检查 | 结果 |
|---|---|
| 临时 home 里没有 DSH | 状态“缺 DSH”；识别出 WSL 里已有 Node 24.22，只给出 DSH 一条命令 |
| 照设置窗口的命令真的安装 | `npm install --prefix ~/.dsh-wsl/dsh @deepseek-ai/dsh@0.2.2-rc.1` 成功；约 5 分钟，装好后 907 MB，npm 缓存 253 MB |
| 点“重新检查” | 复制连接文件；守护进程用模板建好 `desktop-wsl`、加上 `dsh-wsl-agent`（`link:~/.dsh-wsl/bridge/agent`），启动 DSH，状态变为“已连接”，版本相同 |
| 连接文件更新（插件升级） | 新连接替换旧守护进程：旧的 DSH 先退出，新的启动，只剩一个守护进程 |
| 断开所有 Desktop 连接 | 5 秒后守护进程记录 `no Desktop for 5000 ms`，停掉 DSH 并退出，不留进程 |
| 守护进程起不来（socket 路径超长） | 设置窗口显示“WSL 端启动失败”和错误原文，不再一直显示“正在启动” |
| WSL 里 DSH 版本旧 | 状态“版本不同”，环境菜单显示“WSL 里的 DSH 版本和 Desktop 不同，点击查看”，设置窗口给出更新命令 |
| “交给 DSH 安装” | 设置窗口关闭，在 Windows 文件夹里新建任务，输入框里是安装提示词 |

第二轮（2026-11-12，模拟的 wsl.exe，WSL 里有用户自己的 dsh 0.2.2-rc.1）：

| 检查 | 结果 |
|---|---|
| 检测到用户自己的 dsh | 状态“待选择”，设置窗口显示两张卡片（截图核对过） |
| 选“复用” | 守护进程运行用户自己的 dsh，DSH home 为默认的 `~/.dsh`，已连接 |
| 改选“插件专用”，点“自动安装” | 先停掉复用时的守护进程，npm 安装用了 2 分钟（共用 npm 缓存），自动连接；用的是 `~/.dsh-wsl/dsh`，数据在 `~/.dsh-wsl/home`，配置自动建好 |
| WSL 的 DSH 是 0.3.0 | “Desktop 版本较旧”，不提供安装命令 |
| WSL 的 DSH 是 0.2.9 | 照常连接，标记为 WSL 略新 |
| 已连接时打开设置 | 下拉菜单底部的“WSL 运行环境设置…”可用；版本差异按实际运行的版本判断 |

插件自动更新（2026-11-12，本地 npm 仓库 verdaccio，单独的测试 Desktop）：

| 检查 | 结果 |
|---|---|
| 从本地仓库装 0.0.1，仓库里有 0.0.2 | “检查更新”约 6 秒完成，状态“已更新到 0.0.2”；热替换，不用重启；新实例报告 0.0.2，配置里的依赖变为 0.0.2 |
| 仓库里又有 0.0.3，声明 `engines.dsh >=0.3.0-0` | 跳过，显示“已是最新” |
| 关闭自动更新 | 写入 `config.json`，设置窗口立即显示“自动更新已关闭” |
| 从本地文件夹安装（开发机） | 显示“从本地文件夹或 Git 地址安装，不会自动更新” |

单元测试：`node --test tests/setup.test.mjs`（7 个，含 `pickUpdate`），覆盖 `wsl.exe` 的 UTF-16 输出、检测结果（含用户自己的 dsh）、版本顺序和兼容、各状态、命令、安装脚本和提示词、连接文件复制。

## 还没做

- 发布到 npm（2026-11-12 定：包名 `@herenfor/dsh-wsl`，许可证 MIT，已加 LICENSE）。发布时：
  - 包名从 `dsh-wsl-mirror` 改为 `@herenfor/dsh-wsl`（`package.json`、`cordis.patch.yml` 的模块名、`client.js` 的模块 ID），去掉 `private: true`，定正式版本号；
  - 用户自己 `npm login` 后发布；
  - 用户的 Desktop 改为从 npm 安装（替换现在 `link:C:\Users\S\dsh-wsl-test\mirror` 的安装），之后才能自动更新。
  - 现在不改名，是因为 Desktop 按旧名字从本地文件夹安装，改名会让它找不到插件。
- 开发机切换到正式流程：删除 `C:\Users\S\.dsh-wsl\bridge.json` 后，按设置窗口的命令在 `~/.dsh-wsl` 装一份 DSH。这会改动用户的环境，要先问用户。

## DSH 0.2.2-rc.2（2026-11-12 检查）

- rc.2 只在 GitHub 上发了 Desktop 预发布；npm 上的命令行版仍是 0.2.2-rc.1，所以 WSL 端暂时装不到 rc.2。Desktop 升到 rc.2 后，WSL 端会是 rc.1：前两段相同，照样连接，设置窗口显示“WSL 端较旧”；点“更新到 rc.2”会因为 npm 上没有这个版本而失败并说明原因。
- 对照 rc.1 与 rc.2 源码（tag `dsh-v0.2.2-rc.1` / `dsh-v0.2.2-rc.2`）：Typert 网关、连接服务（`fetchRoutes`、`admit`、`connection/request`）、文件夹控制器、网页服务器都没变；会话控制的协议改动是新增的（空消息“继续生成”、`conversationContinuation` 投影），rc.1 的 WSL 端只是不支持这些新功能；我们用的扩展点名字、`data-row-key`、创造模式和在应用中打开的接口名、凭据接口都还在。
- 冲突一处，已修：插件列表的 `updatable: boolean` 改成了 `update: 'registry' | 'git'`，插件自动更新原来会一直判为“不能更新”。`selfupdate.mjs` 的 `updateKind` 两种都认。
- 没有实测 rc.2 Desktop + rc.1 WSL 的组合：rc.2 没有 Linux 可运行的包，测试 Desktop 只能用 rc.1。

## 只装在 WSL 端的插件（2026-11-12，用 ds-bot、dsh-claude-style 验证）

两类问题都是通用的，不针对某个插件：

- **插件自定义的 `/api` 接口**：插件用 `ctx.connection.fetch.register` 加的接口（ds-bot 的 `/api/bot` 和实时推送）原来在 Desktop 页面上是 404。WSL 端 agent 现在上报 WSL Host 的这类路由和方法，Desktop 在本机没有同名路由时整条转发（`wslFetchRoute` → `forwardRequest`）。
- **插件接口里的会话 ID**：插件页面和它的 WSL 后台用自己的格式传数据（ds-bot 的 `mainBotIds`、按会话 ID 作键的表），字段名没法列举。转发插件接口时按值改写：WSL 返回的 `session-<uuid>` 和 WSL 工作区 ID 加上 `wsl:`（对象的键也改），页面发过去的 `wsl:` ID 去掉前缀，JSON 请求/响应、查询参数和事件流（`data:` 行）都处理（`translateLoose`、`eventStreamRewriter`）。没有这一步时，ds-bot 拿到的 Chief 会话 ID 在页面上不存在，主区域停在 Windows 的默认会话，消息发到了 Windows 端。
- **插件补丁关掉的官方组件**：插件的 `cordis.patch.yml` 可以写 `{ id: <条目>, disabled: true }` 关掉官方条目（ds-bot 关掉 `ui-settings-general`，好占用设置入口 `settings.trigger`）。补丁只作用在 WSL Host 的组合上，Desktop 页面里官方组件还在，单例位置被占，插件的 `apply` 抛异常、整个插件不启动（页面只报 “1 entry did not activate”）。现在 agent 读出 WSL 上已启用的第三方插件补丁里关掉的条目，用 WSL 加载器把条目 id 换成包名上报，Desktop 合并模块图时把这些官方模块从页面去掉（`mergeGraphs` 的 `dropped`，写进 `mirror-status.json`）。只影响页面模块，Desktop 后台不动；补丁里改官方条目配置（非 disabled）的情况还没处理。

排查方法：生产页面里 cordis 不把插件 `apply` 的异常打到控制台。用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 在页面脚本前给 `__ModuleLoader__.load` 挂 setter，包住目标模块的 `apply` 打印异常。

## 界面语言（2026-11-12）

- 页面文字跟随 DSH 设置的语言，切换后立即生效，不用刷新。`client.js` 的 `DICT` 每种语言一块（现在有 `zh`、`en`），插件启动时整块注册到 DSH 的语言服务（命名空间 `dshWsl`），用 `ctx.locale.bind` 取文字；组件订阅语言快照，切换时重绘。没有词典的语言按 DSH 的规则退回英文。
- 插件标题和描述按原样的多语言文本传给页面（`plugins.mjs` 的 `text`），由 `ctx.locale.resolveText` 选语言；WSL 插件详情的说明文档按当前语言读取。
- 后台自己写的文字（安装命令的注释、交给 DSH 的安装提示、安装错误、两条报错）：页面每次请求带上 `x-dsh-wsl-language`，`language.mjs` 记下最近的语言，文字写成 `{ zh, en }` 表，按语言 id → 基础语言 → 英文选用。
- 加一种语言：在 `DICT` 加一块（键同 `en`，缺的键退回英文），再给 `language.mjs` 调用处的表加上这种语言。
- 验证（测试环境）：英文界面下切到中文，标签页名、说明、按钮、详情页、组件状态、插件标题和描述立即变成中文；切回英文同样。中英文词典各 175 条，键一一对应。
