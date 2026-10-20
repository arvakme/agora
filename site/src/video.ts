// 宣传片的播放控制：
// - 允许动效时，进入视口才开始加载、静音循环预览，离开视口就停；
// - 点「有声播放」：取消静音、从头播、交给浏览器自带控件（暂停、拖动、音量、全屏），不再自动停；
// - 减少动效时不自动播，只显示海报，点了才播。
export function filmControl(video: HTMLVideoElement, play: HTMLButtonElement) {
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	let full = false;
	const start = () =>
		// 被浏览器拦下（省电模式、解码器不支持 H.264 等）时停在海报上，不报错
		video.play().catch(() => {});

	play.addEventListener("click", () => {
		full = true;
		video.muted = false;
		video.loop = false;
		video.currentTime = 0;
		video.controls = true;
		play.hidden = true;
		start();
		video.focus();
	});

	if (reduced) return;
	new IntersectionObserver(
		([entry]) => {
			if (full) return;
			if (entry.isIntersecting) start();
			else video.pause();
		},
		{ threshold: 0.4 },
	).observe(video);
}
