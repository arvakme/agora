export type Lang = "en" | "zh";

export const REPO = "https://github.com/arvakme/agora";
export const INSTALL = "uv tool install git+https://github.com/arvakme/agora";

/** 站内路径一律经过它，才能同时适配 /agora/ 前缀和自定义域名的根路径 */
export const href = (path: string) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;

/** 链到仓库里的文件：README、docs/ 下的规格 */
export const blob = (path: string) => `${REPO}/blob/main/${path}`;

// 页面级共享文案；各区块自己的文案放在 sections/<名字>.copy.ts，结构与这里相同。
// 标语不在这里：它只来自 README（见 repo.ts）
export const site = {
	en: {
		tag: "en",
		ogLocale: "en_US",
		title: "Agora — an architecture canvas for your coding agent",
		copy: "Copy install command",
		copied: "Copied",
		copyFailed: "Couldn't copy — select the command instead",
		switchLabel: "中文",
		switchTitle: "阅读中文版",
		home: "/",
		skip: "Skip to content",
	},
	zh: {
		tag: "zh-CN",
		ogLocale: "zh_CN",
		title: "Agora：在项目的架构图上和你的 coding agent 讨论设计",
		copy: "复制安装命令",
		copied: "已复制",
		copyFailed: "复制失败，请手动选中命令",
		switchLabel: "EN",
		switchTitle: "Read in English",
		home: "/zh/",
		skip: "跳到正文",
	},
} satisfies Record<Lang, Record<string, string>>;

export const other = (lang: Lang): Lang => (lang === "en" ? "zh" : "en");
