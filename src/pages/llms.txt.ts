import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { formatLlmsTxt } from "../lib/archive-formats";

export const GET: APIRoute = async ({ site }) => {
  const entries = await getCollection("videos");
  const base = site || new URL("https://elon.ayaseeri.com");
  const body = formatLlmsTxt(entries.map((entry) => entry.data), base);

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
