# 本机 tmux 宿主

调用方只使用 `Host`：确保会话存在、投递正文、订阅该会话的原生 JSONL 事件、查询 `SessionGate`。契约类型和状态推进来自仓库根上的 `native_protocol`，这里不复制规则。

所有 tmux 操作走本部署 socket 与配置。Unix socket 路径有长度上限，所以 socket 放在 `/tmp/ag-<部署根哈希>.sock`，仍由部署根与名字唯一确定。生成配置先加载用户文件（若提供），再写出基线，因此下列项不能被用户配置覆盖：`destroy-unattached`、`exit-unattached`、`exit-empty`、`set-clipboard`、`assume-paste-time`、`escape-time`。子进程环境去掉 `TMUX` / `TMUX_PANE`，并把 `TERM` 设成具备 clear 能力的值，避免从 dumb 终端继承后无法 attach。正文是自有 buffer 的 bracketed paste，提交键用 `send-keys -c` 指向本进程挂上的可写控制客户端。关闭 `Host` 只放下该客户端，不结束 tmux server。
