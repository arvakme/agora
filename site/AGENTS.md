# 官网 site/

Astro 静态站，英文在 `/`、中文在 `/zh/`，部署到 GitHub Pages（`.github/workflows/pages.yml`，push 到 main 且改到 `site/**`、`docs/assets/**`、`docs/media/**` 或 README 时构建）。

构建与检查：`cd site && npm ci && npm run check && npm run build`；本地预览 `npm run preview`（带 `/agora` 前缀）。

- **产品事实只从仓库读。** 标语取 README 顶部的 `<b>`（中文）和 `<i>`（英文）两行（`src/repo.ts`），找不到就构建失败；`/index.md`、`/llms.txt` 也由 README 生成。区块文案在 `sections/<名字>.copy.ts`，中英两份结构相同；每条能力都要能在 README 或 `web/docs/` 里找到出处，不写仓库里没有的东西。
- **媒体不另存一份。** 截图、横幅、宣传片都只在 `docs/assets/`、`docs/media/`；`src/media.ts` 用 Vite 的 glob 在构建时拉进产物（png 截图由 Astro 转成 avif/webp，横幅由 `src/banner.ts` 出多宽度 avif/webp，1 MB 原图不进产物）。glob 只写真正用到的文件，写宽了会把 GIF 之类白白打进去。站点里自带的二进制只有宣传片海报帧 `src/assets/film-poster.{en,zh}.jpg`（各自宣传片第 12 秒）。
- **分语言图片**：英文页先找 `<名字>.en.<扩展名>`，没有就用不带后缀的那份（当前是中文界面）。换英文截图只要把 `overview.en.png` 放进 `docs/media/`，不改代码；`media.ts` 的 `highlights` 按文件名登记截图上的高亮框，新文件没登记就不画框，换了截图记得量一遍坐标。
- **录屏片段**：`docs/media/clips/<名字>.mp4` 加同名 `.jpg` 海报（H.264、无音轨、几百 KB），由 `scripts/encode-clips.py` 从原始素材重新编码，可分语言（`live-panel.en.mp4`）。页面上静音循环、过半进视口才播、`preload="none"`，靠近视口才给海报。
- **宣传片**：英文页用 `docs/media/agora-promo.en.mp4`、中文页用 `agora-promo.zh.mp4`，缺一个就用另一个，都没有时只放海报和 GitHub 链接。播放控制在 `src/video.ts`：进视口静音循环预览，点「有声播放」从头有声播放并交给浏览器控件；减少动效时不自动播。
- **加载**：只有首屏横幅 eager + `fetchpriority=high` 并在 `<head>` 预加载（连同两个主字体）；其余图片懒加载，带 24 px 模糊缩略图和主色占位（`placeholder()`），加载完淡出。每张图都给宽高或 aspect-ratio，不许布局偏移。
- **动效**：`<head>` 内联脚本给 `<html>` 加 `js`，不要求减少动效时再加 `motion`；所有动效都挂在 `html.motion` 下，减少动效时页面静止、内容原位。`src/motion.ts` 是唯一的引擎：`[data-reveal]` 进视口升起淡入（`wipe` 标题遮罩擦出、`frame` 窗口侧滑带透视、`soft` 小幅），下沿靠近导航时跟着滚动淡出、模糊（`data-stay` 不淡出）；区块用 `scene()` 登记滚动函数，同一个 rAF 里先读后写。「怎么工作」是钉住的一幕（宽屏才钉），滚动进度推进三步。墨晕横幅（`components/InkBanner.astro`）每次加载、bfcache 返回时都从太阳处揭开，只动合成层的 transform，别换成每帧滤镜或 canvas（软件渲染下掉到 15–25 fps）。不引动画库。
- **路径前缀**：站内链接一律经过 `i18n.ts` 的 `href()`。换自定义域名时不改代码，构建时给 `SITE_URL` 与 `SITE_BASE=/`（工作流里读仓库变量）。
- 中文用系统字体，不引网络中文字体；西文是 Fraunces（标题）、Hanken Grotesk（正文）、JetBrains Mono（代码），都经 fontsource 自带。颜色只在 `styles/global.css` 的 `:root` 定，暗色跟随系统。
- 依赖版本精确锁定（`package.json` 不带 `^`），`package-lock.json` 一起提交。
