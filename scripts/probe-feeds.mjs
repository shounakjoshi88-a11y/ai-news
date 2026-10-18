/**
 * TEMPORARY. Answers one question from the only place it can be answered: what
 * does a GitHub Actions runner see when it asks for Import AI's feed?
 *
 * Import AI is the one source that fails, 3 editions in 5, always `HTTP 403`,
 * while the same URL returns 200 with 20 items from a residential connection.
 * That is the shape of a host blocking datacenter IPs, which is not something the
 * collector can parse its way out of. This probe measures it, and measures a set
 * of candidate replacements at the same time, before any of them is wired in.
 *
 * Delete this file and its step in update.yml once the answer is acted on.
 */

const BOT_UA = "ai-news/1.0 (+https://github.com/shounakjoshi88-a11y/ai-news)";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const TARGETS = [
  // The one that is failing, under each user-agent, to separate "blocked IP"
  // from "blocked user-agent".
  ["importai.substack.com/feed", "https://importai.substack.com/feed", BOT_UA],
  ["importai.substack.com/feed", "https://importai.substack.com/feed", BROWSER_UA],
  ["jack-clark.net/feed", "https://jack-clark.net/feed/", BOT_UA],
  ["jack-clark.net/feed", "https://jack-clark.net/feed/", BROWSER_UA],
  ["importai substack api", "https://importai.substack.com/api/v1/posts?limit=6", BROWSER_UA],
  ["importai /feed?sort=new", "https://importai.substack.com/feed?sort=new", BROWSER_UA],
  // Newsletters and research blogs that could take its place.
  ["latent.space", "https://www.latent.space/feed", BROWSER_UA],
  ["lastweekin.ai", "https://lastweekin.ai/feed", BROWSER_UA],
  ["thegradient.pub", "https://thegradient.pub/rss/", BROWSER_UA],
  ["bair.berkeley.edu", "https://bair.berkeley.edu/blog/feed.xml", BROWSER_UA],
  ["the-decoder.com", "https://the-decoder.com/feed/", BROWSER_UA],
  ["alignmentforum.org", "https://www.alignmentforum.org/feed.xml", BROWSER_UA],
  ["machinelearning.apple.com", "https://machinelearning.apple.com/rss.xml", BROWSER_UA],
  ["blog.google/technology/ai", "https://blog.google/technology/ai/rss/", BROWSER_UA],
  ["spectrum.ieee.org AI", "https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss", BROWSER_UA],
  ["hai.stanford.edu", "https://hai.stanford.edu/news/rss.xml", BROWSER_UA],
];

const count = (body, re) => (body.match(re) || []).length;

async function probe(label, url, ua) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": ua, accept: "*/*" },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    const items = Math.max(count(body, /<item[\s>]/g), count(body, /<entry[\s>]/g));
    const dated = [...body.matchAll(/<(?:pubDate|published|updated)>([^<]+)</g)].map((m) => m[1]);
    const newest = dated
      .map((d) => Date.parse(d))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    return {
      label,
      status: res.status,
      items,
      bytes: body.length,
      newest: Number.isFinite(newest) ? new Date(newest).toISOString().slice(0, 16) : "—",
      ms: Date.now() - started,
      note: res.status === 200 && items === 0 ? "200 but no feed items" : "",
    };
  } catch (error) {
    return {
      label,
      status: "ERR",
      items: 0,
      bytes: 0,
      newest: "—",
      ms: Date.now() - started,
      note: String(error?.cause?.code || error?.name || error),
    };
  }
}

console.log(`probe from a runner, ${new Date().toISOString()}\n`);
const rows = await Promise.all(TARGETS.map(([label, url, ua]) => probe(label, url, ua)));
for (const r of rows) {
  const who = r.label.includes("substack") || r.label.includes("jack-clark") ? "" : "  candidate";
  console.log(
    `${r.label.padEnd(26)} ${String(r.status).padEnd(5)} ${String(r.items).padStart(3)} items  ` +
      `newest ${r.newest}  ${String(r.bytes).padStart(7)}b  ${String(r.ms).padStart(5)}ms  ${r.note}${who}`,
  );
}
