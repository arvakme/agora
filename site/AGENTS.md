# 官网 site/

Astro 静态站，英文在 `/`、中文在 `/zh/`，部署到 GitHub Pages（`.github/workflows/pages.yml`，push 到 main 且改到 `site/**`、`docs/assets/**`、`docs/media/**` 或 README 时构建）。

构建与检查：`cd site && npm ci && npm run check && npm run build`；本地预览 `npm run preview`（带 `/agora` 前缀）。

- **产品事实只从仓库读。** 标语取 README 顶部的 `<b>`（中文）和 `<i>`（英文）两行（`src/repo.ts`），找不到就构建失败；`/index.md`、`/llms.txt` 也由 README 生成。区块文案在 `sections/<名字>.copy.ts`，中英两份结构相同；每条能力都要能在 README 或 `web/docs/` 里找到出处，不写仓库里没有的东西。
- **媒体不另存一份。** 截图、动图、横幅、宣传片都只在 `docs/assets/`、`docs/media/`；`src/media.ts` 用 Vite 的 glob 在构建时拉进产物（png 截图由 Astro 转成 avif/webp）。唯一放在站点里的二进制是宣传片海报帧 `src/assets/film-poster.jpg`（从宣传片第 10 秒截的）。
- **宣传片**：英文页用 `docs/media/agora-promo.en.mp4`、中文页用 `agora-promo.zh.mp4`；缺哪个就退回 `agora-promo.mp4`，都没有时只放海报和 GitHub 链接。播放控制在 `src/video.ts`：进视口静音循环预览，点「有声播放」从头有声播放并交给浏览器控件；减少动效时不自动播。
- **路径前缀**：站内链接一律经过 `i18n.ts` 的 `href()`。换自定义域名时不改代码，构建时给 `SITE_URL` 与 `SITE_BASE=/`（工作流里读仓库变量）。
- 中文用系统字体，不引网络中文字体；西文是 Fraunces（标题）、Hanken Grotesk（正文）、JetBrains Mono（代码），都经 fontsource 自带。颜色只在 `styles/global.css` 的 `:root` 定，暗色跟随系统。
- 依赖版本精确锁定（`package.json` 不带 `^`），`package-lock.json` 一起提交。
