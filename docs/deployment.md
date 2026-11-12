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
| 用户自己的 dsh | `setup.mjs` 的探测脚本 | `bash -lc 'command -v dsh'`、`~/.local/bin/dsh`、`/usr/local/bin/dsh`、`/usr/bin/dsh`，顺着真实路径找到 `@deepseek-ai/dsh` 的 package.json；npm 全局安装时推出前缀，用于更新命令（2026-11-12 起见文末“找不到用户自己的 dsh”）|
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

- 发布准备已做（2026-11-12）：包名改为 `@herenfor/dsh-wsl`（`package.json`、`cordis.patch.yml` 的模块名、`client.js` 的模块 ID），版本 0.1.0，去掉 `private`，`publishConfig.access: public`；加了 `icon.svg`（企鹅）、`locale/zh.json` 和 `locale/en.json`（标题、描述，`meta.detail` 指向对应语言的 README）、包内中英文 README。`scripts/assemble.sh` 把 transport 和 agent 拷进包里；`npm pack --dry-run` 核对过内容。测试环境按新包名重装后验证：插件正常加载，「已安装」页显示企鹅图标、"WSL run mode / WSL 运行模式"，详情页按语言显示英文或中文 README。
- 发布流程（2026-11-12）：`scripts/release.sh <版本>` 跑测试、组装、检查包内容、改版本号、提交、打标签并推送；标签触发 `.github/workflows/publish.yml`，用 npm Trusted Publishing 发布（不存 npm 密钥），已在 npm 上的版本跳过。`--dry-run` 只检查不改动；`--local` 在本机发布后再推标签。预发布版本发到 npm 标签 `next`。
- 0.1.0 已发布（2026-11-12，用户在本机 `release.sh 0.1.0 --local`）。npm 现在是分阶段发布：`npm publish` 先上传到暂存区（npm 上会出现一条 `0.0.0-stage` 占位记录，不能安装），维护者在 npmjs.com 用 2FA 确认后才上线。当时脚本在确认前就推了标签，工作流在 0.1.0 上线前一分钟查不到它，自己去发布被拒（还没配 Trusted Publisher），包本身不受影响；下载 npm 上的 0.1.0 与 `v0.1.0` 逐文件比对一致。已修：`--local` 发布后等版本在 npm 上可查（直接查 registry，不走本地缓存）再提交、打标签、推送；工作流也直接查 registry，发布失败时再查一次。另外：开了 2FA 之后要重新 `npm login`，旧令牌仍会 403。
- 还要用户做：到 npmjs.com 给 `@herenfor/dsh-wsl` 添加 Trusted Publisher（GitHub Actions、`herenfor/dsh-wsl`、`publish.yml`）；在 Desktop 里卸载旧的本地链接安装（旧名 `dsh-wsl-mirror`），再从 npm 安装 `@herenfor/dsh-wsl`，按全新用户的流程走一遍。
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

## 运行中途装上插件（2026-11-12）

- 现象（用户，Desktop rc.2）：装完插件不重启，DSH 会在已经打开的窗口里直接启用它；页面和它的数据流是在插件之前建立的，插件只接管了一部分：WSL 文件夹出现了，里面没有任务，选了 WSL 文件夹后输入框是灰的。重启 Desktop 后完全正常。
- 排查时排除了两个怀疑：冷启动（WSL 比页面晚连上）在 rc.2 上是正常的（测试里看不到任务，是因为测试浏览器里文件夹默认折叠，另外测试数据里的 WSL 任务是空任务，侧栏本来就隐藏空任务）；rc.2 刚启动时 `session/list` 也能立刻返回任务。
- 做法（用户决定：装插件后要求重启）：本进程里第一次加载插件时，如果 Desktop 后台已经运行超过 60 秒（`DSH_WSL_HOT_LOAD_SECONDS`），判定为运行中途装上或打开的：插件不启动 WSL、不改任何数据流，只把 `/wsl-bridge/setup` 和 `/wsl-bridge/plugins` 答成 `restart-required`；侧栏底部显示"WSL 运行模式：重启 Desktop 后生效"，点开有说明。这个判定在本进程里保持不变；随 Desktop 启动时加载过的插件，之后因为依赖的服务重启而重新加载，照常工作。
- 验证（测试环境，判定时间调成 10 秒）：运行中途经官方 `pluginManager/installBundle` 装上（结果 `applied`），侧栏出现重启提示，设置接口为 `restart-required`，WSL 端没有被启动；重启后正常连上，WSL 文件夹和任务都在。

## 插件更新改为只在插件页手动进行（2026-11-12）

- 用户的 Desktop 在 07:40 被插件的后台自动更新从 0.1.0 换成 0.1.1（插件管理记录：先卸载、再安装，`applied`，即在运行中直接替换）。替换的那一刻插件和 WSL 的连接会断开，WSL 里正在运行的任务可能被打断。用户决定：不做后台自动更新，由用户在插件页更新。
- 已删除 `selfupdate.mjs`（启动一分钟后检查、每 6 小时检查、`config.json` 的 `autoUpdate`、设置窗口的"检查更新 / 关闭自动更新"）。设置窗口底部只显示插件名和版本，提示到「插件 → 已安装」里检查和更新，更新后重启 Desktop。
- 在插件页更新同样会在运行中替换插件，所以"运行中途加载"的判断加上版本：同一进程里加载到的版本和 Desktop 启动时不同，就进入 `restart-required`（`loadKind`，有单元测试）。同一版本因依赖的服务重启而重新加载，照常工作。
- 上面"插件本身自动更新"相关的记录（决定 8、`selfupdate.mjs` 一行、verdaccio 测试表）已不再适用，保留作历史。
- 还没处理：运行中途在插件页把本插件关掉再打开（同一版本）不会被判为需要重启。

## 找不到用户自己的 dsh（2026-11-12，用户报告）

用户的另一台机器（Ubuntu-26.04，Desktop 0.2.2-rc.1，插件 0.1.2）：dsh 0.2.2-rc.1 装在 `~/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh`（项目式的本地安装，由自己的启动脚本运行，不在 PATH 上）；Node 由 nvm 管理（v22，只在登录 shell 里有），另有编辑器自带的 Node 24。插件找不到 dsh，也找不到 Node，直接按插件专用落到 `needs-node`，没有“复用”可选，也不说查过哪里。

改动（`setup.mjs`、`index.mjs`、`client.js`）：

- 探测脚本改成 `probeScript({ dshEntry })`。登录 shell 只开一次，同时问 `node` 和 `dsh`；再直接看常见版本管理器的目录：nvm（`~/.nvm/versions/node/*/bin`）、fnm、asdf、mise、volta。不看编辑器自带的 Node（会随编辑器升级消失）。dsh 还会看 nvm 各版本的全局 bin、pnpm（`~/.local/share/pnpm`）、bun、`~/.npm-global`。不扫项目文件夹：慢，也可能挑到过期的副本，而复用意味着共用 `~/.dsh` 的数据，选错代价大。
- 候选可以是 dsh 命令、包里的文件或包的文件夹：先顺着链接找 `package.json`；找不到且是脚本（pnpm 的 shim、`node_modules/.bin/dsh`）时，从脚本里读出它运行的包路径（替换 `$basedir`）。入口一律是包里 `bin.dsh` 指向的文件。
- 用户可以在设置窗口里填 dsh 的位置（命令名、包文件夹、`lib/bin.js`；Windows 的 `\\wsl.localhost\…` 路径会换成 WSL 路径），存到 `config.json` 的 `dshEntry`，同时选上“复用”。填的位置优先于自动找到的。
- 需要的 Node 版本取自要运行的那份 DSH 的 `engines.node`（`minNodeOf`），没有声明时用 `MIN_NODE`（24.9.0）。
- 新状态 `reuse-missing`：选了复用但找不到那份 dsh（或填的位置不对）时，不再悄悄改用插件专用的一份（那是另一份数据，表现为“WSL 任务全不见了”），WSL 端不启动，窗口里让用户填新位置或改用插件专用。
- 每个状态带 `checked`：查过的 dsh 位置及结果、找到的 Node 及版本是否够、需要的最低版本。设置窗口在缺 Node、缺 DSH、找不到复用的 dsh 时显示“查过的位置”。每次探测的完整输出写到 Desktop 一侧的 `~/.dsh-wsl/setup-probe.log`（含 stderr，`.bashrc` 出错时能看到）。
- 复用的 dsh 不是 npm 全局安装（`own.kind: 'local'`，比如上面的本地安装、pnpm 全局）时，不生成 `npm install -g` 的更新命令（会在旁边装出第二份），只提示用户用自己的方式更新。只缺 Node、DSH 已经是 Desktop 的版本时，命令里不再带更新 DSH 的一步（以前会带）。
- 没有选过运行方式、默认走插件专用时，缺 Node / 缺 DSH 的窗口在安装命令前面问“WSL 里已经装了 dsh，只是没被找到？”。

复用的边界（写进了 README）：复用是直接用 Node 运行用户那份 DSH 包，数据在 `~/.dsh`；不经过用户自己的启动脚本或包装器，那里设置的环境变量、端口、`DSH_HOME` 都不会带过来。

验证：单元测试加了 `minNodeOf`、填的位置优先、本地安装不是全局、`reuse-missing`、按 `engines` 判断 Node、只缺 Node 时的命令；另有一个测试在临时 home 里真的运行探测脚本（本地安装、pnpm 的 shim、`.bin/dsh` 的 shim、nvm 的 Node、带引号的路径）。在本机跑探测脚本约 60 ms，结果和以前一致。测试 Desktop（模拟的 wsl.exe）里：填一个不存在的位置得到 `reuse-missing` 并列出查过的位置；改填本地安装的位置后点“使用这份”，几秒内连上；只给 WSL Node 22 时显示“没有找到 Node.js 24.9.0 或更新的版本”和 nvm 的提示。

## 从 npm 安装时连接文件一个也没复制（2026-11-12，用户报告，0.1.3 及以前）

用户的另一台机器在修好上一节的问题后第一次走到 `ready`，WSL 端起不来，设置窗口只显示“Node.js v24.22.3”。WSL 里的 `~/.dsh-wsl/bridge/` 只有 `STAMP`，没有 `transport/`、`agent/`。

- 原因：`installBridgeFiles` 用 `cpSync` 的 `filter` 跳过 `node_modules`，判断的却是完整的源路径。从 npm 安装时插件本身就在 `…\node_modules\@herenfor\dsh-wsl` 下，于是 `transport`、`agent` 整个被跳过，没有报错，`STAMP` 照写；之后每次检查都因为戳一致直接返回，永远不会补上。
- 为什么开发机没遇到：开发机的连接文件是早先用本地文件夹链接安装时复制的（路径里没有 `node_modules`），之后 transport 和 agent 的内容没变，戳一直一致，从 npm 装的版本从没重新复制过。测试 Desktop 用 `link:` 安装，路径也没有 `node_modules`。所有全新的 npm 安装第一次连接都会失败。
- 修复（0.1.4）：过滤改为看复制源内部的相对路径；戳加入布局版本（`BRIDGE_LAYOUT = 2`），并改为递归、带相对路径，0.1.3 及以前写下的戳全部作废，坏掉的环境自己恢复，不用手动删文件；戳一致但缺必需文件（`BRIDGE_REQUIRED`）时也重新复制；复制完缺文件就报错，不写 `STAMP`，设置窗口显示错误。
- 报错显示：`transport/client.mjs` 以前只保留 stderr 每块的最后一行，Node 崩溃时就只剩“Node.js v24.x”。现在保留最近 8 KB，`stderrSummary` 取第一条错误行（不带调用栈），没有错误行时取最后几行。连接日志（包括 WSL 端的 stderr）写到 Windows 上的 `~/.dsh-wsl/bridge.log`（超过 512 KB 时旧的改名为 `.old`），错误窗口显示它的路径。
- 验证：单元测试把插件放在 `node_modules/@herenfor/dsh-wsl` 下复制，检查只剩 `STAMP` 的旧环境能自愈、子文件夹的改动会改变戳、复制不全时报错且不写 `STAMP`（这个测试在旧代码上失败）。测试 Desktop 改成从打包文件解压到 `node_modules` 安装（和 npm 安装一样），假 WSL 的 bridge 弄成只剩旧 `STAMP`：启动后自动重新复制、连上，侧栏出现 WSL 文件夹。再把 WSL 端的 `daemon.mjs` 换成会崩溃的文件：设置窗口显示 `Error [ERR_MODULE_NOT_FOUND]: Cannot find module …`，`bridge.log` 里有完整输出。
- 升级到 0.1.4 后，开发机的戳也会变，连接文件重新复制一次，WSL 端的守护进程会被替换一次（正在运行的 WSL 任务会断开一次）。

## WSL 的 dsh 是 pnpm 布局时 Desktop 白屏（2026-11-12，用户报告，0.1.4 及以前）

远端机器在上一节修好、第一次真正连上 WSL 后，重开 Desktop 整个窗口白屏。`mirror-status.json` 的 `mirrored` 有 74 项，全是 `@deepseek-ai/*` 官方包。

- 原因：WSL 端 agent 的 `builtinRoot()` 从 `dsh-client-modules` 的 `lib/client.js` 往上数四层当作安装根，这只对 npm 的扁平布局成立。用 dsh CLI 装的 DSH 是 pnpm 布局（`<install>/node_modules/.pnpm/<包>@<版本>/node_modules/<包>/…`），数四层停在 `dsh-client-modules` 自己的存储目录，其他官方包都不在它下面，于是 75 行里 74 行被标成 `user`。Desktop 端按设计用 WSL 的 `user` 行替换同名本地行，结果整个窗口的界面代码都改从 WSL 取；页面在 React 挂载前解析启动清单，任何一个模块经桥取不到就停在白色背景，连错误提示都画不出来。
- 为什么开发机没遇到：开发机和测试环境 WSL 里的 dsh 都是 `npm install -g` 装的（扁平布局）。
- 修复（0.1.5）：
  - `builtinRoot()` 向上找 `.pnpm`，取它的父目录；没有 `.pnpm` 时仍数四层（npm 扁平和 npm 全局不变）。
  - YAML 解析器改为从 `dsh-client-modules` 包文件本身解析（pnpm 下只有包自己的目录看得到它的依赖），再退到 `process.argv[1]` 和旧位置。不改的话安装根修对后 `disabled:` 会静默变空。
  - Desktop 端加一道保护（`mergeGraphs` 的 `builtinHere`）：Desktop 自己 DSH 自带的行，无论 WSL 端怎么标，都不被替换，只记到 `mirror-status.json` 的 `kept` 并打一条警告。WSL 端判断出错时，窗口至少保留自己的官方界面。两边都装了的用户插件仍由 WSL 端提供，和以前一样。
- 验证：单元测试覆盖 npm 扁平、pnpm（带链接）的安装根和 `isBuiltin`，以及 WSL 端把官方行都标成 `user` 时 Desktop 保留本地行（pnpm 的测试在旧代码上失败）。端到端：在假 WSL 里用 pnpm 装一份 dsh 0.2.2-rc.2（项目式，和远端一样），复用它，插件按 npm 方式装进测试 Desktop，结果：WSL 端 75 行全部是 `builtin`（旧算法在这份安装上只认出 325 个官方包里的 1 个），`mirrored` 为空，重载页面正常，侧栏有 WSL 文件夹。再把 WSL 端换回 0.1.4 的 agent（会误判）：Desktop 端 `kept` 74 行、`mirrored` 为空，页面照样正常。测试用的 pnpm 安装留在假 WSL 的 `~/.local/share/dsh-cli`，以后测复用时可以用。
- 远端恢复：完全退出 Desktop 后，在 `%USERPROFILE%\.dsh-wsl\config.json` 把 `dshEntry` 临时改成不存在的路径（插件不连 WSL，也就不镜像），或在 Desktop profile 的 `cordis.patch.yml` 里停用插件；更新到 0.1.5 后改回原来的 `dshEntry`。
