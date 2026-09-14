import type {
  ContentKind,
  TranslationStatus,
  VideoEntry,
  VideoType,
} from "./types";

export const TYPE_LABELS: Record<VideoType, string> = {
  interview: "访谈",
  keynote: "主题演讲",
  speech: "公开演讲",
  earnings: "财报会议",
  space: "线上对谈",
};

export const CONTENT_LABELS: Record<ContentKind, string> = {
  dialogue: "对话实录",
  article: "全文",
  none: "暂无正文",
};

export const TRANSLATION_LABELS: Record<TranslationStatus, string> = {
  pending: "待翻译",
  translated: "已翻译",
  reviewed: "已校对",
  failed: "翻译异常",
};

export function formatDate(date: string, locale = "zh-CN") {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return date;

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: locale.startsWith("zh") ? "long" : "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(value);
}

export function formatDuration(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function formatTimestamp(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function videoYear(date: string) {
  return /^\d{4}/.test(date) ? date.slice(0, 4) : "未知";
}

export function getYouTubeId(input?: string) {
  if (!input) return undefined;

  try {
    const url = new URL(input);
    const hostname = url.hostname.replace(/^www\./, "");
    if (hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0];
    if (hostname.endsWith("youtube.com") || hostname === "youtube-nocookie.com") {
      if (url.pathname === "/watch") return url.searchParams.get("v") || undefined;
      const parts = url.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
      if (marker >= 0) return parts[marker + 1];
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function privacyEmbedUrl(input?: string) {
  const id = getYouTubeId(input);
  if (!id) return undefined;

  const url = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
  url.searchParams.set("enablejsapi", "1");
  url.searchParams.set("rel", "0");
  return url.toString();
}

export function videoThumbnail(video: VideoEntry) {
  if (video.thumbnailUrl) return video.thumbnailUrl;
  const id = getYouTubeId(video.embedUrl || video.sourceUrl);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
}
