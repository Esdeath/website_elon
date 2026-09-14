import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseIndexPayload, SOURCE_INDEX_URL } from "./source";

export interface StageArguments {
  fetch: string[];
  translate: string[];
  review: string[];
  validate: string[];
}

const BOOLEAN_OPTIONS = new Set([
  "--force",
  "--resume",
  "--no-resume",
  "--allow-incomplete",
]);
const VALUE_OPTIONS = new Set([
  "--ids",
  "--limit",
  "--data-dir",
  "--concurrency",
  "--chunk-chars",
  "--timeout-ms",
  "--retries",
  "--model",
  "--reasoning",
  "--checkpoint-dir",
  "--expected-count",
  "--manifest",
]);

export function splitStageArguments(argv: string[]): StageArguments {
  const stages: StageArguments = { fetch: [], translate: [], review: [], validate: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.split("=", 1)[0];
    if (!BOOLEAN_OPTIONS.has(name) && !VALUE_OPTIONS.has(name)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const tokens = [argument];
    if (VALUE_OPTIONS.has(name) && !argument.includes("=")) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      tokens.push(value);
    }

    if (["--ids", "--limit", "--data-dir", "--force", "--resume", "--no-resume"].includes(name)) {
      if (name !== "--no-resume") stages.fetch.push(...tokens);
      stages.translate.push(...tokens);
      stages.review.push(...tokens);
      if (name === "--data-dir") stages.validate.push(...tokens);
    } else if (
      [
        "--concurrency",
        "--chunk-chars",
        "--timeout-ms",
        "--retries",
        "--model",
        "--reasoning",
        "--checkpoint-dir",
      ].includes(name)
    ) {
      stages.translate.push(...tokens);
      stages.review.push(...tokens);
    } else {
      stages.validate.push(...tokens);
    }
  }
  return stages;
}

function optionValues(args: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith(`${option}=`)) {
      values.push(argument.slice(option.length + 1));
    } else if (argument === option && args[index + 1]) {
      values.push(args[++index]);
    }
  }
  return values;
}

function withoutOptions(args: string[], names: Set<string>): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const name = argument.split("=", 1)[0];
    if (!names.has(name)) {
      filtered.push(argument);
      continue;
    }
    if (!argument.includes("=") && VALUE_OPTIONS.has(name)) index += 1;
  }
  return filtered;
}

export function alignLimitedSelection(
  stages: StageArguments,
  orderedSourceIds: string[],
): StageArguments {
  const limitValue = optionValues(stages.fetch, "--limit").at(-1);
  if (!limitValue) return stages;
  const limit = Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  const requestedValues = optionValues(stages.fetch, "--ids");
  const requested = new Set(
    requestedValues.flatMap((value) => value.split(",").map((id) => id.trim())),
  );
  if (requested.size > 0) {
    const available = new Set(orderedSourceIds);
    const unknown = [...requested].filter((id) => !available.has(id));
    if (unknown.length > 0) {
      throw new Error(`Requested ids are not in the source index: ${unknown.join(", ")}`);
    }
  }
  const selected = orderedSourceIds
    .filter((id) => requested.size === 0 || requested.has(id))
    .slice(0, limit);
  if (selected.length === 0) throw new Error("The sync selection is empty");
  const selectionArgs = ["--ids", selected.join(",")];
  const removed = new Set(["--ids", "--limit"]);
  return {
    fetch: [...withoutOptions(stages.fetch, removed), ...selectionArgs],
    translate: [...withoutOptions(stages.translate, removed), ...selectionArgs],
    review: [...withoutOptions(stages.review, removed), ...selectionArgs],
    validate: stages.validate,
  };
}

async function sourceIds(): Promise<string[]> {
  const response = await fetch(SOURCE_INDEX_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Unable to resolve --limit selection: HTTP ${response.status}`);
  }
  return parseIndexPayload(await response.json()).map(({ id }) => id);
}

function runStage(
  label: string,
  script: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const localTsx = resolve(cwd, "node_modules/.bin/tsx");
  const command = existsSync(localTsx) ? localTsx : "tsx";
  console.log(`[sync] ${label}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [script, ...args], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${label} failed${signal ? ` with signal ${signal}` : ` with status ${code ?? 1}`}`,
        ),
      );
    });
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cwd = process.cwd();
  let stages = splitStageArguments(argv);
  if (optionValues(stages.fetch, "--limit").length > 0) {
    stages = alignLimitedSelection(stages, await sourceIds());
  }
  await runStage("fetch source", resolve(cwd, "scripts/fetch-videos.ts"), stages.fetch, cwd);
  await runStage(
    "translate content",
    resolve(cwd, "scripts/translate-videos.ts"),
    stages.translate,
    cwd,
  );
  await runStage(
    "review translations",
    resolve(cwd, "scripts/review-translations.ts"),
    stages.review,
    cwd,
  );
  await runStage(
    "validate snapshot",
    resolve(cwd, "scripts/validate-content.ts"),
    stages.validate,
    cwd,
  );
  console.log("[sync] complete");
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
