import type { Lang } from "../i18n";

export const copy = {
	en: { label: "Main", film: "Film", how: "How it works", features: "Features", start: "Install", home: "Agora home" },
	zh: { label: "主导航", film: "宣传片", how: "怎么工作", features: "核心能力", start: "安装", home: "Agora 首页" },
} satisfies Record<Lang, Record<string, string>>;
