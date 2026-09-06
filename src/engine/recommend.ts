import { AXIS_SD, TAG_SETS, TAG_IDF, MEAN_IDF } from '../data/catalog';
import { CORRIDOR_BY_ID } from '../data/corridors';
import { AXES, AXIS_POLES, type Axis, type Item, type Vector } from '../data/schema';

/**
 * How much each axis counts toward "distance". Era is damped because a 30-year
 * gap between two otherwise identical records is a smaller leap than it looks
 * numerically; `abstract` is boosted because a jump in strangeness is the thing
 * a listener notices most.
 */
export const AXIS_WEIGHT: Record<Axis, number> = {
  era: 0.75,
  energy: 1.0,
  density: 1.0,
  brightness: 0.9,
  synthetic: 1.15,
  abstract: 1.2,
  voice: 0.95,
};

/*
 * ── Tuning ───────────────────────────────────────────────────────────────
 * Every knob the recommender has, in one place, because this is the part that
 * gets revisited. `npm run walk -- --dial N` prints the effect of any change
 * in a couple of seconds.
 */
/** Score multipliers derived from listener feedback; see engine/feedback.ts. */
export interface FeedbackWeights {
  byItem: ReadonlyMap<string, number>;
  byPair: ReadonlyMap<string, number>;
}

export const TUNING = {
  /** Target distance at dial 0 and dial 1. */
  radiusNear: 0.14,
  radiusFar: 0.60,
  /** Width of the distance band; wider at high dial, where precision is moot. */
  sigmaNear: 0.10,
  sigmaFar: 0.16,

  /**
   * Where on the fame scale the dial aims. Low dial wants records people know;
   * high dial wants the tail. This is what actually makes "Sidewalk" feel like
   * a sidewalk — proximity alone still served strangers.
   */
  /*
   * Aims high on purpose. At 8.4 the closest setting targeted the 84th
   * percentile — about 4,500 listeners — while the top of the catalog runs to
   * 77,000, so a household-name record was answered with mid-tier ones. Born
   * in the U.S.A. offered Tom Petty's Wildflowers and The Clash where a
   * listener reasonably expects Neil Young's Harvest, which is what it offers
   * now.
   *
   * This does not make the app canon-bound; it is what the near end is for.
   * The dial is the escape route, and its far end reaches the tail properly
   * now. A close step that lands on records nobody recognises isn't adventure,
   * it just reads as the engine not knowing the album.
   *
   * Agreement rises with it too — 57.0% to 61.0% — since co-listening
   * neighbours of famous records are themselves usually famous. Reach costs
   * 0.5 points, which is cheap for the difference in what the near end means.
   */
  popularityNear: 9.8,
  /*
   * Not lower. Aiming at 1.8 asked for records with 12-28 listeners, where the
   * quality signal is deliberately shrunk to the catalog prior because a
   * devotion ratio over that few people is noise. The far end was selecting on
   * nothing: median quality of its offers was 5.1 against a catalog median of
   * 5.0 — indistinguishable from picking at random, which is the opposite of
   * the point of a wide setting. It passed every assertion in the suite,
   * because the far end is built to disagree with co-listening and noise
   * disagrees beautifully.
   *
   * At 3.0 a record still has only ~28-58 listeners, so the setting stays
   * genuinely obscure, but there is enough evidence to tell a lost classic
   * from a demo: far-end quality rises to 6.6. Near-end agreement does not
   * move at all, since this steers only the wide end.
   *
   * Not higher either. 4.0 buys another 0.7 of quality and costs twice as much
   * reach (16.5% -> 15.2% of the catalog ever offered), and breadth is half
   * the point of the dial.
   */
  popularityFar: 3.0,
  popularitySigma: 3.5,

  /**
   * How hard quality is weighted, near and far.
   *
   * Deliberately *higher* far out. The long tail is mostly records almost
   * nobody kept listening to, so reaching for obscurity without leaning on
   * quality finds noise rather than discovery. Out there, devotion is the only
   * thing separating a lost classic from a nobody's demo.
   */
  /*
   * Softened from 0.40/0.85. At those values quality swung the score 5x
   * between a poor record and a great one, which made it behave as a filter
   * rather than a preference: across 400 walks the engine offered only 8.5%
   * of the catalog, every album surfacing about six times. That is the
   * repetition this app exists to avoid. Quality still leads — it just no
   * longer excludes the merely very good.
   */
  qualityWeightNear: 0.28,
  qualityWeightFar: 0.55,

  /**
   * How much shared idiom counts. A candidate with no tags in common with
   * where you are gets multiplied by (1 - idiomWeight); one that shares its
   * whole tag set keeps full score. This is what stops a texture match between
   * unrelated genres reading as a good recommendation.
   */
  idiomWeight: 0.65,

  /*
   * The least vocabulary a "wider" offer may share, relaxing as the dial opens.
   *
   * Measured, wider sat at ~0.05 overlap at every dial setting while deeper
   * fell from 0.49 to 0.16 — so the dial moved distance and never relatedness,
   * and the wide door was equally unrelated on the Sidewalk as in the
   * Bushwhack. That is how Radiohead came to offer Slayer one notch from home.
   *
   * The exact value matters less than it looks. Overlap is bimodal: a
   * candidate either shares nothing (0 to 0.07) or shares a good deal (0.40
   * up), because the evidence shrink pulls unshared pairs toward zero. Every
   * floor between 0.10 and 0.40 selects the same 2.9% of candidates, so this
   * is closer to a switch than a threshold — 0.15 sits in the middle of that
   * dead zone rather than on either edge of it.
   *
   * Zero at the far end on purpose. Bushwhack is where the engine is supposed
   * to hand over a record with nothing in common, and a floor there would
   * quietly delete the setting the whole app is built around.
   */
  widerFloorNear: 0.15,
  widerFloorFar: 0.0,
  /**
   * Idf mass at which a tag overlap is trusted outright — about three
   * averagely-informative tags. Lives here so the sweep can reach it; it was
   * picked on a 74-offer sample and is worth re-checking as the suite grows.
   */
  evidenceFull: 24,

  /**
   * Which signal leads.
   *
   * 'texture' targets a distance radius and lets idiom overlap re-rank what
   * lands there. 'idiom' inverts it: the dial targets a level of shared idiom
   * and texture distance becomes the tiebreak among records already in the
   * right musical world.
   *
   * 'idiom' is the more defensible ordering on the face of it — a listener asks
   * "something like this" before "something with these textures". Measured, it
   * barely matters: 17.6% near-end agreement against texture-first's 18.9%.
   *
   * What did matter, by a wide margin, was making the overlap measure itself
   * trustworthy — see idiomOverlap. Evidence-weighting it moved both modes from
   * ~11-13% to ~18%. The ordering of the two signals was the wrong thing to
   * argue about; the quality of one of them was the whole game.
   *
   * Kept switchable because it is now a measurement rather than an opinion:
   * `npm run eval` scores either in about a minute.
   */
  mode: 'texture' as 'texture' | 'idiom',

  /** Idiom overlap the dial aims at, near end to far end. */
  idiomNear: 0.85,
  idiomFar: 0.0,
  idiomSigma: 0.26,

  /** How much the secondary signal still counts, as an exponent on its band. */
  secondaryExp: 0.45,

  /** Two offers that lead to the same place are only one offer. */
  divergenceBonus: 1.6,

  /**
   * How many candidates each role considers, and how many pairs are weighed.
   * Wider pools are the other half of breadth: with a shortlist of 12 the same
   * few albums won every time, however the scores were weighted.
   */
  poolSize: 30,
  pairSearch: 12,

  /**
   * Deterministic tie-break spread. Stays keyed to (from, to) so revisiting a
   * card re-offers the same records — but +-25% instead of +-10% lets the
   * many near-equal candidates take turns rather than one always winning.
   */
  jitter: 0.6,
  /** Same artist twice running reads as a dead end, not a discovery. */
  sameArtistPenalty: 0.25,
} as const;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const WEIGHT_NORM = Math.sqrt(
  AXES.reduce((sum, a) => sum + AXIS_WEIGHT[a] * AXIS_WEIGHT[a], 0),
);

/**
 * Weighted euclidean distance, normalised to roughly 0..1.
 *
 * Each axis is divided by its own spread first. Without that, `synthetic`
 * (sd 0.275) and `voice` (sd 0.252) dominated: "distance" was largely a
 * measure of how electronic and how sung a record is, while `density`
 * (sd 0.092) barely registered.
 */
export function distance(a: Vector, b: Vector): number {
  let sum = 0;
  for (const axis of AXES) {
    const z = (a[axis] - b[axis]) / AXIS_SD[axis];
    const d = z * AXIS_WEIGHT[axis];
    sum += d * d;
  }
  // /3 keeps the result on roughly the old 0..1 scale now that the axes are
  // expressed in standard deviations, so the dial's radii still mean something.
  return Math.sqrt(sum) / (WEIGHT_NORM * 3);
}

/**
 * How much musical idiom two records share, 0..1, from their tags.
 *
 * The seven axes describe texture, not genre — so Born in the U.S.A. and
 * Ornette Coleman's In All Languages scored 0.41 apart, a textbook Ridgeline
 * step, despite sharing not one tag out of 21 and 2. Nothing in a texture
 * vector knows that one is heartland rock and the other free jazz. This does.
 */
export function idiomOverlap(a: Item, b: Item): number {
  const sa = TAG_SETS.get(a.id);
  const sb = TAG_SETS.get(b.id);
  if (!sa || !sb || !sa.size || !sb.size) return 0.5; // unknown, not disjoint
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];

  /*
   * Weighted by how much each tag actually says. A shared "rock" (idf 0.89,
   * held by a large share of the catalog) is close to no evidence; a shared
   * "grunge" (idf 4.90) is a great deal of it. Counting them alike is what let
   * Zebrahead — tagged only rock/alternative rock/punk/punk rock — beat
   * Soundgarden as a neighbour of Nevermind: all four of its tags were nearly
   * free, and dividing by the smaller set turned that thinness into a 0.91.
   *
   * Overlap coefficient rather than Jaccard still: a record with 21 tags and
   * one with 2 can be the same idiom, and Jaccard would punish that.
   */
  let sharedMass = 0;
  let smallMass = 0;
  for (const t of small) {
    const w = TAG_IDF.get(t) ?? MEAN_IDF;
    smallMass += w;
    if (large.has(t)) sharedMass += w;
  }
  if (smallMass <= 0) return NEUTRAL_OVERLAP;
  let totalMass = 0;
  for (const t of large) totalMass += TAG_IDF.get(t) ?? MEAN_IDF;
  totalMass += smallMass;

  const raw =
    OVERLAP_MODE === 'coefficient' ? sharedMass / smallMass
    : OVERLAP_MODE === 'dice' ? (2 * sharedMass) / totalMass
    : Math.min(1, sharedMass / SATURATION_MASS);

  /*
   * Shrunk by how much evidence there is for it.
   *
   * The coefficient divides by the smaller tag set, so an album tagged only
   * ["rock"] scores 1.0 against anything else tagged rock. That is absence of
   * evidence read as evidence, and it dominated: 57% of all pairs scoring 0.75+
   * involved a single-tag album, 83% one or two. Those thin records became
   * false neighbours of everything.
   *
   * Evidence is now measured in idf mass rather than tag count, for the same
   * reason the overlap is: four generic tags are less to go on than two
   * specific ones, and counting them gave the thin record the benefit twice.
   * evidenceFull is roughly the mass of three averagely-informative tags.
   */
  const evidence = Math.min(1, Math.sqrt(smallMass / TUNING.evidenceFull));
  return raw * evidence + NEUTRAL_OVERLAP * (1 - evidence);
}

/** Roughly the overlap of two unrelated albums; the prior thin pairs shrink to. */
/**
 * How shared tag mass becomes a 0..1 overlap.
 *
 * 'coefficient' divides by the smaller set, which rewards thinness: a record
 * whose few tags are a subset of yours scores 1.0 by construction, and no
 * amount of idf weighting can rescue a denominator that small.
 * 'dice' compares shared mass against both records' mass together.
 * 'saturating' asks only how much distinctive vocabulary is shared outright,
 * on the view that sharing "grunge, 90s, stoner rock" means the same thing
 * however much else either record is tagged with.
 */
const OVERLAP_MODE = 'coefficient' as 'coefficient' | 'dice' | 'saturating';
/** Shared idf mass treated as a complete match under 'saturating'. */
const SATURATION_MASS = 16;

const NEUTRAL_OVERLAP = 0.12;

/** Deterministic hash -> [0,1). Keeps branch offers stable across backtracking. */
function hash01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Score components, kept so debug mode can show why a pick won. */
export interface BranchDebug {
  score: number;
  band: number;
  fame: number;
  merit: number;
  idiom: number;
  sameArtist: number;
  /** Combined listener-feedback multiplier; 1 when nothing has been said. */
  voted: number;
  jitter: number;
  targetR: number;
  targetPop: number;
  qWeight: number;
}

export interface Branch {
  item: Item;
  /** Hover-revealed rationale, e.g. "sparser and stranger — 14 years later". */
  reason: string;
  /** Which lineage this hands you to, when it differs from where you are. */
  corridorLabel: string | null;
  role: 'deeper' | 'wider';
  distance: number;
  debug?: BranchDebug;
}

/**
 * Describe the move from one record to another in the terms a listener would
 * actually notice: name the one or two axes that shifted most, and treat a
 * large era gap as a fact worth stating outright rather than as "later".
 */
export function describeMove(from: Item, to: Item): string {
  /*
   * Ranked by how far each axis moved *relative to its own spread*, not in raw
   * units. Judged raw, `voice` and `synthetic` were named in 64% of all
   * rationales and `density` and `brightness` in 8% between them — not because
   * those records differed that way, but because those two axes are three times
   * wider than the rest, so they always won the comparison.
   */
  const deltas = AXES.filter((a) => a !== 'era')
    .map((axis) => ({
      axis,
      delta: to.vector[axis] - from.vector[axis],
      z: (to.vector[axis] - from.vector[axis]) / AXIS_SD[axis],
    }))
    .filter((d) => Math.abs(d.z) > 0.7)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 2);

  const phrases = deltas.map(({ axis, delta }) =>
    delta > 0 ? AXIS_POLES[axis].high : AXIS_POLES[axis].low,
  );

  const yearGap =
    from.yearStart && to.yearStart ? to.yearStart - from.yearStart : null;
  if (yearGap != null && Math.abs(yearGap) >= 8) {
    phrases.push(
      `${Math.abs(yearGap)} years ${yearGap > 0 ? 'later' : 'earlier'}`,
    );
  }

  if (phrases.length === 0) return 'a close neighbour';
  if (phrases.length === 1) return phrases[0];
  return `${phrases.slice(0, -1).join(', ')} — ${phrases[phrases.length - 1]}`;
}

interface Scored {
  item: Item;
  d: number;
  score: number;
  parts?: BranchDebug;
}

/**
 * Offer two records that are both plausible next steps but lead somewhere
 * genuinely different from each other.
 *
 * The dial sets a *target* distance rather than a maximum, so turning it up
 * moves the whole band outward instead of merely widening it — at low settings
 * both offers are variations on where you are, at high settings both are real
 * departures. Novelty rides along with it: reaching further should also mean
 * reaching past the canon, which is why there is no separate obscurity slider.
 *
 * The two roles are asymmetric by construction. `deeper` stays inside the
 * lineage you are already walking; `wider` hands you to a corridor that
 * borders it. Then the pair is chosen jointly to maximise the distance
 * *between the two offers*, because two equally good branches that lead to the
 * same place are only one branch.
 */
export function pickBranches(
  current: Item,
  pool: Item[],
  dial: number,
  excludeIds: ReadonlySet<string>,
  fb?: FeedbackWeights,
): Branch[] {
  const targetR = lerp(TUNING.radiusNear, TUNING.radiusFar, dial);
  const sigma = lerp(TUNING.sigmaNear, TUNING.sigmaFar, dial);
  const targetPop = lerp(TUNING.popularityNear, TUNING.popularityFar, dial);
  const qWeight = lerp(TUNING.qualityWeightNear, TUNING.qualityWeightFar, dial);
  const targetIdiom = lerp(TUNING.idiomNear, TUNING.idiomFar, dial);


  const scored: Scored[] = [];
  for (const item of pool) {
    if (item.id === current.id || excludeIds.has(item.id)) continue;

    const d = distance(current.vector, item.vector);
    // Gaussian around the target radius: being nearer than asked is just as
    // wrong as being further, otherwise every dial setting collapses to "close".
    const band = Math.exp(-((d - targetR) ** 2) / (2 * sigma * sigma));

    /*
     * Fame. The dial slides a *target* along the popularity scale rather than
     * applying a one-way bonus, so turning it down genuinely asks for records
     * people know instead of merely tolerating them.
     */
    const popGap = item.popularity - targetPop;
    const fame = Math.exp(
      -(popGap * popGap) / (2 * TUNING.popularitySigma * TUNING.popularitySigma),
    );

    /*
     * Quality, weighted harder the further out we reach — see TUNING. A record
     * at quality 10 is worth roughly (1 + qWeight) times one at quality 0.
     */
    const merit = 1 - qWeight + (item.quality / 10) * qWeight * 2;

    // Same artist twice in a row reads as a dead end, not a discovery.
    const sameArtist =
      item.artistId === current.artistId ? TUNING.sameArtistPenalty : 1;

    // Stable tie-break so revisiting a card re-offers the same two records.
    const jitter =
      1 - TUNING.jitter + 2 * TUNING.jitter * hash01(current.id + item.id);

    const overlap = idiomOverlap(current, item);

    /*
     * Which band leads depends on the mode. Either way both signals are
     * present — the difference is which one the dial aims with and which one
     * merely breaks ties.
     */
    let idiom: number;
    let combined: number;
    if (TUNING.mode === 'idiom') {
      const idiomBand = Math.exp(
        -((overlap - targetIdiom) ** 2) / (2 * TUNING.idiomSigma ** 2),
      );
      idiom = idiomBand;
      combined = idiomBand * Math.pow(band, TUNING.secondaryExp);
    } else {
      // Exactly as before the experiment, so the comparison is honest.
      idiom = 1 - TUNING.idiomWeight + TUNING.idiomWeight * overlap;
      combined = band * idiom;
    }

    /*
     * What the listener has told us. A judgement of this exact step outranks a
     * judgement of the record on its own: "not after this" is a narrower and
     * better-evidenced claim than "not ever", and collapsing the two would
     * throw away the more useful half of the signal.
     *
     * This multiplies rather than filters, so a thumbs-down suppresses a record
     * without banishing it. A single misclick should not permanently remove
     * something from a catalogue this large.
     */
    const voted =
      (fb?.byPair.get(`${current.id}>${item.id}`) ?? 1) *
      (fb?.byItem.get(item.id) ?? 1);

    const score = combined * fame * merit * sameArtist * jitter * voted;
    scored.push({
      item,
      d,
      score,
      parts: {
        score, band, fame, merit, idiom, sameArtist, jitter, voted,
        targetR, targetPop, qWeight,
      },
    });
  }

  if (scored.length < 2) return [];

  /*
   * Roles are split on idiom overlap, measured against the candidates this
   * pick actually has — not on precomputed corridor membership.
   *
   * Corridors did this job before, and did it badly: assignments came from the
   * tag the crawler searched rather than the tags an album carries, so Born in
   * the U.S.A. sat in folk-ambient (a lineage running to drone), folk-ambient
   * borders minimalism, and Ornette Coleman became a *legal* "wider" crossing.
   * 17% of assignments had no exact tag support, and 23% of shipped albums —
   * disproportionately mainstream hip-hop and pop — had no corridor at all and
   * so could never be a crossing.
   *
   * The threshold has to be relative. Among candidates that clear the distance
   * band, 34% share half their tags at Sidewalk but only 3% do at Bushwhack,
   * where 87% share none. Any fixed cutoff leaves one role starved at one end
   * of the dial. Splitting at the median of the candidates in hand adapts by
   * construction: "deeper" is always the more idiomatically related half of
   * what is genuinely nearby, "wider" the less related half.
   */
  /*
   * Both doors are drawn from the records that share some vocabulary, and how
   * much "some" means relaxes as the dial opens.
   *
   * Splitting the whole candidate set at its median overlap does not work,
   * which is only obvious once measured: most of the catalog shares nothing
   * with any given record, so the median sits near zero, everything with any
   * overlap lands in "deeper", and "wider" is drawn entirely from records with
   * no relation at all. Measured, wider sat at ~0.05 overlap at every dial
   * setting while deeper fell from 0.49 to 0.16 — the dial moved distance and
   * never relatedness, which is how Radiohead came to offer Slayer one step
   * from home.
   *
   * So the floor selects who is eligible at all, and the split happens inside
   * that group: deeper is its more related half, wider its less related half.
   * At the far end the floor is zero, the group is everything, and this is
   * exactly the old behaviour.
   */
  const widerFloor = lerp(TUNING.widerFloorNear, TUNING.widerFloorFar, dial);
  const overlaps = scored.map((s) => idiomOverlap(current, s.item));

  let eligible = scored.filter((_, i) => overlaps[i] >= widerFloor);
  let eligibleOv = overlaps.filter((o) => o >= widerFloor);
  if (eligible.length < 4) {
    // Some records share their vocabulary with almost nothing. Two unrelated
    // offers beat no offers.
    eligible = scored;
    eligibleOv = overlaps;
  }

  const sortedOv = [...eligibleOv].sort((x, y) => x - y);
  const medianOv = sortedOv[Math.floor(sortedOv.length / 2)] ?? 0;

  const byScore = (a: Scored, b: Scored) => b.score - a.score;
  const closer: Scored[] = [];
  const further: Scored[] = [];
  eligible.forEach((s, i) => {
    (eligibleOv[i] > medianOv ? closer : further).push(s);
  });

  const deeperPool = closer.sort(byScore).slice(0, TUNING.poolSize);
  const widerPool = further.sort(byScore).slice(0, TUNING.poolSize);

  const a = deeperPool.length ? deeperPool : scored.sort(byScore).slice(0, TUNING.poolSize);
  const b = widerPool.length ? widerPool : scored.sort(byScore).slice(0, TUNING.poolSize);

  let best: { a: Scored; b: Scored; total: number } | null = null;
  for (const ca of a.slice(0, TUNING.pairSearch)) {
    for (const cb of b.slice(0, TUNING.pairSearch)) {
      if (ca.item.id === cb.item.id) continue;
      const divergence = distance(ca.item.vector, cb.item.vector);
      const total = ca.score + cb.score + divergence * TUNING.divergenceBonus;
      if (!best || total > best.total) best = { a: ca, b: cb, total };
    }
  }
  if (!best) return [];

  const toBranch = (s: Scored, role: Branch['role']): Branch => {
    // Corridors are no longer part of the decision, but where both records
    // have one and they differ, naming it is still the clearest way to say
    // where you are being handed off to.
    const crossed = s.item.corridorIds.find((c) => !current.corridorIds.includes(c));
    return {
      item: s.item,
      reason: describeMove(current, s.item),
      corridorLabel:
        role === 'wider' && crossed
          ? (CORRIDOR_BY_ID.get(crossed)?.label ?? null)
          : null,
      role,
      distance: s.d,
      debug: s.parts,
    };
  };

  return [toBranch(best.a, 'deeper'), toBranch(best.b, 'wider')];
}

/**
 * The escape hatch: a uniformly random record, ignoring distance, corridors
 * and the scorer entirely.
 *
 * Both scored branches are arguments the engine is making about where you
 * should go next. However well tuned it is, a listener who only ever picks
 * from its two suggestions is still walking inside its model of music. The
 * wildcard is the move the engine cannot recommend — which is exactly why it
 * belongs on the same screen.
 *
 * Deterministic per album, like the branches, so stepping back and forward
 * returns the same three doors.
 */
export function pickWildcard(
  pool: Item[],
  excludeIds: ReadonlySet<string>,
  seed: string,
): Item | null {
  const eligible = pool.filter((i) => !excludeIds.has(i.id));
  if (!eligible.length) return null;
  return eligible[Math.floor(hash01(`wild:${seed}`) * eligible.length)];
}

/**
 * Opening card. Picks from the middle of the obscurity range — starting on
 * something canonical makes the first branches feel obvious, starting on
 * something unplaceable gives you nothing to steer away from.
 */
export function pickStart(pool: Item[], seed: string): Item | null {
  /*
   * Open on something recognisable and well-liked.
   *
   * The first card is the only one a visitor judges with no context, so it has
   * to be a record they might plausibly know — opening on an obscure one makes
   * the app look random before it has made a single recommendation. Not the
   * very top of the charts either: those make the first branches feel obvious.
   */
  const eligible = pool.filter(
    (i) => i.popularity >= 5.5 && i.popularity <= 9.2 && i.quality >= 6.5,
  );
  const from = eligible.length ? eligible : pool;
  if (!from.length) return null;
  return from[Math.floor(hash01(seed) * from.length)];
}
