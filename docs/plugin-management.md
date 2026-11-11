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

### 实验暴露的缺口

1. **插件自己注册的 HTTP 路由**：哨兵界面请求 `dsh-task-notify/events`，在 A 上得到 404，因为这个路由由 B 的宿主部分注册。镜像插件的路由需要转给 B。
2. **不带会话 ID 的宿主调用**：调优替身把显示设置存在 `runtime-tuning-ui-chat` 这个命名空间下，对应的加载条目只在 B。这类调用需要按插件的主场转发，按会话分流管不到。
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
| 管理入口 | 先做自己的面板（侧栏面板加设置分区），列出 WSL 插件并支持安装、删除、启用和配置。官方插件页按上下文转发放到以后。面板需单独设计。 | 已定，面板待设计 |
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
