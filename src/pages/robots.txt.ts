import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const base = site || new URL("https://elon.ayaseeri.com");
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL("sitemap-index.xml", base)}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
