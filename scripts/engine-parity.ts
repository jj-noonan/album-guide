/**
 * Dump what the TypeScript engine decides, for the Python port to be checked
 * against. Writes offers for a spread of seeds across every dial setting.
 */
import { writeFileSync } from 'node:fs';
import { ITEMS } from '../src/data/catalog';
import { pickBranches, TUNING } from '../src/engine/recommend';

// A fixed spread: famous and obscure, well and thinly tagged, across eras.
const seeds = ITEMS.filter((_, i) => i % 811 === 0).slice(0, 40);
const dials = [0, 0.25, 0.5, 0.75, 1];
const out: Record<string, string[]> = {};

for (const seed of seeds) {
  for (const dial of dials) {
    const bs = pickBranches(seed, ITEMS, dial, new Set([seed.id]));
    out[`${seed.id}|${dial}`] = bs.map((b) => `${b.role}:${b.item.id}`);
  }
}
writeFileSync(new URL('../data/parity-ts.json', import.meta.url),
  JSON.stringify({ tuning: TUNING, cases: out }, null, 1));
console.log(`${seeds.length} seeds x ${dials.length} dials -> data/parity-ts.json`);
