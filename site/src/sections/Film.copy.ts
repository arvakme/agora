import type { Lang } from "../i18n";

// 宣传片本身的源文件在 docs/promo/；这里只有区块标题、说明和播放控件的无障碍文字
export const copy = {
	en: {
		eyebrow: "Film · 40 s",
		title: "Agora in forty seconds.",
		lede: "An agent draws the architecture station by station, its little figure walking from node to node. Zoom into a node and you are inside its sub-diagram.",
		videoLabel: "Agora promo film: an agent draws an architecture diagram station by station, then zooming into a node opens its sub-diagram",
		play: "Play with sound",
		missing: "The film isn't bundled in this build — watch it on GitHub.",
		watch: "Watch on GitHub",
	},
	zh: {
		eyebrow: "宣传片 · 40 秒",
		title: "四十秒看懂 Agora",
		lede: "agent 一站一站画出架构图，它的小人从一个节点走到下一个节点；放大节点，就进到它的子图里。",
		videoLabel: "Agora 宣传片：agent 一站一站画出架构图，放大节点进到子图",
		play: "有声播放",
		missing: "这次构建没有带上宣传片，可以到 GitHub 上看。",
		watch: "在 GitHub 上看",
	},
} satisfies Record<Lang, Record<string, string>>;
