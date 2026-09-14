import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const segment = z.object({
  id: z.string(),
  speakerEn: z.string().optional(),
  speakerZh: z.string().optional(),
  startSec: z.number().nonnegative().optional(),
  textEn: z.string(),
  textZh: z.string(),
});

const videos = defineCollection({
  loader: glob({ pattern: "**/*.json", base: "./src/content/videos" }),
  schema: z.object({
    id: z.string(),
    slug: z.string(),
    snapshotId: z.string(),
    type: z.enum(["interview", "keynote", "speech", "earnings", "space"]),
    date: z.string(),
    titleEn: z.string(),
    titleZh: z.string(),
    summaryEn: z.string(),
    summaryZh: z.string(),
    sourceUrl: z.string().url(),
    sourceLabel: z.string().optional(),
    archiveUrl: z.string().url(),
    embedUrl: z.string().url().optional(),
    thumbnailUrl: z.string().url().optional(),
    org: z.string().optional(),
    durationSec: z.number().nonnegative().optional(),
    contentKind: z.enum(["dialogue", "article", "none"]),
    segments: z.array(segment),
    translation: z.object({
      status: z.enum(["pending", "translated", "reviewed", "failed"]),
      model: z.string().optional(),
      translatedAt: z.string().optional(),
      reviewedAt: z.string().optional(),
      lastError: z.string().optional(),
    }),
    fetchedAt: z.string(),
    sourceHash: z.string(),
    transcriptSource: z.string().optional(),
    sourceMissing: z.boolean().optional(),
  }),
});

export const collections = { videos };
