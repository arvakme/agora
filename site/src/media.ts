import type { ImageMetadata } from "astro";
import type { Lang } from "./i18n";

// 仓库里的截图、动图和宣传片只在 docs/ 下存一份；这里用 Vite 的 glob 在构建时把它们拉进产物（带内容哈希）。
// glob 匹配不到文件不会报错，所以宣传片的分语言版本缺席时可以退回总版本
const pngs = import.meta.glob<{ default: ImageMetadata }>("../../docs/media/*.png", { eager: true });
const urls = import.meta.glob<string>(["../../docs/media/*.{mp4,gif}", "../../docs/assets/*.{svg,gif,webp,png}"], {
	eager: true,
	query: "?url",
	import: "default",
});

export function shot(name: string): ImageMetadata {
	const hit = pngs[`../../docs/media/${name}.png`];
	if (!hit) throw new Error(`docs/media/${name}.png 不存在`);
	return hit.default;
}

export function asset(path: string): string {
	const hit = urls[`../../docs/${path}`];
	if (!hit) throw new Error(`docs/${path} 不存在`);
	return hit;
}

/** 宣传片：优先本语言版本（≤10 MB），没有时退回总版本，都没有返回 null（Film 区块只放海报和链接） */
export function film(lang: Lang): { url: string; localized: boolean } | null {
	const own = urls[`../../docs/media/agora-promo.${lang}.mp4`];
	if (own) return { url: own, localized: true };
	const any = urls["../../docs/media/agora-promo.mp4"];
	return any ? { url: any, localized: false } : null;
}
