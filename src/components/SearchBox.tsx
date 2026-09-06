import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../data/schema';
import { ingest, validate, enqueue, noteSearchHit, type Candidate } from '../engine/ingest';
import { apiConfigured, searchApi } from '../data/api';
import { useToast } from './Toast';
import './SearchBox.css';

const LIMIT = 8;

function normalise(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Rank a candidate against the query.
 *
 * Deliberately crude, because it is a stopgap: this scans the catalog the
 * browser already has, which works while the export is capped in the tens of
 * thousands. The real one is FTS5 behind an API — `items_fts` already exists
 * with prefix indexes, and this component only has to swap where `results`
 * comes from.
 *
 * Ordering favours a title that starts with the query, then an artist that
 * does, then anything containing it — and breaks ties by listen count so the
 * record someone is most likely to have meant surfaces first.
 */
function score(item: Item, q: string): number {
  const title = normalise(item.title);
  const artist = normalise(item.subtitle);
  if (title === q || artist === q) return 100;
  if (title.startsWith(q)) return 80;
  if (artist.startsWith(q)) return 70;
  if (title.includes(q)) return 50;
  if (artist.includes(q)) return 40;
  return 0;
}

interface Props {
  /** The live pool, including anything ingested this session. */
  pool: Item[];
  onPick: (item: Item) => void;
  onIngest: (item: Item) => void;
  /** Lets the flow stand its arrow keys down while the overlay is up. */
  onOpenChange?: (open: boolean) => void;
}

export function SearchBox({ pool, onPick, onIngest, onOpenChange }: Props) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const open = rawOpen;
  const setOpen = (v: boolean) => {
    setRawOpen(v);
    onOpenChange?.(v);
  };
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * Matches from the API, merged in beneath local ones.
   *
   * The local index only covers the 12,000 bundled albums, so searching for
   * something in the other 88% found nothing and fell through to a live
   * MusicBrainz lookup — slower, and it re-fetched records the catalog already
   * held. Joni Mitchell has 21 albums in the database and none in the bundle.
   *
   * Local results still come first and appear instantly; these arrive when
   * they arrive. With no API they never arrive and nothing changes.
   */
  const [apiHits, setApiHits] = useState<Item[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!apiConfigured() || q.length < 2) {
      setApiHits([]);
      return;
    }
    let live = true;
    // Debounced: a request per keystroke would spend most of them on prefixes
    // nobody is looking for.
    const t = window.setTimeout(() => {
      void searchApi(q).then((items) => { if (live) setApiHits(items); });
    }, 180);
    return () => { live = false; window.clearTimeout(t); };
  }, [query]);

  const results = useMemo(() => {
    const q = normalise(query.trim());
    if (q.length < 2) return [];
    const hits: { item: Item; s: number }[] = [];
    for (const item of pool) {
      const s = score(item, q);
      // 10 - obscurity recovers the popularity ordering as a tie-break.
      if (s > 0) hits.push({ item, s: s * 100 + (10 - item.obscurity) });
    }
    hits.sort((a, b) => b.s - a.s);
    const local = hits.slice(0, LIMIT).map((h) => h.item);
    if (!apiHits.length) return local;
    // Local first, then anything the API found that is not already listed.
    const seen = new Set(local.map((i) => i.id));
    return [...local, ...apiHits.filter((i) => !seen.has(i.id))].slice(0, LIMIT);
  }, [query, pool, apiHits]);

  useEffect(() => setCursor(0), [query]);

  /*
   * Inline completion.
   *
   * The dropdown already lists matches, but a ghost completion answers a
   * different question: it tells you the catalog has this before you finish
   * typing, and lets you take it without leaving the keyboard. Only offered on
   * a true prefix — completing the middle of a string reads as the field
   * fighting you.
   */
  const ghost = useMemo(() => {
    const raw = query.trim();
    if (raw.length < 2 || !results.length) return '';
    const q = normalise(raw);
    for (const field of [results[0].title, results[0].subtitle]) {
      if (normalise(field).startsWith(q) && field.length > raw.length) {
        return field.slice(raw.length);
      }
    }
    return '';
  }, [query, results]);

  const acceptGhost = () => {
    if (!ghost) return false;
    setQuery(query.trim() + ghost);
    return true;
  };

  // "/" focuses search from anywhere, the way every search field on the web does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
   * When the catalog can't answer, ask MusicBrainz.
   *
   * "Inconclusive" is deliberately generous — fewer than three local hits.
   * A single weak match is usually not the record someone meant, and the whole
   * point is that a search should never be a dead end.
   */
  const [remote, setRemote] = useState<Candidate[]>([]);
  const [probing, setProbing] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || results.length >= 3) {
      setRemote([]);
      setProbing(false);
      return;
    }
    const ctl = new AbortController();
    setProbing(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await validate(q, ctl.signal);
        setRemote(found.slice(0, 5));
        if (found.length === 0) {
          enqueue({ query: q, mbid: null, title: q, state: 'failed', at: new Date().toISOString() });
          toast(<>No record named <strong>{q}</strong> in MusicBrainz.</>, 'warn');
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          toast(<>Couldn't reach MusicBrainz just now.</>, 'warn');
        }
      } finally {
        setProbing(false);
      }
    }, 650);
    return () => {
      ctl.abort();
      window.clearTimeout(timer);
    };
  }, [query, results.length, toast]);

  const addRemote = async (c: Candidate) => {
    setAdding(c.id);
    try {
      const item = await ingest(c);
      enqueue({ query: query.trim(), mbid: c.id, title: c.title, state: 'ingested', at: new Date().toISOString() });
      onIngest(item);
      onPick(item);
      toast(<>Added <strong>{c.title}</strong> — {c.artistName}</>, 'ok');
      setQuery('');
      setOpen(false);
      inputRef.current?.blur();
    } catch (err) {
      enqueue({ query: query.trim(), mbid: c.id, title: c.title, state: 'failed', at: new Date().toISOString() });
      const why = (err as Error).message;
      toast(<><strong>{c.title}</strong> couldn't be added — {why}.</>, 'warn');
    } finally {
      setAdding(null);
    }
  };

  const pick = (item: Item) => {
    // A person searching their way to a record is a stronger signal than
    // anything the crawler infers. Recorded now, weighted later.
    noteSearchHit(item, query.trim());
    onPick(item);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Arrow keys drive the flow globally; inside the field they belong to the
    // result list, so stop them here rather than letting both fire.
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) e.stopPropagation();
    const atEnd =
      inputRef.current &&
      inputRef.current.selectionStart === inputRef.current.value.length;
    if ((e.key === 'Tab' || (e.key === 'ArrowRight' && atEnd)) && ghost) {
      e.preventDefault();
      acceptGhost();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter' && results[cursor]) {
      e.preventDefault();
      pick(results[cursor]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };


  return (
    <>
      {/* Collapsed: a pill at the bottom of the stage. */}
      <button className="searchtrigger" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.6-3.6" strokeLinecap="round" />
        </svg>
        <span>Search an album or artist…</span>
        <kbd>/</kbd>
      </button>

      {open && (
        <div className="searchpanel" role="dialog" aria-modal="true" aria-label="Search">
          <div className="searchpanel__scrim" onClick={() => setOpen(false)} />
          <div className="searchpanel__box" ref={boxRef}>
            <div className="search__field">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.6-3.6" strokeLinecap="round" />
              </svg>
              <span className="search__wrap">
                <input
                  ref={inputRef}
                  value={query}
                  placeholder="Search an album or artist to jump there…"
                  aria-label="Search the catalog"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                />
                {ghost && (
                  <span className="search__ghost" aria-hidden="true">
                    <span className="search__typed">{query}</span>
                    {ghost}
                    <span className="search__tab">tab</span>
                  </span>
                )}
              </span>
              <button className="search__clear" onClick={() => setOpen(false)} aria-label="Close search">
                ×
              </button>
            </div>

            {query.trim().length >= 2 && (
              <div className="search__results" role="listbox">
                {results.length === 0 && !probing && remote.length === 0 ? (
                  <p className="search__empty">
                    Nothing here, and nothing in MusicBrainz either.
                  </p>
                ) : (
                  results.map((item, i) => (
                    <button
                      key={item.id}
                      className="search__row"
                      role="option"
                      aria-selected={i === cursor}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => pick(item)}
                    >
                      {item.artThumbUrl ? (
                        <img className="search__art" src={item.artThumbUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="search__art" />
                      )}
                      <span className="search__meta">
                        <span className="search__title">{item.title}</span>
                        <span className="search__artist">{item.subtitle}</span>
                      </span>
                      <span className="search__year">{item.yearStart ?? ''}</span>
                    </button>
                  ))
                )}

                {(probing || remote.length > 0) && (
                  <>
                    <p className="search__section">
                      {probing ? 'Looking further afield…' : 'Not in the catalog yet'}
                    </p>
                    {remote.map((c) => (
                      <button
                        key={c.id}
                        className="search__row search__row--remote"
                        onClick={() => addRemote(c)}
                        disabled={adding !== null}
                      >
                        <span className="search__art search__art--new">+</span>
                        <span className="search__meta">
                          <span className="search__title">{c.title}</span>
                          <span className="search__artist">{c.artistName}</span>
                        </span>
                        <span className="search__year">
                          {adding === c.id ? 'adding…' : c.year ?? ''}
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
