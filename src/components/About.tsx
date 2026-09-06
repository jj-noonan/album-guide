import { useEffect } from 'react';
import { STOPS } from './DistanceDial';
import './About.css';

/** What this thing is and how to travel it. */
interface Props {
  onClose: () => void;
  /** Reachable from here now that the header carries no reset button. */
  onRestart: () => void;
}

export function About({ onClose, onRestart }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // The flow's arrow keys must not fire behind the panel.
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="about" role="dialog" aria-modal="true" aria-label="About album.guide">
      <div className="about__scrim" onClick={onClose} />
      <div className="about__panel">
        <button className="about__close" onClick={onClose} aria-label="Close">×</button>

        <header className="about__head">
          <img src="./svg/logo-primary-reversed.svg" alt="album.guide" width={116} />
          <p className="tagline">A route through the albums you haven&rsquo;t <em>found</em> yet</p>
        </header>

        <p className="about__lede">
          Streaming recommendations circle the densest corner of your taste and
          hand back the same well-known neighbours. This goes somewhere instead.
        </p>

        <section>
          <h3>The three roads</h3>
          <dl>
            <dt><kbd>→</kbd> Wider</dt>
            <dd>Crosses into a bordering lineage. Still defensible, but it hands you off somewhere you weren't.</dd>
            <dt><kbd>↓</kbd> Deeper</dt>
            <dd>Stays inside the lineage you're already walking.</dd>
            <dt><kbd>↑</kbd> Shuffle</dt>
            <dd>A record chosen at random from the whole catalog, ignoring every rule. The move the engine can't recommend.</dd>
            <dt><kbd>←</kbd> Back</dt>
            <dd>One step, to take the road you skipped.</dd>
          </dl>
          <p className="about__note">
            The two offers are never picked independently — the pair is chosen to
            maximise the distance <em>between</em> them, because two good roads
            leading to the same place are only one road.
          </p>
        </section>

        <section>
          <h3>The terrain dial</h3>
          <p>
            How far each step travels. It sets a <em>target</em> distance, not a
            maximum, so turning it up moves both offers outward rather than just
            spreading them. Novelty rides along with it: reaching further also
            means reaching past the canon.
          </p>
          <ol className="about__stops">
            {STOPS.map((s, i) => (
              <li key={s.name}><b>{i + 1} · {s.name}</b> — {s.blurb}</li>
            ))}
          </ol>
        </section>

        <section>
          <h3>Where the records come from</h3>
          <p>
            Crawled from <a href="https://musicbrainz.org" target="_blank" rel="noreferrer">MusicBrainz</a> and
            the <a href="https://coverartarchive.org" target="_blank" rel="noreferrer">Cover Art Archive</a>,
            starting from eleven lineages — krautrock through post-punk to early
            techno, spiritual jazz through sampling-era hip-hop, and so on — each
            sampled across popularity <em>and</em> decade so the canon and the
            deep cuts both show up and no era swamps the rest.
          </p>
          <p>
            Crawling by tag has a blind spot: it finds artists that tags describe
            well, and a lot of very famous pop is tagged thinly or not at all.
            Whole swathes of it were simply missing. So the catalog is topped up
            in the opposite direction — by asking what listeners actually play
            alongside what's already here, and fetching whatever isn't.
          </p>
          <p>
            Every album is placed on seven axes — era, energy, density, brightness,
            organic↔electronic, conventional↔experimental, instrumental↔vocal —
            mapped by hand from its tags. Hover any cover to see which of those
            moved, and why it's being offered.
          </p>
        </section>

        <section>
          <h3>Deeper and wider</h3>
          <p>
            The two offers differ in <em>vocabulary</em>, not just distance.
            Among the records at the right remove, the one sharing more of this
            album's tags becomes the deeper step and the one sharing less
            becomes the wider — measured against the candidates each pick
            actually has, so both doors stay meaningful at every dial setting.
          </p>
          <p>
            Not every tag counts alike. A shared <em>rock</em> is worth little
            when a large share of the catalog carries it; a shared{' '}
            <em>grunge</em> says a great deal. Weighing them equally made thinly
            tagged records look like neighbours of everything, which is a good
            way to be handed a record that has nothing to do with the one you
            are listening to.
          </p>
        </section>

        <section>
          <h3>Two scores behind every choice</h3>
          <p>
            <b>Popularity</b> is how many separate people reached for a record,
            not how many plays it has — raw plays are dominated by whoever put
            something on two hundred times.
          </p>
          <p>
            <b>Quality</b> is devotion: listens per listener, boosted by the
            MusicBrainz community rating where one exists. It separates records
            people return to from records people tried once — Burial's
            <em> Untrue</em> draws 48 plays per listener where a chart hit with
            more total plays draws 10.
          </p>
          <p>
            The dial moves both. Turned down it aims at records people know;
            turned up it aims at the tail — and leans <em>harder</em> on quality
            as it goes, because out there devotion is the only thing separating
            a lost classic from a nobody's demo.
          </p>
        </section>

        <section>
          <h3>Search</h3>
          <p>
            Searching something the catalog lacks isn't a dead end: it's looked up
            live in MusicBrainz, and if it exists it's fetched and added on the
            spot. Press <kbd>/</kbd> from anywhere, and <kbd>tab</kbd> to accept
            the completion.
          </p>
        </section>

        <section>
          <h3>Telling it when it's wrong</h3>
          <p>
            The three marks under the case rate what you're looking at:{' '}
            <kbd>g</kbd> good call, <kbd>m</kbd> fine but not for you,{' '}
            <kbd>x</kbd> wrong turn. They take effect immediately — a rejected
            record is pushed down the next time it comes up, and hardest of all
            in the same position it was wrong in, since a record can be right
            after one thing and wrong after another.
          </p>
          <p>
            Verdicts stay in this browser. Nothing is uploaded, so they shape
            your own paths and nobody else's.
          </p>
        </section>

        <button
          className="about__restart"
          onClick={() => { onRestart(); onClose(); }}
        >
          Start a fresh path
        </button>

        <footer className="about__foot">
          Titles link to MusicBrainz. Play buttons open a search in Spotify or
          Apple Music — no account or login involved.
        </footer>
      </div>
    </div>
  );
}
