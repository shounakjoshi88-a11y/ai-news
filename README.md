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

Each card carries artwork and a summary. Neither is invented: both are taken from the
item's own page or feed, and each source has its own strategy (below). Most feeds publish
their own image, so those cards cost nothing beyond the single request that read the feed;
only items still missing artwork have their page fetched, and only after ranking and
deduping — so the pages read are the pages shown. An item with no usable picture gets a
designed tile instead.

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
| Research | **arXiv** `cs.AI` `cs.LG` `cs.CL` | recency | no meaningful picture, so a designed tile carrying the category; the abstract |
| Models | **Hugging Face** models | likes, downloads | the model page's preview; the summary comes from the model card, because the page's own description is the site tagline on every model |
| Code | **GitHub** | stars, language | GitHub renders one preview card per repository; the description is the summary |
| Labs | **OpenAI** | recency | answers every scraper with 403, so its cards are tiles by design |
| Labs | **DeepMind**, **Google AI**, **Microsoft Research**, **NVIDIA**, **Hugging Face Blog** | recency | the image each publisher puts in its own feed, so no second request is needed |
| Press | **TechCrunch**, **The Verge**, **Ars Technica**, **MIT News** | recency | the press write the headline, and most publish their own artwork |
| Writing | **Simon Willison**, **Import AI**, **Interconnects** | recency | the newsletter's own enclosure image, or a tile |

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
| Every source is down | The script exits non-zero, commits nothing, and the last good data stays live. |
| The browser is offline, or the file is missing | The page says so and keeps retrying on refocus and on a timer, rather than showing an empty page. |

Nothing here overwrites good data with bad. A failed run leaves the previous
`data/news.json` exactly as it was.

## Running it locally

```bash
node scripts/fetch-news.mjs --out data/news.json   # rebuild the data
python -m http.server 8123                         # open http://localhost:8123
```

Node 20 or newer. There is nothing to install — the collector uses only `fetch` and the
Node standard library, which is also why the workflow has no install step and no lockfile.

## Design

The page is a **grid of dispatches**. A dark masthead carries the name and the live state;
below it the top-ranked story runs full width as a lead, and everything else sits in a
three-column grid of cards — artwork, source, headline, summary, and the source's own
signal along the foot.

The visual language is a newsletter front page: a near-white page, one family (Archivo),
off-black headings over muted grey body text, generous leading, and a single vivid cyan
accent. The accent is used as a **fill with dark text** (9.4:1) rather than as coloured text
on white, which is the one place the reference this is modelled on fails contrast.

Where a source has no artwork the card gets a designed tile carrying the source and a real
attribute of the item — an arXiv category, a repository language, a model task — so the grid
keeps its rhythm without inventing a picture. The top story, if it has no image, drops the
artwork entirely and becomes a wide text lead rather than a large empty panel.

Cards are filtered by source through the tabs, which write `#source=<id>` so a view can be
linked to and survives a reload, and paged in with **Show more**. Nineteen tabs is more than
fits on a line at any width, so the strip scrolls sideways and reveals whichever tab is
selected — a wrapped strip would turn the sticky header into a three-line block that eats a
phone screen. The fade at its trailing edge is the only affordance, since the scrollbar is
hidden. Motion is deliberately small: one staggered entrance, and only for cards that are
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
that actually renders on the page drops below WCAG AA in either theme — 22 pairings, light
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
