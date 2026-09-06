import type { Item } from '../data/schema';

/**
 * Per-listener feedback on offers.
 *
 * Two jobs, deliberately not three. It steers the engine live (a downvoted
 * record stops being offered, an upvoted one is favoured), and it accumulates
 * a record you can read back or hand over for analysis. Tailoring per user
 * across sessions and devices needs an account system and a server, and is not
 * worth reaching for yet.
 *
 * Stored in localStorage, so it is per-browser and private. That is a real
 * limit — feedback cannot be aggregated across people without a backend — but
 * it means the feature costs nothing to ship and reveals nothing about anyone.
 */
const KEY = 'segue.feedback.v1';

export type Verdict = 'good' | 'bad' | 'meh';

export interface Entry {
  /** Album judged. */
  id: string;
  verdict: Verdict;
  at: string;
  /** Where it was offered from, so a bad *pairing* is distinguishable from a
   *  bad *record*. The same album can be right after one thing and wrong after
   *  another, and conflating those would throw away the more useful signal. */
  fromId?: string;
  /** Terrain setting in force, so we can tell "wrong" from "wrong for here". */
  dial?: number;
  role?: 'deeper' | 'wider' | 'shuffle';
  title?: string;
  artist?: string;
  fromTitle?: string;
}

function read(): Entry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

function write(entries: Entry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-1000)));
  } catch {
    // Storage blocked or full; feedback is a convenience, not a requirement.
  }
}

export function record(entry: Entry): void {
  const all = read().filter(
    (e) => !(e.id === entry.id && e.fromId === entry.fromId),
  );
  all.push(entry);
  write(all);
}

export function all(): Entry[] {
  return read();
}

export function clear(): void {
  write([]);
}

/** Latest verdict for one album from one source, if any. */
export function verdictFor(id: string, fromId?: string): Verdict | null {
  const all = read();
  const exact = [...all].reverse().find((e) => e.id === id && e.fromId === fromId);
  if (exact) return exact.verdict;
  const any = [...all].reverse().find((e) => e.id === id);
  return any?.verdict ?? null;
}

export interface Weights {
  /** Album-level multipliers, applied wherever the album is a candidate. */
  byItem: Map<string, number>;
  /** Pair-level multipliers, applied only for that source -> candidate move. */
  byPair: Map<string, number>;
}

/**
 * Turn feedback into score multipliers.
 *
 * A judgement of the *pair* is stronger evidence than one about the album, so
 * it bites harder: rejecting a record after this one says little about the
 * record in general, but a lot about the step. Downvotes are heavier than
 * upvotes are generous — people reach for the thumbs-down when something is
 * wrong, and rarely bother to praise a merely reasonable pick.
 */
export function weights(): Weights {
  const byItem = new Map<string, number>();
  const byPair = new Map<string, number>();
  for (const e of read()) {
    const item = e.verdict === 'bad' ? 0.35 : e.verdict === 'good' ? 1.5 : 0.9;
    const pair = e.verdict === 'bad' ? 0.1 : e.verdict === 'good' ? 2.0 : 0.8;
    byItem.set(e.id, Math.min(byItem.get(e.id) ?? item, item));
    if (e.fromId) byPair.set(`${e.fromId}>${e.id}`, pair);
  }
  return { byItem, byPair };
}

/** Counts for the debug panel, and for handing back for analysis. */
export function summary() {
  const all = read();
  const by = { good: 0, bad: 0, meh: 0 } as Record<Verdict, number>;
  for (const e of all) by[e.verdict]++;
  return { total: all.length, ...by };
}

/** A readable dump, for pasting somewhere it can be looked at properly. */
export function exportText(byId: Map<string, Item>): string {
  const rows = read().map((e) => {
    const it = byId.get(e.id);
    const from = e.fromId ? byId.get(e.fromId) : undefined;
    return [
      e.verdict.toUpperCase().padEnd(4),
      (e.role ?? '').padEnd(7),
      `dial ${(e.dial ?? 0).toFixed(2)}`,
      `${it?.subtitle ?? e.artist ?? '?'} — ${it?.title ?? e.title ?? '?'}`,
      from || e.fromTitle ? `  (after ${from?.subtitle ?? ''} — ${from?.title ?? e.fromTitle})` : '',
    ].join('  ');
  });
  return [`album.guide feedback — ${rows.length} judgements`, ...rows].join('\n');
}
