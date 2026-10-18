/**
 * AI Wire — renders data/news.json as a grid of dispatches.
 *
 * The data file is rewritten hourly by a scheduled job and served from the same
 * origin, so there is no API, no build step and no key. This script only reads,
 * filters, paginates and formats it.
 */

const DATA_URL = "data/news.json";
const REFRESH_MS = 10 * 60 * 1000;
const TICK_MS = 30 * 1000;
const STALE_MS = 90 * 60 * 1000;
const MIN_REFETCH_GAP_MS = 60 * 1000;
/** Cards past this point still animate, but as one batch, so the entrance never drags. */
const ENTER_STAGGER_CAP = 11;
const PAGE_SIZE = 24;

/**
 * Every source the collector can produce. `code` is what a card shows, in a small
 * chip, so it is short; `name` is what the filter tab and the card's meta line
 * show, so it is spelled out. The order below is the order of the tabs, and it is
 * fixed on purpose — sorting by volume would make a source jump around the strip
 * every hour as the news changed.
 */
const SOURCES = {
  hn: { name: "Hacker News", code: "HN" },
  lobsters: { name: "Lobsters", code: "LOB" },
  papers: { name: "Daily Papers", code: "DP" },
  arxiv: { name: "arXiv", code: "arXiv" },
  hf: { name: "Hugging Face", code: "HF" },
  gh: { name: "GitHub", code: "GH" },
  openai: { name: "OpenAI", code: "OAI" },
  deepmind: { name: "DeepMind", code: "DM" },
  googleai: { name: "Google AI", code: "GAI" },
  msr: { name: "Microsoft Research", code: "MSR" },
  nvidia: { name: "NVIDIA", code: "NV" },
  hfblog: { name: "Hugging Face Blog", code: "HFB" },
  tc: { name: "TechCrunch", code: "TC" },
  verge: { name: "The Verge", code: "VZ" },
  ars: { name: "Ars Technica", code: "ARS" },
  mit: { name: "MIT News", code: "MIT" },
  simonw: { name: "Simon Willison", code: "SW" },
  importai: { name: "Import AI", code: "IA" },
  interconnects: { name: "Interconnects", code: "IC" },
};
const ORDER = Object.keys(SOURCES);

const els = {
  wire: document.getElementById("wire"),
  lead: document.getElementById("lead"),
  brief: document.getElementById("brief"),
  count: document.getElementById("count"),
  filters: document.getElementById("filters"),
  state: document.getElementById("state"),
  pulse: document.getElementById("status"),
  note: document.getElementById("note"),
  alert: document.getElementById("alert"),
  more: document.getElementById("more"),
  announcer: document.getElementById("announcer"),
};
const pulseText = els.pulse.querySelector(".pulse__text");

const state = {
  payload: null,
  filter: "all",
  shown: PAGE_SIZE,
  loading: true,
  error: null,
  /** Ids already on screen, so a refresh only animates what is genuinely new. */
  seen: new Set(),
  animateAll: true,
  lastFetch: 0,
};

const nf = new Intl.NumberFormat();

/* --------------------------------------------------------------- helpers */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.filter(Boolean));
  return node;
}

const stamp = (iso) =>
  Number.isFinite(Date.parse(iso))
    ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "";

function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function relWords(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return "less than a minute ago";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const sourceOf = (item) => SOURCES[item.source] || { name: item.source, code: item.source };

function scoreText(item) {
  if (typeof item.score === "number") return `${nf.format(item.score)} ${item.scoreLabel}`;
  return item.meta?.category || "";
}

/**
 * Other sources carrying the same story, named rather than counted. The item's own
 * source is excluded: the same link submitted twice to Hacker News is still just
 * Hacker News, and "Also on Hacker News" on a Hacker News card reads as a bug.
 */
function alsoText(item) {
  if (!item.alsoOn?.length) return "";
  const own = sourceOf(item).name;
  const names = [
    ...new Set(
      item.alsoOn
        .map((id) => SOURCES[String(id).split(":")[0]]?.name)
        .filter((name) => name && name !== own),
    ),
  ];
  if (names.length === 0) return "";
  return `Also on ${names.join(" and ")}`;
}

const timeNode = (item, className) =>
  el("p", {
    class: className,
    "data-time": item.publishedAt,
    title: stamp(item.publishedAt),
    text: relTime(item.publishedAt),
  });

/** A second line for the designed tile, from what the source actually records. */
function tileSub(item) {
  return item.meta?.category || item.meta?.task || item.meta?.language || "";
}

/**
 * Artwork when the source has any, and a designed tile when it does not — the
 * grid keeps its rhythm either way, and a dead preview link degrades to the tile
 * rather than to a broken image.
 */
function media(item, isLead) {
  const wrap = el("div", { class: isLead ? "lead__media" : "story__media" });
  wrap.append(
    el("span", {
      class: isLead ? "lead__mark" : "story__mark",
      "aria-hidden": "true",
      text: sourceOf(item).code,
    }),
  );
  const sub = tileSub(item);
  if (sub) {
    wrap.append(
      el("span", {
        class: isLead ? "lead__mark-sub" : "story__mark-sub",
        "aria-hidden": "true",
        text: sub,
      }),
    );
  }
  if (item.image) {
    const img = el("img", {
      class: isLead ? "lead__img" : "story__img",
      src: item.image,
      alt: "",
      loading: "lazy",
      decoding: "async",
      referrerpolicy: "no-referrer",
    });
    img.addEventListener("error", () => img.remove(), { once: true });
    wrap.append(img);
  }
  return wrap;
}

function link(item, className) {
  return el("a", {
    class: className,
    href: item.url,
    target: "_blank",
    rel: "noopener noreferrer",
  });
}

function leadNode(item) {
  const anchor = link(item, item.image ? "lead__link" : "lead__link lead__link--text");
  const body = el("div", { class: "lead__body" });

  const meta = el("div", { class: "lead__meta" });
  meta.append(el("span", { class: "chip", "aria-hidden": "true", text: sourceOf(item).code }));
  meta.append(el("span", { class: "story__source", text: sourceOf(item).name }));
  meta.append(
    el("span", {
      "data-time": item.publishedAt,
      title: stamp(item.publishedAt),
      text: relTime(item.publishedAt),
    }),
  );
  body.append(meta);

  body.append(el("h2", { class: "lead__title", text: item.title }));
  if (item.blurb) body.append(el("p", { class: "lead__blurb", text: item.blurb }));

  const score = scoreText(item);
  const also = alsoText(item);
  if (score || also) {
    const foot = el("div", { class: "lead__foot" });
    if (score) foot.append(el("span", { text: score }));
    if (also) foot.append(el("span", { text: also }));
    body.append(foot);
  }

  if (item.image) anchor.append(media(item, true));
  anchor.append(body);
  return el("article", { class: "lead" }, anchor);
}

function storyNode(item) {
  const source = sourceOf(item);
  const anchor = link(item, "story__link");

  anchor.append(media(item, false));
  anchor.append(timeNode(item, "story__time"));
  anchor.append(el("h3", { class: "story__title", text: item.title }));
  if (item.blurb) anchor.append(el("p", { class: "story__blurb", text: item.blurb }));

  const foot = el("div", { class: "story__foot" });
  foot.append(el("span", { class: "chip", "aria-hidden": "true", text: source.code }));
  foot.append(el("span", { class: "story__source", text: source.name }));
  const score = scoreText(item);
  if (score) foot.append(el("span", { class: "story__score", text: score }));
  anchor.append(foot);

  const also = alsoText(item);
  if (also) anchor.append(el("p", { class: "story__also", text: also }));

  return el("li", { class: "story" }, anchor);
}

/* ---------------------------------------------------------------- render */

const visible = () => {
  const items = state.payload?.items || [];
  return state.filter === "all" ? items : items.filter((item) => item.source === state.filter);
};

function render({ animate = true } = {}) {
  const list = visible();
  const page = list.slice(0, state.shown);

  els.wire.replaceChildren();
  els.lead.replaceChildren();

  if (page.length > 0) {
    const lead = leadNode(page[0]);
    if (animate && (state.animateAll || !state.seen.has(page[0].id))) {
      lead.classList.add("is-new");
    }
    els.lead.append(lead);
  }
  els.lead.hidden = page.length === 0;

  const fragment = document.createDocumentFragment();
  page.slice(1).forEach((item, i) => {
    const node = storyNode(item);
    if (animate && (state.animateAll || !state.seen.has(item.id))) {
      node.classList.add("is-new");
      node.style.setProperty("--i", String(Math.min(i, ENTER_STAGGER_CAP)));
    }
    fragment.append(node);
  });
  els.wire.append(fragment);

  for (const item of page) state.seen.add(item.id);
  state.animateAll = false;

  els.brief.hidden = list.length === 0;
  els.count.textContent = `${nf.format(list.length)} ${list.length === 1 ? "dispatch" : "dispatches"}`;

  const remaining = list.length - page.length;
  els.more.hidden = remaining <= 0;
  els.more.textContent = `Show ${nf.format(remaining)} more`;

  renderState(list);
}

function renderState(list) {
  const show = (className, message) => {
    els.state.hidden = false;
    els.state.className = className;
    els.state.textContent = message;
  };

  if (!state.payload) {
    if (state.loading) return show("state", "Loading the latest edition…");
    return show("state state--warn", "The wire could not be loaded. It will be retried automatically.");
  }
  if (list.length === 0) {
    return show("state", "Nothing from this source in the latest edition.");
  }
  els.state.hidden = true;
  els.state.textContent = "";
}

/**
 * The strip scrolls, so it has to say so. `data-overflow` drives the edge fade,
 * and the fade only shows while there is something left to scroll to — a fade
 * pinned at an edge that has reached its end is just a smudge.
 */
function syncTabOverflow() {
  const strip = els.filters;
  const slack = 4;
  strip.dataset.overflow =
    strip.scrollWidth - strip.clientWidth > slack ? "true" : "false";
  strip.dataset.atEnd =
    strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - slack ? "true" : "false";
}

/**
 * Keeps the selected tab on screen, which matters now that there are twenty of
 * them. Instant and after a frame, not smooth and during render: the strip
 * carries `scroll-behavior: smooth` so a drag ends softly, and an animated
 * reveal started mid-render computes its target from a stale width — it lands at
 * almost the old position, which is exactly what it did.
 */
function revealActiveTab() {
  const active = els.filters.querySelector('[aria-current="true"]');
  if (!active) return;
  requestAnimationFrame(() => {
    active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    syncTabOverflow();
  });
}

function renderTabs() {
  const items = state.payload?.items || [];
  const counts = new Map();
  for (const item of items) counts.set(item.source, (counts.get(item.source) || 0) + 1);

  const options = [["all", "All", items.length]];
  for (const id of ORDER) {
    if (SOURCES[id] && counts.get(id)) options.push([id, SOURCES[id].name, counts.get(id)]);
  }

  els.filters.replaceChildren(
    ...options.map(([id, name, n]) => {
      const tab = el("button", {
        class: "tab",
        type: "button",
        "aria-current": state.filter === id ? "true" : null,
      });
      tab.append(document.createTextNode(name));
      if (n) tab.append(el("span", { class: "tab__n", text: nf.format(n) }));
      tab.addEventListener("click", () => setFilter(id));
      return tab;
    }),
  );

  syncTabOverflow();
  revealActiveTab();
}

function updateStatus(now = Date.now()) {
  els.pulse.classList.remove("pulse--stale", "pulse--error");
  const stampNode = els.note;
  const payload = state.payload;

  if (!payload) {
    pulseText.textContent = state.loading ? "Connecting…" : "Offline";
    if (!state.loading) els.pulse.classList.add("pulse--error");
    stampNode.textContent = "";
    return;
  }

  const age = now - Date.parse(payload.generatedAt);
  const stale = !Number.isFinite(age) || age > STALE_MS;
  pulseText.textContent = stale
    ? `Stale · ${relTime(payload.generatedAt, now)}`
    : `Updated ${relTime(payload.generatedAt, now)}`;
  if (stale) els.pulse.classList.add("pulse--stale");

  const ok = payload.sources.filter((s) => s.status === "ok").length;
  stampNode.textContent =
    `${nf.format(payload.items.length)} dispatches from ${ok} of ${payload.sources.length} ` +
    `sources, rebuilt ${relWords(payload.generatedAt, now)}.`;
}

function updateAlerts(now = Date.now()) {
  const payload = state.payload;
  if (!payload) {
    els.alert.hidden = true;
    return;
  }

  const failed = payload.sources.filter((s) => s.status !== "ok");
  const stale = now - Date.parse(payload.generatedAt) > STALE_MS;
  const messages = [];

  if (failed.length > 0) {
    const names = failed.map((s) => s.name).join(", ");
    messages.push(
      `${names} ${failed.length === 1 ? "is" : "are"} not reporting right now, so ` +
        `${failed.length === 1 ? "its dispatches are" : "their dispatches are"} missing from this edition.`,
    );
  }
  if (stale) {
    messages.push("This edition is older than expected, so the hourly rebuild may have stalled.");
  }

  els.alert.hidden = messages.length === 0;
  els.alert.textContent = messages.join(" ");
  els.alert.classList.toggle("alert--error", failed.length === payload.sources.length);
}

/** Re-render only the relative times; the cards themselves are left alone. */
function tick() {
  const now = Date.now();
  for (const node of document.querySelectorAll("[data-time]")) {
    const rel = relTime(node.getAttribute("data-time"), now);
    if (rel) node.textContent = rel;
  }
  updateStatus(now);
  updateAlerts(now);
}

function announce(message) {
  els.announcer.textContent = "";
  window.setTimeout(() => {
    els.announcer.textContent = message;
  }, 60);
}

/* ----------------------------------------------------------------- state */

function syncHash() {
  const url =
    state.filter === "all" ? location.pathname + location.search : `#source=${state.filter}`;
  history.replaceState(null, "", url);
}

function readHash() {
  const m = location.hash.match(/^#source=([a-z]+)$/);
  if (m && SOURCES[m[1]]) state.filter = m[1];
}

function setFilter(id, { sync = true } = {}) {
  if (state.filter === id) return;
  state.filter = id;
  state.shown = PAGE_SIZE;
  if (sync) syncHash();
  renderTabs();
  render();
  announce(
    id === "all" ? "Showing every source." : `Showing ${SOURCES[id].name} only.`,
  );
}

/* ------------------------------------------------------------------ load */

async function load() {
  state.lastFetch = Date.now();
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.items) || data.items.length === 0) throw new Error("empty edition");

    const first = !state.payload;
    state.payload = data;
    state.error = null;
    state.loading = false;
    if (first) state.animateAll = true;

    renderTabs();
    render();
    updateAlerts();
    if (!first) {
      announce(`Refreshed. ${data.items.length} dispatches.`);
    }
  } catch (error) {
    state.error = error;
    state.loading = false;
    // Whatever is already on screen stays on screen; a failed refresh must not blank it.
    renderTabs();
    render({ animate: false });
    if (!state.payload) announce("The wire could not be loaded.");
  }
  updateStatus();
}

/** Focus and tab-return refetch, but never more than once a minute. */
function maybeRefetch() {
  if (Date.now() - state.lastFetch < MIN_REFETCH_GAP_MS) return;
  load();
}

/* ------------------------------------------------------------------ boot */

els.more.addEventListener("click", () => {
  state.shown += PAGE_SIZE;
  render();
});

window.addEventListener("hashchange", () => {
  const before = state.filter;
  readHash();
  if (state.filter !== before) setFilter(state.filter, { sync: false });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") maybeRefetch();
});
window.addEventListener("focus", maybeRefetch);
window.setInterval(tick, TICK_MS);
window.setInterval(load, REFRESH_MS);

// The strip's scrollability depends on the tabs inside it and on the window
// width, so both are watched rather than measured once.
els.filters.addEventListener("scroll", syncTabOverflow, { passive: true });
window.addEventListener("resize", syncTabOverflow, { passive: true });

readHash();
renderTabs();
render();
updateStatus();
load();
