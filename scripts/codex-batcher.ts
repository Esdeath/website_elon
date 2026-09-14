import type { VideoEntry } from "../src/lib/types";
import type { TranslationUnit } from "./codex-content";
import { CodexInvocationError } from "./codex-runner";

export interface BatchedUnit {
  globalId: string;
  entry: VideoEntry;
  unit: TranslationUnit;
}

interface RequestState<Result> {
  remaining: number;
  results: Map<string, Result>;
  resolve: (results: Map<string, Result>) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

interface QueuedUnit<Result> extends BatchedUnit {
  request: RequestState<Result>;
}

export class CodexUnitBatcher<Result> {
  private readonly queue: Array<QueuedUnit<Result>> = [];
  private inFlight = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private fatalError?: unknown;

  constructor(
    private readonly maximumCharacters: number,
    private readonly concurrency: number,
    private readonly execute: (
      units: BatchedUnit[],
    ) => Promise<Map<string, Result>>,
  ) {}

  enqueue(entry: VideoEntry, units: TranslationUnit[]): Promise<Map<string, Result>> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    return new Promise((resolve, reject) => {
      const request: RequestState<Result> = {
        remaining: units.length,
        results: new Map(),
        resolve,
        reject,
        settled: false,
      };
      for (const unit of units) {
        this.queue.push({
          globalId: `${entry.id}::${unit.id}`,
          entry,
          unit,
          request,
        });
      }
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer || this.inFlight >= this.concurrency) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, 10);
  }

  private sizeOf(item: BatchedUnit): number {
    return JSON.stringify({
      id: item.globalId,
      videoId: item.entry.id,
      title: item.entry.titleEn,
      kind: item.unit.kind,
      textEn: item.unit.textEn,
      textZh: item.unit.textZh,
      speakerEn: item.unit.speakerEn,
      speakerZh: item.unit.speakerZh,
    }).length;
  }

  private takeBatch(): Array<QueuedUnit<Result>> {
    const batch: Array<QueuedUnit<Result>> = [];
    let size = 0;
    for (let index = 0; index < this.queue.length; ) {
      const item = this.queue[index];
      if (item.request.settled) {
        this.queue.splice(index, 1);
        continue;
      }
      const itemSize = this.sizeOf(item);
      if (batch.length === 0 || size + itemSize <= this.maximumCharacters) {
        batch.push(item);
        size += itemSize;
        this.queue.splice(index, 1);
      } else {
        index += 1;
      }
    }
    return batch;
  }

  private pump(): void {
    while (!this.fatalError && this.inFlight < this.concurrency && this.queue.length > 0) {
      const batch = this.takeBatch();
      if (batch.length === 0) return;
      this.inFlight += 1;
      void this.executeRecovering(batch, true)
        .finally(() => {
          this.inFlight -= 1;
          this.pump();
        });
    }
    if (this.queue.length > 0) this.schedule();
  }

  private completeBatch(
    batch: Array<QueuedUnit<Result>>,
    results: Map<string, Result>,
  ): void {
    for (const item of batch) {
      if (item.request.settled) continue;
      const result = results.get(item.globalId);
      if (result !== undefined) item.request.results.set(item.unit.id, result);
      item.request.remaining -= 1;
      if (item.request.remaining === 0) {
        item.request.settled = true;
        item.request.resolve(item.request.results);
      }
    }
  }

  private failBatch(batch: Array<QueuedUnit<Result>>, error: unknown): void {
    for (const item of batch) {
      if (item.request.settled) continue;
      item.request.settled = true;
      item.request.reject(error);
    }
  }

  private failAll(error: unknown): void {
    this.fatalError = error;
    this.failBatch(this.queue, error);
    this.queue.length = 0;
  }

  private async executeRecovering(
    batch: Array<QueuedUnit<Result>>,
    retrySingleton: boolean,
  ): Promise<void> {
    const activeBatch = batch.filter(({ request }) => !request.settled);
    if (activeBatch.length === 0) return;
    if (this.fatalError) {
      this.failBatch(activeBatch, this.fatalError);
      return;
    }
    try {
      this.completeBatch(activeBatch, await this.execute(activeBatch));
    } catch (error) {
      if (error instanceof CodexInvocationError && error.kind === "usage-limit") {
        this.failBatch(activeBatch, error);
        this.failAll(error);
        return;
      }
      if (activeBatch.length > 1) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `[codex] batch of ${activeBatch.length} units failed; isolating smaller batches: ${detail.replace(/\s+/g, " ").slice(0, 240)}`,
        );
        const middle = Math.ceil(activeBatch.length / 2);
        await this.executeRecovering(activeBatch.slice(0, middle), true);
        await this.executeRecovering(activeBatch.slice(middle), true);
        return;
      }
      if (retrySingleton) {
        console.warn(`[codex] retrying single unit: ${activeBatch[0].globalId}`);
        await this.executeRecovering(activeBatch, false);
        return;
      }
      this.failBatch(activeBatch, error);
    }
  }
}
