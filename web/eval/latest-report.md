Run: `/Users/zhijie/Job/agora-wt-workbench/web/eval/runs/2026-09-27T15-15-28-455Z.jsonl`

| 任务 | 次 | 通过校验 | 新鲜度 | 改对元素 | 误伤 | 撤销还原 | 耗时 s | 花费 | 操作 | 判定依据 |
|---|---|---|---|---|---|---|---|---|---|---|
| T1-rename | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 6.4 | $0.0097 | update_text | label="Redis（通知）" |
| T1-rename | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 5.0 | $0.0032 | update_text | label="Redis（通知）" |
| T1-rename | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 8.3 | $0.0031 | update_text | label="Redis（通知）" |
| T2-add-kimi | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 7.9 | $0.0115 | resize add_shape add_arrow | kimi=kimi (1230,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T2-add-kimi | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 11.9 | $0.0051 | resize add_shape add_arrow | kimi=kimi (1230,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T2-add-kimi | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 9.3 | $0.0072 | resize add_shape add_arrow | kimi=kimi (1210,410) sideBySide=true pi→kimi=true inTmux=true overlap=none |
| T3-label-arrow | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 6.4 | $0.0076 | update_text | label="WS" |
| T3-label-arrow | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 5.2 | $0.0020 | update_text | label="WS" |
| T3-label-arrow | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 4.2 | $0.0021 | update_text | label="WS" |
| T4-align | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 11.7 | $0.0140 | move move | pg=(520,400) redis=(520,504) aligned=true stacked=true rightOfBackend=true overlap=none |
| T4-align | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 20.2 | $0.0175 | move move | pg=(520,330) redis=(520,434) aligned=true stacked=true rightOfBackend=true overlap=none |
| T4-align | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 17.8 | $0.0148 | move move | pg=(520,330) redis=(520,434) aligned=true stacked=true rightOfBackend=true overlap=none |
| T5-delete-host | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 5.4 | $0.0086 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T5-delete-host | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 5.3 | $0.0032 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T5-delete-host | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 5.1 | $0.0031 | delete delete delete add_arrow | hostDeleted=true backend↔pi=true dangling=none |
| T6-library-kafka | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 22.3 | $0.0277 | insert_library_item add_arrow | libraryInserts=1 kafka=Kafka (official/pclainchard/it-logos#10) rightOfBackend=true linked=true overlap=none minGap=40 caption=none plainShapes=0 |
| T6-library-kafka | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 35.9 | $0.0378 | insert_library_item add_arrow | libraryInserts=1 kafka=Apache Kafka® Logo (official/hartmut-co-uk/kafka-streams-topology-design#4) rightOfBackend=true linked=true overlap=none minGap=16 caption=none plainShapes=0 |
| T6-library-kafka | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 16.4 | $0.0184 | insert_library_item add_arrow | libraryInserts=1 kafka=Kafka (official/pclainchard/it-logos#10) rightOfBackend=true linked=true overlap=none minGap=17 caption=none plainShapes=0 |
| T7-plain-todo-box | 1 | ✓ | ✓ | ✓ | 无 | ✓ | 12.5 | $0.0158 | add_shape | libraryInserts=0 todoBox=todo below=true overlap=none |
| T7-plain-todo-box | 2 | ✓ | ✓ | ✓ | 无 | ✓ | 5.2 | $0.0034 | add_shape | libraryInserts=0 todoBox=todo-box below=true overlap=none |
| T7-plain-todo-box | 3 | ✓ | ✓ | ✓ | 无 | ✓ | 12.2 | $0.0093 | add_shape | libraryInserts=0 todoBox=todo-box below=true overlap=none |

| 任务 | 成功 | 平均耗时 s | 平均花费 |
|---|---|---|---|
| T1-rename | 3/3 | 6.5 | $0.0053 |
| T2-add-kimi | 3/3 | 9.7 | $0.0080 |
| T3-label-arrow | 3/3 | 5.3 | $0.0039 |
| T4-align | 3/3 | 16.6 | $0.0154 |
| T5-delete-host | 3/3 | 5.3 | $0.0050 |
| T6-library-kafka | 3/3 | 24.8 | $0.0280 |
| T7-plain-todo-box | 3/3 | 10.0 | $0.0095 |
| **合计** | **21/21（100%）** | 11.2 | $0.0107（总 $0.2251） |
