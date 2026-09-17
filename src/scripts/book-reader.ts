function initBookReader() {
  const root = document.documentElement;
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const main = document.querySelector<HTMLElement>("main.reader");
  const dialog = document.querySelector<HTMLDialogElement>("#searchDialog");
  const input = document.querySelector<HTMLInputElement>("#searchInput");
  const results = document.querySelector<HTMLOListElement>("#searchResults");
  const status = document.querySelector<HTMLElement>("#searchStatus");
  const menu = document.querySelector<HTMLButtonElement>("#menuToggle");
  const backdrop = document.querySelector<HTMLButtonElement>("#menuBackdrop");
  if (!sidebar || !main || !dialog || !input || !results || !status || !menu || !backdrop) return;

  root.classList.add("reader-enhanced");
  const mobile = matchMedia("(max-width: 860px)");
  const storagePrefix = "elon:first-principles:";
  const readSaved = (key: string) => {
    try { return localStorage.getItem(storagePrefix + key); } catch { return null; }
  };
  const save = (key: string, value: string) => {
    try { localStorage.setItem(storagePrefix + key, value); } catch { /* Reading works without storage. */ }
  };

  const down = document.querySelector<HTMLButtonElement>("#fontDown");
  const up = document.querySelector<HTMLButtonElement>("#fontUp");
  const savedSize = Number(readSaved("size"));
  let fontSize = savedSize >= 15 && savedSize <= 23 ? savedSize : (mobile.matches ? 17 : 18);
  const setSize = (value: number) => {
    fontSize = Math.min(23, Math.max(15, value));
    root.style.setProperty("--reader-size", `${fontSize}px`);
    if (down) down.disabled = fontSize === 15;
    if (up) up.disabled = fontSize === 23;
    const announcement = document.querySelector("#fontStatus");
    if (announcement) announcement.textContent = `正文字号 ${fontSize}`;
    save("size", String(fontSize));
  };
  setSize(fontSize);
  down?.addEventListener("click", () => setSize(fontSize - 1));
  up?.addEventListener("click", () => setSize(fontSize + 1));

  const setMenu = (open: boolean, restoreFocus = false) => {
    const expanded = mobile.matches && open;
    sidebar.classList.toggle("open", expanded);
    sidebar.inert = mobile.matches && !expanded;
    main.inert = expanded;
    backdrop.hidden = !expanded;
    menu.setAttribute("aria-expanded", String(expanded));
    root.classList.toggle("reader-menu-open", expanded);
    if (expanded) sidebar.querySelector<HTMLElement>("#menuClose")?.focus();
    else if (restoreFocus && mobile.matches) menu.focus();
  };
  setMenu(false);
  menu.addEventListener("click", () => setMenu(menu.getAttribute("aria-expanded") !== "true"));
  document.querySelector("#menuClose")?.addEventListener("click", () => setMenu(false, true));
  backdrop.addEventListener("click", () => setMenu(false, true));
  mobile.addEventListener("change", () => setMenu(false));
  sidebar.addEventListener("keydown", (event) => {
    if (!mobile.matches || menu.getAttribute("aria-expanded") !== "true") return;
    if (event.key === "Escape") { event.preventDefault(); setMenu(false, true); }
    if (event.key !== "Tab") return;
    const focusable = Array.from(sidebar.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)"))
      .filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });

  const targetForHash = () => {
    try { return document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { return null; }
  };
  const revealHash = () => {
    const target = targetForHash();
    if (!target) return;
    const details = target.closest("details");
    if (details) details.open = true;
    setMenu(false);
  };
  addEventListener("hashchange", revealHash);
  revealHash();
  sidebar.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", () => setMenu(false, true));
  });

  const resumeId = readSaved("position");
  const resumeTarget = resumeId ? document.getElementById(resumeId) : null;
  if (resumeTarget?.closest(".chapter")) {
    document.querySelectorAll<HTMLAnchorElement>(".reader-resume").forEach((link) => {
      link.href = `#${resumeTarget.id}`;
      const chapter = resumeTarget.closest<HTMLElement>(".chapter");
      link.textContent = `继续阅读：${chapter?.dataset.title || "上次位置"}`;
      link.hidden = false;
    });
  }

  const toc = Array.from(sidebar.querySelectorAll<HTMLAnchorElement>(".toc-group a"));
  const positions = Array.from(main.querySelectorAll<HTMLElement>(".chapter[id], .question-title[id], .bibliography li[id]"));
  const progress = document.querySelector<HTMLElement>(".progress span");
  const progressText = document.querySelector("#readingPosition");
  const mobileTitle = document.querySelector<HTMLElement>("#mobileTitle");
  const bookTitle = main.querySelector(".book-front h1")?.textContent || "第一性原理";
  let currentPosition = "";
  let frame = 0;
  const updatePosition = () => {
    frame = 0;
    const available = root.scrollHeight - innerHeight;
    const percent = Math.round(Math.min(100, Math.max(0, available > 0 ? scrollY / available * 100 : 0)));
    if (progress) progress.style.width = `${percent}%`;
    if (progressText) progressText.textContent = `阅读进度 ${percent}%`;
    const readingLine = mobile.matches ? 120 : 90;
    let low = 0;
    let high = positions.length - 1;
    let index = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (positions[middle].getBoundingClientRect().top <= readingLine) { index = middle; low = middle + 1; }
      else high = middle - 1;
    }
    const current = positions[index];
    const chapter = current?.closest<HTMLElement>(".chapter");
    toc.forEach((link) => {
      const active = link.hash === `#${chapter?.id}`;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
    if (mobileTitle) mobileTitle.textContent = chapter?.dataset.title || bookTitle;
    if (current && current.id !== currentPosition) {
      currentPosition = current.id;
      save("position", currentPosition);
    }
  };
  const queuePosition = () => { if (!frame) frame = requestAnimationFrame(updatePosition); };
  addEventListener("scroll", queuePosition, { passive: true });
  addEventListener("resize", queuePosition);
  addEventListener("pagehide", updatePosition);
  queuePosition();

  // Map every paragraph to its existing question/section anchor, including later answer paragraphs.
  const searchEntries = Array.from(main.querySelectorAll<HTMLElement>(".chapter-body > h2, .chapter-body > h3, .chapter-body > p, .bibliography li"))
    .filter((element) => !element.classList.contains("source-ref"))
    .map((element) => {
      const chapter = element.closest<HTMLElement>(".chapter");
      let preceding: Element | null = element;
      while (preceding && !preceding.id) preceding = preceding.previousElementSibling;
      return { id: preceding?.id || chapter?.id || "top", title: chapter?.dataset.title || "正文", text: element.textContent?.trim() || "" };
    });
  const runSearch = () => {
    const query = input.value.trim().toLocaleLowerCase();
    results.replaceChildren();
    if (query.length < 2) { status.textContent = "输入至少两个字开始检索"; return; }
    const found = new Set<string>();
    for (const entry of searchEntries) {
      const index = entry.text.toLocaleLowerCase().indexOf(query);
      if (index < 0 || found.has(entry.id)) continue;
      found.add(entry.id);
      const item = document.createElement("li");
      const link = document.createElement("a");
      const heading = document.createElement("strong");
      const detail = document.createElement("span");
      link.href = `#${entry.id}`;
      heading.textContent = entry.title;
      const start = Math.max(0, index - 30);
      detail.textContent = `${start ? "…" : ""}${entry.text.slice(start, start + 120)}${entry.text.length > start + 120 ? "…" : ""}`;
      link.append(heading, detail);
      link.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        dialog.close();
        setMenu(false);
        const target = document.getElementById(entry.id);
        if (target) {
          history.pushState(null, "", `#${entry.id}`);
          // Let the dialog finish restoring focus before moving into the long document.
          requestAnimationFrame(() => {
            target.tabIndex = -1;
            target.focus({ preventScroll: true });
            target.scrollIntoView({ behavior: "instant", block: "start" });
          });
        }
      });
      item.append(link);
      results.append(item);
      if (found.size === 50) break;
    }
    status.textContent = found.size === 50 ? "显示前 50 条结果" : `找到 ${found.size} 条结果`;
  };
  const openSearch = () => {
    setMenu(false);
    dialog.showModal();
    input.focus();
  };
  document.querySelector("#searchOpen")?.addEventListener("click", openSearch);
  document.querySelector("#mobileSearch")?.addEventListener("click", openSearch);
  input.addEventListener("input", runSearch);
  dialog.addEventListener("close", () => { input.value = ""; runSearch(); });
  let printDetails: HTMLDetailsElement[] = [];
  addEventListener("beforeprint", () => {
    printDetails = Array.from(document.querySelectorAll<HTMLDetailsElement>("details:not([open])"));
    printDetails.forEach((element) => element.open = true);
  });
  addEventListener("afterprint", () => printDetails.forEach((element) => element.open = false));
}

initBookReader();
