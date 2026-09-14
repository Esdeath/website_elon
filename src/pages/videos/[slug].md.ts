import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { formatVideoMarkdown } from "../../lib/archive-formats";
import type { VideoEntry } from "../../lib/types";

export async function getStaticPaths() {
  const entries = await getCollection("videos");
  return entries.map((entry) => ({
    params: { slug: entry.data.slug },
    props: { video: entry.data },
  }));
}

interface Props {
  video: VideoEntry;
}

export const GET: APIRoute<Props> = ({ props, site }) => {
  const base = site || new URL("https://elon.ayaseeri.com");
  return new Response(formatVideoMarkdown(props.video, base), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
