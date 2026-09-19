const form = document.querySelector<HTMLFormElement>("[data-transcript-filters]");
const list = document.querySelector<HTMLElement>("[data-transcript-list]");

if (form && list) {
  const cards = [...list.querySelectorAll<HTMLElement>("[data-transcript-card]")];
  const count = document.querySelector<HTMLElement>("[data-transcript-count]")!;
  const pageText = document.querySelector<HTMLElement>("[data-transcript-page]")!;
  const empty = document.querySelector<HTMLElement>("[data-transcript-empty]")!;
  const pagination = document.querySelector<HTMLElement>("[data-transcript-pagination]")!;
  const prev = document.querySelector<HTMLButtonElement>("[data-transcript-prev]")!;
  const next = document.querySelector<HTMLButtonElement>("[data-transcript-next]")!;
  const label = document.querySelector<HTMLElement>("[data-transcript-page-label]")!;
  const query = form.elements.namedItem("q") as HTMLInputElement;
  const pageSize = 24;
  let page = 1;

  const readUrl = () => {
    const params = new URLSearchParams(location.search);
    query.value = params.get("q") || "";
    for (const name of ["type", "year", "sort"]) {
      const select = form.elements.namedItem(name) as HTMLSelectElement;
      const value = params.get(name);
      select.value = [...select.options].some((option) => option.value === value) ? value! : select.options[0].value;
    }
    page = Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1);
  };

  const render = (syncUrl = true) => {
    const data = new FormData(form);
    const terms = query.value.trim().toLocaleLowerCase("zh-CN").split(/\s+/).filter(Boolean);
    const matches = cards.filter((card) =>
      (data.get("type") === "all" || data.get("type") === card.dataset.type)
      && (data.get("year") === "all" || data.get("year") === card.dataset.year)
      && terms.every((term) => card.dataset.search?.includes(term)),
    );
    matches.sort((a, b) => (a.dataset.date || "").localeCompare(b.dataset.date || "") * (data.get("sort") === "oldest" ? 1 : -1));
    matches.forEach((card) => list.append(card));
    const pages = Math.max(1, Math.ceil(matches.length / pageSize));
    page = Math.min(page, pages);
    const visible = new Set(matches.slice((page - 1) * pageSize, page * pageSize));
    cards.forEach((card) => card.hidden = !visible.has(card));
    count.textContent = String(matches.length);
    pageText.textContent = matches.length ? `第 ${page} / ${pages} 页` : "";
    label.textContent = `第 ${page} / ${pages} 页`;
    empty.hidden = matches.length > 0;
    pagination.hidden = pages <= 1;
    prev.disabled = page === 1;
    next.disabled = page === pages;
    if (syncUrl) {
      const params = new URLSearchParams();
      for (const [name, value] of data.entries()) {
        const text = String(value).trim();
        if (text && (name === "q" || text !== (name === "sort" ? "newest" : "all"))) params.set(name, text);
      }
      if (page > 1) params.set("page", String(page));
      history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    }
  };

  const filter = () => { page = 1; render(); };
  form.addEventListener("submit", (event) => { event.preventDefault(); filter(); });
  form.addEventListener("change", (event) => {
    // Search already updates on input. Reordering links on blur can cancel the click that caused it.
    if (event.target instanceof HTMLSelectElement) filter();
  });
  query.addEventListener("input", filter);
  form.addEventListener("reset", () => requestAnimationFrame(filter));
  const turnPage = (offset: number) => {
    page += offset;
    render();
    document.getElementById("transcript-results")?.focus({ preventScroll: true });
    document.getElementById("transcript-results")?.scrollIntoView({ block: "start" });
  };
  prev.addEventListener("click", () => turnPage(-1));
  next.addEventListener("click", () => turnPage(1));
  window.addEventListener("popstate", () => { readUrl(); render(false); });
  readUrl();
  render(false);
}
