import { describe, expect, it } from "vitest";
import {
  createArchiveIndex,
  formatLlmsTxt,
  formatVideoMarkdown,
  sortVideosNewest,
  validHttpUrl,
} from "./archive-formats";
import type { VideoEntry } from "./types";

const site = new URL("https://archive.example/");

function video(overrides: Partial<VideoEntry> = {}): VideoEntry {
  return {
    id: "sample-video",
    slug: "sample-video",
    snapshotId: "2026-09-12",
    type: "interview",
    date: "2025-03-04",
    titleEn: "A [sample] interview",
    titleZh: "一次示例访谈",
    summaryEn: "An English summary.",
    summaryZh: "一段中文摘要。",
    sourceUrl: "https://www.youtube.com/watch?v=example",
    sourceLabel: "Original publisher",
    archiveUrl: "https://elonmuskarchive.org/video/sample-video",
    org: "Example Org",
    durationSec: 65,
    contentKind: "dialogue",
    segments: [
      {
        id: "p-0042",
        speakerEn: "Elon Musk",
        speakerZh: "埃隆·马斯克",
        startSec: 64.9,
        textEn: "English <source> text.",
        textZh: "中文正文。",
      },
    ],
    translation: {
      status: "reviewed",
      translatedAt: "2026-09-12T10:00:00.000Z",
      reviewedAt: "2026-09-13T10:00:00.000Z",
    },
    fetchedAt: "2026-09-12T09:00:00.000Z",
    sourceHash: "abc123",
    transcriptSource: "https://transcripts.example/sample",
    ...overrides,
  };
}

describe("validHttpUrl", () => {
  it("accepts only absolute HTTP(S) URLs", () => {
    expect(validHttpUrl(" https://example.com/transcript ")).toBe("https://example.com/transcript");
    expect(validHttpUrl("http://example.com/transcript")).toBe("http://example.com/transcript");
    expect(validHttpUrl("ftp://example.com/transcript")).toBeUndefined();
    expect(validHttpUrl("$undefined")).toBeUndefined();
    expect(validHttpUrl("YouTube auto-generated captions")).toBeUndefined();
    expect(validHttpUrl(undefined)).toBeUndefined();
  });
});

describe("formatVideoMarkdown", () => {
  it("renders bilingual content with stable source paragraph IDs", () => {
    const output = formatVideoMarkdown(video(), site);

    expect(output).toContain("# 一次示例访谈");
    expect(output).toContain("A \\[sample\\] interview");
    expect(output).toContain('<a id="p-0042"></a>');
    expect(output).toContain('<a id="p-0042-en"></a>');
    expect(output).toContain("### p-0042 · 埃隆·马斯克 · 1:04");
    expect(output).toContain("English &lt;source&gt; text.");
    expect(output).toContain("https://transcripts.example/sample");
  });

  it("omits invalid transcript sources", () => {
    const output = formatVideoMarkdown(video({ transcriptSource: "$undefined" }), site);

    expect(output).not.toContain("文字记录来源");
    expect(output).not.toContain("$undefined");
  });

  it("escapes source IDs before placing them in HTML anchors", () => {
    const output = formatVideoMarkdown(video({
      segments: [{ id: 'p-"42&', textEn: "English.", textZh: "中文。" }],
    }), site);

    expect(output).toContain('<a id="p-&quot;42&amp;"></a>');
    expect(output).toContain('<a id="p-&quot;42&amp;-en"></a>');
  });

  it("states when no transcript is available without inventing text", () => {
    const output = formatVideoMarkdown(video({ contentKind: "none", segments: [] }), site);

    expect(output).toContain("暂无可用正文。");
    expect(output).toContain("No transcript is available.");
  });
});

describe("createArchiveIndex", () => {
  it("creates deterministic metadata and filters transcript sources", () => {
    const newer = video({ id: "newer", slug: "newer", date: "2026-01-01", transcriptSource: "plain text" });
    const index = createArchiveIndex([video(), newer], site);

    expect(index.numberOfItems).toBe(2);
    expect(index.updatedAt).toBe("2026-09-13T10:00:00.000Z");
    expect(index.snapshotIds).toEqual(["2026-09-12"]);
    expect(index.items.map((item) => item.id)).toEqual(["newer", "sample-video"]);
    expect(index.items[0].source).not.toHaveProperty("transcript");
    expect(index.items[1].source.transcript).toBe("https://transcripts.example/sample");
    expect(index.items[1].markdownUrl).toBe("https://archive.example/videos/sample-video.md");
    expect(index.items[1]).toMatchObject({
      snapshotId: "2026-09-12",
      fetchedAt: "2026-09-12T09:00:00.000Z",
      sourceHash: "abc123",
    });
  });
});

describe("formatLlmsTxt", () => {
  it("enumerates Markdown records and accurately describes About", () => {
    const output = formatLlmsTxt([video()], site);

    expect(output).toContain("## 全部档案（1 条）");
    expect(output).toContain("https://archive.example/videos/sample-video.md");
    expect(output).toContain("https://archive.example/archive.json");
    expect(output).toContain("https://archive.example/sitemap-index.xml");
    expect(output).toContain("https://archive.example/video-sitemap.xml");
    expect(output).toContain("本站定位与简介");
    expect(output).not.toContain("数据来源、翻译方式与收录范围");
  });
});

describe("sortVideosNewest", () => {
  it("sorts by descending date and then stable slug", () => {
    const items = [
      video({ slug: "z", date: "2024-01-01" }),
      video({ slug: "b", date: "2025-01-01" }),
      video({ slug: "a", date: "2025-01-01" }),
    ];

    expect(sortVideosNewest(items).map((item) => item.slug)).toEqual(["a", "b", "z"]);
  });
});
