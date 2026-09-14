import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { VideoEntry } from "../src/lib/types";
import { CodexUnitBatcher, type BatchedUnit } from "./codex-batcher";
import { processChunksConcurrently } from "./concurrent-chunks";
import { CodexInvocationError, runCodexStructured } from "./codex-runner";
import {
  REVIEW_SCHEMA,
  applyCompletedParts,
  assertNumbersPreserved,
  assertReviewOutput,
  buildBatchReviewPrompt,
  buildReviewPrompt,
  checkpointPath,
  chunkUnits,
  createCheckpoint,
  expandOversizedUnits,
  getTranslationUnits,
  numbersArePreserved,
  readCheckpoint,
  unitReviewHash,
  unitSourceHash,
  writeCheckpoint,
  writeJsonAtomic,
  type ReviewOutput,
  type TranslationUnit,
  type VideoFile,
} from "./codex-content";
import {
  loadVideoFiles,
  parseTranslateArgs,
  type TranslateOptions,
} from "./translate-videos";
import { withVideoEntryLock } from "./video-entry-lock";

export type ReviewChunk = (
  entry: VideoEntry,
  units: TranslationUnit[],
  options: TranslateOptions,
) => Promise<ReviewOutput>;

export interface ReviewSummary {
  selected: number;
  reviewed: number;
  skipped: number;
  failed: number;
}

export async function reviewChunkWithCodex(
  entry: VideoEntry,
  units: TranslationUnit[],
  options: TranslateOptions,
): Promise<ReviewOutput> {
  return runCodexStructured<ReviewOutput>(buildReviewPrompt(entry, units), {
    schema: REVIEW_SCHEMA,
    model: options.model,
    reasoning: options.reasoning,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    cwd: options.cwd,
  });
}

function createBatchedReviewChunk(options: TranslateOptions): ReviewChunk {
  const batcher = new CodexUnitBatcher<{
    textZh: string;
    speakerZh: string;
    reason: string;
  }>(options.chunkCharacters, options.concurrency, async (items: BatchedUnit[]) => {
    const wireUnits = items.map(({ globalId, unit }) => ({
      ...unit,
      id: globalId,
    }));
    const output = await runCodexStructured<ReviewOutput>(
      buildBatchReviewPrompt(items),
      {
        schema: REVIEW_SCHEMA,
        model: options.model,
        reasoning: options.reasoning,
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        cwd: options.cwd,
      },
    );
    return assertReviewOutput(wireUnits, output);
  });
  return async (entry, units) => {
    const results = await batcher.enqueue(entry, units);
    return {
      corrections: units.flatMap((unit) => {
        const correction = results.get(unit.id);
        return correction ? [{ id: unit.id, ...correction }] : [];
      }),
    };
  };
}

function hasCompleteDraft(entry: VideoEntry): boolean {
  return getTranslationUnits(entry).every(
    (unit) => unit.textZh.trim() && (!unit.speakerEn || unit.speakerZh.trim()),
  );
}

function buildReviewUnits(
  baseUnits: TranslationUnit[],
  checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
  maximumCharacters: number,
  trustCheckpointParts = false,
): TranslationUnit[] {
  const expanded = expandOversizedUnits(baseUnits, maximumCharacters);
  const output: TranslationUnit[] = [];
  for (const base of baseUnits) {
    const requestedParts = expanded.filter(
      (unit) => (unit.parentId ?? unit.id) === base.id,
    );
    const candidateLimits = [
      checkpoint?.translationChunkCharacters,
      500,
      1_000,
      2_500,
    ].filter(
      (value, index, values): value is number =>
        typeof value === "number" &&
        value !== maximumCharacters &&
        values.indexOf(value) === index,
    );
    const candidateParts = [
      requestedParts,
      ...candidateLimits.map((limit) => expandOversizedUnits([base], limit)),
    ];
    const parts = candidateParts.find(
      (candidate) =>
        candidate.length > 1 &&
        candidate.every((part) => {
          const saved = checkpoint?.units[part.id];
          return Boolean(
            saved &&
              saved.sourceHash === unitSourceHash(part) &&
              saved.textZh.trim() &&
              (!part.speakerEn || saved.speakerZh.trim()),
          );
        }),
    );
    if (!parts) {
      // Older hand-authored translations may not have per-part alignment data.
      output.push(base);
      continue;
    }
    const checkpointText = parts
      .map((part) => checkpoint!.units[part.id].textZh.trim())
      .join("");
    if (!trustCheckpointParts && checkpointText !== base.textZh.trim()) {
      // The content file is authoritative for deliberate edits. A checkpoint
      // mismatch is reviewed again instead of silently replacing that text.
      output.push(base);
      continue;
    }
    for (const part of parts) {
      const saved = checkpoint!.units[part.id];
      part.textZh = saved.textZh;
      part.speakerZh = saved.speakerZh;
      output.push(part);
    }
  }
  return output;
}

async function reviewOneLocked(
  file: VideoFile,
  options: TranslateOptions,
  reviewChunk: ReviewChunk,
): Promise<"reviewed" | "skipped"> {
  file.entry = JSON.parse(await readFile(file.path, "utf8")) as VideoEntry;
  const checkpointFile = checkpointPath(options.checkpointDir, file.entry.id);
  const previousCheckpoint = await readCheckpoint(checkpointFile);
  const forcedResume = previousCheckpoint?.reviewRun === "forced";
  const isolatedRun = options.force || forcedResume;
  const publishedEntry = isolatedRun ? structuredClone(file.entry) : undefined;
  if (!options.force && !forcedResume && file.entry.translation.status === "reviewed") {
    return "skipped";
  }
  const reviewable =
    file.entry.translation.status === "translated" ||
    forcedResume ||
    (options.resume &&
      file.entry.translation.status === "failed" &&
      hasCompleteDraft(file.entry));
  if (!options.force && !reviewable) return "skipped";
  if (!hasCompleteDraft(file.entry)) {
    throw new Error("translation draft is incomplete; run sync:translate first");
  }

  const checkpoint = createCheckpoint(
    file.entry,
    options.model,
    previousCheckpoint,
  );
  if (options.force) {
    checkpoint.reviewRun = "forced";
    for (const unit of Object.values(checkpoint.units)) delete unit.reviewedHash;
    await writeCheckpoint(checkpointFile, checkpoint);
  }
  const baseUnits = getTranslationUnits(file.entry);
  const workUnits = buildReviewUnits(
    baseUnits,
    checkpoint,
    options.chunkCharacters,
    forcedResume,
  );
  if (forcedResume) {
    for (const unit of workUnits) {
      const saved = checkpoint.units[unit.id];
      if (!saved || saved.sourceHash !== unitSourceHash(unit) || !saved.reviewedHash) continue;
      const restored = {
        ...unit,
        textZh: saved.textZh,
        speakerZh: saved.speakerZh,
      };
      if (saved.reviewedHash !== unitReviewHash(restored)) continue;
      unit.textZh = saved.textZh;
      unit.speakerZh = saved.speakerZh;
    }
  }
  applyCompletedParts(file.entry, baseUnits, workUnits);
  const invalidParentIds = new Set(
    getTranslationUnits(file.entry)
      .filter((unit) => !numbersArePreserved(unit.textEn, unit.textZh))
      .map(({ id }) => id),
  );
  const pending = workUnits.filter((unit) => {
    if (options.force || !options.resume) return true;
    if (invalidParentIds.has(unit.parentId ?? unit.id)) return true;
    const saved = checkpoint.units[unit.id];
    return !(
      saved &&
      saved.sourceHash === unitSourceHash(unit) &&
      saved.reviewedHash === unitReviewHash(unit)
    );
  });

  if (pending.length > 0 && !isolatedRun) {
    file.entry.translation = {
      ...file.entry.translation,
      status: "translated",
      reviewedAt: undefined,
      lastError: undefined,
    };
    await writeJsonAtomic(file.path, file.entry);
  }

  try {
    await processChunksConcurrently(
      chunkUnits(pending, options.chunkCharacters),
      options.concurrency,
      async (chunk) => {
        const output = await reviewChunk(file.entry, chunk, options);
        return assertReviewOutput(chunk, output);
      },
      async (chunk, corrections) => {
        const candidates = chunk.map((reviewedUnit) => {
          const correction = corrections.get(reviewedUnit.id);
          return {
            reviewedUnit,
            textZh: correction?.textZh ?? reviewedUnit.textZh,
            speakerZh: correction?.speakerZh ?? reviewedUnit.speakerZh,
          };
        });
        for (const { reviewedUnit, textZh } of candidates) {
          assertNumbersPreserved(
            reviewedUnit.textEn,
            textZh,
            reviewedUnit.id,
          );
        }
        for (const { reviewedUnit, textZh, speakerZh } of candidates) {
          reviewedUnit.textZh = textZh;
          reviewedUnit.speakerZh = speakerZh;
          checkpoint.units[reviewedUnit.id] = {
            sourceHash: unitSourceHash(reviewedUnit),
            textZh: reviewedUnit.textZh,
            speakerZh: reviewedUnit.speakerZh,
            reviewedHash: unitReviewHash(reviewedUnit),
          };
        }
        applyCompletedParts(file.entry, baseUnits, workUnits);
        checkpoint.sourceHash = file.entry.sourceHash;
        await writeCheckpoint(checkpointFile, checkpoint);
        if (!isolatedRun) await writeJsonAtomic(file.path, file.entry);
      },
    );

    for (const unit of getTranslationUnits(file.entry)) {
      assertNumbersPreserved(unit.textEn, unit.textZh, unit.id);
    }

    file.entry.translation = {
      status: "reviewed",
      model: file.entry.translation.model ?? options.model,
      translatedAt: file.entry.translation.translatedAt,
      reviewedAt: new Date().toISOString(),
    };
    checkpoint.sourceHash = file.entry.sourceHash;
    await writeJsonAtomic(file.path, file.entry);
    delete checkpoint.reviewRun;
    await writeCheckpoint(checkpointFile, checkpoint);
    return "reviewed";
  } catch (error) {
    if (publishedEntry) {
      publishedEntry.translation = {
        ...publishedEntry.translation,
        lastError: `Review failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      file.entry = publishedEntry;
      await writeJsonAtomic(file.path, file.entry);
      throw error;
    }
    file.entry.translation = {
      ...file.entry.translation,
      status: "failed",
      lastError: `Review failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    await writeJsonAtomic(file.path, file.entry);
    throw error;
  }
}

async function reviewOne(
  file: VideoFile,
  options: TranslateOptions,
  reviewChunk: ReviewChunk,
): Promise<"reviewed" | "skipped"> {
  return withVideoEntryLock(file.path, () =>
    reviewOneLocked(file, options, reviewChunk),
  );
}

export async function reviewVideoFiles(
  files: VideoFile[],
  options: TranslateOptions,
  reviewChunk?: ReviewChunk,
): Promise<ReviewSummary> {
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
  const summary: ReviewSummary = {
    selected: selected.length,
    reviewed: 0,
    skipped: 0,
    failed: 0,
  };
  let cursor = 0;
  let fatalError: unknown;
  const failures: Error[] = [];
  const batched = reviewChunk === undefined;
  const activeReviewChunk = reviewChunk ?? createBatchedReviewChunk(options);

  const worker = async () => {
    while (!fatalError) {
      const index = cursor;
      cursor += 1;
      const file = selected[index];
      if (!file) return;
      try {
        const outcome = await reviewOne(file, options, activeReviewChunk);
        summary[outcome] += 1;
        console.log(`[review] ${file.entry.id}: ${outcome}`);
      } catch (error) {
        summary.failed += 1;
        const normalized = error instanceof Error ? error : new Error(String(error));
        failures.push(normalized);
        console.error(`[review] ${file.entry.id}: ${normalized.message}`);
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
    throw new AggregateError(failures, `${failures.length} video review(s) failed`);
  }
  return summary;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseTranslateArgs(argv);
  const files = await loadVideoFiles(options.dataDir);
  const summary = await reviewVideoFiles(files, options);
  console.log(
    `[review] done: ${summary.reviewed} reviewed, ${summary.skipped} skipped, ${summary.failed} failed`,
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
