#!/usr/bin/env node
/**
 * Fills in artwork for the cards whose source supplied none.
 *
 * Some sources never hand over a picture — arXiv has none by nature, Simon
 * Willison publishes no og:image, OpenAI answers every scraper with 403, and
 * Ask/Show HN posts have no page to scrape. Those cards fall back to a designed
 * tile, which is honest but leaves the grid looking half-empty.
 *
 * This runs after `fetch-news.mjs` and generates a picture for exactly those
 * items, from the story's own title. It is deliberately conservative:
 *
 *   - **Paced.** The free generator allows one image per 45 seconds per IP, so
 *     requests are serialised with a gap rather than fired in parallel. A run
 *     therefore tops the backlog up in batches rather than all at once.
 *   - **Cached.** Every image is keyed by a hash of the normalised title and
 *     recorded in `images/index.json`. A story that keeps appearing keeps its
 *     picture, is never paid for twice, and the collector can rebuild
 *     `data/news.json` from scratch without losing it.
 *   - **Fail-soft.** A failure — rate limit, timeout, blocked prompt — leaves the
 *     item exactly as it was, so the card keeps its tile and the site is never
 *     held together by this step. It exits 0 unless the data itself is broken.
 *
 * The generator is Pollinations, which is keyless and is the engine the
 * perchance.org front-end runs on. Perchance's own site cannot back an
 * unattended job, and that was measured rather than assumed:
 *
 *   - `GET /api/*` on perchance.org answers 403 to a non-browser client.
 *   - `image-generation.perchance.org` — the host that renders the images — is
 *     behind Cloudflare: every path and method from an HTTP client answers 403
 *     with `<title>Just a moment...</title>`, so the request never reaches the
 *     API. From inside a real session it then answers
 *     `{"status":"failed_verification","reason":"token_required"}`.
 *   - that token is perchance's own ad-powered access code, not a credential
 *     that exists anywhere to be collected: the plugin postMessages
 *     `plsGibAccessCodeForAdPoweredStuff` to its parent, which fetches
 *     `/api/getAccessCodeForAdPoweredStuff`, caches it for ten minutes, and only
 *     after a `humanInteractionSignalsPromise` of real pointer and keyboard
 *     input has resolved. Per session, re-minted only by passing the gate again.
 *     The same page's code also reads `navigator.webdriver`.
 *   - driven with a real headed Chrome it can work, but it is a consumer
 *     service with a shared queue, not an API: it answers "no image after
 *     180s" often enough that nothing unattended should depend on it.
 *
 * Pollinations has one tradeoff of its own, and it is worth stating plainly:
 * its free tier stamps a small `pollinations.ai` mark in the corner of every
 * image, and that is conditional on the free tier — a key from
 * gen.pollinations.ai removes the mark and the per-IP limit. So the free path
 * here is complete but credited.
 *
 *   node scripts/generate-artwork.mjs --max 12
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const PROVIDER = "https://image.pollinations.ai/prompt/";
const MODEL = "flux";
/** Where the generated files are served from, relative to the site root. */
const IMAGE_DIR = "images";

/** One image per 45s per IP; 46s leaves a margin, and the window is per-IP so
 * the gap matters even when a run starts with a fresh allowance. */
const DEFAULT_GAP_MS = 46_000;
const DEFAULT_MAX = 12;
/** 1200x630 is the size every press and lab og:image uses, so these sit in the
 * grid as though the source had supplied them. */
const DEFAULT_W = 1200;
const DEFAULT_H = 630;

/** The look asked for, appended to every story's own subject. */
const PHOTO_STYLE =
  "realistic editorial photograph, natural lighting, shallow depth of field, " +
  "photorealistic, high detail, no text, no words, no watermark, no logos, no UI";

function parseArgs(argv) {
  const envNum = (name, fallback) => {
    const v = process.env[name];
    return v === undefined || v === "" ? fallback : Number(v);
  };
  const out = {
    data: process.env.ARTWORK_DATA || "data/news.json",
    outDir: process.env.ARTWORK_DIR || "images",
    max: envNum("ARTWORK_MAX", DEFAULT_MAX),
    gapMs: envNum("ARTWORK_GAP_MS", DEFAULT_GAP_MS),
    budgetMs: envNum("ARTWORK_BUDGET_MS", 0),
    width: DEFAULT_W,
    height: DEFAULT_H,
    timeoutMs: envNum("ARTWORK_TIMEOUT_MS", 90_000),
    dryRun: false,
    verbose: process.env.ARTWORK_VERBOSE === "1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--data") out.data = next();
    else if (a === "--out") out.outDir = next();
    else if (a === "--max") out.max = Number(next());
    else if (a === "--gap") out.gapMs = Number(next());
    else if (a === "--budget") out.budgetMs = Number(next());
    else if (a === "--width") out.width = Number(next());
    else if (a === "--height") out.height = Number(next());
    else if (a === "--timeout") out.timeoutMs = Number(next());
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: node scripts/generate-artwork.mjs [--max N] [--gap MS] [--budget MS]\n" +
          "                                        [--data PATH] [--out DIR] [--dry-run] [--verbose]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const log = (...m) => console.log(...m);
const trace = (...m) => {
  if (args.verbose) console.log("   ", ...m);
};

/** Titles arrive with markup, HN prefixes and trailing "| Site" attribution.
 * Dashes are left alone on purpose — plenty of real titles have one in them. */
function subjectOf(title) {
  return String(title || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/^\s*(show|ask|tell)\s+hn:\s*/i, "")
    .replace(/\s*\|\s*[^|]{1,40}$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

/** Stable across rebuilds, so a story keeps one picture forever. Derived from
 * the title alone: the same story seen through two sources should not be
 * generated twice. */
function keyOf(title) {
  const norm = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

function seedOf(key) {
  // A stable 31-bit seed, so a regenerated image is the same image.
  return parseInt(key.slice(0, 7), 16);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchImage(prompt, seed) {
  const url =
    PROVIDER +
    encodeURIComponent(prompt) +
    `?width=${args.width}&height=${args.height}` +
    // No `nologo`: the free tier stamps its mark unconditionally, and asking
    // for it to be removed only pretends otherwise.
    `&safe=false&seed=${seed}&model=${MODEL}`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), args.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "ai-news/1.0 (+https://github.com/shounakjoshi88-a11y/ai-news)" },
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, body: body.slice(0, 200) };
    }
    const type = (res.headers.get("content-type") || "").toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const png = buf[0] === 0x89 && buf[1] === 0x50;
    if (!jpeg && !png) return { ok: false, status: res.status, body: `not an image (${type})` };
    if (buf.length < 8_000) return { ok: false, status: res.status, body: `too small (${buf.length}b)` };
    return { ok: true, buf, ext: jpeg ? "jpg" : "png" };
  } catch (err) {
    return { ok: false, status: 0, body: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const dataPath = resolve(args.data);
  const outDir = resolve(args.outDir);
  const indexPath = join(outDir, "index.json");

  const data = await readJson(dataPath, null);
  if (!data || !Array.isArray(data.items)) {
    console.error(`cannot read items from ${dataPath}`);
    return 1;
  }

  const index = await readJson(indexPath, null) || {
    version: 1,
    provider: "pollinations",
    model: MODEL,
    style: PHOTO_STYLE,
    entries: {},
  };
  index.entries ||= {};

  await mkdir(outDir, { recursive: true });

  // Every item in the file, in rank order, that has no artwork yet. Cached
  // images are attached first and for free; only the remainder is generated.
  const missing = data.items.filter((it) => !it.image && it.title);
  const cached = [];
  const fresh = [];
  for (const item of missing) {
    const key = keyOf(item.title);
    const hit = index.entries[key];
    if (hit && existsSync(join(outDir, hit.file))) cached.push({ item, key, hit });
    else fresh.push({ item, key });
  }

  for (const { item, hit } of cached) {
    item.image = `${IMAGE_DIR}/${hit.file}`;
    item.imageKind = "generated";
  }

  log(`artwork: ${missing.length} cards have no picture — ${cached.length} already generated, ${fresh.length} to make`);

  if (args.dryRun) {
    for (const { item, key } of fresh) log(`  would generate ${key}  ${subjectOf(item.title).slice(0, 66)}`);
    return 0;
  }

  const started = Date.now();
  let made = 0;
  let failed = 0;
  let attempted = 0;
  let rateLimited = false;

  for (const { item, key } of fresh) {
    if (made >= args.max) {
      log(`stopping at the per-run cap of ${args.max} (${fresh.length - made} left for the next run)`);
      break;
    }
    if (args.budgetMs && Date.now() - started > args.budgetMs) {
      log("stopping: time budget reached");
      break;
    }
    // Paced on *attempts*, not successes: a run of failures must not turn into a
    // burst of requests just because nothing succeeded.
    if (attempted > 0) await sleep(args.gapMs);
    attempted++;

    const subject = subjectOf(item.title);
    const prompt = `${subject}. ${PHOTO_STYLE}`;
    const seed = seedOf(key);

    trace(`generating ${key}: ${subject.slice(0, 60)}`);
    let result = await fetchImage(prompt, seed);
    if (!result.ok && result.status === 402) {
      // The per-IP window: wait it out once rather than losing the item.
      log("rate limited; waiting one window");
      await sleep(args.gapMs);
      result = await fetchImage(prompt, seed);
    }

    if (!result.ok) {
      if (result.status === 402) {
        rateLimited = true;
        log("still rate limited — stopping this run so it does not burn the budget");
        break;
      }
      failed++;
      log(`  failed ${item.source} "${subject.slice(0, 48)}": ${result.status} ${result.body}`);
      continue;
    }

    const file = `${key}.${result.ext}`;
    await writeFile(join(outDir, file), result.buf);
    index.entries[key] = {
      file,
      prompt,
      seed,
      source: item.source,
      title: item.title,
      createdAt: new Date().toISOString(),
    };
    item.image = `${IMAGE_DIR}/${file}`;
    item.imageKind = "generated";
    made++;
    log(`  ${String(made).padStart(2)}/${Math.min(args.max, fresh.length)}  ${Math.round(result.buf.length / 1024)}KB  ${subject.slice(0, 58)}`);
  }

  index.updatedAt = new Date().toISOString();
  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  // Same shape the collector writes, so a run that changes only the artwork
  // does not reformat the whole file.
  await writeFile(dataPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  const total = Object.keys(index.entries).length;
  log(
    `artwork: made ${made}${failed ? `, ${failed} failed` : ""}${rateLimited ? ", stopped early on the rate limit" : ""}` +
      ` — ${total} in the library, ${Math.round((Date.now() - started) / 1000)}s`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Never fail the workflow: a broken generator must not stop the news.
    console.error("artwork generation failed:", err?.stack || err);
    process.exit(0);
  },
);
