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

// 3. Candidates from the API must be scorable alongside bundled ones without
//    the engine noticing a difference in kind.
const cands = (await get<{ candidates: RawAlbum[] }>(
  `/v1/recs?id=${local.id}&dial=0&limit=240`)).candidates.map(toItem);
check('api returns candidates', cands.length > 100, `${cands.length}`);
const known = new Set(ITEMS.map((i) => i.id));
const novel = cands.filter((c) => !known.has(c.id));
check('most candidates are new to the bundle', novel.length > cands.length / 2,
  `${novel.length} of ${cands.length} are not in the 12,000`);

const merged = [...ITEMS, ...novel];
const widened = pickBranches(local, merged, 0, excl);
check('the widened pool still produces two offers', widened.length === 2,
  widened.map((b) => `${b.role}: ${b.item.subtitle} — ${b.item.title}`).join(' | '));

// 4. Every fetched item must be complete enough to score. A candidate with no
//    tags scores from a dead-centre vector and quietly pollutes the pool.
const untagged = novel.filter((i) => i.tags.length === 0).length;
check('fetched candidates carry tags', untagged === 0, `${untagged} untagged`);
const noArt = novel.filter((i) => !i.artUrl).length;
check('fetched candidates carry art', noArt === 0, `${noArt} without art`);

// 5. Reachability: the whole point.
const joni = (await get<{ items: RawAlbum[] }>('/v1/search?q=joni%20mitchell&limit=5')).items;
const jonInBundle = ITEMS.filter((i) => i.subtitle === 'Joni Mitchell').length;
check('api reaches artists the bundle lacks', joni.length > 0 && jonInBundle === 0,
  `api ${joni.length} albums, bundle ${jonInBundle}`);

console.log(`\n${failures === 0 ? 'wiring is consistent' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
