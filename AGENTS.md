# Agora 仓库入口

开始改动或接收工单时，先读[开发协作规则](docs/development.md)，再核对对应 GitHub Issue 的范围、依赖和验收条件。讨论、计划和实现授权分开；工单存在不代表已经获准编码。

## 按任务导航

- 工作台改造：读[目标计划](docs/canvas-workbench-plan.md)。它描述目标；[README](README.md)描述当前可运行能力。
- 原生 CLI 会话控制：契约事实源是 [`native_protocol.py`](native_protocol.py)，顺序、权限、实测结论与后续工单的写入路径见[行为契约](docs/native-control.md)。字段只在代码里定义一次；契约冻结前只有本单执行者写这两个文件。
- 房间、授权和调度：从 `server/` 及[现有设计](docs/design.md)定位；旧设计不要求保留被替代的执行路径。
- 模型执行、BYOA 或云 turn：分别读 [brain](brain/README.md)、[daemon](daemon/README.md)、[k8s](k8s/README.md)；替换时检查所有消费者及对应测试。
- 验证：读[测试入口](docs/testing.md)，按受影响行为选择最窄检查。

GitHub Issue 是任务事实源，Project 和 Seedmux 回执只作投影或证据。不要在本地另建独立任务状态表。
