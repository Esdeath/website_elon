import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { VideoEntry } from "./types";
import {
  buildCollectionJsonLd,
  buildDetailMetaTitles,
  buildDetailJsonLd,
  toIsoDuration,
  truncateDescription,
} from "./seo";

const fixture: VideoEntry = {
  id: "example-video",
  slug: "example-video",
  snapshotId: "snapshot",
  type: "interview",
  date: "2026-09-12",
  titleEn: "Example interview",
  titleZh: "示例访谈",
  summaryEn: "An example summary.",
  summaryZh: "一段用于测试的摘要。",
  sourceUrl: "https://www.youtube.com/watch?v=example",
  sourceLabel: "YouTube",
  archiveUrl: "https://elonmuskarchive.org/video/example-video",
  embedUrl: "https://www.youtube.com/embed/example",
  thumbnailUrl: "https://i.ytimg.com/vi/example/hqdefault.jpg",
  durationSec: 3661,
  contentKind: "dialogue",
  segments: [],
  translation: { status: "reviewed", model: "test", reviewedAt: "2026-09-13T10:00:00Z" },
  fetchedAt: "2026-09-12T10:00:00Z",
  sourceHash: "hash",
};

describe("SEO helpers", () => {
  it("normalizes and bounds meta descriptions", () => {
    expect(truncateDescription("  第一段\n 第二段  ")).toBe("第一段 第二段");
    expect(truncateDescription("文".repeat(200))).toHaveLength(160);
    expect(truncateDescription("文".repeat(200)).endsWith("…")).toBe(true);
  });

  it("formats positive durations as ISO 8601", () => {
    expect(toIsoDuration(3661)).toBe("PT1H1M1S");
    expect(toIsoDuration(3600)).toBe("PT1H");
    expect(toIsoDuration(0)).toBeUndefined();
  });

  it("builds an attributable video graph without inventing a media content URL", () => {
    const graph = buildDetailJsonLd(fixture, {
      canonical: "https://elon.ayaseeri.com/videos/example-video/",
      description: fixture.summaryZh,
      thumbnail: fixture.thumbnailUrl,
      embedUrl: "https://www.youtube-nocookie.com/embed/example",
    });
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain('"@type":"VideoObject"');
    expect(serialized).toContain('"duration":"PT1H1M1S"');
    expect(serialized).toContain('"@type":"BreadcrumbList"');
    expect(serialized).toContain("https://www.wikidata.org/wiki/Q317521");
    expect(serialized).not.toContain("contentUrl");
  });

  it("falls back to Article when no crawlable player and thumbnail pair exists", () => {
    const graph = buildDetailJsonLd(fixture, {
      canonical: "https://elon.ayaseeri.com/videos/example-video/",
      description: fixture.summaryZh,
    });

    expect(JSON.stringify(graph)).toContain('"@type":"Article"');
  });

  it("describes the complete collection as an ordered item list", () => {
    const graph = buildCollectionJsonLd(
      [fixture],
      "https://elon.ayaseeri.com/",
      "资料库描述",
    );
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain('"numberOfItems":1');
    expect(serialized).toContain("https://elon.ayaseeri.com/videos/example-video/");
  });

  it("produces a unique dated meta title for every archive record", () => {
    const directory = resolve("src/content/videos");
    const videos = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(resolve(directory, name), "utf8")) as VideoEntry);
    const titles = [...buildDetailMetaTitles(videos).values()];

    expect(videos.length).toBeGreaterThan(0);
    expect(titles).toHaveLength(videos.length);
    expect(new Set(titles).size).toBe(videos.length);
  });
});
