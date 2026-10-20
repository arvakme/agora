import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// 站点地址与路径前缀：默认是 GitHub Pages 的项目页 https://arvakme.github.io/agora/。
// 换自定义域名时不改代码，构建时给 SITE_URL=https://域名 SITE_BASE=/ 即可（见 .github/workflows/pages.yml）
const site = process.env.SITE_URL ?? "https://arvakme.github.io";
const base = process.env.SITE_BASE ?? "/agora";

export default defineConfig({
	site,
	base,
	integrations: [sitemap()],
	devToolbar: { enabled: false },
	vite: {
		// 截图、动图和宣传片的唯一来源在仓库根的 docs/，构建时由 Vite 复制进产物，站点里不另存一份
		server: { fs: { allow: [".."] } },
	},
});
