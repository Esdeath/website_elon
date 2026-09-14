import { describe, expect, it } from "vitest";
import type { VideoEntry } from "../src/lib/types";
import { CodexUnitBatcher } from "./codex-batcher";
import {
  CodexInvocationError,
  buildCodexArgs,
  parseCodexJson,
  runCodexStructured,
} from "./codex-runner";

describe("codex runner", () => {
  it("builds an ephemeral read-only structured-output command", () => {
    const args = buildCodexArgs({
      model: "gpt-5.6-sol",
      reasoning: "medium",
      cwd: "/workspace",
      schemaPath: "/tmp/schema.json",
      outputPath: "/tmp/output.json",
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-rules",
        "read-only",
        "--output-schema",
        "/tmp/schema.json",
        "--output-last-message",
        "/tmp/output.json",
      ]),
    );
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args.at(-1)).toBe("-");
  });

  it("accepts plain or fenced JSON and rejects prose", () => {
    expect(parseCodexJson<{ ok: boolean }>(' {"ok":true} ')).toEqual({ ok: true });
    expect(parseCodexJson<{ ok: boolean }>('```json\n{"ok":true}\n```')).toEqual({
      ok: true,
    });
    expect(() => parseCodexJson("not json")).toThrow(CodexInvocationError);
  });

  it("turns an early child exit into a caught invocation error", async () => {
    await expect(
      runCodexStructured("x".repeat(1_000_000), {
        command: "/usr/bin/false",
        schema: { type: "object" },
        retries: 0,
      }),
    ).rejects.toBeInstanceOf(CodexInvocationError);
  });

  it("coalesces units from different videos into one model batch", async () => {
    const calls: string[][] = [];
    const batcher = new CodexUnitBatcher<string>(10_000, 1, async (units) => {
      calls.push(units.map(({ globalId }) => globalId));
      return new Map(units.map(({ globalId }) => [globalId, `done:${globalId}`]));
    });
    const entry = (id: string) => ({ id, titleEn: id }) as VideoEntry;
    const unit = {
      id: "meta:title",
      kind: "title" as const,
      textEn: "Title",
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    const [first, second] = await Promise.all([
      batcher.enqueue(entry("video-a"), [unit]),
      batcher.enqueue(entry("video-b"), [unit]),
    ]);
    expect(calls).toEqual([
      ["video-a::meta:title", "video-b::meta:title"],
    ]);
    expect(first.get("meta:title")).toBe("done:video-a::meta:title");
    expect(second.get("meta:title")).toBe("done:video-b::meta:title");
  });

  it("isolates a bad unit while preserving successful requests", async () => {
    const calls: string[][] = [];
    const batcher = new CodexUnitBatcher<string>(10_000, 1, async (units) => {
      const ids = units.map(({ globalId }) => globalId);
      calls.push(ids);
      if (ids.some((id) => id.startsWith("video-b::"))) {
        throw new Error("invalid model output");
      }
      return new Map(ids.map((id) => [id, `done:${id}`]));
    });
    const entry = (id: string) => ({ id, titleEn: id }) as VideoEntry;
    const unit = {
      id: "meta:title",
      kind: "title" as const,
      textEn: "Title",
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    const outcomes = await Promise.allSettled([
      batcher.enqueue(entry("video-a"), [unit]),
      batcher.enqueue(entry("video-b"), [unit]),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1].status).toBe("rejected");
    expect(calls).toEqual([
      ["video-a::meta:title", "video-b::meta:title"],
      ["video-a::meta:title"],
      ["video-b::meta:title"],
      ["video-b::meta:title"],
    ]);
  });
});
