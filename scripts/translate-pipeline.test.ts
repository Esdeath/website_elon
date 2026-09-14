import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VideoEntry } from "../src/lib/types";
import {
  applyCompletedParts,
  assertTranslationOutput,
  checkpointPath,
  chunkUnits,
  createCheckpoint,
  expandOversizedUnits,
  getTranslationUnits,
  unitReviewHash,
  unitSourceHash,
  writeCheckpoint,
} from "./codex-content";
import { reviewVideoFiles } from "./review-translations";
import {
  loadVideoFiles,
  parseTranslateArgs,
  translateVideoFiles,
  type TranslateOptions,
} from "./translate-videos";
import { computeSourceHash, validateVideoEntries } from "./validate-content";
import { compareNumericIntegrity } from "./translation-integrity";
import { alignLimitedSelection, splitStageArguments } from "./sync";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

function fixtureEntry(): VideoEntry {
  const entry: VideoEntry = {
    id: "video-1",
    slug: "example-video",
    snapshotId: "2026-09-12",
    type: "interview",
    date: "2024-01-02",
    titleEn: "A useful conversation",
    titleZh: "",
    summaryEn: "A short summary.",
    summaryZh: "",
    sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    archiveUrl: "https://elonmuskarchive.org/video/video-1",
    embedUrl: "https://www.youtube-nocookie.com/embed/abcdefghijk",
    contentKind: "dialogue",
    segments: [
      {
        id: "p0001",
        speakerEn: "Elon Musk",
        textEn: "Hello 42.",
        textZh: "",
      },
      {
        id: "p0002",
        speakerEn: "Interviewer",
        textEn: "Why now?",
        textZh: "",
      },
    ],
    translation: { status: "pending" },
    fetchedAt: "2026-09-12T00:00:00.000Z",
    sourceHash: "pending",
  };
  entry.sourceHash = computeSourceHash(entry);
  return entry;
}

async function fixtureWorkspace(): Promise<{
  root: string;
  dataDir: string;
  filePath: string;
  options: TranslateOptions;
}> {
  const root = await mkdtemp(join(tmpdir(), "translate-test-"));
  temporaryDirectories.push(root);
  const dataDir = join(root, "videos");
  const filePath = join(dataDir, "video-1.json");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dataDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(fixtureEntry(), null, 2)}\n`);
  const options = parseTranslateArgs(
    [
      "--data-dir",
      dataDir,
      "--checkpoint-dir",
      join(root, "checkpoints"),
      "--resume",
      "--chunk-chars",
      "1000",
    ],
    root,
  );
  return { root, dataDir, filePath, options };
}

function chineseFor(id: string): { textZh: string; speakerZh: string } {
  if (id === "meta:title") return { textZh: "一次有价值的对话", speakerZh: "" };
  if (id === "meta:summary") return { textZh: "一段简短摘要。", speakerZh: "" };
  if (id === "segment:p0001") return { textZh: "你好，42。", speakerZh: "埃隆·马斯克" };
  if (id === "segment:p0002") return { textZh: "为什么是现在？", speakerZh: "采访者" };
  throw new Error(`unexpected fixture id ${id}`);
}

function multiChunkEntry(): VideoEntry {
  const entry = fixtureEntry();
  entry.titleEn = "A useful conversation. ".repeat(24);
  entry.summaryEn = "A short archive summary. ".repeat(22);
  entry.sourceHash = computeSourceHash(entry);
  return entry;
}

describe("translation pipeline", () => {
  it("rejects empty and unknown explicit id selections", async () => {
    expect(() => parseTranslateArgs(["--ids=,"])).toThrow(
      "--ids must contain one or more comma-separated video ids",
    );
    const options = parseTranslateArgs(["--ids=not-present"]);
    await expect(
      translateVideoFiles(
        [{ path: "/unused.json", entry: fixtureEntry() }],
        options,
        async () => ({ translations: [] }),
      ),
    ).rejects.toThrow("Requested ids are not in the local snapshot");
  });

  it("keeps stable paragraph ids while chunking", () => {
    const units = getTranslationUnits(fixtureEntry());
    const chunks = chunkUnits(units, 1_000);
    expect(chunks.flat().map(({ id }) => id)).toEqual([
      "meta:title",
      "meta:summary",
      "segment:p0001",
      "segment:p0002",
    ]);
  });

  it("recovers the id for a single structured translation result", () => {
    const unit = {
      id: "segment:only",
      kind: "segment" as const,
      textEn: "Hello 42.",
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(
      assertTranslationOutput([unit], {
        translations: [{ id: "", textZh: "你好，42。", speakerZh: "" }],
      }).get(unit.id),
    ).toEqual({ textZh: "你好，42。", speakerZh: "" });

    expect(() =>
      assertTranslationOutput([unit, { ...unit, id: "segment:second" }], {
        translations: [{ id: "", textZh: "你好，42。", speakerZh: "" }],
      }),
    ).toThrow("unexpected id");
  });

  it("rejects explicit substitutions, omissions, and additions", () => {
    const unit = {
      id: "segment:numbers",
      kind: "segment" as const,
      textEn: "10 robots, then 10 more",
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [
          { id: unit.id, textZh: "10 个机器人，另外 99 个", speakerZh: "" },
        ],
      }),
    ).toThrow("changed numbers");
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [
          { id: unit.id, textZh: "这里只剩 10 个机器人", speakerZh: "" },
        ],
      }),
    ).toThrow("changed numbers");
    expect(compareNumericIntegrity(unit.textEn, "这里只剩 10 个机器人").level).toBe(
      "error",
    );
    expect(
      compareNumericIntegrity(
        "Revenue was $5 billion.",
        "营收为50亿美元，利润为2亿美元。",
      ).level,
    ).toBe("error");
    expect(
      compareNumericIntegrity(
        "One issue: revenue was $5 billion.",
        "一个问题是：营收为40亿美元。",
      ).level,
    ).toBe("error");
  });

  it("allows quarter labels to be localized", () => {
    const unit = {
      id: "meta:title",
      kind: "title" as const,
      textEn: "Tesla Q1 2026 earnings call",
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [
          { id: unit.id, textZh: "特斯拉 2026 年第一季度财报电话会议", speakerZh: "" },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [
          { id: unit.id, textZh: "特斯拉 2026 年第四季度财报电话会议", speakerZh: "" },
        ],
      }),
    ).toThrow("changed numbers");
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [
          { id: unit.id, textZh: "特斯拉 2026 年财报电话会议", speakerZh: "" },
        ],
      }),
    ).toThrow("changed numbers");
    expect(
      compareNumericIntegrity(
        "Production tripled in Q3 compared to the previous quarter.",
        "产量在第三季度较上一季度增长2倍。",
      ).level,
    ).toBe("ok");
  });

  it("accepts semantically equivalent localized magnitudes and dates", () => {
    const unit = {
      id: "segment:values",
      kind: "segment" as const,
      textEn: "On November 18, we invested $5 billion.",
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [
          { id: unit.id, textZh: "11月18日，我们投资了50亿美元。", speakerZh: "" },
        ],
      }),
    ).not.toThrow();
  });

  it("does not parse the temporal phrase at one point as a decimal", () => {
    const source = "That's one thing I enjoy. I asked at one point one of the guys.";
    const translation = "这是我喜欢的一点。我有一次问过其中一个人。";
    expect(compareNumericIntegrity(source, translation).level).not.toBe("error");
    expect(
      compareNumericIntegrity(
        "The value was one point one percent.",
        "这个值是 1.1%。",
      ).level,
    ).toBe("ok");
  });

  it("allows repeated endpoints to use explicit Chinese classifiers", () => {
    expect(
      compareNumericIntegrity(
        "That's a way to get a score. How quickly can you get from bubble to bubble?",
        "这是一种打分方法。你能多快地从一个气泡移到另一个气泡？",
      ).level,
    ).not.toBe("error");
  });

  it("allows a named team to be localized as standing on one side", () => {
    expect(
      compareNumericIntegrity(
        "At one point he called me a species for being too much on Team Humanity.",
        "有一次，他因为我太站在人类一边而称我是一个物种。",
      ).level,
    ).not.toBe("error");
  });

  it("does not treat May as a month outside date context", () => {
    const examples = [
      ["May I ask a question?", "我可以问一个问题吗？"],
      ["Elon's mother, May Musk.", "埃隆的母亲梅耶·马斯克。"],
      [
        "Part of this may be related to the past 18 months.",
        "这可能与过去18个月有关。",
      ],
      [
        "This may sound strange, but it has lasted 18 months.",
        "这听起来可能很奇怪，但已经持续18个月了。",
      ],
    ];
    for (const [textEn, textZh] of examples) {
      const unit = {
        id: "segment:may",
        kind: "segment" as const,
        textEn,
        textZh: "",
        speakerEn: "",
        speakerZh: "",
      };
      expect(() =>
        assertTranslationOutput([unit], {
          translations: [{ id: unit.id, textZh, speakerZh: "" }],
        }),
      ).not.toThrow();
    }
  });

  it("does not treat the verb march as a month and preserves amendment ordinals", () => {
    expect(compareNumericIntegrity("They wanted to march through town in 977.", "他们想在977年游行穿城而过。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("The First Amendment protects speech.", "第一修正案保护言论。").level)
      .toBe("ok");
  });

  it("handles lowercase and textual Chinese month forms without treating May Musk as a date", () => {
    const examples = [
      ["The launch is in august 2026.", "发射定于2026年8月。"],
      ["On November 18, we launched.", "十一月18日，我们发射了。"],
      ["November and December next year.", "明年11月和12月。"],
      ["We met on May Musk's birthday.", "我们在梅耶·马斯克生日那天见面。"],
    ];
    for (const [textEn, textZh] of examples) {
      const unit = {
        id: "segment:month",
        kind: "segment" as const,
        textEn,
        textZh: "",
        speakerEn: "",
        speakerZh: "",
      };
      expect(() =>
        assertTranslationOutput([unit], {
          translations: [{ id: unit.id, textZh, speakerZh: "" }],
        }),
      ).not.toThrow();
    }
  });

  it("recognizes compact Chinese ten-based numerals used with counters", () => {
    const unit = {
      id: "segment:chinese-counter-number",
      kind: "segment" as const,
      textEn: "Top 10 Tech Trends on May 7, 2009 and May 20th.",
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [
          {
            id: unit.id,
            textZh: "2009年5月7日和5月20日的十大科技趋势。",
            speakerZh: "",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("preserves numeric ordinals in localized university names", () => {
    expect(compareNumericIntegrity("Universite Paris 1", "巴黎第一大学").level).toBe("ok");
  });

  it("preserves numeric ordinals in localized circuit court names", () => {
    expect(
      compareNumericIntegrity(
        "The U.S. 5th Circuit Court of Appeals issued a decision.",
        "美国第五巡回上诉法院作出了一项裁决。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "The U.S. 5th Circuit Court of Appeals issued a decision.",
        "美国第四巡回上诉法院作出裁决。",
      ).level,
    ).toBe("error");
  });

  it("preserves written multiplier words across Chinese equivalents", () => {
    expect(
      compareNumericIntegrity(
        "We will triple the coverage area.",
        "我们会把覆盖面积扩大到三倍。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "We will triple the coverage area.",
        "我们会大幅扩大覆盖面积。",
      ).level,
    ).toBe("error");
    expect(
      compareNumericIntegrity(
        "The output will double.",
        "产量将提高到2倍。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("The output will double.", "产量将翻倍。").level).toBe(
      "ok",
    );
    expect(compareNumericIntegrity("We will double the size.", "我们会把规模扩大1倍。").level).toBe(
      "ok",
    );
    expect(compareNumericIntegrity("Production tripled.", "产量增长2倍。").level).toBe("ok");
    expect(
      compareNumericIntegrity(
        "We could double or triple the population.",
        "我们可以让人口增加1倍或2倍。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "We could double or triple the population.",
        "我们可以让人口增加2倍或3倍。",
      ).level,
    ).toBe("error");
    expect(
      compareNumericIntegrity(
        "We double fuse the cell so it is triple fused in total.",
        "我们对电芯采用双重熔断，因此总共有三重熔断。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("We use a double crane.", "我们使用双吊车。").level).toBe(
      "ok",
    );
    expect(compareNumericIntegrity("It is a double-edged sword.", "这是一把双刃剑。").level).toBe(
      "ok",
    );
    expect(
      compareNumericIntegrity(
        "Tesla doubled its fleet while demand was tripling.",
        "Tesla 的车队扩大到2倍，而需求正增至3倍。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("We achieved a threefold increase.", "我们实现了三倍增长。").level)
      .toBe("ok");
    expect(
      compareNumericIntegrity(
        "Double check that your registration is good.",
        "再次确认你的登记有效。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("The parts are doubled up.", "这些部件重复设置了。").level)
      .toBe("ok");
    expect(
      compareNumericIntegrity(
        "Double click into that; if one uses authentication, it should be okay.",
        "深入谈谈这一点；如果一个人使用身份验证，应该没问题。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("Double click the button.", "双击按钮。").level).toBe("ok");
    expect(
      compareNumericIntegrity(
        "Production doubled and then doubled again.",
        "产量先倍增，随后又翻了一倍。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("It uses a dual motor.", "它采用双电机。").level).toBe(
      "ok",
    );
    expect(
      compareNumericIntegrity(
        "It reflects a dual philosophy.",
        "它体现了一种双重理念。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "There is a dual benefit.",
        "这有一种双重好处。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "Dual inductive chargers in the back and dual inductive in the front.",
        "后排配有双感应充电器，前排也有双感应充电。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("It uses a tri-motor powertrain.", "它采用三电机动力系统。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("It supports bi-directional signals.", "它支持双向信号。").level)
      .toBe("ok");
  });

  it("does not treat doubles down as a multiplier and allows the only means to become one", () => {
    expect(
      compareNumericIntegrity(
        "It doubles down on the claim that this is the only means, despite a 30% drop.",
        "它进一步坚持这是唯一手段，尽管下跌了 30%。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "You are the only massive platform that's open and free. We're trying to create a pro human future.",
        "你们是唯一一个开放且自由的大型平台。我们正努力创造一个亲人类的未来。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("Production doubles.", "产量翻倍。").level).toBe("ok");
  });

  it("allows archive phrasing to make a selected kind explicit", () => {
    expect(
      compareNumericIntegrity(
        "It's the ability to come up with novel ideas.",
        "这是一种提出新颖想法的能力。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "We operated in a thermally constrained environment and picked integer add.",
        "我们在一个受散热限制的环境中选择了一种整数加法。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "It is not a signal. You have this very complicated guesstimation or unsupervised problem. The open loop problem has the nice property of being easy to debug.",
        "这不是一种信号。你面临这样一个非常复杂的估算或无监督问题。开环问题有一个很好的特性，就是容易调试。",
      ).level,
    ).toBe("warning");
  });

  it("routes approximate calendar-scale words to review", () => {
    const source = "What innovations will change our lives in the decades ahead?";
    const translation = "未来几十年，哪些创新会改变我们的生活？";
    expect(compareNumericIntegrity(source, translation).level).toBe("warning");

    const unit = {
      id: "segment:approximate-decades",
      kind: "segment" as const,
      textEn: source,
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [{ id: unit.id, textZh: translation, speakerZh: "" }],
      }),
    ).not.toThrow();
  });

  it("recognizes plural nines as a numeric reliability expression", () => {
    expect(
      compareNumericIntegrity(
        "We should reach the end of the nines by 2020.",
        "到2020年，我们应该能达到多个9的末端。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "It reached ninety-nine with many nines after it.",
        "它达到了九十九，后面还有许多个9。",
      ).level,
    ).toBe("warning");
  });

  it("distinguishes counted things from discourse markers", () => {
    expect(compareNumericIntegrity("There are two things.", "有两件事。 ").level).toBe("ok");
    expect(
      compareNumericIntegrity("Tell me one thing or two things.", "告诉我一件事或两件事。").level,
    ).toBe("ok");
    expect(compareNumericIntegrity("At one point it stopped.", "它一度停了下来。").level).toBe("ok");
    expect(compareNumericIntegrity("One thing to note is speed.", "需要注意的一点是速度。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("Compare the input to the output.", "比较输入与输出两者。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("It works between flights.", "它能在两次飞行之间工作。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("Decouple generation from use.", "把两者分离开来。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("They may like me or hate me.", "这两者都有可能。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("Tell us about the drug called Soma.", "介绍一种叫Soma的药。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("This is a strange situation.", "这是一种奇怪的情况。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("This movement is growing.", "这样一种运动正在发展。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("I can do open cab ride.", "我可以进行一次敞篷车体验。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("It is exciting future.", "这是一个激动人心的未来。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("It is getting to the point where it works.", "它正达到一个可用的阶段。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("It may come across as critical.", "这可能给人一种苛刻的感觉。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("Finatra and Finagle are custom.", "这两个项目都是定制的。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("There are many parallels.", "两者有很多相似之处。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("A truck while also a sports car.", "卡车与跑车二者合一。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("Six six or seven swing states.", "6个、6个或7个摇摆州。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("About 10 or 20,000 votes.", "大约10,000或20,000票。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("Start with no credibility score.", "可信度从0分开始。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("Draw a Venn diagram.", "画出两个集合的维恩图。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("It is a form, a form of speech.", "这是一种，一种言论形式。").level)
      .toBe("warning");
  });

  it("recognizes archive-style quarter comparisons", () => {
    expect(
      compareNumericIntegrity(
        "It creates only a quarter as much CO2, about quarter as much overall.",
        "它产生的CO2只有四分之一，总体也约为四分之一。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("Quarter of people got one.", "四分之一的人拿到了。").level)
      .toBe("ok");
  });

  it("allows relative calendar phrases to make the implied one explicit", () => {
    expect(
      compareNumericIntegrity(
        "We arrived the day before the factory opened.",
        "我们在工厂开业前1天抵达。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("We arrived before it opened.", "我们提前1天抵达。").level).toBe(
      "error",
    );
  });

  it("allows a possessive other to make one explicit", () => {
    expect(
      compareNumericIntegrity(
        "My other son asked a question.",
        "我的另一个儿子问了一个问题。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "My other son asked a question.",
        "我另外两个儿子问了一个问题。",
      ).level,
    ).toBe("error");
  });

  it("allows this exploration to make one explicit", () => {
    expect(
      compareNumericIntegrity(
        "It was like this exploration.",
        "这就像是这样一种探索。",
      ).level,
    ).toBe("warning");
  });

  it("allows a singular this-thing phrase to make one explicit", () => {
    expect(compareNumericIntegrity("Little subtle thing.", "一个不易察觉的小细节。").level)
      .toBe("warning");
    expect(
      compareNumericIntegrity(
        "Latency is this huge, huge thing that you have to deal with in 15 milliseconds.",
        "延迟是你必须处理的一个非常大的问题，耗时 15 毫秒。",
      ).level,
    ).toBe("warning");
  });

  it("allows a singular the-side phrase to make one explicit", () => {
    const source = "These 4680s also get large credits on the consumer side.";
    expect(compareNumericIntegrity(source, "这些 4680 电池在消费者一侧也能获得大额抵免。").level)
      .toBe("warning");
    expect(compareNumericIntegrity(source, "这些 4680 电池在消费者两侧都能获得大额抵免。").level)
      .toBe("error");
  });

  it("allows ASR-dropped articles for a stain and a standard set", () => {
    const source =
      "This is multiplex stain that uses different proteins. We use very standard set of techniques, with EB1.";
    const target = "这是一种多重染色。我们使用一套非常标准的技术，包括 EB1。";
    expect(compareNumericIntegrity(source, target).level).toBe("warning");
    expect(compareNumericIntegrity(source, `${target} 还有一个额外步骤。`).level).toBe("error");
  });

  it("allows a pronoun plus alone to become one person", () => {
    const source = "You alone have contributed so much money.";
    expect(compareNumericIntegrity(source, "你一个人就贡献了这么多钱。").level).toBe("warning");
    expect(compareNumericIntegrity(source, "你们两个人贡献了这么多钱。").level).toBe("error");
  });

  it("allows a singular this-layer phrase to make one explicit", () => {
    const source = "You are creating this protective layer about 50 microns thick.";
    expect(compareNumericIntegrity(source, "你正在形成一层约 50 微米厚的保护层。").level)
      .toBe("warning");
    expect(compareNumericIntegrity(source, "你正在形成两层约 50 微米厚的保护层。").level)
      .toBe("error");
  });

  it("recognizes a double-sided board as two-sided", () => {
    const source = "This board is double sided, eight layered.";
    expect(compareNumericIntegrity(source, "这块板是双面、8 层的。").level).toBe("warning");
    expect(compareNumericIntegrity(source, "这块板是单面、8 层的。").level).toBe("error");
  });

  it("recognizes dual and triple sourcing", () => {
    const source = "We use dual sourcing and triple sourcing across 45 countries.";
    expect(compareNumericIntegrity(source, "我们在 45 个国家实行双重采购和三重采购。").level)
      .toBe("ok");
    expect(compareNumericIntegrity(source, "我们在 45 个国家实行三重采购。").level)
      .toBe("error");
    expect(compareNumericIntegrity("We laid the foundation for dual sources.", "我们为双重供应源奠定了基础。").level)
      .toBe("ok");
  });

  it("does not treat double-and-triple-click-on as numeric", () => {
    expect(compareNumericIntegrity("We should double and triple click on these questions.", "我们应该反复深入追问这些问题。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("We should double and triple the clicks.", "我们应该增加点击次数。").level)
      .toBe("error");
  });

  it("recognizes a counted Chinese points phrase", () => {
    expect(compareNumericIntegrity("Yeah, two things.", "对，有两点。").level).toBe("ok");
    expect(compareNumericIntegrity("Yeah, two things.", "对，有三点。").level).toBe("error");
    expect(compareNumericIntegrity("This is a little hard.", "这有点难。").level).toBe("ok");
  });

  it("normalizes the bottom of the hour to minute 30", () => {
    expect(compareNumericIntegrity("I'm good to the bottom of the hour.", "我可以待到这个小时的 30 分。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("I'm good to the bottom of the hour.", "我可以待到这个小时的半点。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("I'm good to the bottom of the hour.", "我可以待到这个小时的 45 分。").level)
      .toBe("error");
  });

  it("treats megapixels per year as a unit label", () => {
    const source = "Resolution over time, like megapixels per year, then a 100 megapixel camera.";
    expect(compareNumericIntegrity(source, "分辨率随时间变化，比如每年对应的百万像素数，然后是 1 亿像素相机。").level)
      .toBe("ok");
    expect(compareNumericIntegrity(source, "分辨率随时间变化，然后是 2000 万像素相机。").level)
      .toBe("error");
  });

  it("allows a singular the-reason phrase to make one explicit", () => {
    const source = "The metaphysical damn good reason does not matter.";
    expect(compareNumericIntegrity(source, "那一个形而上学层面的充分理由并不重要。").level)
      .toBe("warning");
    expect(compareNumericIntegrity(source, "那两个理由并不重要。").level).toBe("error");
  });

  it("allows a singular this-person phrase to make one explicit", () => {
    expect(
      compareNumericIntegrity(
        "Me and this guy named Paul went into the jungle.",
        "我和一个名叫保罗的人走进了丛林。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "Me and this guy named Paul went into the jungle.",
        "我和两个名叫保罗的人走进了丛林。",
      ).level,
    ).toBe("error");
  });

  it("allows a numeric ordinal fraction to make its numerator explicit", () => {
    expect(
      compareNumericIntegrity(
        "Civilization has existed for 1000000th of Earth's existence.",
        "文明存在的时间是地球存在时间的 1000000 分之 1。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "Civilization has existed for 1000000th of Earth's existence.",
        "文明存在的时间是地球存在时间的 1000000 分之 2。",
      ).level,
    ).toBe("error");
  });

  it("allows rule-of-thumb and order-of phrases to make one explicit", () => {
    const source = "The general good rule of thumb is to keep it on the order of the object's size.";
    expect(
      compareNumericIntegrity(
        source,
        "一个实用经验法则是，让它与物体尺寸大致处于同一数量级。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        source,
        "两个经验法则要求相差两个数量级。",
      ).level,
    ).toBe("error");
  });

  it("allows that threshold to be localized with an explicit one", () => {
    expect(
      compareNumericIntegrity(
        "Like frustrating hard, or actually cognitively hard? Like which way?",
        "是令人沮丧的那种难，还是认知层面很难？是哪一种？",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "We are getting to that threshold and a seriously advanced level.",
        "我们正接近一个门槛，并达到一个非常先进的水平。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "We are getting to that threshold.",
        "我们正接近两个门槛。",
      ).level,
    ).toBe("error");
  });

  it("allows practically nothing to be localized as zero", () => {
    expect(
      compareNumericIntegrity(
        "The amount needed is practically nothing.",
        "所需的量几乎为零。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "The amount needed is practically nothing.",
        "所需的量大约为 1。",
      ).level,
    ).toBe("error");
  });

  it("allows an implicit one before prefixed power units", () => {
    expect(
      compareNumericIntegrity(
        "We brought a gigawatt of power online.",
        "我们让1吉瓦电力上线了。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("We brought power online.", "我们让1吉瓦电力上线了。").level).toBe(
      "error",
    );
  });

  it("does not parse a broken lowercase may range as a calendar month", () => {
    const source = "at least one to two years may 1 to 3 years after that";
    const translation = "至少1到2年，也许在那之后还要1到3年。";
    expect(compareNumericIntegrity(source, translation).level).toBe("warning");

    const unit = {
      id: "segment:broken-modal-range",
      kind: "segment" as const,
      textEn: source,
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [{ id: unit.id, textZh: translation, speakerZh: "" }],
      }),
    ).not.toThrow();
  });

  it("normalizes written decades, word fractions, and percent ranges", () => {
    expect(compareNumericIntegrity("The nineties and the 90s.", "90年代和90年代。").level)
      .toBe("ok");
    expect(
      compareNumericIntegrity(
        "Roughly 60-70 percent prefer a two-third or one-third share.",
        "大约60%-70%的人倾向于2/3或1/3的份额。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("A two-thirds share.", "三分之二的份额。").level)
      .toBe("ok");
    expect(
      compareNumericIntegrity(
        "Onethird of approvals get pulled; that is onethird of the things you say are okay.",
        "三分之一的批准项目会被撤回；那是你说没问题的事情中的三分之一。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("A quarter mile.", "四分之一英里。").level).toBe("ok");
    expect(compareNumericIntegrity("A quarter of people.", "四分之一的人。").level).toBe(
      "ok",
    );
    expect(
      compareNumericIntegrity(
        "This was our best quarter of new customers, up from 1.4 million.",
        "这是新增客户表现最好的季度，高于此前的140万。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("Yeah, like a quarter.", "对，大约四分之一。 ").level)
      .toBe("ok");
    expect(
      compareNumericIntegrity(
        "It is a size of about a quarter and has over 1000 channels.",
        "它约有25美分硬币大小，并有1000多个通道。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "It can be two orders of magnitude cheaper. Two orders of magnitude cheaper.",
        "它可以便宜两个数量级。便宜两个数量级。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("It may drop by an order of magnitude.", "它可能下降一个数量级。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("It may drop by in order of magnitude.", "它可能下降一个数量级。").level)
      .toBe("ok");
    expect(
      compareNumericIntegrity(
        "A low 20s to 30% premium.",
        "百分之二十出头到30%的溢价。",
      ).level,
    ).toBe("ok");
  });

  it("normalizes a half-century into a Chinese half expression", () => {
    expect(compareNumericIntegrity("One half century has passed.", "已经过去半个世纪。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("One half century has passed.", "已经过去一个世纪。").level)
      .toBe("error");
  });

  it("normalizes explicit archive transcript idioms", () => {
    expect(compareNumericIntegrity("It costs a buck 05.", "它的价格是1.05美元。").level).toBe("ok");
    expect(compareNumericIntegrity("A 100th of the price.", "价格的1%。").level).toBe("ok");
    expect(compareNumericIntegrity("Literally zero.", "确切地说是0。").level).toBe("ok");
    expect(compareNumericIntegrity("It is almost nothing.", "它几乎为零。").level).toBe("warning");
    expect(compareNumericIntegrity("It is almost nothing.", "它几乎什么都没有。").level).toBe("ok");
    expect(compareNumericIntegrity("A non-zero chance.", "一个非零概率。").level).toBe("warning");
    expect(compareNumericIntegrity("The components are ready.", "零部件已经就绪。").level).toBe("ok");
    expect(
      compareNumericIntegrity(
        "Episode four improves by the fourth or fifth episode in season one, then season two.",
        "第四集开始改善，到第一季第四或第五集已很出色，第二季更好。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "This iterative process, this HydraNet, this flywheel, and this handy fusion reactor.",
        "一个迭代过程、一个 HydraNet、一个飞轮和一个现成的聚变反应堆。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("The final question.", "最后一个问题。").level).toBe("warning");
    expect(
      compareNumericIntegrity(
        "The next question concerns the most recent round of cuts.",
        "下一个问题与最近一轮降价有关。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("We are doubling down.", "我们会进一步投入。").level).toBe("ok");
    expect(
      compareNumericIntegrity(
        "Three main points include one-time items.",
        "三个要点包括一次性项目。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "For profitability first, review the second and third tranche.",
        "盈利能力列第1，并检查第二和第三批。",
      ).level,
    ).toBe("ok");
  });

  it("distinguishes numeric ranges from negative values", () => {
    const range = {
      id: "segment:range",
      kind: "segment" as const,
      textEn: "The estimate is 10-15%, or 500-1,000 units.",
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(() =>
      assertTranslationOutput([range], {
        translations: [
          { id: range.id, textZh: "估计为10%至15%，即500至1,000个单位。", speakerZh: "" },
        ],
      }),
    ).not.toThrow();

    const negative = { ...range, textEn: "The result was -5%." };
    expect(() =>
      assertTranslationOutput([negative], {
        translations: [{ id: negative.id, textZh: "结果为5%。", speakerZh: "" }],
      }),
    ).toThrow("changed numbers");

    const asrCurrencyRange = {
      ...range,
      id: "segment:asr-currency-range",
      textEn: "It costs somewhere in the 15 to$20,000 region over seven years.",
    };
    expect(() =>
      assertTranslationOutput([asrCurrencyRange], {
        translations: [
          {
            id: asrCurrencyRange.id,
            textZh: "七年内的成本约为1.5万至2万美元。",
            speakerZh: "",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("does not treat product-model hyphens as negative signs", () => {
    expect(
      compareNumericIntegrity(
        "I saw a Commodore Vic 20 when I was nine.",
        "我九岁时看到了一台 Commodore VIC-20。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("It uses helium-3.", "它使用氦-3。").level).toBe("ok");
    expect(compareNumericIntegrity("The result was 20.", "结果是-20。").level).toBe(
      "error",
    );
    expect(
      compareNumericIntegrity(
        "The answer, which is-- -42.",
        "那个答案就是42。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("The temperature was -42.", "温度是42。").level).toBe(
      "error",
    );
  });

  it("normalizes Roman numerals only in World War labels", () => {
    expect(
      compareNumericIntegrity(
        "World War I led toward World War II.",
        "第一次世界大战走向了第二次世界大战。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "World Wars I and II led to huge resets.",
        "一战和二战带来了大规模重置。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("I led the team.", "我带领了第1支团队。").level).toBe(
      "error",
    );
  });

  it("preserves Asimov's zeroth law as zero rather than first", () => {
    expect(compareNumericIntegrity("The zeroth law, the zeroth law.", "第零定律，第零定律。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("The zeroth law.", "第一定律。").level).toBe("error");
  });

  it("keeps identifier digits separate from adjacent Chinese magnitudes", () => {
    expect(
      compareNumericIntegrity(
        "We can reverse the CO2 parts per million.",
        "我们可以逆转 CO2百万分率。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("We remove CO2.", "我们去除二氧化碳。").level).toBe(
      "ok",
    );
    expect(
      compareNumericIntegrity(
        "The atmosphere contains carbon dioxide.",
        "大气中含有二氧化碳。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "Carbon dioxide and carbon dioxide remain.",
        "二氧化碳和二氧化碳仍然存在。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("The gas is CO2.", "这种气体是 CO3。").level).toBe(
      "error",
    );
  });

  it("treats metric prefixes and ASR-split decimals as reviewable rather than fatal", () => {
    const examples = [
      ["They have four Tesla 100 kilowatt hour batteries.", "他们有4块Tesla 100千瓦时电池。"],
      ["It goes from 0 to 100 km in 3. 1 seconds.", "它从0加速到100公里每小时需要3.1秒。"],
    ];
    for (const [textEn, textZh] of examples) {
      const unit = {
        id: "segment:asr-number",
        kind: "segment" as const,
        textEn,
        textZh: "",
        speakerEn: "",
        speakerZh: "",
      };
      expect(() =>
        assertTranslationOutput([unit], {
          translations: [{ id: unit.id, textZh, speakerZh: "" }],
        }),
      ).not.toThrow();
    }
  });

  it("allows numeric idioms to be resolved by independent review", () => {
    const unit = {
      id: "segment:idiom",
      kind: "segment" as const,
      textEn: "At the 11th hour, investors gave him a second chance.",
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [{ id: unit.id, textZh: "在最后关头，投资者又给了他1次机会。", speakerZh: "" }],
      }),
    ).not.toThrow();

    const centsOnDollar = {
      ...unit,
      id: "segment:cents-on-dollar",
      textEn: "We sell at 65 cents on the dollar, while they get 100 cents on the dollar.",
    };
    expect(() =>
      assertTranslationOutput([centsOnDollar], {
        translations: [
          {
            id: centsOnDollar.id,
            textZh: "我们每1美元只卖65美分，而他们每1美元能拿回1美元。",
            speakerZh: "",
          },
        ],
      }),
    ).not.toThrow();
    expect(
      compareNumericIntegrity("The price is 100 dollars.", "价格是1美元。").level,
    ).toBe("error");
  });

  it("uses the same quarter semantics in final validation", () => {
    const entry = multiChunkEntry();
    entry.titleEn = "Tesla Q1 2026 earnings call";
    entry.titleZh = "特斯拉 2026 年第一季度财报电话会议";
    entry.summaryZh = "简短摘要";
    entry.segments[0].textZh = "你好，42。";
    entry.segments[0].speakerZh = "埃隆·马斯克";
    entry.segments[1].textZh = "为什么？";
    entry.segments[1].speakerZh = "采访者";
    entry.translation = {
      status: "reviewed",
      model: "gpt-5.6-sol",
      reviewedAt: "2026-09-12T00:00:00.000Z",
    };
    const issues = validateVideoEntries([entry], { expectedCount: 1, env: {} });
    expect(issues.filter(({ field }) => field === "titleZh")).toEqual([]);
  });

  it("normalizes written quarters and common English magnitudes", () => {
    const units = [
      ["We had an exceptional second quarter.", "我们的第二季度表现出色。"],
      ["Margins improved in the first two quarters.", "利润率在前两个季度有所改善。"],
      ["Third-quarter 2023 results.", "2023年第三季度业绩。"],
      ["We expect it by quarter one of 2023.", "我们预计在2023年第一季度前完成。"],
      ["This is our third quarter in the plan.", "这是计划中的第三个季度。"],
      ["Our fourth consecutive profitable quarter.", "连续第4个季度实现盈利。"],
      ["It happened in the same quarter.", "它发生在同一个季度。"],
      ["Support over the last quarter.", "过去一个季度的支持。"],
      ["One billion users and half a million cars.", "10亿用户和50万辆汽车。"],
    ].map(([textEn], index) => ({
      id: `segment:words-${index}`,
      kind: "segment" as const,
      textEn,
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    }));
    expect(() =>
      assertTranslationOutput(units, {
        translations: units.map((unit, index) => ({
          id: unit.id,
          textZh: [
            "我们的第二季度表现出色。",
            "利润率在前两个季度有所改善。",
            "2023年第三季度业绩。",
            "我们预计在2023年第一季度前完成。",
            "这是计划中的第三个季度。",
            "连续第4个季度实现盈利。",
            "它发生在同一个季度。",
            "过去一个季度的支持。",
            "10亿用户和50万辆汽车。",
          ][index],
          speakerZh: "",
        })),
      }),
    ).not.toThrow();
  });

  it("treats a sequential-quarter ordinal as a count", () => {
    expect(
      compareNumericIntegrity(
        "This marks the fifth sequential quarter of improvement.",
        "这是连续第5个季度实现改善。",
      ).level,
    ).toBe("ok");
  });

  it("normalizes a localized perfect-score expression", () => {
    expect(
      compareNumericIntegrity(
        "They called it an amazing 10 out of 10 experience.",
        "他们称这是一次令人惊叹的满分 10 分体验。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "They called it an amazing 10 out of 10 experience.",
        "他们称这是一次令人惊叹的 10 分满分体验。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "They called it an amazing 9 out of 10 experience.",
        "他们称这是一次令人惊叹的满分 10 分体验。",
      ).level,
    ).toBe("error");
    expect(compareNumericIntegrity("I give this an 8 out of 10.", "我给这个打8分，满分10分。").level)
      .toBe("ok");
  });

  it("normalizes standalone tens as an approximate count", () => {
    expect(
      compareNumericIntegrity(
        "Wait until we have tens to divide up.",
        "等到有几十个可供分配。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "Wait until we have tens to divide up.",
        "等到有20个可供分配。",
      ).level,
    ).toBe("error");
  });

  it("normalizes tens of a magnitude into a Chinese vague magnitude", () => {
    expect(
      compareNumericIntegrity(
        "Tens of thousands of employees helped.",
        "数万名员工提供了帮助。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "There were tens of thousands of people.",
        "那里有成千上万的人。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "There were tens of thousands of people.",
        "那里有成百上千的人。",
      ).level,
    ).toBe("error");
    expect(
      compareNumericIntegrity(
        "There are tens of thousands of tiles.",
        "有数万块隔热瓦。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "There are tens of billions of robots.",
        "有“数百亿”个人形机器人。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "There are tens of thousands of organizations.",
        "有数以万计的组织。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "You pass through tens of different regulations.",
        "你要经过数十套不同的法规。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "Tens of thousands of employees helped.",
        "数千名员工提供了帮助。",
      ).level,
    ).toBe("error");
  });

  it("routes an indefinite many-billions range to review", () => {
    expect(
      compareNumericIntegrity(
        "You need not spend 10 or many billions of dollars.",
        "你不必花费 100 亿美元或数百亿美元。",
      ).level,
    ).toBe("warning");
  });

  it("normalizes localized product generations", () => {
    expect(
      compareNumericIntegrity("Gen 2 satellites", "第二代卫星").level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity("Gen 2 satellites", "第一代卫星").level,
    ).toBe("error");
  });

  it("carries an explicit magnitude into a later confidence shorthand", () => {
    expect(
      compareNumericIntegrity(
        "We have a shot at 2 million vehicles, and we feel comfortable with 1.8.",
        "我们有机会达到 200 万辆，并且对 180 万辆有把握。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "We have a shot at 2 million vehicles, and we feel comfortable with 1.8.",
        "我们有机会达到 200 万辆，并且对 190 万辆有把握。",
      ).level,
    ).toBe("error");
  });

  it("allows either way to be localized as two alternatives", () => {
    expect(
      compareNumericIntegrity(
        "You can do it either way.",
        "两种方式都可以。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "You can do it either way.",
        "三种方式都可以。",
      ).level,
    ).toBe("error");
  });

  it("does not read triple-digit percentage wording as hundreds", () => {
    expect(
      compareNumericIntegrity(
        "There were triple digit increases.",
        "出现了 3 位数百分比的增长。",
      ).level,
    ).toBe("ok");
  });

  it("allows that brings up to make one question explicit", () => {
    expect(
      compareNumericIntegrity(
        "That brings up: how much of that is normal? Falcon 9 was different.",
        "这引出了一个问题：其中有多少是正常的？Falcon 9 当时有所不同。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "That brings up: how much of that is normal? Falcon 9 was different.",
        "这引出了两个问题：其中有多少是正常的？Falcon 9 当时有所不同。",
      ).level,
    ).toBe("error");
  });

  it("allows human hands to be localized as a pair", () => {
    expect(
      compareNumericIntegrity(
        "It was made by pure human hands.",
        "它完全由人类双手打造。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "It was made by pure human hands.",
        "它完全由人类 3 只手打造。",
      ).level,
    ).toBe("error");
  });

  it("does not hard-fail ambiguous shared scales and complex number words", () => {
    const examples = [
      ["The labs cost $50-200 billion.", "这些实验室耗资500亿至2000亿美元。"],
      ["The range is $30-$35,000.", "范围是3万至3.5万美元。"],
      ["Maybe 20-30,000 robots.", "可能是2万至3万台机器人。"],
      ["Maybe 30 or 40,000 miles per hour.", "每小时30或40,000英里。"],
      ["Maybe 10,000 or 20,000 votes.", "可能有10,000或20,000票。"],
      ["It costs 55 or $6,000.", "它花费55或6,000美元。"],
      ["Maybe 20 or 25 million users.", "可能是2000万或2500万用户。"],
      ["It could be 3 or 400 million.", "可能是3亿或4亿。"],
      ["It may be 30, 40 million.", "可能是3000万或4000万。"],
      ["It may be 20 billion, 30, 40 billion.", "可能是200亿、300亿或400亿。"],
      ["It may be 35 40 thousand.", "可能是3.5万至4万。"],
      ["It may be 10 20 million.", "可能是1000万、2000万。"],
      ["It may be 6 to 800 kilometers up.", "它可能位于600至800公里高空。"],
      ["Raise 100 million to raise 40.", "融资1亿美元，再融资4000万美元。"],
      ["It could reach a hundred billion.", "它可能达到1000亿。"],
      ["We served sixty million in 2023.", "2023年我们服务了6000万人。"],
      ["It reached twenty six million in 2023.", "2023年达到2600万。"],
      ["It is one and a half billion.", "它是15亿。"],
      ["It is two and a half times bigger.", "它大2.5倍。"],
      ["Two thousand hospitals.", "两千家医院。"],
      ["A thousand-fold difference and half a million dollars.", "相差一千倍，价值50万美元。"],
      ["It started in the 1900s.", "它始于20世纪。"],
      ["That changed in the early 2000s.", "这在21世纪初发生了变化。"],
      ["Tesla private at 4 20.", "Tesla以420美元私有化。"],
      ["It was 20 you know 2001.", "那是2001年。"],
      ["The billiondoll energy business.", "价值10亿美元的能源产业。"],
      ["The wait is over a year.", "等待时间超过1年。"],
      ["It improved by an order of magnitude over 40 days.", "它在40天内提升了1个数量级。"],
      ["It passed 25 million. It may reach 60 or 70.", "它超过了2500万，可能达到6000万或7000万。"],
    ];
    for (const [textEn, textZh] of examples) {
      const unit = {
        id: "segment:ambiguous",
        kind: "segment" as const,
        textEn,
        textZh: "",
        speakerEn: "",
        speakerZh: "",
      };
      expect(() =>
        assertTranslationOutput([unit], {
          translations: [{ id: unit.id, textZh, speakerZh: "" }],
        }),
      ).not.toThrow();
    }
  });

  it("routes a repeated broken ASR magnitude to review without relaxing clear numbers", () => {
    const source =
      "the system is approaching $10 billion and the interviewer says hey 10 mil million";
    const translation = "该系统正接近100亿美元，采访者说，嘿，是1000万美元。";
    const comparison = compareNumericIntegrity(source, translation);

    expect(comparison).toEqual({
      level: "warning",
      sourceValues: ["number:10", "number:10000000000"],
      translationValues: ["number:10000000", "number:10000000000"],
    });

    const unit = {
      id: "segment:broken-asr-magnitude",
      kind: "segment" as const,
      textEn: source,
      textZh: "",
      speakerEn: "",
      speakerZh: "",
    };
    expect(() =>
      assertTranslationOutput([unit], {
        translations: [{ id: unit.id, textZh: translation, speakerZh: "" }],
      }),
    ).not.toThrow();

    expect(
      compareNumericIntegrity(
        "The company is approaching $10 billion.",
        "公司估值正接近1000万美元。",
      ).level,
    ).toBe("error");
    expect(
      compareNumericIntegrity(
        "The service has 10 million users and 5 offices.",
        "该服务有1000万用户。",
      ).level,
    ).toBe("error");
  });

  it("normalizes shared comma-thousands and an ASR-stuttered swing-state count", () => {
    const source = "There are only like six six or seven swing States, often with 10 or 20,000 votes and triple-digit increases.";
    expect(
      compareNumericIntegrity(
        source,
        "只有6到7个摇摆州，差距通常为1万或2万票，增幅达到三位数。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        source,
        "只有6、6或7个摇摆州，差距通常为1万或2万票，增幅达到三位数。",
      ).level,
    ).toBe("error");
  });

  it("routes an ASR decimal connector with a missing space to review", () => {
    expect(
      compareNumericIntegrity(
        "Earth is about 4 and2 billion years old.",
        "地球大约有42亿年历史。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "Earth is about 4.2 billion years old.",
        "地球大约有42亿年历史。",
      ).level,
    ).toBe("ok");
  });

  it("separates an ASR article stuck to a scaled number", () => {
    expect(
      compareNumericIntegrity(
        "try to make a100 billion and get $100 billion for compute",
        "尝试赚到1000亿美元，并为算力获得1000亿美元",
      ),
    ).toEqual({
      level: "ok",
      sourceValues: ["number:100000000000", "number:100000000000"],
      translationValues: ["number:100000000000", "number:100000000000"],
    });
  });

  it("normalizes tera operations when Chinese states the expanded quantity", () => {
    expect(
      compareNumericIntegrity(
        "It has eight cameras, 12 sonars, and over 10 tera ops of compute.",
        "它有8个摄像头、12个声呐，以及超过10万亿次运算的算力。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "It has 12 sonars and over 10 tera ops of compute.",
        "它有12个声呐，以及超过10万亿次运算的算力。",
      ).level,
    ).toBe("ok");
  });

  it("normalizes a repeated magnitude omitted by ASR", () => {
    const source = "Like 22 million 24 I mean I do not see the fabs, so we have two we have two issues.";
    expect(
      compareNumericIntegrity(
        source,
        "大约 2200 万、2400 万，所以我们有 2 个，我们有 2 个问题。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(source, "大约 2400 万，所以我们有 2 个问题。 ").level,
    ).toBe("error");
  });

  it("allows a contextual probably-N shorthand to carry a matching magnitude", () => {
    expect(compareNumericIntegrity("Probably 20 or more.", "可能是 200 亿个或更多。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("Probably 20 or more.", "可能是 300 亿个或更多。").level)
      .toBe("error");
  });

  it("normalizes a compact ASR clock time only in a narrow time phrase", () => {
    expect(
      compareNumericIntegrity(
        "Yeah, maybe it was 422 or something.",
        "是啊，也许是 4:22 左右。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("We built 422 units.", "我们制造了 4:22 个单元。").level)
      .toBe("error");
  });

  it("normalizes a spoken single-digit decimal", () => {
    expect(compareNumericIntegrity("The value is seven point four.", "这个值是 7.4。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("The value is seven point four.", "这个值是 7。").level)
      .toBe("error");
  });

  it("normalizes narrowly scoped ASR decimals in the donut passage", () => {
    const source =
      "I was trying to have point4 of a donut, which rounds down to zero. Anything below 044 of a donut rounds down to zero.";
    expect(
      compareNumericIntegrity(
        source,
        "我当时尽量只吃 0.4 个甜甜圈，向下取整就是 0。任何低于 0.44 个甜甜圈的量，向下取整都是 0。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("Flight 044 landed.", "航班 0.44 已着陆。").level)
      .toBe("error");
  });

  it("normalizes two-factor authentication and keeps vague millions reviewable", () => {
    const source = "They ran two factor authentication and earned millions of dollars.";
    expect(compareNumericIntegrity(source, "他们运行双因素认证并赚取数百万美元。").level)
      .toBe("warning");
    expect(compareNumericIntegrity(source, "他们运行认证并赚取数百万美元。").level)
      .toBe("error");
  });

  it("normalizes bidirectionally as two directions", () => {
    expect(
      compareNumericIntegrity(
        "Bidirectionally, xAI can help Tesla and vice versa.",
        "从双向关系看，xAI 可以帮助 Tesla，反之亦然。",
      ).level,
    ).toBe("ok");
  });

  it("does not parse the Chinese word for millennials as one thousand", () => {
    expect(compareNumericIntegrity("Most millennials live in apartments.", "大多数千禧一代住在公寓。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("Most millennials live in apartments.", "有 1000 人住在公寓。").level)
      .toBe("error");
  });

  it("does not parse the Chinese term for QR code as the number two", () => {
    expect(compareNumericIntegrity("The QR code cannot be read.", "二维码无法读取。").level)
      .toBe("ok");
    expect(compareNumericIntegrity("There are two QR codes.", "这里有两个二维码。").level)
      .toBe("warning");
  });

  it("normalizes spelled product model numbers", () => {
    expect(compareNumericIntegrity("A private person could buy 10 Model Threes.", "一个私人可以买 10 辆 Model 3。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("A private person could buy 10 Model Threes.", "一个私人可以买 10 辆 Model 2。").level)
      .toBe("error");
  });

  it("normalizes megapixels into an expanded pixel count", () => {
    expect(
      compareNumericIntegrity(
        "A megapixel sensor or a 10 megapixel camera.",
        "一个 100 万像素传感器或一台 1000 万像素相机。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "A 100 megapixel camera.",
        "一台 1 亿像素的相机。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "A 100 megapixel camera.",
        "一台 100 万像素的相机。",
      ).level,
    ).toBe("error");
    expect(
      compareNumericIntegrity(
        "Maybe 10 to 1, 100 to 1 potentially. So a megapixel type basically.",
        "或许 10 比 1，甚至可能 100 比 1，也就是基本达到百万像素级别。",
      ).level,
    ).toBe("ok");
  });

  it("allows a shared measurement to be repeated across unit alternatives", () => {
    expect(
      compareNumericIntegrity(
        "It was 69,420 days old or minutes old.",
        "它已经存在 69,420 天，或者 69,420 分钟。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "It was 69,420 days old or minutes old.",
        "它已经存在 69,420 天，或者 69,421 分钟。",
      ).level,
    ).toBe("error");
  });

  it("normalizes explicit kilobit quantities without relaxing bare numbers", () => {
    expect(compareNumericIntegrity("A 2 kilobit link.", "一条2000比特的链路。").level).toBe(
      "ok",
    );
    expect(compareNumericIntegrity("The value is 2.", "这个值是2000。").level).toBe("error");
  });

  it("routes malformed mixed half-hour expressions to review", () => {
    expect(
      compareNumericIntegrity(
        "The rotational period is 24 and 1 half hours.",
        "自转周期是24.5小时。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("The period is 24 hours.", "周期是24.5小时。").level).toBe(
      "error",
    );
    expect(
      compareNumericIntegrity(
        "We will have 9 a half million cars.",
        "我们将拥有950万辆汽车。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("We will have 9 cars.", "我们将拥有950万辆汽车。").level).toBe(
      "error",
    );
  });

  it("routes digit-style translations of indefinite articles to review", () => {
    expect(
      compareNumericIntegrity(
        "I have a naive question for a well-meaning group.",
        "我有1个天真的问题，要问1个善意的团体。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "I have a question and 10 robots.",
        "我有1个问题和11个机器人。",
      ).level,
    ).toBe("error");
    expect(
      compareNumericIntegrity(
        "Now, something I have never asked you.",
        "现在，有1件我从未问过你的事。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("We check each cell.", "我们检查每1颗电芯。").level).toBe(
      "warning",
    );
    expect(compareNumericIntegrity("Work for another year.", "再工作1年。").level).toBe(
      "warning",
    );
    expect(compareNumericIntegrity("Use the next version.", "使用下1个版本。").level).toBe(
      "warning",
    );
    expect(compareNumericIntegrity("Ask the last question.", "问最后1个问题。").level).toBe(
      "warning",
    );
    expect(compareNumericIntegrity("They are the same size.", "它们是1样的大小。").level).toBe(
      "warning",
    );
    expect(compareNumericIntegrity("Try it again.", "再试1次。").level).toBe("warning");
    expect(compareNumericIntegrity("I have not seen any.", "我1个也没见过。").level).toBe(
      "warning",
    );
    expect(compareNumericIntegrity("This time it worked.", "这一次成功了。").level).toBe(
      "warning",
    );
    expect(compareNumericIntegrity("Fix the latter problem.", "解决后一个问题。").level).toBe(
      "warning",
    );
    expect(
      compareNumericIntegrity(
        "This much vaster space could be wonderful.",
        "一个广阔得多的空间中有一些可能很美妙。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("There is the fact.", "还有一个事实。").level).toBe(
      "warning",
    );
    expect(compareNumericIntegrity("It fits everywhere.", "它适合每一个地方。").level).toBe(
      "warning",
    );
    expect(compareNumericIntegrity("He had this idea.", "他有一个想法。").level).toBe(
      "warning",
    );
    expect(
      compareNumericIntegrity(
        "View it as like, extremely fundamental crisis around 1971.",
        "把它视为1971年前后的一个极其根本的危机。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("You will have your buddy robot.", "你会有一个伙伴机器人。").level)
      .toBe("warning");
    expect(
      compareNumericIntegrity(
        "The big innovation is the thing about rockets.",
        "一个重大创新在于火箭有一个特点。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "I guess due diligence question matters.",
        "我想这是一个尽职调查问题。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("It was unipolar world.", "这是一个单极世界。").level)
      .toBe("warning");
    expect(
      compareNumericIntegrity(
        "There is the question of whether the debt portion of the round will close.",
        "还有一个问题：这一轮融资的债务部分能否落实。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("The terawatt is small.", "1太瓦很小。").level).toBe(
      "warning",
    );
    expect(
      compareNumericIntegrity(
        "It is like mythical place in the cloud.",
        "它就像云中的1个神话之地。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("It is mythical place.", "它是1个神话之地。").level).toBe(
      "error",
    );
    expect(
      compareNumericIntegrity(
        "A friend of mine uses that sort of explanation.",
        "我的一个朋友会使用那一种解释。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "I saw Level 100 Druid run back the other way.",
        "我看到一个100级德鲁伊朝另一个方向跑回来。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "None of the reasons were on the risk list.",
        "风险清单上没有一个相关原因。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "This solution works wherever you are.",
        "有一个无论在哪里都能使用的解决方案。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "Limit lobbying in D.C. or at the state level.",
        "限制在华盛顿特区或州一级的游说。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("Check the cell.", "检查1颗电芯。").level).toBe("error");
    expect(compareNumericIntegrity("The factory is small.", "这1座工厂很小。").level).toBe("error");
  });

  it("allows narrow English phrases that conventionally translate with an implicit two", () => {
    expect(
      compareNumericIntegrity(
        "The terms channels and electrodes are interchangeable.",
        "通道和电极这两个词可以互换使用。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("They are complementary.", "这两者相辅相成。").level)
      .toBe("warning");
    expect(compareNumericIntegrity("Those capabilities go hand in hand.", "这两者相辅相成。").level)
      .toBe("warning");
    expect(
      compareNumericIntegrity(
        "You can fit a queen size bed behind the 10 seats.",
        "在10个座位后面可以放下一张双人床。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "Keep your hands on the wheel.",
        "把双手放在方向盘上。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "Restore people's ability to walk and use their hands.",
        "恢复人们行走和使用双手的能力。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("There is a bed.", "那里有一张双人床。").level).toBe(
      "error",
    );
    expect(
      compareNumericIntegrity(
        "Margins improved, driven by our used vehicle business.",
        "利润率有所改善，主要由我们的二手车业务推动。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "We will give more prominence to used Teslas.",
        "我们会更加突出二手 Tesla。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("The doors are double hinged.", "车门采用双铰链设计。").level).toBe(
      "ok",
    );
    expect(
      compareNumericIntegrity(
        "A hand is like a puppet, and the hands are versatile.",
        "手像一个木偶，而双手用途广泛。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "The other application would enable someone faster than someone who has working hands.",
        "另一个应用会让一个人比双手正常的人操作得更快。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("The link is bi directional.", "这条链路是双向的。").level)
      .toBe("ok");
  });

  it("does not treat the 一边…一边… construction as numeric", () => {
    expect(
      compareNumericIntegrity(
        "They care about looking good while doing evil.",
        "他们一边在意显得善良，一边作恶。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("Nevada understands the house.", "内华达州懂这一套。").level)
      .toBe("ok");
    expect(
      compareNumericIntegrity(
        "What does it look like when it starts this side of the assembly line?",
        "它从装配线这一侧开始时是什么样的？",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "I said more than what you just read; the other was absent.",
        "我说的比你刚才读到的更多；另一个缺失了。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "What side are you on? You sound like you are on the computer side. It would be an nonprofit.",
        "你站在哪一边？听起来你站在计算机那一边。那会是一个非营利组织。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "The homunculus is where you have humongous hands.",
        "这个小人模型的双手巨大无比。",
      ).level,
    ).toBe("warning");
  });

  it("normalizes a two-value comma-thousands range", () => {
    expect(
      compareNumericIntegrity(
        "The 15, 000 people and those 15,000 people.",
        "这 15,000 人和那 15,000 人。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("The 15, 000 people and those 15,000 people.", "这 15,000 人。").level)
      .toBe("error");
    expect(
      compareNumericIntegrity(
        "Roughly 35, 40,000 people are killed after 80 million miles.",
        "大约 3.5 万到 4 万人死亡，里程为 8000 万英里。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "Roughly 35, 40,000 people are killed.",
        "大约 35 到 4 万人死亡。",
      ).level,
    ).toBe("error");
  });

  it("does not count the repeated Chinese once-again idiom", () => {
    expect(
      compareNumericIntegrity(
        "And that's proven I think over and over in his case to be a very powerful approach.",
        "而且我认为，在他的案例中，这种方法已经一次又一次地被证明非常有效。",
      ).level,
    ).toBe("ok");
  });

  it("normalizes ordinal layer terminology", () => {
    expect(
      compareNumericIntegrity(
        "There is a tertiary layer and a tertiary level.",
        "这里有一个第三层和一个第三级。",
      ).level,
    ).toBe("warning");
    expect(
      compareNumericIntegrity(
        "A Homestead High School junior has a question.",
        "一名霍姆斯特德高中11年级学生有一个问题。",
      ).level,
    ).toBe("warning");
    expect(compareNumericIntegrity("The 3D architecture.", "三维架构。").level).toBe("ok");
    expect(
      compareNumericIntegrity(
        "It is about the size of a quarter.",
        "它大约有一个25美分硬币那么大。",
      ).level,
    ).toBe("warning");
  });

  it("normalizes repeated tertiary system and compute-layer terminology", () => {
    expect(
      compareNumericIntegrity(
        "The tertiary system, tertiary layer, and tertiary compute layer are connected.",
        "第三层系统、第三层和第三层计算层彼此相连。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "The tertiary system, tertiary layer, and tertiary compute layer are connected.",
        "第三层系统和第三层彼此相连。",
      ).level,
    ).toBe("error");
  });

  it("normalizes explicit abbreviated and Chinese magnitude units", () => {
    const examples = [
      ["The value is $20B.", "价值为200亿美元。"],
      ["The budget is $6K.", "预算为6千美元。"],
      ["It may reach $1 trillion.", "可能达到1万亿美元。"],
      ["There is this 4 something trillion dollar total.", "总额大约是4万亿美元。"],
      ["Margins were 15% in 3Q.", "第三季度利润率为15%。"],
      ["The fund manages $1.6tn.", "该基金管理1.6万亿美元。"],
      ["There are 50k cars and 20k trucks.", "有5万辆汽车和2万辆卡车。"],
      ["It costs 20 grand.", "它的价格是2万美元。"],
      ["It costs 70 something million.", "它花费7000多万。"],
      ["You need not spend 10 or many billions of dollars.", "你不必预先花费100亿美元。"],
      ["It has th000 electrodes.", "它有1000个电极。"],
    ];
    for (const [textEn, textZh] of examples) {
      const unit = {
        id: "segment:scale",
        kind: "segment" as const,
        textEn,
        textZh: "",
        speakerEn: "",
        speakerZh: "",
      };
      expect(() =>
        assertTranslationOutput([unit], {
          translations: [{ id: unit.id, textZh, speakerZh: "" }],
        }),
      ).not.toThrow();
    }
  });

  it("distinguishes a 10-K filing from a ten-thousand quantity", () => {
    expect(
      compareNumericIntegrity(
        "We will have additional detail in the 10k, um.",
        "更多细节会写在 10-K 文件里。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "We will have additional detail in the 10k, um.",
        "我们会在 10k 中提供更多细节。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "We will have additional detail in the 10k, um.",
        "更多细节会写在 8-K 文件里。",
      ).level,
    ).toBe("error");
  });

  it("leaves ambiguous letter suffixes for review", () => {
    expect(compareNumericIntegrity("A 400B powerlifter.", "一名400磅的力量举选手。").level).toBe("warning");
    expect(compareNumericIntegrity("A 40 K Kow hour pack.", "一块40千瓦时电池包。").level).toBe("warning");
    expect(compareNumericIntegrity("It moves at 60 M hour.", "它以60英里时速行驶。").level).toBe("ok");
    expect(compareNumericIntegrity("It serves 30 m users.", "它服务3000万用户。").level).toBe("warning");
    expect(compareNumericIntegrity("Savings in a 401k plan.", "401(k)计划中的储蓄。").level).toBe("warning");
  });

  it("uses deterministic internal parts for an oversized paragraph", () => {
    const entry = fixtureEntry();
    entry.segments = [
      {
        id: "long",
        speakerEn: "Elon Musk",
        textEn: Array.from({ length: 300 }, () => "A long sentence.").join(" "),
        textZh: "",
      },
    ];
    const base = getTranslationUnits(entry).filter(({ kind }) => kind === "segment");
    const parts = expandOversizedUnits(base, 1_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].id).toBe("segment:long::part:0001");
    expect(parts.every(({ textEn }) => textEn.length <= 700)).toBe(true);
    parts.forEach((part, index) => {
      part.textZh = `第${index + 1}段。`;
      if (part.speakerEn) part.speakerZh = "埃隆·马斯克";
    });
    applyCompletedParts(entry, base, parts);
    expect(entry.segments[0].textZh).toBe(
      parts.map((_part, index) => `第${index + 1}段。`).join(""),
    );
    expect(entry.segments[0].speakerZh).toBe("埃隆·马斯克");
  });

  it("translates, reviews, and resumes only a changed segment", async () => {
    const workspace = await fixtureWorkspace();
    let files = await loadVideoFiles(workspace.dataDir);
    const initialCalls: string[][] = [];
    await translateVideoFiles(files, workspace.options, async (_entry, units) => {
      initialCalls.push(units.map(({ id }) => id));
      return {
        translations: units.map(({ id }) => ({ id, ...chineseFor(id) })),
      };
    });
    expect(initialCalls.flat()).toHaveLength(4);

    files = await loadVideoFiles(workspace.dataDir);
    await reviewVideoFiles(files, workspace.options, async () => ({ corrections: [] }));
    let saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.translation.status).toBe("reviewed");
    expect(
      validateVideoEntries([saved], { expectedCount: 1, env: {} }).filter(
        ({ severity }) => severity === "error",
      ),
    ).toEqual([]);

    saved.segments[0].textEn = "Updated hello 42.";
    saved.segments[0].textZh = "";
    saved.segments[0].speakerZh = undefined;
    saved.translation.status = "pending";
    saved.sourceHash = "source-v2";
    await writeFile(workspace.filePath, `${JSON.stringify(saved, null, 2)}\n`);

    files = await loadVideoFiles(workspace.dataDir);
    const resumedCalls: string[][] = [];
    await translateVideoFiles(files, workspace.options, async (_entry, units) => {
      resumedCalls.push(units.map(({ id }) => id));
      return {
        translations: units.map(({ id }) => ({
          id,
          textZh: id === "segment:p0001" ? "更新后的问候，42。" : chineseFor(id).textZh,
          speakerZh: chineseFor(id).speakerZh,
        })),
      };
    });
    expect(resumedCalls).toEqual([["segment:p0001"]]);
    saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.segments[0].textZh).toBe("更新后的问候，42。");
    expect(saved.segments[1].textZh).toBe("为什么是现在？");
  });

  it("runs chunks concurrently when the requested concurrency is greater than one", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      workspace.filePath,
      `${JSON.stringify(multiChunkEntry(), null, 2)}\n`,
    );
    let active = 0;
    let maximumActive = 0;

    await translateVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      { ...workspace.options, concurrency: 2, chunkCharacters: 1_000 },
      async (_entry, units) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          translations: units.map(({ id }) => ({ id, ...chineseFor(id) })),
        };
      },
    );

    let saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(maximumActive).toBe(2);
    expect(saved.translation.status).toBe("translated");
  });

  it("skips metadata-only source changes without hiding translation source changes", async () => {
    const workspace = await fixtureWorkspace();
    await translateVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async (_entry, units) => ({
        translations: units.map(({ id }) => ({ id, ...chineseFor(id) })),
      }),
    );
    await reviewVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async () => ({ corrections: [] }),
    );

    let saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    saved.thumbnailUrl = "https://example.com/new-thumbnail.jpg";
    saved.sourceHash = computeSourceHash(saved);
    await writeFile(workspace.filePath, `${JSON.stringify(saved, null, 2)}\n`);

    const metadataOnly = await translateVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async () => {
        throw new Error("metadata-only changes must not invoke translation");
      },
    );
    expect(metadataOnly).toMatchObject({ translated: 0, skipped: 1, failed: 0 });
    saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.translation.status).toBe("reviewed");
    const checkpointPath = join(workspace.root, "checkpoints", "video-1.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
      sourceHash: string;
    };
    expect(checkpoint.sourceHash).toBe(saved.sourceHash);

    saved.titleEn = "An updated conversation";
    saved.summaryEn = "An updated summary.";
    saved.segments[0].speakerEn = "Host";
    saved.segments[1].textEn = "Why tomorrow?";
    saved.sourceHash = computeSourceHash(saved);
    await writeFile(workspace.filePath, `${JSON.stringify(saved, null, 2)}\n`);

    const resumedCalls: string[][] = [];
    await translateVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async (_entry, units) => {
        resumedCalls.push(units.map(({ id }) => id));
        return {
          translations: units.map(({ id }) => {
            if (id === "meta:title") return { id, textZh: "更新后的对话", speakerZh: "" };
            if (id === "meta:summary") return { id, textZh: "更新后的摘要。", speakerZh: "" };
            if (id === "segment:p0001") return { id, textZh: "你好，42。", speakerZh: "主持人" };
            if (id === "segment:p0002") return { id, textZh: "为什么是明天？", speakerZh: "采访者" };
            throw new Error(`unexpected fixture id ${id}`);
          }),
        };
      },
    );
    expect(resumedCalls.flat()).toEqual([
      "meta:title",
      "meta:summary",
      "segment:p0001",
      "segment:p0002",
    ]);
  });

  it("refreshes queued files before translation and review", async () => {
    const workspace = await fixtureWorkspace();
    const staleTranslationFiles = await loadVideoFiles(workspace.dataDir);
    const completed = fixtureEntry();
    completed.titleZh = "一次有价值的对话";
    completed.summaryZh = "一段简短摘要。";
    completed.segments[0].textZh = "你好，42。";
    completed.segments[0].speakerZh = "埃隆·马斯克";
    completed.segments[1].textZh = "为什么是现在？";
    completed.segments[1].speakerZh = "采访者";
    completed.translation = { status: "reviewed", model: "test" };
    await writeFile(workspace.filePath, `${JSON.stringify(completed, null, 2)}\n`);

    const translated = await translateVideoFiles(
      staleTranslationFiles,
      workspace.options,
      async () => {
        throw new Error("completed entry should not be translated again");
      },
    );
    expect(translated.skipped).toBe(1);

    completed.translation.status = "translated";
    await writeFile(workspace.filePath, `${JSON.stringify(completed, null, 2)}\n`);
    const staleReviewFiles = await loadVideoFiles(workspace.dataDir);
    const latest = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    latest.translation.status = "reviewed";
    await writeFile(workspace.filePath, `${JSON.stringify(latest, null, 2)}\n`);
    const reviewed = await reviewVideoFiles(
      staleReviewFiles,
      workspace.options,
      async () => {
        throw new Error("reviewed entry should not be reviewed again");
      },
    );
    expect(reviewed.skipped).toBe(1);
  });

  it("serializes translation and review for the same video before refreshing it", async () => {
    const workspace = await fixtureWorkspace();
    const translationFiles = await loadVideoFiles(workspace.dataDir);
    const reviewFiles = await loadVideoFiles(workspace.dataDir);
    let markTranslationStarted!: () => void;
    let releaseTranslation!: () => void;
    const translationStarted = new Promise<void>((resolvePromise) => {
      markTranslationStarted = resolvePromise;
    });
    const translationRelease = new Promise<void>((resolvePromise) => {
      releaseTranslation = resolvePromise;
    });

    const translating = translateVideoFiles(
      translationFiles,
      workspace.options,
      async (_entry, units) => {
        markTranslationStarted();
        await translationRelease;
        return {
          translations: units.map(({ id }) => ({ id, ...chineseFor(id) })),
        };
      },
    );
    await translationStarted;

    let reviewCalls = 0;
    const reviewing = reviewVideoFiles(
      reviewFiles,
      workspace.options,
      async () => {
        reviewCalls += 1;
        return { corrections: [] };
      },
    );
    const earlyReviewState = await Promise.race([
      reviewing.then(
        () => "settled",
        () => "settled",
      ),
      new Promise<"waiting">((resolvePromise) =>
        setTimeout(() => resolvePromise("waiting"), 20),
      ),
    ]);
    releaseTranslation();

    const [translated, reviewed] = await Promise.all([translating, reviewing]);
    expect(earlyReviewState).toBe("waiting");
    expect(translated.translated).toBe(1);
    expect(reviewed.reviewed).toBe(1);
    expect(reviewCalls).toBeGreaterThan(0);
    const saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.translation.status).toBe("reviewed");
  });

  it("resumes only completed units after an interrupted forced translation", async () => {
    const workspace = await fixtureWorkspace();
    const entry = multiChunkEntry();
    entry.titleZh = "旧标题";
    entry.summaryZh = "旧摘要";
    entry.segments[0].textZh = "旧问候，42。";
    entry.segments[0].speakerZh = "旧说话人";
    entry.segments[1].textZh = "旧问题";
    entry.segments[1].speakerZh = "旧采访者";
    entry.translation = { status: "reviewed", model: "old-model" };
    await writeFile(workspace.filePath, `${JSON.stringify(entry, null, 2)}\n`);

    let calls = 0;
    await expect(
      translateVideoFiles(
        await loadVideoFiles(workspace.dataDir),
        { ...workspace.options, force: true, resume: false, chunkCharacters: 1_000 },
        async (_entry, units) => {
          calls += 1;
          if (calls === 2) throw new Error("interrupted");
          return { translations: units.map(({ id }) => ({ id, ...chineseFor(id) })) };
        },
      ),
    ).rejects.toThrow();

    let saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.titleZh).toBe("旧标题");
    expect(saved.summaryZh).toBe("旧摘要");
    expect(saved.segments.map(({ textZh }) => textZh)).toEqual([
      "旧问候，42。",
      "旧问题",
    ]);
    expect(saved.translation.status).toBe("reviewed");

    const resumed: string[] = [];
    await translateVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      { ...workspace.options, force: false, resume: true, chunkCharacters: 1_000 },
      async (_entry, units) => {
        resumed.push(...units.map(({ id }) => id));
        return { translations: units.map(({ id }) => ({ id, ...chineseFor(id) })) };
      },
    );
    expect(resumed).not.toContain("meta:title");
    expect(resumed).toEqual([
      "meta:summary",
      "segment:p0001",
      "segment:p0002",
    ]);
    saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.translation.status).toBe("translated");
  });

  it("resumes only completed units after an interrupted forced review", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      workspace.filePath,
      `${JSON.stringify(multiChunkEntry(), null, 2)}\n`,
    );
    await translateVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async (_entry, units) => ({
        translations: units.map(({ id }) => ({ id, ...chineseFor(id) })),
      }),
    );
    await reviewVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async () => ({ corrections: [] }),
    );

    let calls = 0;
    await expect(
      reviewVideoFiles(
        await loadVideoFiles(workspace.dataDir),
        { ...workspace.options, force: true, resume: false, chunkCharacters: 1_000 },
        async () => {
          calls += 1;
          if (calls === 2) throw new Error("interrupted");
          return { corrections: [] };
        },
      ),
    ).rejects.toThrow();

    const resumed: string[] = [];
    await reviewVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      { ...workspace.options, force: false, resume: true, chunkCharacters: 1_000 },
      async (_entry, units) => {
        resumed.push(...units.map(({ id }) => id));
        return { corrections: [] };
      },
    );
    expect(resumed).not.toContain("meta:title");
    expect(resumed).toEqual([
      "meta:summary",
      "segment:p0001",
      "segment:p0002",
    ]);
    const saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.translation.status).toBe("reviewed");
  });

  it("keeps completed part corrections when a forced long review resumes", async () => {
    const workspace = await fixtureWorkspace();
    const entry = fixtureEntry();
    entry.segments = [{
      id: "long",
      speakerEn: "Elon Musk",
      textEn: Array.from({ length: 300 }, () => "A long sentence.").join(" "),
      textZh: "",
    }];
    entry.sourceHash = computeSourceHash(entry);
    await writeFile(workspace.filePath, `${JSON.stringify(entry, null, 2)}\n`);

    await translateVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async (_entry, units) => ({
        translations: units.map((unit) => ({
          id: unit.id,
          textZh: unit.id.startsWith("segment:long")
            ? "原始分段译文。"
            : chineseFor(unit.id).textZh,
          speakerZh: unit.speakerEn ? "埃隆·马斯克" : "",
        })),
      }),
    );
    await reviewVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async () => ({ corrections: [] }),
    );

    let correctedPartId = "";
    await expect(
      reviewVideoFiles(
        await loadVideoFiles(workspace.dataDir),
        { ...workspace.options, force: true, resume: false, chunkCharacters: 1_000 },
        async (_entry, units) => {
          const part = units.find(({ id }) => id.startsWith("segment:long::part:"));
          if (!part) return { corrections: [] };
          if (correctedPartId) throw new Error("interrupted after a saved correction");
          correctedPartId = part.id;
          return {
            corrections: [{
              id: part.id,
              textZh: "已经复核并修正的分段。",
              speakerZh: "",
              reason: "修正分段译文",
            }],
          };
        },
      ),
    ).rejects.toThrow("1 video review(s) failed");

    let saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.segments[0].textZh).not.toContain("已经复核并修正");

    const resumed: string[] = [];
    await reviewVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      { ...workspace.options, force: false, resume: true, chunkCharacters: 1_000 },
      async (_entry, units) => {
        resumed.push(...units.map(({ id }) => id));
        return { corrections: [] };
      },
    );
    expect(resumed).not.toContain(correctedPartId);
    expect(resumed.some((id) => id.startsWith("segment:long::part:"))).toBe(true);
    saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.segments[0].textZh).toContain("已经复核并修正的分段。");
    expect(saved.translation.status).toBe("reviewed");
  });

  it("reviews a long paragraph using the translation part alignment", async () => {
    const workspace = await fixtureWorkspace();
    const entry = fixtureEntry();
    entry.segments = [
      {
        id: "long",
        speakerEn: "Elon Musk",
        textEn: Array.from({ length: 300 }, () => "A long sentence.").join(" "),
        textZh: "",
      },
    ];
    await writeFile(workspace.filePath, `${JSON.stringify(entry, null, 2)}\n`);
    let files = await loadVideoFiles(workspace.dataDir);
    await translateVideoFiles(
      files,
      { ...workspace.options, chunkCharacters: 500 },
      async (_entry, units) => ({
        translations: units.map((unit) => ({
          id: unit.id,
          textZh:
            unit.id === "meta:title" || unit.id === "meta:summary"
              ? chineseFor(unit.id).textZh
              : "这是分段译文。",
          speakerZh: unit.speakerEn ? "埃隆·马斯克" : "",
        })),
      }),
    );

    files = await loadVideoFiles(workspace.dataDir);
    const reviewedIds: string[] = [];
    await reviewVideoFiles(
      files,
      { ...workspace.options, chunkCharacters: 12_000 },
      async (_entry, units) => {
      reviewedIds.push(...units.map(({ id }) => id));
      expect(Math.max(...units.map(({ textEn }) => textEn.length))).toBeLessThanOrEqual(
        500,
      );
      return { corrections: [] };
      },
    );
    expect(reviewedIds.some((id) => id.startsWith("segment:long::part:"))).toBe(true);
    let saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.translation.status).toBe("reviewed");
    expect(saved.segments[0].textZh).toContain("译文");

    const reviewedText = saved.segments[0].textZh;
    saved.segments[0].textZh = "过期但完整的译文";
    saved.translation.status = "failed";
    await writeFile(workspace.filePath, `${JSON.stringify(saved, null, 2)}\n`);
    files = await loadVideoFiles(workspace.dataDir);
    await reviewVideoFiles(files, workspace.options, async (_entry, units) => {
      expect(units.map(({ id }) => id)).toContain("segment:long");
      return {
        corrections: units
          .filter(({ id }) => id === "segment:long")
          .map(({ id }) => ({
            id,
            textZh: reviewedText,
            speakerZh: "",
            reason: "恢复尚未写入的审校结果",
          })),
      };
    });
    saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.translation.status).toBe("reviewed");
    expect(saved.segments[0].textZh).toBe(reviewedText);
  });

  it("refuses to mark a numerically invalid draft as reviewed", async () => {
    const workspace = await fixtureWorkspace();
    const entry = fixtureEntry();
    entry.titleZh = "一次有价值的对话";
    entry.summaryZh = "一段简短摘要。";
    entry.segments[0].textZh = "你好，43。";
    entry.segments[0].speakerZh = "埃隆·马斯克";
    entry.segments[1].textZh = "为什么是现在？";
    entry.segments[1].speakerZh = "采访者";
    entry.translation = {
      status: "translated",
      model: "gpt-5.6-sol",
      translatedAt: "2026-09-12T00:00:00.000Z",
    };
    await writeFile(workspace.filePath, `${JSON.stringify(entry, null, 2)}\n`);

    await expect(
      reviewVideoFiles(
        await loadVideoFiles(workspace.dataDir),
        workspace.options,
        async () => ({ corrections: [] }),
      ),
    ).rejects.toThrow("1 video review(s) failed");
    let saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(saved.translation.status).toBe("failed");
    expect(saved.translation.lastError).toContain("changed numbers");

    let correctionRequested = false;
    await reviewVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async (_entry, units) => {
        correctionRequested = correctionRequested || units.some(
          ({ id }) => id === "segment:p0001",
        );
        return {
          corrections: units
            .filter(({ id }) => id === "segment:p0001")
            .map(({ id }) => ({
              id,
              textZh: "你好，42。",
              speakerZh: "埃隆·马斯克",
              reason: "恢复原文数字",
            })),
        };
      },
    );
    saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(correctionRequested).toBe(true);
    expect(saved.translation.status).toBe("reviewed");
    expect(saved.segments[0].textZh).toBe("你好，42。");
  });

  it("rechecks invalid drafts stored by an older reviewed checkpoint", async () => {
    const workspace = await fixtureWorkspace();
    const entry = fixtureEntry();
    entry.titleZh = "一次有价值的对话";
    entry.summaryZh = "一段简短摘要。";
    entry.segments[0].textZh = "你好，43。";
    entry.segments[0].speakerZh = "埃隆·马斯克";
    entry.segments[1].textZh = "为什么是现在？";
    entry.segments[1].speakerZh = "采访者";
    entry.translation = {
      status: "failed",
      model: "gpt-5.6-sol",
      translatedAt: "2026-09-12T00:00:00.000Z",
    };
    await writeFile(workspace.filePath, `${JSON.stringify(entry, null, 2)}\n`);

    const checkpoint = createCheckpoint(entry, "gpt-5.6-sol");
    for (const unit of getTranslationUnits(entry)) {
      checkpoint.units[unit.id] = {
        sourceHash: unitSourceHash(unit),
        textZh: unit.textZh,
        speakerZh: unit.speakerZh,
        reviewedHash: unitReviewHash(unit),
      };
    }
    await writeCheckpoint(
      checkpointPath(workspace.options.checkpointDir, entry.id),
      checkpoint,
    );

    let requestedInvalidUnit = false;
    await reviewVideoFiles(
      await loadVideoFiles(workspace.dataDir),
      workspace.options,
      async (_entry, units) => {
        requestedInvalidUnit = requestedInvalidUnit || units.some(
          ({ id }) => id === "segment:p0001",
        );
        return {
          corrections: units
            .filter(({ id }) => id === "segment:p0001")
            .map(({ id }) => ({
              id,
              textZh: "你好，42。",
              speakerZh: "埃隆·马斯克",
              reason: "修复旧检查点中的数字",
            })),
        };
      },
    );

    const saved = JSON.parse(await readFile(workspace.filePath, "utf8")) as VideoEntry;
    expect(requestedInvalidUnit).toBe(true);
    expect(saved.translation.status).toBe("reviewed");
    expect(saved.segments[0].textZh).toBe("你好，42。");
  });

  it("reports unfinished translations explicitly", () => {
    const issues = validateVideoEntries([fixtureEntry()], {
      expectedCount: 1,
      env: {},
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "translation.status",
          severity: "error",
        }),
        expect.objectContaining({ field: "titleZh", severity: "error" }),
      ]),
    );
  });

  it("rejects a reviewed paragraph that was truncated to one character", () => {
    const entry = fixtureEntry();
    entry.titleZh = "一次对话";
    entry.summaryZh = "简短摘要";
    entry.segments = [{
      id: "p0001",
      textEn: "This deliberately longer sentence contains enough source material to require a real translation.",
      textZh: "好",
    }];
    entry.translation = {
      status: "reviewed",
      model: "gpt-5.6-sol",
      reviewedAt: "2026-09-12T00:00:00.000Z",
    };
    entry.sourceHash = computeSourceHash(entry);
    expect(validateVideoEntries([entry], { expectedCount: 1, env: {} })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "segments[0].textZh",
          message: "translation is implausibly short for its source",
        }),
      ]),
    );
  });

  it("requires baseline ids without freezing future snapshot dates", () => {
    const entry = fixtureEntry();
    entry.snapshotId = "2026-10-01";
    const issues = validateVideoEntries([entry], {
      expectedIds: new Set(["video-1", "required-baseline-video"]),
      allowIncomplete: true,
      env: {},
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "required-baseline-video",
          message: "missing required baseline video",
        }),
      ]),
    );
    expect(issues.some(({ field }) => field === "snapshotId")).toBe(false);
  });

  it("rejects duplicate keys, broken URLs, segment ids, and untranslated text", () => {
    const first = fixtureEntry();
    first.sourceUrl = "not-a-url";
    first.titleZh = "still English";
    first.segments.push({ ...first.segments[0] });
    first.translation = {
      status: "reviewed",
      model: "gpt-5.6-sol",
      reviewedAt: "2026-09-12T00:00:00.000Z",
    };
    const second = structuredClone(first);
    const issues = validateVideoEntries([first, second], {
      expectedCount: 2,
      allowIncomplete: true,
      env: {},
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "id", message: "duplicate id" }),
        expect.objectContaining({ field: "slug", message: "duplicate slug" }),
        expect.objectContaining({ field: "sourceUrl" }),
        expect.objectContaining({ field: "segments[2].id", message: "duplicate segment id" }),
        expect.objectContaining({ field: "titleZh", message: "translation contains no Chinese characters" }),
      ]),
    );
  });

  it("allows a short translated byline to preserve source names", () => {
    const entry = fixtureEntry();
    entry.titleZh = "一次对话";
    entry.summaryZh = "简短摘要";
    entry.segments = [{
      id: "p0001",
      textEn: "Jason Ridlo reporting for Americ Jr.",
      textZh: "Jason Ridlo 为 Americ Jr. 报道。",
    }];
    entry.translation = {
      status: "reviewed",
      model: "gpt-5.6-sol",
      reviewedAt: "2026-09-12T00:00:00.000Z",
    };
    entry.sourceHash = computeSourceHash(entry);
    expect(
      validateVideoEntries([entry], { expectedCount: 1, env: {} }).filter(
        ({ severity }) => severity === "error",
      ),
    ).toEqual([]);
    entry.titleEn = "VivaTech";
    entry.titleZh = "VivaTech";
    entry.sourceHash = computeSourceHash(entry);
    expect(
      validateVideoEntries([entry], { expectedCount: 1, env: {} }).filter(
        ({ severity }) => severity === "error",
      ),
    ).toEqual([]);
    entry.titleEn = "Clubhouse";
    entry.titleZh = "Clubhouse";
    entry.sourceHash = computeSourceHash(entry);
    expect(
      validateVideoEntries([entry], { expectedCount: 1, env: {} }).filter(
        ({ severity }) => severity === "error",
      ),
    ).toEqual([]);
    entry.segments = [{
      id: "p0001",
      textEn: "The next question comes from Joseph Spock of RBC Capital Markets.",
      textZh: "下一个问题来自 RBC Capital Markets 的 Joseph Spock。",
    }];
    entry.sourceHash = computeSourceHash(entry);
    expect(
      validateVideoEntries([entry], { expectedCount: 1, env: {} }).filter(
        ({ severity }) => severity === "error",
      ),
    ).toEqual([]);
  });

  it("allows preserved brand titles and one-letter transcript fragments", () => {
    const entry = fixtureEntry();
    entry.titleEn = "Tesla Cyber Rodeo";
    entry.titleZh = "Tesla Cyber Rodeo";
    entry.summaryZh = "简短摘要";
    entry.segments = [
      {
        id: "p0001",
        textEn: "s.",
        textZh: "S。",
        speakerEn: "Bliss Chapman (Neuralink)",
        speakerZh: "Bliss Chapman（Neuralink）",
      },
      { id: "p0002", textEn: "Three, two, one.", textZh: "3，2，1。" },
      {
        id: "p0003",
        textEn: "Raptor 3, Raptor 4, Raptor 5.",
        textZh: "Raptor 3、Raptor 4、Raptor 5。",
      },
      { id: "p0004", textEn: "Kim.com.", textZh: "Kim.com。" },
    ];
    entry.translation = {
      status: "reviewed",
      model: "gpt-5.6-sol",
      reviewedAt: "2026-09-12T00:00:00.000Z",
    };
    entry.sourceHash = computeSourceHash(entry);
    expect(
      validateVideoEntries([entry], { expectedCount: 1, env: {} }).filter(
        ({ severity }) => severity === "error",
      ),
    ).toEqual([]);
  });

  it("ignores URL path text while still rejecting residual English prose", () => {
    const entry = fixtureEntry();
    entry.titleZh = "一次对话";
    entry.summaryZh = "简短摘要";
    entry.segments = [{
      id: "p0001",
      textEn: "Source: https://example.com/really-long-english-path-with-many-words",
      textZh: "来源：https://example.com/really-long-english-path-with-many-words",
    }];
    entry.translation = {
      status: "reviewed",
      model: "gpt-5.6-sol",
      reviewedAt: "2026-09-12T00:00:00.000Z",
    };
    entry.sourceHash = computeSourceHash(entry);
    let issues = validateVideoEntries([entry], { expectedCount: 1, env: {} });
    expect(issues.some(({ message }) => message === "translation contains excessive residual English"))
      .toBe(false);

    entry.segments[0].textZh = "这是中文 but this paragraph remains mostly untranslated English prose";
    issues = validateVideoEntries([entry], { expectedCount: 1, env: {} });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "segments[0].textZh",
          message: "translation contains excessive residual English",
        }),
      ]),
    );
  });

  it("requires public site metadata on Cloudflare Pages", () => {
    const entry = fixtureEntry();
    entry.titleZh = "一次对话";
    entry.summaryZh = "简短摘要";
    entry.segments[0].textZh = "你好，42。";
    entry.segments[0].speakerZh = "埃隆·马斯克";
    entry.segments[1].textZh = "为什么？";
    entry.segments[1].speakerZh = "采访者";
    entry.translation = {
      status: "reviewed",
      model: "gpt-5.6-sol",
      reviewedAt: "2026-09-12T00:00:00.000Z",
    };
    expect(
      validateVideoEntries([entry], {
        expectedCount: 1,
        env: { CF_PAGES: "1" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "PUBLIC_CONTACT_EMAIL", severity: "error" }),
        expect.objectContaining({ field: "PUBLIC_SITE_URL", severity: "error" }),
      ]),
    );
  });

  it("routes shared and phase-specific sync flags", () => {
    const stages = splitStageArguments([
      "--ids=video-1",
      "--resume",
      "--model",
      "gpt-5.6-sol",
      "--expected-count=1",
    ]);
    expect(stages.fetch).toEqual(["--ids=video-1", "--resume"]);
    expect(stages.translate).toContain("--model");
    expect(stages.review).toContain("gpt-5.6-sol");
    expect(stages.validate).toEqual(["--expected-count=1"]);
  });

  it("resolves --limit to the same source ids for every content stage", () => {
    const stages = alignLimitedSelection(
      splitStageArguments(["--limit", "2", "--force"]),
      ["source-first", "source-second", "source-third"],
    );
    for (const args of [stages.fetch, stages.translate, stages.review]) {
      expect(args).not.toContain("--limit");
      expect(args).toEqual(
        expect.arrayContaining([
          "--force",
          "--ids",
          "source-first,source-second",
        ]),
      );
    }
    expect(() =>
      alignLimitedSelection(
        splitStageArguments(["--limit=-1"]),
        ["source-first"],
      ),
    ).toThrow("--limit must be a positive integer");
  });
});

describe("financial transcript numeric integrity", () => {
  it("distinguishes reporting quarters from fractions", () => {
    expect(
      compareNumericIntegrity(
        "You can't just look at one quarter versus the other quarter in terms of churn.",
        "不能只按季度环比观察流失率。",
      ).level,
    ).not.toBe("error");
  });

  it("recognizes spoken and written quarter labels", () => {
    expect(
      compareNumericIntegrity(
        "Q1 is often the first quarter of the year.",
        "第一季度通常是全年的第一季度。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("early 1 Q 2023", "2023 年第一季度初").level)
      .toBe("ok");
  });

  it("aligns ranked company counts and non-idiomatic doubling", () => {
    expect(compareNumericIntegrity("the top five companies", "排名前五的公司").level)
      .toBe("ok");
    expect(compareNumericIntegrity("Top nine for the Falcon Heavy side", "前九").level)
      .toBe("ok");
    expect(
      compareNumericIntegrity(
        "doubling down on autonomy, but doubling is not enough",
        "加倍押注自动驾驶，但仅仅加倍还不够",
      ).level,
    ).toBe("ok");
  });

  it("recognizes numbered questions in earnings calls", () => {
    expect(
      compareNumericIntegrity(
        "The first question is followed by the second question.",
        "第一个问题之后是第二个问题。",
      ).level,
    ).toBe("ok");
    expect(compareNumericIntegrity("the first questions from retail investors", "首先回答散户投资者的问题").level)
      .not.toBe("error");
  });

  it("handles percentage restatements and carried magnitude units", () => {
    expect(
      compareNumericIntegrity(
        "It probably costs a quarter or 20% of the other car.",
        "它的成本可能是另一辆车的四分之一，也就是 20%。",
      ).level,
    ).toBe("ok");
    expect(
      compareNumericIntegrity(
        "The indication is 1.8 million, and we're saying 1.8 because demand varies.",
        "指引是 180 万辆；我们说 180 万辆，是因为需求会变化。",
      ).level,
    ).toBe("warning");
  });
});
