import { CodexInvocationError } from "./codex-runner";

export async function processChunksConcurrently<Chunk, Result>(
  chunks: readonly Chunk[],
  concurrency: number,
  execute: (chunk: Chunk, index: number) => Promise<Result>,
  commit: (chunk: Chunk, result: Result, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("chunk concurrency must be a positive integer");
  }
  if (chunks.length === 0) return;

  let cursor = 0;
  let halted = false;
  const failures: Array<{ index: number; error: unknown }> = [];
  let commitTail = Promise.resolve();

  const commitSerially = (
    chunk: Chunk,
    result: Result,
    index: number,
  ): Promise<void> => {
    const current = commitTail.then(() => commit(chunk, result, index));
    commitTail = current.catch(() => undefined);
    return current;
  };

  const worker = async () => {
    while (!halted) {
      const index = cursor;
      cursor += 1;
      const chunk = chunks[index];
      if (chunk === undefined) return;
      try {
        const result = await execute(chunk, index);
        await commitSerially(chunk, result, index);
      } catch (error) {
        failures.push({ index, error });
        halted = true;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, chunks.length) },
      () => worker(),
    ),
  );
  await commitTail;
  if (failures.length > 0) {
    const usageLimit = failures.find(
      ({ error }) =>
        error instanceof CodexInvocationError && error.kind === "usage-limit",
    );
    if (usageLimit) throw usageLimit.error;
    failures.sort((left, right) => left.index - right.index);
    throw failures[0].error;
  }
}
