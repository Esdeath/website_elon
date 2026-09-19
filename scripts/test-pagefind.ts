import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";

const distDir = resolve(process.cwd(), "dist");
const contentTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

interface SmokeFixture {
  query: string;
  slug: string;
  anchor: string;
}

async function findSmokeFixtures(): Promise<SmokeFixture[]> {
  const videoDir = resolve(distDir, "videos");
  const segments: Array<SmokeFixture & { text: string }> = [];
  for (const directory of (await readdir(videoDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (!directory.isDirectory()) continue;
    const $ = load(await readFile(resolve(videoDir, directory.name, "index.html"), "utf8"));
    $("h3[id^='segment-']").each((_index, element) => {
      const anchor = $(element).attr("id") ?? "";
      if (!/^segment-\d+$/.test(anchor)) return;
      segments.push({
        query: "",
        slug: directory.name,
        anchor,
        text: $(element).closest("article").text().replace(/\s+/g, " ").trim(),
      });
    });
  }
  const corpus = segments.map(({ text }) => text).join("\n");
  const fixtures: SmokeFixture[] = [];

  for (const segment of segments) {
    for (const sequence of segment.text.match(/\p{Script=Han}{8,}/gu) ?? []) {
      const query = sequence.slice(0, 12);
      if (corpus.indexOf(query) !== corpus.lastIndexOf(query)) continue;
      fixtures.push({ query, slug: segment.slug, anchor: segment.anchor });
      if (fixtures.length >= 50) return fixtures;
    }
  }
  if (fixtures.length === 0) {
    throw new Error("No unique Chinese transcript phrase is available for the Pagefind smoke test");
  }
  return fixtures;
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const path = resolve(distDir, `.${pathname}`);
    if (!path.startsWith(`${distDir}/`)) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(path);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

// Keep connections alive while Pagefind processes the preceding large query results.
server.keepAliveTimeout = 60_000;

await new Promise<void>((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});

try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start search test server");
  const pagefind = await import(
    pathToFileURL(resolve(distDir, "pagefind/pagefind.js")).href
  );
  await pagefind.options({
    basePath: `http://127.0.0.1:${address.port}/pagefind/`,
  });
  await pagefind.init();
  const passed: SmokeFixture[] = [];
  const diagnostics: string[] = [];
  for (const fixture of await findSmokeFixtures()) {
    const result = await pagefind.search(fixture.query, { excerptLength: 34 });
    const records = await Promise.all(
      result.results.map((item: { data: () => Promise<any> }) => item.data()),
    );
    const expected = records.find(
      (record: any) =>
        String(record.url).includes(`/videos/${fixture.slug}/`) &&
        String(record.content).includes(fixture.query),
    );
    const matchingSubResult = expected?.sub_results?.find((subResult: any) =>
      String(subResult.plain_excerpt).includes(fixture.query),
    );
    const resultAnchor = String(matchingSubResult?.url ?? "").split("#")[1];
    if (matchingSubResult && resultAnchor !== fixture.anchor) {
      throw new Error(
        `Pagefind linked ${fixture.query} to #${resultAnchor || "none"}, expected #${fixture.anchor}`,
      );
    }
    if (resultAnchor === fixture.anchor) {
      passed.push(fixture);
      if (passed.length >= 5) break;
      continue;
    }
    if (diagnostics.length < 3) {
      diagnostics.push(JSON.stringify({
        fixture,
        resultCount: records.length,
        expectedUrl: expected?.url,
        subResultCount: expected?.sub_results?.length,
        resultAnchor,
      }));
    }
  }
  if (passed.length < 5) {
    throw new Error(
      `Pagefind did not return a Chinese transcript result at its segment anchor: ${diagnostics.join("; ")}`,
    );
  }
  const bookQuery = "效用曲线";
  const bookSearch = await pagefind.search(bookQuery, { excerptLength: 34 });
  const bookResults = await Promise.all(
    bookSearch.results.map((item: { data: () => Promise<any> }) => item.data()),
  );
  const book = bookResults.find((record: any) => String(record.url).includes("/books/first-principles/"));
  const bookExcerpt = book?.sub_results?.find((result: any) => String(result.plain_excerpt).includes(bookQuery));
  if (!bookExcerpt || !String(bookExcerpt.url).endsWith("/books/first-principles/#chapter-01-question-01")) {
    throw new Error(`Pagefind did not return the book's full text at its question anchor: ${JSON.stringify({
      query: bookQuery,
      resultCount: bookResults.length,
      bookUrl: book?.url,
      excerptUrl: bookExcerpt?.url,
    })}`);
  }
  console.log(`[pagefind] ${passed.length} Chinese transcript queries returned exact segment anchors`);
  for (const fixture of passed) {
    const result = await pagefind.search(fixture.query, { filters: { collection: "中文文字稿" }, excerptLength: 34 });
    const records = await Promise.all(result.results.map((item: { data: () => Promise<any> }) => item.data()));
    if (!records.length || records.some((record: any) => !new URL(record.url, "http://localhost").pathname.startsWith("/transcripts/"))) {
      throw new Error(`Scoped transcript search returned missing or non-transcript results for ${fixture.query}`);
    }
    const record = records.find((item: any) => String(item.url).includes(`/transcripts/${fixture.slug}/`));
    const match = record?.sub_results?.find((item: any) => String(item.plain_excerpt).includes(fixture.query));
    if (String(match?.url).split("#")[1] !== fixture.anchor) {
      throw new Error(`Chinese article search did not link to ${fixture.slug}#${fixture.anchor}`);
    }
  }
  console.log(`[pagefind] ${passed.length} scoped Chinese article queries returned exact segment anchors`);
  console.log("[pagefind] book full-text query returned its exact question anchor");
} finally {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}
