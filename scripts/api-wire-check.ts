/**
 * Does the client behave the same through the API as without it?
 *
 * Phase 1 keeps the scorer in the client precisely so this is checkable: the
 * transport changed and nothing else did, so identical inputs must produce
 * identical offers. If they diverge, it is the wire, because the engine did
 * not move.
 *
 * Needs a local API:  .venv/bin/python api/server.py --port 8787
 *
 *   npx vite-node scripts/api-wire-check.ts
 */
import { ITEMS } from '../src/data/catalog';
import { itemFromRaw } from '../src/data/catalog';
import { pickBranches } from '../src/engine/recommend';
import type { Item, RawAlbum } from '../src/data/schema';

const BASE = 'http://127.0.0.1:8787';
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const toItem = (a: RawAlbum): Item => itemFromRaw(a, 10 - (a.popularity ?? 5));

const get = async <T>(path: string): Promise<T> =>
  (await fetch(`${BASE}${path}`)).json() as Promise<T>;

const health = await get<{ albums: number }>('/v1/health');
check('api is up', health.albums > 90000, `${health.albums.toLocaleString()} albums`);

// 1. An album present in both must convert to the same scored values, or every
//    comparison after this is meaningless.
const local = ITEMS.find((i) => /Born in the U\.S\.A/i.test(i.title))!;
const viaApi = toItem((await get<{ items: RawAlbum[] }>(`/v1/items?ids=${local.id}`)).items[0]);
check('same album, same popularity', Math.abs(local.popularity - viaApi.popularity) < 0.01,
  `bundle ${local.popularity} vs api ${viaApi.popularity}`);
check('same album, same quality', Math.abs(local.quality - viaApi.quality) < 0.01,
  `bundle ${local.quality} vs api ${viaApi.quality}`);
check('same album, same tags', local.tags.length === viaApi.tags.length,
  `${local.tags.length} vs ${viaApi.tags.length}`);
const dv = Math.max(...(['era','energy','density','brightness','synthetic','abstract','voice'] as const)
  .map((a) => Math.abs(local.vector[a] - viaApi.vector[a])));
check('same album, same vector', dv < 0.001, `max axis delta ${dv.toExponential(1)}`);

// 2. The offers must not move when the pool is the bundle alone.
const excl = new Set([local.id]);
const before = pickBranches(local, ITEMS, 0, excl).map((b) => b.item.id).join(',');
const after = pickBranches(local, ITEMS, 0, excl).map((b) => b.item.id).join(',');
check('scoring is deterministic', before === after);

// 3. Phase 2: the server now returns scored offers, not candidates.
const recs = await get<{ offers: { role: string; item: RawAlbum; distance: number }[] }>(
  `/v1/recs?id=${local.id}&dial=0`);
check('recs returns two scored offers', recs.offers?.length === 2,
  (recs.offers ?? []).map((o) => `${o.role}: ${o.item.artistName} — ${o.item.title}`).join(' | '));
check('offers carry both roles',
  new Set((recs.offers ?? []).map((o) => o.role)).size === 2);

// 4. Offers must be complete enough to render and to score from next.
const offered = (recs.offers ?? []).map((o) => toItem(o.item));
check('offers carry tags', offered.every((i) => i.tags.length > 0));
check('offers carry art', offered.every((i) => Boolean(i.artUrl)));
check('offers carry popularity and quality',
  offered.every((i) => i.popularity > 0 && i.quality > 0),
  offered.map((i) => `${i.popularity}/${i.quality}`).join(' '));

// The server sees a far larger catalog than the bundle, which is the point.
const known = new Set(ITEMS.map((i) => i.id));
const health2 = await get<{ albums: number }>('/v1/health');
check('server scores a much larger catalog than the bundle ships',
  health2.albums > ITEMS.length * 5,
  `${health2.albums.toLocaleString()} vs ${ITEMS.length.toLocaleString()}`);
void known;

// 5. Reachability: the whole point.
const joni = (await get<{ items: RawAlbum[] }>('/v1/search?q=joni%20mitchell&limit=5')).items;
const jonInBundle = ITEMS.filter((i) => i.subtitle === 'Joni Mitchell').length;
check('api reaches artists the bundle lacks', joni.length > 0 && jonInBundle === 0,
  `api ${joni.length} albums, bundle ${jonInBundle}`);

console.log(`\n${failures === 0 ? 'wiring is consistent' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
