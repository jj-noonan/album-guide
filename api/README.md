# seebugbus API

Read-only HTTP access to the catalog, so the client stops carrying it.

The browser currently downloads 12,000 albums at load — 1.9 MB gzipped — and
that is the whole catalog it can ever see. The database holds 100,931. Shipping
all of them would be a ~16 MB page load, so the export samples 12% and throws
the rest away: held-out evaluation seeds keep 392 albums in the database and 67
in the export, and Joni Mitchell has 21 and ships none.

## Shape

Three endpoints, all read-only, all returning the `Item` shape the client
already uses. No new schema, no mapping layer.

    GET /v1/items?ids=<mbid>,<mbid>      specific albums
    GET /v1/recs?id=<mbid>&dial=<0..1>   candidates for one card
    GET /v1/search?q=<text>&limit=<n>    replaces the bundled index

## Deliberately not

GraphQL, auth, write paths, per-user state, an ORM. This serves a public,
read-only catalog that changes when a crawl finishes. Feedback stays in the
browser until cross-device history is actually wanted, which is the point where
accounts and a write path start earning their cost.

## Phases

**Phase 1 (this):** `/v1/recs` returns a *candidate pool*. Scoring stays in the
client, in TypeScript, unchanged. That is the point — if held-out agreement is
the same before and after, the transport is correct. Moving the data and the
scorer at once would leave a regression unattributable to either.

**Phase 2 (later):** `/v1/recs` returns *scored offers* instead, so the engine
can consider all 100,931 albums rather than the 12,000 that fit in a bundle.
The endpoint already exists by then, so the client's question does not change —
only the answer does.

## Data

Reads `data/catalog-api.sqlite`, a copy of the crawl database with the crawl
bookkeeping dropped: 143 MB becomes 122 MB. Built by `make-api-db.py`. Nothing
writes to it at runtime, so it can be baked into an image and replaced whole.

## The open question for Phase 1: whose popularity scale?

`popularity` is a percentile, not a measurement, and the two sides currently
rank over different populations. The client ranks over the 12,000 albums it
ships; the API ranks over all 100,931. So the engine's `popularityNear: 9.8`
means roughly 12,000 listeners to the client and roughly 620 to the API — the
`/v1/recs` pool at the near end has a median of 619 listeners where the client
would expect around 12,000.

Nothing is broken today, because the client still scores albums it already
holds. It breaks the moment API candidates are scored alongside bundled ones,
and it will break quietly: the offers stay plausible and just skew obscure.

Two ways out.

**Rank globally, in the API.** Return `popularity` and `quality` computed over
the whole database and have the client stop deriving its own. One scale, and
the dial finally means the same thing everywhere. It changes `catalog.ts`, and
every tuning constant is currently calibrated against the 12,000-album
distribution, so the numbers in TUNING would need re-sweeping against the eval
once — which is exactly the kind of change the held-out split exists to check.

**Rank locally, per response.** The API returns raw `listenerCount` and the
client ranks whatever it is holding. Nothing changes in the engine, but the
scale then shifts with the contents of each response, which is worse: the same
album scores differently depending on what it arrived with.

The first is right. It is worth doing deliberately rather than discovering it
through drifting recommendations, and it should land with an eval run either
side of it.
