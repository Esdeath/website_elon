# 马斯克中文档案

一个面向中文读者的非官方、非商业资料库，整理 [Elon Musk Archive](https://elonmuskarchive.org/videos) 视频目录中的来源链接、英文详情与简体中文机器翻译。

## 本地开发

```bash
npm install
cp .env.example .env
npm run sync:fetch
npm run sync:translate -- --resume
npm run sync:review -- --resume
npm run validate
npm run test:e2e
npm run dev
```

完整同步可运行：

```bash
npm run sync
```

翻译流程使用本机已登录的 Codex CLI。先运行 `codex login status` 确认当前 ChatGPT 账号可用。翻译与复核支持 `--ids id-a,id-b`、`--limit 10`、`--force` 和 `--resume`；命中使用限额后可在额度恢复时继续。批次大小和模型并发可用 `CODEX_TRANSLATION_CHUNK_CHARS`、`CODEX_TRANSLATION_CONCURRENCY` 调整。

## 生产构建

```bash
PUBLIC_SITE_URL=https://elon.ayaseeri.com \
PUBLIC_CONTACT_EMAIL=807267531@qq.com \
npm run build
```

Cloudflare Pages 配置：

- GitHub 仓库：`Esdeath/website_elon`
- Pages 项目：`website-elon`
- 生产分支：`main`
- 构建命令：`npm run build`
- 输出目录：`dist`
- Node.js：22 或更新版本
- 环境变量：`PUBLIC_SITE_URL`、`PUBLIC_CONTACT_EMAIL`
- 自定义域名：`elon.ayaseeri.com`

采集和翻译只在本地运行。Cloudflare 构建不需要、也不应配置 ChatGPT/Codex 登录凭据。

## 搜索与机器读取

- `/sitemap-index.xml` 收录 canonical HTML 页面及真实内容更新时间，`/video-sitemap.xml` 收录可嵌入视频。
- `/archive.json` 提供 271 条双语元数据；每条详情另有 `/videos/{slug}.md` Markdown 版本。
- `/llms.txt` 枚举机器可读入口和全部档案，HTML 详情页通过 `rel="alternate"` 指向对应 Markdown。
- robots 优先允许 AI 搜索和用户请求式读取，并通过 `Content-Signal` 表达不用于训练的偏好；已知训练爬虫 GPTBot、ClaudeBot 与 CCBot 被禁止。

## 在线读书

- 顶部「读书」、首页书籍入口及页脚指向 `/books/first-principles/`，可阅读《第一性原理：马斯克创业与管理问答录》。
- 原始合订本保存在 `src/data/books/first-principles.html`，构建时保留正文和来源，生成带有稳定锚点的阅读页；不依赖仓库外的原文件。
- 阅读页提供章节目录、全书搜索、字号调节和继续阅读。字号与阅读位置保存在当前浏览器；链接中的章节或问答位置优先于历史记录。
- 书籍正文加入 Pagefind 全文搜索，阅读页加入 sitemap 和 `llms.txt`。

## SEO 与 GEO 维护

- `/categories/{type}/` 是五类资料的静态目录，每个目录有独立标题、摘要、canonical 和 CollectionPage / ItemList 结构化数据，所有记录链接直接出现在 HTML 中。
- 首页链接到分类目录；详情页链接到同类资料，优先展示同机构记录；目录自动加入 sitemap，并使用实际资料处理时间作为 lastmod。
- 详情页提供资料更新时间、永久链接、Markdown 入口和中文段落引用链接。Markdown 中的引用链接回到 HTML 对应段落，便于核对来源。
- `/about/` 说明资料来源、机器翻译和引用方式。机器可读格式是辅助入口，不保证任何搜索引擎收录或 AI 引用。
- 部署后在 Google Search Console / Bing Webmaster Tools 验证域名并提交 `/sitemap-index.xml` 和 `/video-sitemap.xml`；检查抓取、索引和引用数据。现有 `seo:indexnow` 命令可在部署完成后提交 URL。
- `npm run build` 会验证全部详情页和分类页的 canonical、结构化数据、引用链接、sitemap 与机器可读入口。
- 实施参考：[Google AI 搜索指南](https://developers.google.com/search/docs/appearance/ai-features)、[Bing 网站管理员指南](https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a)。

## 内容边界

- 视频仅从原平台嵌入，不下载、不镜像。
- 每页保留原始来源与原档案页链接。
- 中文内容为机器翻译，可能存在错误，请以英文原文为准。
- 内容权利属于相应作者和来源；版权方可通过站点版权页面请求更正或下架。

## 主要脚本

- `npm run sync:fetch`：获取精确的 271 条基线目录与详情正文。
- `npm run sync:translate`：使用当前 ChatGPT/Codex 账号分块翻译。
- `npm run sync:review`：对中英段落做独立复核并应用修正。
- `--resume`：用于从上次中断处继续；日常更新请不带此参数运行 `npm run sync`，以便重新检查源站变化。
- `npm run validate`：验证来源、结构、翻译状态与生产配置。
- `npm run test:e2e`：在桌面 Chrome 与 390px Chromium 手机视口运行浏览器验收。
- `npm run build`：验证、测试、Astro 静态构建并生成 Pagefind 索引。
- `npm run test:seo`：验证 canonical、结构化数据、机器可读入口与 sitemap 产物。
- `npm run seo:indexnow`：构建部署完成后，将 sitemap 中的 canonical URL 提交给 IndexNow。
