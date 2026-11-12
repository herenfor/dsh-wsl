# 插件管理面板设计

状态：方向已定（见下面"决定"），细节待实现。2026-11-11。背景见 `plugin-management.md`。

## 新发现：官方插件页可以直接管理 WSL 插件

官方插件页（`dsh-client-ui-plugin-manager` 等）只通过以下命名空间与 Host 通信，全部是单次调用，没有流：

- `pluginManager/*`：列出、安装、卸载、启用、更新、版本、注册表
- `pluginInventory/list`
- `pluginMarket/*`：索引和搜索
- `pluginRecommendations/describe`
- `pluginRegistryProbe/fastest`

mirror 在 `connection/request` 钩子里加了一个"管理位置"开关（`/wsl-bridge/plugin-target`，取值 `local` 或 `wsl`）。设为 `wsl` 时，这些命名空间的请求转发给 WSL Host。

实验结果（WSL 内两个 DSH，0.2.2-rc.1）：开关设为 `wsl` 后，A 的官方插件页"已安装插件"列出的是 B 的 `dsh-runtime-tuning`、`dsh-wsl-probe`、`dsh-wsl-agent`，A 自己的 `dsh-wsl-mirror` 不在列表中。安装、卸载和启用还没测，它们会改动 B 的 profile。

页面上的"内置插件设置"（子代理、网页搜索等）读写的是设置命名空间，目前仍走 A（见 `plugin-management.md` 中"两边都有的设置命名空间"）。

## 两种做法

### A. 官方插件页 + 管理位置开关（推荐）

- 官方插件页不变，加一个"管理位置：Windows / WSL"开关，切换后整页管理对应那边的插件。
- 我们自己只做一个小面板：显示 WSL 环境状态（发行版、DSH 版本是否一致、连接）、切换开关、出错时的修复入口。
- 好处：
  - 市场、搜索、安装、版本、启用、配置表单全部现成；
  - 用户不用学两套界面；
  - 官方插件页以后加的功能自动可用。
- 代价：
  - 依赖官方插件页的内部接口，每个版本都要实测；
  - 页面本身看不出当前管理的是哪一边，必须在页面上加醒目的标识；
  - 官方页面可能缓存了上一边的数据，切换后要触发刷新。

### B. 完全自己写面板（原计划）

- 自己实现列表、安装、启用和配置。
- 好处：不依赖官方插件页的内部结构，界面完全可控。
- 代价：工作量大，功能长期落后于官方，配置表单要重做。

## 推荐

采用 A。要先确定的：

1. **默认管理位置**：开启 WSL 模式后，默认管理 WSL（与"插件默认装在 WSL"一致），还是跟随当前选中的项目或会话。
2. **标识**：在官方插件页加醒目标识的方式，可选用官方插槽、顶部横幅，或我们小面板里的开关状态。
3. **两边都有的设置命名空间**跟随哪一边（与插件页里"内置插件设置"直接相关）。

## 决定（2026-11-11）

- **用官方插件页**，但不做"管理位置"开关：**Windows 和 WSL 两边的插件全部列出来，并逐个标明属于哪一边**，不能有看不到的。
  - 实现思路：合并两边的列表响应，WSL 一侧的条目改写 ID（类似 dsh-ssh-workspace 的 `dsh-remote:<来源>:<id>`）。写操作按 ID 前缀分流到对应那边。标识写在页面能显示的字段里。
  - 需要验证：官方页面是否接受改写后的 ID，两边同名的内置插件怎么并列显示，安装时怎么选择装到哪一边。
- **按会话决定在哪边运行，不做全局开关**：会话 A 在 Desktop 运行，会话 B 开了 WSL 模式就在 WSL 运行，侧栏正常列出两边的会话（这一部分属于桥接的"按会话分流"）。
- 已实现的 `/wsl-bridge/plugin-target` 开关只是实验，最终会被"两边全部标注"取代。

## 两边插件合并列出（2026-11-11，WSL 内两个 DSH 间已验证）

做法：在 mirror 的 `connection/request` 钩子里处理 `pluginManager/*` 和 `pluginInventory/*`（实现见 `experiments/mirror/mirror/plugins.mjs`）：

- **列表**：`listBundles`、`listPlugins`、`pluginInventory/list` 同时问两边，合并后返回。
  - 每个插件标题后面加上"· Windows"或"· WSL"。
  - WSL 一侧条目的 ID（`name`、`entryId`、`patchId`、`rows[].entryId`）加上 `wsl:` 前缀。两边都有的同名内置插件因此可以并列，开关状态各自独立。
- **操作**：参数里任何字符串带 `wsl:` 前缀，就去掉前缀转给 WSL Host，返回的 `target`、`bundle` 再加回前缀。
  - 在 WSL 发起的安装会记下它的 `requestId`，之后的 `waitForInstall`、`cancelInstall` 也发往 WSL。
- 已删除实验用的"管理位置"开关。

结果：

| 检查 | 结果 |
|---|---|
| 列表 | 插件 52 个（两边各 26 个），插件条目 413 个；"已安装插件"里同时有 `dsh-wsl-mirror · Windows` 和 `dsh-runtime-tuning · WSL` 等 |
| 详情页 | 点击 `dsh-runtime-tuning · WSL` 打开详情，README 从 WSL 读取；ID 行显示 `wsl:dsh-runtime-tuning` |
| 停用和启用 | 经 A 停用 WSL 的 probe 后，B 上该插件停止，A 转发的路由随之消失；再启用后恢复 |
| 安装和卸载 | 经 A 安装 `wsl:/home/s/dsh-sentinel`，装进 B 的 `desktop-wsl` profile，A 的 profile 不变；经 A 卸载后 B 恢复原样 |



## 安装位置（2026-11-11，已实现并在 WSL 内验证）

官方"添加插件"下拉菜单有两项："安装第三方插件"（一个输入框，支持 npm 包名、GitHub 仓库地址、本地目录路径三种形式，另有注册表选择）和"让 agent 创建插件"（Creator 模式）。下拉菜单里的额外项来自官方插槽 `plugins.add.actions`。

- mirror 通过这个插槽在菜单里加了一项"安装位置：WSL（发行版名）"，左侧有色条（WSL 橙色、Windows 蓝色），点击在 WSL 和 Windows 之间切换，默认 WSL。"安装第三方插件"的 `inspect` 和 `installBundle` 按这个位置发送。
- **本地目录**：装到 WSL 时，Windows 路径会自动换成 WSL 路径（`C:\…` → `/mnt/c/…`，`\\wsl.localhost\<发行版>\…` 和 `\\wsl$\…` → `/…`）。装到 Windows 时，WSL 路径会换成 Windows 路径（`/mnt/c/…` → `C:\…`，`/home/…` → `\\wsl.localhost\<发行版>\home\…`）。
- **不静默回退**：位置选了 WSL，但 WSL Host 未连接或版本不同时，安装直接报错并提示切换，不会改装到 Windows。mirror 与 WSL Host 断开时会清掉旧的清单，重新连上后自动恢复（会重新读取 `remote.json`，WSL Host 重启后令牌变了也能连上）。

验证（经 A 装进 B，然后卸载，B 的 profile 恢复原样，A 的 profile 全程不变）：

| 形式 | 例子 | 结果 |
|---|---|---|
| npm 包 | `dsh-ssh-workspaces` | 装进 WSL |
| Git 仓库 | `github:herenfor/dsh-sentinel#v0.3.1` | 装进 WSL（WSL 自己的 git） |
| 本地目录 | `C:\Users\S\dsh-wsl-test\mirror` | 换成 `/mnt/c/…` 后装进 WSL |
| WSL 断开 | 同上 | 返回"The WSL Host is not connected…"，没有装到 Windows |

"让 agent 创建插件"会开一个 Creator 会话，它在哪边运行属于按会话分流，暂不处理。

截图：`images/plugins-add-menu.png`。

## 官方内置插件的两边显示（已决定：一行显示两边状态）

官方插件页按包名的固定列表决定内置插件怎么显示：哪些隐藏、哪些排在前面、哪些收进"More"、哪些带"Experimental"标记，都是精确匹配。WSL 一侧的 ID 加了 `wsl:` 前缀，所以：

- 核心包（`dsh-base` 等）在两边都不显示，正常；
- Windows 的实验插件保持官方样式：5 个在列表里、带 Experimental 标记，其余收进 More；
- WSL 的实验插件 14 个全部列出，没有 Experimental 标记，排在 Windows 的后面。

截图：`images/plugins-experimental-both-sides.png`、`images/plugins-installed-both-sides.png`。

另一种做法：官方内置插件每个只占一行（保持官方样式），标题标出两边的状态，例如"Agent teams · Windows 已启用 · WSL 未启用"；WSL 一侧的开关放在插件详情页（官方插槽 `plugins.detail.actions`）。用户自己装的插件不受影响，仍按两边各列一行。

### 实现（2026-11-11，WSL 内已验证）

- 两边同名、且属于官方的插件只保留一行（不加 `wsl:` 前缀，官方的隐藏、排序、More 收纳和 Experimental 标记都照常）。行上的开关同时切换两边（先切 WSL，再按原样切本机；`alsoOnWsl`）。两边一致时标题不加后缀；只有在详情页单独切过一边、两边不一致时，标题后面写"· 仅 Windows 启用"或"· 仅 WSL 启用"（其他语言 "· Windows only / WSL only"），再点一次行上的开关两边就重新一致。（2026-11-12 改：之前开关只管本机，标题写"· Windows · WSL 未启用"，用户看不懂，切换后也不像在变。）
- 插件详情页右上角（官方插槽 `plugins.detail.actions`）加一个 WSL 开关："WSL：未启用 [在 WSL 启用]"。经 mirror 的 `/wsl-bridge/bundle` 读取和切换 WSL 一侧。需要重启 WSL 端才能生效时，会提示出来。
- 用户自己装的插件不变，仍然两边各一行。
- 验证：在"Agent teams"详情页点"在 WSL 启用"，WSL 一侧变为已启用；再点停用，恢复原状。B 的 profile 恢复原样。

截图：`images/plugin-detail-wsl-switch.png`。
