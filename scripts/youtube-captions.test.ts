import { describe, expect, it } from "vitest";
import { parseYouTubeJson3 } from "./youtube-captions";

describe("parseYouTubeJson3", () => {
  it("ignores rolling-caption control events and preserves timestamps", () => {
    const segments = parseYouTubeJson3(
      {
        events: [
          { tStartMs: 0 },
          { tStartMs: 1_250, segs: [{ utf8: "Hello" }, { utf8: " world." }] },
          { tStartMs: 2_000, segs: [{ utf8: "\n" }] },
          { tStartMs: 2_100, segs: [{ utf8: "Next" }, { utf8: " sentence." }] },
        ],
      },
      { targetCharacters: 1, maximumCharacters: 100 },
    );

    expect(segments).toEqual([
      { id: "p-0001", startSec: 1.25, textEn: "Hello world.", textZh: "" },
      { id: "p-0002", startSec: 2.1, textEn: "Next sentence.", textZh: "" },
    ]);
  });

  it("starts a new paragraph before the maximum size is exceeded", () => {
    const segments = parseYouTubeJson3(
      {
        events: [
          { tStartMs: 0, segs: [{ utf8: "one two" }] },
          { tStartMs: 1_000, segs: [{ utf8: "three four" }] },
        ],
      },
      { targetCharacters: 100, maximumCharacters: 12 },
    );

    expect(segments.map(({ textEn }) => textEn)).toEqual(["one two", "three four"]);
  });
});
