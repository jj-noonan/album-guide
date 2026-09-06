import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { CATALOG_STATS, ITEMS, ITEM_BY_ID } from './data/catalog';
import { CORRIDOR_BY_ID } from './data/corridors';
import type { Item } from './data/schema';
import {
  describeMove,
  pickBranches,
  pickStart,
  pickWildcard,
  type Branch,
} from './engine/recommend';
import { Flow, type FlowCard } from './components/Flow';
import { SearchBox } from './components/SearchBox';
import { Die, ROLL_MS } from './components/Die';
import { About } from './components/About';
import { Feedback } from './components/Feedback';
import { apiConfigured, fetchOffers, type ApiOffer } from './data/api';
import {
  weights as feedbackWeights,
  verdictFor,
  record as recordVerdict,
  type Verdict,
} from './engine/feedback';
import { Debug } from './components/Debug';
import { useAmbient } from './hooks/useAmbient';
import { DistanceDial } from './components/DistanceDial';

const STORAGE_KEY = 'segue.session.v1';
const INGEST_KEY = 'segue.ingested.v1';

interface Session {
  trail: string[];
  focusIndex: number;
  dial: number;
}

/** Albums pulled in from MusicBrainz this session, kept across reloads. */
function loadIngested(): Item[] {
  try {
    return JSON.parse(localStorage.getItem(INGEST_KEY) ?? '[]') as Item[];
  } catch {
    return [];
  }
}

function loadSession(validIds: ReadonlySet<string>): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    // A rebuilt catalog can drop albums out from under a saved trail.
    const trail = s.trail?.filter((id) => validIds.has(id)) ?? [];
    if (!trail.length) return null;
    return {
      trail,
      focusIndex: Math.min(s.focusIndex ?? 0, trail.length - 1),
      dial: typeof s.dial === 'number' ? s.dial : 0.5,
    };
  } catch {
    return null; // private browsing, cleared storage, or a stale shape
  }
}

export default function App() {
  const initialIngested = useMemo(loadIngested, []);
  const restored = useMemo(
    () => loadSession(new Set([...ITEM_BY_ID.keys(), ...initialIngested.map((i) => i.id)])),
    [initialIngested],
  );
  const [trail, setTrail] = useState<string[]>(() => {
    if (restored) return restored.trail;
    const start = pickStart(ITEMS, String(Date.now()));
    return start ? [start.id] : [];
  });
  const [focusIndex, setFocusIndex] = useState(restored?.focusIndex ?? 0);
  const [dial, setDial] = useState(restored?.dial ?? 0.5);

  /*
   * Albums ingested from search join the same pool as crawled ones, so the
   * engine treats them identically — they can be offered as branches, land as
   * a wildcard, and sit in the trail like anything else.
   */
  const [ingested, setIngested] = useState<Item[]>(initialIngested);
  /*
   * The pool the engine scores: what shipped, what search pulled in, and what
   * the API has supplied for cards seen this session. Merged rather than
   * swapped, so an absent API leaves the app exactly as it was.
   */
  const pool = useMemo(
    () => (ingested.length ? [...ITEMS, ...ingested] : ITEMS),
    [ingested],
  );
  /*
   * Offers scored by the server. Declared here because `byId` reads it during
   * render — the third time in this file that state used by a useMemo was
   * written below it, which is a ReferenceError at first paint rather than a
   * type error, so the compiler catching it is luck.
   */
  const [apiOffers, setApiOffers] = useState<ApiOffer[] | null>(null);

  const byId = useMemo(() => {
    if (!ingested.length && !apiOffers?.length) return ITEM_BY_ID;
    const m = new Map(ITEM_BY_ID);
    for (const i of ingested) m.set(i.id, i);
    // Server offers are albums the bundle may not hold; the trail looks them
    // up by id, so they have to be findable after they are chosen.
    for (const o of apiOffers ?? []) m.set(o.item.id, o.item);
    return m;
  }, [ingested, apiOffers]);

  const addIngested = useCallback((item: Item) => {
    setIngested((cur) => {
      if (cur.some((i) => i.id === item.id)) return cur;
      const next = [...cur, item];
      try {
        localStorage.setItem(INGEST_KEY, JSON.stringify(next.slice(-300)));
      } catch {
        // Storage full or blocked; the album still works this session.
      }
      return next;
    });
  }, []);

  const catalogSize = pool.length;

  const ambient = useAmbient(
    trail.length ? byId.get(trail[focusIndex]) ?? null : null,
  );

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ trail, focusIndex, dial }));
    } catch {
      // Storage is a convenience here; a failure shouldn't break the session.
    }
  }, [trail, focusIndex, dial]);

  /*
   * Re-seed when the catalog changes underneath us.
   *
   * The trail is seeded once, in useState's initializer. Open the page while
   * the crawler is still on its first corridor and that initializer sees an
   * empty catalog and produces an empty trail — and because Fast Refresh
   * preserves state, every later hot update re-renders with that same empty
   * trail. The app then sits on the loading screen forever even though the
   * data arrived minutes ago. Same hazard for a saved trail whose albums are
   * no longer in a rebuilt catalog.
   */
  useEffect(() => {
    const valid = trail.filter((id) => byId.has(id));
    if (valid.length === 0) {
      const start = pickStart(pool, String(Date.now()));
      if (start) {
        setTrail([start.id]);
        setFocusIndex(0);
      }
    } else if (valid.length !== trail.length) {
      setTrail(valid);
      setFocusIndex((i) => Math.min(i, valid.length - 1));
    }
  }, [trail, byId, pool, catalogSize]);

  const current = trail.length ? byId.get(trail[focusIndex]) ?? null : null;
  const previous = focusIndex > 0 ? byId.get(trail[focusIndex - 1]) ?? null : null;

  /*
   * Bumped on every verdict. Feedback lives in localStorage rather than React
   * state, so nothing re-renders on its own; this is the signal that makes a
   * thumbs-down take effect on the offers immediately instead of at the next
   * reload.
   */
  const [fbVersion, setFbVersion] = useState(0);
  const fbWeights = useMemo(() => feedbackWeights(), [fbVersion]);
  const noteFeedback = useCallback(() => setFbVersion((v) => v + 1), []);

  /*
   * Candidates fetched from the API for the card in focus.
   *
   * The bundled catalog is 12,000 albums of 100,931; these are the rest,
   * fetched for the card being looked at rather than downloaded up front.
   * Kept for the session so stepping back does not re-offer a different set,
   * which would silently rewrite a path the listener already walked.
   *
   * Nothing here is required. With no API configured, or one that is asleep or
   * unreachable, this stays empty and the engine scores the bundled catalog
   * exactly as it did before.
   */
  /*
   * Offers scored by the server, for the card in focus.
   *
   * The engine there sees ~89,000 albums against the ~11,500 bundled here, so
   * this is the difference between recommending from an eighth of the catalog
   * and recommending from all of it. Null until it answers — the local engine
   * fills the gap meanwhile, so there is never a moment with nothing to click.
   */

  useEffect(() => {
    if (!apiConfigured() || !current) {
      setApiOffers(null);
      return;
    }
    let live = true;
    setApiOffers(null);
    void fetchOffers(current.id, dial).then((offers) => {
      if (live) setApiOffers(offers);
    });
    return () => { live = false; };
  }, [current, dial]);

  const branches = useMemo<Branch[]>(() => {
    if (!current) return [];
    const exclude = new Set(trail.slice(0, focusIndex + 1));

    /*
     * Prefer the server's offers, which are scored over the whole catalog
     * rather than the slice that fits in a bundle.
     *
     * Two reasons they can still be refused. A verdict is stored in this
     * browser and never sent anywhere, so the server cannot know a step was
     * rejected and would keep offering it — feedback would silently stop
     * working the moment the API came online. And an offer already on the path
     * would send the listener in a circle.
     *
     * Falling back to the local engine rather than dropping the offer keeps
     * two doors on screen either way.
     */
    const usable = (apiOffers ?? []).filter(
      (o) => !exclude.has(o.item.id) && verdictFor(o.item.id, current.id) !== 'bad',
    );
    const picked =
      usable.length === 2
        ? usable.map((o) => ({
            item: o.item,
            reason: describeMove(current, o.item),
            corridorLabel: null,
            role: o.role,
            distance: o.distance,
          }))
        : pickBranches(current, pool, dial, exclude, fbWeights);

    // If you've walked past this card before, the branch you actually took has
    // to stay on offer — otherwise stepping back and then forward again would
    // silently rewrite your own history.
    const takenId = trail[focusIndex + 1];
    if (!takenId || picked.some((b) => b.item.id === takenId)) return picked;

    /*
     * Unless it was rejected. Preserving the taken branch normally beats
     * re-scoring it, but a "wrong turn" mark is the one case where the
     * listener has explicitly said this step should not have happened —
     * putting it back on screen would answer their judgement by repeating it.
     * The history it protects is the history they just disowned.
     */
    if (verdictFor(takenId, current.id) === 'bad') return picked;

    const taken = byId.get(takenId);
    if (!taken || picked.length < 2) return picked;

    const shares = taken.corridorIds.some((c) => current.corridorIds.includes(c));
    const role: Branch['role'] = shares ? 'deeper' : 'wider';
    const crossed = taken.corridorIds.find((c) => !current.corridorIds.includes(c));
    const replacement: Branch = {
      item: taken,
      reason: describeMove(current, taken),
      corridorLabel:
        role === 'wider' && crossed ? CORRIDOR_BY_ID.get(crossed)?.label ?? null : null,
      role,
      distance: 0,
    };
    const idx = picked.findIndex((b) => b.role === role);
    const out = [...picked];
    out[idx === -1 ? 1 : idx] = replacement;
    return out;
  }, [current, trail, focusIndex, dial, pool, byId, fbWeights, apiOffers]);

  const wildcard = useMemo(() => {
    if (!current) return null;
    // Exclude the scored offers too, so the wildcard is never a duplicate door.
    const exclude = new Set([...trail.slice(0, focusIndex + 1), ...branches.map((b) => b.item.id)]);
    return pickWildcard(pool, exclude, current.id);
  }, [current, trail, focusIndex, branches, pool]);

  // Named rather than indexed, so key bindings track the role on screen
  // instead of the order the engine happened to return them in.
  const deeper = branches.find((b) => b.role === 'deeper');
  const wider = branches.find((b) => b.role === 'wider');

  /*
   * How each card was arrived at, so feedback can say whether the *step* was
   * wrong rather than only the record. Not derivable after the fact: the roles
   * are assigned relative to the candidates a pick actually had, and those are
   * gone by the time you judge the result.
   */
  const [roleById, setRoleById] = useState<Record<string, 'deeper' | 'wider' | 'shuffle'>>({});

  const choose = useCallback(
    (item: Item, role?: 'deeper' | 'wider' | 'shuffle') => {
      setTrail((t) => [...t.slice(0, focusIndex + 1), item.id]);
      setFocusIndex((i) => i + 1);
      if (role) setRoleById((m) => ({ ...m, [item.id]: role }));
    },
    [focusIndex],
  );

  const back = useCallback(() => setFocusIndex((i) => Math.max(0, i - 1)), []);

  const castVerdict = useCallback(
    (verdict: Verdict) => {
      if (!current) return;
      recordVerdict({
        id: current.id,
        verdict,
        at: new Date().toISOString(),
        fromId: previous?.id,
        dial,
        role: roleById[current.id],
        title: current.title,
        artist: current.subtitle,
        fromTitle: previous?.title,
      });
      setFbVersion((v) => v + 1);
      setFlash(verdict);
      window.setTimeout(() => setFlash(null), 900);
    },
    [current, previous, dial, roleById],
  );
  const [flash, setFlash] = useState<Verdict | null>(null);

  const [showAbout, setShowAbout] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [rolling, setRolling] = useState(false);
  const rollShuffle = useCallback(() => {
    if (!wildcard) return;
    setRolling(true);
    // The card starts travelling immediately; the die tumbles alongside it, so
    // the animation never costs the user latency.
    choose(wildcard, 'shuffle');
    window.setTimeout(() => setRolling(false), ROLL_MS);
  }, [wildcard, choose]);

  const restart = useCallback(() => {
    const start = pickStart(pool, String(Date.now()));
    if (!start) return;
    setTrail([start.id]);
    setFocusIndex(0);
  }, [pool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'd' || e.key === 'D') {
        // Not while the search field has focus — 'd' is a letter there.
        if (!searchOpen) {
          e.preventDefault();
          setShowDebug((v) => !v);
        }
        return;
      }
      // While a panel is up it owns the arrow keys; the flow stands down.
      if (showAbout || searchOpen) return;
      // The dial is arrow-driven too; let it keep its own keys when focused.
      if ((e.target as HTMLElement | null)?.closest?.('.dial')) return;

      /*
       * Verdicts on the focused card. Worth a key each: the rest of the app is
       * navigable without the mouse, and a rating people have to reach for is
       * a rating that mostly does not get given.
       */
      if (current && (e.key === 'g' || e.key === 'm' || e.key === 'x')) {
        e.preventDefault();
        castVerdict(e.key === 'g' ? 'good' : e.key === 'm' ? 'meh' : 'bad');
        return;
      }

      // The keymap is the layout: shuffle sits above, the two offers to the
      // right, your last card to the left.
      if (e.key === 'ArrowUp' && wildcard) {
        e.preventDefault();
        rollShuffle();
      } else if (e.key === 'ArrowRight' && wider) {
        e.preventDefault();
        choose(wider.item, 'wider');
      } else if (e.key === 'ArrowDown' && deeper) {
        e.preventDefault();
        choose(deeper.item, 'deeper');
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deeper, wider, choose, wildcard, back, rollShuffle, showAbout, searchOpen]);

  const takenId = trail[focusIndex + 1];

  /*
   * One card per slot, keyed by album id.
   *
   * The key is doing the real work: when you pick an offer, that album's card
   * keeps its key, so React reuses the node and the browser glides it from the
   * offer rail into the centre rather than swapping one element for another.
   */
  const cards = useMemo<FlowCard[]>(() => {
    if (!current) return [];
    const out: FlowCard[] = [];

    // Only the immediately preceding card is shown, and it is the only way
    // back — one step at a time.
    if (previous) {
      out.push({
        key: previous.id,
        item: previous,
        slot: 'past',
        face: 'art',
        onClick: back,
        why: <>Back to {previous.title}</>,
      });
    }

    out.push({ key: current.id, item: current, slot: 'focus', face: 'art' });

    branches.forEach((b) => {
      out.push({
        key: b.item.id,
        item: b.item,
        // branches[0] is 'deeper', [1] is 'wider' — wider rides on top, so the
        // lineage you are already in sits closest to where you're heading.
        slot: b.role === 'wider' ? 'up' : 'down',
        face: 'art',
        badge: b.role,
        badgeKey: b.role === 'wider' ? '→' : '↓',
        taken: takenId === b.item.id,
        onClick: () => choose(b.item, b.role),
        why: (
          <>
            {b.reason}
            {b.corridorLabel && <em>into {b.corridorLabel}</em>}
          </>
        ),
      });
    });

    return out;
  }, [current, previous, branches, wildcard, takenId, choose, back]);

  if (!current) {
    // Always give this screen a way out — it is the one place the app can get
    // stuck, so it must never be a dead end.
    return (
      <div className="loading">
        <img className="loading__logo" src="./svg/logo-primary-reversed.svg" alt="album.guide" width={190} />
        <p className="tagline">
          A route through the albums you haven&rsquo;t <em>found</em> yet
        </p>
        <div style={{ fontSize: 12, opacity: 0.6 }}>
          {catalogSize.toLocaleString()} albums aboard ·{' '}
          {CATALOG_STATS.corridorsComplete.length} of 11 routes mapped
        </div>
        <button className="play" onClick={restart} disabled={!catalogSize}>
          {catalogSize ? 'Start driving' : 'Waiting for the crawler…'}
        </button>
      </div>
    );
  }

  return (
    <div className="stage" style={{ '--ambient': ambient } as CSSProperties}>
      <header className="bar">
        <div className="bar__left">
          <button
            className="brand"
            onClick={() => setShowAbout(true)}
            title="What this is, and how to drive it"
          >
            <img className="brand__mark" src="./svg/icon-lg-reversed.svg" alt="album.guide" width={64} height={64} />
            <span className="brand__word">
              <span>album</span>
              <span>.guide</span>
              <span className="brand__count">{pool.length.toLocaleString()} albums</span>
            </span>
          </button>
        </div>

        {wildcard && (
          <button
            className="shuffle"
            onClick={rollShuffle}
            title="Jump somewhere random — ignores every rule the engine follows"
          >
            <Die rolling={rolling} />
            <span className="shuffle__label">Shuffle</span>
          </button>
        )}

        <div className="bar__right">
          <DistanceDial value={dial} onChange={setDial} />
        </div>
      </header>

      <div className="flow">
        <Flow cards={cards} />



        <div className="plate">
          <div className="plate__text" key={current.id}>
            <h1 className="plate__title">
              <a href={current.infoUrl} target="_blank" rel="noreferrer" title="Look this record up on MusicBrainz">
                {current.title}
              </a>
            </h1>
            <p className="plate__sub">
              {current.subtitle}
              {current.yearStart ? ` · ${current.yearStart}` : ''}
            </p>
            <p className="plate__tags">
              {current.corridorIds
                .map((c) => CORRIDOR_BY_ID.get(c)?.label)
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div className="plays">
            <a className="play play--spotify" href={current.spotifyUrl} target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.5 17.3c-.22.36-.68.47-1.03.25-2.83-1.73-6.4-2.12-10.6-1.16a.75.75 0 1 1-.33-1.46c4.6-1.05 8.55-.6 11.72 1.34.35.22.46.68.24 1.03zm1.47-3.27a.94.94 0 0 1-1.29.31c-3.24-2-8.18-2.57-12.01-1.4a.94.94 0 1 1-.55-1.8c4.38-1.33 9.82-.69 13.54 1.6.44.27.58.85.31 1.29zm.13-3.4C15.22 8.33 8.9 8.12 5.18 9.25a1.12 1.12 0 1 1-.65-2.15c4.27-1.3 11.25-1.05 15.69 1.58a1.12 1.12 0 1 1-1.14 1.94z"/></svg>
              Spotify
            </a>
            <a className="play play--apple" href={current.appleMusicUrl} target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24"><path d="M23.99 6.12c0-.5-.05-1-.14-1.48a4.9 4.9 0 0 0-.66-1.72A4.6 4.6 0 0 0 20.9.73 6.2 6.2 0 0 0 19.4.15c-.5-.1-1-.13-1.5-.14H6.1c-.5.01-1 .05-1.49.14a5.9 5.9 0 0 0-1.5.58A4.6 4.6 0 0 0 .8 2.92a5.9 5.9 0 0 0-.66 1.72c-.1.49-.13.99-.14 1.48v11.76c.01.5.05 1 .14 1.48.13.6.34 1.18.66 1.72a4.6 4.6 0 0 0 2.31 2.19c.48.2.98.34 1.5.43.5.09 1 .12 1.49.13h11.8c.5-.01 1-.04 1.5-.13a5.9 5.9 0 0 0 1.5-.43 4.6 4.6 0 0 0 2.3-2.2c.32-.53.53-1.1.66-1.71.1-.49.14-.99.14-1.48V6.12zM17.3 5.6v9.53c0 .35-.02.7-.11 1.03-.18.68-.6 1.17-1.24 1.45-.35.16-.72.25-1.1.3-.72.09-1.35-.36-1.5-1.06a1.63 1.63 0 0 1 1.03-1.87c.4-.15.83-.2 1.24-.3.35-.1.53-.3.57-.66V8.02c0-.34-.15-.45-.47-.4l-6.2 1.25c-.3.07-.4.2-.4.51v8.03c0 .35-.03.7-.12 1.04-.18.67-.6 1.15-1.24 1.43-.35.16-.72.25-1.1.31-.72.1-1.35-.36-1.5-1.06a1.63 1.63 0 0 1 1.04-1.87c.4-.15.82-.2 1.23-.3.36-.1.54-.3.57-.66V6.75c0-.1 0-.2.03-.3.05-.25.23-.4.5-.45l.65-.14 7.5-1.5c.06-.02.13-.03.2-.03.28-.02.47.14.47.42v.85z"/></svg>
              Apple Music
            </a>
          </div>

          <Feedback
            item={current}
            from={previous}
            dial={dial}
            role={roleById[current.id]}
            onChange={noteFeedback}
            onCast={castVerdict}
            flash={flash}
          />
        </div>


        <ul className="keys">
          <li><kbd>↑</kbd> shuffle</li>
          <li><kbd>→</kbd> wider</li>
          <li><kbd>↓</kbd> deeper</li>
          <li><kbd>←</kbd> back</li>
          <li><kbd>/</kbd> search</li>
          <li><kbd>g</kbd>/<kbd>m</kbd>/<kbd>x</kbd> rate</li>
        </ul>
      </div>

      {showAbout && (
        <About onClose={() => setShowAbout(false)} onRestart={restart} />
      )}

      {showDebug && (
        <Debug
          current={current}
          branches={branches}
          wildcard={wildcard}
          trail={trail.map((id) => byId.get(id)).filter((x): x is Item => Boolean(x))}
          dial={dial}
          poolSize={pool.length}
          onClose={() => setShowDebug(false)}
          onFeedbackChange={noteFeedback}
        />
      )}

      <footer className="foot">
        <SearchBox
          pool={pool}
          onPick={choose}
          onIngest={addIngested}
          onOpenChange={setSearchOpen}
        />
      </footer>
    </div>
  );
}
