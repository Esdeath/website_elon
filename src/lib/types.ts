export const VIDEO_TYPES = [
  "interview",
  "keynote",
  "speech",
  "earnings",
  "space",
] as const;

export type VideoType = (typeof VIDEO_TYPES)[number];
export type ContentKind = "dialogue" | "article" | "none";
export type TranslationStatus =
  | "pending"
  | "translated"
  | "reviewed"
  | "failed";

export interface TranscriptSegment {
  id: string;
  speakerEn?: string;
  speakerZh?: string;
  startSec?: number;
  textEn: string;
  textZh: string;
}

export interface TranslationState {
  status: TranslationStatus;
  model?: string;
  translatedAt?: string;
  reviewedAt?: string;
  lastError?: string;
}

export interface VideoEntry {
  id: string;
  slug: string;
  snapshotId: string;
  type: VideoType;
  date: string;
  titleEn: string;
  titleZh: string;
  summaryEn: string;
  summaryZh: string;
  sourceUrl: string;
  sourceLabel?: string;
  archiveUrl: string;
  embedUrl?: string;
  thumbnailUrl?: string;
  org?: string;
  durationSec?: number;
  contentKind: ContentKind;
  segments: TranscriptSegment[];
  translation: TranslationState;
  fetchedAt: string;
  sourceHash: string;
  transcriptSource?: string;
  sourceMissing?: boolean;
}
