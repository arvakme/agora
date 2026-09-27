# 素材库来源调查

调查日期 2026-09-27。许可一律按仓库里实际的 LICENSE 核对（GitHub API `repos/<repo>/license` 取回原文，存进 `licenses/`）。每个来源固定到一个 commit 或 npm 版本，写在 `sources.json`，由 `scripts/libraries/fetch.ts` 抓取、校验并记录每个文件的 sha256，结果在 `manifest.json`。

**判定规则**
- 宽松许可（MIT / Apache-2.0 / ISC / Unlicense / CC0）：打包进仓库，在 `NOTICE.md` 里逐库署名。
- GPL、没有 LICENSE、或明确限制再分发：不打包。
- 纯镜像（内容和官方库重复）：只合并其中的额外名称作为检索关键词，不重复打包。

**表中「收录」列的意思**：去重、过滤之后，真正进入 catalog 的组件数。以下三类组件被过滤：
- 含 image 或 embeddable 元素（库格式里不带图片文件）；
- 元素为空；
- 与已收录组件几何完全相同。

## 已打包

| 来源 | 版本 | 许可 | 库文件 | 组件（原始 → 收录） | 备注 |
|---|---|---|---|---|---|
| [excalidraw/excalidraw-libraries](https://github.com/excalidraw/excalidraw-libraries)（官方） | `297a349` | MIT | 232 | 4187 → 4125 | 过滤掉 48 个含图片的组件和 14 个重复组件。**其中 25 个库（1167 个组件）是厂商产品图标**，见下方「需要留意」 |
| [jonra/excalidrawlib-agentic-flows](https://github.com/jonra/excalidrawlib-agentic-flows) | `f013efa` | MIT | 2 | 60 → 30 | 两个文件互相重复 30 个 |
| [w-gitops/excalidrawLib](https://github.com/w-gitops/excalidrawLib) | `274ab8f` | MIT | 2 | 613 → 7 | 606 个是 image 元素（位图图标），库格式不含图片数据，无法使用 |
| [jorgedlcruz/excalidraw-library](https://github.com/jorgedlcruz/excalidraw-library) | `d15be71` | MIT | 1 | 76 → 0 | 全部已在官方库里 |
| [clainchoupi/excalidrawLib](https://github.com/clainchoupi/excalidrawLib) | `ea013e0` | Apache-2.0 | 1 | 16 → 16 | Apache 许可原文保存在 `licenses/clainchoupi.txt` |
| [jordanbrauer/excalidrawlib](https://github.com/jordanbrauer/excalidrawlib) | `4fd2a77` | Unlicense | 1 | 87 → 86 | |
| [hon668/hvac-excalidraw-library](https://github.com/hon668/hvac-excalidraw-library) | `f1918a1` | MIT | 3 | 48 → 32 | 暖通空调设备 |
| [marcrow/pentest-excalidraw-library](https://github.com/marcrow/pentest-excalidraw-library) | `2f596ff` | MIT | 1 | 90 → 17 | 其余在官方库里 |
| [JustGoscha/excalidraw-libs](https://github.com/JustGoscha/excalidraw-libs) | `d992db1` | CC0-1.0 | 1 | 19 → 19 | 指针与交互手势 |
| [tonac/tonac-excalidraw-library-qa](https://github.com/tonac/tonac-excalidraw-library-qa) | `c124a6a` | MIT | 1 | 1 → 1 | |
| [Lucide](https://lucide.dev)（npm `lucide-static`） | `1.48.0` | ISC | — | 1854 → 1853 | 把 SVG 转成原生 Excalidraw 线条（ellipse / rect / line，path 按曲线采样）；每个图标自成一组；用官方 `tags.json` 作关键词；按首字母分成 25 个库 |

总计：**266 个库，6186 个组件**。打包后 `libraries/` 占 35 MB（`items/` 33 MB，已压缩成单行并把坐标取两位小数；原始 JSON 约 89 MB），git 压缩后约 5 MB。

## 只合并名称（镜像，不打包）

| 来源 | 许可 | 情况 |
|---|---|---|
| [getofferhelp/excalidraw-libraries](https://github.com/getofferhelp/excalidraw-libraries) | MIT | 官方库的中文化镜像，212 个文件。按几何指纹，3539 个组件中有 3228 个与官方完全相同，把中文名合并进这些组件的检索关键词；另外 311 个与官方有差异（改过或旧版本），不收录 |
| [jdebnath21/excalidraw-libraries](https://github.com/jdebnath21/excalidraw-libraries) | MIT | 官方库的子集镜像，647 个组件中 517 个重复；其余 130 个是旧版本，不收录 |

## 不打包

| 来源 | 许可 | 理由 |
|---|---|---|
| [RKrokson/msft-icons-excalidraw](https://github.com/RKrokson/msft-icons-excalidraw) | 仓库 MIT | 仓库本身是 MIT，但内容是 Microsoft / Azure 官方图标的转换版。微软的图标条款只允许在架构图、文档里使用，不允许作为图标集再分发，所以不打包（已记录在 `manifest.json`，未来可以做运行时按需拉取） |
| [thriving-dev/kafka-streams-topology-design](https://github.com/thriving-dev/kafka-streams-topology-design) | GPL-3.0 | GPL，不打包（它的一个版本也在官方库里，见下方「需要留意」） |
| [alexbarbato/excalidraw-tanzu](https://github.com/alexbarbato/excalidraw-tanzu)、[graphia/govuk-excalidraw-library](https://github.com/graphia/govuk-excalidraw-library)、[alexengrig/excalidraw-software-engineer-pack](https://github.com/alexengrig/excalidraw-software-engineer-pack)、[HeyltsTim/Excalidraw_Network_Mapping](https://github.com/HeyltsTim/Excalidraw_Network_Mapping)、[amattas/microsoft-excalidraw](https://github.com/amattas/microsoft-excalidraw)、[Vaibhav0718/modern-prefab](https://github.com/Vaibhav0718/modern-prefab)、[p4087927/excalidraw-icons](https://github.com/p4087927/excalidraw-icons)、[j0rdan-m/all-excalidraw-libraries](https://github.com/j0rdan-m/all-excalidraw-libraries)、Omixxx/oci-excalidraw-library | 无 LICENSE | 没有许可就是保留所有权利，不能再分发（amattas 的内容还是微软图标） |
| [sayyed-glitch/excalidraw-academic-science-assets](https://github.com/sayyed-glitch/excalidraw-academic-science-assets) | 自定义「个人非商业使用」条款 | 明确禁止再分发和商用 |
| [sergey-pronin/excalidraw-threatmodeling](https://github.com/sergey-pronin/excalidraw-threatmodeling) | MIT | 提供的是 `.excalidraw` 场景文件，不是库；要拆成组件得手工分组，本轮跳过 |
| yyueshui/excalidrawlib | — | 空仓库 |
| Tabler Icons（MIT，约 5,000 个）| MIT | 可以用同一个转换器打包，但和 Lucide 大量重叠，还会让体积翻倍；先不收，需要时加进 `sources.json` 的 `icons` 即可 |
| Simple Icons（CC0，约 3,000 个品牌 logo） | CC0（图形），但商标权归各品牌 | 都是实心填充的 logo，转成线条效果差；而且商标使用有各品牌自己的规则。官方库里已有手绘的技术 logo（IT Logos、Software Logos 等） |
| AWS / Azure / GCP 官方架构图标包 | 厂商条款 | AWS 允许客户和合作伙伴用来画架构图；Microsoft 只允许在图、文档、培训材料中使用，不能修改；Google 同样按品牌条款。三家都没有授予「作为图标集随开源项目再分发」的许可，所以不打包原始图标包 |

## 保留决定（2026-09-27 用户确认保留，见 NOTICE.md 的商标声明与 Kafka 说明）

1. **厂商产品图标**：官方库里有 25 个库（1167 个组件）是社区手绘或转换的厂商图标，包括 AWS Architecture / Serverless / Simple Icons、Azure 系列、GCP / Google Icons、Microsoft 365 / Fabric、Oracle OCI、Databricks、Snowflake、VMware / NSX-T 等。它们随官方仓库以 MIT 分发，但图形本身涉及厂商商标。
   - 在 Agora 里用于画架构图，符合各厂商允许的用途。
   - 如果开源发布时想更稳妥，可以在 `sources.json` 里给官方来源加排除清单，把这 25 个库改成按需拉取。
2. **Kafka Streams Topology Design**（`official/hartmut-co-uk/kafka-streams-topology-design`，72 个组件）：作者的独立仓库是 GPL-3.0，而官方库里的这份副本随官方仓库以 MIT 发布。目前按官方仓库的许可收录；发布前建议向作者确认，或者排除它。第四轮的实测里 Agent 就选中了它的「Apache Kafka® Logo」。

## 组件命名覆盖率

catalog 里每个组件都有 `name`，命名方式记在 `how` 字段：

| 方式 | 组件数 | 说明 |
|---|---|---|
| 库自带名称 | 5050 | 来自 `.excalidrawlib` 的 name，Lucide 用图标名 |
| 从组件内部文字推断 | 537 | 取组件里 text 元素的内容 |
| 离线模型打标 | 见 README | `scripts/libraries/label.ts`：先用 Excalidraw 的 `exportToBlob` 渲染成 PNG，再分批让本机 `claude -p` 看图起名、给关键词。结果提交在 `labels.json`，运行时不调用模型 |
