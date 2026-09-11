# agora_ask：第一条端到端原生问答链路

`agora_ask` 是本地自用的最小命令行入口：在专属 tmux 里复用或启动一个 Codex CLI 会话，把问题投递进去，订阅该会话自己的原生 JSONL 记录，等这一轮真正结束，并把终态与回答写入 PostgreSQL。

## 前置条件

- `tmux` 已安装并在 PATH 中
- PostgreSQL 已按 [测试文档](testing.md) 起好（`docker compose up -d --wait`）
- 设置 `AGORA_DATABASE_URL`（默认 `postgresql://agora:agora@127.0.0.1:5433/agora`）
- 真 Codex 时：`codex` 在 PATH 中，且本机已有 Codex 配置

投递记录会写入 `delivery_records` 表（与 `server/delivery.py` 共用 schema）。若与其他工作树并行开发，建议把库名改成 `agora_delivery`，见测试文档 §1。

## 怎么用

```bash
docker compose up -d --wait
export AGORA_DATABASE_URL=postgresql://agora:agora@127.0.0.1:5433/agora
uv run python -m agora_ask "帮我看看这段代码有没有问题"
```

常用环境变量：

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `AGORA_DATABASE_URL` | 投递记录库 | `postgresql://agora:agora@127.0.0.1:5433/agora` |
| `AGORA_ASK_HOST_ROOT` | 宿主状态目录 | `~/.agora/host` |
| `AGORA_ASK_DEPLOYMENT` | 部署名 | `local` |
| `AGORA_ASK_SESSION_NAME` | tmux 会话名 | `codex` |
| `AGORA_ASK_CODEX_COMMAND` | 启动命令 | `codex` |
| `AGORA_ASK_CWD` | 会话工作目录 | 当前目录 |
| `AGORA_ASK_TIMEOUT_S` | 等待原生终态超时（秒） | `600` |

第二次问同一个问题时，会复用 `AGORA_ASK_SESSION_NAME` 对应的 tmux 会话，不会每次新建。

## Codex 原生日志怎么发现

Codex 把每个会话写在 `~/.codex/sessions/**/rollout-<thread-id>.jsonl`。新会话的 thread id 事先不知道，因此 `host/codex.py` 在 tmux pane 起来之后，从**该 pane 进程自己打开的文件**里找 rollout 路径（macOS 用 `lsof`，Linux 读 `/proc/<pid>/fd`），不扫描目录、不按修改时间猜。

发现后把路径和 thread id 记入宿主 `sessions.json`，后续复用同一会话时直接读回。

## 现在能做什么 / 不能做什么

**能做：**

- 单会话、单次投递、等原生 `input_accepted` → `execution_completed`/`execution_failed`
- 投递全程落库（`start` → `hand_off` → `apply`）
- 门控挡住、会话消失、超时如实报错退出

**还不能做（留给后续工单）：**

- HTTP API、画布、多会话并发、人工接管与归还
- 权限弹窗自动处理（遇到 `permission_wait` 会报错退出）
- 生产级完备性与跨平台 rollout 发现验证（目前 macOS/Linux 接缝已写，真 Codex 端到端由指挥官实测）

## 自测

集成测试用 `tests/fake_native_cli.py` 替身，不启动真 Codex：

```bash
docker compose up -d --wait
uv run pytest tests/test_agora_ask.py tests/test_codex_discovery.py -q
```

全量 mock 套件：

```bash
uv run pytest -m "not llm" -q
```
