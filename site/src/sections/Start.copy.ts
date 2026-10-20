import type { Lang } from "../i18n";

// 命令、依赖与限制都来自 README 的「快速开始」与「限制」
export const copy = {
	en: {
		eyebrow: "Get started",
		title: "Install once. Open it in <em>any</em> project.",
		lede: "No need to keep the repository around. The install builds the web UI, so it needs Node and npm.",
		commands: [
			["cd ~/code/my-service", ""],
			["agora", "set up .agora/, start this project's server, open the browser"],
			["agora status", "address, port and pid if it's running"],
			["agora down", "stop the server and this project's tmux"],
			["agora share create --for 1d", "a read-only link for a day"],
		],
		needsTitle: "You’ll need",
		needs: [
			"<a href=\"https://docs.astral.sh/uv/\">uv</a> (Python 3.12+; uv installs it if missing)",
			"Node 22+ and npm, to build the front end",
			"tmux, for “Open in terminal”",
			"At least one logged-in agent CLI: <code>pi</code>, <code>claude</code>, <code>codex</code>, <code>grok</code>, <code>cursor-agent</code> or <code>devin</code>",
			"Optional, for sharing: <code>cf</code> and your own Cloudflare domain",
		],
		limitsTitle: "Good to know",
		limits: [
			"Single editor — no real-time multi-user editing. Conflicts are caught by version checks.",
			"Changing the diagram needs the page open; without it <code>agora canvas apply</code> exits with code 3.",
			"Only tested on macOS. Without Ghostty, Kitty or Terminal.app the panel gives you a <code>tmux attach</code> command instead.",
			"Not on PyPI yet. The package is <code>agora-canvas</code>; the command is <code>agora</code>.",
		],
		github: "Star it on GitHub",
		readme: "Read the full README",
	},
	zh: {
		eyebrow: "开始用",
		title: "装一次，<em>任何</em>项目里都能打开",
		lede: "不需要留着仓库。安装时会构建前端，所以需要 Node 和 npm。",
		commands: [
			["cd ~/code/my-service", ""],
			["agora", "初始化 .agora/，起本项目服务并打开浏览器"],
			["agora status", "在跑就打印地址、端口、pid"],
			["agora down", "停掉服务和本项目的 tmux"],
			["agora share create --for 1d", "开一个一天有效的只读地址"],
		],
		needsTitle: "需要",
		needs: [
			"<a href=\"https://docs.astral.sh/uv/\">uv</a>（Python 3.12+，没有时 uv 自己装）",
			"Node 22+ 与 npm，用来构建前端",
			"tmux，用于「在终端打开」",
			"至少一个已登录的 agent CLI：<code>pi</code>、<code>claude</code>、<code>codex</code>、<code>grok</code>、<code>cursor-agent</code> 或 <code>devin</code>",
			"可选，分享用：<code>cf</code> 和你自己的 Cloudflare 域名",
		],
		limitsTitle: "先说清楚",
		limits: [
			"单人编辑，没有实时多人协同；冲突靠版本校验发现。",
			"改图需要打开着的页面；没开页面时 <code>agora canvas apply</code> 返回退出码 3。",
			"只在 macOS 上实测过。没有 Ghostty、Kitty 或 Terminal.app 时，面板给出 <code>tmux attach</code> 命令。",
			"还没有发布到 PyPI。包名是 <code>agora-canvas</code>，命令名是 <code>agora</code>。",
		],
		github: "在 GitHub 上加星",
		readme: "阅读完整 README",
	},
} as const satisfies Record<Lang, unknown>;
