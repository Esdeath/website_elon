import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TranscriptSegment, VideoEntry } from "../src/lib/types";
import { computeSourceHash } from "./validate-content";
import { loadVideoFiles } from "./translate-videos";
import { writeJsonAtomic } from "./codex-content";

interface Json3Segment {
  utf8?: string;
}

interface Json3Event {
  tStartMs?: number;
  segs?: Json3Segment[];
}

interface Json3Caption {
  events?: Json3Event[];
}

interface CaptionCue {
  startSec: number;
  text: string;
}

export interface CaptionParseOptions {
  targetCharacters?: number;
  maximumCharacters?: number;
  maximumDurationSec?: number;
}

function cleanCaptionText(value: string): string {
  return value
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function captionCues(caption: Json3Caption): CaptionCue[] {
  return (caption.events ?? []).flatMap((event) => {
    if (!Number.isFinite(event.tStartMs) || !event.segs) return [];
    const text = cleanCaptionText(event.segs.map(({ utf8 }) => utf8 ?? "").join(""));
    if (!text) return [];
    return [{ startSec: event.tStartMs! / 1_000, text }];
  });
}

function endsSentence(value: string): boolean {
  return /[.!?][\])}'\"]*$/.test(value);
}

export function parseYouTubeJson3(
  caption: Json3Caption,
  options: CaptionParseOptions = {},
): TranscriptSegment[] {
  const targetCharacters = options.targetCharacters ?? 800;
  const maximumCharacters = options.maximumCharacters ?? 1_200;
  const maximumDurationSec = options.maximumDurationSec ?? 75;
  const cues = captionCues(caption);
  const paragraphs: Array<{ startSec: number; text: string }> = [];
  let current: { startSec: number; text: string } | undefined;

  const flush = () => {
    if (!current) return;
    paragraphs.push(current);
    current = undefined;
  };

  for (const cue of cues) {
    if (!current) {
      current = { ...cue };
      if (current.text.length >= targetCharacters && endsSentence(current.text)) flush();
      continue;
    }
    const candidate = `${current.text} ${cue.text}`;
    const duration = cue.startSec - current.startSec;
    if (candidate.length > maximumCharacters || duration > maximumDurationSec) {
      flush();
      current = { ...cue };
      continue;
    }
    current.text = candidate;
    if (current.text.length >= targetCharacters && endsSentence(current.text)) flush();
  }
  flush();

  return paragraphs.map(({ startSec, text }, index) => ({
    id: `p-${String(index + 1).padStart(4, "0")}`,
    startSec: Math.round(startSec * 100) / 100,
    textEn: text,
    textZh: "",
  }));
}

function valueAfter(argv: string[], index: number, option: string): [string, number] {
  const inline = argv[index].slice(option.length + 1);
  if (inline) return [inline, index];
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return [value, index + 1];
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let dataDir = resolve("src/content/videos");
  const inputs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--data-dir" || argument.startsWith("--data-dir=")) {
      const [value, nextIndex] = valueAfter(argv, index, "--data-dir");
      dataDir = resolve(value);
      index = nextIndex;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      inputs.push(resolve(argument));
    }
  }
  if (inputs.length === 0) throw new Error("Provide one or more <youtube-id>.json3 files");

  const files = await loadVideoFiles(dataDir);
  const byYouTubeId = new Map<string, (typeof files)[number]>();
  for (const file of files) {
    const id = new URL(file.entry.sourceUrl).searchParams.get("v");
    if (id) byYouTubeId.set(id, file);
  }

  for (const input of inputs) {
    const youtubeId = basename(input).split(".", 1)[0];
    const file = byYouTubeId.get(youtubeId);
    if (!file) throw new Error(`No video entry matches YouTube id ${youtubeId}`);
    const caption = JSON.parse(await readFile(input, "utf8")) as Json3Caption;
    const segments = parseYouTubeJson3(caption);
    if (segments.length === 0) throw new Error(`No caption text found in ${input}`);

    const entry: VideoEntry = {
      ...file.entry,
      contentKind: "article",
      segments,
      translation: { status: "pending" },
      transcriptSource: file.entry.sourceUrl,
    };
    entry.sourceHash = computeSourceHash(entry);
    await writeJsonAtomic(file.path, entry);
    console.log(`[captions] ${entry.id}: ${segments.length} segments`);
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
