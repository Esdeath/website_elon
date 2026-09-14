import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const base = site || new URL("https://elon.ayaseeri.com");
  const url = (path: string) => new URL(path, base).toString();
  const body = `# 马斯克中文档案

> 非官方、非商业的伊隆·马斯克公开影像与中英文实录资料库。

## 主要页面
- [影像目录](${url("/")}): 按类别、年份、机构与正文状态浏览。
- [全文搜索](${url("/search/")}): 检索中文标题、摘要与正文。
- [关于本站](${url("/about/")}): 数据来源、翻译方式与收录范围。
- [版权、纠错与下架](${url("/rights/")}): 权利声明与联系渠道。

## 使用说明
- 中文为机器翻译，引用前应核对英文原文和视频。
- 每条记录保留原始来源和英文档案页。
- 本站不托管视频，不包含用户生成内容。
`;

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
