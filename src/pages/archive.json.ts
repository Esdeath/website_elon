import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { createArchiveIndex } from "../lib/archive-formats";

export const GET: APIRoute = async ({ site }) => {
  const entries = await getCollection("videos");
  const base = site || new URL("https://elon.ayaseeri.com");
  const index = createArchiveIndex(entries.map((entry) => entry.data), base);

  return new Response(`${JSON.stringify(index, null, 2)}\n`, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
