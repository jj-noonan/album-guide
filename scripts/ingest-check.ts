/**
 * Exercises the search-driven ingest against the live APIs.
 *
 *   npx vite-node scripts/ingest-check.ts -- "spiderland slint"
 */
// MusicBrainz 403s generic User-Agents; browsers are fine because they send
// their own. Node is not, so the harness supplies one.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init: any = {}) =>
  realFetch(input, {
    ...init,
    headers: { ...(init.headers ?? {}), 'User-Agent': 'album.guide-dev/0.1 (jj@noonan.cc)' },
  })) as typeof fetch;

import { validate, ingest } from '../src/engine/ingest';
import { ITEM_BY_ID } from '../src/data/catalog';

const query = process.argv.slice(2).filter((a) => a !== '--').join(' ') || 'spiderland slint';

console.log(`query: "${query}"`);
console.log('in bundled catalog already?',
  [...ITEM_BY_ID.values()].some((i) =>
    `${i.title} ${i.subtitle}`.toLowerCase().includes(query.toLowerCase())) ? 'yes' : 'no');

const found = await validate(query);
console.log(`\nvalidate -> ${found.length} candidates`);
for (const c of found.slice(0, 4)) {
  console.log(`  ${c.year ?? '????'}  ${c.artistName} — ${c.title}  [${c.tags.map(t => t.tag).slice(0,3).join(', ')}]`);
}

if (!found.length) {
  console.log('\nno candidates — the failure toast path would fire');
  process.exit(0);
}

const item = await ingest(found[0]);
console.log('\ningest ->');
console.log('  title     ', item.title, '·', item.subtitle, item.yearStart);
console.log('  art       ', item.artUrl?.slice(0, 78));
console.log('  corridors ', item.corridorIds.length ? item.corridorIds : '(none inferred)');
console.log('  vector    ', Object.entries(item.vector).map(([k, v]) => `${k}=${(v as number).toFixed(2)}`).join(' '));
console.log('  links     ', item.infoUrl);

const res = await fetch(item.artUrl!, { method: 'HEAD', redirect: 'follow' });
console.log('  art HTTP  ', res.status);
