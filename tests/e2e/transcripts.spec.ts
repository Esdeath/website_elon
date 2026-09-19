import { expect, test, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import type { VideoEntry } from "../../src/lib/types";

const VIDEO_DIRECTORY = new URL("../../src/content/videos/", import.meta.url);
const ENTRIES = readdirSync(VIDEO_DIRECTORY)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(new URL(name, VIDEO_DIRECTORY), "utf8")) as VideoEntry);
const TIMED = ENTRIES.find((entry) => entry.slug === "falcon-9-droneship-landing-2016-04-08")!;
const LONG = ENTRIES.find((entry) => entry.slug === "lex-fridman-438-musk-2024")!;
const NO_EMBED = ENTRIES.find((entry) => entry.slug === "forbes-jim-clash-2014")!;
const CATALOG = "/transcripts/";
const readerPath = (entry: VideoEntry) => `${CATALOG}${entry.slug}/`;
const visibleCards = (page: Page) => page.locator("[data-transcript-card]:not([hidden])");

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, `页面宽度 ${dimensions.document}px 超过视口 ${dimensions.viewport}px`)
    .toBeLessThanOrEqual(dimensions.viewport + 1);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      await route.abort();
      return;
    }
    await route.continue();
  });
});

test("文字稿目录静态收录 273 篇并默认显示 24 篇", async ({ page }) => {
  expect(ENTRIES).toHaveLength(273);
  const response = await page.goto(CATALOG);
  expect(response?.ok()).toBe(true);
  const html = await response!.text();
  expect(html.match(/\bdata-transcript-card(?:\s|=|>)/g)).toHaveLength(ENTRIES.length);
  await expect(page.locator("[data-transcript-card]")).toHaveCount(ENTRIES.length);
  await expect(page.locator("[data-transcript-count]")).toHaveText(String(ENTRIES.length));
  await expect(visibleCards(page)).toHaveCount(24);
  const links = await page.locator("[data-transcript-card] h2 a")
    .evaluateAll((items) => items.map((item) => item.getAttribute("href")));
  expect(new Set(links)).toEqual(new Set(ENTRIES.map(readerPath)));
  await expectNoHorizontalOverflow(page);
});

test("类别年份与排序写入分享链接，刷新恢复且可清除", async ({ page }) => {
  await page.goto(CATALOG);
  const form = page.locator("[data-transcript-filters]");
  await form.locator('select[name="type"]').selectOption("interview");
  await form.locator('select[name="year"]').selectOption("2024");
  await form.locator('select[name="sort"]').selectOption("oldest");
  await expect.poll(() => new URL(page.url()).searchParams.get("type")).toBe("interview");
  await expect.poll(() => new URL(page.url()).searchParams.get("year")).toBe("2024");
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("oldest");
  const expected = ENTRIES.filter((entry) => entry.type === "interview" && entry.date.startsWith("2024"));
  await expect(page.locator("[data-transcript-count]")).toHaveText(String(expected.length));
  const dates = await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-date")));
  expect(dates).toEqual(expected.map((entry) => entry.date).sort().slice(0, 24));

  await page.reload();
  await expect(form.locator('select[name="type"]')).toHaveValue("interview");
  await expect(form.locator('select[name="year"]')).toHaveValue("2024");
  await expect(form.locator('select[name="sort"]')).toHaveValue("oldest");
  await expect(page.locator("[data-transcript-count]")).toHaveText(String(expected.length));
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await expect(form.locator('select[name="type"]')).toHaveValue("all");
  await expect(form.locator('select[name="year"]')).toHaveValue("all");
  await expect(form.locator('select[name="sort"]')).toHaveValue("newest");
  await expect(page.locator("[data-transcript-count]")).toHaveText(String(ENTRIES.length));
});

test("目录可搜索标题摘要并显示无结果状态", async ({ page }) => {
  await page.goto(CATALOG);
  const input = page.getByRole("searchbox", { name: "查找文字稿", exact: true });
  const query = "无人船着陆";
  await input.fill(query);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(query);
  await expect(visibleCards(page).locator(`a[href="${readerPath(TIMED)}"]`)).toBeVisible();
  const searchTexts = await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-search")));
  expect(searchTexts.length).toBeGreaterThan(0);
  expect(searchTexts.every((text) => text?.includes(query))).toBe(true);
  await page.reload();
  await expect(input).toHaveValue(query);
  await expect(visibleCards(page).locator(`a[href="${readerPath(TIMED)}"]`)).toBeVisible();

  await input.fill("CRS-8");
  await expect(visibleCards(page).locator(`a[href="${readerPath(TIMED)}"]`)).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("CRS-8");
  await input.fill("SpaceX");
  const expectedSpaceX = ENTRIES.filter((entry) => `${entry.titleZh} ${entry.summaryZh} ${entry.org || ""}`.toLowerCase().includes("spacex"));
  await expect(page.locator("[data-transcript-count]")).toHaveText(String(expectedSpaceX.length));

  await input.fill("不存在的文字稿测试关键词-zzzzzz");
  await expect(page.locator("[data-transcript-count]")).toHaveText("0");
  await expect(visibleCards(page)).toHaveCount(0);
  await expect(page.locator("[data-transcript-empty]")).toBeVisible();
  await expect(page.locator("[data-transcript-pagination]")).toBeHidden();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(visibleCards(page)).toHaveCount(24);
});

test("文字稿分页刷新后保留页码，上一页恢复首批文章", async ({ page }) => {
  await page.goto(CATALOG);
  const firstPageLinks = await visibleCards(page).locator("h2 a")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  await page.locator("[data-transcript-next]").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe("2");
  await expect(page.locator("[data-transcript-page]")).toContainText("第 2 /");
  await expect(visibleCards(page)).toHaveCount(24);
  const secondPageLink = await visibleCards(page).first().locator("h2 a").getAttribute("href");
  expect(firstPageLinks).not.toContain(secondPageLink);
  await page.reload();
  await expect(page.locator("[data-transcript-page]")).toContainText("第 2 /");
  await expect(visibleCards(page).first().locator("h2 a")).toHaveAttribute("href", secondPageLink!);
  await page.locator("[data-transcript-prev]").click();
  await expect.poll(() => new URL(page.url()).searchParams.has("page")).toBe(false);
  await expect(visibleCards(page).first().locator("h2 a")).toHaveAttribute("href", firstPageLinks[0]!);
  await expect(page.locator("[data-transcript-prev]")).toBeDisabled();
});

test("主导航与目录可进入独立正文并往返对应影像", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  const transcriptNav = nav.getByRole("link", { name: "中文文字稿", exact: true });
  await expect(transcriptNav).toHaveAttribute("href", CATALOG);
  await transcriptNav.click();
  await expect(transcriptNav).toHaveAttribute("aria-current", "page");
  await page.getByRole("searchbox", { name: "查找文字稿", exact: true }).fill("无人船着陆");
  await visibleCards(page).locator(`a[href="${readerPath(TIMED)}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${readerPath(TIMED)}$`));
  await expect(transcriptNav).toHaveAttribute("aria-current", "page");
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await page.getByRole("link", { name: "查看影像与英文", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/videos/${TIMED.slug}/$`));
  await expect(nav.getByRole("link", { name: "影像目录", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "阅读独立中文文字稿", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${readerPath(TIMED)}$`));
  await page.getByRole("link", { name: "全部中文文字稿", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${CATALOG}$`));
});

for (const [label, entry] of [["带时间戳", TIMED], ["最长篇", LONG], ["无播放器", NO_EMBED]] as const) {
  test(`${label}文字稿逐段保留原中文且不加载播放器或英文块`, async ({ page }) => {
    await page.goto(readerPath(entry));
    await expect(page.locator(".reader-head h1")).toHaveText(entry.titleZh);
    const paragraphs = page.locator(".reading-segment > p");
    await expect(paragraphs).toHaveCount(entry.segments.length);
    expect(await paragraphs.evaluateAll((items) => items.map((item) => item.textContent)))
      .toEqual(entry.segments.map((segment) => segment.textZh));
    expect(await page.locator(".reading-segment").evaluateAll((items) => items.map((item) => item.id)))
      .toEqual(entry.segments.map((segment) => segment.id));
    await expect(page.locator('iframe, [data-lazy-video], [data-lang-block="en"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "English", exact: true })).toHaveCount(0);
    const download = page.getByRole("link", { name: "下载文字稿", exact: true });
    await expect(download).toHaveAttribute("href", `/transcripts/${entry.slug}.md`);
    await expect(download).toHaveAttribute("download", `${entry.slug}.md`);
    await expect(page.locator('.reader-sources a[href="' + entry.sourceUrl + '"]')).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
  });
}

test("段落引用使用原始 ID 并可在刷新后定位", async ({ page }) => {
  const segment = TIMED.segments[1];
  await page.goto(readerPath(TIMED));
  const citation = page.getByRole("link", { name: "引用第 2 段", exact: true });
  await expect(citation).toHaveAttribute("href", `#${segment.id}`);
  await citation.click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#${segment.id}`);
  await expect(page.locator(`#${segment.id}`)).toBeInViewport();
  await page.reload();
  await expect(page.locator(`#${segment.id}`)).toBeInViewport();
  await expect(page.locator(`#${segment.id} > p`)).toHaveText(segment.textZh);
});

test("中文阅读字号可以增减并在刷新后保存", async ({ page }) => {
  await page.goto(readerPath(TIMED));
  const paragraph = page.locator(".reading-segment > p").first();
  const fontSize = () => paragraph.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const original = await fontSize();
  await page.getByRole("button", { name: "放大字号", exact: true }).click();
  await expect.poll(fontSize).toBeGreaterThan(original);
  const enlarged = await fontSize();
  await page.reload();
  await expect.poll(fontSize).toBe(enlarged);
  await page.getByRole("button", { name: "缩小字号", exact: true }).click();
  await expect.poll(fontSize).toBe(original);
  await page.reload();
  await expect.poll(fontSize).toBe(original);
  await expectNoHorizontalOverflow(page);
});

test("全文搜索入口保留文字稿范围，索引不可用时只返回文字稿", async ({ page }) => {
  await page.route((url) => url.pathname === "/pagefind/pagefind.js", (route) => route.abort());
  await page.goto(CATALOG);
  await page.getByRole("link", { name: "搜索文字稿全文", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("transcripts");
  await expect(page.locator('select[name="scope"]')).toHaveValue("transcripts");
  const query = page.getByRole("searchbox", { name: "搜索中文标题与正文", exact: true });
  await query.fill("无人船着陆");
  await query.press("Enter");
  await expect(page.locator("[data-search-status]")).toContainText(/找到 \d+ 条结果/);
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("transcripts");
  const results = page.locator("[data-search-results] a");
  expect(await results.count()).toBeGreaterThan(0);
  expect(await results.evaluateAll((links) => links.every((link) => new URL((link as HTMLAnchorElement).href).pathname.startsWith("/transcripts/"))))
    .toBe(true);
  await expect(page.locator(`[data-search-results] a[href="${readerPath(TIMED)}"]`)).toBeVisible();
  await page.reload();
  await expect(page.locator('select[name="scope"]')).toHaveValue("transcripts");
  await expect(query).toHaveValue("无人船着陆");
  await expect(page.locator("[data-search-status]")).toContainText(/找到 \d+ 条结果/);
  await expectNoHorizontalOverflow(page);
});

test("全文搜索将中文文字稿集合传给 Pagefind 并打开段落链接", async ({ page }) => {
  const segment = TIMED.segments[1];
  const result = {
    url: readerPath(TIMED),
    meta: { title: TIMED.titleZh, date: TIMED.date },
    filters: { collection: ["中文文字稿"], type: ["演讲"] },
    excerpt: segment.textZh,
    sub_results: [{ url: `${readerPath(TIMED)}#${segment.id}`, plain_excerpt: segment.textZh, excerpt: segment.textZh }],
  };
  await page.route((url) => url.pathname === "/pagefind/pagefind.js", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: `export async function init() {}\nexport async function search(query, options) { window.__transcriptSearchOptions = options; return { results: [{ data: async () => (${JSON.stringify(result)}) }] }; }`,
  }));
  await page.goto(`/search/?scope=transcripts&q=${encodeURIComponent("无人船着陆")}`);
  await expect(page.locator("[data-search-status]")).toContainText("找到 1 条结果");
  const options = await page.evaluate(() => (window as unknown as { __transcriptSearchOptions: { filters: { collection: string } } }).__transcriptSearchOptions);
  expect(options.filters.collection).toBe("中文文字稿");
  await page.locator(`[data-search-results] a[href="${readerPath(TIMED)}#${segment.id}"]`).click();
  await expect(page.locator(`#${segment.id}`)).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});
