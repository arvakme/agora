// 全站唯一的动效引擎：不引动画库，只用 IntersectionObserver、一个 rAF 节流的滚动循环和 CSS。
//
// - 入场（一次性）：带 data-reveal 的元素进入视口时加上 .in，由 global.css 里的过渡把它升起、淡入
//   （同一批进入的按 DOM 顺序错开 90 ms）。种类见 global.css 的 [data-reveal=…]。
// - 离场（跟着滚动）：这些元素的下沿接近导航条时，按距离把 --out 从 0 推到 1：淡出、轻微上移和模糊，
//   往回滚就原路回来。学的是 firecode 首屏文字随滚动淡出、模糊的做法，推广到每个区块。
// - 场景：区块可以用 scene() 登记自己的滚动函数（首屏视差、宣传片放大、怎么工作那一幕的钉住推进）。
//   每帧先读完所有位置再统一写，不在循环里交替读写，免得强制重排。
//
// 减少动效时（<html> 没有 .motion，由 Landing 头部的内联脚本按 prefers-reduced-motion 决定）以上都不启用：
// 元素一开始就在原位，没有任何跟着滚动的变化。

export const motion = document.documentElement.classList.contains("motion");

type Scene = (rect: DOMRect, viewport: number) => void;
const scenes: { el: Element; run: Scene }[] = [];
let queued = false;

function frame() {
	queued = false;
	const viewport = innerHeight;
	const rects = scenes.map(({ el }) => el.getBoundingClientRect());
	scenes.forEach(({ run }, i) => run(rects[i], viewport));
}

const schedule = () => {
	if (queued) return;
	queued = true;
	requestAnimationFrame(frame);
};

/** 登记一个跟着滚动的场景；减少动效时什么也不做 */
export function scene(el: Element, run: Scene) {
	if (!motion) return;
	if (!scenes.length) {
		addEventListener("scroll", schedule, { passive: true });
		addEventListener("resize", schedule, { passive: true });
	}
	scenes.push({ el, run });
	schedule();
}

export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

if (motion) {
	const STAGGER_MS = 90;
	const reveal = new IntersectionObserver(
		(entries) => {
			let order = 0;
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const el = entry.target as HTMLElement;
				if (!el.style.getPropertyValue("--d")) el.style.setProperty("--d", `${order++ * STAGGER_MS}ms`);
				el.classList.add("in");
				reveal.unobserve(el);
			}
		},
		{ rootMargin: "0px 0px -10% 0px" },
	);

	// 离场线：导航条下沿再往下一点。元素下沿离它还有 span 时开始淡，贴到线上时完全淡出
	const NAV = 64;
	const exit = (el: HTMLElement): Scene => {
		let last = -1;
		return (rect, viewport) => {
			const span = Math.min(rect.height * 0.7, viewport * 0.3) + 40;
			const out = Math.round(clamp(1 - (rect.bottom - NAV - 8) / span) * 100) / 100;
			if (out === last) return;
			last = out;
			el.style.setProperty("--out", String(out));
			el.style.filter = out > 0 ? `blur(${(out * 6).toFixed(1)}px)` : "";
		};
	};

	for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
		reveal.observe(el);
		if (!el.hasAttribute("data-stay")) scene(el, exit(el));
	}
}
