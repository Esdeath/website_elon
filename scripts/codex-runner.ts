import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CodexErrorKind =
  | "timeout"
  | "usage-limit"
  | "process"
  | "invalid-output";

export class CodexInvocationError extends Error {
  readonly kind: CodexErrorKind;

  constructor(kind: CodexErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexInvocationError";
    this.kind = kind;
  }
}

export interface CodexRunOptions {
  schema: Record<string, unknown>;
  model?: string;
  reasoning?: string;
  timeoutMs?: number;
  retries?: number;
  cwd?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING = "medium";
export const DEFAULT_CODEX_TIMEOUT_MS = 10 * 60 * 1_000;

export function buildCodexArgs(options: {
  model: string;
  reasoning: string;
  cwd: string;
  schemaPath: string;
  outputPath: string;
}): string[] {
  return [
    "exec",
    "--model",
    options.model,
    "--config",
    `model_reasoning_effort=${JSON.stringify(options.reasoning)}`,
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--cd",
    options.cwd,
    "--output-schema",
    options.schemaPath,
    "--output-last-message",
    options.outputPath,
    "--color",
    "never",
    "-",
  ];
}

export function parseCodexJson<T>(raw: string): T {
  const trimmed = raw.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(unfenced) as T;
  } catch (error) {
    throw new CodexInvocationError(
      "invalid-output",
      `Codex returned invalid JSON: ${unfenced.slice(0, 240)}`,
      { cause: error },
    );
  }
}

function looksLikeUsageLimit(message: string): boolean {
  return /(?:usage|rate|spend) limit|quota|too many requests|insufficient_quota|credit balance/i.test(
    message,
  );
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function invokeOnce<T>(
  prompt: string,
  options: Required<
    Pick<
      CodexRunOptions,
      "schema" | "model" | "reasoning" | "timeoutMs" | "cwd" | "command"
    >
  > &
    Pick<CodexRunOptions, "env">,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "musk-archive-codex-"));
  const schemaPath = join(tempDir, "output.schema.json");
  const outputPath = join(tempDir, "last-message.json");

  try {
    await writeFile(schemaPath, `${JSON.stringify(options.schema, null, 2)}\n`, "utf8");
    const args = buildCodexArgs({
      model: options.model,
      reasoning: options.reasoning,
      cwd: options.cwd,
      schemaPath,
      outputPath,
    });

    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
        forceKill.unref();
        finish(() =>
          reject(
            new CodexInvocationError(
              "timeout",
              `Codex timed out after ${options.timeoutMs}ms`,
            ),
          ),
        );
      }, options.timeoutMs);

      child.once("error", (error) => {
        finish(() =>
          reject(
            new CodexInvocationError(
              "process",
              `Unable to start Codex: ${error.message}`,
              { cause: error },
            ),
          ),
        );
      });
      child.stdin.once("error", (error) => {
        finish(() =>
          reject(
            new CodexInvocationError(
              "process",
              `Unable to send the prompt to Codex: ${error.message}`,
              { cause: error },
            ),
          ),
        );
      });
      child.once("close", (code) => finish(() => resolve(code ?? 1)));
      child.stdin.end(prompt);
    });

    if (exitCode !== 0) {
      const detail = `${stderr}\n${stdout}`.trim();
      const kind: CodexErrorKind = looksLikeUsageLimit(detail)
        ? "usage-limit"
        : "process";
      throw new CodexInvocationError(
        kind,
        `Codex exited with status ${exitCode}${detail ? `: ${detail.slice(-1_200)}` : ""}`,
      );
    }

    let raw: string;
    try {
      raw = await readFile(outputPath, "utf8");
    } catch (error) {
      throw new CodexInvocationError(
        "invalid-output",
        "Codex did not write its final response",
        { cause: error },
      );
    }
    return parseCodexJson<T>(raw);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runCodexStructured<T>(
  prompt: string,
  options: CodexRunOptions,
): Promise<T> {
  const retries = Math.max(0, options.retries ?? 2);
  const resolved = {
    schema: options.schema,
    model: options.model ?? DEFAULT_CODEX_MODEL,
    reasoning: options.reasoning ?? DEFAULT_CODEX_REASONING,
    timeoutMs: options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
    cwd: options.cwd ?? process.cwd(),
    command: options.command ?? "codex",
    env: options.env,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await invokeOnce<T>(prompt, resolved);
    } catch (error) {
      lastError = error;
      if (
        error instanceof CodexInvocationError &&
        (error.kind === "usage-limit" || attempt === retries)
      ) {
        throw error;
      }
      if (attempt === retries) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[codex] attempt ${attempt + 1}/${retries + 1} failed; retrying: ${detail.replace(/\s+/g, " ").slice(0, 240)}`,
      );
      await wait(Math.min(1_000 * 2 ** attempt, 8_000));
    }
  }

  throw lastError;
}
