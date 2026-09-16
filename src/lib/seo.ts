import type { VideoEntry } from "./types";

export const SITE_NAME = "马斯克中文档案";
export const SITE_DESCRIPTION = "按时间、主题和机构检索伊隆·马斯克的公开视频、访谈与中文实录。";

type JsonLdObject = Record<string, unknown>;

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function truncateDescription(value: string, maxLength = 160): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  if (maxLength <= 0) return "";
  const characters = Array.from(clean);
  if (characters.length <= maxLength) return clean;
  if (maxLength === 1) return "…";

  const candidate = characters.slice(0, maxLength - 1).join("");
  const lastBoundary = Math.max(candidate.lastIndexOf("。"), candidate.lastIndexOf("；"));
  const trimmed = lastBoundary >= Math.floor(maxLength * 0.6)
    ? candidate.slice(0, lastBoundary + 1)
    : candidate.trimEnd();
  return `${trimmed}…`;
}

export function toIsoDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const wholeSeconds = Math.round(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return `PT${hours > 0 ? `${hours}H` : ""}${minutes > 0 ? `${minutes}M` : ""}${remainder > 0 ? `${remainder}S` : ""}`;
}

export function detailMetaTitle(video: VideoEntry): string {
  return `${video.titleZh || video.titleEn}（${video.date}）`;
}

export function buildDetailMetaTitles(videos: readonly VideoEntry[]): Map<string, string> {
  const baseTitles = videos.map((video) => detailMetaTitle(video));
  const counts = baseTitles.reduce((map, title) => {
    map.set(title, (map.get(title) || 0) + 1);
    return map;
  }, new Map<string, number>());
  const candidates = videos.map((video, index) => {
    const title = video.titleZh || video.titleEn;
    return counts.get(baseTitles[index]) === 1
      ? baseTitles[index]
      : `${title}：${video.titleEn}（${video.date}）`;
  });
  const candidateCounts = candidates.reduce((map, title) => {
    map.set(title, (map.get(title) || 0) + 1);
    return map;
  }, new Map<string, number>());

  return new Map(videos.map((video, index) => [
    video.slug,
    candidateCounts.get(candidates[index]) === 1
      ? candidates[index]
      : `${candidates[index]}［${video.id}］`,
  ]));
}

function entityIds(canonical: string) {
  const site = new URL("/", canonical).toString();
  return {
    site,
    organization: `${site}#organization`,
    website: `${site}#website`,
    person: `${site}#elon-musk`,
  };
}

function organization(ids: ReturnType<typeof entityIds>): JsonLdObject {
  return {
    "@type": "Organization",
    "@id": ids.organization,
    name: SITE_NAME,
    url: ids.site,
    description: "面向中文读者的非官方、非商业伊隆·马斯克公开影像研究档案。",
  };
}

function subject(ids: ReturnType<typeof entityIds>): JsonLdObject {
  return {
    "@type": "Person",
    "@id": ids.person,
    name: "Elon Musk",
    alternateName: "伊隆·马斯克",
    sameAs: [
      "https://www.wikidata.org/wiki/Q317521",
      "https://en.wikipedia.org/wiki/Elon_Musk",
    ],
  };
}

function website(ids: ReturnType<typeof entityIds>): JsonLdObject {
  return {
    "@type": "WebSite",
    "@id": ids.website,
    url: ids.site,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    inLanguage: ["zh-CN", "en"],
    publisher: { "@id": ids.organization },
    about: { "@id": ids.person },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${ids.site}search/?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

function sourceUrls(video: VideoEntry): string[] {
  return [video.sourceUrl, video.archiveUrl, video.transcriptSource]
    .filter(isHttpUrl)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function citations(video: VideoEntry): JsonLdObject[] {
  const labels = new Map<string, string>([
    [video.sourceUrl, video.sourceLabel || "原始来源"],
    [video.archiveUrl, "Elon Musk Archive 英文档案页"],
  ]);
  if (isHttpUrl(video.transcriptSource) && !labels.has(video.transcriptSource)) {
    labels.set(video.transcriptSource, "英文文字记录来源");
  }

  return sourceUrls(video).map((url) => ({
    "@type": "CreativeWork",
    name: labels.get(url) || "来源",
    url,
  }));
}

export function buildCollectionJsonLd(
  videos: VideoEntry[],
  canonical: string,
  description: string,
  name = SITE_NAME,
): JsonLdObject {
  const ids = entityIds(canonical);
  const modified = videos
    .flatMap((video) => [video.translation.reviewedAt, video.translation.translatedAt, video.fetchedAt])
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const collectionId = `${canonical}#collection`;
  const itemListId = `${canonical}#items`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      organization(ids),
      subject(ids),
      website(ids),
      {
        "@type": "CollectionPage",
        "@id": collectionId,
        url: canonical,
        name,
        description,
        inLanguage: "zh-CN",
        isPartOf: { "@id": ids.website },
        about: { "@id": ids.person },
        mainEntity: { "@id": itemListId },
        ...(modified ? { dateModified: modified } : {}),
      },
      {
        "@type": "ItemList",
        "@id": itemListId,
        numberOfItems: videos.length,
        itemListOrder: "https://schema.org/ItemListOrderDescending",
        itemListElement: videos.map((video, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: new URL(`/videos/${video.slug}/`, ids.site).toString(),
          name: video.titleZh || video.titleEn,
        })),
      },
    ],
  };
}

interface DetailJsonLdOptions {
  canonical: string;
  description: string;
  thumbnail?: string;
  embedUrl?: string;
}

export function buildDetailJsonLd(video: VideoEntry, options: DetailJsonLdOptions): JsonLdObject {
  const { canonical, description, thumbnail, embedUrl } = options;
  const ids = entityIds(canonical);
  const title = video.titleZh || video.titleEn;
  const pageId = `${canonical}#webpage`;
  const breadcrumbId = `${canonical}#breadcrumb`;
  const validThumbnail = isHttpUrl(thumbnail) ? thumbnail : undefined;
  const validEmbedUrl = isHttpUrl(embedUrl) ? embedUrl : undefined;
  const mediaType = validEmbedUrl && validThumbnail ? "VideoObject" : "Article";
  const mediaId = `${canonical}#${mediaType === "VideoObject" ? "video" : "article"}`;
  const modified = video.translation.reviewedAt || video.translation.translatedAt || video.fetchedAt;
  const basedOn = sourceUrls(video);
  const citation = citations(video);
  const duration = toIsoDuration(video.durationSec);

  const commonMedia: JsonLdObject = {
    "@type": mediaType,
    "@id": mediaId,
    name: title,
    description,
    identifier: video.id,
    url: canonical,
    datePublished: video.date,
    dateModified: modified,
    inLanguage: ["zh-CN", "en"],
    mainEntityOfPage: { "@id": pageId },
    isPartOf: { "@id": ids.website },
    about: { "@id": ids.person },
    isBasedOn: basedOn,
    citation,
  };

  if (mediaType === "VideoObject") {
    Object.assign(commonMedia, {
      alternateName: video.titleEn,
      uploadDate: video.date,
      thumbnailUrl: [validThumbnail],
      embedUrl: validEmbedUrl,
      inLanguage: "en",
      ...(duration ? { duration } : {}),
    });
  } else {
    Object.assign(commonMedia, {
      headline: title,
      alternativeHeadline: video.titleEn,
      publisher: { "@id": ids.organization },
      ...(validThumbnail ? { image: [validThumbnail] } : {}),
    });
  }

  return {
    "@context": "https://schema.org",
    "@graph": [
      organization(ids),
      subject(ids),
      website(ids),
      {
        "@type": "BreadcrumbList",
        "@id": breadcrumbId,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "影像目录",
            item: ids.site,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: title,
            item: canonical,
          },
        ],
      },
      {
        "@type": "WebPage",
        "@id": pageId,
        url: canonical,
        name: title,
        description,
        datePublished: video.date,
        dateModified: modified,
        inLanguage: "zh-CN",
        isPartOf: { "@id": ids.website },
        breadcrumb: { "@id": breadcrumbId },
        about: { "@id": ids.person },
        mainEntity: { "@id": mediaId },
        publisher: { "@id": ids.organization },
        citation,
        ...(validThumbnail
          ? { primaryImageOfPage: { "@type": "ImageObject", url: validThumbnail } }
          : {}),
      },
      commonMedia,
    ],
  };
}
