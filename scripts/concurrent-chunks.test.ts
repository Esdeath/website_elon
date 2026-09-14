import { describe, expect, it } from "vitest";
import { CodexInvocationError } from "./codex-runner";
import { processChunksConcurrently } from "./concurrent-chunks";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("concurrent chunk processing", () => {
  it("bounds model work while serializing checkpoint commits", async () => {
    let activeExecutions = 0;
    let maximumExecutions = 0;
    let activeCommits = 0;
    let maximumCommits = 0;
    const committed: number[] = [];

    await processChunksConcurrently(
      [0, 1, 2, 3],
      2,
      async (value) => {
        activeExecutions += 1;
        maximumExecutions = Math.max(maximumExecutions, activeExecutions);
        await delay(value % 2 === 0 ? 10 : 5);
        activeExecutions -= 1;
        return value * 2;
      },
      async (_value, result) => {
        activeCommits += 1;
        maximumCommits = Math.max(maximumCommits, activeCommits);
        await delay(2);
        committed.push(result);
        activeCommits -= 1;
      },
    );

    expect(maximumExecutions).toBe(2);
    expect(maximumCommits).toBe(1);
    expect(committed.sort((left, right) => left - right)).toEqual([0, 2, 4, 6]);
  });

  it("stops scheduling after an error but commits successful in-flight work", async () => {
    const failure = new Error("bad chunk");
    const started: number[] = [];
    const committed: number[] = [];

    await expect(
      processChunksConcurrently(
        [0, 1, 2, 3],
        2,
        async (value) => {
          started.push(value);
          if (value === 0) {
            await delay(5);
            throw failure;
          }
          await delay(10);
          return value;
        },
        async (_value, result) => {
          committed.push(result);
        },
      ),
    ).rejects.toBe(failure);

    expect(started).toEqual([0, 1]);
    expect(committed).toEqual([1]);
  });

  it("rejects invalid concurrency", async () => {
    await expect(
      processChunksConcurrently([], 0, async () => 0, async () => undefined),
    ).rejects.toThrow("positive integer");
  });

  it("does not hide a usage limit behind a lower-index ordinary failure", async () => {
    const usageLimit = new CodexInvocationError("usage-limit", "quota reached");
    await expect(
      processChunksConcurrently(
        [0, 1],
        2,
        async (value) => {
          await delay(value === 0 ? 10 : 5);
          if (value === 1) throw usageLimit;
          throw new Error("ordinary failure");
        },
        async () => undefined,
      ),
    ).rejects.toBe(usageLimit);
  });
});
