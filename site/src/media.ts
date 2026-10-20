import type { ImageMetadata } from "astro";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Lang } from "./i18n";

// 仓库里的截图、录屏片段和宣传片只在 docs/ 下存一份；这里用 Vite 的 glob 在构建时把它们拉进产物（带内容哈希）。
// glob 只写站点真正用到的文件：eager glob 会把匹配到的每个文件都打进产物，写宽了就会把 GIF、横幅原图白白发布出去。
// 匹配不到不会报错，所以分语言版本缺席时可以退回不带后缀的那份。
//
// 分语言：英文页先找 <名字>.en.<扩展名>，没有就用 <名字>.<扩展名>（中文界面、当前的那份）。
// 换上英文界面截图只需要把 overview.en.png 放进 docs/media/，不改代码。
const images = import.meta.glob<{ default: ImageMetadata }>(["../../docs/media/*.png", "../../docs/media/clips/*.jpg"], { eager: true });
const urls = import.meta.glob<string>(["../../docs/media/agora-promo.*.mp4", "../../docs/media/clips/*.mp4"], {
	eager: true,
	query: "?url",
	import: "default",
});

const key = (path: string) => `../../docs/${path}`;
const withLang = (path: string, lang: Lang) => (lang === "en" ? [path.replace(/(\.[^.]+)$/, ".en$1"), path] : [path]);

function pick<T>(table: Record<string, T>, path: string, lang: Lang): { file: string; value: T } {
	for (const candidate of withLang(path, lang)) {
		const value = table[key(candidate)];
		if (value) return { file: candidate, value };
	}
	throw new Error(`docs/${path} 不存在`);
}

const base = (path: string) => path.split("/").pop()!;

/** docs/media/<name>.png，英文页优先 <name>.en.png；path 是实际用到的 docs/ 下路径 */
export function shot(name: string, lang: Lang) {
	const { file, value } = pick(images, `media/${name}.png`, lang);
	return { path: file, file: base(file), image: value.default };
}

/** docs/media/clips/<name>.mp4 与同名 .jpg 海报，英文页优先 .en 版本 */
export function clip(name: string, lang: Lang) {
	const video = pick(urls, `media/clips/${name}.mp4`, lang);
	const posterPath = video.file.replace(/\.mp4$/, ".jpg");
	const poster = pick(images, posterPath, "zh");
	return { file: base(video.file), url: video.value, poster: poster.value.default, posterPath };
}

/** 宣传片：本语言版本，没有就退回另一种语言，都没有返回 null（Film 区块只放海报和链接） */
export function film(lang: Lang): string | null {
	return urls[key(`media/agora-promo.${lang}.mp4`)] ?? urls[key(`media/agora-promo.${lang === "en" ? "zh" : "en"}.mp4`)] ?? null;
}

// 占位：24 px 宽的模糊缩略图（内联成 data URI，几百字节）加主色，图片解码前先铺在框里，加载完淡出。
// 读的是仓库里的源文件（构建时工作目录是 site/）
const placeholders = new Map<string, Promise<{ blur: string; color: string }>>();
export function placeholder(docsPath: string) {
	let hit = placeholders.get(docsPath);
	if (!hit) {
		const source = readFileSync(join(process.cwd(), "..", "docs", docsPath));
		hit = Promise.all([sharp(source).resize(24).webp({ quality: 40 }).toBuffer(), sharp(source).stats()]).then(([tiny, stats]) => {
			const { r, g, b } = stats.dominant;
			return { blur: `data:image/webp;base64,${tiny.toString("base64")}`, color: `rgb(${r} ${g} ${b})` };
		});
		placeholders.set(docsPath, hit);
	}
	return hit;
}

export type Highlight = { x: number; y: number; w: number; h: number; label: Record<Lang, string> };

// 截图上要引人看的那一块（百分比坐标，按图片文件名登记）。换了截图（比如加了 overview.en.png）而这里没登记，
// 就不画高亮，不会框错地方
export const highlights: Record<string, Highlight> = {
	"overview.png": { x: 1, y: 45, w: 15.5, h: 11.5, label: { en: "Claude Code · App.tsx", zh: "Claude Code · App.tsx" } },
	"trajectory.png": { x: 60.5, y: 66.2, w: 39, h: 23, label: { en: "One Edit call, full input", zh: "一次 Edit 调用的完整输入" } },
	"choose-agent.png": { x: 64.2, y: 48.6, w: 31.4, h: 9.4, label: { en: "Locked once chosen", zh: "选定后不能更改" } },
	"terminal.png": { x: 1.2, y: 25.4, w: 97.6, h: 6.4, label: { en: "tmux attach", zh: "tmux attach" } },
	"share.png": { x: 42.3, y: 5.6, w: 28.9, h: 32.4, label: { en: "Canvas + expiry", zh: "画布 + 有效期" } },
	"guest.png": { x: 80.6, y: 9.8, w: 19.2, h: 27, label: { en: "Guest comments", zh: "访客评论" } },
};
