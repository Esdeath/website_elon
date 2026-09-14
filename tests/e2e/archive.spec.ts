import { expect, test, type Page } from "@playwright/test";

const TIMED_VIDEO = "/videos/falcon-9-droneship-landing-2016-04-08/";
const NO_EMBED_VIDEO = "/videos/forbes-jim-clash-2014/";
const NO_BODY_VIDEO = "/videos/npc-luncheon-2011/";

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));

  expect(dimensions.document, `页面宽度 ${dimensions.document}px 超过视口 ${dimensions.viewport}px`).toBeLessThanOrEqual(
    dimensions.viewport + 1,
  );
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isLocal = url.hostname === "127.0.0.1" || url.hostname === "localhost";

    if (!isLocal && request.resourceType() === "image") {
      await route.abort();
      return;
    }

    await route.continue();
  });
});

test("中文搜索入口支持键盘提交并返回结果", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();

  const searchbox = page.getByRole("searchbox", { name: "搜索中文标题与正文" });
  await searchbox.focus();
  await page.keyboard.type("无人船着陆");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/search\/\?q=/);

  expect(new URL(page.url()).searchParams.get("q")).toBe("无人船着陆");
  await expect(page.getByRole("searchbox", { name: "搜索中文标题与正文" })).toHaveValue("无人船着陆");
  await expect(page.locator("[data-search-status]")).toContainText(/找到 \d+ 条结果/);
  await expect(page.getByRole("heading", { name: "Falcon 9 无人船着陆" })).toBeVisible();
});

test("首页筛选写入 URL，清除后恢复完整目录", async ({ page }) => {
  await page.goto("/");

  const resultCount = page.locator("[data-result-count]");
  await expect(resultCount).toHaveText("271");
  await expect(page.locator("[data-video-card]:not([hidden])")).toHaveCount(24);

  await page.getByRole("radio", { name: /^访谈/ }).check();
  await expect.poll(() => new URL(page.url()).searchParams.get("type")).toBe("interview");
  const interviewTypes = await page
    .locator("[data-video-card]:not([hidden])")
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-type")));
  expect(interviewTypes.length).toBeGreaterThan(0);
  expect(new Set(interviewTypes)).toEqual(new Set(["interview"]));

  await page.locator('select[name="body"]').selectOption("none");
  await expect.poll(() => new URL(page.url()).searchParams.get("body")).toBe("none");
  const bodyStates = await page
    .locator("[data-video-card]:not([hidden])")
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-body")));
  expect(bodyStates.length).toBeGreaterThan(0);
  expect(new Set(bodyStates)).toEqual(new Set(["none"]));

  await page.getByRole("button", { name: "清除" }).click();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await expect(page.getByRole("radio", { name: /^全部/ })).toBeChecked();
  await expect(resultCount).toHaveText("271");
});

test("分享链接恢复筛选与排序状态", async ({ page }) => {
  await page.goto("/?type=interview&year=2024&org=xAI&body=available&sort=oldest");

  await expect(page.getByRole("radio", { name: /^访谈/ })).toBeChecked();
  await expect(page.locator('select[name="year"]')).toHaveValue("2024");
  await expect(page.locator('select[name="org"]')).toHaveValue("xAI");
  await expect(page.locator('select[name="body"]')).toHaveValue("available");
  await expect(page.locator('select[name="sort"]')).toHaveValue("oldest");

  const records = await page.locator("[data-video-card]:not([hidden])").evaluateAll((cards) =>
    cards.map((card) => ({
      type: card.getAttribute("data-type"),
      year: card.getAttribute("data-year"),
      org: card.getAttribute("data-org"),
      body: card.getAttribute("data-body"),
      date: card.getAttribute("data-date") || "",
    })),
  );
  expect(records.length).toBeGreaterThan(1);
  expect(records.every((record) => record.type === "interview")).toBe(true);
  expect(records.every((record) => record.year === "2024")).toBe(true);
  expect(records.every((record) => record.org === "xAI")).toBe(true);
  expect(records.every((record) => record.body === "available")).toBe(true);
  expect(records.map((record) => record.date)).toEqual([...records.map((record) => record.date)].sort());
});

test("目录每页 24 条并在刷新后保留页码", async ({ page }) => {
  await page.goto("/");

  const visibleCards = page.locator("[data-video-card]:not([hidden])");
  await expect(visibleCards).toHaveCount(24);
  const firstPageHref = await visibleCards.first().locator("h2 a").getAttribute("href");

  await page.locator("[data-page-next]").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe("2");
  await expect(page.locator("[data-result-page]")).toContainText("第 2 /");
  await expect(visibleCards).toHaveCount(24);
  expect(await visibleCards.first().locator("h2 a").getAttribute("href")).not.toBe(firstPageHref);

  await page.reload();
  await expect(page.locator("[data-result-page]")).toContainText("第 2 /");
  await expect(page.locator("[data-page-prev]")).toBeEnabled();
  await page.locator("[data-page-prev]").click();
  await expect.poll(() => new URL(page.url()).searchParams.has("page")).toBe(false);
});

test("详情页中英文切换写入 URL 并可由键盘操作", async ({ page }) => {
  await page.goto(TIMED_VIDEO);

  const chineseTitle = page.locator(".detail-head [data-lang-block='zh']");
  const englishTitle = page.locator(".detail-head [data-lang-block='en']");
  const englishButton = page.getByRole("button", { name: "English", exact: true });
  await expect(chineseTitle).toBeVisible();
  await expect(englishTitle).toBeHidden();

  await englishButton.focus();
  await page.keyboard.press("Enter");
  await expect(englishButton).toHaveAttribute("aria-pressed", "true");
  await expect(englishTitle).toBeVisible();
  await expect(chineseTitle).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(englishTitle).toHaveAttribute("lang", "en");
  await expect(page.locator('.transcript > [data-lang-block="en"]')).toHaveAttribute("lang", "en");
  expect(new URL(page.url()).searchParams.get("lang")).toBe("en");

  await page.reload();
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const chineseButton = page.getByRole("button", { name: "中文", exact: true });
  await chineseButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect.poll(() => new URL(page.url()).searchParams.has("lang")).toBe(false);
});

test("时间戳锚点加载隐私播放器并跳到对应秒数", async ({ page }) => {
  const playerRequests: string[] = [];
  await page.route("https://www.youtube-nocookie.com/**", async (route) => {
    playerRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Test player</title>" });
  });

  await page.goto(TIMED_VIDEO);
  const initialTimestamp = page.locator('[data-lang-block="zh"] [data-seek]').nth(1);
  await expect(initialTimestamp).toBeVisible();
  const anchorId = await initialTimestamp.evaluate(
    (button) => button.closest("article")?.querySelector<HTMLElement>("h3[id]")?.id || "",
  );
  expect(anchorId).toBeTruthy();

  await page.goto(`${TIMED_VIDEO}#${anchorId}`);
  const anchor = page.locator(`#${anchorId}`);
  await expect(anchor).toBeInViewport();

  const timestamp = page.locator(`#${anchorId} + [data-seek]`);
  const seconds = Number(await timestamp.getAttribute("data-seek"));
  await timestamp.click();

  const iframe = page.locator("[data-lazy-video] iframe");
  await expect(iframe).toBeVisible();
  const src = new URL((await iframe.getAttribute("src")) || "");
  expect(src.hostname).toBe("www.youtube-nocookie.com");
  expect(src.searchParams.get("enablejsapi")).toBe("1");
  expect(src.searchParams.get("start")).toBe(String(Math.floor(seconds)));
  await expect.poll(() => playerRequests.length).toBeGreaterThan(0);
});

test("详情保留原始来源和英文档案外链", async ({ page }) => {
  await page.goto(TIMED_VIDEO);

  const source = page.getByRole("link", { name: "原始来源", exact: true });
  const archive = page.getByRole("link", { name: "英文档案页", exact: true });
  await expect(source).toHaveAttribute("href", /^https:\/\//);
  await expect(archive).toHaveAttribute("href", /^https:\/\/elonmuskarchive\.org\//);
  for (const link of [source, archive]) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noreferrer/);
  }
});

test("无正文记录仍显示真实翻译状态", async ({ page }) => {
  await page.goto(NO_BODY_VIDEO);

  await expect(page.locator(".record-note").getByText("暂无正文", { exact: true })).toBeVisible();
  await expect(page.locator(".record-note").getByText("已校对", { exact: true })).toBeVisible();
});

test("无播放器记录只显示原始来源回退", async ({ page }) => {
  await page.goto(NO_EMBED_VIDEO);

  await expect(page.locator(".video-unavailable")).toBeVisible();
  await expect(page.locator("[data-lazy-video]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "打开原始来源", exact: true })).toHaveAttribute(
    "href",
    /^https:\/\/web\.archive\.org\//,
  );
});

test("关键页面不产生横向溢出", async ({ page }) => {
  const paths = [
    "/",
    "/search/?q=%E6%97%A0%E4%BA%BA%E8%88%B9%E7%9D%80%E9%99%86",
    `${TIMED_VIDEO}?lang=en`,
    "/videos/hannity-abbott-musk-2026/?lang=en",
    NO_EMBED_VIDEO,
  ];

  for (const path of paths) {
    await test.step(path, async () => {
      await page.goto(path);
      if (path.startsWith("/search/")) {
        await expect(page.locator("[data-search-status]")).toContainText(/找到 \d+ 条结果/);
      }
      await expectNoHorizontalOverflow(page);
    });
  }
});

test("中间宽度不会裁切卡片页脚或放大长标题", async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 900 });
  await page.goto("/");
  const clippedFooters = await page
    .locator("[data-video-card]:not([hidden])")
    .evaluateAll((cards) =>
      cards.filter((card) => {
        const footer = card.querySelector<HTMLElement>(".card-footer");
        return Boolean(
          footer &&
          footer.getBoundingClientRect().bottom >
            card.getBoundingClientRect().bottom + 1,
        );
      }).length,
    );
  expect(clippedFooters).toBe(0);

  await page.setViewportSize({ width: 620, height: 844 });
  await page.goto("/videos/reddit-ama-iama-2015/");
  const headingSize = await page
    .locator(".detail-head [data-lang-block='zh'] h1")
    .evaluate((heading) => Number.parseFloat(getComputedStyle(heading).fontSize));
  expect(headingSize).toBeLessThanOrEqual(46);
  await expectNoHorizontalOverflow(page);
});
