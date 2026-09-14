import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { readdir, readFile } from "node:fs/promises";
import { includeInSitemap } from "./src/lib/sitemap";

const site = process.env.PUBLIC_SITE_URL || "https://elon.ayaseeri.com";
const videoDirectory = new URL("./src/content/videos/", import.meta.url);
const videoLastModified = new Map();

for (const filename of await readdir(videoDirectory)) {
  if (!filename.endsWith(".json")) continue;
  const entry = JSON.parse(await readFile(new URL(filename, videoDirectory), "utf8"));
  const lastModified = entry.translation?.reviewedAt || entry.translation?.translatedAt || entry.fetchedAt;
  if (entry.slug && lastModified && Number.isFinite(Date.parse(lastModified))) {
    videoLastModified.set(entry.slug, lastModified);
  }
}

const collectionLastModified = [...videoLastModified.values()].sort().at(-1);

export default defineConfig({
  site,
  output: "static",
  integrations: [
    sitemap({
      filter: includeInSitemap,
      serialize(item) {
        const pathname = new URL(item.url).pathname;
        const videoMatch = /^\/videos\/([^/]+)\/?$/.exec(pathname);
        let lastModified;
        if (videoMatch) lastModified = videoLastModified.get(decodeURIComponent(videoMatch[1]));
        else if (pathname === "/") lastModified = collectionLastModified;
        if (lastModified) item.lastmod = new Date(lastModified);
        return item;
      },
    }),
  ],
  build: {
    format: "directory",
  },
});
