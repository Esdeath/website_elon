import { describe, expect, it } from "vitest";
import {
  VIDEO_DESCRIPTION_MAX_LENGTH,
  VIDEO_TITLE_MAX_LENGTH,
  buildVideoSitemap,
  escapeXml,
  type VideoSitemapEntry,
} from "./video-sitemap";

const validEntry: VideoSitemapEntry = {
  loc: "https://archive.example/videos/example/",
  thumbnailLoc: "https://img.example/thumb.jpg",
  title: "中文标题",
  description: "中文摘要",
  playerLoc: "https://www.youtube-nocookie.com/embed/example?rel=0&lang=zh",
  publicationDate: "2024-02-29",
  durationSec: 3600,
};

describe("escapeXml", () => {
  it("escapes XML syntax and removes invalid XML characters", () => {
    expect(escapeXml(`  A&B <C> "D" 'E'\u0000\u0008  `)).toBe(
      "A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;",
    );
  });

  it("truncates by Unicode code point without splitting surrogate pairs", () => {
    expect(escapeXml("😀".repeat(VIDEO_TITLE_MAX_LENGTH + 1), VIDEO_TITLE_MAX_LENGTH)).toBe(
      "😀".repeat(VIDEO_TITLE_MAX_LENGTH),
    );
  });
});

describe("buildVideoSitemap", () => {
  it("serializes Google video sitemap fields and escapes URLs", () => {
    const xml = buildVideoSitemap([validEntry]);

    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    expect(xml).toContain(`<loc>${validEntry.loc}</loc>`);
    expect(xml).toContain(`<video:thumbnail_loc>${validEntry.thumbnailLoc}</video:thumbnail_loc>`);
    expect(xml).toContain("<video:title>中文标题</video:title>");
    expect(xml).toContain("<video:description>中文摘要</video:description>");
    expect(xml).toContain(
      '<video:player_loc allow_embed="yes">https://www.youtube-nocookie.com/embed/example?rel=0&amp;lang=zh</video:player_loc>',
    );
    expect(xml).toContain("<video:publication_date>2024-02-29</video:publication_date>");
    expect(xml).toContain("<video:duration>3600</video:duration>");
  });

  it("limits titles and descriptions to Google's character limits", () => {
    const title = "题".repeat(VIDEO_TITLE_MAX_LENGTH + 10);
    const description = "文".repeat(VIDEO_DESCRIPTION_MAX_LENGTH + 10);
    const xml = buildVideoSitemap([{ ...validEntry, title, description }]);

    expect(xml).toContain(`<video:title>${"题".repeat(VIDEO_TITLE_MAX_LENGTH)}</video:title>`);
    expect(xml).not.toContain("题".repeat(VIDEO_TITLE_MAX_LENGTH + 1));
    expect(xml).toContain(
      `<video:description>${"文".repeat(VIDEO_DESCRIPTION_MAX_LENGTH)}</video:description>`,
    );
    expect(xml).not.toContain("文".repeat(VIDEO_DESCRIPTION_MAX_LENGTH + 1));
  });

  it("omits invalid durations while retaining otherwise valid videos", () => {
    for (const durationSec of [undefined, 0, 1.5, 28_801, Number.NaN]) {
      expect(buildVideoSitemap([{ ...validEntry, durationSec }])).not.toContain(
        "<video:duration>",
      );
    }

    for (const durationSec of [1, 28_800]) {
      expect(buildVideoSitemap([{ ...validEntry, durationSec }])).toContain(
        `<video:duration>${durationSec}</video:duration>`,
      );
    }
  });

  it("excludes entries without valid canonical, player, thumbnail, date, or Chinese text", () => {
    const invalidEntries = [
      { ...validEntry, loc: "relative/path" },
      { ...validEntry, playerLoc: "javascript:alert(1)" },
      { ...validEntry, thumbnailLoc: undefined },
      { ...validEntry, publicationDate: "2023-02-29" },
      { ...validEntry, title: " " },
      { ...validEntry, description: " " },
      { ...validEntry, title: "\u0000\u0008" },
    ];

    expect(buildVideoSitemap(invalidEntries)).not.toContain("<url>");
  });
});
