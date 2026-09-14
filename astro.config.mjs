import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { includeInSitemap } from "./src/lib/sitemap";

const site = process.env.PUBLIC_SITE_URL || "https://elon.ayaseeri.com";

export default defineConfig({
  site,
  output: "static",
  integrations: [sitemap({ filter: includeInSitemap })],
  build: {
    format: "directory",
  },
});
