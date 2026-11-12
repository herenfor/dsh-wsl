# 跨两边的兼容扫描（进行中）

## 目标

做一个扫描脚本（`dev/scan/`），在测试环境里把"Windows 和 WSL 两个 Host 拼在一起后语义对不上"的地方**系统地找全**，输出一份报告；然后按报告逐类做**兼容**：每一类东西在两边各自是什么意思、合在一起应该是什么意思，定清楚规则再实现。不是哪里坏了补哪里。

先扫、出报告、和所有者一起定规则，再改代码。随 0.1.9 发布。

## 引出这件事的例子：新任务默认预设

- 官方把"新任务默认"存在设置 `agent-preset-registry.selectedDefault`（一个值），会话创建时由各自的 Host 解析。
- 在预设页把 WSL 独有的预设（如调优插件的 `tuned`）设为默认：Windows 端写入成功，设置同步带到 WSL 端。结果：
  - WSL 新任务正常用 `tuned`；
  - **Windows 新任务建不出来**：`agent-preset/not-found: Unknown agent preset: tuned`；
  - 预设页上没有任何一张卡显示「新任务默认」（`routing.mjs` 的 `mergePresets` 把 WSL 独有的行一律 `isDefault: false`，Windows 端又找不到 `tuned`）。
- 复现：测试环境复用模式，假 WSL 的 `web` profile 里打开 `runtime-tuning-preset-tuned`，在页面上调 `settings/update {ns: 'agent-preset-registry', patch: {selectedDefault: 'tuned'}}`，再 `session/create {request: {cwd: <Windows 文件夹>}}`。
- 当时提的两个方案（待扫描后再定）：按运行位置分别记默认；或 WSL 独有的预设不能设为默认。

## 要找的几类问题

1. **跨边引用**：设置里存的值（或会话、工作区上的字段）指向只在一边存在的东西——预设、模型/服务商、权限预设、技能、斜杠命令、子智能体、MCP 服务……写到另一边就失效或报错。
2. **合并列表里的单边标记**：我们合并过的列表（预设、侧栏会话和工作区、插件、界面模块、设置命名空间……），每项上的 `isDefault`、`selected`、`current`、`active`、`enabled`、`pinned` 之类只对一边有意义的字段，合并时是否处理对了。
3. **没合并的列表**：页面只拿到 Windows 端的结果，但 WSL 端有更多条目（页面上看不到 WSL 的东西），或反过来。
4. **按 id 写入的接口**：参数里带预设、模型、会话、工作区 id 的写接口，id 只在另一边时，路由是否送对了地方。

## 扫描脚本的设计

在测试环境（`dev/README.md`）里跑，复用模式，假 WSL 里装着带 WSL 独有东西的插件（调优插件的 `tuned` 预设、ds-bot、dsh-pet……）。

1. **列接口**：从 DSH 包里每个 `typert.remote-client.d.ts` 解析出页面可调用的接口名和参数形状。注意：`dsh-api-*` 包里只有 68 个（session、workspace、settings、terminal、workspaceFiles、job、directoryPicker、credentials、skills…），`agentPresets/*` 等在别的包里，要扫整个 `node_modules/@deepseek-ai` 下所有包的 `typert.remote-client.d.ts`（插件包也算）。
2. **读两边**：对所有只读、可无参调用的接口（list/describe/read/status/catalog 一类），分别直接问 Windows Host（测试 Desktop 的页面 API，绕过我们的路由要另想办法，或用 Host 自己的端口）和 WSL Host（`dev/bridge-call.mjs` 的方式），再问一遍"经过我们路由后页面拿到的结果"。比较三份：WSL 独有的 id、页面上缺了的条目、合并后各项的标记字段。
3. **列设置字段**：两边 `settings/describe` 的全部命名空间和字段（schema + 当前值）。字符串或字符串数组字段里，值或可选值落在第 2 步任一 id 集合里的，判为"引用字段"；字段名像 default/selected/preset/model/provider 的也列上。
4. **动态试**：对每个引用字段，临时写成一个只在 WSL 有的值（以及只在 Windows 有的值），然后在 Windows 文件夹和 WSL 文件夹各新建一个任务、重读相关列表，记录报错和显示变化；最后按 revision 还原。
5. **查我们的合并代码**：`experiments/mirror/mirror/routing.mjs`、`index.mjs`、`settings.mjs`、`merge.mjs` 里每个特殊处理的接口，对照第 2、3 步的结果，标出处理了什么、漏了什么。
6. **报告**：`dev/scan/report-<日期>.md`，每条写：哪个接口/字段、两边各是什么、页面上表现成什么、复现步骤、属于上面哪一类。

## 进度

- [x] 发现预设默认的问题并复现（见上）。
- [x] 盘点 `dsh-api-*` 包里的接口（68 个）。
- [ ] 扩大到所有包的 `typert.remote-client.d.ts`，写 `dev/scan/` 的接口清单部分。
- [ ] 读两边 + 页面三方比较。
- [ ] 设置字段的引用分析。
- [ ] 动态试写（必须还原）。
- [ ] 报告，和所有者一起定每一类的兼容规则。
