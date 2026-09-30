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

- `tests/test_terminal_input.py`：输入权、按登记的 pane 和进程判断存活、Codex 从 pane 进程认 rollout、会话环境里没有 `SEEDMUX_*`。
- `tests/test_dispatch_store.py`、`test_dispatch.py`、`test_dispatch_marks.py`、`test_dispatch_api.py`：派发的记录格式（样本 `tests/fixtures/dispatch/sample.json`）、状态流转、重启对账、撤销后迟到的结果、三家日志里的标记、评论经派发贴回线程、`agora dispatch|reply`、运行树里的 `via: "dispatch"`（设计与接口见 [dispatch.md](dispatch.md)）。

## 前端

```bash
cd web && npx tsc -p . && npx vitest run && npm run build && npm run eval:replay
```

各功能的规格在 `web/docs/`。

## CI

`.github/workflows/test.yml`：`test` 作业跑全部 Python 测试；`web` 作业跑前端类型检查、单测、构建、素材库校验与离线评测回放。

## 早期房间调度

多 Agent 房间调度（LangGraph、Postgres、Redis、daemon、K8s Job）及其测试、真模型实测记录已删除，产品只剩原生会话一条执行路径。需要查看时读提交 `b6e9789`（删除前的最后一个提交）。
