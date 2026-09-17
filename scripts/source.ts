import { createHash } from "node:crypto";

import { load } from "cheerio";

import type {
  ContentKind,
  TranscriptSegment,
  VideoEntry,
  VideoType,
} from "../src/lib/types";

export const SOURCE_ORIGIN = "https://elonmuskarchive.org";
export const SOURCE_INDEX_URL =
  `${SOURCE_ORIGIN}/agents/index?type=interviews,keynotes,speeches,spaces,earnings&list=1&limit=1000`;
export const INITIAL_SNAPSHOT_COUNT = 271;

const VALID_VIDEO_TYPES = new Set<VideoType>([
  "interview",
  "keynote",
  "speech",
  "earnings",
  "space",
]);

export interface SourceIndexEntry {
  id: string;
  type: VideoType;
  date: string;
  title: string;
  url: string;
  source: string;
  sourceLabel?: string;
  org?: string;
  hasTranscript?: boolean;
  durationSec?: number;
}

export interface ParsedContent {
  contentKind: ContentKind;
  segments: TranscriptSegment[];
}

export interface ParsedTranscript extends ParsedContent {
  title?: string;
  summary?: string;
  embedUrl?: string;
  sourceLabel?: string;
  transcriptSource?: string;
}

export interface ParsedDetail extends ParsedContent {
  title?: string;
  summary?: string;
  embedUrl?: string;
  thumbnailUrl?: string;
  transcriptSource?: string;
}

export interface BuildVideoOptions {
  fetchedAt: string;
  snapshotId: string;
  transcript?: ParsedTranscript;
  detail?: ParsedDetail;
}

interface UnknownRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

export function parseIndexPayload(payload: unknown): SourceIndexEntry[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.entries)) {
    throw new Error("Source index is missing its entries array");
  }

  if (
    typeof root.total === "number" &&
    root.total !== root.entries.length
  ) {
    throw new Error(
      `Source index total (${root.total}) does not match entries (${root.entries.length})`,
    );
  }

  const ids = new Set<string>();
  return root.entries.map((rawEntry, index) => {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`Source index entry ${index} is not an object`);
    }

    const id = asNonEmptyString(entry.id);
    const type = asNonEmptyString(entry.type) as VideoType | undefined;
    const date = asNonEmptyString(entry.date);
    const title = asNonEmptyString(entry.title);
    const url = asNonEmptyString(entry.url);
    const source = asNonEmptyString(entry.source);

    if (!id || !isSafeId(id)) {
      throw new Error(`Source index entry ${index} has an invalid id`);
    }
    if (ids.has(id)) {
      throw new Error(`Source index contains duplicate id: ${id}`);
    }
    ids.add(id);
    if (!type || !VALID_VIDEO_TYPES.has(type)) {
      throw new Error(`Source index entry ${id} has an invalid type`);
    }
    if (!date || !isDate(date)) {
      throw new Error(`Source index entry ${id} has an invalid date`);
    }
    if (!title || !url || !source || !isHttpUrl(url) || !isHttpUrl(source)) {
      throw new Error(`Source index entry ${id} is missing a required URL or title`);
    }

    const durationSec = asFiniteNumber(entry.durationSec);
    return {
      id,
      type,
      date,
      title,
      url,
      source,
      sourceLabel: asNonEmptyString(entry.sourceLabel),
      org: asNonEmptyString(entry.org),
      hasTranscript:
        typeof entry.hasTranscript === "boolean" ? entry.hasTranscript : undefined,
      durationSec:
        durationSec !== undefined && durationSec >= 0 ? durationSec : undefined,
    };
  });
}

function timestampToSeconds(value: string): number | undefined {
  const parts = value.split(":").map(Number);
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  ) {
    return undefined;
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

interface RawSegment {
  speakerEn?: string;
  startSec?: number;
  textEn: string;
}

function withStableIds(segments: RawSegment[]): TranscriptSegment[] {
  return segments
    .filter((segment) => normalizeText(segment.textEn))
    .map((segment, index) => ({
      id: `p-${String(index + 1).padStart(4, "0")}`,
      ...(segment.speakerEn
        ? { speakerEn: normalizeInlineText(segment.speakerEn) }
        : {}),
      ...(segment.startSec !== undefined && segment.startSec >= 0
        ? { startSec: segment.startSec }
        : {}),
      textEn: normalizeText(segment.textEn),
      textZh: "",
    }));
}

const NON_SPEAKER_LABELS = new Set([
  "DATE",
  "MANDATORY CREDIT",
  "SOURCE",
  "TRANSCRIPT",
  "WHEN",
  "WHERE",
]);

function parseLabelledParagraph(paragraph: string): RawSegment | undefined {
  const timed = paragraph.match(
    /^([^():\n]{1,80}?)\s*\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*:\s*([\s\S]+)$/,
  );
  if (timed) {
    return {
      speakerEn: timed[1],
      startSec: timestampToSeconds(timed[2]),
      textEn: timed[3],
    };
  }

  const bracketed = paragraph.match(
    /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:\n]{1,80})\s*:\s*([\s\S]+)$/,
  );
  if (bracketed) {
    return {
      speakerEn: bracketed[2],
      startSec: timestampToSeconds(bracketed[1]),
      textEn: bracketed[3],
    };
  }

  const labelled = paragraph.match(/^([A-Z][A-Z0-9 .&'’-]{1,60}):\s*([\s\S]+)$/);
  if (labelled && !NON_SPEAKER_LABELS.has(labelled[1].trim())) {
    return { speakerEn: labelled[1], textEn: labelled[2] };
  }
  return undefined;
}

export function parseTranscriptText(text: string): ParsedContent {
  const paragraphs = normalizeText(text)
    .split(/\n\s*\n+/)
    .map(normalizeText)
    .filter(Boolean);

  if (!paragraphs.length) {
    return { contentKind: "none", segments: [] };
  }

  const labelled = paragraphs.map(parseLabelledParagraph);
  const labelledCount = labelled.filter(Boolean).length;
  const timedCount = labelled.filter(
    (segment) => segment?.startSec !== undefined,
  ).length;
  const isDialogue =
    timedCount >= 1 ||
    (labelledCount >= 3 && labelledCount / paragraphs.length >= 0.3);

  const rawSegments = paragraphs.map((paragraph, index) =>
    isDialogue && labelled[index]
      ? labelled[index]!
      : { textEn: paragraph },
  );
  return {
    contentKind: isDialogue ? "dialogue" : "article",
    segments: withStableIds(rawSegments),
  };
}

function dialogueFromUnknown(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const segments: RawSegment[] = [];
  for (const rawGroup of value) {
    const group = asRecord(rawGroup);
    if (!group) continue;
    const speaker = asNonEmptyString(group.speaker);
    const paragraphs = Array.isArray(group.paras)
      ? group.paras
      : Array.isArray(group.paragraphs)
        ? group.paragraphs
        : [];
    for (const rawParagraph of paragraphs) {
      const paragraph = asRecord(rawParagraph);
      if (!paragraph) continue;
      const text =
        asNonEmptyString(paragraph.text) ?? asNonEmptyString(paragraph.content);
      if (!text) continue;
      const startSec =
        asFiniteNumber(paragraph.t) ??
        asFiniteNumber(paragraph.startSec) ??
        asFiniteNumber(paragraph.start);
      segments.push({
        ...(speaker ? { speakerEn: speaker } : {}),
        ...(startSec !== undefined ? { startSec } : {}),
        textEn: text,
      });
    }
  }
  return withStableIds(segments);
}

export function parseTranscriptPayload(payload: unknown): ParsedTranscript {
  const root = asRecord(payload);
  if (!root) {
    throw new Error("Transcript response is not an object");
  }
  if (asNonEmptyString(root.error)) {
    throw new Error(`Transcript API: ${asNonEmptyString(root.error)}`);
  }

  const directDialogue = dialogueFromUnknown(root.dialogue);
  let parsed: ParsedContent;
  if (directDialogue.length) {
    parsed = { contentKind: "dialogue", segments: directDialogue };
  } else {
    const textByLang = asRecord(root.textByLang);
    const text =
      asNonEmptyString(root.text) ?? asNonEmptyString(textByLang?.en) ?? "";
    parsed = parseTranscriptText(text);
  }

  const titles = asRecord(root.titles);
  return {
    ...parsed,
    title: asNonEmptyString(root.title) ?? asNonEmptyString(titles?.en),
    summary: asNonEmptyString(root.summary),
    embedUrl: asNonEmptyString(root.embedUrl),
    sourceLabel: asNonEmptyString(root.sourceLabel),
    transcriptSource: asNonEmptyString(root.transcriptSource),
  };
}

function decodeFlightPayload(html: string): string {
  const chunks: string[] = [];
  const scripts = html.matchAll(
    /<script[^>]*>\s*self\.__next_f\.push\(([\s\S]*?)\)\s*<\/script>/g,
  );
  for (const match of scripts) {
    try {
      const tuple = JSON.parse(match[1]) as unknown[];
      if (typeof tuple[1] === "string") chunks.push(tuple[1]);
    } catch {
      // The readable DOM remains the final fallback for malformed Flight chunks.
    }
  }
  return chunks.join("\n");
}

function extractJsonValue(text: string, key: string): unknown {
  const marker = `"${key}":`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return undefined;

  let start = markerIndex + marker.length;
  while (/\s/.test(text[start] ?? "")) start += 1;
  const opener = text[start];
  const closer = opener === "[" ? "]" : opener === "{" ? "}" : undefined;
  if (!closer) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function extractFlightString(payload: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = payload.match(new RegExp(`"${escapedKey}":"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function youtubeIdFromThumbnail(url: string | undefined): string | undefined {
  return url?.match(/ytimg\.com\/vi\/([A-Za-z0-9_-]{6,})\//)?.[1];
}

export function youtubeIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const thumbnailId = youtubeIdFromThumbnail(url);
  if (thumbnailId) return thumbnailId;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0];
    }
    if (
      host === "youtube.com" ||
      host === "youtube-nocookie.com" ||
      host === "m.youtube.com"
    ) {
      if (parsed.searchParams.get("v")) return parsed.searchParams.get("v")!;
      const parts = parsed.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part) =>
        ["embed", "live", "shorts"].includes(part),
      );
      if (marker >= 0) return parts[marker + 1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function normalizeEmbedUrl(
  sourceUrl: string,
  candidate?: string,
): string | undefined {
  const id = youtubeIdFromUrl(candidate) ?? youtubeIdFromUrl(sourceUrl);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : undefined;
}

function isSafeThumbnailCandidate(value: string | undefined): value is string {
  if (!value || !isHttpUrl(value)) return false;

  const candidate = new URL(value);
  if (candidate.username || candidate.password) return false;

  const archiveHost = new URL(SOURCE_ORIGIN).hostname.replace(/^www\./, "");
  const candidateHost = candidate.hostname.replace(/^www\./, "");
  return !(
    candidateHost === archiveHost &&
    candidate.pathname.toLowerCase() === "/og-default.jpg"
  );
}

export function thumbnailForVideo(
  sourceUrl: string,
  embedUrl?: string,
  candidate?: string,
): string | undefined {
  if (isSafeThumbnailCandidate(candidate)) {
    return candidate;
  }
  const id = youtubeIdFromUrl(embedUrl) ?? youtubeIdFromUrl(sourceUrl);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
}

export function parseDetailHtml(html: string): ParsedDetail {
  const $ = load(html);
  const flight = decodeFlightPayload(html);
  const flightDialogue = dialogueFromUnknown(extractJsonValue(flight, "dialogue"));

  const domDialogue: RawSegment[] = [];
  $("button").each((_, element) => {
    const paragraph = $(element).find(".whitespace-pre-wrap").first();
    if (!paragraph.length) return;
    const text = normalizeInlineText(paragraph.text());
    if (!text) return;
    const speaker = normalizeInlineText(
      $(element).parent().prev("div").first().text(),
    );
    domDialogue.push({
      ...(speaker ? { speakerEn: speaker } : {}),
      textEn: text,
    });
  });

  const transcriptHeading = $("h2")
    .filter((_, element) => /transcript/i.test($(element).text()))
    .first();
  const articleParagraphs = transcriptHeading
    .closest("section")
    .find("p.whitespace-pre-wrap")
    .map((_, element) => normalizeText($(element).text()))
    .get()
    .filter(Boolean);
  const standaloneArticle = parseTranscriptText(
    normalizeText($("main article > div.whitespace-pre-wrap").first().text()),
  );

  let parsed: ParsedContent = { contentKind: "none", segments: [] };
  if (flightDialogue.length) {
    parsed = { contentKind: "dialogue", segments: flightDialogue };
  } else if (domDialogue.length) {
    parsed = { contentKind: "dialogue", segments: withStableIds(domDialogue) };
  } else if (articleParagraphs.length) {
    parsed = {
      contentKind: "article",
      segments: withStableIds(
        articleParagraphs.map((textEn) => ({ textEn })),
      ),
    };
  } else if (standaloneArticle.contentKind !== "none") {
    parsed = {
      contentKind: "article",
      segments: standaloneArticle.segments,
    };
  }

  const thumbnailUrl =
    asNonEmptyString($("meta[property='og:image']").attr("content")) ??
    asNonEmptyString($("img[src*='ytimg.com/vi/']").first().attr("src"));
  const iframeUrl = asNonEmptyString(
    $("iframe[src*='youtube'], [data-embed-url]").first().attr("src") ??
      $("[data-embed-url]").first().attr("data-embed-url"),
  );
  const flightEmbed = extractFlightString(flight, "embedUrl");
  const youtubeId = youtubeIdFromThumbnail(thumbnailUrl);
  const embedUrl =
    iframeUrl ??
    flightEmbed ??
    (youtubeId ? `https://www.youtube.com/embed/${youtubeId}` : undefined);

  return {
    ...parsed,
    title: asNonEmptyString($("h1").first().text()),
    summary:
      asNonEmptyString($("meta[name='description']").attr("content")) ??
      asNonEmptyString($("meta[property='og:description']").attr("content")),
    embedUrl,
    thumbnailUrl,
    transcriptSource: extractFlightString(flight, "transcriptSource"),
  };
}

function hashSource(entry: Omit<VideoEntry, "sourceHash">): string {
  const source = {
    id: entry.id,
    type: entry.type,
    date: entry.date,
    titleEn: entry.titleEn,
    summaryEn: entry.summaryEn,
    sourceUrl: entry.sourceUrl,
    sourceLabel: entry.sourceLabel,
    archiveUrl: entry.archiveUrl,
    embedUrl: entry.embedUrl,
    thumbnailUrl: entry.thumbnailUrl,
    org: entry.org,
    durationSec: entry.durationSec,
    contentKind: entry.contentKind,
    segments: entry.segments.map(({ id, speakerEn, startSec, textEn }) => ({
      id,
      speakerEn,
      startSec,
      textEn,
    })),
    transcriptSource: entry.transcriptSource,
  };
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function translationInputsEqual(a: VideoEntry, b: VideoEntry): boolean {
  return (
    a.titleEn === b.titleEn &&
    a.summaryEn === b.summaryEn &&
    JSON.stringify(
      a.segments.map(({ id, speakerEn, textEn }) => ({ id, speakerEn, textEn })),
    ) ===
      JSON.stringify(
        b.segments.map(({ id, speakerEn, textEn }) => ({
          id,
          speakerEn,
          textEn,
        })),
      )
  );
}

export function mergeExistingTranslations(
  next: VideoEntry,
  existing?: VideoEntry,
): VideoEntry {
  if (!existing) return next;

  const oldSegments = new Map(existing.segments.map((segment) => [segment.id, segment]));
  const segments = next.segments.map((segment) => {
    const old = oldSegments.get(segment.id);
    const unchanged =
      old?.textEn === segment.textEn && old?.speakerEn === segment.speakerEn;
    return {
      ...segment,
      textZh: unchanged ? old.textZh : "",
      ...(unchanged && old.speakerZh ? { speakerZh: old.speakerZh } : {}),
    };
  });

  const merged: VideoEntry = {
    ...next,
    snapshotId: existing.snapshotId || next.snapshotId,
    titleZh: existing.titleEn === next.titleEn ? existing.titleZh : "",
    summaryZh: existing.summaryEn === next.summaryEn ? existing.summaryZh : "",
    segments,
  };
  if (translationInputsEqual(merged, existing)) {
    merged.translation = existing.translation;
  } else {
    merged.translation = {
      status: "pending",
      ...(existing.translation.model ? { model: existing.translation.model } : {}),
    };
  }
  return merged;
}

function supplementalTranscriptMatchesVideo(
  index: SourceIndexEntry,
  embedUrl: string | undefined,
  existing: VideoEntry | undefined,
): existing is VideoEntry {
  if (
    !existing ||
    existing.id !== index.id ||
    existing.contentKind === "none" ||
    !existing.segments.length
  ) {
    return false;
  }

  // youtube-captions.ts records the caption video's URL as transcriptSource.
  // Only reuse it while both the archive entry and its video still match.
  const captionId = youtubeIdFromUrl(existing.transcriptSource);
  const oldSourceId = youtubeIdFromUrl(existing.sourceUrl);
  const newSourceId = youtubeIdFromUrl(index.source);
  const sameSource = oldSourceId && newSourceId
    ? oldSourceId === newSourceId
    : existing.sourceUrl === index.source;
  return Boolean(
    sameSource &&
    captionId &&
    captionId === (youtubeIdFromUrl(existing.embedUrl) ?? oldSourceId) &&
    captionId === (youtubeIdFromUrl(embedUrl) ?? newSourceId),
  );
}

export function buildVideoEntry(
  index: SourceIndexEntry,
  options: BuildVideoOptions,
  existing?: VideoEntry,
): VideoEntry {
  const transcript = options.transcript;
  const detail = options.detail;
  const candidateEmbed = transcript?.embedUrl ?? detail?.embedUrl;
  const embedUrl = normalizeEmbedUrl(index.source, candidateEmbed);
  const supplementalTranscript = supplementalTranscriptMatchesVideo(index, embedUrl, existing)
    ? existing
    : undefined;
  const content =
    transcript && transcript.contentKind !== "none" && transcript.segments.length
      ? transcript
      : detail && detail.contentKind !== "none" && detail.segments.length
        ? detail
        : supplementalTranscript ?? { contentKind: "none" as const, segments: [] };
  const transcriptSource = content === supplementalTranscript
    ? supplementalTranscript?.transcriptSource
    : transcript?.transcriptSource ?? detail?.transcriptSource;
  const thumbnailUrl = thumbnailForVideo(
    index.source,
    embedUrl,
    detail?.thumbnailUrl,
  ) ?? thumbnailForVideo(index.source, embedUrl, existing?.thumbnailUrl);

  const withoutHash: Omit<VideoEntry, "sourceHash"> = {
    id: index.id,
    slug: index.id,
    snapshotId: options.snapshotId,
    type: index.type,
    date: index.date,
    titleEn: transcript?.title ?? detail?.title ?? index.title,
    titleZh: "",
    summaryEn: transcript?.summary ?? detail?.summary ?? "",
    summaryZh: "",
    sourceUrl: index.source,
    ...(index.sourceLabel || transcript?.sourceLabel
      ? { sourceLabel: index.sourceLabel ?? transcript?.sourceLabel }
      : {}),
    archiveUrl: index.url,
    ...(embedUrl ? { embedUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(index.org ? { org: index.org } : {}),
    ...(index.durationSec !== undefined
      ? { durationSec: index.durationSec }
      : {}),
    contentKind: content.contentKind,
    segments: content.segments,
    translation: { status: "pending" },
    fetchedAt: options.fetchedAt,
    ...(transcriptSource ? { transcriptSource } : {}),
  };
  const next: VideoEntry = {
    ...withoutHash,
    sourceHash: hashSource(withoutHash),
  };
  return mergeExistingTranslations(next, existing);
}

export function transcriptNeedsHtmlFallback(
  transcript: ParsedTranscript | undefined,
  sourceUrl?: string,
): boolean {
  return (
    !transcript ||
    transcript.contentKind === "none" ||
    !transcript.segments.length ||
    !transcript.summary ||
    (!transcript.embedUrl && !!sourceUrl && !youtubeIdFromUrl(sourceUrl))
  );
}
