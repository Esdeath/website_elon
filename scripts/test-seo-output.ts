import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { load } from "cheerio";
import { privacyEmbedUrl, videoThumbnail } from "../src/lib/display";
import type { VideoEntry } from "../src/lib/types";

const dist = resolve("dist");
const site = new URL(process.env.PUBLIC_SITE_URL || "https://elon.ayaseeri.com");
const videosDirectory = resolve(dist, "videos");
const contentDirectory = resolve("src/content/videos");
const contentFiles = (await readdir(contentDirectory)).filter((name) => name.endsWith(".json"));
const sourceVideos = await Promise.all(
  contentFiles.map(async (name) => JSON.parse(await readFile(resolve(contentDirectory, name), "utf8")) as VideoEntry),
);
const expectedVideos = sourceVideos.length;
const categories = [...new Set(sourceVideos.map((video) => video.type))];
const expectedIndexableUrls = expectedVideos + 4 + categories.length;
const expectedVideoSitemapUrls = sourceVideos.filter(
  (video) => privacyEmbedUrl(video.embedUrl) && videoThumbnail(video),
).length;

function xmlValues(xml: string, tag: string): string[] {
  const matches = xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, "gu"));
  return [...matches].map((match) => match[1]);
}

function jsonLdTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdTypes);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [
    ...(typeof object["@type"] === "string" ? [object["@type"]] : []),
    ...Object.values(object).flatMap(jsonLdTypes),
  ];
}

const videoEntries = await readdir(videosDirectory, { withFileTypes: true });
const detailSlugs = videoEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const markdownFiles = videoEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name)
  .sort();

assert.equal(detailSlugs.length, expectedVideos, "unexpected number of HTML video detail pages");
assert.equal(markdownFiles.length, expectedVideos, "unexpected number of Markdown video alternates");
assert.deepEqual(
  markdownFiles.map((filename) => filename.slice(0, -3)),
  detailSlugs,
  "HTML and Markdown routes must map one-to-one",
);

const titles = new Set<string>();
const descriptions = new Set<string>();
const canonicals = new Set<string>();
let structuredVideos = 0;
let structuredArticles = 0;

for (const slug of detailSlugs) {
  const html = await readFile(resolve(videosDirectory, slug, "index.html"), "utf8");
  const $ = load(html);
  const title = $("title").text().trim();
  const description = $('meta[name="description"]').attr("content")?.trim() || "";
  const robots = $('meta[name="robots"]').attr("content") || "";
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const markdown = $('link[rel="alternate"][type="text/markdown"]').attr("href") || "";
  const jsonLdText = $('script[type="application/ld+json"]').text();

  assert(title, `${slug}: missing title`);
  assert(description, `${slug}: missing description`);
  assert(description.length <= 160, `${slug}: meta description exceeds 160 characters`);
  assert.match(robots, /max-snippet:-1/u, `${slug}: unrestricted snippet directive missing`);
  assert.equal(canonical, new URL(`/videos/${slug}/`, site).toString(), `${slug}: canonical mismatch`);
  assert.equal(markdown, new URL(`/videos/${slug}.md`, site).toString(), `${slug}: Markdown alternate mismatch`);
  assert(jsonLdText, `${slug}: JSON-LD missing`);
  const source = sourceVideos.find((video) => video.slug === slug)!;
  assert($(`a[href="/categories/${source.type}/"]`).length, `${slug}: missing category link`);
  assert.equal($(".citation-note time").attr("datetime"), source.translation.reviewedAt || source.translation.translatedAt || source.fetchedAt);
  const markdownText = await readFile(resolve(videosDirectory, `${slug}.md`), "utf8");
  const citationLinks = new Set($("a.segment-link").toArray().map((link) => $(link).attr("href")));
  if (source.contentKind !== "none") {
    for (const segment of source.segments) {
      assert(citationLinks.has(`#${segment.id}`), `${slug}: missing citation link`);
      assert(markdownText.includes(`${canonical}#${encodeURIComponent(segment.id)}`), `${slug}: missing Markdown citation`);
    }
  }
  for (const link of $(".related-records li a").toArray()) {
    const href = $(link).attr("href");
    assert(sourceVideos.some((video) => video.slug !== slug && video.type === source.type && href === `/videos/${video.slug}/`), `${slug}: invalid related record`);
  }

  const jsonLd = JSON.parse(jsonLdText) as unknown;
  const serialized = JSON.stringify(jsonLd);
  const types = jsonLdTypes(jsonLd);
  assert(types.includes("WebPage"), `${slug}: WebPage JSON-LD missing`);
  assert(types.includes("BreadcrumbList"), `${slug}: BreadcrumbList JSON-LD missing`);
  assert(!serialized.includes('"contentUrl"'), `${slug}: source page must not be a media contentUrl`);
  if (types.includes("VideoObject")) structuredVideos += 1;
  if (types.includes("Article")) structuredArticles += 1;

  const stableIds = $("article.transcript-segment[id]")
    .map((_index, element) => $(element).attr("id"))
    .get();
  assert.equal(new Set(stableIds).size, stableIds.length, `${slug}: duplicate transcript anchors`);

  assert(!titles.has(title), `${slug}: duplicate page title: ${title}`);
  assert(!descriptions.has(description), `${slug}: duplicate meta description`);
  assert(!canonicals.has(canonical), `${slug}: duplicate canonical: ${canonical}`);
  titles.add(title);
  descriptions.add(description);
  canonicals.add(canonical);
}

assert.equal(structuredVideos, expectedVideoSitemapUrls, "unexpected VideoObject count");
assert.equal(structuredArticles, expectedVideos - expectedVideoSitemapUrls, "unexpected Article count");

const archiveIndex = JSON.parse(await readFile(resolve(dist, "archive.json"), "utf8"));
assert.equal(archiveIndex.numberOfItems, expectedVideos, "archive.json count mismatch");
assert.equal(archiveIndex.items.length, expectedVideos, "archive.json item count mismatch");
assert.equal(new Set(archiveIndex.items.map((item: { id: string }) => item.id)).size, expectedVideos);

const llms = await readFile(resolve(dist, "llms.txt"), "utf8");
const llmsMarkdownUrls = [...llms.matchAll(/https:\/\/[^)>\s]+\/videos\/[^)>\s]+\.md/gu)]
  .map((match) => match[0]);
assert.equal(llmsMarkdownUrls.length, expectedVideos, "llms.txt record count mismatch");
assert.equal(new Set(llmsMarkdownUrls).size, expectedVideos, "llms.txt contains duplicate records");
assert(llmsMarkdownUrls.every((url) => new URL(url).origin === site.origin));

const sitemapIndex = await readFile(resolve(dist, "sitemap-index.xml"), "utf8");
const sitemapUrls = xmlValues(sitemapIndex, "loc");
const indexableUrls: string[] = [];
let lastModifiedCount = 0;
for (const sitemapUrl of sitemapUrls) {
  const filename = new URL(sitemapUrl).pathname.split("/").filter(Boolean).at(-1);
  assert(filename, "sitemap index contains an invalid URL");
  const sitemap = await readFile(resolve(dist, filename), "utf8");
  indexableUrls.push(...xmlValues(sitemap, "loc"));
  lastModifiedCount += xmlValues(sitemap, "lastmod").length;
}
assert.equal(indexableUrls.length, expectedIndexableUrls, "canonical sitemap URL count mismatch");
assert.equal(new Set(indexableUrls).size, expectedIndexableUrls, "canonical sitemap has duplicates");
assert.equal(lastModifiedCount, expectedVideos + 1 + categories.length, "sitemap lastmod coverage mismatch");
assert(indexableUrls.every((url) => !/\.(?:json|md|txt|xml)$/u.test(new URL(url).pathname)));

const home = load(await readFile(resolve(dist, "index.html"), "utf8"));
for (const type of categories) {
  const url = new URL(`/categories/${type}/`, site).toString();
  assert(indexableUrls.includes(url), `${type}: missing category sitemap entry`);
  assert(home(`a[href="/categories/${type}/"]`).length, `${type}: missing homepage link`);
  assert(llms.includes(url), `${type}: missing llms.txt category`);
  const $ = load(await readFile(resolve(dist, "categories", type, "index.html"), "utf8"));
  assert.equal($('link[rel="canonical"]').attr("href"), url);
  assert(!($('meta[name="robots"]').attr("content") || "").includes("noindex"));
  const graph = JSON.parse($('script[type="application/ld+json"]').text())["@graph"];
  assert.equal(graph.find((node: Record<string, unknown>) => node["@type"] === "CollectionPage").name, $("h1").text());
  const categoryVideos = sourceVideos.filter((video) => video.type === type);
  assert.equal(graph.find((node: Record<string, unknown>) => node["@type"] === "ItemList").numberOfItems, categoryVideos.length);
  for (const video of categoryVideos) {
    assert($(`a[href="/videos/${video.slug}/"]`).length, `${type}: missing static record link`);
  }
}

const videoSitemap = await readFile(resolve(dist, "video-sitemap.xml"), "utf8");
const videoUrls = xmlValues(videoSitemap, "loc");
assert.equal(videoUrls.length, expectedVideoSitemapUrls, "video sitemap count mismatch");
assert.equal(new Set(videoUrls).size, expectedVideoSitemapUrls, "video sitemap has duplicates");

const robotsTxt = await readFile(resolve(dist, "robots.txt"), "utf8");
assert(robotsTxt.includes("User-agent: OAI-SearchBot"));
assert(robotsTxt.includes("User-agent: Claude-SearchBot"));
assert(robotsTxt.includes("User-agent: PerplexityBot"));
assert.match(robotsTxt, /User-agent: Google-Extended\nAllow: \/\n/u);
assert(robotsTxt.includes("Content-Signal: search=yes, ai-input=yes, ai-train=no"));
assert(robotsTxt.includes(new URL("/sitemap-index.xml", site).toString()));
assert(robotsTxt.includes(new URL("/video-sitemap.xml", site).toString()));

const headers = await readFile(resolve(dist, "_headers"), "utf8");
assert(headers.includes("Content-Signal: search=yes, ai-input=yes, ai-train=no"));
assert(headers.includes("/videos/*.md"));
assert.equal(
  (await readFile(resolve(dist, "d4eba4232e2e02c998ca57c87da498ca.txt"), "utf8")).trim(),
  "d4eba4232e2e02c998ca57c87da498ca",
);

console.log(
  `[seo] ${expectedVideos} unique detail pages, ${markdownFiles.length} Markdown alternates, ` +
  `${indexableUrls.length} canonical URLs, ${videoUrls.length} videos`,
);
