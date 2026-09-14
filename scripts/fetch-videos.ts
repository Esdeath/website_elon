#!/usr/bin/env node

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { VideoEntry } from "../src/lib/types";
import {
  buildVideoEntry,
  INITIAL_SNAPSHOT_COUNT,
  parseDetailHtml,
  parseIndexPayload,
  parseTranscriptPayload,
  SOURCE_INDEX_URL,
  SOURCE_ORIGIN,
  transcriptNeedsHtmlFallback,
  type ParsedDetail,
  type ParsedTranscript,
  type SourceIndexEntry,
} from "./source";

const DEFAULT_OUTPUT_DIR = path.resolve("src/content/videos");
const REQUEST_TIMEOUT_MS = Number(process.env.SOURCE_REQUEST_TIMEOUT_MS ?? "120000");
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 4;

interface CliOptions {
  ids?: Set<string>;
  limit?: number;
  dataDir: string;
  force: boolean;
  resume: boolean;
}

interface ExistingState {
  entries: Map<string, VideoEntry>;
  invalidIds: Set<string>;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

function readOptionValue(args: string[], index: number, name: string): [string, number] {
  const argument = args[index];
  const inline = argument.slice(name.length + 1);
  if (argument.startsWith(`${name}=`)) return [inline, index];
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return [value, index + 1];
}

export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: DEFAULT_OUTPUT_DIR,
    force: false,
    resume: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--force") options.force = true;
    else if (argument === "--resume") options.resume = true;
    else if (argument === "--help") {
      console.log(
        "Usage: npm run sync:fetch -- [--ids id-a,id-b] [--limit N] [--data-dir PATH] [--force] [--resume]",
      );
      process.exit(0);
    } else if (argument === "--ids" || argument.startsWith("--ids=")) {
      const [value, consumed] = readOptionValue(args, index, "--ids");
      index = consumed;
      const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
      if (!ids.length || ids.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id))) {
        throw new Error("--ids must be a comma-separated list of source ids");
      }
      options.ids = new Set([...(options.ids ?? []), ...ids]);
    } else if (argument === "--limit" || argument.startsWith("--limit=")) {
      const [value, consumed] = readOptionValue(args, index, "--limit");
      index = consumed;
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = limit;
    } else if (
      argument === "--data-dir" ||
      argument.startsWith("--data-dir=")
    ) {
      const [value, consumed] = readOptionValue(args, index, "--data-dir");
      index = consumed;
      options.dataDir = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (options.force && options.resume) {
    throw new Error("--force and --resume cannot be used together");
  }
  return options;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchResponse(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json,text/html;q=0.9,*/*;q=0.8",
          "user-agent": "musk-zh-archive/0.1 (+non-commercial research archive)",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok || response.status === 404) return response;
      throw new HttpError(response.status, url);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(400 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
}

async function fetchIndex(): Promise<SourceIndexEntry[]> {
  const response = await fetchResponse(SOURCE_INDEX_URL);
  if (!response.ok) throw new HttpError(response.status, SOURCE_INDEX_URL);
  const entries = parseIndexPayload(await response.json());
  if (entries.length < INITIAL_SNAPSHOT_COUNT) {
    throw new Error(
      `Source index returned only ${entries.length} videos; expected at least ${INITIAL_SNAPSHOT_COUNT}. Refusing to mark removals.`,
    );
  }
  return entries;
}

async function fetchTranscript(id: string): Promise<ParsedTranscript | undefined> {
  const url = `${SOURCE_ORIGIN}/agents/transcript/${encodeURIComponent(id)}`;
  const response = await fetchResponse(url);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new HttpError(response.status, url);
  return parseTranscriptPayload(await response.json());
}

async function fetchDetail(url: string): Promise<ParsedDetail> {
  const response = await fetchResponse(url);
  if (!response.ok) throw new HttpError(response.status, url);
  return parseDetailHtml(await response.text());
}

function looksLikeVideoEntry(value: unknown): value is VideoEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<VideoEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.sourceHash === "string" &&
    Array.isArray(entry.segments) &&
    typeof entry.translation?.status === "string"
  );
}

async function readExisting(outputDir: string): Promise<ExistingState> {
  const entries = new Map<string, VideoEntry>();
  const invalidIds = new Set<string>();
  await mkdir(outputDir, { recursive: true });
  const files = (await readdir(outputDir)).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    try {
      const value: unknown = JSON.parse(
        await readFile(path.join(outputDir, file), "utf8"),
      );
      if (!looksLikeVideoEntry(value) || value.id !== id) {
        throw new Error("content does not match its filename");
      }
      entries.set(id, value);
    } catch (error) {
      invalidIds.add(id);
      console.error(
        `[invalid] ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { entries, invalidIds };
}

async function atomicWrite(entry: VideoEntry, outputDir: string): Promise<void> {
  const destination = path.join(outputDir, `${entry.id}.json`);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function mapConcurrent<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

async function updateRemovedEntries(
  allSourceIds: Set<string>,
  existing: ExistingState,
  outputDir: string,
): Promise<number> {
  let marked = 0;
  for (const [id, entry] of existing.entries) {
    if (allSourceIds.has(id) || entry.sourceMissing) continue;
    await atomicWrite({ ...entry, sourceMissing: true }, outputDir);
    marked += 1;
    console.log(`[missing] ${id}`);
  }
  return marked;
}

async function run(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const existing = await readExisting(options.dataDir);
  const index = await fetchIndex();
  const allSourceIds = new Set(index.map((entry) => entry.id));

  const unknownRequested = [...(options.ids ?? [])].filter(
    (id) => !allSourceIds.has(id),
  );
  if (unknownRequested.length) {
    throw new Error(`Requested ids are not in the source index: ${unknownRequested.join(", ")}`);
  }

  let selected = options.ids
    ? index.filter((entry) => options.ids!.has(entry.id))
    : index;
  if (options.resume) {
    selected = selected.filter(
      (entry) => !existing.entries.has(entry.id) || existing.entries.get(entry.id)?.sourceMissing,
    );
  }
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);

  const summary = { written: 0, unchanged: 0, failed: 0, missing: 0 };
  const snapshotId = new Date().toISOString().slice(0, 10);
  await mapConcurrent(selected, CONCURRENCY, async (indexEntry) => {
    if (existing.invalidIds.has(indexEntry.id)) {
      summary.failed += 1;
      console.error(`[failed] ${indexEntry.id}: existing JSON is invalid; left untouched`);
      return;
    }
    try {
      const transcript = await fetchTranscript(indexEntry.id);
      const detail = transcriptNeedsHtmlFallback(transcript, indexEntry.source)
        ? await fetchDetail(indexEntry.url)
        : undefined;
      const oldEntry = existing.entries.get(indexEntry.id);
      const nextEntry = buildVideoEntry(
        indexEntry,
        {
          fetchedAt: new Date().toISOString(),
          snapshotId,
          transcript,
          detail,
        },
        oldEntry,
      );

      if (
        !options.force &&
        oldEntry?.sourceHash === nextEntry.sourceHash &&
        !oldEntry.sourceMissing
      ) {
        summary.unchanged += 1;
        console.log(`[unchanged] ${indexEntry.id}`);
        return;
      }
      await atomicWrite(nextEntry, options.dataDir);
      existing.entries.set(indexEntry.id, nextEntry);
      summary.written += 1;
      console.log(`[written] ${indexEntry.id} (${nextEntry.contentKind})`);
    } catch (error) {
      summary.failed += 1;
      console.error(
        `[failed] ${indexEntry.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  summary.missing = await updateRemovedEntries(
    allSourceIds,
    existing,
    options.dataDir,
  );
  console.log(
    `Fetch complete: ${summary.written} written, ${summary.unchanged} unchanged, ${summary.failed} failed, ${summary.missing} marked sourceMissing.`,
  );
  if (summary.failed) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
