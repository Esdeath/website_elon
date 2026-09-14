import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

async function runChild(source: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), stdio: "pipe" },
  );
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [exitCode] = await once(child, "close");
  expect(Buffer.concat(stderr).toString("utf8")).toBe("");
  expect(exitCode).toBe(0);
}

describe("video entry lock", () => {
  it("recovers a dead same-host lock without admitting simultaneous contenders", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-entry-lock-test-"));
    try {
      const filePath = join(root, "video.json");
      const logPath = join(root, "owners.log");
      const moduleUrl = pathToFileURL(
        join(process.cwd(), "scripts/video-entry-lock.ts"),
      ).href;
      await runChild(
        `import { withVideoEntryLock } from ${JSON.stringify(moduleUrl)}; await withVideoEntryLock(${JSON.stringify(filePath)}, async () => process.exit(0));`,
      );

      const contender = `
        import { appendFile } from "node:fs/promises";
        import { withVideoEntryLock } from ${JSON.stringify(moduleUrl)};
        await withVideoEntryLock(${JSON.stringify(filePath)}, async () => {
          const marker = String(process.pid);
          await appendFile(${JSON.stringify(logPath)}, "start " + marker + "\\n");
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
          await appendFile(${JSON.stringify(logPath)}, "end " + marker + "\\n");
        });
      `;
      await Promise.all([runChild(contender), runChild(contender)]);

      const lines = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(4);
      expect(lines[0]).toMatch(/^start \d+$/);
      expect(lines[1]).toBe(lines[0].replace("start", "end"));
      expect(lines[2]).toMatch(/^start \d+$/);
      expect(lines[3]).toBe(lines[2].replace("start", "end"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
