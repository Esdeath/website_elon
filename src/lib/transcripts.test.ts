import { describe, expect, it } from "vitest";
import {
  TRANSCRIPTS_PATH,
  formatChineseTranscriptMarkdown,
  getChineseTranscripts,
  hasChineseTranscript,
  transcriptPath,
  transcriptStats,
} from "./transcripts";
import type { VideoEntry } from "./types";

function video(overrides: Partial<VideoEntry> = {}): VideoEntry {
  return {
    id: "sample",
    slug: "sample",
    snapshotId: "2026-09-12",
    type: "interview",
    date: "2025-03-04",
    titleEn: "English title must not appear",
    titleZh: "一次中文访谈",
    summaryEn: "English summary must not appear",
    summaryZh: "完整的中文摘要。\n\n保留第二段。",
    sourceUrl: "https://example.com/source",
    archiveUrl: "https://example.com/archive",
    contentKind: "dialogue",
    segments: [
      {
        id: "p-0042",
        speakerEn: "Elon Musk",
        speakerZh: "埃隆·马斯克",
        startSec: 64.9,
        textEn: "English body must not appear",
        textZh: "完整的中文正文。\n\n保留原有分段。",
      },
      { id: "p-0050", textEn: "Another English body", textZh: "最后一段正文。" },
    ],
    translation: { status: "translated" },
    fetchedAt: "2026-09-12T09:00:00Z",
    sourceHash: "abc123",
    ...overrides,
  };
}

describe("Chinese transcript selection", () => {
  it("requires an available Chinese translation for every segment", () => {
    expect(hasChineseTranscript(video())).toBe(true);
    expect(hasChineseTranscript(video({ contentKind: "article" }))).toBe(true);
    expect(hasChineseTranscript(video({ contentKind: "none" }))).toBe(false);
    expect(hasChineseTranscript(video({ segments: [] }))).toBe(false);
    expect(hasChineseTranscript(video({ segments: [
      video().segments[0],
      { id: "missing", textEn: "Available English", textZh: " \n\t " },
    ] }))).toBe(false);
  });

  it("filters incomplete translations and sorts without mutating the collection", () => {
    const videos = [
      video({ slug: "old", date: "2024-01-01" }),
      video({ slug: "z", date: "2025-01-01" }),
      video({ slug: "a", date: "2025-01-01" }),
      video({ slug: "missing", date: "2026-01-01", segments: [] }),
    ];
    expect(getChineseTranscripts(videos).map((item) => item.slug)).toEqual(["a", "z", "old"]);
    expect(videos.map((item) => item.slug)).toEqual(["old", "z", "a", "missing"]);
    expect(transcriptPath(videos[0])).toBe(`${TRANSCRIPTS_PATH}old/`);
  });
});

describe("transcriptStats", () => {
  it("counts only Chinese-field body text, excluding whitespace and counting Unicode code points", () => {
    const entry = video({ segments: [{ id: "p", textEn: "ignored", textZh: " 中 文\n𠮷\t " }] });
    expect(transcriptStats(entry)).toEqual({ characterCount: 3, readingMinutes: 1 });
    expect(transcriptStats(video({ segments: [] }))).toEqual({ characterCount: 0, readingMinutes: 1 });
  });

  it("rounds reading time up at 400 characters per minute", () => {
    for (const [length, minutes] of [[400, 1], [401, 2], [800, 2]]) {
      const entry = video({ segments: [{ id: "p", textEn: "ignored", textZh: "中".repeat(length) }] });
      expect(transcriptStats(entry)).toEqual({ characterCount: length, readingMinutes: minutes });
    }
  });
});

describe("formatChineseTranscriptMarkdown", () => {
  const site = new URL("https://archive.example/");

  it("exports the entire Chinese summary and body with original paragraph anchors", () => {
    const entry = video();
    const output = formatChineseTranscriptMarkdown(entry, site);
    expect(output).toContain("# 一次中文访谈");
    expect(output).toContain("2025-03-04");
    expect(output).toContain("**类别：** 访谈");
    expect(output).toContain("https://example.com/source");
    expect(output).toContain("https://archive.example/videos/sample/");
    expect(output).toContain(entry.summaryZh);
    for (const segment of entry.segments) {
      expect(output).toContain(segment.textZh);
      expect(output).toContain(`<a id="${segment.id}"></a>`);
      expect(output).toContain(`https://archive.example/transcripts/sample/#${segment.id}`);
      expect(output).not.toContain(segment.textEn);
    }
    expect(output).toContain("### 第 1 段 · 埃隆·马斯克 · 1:04");
    expect(output).not.toContain(entry.titleEn);
    expect(output).not.toContain(entry.summaryEn);
    expect(output).not.toContain("English transcript");
  });

  it("never uses English content as fallback, allowing only an English speaker label", () => {
    const entry = video({ titleZh: "", summaryZh: "", segments: [{
      id: "p-1", speakerZh: " ", speakerEn: "Elon Musk", textEn: "English body", textZh: "",
    }] });
    const output = formatChineseTranscriptMarkdown(entry, site);
    expect(output).toContain("### 第 1 段 · Elon Musk");
    expect(output).not.toContain(entry.titleEn);
    expect(output).not.toContain(entry.summaryEn);
    expect(output).not.toContain("English body");
  });

  it("includes only usable HTTP(S) transcript sources", () => {
    const output = formatChineseTranscriptMarkdown(video({ transcriptSource: "https://example.com/transcript" }), site);
    expect(output).toContain("**文字记录来源：** [查看文字记录来源](<https://example.com/transcript>)");
    for (const transcriptSource of [undefined, "$undefined", "captions", "javascript:alert(1)", "ftp://example.com/file"]) {
      expect(formatChineseTranscriptMarkdown(video({ transcriptSource }), site)).not.toContain("文字记录来源");
    }
  });

  it("escapes source text and IDs while keeping citation fragments linked to the original IDs", () => {
    const id = 'p-"<&';
    const entry = video({ titleZh: "标题 [一]", segments: [{
      id,
      textEn: "English body",
      textZh: "<script>正文</script> & [文字](url)\n# 原文标题\n1. 原文序号",
    }] });
    const output = formatChineseTranscriptMarkdown(entry, site);
    expect(output).toContain("# 标题 \\[一\\]");
    expect(output).toContain('<a id="p-&quot;&lt;&amp;"></a>');
    expect(output).toContain(`https://archive.example/transcripts/sample/#${encodeURIComponent(id)}`);
    expect(output).toContain("&lt;script&gt;正文&lt;/script&gt; &amp; \\[文字\\](url)");
    expect(output).toContain("\\# 原文标题");
    expect(output).toContain("1\\. 原文序号");
    expect(output).not.toContain("<script>");
  });
});
