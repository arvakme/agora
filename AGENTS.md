# Agora 仓库入口

开始改动前先读[开发约定](docs/development.md)。

## 按任务导航

- 工作台改造：读[目标计划](docs/canvas-workbench-plan.md)。它描述目标；[README](README.md)描述当前可运行能力。
- 原生 CLI 会话控制：契约事实源是 [`native_protocol.py`](native_protocol.py)，顺序、权限、实测结论与未解决项见[行为契约](docs/native-control.md)。字段只在代码里定义一次。
- 早期房间调度（LangGraph、Postgres、Redis、daemon、K8s）已删除；产品只剩原生会话一条执行路径。
- 打包与安装：前端、素材库、skill、`bin/` 等非 Python 文件只经 [`server/paths.py`](server/paths.py) 定位（源码是仓库根，安装后是包内 `server/_bundle/`）；wheel 由 [`hatch_build.py`](hatch_build.py) 组装。
- 验证：读[测试入口](docs/testing.md)，按受影响行为选择最窄检查。
