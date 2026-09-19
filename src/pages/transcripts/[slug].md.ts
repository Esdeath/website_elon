import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { formatChineseTranscriptMarkdown, getChineseTranscripts } from "../../lib/transcripts";
import type { VideoEntry } from "../../lib/types";

export async function getStaticPaths() {
  const entries = await getCollection("videos");
  return getChineseTranscripts(entries.map((entry) => entry.data)).map((video) => ({
    params: { slug: video.slug },
    props: { video },
  }));
}

interface Props {
  video: VideoEntry;
}

export const GET: APIRoute<Props> = ({ props, site }) => {
  const base = site || new URL("https://elon.ayaseeri.com");
  return new Response(formatChineseTranscriptMarkdown(props.video, base), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
