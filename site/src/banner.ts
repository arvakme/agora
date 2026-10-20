import { getImage } from "astro:assets";
import bannerPng from "../../docs/assets/banner.png";

// 首屏横幅的位图：avif / webp 各出五档，InkBanner 用它们做 <picture>，Landing 用同一组做预加载，两边地址一致才能命中。
// 原图 banner.png（1 MB）不进产物，只在构建时当源。
export const BANNER_WIDTHS = [800, 1200, 1600, 2000, 2400];
// 手机上横幅裁成 4:3 只露中间，位图的渲染宽度是框宽的 2.25 倍（高 = 宽 × 3/4，位图宽 = 高 × 3）
export const BANNER_SIZES = "(max-width: 640px) calc((100vw - 32px) * 2.25), min(1320px, 100vw - 96px)";

const srcset = async (format: "avif" | "webp", quality: number) =>
	(await Promise.all(BANNER_WIDTHS.map((width) => getImage({ src: bannerPng, format, width, quality }))))
		.map((image, i) => `${image.src} ${BANNER_WIDTHS[i]}w`)
		.join(", ");

let cached: Promise<{ avif: string; webp: string; fallback: string }> | undefined;
export function bannerImages() {
	cached ??= (async () => ({
		avif: await srcset("avif", 50),
		webp: await srcset("webp", 68),
		fallback: (await getImage({ src: bannerPng, format: "webp", width: 1600, quality: 68 })).src,
	}))();
	return cached;
}
