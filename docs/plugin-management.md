# 插件管理方式

状态：方案 B（界面镜像）已在 WSL 内做过实验并跑通，其余部分为草案。2026-11-11 整理。桥接方案见 `bridge-plan.md`。

## 目标

WSL 模式下，Linux 插件装在 WSL 的 DSH 里，原样可用，包括修改界面的插件。

- **全窗口一套界面。** 改界面的插件就是要改整个窗口，Windows 本机会话也用同一套界面。
- **插件只装一边，宿主部分只在那一边运行。** 不会出现两份宿主同时运行，比如两只桌宠。
- **在 Desktop 里管理插件，不用浏览器。**

## DSH 怎么加载插件界面（0.2.2-rc.1）

- Host 上的 `clientModules` 服务（`@deepseek-ai/dsh-client-modules`）扫描启用的加载条目，把带 `dsh.client` 的包组成**模块清单**：
  - `entries`：每个插件界面一行，含 `id`、`url`、`rev`、`inject`、`external`。
  - `batches`：把多行打包成一个脚本的合并请求，**每行恰好属于一个 batch**。
  - `release`：版本号加构建 commit。
- 清单有两条发出去的路：
  - 页面打开时注入为 `window.__DSH_BOOT__`，由 `webserver/index-inject` 事件读取 `this.composed`。
  - 之后由 `client-hmr` 的 `/plugins/events`（SSE）推送更新，读取的是 `clientModules.graph()`。
- 页面把清单里的每一行都当作插件挂载。只接受 `release` 与自己相同的清单，否则暂停更新并提示刷新页面。
- 界面代码由 `/plugins` 路由回答：
  - 合并请求：`/plugins/??a/client.js,b/client.js&rev=`
  - 分块：`/plugins/<包>/<文件>?rev=`
  - 资源：`/plugins/<包>/assets/...`
  - 这些请求都由同一个 `fetchBundle()` 处理。
- `rev` 由文件的 mtime、ctime 和大小算出，**不是内容哈希**，所以两台 Host 上同一个文件的 `rev` 也不一样。
- 同版本下，Desktop 和 WSL 的官方界面代码**逻辑完全相同**，只差 CI 构建路径和由路径算出的 CSS 类名哈希（2026-11-11 逐文件比对过）。

## 方案 B：界面镜像

```
WSL Host（B）                                  Desktop Host（A）
  dsh-wsl-agent                                  dsh-wsl-mirror
  /wsl-bridge/events ──{graph, origin}──SSE──►   合并清单：B 的用户行加入，同 id 替换 A 的行
                                                 /plugins 请求：属于镜像包的转给 B
                                                        │
                                                        ▼
                                              页面（Desktop 窗口）挂载合并后的清单
```

- **区分来源**：B 端按每行界面代码的真实路径判断。在 DSH 安装目录（`.../@deepseek-ai/dsh-client-modules` 往上四层的 `node_modules`）里的算 `builtin`，否则算 `user`。只有 `user` 行会被镜像，官方行用 A 自己的。
- **合并规则**：
  - B 的 user 行加入 A 的清单。
  - 和 A 同 id 的行由 B 替换，也就是 WSL 优先。调优插件的 `ui-chat` 替身沿用官方包名，正好走这条路。
  - A 中含被替换行的 batch，拆成单行 batch。不拆的话，batch 脚本会把被替换的官方 factory 也注册一次。
  - 镜像行各自单独一个 batch。
  - 用 `orderByModuleGraph` 重新排序，重新算整份清单的 `rev`。
- **版本不同不镜像**：两边 `release` 不同时，退回 A 自己的清单。
- **对官方代码的改动**：A 端只改 `clientModules` 实例上的两个成员，dispose 时恢复。
  - `composed` 改成 getter/setter，`graph()` 和页面注入都会读到合并后的清单。
  - `fetchBundle` 改成先判断请求是否属于镜像包。
  - 依赖的私有成员只有 `composed`、`fetchBundle` 和 `notifyGraphChanged`，**每个 DSH 版本都要实测**。

代码在 `experiments/mirror/`，合并逻辑有单元测试（`tests/merge.test.mjs`，4 项）。

### 实验结果（2026-11-11，WSL 内两个独立 DSH_HOME，DSH 0.2.2-rc.1）

B 装调优插件、哨兵和 agent，A 只装 mirror。用 headless Chromium 打开 A 的页面：

| 检查 | 结果 |
|---|---|
| B 端来源判断 | 74 行中 2 行是 `user`：`dsh-sentinel`、`@deepseek-ai/dsh-client-ui-chat`（调优替身） |
| A 的页面清单 | 含这 2 行，`ui-chat` 的 `rev` 是 B 的；batch 从 A 原来的拆分重组后共 60 个 |
| 界面代码来源 | 经 A 取到的两份界面代码与 B 直接给出的逐字节相同 |
| 是否真的运行 | V8 覆盖率显示 `ui-chat` 替身的 factory 和注册函数都执行了，没有重复注册的错误；哨兵界面的 `apply` 也执行了 |
| A 自己的界面 | 正常显示，无报错 |
| 实时更新 | 改动 B 上哨兵界面代码的时间戳后，A 的页面没有刷新就加载了新的 `rev` |

结论：**界面镜像可行。插件只装在 WSL，界面在 Desktop 窗口里出现并运行，宿主部分只在 WSL。** 原来的方案 A（Windows 也装、只挂界面）不再需要。

### 真实 Desktop 验证（2026-11-11，Desktop 0.2.2-rc.1，Windows）

- WSL 端：`~/.dsh/profiles/desktop-wsl`，装调优插件、`dsh-wsl-probe`（右下角徽章，第二行询问自己的宿主部分）和 agent，`dsh web` 监听 `127.0.0.1:47201`。Windows 通过 WSL 的 localhost 转发访问它。
- Desktop 端：在插件页安装本地路径 `C:\Users\S\dsh-wsl-test\mirror`（pnpm 以 `link:` 方式安装，**本地绝对路径可以绕开私有仓库的权限问题**）。连接信息从 `%USERPROFILE%\.dsh-wsl\remote.json` 读取。
- 结果：
  - 点击"立即启用"后，徽章出现在 Desktop 窗口右下角，不需要重启。
  - 第二行显示"宿主不可达（HTTP 404）"，符合预期（缺口 1）。
  - Desktop 原有界面正常。

**结论：镜像在 Electron 窗口加 Windows Host 下成立；Windows 与 WSL 官方界面代码中 CSS 类名哈希不同，也不影响。**

### 版本跟随：Desktop 可能先于 npm 发布

2026-11-11，Desktop 开始更新到 0.2.2-rc.2，此时 npm（官方源和 npmmirror）上最新的仍是 rc.1，而官方 GitHub 仓库 `deepseek-ai/deepseek-harness`（公开）已有标签 `dsh-v0.2.2-rc.2`。

- 两边版本不同时，mirror 按设计不做镜像，Desktop 正常运行，WSL 插件的界面暂时不出现。
- WSL 端部署不能只依赖 npm。备选来源：
  1. 按 Desktop 版本对应的 GitHub 标签从源码构建；
  2. 等 npm 发布。
- 页面比较版本时，用的是 `release` 里的 `{version, commit}`，commit 是构建时写进去的。**源码构建得到的 commit 必须与 Desktop 的一致**，这一点需要验证。

### 对照 0.2.2-rc.2（2026-11-11 发布）

- 镜像依赖的包，在 rc.1 → rc.2 之间只有版本号更新和"随包发布源码"的提交：`client-modules`、`client-hmr`、`host-webserver` 各 2 个提交，`client-connection` 3 个，`ui-layout` 3 个。`client-modules/src/index.ts` 两个版本逐行相同，`composed`、`fetchBundle`、`notifyGraphChanged` 都在。
- 与本项目有关的变更：
  - 可选插件加载失败不再导致整个页面无法启动；启用但未加载的插件会显示"未运行"及原因。
  - 自定义浮层需适配新的菜单定位接口：界面插件跨版本可能失效，说明兼容检查有必要。
  - AgentTeam："共享会话的进程须同步升级"，再次说明两边版本必须一致。
  - 模型请求的 User-Agent 增加启动配置标记，用于区分桌面端、Web、命令行和 SDK。
  - Desktop 可切换正式版和开发版更新渠道：版本跟随要考虑渠道。
  - npm 包和 Desktop 都随附对应版本的源码和文档。
- 调优插件需要复查的：Session 批量追加事件（包装追加接口的插件要适配），以及工具失败的新错误类型。

### 按主场转发（2026-11-11，WSL 内两个 DSH 间已验证）

镜像插件的界面要和它的宿主部分通信，有这几条路。各条路的转发方式：

| 通信方式 | 例子 | 做法 | 状态 |
|---|---|---|---|
| 插件自己注册的 HTTP 路由 | 哨兵 `dsh-task-notify/events`、probe `dsh-wsl-probe/whoami` | agent 报告 B 的路由表（每 2 秒比较一次，有变化就推送），mirror 在 A 上注册"B 有、A 没有"的路由，排除 DSH 自己的路径（`/`、`/api`、`/plugins`、`/connect`、`/assets`），并转发到 B | 已实现 |
| 只在 B 存在的设置命名空间 | 调优替身的 `runtime-tuning-ui-chat` | 在 client-connection 的 `connection/request` 钩子里：`settings/describe` 合并两边，B 独有的命名空间排在后面；`update`、`replace`、`mutate` 写 B 独有命名空间时转发到 B | 已实现 |
| 两边都有的设置命名空间 | 模型、主题、语言、子代理等 | **以 Desktop 为准，单向复制到 WSL**（见下） | 已实现 |
| 插件自己的 Typert 远程服务 | `/api/<命名空间>/<方法>`，以及 `/api/remote.mux` 上的流 | 单次调用可按命名空间转发；流在同一条 WebSocket 上复用，需要在客户端拆分（dsh-ssh-workspace 的做法） | 未做 |
| 插件的 WebSocket 升级路由 | `registerUpgrade` | 需要转发 WebSocket | 未做 |

- **设置以 Desktop 为准**（2026-11-11 决定）：凡是 Desktop 上能调的设置，都以 Desktop 为准；只有 WSL 独有的设置交给 WSL 自己配置。
  - **同步方式**：mirror 在进程内读取 `settings.describe()`，再与 WSL 的设置逐个顶层字段比较，用 `settings/mutate` 写入不同的值（`set`），删掉 WSL 多出来的字段（`unset`）。
  - **触发时机**：连上 WSL 时同步一次全部，Desktop 写设置后立即同步，此外每分钟检查一次。在 WSL 一侧直接改这些设置，下次同步时会被 Desktop 的值覆盖。
  - **不同步的**：密钥字段（每边各填各的）；只描述单台机器的命名空间 `bash-sandbox`、`pwsh-sandbox`；只有一边才有的命名空间，比如调优替身的 `runtime-tuning-ui-chat`，仍按上面的规则交给它所在的一边。
  - **结果**：连上时复制了 A 改过的 `ui-settings-general`；A 把主题设为深色后，B 立即变成深色（revision 0 → 1）；A 清空后，B 也清空（→ 2）。
  - 同步结果写在 `~/.dsh-wsl/mirror-status.json` 的 `settingsSync` 里。
- **校验**：转发前用 A 自己的 `connection.admit(req)` 检查登录和 Origin。验证结果：不带 cookie 返回 401，跨站请求返回 403，带登录时返回 B 的结果。B 的 cookie 只在 mirror 里使用，`set-cookie` 不会传给页面。
- **结果**：
  - probe 徽章第二行变成"宿主：linux …"，返回的是 B 的 pid；
  - 经 A 写入 `runtime-tuning-ui-chat` 的设置，落在 B（revision 0 → 1）；
  - 两边都有的 `locale` 仍读写 A。
- **真实 Desktop 验证**（2026-11-11，Desktop 0.2.2-rc.1）：完全重启 Desktop 加载新版 mirror 后，徽章第二行显示"宿主：linux · HeRenFor · …WSL2"，即 Windows Host 把 probe 的路由转发给了 WSL Host。注意：插件代码更新后，只在插件页关掉再打开不会生效（Node 缓存已加载的模块），必须完全重启 Desktop。
- **依赖的内部接口**：web server 的 `exact`、`prefixes`、`upgrades` 三个私有 Map；`connection.admit`；`connection/request` 钩子；settings 的 `describe`、`update`、`replace`、`mutate`。每个 DSH 版本都要实测。

### 实验暴露的缺口

1. ~~**插件自己注册的 HTTP 路由**~~（已解决，见"按主场转发"）：哨兵界面请求 `dsh-task-notify/events`，在 A 上得到 404，因为这个路由由 B 的宿主部分注册。镜像插件的路由需要转给 B。
2. **不带会话 ID 的宿主调用**（只在 B 存在的设置命名空间已解决；两边都有的命名空间和 Typert 服务见"按主场转发"）：调优替身把显示设置存在 `runtime-tuning-ui-chat` 这个命名空间下，对应的加载条目只在 B。这类调用需要按插件的主场转发，按会话分流管不到。
3. **插件路由不验证登录**：B 上 agent 的 `/wsl-bridge/events` 不带 cookie 也返回 200。DSH 只对 `/api` 等官方入口做校验，插件注册的路由要自己保护。正式方案里 WSL Host 不开 TCP 端口（见 `bridge-plan.md`），A 端转发也只能接受本机已登录的页面。
4. **还没验证的**：
   - mirror dispose 后恢复原清单；
   - 在真实的 Windows Desktop 上运行（A 端在 Windows、页面在 Electron 里）；
   - 带资源文件（assets）和分块的插件；
   - B 停用了某个官方界面行时，A 仍会显示它。

## 插件管理设计（草案）

| 问题 | 建议 | 状态 |
|---|---|---|
| 插件装在哪边 | 见下文"安装位置"。WSL 是默认且推荐的位置；Windows 只用于确实需要 Windows 的插件，要先检查兼容性。 | 已定 |
| Windows 只挂界面 | 不需要，由镜像代替 | 已定 |
| 两边版本 | 必须完全相同；页面本身也会拒绝不同版本的清单 | 已定 |
| WSL 端 profile | 独立的 `desktop-wsl`，不和用户自己的 `web` 共用目录 | 已定 |
| 管理入口 | 插件页里独立的「WSL（发行版名）」标签页管理 WSL 端插件；官方「已安装」页只管 Windows，不做改动（见 panel.md"当前做法"） | 已实现（2026-11-12） |
| 插件配置写在哪里 | 写在插件所在 profile 的 `cordis.patch.yml`，即 WSL 端 | 已定 |
| 安装来源 | 在 WSL 里用 pnpm 安装，支持 npm 镜像和 `github:` 规格；pnpm 的 exotic 子依赖限制照官方处理 | 草案 |
| 升级和回退 | Desktop 升级后，WSL 按版本目录部署新 DSH，先检查已装插件的 `engines.dsh`，不兼容的提示停用；旧版本目录保留用于回退 | 草案 |
| 同 id 冲突 | WSL 优先（已实现于合并规则） | 已定 |
| 路由和无会话调用 | 镜像插件的 HTTP 路由和宿主调用按"主场"转给 WSL，详见上面的缺口 1、2 | 待设计 |

### 安装位置

**原则：开启 WSL 模式后，插件的家在 WSL。** 不尝试让一般插件在 Windows 上运行，Windows 只是界面所在的地方。

- **默认装到 WSL**：从我们的面板安装时直接装进 WSL 的 `desktop-wsl` profile；界面经镜像出现在 Desktop 窗口。
- **Windows 只在有理由时才装**：插件确实需要 Windows（调用 Windows 专属 API、托盘、Windows 路径），或者用户要让它的宿主功能作用于 Windows 本机会话。Windows 侧的安装仍由官方插件页负责，行为和现在一样。
- **装到 Windows 之前先检查**，只用于提示，不保证一定能用：
  - `package.json` 的 `os`、`cpu` 不含 `win32`；
  - 依赖里有原生模块（`binding.gyp`、`prebuilds/` 里没有 win32），或安装脚本调用 bash；
  - 代码里明显的 Linux 专属用法（`/proc`、`bash -c`、写死的 `/` 路径）。
  命中任意一条就标"可能无法在 Windows 运行"，并建议改装到 WSL。
- **装好后检查能否启动**：插件的宿主条目启动失败时自动停用，并提示改装到 WSL。任何情况下都不能让 Desktop 打不开（可借用哨兵的崩溃保护思路）。

**作用范围要讲清楚。** 镜像后界面是全窗口的，但装在 WSL 的插件，**宿主功能只作用于 WSL 会话**。例如调优插件的 wait-guard 不会影响 Windows 本机会话，而它改过的聊天界面对所有会话都生效。面板上每个插件都要标出"作用于：WSL 会话"，免得用户在本机会话里以为插件坏了。
