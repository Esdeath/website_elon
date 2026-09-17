import { load } from "cheerio";

/** Prepare the supplied book at build time; its text and stable links remain intact. */
export function prepareBook(source: string): { html: string; css: string } {
  const $ = load(source);
  const css = $("style").map((_, element) => $(element).html() || "").get().join("\n")
    .replaceAll(".chapter-header h1", ".chapter-header h2");

  $("script, style").remove();
  $("*").each((_, element) => {
    if (element.type !== "tag") return;
    for (const name of Object.keys(element.attribs)) {
      if (name.toLowerCase().startsWith("on")) $(element).removeAttr(name);
    }
  });
  $(".chapter-header h1").each((_, element) => { element.tagName = "h2"; });
  $("main.reader").attr({ id: "main-content", "data-pagefind-body": "", "data-pagefind-meta": "type:电子书", "data-pagefind-filter": "type:电子书" });
  $(".book-front h1").attr("data-pagefind-meta", "title");
  const title = $(".book-front h1").text();
  const separator = title.indexOf("：");
  if (separator >= 0) {
    $(".book-front h1").empty()
      .append($("<span>").text(title.slice(0, separator + 1)))
      .append($("<span class='reader-book-subtitle'>").text(title.slice(separator + 1)));
  }
  $(".sidebar, .mobile-bar, .progress, .chapter-nav, dialog").attr("data-pagefind-ignore", "");
  $(".sidebar").attr("id", "book-toc");
  $(".sidebar > nav").attr("aria-label", "全书章节");
  $("#menuToggle").attr({ "aria-controls": "book-toc", "aria-expanded": "false" });
  $("#searchOpen, #mobileSearch").attr({ "aria-haspopup": "dialog", "aria-controls": "searchDialog" });
  $("#searchInput").attr("aria-describedby", "searchStatus");
  $("#searchStatus").attr({ role: "status", "aria-live": "polite" });
  $("#searchDialog").prepend('<h2 class="reader-sr-only" id="searchLabel">搜索全书</h2>');
  $(".search-head").prepend('<label class="reader-sr-only" for="searchInput">搜索问题、回答或主题</label>');

  $(".sidebar-brand").before('<div class="reader-sidebar-top"><a class="reader-home" href="/">← 影像目录</a><button class="reader-menu-close reader-js-only" id="menuClose" type="button" aria-label="关闭目录">关闭</button></div>');
  $(".sidebar-actions").after('<a class="reader-resume reader-sidebar-resume" hidden href="#chapter-01">继续上次阅读</a><p class="reader-position reader-js-only" id="readingPosition" aria-live="off">阅读进度 0%</p><p class="reader-sr-only" id="fontStatus" role="status" aria-live="polite"></p>');
  $(".book-meta").after('<div class="reader-front-actions" data-pagefind-ignore><a class="reader-start" href="#chapter-01">开始阅读第一章 <span aria-hidden="true">↓</span></a><a class="reader-resume" hidden href="#chapter-01">继续上次阅读</a></div><p class="reader-saved-note reader-js-only" data-pagefind-ignore>阅读位置与字号保存在当前浏览器，可随时继续。</p>');
  $("body").prepend('<a class="reader-skip" href="#main-content">跳到正文</a><button class="reader-backdrop" id="menuBackdrop" type="button" aria-label="关闭目录" hidden data-pagefind-ignore></button>');

  return { html: $("body").html() || "", css };
}
