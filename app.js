/**
 * AI Wire — renders data/news.json as a dispatch tape.
 *
 * The data file is rewritten hourly by a scheduled job and served from the same
 * origin, so there is no API, no build step and no key. This script only reads,
 * filters and formats it.
 */

const DATA_URL = "data/news.json";
const REFRESH_MS = 10 * 60 * 1000;
const TICK_MS = 30 * 1000;
const STALE_MS = 90 * 60 * 1000;
const MIN_REFETCH_GAP_MS = 60 * 1000;
/** Rows past this point all animate together, so the entrance never drags on. */
const ENTER_STAGGER_CAP = 11;
/** How many top-ranked dispatches are set in ink rather than muted type. */
const LEAD_ROWS = 6;

const SOURCES = { hn: "Hacker News", hf: "Hugging Face", gh: "GitHub", arxiv: "arXiv" };
const ORDER = ["hn", "hf", "gh", "arxiv"];

const els = {
  tape: document.getElementById("tape"),
  state: document.getElementById("state"),
  filters: document.getElementById("filters"),
  status: document.getElementById("status"),
  note: document.getElementById("note"),
  alert: document.getElementById("alert"),
  announcer: document.getElementById("announcer"),
};

const state = {
  data: null,
  filter: "all",
  error: null,
  fetchedAt: 0,
  seen: new Set(),
  rendered: false,
};

/* ------------------------------------------------------------------ format */

const fmtInt = new Intl.NumberFormat();
const fmtCompact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fmtTime = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const fmtDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function num(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= 10000 ? fmtCompact.format(value) : fmtInt.format(value);
}

function countOf(count, singular, pluralForm) {
  return `${fmtInt.format(count)} ${count === 1 ? singular : pluralForm}`;
}

function plural(count, word) {
  return countOf(count, word, `${word}s`);
}

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * The tape is ordered by signal, not by clock, so a stamp belongs to its own row
 * rather than to a day heading. Today shows the hour; older shows the date.
 */
function railStamp(date) {
  return startOfDay(date) === startOfDay(new Date()) ? fmtTime.format(date) : fmtDate.format(date);
}

function ago(iso) {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return "an unknown time ago";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.round(hours / 24), "day")} ago`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Source first, then its figures. No middle dots, no badges. */
function metaLine(item) {
  const meta = item.meta || {};
  const words = [];

  if (item.source === "hn") {
    const points = num(item.score);
    if (points) words.push(`${points} points`);
    const comments = num(meta.comments);
    if (comments) words.push(`${comments} comments`);
  } else if (item.source === "hf") {
    const likes = num(item.score);
    if (likes) words.push(`${likes} likes`);
    const downloads = num(meta.downloads);
    if (downloads) words.push(`${downloads} downloads`);
  } else if (item.source === "gh") {
    const stars = num(item.score);
    if (stars) words.push(`${stars} stars`);
    if (meta.language) words.push(meta.language);
  } else if (item.source === "arxiv") {
    if (meta.category) words.push(meta.category);
    if (meta.authors) words.push(plural(meta.authors, "author"));
  }

  if (Array.isArray(item.alsoOn) && item.alsoOn.length > 0) {
    const own = SOURCES[item.source] || item.source;
    const names = [
      ...new Set(
        item.alsoOn
          .map((id) => SOURCES[String(id).split(":")[0]])
          .filter((name) => Boolean(name) && name !== own),
      ),
    ];
    if (names.length > 0) words.push(`also on ${names.join(" and ")}`);
  }

  return { name: SOURCES[item.source] || item.source, words };
}

/* ------------------------------------------------------------------ render */

function renderRow(item, index, options) {
  const row = el("li", "row");
  if (index < LEAD_ROWS) row.classList.add("row--lead");

  if (options.enter) {
    row.classList.add("row--enter");
    row.style.setProperty("--i", String(Math.min(index, ENTER_STAGGER_CAP)));
  }
  if (options.newIds && options.newIds.has(item.id)) row.classList.add("row--new");

  const rail = el("div", "row__rail");
  const date = new Date(item.publishedAt);
  const stamp = el("time", null, railStamp(date));
  stamp.dateTime = item.publishedAt;
  stamp.title = date.toLocaleString();
  rail.appendChild(stamp);

  const body = el("div", "row__body");
  const heading = el("h3", "row__title");
  const link = el("a", "row__link", item.title);
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  heading.appendChild(link);
  body.appendChild(heading);

  const { name, words } = metaLine(item);
  const meta = el("p", "row__meta");
  meta.appendChild(el("span", "row__source", name));
  if (words.length > 0) meta.appendChild(document.createTextNode(`, ${words.join(", ")}`));
  body.appendChild(meta);

  row.append(rail, body);
  return row;
}

function renderTape(items, options) {
  els.tape.textContent = "";
  items.forEach((item, index) => {
    els.tape.appendChild(renderRow(item, index, options));
  });
}

/** Six rows in the final grid, fading in quietly. No shimmer, no layout shift. */
function renderSkeleton() {
  els.tape.textContent = "";
  showState(null);
  for (let i = 0; i < 6; i += 1) {
    const row = el("li", "row");
    const rail = el("div", "row__rail");
    const railBar = el("div", "skeleton__bar skeleton__bar--rail");
    railBar.style.animationDelay = `${i * 40}ms`;
    rail.appendChild(railBar);

    const body = el("div", "row__body");
    const titleBar = el("div", "skeleton__bar skeleton__bar--title");
    const metaBar = el("div", "skeleton__bar skeleton__bar--meta");
    titleBar.style.animationDelay = `${i * 40}ms`;
    metaBar.style.animationDelay = `${i * 40}ms`;
    body.append(titleBar, metaBar);

    row.append(rail, body);
    els.tape.appendChild(row);
  }
}

function showState(spec) {
  els.state.textContent = "";
  if (!spec) {
    els.state.hidden = true;
    return;
  }
  els.state.hidden = false;
  if (spec.art) els.state.appendChild(el("div", "state__art"));
  els.state.appendChild(el("p", "state__title", spec.title));
  if (spec.line) els.state.appendChild(el("p", "state__line", spec.line));
  if (spec.action) {
    const wrap = el("p", "state__action");
    const button = el("button", "btn", spec.action.label);
    button.type = "button";
    button.addEventListener("click", spec.action.onClick);
    wrap.appendChild(button);
    els.state.appendChild(wrap);
  }
}

function emptySpec() {
  if (!state.data) {
    return {
      title: "Couldn't load dispatches",
      line: "The page couldn't read the data file. The hourly build may not have run yet.",
      action: { label: "Retry", onClick: () => load("retry") },
    };
  }
  if (state.filter !== "all") {
    return {
      title: `Nothing from ${SOURCES[state.filter]}`,
      line: "That source had no dispatches worth showing in the last run.",
      action: { label: "Clear filter", onClick: () => setFilter("all") },
    };
  }
  return {
    art: true,
    title: "No dispatches yet",
    line: "The first build hasn't finished. This wire is rebuilt every hour.",
    action: { label: "Check now", onClick: () => load("retry") },
  };
}

function render(options = {}) {
  // Still loading: keep the skeleton rather than claiming a failure.
  if (!state.data && !state.error) {
    updateStatus();
    return;
  }

  const all = state.data ? state.data.items || [] : [];
  const items = state.filter === "all" ? all : all.filter((i) => i.source === state.filter);

  if (items.length === 0) {
    // Clear the tape as well, or skeleton rows left over from the first load
    // stay on screen underneath the empty state.
    els.tape.textContent = "";
    showState(emptySpec());
    if (state.data && state.filter !== "all") nudgeActiveTab();
  } else {
    renderTape(items, options);
    showState(null);
  }

  updateNote(items);
  updateStatus();
}

function nudgeActiveTab() {
  const tab = els.filters.querySelector('[aria-pressed="true"]');
  if (!tab) return;
  tab.classList.remove("filters__tab--nudge");
  void tab.offsetWidth; // restart the animation
  tab.classList.add("filters__tab--nudge");
}

/* ------------------------------------------------------------------ chrome */

function updateStatus() {
  const set = (tone, text) => {
    els.status.dataset.tone = tone;
    els.status.querySelector(".status__text").textContent = text;
  };

  if (state.error && !state.data) return set("danger", "Couldn't load dispatches");
  if (state.error && state.data) return set("danger", `Showing data from ${ago(state.data.generatedAt)}`);
  if (!state.data) return set("ok", "Connecting");

  const age = Date.now() - Date.parse(state.data.generatedAt);
  set(age > STALE_MS ? "warning" : "ok", `Synced ${ago(state.data.generatedAt)}`);
}

function updateNote(items) {
  if (!state.data) {
    els.note.textContent = "";
    return;
  }
  // Nothing to count: the state panel already says why.
  if (items.length === 0) {
    els.note.textContent = "";
    return;
  }
  const ok = (state.data.sources || []).filter((s) => s.status === "ok").length;
  els.note.textContent =
    state.filter === "all"
      ? `${countOf(items.length, "dispatch", "dispatches")} from ${countOf(ok, "source", "sources")}`
      : `${countOf(items.length, "dispatch", "dispatches")} from ${SOURCES[state.filter]}`;
}

function updateAlert() {
  const failed = (state.data?.sources || []).filter((s) => s.status !== "ok");
  if (failed.length === 0) {
    els.alert.hidden = true;
    els.alert.textContent = "";
    return;
  }
  const names = failed.map((s) => s.name);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  els.alert.hidden = false;
  els.alert.textContent = `${list} couldn't be reached in the last run.`;
}

function updateFilterTabs() {
  for (const tab of els.filters.querySelectorAll(".filters__tab")) {
    tab.setAttribute("aria-pressed", String(tab.dataset.source === state.filter));
  }
}

function renderFilters() {
  els.filters.textContent = "";
  const entries = [["all", "All"], ...ORDER.map((id) => [id, SOURCES[id]])];
  for (const [id, label] of entries) {
    const tab = el("button", "filters__tab", label);
    tab.type = "button";
    tab.dataset.source = id;
    tab.setAttribute("aria-pressed", String(state.filter === id));
    tab.addEventListener("click", () => setFilter(id));
    els.filters.appendChild(tab);
  }
}

function readHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return "all";
  const id = new URLSearchParams(raw).get("source");
  return id && SOURCES[id] ? id : "all";
}

function setFilter(id) {
  state.filter = id;
  const params = new URLSearchParams();
  if (id !== "all") params.set("source", id);
  const hash = params.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
  updateFilterTabs();
  render();
  announce(
    state.filter === "all"
      ? "Showing every source."
      : `Showing dispatches from ${SOURCES[state.filter]}.`,
  );
}

function announce(message) {
  els.announcer.textContent = message;
}

/* -------------------------------------------------------------------- load */

async function load(reason) {
  if (reason === "init") {
    renderSkeleton();
    updateStatus();
  }

  try {
    const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.error = null;
    state.fetchedAt = Date.now();
  } catch (error) {
    state.error = error;
  }

  const newIds = new Set();
  if (state.data && state.rendered) {
    for (const item of state.data.items || []) {
      if (!state.seen.has(item.id)) newIds.add(item.id);
    }
  }

  const firstPaint = !state.rendered && Boolean(state.data);
  if (state.data) {
    state.rendered = true;
    for (const item of state.data.items || []) state.seen.add(item.id);
  }

  updateAlert();
  render({ enter: firstPaint, newIds });

  if (state.error && !state.data) announce("Couldn't load dispatches.");
  else if (state.data && firstPaint) {
    announce(`${countOf((state.data.items || []).length, "dispatch", "dispatches")} loaded.`);
  }
}

/* -------------------------------------------------------------------- boot */

state.filter = readHash();
renderFilters();
updateStatus();
load("init");

setInterval(updateStatus, TICK_MS);

setInterval(() => {
  if (document.visibilityState === "visible") load("interval");
}, REFRESH_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.fetchedAt > MIN_REFETCH_GAP_MS) {
    load("visible");
  }
});

window.addEventListener("focus", () => {
  if (Date.now() - state.fetchedAt > MIN_REFETCH_GAP_MS) load("focus");
});
