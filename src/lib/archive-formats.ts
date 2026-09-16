import {
  CONTENT_LABELS,
  TRANSLATION_LABELS,
  TYPE_LABELS,
  formatDuration,
  formatTimestamp,
} from "./display";
import { VIDEO_TYPES, type VideoEntry } from "./types";

const ARCHIVE_NAME = "马斯克中文档案";
const ARCHIVE_DESCRIPTION = "非官方、非商业的伊隆·马斯克公开影像与中英文实录资料库。";

function absoluteUrl(path: string, site: URL): string {
  return new URL(path.startsWith("/") ? path : `/${path}`, site).toString();
}

function markdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]])/g, "\\$1")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function markdownLine(value: string): string {
  return markdownText(value).replace(/\s*\n\s*/g, " ");
}

function markdownLink(label: string, url: string): string {
  return `[${markdownLine(label)}](<${url}>)`;
}

function htmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function validHttpUrl(value?: string): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;

  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

export function sortVideosNewest(videos: readonly VideoEntry[]): VideoEntry[] {
  return [...videos].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function formatVideoMarkdown(video: VideoEntry, site: URL): string {
  const pageUrl = absoluteUrl(`/videos/${video.slug}/`, site);
  const markdownUrl = absoluteUrl(`/videos/${video.slug}.md`, site);
  const transcriptUrl = validHttpUrl(video.transcriptSource);
  const duration = formatDuration(video.durationSec);
  const lines = [
    `# ${markdownLine(video.titleZh || video.titleEn)}`,
    "",
    `> ${markdownLine(video.titleEn)}`,
    "",
    `- **资料编号 / Record ID：** \`${markdownLine(video.id)}\``,
    `- **快照版本 / Snapshot：** ${markdownLine(video.snapshotId)}`,
    `- **日期 / Date：** ${markdownLine(video.date)}`,
    `- **类别 / Type：** ${TYPE_LABELS[video.type]} (${video.type})`,
    `- **机构 / Organization：** ${video.org ? markdownLine(video.org) : "未标注 / Not specified"}`,
    `- **时长 / Duration：** ${duration || "未标注 / Not specified"}`,
    `- **正文类型 / Content：** ${CONTENT_LABELS[video.contentKind]} (${video.contentKind})`,
    `- **翻译状态 / Translation：** ${TRANSLATION_LABELS[video.translation.status]} (${video.translation.status})`,
    `- **资料更新 / Updated at：** ${markdownLine(video.translation.reviewedAt || video.translation.translatedAt || video.fetchedAt)}`,
    `- **抓取时间 / Fetched at：** ${markdownLine(video.fetchedAt)}`,
    `- **网页版 / HTML：** ${markdownLink(video.titleZh || video.titleEn, pageUrl)}`,
    `- **Markdown：** ${markdownLink(markdownUrl, markdownUrl)}`,
    `- **原始来源 / Original source：** ${markdownLink(video.sourceLabel || video.sourceUrl, video.sourceUrl)}`,
    `- **英文档案 / Source archive：** ${markdownLink("Elon Musk Archive", video.archiveUrl)}`,
  ];

  if (transcriptUrl) {
    lines.push(`- **文字记录来源 / Transcript source：** ${markdownLink(transcriptUrl, transcriptUrl)}`);
  }

  lines.push(
    "",
    "## 中文摘要",
    "",
    markdownText(video.summaryZh || video.summaryEn),
    "",
    "## English summary",
    "",
    markdownText(video.summaryEn),
    "",
  );

  if (video.contentKind === "none" || video.segments.length === 0) {
    lines.push(
      "## 中文正文",
      "",
      "暂无可用正文。",
      "",
      "## English transcript",
      "",
      "No transcript is available.",
      "",
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push("## 中文正文", "");
  for (const [index, segment] of video.segments.entries()) {
    const speaker = segment.speakerZh || segment.speakerEn || `第 ${index + 1} 段`;
    const timestamp = formatTimestamp(segment.startSec);
    lines.push(
      `<a id="${htmlAttribute(segment.id)}"></a>`,
      `### ${segment.id} · ${markdownLine(speaker)}${timestamp ? ` · ${timestamp}` : ""}`,
      "",
      markdownText(segment.textZh || segment.textEn),
      "",
      markdownLink("引用此段 / Cite this paragraph", `${pageUrl}#${encodeURIComponent(segment.id)}`),
      "",
    );
  }

  lines.push("## English transcript", "");
  for (const [index, segment] of video.segments.entries()) {
    const speaker = segment.speakerEn || segment.speakerZh || `Paragraph ${index + 1}`;
    const timestamp = formatTimestamp(segment.startSec);
    lines.push(
      `<a id="${htmlAttribute(segment.id)}-en"></a>`,
      `### ${segment.id} · ${markdownLine(speaker)}${timestamp ? ` · ${timestamp}` : ""}`,
      "",
      markdownText(segment.textEn),
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

export function createArchiveIndex(videos: readonly VideoEntry[], site: URL) {
  const sorted = sortVideosNewest(videos);
  const updatedAt = sorted
    .flatMap((video) => [video.translation.reviewedAt, video.translation.translatedAt, video.fetchedAt])
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return {
    schemaVersion: "1.0",
    name: ARCHIVE_NAME,
    description: ARCHIVE_DESCRIPTION,
    url: absoluteUrl("/", site),
    inLanguage: ["zh-CN", "en"],
    numberOfItems: sorted.length,
    snapshotIds: [...new Set(sorted.map((video) => video.snapshotId))].sort(),
    updatedAt,
    items: sorted.map((video) => {
      const transcriptUrl = validHttpUrl(video.transcriptSource);
      return {
        id: video.id,
        slug: video.slug,
        url: absoluteUrl(`/videos/${video.slug}/`, site),
        markdownUrl: absoluteUrl(`/videos/${video.slug}.md`, site),
        snapshotId: video.snapshotId,
        date: video.date,
        type: video.type,
        organization: video.org,
        durationSec: video.durationSec,
        contentKind: video.contentKind,
        segmentCount: video.segments.length,
        fetchedAt: video.fetchedAt,
        sourceHash: video.sourceHash,
        title: { zh: video.titleZh, en: video.titleEn },
        summary: { zh: video.summaryZh, en: video.summaryEn },
        source: {
          media: video.sourceUrl,
          archive: video.archiveUrl,
          ...(transcriptUrl ? { transcript: transcriptUrl } : {}),
        },
        translation: {
          status: video.translation.status,
          model: video.translation.model,
          translatedAt: video.translation.translatedAt,
          reviewedAt: video.translation.reviewedAt,
        },
      };
    }),
  };
}

export function formatLlmsTxt(videos: readonly VideoEntry[], site: URL): string {
  const sorted = sortVideosNewest(videos);
  const lines = [
    `# ${ARCHIVE_NAME}`,
    "",
    `> ${ARCHIVE_DESCRIPTION}`,
    "",
    "本站以简体中文为主要阅读语言，每条记录保留英文标题、摘要与正文对照。中文内容由机器翻译生成；引用具体观点时，请同时核对英文原文、视频和所列来源。",
    "",
    "## 机器可读入口",
    `- ${markdownLink("档案元数据索引（JSON）", absoluteUrl("/archive.json", site))}: ${sorted.length} 条记录的中英标题、摘要、日期、类别、正文状态与来源链接。`,
    `- ${markdownLink("XML Sitemap", absoluteUrl("/sitemap-index.xml", site))}: 可抓取页面清单。`,
    `- ${markdownLink("视频 Sitemap", absoluteUrl("/video-sitemap.xml", site))}: 可嵌入视频的发现与预览元数据。`,
    "",
    "## 主要页面",
    `- ${markdownLink("影像目录", absoluteUrl("/", site))}: 按类别、年份、机构与正文状态浏览。`,
    `- ${markdownLink("全文搜索", absoluteUrl("/search/", site))}: 检索中文标题、摘要与正文。`,
    `- ${markdownLink("关于本站", absoluteUrl("/about/", site))}: 本站定位与简介。`,
    `- ${markdownLink("版权、纠错与下架", absoluteUrl("/rights/", site))}: 权利声明、翻译纠错与联系渠道。`,
    "",
    "## 分类档案",
    ...VIDEO_TYPES.filter((type) => sorted.some((video) => video.type === type)).map((type) =>
      `- ${markdownLink(`${TYPE_LABELS[type]}档案`, absoluteUrl(`/categories/${type}/`, site))}`),
    "",
    `## 全部档案（${sorted.length} 条）`,
  ];

  for (const video of sorted) {
    const details = [video.date, TYPE_LABELS[video.type], video.org]
      .filter((value): value is string => Boolean(value))
      .map(markdownLine)
      .join(" · ");
    const markdownUrl = absoluteUrl(`/videos/${video.slug}.md`, site);
    const pageUrl = absoluteUrl(`/videos/${video.slug}/`, site);
    lines.push(
      `- ${markdownLink(video.titleZh || video.titleEn, markdownUrl)}: ${details} · ${markdownLink("网页版", pageUrl)} · English: ${markdownLine(video.titleEn)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
