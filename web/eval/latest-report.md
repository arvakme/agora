Run: `/Users/zhijie/Job/agora-wt-workbench/web/eval/runs/2026-09-27T16-44-58-842Z.jsonl`

| 任务 | 次 | 通过校验 | 新鲜度 | 改对元素 | 误伤 | 撤销还原 | 耗时 s | 花费 | 操作 | 判定依据 |
|---|---|---|---|---|---|---|---|---|---|---|
| T1-rename | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 5.5 | $0.0086 | update_text | label="Redis（通知）" |
| T1-rename | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 5.6 | $0.0031 | update_text | label="Redis（通知）" |
| T1-rename | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 74.0 | $0.0034 | update_text | label="Redis（通知）" |
| T2-add-kimi | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 10.2 | $0.0130 | resize add_shape add_arrow | kimi=kimi (1210,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T2-add-kimi | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 10.4 | $0.0072 | resize add_shape add_arrow | kimi=kimi (1230,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T2-add-kimi | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 9.2 | $0.0068 | add_shape resize add_arrow | kimi=kimi (1210,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T3-label-arrow | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 4.4 | $0.0075 | update_text | label="WS" |
| T3-label-arrow | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 5.6 | $0.0021 | update_text | label="WS" |
| T3-label-arrow | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 4.2 | $0.0020 | update_text | label="WS" |
| T4-align | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 24.8 | $0.0257 | move move | pg=(520,100) redis=(520,340) aligned=true stacked=true rightOfBackend=true overlap=none |
| T4-align | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 25.9 | $0.0213 | move move | pg=(520,340) redis=(520,444) aligned=true stacked=true rightOfBackend=true overlap=none |
| T4-align | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 18.5 | $0.0164 | move move | pg=(520,340) redis=(520,444) aligned=true stacked=true rightOfBackend=true overlap=none |
| T5-delete-host | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 5.2 | $0.0086 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T5-delete-host | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 4.6 | $0.0030 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T5-delete-host | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 4.3 | $0.0032 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T6-library-kafka | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 15.7 | $0.0223 | insert_library_item add_arrow | libraryInserts=1 kafka=Apache Kafka® Logo (official/hartmut-co-uk/kafka-streams-topology-design#4) rightOfBackend=true linked=true overlap=none minGap=40 caption=dup plainShapes=0 |
| T6-library-kafka | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 21.3 | $0.0249 | insert_library_item add_arrow | libraryInserts=1 kafka=Apache Kafka® Logo (official/hartmut-co-uk/kafka-streams-topology-design#4) rightOfBackend=true linked=true overlap=none minGap=19 caption=none plainShapes=0 |
| T6-library-kafka | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 26.0 | $0.0283 | insert_library_item add_arrow | libraryInserts=1 kafka=Apache Kafka® Logo (official/hartmut-co-uk/kafka-streams-topology-design#4) rightOfBackend=true linked=true overlap=none minGap=40 caption=dup plainShapes=0 |
| T7-plain-todo-box | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 22.9 | $0.0239 | add_shape | libraryInserts=0 todoBox=todo below=true overlap=none |
| T7-plain-todo-box | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 10.2 | $0.0074 | add_shape | libraryInserts=0 todoBox=todo-box below=true overlap=none |
| T7-plain-todo-box | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 9.7 | $0.0070 | add_shape | libraryInserts=0 todoBox=todo below=true overlap=none |

| 任务 | 成功 | 平均耗时 s | 平均花费 |
|---|---|---|---|
| T1-rename | 3/3 | 28.4 | $0.0050 |
| T2-add-kimi | 3/3 | 9.9 | $0.0090 |
| T3-label-arrow | 3/3 | 4.7 | $0.0039 |
| T4-align | 3/3 | 23.1 | $0.0211 |
| T5-delete-host | 3/3 | 4.7 | $0.0049 |
| T6-library-kafka | 3/3 | 21.0 | $0.0252 |
| T7-plain-todo-box | 3/3 | 14.3 | $0.0128 |
| **合计** | **21/21（100%）** | 15.2 | $0.0117（总 $0.2457） |
