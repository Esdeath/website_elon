import { expect, test, type Page } from "@playwright/test";

const BOOK = "/books/first-principles/";
const FIRST_QUESTION = "chapter-01-question-01";

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function showReaderControls(page: Page) {
  const menu = page.locator("#menuToggle");
  if (await menu.isVisible()) {
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
  }
}

test("首页和主导航可直接进入完整电子书并返回影像目录", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "读书", exact: true }))
    .toHaveAttribute("href", BOOK);
  await page.locator(".book-feature").getByRole("link", { name: "阅读全文", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${BOOK}$`));
  await expect(page.locator(".book-front h1")).toContainText("第一性原理");
  await expect(page.locator('.chapter[id^="chapter-"]')).toHaveCount(20);
  await expect(page.locator(".chapter#sources")).toHaveCount(1);
  await expect(page.locator(".question-title")).toHaveCount(903);
  await expect(page.locator(".answer")).toHaveCount(903);
  await expect(page.locator(".bibliography li")).toHaveCount(92);
  await expectNoHorizontalOverflow(page);

  await showReaderControls(page);
  await page.locator(".reader-home").first().click();
  await expect(page).toHaveURL(/\/$/);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.locator(".book-feature")).toBeVisible();
});

test("目录定位章节且手机选择后关闭侧栏", async ({ page }) => {
  await page.goto(BOOK);
  await showReaderControls(page);
  await page.locator('.sidebar .toc-group a[href="#chapter-02"]').click();
  await expect(page).toHaveURL(new RegExp(`${BOOK}#chapter-02$`));
  await expect(page.locator("#chapter-02 .chapter-header")).toBeInViewport();
  if (await page.locator("#menuToggle").isVisible()) {
    await expect(page.locator("#menuToggle")).toHaveAttribute("aria-expanded", "false");
    const sidebar = await page.locator(".sidebar").boundingBox();
    expect(sidebar).not.toBeNull();
    expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(1);
  }
  await expectNoHorizontalOverflow(page);
});

test("书内搜索覆盖回答后续段落并生成刷新稳定的问答链接", async ({ page }) => {
  await page.goto(BOOK);
  const mobileSearch = page.locator("#mobileSearch");
  await (await mobileSearch.isVisible() ? mobileSearch : page.locator("#searchOpen")).click();
  await expect(page.locator("#searchDialog")).toBeVisible();
  await page.locator("#searchInput").fill("效用曲线");
  const result = page.locator(`#searchResults a[href="#${FIRST_QUESTION}"]`).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.locator("#searchDialog")).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${BOOK}#${FIRST_QUESTION}$`));
  await expect(page.locator(`#${FIRST_QUESTION}`)).toBeInViewport();
  await page.reload();
  await expect(page.locator(`#${FIRST_QUESTION}`)).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test("字号刷新后保留且来源链接可直接定位附录", async ({ page }) => {
  await page.goto(`${BOOK}#${FIRST_QUESTION}`);
  const answer = page.locator(`#${FIRST_QUESTION} + .answer`);
  const initialFontSize = await answer.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  await showReaderControls(page);
  await page.locator("#fontUp").click();
  await expect.poll(() => answer.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)))
    .toBeGreaterThan(initialFontSize);
  const enlargedFontSize = await answer.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  await page.reload();
  await expect.poll(() => answer.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)))
    .toBe(enlargedFontSize);

  await page.locator(".source-ref a").first().click();
  await expect(page).toHaveURL(new RegExp(`${BOOK}#source-001$`));
  await expect(page.locator(".bibliography #source-001")).toBeInViewport();
  await page.reload();
  await expect(page.locator(".bibliography #source-001")).toBeInViewport();
  await expect(page.locator("#source-001 .source-url")).toHaveAttribute("href", /^https:\/\//);
  await expectNoHorizontalOverflow(page);
});

test("全站搜索能找到电子书并打开阅读页", async ({ page }) => {
  await page.goto(`/search/?q=${encodeURIComponent("创业与管理问答录")}`);
  await expect(page.locator("[data-search-status]")).toContainText(/找到 \d+ 条结果/);
  const result = page.locator(`[data-search-results] a[href^="${BOOK}"]`).first();
  await expect(result).toContainText("第一性原理");
  await result.click();
  expect(new URL(page.url()).pathname).toBe(BOOK);
  await expect(page.locator(".book-front h1")).toContainText("第一性原理");
});

test("返回阅读页可继续上次位置且明确的问答链接优先", async ({ page }) => {
  const savedQuestion = "chapter-02-question-05";
  await page.goto(`${BOOK}#${savedQuestion}`);
  await expect(page.locator(`#${savedQuestion}`)).toBeInViewport();
  await expect(page.locator('.toc-group a[href="#chapter-02"]')).toHaveAttribute("aria-current", "location");
  await showReaderControls(page);
  await page.locator(".reader-home").first().click();
  await page.locator(".book-feature").getByRole("link", { name: "阅读全文", exact: true }).click();
  await expect(page.locator(".book-front h1")).toBeInViewport();
  const resume = page.locator(".book-front .reader-resume");
  await expect(resume).toHaveAttribute("href", `#${savedQuestion}`);
  await resume.click();
  await expect(page.locator(`#${savedQuestion}`)).toBeInViewport();
  await page.goto(`${BOOK}#${FIRST_QUESTION}`);
  await expect(page).toHaveURL(new RegExp(`${BOOK}#${FIRST_QUESTION}$`));
  await expect(page.locator(`#${FIRST_QUESTION}`)).toBeInViewport();
});
