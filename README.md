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
