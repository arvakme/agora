Run: `/Users/zhijie/Job/agora-wt-workbench/web/eval/runs/2026-09-27T17-45-40-073Z.jsonl`

| 任务 | 次 | 通过校验 | 新鲜度 | 改对元素 | 误伤 | 撤销还原 | 耗时 s | 花费 | 操作 | 判定依据 |
|---|---|---|---|---|---|---|---|---|---|---|
| T1-rename | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 6.0 | $0.0092 | update_text | label="Redis（通知）" |
| T1-rename | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 6.3 | $0.0036 | update_text | label="Redis（通知）" |
| T1-rename | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 5.7 | $0.0033 | update_text | label="Redis（通知）" |
| T2-add-kimi | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 7.9 | $0.0107 | add_shape add_arrow | kimi=kimi (1210,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T2-add-kimi | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 60.6 | $0.0049 | add_shape add_arrow | kimi=kimi (1230,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T2-add-kimi | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 9.6 | $0.0075 | add_shape resize add_arrow | kimi=kimi (1210,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T3-label-arrow | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 4.0 | $0.0079 | update_text | label="WS" |
| T3-label-arrow | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 4.5 | $0.0021 | update_text | label="WS" |
| T3-label-arrow | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 4.8 | $0.0021 | update_text | label="WS" |
| T4-align | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 21.1 | $0.0231 | move move | pg=(560,350) redis=(560,454) aligned=true stacked=true rightOfBackend=true overlap=none |
| T4-align | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 31.4 | $0.0247 | move move | pg=(520,330) redis=(520,434) aligned=true stacked=true rightOfBackend=true overlap=none |
| T4-align | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 19.9 | $0.0147 | move move | pg=(520,324) redis=(520,428) aligned=true stacked=true rightOfBackend=true overlap=none |
| T5-delete-host | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 4.3 | $0.0086 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T5-delete-host | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 5.0 | $0.0031 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T5-delete-host | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 6.3 | $0.0033 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T6-library-kafka | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 27.7 | $0.0353 | insert_library_item add_arrow | libraryInserts=1 kafka=Apache Kafka® Logo (official/hartmut-co-uk/kafka-streams-topology-design#4) rightOfBackend=true linked=true overlap=none minGap=30 caption=none plainShapes=0 |
| T6-library-kafka | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 145.1 | $0.0305 | insert_library_item add_arrow | libraryInserts=1 kafka=Kafka (official/kvchitrapu/data-sources#1) rightOfBackend=true linked=true overlap=none minGap=39 caption=none plainShapes=0 |
| T6-library-kafka | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 18.1 | $0.0192 | insert_library_item add_arrow | libraryInserts=1 kafka=Kafka (official/kvchitrapu/data-sources#1) rightOfBackend=true linked=true overlap=none minGap=45 caption=none plainShapes=0 |
| T7-plain-todo-box | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 14.8 | $0.0175 | add_shape add_arrow | libraryInserts=0 todoBox=todo below=true overlap=none |
| T7-plain-todo-box | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 16.6 | $0.0137 | add_shape add_arrow | libraryInserts=0 todoBox=todo below=true overlap=none |
| T7-plain-todo-box | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 15.6 | $0.0131 | add_shape | libraryInserts=0 todoBox=todo below=true overlap=none |

| 任务 | 成功 | 平均耗时 s | 平均花费 |
|---|---|---|---|
| T1-rename | 3/3 | 6.0 | $0.0053 |
| T2-add-kimi | 3/3 | 26.0 | $0.0077 |
| T3-label-arrow | 3/3 | 4.4 | $0.0040 |
| T4-align | 3/3 | 24.1 | $0.0208 |
| T5-delete-host | 3/3 | 5.2 | $0.0050 |
| T6-library-kafka | 3/3 | 63.6 | $0.0283 |
| T7-plain-todo-box | 3/3 | 15.7 | $0.0148 |
| **合计** | **21/21（100%）** | 20.7 | $0.0123（总 $0.2581） |
