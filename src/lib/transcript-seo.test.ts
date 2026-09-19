import { describe, expect, it } from "vitest";
import { createArchiveIndex, formatLlmsTxt } from "./archive-formats";
import { buildTranscriptCollectionJsonLd, buildTranscriptJsonLd } from "./transcript-seo";
import type { VideoEntry } from "./types";

const site = new URL("https://archive.example/");
const video: VideoEntry = {
  id: "sample",
  slug: "sample",
  snapshotId: "2026-09-19",
  type: "interview",
  date: "2025-03-04",
  titleEn: "Sample interview",
  titleZh: "示例访谈",
  summaryEn: "English summary.",
  summaryZh: "中文摘要。",
  sourceUrl: "https://video.example/source",
  archiveUrl: "https://archive.example/original",
  transcriptSource: "https://transcripts.example/original",
  contentKind: "dialogue",
  segments: [{ id: "p-0042", textEn: "English source body.", textZh: "中文来源正文。" }],
  translation: { status: "reviewed", reviewedAt: "2026-09-19T01:00:00.000Z" },
  fetchedAt: "2026-09-18T01:00:00.000Z",
  sourceHash: "sample-hash",
};
const missing: VideoEntry = {
  ...video,
  id: "missing",
  slug: "missing",
  segments: [{ id: "p-0001", textEn: "Untranslated English.", textZh: "" }],
};

describe("Chinese transcript discovery", () => {
  it("lists available Chinese reading URLs and excludes missing translations", () => {
    const result = buildTranscriptCollectionJsonLd([missing, video], new URL("/transcripts/", site).toString(), "目录");
    const graph = result["@graph"] as Record<string, unknown>[];
    const collection = graph.find((node) => node["@type"] === "CollectionPage")!;
    const list = graph.find((node) => node["@type"] === "ItemList")!;

    expect(collection).toMatchObject({ inLanguage: "zh-CN", dateModified: video.translation.reviewedAt });
    expect(list).toMatchObject({
      numberOfItems: 1,
      itemListElement: [{ position: 1, name: video.titleZh, url: "https://archive.example/transcripts/sample/" }],
    });
  });

  it("publishes Chinese Article provenance without duplicating either language's body", () => {
    const canonical = "https://archive.example/transcripts/sample/";
    const result = buildTranscriptJsonLd(video, canonical, "中文阅读页");
    const graph = result["@graph"] as Record<string, unknown>[];
    const article = graph.find((node) => node["@type"] === "Article")!;
    const breadcrumb = graph.find((node) => node["@type"] === "BreadcrumbList")!;

    expect(article).toMatchObject({ url: canonical, inLanguage: "zh-CN", headline: video.titleZh });
    expect(article.isBasedOn).toEqual([
      "https://archive.example/videos/sample/", video.sourceUrl, video.archiveUrl, video.transcriptSource,
    ]);
    expect(article.citation).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: video.sourceUrl }),
      expect.objectContaining({ url: video.archiveUrl }),
      expect.objectContaining({ url: video.transcriptSource }),
    ]));
    expect(breadcrumb.itemListElement).toEqual(expect.arrayContaining([
      expect.objectContaining({ position: 2, item: "https://archive.example/transcripts/" }),
      expect.objectContaining({ position: 3, item: canonical }),
    ]));
    expect(graph.some((node) => node["@type"] === "VideoObject")).toBe(false);
    expect(JSON.stringify(result)).not.toContain(video.segments[0].textZh);
    expect(JSON.stringify(result)).not.toContain(video.segments[0].textEn);
  });

  it("adds Chinese machine-readable links only for records with complete Chinese text", () => {
    const index = createArchiveIndex([missing, video], site);
    expect(index.items.find((item) => item.id === "sample")).toMatchObject({
      transcriptUrl: "https://archive.example/transcripts/sample/",
      transcriptMarkdownUrl: "https://archive.example/transcripts/sample.md",
    });
    expect(index.items.find((item) => item.id === "missing")).not.toHaveProperty("transcriptUrl");
    const llms = formatLlmsTxt([missing, video], site);
    expect(llms).toContain("https://archive.example/transcripts/");
    expect(llms).toContain("## 中文文字稿（1 篇）");
    expect(llms).toContain("https://archive.example/transcripts/sample.md");
    expect(llms).not.toContain("https://archive.example/transcripts/missing");
  });
});
