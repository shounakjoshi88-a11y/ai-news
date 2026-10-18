# AI Wire

A single page showing what is happening in AI right now — papers, models, code and
discussion — from four sources, rebuilt every hour by a scheduled job. No server, no
database, no API keys, nothing to run.

**Live:** https://ai-news-seven-tan.vercel.app/

## How it works

```
Hacker News   ─┐
Hugging Face  ─┤   scripts/fetch-news.mjs                        data/news.json        index.html
GitHub        ─┼─▶ normalise → dedupe → rank → fill in previews ─▶ committed hourly ─▶ app.js renders
arXiv cs.AI   ─┘                                                       ▲                     ▲
                                                                       │                     │
                                                             GitHub Actions, hourly     Vercel, on push
```

A scheduled workflow runs `scripts/fetch-news.mjs`, which writes `data/news.json` and
commits it if it changed. Because the page is served from the same origin as that file,
the browser reads it directly. There is no API to call and no process to keep alive.

Each card carries artwork and a summary. Neither is invented: both are taken from the
item's own page or feed, and each source has its own strategy (below). Only the items that
survive ranking and deduping are fetched, so the pages read are the pages shown, and a page
that has no preview image simply gets a designed tile instead.

The repository is linked to Vercel, so that same commit is also what republishes the page.
The hourly job deploys nothing itself and holds no hosting credential — it only commits,
and Vercel rebuilds on push. A total collection failure therefore leaves both the last good
commit and the live site untouched.

## Sources

| Source | What it contributes | Signal | Artwork and summary |
| --- | --- | --- | --- |
| Hacker News | discussion, the field's front page | points, comments | the linked page's own preview image and description; Ask/Show HN posts carry their text already |
| Hugging Face | newly published models | likes, downloads | the model page's preview image; the summary comes from the model card itself, because the page's own description is the site's tagline on every model |
| GitHub | repos created in the last two weeks that are already being adopted | stars, language | GitHub renders one preview card per repository; the repo's description is the summary |
| arXiv `cs.AI` | new papers | recency | papers have no meaningful picture, so the card gets a designed tile; the abstract is the summary |

## How items are chosen and ordered

- Each source gets a **window** (Hacker News 7 days, Hugging Face 21, GitHub and arXiv
  14) and a **cap** (25 / 20 / 20 / 15), so no single source can flood the wire.
- Within a source, engagement is a **percentile** of that source's own signal, which is
  what makes points, likes and stars comparable. arXiv has no engagement metric, so its
  own recency order stands in.
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
linked to and survives a reload, and paged in with **Show more**. Motion is deliberately
small: one staggered entrance, and only for cards that are genuinely new since the last
render. Relative times tick over every 30 seconds, and reduced-motion is respected.

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
- Scheduled runs can start 5–20 minutes late. The page reports how long ago it was built
  rather than pretending otherwise, and marks itself stale after 90 minutes.
- Times are shown relative to now, with the exact timestamp in the tooltip, rendered in the
  reader's own locale and timezone.
- Fonts are Archivo from Google Fonts, with a system fallback stack.
- Artwork is hot-linked from the source and never re-hosted, with `referrerpolicy="no-referrer"`
  and `loading="lazy"`; a link that goes dead falls back to the designed tile.
- Some `og:image` previews carry the page's own title text, so a card can echo itself. That
  is the trade for real imagery from the source instead of a placeholder on every card.
