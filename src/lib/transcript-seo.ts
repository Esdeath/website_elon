import { buildCollectionJsonLd, buildDetailJsonLd } from "./seo";
import { getChineseTranscripts, transcriptPath } from "./transcripts";
import type { VideoEntry } from "./types";

type JsonLdObject = Record<string, unknown>;

export function buildTranscriptCollectionJsonLd(
  videos: readonly VideoEntry[],
  canonical: string,
  description: string,
): JsonLdObject {
  const transcripts = getChineseTranscripts(videos);
  const result = buildCollectionJsonLd(transcripts, canonical, description, "中文文字稿");
  const graph = result["@graph"] as JsonLdObject[];
  const items = graph.find((node) => node["@type"] === "ItemList")!;
  items.itemListElement = transcripts.map((video, index) => ({
    "@type": "ListItem",
    position: index + 1,
    url: new URL(transcriptPath(video), canonical).toString(),
    name: video.titleZh,
  }));
  return result;
}

export function buildTranscriptJsonLd(
  video: VideoEntry,
  canonical: string,
  description: string,
): JsonLdObject {
  const result = buildDetailJsonLd(video, { canonical, description });
  const graph = result["@graph"] as JsonLdObject[];
  const article = graph.find((node) => node["@type"] === "Article")!;
  article.inLanguage = "zh-CN";
  article.isBasedOn = [
    new URL(`/videos/${video.slug}/`, canonical).toString(),
    ...(article.isBasedOn as string[]),
  ];
  delete article.alternativeHeadline;

  const breadcrumb = graph.find((node) => node["@type"] === "BreadcrumbList")!;
  breadcrumb.itemListElement = [
    {
      "@type": "ListItem",
      position: 1,
      name: "影像目录",
      item: new URL("/", canonical).toString(),
    },
    {
      "@type": "ListItem",
      position: 2,
      name: "中文文字稿",
      item: new URL("/transcripts/", canonical).toString(),
    },
    {
      "@type": "ListItem",
      position: 3,
      name: video.titleZh,
      item: canonical,
    },
  ];
  return result;
}
