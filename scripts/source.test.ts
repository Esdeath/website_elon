import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { VideoEntry } from "../src/lib/types";
import {
  buildVideoEntry,
  normalizeEmbedUrl,
  parseDetailHtml,
  parseIndexPayload,
  parseTranscriptPayload,
  parseTranscriptText,
  thumbnailForVideo,
  transcriptNeedsHtmlFallback,
} from "./source";
import type { BuildVideoOptions, SourceIndexEntry } from "./source";

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const fixture = (name: string) => readFile(fixtureUrl(name), "utf8");

describe("source index", () => {
  it("validates and preserves the exact listed entries", async () => {
    const entries = parseIndexPayload(JSON.parse(await fixture("index.json")));
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual([
      "dialogue-video",
      "article-video",
    ]);
  });

  it("rejects totals that could cause false removal markers", () => {
    expect(() => parseIndexPayload({ total: 2, entries: [] })).toThrow(
      /does not match/,
    );
  });
});

describe("transcript parsing", () => {
  it("parses normal transcript JSON into timed dialogue", async () => {
    const parsed = parseTranscriptPayload(
      JSON.parse(await fixture("transcript-dialogue.json")),
    );
    expect(parsed.contentKind).toBe("dialogue");
    expect(parsed.segments).toEqual([
      {
        id: "p-0001",
        speakerEn: "Host",
        startSec: 3,
        textEn: "Welcome to the interview.",
        textZh: "",
      },
      {
        id: "p-0002",
        speakerEn: "Elon Musk",
        startSec: 62,
        textEn: "Thank you for having me.",
        textZh: "",
      },
    ]);
  });

  it("keeps an unlabelled prose transcript as an article", () => {
    const parsed = parseTranscriptText(
      "A first long-form paragraph.\n\nA second long-form paragraph.",
    );
    expect(parsed.contentKind).toBe("article");
    expect(parsed.segments).toHaveLength(2);
  });

  it("requests HTML fallback for missing or empty API content", () => {
    expect(transcriptNeedsHtmlFallback(undefined)).toBe(true);
    expect(
      transcriptNeedsHtmlFallback({ contentKind: "none", segments: [] }),
    ).toBe(true);
  });
});

describe("SSR detail parsing", () => {
  it("prefers Next Flight dialogue and retains timestamps", async () => {
    const parsed = parseDetailHtml(await fixture("detail-dialogue.html"));
    expect(parsed.contentKind).toBe("dialogue");
    expect(parsed.segments[1]).toMatchObject({
      id: "p-0002",
      speakerEn: "Elon Musk",
      startSec: 4.5,
      textEn: "First answer.",
    });
    expect(parsed.transcriptSource).toBe("assemblyai");
  });

  it("falls back to readable speaker DOM", async () => {
    const parsed = parseDetailHtml(await fixture("detail-dialogue-dom.html"));
    expect(parsed.contentKind).toBe("dialogue");
    expect(parsed.segments.map((segment) => segment.speakerEn)).toEqual([
      "Interviewer",
      "Elon Musk",
    ]);
  });

  it("parses prose transcript DOM as an article", async () => {
    const parsed = parseDetailHtml(await fixture("detail-article.html"));
    expect(parsed.contentKind).toBe("article");
    expect(parsed.segments.map((segment) => segment.textEn)).toEqual([
      "The first article paragraph.",
      "The second article paragraph.",
    ]);
  });

  it("parses a standalone profile body without a Transcript heading", async () => {
    const parsed = parseDetailHtml(await fixture("detail-standalone-article.html"));
    expect(parsed.contentKind).toBe("article");
    expect(parsed.segments.map((segment) => segment.textEn)).toEqual([
      "The first profile paragraph.",
      "The second profile paragraph.",
    ]);
  });

  it("reports none rather than inventing unavailable content", async () => {
    const parsed = parseDetailHtml(await fixture("detail-none.html"));
    expect(parsed.contentKind).toBe("none");
    expect(parsed.segments).toEqual([]);
  });
});

describe("media normalization and persistence merge", () => {
  it("separates an X source from its YouTube mirror", async () => {
    const detail = parseDetailHtml(await fixture("detail-x-youtube.html"));
    const sourceUrl = "https://x.com/i/broadcasts/123";
    expect(normalizeEmbedUrl(sourceUrl, detail.embedUrl)).toBe(
      "https://www.youtube-nocookie.com/embed/xMirror12345",
    );
    expect(thumbnailForVideo(sourceUrl, detail.embedUrl, detail.thumbnailUrl)).toBe(
      "https://i.ytimg.com/vi/xMirror12345/maxresdefault.jpg",
    );
  });

  it("does not invent a player for a non-YouTube source", () => {
    expect(normalizeEmbedUrl("https://example.com/article")).toBeUndefined();
    expect(thumbnailForVideo("https://example.com/article")).toBeUndefined();
  });

  it("keeps a safe non-YouTube thumbnail candidate", () => {
    expect(
      thumbnailForVideo(
        "https://example.com/article",
        undefined,
        "https://cdn.example.com/images/interview.jpg",
      ),
    ).toBe("https://cdn.example.com/images/interview.jpg");
  });

  it("rejects the archive-wide default Open Graph image", () => {
    expect(
      thumbnailForVideo(
        "https://example.com/article",
        undefined,
        "https://elonmuskarchive.org/og-default.jpg?v=5",
      ),
    ).toBeUndefined();
  });

  it("retains an existing non-YouTube thumbnail across source refreshes", async () => {
    const index = parseIndexPayload(JSON.parse(await fixture("index.json")))[1];
    const existing = buildVideoEntry(index, {
      fetchedAt: "2026-09-12T00:00:00.000Z",
      snapshotId: "2026-09-12",
      detail: {
        contentKind: "none",
        segments: [],
        thumbnailUrl: "https://cdn.example.com/images/interview.jpg",
      },
    });
    const refreshed = buildVideoEntry(
      index,
      {
        fetchedAt: "2026-09-13T00:00:00.000Z",
        snapshotId: "2026-09-13",
        detail: {
          contentKind: "none",
          segments: [],
          thumbnailUrl: "https://elonmuskarchive.org/og-default.jpg?v=5",
        },
      },
      existing,
    );

    expect(refreshed.thumbnailUrl).toBe(
      "https://cdn.example.com/images/interview.jpg",
    );
  });

  it("keeps reviewed Chinese text when the English source is unchanged", async () => {
    const index = parseIndexPayload(JSON.parse(await fixture("index.json")))[0];
    const transcript = parseTranscriptPayload(
      JSON.parse(await fixture("transcript-dialogue.json")),
    );
    const first = buildVideoEntry(index, {
      fetchedAt: "2026-09-12T00:00:00.000Z",
      snapshotId: "2026-09-12",
      transcript,
    });
    const existing: VideoEntry = {
      ...first,
      titleZh: "一场对话",
      summaryZh: "简短访谈。",
      segments: first.segments.map((segment, index) => ({
        ...segment,
        textZh: index ? "谢谢邀请。" : "欢迎。",
      })),
      translation: { status: "reviewed", reviewedAt: "2026-09-12" },
    };
    const next = buildVideoEntry(
      index,
      {
        fetchedAt: "2026-09-13T00:00:00.000Z",
        snapshotId: "2026-09-13",
        transcript,
      },
      existing,
    );
    expect(next.sourceHash).toBe(existing.sourceHash);
    expect(next.titleZh).toBe("一场对话");
    expect(next.segments[0].textZh).toBe("欢迎。");
    expect(next.translation.status).toBe("reviewed");
  });

  it("clears only changed paragraph translations and returns to pending", async () => {
    const index = parseIndexPayload(JSON.parse(await fixture("index.json")))[0];
    const transcript = parseTranscriptPayload(
      JSON.parse(await fixture("transcript-dialogue.json")),
    );
    const first = buildVideoEntry(index, {
      fetchedAt: "2026-09-12T00:00:00.000Z",
      snapshotId: "2026-09-12",
      transcript,
    });
    const existing: VideoEntry = {
      ...first,
      segments: first.segments.map((segment) => ({
        ...segment,
        textZh: "已有译文",
      })),
      translation: { status: "reviewed" },
    };
    const changedTranscript = {
      ...transcript,
      segments: transcript.segments.map((segment, position) =>
        position === 1 ? { ...segment, textEn: "A corrected answer." } : segment,
      ),
    };
    const next = buildVideoEntry(
      index,
      {
        fetchedAt: "2026-09-13T00:00:00.000Z",
        snapshotId: "2026-09-13",
        transcript: changedTranscript,
      },
      existing,
    );
    expect(next.segments.map((segment) => segment.textZh)).toEqual([
      "已有译文",
      "",
    ]);
    expect(next.translation.status).toBe("pending");
  });
});

describe("supplemental YouTube caption persistence", () => {
  const index: SourceIndexEntry = {
    id: "earnings-video",
    type: "earnings",
    date: "2026-04-22",
    title: "An earnings call",
    url: "https://elonmuskarchive.org/video/earnings-video",
    source: "https://www.youtube.com/watch?v=abcDEF12345",
  };
  const options: BuildVideoOptions = {
    fetchedAt: "2026-09-17T00:00:00.000Z",
    snapshotId: "2026-09-17",
    transcript: { contentKind: "none", segments: [] },
    detail: { contentKind: "none", segments: [] },
  };
  const withCaptions = (): VideoEntry => {
    const entry = buildVideoEntry(index, {
      ...options,
      transcript: {
        ...parseTranscriptText("Supplemental caption text."),
        transcriptSource: index.source,
      },
    });
    return {
      ...entry,
      titleZh: "财报电话会",
      segments: entry.segments.map((segment) => ({ ...segment, textZh: "补充字幕。" })),
      translation: { status: "reviewed", reviewedAt: "2026-09-17" },
    };
  };

  it("retains supplemental captions, their provenance, translations and hash when the archive has no text", () => {
    const existing = withCaptions();
    const refreshed = buildVideoEntry(index, {
      ...options,
      transcript: { contentKind: "none", segments: [], transcriptSource: "assemblyai" },
    }, existing);

    expect(refreshed.contentKind).toBe("article");
    expect(refreshed.segments).toEqual(existing.segments);
    expect(refreshed.transcriptSource).toBe(existing.transcriptSource);
    expect(refreshed.titleZh).toBe(existing.titleZh);
    expect(refreshed.translation).toEqual(existing.translation);
    expect(refreshed.sourceHash).toBe(existing.sourceHash);
  });

  it("recognizes equivalent YouTube source URLs", () => {
    const existing = withCaptions();
    const refreshed = buildVideoEntry({ ...index, source: "https://youtu.be/abcDEF12345?t=10" }, options, existing);

    expect(refreshed.segments).toEqual(existing.segments);
    expect(refreshed.transcriptSource).toBe(existing.transcriptSource);
  });

  it.each(["transcript", "detail"] as const)("prefers newly available archive %s text over supplemental captions", (source) => {
    const existing = withCaptions();
    const refreshed = buildVideoEntry(index, {
      ...options,
      [source]: {
        ...parseTranscriptText("A corrected transcript from the archive."),
        transcriptSource: "assemblyai",
      },
    }, existing);

    expect(refreshed.segments[0].textEn).toBe("A corrected transcript from the archive.");
    expect(refreshed.segments[0].textZh).toBe("");
    expect(refreshed.transcriptSource).toBe("assemblyai");
    expect(refreshed.translation.status).toBe("pending");
    expect(refreshed.sourceHash).not.toBe(existing.sourceHash);
  });

  it.each([
    { name: "entry identity", index: { id: "different-entry" } },
    { name: "source video", index: { source: "https://www.youtube.com/watch?v=otherVideo1" } },
    { name: "embedded video", detail: { embedUrl: "https://www.youtube.com/embed/otherVideo1" } },
    { name: "caption video", existing: { transcriptSource: "https://www.youtube.com/watch?v=otherVideo1" } },
    { name: "archive transcript", existing: { transcriptSource: "assemblyai" } },
  ])("does not retain captions for a mismatched $name", (change) => {
    const refreshed = buildVideoEntry(
      { ...index, ...change.index },
      { ...options, detail: { contentKind: "none", segments: [], ...change.detail } },
      { ...withCaptions(), ...change.existing },
    );

    expect(refreshed.contentKind).toBe("none");
    expect(refreshed.segments).toEqual([]);
    expect(refreshed.transcriptSource).toBeUndefined();
  });
});
