import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { load } from "cheerio";
import { privacyEmbedUrl, videoThumbnail } from "../src/lib/display";
import { getChineseTranscripts, hasChineseTranscript, transcriptPath } from "../src/lib/transcripts";
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
const sourceTranscripts = getChineseTranscripts(sourceVideos);
const expectedTranscripts = sourceTranscripts.length;
const transcriptsDirectory = resolve(dist, "transcripts");
const transcriptCollectionUrl = new URL("/transcripts/", site).toString();
const categories = [...new Set(sourceVideos.map((video) => video.type))];
const expectedIndexableUrls = expectedVideos + expectedTranscripts + 6 + categories.length;
const bookPath = "/books/first-principles/";
const bookUrl = new URL(bookPath, site).toString();
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

const normalizedText = (value: string) => value.replace(/\s+/gu, " ").trim();

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*_[\]#+.\-])/gu, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
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

const transcriptEntries = await readdir(transcriptsDirectory, { withFileTypes: true });
const transcriptSlugs = transcriptEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const transcriptMarkdownFiles = transcriptEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name.slice(0, -3)).sort();
const expectedTranscriptSlugs = sourceTranscripts.map((video) => video.slug).sort();
assert.deepEqual(transcriptSlugs, expectedTranscriptSlugs, "Chinese HTML routes must match available source transcripts");
assert.deepEqual(transcriptMarkdownFiles, expectedTranscriptSlugs, "Chinese Markdown routes must match available source transcripts");

const transcriptCollection = load(await readFile(resolve(transcriptsDirectory, "index.html"), "utf8"));
assert.equal(transcriptCollection('link[rel="canonical"]').attr("href"), transcriptCollectionUrl);
assert(!transcriptCollection('meta[name="robots"]').attr("content")?.includes("noindex"));
assert.equal(transcriptCollection("[data-transcript-card]").length, expectedTranscripts, "Chinese collection card count mismatch");
const collectionGraph = JSON.parse(transcriptCollection('script[type="application/ld+json"]').text())["@graph"];
assert(collectionGraph.some((node: Record<string, unknown>) => node["@type"] === "CollectionPage"), "Chinese collection JSON-LD missing");
const transcriptItemList = collectionGraph.find((node: Record<string, unknown>) => node["@type"] === "ItemList");
assert.equal(transcriptItemList.numberOfItems, expectedTranscripts, "Chinese ItemList count mismatch");
assert.deepEqual(
  transcriptItemList.itemListElement.map((item: { url: string }) => item.url).sort(),
  sourceTranscripts.map((video) => new URL(transcriptPath(video), site).toString()).sort(),
  "Chinese ItemList must link to every independent reading page",
);

let transcriptParagraphCount = 0;
for (const source of sourceTranscripts) {
  const { slug } = source;
  const canonical = new URL(transcriptPath(source), site).toString();
  const markdownUrl = new URL(`/transcripts/${slug}.md`, site).toString();
  const $ = load(await readFile(resolve(transcriptsDirectory, slug, "index.html"), "utf8"));
  const reader = $(".transcript-reader");
  const title = $("title").text().trim();
  const description = $('meta[name="description"]').attr("content") || "";
  const paragraphs = $(".reader-body .reading-segment[data-segment-id]").toArray();
  const markdown = await readFile(resolve(transcriptsDirectory, `${slug}.md`), "utf8");
  const markdownText = normalizedText(unescapeMarkdown(markdown));
  const bodyText = normalizedText($(".reader-body .reading-segment > p").toArray().map((paragraph) => $(paragraph).text()).join(" "));
  const links = new Set($("a[href]").toArray().map((link) => $(link).attr("href")));

  assert(reader.length, `${slug}: Chinese reader missing`);
  assert.equal($("h1").text().trim(), source.titleZh, `${slug}: Chinese title changed`);
  assert(title && !titles.has(title), `${slug}: Chinese title missing or duplicates another page`);
  assert(description && description.length <= 160, `${slug}: invalid Chinese meta description`);
  assert(!descriptions.has(description), `${slug}: Chinese description duplicates another page`);
  assert.equal($('link[rel="canonical"]').attr("href"), canonical, `${slug}: Chinese canonical mismatch`);
  assert.equal($('link[rel="alternate"][type="text/markdown"]').attr("href"), markdownUrl, `${slug}: Chinese Markdown alternate mismatch`);
  assert(!($('meta[name="robots"]').attr("content") || "").includes("noindex"), `${slug}: Chinese reader must be indexable`);
  assert(!canonicals.has(canonical), `${slug}: duplicate Chinese canonical`);
  assert.equal(paragraphs.length, source.segments.length, `${slug}: Chinese paragraph count mismatch`);
  assert.equal($(".reader-body .reading-segment > p").length, source.segments.length, `${slug}: reader must contain only Chinese transcript paragraphs`);
  assert.equal($(".reader-body [lang=\"en\"]").length, 0, `${slug}: English content must not appear in Chinese body`);
  assert(links.has(`/videos/${slug}/`) || links.has(new URL(`/videos/${slug}/`, site).toString()), `${slug}: source video record link missing`);
  assert(links.has(source.sourceUrl), `${slug}: original source link missing`);
  assert(links.has(source.archiveUrl), `${slug}: archive source link missing`);
  assert(transcriptCollection(`a[href="${transcriptPath(source)}"]`).length, `${slug}: static Chinese collection link missing`);
  assert(markdown.includes(canonical), `${slug}: Chinese Markdown reading page link missing`);
  assert(markdown.includes(source.sourceUrl), `${slug}: Chinese Markdown source link missing`);
  assert(markdown.includes(source.archiveUrl), `${slug}: Chinese Markdown archive source link missing`);

  const anchorIds = paragraphs.map((paragraph) => $(paragraph).attr("id"));
  assert.equal(new Set(anchorIds).size, anchorIds.length, `${slug}: duplicate Chinese paragraph anchors`);
  for (const [index, segment] of source.segments.entries()) {
    const paragraph = $(paragraphs[index]);
    assert.equal(paragraph.attr("data-segment-id"), segment.id, `${slug}: Chinese paragraph order changed`);
    assert.equal(paragraph.attr("id"), segment.id, `${slug}: source paragraph anchor changed`);
    assert.equal(paragraph.find("p").length, 1, `${slug}/${segment.id}: expected one Chinese paragraph`);
    assert.equal(normalizedText(paragraph.find("p").text()), normalizedText(segment.textZh), `${slug}/${segment.id}: Chinese source text changed`);
    assert(markdownText.includes(normalizedText(segment.textZh)), `${slug}/${segment.id}: Chinese Markdown text missing`);
    assert(markdown.includes(`${canonical}#${encodeURIComponent(segment.id)}`), `${slug}/${segment.id}: Chinese Markdown citation missing`);
    const english = normalizedText(segment.textEn);
    if (english.length > 40 && !normalizedText(segment.textZh).includes(english)) {
      assert(!bodyText.includes(english), `${slug}/${segment.id}: English source text leaked into Chinese reader`);
      assert(!markdownText.includes(english), `${slug}/${segment.id}: English source text leaked into Chinese Markdown`);
    }
  }
  transcriptParagraphCount += paragraphs.length;

  const jsonLd = JSON.parse($('script[type="application/ld+json"]').text());
  const graph = jsonLd["@graph"] as Record<string, unknown>[];
  const article = graph.find((node) => node["@type"] === "Article");
  const webpage = graph.find((node) => node["@type"] === "WebPage");
  assert(article && webpage && jsonLdTypes(jsonLd).includes("BreadcrumbList"), `${slug}: Chinese structured data incomplete`);
  assert.equal(article.inLanguage, "zh-CN", `${slug}: Chinese article language mismatch`);
  assert.equal(webpage.inLanguage, "zh-CN", `${slug}: Chinese webpage language mismatch`);
  assert.equal(article.url, canonical, `${slug}: Chinese article URL mismatch`);
  assert.equal(article.dateModified, source.translation.reviewedAt || source.translation.translatedAt || source.fetchedAt);
  assert(Array.isArray(article.citation) && article.citation.length, `${slug}: Chinese source citations missing`);
  assert(!("articleBody" in article) && !("text" in article), `${slug}: JSON-LD must not duplicate the transcript body`);
  titles.add(title);
  descriptions.add(description);
  canonicals.add(canonical);
}

const archiveIndex = JSON.parse(await readFile(resolve(dist, "archive.json"), "utf8"));
assert.equal(archiveIndex.numberOfItems, expectedVideos, "archive.json count mismatch");
assert.equal(archiveIndex.items.length, expectedVideos, "archive.json item count mismatch");
assert.equal(new Set(archiveIndex.items.map((item: { id: string }) => item.id)).size, expectedVideos);
for (const item of archiveIndex.items) {
  const source = sourceVideos.find((video) => video.slug === item.slug)!;
  if (hasChineseTranscript(source)) {
    assert.equal(item.transcriptUrl, new URL(transcriptPath(source), site).toString());
    assert.equal(item.transcriptMarkdownUrl, new URL(`/transcripts/${source.slug}.md`, site).toString());
  } else {
    assert(!item.transcriptUrl && !item.transcriptMarkdownUrl, `${source.slug}: unavailable Chinese transcript linked in archive.json`);
  }
}

const llms = await readFile(resolve(dist, "llms.txt"), "utf8");
const llmsMarkdownUrls = [...llms.matchAll(/https:\/\/[^)>\s]+\/videos\/[^)>\s]+\.md/gu)]
  .map((match) => match[0]);
assert.equal(llmsMarkdownUrls.length, expectedVideos, "llms.txt record count mismatch");
assert.equal(new Set(llmsMarkdownUrls).size, expectedVideos, "llms.txt contains duplicate records");
assert(llmsMarkdownUrls.every((url) => new URL(url).origin === site.origin));
assert(llms.includes(transcriptCollectionUrl), "Chinese collection missing from llms.txt");
const llmsTranscriptUrls = [...llms.matchAll(/https?:\/\/[^)>\s]+\/transcripts\/[^)>\s]+\.md/gu)].map((match) => match[0]);
assert.deepEqual(
  llmsTranscriptUrls.sort(),
  sourceTranscripts.map((video) => new URL(`/transcripts/${video.slug}.md`, site).toString()).sort(),
  "llms.txt must enumerate each available Chinese Markdown once",
);

const sitemapIndex = await readFile(resolve(dist, "sitemap-index.xml"), "utf8");
const sitemapUrls = xmlValues(sitemapIndex, "loc");
const indexableUrls: string[] = [];
let lastModifiedCount = 0;
const sitemapLastModified = new Map<string, string>();
for (const sitemapUrl of sitemapUrls) {
  const filename = new URL(sitemapUrl).pathname.split("/").filter(Boolean).at(-1);
  assert(filename, "sitemap index contains an invalid URL");
  const sitemap = await readFile(resolve(dist, filename), "utf8");
  indexableUrls.push(...xmlValues(sitemap, "loc"));
  lastModifiedCount += xmlValues(sitemap, "lastmod").length;
  const sitemapDocument = load(sitemap, { xmlMode: true });
  for (const entry of sitemapDocument("url").toArray()) {
    sitemapLastModified.set(sitemapDocument(entry).find("loc").text(), sitemapDocument(entry).find("lastmod").text());
  }
}
assert.equal(indexableUrls.length, expectedIndexableUrls, "canonical sitemap URL count mismatch");
assert.equal(new Set(indexableUrls).size, expectedIndexableUrls, "canonical sitemap has duplicates");
assert.equal(lastModifiedCount, expectedVideos + expectedTranscripts + 2 + categories.length, "sitemap lastmod coverage mismatch");
assert(indexableUrls.every((url) => !/\.(?:json|md|txt|xml)$/u.test(new URL(url).pathname)));
assert(indexableUrls.includes(transcriptCollectionUrl), "Chinese collection missing from sitemap");
assert(sitemapLastModified.get(transcriptCollectionUrl), "Chinese collection lastmod missing");
for (const source of sourceTranscripts) {
  const canonical = new URL(transcriptPath(source), site).toString();
  assert(indexableUrls.includes(canonical), `${source.slug}: Chinese reader missing from sitemap`);
  assert.equal(
    Date.parse(sitemapLastModified.get(canonical) || ""),
    Date.parse(source.translation.reviewedAt || source.translation.translatedAt || source.fetchedAt),
    `${source.slug}: Chinese reader lastmod mismatch`,
  );
}

const home = load(await readFile(resolve(dist, "index.html"), "utf8"));
const book = load(await readFile(resolve(dist, "books/first-principles/index.html"), "utf8"));
const sourceBook = load(await readFile(resolve("src/data/books/first-principles.html"), "utf8"));
assert.equal(book('link[rel="canonical"]').attr("href"), bookUrl, "book canonical mismatch");
assert(!book('meta[name="robots"]').attr("content")?.includes("noindex"), "book must be indexable");
assert(indexableUrls.includes(bookUrl), "book missing from canonical sitemap");
assert(llms.includes(bookUrl), "book missing from llms.txt");
assert(home(`.book-feature a[href="${bookPath}"]`).length, "book missing from homepage");
assert(home(`nav[aria-label="主导航"] a[href="${bookPath}"]`).length, "book missing from main navigation");
const bookJsonLd = book('script[type="application/ld+json"]').toArray().map((script) => JSON.parse(book(script).text()));
assert(jsonLdTypes(bookJsonLd).includes("Book"), "book JSON-LD missing");
assert.equal(book('.chapter[id^="chapter-"]').length, 20, "book chapter count mismatch");
assert.equal(book(".question-title").length, 903, "book question count mismatch");
assert.equal(book(".answer").length, 903, "book answer count mismatch");
assert.equal(book(".bibliography li").length, 92, "book bibliography count mismatch");
assert.equal(book(".chapter#sources").length, 1, "book source appendix missing");

const bookIds = book("[id]").toArray().map((element) => book(element).attr("id"));
assert.equal(new Set(bookIds).size, bookIds.length, "book contains duplicate anchors");
for (const link of book('a[href^="#"]').toArray()) {
  const anchor = decodeURIComponent(book(link).attr("href")!.slice(1));
  assert(anchor && bookIds.includes(anchor), `book link has no target: #${anchor}`);
}
for (const selector of [".question-title", ".answer", ".chapter-body > p", ".chapter-body > h2", ".bibliography li"]) {
  assert.deepEqual(
    book(selector).toArray().map((element) => normalizedText(book(element).text())),
    sourceBook(selector).toArray().map((element) => normalizedText(sourceBook(element).text())),
    `book changed original content: ${selector}`,
  );
}
for (const selector of [".chapter[id]", ".question-title[id]", ".bibliography li[id]"]) {
  assert.deepEqual(
    book(selector).toArray().map((element) => book(element).attr("id")),
    sourceBook(selector).toArray().map((element) => sourceBook(element).attr("id")),
    `book changed original anchors: ${selector}`,
  );
}
for (const selector of [".source-ref a", ".bibliography a"]) {
  assert.deepEqual(
    book(selector).toArray().map((element) => book(element).attr("href")),
    sourceBook(selector).toArray().map((element) => sourceBook(element).attr("href")),
    `book changed original source links: ${selector}`,
  );
}
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
  `${expectedTranscripts} Chinese articles with ${transcriptParagraphCount} complete source paragraphs, ` +
  `${indexableUrls.length} canonical URLs, ${videoUrls.length} videos, 1 complete book`,
);
