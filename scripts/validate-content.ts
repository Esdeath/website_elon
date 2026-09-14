import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { VideoEntry } from "../src/lib/types";
import { compareNumericIntegrity } from "./translation-integrity";
import { loadVideoFiles } from "./translate-videos";

export interface ValidationIssue {
  severity: "error" | "warning";
  id?: string;
  field?: string;
  message: string;
}

export interface ValidationOptions {
  expectedCount?: number;
  expectedIds?: ReadonlySet<string>;
  expectedSnapshotId?: string;
  allowIncomplete?: boolean;
  env?: NodeJS.ProcessEnv;
}

const VIDEO_TYPES = new Set(["interview", "keynote", "speech", "earnings", "space"]);
const CONTENT_KINDS = new Set(["dialogue", "article", "none"]);
const PRESERVED_TERMS = [
  "Model 3",
  "Model S",
  "Model X",
  "Model Y",
  "Falcon 9",
  "Falcon Heavy",
  "Raptor",
  "Super Heavy",
  "Cybertruck",
  "Tesla",
  "SpaceX",
  "xAI",
  "Starlink",
  "Starship",
  "Optimus",
  "Neuralink",
  "Grok",
  "NASA",
  "AllThingsD",
  "Big Think",
  "VivaTech",
  "Clubhouse",
  "Cyber Rodeo",
];

function validWebUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validIsoTime(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

function needsHan(source: string): boolean {
  let remainder = source
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:[A-Za-z0-9-]+\.)+(?:com|org|net|ai|io|co)\b/gi, " ");
  for (const term of PRESERVED_TERMS) {
    remainder = remainder.replaceAll(term, " ");
  }
  const substantiveWords = remainder.match(/\b(?=[A-Za-z]{2,}\b)[A-Za-z]*[a-z][A-Za-z]*\b/g) ?? [];
  return substantiveWords.length >= 2;
}

function hasHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function preservesSpeakerName(field: string, source: string, translation: string): boolean {
  if (!field.endsWith(".speakerZh")) return false;
  const nameLike = /^(?:[A-Z][A-Za-z'’-]+|[A-Z]{2,})(?:\s+(?:[A-Z][A-Za-z'’-]+|[A-Z]{2,}))+(?:\s*\([^)]*\))?$/u;
  if (!nameLike.test(source.trim())) return false;
  const normalized = (value: string) =>
    value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
  return normalized(source) === normalized(translation);
}

function isNumericUtterance(source: string): boolean {
  const remainder = source
    .replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and|a|an|half|point|percent|percentage)\b/gi, " ")
    .replace(/[\d\s.,!?;:'"()%+\-/]/g, "");
  return remainder.length === 0;
}

export function computeSourceHash(entry: VideoEntry): string {
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

function validateTranslatedText(
  issues: ValidationIssue[],
  id: string,
  field: string,
  source: string,
  translation: string,
  allowIncomplete: boolean,
): void {
  if (!source.trim()) return;
  if (!translation.trim()) {
    if (!allowIncomplete) {
      issues.push({ severity: "error", id, field, message: "missing Chinese translation" });
    }
    return;
  }
  if (
    needsHan(source) &&
    !hasHan(translation) &&
    !preservesSpeakerName(field, source, translation) &&
    !isNumericUtterance(source)
  ) {
    issues.push({
      severity: "error",
      id,
      field,
      message: "translation contains no Chinese characters",
    });
  }
  const sourceWords = source.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length ?? 0;
  const minimumLength = source.length >= 80
    ? Math.ceil(source.length * 0.08)
    : source.length >= 40 && sourceWords >= 6
      ? 3
      : source.length >= 24 && sourceWords >= 5
        ? 2
        : 0;
  if (minimumLength > 0 && translation.trim().length < minimumLength) {
    issues.push({
      severity: "error",
      id,
      field,
      message: "translation is implausibly short for its source",
    });
  }
  const residualWithoutUrls = translation.replace(/https?:\/\/\S+/g, " ");
  const preservedSourceNames = source.match(
    /\b(?:[A-Z]{2,}(?:\s+(?:[A-Z]{2,}|[A-Z][a-z]+)){0,4}|[A-Z][a-z]+(?:\s+(?:[A-Z]{2,}|[A-Z][a-z]+)){1,4})\b/g,
  ) ?? [];
  const residual = [...PRESERVED_TERMS, ...preservedSourceNames].reduce(
    (value, term) => value.replaceAll(term, ""),
    residualWithoutUrls,
  );
  const latinCount = (residual.match(/[A-Za-z]/g) ?? []).length;
  const latinWords = residual.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length ?? 0;
  const hanCount = (translation.match(/\p{Script=Han}/gu) ?? []).length;
  if (latinWords > 4 && latinCount > 12 && latinCount > hanCount * 1.5) {
    issues.push({
      severity: "error",
      id,
      field,
      message: "translation contains excessive residual English",
    });
  }
  const numericComparison = compareNumericIntegrity(source, translation);
  if (numericComparison.level !== "ok") {
    issues.push({
      severity: numericComparison.level === "error" ? "error" : "warning",
      id,
      field,
      message: numericComparison.level === "error"
        ? "translation changed, added, or removed numeric values"
        : "complex numeric expression needs human review",
    });
  }
}

function validateEntry(
  entry: VideoEntry,
  issues: ValidationIssue[],
  allowIncomplete: boolean,
): void {
  const id = typeof entry?.id === "string" && entry.id ? entry.id : "<unknown>";
  const requiredStrings: Array<[keyof VideoEntry, unknown]> = [
    ["id", entry?.id],
    ["slug", entry?.slug],
    ["snapshotId", entry?.snapshotId],
    ["titleEn", entry?.titleEn],
    ["sourceHash", entry?.sourceHash],
  ];
  for (const [field, value] of requiredStrings) {
    if (typeof value !== "string" || !value.trim()) {
      issues.push({ severity: "error", id, field, message: "must be a non-empty string" });
    }
  }
  if (!VIDEO_TYPES.has(entry?.type)) {
    issues.push({ severity: "error", id, field: "type", message: "unknown video type" });
  }
  if (!CONTENT_KINDS.has(entry?.contentKind)) {
    issues.push({ severity: "error", id, field: "contentKind", message: "unknown content kind" });
  }
  if (!validDate(entry?.date)) {
    issues.push({ severity: "error", id, field: "date", message: "must be YYYY-MM-DD" });
  }
  if (!validIsoTime(entry?.fetchedAt)) {
    issues.push({ severity: "error", id, field: "fetchedAt", message: "must be an ISO timestamp" });
  }
  for (const field of ["sourceUrl", "archiveUrl"] as const) {
    if (!validWebUrl(entry?.[field])) {
      issues.push({ severity: "error", id, field, message: "must be an HTTP(S) URL" });
    }
  }
  if (validWebUrl(entry?.archiveUrl)) {
    const archive = new URL(entry.archiveUrl);
    if (
      archive.hostname !== "elonmuskarchive.org" ||
      archive.pathname.replace(/\/$/, "") !== `/video/${encodeURIComponent(entry.id)}`
    ) {
      issues.push({
        severity: "error",
        id,
        field: "archiveUrl",
        message: "must point to this id on elonmuskarchive.org",
      });
    }
  }
  for (const field of ["embedUrl", "thumbnailUrl"] as const) {
    const value = entry?.[field];
    if (value !== undefined && !validWebUrl(value)) {
      issues.push({ severity: "error", id, field, message: "must be an HTTP(S) URL" });
    }
  }
  if (entry?.embedUrl && validWebUrl(entry.embedUrl)) {
    const host = new URL(entry.embedUrl).hostname;
    if (host !== "youtube-nocookie.com" && host !== "www.youtube-nocookie.com") {
      issues.push({
        severity: "error",
        id,
        field: "embedUrl",
        message: "embedded videos must use youtube-nocookie.com",
      });
    }
  }
  if (
    entry?.durationSec !== undefined &&
    (!Number.isFinite(entry.durationSec) || entry.durationSec < 0)
  ) {
    issues.push({ severity: "error", id, field: "durationSec", message: "must be non-negative" });
  }
  if (!Array.isArray(entry?.segments)) {
    issues.push({ severity: "error", id, field: "segments", message: "must be an array" });
    return;
  }
  if (entry.contentKind === "none" && entry.segments.length > 0) {
    issues.push({
      severity: "error",
      id,
      field: "segments",
      message: "contentKind=none cannot contain transcript segments",
    });
  }
  if (entry.contentKind !== "none" && entry.segments.length === 0) {
    issues.push({
      severity: "error",
      id,
      field: "segments",
      message: `${entry.contentKind} content must contain transcript segments`,
    });
  }

  validateTranslatedText(
    issues,
    id,
    "titleZh",
    entry.titleEn ?? "",
    entry.titleZh ?? "",
    allowIncomplete,
  );
  validateTranslatedText(
    issues,
    id,
    "summaryZh",
    entry.summaryEn ?? "",
    entry.summaryZh ?? "",
    allowIncomplete,
  );

  const segmentIds = new Set<string>();
  let sourceBodyLength = 0;
  let translationBodyLength = 0;
  let priorStart = -1;
  let priorTranslation: { source: string; translation: string } | undefined;
  for (const [index, segment] of entry.segments.entries()) {
    const field = `segments[${index}]`;
    if (typeof segment.id !== "string" || !segment.id.trim()) {
      issues.push({ severity: "error", id, field: `${field}.id`, message: "missing stable id" });
    } else if (segmentIds.has(segment.id)) {
      issues.push({ severity: "error", id, field: `${field}.id`, message: "duplicate segment id" });
    } else {
      segmentIds.add(segment.id);
    }
    if (typeof segment.textEn !== "string" || !segment.textEn.trim()) {
      issues.push({ severity: "error", id, field: `${field}.textEn`, message: "missing source text" });
    }
    sourceBodyLength += segment.textEn?.trim().length ?? 0;
    translationBodyLength += segment.textZh?.trim().length ?? 0;
    validateTranslatedText(
      issues,
      id,
      `${field}.textZh`,
      segment.textEn ?? "",
      segment.textZh ?? "",
      allowIncomplete,
    );
    if (
      segment.textZh.trim().length >= 30 &&
      priorTranslation?.translation === segment.textZh.trim() &&
      priorTranslation.source !== segment.textEn.trim()
    ) {
      issues.push({
        severity: "error",
        id,
        field: `${field}.textZh`,
        message: "duplicates the previous segment translation for different source text",
      });
    }
    priorTranslation = {
      source: segment.textEn.trim(),
      translation: segment.textZh.trim(),
    };
    if (segment.speakerEn) {
      validateTranslatedText(
        issues,
        id,
        `${field}.speakerZh`,
        segment.speakerEn,
        segment.speakerZh ?? "",
        allowIncomplete,
      );
    }
    if (
      segment.startSec !== undefined &&
      (!Number.isFinite(segment.startSec) || segment.startSec < 0)
    ) {
      issues.push({ severity: "error", id, field: `${field}.startSec`, message: "must be non-negative" });
    } else if (segment.startSec !== undefined) {
      if (segment.startSec < priorStart) {
        issues.push({
          severity: "error",
          id,
          field: `${field}.startSec`,
          message: "timestamps must be non-decreasing",
        });
      }
      priorStart = segment.startSec;
    }
  }

  if (
    !allowIncomplete &&
    sourceBodyLength >= 1_000 &&
    translationBodyLength < sourceBodyLength * 0.08
  ) {
    issues.push({
      severity: "error",
      id,
      field: "segments",
      message: "total Chinese transcript is implausibly short for its source",
    });
  }

  if (!entry.translation || typeof entry.translation !== "object") {
    issues.push({ severity: "error", id, field: "translation", message: "missing state" });
  } else if (!allowIncomplete && entry.translation.status !== "reviewed") {
    issues.push({
      severity: "error",
      id,
      field: "translation.status",
      message: `expected reviewed, got ${entry.translation.status}`,
    });
  } else if (
    entry.translation.status === "reviewed" &&
    !validIsoTime(entry.translation.reviewedAt)
  ) {
    issues.push({
      severity: "error",
      id,
      field: "translation.reviewedAt",
      message: "reviewed content needs a valid timestamp",
    });
  }
  if (entry.translation?.status === "reviewed" && !entry.translation.model?.trim()) {
    issues.push({
      severity: "error",
      id,
      field: "translation.model",
      message: "reviewed content needs its model recorded",
    });
  }
  if (entry.sourceMissing) {
    issues.push({
      severity: "warning",
      id,
      field: "sourceMissing",
      message: "entry is no longer present upstream and was retained",
    });
  }
}

function validateEnvironment(env: NodeJS.ProcessEnv, issues: ValidationIssue[]): void {
  const contact = env.PUBLIC_CONTACT_EMAIL?.trim();
  if (env.CF_PAGES === "1" && !contact) {
    issues.push({
      severity: "error",
      field: "PUBLIC_CONTACT_EMAIL",
      message: "is required for Cloudflare Pages production builds",
    });
  }
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    issues.push({
      severity: "error",
      field: "PUBLIC_CONTACT_EMAIL",
      message: "is not a valid email address",
    });
  }
  const siteUrl = env.PUBLIC_SITE_URL?.trim();
  if (env.CF_PAGES === "1" && !siteUrl) {
    issues.push({
      severity: "error",
      field: "PUBLIC_SITE_URL",
      message: "is required for Cloudflare Pages production builds",
    });
  }
  if (siteUrl && !validWebUrl(siteUrl)) {
    issues.push({
      severity: "error",
      field: "PUBLIC_SITE_URL",
      message: "must be an HTTP(S) URL",
    });
  }
}

export function validateVideoEntries(
  entries: VideoEntry[],
  options: ValidationOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (options.expectedCount !== undefined && entries.length !== options.expectedCount) {
    issues.push({
      severity: "error",
      message: `expected ${options.expectedCount} video entries, found ${entries.length}`,
    });
  }
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const expectedSnapshotId = options.expectedSnapshotId;
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      issues.push({ severity: "error", id: entry.id, field: "id", message: "duplicate id" });
    }
    ids.add(entry.id);
    if (slugs.has(entry.slug)) {
      issues.push({ severity: "error", id: entry.id, field: "slug", message: "duplicate slug" });
    }
    slugs.add(entry.slug);
    validateEntry(entry, issues, options.allowIncomplete ?? false);
    if (expectedSnapshotId && entry.snapshotId !== expectedSnapshotId) {
      issues.push({
        severity: "error",
        id: entry.id,
        field: "snapshotId",
        message: `expected ${expectedSnapshotId}, got ${entry.snapshotId}`,
      });
    }
    if (entry.sourceHash !== computeSourceHash(entry)) {
      issues.push({
        severity: "error",
        id: entry.id,
        field: "sourceHash",
        message: "does not match the canonical English source fields",
      });
    }
  }
  for (const expectedId of options.expectedIds ?? []) {
    if (!ids.has(expectedId)) {
      issues.push({
        severity: "error",
        id: expectedId,
        field: "id",
        message: "missing required baseline video",
      });
    }
  }
  validateEnvironment(options.env ?? process.env, issues);
  return issues;
}

interface ValidateCliOptions extends ValidationOptions {
  dataDir: string;
  manifestPath: string;
}

export function parseValidateArgs(
  argv: string[],
  cwd = process.cwd(),
): ValidateCliOptions {
  const options: ValidateCliOptions = {
    dataDir: resolve(cwd, "src/content/videos"),
    manifestPath: resolve(cwd, "data/snapshots/2026-09-12-video-ids.json"),
    expectedCount: process.env.EXPECTED_VIDEO_COUNT
      ? Number(process.env.EXPECTED_VIDEO_COUNT)
      : undefined,
    expectedSnapshotId: process.env.EXPECTED_SNAPSHOT_ID,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-incomplete") {
      options.allowIncomplete = true;
      continue;
    }
    const [name, inline] = argument.split("=", 2);
    if (name !== "--data-dir" && name !== "--expected-count" && name !== "--manifest") {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = inline || argv[++index];
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--data-dir") options.dataDir = resolve(cwd, value);
    if (name === "--expected-count") options.expectedCount = Number(value);
    if (name === "--manifest") options.manifestPath = resolve(cwd, value);
  }
  if (
    options.expectedCount !== undefined &&
    (!Number.isInteger(options.expectedCount) || options.expectedCount < 0)
  ) {
    throw new Error("--expected-count must be a non-negative integer");
  }
  return options;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseValidateArgs(argv);
  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as unknown;
  if (!Array.isArray(manifest) || manifest.some((id) => typeof id !== "string")) {
    throw new Error(`Invalid video id manifest: ${options.manifestPath}`);
  }
  options.expectedIds = new Set(manifest);
  const files = await loadVideoFiles(options.dataDir);
  const issues = validateVideoEntries(
    files.map(({ entry }) => entry),
    options,
  );
  for (const issue of issues) {
    const location = [issue.id, issue.field].filter(Boolean).join(":");
    const prefix = issue.severity === "error" ? "ERROR" : "WARN";
    console[issue.severity === "error" ? "error" : "warn"](
      `[validate] ${prefix}${location ? ` ${location}` : ""}: ${issue.message}`,
    );
  }
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(`Content validation failed with ${errors.length} error(s)`);
  }
  console.log(`[validate] ${files.length} entries valid`);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
