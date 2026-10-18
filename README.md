# AI Wire

A single page showing what is happening in AI right now — announcements, papers, models,
code, press and discussion — from **nineteen sources**, rebuilt every hour by a scheduled
job. No server, no database, no API keys, nothing to run.

**Live:** https://ai-news-seven-tan.vercel.app/

## How it works

```
Hacker News · Lobsters · Daily Papers · arXiv · HF · GitHub
the labs' own feeds · the press · the blogs
        │
        │  scripts/fetch-news.mjs
        ▼
   normalise → dedupe → rank → fill in previews
        │
        ▼
   data/news.json, committed ──▶ index.html + app.js render it
        ▲                             ▲
        │                             │
   GitHub Actions, hourly          Vercel, on push
```

A scheduled workflow runs `scripts/fetch-news.mjs`, which writes `data/news.json` and
commits it if it changed. Because the page is served from the same origin as that file,
the browser reads it directly. There is no API to call and no process to keep alive.

Each card carries artwork and a summary, and neither is invented: both are taken from the
item's own page or feed, and each source has its own strategy (below). Most feeds publish
their own image, so those cards cost nothing beyond the single request that read the feed;
only items still missing artwork have their page fetched, and only after ranking and
deduping — so the pages read are the pages shown. Where there is no picture to be had at
all, the card gets a designed tile instead of a fake one. See
[Pictures](#pictures-and-why-they-are-not-generated).

The repository is linked to Vercel, so that same commit is also what republishes the page.
The hourly job deploys nothing itself and holds no hosting credential — it only commits,
and Vercel rebuilds on push. A total collection failure therefore leaves both the last good
commit and the live site untouched.

It is triggered **twice an hour**, at `:07` and `:37`, on purpose. GitHub's scheduler is
explicitly best-effort: it starts runs late under load and sometimes drops them entirely,
and this job is the only thing keeping the site current, so one missed tick means a stale
page. The collector stands down when `data/news.json` is under 50 minutes old, so whichever
of the two fires first does the work and the other costs a few seconds of runner time rather
than a duplicate commit.

## Sources

Every source is keyless and public. Nothing here needs an account, an API key or a paid
tier, and each is read from its publisher rather than through an intermediary.

| Group | Source | Signal | Artwork and summary |
| --- | --- | --- | --- |
| Community | **Hacker News** | points, comments | the linked page's own preview; Ask/Show HN posts carry their text already |
| Community | **Lobsters** (AI tag) | points, comments | the linked page's preview |
| Research | **Daily Papers** (Hugging Face) | upvotes, comments | the paper's own thumbnail; the abstract |
| Research | **arXiv** `cs.AI` `cs.LG` `cs.CL` | recency | no picture from the source at all, so the card gets a tile; the abstract is the summary |
| Models | **Hugging Face** models | likes, downloads | the model page's preview; the summary comes from the model card, because the page's own description is the site tagline on every model |
| Code | **GitHub** | stars, language | GitHub renders one preview card per repository; the description is the summary |
| Labs | **OpenAI** | recency | answers every scraper with `403`, so the card gets a tile |
| Labs | **DeepMind**, **Google AI**, **Microsoft Research**, **NVIDIA**, **Hugging Face Blog** | recency | the image each publisher puts in its own feed, so no second request is needed |
| Press | **TechCrunch**, **The Verge**, **Ars Technica**, **MIT News** | recency | the press write the headline, and most publish their own artwork |
| Writing | **Simon Willison**, **Import AI**, **Interconnects** | recency | the newsletter's own enclosure image where there is one, a tile where there is not |

## What was left out, and why

Sources are only added if they are free, keyless, public, and actually return items. Four
plausible candidates were measured and rejected:

| Candidate | Why not |
| --- | --- |
| Reddit (`r/LocalLLaMA`, `r/MachineLearning`) | its JSON endpoints now answer `403` without OAuth |
| Anthropic, Meta, Mistral, The Batch | no working RSS feed at any published path |
| VentureBeat | rate-limits to `429` often enough to fail the run |
| Google News RSS | no artwork, and every link is a redirect through `news.google.com` |

AI News (`news.smol.ai`) was wired in, measured, and then removed: its newest post was
five weeks old, so it is not news.

## Pictures, and why they are not generated

A card shows the artwork its source published. Where no source has one, the card gets a
designed plate instead: the source's monogram, what the item actually is — a discussion, a
paper, a report, an announcement — and one real attribute the card does not already show
(the comments on a thread, the authors on a paper, a repository's language). Two tiers, and
nothing invented.

The obvious third tier — *generate* whatever is still missing — was built, run against the
real wire, and switched off. `scripts/generate-artwork.mjs` exists and works; the workflow
skips it unless the repository variable `ARTWORK_MAX` is set to a non-zero number. Two
measured reasons, both of which would have shipped a defect:

**1. It marks every image.** The service is keyless and free, and the price of that is a
small `pollinations.ai` mark in the corner of every image it returns. Their own documentation
states it as a property of the tier, not a parameter, and asking for it to be removed does
not remove it. Cropping it off would be taking the free tier's output and hiding its term, so
it is not done.

**2. It answers a headline with a face.** This is the one that actually decided it. Given the
titles that have no picture — which is exactly the set that arrives bare — it produced this:

| The card | What came back |
| --- | --- |
| *PathFM: Fast Generative Forecasting of Multivariate Trajectories* | a blurred portrait of a person |
| *Quoting Addy Osmani, Morgan Westlee Lunt, and Qing Wang* | a portrait of a young woman |
| *How Itaú is building generative AI for its entire customer base* | a portrait of a young woman |
| *web-edit 0.1a2* | a portrait of a young woman |

Four of the first six were faces, and none of them had anything to do with the story. The
cause is structural rather than a bad prompt: a card only has no picture when its headline has
no visual subject — an arXiv title, a `Show HN` post, a quote round-up — so the generator is
being asked for a photograph of something that is not a photograph of anything. A face beside
a headline is read as "this is who the story is about", which is a claim the page cannot
support and must not make. A flat tile is honest about having nothing; a portrait is a
fabrication.

**Perchance.org was the first choice and is not possible**, and that was measured too:

| Attempt | Result |
| --- | --- |
| `GET https://perchance.org/api/...` | `403` to any non-browser client |
| `GET/POST https://image-generation.perchance.org/api/*` | every method, every path: `403` with `<title>Just a moment...</title>` — Cloudflare's challenge interstitial, so the request never reaches the API at all |
| `image-generation.perchance.org/api/verifyUser` from inside a real session | `{"status":"failed_verification","reason":"token_required"}` |
| A headless browser, driven with Playwright | `400`, `424 Failed Dependency`, `ERR_TOO_MANY_REDIRECTS` |
| Its own page's JavaScript | reads `navigator.webdriver`, and gates generation behind an ad-powered access code from `/api/getAccessCodeForAdPoweredStuff` |
| Our own `perchance-image-mcp`, headed Chrome, cleared profile | `no image after 180s (queue may be busy)` — repeatedly |

**What the token actually is, since it is the natural question.** It is not a credential that
exists anywhere to be collected. Perchance's own front-end shows the whole mechanism:

```js
let cachedAccessCodeForAdPoweredStuff = null;
setInterval(() => { cachedAccessCodeForAdPoweredStuff = null }, 10 * 60 * 1000);

window.addEventListener("message", async function (e) {
  if (e.origin !== "https://text-generation.perchance.org" &&
      e.origin !== "https://image-generation.perchance.org") return;
  if (e.data.type == "plsGibAccessCodeForAdPoweredStuff") {
    let code = cachedAccessCodeForAdPoweredStuff ||
      (await fetch(`/api/getAccessCodeForAdPoweredStuff?__cacheBust=...`).then(r => r.text()));
    cachedAccessCodeForAdPoweredStuff = code;
```

and immediately before that fetch:

```js
let interactionGateTimeout = setTimeout(() => { ... adgate60t ... }, 60_000);
await window.humanInteractionSignalsPromise;   // real pointer/keyboard signals
window.queuedStatCountKeys.add("adgatep");     // "ad gate passed"
```

So there are two gates stacked, and neither is a token you can fetch:

1. **Cloudflare** fronts `image-generation.perchance.org`. Anything that is not a browser it
   trusts gets the interstitial instead of a response, whatever the path or method.
2. **Behind that, an ad-powered access code.** The generation plugin asks its parent for one by
   `postMessage`; the parent mints it, caches it for ten minutes, and only after it has seen
   `humanInteractionSignalsPromise` resolve and has run a sandboxed ad iframe
   (`ad-sandbox.perchance.org`, provider `vli`).

That is the whole point of it. The code is per session, expires in ten minutes, and re-minting
it means passing the interaction gate again — in a browser, by hand or close enough. It is a
gate by construction, not a key: there is no endpoint that issues one, no page that shows you
one, and nothing to paste into a scheduled job. Driving a real headed browser with a warmed
profile can satisfy it — which is what our own `perchance-image-mcp` does, and even that only
sometimes, because the queue then answers `no image after 180s`.

**If it is ever wanted anyway**, one repository variable turns it on: set `ARTWORK_MAX` to a
number, and the workflow runs the generator capped to that many new pictures per hour. Its
design is sound and worth keeping — pictures are keyed by a hash of the normalised title and
recorded in `images/index.json`, so a story is generated once and never again, and the
collector can rebuild `data/news.json` from nothing without losing them; requests are paced to
the service's one-image-per-45-seconds limit; a run is capped and budgeted; and every failure
is fail-soft, so a rate limit costs pictures, never news. A key from
[gen.pollinations.ai](https://gen.pollinations.ai) would also remove the mark and the per-IP
limit. Neither fixes reason 2.

## How items are chosen and ordered

- Each source gets a **window** (14 days for arXiv and Hacker News, up to 150 for a lab
  that announces quarterly) and a **cap** (5 to 22), so no single source can flood the
  wire and a slow-moving source cannot pad it.
- Within a source, engagement is a **percentile** of that source's own signal, which is
  what makes points, likes, stars and upvotes comparable. A source with no engagement
  metric at all — arXiv, the labs, the press — is ranked by its own recency instead, so a
  fresh announcement still surfaces without a score.
- `rank = 0.5 × engagement + 0.5 × freshness`, with freshness decaying on a 36-hour
  half-life.
- Ranking decides **which** items appear. The list is then spread so that one source
  cannot hold more than two rows in a row.
- Near-duplicates merge: identical links, identical titles, and titles that differ only
  by a prefix or suffix — the same paper on Hacker News and on arXiv, or a model's repo
  and its model page.

## Failure behaviour

| What breaks | What happens |
| --- | --- |
| One source is down | The rest still publish, and the page names the source that failed. |
| A source's host is blocked rather than broken | The collector tries that source's alternate URL before giving up — see the two-host note in [Notes and limits](#notes-and-limits). |
| Every source is down | The script exits non-zero, commits nothing, and the last good data stays live. |
| Image generation, if it is switched on, fails or is rate-limited | The step gives up politely, the affected cards keep their designed tiles, and the news is committed regardless. |
| The browser is offline, or the file is missing | The page says so and keeps retrying on refocus and on a timer, rather than showing an empty page. |

Nothing here overwrites good data with bad. A failed run leaves the previous
`data/news.json` exactly as it was.

## Running it locally

```bash
node scripts/fetch-news.mjs --out data/news.json   # rebuild the data
python -m http.server 8123                         # open http://localhost:8123
```

`scripts/generate-artwork.mjs` is the switched-off generator described above. It takes
`--max`, `--gap`, `--budget`, `--dry-run` and `--verbose`, and reads the same settings from
`ARTWORK_MAX`, `ARTWORK_GAP_MS` and `ARTWORK_BUDGET_MS`. `--dry-run` prints exactly which
cards it would make a picture for and writes nothing, which is a cheap way to see what a
headline with no picture turns into before committing to it.

Node 20 or newer. There is nothing to install — the collector uses only `fetch` and the
Node standard library, which is also why the workflow has no install step and no lockfile.

## Design

The page is a **grid of dispatches**. A dark masthead opens with a segmented clock board,
then the name and the live state; below it the top-ranked story runs full width as a lead,
and everything else sits in a three-column grid of cards — artwork, source, headline,
summary, and the source's own signal along the foot.

The visual language is a newsletter front page: a near-white page, one family (Archivo),
off-black headings over muted grey body text, generous leading, and a single vivid cyan
accent. The accent is used as a **fill with dark text** (9.4:1) rather than as coloured text
on white, which is the one place the reference this is modelled on fails contrast.

Where a source has no artwork the card gets a designed plate: the source's monogram, a
caption naming what the item is and one real attribute of it, and a bar of the accent along
the top edge. It is deliberately a *plate* rather than an empty frame — an unmarked grey
rectangle with a two-letter chip in it is read as a photograph that has failed to load, which
is exactly what the first version of this looked like. It keeps the grid's rhythm without
inventing a picture, and a preview link that dies mid-flight degrades to the same plate: the
`<img>` removes itself on `error` and the card takes the tile class. The top story, if it has
no image, drops the artwork entirely and becomes a wide text lead rather than a large empty
panel.

Cards are filtered by source through the tabs, which write `#source=<id>` so a view can be
linked to and survives a reload, and paged in with **Show more**. Twenty tabs is more than
fits on a line at any width, so the strip scrolls sideways and reveals whichever tab is
selected — a wrapped strip would turn the sticky header into a three-line block that eats a
phone screen. Because the scrollbar is hidden on purpose, the strip carries its own controls
instead of relying on one: an arrow appears on any edge that still has a tab behind it, a
wheel over the strip scrolls it sideways, and the trailing fade marks where the tabs continue.
A touch screen keeps the swipe and drops the arrows, which would only cover tabs there.

The masthead opens with a **segmented clock board** rather than a headline: the date, then
hours and minutes at full size with the seconds at two thirds in the accent, then a row of
zones. It is a real instrument rather than an ornament — the wire is rebuilt hourly, every
card is stamped with when it landed, and the edition goes stale at ninety minutes, so a page
that is *about* time can reasonably open by telling you what time it is.

The digits are seven-segment geometry drawn as SVG rather than set in a typeface. That is
what lets one `viewBox` scale the board from a phone to a desktop without a breakpoint, and
what lets an unlit bar stay faintly visible: the ghost of the 8 is the difference between a
board and a stencil font. It is held at 5% opacity, which is where you see the board only if
you look for it — at 8% every digit carried a muddy second copy of itself and neighbouring
ghosts merged across the gap.

The reader's own zone is the first item on the row beneath, named in the accent — the zone's
own name as the browser reports it, not a city inferred from it. A zone sharing the reader's
offset is dropped rather than printed twice, and a zone that has rolled into another date
carries its weekday with the time (`Mon 01:20`), since after the place name it read as one
name: `Beijing Mon`.

Under all of that sits a **rail rather than a title block**: the name, what the page is, and how
much is in it, on one line of small type. The first version was a 2.5rem name over a three-line
paragraph, and under a board that loud it read as a second, softer monument — not a quieter page,
just two loud things. Cut to a rail it does the same work in a fifth of the height (612px of
masthead became 439px) and the board above keeps the only big voice. It wraps to its own short
lines on a phone rather than shrinking, and the stamp no longer says when the edition was rebuilt,
because the pulse in the bar already says it.

The board is a picture of the time, so it is `aria-hidden`; the row of zones is where the
local time actually comes from for a screen reader, and its first item reads "Your clock, …".
The seconds cost one glyph a second rather than six — a digit whose character has not changed
is left untouched — and the only transition is a 110ms fade on the bars that did change. A
timer aligned to the wall clock drives it, recomputed from `Date.now()` on every pass rather
than accumulated, so a second changes on the second and a suspended tab re-aligns instead of
resuming late. Under `prefers-reduced-motion` the fade goes and the time still ticks.

Motion is deliberately small: one staggered entrance, and only for cards that are
genuinely new since the last render. Relative times tick over every 30 seconds, and
reduced-motion is respected.

The palette is written as **sRGB first and `oklch()` second**. An engine that cannot parse
`oklch()` drops only that line and keeps the palette, instead of painting the whole page in
fallback black and white.

Contrast is verified numerically rather than by eye:

```bash
node scripts/check-contrast.mjs
```

It converts the `oklch()` tokens in `styles.css` to sRGB directly and fails if any pairing
that actually renders on the page drops below WCAG AA in either theme — 24 pairings, light
and dark. It also prints the palette as hex, which is where the sRGB fallbacks come from.

## Notes and limits

- Every source is keyless and public. The only credential involved is the ephemeral
  `GITHUB_TOKEN` the workflow already has, used purely to raise the GitHub API rate limit
  from 60 to 5000 requests an hour.
- Scheduled runs can start 5–20 minutes late, and occasionally do not start at all — which is
  why there are two entries an hour (above). The page reports how long ago it was built
  rather than pretending otherwise, and marks itself stale after 90 minutes.
- Times are shown relative to now, with the exact timestamp in the tooltip, rendered in the
  reader's own locale and timezone.
- Fonts are Archivo from Google Fonts, with a system fallback stack.
- Artwork is hot-linked from the source and never re-hosted, with `referrerpolicy="no-referrer"`
  and `loading="lazy"`; a link that goes dead falls back to the designed tile.
- Some `og:image` previews carry the page's own title text, so a card can echo itself. That
  is the trade for real imagery from the source instead of a placeholder on every card.
- About a quarter of the cards have no picture to show, and they are the ones whose headline
  has no visual subject. They get tiles rather than a generated face, for the reasons in
  [Pictures](#pictures-and-why-they-are-not-generated).
- **One source is read from two hosts, because it has two.** Import AI's Substack host
  answers GitHub's runners with `403` on every path, under every user-agent, while the same
  URL returns `200` with twenty items from a residential connection: a block on datacenter
  addresses, which no amount of parsing gets around. The author mirrors each post to
  `jack-clark.net` on the same minute, and that host does answer the runner, so the collector
  asks it first and falls back to Substack. This was not hypothetical: across the editions
  kept in git history, Import AI was the only source that ever failed — three of five, always
  `403` — and it was the amber notice every time a reader saw one.
