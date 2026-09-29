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

## 前端

```bash
cd web && npx tsc -p . && npx vitest run && npm run build && npm run eval:replay
```

各功能的规格在 `web/docs/`。

## CI

`.github/workflows/test.yml`：`test` 作业跑全部 Python 测试；`web` 作业跑前端类型检查、单测、构建、素材库校验与离线评测回放。

## 早期房间调度

多 Agent 房间调度（LangGraph、Postgres、Redis、daemon、K8s Job）及其测试、真模型实测记录已删除，产品只剩原生会话一条执行路径。需要查看时读提交 `b6e9789`（删除前的最后一个提交）。
