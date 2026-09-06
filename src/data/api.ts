import { itemFromRaw } from './catalog';
import type { Item, RawAlbum } from './schema';

/**
 * Client for the catalog API.
 *
 * The bundled catalog is 12,000 albums of 100,931, chosen by stratified
 * sampling — Joni Mitchell has 21 records in the database and none in the
 * bundle. This is how the other 88% becomes reachable.
 *
 * Every call degrades to null rather than throwing. The site is served from
 * static hosting and the API is a separate deployment that can be absent,
 * asleep, or mid-deploy; when it is, the app falls back to the bundled catalog
 * and keeps working exactly as it did before. An unreachable API must never be
 * the difference between a working page and a blank one.
 */

/** Empty in the default build, so nothing changes until it is deployed. */
const BASE = (import.meta.env?.VITE_API_BASE ?? '').replace(/\/$/, '');

export const apiConfigured = (): boolean => BASE.length > 0;

/** Slow requests are worse than no requests: the bundled catalog is right here. */
const TIMEOUT_MS = 4000;

async function get<T>(path: string): Promise<T | null> {
  if (!BASE) return null;
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ctl.signal });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    // Offline, asleep, CORS, malformed — all the same answer here.
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * The API sends the same shape the bundle does, so conversion is the same
 * function. Obscurity is derived from popularity rather than sent, exactly as
 * the bundled path does it, so an album scores identically whichever route it
 * arrived by — which is the property that makes the swap verifiable.
 */
const toItem = (a: RawAlbum): Item => itemFromRaw(a, 10 - (a.popularity ?? 5));

export async function fetchItems(ids: string[]): Promise<Item[]> {
  if (!ids.length) return [];
  const out = await get<{ items: RawAlbum[] }>(`/v1/items?ids=${ids.join(',')}`);
  return out ? out.items.map(toItem) : [];
}

export interface ApiOffer {
  role: 'deeper' | 'wider';
  item: Item;
  distance: number;
}

/**
 * Two scored offers for one card, chosen from the whole catalog.
 *
 * The scorer runs on the server now, over ~89,000 scorable albums rather than
 * the ~11,500 the client holds. It is a port of the client's engine and is
 * checked against it — api/parity-check.py requires identical albums in
 * identical roles for the same seeds at every dial setting, so this returns
 * what the client would have returned given the same catalog.
 *
 * Null, not an empty array, when the API has nothing to say: the caller has to
 * tell "the server chose these" from "ask the local engine instead", and an
 * empty array would collapse the two.
 */
export async function fetchOffers(
  id: string,
  dial: number,
): Promise<ApiOffer[] | null> {
  const out = await get<{ offers?: { role: string; item: RawAlbum; distance: number }[] }>(
    `/v1/recs?id=${encodeURIComponent(id)}&dial=${dial.toFixed(2)}`,
  );
  if (!out?.offers?.length) return null;
  return out.offers.map((o) => ({
    role: o.role === 'wider' ? 'wider' : 'deeper',
    item: toItem(o.item),
    distance: o.distance,
  }));
}

/*
 * Offers already fetched, keyed by card and dial.
 *
 * Module-level rather than React state on purpose: it survives re-renders and
 * is read during render by the card that needs it, so a card whose offers have
 * already arrived shows them immediately instead of showing local ones and
 * swapping a second later.
 */
const offerCache = new Map<string, ApiOffer[]>();
const inFlight = new Set<string>();
const key = (id: string, dial: number) => `${id}|${dial.toFixed(2)}`;

/** Offers already in hand for this card, if any. */
export function cachedOffers(id: string, dial: number): ApiOffer[] | undefined {
  return offerCache.get(key(id, dial));
}

/**
 * Fetch offers and remember them.
 *
 * Deduplicated: landing on a card triggers a fetch for it and, once that
 * lands, prefetches for both of its offers — so the same card is often asked
 * for twice within a second.
 */
export async function loadOffers(id: string, dial: number): Promise<ApiOffer[] | null> {
  const k = key(id, dial);
  const hit = offerCache.get(k);
  if (hit) return hit;
  if (inFlight.has(k)) return null;
  inFlight.add(k);
  try {
    const offers = await fetchOffers(id, dial);
    if (offers) {
      // Bounded: a long session would otherwise keep every card ever seen.
      if (offerCache.size > 240) offerCache.clear();
      offerCache.set(k, offers);
    }
    return offers;
  } finally {
    inFlight.delete(k);
  }
}

/**
 * Warm the cache for cards the listener can reach in one click.
 *
 * The server takes about a second, which is fine to wait for once and
 * irritating to wait for at every step. Fetching the next two while the
 * current card is being looked at means the swap happens on the first card
 * only; after that, choosing an offer shows server-scored offers immediately.
 */
export function prefetchOffers(ids: string[], dial: number): void {
  if (!apiConfigured()) return;
  for (const id of ids) {
    if (!offerCache.has(key(id, dial))) void loadOffers(id, dial);
  }
}

export async function searchApi(q: string, limit = 12): Promise<Item[]> {
  const out = await get<{ items: RawAlbum[] }>(
    `/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
  return out ? out.items.map(toItem) : [];
}
