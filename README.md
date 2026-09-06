# album.guide

*choose your own music adventure*

Music discovery that travels past the obvious. One album sits centre stage as a
CD jewel case; two covers offer deliberately different roads onward, and a
shuffle takes a turn the engine would never recommend. Pick one and the flow
glides — the cover you chose travels into the centre, the one you left slides
away behind you.

A music exploration app built around Apple's Cover Flow. One album sits in the
centre as a CD jewel case; two covers on the right are the next steps, each
leading down a deliberately different path. Choosing one advances the flow and
pushes the previous cover onto the trail at left, where you can walk back and
take the branch you skipped.

The premise is that streaming recommendations fail by over-indexing on the
densest cluster of your taste and serving the same adjacency canon. So the
engine is built to do the opposite: it offers two options that diverge *from
each other*, and a distance dial that moves both further out together.

## Brand

Assets live in `public/` (marks, favicons, social cards, manifest). Fonts are
self-hosted Outfit + Playfair Display Black — no CDN.

The stage stays dark even though the brand is warm and light: Cover Flow's
depth cues are shadow and reflection, and album art is composed against black
far more often than cream, so a sand ground would flatten every cover on it.
The palette is the brand's own dark-mode block — warm ink `#1C1611`, sand text,
orange as the accent.

The tagline is live text, never the SVG: an SVG in an `<img>` is font-isolated
and would fall back to a generic serif, and recolouring the raster for a dark
ground turns the orange `music` teal — flattening the two-face, two-colour
switch that carries the joke.

## Hosting

Static app on GitHub Pages, catalog on Turso (both free at this scale — see
*Known gaps*). `vite.config.ts` uses `base: './'`, so the same build serves
from `jj-noonan.github.io/album-guide/` and from a custom domain with no rebuild.

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and
publishes to Pages.

To move it to a custom domain (`album.guide` once registered): add a `public/CNAME` file containing
that hostname, then point a DNS `CNAME` record at `noonhub.github.io`. Don't add
the file before the DNS record exists — Pages will serve 404s at the old URL in
the gap.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

Node only — no virtualenv needed for the app itself. Python is used solely by
the offline crawler, which has its own venv:

```bash
python3 -m venv .venv && .venv/bin/pip install requests
npm run crawl:deep   # resumable; safe to interrupt with ctrl-c
```

The catalog lives in `data/catalog.sqlite`. The crawler re-exports
`src/data/catalog.json` as it goes and Vite hot-reloads it, so the app grows
while it is running.

For a multi-day run, detach it — all state is in SQLite, so it picks up exactly
where it stopped:

```bash
nohup .venv/bin/python -u scripts/crawl.py --pages 3 --sweeps 100 > data/crawl.log 2>&1 &
tail -f data/crawl.log
```

| command | what it does |
| --- | --- |
| `npm run dev` | dev server with HMR |
| `npm run build` | production build to `dist/` |
| `npm run crawl` | harvest albums from MusicBrainz (resumable) |
| `npm run crawl:deep` | long-running deep crawl, 3 pages per slice per sweep |
| `npm run ratings` | fetch MusicBrainz community ratings, deployed albums first |
| `npm run backfill` | fill in ListenBrainz popularity for new albums |
| `npm run export` | rebuild `catalog.json` from SQLite |
| `npm run db` | open the catalog in the sqlite3 shell |
| `npm run walk` | simulate walks in the terminal — the fast loop for tuning recommendations |
| `npm run eval` | score the recommender against independent similarity data |
| `npm run eval:fetch` | refresh that ground truth from ListenBrainz Labs |
| `npm run reach` | how much of the catalog the engine can actually offer |
| `npm run ingest-check` | exercise search-driven ingest against the live APIs |
| `npm run check` | server-render the app and assert its structure |

`npm run walk -- --dial 0.9 --steps 10` is the quickest way to judge whether a
change to the lexicon or the scorer actually improved anything.

## How the catalog is built

`scripts/crawl.py` pulls from MusicBrainz and the Cover Art Archive. No API
keys. Two decisions shape the result:

**Corridors, not an even spread.** The catalog is organised as eleven walkable
lineages (`src/data/corridors.ts`) — krautrock → post-punk → industrial → early
techno, spiritual jazz → sampling-era hip-hop → beat scene, and so on. A uniform
spread across genre × decade would leave roughly six albums per cell, so every
branch would be a wild leap and the distance dial would mean nothing. Corridors
keep short steps available while still reaching a long way. Where corridors
touch, the crossings become the high-value "wider" branches.

**Stratified by popularity.** MusicBrainz orders a tag search by text
relevance, which is uncorrelated with how known a record is; taking the top N
yields an arbitrary slice that skews almost entirely obscure. When sampling
(`--sample N`), the crawler fetches ListenBrainz listen counts and takes a
spread across popularity quartiles. Deep cuts still dominate, but Faust and
Neu! are in there alongside Dzyan and Os Mundi — without anchors there is
nothing to orient by, and the obscurity signal has no range.

**Sliced by decade, and resumable.** A crawl unit is (corridor, tag, decade),
and each slice keeps its own `next_offset` in SQLite. This matters more than it
looks: MusicBrainz returns the same relevance-ordered results for a given
query every time, so a crawler that re-runs the same query finds *nothing* new
on its second pass. Persisting the offset is what makes a multi-day crawl
productive. Slicing by release date also multiplies how much of a large tag
the search API will surface, and balances eras by construction rather than by
sampling after the fact — an earlier popularity-only crawl came out 58%
post-2010 and only 16% pre-1990.

## How a branch is chosen

Every album is placed in a 7-axis space — era, energy, density, brightness,
organic↔electronic, conventional↔experimental, instrumental↔vocal. Positions
come from `src/data/lexicon.ts`, which maps MusicBrainz tags onto those axes by
hand. That mapping is the actual recommendation signal: community tags tell you
what a record is *filed under*, not what it sounds like. It lives in TypeScript
rather than in the crawler so tuning it is a hot-reload away, not a re-crawl.

`pickBranches()` then:

1. sets a **target** distance from the dial — not a maximum, so turning it up
   moves both offers outward rather than merely widening the spread;
2. scores candidates by how close they land to that target, with a novelty
   bonus that scales with the dial (reaching further should also mean reaching
   past the canon, which is why there's no separate obscurity slider);
3. fills two asymmetric roles — `deeper` stays in your current lineage, `wider`
   hands you to a bordering one;
4. picks the **pair** that maximises the distance between the two offers,
   because two good branches leading to the same place are only one branch.

Offers are deterministic per album, so stepping back and forward again gives
you the same two choices.

## The two scores

**Popularity** is distinct listeners, not plays — plays are dominated by
whoever put a record on two hundred times.

**Quality** is devotion: listens per listener, shrunk toward the catalog median
by listener count, boosted by the MusicBrainz community rating where one
exists. Burial's *Untrue* draws 48 plays per listener against a chart hit's 10
on comparable totals.

Ratings have no bulk endpoint — one request per album — so coverage is always
partial and the queue order is what makes it worth having. Priority is
**deployed albums first, then most-listened**. The export samples across every
popularity decile, so ranking purely by listeners would leave the obscure half
of the *live* catalog unrated for hours, and that half is exactly what the far
end of the terrain dial serves.

Once the deployed set is covered the same queue rolls onto everything else, so
the crawler's interleaved pass (every 15 slices) keeps rating freshly harvested
albums without a separate step. Re-exporting re-marks the deployed set, so the
priority follows whatever is actually live.

## Validating the recommender

`npm run eval` scores offers against **ListenBrainz Labs similar-artists**,
which derives similarity from collaborative filtering over real listening
sessions. That independence is the point: this engine reasons from MusicBrainz
tags, so agreeing with a tag-derived source would prove nothing.

The metric is deliberately not a single number. Agreement should be **high at
Sidewalk and fall toward Bushwhack** — the far end of the dial exists to leave
the neighbourhood, and an engine that matched a similarity model at every
setting would have a broken dial rather than good recommendations. The suite
asserts two things: near-end agreement clearly beats chance, and the curve
declines as the dial opens.

An early version averaged all five settings, scored 2.0% against a 2.4% chance
rate, and looked like it was losing to random. It was averaging in three
settings that are supposed to disagree. Worth remembering before trusting any
aggregate here.

Current: **3.8x chance at the near end** (10.8% against 2.81%), declining
cleanly to 0% at Bushwhack. Ten seed artists spread across idioms so the suite
cannot pass by being good at one kind of music.

## Data model

The catalog is SQLite (`data/catalog.sqlite`); `src/data/schema.ts` mirrors it
exactly, so the TypeScript model and the database stay one design rather than
two that drift. Everything the engine touches is an `Item` with a `kind`
discriminator — only `album` is populated today, but artists, sub-genres and
micro-eras slot in as new rows plus one card renderer, without the engine
changing. The shape is flat and FK-shaped so it maps onto SQL directly when the
catalog outgrows a JSON file:

```
artists(id, name, sort_name, country, began_year, ended_year)
items(id, kind, title, artist_id, year_start, art_url, listen_count, obscurity, …)
item_tags(item_id, tag, count)
item_corridors(item_id, corridor_id)
edges(from_id, to_id, relation, weight)
crawl_units(corridor_id, tag, decade, next_offset, exhausted, total)
jobs(kind, payload, state, attempts)      -- for search-driven ingest
items_fts                                  -- FTS5, prefix='2 3 4'
```

## Known gaps

- **Deep links are search URLs.** Exact Spotify/Apple album IDs need a Spotify
  developer app and secret; the search URLs open the right record without
  credentials. Spotify also deprecated `/v1/recommendations` and audio-features
  for new apps in late 2024, so the recommendation logic deliberately doesn't
  depend on them.
- **No taste layer yet.** The schema has room for a `user_follows` table and an
  `excluded` flag, so loading a followed-artists list is a data load rather than
  a refactor.
- **`catalog.json` is bundled**, so the export is capped (`--export-limit`,
  default 12k). The cap samples across all ten popularity deciles rather than
  taking the most-listened: the far end of the terrain dial aims at the obscure
  half, and a top-N export would quietly delete the very records it asks for.
  Within each decile the highest-quality albums win the slots. Past ~30k the app
  needs an API rather than a bundled catalog.
- **Vectors are still derived in the browser** on load. They move to write-time
  columns in `items.vector` when the catalog outgrows the export.
- **Ingest is client-side only.** Searching something the catalog lacks pulls
  it live from MusicBrainz + Cover Art Archive in the browser (both send
  `Access-Control-Allow-Origin: *`), so the album is usable in about a second
  and persists in `localStorage`. Making it permanent is still manual:
  `copy(segueQueue().join('\n'))` in the console, then
  `pbpaste | python3 scripts/ingest_mbids.py`. A real API would close this loop.
- **Ingested albums have no neighbourhood.** They land in whichever corridors
  their tags imply, which makes them offerable — but the artist's other
  releases and same-tag peers aren't pulled with them, so they sit thinly
  connected until a crawl sweep catches up.
