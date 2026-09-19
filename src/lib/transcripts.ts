import { CONTENT_LABELS, TYPE_LABELS, formatTimestamp } from "./display";
import type { VideoEntry } from "./types";

export const TRANSCRIPTS_PATH = "/transcripts/";

export function hasChineseTranscript(video: VideoEntry): boolean {
  return video.contentKind !== "none"
    && video.segments.length > 0
    && video.segments.every((segment) => segment.textZh.trim().length > 0);
}

export function getChineseTranscripts(videos: readonly VideoEntry[]): VideoEntry[] {
  return videos.filter(hasChineseTranscript)
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function transcriptPath(video: Pick<VideoEntry, "slug">): string {
  return `${TRANSCRIPTS_PATH}${video.slug}/`;
}

export function transcriptStats(video: VideoEntry): { characterCount: number; readingMinutes: number } {
  const characterCount = video.segments.reduce(
    (total, segment) => total + Array.from(segment.textZh.replace(/\s/g, "")).length,
    0,
  );
  return { characterCount, readingMinutes: Math.max(1, Math.ceil(characterCount / 400)) };
}

function markdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]])/g, "\\$1")
    .replace(/\r\n?/g, "\n")
    .replace(/^(\s*)(#{1,6}|[-+])(?=\s)/gm, "$1\\$2")
    .replace(/^(\s*\d+)\.(?=\s)/gm, "$1\\.")
    .trim();
}

function markdownLine(value: string): string {
  return markdownText(value).replace(/\s*\n\s*/g, " ");
}

function markdownLink(label: string, url: string): string {
  const destination = url.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("\n", "%0A").replaceAll("\r", "%0D");
  return `[${markdownLine(label)}](<${destination}>)`;
}

function htmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function transcriptSourceUrl(value?: string): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function formatChineseTranscriptMarkdown(video: VideoEntry, site: URL): string {
  const pageUrl = new URL(transcriptPath(video), site).toString();
  const videoUrl = new URL(`/videos/${video.slug}/`, site).toString();
  const { characterCount, readingMinutes } = transcriptStats(video);
  const lines = [
    `# ${markdownLine(video.titleZh)}`,
    "",
    `- **日期：** ${markdownLine(video.date)}`,
    `- **类别：** ${TYPE_LABELS[video.type]}`,
    `- **正文类型：** ${CONTENT_LABELS[video.contentKind]}`,
    `- **字数：** ${characterCount.toLocaleString("zh-CN")} 字`,
    `- **预计阅读：** ${readingMinutes} 分钟`,
    `- **文字稿页面：** ${markdownLink("阅读中文文字稿", pageUrl)}`,
    `- **影像档案：** ${markdownLink("观看影像与双语对照", videoUrl)}`,
    `- **原始来源：** ${markdownLink(video.sourceLabel || "查看原始来源", video.sourceUrl)}`,
    `- **英文档案来源：** ${markdownLink("查看英文档案", video.archiveUrl)}`,
  ];
  const transcriptSource = transcriptSourceUrl(video.transcriptSource);
  if (transcriptSource) {
    lines.push(`- **文字记录来源：** ${markdownLink("查看文字记录来源", transcriptSource)}`);
  }
  lines.push(
    "",
    "## 中文摘要",
    "",
    markdownText(video.summaryZh),
    "",
    "## 中文正文",
    "",
  );

  for (const [index, segment] of video.segments.entries()) {
    const speaker = segment.speakerZh?.trim() || segment.speakerEn?.trim();
    const timestamp = formatTimestamp(segment.startSec);
    const heading = [`第 ${index + 1} 段`, speaker, timestamp].filter(Boolean).join(" · ");
    lines.push(
      `<a id="${htmlAttribute(segment.id)}"></a>`,
      `### ${markdownLine(heading)}`,
      "",
      markdownText(segment.textZh),
      "",
      markdownLink("引用此段", `${pageUrl}#${encodeURIComponent(segment.id)}`),
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}
