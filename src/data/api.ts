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

/** Candidates for one card. Phase 1: the client still scores them. */
export async function fetchRecs(
  id: string,
  dial: number,
  limit = 240,
): Promise<Item[]> {
  const out = await get<{ candidates: RawAlbum[] }>(
    `/v1/recs?id=${encodeURIComponent(id)}&dial=${dial.toFixed(2)}&limit=${limit}`,
  );
  return out ? out.candidates.map(toItem) : [];
}

export async function searchApi(q: string, limit = 12): Promise<Item[]> {
  const out = await get<{ items: RawAlbum[] }>(
    `/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
  return out ? out.items.map(toItem) : [];
}
