import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { VideoEntry } from "../src/lib/types";
import { CodexUnitBatcher, type BatchedUnit } from "./codex-batcher";
import { processChunksConcurrently } from "./concurrent-chunks";
import {
  CodexInvocationError,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING,
  DEFAULT_CODEX_TIMEOUT_MS,
  runCodexStructured,
} from "./codex-runner";
import {
  TRANSLATION_SCHEMA,
  applyCompletedParts,
  assertNumbersPreserved,
  assertTranslationOutput,
  buildBatchTranslationPrompt,
  buildTranslationPrompt,
  checkpointPath,
  chunkUnits,
  createCheckpoint,
  expandOversizedUnits,
  getTranslationUnits,
  numbersArePreserved,
  readCheckpoint,
  unitSourceHash,
  writeCheckpoint,
  writeJsonAtomic,
  type TranslationCheckpoint,
  type TranslationOutput,
  type TranslationUnit,
  type VideoFile,
} from "./codex-content";
import { withVideoEntryLock } from "./video-entry-lock";

export interface TranslateOptions {
  dataDir: string;
  checkpointDir: string;
  ids?: Set<string>;
  limit?: number;
  force: boolean;
  resume: boolean;
  concurrency: number;
  chunkCharacters: number;
  model: string;
  reasoning: string;
  timeoutMs: number;
  retries: number;
  cwd: string;
}

export type TranslateChunk = (
  entry: VideoEntry,
  units: TranslationUnit[],
  options: TranslateOptions,
) => Promise<TranslationOutput>;

export interface TranslateSummary {
  selected: number;
  translated: number;
  skipped: number;
  failed: number;
}

function unitSourceMatchesCheckpoint(
  unit: TranslationUnit,
  checkpoint: TranslationCheckpoint,
  fallbackChunkCharacters: number,
): boolean {
  if (checkpoint.units[unit.id]?.sourceHash === unitSourceHash(unit)) return true;
  const parts = expandOversizedUnits(
    [unit],
    checkpoint.translationChunkCharacters ?? fallbackChunkCharacters,
  );
  return (
    parts.length > 1 &&
    parts.every(
      (part) =>
        checkpoint.units[part.id]?.sourceHash === unitSourceHash(part),
    )
  );
}

function translationSourcesMatchCheckpoint(
  entry: VideoEntry,
  checkpoint: TranslationCheckpoint,
  fallbackChunkCharacters: number,
): boolean {
  return getTranslationUnits(entry).every((unit) =>
    unitSourceMatchesCheckpoint(unit, checkpoint, fallbackChunkCharacters),
  );
}

function valueAfter(argv: string[], index: number, option: string): [string, number] {
  const inline = argv[index].slice(option.length + 1);
  if (inline) return [inline, index];
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return [value, index + 1];
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function nonnegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

export function parseTranslateArgs(
  argv: string[],
  cwd = process.cwd(),
): TranslateOptions {
  const options: TranslateOptions = {
    dataDir: resolve(cwd, "src/content/videos"),
    checkpointDir: resolve(cwd, "tmp/translation-checkpoints"),
    force: false,
    resume: false,
    concurrency: positiveInteger(
      process.env.CODEX_TRANSLATION_CONCURRENCY ??
        process.env.TRANSLATION_CONCURRENCY ??
        "1",
      "CODEX_TRANSLATION_CONCURRENCY",
    ),
    chunkCharacters: positiveInteger(
      process.env.CODEX_TRANSLATION_CHUNK_CHARS ?? "12000",
      "CODEX_TRANSLATION_CHUNK_CHARS",
    ),
    model: process.env.CODEX_TRANSLATION_MODEL ?? DEFAULT_CODEX_MODEL,
    reasoning: process.env.CODEX_TRANSLATION_REASONING ?? DEFAULT_CODEX_REASONING,
    timeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
    retries: 2,
    cwd,
  };
  const ids = new Set<string>();
  let idsSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") {
      options.force = true;
    } else if (argument === "--resume") {
      options.resume = true;
    } else if (argument === "--no-resume") {
      options.resume = false;
    } else if (argument === "--ids" || argument.startsWith("--ids=")) {
      idsSpecified = true;
      const [value, nextIndex] = valueAfter(argv, index, "--ids");
      index = nextIndex;
      const parsedIds = value.split(",").map((part) => part.trim()).filter(Boolean);
      if (
        parsedIds.length === 0 ||
        parsedIds.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id))
      ) {
        throw new Error("--ids must contain one or more comma-separated video ids");
      }
      for (const id of parsedIds) {
        ids.add(id);
      }
    } else if (argument === "--limit" || argument.startsWith("--limit=")) {
      const [value, nextIndex] = valueAfter(argv, index, "--limit");
      index = nextIndex;
      options.limit = positiveInteger(value, "--limit");
    } else if (
      argument === "--concurrency" ||
      argument.startsWith("--concurrency=")
    ) {
      const [value, nextIndex] = valueAfter(argv, index, "--concurrency");
      index = nextIndex;
      options.concurrency = positiveInteger(value, "--concurrency");
    } else if (
      argument === "--chunk-chars" ||
      argument.startsWith("--chunk-chars=")
    ) {
      const [value, nextIndex] = valueAfter(argv, index, "--chunk-chars");
      index = nextIndex;
      options.chunkCharacters = positiveInteger(value, "--chunk-chars");
    } else if (
      argument === "--timeout-ms" ||
      argument.startsWith("--timeout-ms=")
    ) {
      const [value, nextIndex] = valueAfter(argv, index, "--timeout-ms");
      index = nextIndex;
      options.timeoutMs = positiveInteger(value, "--timeout-ms");
    } else if (argument === "--retries" || argument.startsWith("--retries=")) {
      const [value, nextIndex] = valueAfter(argv, index, "--retries");
      index = nextIndex;
      options.retries = nonnegativeInteger(value, "--retries");
    } else if (argument === "--model" || argument.startsWith("--model=")) {
      const [value, nextIndex] = valueAfter(argv, index, "--model");
      index = nextIndex;
      options.model = value;
    } else if (
      argument === "--reasoning" ||
      argument.startsWith("--reasoning=")
    ) {
      const [value, nextIndex] = valueAfter(argv, index, "--reasoning");
      index = nextIndex;
      options.reasoning = value;
    } else if (
      argument === "--data-dir" ||
      argument.startsWith("--data-dir=")
    ) {
      const [value, nextIndex] = valueAfter(argv, index, "--data-dir");
      index = nextIndex;
      options.dataDir = resolve(cwd, value);
    } else if (
      argument === "--checkpoint-dir" ||
      argument.startsWith("--checkpoint-dir=")
    ) {
      const [value, nextIndex] = valueAfter(argv, index, "--checkpoint-dir");
      index = nextIndex;
      options.checkpointDir = resolve(cwd, value);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (idsSpecified) options.ids = ids;
  return options;
}

export async function loadVideoFiles(dataDir: string): Promise<VideoFile[]> {
  const names = (await readdir(dataDir))
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(
    names.map(async (name) => {
      const path = resolve(dataDir, name);
      return {
        path,
        entry: JSON.parse(await readFile(path, "utf8")) as VideoEntry,
      };
    }),
  );
}

export async function translateChunkWithCodex(
  entry: VideoEntry,
  units: TranslationUnit[],
  options: TranslateOptions,
): Promise<TranslationOutput> {
  return runCodexStructured<TranslationOutput>(buildTranslationPrompt(entry, units), {
    schema: TRANSLATION_SCHEMA,
    model: options.model,
    reasoning: options.reasoning,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    cwd: options.cwd,
  });
}

function createBatchedTranslateChunk(options: TranslateOptions): TranslateChunk {
  const batcher = new CodexUnitBatcher<{ textZh: string; speakerZh: string }>(
    options.chunkCharacters,
    options.concurrency,
    async (items: BatchedUnit[]) => {
      const wireUnits = items.map(({ globalId, unit }) => ({
        ...unit,
        id: globalId,
      }));
      const output = await runCodexStructured<TranslationOutput>(
        buildBatchTranslationPrompt(items),
        {
          schema: TRANSLATION_SCHEMA,
          model: options.model,
          reasoning: options.reasoning,
          timeoutMs: options.timeoutMs,
          retries: options.retries,
          cwd: options.cwd,
        },
      );
      return assertTranslationOutput(wireUnits, output);
    },
  );
  return async (entry, units) => {
    const results = await batcher.enqueue(entry, units);
    return {
      translations: units.map((unit) => {
        const result = results.get(unit.id);
        if (!result) throw new Error(`Batched translation omitted id: ${unit.id}`);
        return { id: unit.id, ...result };
      }),
    };
  };
}

async function translateOneLocked(
  file: VideoFile,
  options: TranslateOptions,
  translateChunk: TranslateChunk,
): Promise<"translated" | "skipped"> {
  // A long-running queue may have been loaded before another process finished
  // translating or reviewing this entry. Refresh it at dispatch time so that
  // completed work remains authoritative.
  file.entry = JSON.parse(await readFile(file.path, "utf8")) as VideoEntry;
  const checkpointFile = checkpointPath(options.checkpointDir, file.entry.id);
  const previousCheckpoint = options.resume
    ? await readCheckpoint(checkpointFile)
    : undefined;
  const forcedResume = previousCheckpoint?.translationRun === "forced";
  const isolatedRun = options.force || forcedResume;
  const publishedEntry = isolatedRun ? structuredClone(file.entry) : undefined;
  const alreadyComplete =
    file.entry.translation.status === "translated" ||
    file.entry.translation.status === "reviewed";
  const completedEntrySourceChanged = Boolean(
    alreadyComplete &&
      options.resume &&
      previousCheckpoint &&
      previousCheckpoint.sourceHash !== file.entry.sourceHash,
  );
  if (
    !options.force &&
    !forcedResume &&
    alreadyComplete &&
    (!options.resume || !previousCheckpoint || previousCheckpoint.sourceHash === file.entry.sourceHash)
  ) {
    return "skipped";
  }
  if (
    !options.force &&
    !forcedResume &&
    completedEntrySourceChanged &&
    previousCheckpoint &&
    translationSourcesMatchCheckpoint(
      file.entry,
      previousCheckpoint,
      options.chunkCharacters,
    )
  ) {
    previousCheckpoint.sourceHash = file.entry.sourceHash;
    await writeCheckpoint(checkpointFile, previousCheckpoint);
    return "skipped";
  }

  const checkpoint = createCheckpoint(
    file.entry,
    options.model,
    options.force ? undefined : previousCheckpoint,
  );
  checkpoint.translationChunkCharacters = options.chunkCharacters;
  if (options.force) {
    checkpoint.translationRun = "forced";
    await writeCheckpoint(checkpointFile, checkpoint);
  }
  if (isolatedRun) {
    file.entry.titleZh = "";
    file.entry.summaryZh = "";
    for (const segment of file.entry.segments) {
      segment.textZh = "";
      segment.speakerZh = "";
    }
  }

  file.entry.translation = {
    ...file.entry.translation,
    status: "pending",
    model: options.model,
    reviewedAt: undefined,
    lastError: undefined,
  };
  if (!isolatedRun) await writeJsonAtomic(file.path, file.entry);

  const baseUnits = getTranslationUnits(file.entry);
  const workUnits = expandOversizedUnits(baseUnits, options.chunkCharacters);
  const baseComplete = new Map(
    baseUnits.map((unit) => [
      unit.id,
      Boolean(unit.textZh.trim() && (!unit.speakerEn || unit.speakerZh.trim())),
    ]),
  );
  const authoritativeParents = new Set<string>();

  if (options.resume && !options.force) {
    for (const base of baseUnits) {
      const parts = workUnits.filter(
        (unit) => (unit.parentId ?? unit.id) === base.id,
      );
      const savedParts = parts.map((part) => checkpoint.units[part.id]);
      const allSavedPartsMatch = parts.every((part, index) => {
        const saved = savedParts[index];
        return Boolean(
          saved &&
            saved.sourceHash === unitSourceHash(part) &&
            saved.textZh.trim() &&
            (!part.speakerEn || saved.speakerZh.trim()),
        );
      });
      const sourceMatchesCheckpoint = previousCheckpoint
        ? unitSourceMatchesCheckpoint(
            base,
            previousCheckpoint,
            options.chunkCharacters,
          )
        : false;
      if (
        baseComplete.get(base.id) &&
        !forcedResume &&
        (!completedEntrySourceChanged || sourceMatchesCheckpoint)
      ) {
        authoritativeParents.add(base.id);
        const savedText = allSavedPartsMatch
          ? savedParts.map((saved) => saved!.textZh.trim()).join("")
          : undefined;
        if (parts.length === 1) {
          checkpoint.units[base.id] = {
            sourceHash: unitSourceHash(base),
            textZh: base.textZh,
            speakerZh: base.speakerZh,
          };
        } else if (!allSavedPartsMatch || savedText !== base.textZh.trim()) {
          for (const part of parts) delete checkpoint.units[part.id];
          checkpoint.units[base.id] = {
            sourceHash: unitSourceHash(base),
            textZh: base.textZh,
            speakerZh: base.speakerZh,
          };
        }
        continue;
      }
      for (const [index, part] of parts.entries()) {
        const saved = savedParts[index];
        if (
          saved &&
          saved.sourceHash === unitSourceHash(part) &&
          saved.textZh.trim() &&
          (!part.speakerEn || saved.speakerZh.trim())
        ) {
          part.textZh = saved.textZh;
          part.speakerZh = saved.speakerZh;
        } else {
          part.textZh = "";
          part.speakerZh = "";
        }
      }
    }
    applyCompletedParts(file.entry, baseUnits, workUnits);
  }

  const invalidParentIds = new Set(
    getTranslationUnits(file.entry)
      .filter(
        (unit) =>
          unit.textZh.trim() &&
          !numbersArePreserved(unit.textEn, unit.textZh),
      )
      .map(({ id }) => id),
  );

  const pending = workUnits.filter((unit) => {
    if (options.force) return true;
    if (invalidParentIds.has(unit.parentId ?? unit.id)) return true;
    if (authoritativeParents.has(unit.parentId ?? unit.id)) return false;
    const saved = checkpoint.units[unit.id];
    if (options.resume) {
      return !(
        saved &&
        saved.sourceHash === unitSourceHash(unit) &&
        saved.textZh.trim() &&
        (!unit.speakerEn || saved.speakerZh.trim())
      );
    }
    return !baseComplete.get(unit.parentId ?? unit.id);
  });

  const pendingIds = new Set(pending.map((unit) => unit.id));
  for (const unit of workUnits) {
    if (pendingIds.has(unit.id)) continue;
    if (!unit.textZh.trim() || (unit.speakerEn && !unit.speakerZh.trim())) continue;
    checkpoint.units[unit.id] = {
      sourceHash: unitSourceHash(unit),
      textZh: unit.textZh,
      speakerZh: unit.speakerZh,
    };
  }

  try {
    await processChunksConcurrently(
      chunkUnits(pending, options.chunkCharacters),
      options.concurrency,
      async (chunk) => {
        const output = await translateChunk(file.entry, chunk, options);
        return assertTranslationOutput(chunk, output);
      },
      async (chunk, translations) => {
        for (const translatedUnit of chunk) {
          const translated = translations.get(translatedUnit.id)!;
          translatedUnit.textZh = translated.textZh;
          translatedUnit.speakerZh = translated.speakerZh;
          checkpoint.units[translatedUnit.id] = {
            sourceHash: unitSourceHash(translatedUnit),
            textZh: translatedUnit.textZh,
            speakerZh: translatedUnit.speakerZh,
          };
        }
        applyCompletedParts(file.entry, baseUnits, workUnits);
        checkpoint.sourceHash = file.entry.sourceHash;
        await writeCheckpoint(checkpointFile, checkpoint);
        if (!isolatedRun) await writeJsonAtomic(file.path, file.entry);
      },
    );

    const incomplete = getTranslationUnits(file.entry).filter(
      (unit) => !unit.textZh.trim() || (unit.speakerEn && !unit.speakerZh.trim()),
    );
    if (incomplete.length > 0) {
      throw new Error(
        `Translation is incomplete after all chunks: ${incomplete.map(({ id }) => id).join(", ")}`,
      );
    }
    for (const unit of getTranslationUnits(file.entry)) {
      assertNumbersPreserved(unit.textEn, unit.textZh, unit.id);
    }

    file.entry.translation = {
      status: "translated",
      model: options.model,
      translatedAt: new Date().toISOString(),
    };
    checkpoint.sourceHash = file.entry.sourceHash;
    await writeJsonAtomic(file.path, file.entry);
    delete checkpoint.translationRun;
    await writeCheckpoint(checkpointFile, checkpoint);
    return "translated";
  } catch (error) {
    if (publishedEntry) {
      publishedEntry.translation = {
        ...publishedEntry.translation,
        lastError: error instanceof Error ? error.message : String(error),
      };
      file.entry = publishedEntry;
      await writeJsonAtomic(file.path, file.entry);
      throw error;
    }
    file.entry.translation = {
      ...file.entry.translation,
      status: "failed",
      model: options.model,
      lastError: error instanceof Error ? error.message : String(error),
    };
    await writeJsonAtomic(file.path, file.entry);
    throw error;
  }
}

async function translateOne(
  file: VideoFile,
  options: TranslateOptions,
  translateChunk: TranslateChunk,
): Promise<"translated" | "skipped"> {
  return withVideoEntryLock(file.path, () =>
    translateOneLocked(file, options, translateChunk),
  );
}

export async function translateVideoFiles(
  files: VideoFile[],
  options: TranslateOptions,
  translateChunk?: TranslateChunk,
): Promise<TranslateSummary> {
  if (options.ids) {
    const known = new Set(
      files.flatMap(({ entry }) => [entry.id, entry.slug]),
    );
    const unknown = [...options.ids].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`Requested ids are not in the local snapshot: ${unknown.join(", ")}`);
    }
  }
  let selected = files.filter(({ entry }) =>
    options.ids ? options.ids.has(entry.id) || options.ids.has(entry.slug) : true,
  );
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);

  const summary: TranslateSummary = {
    selected: selected.length,
    translated: 0,
    skipped: 0,
    failed: 0,
  };
  let cursor = 0;
  let fatalError: unknown;
  const failures: Error[] = [];
  const batched = translateChunk === undefined;
  const activeTranslateChunk = translateChunk ?? createBatchedTranslateChunk(options);

  const worker = async () => {
    while (!fatalError) {
      const index = cursor;
      cursor += 1;
      const file = selected[index];
      if (!file) return;
      try {
        const outcome = await translateOne(file, options, activeTranslateChunk);
        summary[outcome] += 1;
        console.log(`[translate] ${file.entry.id}: ${outcome}`);
      } catch (error) {
        summary.failed += 1;
        const normalized = error instanceof Error ? error : new Error(String(error));
        failures.push(normalized);
        console.error(`[translate] ${file.entry.id}: ${normalized.message}`);
        if (error instanceof CodexInvocationError && error.kind === "usage-limit") {
          fatalError = error;
        }
      }
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          batched ? 64 : options.concurrency,
          Math.max(1, selected.length),
        ),
      },
      () => worker(),
    ),
  );

  if (fatalError) throw fatalError;
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} video translation(s) failed`);
  }
  return summary;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseTranslateArgs(argv);
  const files = await loadVideoFiles(options.dataDir);
  const summary = await translateVideoFiles(files, options);
  console.log(
    `[translate] done: ${summary.translated} translated, ${summary.skipped} skipped, ${summary.failed} failed`,
  );
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
