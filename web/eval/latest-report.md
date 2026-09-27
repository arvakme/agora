Run: `/Users/zhijie/Job/agora-wt-workbench/web/eval/runs/2026-09-27T14-23-24-512Z.jsonl`

| 任务 | 次 | 通过校验 | 新鲜度 | 改对元素 | 误伤 | 撤销还原 | 耗时 s | 花费 | 操作 | 判定依据 |
|---|---|---|---|---|---|---|---|---|---|---|
| T1-rename | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 6.1 | $0.0025 | update_text | label="Redis（通知）" |
| T6-library-kafka | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 22.2 | $0.0242 | insert_library_item add_arrow | libraryInserts=1 kafka=Kafka (official/kvchitrapu/data-sources#1) rightOfBackend=true linked=true overlap=none minGap=24 caption=none plainShapes=0 |

| 任务 | 成功 | 平均耗时 s | 平均花费 |
|---|---|---|---|
| T1-rename | 1/1 | 6.1 | $0.0025 |
| T6-library-kafka | 1/1 | 22.2 | $0.0242 |
| **合计** | **2/2（100%）** | 14.1 | $0.0134（总 $0.0267） |
