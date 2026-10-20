import type { Lang } from "../i18n";

// 首屏副标题（lede）不在这里：它取自 README 顶部的标语（repo.ts 的 tagline）
export const copy = {
	en: {
		eyebrow: "One Agora per project",
		title: ["Talk design with your agent", "on the <em>architecture</em> itself."],
		run: "Then, inside any project:",
		github: "View on GitHub",
		readme: "Read the README",
		banner: "Ink-wash night scene: an architecture diagram drawn in the stars above a public square, little figures standing on its nodes",
	},
	zh: {
		eyebrow: "一个项目一个 Agora",
		title: ["和你的 coding agent", "在<em>架构图</em>上谈设计"],
		run: "然后在任何项目目录里：",
		github: "在 GitHub 上查看",
		readme: "阅读 README",
		banner: "墨迹风格的夜景：广场上空的星光连成一张架构图，节点上站着小人",
	},
} satisfies Record<Lang, Record<string, string | string[]>>;
