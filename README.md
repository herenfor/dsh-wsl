# dsh-wsl

给 Windows 版 DeepSeek Harness（Desktop）加一个 **WSL 运行模式**：某个项目或会话选择 WSL 后，agent、会话和插件都在 WSL 内的 DSH Host 运行，界面仍是 Desktop 的窗口。核心是插件：Linux 插件装在 WSL 里原样可用，包括修改界面的插件，在 Desktop 里管理，不用浏览器。

只用插件和外部组件实现，不改官方代码。

状态：设计和实验阶段，尚无可用版本。

## 文档

- [docs/bridge-plan.md](docs/bridge-plan.md)：桥接方案（传输、部署、按会话分流）。
- [docs/plugin-management.md](docs/plugin-management.md)：插件管理方式，含界面镜像实验结果。
- [docs/panel.md](docs/panel.md)：插件管理面板设计（草案）。

## 实验

- [experiments/mirror](experiments/mirror)：界面镜像。插件只装在 WSL，界面出现在 Desktop 窗口（已在 WSL 内两个 DSH 间验证，DSH 0.2.2-rc.1）。
