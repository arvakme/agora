import type { Lang } from "../i18n";

// 每条都能在 README 或 web/docs/ 里找到出处（注释里写着），不写仓库里没有的能力
export const copy = {
	en: {
		eyebrow: "What you get",
		title: "A canvas that knows <em>who</em> is working <em>where</em>.",
		rows: [
			{
				// README §1；web/docs/project-storage.md
				kicker: "01 · Per project",
				title: "One Agora per project. The diagram travels with the code.",
				body: [
					"Run <code>agora</code> in a project and it sets up <code>.agora/</code> right there, with its own local server. Canvases are plain <code>.excalidraw</code> files and comments are JSON with sorted keys, so they commit, clone and branch with your code — and the diffs stay readable.",
					"Session records, runtime state and share records stay out of git by default. Deleted canvases and sessions sit in a trash for 30 days.",
				],
				alt: "Agora with the architecture canvas and comment pins on the left and a Claude Code session on the right",
			},
			{
				// web/docs/workstation.md「分站揭示」
				kicker: "02 · Station by station",
				title: "Watch it draw, one station at a time.",
				body: [
					"When an agent changes the diagram, its little figure walks to each spot and the new elements fade in as it arrives — the diagram doesn’t pop into existence all at once, and you can follow what it is building.",
				],
				alt: "Pi draws an architecture diagram: its figure walks from node to node and each new box and arrow appears as it arrives",
			},
			{
				// web/docs/nested-canvas.md
				kicker: "03 · Sub-diagrams",
				title: "Zoom into a node. Step inside.",
				body: [
					"Any node can hold a sub-diagram: overview › backend › order service. ⌘/Ctrl + scroll into a node and you land inside it; zoom out to climb back. Breadcrumbs and ⌘↑ work too.",
				],
				alt: "Scrolling into a node opens its sub-diagram, with breadcrumbs back to the parent",
			},
			{
				// README §4；web/docs/progress-pointer.md、multi-agent.md
				kicker: "04 · Progress pointers",
				title: "See which part of the architecture the AI is changing.",
				body: [
					"Attach code paths (globs) to nodes — by hand, or let the agent map them from the directory layout. When the agent edits a file, its figure walks to the node that file belongs to: gliding along an arrow when the two nodes are connected, hopping across when they aren’t. Edits made in the terminal move it too.",
					"Several sessions get one pointer each, and Agora flags a possible conflict when two agents touch the same file.",
				],
				alt: "Claude Code and Pi each have a pointer; as they edit files, their figures move to the matching nodes, gliding along arrows or hopping across",
			},
			{
				// README §5；web/docs/share-build-replay.md
				kicker: "05 · Trajectory & replay",
				title: "Every turn, every tool call — step by step.",
				body: [
					"Switch a session between Conversation and Trajectory. Each turn shows model, effort, input / output / cache tokens, time and cost on a timeline; every tool call expands to its full input, output, the files it touched and when it ran.",
					"And the diagram itself can be replayed: from the first stroke to now, the figures walking to where they drew, with play, pause, speed and a scrubber.",
				],
				alt: "Trajectory view with a timeline, per-turn usage and an expanded Edit call showing its full input",
			},
		],
		cards: [
			{
				// README §2；web/docs/agent-sessions.md
				title: "Your own agent, locked per session",
				body: "Pick the agent, model and effort when a session starts; they stay fixed. Hand a canvas comment to the agent and its reply is posted back into the thread. The <code>agora</code> skill is installed for that agent automatically.",
				alt: "New session dialog: choose an agent, model and effort, which can't be changed afterwards",
			},
			{
				// README §3
				title: "Back to the terminal in one click",
				body: "“Open in terminal” resumes the very same native session (<code>claude --resume</code>, <code>codex resume</code>, <code>pi --session-id</code>) in a project-scoped tmux, in Ghostty, Kitty or Terminal.app. What happens in the terminal shows up in the panel, and panel messages queue until the terminal is free.",
				alt: "Terminal taken over: the panel shows the tmux attach command while the conversation keeps syncing",
			},
		],
		share: {
			// README §6；web/docs/sharing.md
			title: "Share read-only. Collect comments.",
			body: "<code>agora share create --for 1d</code> opens a subdomain on your own Cloudflare zone through Cloudflare Tunnel. Guests can view the diagram and read, write and reply to comments — editing, sessions, terminal, code paths and local paths are never sent. When it expires or you revoke it, the DNS record and tunnel are removed. No account? <code>--quick</code> gives a temporary trycloudflare.com address.",
			author: "Author: pick a canvas and how long",
			guest: "Guest: read-only canvas, comments allowed",
			altAuthor: "Share popover: choose a canvas and an expiry",
			altGuest: "Guest page: read-only canvas with comments",
		},
		uiNote: "Screenshots and recordings show Agora’s interface in Chinese.",
		play: "Play recording",
		pause: "Pause recording",
	},
	zh: {
		eyebrow: "核心能力",
		title: "一张知道<em>谁</em>在改<em>哪里</em>的架构图",
		rows: [
			{
				kicker: "01 · 一个项目一个",
				title: "一个项目一个 Agora，图跟着代码走",
				body: [
					"在项目里敲 <code>agora</code>，就在当前目录建好 <code>.agora/</code>，起本项目专属的本地服务。画布是标准 <code>.excalidraw</code> 文件，评论是键排序的 JSON：跟代码一起提交、克隆、切分支，git diff 可读。",
					"会话记录、运行状态和分享记录默认不提交。删掉的画布和会话进回收站，30 天内可恢复。",
				],
				alt: "画布与会话并排：左边是项目的架构图和评论钉，右边是 Claude Code 会话",
			},
			{
				kicker: "02 · 逐站画图",
				title: "一站一站画出来",
				body: ["agent 改图时，它的小人走到每一站，新加的元素等它走到才淡入，不是整张图一下冒出来；你看得清它在搭什么。"],
				alt: "Pi 画出架构图：小人从一个节点走到下一个，每个新方框和箭头在它走到时出现",
			},
			{
				kicker: "03 · 子图",
				title: "放大节点，走进子图",
				body: ["任何节点都能装一张子图：总架构 › 后端 › 订单服务。⌘ / Ctrl + 滚轮放大节点就进到子图，缩小就回到上一层；面包屑和 ⌘↑ 也行。"],
				alt: "滚轮放大节点进到子图，面包屑可以回到上一层",
			},
			{
				kicker: "04 · 进度指针",
				title: "看得见 AI 正在改架构图的哪一块",
				body: [
					"给节点关联代码路径（glob），可以手动设，也可以让 agent 按目录结构批量关联。agent 改哪个文件，它的小人就走到这个文件所属的节点：两个节点有箭头相连就沿箭头滑过去，否则跳过去。终端里的改动同样驱动它。",
					"几个会话各有一个指针；两个 agent 改到同一个文件时，Agora 会提示可能冲突。",
				],
				alt: "Claude Code 和 Pi 各有一个指针：改到哪个文件，小人就沿箭头滑过去或跳到对应的节点",
			},
			{
				kicker: "05 · 轨迹与回放",
				title: "每一轮、每一次工具调用，逐步可查",
				body: [
					"会话有「对话 / 轨迹」两种视图：每轮的模型、强度、输入 / 输出 / 缓存 tokens、耗时、花费排在时间轴上；每次工具调用都能展开看完整输入、输出、改到的文件和起止时间。",
					"架构图本身也能回放：从第一笔到现在，小人走到它画的地方，可以播放、暂停、倍速、拖进度条。",
				],
				alt: "轨迹视图：时间轴、每轮用量，展开的 Edit 调用显示完整输入",
			},
		],
		cards: [
			{
				title: "你自己的 agent，会话锁定",
				body: "每个会话开始时选 agent、模型和强度，选定后不变。画布上的评论可以直接交给 agent，答复贴回评论线程。绑定会话时自动为它安装 <code>agora</code> skill。",
				alt: "新会话先选 agent、模型和强度，选定后不能更改",
			},
			{
				title: "一键回到终端，双向同步",
				body: "「在终端打开」用同一个原生会话起交互式 CLI（<code>claude --resume</code>、<code>codex resume</code>、<code>pi --session-id</code>），跑在本项目专属的 tmux 里，用 Ghostty、Kitty 或 Terminal.app 打开。终端里发生的事都出现在面板上；面板发的消息排队，等终端空下来再送进去。",
				alt: "终端已接管：面板显示 tmux attach 命令，对话继续同步",
			},
		],
		share: {
			title: "分享出去，只读、可评论",
			body: "<code>agora share create --for 1d</code> 经 Cloudflare Tunnel 在你自己的 Cloudflare 域名下开一个子域名。访客能看图、读评论、发评论和回复；改图、会话、终端、代码路径和本地路径都不下发。到期或撤销后，DNS 记录和隧道一起删除。没有账号也行：<code>--quick</code> 开一个临时 trycloudflare.com 地址。",
			author: "作者：选画布和有效期",
			guest: "访客：只读画布，可评论",
			altAuthor: "分享弹层：选画布和有效期",
			altGuest: "访客页：只读画布，可评论",
		},
		uiNote: "",
		play: "播放录屏",
		pause: "暂停录屏",
	},
} as const satisfies Record<Lang, unknown>;
