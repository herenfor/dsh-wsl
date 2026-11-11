# 界面镜像实验

两个 DSH 插件，验证"插件只装在 WSL，界面出现在 Desktop 窗口"。结果和设计见 `../../docs/plugin-management.md`。

- `agent/`：装在 WSL 端（B）。`GET /wsl-bridge/events` 推送 `{ graph, origin }`。
- `probe/`：一个明显的界面插件，右下角显示徽章，第二行询问自己的宿主部分在哪台机器上运行。
- `mirror/`：装在 Desktop 端（A）。配置 `{ remote, token }`（没有配置时读取 `~/.dsh-wsl/remote.json`，并把合并结果写到 `~/.dsh-wsl/mirror-status.json`），把 B 的用户插件行合并进 A 的模块清单，并转发这些包的 `/plugins` 请求。
- `tests/merge.test.mjs`：合并逻辑的单元测试，运行 `node --test tests/merge.test.mjs`。

仅供实验：agent 的路由不校验登录，token 写在 A 的 profile 配置里。正式实现不这样做。
