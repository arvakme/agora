import type { Lang } from "../i18n";

export const copy = {
	en: {
		eyebrow: "How it works",
		title: "It follows the session your CLI <em>already</em> writes.",
		lede: "You talk to your agent in the panel or in the terminal, and it keeps writing its own native session log. This project’s agora server follows that log and pushes every turn to the canvas in your browser.",
		stations: [
			{ name: "Your coding agent", meta: "claude · codex · pi · grok · cursor · devin" },
			{ name: "This project’s agora server", meta: "127.0.0.1 · <project>/.agora/" },
			{ name: "The canvas in your browser", meta: "excalidraw · figures · sub-diagrams" },
		],
		links: [
			{ top: "native session log", bottom: "JSONL, followed every 0.4 s" },
			{ top: "changes pushed live", bottom: "HTTP + SSE" },
		],
		beats: [
			{ title: "You talk, the agent works.", body: "In the panel or in the terminal. It keeps writing its own native session log, exactly as it would without Agora." },
			{ title: "The server follows the log.", body: "Every 0.4 s, this project’s agora server picks up the turns from both sides — the panel’s and the terminal’s." },
			{ title: "The canvas moves.", body: "Changes reach the page over HTTP + SSE. When the agent edits the diagram with <code>agora canvas apply</code>, the page checks schema, references and freshness, writes the result to <code>.agora/</code>, and every batch can be undone." },
		],
		points: [
			{ title: "Nothing leaves your machine.", body: "The server only listens on <code>127.0.0.1</code>, one port per project. Only when you share does a read-only guest entrance open through Cloudflare Tunnel." },
			{ title: "No second copy of the conversation.", body: "Sessions are the CLI’s own. Agora reads the native log; models and billing stay with the CLI you already logged into." },
		],
		agentsTitle: "Six session agents",
		agentsNote: "Each one gets the figure, the progress pointer, station-by-station drawing, panel messages and the same session in the terminal. Two differences come from the CLIs themselves: in <code>-p</code> mode Grok, Cursor and Devin take no input once a turn has started, and Pi and Devin have no native sub-agents.",
		panelAlt: "Terminal-style live panel: Claude Code, Codex and Pi sessions connected to the project's agora server and on to the canvas in the browser, with the session log scrolling underneath",
		panelCaption: "Three agents running turn after turn. Turn counts and turn ids are illustrative; pending → in_flight → accepted → completed are the real states Agora records for each turn.",
	},
	zh: {
		eyebrow: "怎么工作",
		title: "跟着 CLI <em>自己</em>写的会话走",
		lede: "你在面板或终端里跟 agent 说话，它照常写自己的原生会话日志；本项目的 agora 服务跟随日志，把每一轮推到浏览器里的画布上。",
		stations: [
			{ name: "你的 coding agent", meta: "claude · codex · pi · grok · cursor · devin" },
			{ name: "本项目的 agora 服务", meta: "127.0.0.1 · <project>/.agora/" },
			{ name: "浏览器里的画布", meta: "excalidraw · 小人 · 子图" },
		],
		links: [
			{ top: "原生会话日志", bottom: "JSONL · 每 0.4 s 跟随" },
			{ top: "改动实时推到页面", bottom: "HTTP + SSE" },
		],
		beats: [
			{ title: "你说话，agent 干活", body: "在面板或终端里都行。它照常写自己的原生会话日志，和没有 Agora 时一模一样。" },
			{ title: "服务跟着日志走", body: "本项目的 agora 服务每 0.4 秒跟随一次，面板和终端两边的轮次都收得到。" },
			{ title: "画布跟着动", body: "改动经 HTTP + SSE 推到页面。agent 用 <code>agora canvas apply</code> 改图时，页面先校验 schema、引用和新鲜度再执行，结果写回 <code>.agora/</code>，每批修改都能撤销。" },
		],
		points: [
			{ title: "全部在你自己的机器上。", body: "服务只监听 <code>127.0.0.1</code>，一个项目一个端口。只有分享时才经 Cloudflare Tunnel 开一个只读的访客入口。" },
			{ title: "不另存一份对话。", body: "会话就是 CLI 自己的原生会话，Agora 只跟随日志；模型和费用都走你已经登录的那个 CLI。" },
		],
		agentsTitle: "六个会话 agent",
		agentsNote: "都能在画布上看到小人、进度指针和逐站画图，都能在面板发消息、在终端接着同一个会话。两处差别来自 CLI 本身：Grok、Cursor、Devin 的 <code>-p</code> 模式一轮开始后不接收输入；Pi 和 Devin 没有原生子代理。",
		panelAlt: "终端风格的动态面板：Claude Code、Codex、Pi 三个会话连到本项目的 agora 服务，再连到浏览器里的画布；底下的会话日志在滚动",
		panelCaption: "三个 agent 各自一轮一轮地跑。轮次和 turn id 是示意，状态 pending → in_flight → accepted → completed 是 Agora 记录每一轮的真实状态。",
	},
} as const satisfies Record<Lang, unknown>;
