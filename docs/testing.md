# 测试入口

## Python

```bash
uv sync --frozen
uv run pytest -q tests
```

测试不需要数据库、Redis 或外部服务，也不调用真模型；`tests/fake_*_cli.py` 是假的 agent CLI，`tests/fixtures/` 与 `tests/legacy/` 是适配器 parity 用的录制样本和冻结实现。按改动选窄测，例如画布相关：

```bash
uv run pytest tests/test_project_store.py tests/test_agent_sessions.py tests/test_share.py
```

终端与派发（碰真实 tmux 的用例用独立的 `-L` socket，结束时关掉）：

- `tests/test_pane_state.py`：CLI 在终端里回报状态——`bin/agora-state` 脚本（子 agent 不算、没有服务或会话时静默退出）、三家 CLI 的启动参数、投递闸门的规则；闸门接进服务的部分在 `test_terminal_input.py`（真实 tmux 加假 CLI）。
- `tests/test_terminal_input.py`：输入权、按登记的 pane 和进程判断存活、Codex 从 pane 进程认 rollout、会话环境里没有 `SEEDMUX_*`。
- `tests/test_dispatch_store.py`、`test_dispatch.py`、`test_dispatch_marks.py`、`test_dispatch_api.py`：派发的记录格式（样本 `tests/fixtures/dispatch/sample.json`）、状态流转、重启对账、撤销后迟到的结果、三家日志里的标记、评论经派发贴回线程、`agora dispatch|reply`、运行树里的 `via: "dispatch"`（设计与接口见 [dispatch.md](dispatch.md)）。

## 前端

```bash
cd web && npx tsc -p . && npx vitest run && npm run build && npm run eval:replay
```

各功能的规格在 `web/docs/`。

## 打包与安装

改到 `pyproject.toml`、`hatch_build.py`、`server/paths.py` 或要进包的文件时，在隔离目录里装一遍再在仓库外的项目里跑，不碰全局工具目录：

```bash
uv build                                             # dist/ 下的 sdist 与 wheel；wheel 内 server/_bundle/ 应有 web/dist、web/libraries、web/generated、skills、bin
T=$(mktemp -d)
UV_TOOL_DIR=$T/tools UV_TOOL_BIN_DIR=$T/bin uv tool install dist/agora_canvas-*.whl
cd "$(mktemp -d)" && git init -q
$T/bin/agora up && curl -s "$(python3 -c "import json;print(json.load(open('.agora/run/server.json'))['url'])")" | grep '<title>'
$T/bin/agora status && $T/bin/agora down
```

## CI

`.github/workflows/test.yml`：`test` 作业跑全部 Python 测试；`web` 作业跑前端类型检查、单测、构建、素材库校验与离线评测回放。

## 早期房间调度

多 Agent 房间调度（LangGraph、Postgres、Redis、daemon、K8s Job）及其测试、真模型实测记录已删除，产品只剩原生会话一条执行路径。需要查看时读提交 `b6e9789`（删除前的最后一个提交）。
