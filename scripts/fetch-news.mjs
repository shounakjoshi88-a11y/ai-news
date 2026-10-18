#!/usr/bin/env node
/**
 * fetch-news.mjs — zero-dependency aggregator for AI Wire.
 *
 *   node scripts/fetch-news.mjs [--out data/news.json] [--force]
 *
 * Fetches four keyless sources, normalises them into one shape, dedupes, ranks,
 * gives each card an image and a summary, and writes data/news.json atomically.
 * Exits 1 only when every source failed, in which case the existing file is left
 * untouched so the page keeps its last good data and the workflow goes red.
 *
 * Exits 0 without touching anything if the existing file is still fresh, unless
 * --force is given. Two cron entries cover each hour because GitHub's scheduler
 * drops runs under load; this guard is what stops the second entry from doubling
 * the commit history.
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const UA = "ai-news/1.0 (+https://github.com/shounakjoshi88-a11y/ai-news)";
const TIMEOUT_MS = 12_000;
/** arXiv's API regularly needs longer than the rest. */
const SLOW_TIMEOUT_MS = 30_000;
/** A link preview is a nice-to-have; a page that hangs must not hold up the run. */
const PAGE_TIMEOUT_MS = 6_000;
const PAGE_CONCURRENCY = 8;
const BLURB_MAX = 190;
/** Below this the artwork is a stretched favicon, and a designed tile looks better. */
const MIN_HERO_WIDTH = 400;
const HALF_LIFE_HOURS = 36;
const WEIGHT_ENGAGEMENT = 0.5;
const TOTAL_CAP = 200;

/**
 * The ordinary RSS and Atom sources, as data rather than fifteen near-identical
 * functions. Every one is keyless and public, and each is read straight from the
 * publisher, so the headline on a card is the headline they wrote.
 */
const FEEDS = {
  openai: { url: "https://openai.com/news/rss.xml", window: 150 * 24, cap: 7 },
  deepmind: { url: "https://deepmind.google/blog/rss.xml", window: 150 * 24, cap: 7 },
  googleai: { url: "https://blog.google/technology/ai/rss/", window: 150 * 24, cap: 7 },
  msr: { url: "https://www.microsoft.com/en-us/research/feed/", window: 150 * 24, cap: 6 },
  nvidia: { url: "https://blogs.nvidia.com/feed/", window: 90 * 24, cap: 6 },
  hfblog: { url: "https://huggingface.co/blog/feed.xml", window: 120 * 24, cap: 7 },
  tc: { url: "https://techcrunch.com/category/artificial-intelligence/feed/", window: 21 * 24, cap: 10 },
  verge: { url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", window: 14 * 24, cap: 9 },
  ars: { url: "https://feeds.arstechnica.com/arstechnica/technology-lab", window: 21 * 24, cap: 9 },
  mit: { url: "https://news.mit.edu/rss/topic/artificial-intelligence2", window: 45 * 24, cap: 8 },
  simonw: { url: "https://simonwillison.net/atom/everything/", window: 45 * 24, cap: 8 },
  importai: { url: "https://importai.substack.com/feed", window: 90 * 24, cap: 5 },
  interconnects: { url: "https://www.interconnects.ai/feed", window: 60 * 24, cap: 5 },
};

// Each feed's collector is the same function closed over its own spec, which is
// why the entries below spread `FEEDS.<id>` rather than naming a function.
for (const [id, spec] of Object.entries(FEEDS)) {
  spec.id = id;
  spec.fn = feedSource(spec);
}

/**
 * `window` is how long an item stays worth showing, in hours — Hugging Face
 * models are news for weeks, a Hacker News post for days. `cap` is how many
 * items that source may contribute, so twenty sources cannot drown the page.
 *
 * `artwork` says where a card's picture comes from. `page` scrapes the item's own
 * page for a link-preview image, but only when the source has not already
 * supplied one — most feeds publish their own image, and those items then cost no
 * second request at all. `none` is a deliberate choice rather than a missing one:
 * a designed tile reads better than a site's logo stretched across a card.
 */
const SOURCES = [
  // What practitioners are saying.
  { id: "hn", name: "Hacker News", window: 7 * 24, cap: 22, artwork: "page", fn: fromHN },
  { id: "lobsters", name: "Lobsters", window: 30 * 24, cap: 8, artwork: "page", fn: fromLobsters },

  // Research.
  { id: "papers", name: "Daily Papers", window: 21 * 24, cap: 15, artwork: "page", fn: fromDailyPapers },
  { id: "arxiv", name: "arXiv", window: 14 * 24, cap: 14, artwork: "none", fn: fromArxiv },

  // Models and code.
  { id: "hf", name: "Hugging Face", window: 21 * 24, cap: 14, artwork: "page", fn: fromHF },
  { id: "gh", name: "GitHub", window: 14 * 24, cap: 16, artwork: "page", fn: fromGH },

  // What the labs publish themselves, which is the primary source for anything big.
  // OpenAI answers every scraper with 403, so its cards are tiles by design.
  { id: "openai", name: "OpenAI", artwork: "none", ...FEEDS.openai },
  { id: "deepmind", name: "DeepMind", artwork: "page", ...FEEDS.deepmind },
  { id: "googleai", name: "Google AI", artwork: "page", ...FEEDS.googleai },
  { id: "msr", name: "Microsoft Research", artwork: "page", ...FEEDS.msr },
  { id: "nvidia", name: "NVIDIA", artwork: "page", ...FEEDS.nvidia },
  { id: "hfblog", name: "Hugging Face Blog", artwork: "page", ...FEEDS.hfblog },

  // The press.
  { id: "tc", name: "TechCrunch", artwork: "page", ...FEEDS.tc },
  { id: "verge", name: "The Verge", artwork: "page", ...FEEDS.verge },
  { id: "ars", name: "Ars Technica", artwork: "page", ...FEEDS.ars },
  { id: "mit", name: "MIT News", artwork: "page", ...FEEDS.mit },

  // Writing worth reading, from people who do the work.
  { id: "simonw", name: "Simon Willison", artwork: "none", ...FEEDS.simonw },
  { id: "importai", name: "Import AI", artwork: "page", ...FEEDS.importai },
  { id: "interconnects", name: "Interconnects", artwork: "page", ...FEEDS.interconnects },
];

const IMAGE_SOURCE = Object.fromEntries(SOURCES.map((s) => [s.id, s.artwork]));

/** GitHub renders one preview card per repository; the path segment is a cache tag. */
const ghPreviewImage = (fullName) => `https://opengraph.githubassets.com/1/${fullName}`;

/**
 * Some pages put their site tagline in the description of every URL. Those make
 * every card say the same sentence, so they are dropped rather than shown.
 */
const TAGLINES = [
  "on a journey to advance and democratize artificial intelligence",
  "hugging face is a platform",
  "we use cookies",
  "please enable javascript",
];

/** Site furniture rather than article artwork: stretched across a card it reads as broken. */
const DECORATIVE_IMAGE = /(^|[/\-_.])(logo|icon|avatar|favicon|sprite|placeholder|spacer|blank)([/\-_.]|$)/i;

/* ---------------------------------------------------------------- helpers */

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function get(url, headers = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "*/*", ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const codePoint = (n) =>
  Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";

const NAMED_ENTITIES = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
};

/**
 * Entities, in the order a page can nest them. Head metadata and feed text are
 * routinely double-encoded — `&amp;#x27;` for an apostrophe — so the value is
 * decoded twice: the first pass unwraps the outer layer, the second resolves
 * whatever that layer was hiding.
 */
function decode(value) {
  let out = String(value);
  for (let pass = 0; pass < 2; pass += 1) {
    out = out
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => codePoint(parseInt(hex, 16)))
      .replace(/&#(\d{1,7});/g, (_, dec) => codePoint(Number(dec)))
      .replace(/&([a-z]{2,8});/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
  }
  return out;
}

/**
 * Most feeds wrap their text in CDATA. Left in place, `<![CDATA[…]]>` looks like
 * a tag and the stripper deletes the *content* along with the wrapper, so the
 * CDATA has to come off before any tag stripping happens.
 */
const unwrapCdata = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

/**
 * Feeds and pages nest their markup, and not just one level: an Atom `<content>`
 * holds escaped HTML, and some feeds carry markdown inside that. Stripping tags
 * once is therefore not enough — the entities have to be decoded *first* and the
 * result stripped again, or `&lt;p&gt;` survives into the card as visible text.
 */
const TAG_RE = /<[^>]*>/g;

const stripTags = (s) => {
  let out = unwrapCdata(String(s));
  for (let pass = 0; pass < 2; pass += 1) out = decode(out).replace(TAG_RE, " ");
  return out
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
};

/** Titles contain emoji; slicing by code unit splits surrogate pairs into mojibake. */
function clampTitle(t) {
  const chars = Array.from(String(t).trim());
  return chars.length > 160 ? chars.slice(0, 159).join("") + "…" : chars.join("");
}

/**
 * Same code-point care as clampTitle, but summaries are cut on a word boundary
 * and lose the punctuation the cut left dangling.
 */
function clampText(value, max) {
  const chars = Array.from(String(value).trim());
  if (chars.length <= max) return chars.join("");
  const cut = chars.slice(0, max).join("");
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.–—-]+$/, "") + "…";
}

/** A summary made of links tells a reader nothing, so it is dropped rather than shown. */
function cleanBlurb(value) {
  if (!value) return "";
  const text = String(value)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= 40 ? text : "";
}

/** One attribute out of a tag string, single- or double-quoted or bare. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function xmlTag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : "";
}

const normalizeTitle = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

const iso = (ms) => new Date(ms).toISOString();

/* ---------------------------------------------------------------- sources */

/** Recent front-page stories. `search` sorts by relevance; `search_by_date` is the news wire. */
async function fromHN() {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const url =
    `https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story` +
    `&numericFilters=created_at_i>${since},points>=20&hitsPerPage=100`;
  const data = JSON.parse(await get(url));
  return (data.hits || [])
    .map((h) => ({
      id: `hn:${h.objectID}`,
      source: "hn",
      title: clampTitle(stripTags(h.title || h.story_title || "")),
      // Ask/Show HN posts carry their own text, which is a summary already written
      // by whoever posted the story, so no page needs to be fetched for it.
      blurb: h.story_text ? clampText(stripTags(h.story_text), BLURB_MAX) : null,
      url: h.url || h.story_url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      publishedAt: iso(h.created_at_i * 1000),
      score: typeof h.points === "number" ? h.points : null,
      scoreLabel: "points",
      meta: { comments: h.num_comments ?? 0 },
    }))
    .filter((i) => i.title && i.url);
}

/**
 * Newly published models only. `sort=trendingScore` alone returns models from
 * months ago, so the creation date is the filter and the news date.
 */
async function fromHF() {
  const url = "https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=100";
  const data = JSON.parse(await get(url));
  const cutoff = Date.now() - 21 * 24 * 3600 * 1000;
  return (data || [])
    .filter((m) => m.createdAt && Date.parse(m.createdAt) >= cutoff)
    .map((m) => ({
      id: `hf:${m.id}`,
      source: "hf",
      title: clampTitle(m.id),
      url: `https://huggingface.co/${m.id}`,
      publishedAt: iso(Date.parse(m.createdAt)),
      score: typeof m.likes === "number" ? m.likes : null,
      scoreLabel: "likes",
      meta: { downloads: m.downloads ?? 0, task: m.pipeline_tag || null },
    }))
    .filter((i) => i.title && i.url);
}

/**
 * Recently created, already-adopted repos. Sorting all AI repos by total stars
 * returns the same handful of mega-repos every hour, so creation date is the
 * signal and `topic:` avoids substring matches like "mailcheap" or "IAMDDB".
 */
async function fromGH() {
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const query = `topic:ai,llm,artificial-intelligence,agents created:>${since} stars:>30`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=50`;
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const data = JSON.parse(await get(url, headers));
  return (data.items || [])
    .map((r) => ({
      id: `gh:${r.full_name}`,
      source: "gh",
      // The repo name is the headline and its description the summary, so a card
      // reads like every other card. `altTitle` keeps the description in play for
      // duplicate matching, which would otherwise lose a repo's second telling.
      title: clampTitle(r.full_name),
      altTitle: r.description ? clampTitle(stripTags(r.description)) : null,
      blurb: r.description ? clampText(stripTags(r.description), BLURB_MAX) : null,
      image: ghPreviewImage(r.full_name),
      url: r.html_url,
      publishedAt: iso(Date.parse(r.created_at)),
      score: typeof r.stargazers_count === "number" ? r.stargazers_count : null,
      scoreLabel: "stars",
      meta: { repo: r.full_name, language: r.language || null },
    }))
    .filter((i) => i.title && i.url && i.publishedAt);
}

/**
 * The three arXiv categories this page covers. The query also returns papers
 * merely cross-listed into them, so the primary category decides membership —
 * and it is also what the card's tile displays.
 */
const RESEARCH_CATEGORIES = new Set(["cs.AI", "cs.LG", "cs.CL"]);

async function fromArxiv() {
  const url =
    `https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=60`;
  const xml = await get(url, {}, SLOW_TIMEOUT_MS);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries
    .map((e) => {
      const rawId = xmlTag(e, "id").trim();
      const slug = rawId.split("/abs/")[1] || rawId;
      const categories = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
      const primary =
        (e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [])[1] || categories[0];
      const published = Date.parse(xmlTag(e, "published").trim());
      return {
        id: `arxiv:${slug}`,
        source: "arxiv",
        title: clampTitle(stripTags(xmlTag(e, "title"))),
        // The feed already carries the abstract, so no page has to be fetched.
        blurb: (() => {
          const abstract = stripTags(xmlTag(e, "summary"));
          return abstract.length >= 80 ? clampText(abstract, BLURB_MAX) : null;
        })(),
        image: null,
        url: rawId,
        // Validated before formatting: new Date(NaN).toISOString() throws.
        publishedAt: Number.isFinite(published) ? iso(published) : null,
        score: null,
        scoreLabel: null,
        meta: {
          category: primary || null,
          authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].length,
        },
        offTopic: !RESEARCH_CATEGORIES.has(primary),
      };
    })
    .filter((i) => i.title && i.url && i.publishedAt && !i.offTopic)
    .map(({ offTopic, ...item }) => item);
}

/**
 * One entry's fields, from either an RSS `<item>` or an Atom `<entry>`. Feeds
 * disagree about almost everything: a link is element text in RSS and an
 * attribute in Atom, dates arrive under four different names, and the summary
 * lives in `description`, `summary` or `content:encoded` depending on which
 * generator wrote the file. So each field is probed in order of preference
 * rather than read from a fixed shape.
 */
function feedEntry(block) {
  const atom = !/<link>/i.test(block) && /<link\b[^>]*href=/i.test(block);

  let url = null;
  if (atom) {
    const tags = [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const alternate = tags.find((t) => /rel\s*=\s*["']alternate["']/i.test(t)) || tags[0];
    url = alternate ? attr(alternate, "href") : null;
  } else {
    const inner = stripTags(xmlTag(block, "link"));
    if (inner) url = inner;
  }

  const dateText =
    xmlTag(block, "pubDate") ||
    xmlTag(block, "published") ||
    xmlTag(block, "updated") ||
    xmlTag(block, "dc:date") ||
    xmlTag(block, "date");
  const published = Date.parse(stripTags(dateText));

  // The feed's own summary is preferred over its full article body: an excerpt is
  // a sentence someone wrote to be a summary, where `content:encoded` is the piece.
  const body =
    xmlTag(block, "description") ||
    xmlTag(block, "summary") ||
    xmlTag(block, "content:encoded") ||
    xmlTag(block, "content");

  const blurb = cleanBlurb(stripTags(body));
  // A feed's own categories are the only honest second line a tile can carry.
  const category =
    [...block.matchAll(/<category[^>]*?(?:term\s*=\s*"([^"]*)"|>([^<]*)<)/gi)]
      .map((m) => stripTags(m[1] || m[2] || ""))
      .find((c) => c && c.length <= 32) || null;

  return {
    title: clampTitle(stripTags(xmlTag(block, "title"))),
    url: url ? url.trim() : null,
    publishedAt: Number.isFinite(published) ? iso(published) : null,
    blurb: blurb ? clampText(blurb, BLURB_MAX) : null,
    image: feedImage(block, body),
    category,
  };
}

/**
 * Artwork straight out of the feed, so the item needs no page fetch at all.
 * Feeds publish it under whichever namespace their generator chose, and plenty
 * publish none — in which case the card gets a scrape or a designed tile.
 */
function feedImage(block, body) {
  const enclosures = [...block.matchAll(/<enclosure\b[^>]*>/gi)].map((m) => m[0]);
  const candidates = [
    (block.match(/<media:content[^>]*\burl\s*=\s*["']([^"']+)/i) || [])[1],
    (block.match(/<media:thumbnail[^>]*\burl\s*=\s*["']([^"']+)/i) || [])[1],
    (block.match(/<itunes:image[^>]*\bhref\s*=\s*["']([^"']+)/i) || [])[1],
    // An audio or video enclosure is not artwork, so only image ones qualify.
    enclosures
      .map((tag) => {
        const url = attr(tag, "url");
        const type = attr(tag, "type") || "";
        return /^image\//i.test(type) || /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(url || "")
          ? url
          : null;
      })
      .find(Boolean),
    (body.match(/<img[^>]*\bsrc\s*=\s*["']([^"']+)/i) || [])[1],
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    const url = decode(raw).trim();
    if (!/^https:\/\//i.test(url)) continue;
    if (DECORATIVE_IMAGE.test(url)) continue;
    return url;
  }
  return null;
}

/**
 * Reads one feed. Blocks are matched before anything inside them is parsed, so a
 * single malformed entry costs that entry rather than the whole source.
 */
function feedSource(spec) {
  return async function fetchFeed() {
    const xml = await get(spec.url);
    const rss = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
    const blocks = rss.length
      ? rss
      : [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0]);

    return blocks
      .map(feedEntry)
      .filter((e) => e.title && e.url && e.publishedAt)
      .map((e) => ({
        id: `${spec.id}:${e.url}`,
        source: spec.id,
        title: e.title,
        blurb: e.blurb,
        image: e.image,
        url: e.url,
        publishedAt: e.publishedAt,
        score: null,
        scoreLabel: null,
        meta: e.category ? { category: e.category } : {},
      }));
  };
}

/**
 * Lobsters' AI tag: a smaller, more opinionated front page than Hacker News.
 * The links are external, so their pages carry real artwork and a real summary.
 */
async function fromLobsters() {
  const data = JSON.parse(await get("https://lobste.rs/t/ai.json"));
  return (data || [])
    .map((s) => {
      const published = Date.parse(s.created_at);
      return {
        id: `lobsters:${s.short_id}`,
        source: "lobsters",
        title: clampTitle(stripTags(s.title)),
        blurb: cleanBlurb(stripTags(s.description_plain || s.description)) || null,
        url: s.url || s.comments_url,
        publishedAt: Number.isFinite(published) ? iso(published) : null,
        score: typeof s.score === "number" ? s.score : null,
        scoreLabel: "points",
        meta: { comments: s.comment_count ?? 0 },
      };
    })
    .filter((i) => i.title && i.url && i.publishedAt);
}

/**
 * Hugging Face's Daily Papers. Unlike raw arXiv this carries a real signal — the
 * community upvotes papers — and it ships a thumbnail, so there is nothing to
 * scrape. Its ids overlap arXiv's, and the title match merges the two.
 */
async function fromDailyPapers() {
  const data = JSON.parse(await get("https://huggingface.co/api/daily_papers?limit=50"));
  return (data || [])
    .map((p) => {
      const paper = p.paper || {};
      const published = Date.parse(p.publishedAt || paper.publishedAt);
      const id = paper.id || p.id;
      const image = typeof p.thumbnail === "string" ? p.thumbnail.trim() : "";
      return {
        id: `papers:${id}`,
        source: "papers",
        title: clampTitle(stripTags(p.title)),
        blurb: cleanBlurb(stripTags(p.summary)) || null,
        image: /^https:\/\//i.test(image) ? image : null,
        url: id ? `https://huggingface.co/papers/${id}` : null,
        publishedAt: Number.isFinite(published) ? iso(published) : null,
        score: typeof paper.upvotes === "number" ? paper.upvotes : null,
        scoreLabel: "upvotes",
        meta: { comments: p.numComments ?? 0 },
      };
    })
    .filter((i) => i.title && i.url && i.publishedAt);
}

/* ------------------------------------------------------------------- rank */

function percentileRanks(values) {
  const out = new Array(values.length).fill(0.5);
  const scored = values.map((v, i) => ({ v, i })).filter((x) => typeof x.v === "number");
  if (scored.length === 0) return out;
  scored.sort((a, b) => a.v - b.v);
  scored.forEach((x, j) => {
    out[x.i] = scored.length === 1 ? 1 : j / (scored.length - 1);
  });
  return out;
}

/** When a source carries no engagement metric (arXiv), its own recency order stands in. */
function recencyPercentile(group) {
  const out = new Array(group.length).fill(0.5);
  const order = group
    .map((item, i) => ({ t: Date.parse(item.publishedAt), i }))
    .sort((a, b) => a.t - b.t);
  order.forEach((x, j) => {
    out[x.i] = order.length === 1 ? 1 : j / (order.length - 1);
  });
  return out;
}

function rankAll(items) {
  const bySource = new Map();
  for (const item of items) {
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }

  const now = Date.now();
  for (const group of bySource.values()) {
    const hasScores = group.some((i) => typeof i.score === "number");
    const engagement = hasScores
      ? percentileRanks(group.map((i) => i.score))
      : recencyPercentile(group);
    group.forEach((item, i) => {
      const ageHours = Math.max(0, (now - Date.parse(item.publishedAt)) / 3_600_000);
      const freshness = Math.exp(-ageHours / HALF_LIFE_HOURS);
      item.rank = WEIGHT_ENGAGEMENT * engagement[i] + (1 - WEIGHT_ENGAGEMENT) * freshness;
    });
  }

  return items.sort(
    (a, b) => b.rank - a.rank || Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
}

/** How many consecutive items of `source` currently sit at the end of `out`. */
function trailingRun(out, source) {
  let run = 1;
  for (let i = out.length - 1; i >= 0 && out[i].source === source; i -= 1) run += 1;
  return run;
}

/**
 * Pure rank order puts the freshest source first for a dozen rows. This keeps
 * rank order but skips an item when its source is already holding a run, and
 * within a short rank window it prefers the source with the most left to say —
 * so large sources drain steadily instead of piling up at the end.
 */
function diversify(items, maxRun = 2, window = 8) {
  const remaining = items.slice();
  const out = [];

  while (remaining.length > 0) {
    let pick = -1;
    let best = -1;

    for (let i = 0; i < Math.min(window, remaining.length); i += 1) {
      const source = remaining[i].source;
      if (trailingRun(out, source) > maxRun) continue;
      let left = 0;
      for (const r of remaining) if (r.source === source) left += 1;
      if (left > best) {
        best = left;
        pick = i;
      }
    }

    if (pick === -1) {
      for (let i = 0; i < remaining.length; i += 1) {
        if (trailingRun(out, remaining[i].source) <= maxRun) {
          pick = i;
          break;
        }
      }
    }
    // Every remaining item shares one source, so a longer run is unavoidable.
    if (pick === -1) pick = 0;

    out.push(remaining.splice(pick, 1)[0]);
  }

  return out;
}

/** Drop anything outside its source's window, then keep only the top `cap` per source. */
function windowAndCap(items) {
  const windows = new Map(SOURCES.map((s) => [s.id, Date.now() - s.window * 3600 * 1000]));
  const caps = new Map(SOURCES.map((s) => [s.id, s.cap]));
  const counts = new Map();
  return items.filter((item) => {
    if (Date.parse(item.publishedAt) < windows.get(item.source)) return false;
    const n = counts.get(item.source) || 0;
    if (n >= caps.get(item.source)) return false;
    counts.set(item.source, n + 1);
    return true;
  });
}

function dedupe(items) {
  const byUrl = new Map();
  const byTitle = new Map();
  const kept = [];

  const attach = (twin, item) => {
    if (!twin.alsoOn) twin.alsoOn = [];
    if (twin.alsoOn.length < 3 && !twin.alsoOn.includes(item.id)) twin.alsoOn.push(item.id);
  };

  for (const item of items) {
    const url = normalizeUrl(item.url);
    const title = normalizeTitle(item.title);
    // A repo's description is a second telling of its own title, so both count.
    const tokens = new Set(
      `${title} ${normalizeTitle(item.altTitle || "")}`.split(" ").filter(Boolean),
    );
    let twin = byUrl.get(url) || byTitle.get(title) || null;

    if (!twin) {
      // Titles differing only by a prefix or suffix are the same story — a paper
      // posted to Hacker News and to arXiv, or a model's repo and its model page.
      for (const prev of kept) {
        const [small, large] =
          tokens.size <= prev.tokens.size ? [tokens, prev.tokens] : [prev.tokens, tokens];
        if (small.size < 3) continue;
        let subset = true;
        for (const token of small) {
          if (!large.has(token)) {
            subset = false;
            break;
          }
        }
        if (subset) {
          twin = prev.item;
          break;
        }
      }
    }

    if (twin) {
      attach(twin, item);
      continue;
    }

    item.alsoOn = [];
    byUrl.set(url, item);
    if (title) byTitle.set(title, item);
    kept.push({ item, tokens });
  }

  return kept.map((r) => r.item);
}

/* ------------------------------------------------------------------ media */

/**
 * Reading a page for its link preview is entirely best-effort: a missing image
 * means a designed tile and a missing summary means a shorter card, never a
 * failed run.
 */
async function fetchPage(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    // A size ceiling keeps one pathological page from stalling the collector.
    if (Number(res.headers.get("content-length") || 0) > 4_000_000) return null;
    if (accept.includes("html") && !(res.headers.get("content-type") || "").includes("html")) {
      return null;
    }
    return { text: await res.text(), url: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The two things a link preview needs, out of a page's head. Tolerant on purpose:
 * unclosed tags, single quotes and content-before-property are all common, so
 * candidates are collected and ranked rather than matched in place. `og:` beats
 * `twitter:`, which beats a plain description.
 */
function headMeta(html, baseUrl) {
  const images = [];
  const blurbs = [];
  let declaredWidth = null;

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, "property") || attr(tag, "name") || "").toLowerCase();
    const content = attr(tag, "content");
    if (!key || !content) continue;

    if (key === "og:image" || key === "og:image:url" || key === "og:image:secure_url") {
      images.push([1, content]);
    } else if (key === "twitter:image" || key === "twitter:image:src") {
      images.push([2, content]);
    } else if (key === "og:description") {
      blurbs.push([1, content]);
    } else if (key === "twitter:description") {
      blurbs.push([2, content]);
    } else if (key === "description") {
      blurbs.push([3, content]);
    } else if (key === "og:image:width" && Number(content) > 0) {
      declaredWidth = Number(content);
    }
  }

  images.sort((a, b) => a[0] - b[0]);
  blurbs.sort((a, b) => a[0] - b[0]);

  let image = null;
  // A declared width small enough to look like a stretched favicon voids all of them.
  if (!(declaredWidth !== null && declaredWidth < MIN_HERO_WIDTH)) {
    for (const [, candidate] of images) {
      let resolved;
      try {
        resolved = new URL(String(candidate).trim(), baseUrl);
      } catch {
        continue;
      }
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
      if (DECORATIVE_IMAGE.test(resolved.pathname)) continue;
      image = resolved.href;
      break;
    }
  }

  // A URL in a card summary is dead weight; if that leaves nothing, there is none.
  let blurb = stripTags(blurbs[0]?.[1] || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const lowered = blurb.toLowerCase();
  if (blurb.length < 40 || TAGLINES.some((t) => lowered.includes(t))) blurb = "";

  return { image, blurb: blurb ? clampText(blurb, BLURB_MAX) : null };
}

/**
 * Markdown reduced to something a card can wear: frontmatter, code, HTML, images
 * and emphasis go, links keep only their text.
 */
function markdownToText(markdown) {
  return String(markdown)
    .replace(/^---[\s\S]*?\n---\s*/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    // Model cards routinely open with an <img> that spans several lines, so tags
    // are removed before the text is ever split into lines.
    .replace(/<[a-z/!?][^>]*>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}|[-*>+])\s*/gm, "")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/(^|[\s(])[*_](\S(?:[^*_]*\S)?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/[ \t]+/g, " ");
}

/**
 * A Hugging Face model page describes the *site*, not the model, so the summary
 * has to come from the model card itself: the first real paragraph of its README,
 * past the frontmatter and past the badge and link blocks most cards open with.
 * A blog post's markdown is read the same way.
 */
function markdownSummary(markdown) {
  for (const block of markdownToText(markdown).split(/\n\s*\n/)) {
    const text = decode(block).replace(/\s+/g, " ").trim();
    if (text.length < 80 || text.split(" ").length < 12) continue;
    // Still markup, or a nav strip of links rather than a sentence.
    if (/\]\(|\*\*|\b(src|alt|style|href|class)=/.test(text)) continue;
    if ((text.match(/[|·]/g) || []).length >= 2) continue;
    return clampText(text, BLURB_MAX);
  }
  return null;
}

/**
 * Where a source's markdown lives, for the sources whose pages cannot supply a
 * summary. A miss is expected here — partner posts in the blog repository are not
 * at the path the URL implies — and a miss simply leaves the card without one.
 */
function markdownSummaryUrl(item) {
  if (item.source === "hf") {
    return `https://huggingface.co/${item.id.slice(3)}/raw/main/README.md`;
  }
  if (item.source === "hfblog") {
    const slug = String(item.url)
      .replace(/^https:\/\/huggingface\.co\/blog\//, "")
      .replace(/\/+$/, "");
    return /^[a-z0-9][a-z0-9._/-]*$/i.test(slug)
      ? `https://raw.githubusercontent.com/huggingface/blog/main/${slug}.md`
      : null;
  }
  return null;
}

/**
 * Give each card its artwork and summary. Only the sources that need it are
 * touched, and only after capping and deduping, so the pages fetched are the
 * pages actually shown.
 */
async function enrich(items) {
  // An item whose feed or API already supplied artwork needs no page fetched for
  // one. That is what keeps widening from four sources to twenty cheap: most
  // items cost a single request shared with the whole feed.
  const targets = items.filter((item) => IMAGE_SOURCE[item.source] === "page" && !item.image);
  const stats = { pages: targets.length, images: 0, blurbs: 0 };
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const item = targets[cursor];
      cursor += 1;

      const page = await fetchPage(item.url, "text/html,application/xhtml+xml");
      const found = page ? headMeta(page.text, page.url) : null;

      if (found?.image && !item.image) {
        item.image = found.image;
        stats.images += 1;
      }
      if (found?.blurb && !item.blurb && normalizeTitle(found.blurb) !== normalizeTitle(item.title)) {
        item.blurb = found.blurb;
        stats.blurbs += 1;
      }

      // A second chance at a summary for the sources whose own pages cannot
      // supply one, because the page describes the site rather than the item.
      const markdown = item.blurb ? null : markdownSummaryUrl(item);
      if (markdown) {
        const card = await fetchPage(markdown, "text/plain,*/*");
        const summary = card ? markdownSummary(card.text) : null;
        if (summary) {
          item.blurb = summary;
          stats.blurbs += 1;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, targets.length) }, worker));
  return stats;
}

/* ------------------------------------------------------------------- main */

const outPath = resolve(arg("--out", "data/news.json"));

/**
 * GitHub's scheduler is best-effort: it delays scheduled runs under load and
 * sometimes drops them outright, which for an hourly job means the page quietly
 * goes stale. Two cron entries an hour are configured to absorb that, and this
 * guard makes whichever fires second a no-op — so the site stays hourly without
 * the history collecting two identical commits every hour.
 *
 * A push or a manual run means the code changed, and passes --force.
 */
const FORCE = process.argv.includes("--force") || process.env.FORCE === "true";
const FRESH_MINUTES = Number(arg("--fresh-minutes", "50"));

if (!FORCE) {
  try {
    const previous = JSON.parse(await readFile(outPath, "utf8"));
    const ageMinutes = (Date.now() - Date.parse(previous.generatedAt)) / 60_000;
    if (Number.isFinite(ageMinutes) && ageMinutes < FRESH_MINUTES) {
      console.log(
        `data is ${ageMinutes.toFixed(0)}m old, fresher than ${FRESH_MINUTES}m — nothing to rebuild.`,
      );
      process.exit(0);
    }
  } catch {
    // Unreadable or absent: a first run, or a corrupted file. Either way, build one.
  }
}

const settled = await Promise.allSettled(SOURCES.map((s) => s.fn()));

const sources = [];
let items = [];
let okCount = 0;

SOURCES.forEach((source, i) => {
  const result = settled[i];
  if (result.status === "rejected") {
    const message = String(result.reason?.message || result.reason || "unknown error");
    sources.push({ id: source.id, name: source.name, status: "error", count: 0, error: message });
    return;
  }
  if (result.value.length === 0) {
    sources.push({
      id: source.id,
      name: source.name,
      status: "error",
      count: 0,
      error: "returned no items",
    });
    return;
  }
  okCount += 1;
  sources.push({
    id: source.id,
    name: source.name,
    status: "ok",
    count: result.value.length,
    error: null,
  });
  items.push(...result.value);
});

// Rank before capping so each source keeps its strongest items, not its first ones.
items = windowAndCap(rankAll(items));

const kept = new Map();
for (const item of items) kept.set(item.source, (kept.get(item.source) || 0) + 1);

const width = Math.max(...sources.map((s) => s.name.length));
console.log("source".padEnd(width + 2) + "status    found  kept  note");
for (const s of sources) {
  console.log(
    s.name.padEnd(width + 2) +
      (s.status === "ok" ? "ok     " : "ERROR  ") +
      String(s.count).padStart(5) +
      "  " +
      String(kept.get(s.id) || 0).padStart(4) +
      "  " +
      (s.error || ""),
  );
}

items = diversify(dedupe(items)).slice(0, TOTAL_CAP);

console.log(
  `\nenriching ${items.length} cards — fetching link previews for the sources that need them…`,
);
const media = await enrich(items);

// `rank` and `altTitle` are working values for ordering and matching, not data.
for (const item of items) {
  delete item.rank;
  delete item.altTitle;
  item.image ||= null;
  item.blurb = cleanBlurb(item.blurb) || null;
}

const payload = {
  generatedAt: iso(Date.now()).replace(/\.\d{3}Z$/, "Z"),
  sources,
  items,
};

if (okCount === 0) {
  console.error(
    `\nAll ${SOURCES.length} sources failed. Existing data left untouched so the page keeps its last good state.`,
  );
  process.exit(1);
}

await mkdir(dirname(outPath), { recursive: true });
const tmp = `${outPath}.tmp`;
await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
await rename(tmp, outPath);

console.log(
  `media: ${media.images}/${media.pages} page-sourced cards got artwork, ` +
    `${media.blurbs} cards got a summary`,
);
console.log(`\n${items.length} dispatches from ${okCount}/${SOURCES.length} sources → ${outPath}`);
