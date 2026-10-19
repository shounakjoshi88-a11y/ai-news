/**
 * AI Wire — renders data/news.json as a grid of dispatches.
 *
 * The data file is rebuilt every five minutes by a scheduled job. The deployed
 * copy is the fallback; a live ladder reads the freshest edition straight from
 * the repo's data branch, so a refresh costs the reader one request rather than
 * the project a deployment. There is no API, no build step and no key. This
 * script only reads, filters, paginates and formats.
 */

const DATA_URL = "data/news.json";
/** How often the page re-reads the wire. The collector writes every five minutes. */
const REFRESH_MS = 5 * 60 * 1000;
const TICK_MS = 30 * 1000;
const STALE_MS = 90 * 60 * 1000;
const MIN_REFETCH_GAP_MS = 60 * 1000;
/** Cards past this point still animate, but as one batch, so the entrance never drags. */
const ENTER_STAGGER_CAP = 11;
const PAGE_SIZE = 24;

/**
 * Every source the collector can produce. `code` is what a card shows, in a small
 * chip, so it is short; `name` is what the filter tab and the card's meta line
 * show, so it is spelled out; `kind` is what the source publishes, and is what a
 * card with no picture says instead of a picture. The order below is the order of
 * the tabs, and it is fixed on purpose — sorting by volume would make a source
 * jump around the strip every five minutes as the news changes.
 */
const SOURCES = {
  hn: { name: "Hacker News", code: "HN", kind: "Discussion" },
  lobsters: { name: "Lobsters", code: "LOB", kind: "Discussion" },
  papers: { name: "Daily Papers", code: "DP", kind: "Paper" },
  arxiv: { name: "arXiv", code: "arXiv", kind: "Paper" },
  hf: { name: "Hugging Face", code: "HF", kind: "Model" },
  gh: { name: "GitHub", code: "GH", kind: "Repository" },

  openai: { name: "OpenAI", code: "OAI", kind: "Announcement" },
  deepmind: { name: "DeepMind", code: "DM", kind: "Announcement" },
  googleai: { name: "Google AI", code: "GAI", kind: "Announcement" },
  googleresearch: { name: "Google Research", code: "GR", kind: "Research" },
  msr: { name: "Microsoft Research", code: "MSR", kind: "Research" },
  nvidia: { name: "NVIDIA", code: "NV", kind: "Announcement" },
  nvidiaresearch: { name: "NVIDIA Research", code: "NVR", kind: "Research" },
  appleml: { name: "Apple ML", code: "APL", kind: "Research" },
  awsml: { name: "AWS Machine Learning", code: "AWS", kind: "Engineering" },
  metaeng: { name: "Meta Engineering", code: "META", kind: "Engineering" },
  databricks: { name: "Databricks", code: "DBX", kind: "Engineering" },
  pytorch: { name: "PyTorch", code: "PT", kind: "Engineering" },
  ghblog: { name: "GitHub Blog", code: "GHB", kind: "Engineering" },
  hfblog: { name: "Hugging Face Blog", code: "HFB", kind: "Announcement" },
  together: { name: "Together AI", code: "TAI", kind: "Announcement" },
  ollama: { name: "Ollama", code: "OLL", kind: "Announcement" },
  sakana: { name: "Sakana AI", code: "SKA", kind: "Announcement" },
  metr: { name: "METR", code: "METR", kind: "Research" },
  mozillaai: { name: "Mozilla.ai", code: "MZL", kind: "Announcement" },

  tc: { name: "TechCrunch", code: "TC", kind: "Report" },
  verge: { name: "The Verge", code: "VZ", kind: "Report" },
  ars: { name: "Ars Technica", code: "ARS", kind: "Report" },
  mit: { name: "MIT News", code: "MIT", kind: "Report" },
  wiredai: { name: "WIRED", code: "WIR", kind: "Report" },
  guardian: { name: "The Guardian", code: "GDN", kind: "Report" },
  techreview: { name: "MIT Tech Review", code: "MITR", kind: "Report" },
  spectrum: { name: "IEEE Spectrum", code: "IEEE", kind: "Report" },
  zdnet: { name: "ZDNET", code: "ZD", kind: "Report" },
  marktechpost: { name: "MarkTechPost", code: "MTP", kind: "Report" },
  aim: { name: "Analytics India", code: "AIM", kind: "Report" },
  aibusiness: { name: "AI Business", code: "AIB", kind: "Report" },
  siliconangle: { name: "SiliconANGLE", code: "SANG", kind: "Report" },
  techxplore: { name: "TechXplore", code: "TXP", kind: "Report" },
  fastcompany: { name: "Fast Company", code: "FC", kind: "Report" },
  scmp: { name: "SCMP", code: "SCMP", kind: "Report" },
  etai: { name: "Economic Times", code: "ET", kind: "Report" },
  f404: { name: "404 Media", code: "404", kind: "Report" },
  platformer: { name: "Platformer", code: "PLT", kind: "Report" },

  techmeme: { name: "Techmeme", code: "TM", kind: "Aggregator" },
  slashdot: { name: "Slashdot", code: "SD", kind: "Discussion" },
  thehackernews: { name: "The Hacker News", code: "THN", kind: "Security" },
  bleepingcomputer: { name: "BleepingComputer", code: "BLP", kind: "Security" },
  tomshardware: { name: "Tom's Hardware", code: "TOMS", kind: "Hardware" },
  techspot: { name: "TechSpot", code: "TSP", kind: "Report" },
  semiengineering: { name: "Semiconductor Engineering", code: "SEMI", kind: "Hardware" },
  eetimes: { name: "EE Times", code: "EET", kind: "Hardware" },
  thenewstack: { name: "The New Stack", code: "TNS", kind: "Engineering" },
  servethehome: { name: "ServeTheHome", code: "STH", kind: "Hardware" },
  dcd: { name: "Data Centre Dynamics", code: "DCD", kind: "Infrastructure" },
  computerworld: { name: "Computerworld", code: "CW", kind: "Enterprise" },
  nine5google: { name: "9to5Google", code: "9TO5", kind: "Hardware" },
  macrumors: { name: "MacRumors", code: "MR", kind: "Report" },
  stratechery: { name: "Stratechery", code: "STR", kind: "Analysis" },
  daringfireball: { name: "Daring Fireball", code: "DF", kind: "Post" },
  restofworld: { name: "Rest of World", code: "ROW", kind: "Report" },
  sifted: { name: "Sifted", code: "SFT", kind: "Report" },
  techeu: { name: "Tech.eu", code: "TEU", kind: "Report" },
  sciencedaily: { name: "ScienceDaily", code: "SDC", kind: "Research" },

  simonw: { name: "Simon Willison", code: "SW", kind: "Post" },
  importai: { name: "Import AI", code: "IA", kind: "Post" },
  interconnects: { name: "Interconnects", code: "IC", kind: "Post" },
  tldrai: { name: "TLDR AI", code: "TLDR", kind: "Newsletter" },
  latentspace: { name: "Latent Space", code: "LS", kind: "Post" },
  oneusefulthing: { name: "One Useful Thing", code: "OUT", kind: "Post" },
  aheadofai: { name: "Ahead of AI", code: "AOAI", kind: "Newsletter" },
  lastweekinai: { name: "Last Week in AI", code: "LWI", kind: "Newsletter" },
  aisnakeoil: { name: "AI as Normal Technology", code: "AISN", kind: "Analysis" },
  exponentialview: { name: "Exponential View", code: "EXV", kind: "Newsletter" },
  gradflow: { name: "Gradient Flow", code: "GRF", kind: "Analysis" },
  dair: { name: "DAIR.AI", code: "DAIR", kind: "Newsletter" },
  alignmentforum: { name: "Alignment Forum", code: "AF", kind: "Discussion" },
  lesswrong: { name: "LessWrong", code: "LW", kind: "Discussion" },
  kdnuggets: { name: "KDnuggets", code: "KDN", kind: "Post" },
  rundown: { name: "The Rundown", code: "TRD", kind: "Newsletter" },
};
const ORDER = Object.keys(SOURCES);

const els = {
  wire: document.getElementById("wire"),
  lead: document.getElementById("lead"),
  brief: document.getElementById("brief"),
  count: document.getElementById("count"),
  filters: document.getElementById("filters"),
  tabPrev: document.getElementById("tabPrev"),
  tabNext: document.getElementById("tabNext"),
  state: document.getElementById("state"),
  pulse: document.getElementById("status"),
  note: document.getElementById("note"),
  alert: document.getElementById("alert"),
  more: document.getElementById("more"),
  board: document.getElementById("board"),
  clocks: document.getElementById("clocks"),
  wireDate: document.getElementById("wireDate"),
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
  /** False until the first load completes, so the boot itself never announces. */
  booted: false,
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

/**
 * The tile's caption: the kind of thing the item is, plus one real attribute the
 * card does not already show. The meta line under the headline carries the score,
 * or the category when there is no score, so this deliberately names the attribute
 * that line leaves out — comments for a thread, authors for a paper.
 */
function tileSub(item) {
  const meta = item.meta || {};
  const shown = scoreText(item);
  const candidates = [
    meta.category,
    meta.task,
    meta.language,
    typeof meta.comments === "number" ? `${nf.format(meta.comments)} comments` : "",
    typeof meta.authors === "number" ? `${meta.authors} authors` : "",
  ].filter(Boolean);
  return candidates.find((candidate) => candidate !== shown) || "";
}

/**
 * Artwork when the source has any, and a designed plate when it does not — the
 * grid keeps its rhythm either way, and a dead preview link degrades to the plate
 * rather than to a broken image. The plate is marked `is-tile` so it can be styled
 * as a surface in its own right: a card with no picture must not read as a
 * photograph that failed to load.
 */
function media(item, isLead) {
  const source = sourceOf(item);
  const wrap = el("div", {
    class: (isLead ? "lead__media" : "story__media") + (item.image ? "" : " is-tile"),
  });
  // Three separate marks rather than one dotted string: this project's own rules
  // forbid joining meta with middle dots, and the plate reads better as a stamp
  // anyway — a label, a mark, and a detail.
  wrap.append(
    el("span", {
      class: isLead ? "lead__kind" : "story__kind",
      "aria-hidden": "true",
      text: source.kind,
    }),
  );
  wrap.append(
    el("span", {
      class: isLead ? "lead__mark" : "story__mark",
      "aria-hidden": "true",
      text: source.code,
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
    img.addEventListener(
      "error",
      () => {
        // A preview link that has gone dead degrades to the plate, not to a hole.
        img.remove();
        wrap.classList.add("is-tile");
      },
      { once: true },
    );
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
 * The strip scrolls, so it has to say so. `data-overflow` drives the fade and the
 * buttons, and both edges are tracked separately: the fade only shows on an edge
 * that still has a tab behind it, and a button only shows when it can do
 * something. A control that does nothing when clicked is worse than no control.
 */
function syncTabOverflow() {
  const strip = els.filters;
  const slack = 4;
  const reach = strip.scrollWidth - strip.clientWidth;
  const scrolls = reach > slack;
  const atStart = strip.scrollLeft <= slack;
  const atEnd = strip.scrollLeft >= reach - slack;
  strip.dataset.overflow = scrolls ? "true" : "false";
  strip.dataset.atStart = atStart ? "true" : "false";
  strip.dataset.atEnd = atEnd ? "true" : "false";
  if (els.tabPrev) els.tabPrev.hidden = !scrolls || atStart;
  if (els.tabNext) els.tabNext.hidden = !scrolls || atEnd;
}

/** Moves the strip about a screenful, which is as far as anyone wants to go in one click. */
function scrollTabs(direction) {
  els.filters.scrollBy({
    left: direction * Math.round(els.filters.clientWidth * 0.7),
    behavior: "smooth",
  });
}

/**
 * A wheel over the strip scrolls it sideways. The scrollbar is hidden on purpose,
 * so this is the other half of what the buttons do for a mouse. It deliberately
 * claims the event only while there is somewhere to go, and hands it back to the
 * page at either end — otherwise the strip becomes a trap where you cannot scroll
 * past the header at all.
 */
function onTabWheel(event) {
  const strip = els.filters;
  const reach = strip.scrollWidth - strip.clientWidth;
  if (reach <= 0) return;
  const step = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (!step) return;
  const next = strip.scrollLeft + step;
  if (next < 0 || next > reach) return;
  strip.scrollTo({ left: next, behavior: "instant" });
  event.preventDefault();
}

/**
 * Keeps the selected tab on screen, which matters now that there are eighty of
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
  // Only the counts, now. "rebuilt X ago" was the same fact as the pulse two
  // inches above it, and on a one-line rail the extra clause was the difference
  // between a line and a wrapped remnant.
  stampNode.textContent =
    `${nf.format(payload.items.length)} dispatches from ${ok} of ` +
    `${payload.sources.length} sources.`;
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
    messages.push("This edition is older than expected, so the scheduled rebuild may have stalled.");
  }

  els.alert.hidden = messages.length === 0;
  els.alert.textContent = messages.join(" ");
  els.alert.classList.toggle("alert--error", failed.length === payload.sources.length);
}

/* --------------------------------------------------------------- the board */

/**
 * Seven-segment geometry in a 100 x 180 cell: a 22-unit bar with mitred ends,
 * which is the detail that makes this read as a display rather than a typeface.
 * Written once as SVG, so a single `viewBox` scales the whole board and no
 * breakpoint has to know the digits exist.
 */
const SEGMENTS = {
  a: "11,0 89,0 100,11 89,22 11,22 0,11",
  b: "89,0 100,11 100,79 89,90 78,79 78,11",
  c: "89,90 100,101 100,169 89,180 78,169 78,101",
  d: "11,158 89,158 100,169 89,180 11,180 0,169",
  e: "11,90 22,101 22,169 11,180 0,169 0,101",
  f: "11,0 22,11 22,79 11,90 0,79 0,11",
  g: "11,79 89,79 100,90 89,101 11,101 0,90",
};

/** Which of those bars each character lights. */
const GLYPHS = {
  0: "abcdef",
  1: "bc",
  2: "abdeg",
  3: "abcdg",
  4: "bcfg",
  5: "acdfg",
  6: "acdefg",
  7: "abc",
  8: "abcdefg",
  9: "abcdfg",
};

/**
 * The cells of the board in reading order: hours, the colon, minutes, then the
 * seconds at two thirds size, centred on the same axis so the row reads as one
 * line rather than as a clock with a smaller clock bolted to its right.
 */
const CELLS = [
  { x: 0, kind: "digit" },
  { x: 112, kind: "digit" },
  { x: 232, kind: "colon" },
  { x: 296, kind: "digit" },
  { x: 408, kind: "digit" },
  { x: 548, kind: "second" },
  { x: 621.9, kind: "second" },
];
const SECOND_SCALE = 0.66;
const SECOND_Y = (180 * (1 - SECOND_SCALE)) / 2;

/**
 * The zones on the row under the board. Nothing is claimed about which is
 * important; they are simply spread across the field's working day, so that
 * whatever hour you are reading at, some part of it is in daylight.
 */
const OTHER_ZONES = [
  { name: "San Francisco", zone: "America/Los_Angeles" },
  { name: "New York", zone: "America/New_York" },
  { name: "London", zone: "Europe/London" },
  { name: "Paris", zone: "Europe/Paris" },
  { name: "Beijing", zone: "Asia/Shanghai" },
  { name: "Bengaluru", zone: "Asia/Kolkata" },
];

/**
 * The reader's own zone: what the board shows, and what the first item on the
 * row names. This is the zone's own name rather than an inferred city — the
 * browser reports the zone, not the place, and naming a city the reader may not
 * be in would be a guess dressed up as a fact.
 */
const LOCAL_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

/** `Intl` formatters are expensive to build, so one set per zone is kept. */
const zoneFormats = new Map();

function formatsFor(zone) {
  let formats = zoneFormats.get(zone);
  if (!formats) {
    formats = {
      clock: new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
      date: new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
      weekday: new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short" }),
      full: new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    };
    zoneFormats.set(zone, formats);
  }
  return formats;
}

const boardParts = [];
const clockCells = [];

/** Lays out the digits once; from here on only their classes change. */
function buildBoard() {
  if (!els.board) return;
  const SVG = "http://www.w3.org/2000/svg";

  for (const cell of CELLS) {
    const group = document.createElementNS(SVG, "g");

    if (cell.kind === "colon") {
      group.setAttribute("class", "board__colon");
      for (const y of [49, 109]) {
        const dot = document.createElementNS(SVG, "rect");
        dot.setAttribute("x", 243);
        dot.setAttribute("y", y);
        dot.setAttribute("width", 22);
        dot.setAttribute("height", 22);
        dot.setAttribute("class", "seg is-on");
        group.append(dot);
      }
      els.board.append(group);
      continue;
    }

    const seconds = cell.kind === "second";
    group.setAttribute(
      "class",
      seconds ? "board__digit board__digit--seconds" : "board__digit",
    );
    group.setAttribute(
      "transform",
      seconds
        ? `translate(${cell.x} ${SECOND_Y}) scale(${SECOND_SCALE})`
        : `translate(${cell.x} 0)`,
    );

    const bars = new Map();
    for (const [name, points] of Object.entries(SEGMENTS)) {
      const bar = document.createElementNS(SVG, "polygon");
      bar.setAttribute("points", points);
      bar.setAttribute("class", "seg");
      bars.set(name, bar);
      group.append(bar);
    }
    els.board.append(group);
    boardParts.push({ bars, lit: null });
  }
}

/**
 * Lights the bars each digit needs. A digit whose character has not changed is
 * left completely alone, so one second costs one glyph rather than six, and the
 * faint unlit bars are never touched at all.
 */
function drawBoard(now) {
  const digits =
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  for (let i = 0; i < boardParts.length; i += 1) {
    const part = boardParts[i];
    const lit = GLYPHS[digits[i]] || "";
    if (lit === part.lit) continue;
    part.lit = lit;
    for (const [name, bar] of part.bars) {
      bar.classList.toggle("is-on", lit.includes(name));
    }
  }
}

/**
 * The row of zones. Built once, because a zone that already shares the reader's
 * own offset would print the same minute twice; it is dropped rather than shown
 * as though it were somewhere else.
 */
function buildClocks() {
  if (!els.clocks) return;
  const now = new Date();
  const here = formatsFor(LOCAL_ZONE).clock.format(now);
  const others = OTHER_ZONES.filter(
    (place) => formatsFor(place.zone).clock.format(now) !== here,
  );

  const places = [
    { name: LOCAL_ZONE.replace(/_/g, " "), zone: LOCAL_ZONE, here: true },
    ...others,
  ];

  clockCells.length = 0;
  els.clocks.replaceChildren();

  for (const place of places) {
    const item = document.createElement("li");
    item.className = place.here ? "clock clock--here" : "clock";

    const label = document.createElement("span");
    label.className = "clock__label";
    if (place.here) {
      // The board is hidden from assistive tech, so this row is where the local
      // time actually comes from — and this is the word that says it is theirs.
      const mine = document.createElement("span");
      mine.className = "sr-only";
      mine.textContent = "Your clock, ";
      label.append(mine);
    }

    const name = document.createElement("span");
    name.textContent = place.name;
    label.append(name);

    // The weekday rides with the time, not with the place: "Beijing Mon" reads
    // as one name, where "Mon 01:18" reads as the day it actually is.
    const value = document.createElement("span");
    value.className = "clock__value";
    const day = document.createElement("span");
    day.className = "clock__day";
    const time = document.createElement("time");
    time.className = "clock__time";
    value.append(day, time);

    item.append(label, value);
    els.clocks.append(item);
    clockCells.push({ time, day, zone: place.zone, here: place.here });
  }
}

function drawClocks(now) {
  if (clockCells.length === 0) return;
  const hereDay = formatsFor(LOCAL_ZONE).date.format(now);

  for (const cell of clockCells) {
    const formats = formatsFor(cell.zone);

    const text = formats.clock.format(now);
    if (cell.time.textContent !== text) {
      cell.time.textContent = text;
      cell.time.setAttribute("datetime", now.toISOString());
    }

    // Only a zone that has rolled into another date carries a weekday; on the
    // ones that agree with the reader's date the marker would be noise.
    const mark =
      cell.here || formats.date.format(now) === hereDay
        ? ""
        : formats.weekday.format(now);
    if (cell.day.textContent !== mark) cell.day.textContent = mark;
  }
}

/**
 * One timer, aligned to the wall clock rather than to whenever the page happened
 * to open, so a second changes on the second instead of drifting a fraction
 * behind. The delay is recomputed from `Date.now()` on every pass, so a tab the
 * browser throttled or suspended re-aligns itself on the way back instead of
 * resuming late. Anything that has not changed is not written.
 */
function startBoard() {
  const step = () => {
    const now = new Date();
    drawBoard(now);
    drawClocks(now);
    const today = formatsFor(LOCAL_ZONE).full.format(now);
    if (els.wireDate.textContent !== today) els.wireDate.textContent = today;
    window.setTimeout(step, 1000 - (Date.now() % 1000));
  };
  step();
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

// The deployed copy is the instant first paint and the guaranteed fallback: it
// ships with the site, so it is there even when nothing else can be reached.
//
// The live ladder upgrades it without a deployment. The GitHub contents API is
// first because it is the only path that is current the moment the collector
// writes; the raw CDN copy trails it by up to five minutes and carries no rate
// limit; the same-origin copy is the floor every run can fall back to. The data
// is a file the page reads, not something baked into the build — so a refresh
// costs the reader one request, not the project a deployment.
const LIVE_SOURCES = [
  {
    url: "https://api.github.com/repos/shounakjoshi88-a11y/ai-news/contents/data/news.json?ref=data",
    init: { headers: { Accept: "application/vnd.github.raw" } },
  },
  {
    url: "https://raw.githubusercontent.com/shounakjoshi88-a11y/ai-news/data/data/news.json",
  },
];

async function fetchEdition(url, init) {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.items) || data.items.length === 0) throw new Error("empty edition");
  return data;
}

/** True only when this edition is newer than what is already on screen. */
function isNewer(a, b) {
  const ta = Date.parse(a?.generatedAt || 0) || 0;
  const tb = Date.parse(b?.generatedAt || 0) || 0;
  return ta > tb;
}

/**
 * Show an edition, but only when it is newer than the current one. Returns true
 * when it actually changed the screen, so a poll that finds nothing new stays
 * quiet and a stale fallback never regresses the page.
 */
function applyEdition(data) {
  if (!isNewer(data, state.payload)) return false;
  const first = !state.payload;
  state.payload = data;
  state.error = null;
  state.loading = false;
  if (first) state.animateAll = true;
  renderTabs();
  render();
  updateAlerts();
  return true;
}

async function load() {
  state.lastFetch = Date.now();
  const booted = state.booted;
  let changed = false;
  let lastError = null;

  // Walk the ladder: the deployed copy first for a fast first paint, then the
  // live sources for whatever is newer. The first live source that applies is
  // the freshest there is, so the ladder stops there.
  for (const { url, init } of [{ url: DATA_URL }, ...LIVE_SOURCES]) {
    try {
      const data = await fetchEdition(url, init);
      if (applyEdition(data)) {
        changed = true;
        if (url !== DATA_URL) break;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!state.payload) {
    state.error = lastError;
    state.loading = false;
    // Whatever is already on screen stays on screen; a failed refresh must not blank it.
    renderTabs();
    render({ animate: false });
    announce("The wire could not be loaded.");
  } else if (changed && booted) {
    announce(`Refreshed. ${state.payload.items.length} dispatches.`);
  }
  state.booted = true;
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

// The strip is reachable three ways now, because a hidden scrollbar is not an
// affordance: click a button, turn the wheel over it, or swipe a touch screen.
// Not passive — this one calls preventDefault when it takes the event.
els.filters.addEventListener("wheel", onTabWheel, { passive: false });
els.tabPrev?.addEventListener("click", () => scrollTabs(-1));
els.tabNext?.addEventListener("click", () => scrollTabs(1));

readHash();
buildBoard();
buildClocks();
startBoard();
renderTabs();
render();
updateStatus();
load();
