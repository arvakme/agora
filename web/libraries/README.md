# 内置素材库

Agora 自带的 Excalidraw 组件库：官方 excalidraw-libraries 全量、若干宽松许可的社区库，以及 Lucide 图标（已转成原生线条）。来源和许可结论见 [SOURCES.md](SOURCES.md)，逐库署名见 [NOTICE.md](NOTICE.md)，许可原文在 `licenses/`。

## 文件

| 文件 | 内容 |
|---|---|
| `sources.json` | 来源清单，唯一的手工输入：每个来源固定 commit 或 npm 版本，并标明是否打包 |
| `items/**.json` | 每个库一份组件文件（元素 JSON，已规整、去重） |
| `catalog.json` | 检索索引：库清单，以及每个组件的 id / 名称 / 命名方式 / 关键词 / 尺寸 / 元素数。**搜索服务只读这份** |
| `labels.json` | 离线模型打标的结果（id → 名称 + 关键词），会合并进 catalog |
| `manifest.json` | 抓取记录：各来源的 ref、文件 sha256、各来源的统计、命名覆盖率、产物指纹 |
| `NOTICE.md`、`licenses/` | 署名和许可原文（生成） |

## 重建

```bash
npm run libraries:fetch             # 按 sources.json 抓取、校验许可、规整、去重、建索引（下载缓存在 .cache/libraries）
npm run libraries:fetch -- --check  # 核对 items/ 是否仍与 manifest 记录的指纹一致
```

## 给无名组件打标（一次性）

1. `npm run dev`，打开任意页面，用 Excalidraw 的 `exportToBlob` 把 `catalog.json` 里 `how === "none"` 的组件渲染成 PNG。每个 PNG 的 id 和所属库名写进同目录的 `meta.json`（本轮用 Ego 浏览器脚本完成）。
2. `node scripts/libraries/label.ts <png 目录>`：每批 30 张交给本机 `claude -p`（只开放 Read 工具，按 JSON schema 输出），结果合并进 `labels.json`。
3. 再跑一次 `npm run libraries:fetch`，把名称并入 catalog。

## 运行时

- **服务**（dev server 中间件，`server/library.ts`）：
  - `GET /api/library/search?q=&limit=`
  - `GET /api/library/item?id=`
  - `GET /api/library/libs`
- **Agent**：`claude -p` 通过 MCP 工具 `search_library` 检索（`server/library-mcp.ts`），只拿到前 N 个候选，整份目录不进上下文。插入走类型化操作 `insert_library_item`，由浏览器校验并执行，和其他 6 种操作一样整批可撤销。
- **画布**：
  - 侧栏的「素材」tab 支持按来源浏览、搜索、点击插入。
  - Excalidraw 自带的 Library tab 会预装全部组件：某个画布第一次打开 Library 时才装入（约 0.8 秒），抓取结果由所有画布共享。
