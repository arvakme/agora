Run: `eval/runs/2026-09-27T19-29-27-273Z.jsonl`

基线：每次规划走 `POST /api/canvas/turns` → 一次性 `claude -p --json-schema`，在中性的空临时目录里运行（不继承仓库或项目上下文），不经过 Agent 会话。

| 任务 | 次 | 通过校验 | 新鲜度 | 改对元素 | 误伤 | 撤销还原 | 耗时 s | 花费 | 操作 | 判定依据 |
|---|---|---|---|---|---|---|---|---|---|---|
| T1-rename | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 5.8 | $0.0201 | update_text | label="Redis（通知）" |
| T1-rename | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 5.5 | $0.0032 | update_text | label="Redis（通知）" |
| T1-rename | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 5.8 | $0.0031 | update_text | label="Redis（通知）" |
| T2-add-kimi | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 7.8 | $0.0110 | add_shape add_arrow | kimi=kimi (1230,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T2-add-kimi | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 11.3 | $0.0101 | resize add_shape add_arrow | kimi=kimi (1250,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T2-add-kimi | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 7.1 | $0.0065 | resize add_shape add_arrow | kimi=kimi (1230,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T3-label-arrow | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 3.8 | $0.0076 | update_text | label="WS" |
| T3-label-arrow | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 4.3 | $0.0021 | update_text | label="WS" |
| T3-label-arrow | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 5.6 | $0.0021 | update_text | label="WS" |
| T4-align | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 18.6 | $0.0208 | move move | pg=(520,324) redis=(520,428) aligned=true stacked=true rightOfBackend=true overlap=none |
| T4-align | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 34.4 | $0.0282 | move move | pg=(520,340) redis=(520,444) aligned=true stacked=true rightOfBackend=true overlap=none |
| T4-align | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 25.8 | $0.0204 | move move | pg=(520,330) redis=(520,434) aligned=true stacked=true rightOfBackend=true overlap=none |
| T5-delete-host | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 4.7 | $0.0087 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T5-delete-host | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 5.1 | $0.0031 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T5-delete-host | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 4.5 | $0.0032 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T6-library-kafka | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 23.3 | $0.0281 | insert_library_item add_arrow | libraryInserts=1 kafka=Apache Kafka® Logo (official/hartmut-co-uk/kafka-streams-topology-design#4) rightOfBackend=true linked=true overlap=none minGap=40 caption=dup plainShapes=0 |
| T6-library-kafka | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 19.0 | $0.0203 | insert_library_item add_arrow | libraryInserts=1 kafka=Kafka (official/kvchitrapu/data-sources#1) rightOfBackend=true linked=true overlap=none minGap=69 caption=none plainShapes=0 |
| T6-library-kafka | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 14.5 | $0.0154 | insert_library_item add_arrow | libraryInserts=1 kafka=Kafka (official/kvchitrapu/data-sources#1) rightOfBackend=true linked=true overlap=none minGap=34 caption=none plainShapes=0 |
| T7-plain-todo-box | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 5.8 | $0.0098 | add_shape | libraryInserts=0 todoBox=todo-box below=true overlap=none |
| T7-plain-todo-box | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 6.8 | $0.0035 | add_shape | libraryInserts=0 todoBox=todo below=true overlap=none |
| T7-plain-todo-box | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 6.2 | $0.0038 | add_shape | libraryInserts=0 todoBox=todo below=true overlap=none |

| 任务 | 成功 | 平均耗时 s | 平均花费 |
|---|---|---|---|
| T1-rename | 3/3 | 5.7 | $0.0088 |
| T2-add-kimi | 3/3 | 8.7 | $0.0092 |
| T3-label-arrow | 3/3 | 4.6 | $0.0039 |
| T4-align | 3/3 | 26.2 | $0.0232 |
| T5-delete-host | 3/3 | 4.8 | $0.0050 |
| T6-library-kafka | 3/3 | 18.9 | $0.0213 |
| T7-plain-todo-box | 3/3 | 6.3 | $0.0057 |
| **合计** | **21/21（100%）** | 10.7 | $0.0110（总 $0.2312） |
