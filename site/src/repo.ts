import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, blob, type Lang } from "./i18n";

// 构建期从仓库读的事实。标语只来自 README 顶部 <b> 那一行：英文取 README.md，中文取 README.zh-CN.md；
// 找不到就让构建失败，不拿旧文案顶上。Astro 构建时的工作目录是 site/，仓库根在上一级
const root = join(process.cwd(), "..");
export const readmeFile = (lang: Lang) => (lang === "zh" ? "README.zh-CN.md" : "README.md");
const readme = (lang: Lang) => readFileSync(join(root, readmeFile(lang)), "utf8");

export function tagline(lang: Lang) {
	const match = readme(lang).match(/<p align="center"><b>(.*?)<\/b><\/p>/s);
	if (!match) throw new Error(`${readmeFile(lang)}：找不到 <p align="center"><b>…</b></p> 标语`);
	return match[1].trim();
}

/** 给 Agent 读的 Markdown：README 原文，相对链接改成 GitHub 上的绝对地址 */
export function readmeMarkdown(lang: Lang) {
	return readme(lang)
		.replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, path: string) => `](${blob(path)})`)
		.replace(/src="(?!https?:)([^"]+)"/g, (_, path: string) => `src="${REPO}/raw/main/${path}"`);
}

export function llmsTxt(home: URL) {
	return `# Agora

> ${tagline("en")}

Install with \`uv tool install git+https://github.com/arvakme/agora\`, then run \`agora\` inside a project directory. Needs uv, Node 22+ and npm (the install builds the web UI), tmux, and at least one logged-in agent CLI (pi, claude, codex, grok, cursor-agent or devin). Only tested on macOS.

## Docs

- [README](${new URL("index.md", home)}): what Agora does, install, sharing, limits
- [README (简体中文)](${new URL("zh/index.md", home)})
- [Agent sessions](${blob("web/docs/agent-sessions.md")})
- [Progress pointer](${blob("web/docs/progress-pointer.md")})
- [Nested canvases](${blob("web/docs/nested-canvas.md")})
- [Sharing](${blob("web/docs/sharing.md")})

## Optional

- [Source code](${REPO})
`;
}

export const markdown = (text: string) => new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
