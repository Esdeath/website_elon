import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { privacyEmbedUrl, videoThumbnail } from "../lib/display";
import { buildVideoSitemap, type VideoSitemapEntry } from "../lib/video-sitemap";

export const GET: APIRoute = async ({ site }) => {
  const base = site || new URL("https://elon.ayaseeri.com");
  const videos = await getCollection("videos");
  const entries: VideoSitemapEntry[] = videos.map(({ data }) => {
    const title = data.titleZh.trim();

    return {
      loc: new URL(`/videos/${encodeURIComponent(data.slug)}/`, base).toString(),
      thumbnailLoc: videoThumbnail(data),
      title,
      description: data.summaryZh.trim() || `${title}的中文实录与英文原文。`,
      playerLoc: privacyEmbedUrl(data.embedUrl),
      publicationDate: data.date,
      durationSec: data.durationSec,
    };
  });

  return new Response(buildVideoSitemap(entries), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
