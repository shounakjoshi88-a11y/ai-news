# AI Wire

A single page showing what is happening in AI right now — papers, models, code and
discussion — from four sources, rebuilt every hour by a scheduled job. No server, no
database, no API keys, nothing to run.

**Live:** https://shounakjoshi88-a11y.github.io/ai-news/

## How it works

```
Hacker News  ─┐
Hugging Face ─┤   scripts/fetch-news.mjs        data/news.json         index.html
GitHub       ─┼─▶ normalise → dedupe → rank ─▶ committed hourly ─▶ app.js renders
arXiv cs.AI  ─┘                                       ▲
                                                      └─ GitHub Actions, every hour
```

A scheduled workflow runs `scripts/fetch-news.mjs`, which writes `data/news.json` and
commits it if it changed, then publishes the page. Because the page is served from the
same origin as that file, the browser reads it directly. There is no API to call and no
process to keep alive.

Publishing runs on GitHub Pages from Actions, and the published site is assembled from
four files plus the data — the repo's own `scripts/` and `docs/` are never part of it.

> Pages has to be switched on once in the repository's **Settings → Pages**, which is an
> administrator action no workflow token is allowed to perform. After that single
> setting, every hourly run keeps the live page current on its own.

## Sources

| Source | What it contributes | Signal |
| --- | --- | --- |
| Hacker News | discussion, the field's front page | points, comments |
| Hugging Face | newly published models | likes, downloads |
| GitHub | repos created in the last two weeks that are already being adopted | stars, language |
| arXiv `cs.AI` | new papers | recency |

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
| The browser is offline, or the file is missing | The page says so and offers a retry, rather than showing an empty page. |

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

The page is built as a **dispatch tape**: one column, a fixed 96px timestamp rail, a
single accent colour, and no cards, badges, icons or shadows. Rank is carried
typographically — the six strongest dispatches are set in ink, the rest in muted type —
rather than by scores or labels stapled onto every row.

Colour is used for exactly two things: links and focus. Status colour appears only when
something is actually wrong, so a healthy wire shows no green, no badge and nothing to
read.

Contrast is verified numerically rather than by eye:

```bash
node scripts/check-contrast.mjs
```

It converts the `oklch()` tokens in `styles.css` to sRGB directly and fails if any
pairing that actually renders on the page drops below WCAG AA in either theme. It caught
a real light-mode failure (muted text at 3.95:1) during development.

## Notes and limits

- Every source is keyless and public. The only credential involved is the ephemeral
  `GITHUB_TOKEN` the workflow already has, used purely to raise the GitHub API rate limit
  from 60 to 5000 requests an hour.
- Scheduled runs can start 5–20 minutes late. The page reports how long ago it was built
  rather than pretending otherwise, and marks itself stale after 90 minutes.
- Times are rendered in the reader's own timezone and locale; today's dispatches show a
  clock time and older ones show a date.
- Fonts are Archivo and IBM Plex Mono from Google Fonts, with a system fallback stack.
