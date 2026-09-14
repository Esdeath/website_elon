import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const INDEXNOW_KEY = "d4eba4232e2e02c998ca57c87da498ca";
const site = new URL(process.env.PUBLIC_SITE_URL || "https://elon.ayaseeri.com");
const sitemapIndex = await readFile(resolve("dist/sitemap-index.xml"), "utf8");

function locations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]);
}

const sitemapFiles = locations(sitemapIndex).map((url) => {
  const parsed = new URL(url);
  if (parsed.origin !== site.origin) throw new Error(`Unexpected sitemap origin: ${url}`);
  const filename = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!filename) throw new Error(`Invalid sitemap URL: ${url}`);
  return filename;
});

const urlList = [...new Set((await Promise.all(
  sitemapFiles.map(async (filename) => locations(await readFile(resolve("dist", filename), "utf8"))),
)).flat())];

if (urlList.length === 0 || urlList.length > 10_000) {
  throw new Error(`IndexNow URL count is outside the supported range: ${urlList.length}`);
}
for (const url of urlList) {
  if (new URL(url).origin !== site.origin) throw new Error(`Unexpected URL origin: ${url}`);
}

const response = await fetch(INDEXNOW_ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host: site.hostname,
    key: INDEXNOW_KEY,
    keyLocation: new URL(`/${INDEXNOW_KEY}.txt`, site).toString(),
    urlList,
  }),
});

if (!response.ok) {
  const detail = (await response.text()).trim();
  throw new Error(`IndexNow returned ${response.status}${detail ? `: ${detail}` : ""}`);
}

console.log(`[indexnow] accepted ${urlList.length} canonical URLs (${response.status})`);
