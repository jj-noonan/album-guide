import { AXES, type Axis, type ItemTag, type Vector } from './schema';

/**
 * Tag -> position in attribute space.
 *
 * This is the recommendation signal, and the one part of the pipeline that is
 * deliberately hand-authored: MusicBrainz's community tags tell us *what* a
 * record is filed under, not what it sounds like. Mapping those tags onto the
 * axes by hand is what lets the engine say "sparser and stranger" instead of
 * "also tagged post-punk".
 *
 * It lives in TS rather than in the crawler on purpose — tuning it is a
 * hot-reload away instead of a re-crawl away.
 *
 * Every value is 0..1 on that axis. Omitted axes contribute nothing (so a tag
 * only asserts what it actually implies). `era` is never set here; it comes
 * from the release year.
 */
type TagProfile = Partial<Record<Exclude<Axis, 'era'>, number>>;

export const TAG_LEXICON: Record<string, TagProfile> = {
  // --- kraut-techno -------------------------------------------------------
  'krautrock':          { energy: .62, density: .50, brightness: .45, synthetic: .55, abstract: .72, voice: .28 },
  'kosmische musik':    { energy: .30, density: .38, brightness: .60, synthetic: .72, abstract: .78, voice: .12 },
  'post-punk':          { energy: .66, density: .48, brightness: .32, synthetic: .38, abstract: .58, voice: .72 },
  'coldwave':           { energy: .48, density: .40, brightness: .22, synthetic: .62, abstract: .55, voice: .65 },
  'minimal wave':       { energy: .52, density: .30, brightness: .25, synthetic: .82, abstract: .60, voice: .58 },
  'industrial':         { energy: .74, density: .72, brightness: .15, synthetic: .78, abstract: .74, voice: .48 },
  'ebm':                { energy: .82, density: .62, brightness: .25, synthetic: .88, abstract: .48, voice: .55 },
  'electro':            { energy: .72, density: .48, brightness: .55, synthetic: .92, abstract: .45, voice: .35 },
  'detroit techno':     { energy: .76, density: .45, brightness: .48, synthetic: .95, abstract: .55, voice: .12 },
  'acid house':         { energy: .80, density: .48, brightness: .52, synthetic: .95, abstract: .52, voice: .18 },

  // --- jazz-beats ---------------------------------------------------------
  'modal jazz':         { energy: .42, density: .48, brightness: .52, synthetic: .05, abstract: .52, voice: .10 },
  'spiritual jazz':     { energy: .55, density: .62, brightness: .62, synthetic: .08, abstract: .68, voice: .25 },
  'free jazz':          { energy: .78, density: .82, brightness: .40, synthetic: .05, abstract: .95, voice: .12 },
  'jazz fusion':        { energy: .68, density: .72, brightness: .58, synthetic: .45, abstract: .62, voice: .18 },
  'jazz-funk':          { energy: .70, density: .68, brightness: .65, synthetic: .32, abstract: .40, voice: .30 },
  'jazz rap':           { energy: .55, density: .58, brightness: .58, synthetic: .48, abstract: .40, voice: .82 },
  'boom bap':           { energy: .60, density: .55, brightness: .42, synthetic: .55, abstract: .32, voice: .88 },
  'instrumental hip hop':{ energy: .48, density: .52, brightness: .45, synthetic: .68, abstract: .48, voice: .10 },
  'trip hop':           { energy: .38, density: .55, brightness: .28, synthetic: .68, abstract: .50, voice: .58 },
  'wonky':              { energy: .52, density: .60, brightness: .48, synthetic: .82, abstract: .70, voice: .22 },

  // --- folk-ambient -------------------------------------------------------
  'folk':               { energy: .32, density: .25, brightness: .58, synthetic: .02, abstract: .18, voice: .85 },
  'british folk rock':  { energy: .45, density: .42, brightness: .48, synthetic: .08, abstract: .30, voice: .82 },
  'psychedelic folk':   { energy: .35, density: .38, brightness: .50, synthetic: .15, abstract: .60, voice: .72 },
  'freak folk':         { energy: .38, density: .40, brightness: .52, synthetic: .12, abstract: .68, voice: .78 },
  'american primitivism':{ energy: .30, density: .20, brightness: .48, synthetic: .00, abstract: .45, voice: .05 },
  'drone':              { energy: .18, density: .35, brightness: .30, synthetic: .55, abstract: .88, voice: .05 },
  'ambient':            { energy: .12, density: .28, brightness: .55, synthetic: .70, abstract: .68, voice: .08 },
  'new age':            { energy: .15, density: .30, brightness: .78, synthetic: .62, abstract: .40, voice: .12 },
  'fourth world':       { energy: .28, density: .42, brightness: .58, synthetic: .55, abstract: .78, voice: .15 },

  // --- dub-bass -----------------------------------------------------------
  'roots reggae':       { energy: .48, density: .48, brightness: .58, synthetic: .12, abstract: .22, voice: .82 },
  'dub':                { energy: .42, density: .40, brightness: .42, synthetic: .48, abstract: .68, voice: .30 },
  'dancehall':          { energy: .72, density: .50, brightness: .62, synthetic: .68, abstract: .28, voice: .85 },
  'jungle':             { energy: .92, density: .78, brightness: .42, synthetic: .82, abstract: .62, voice: .28 },
  'drum and bass':      { energy: .88, density: .70, brightness: .45, synthetic: .88, abstract: .48, voice: .22 },
  'uk garage':          { energy: .74, density: .52, brightness: .58, synthetic: .82, abstract: .38, voice: .55 },
  '2-step':             { energy: .70, density: .48, brightness: .58, synthetic: .82, abstract: .45, voice: .52 },
  'dubstep':            { energy: .68, density: .55, brightness: .22, synthetic: .88, abstract: .58, voice: .20 },
  'grime':              { energy: .85, density: .58, brightness: .35, synthetic: .85, abstract: .48, voice: .90 },
  'sound system':       { energy: .55, density: .48, brightness: .45, synthetic: .40, abstract: .50, voice: .50 },

  // --- punk-noise ---------------------------------------------------------
  'punk rock':          { energy: .88, density: .58, brightness: .48, synthetic: .05, abstract: .22, voice: .82 },
  'proto-punk':         { energy: .78, density: .52, brightness: .45, synthetic: .05, abstract: .42, voice: .80 },
  'hardcore punk':      { energy: .96, density: .68, brightness: .35, synthetic: .02, abstract: .25, voice: .82 },
  'post-hardcore':      { energy: .78, density: .62, brightness: .38, synthetic: .12, abstract: .58, voice: .78 },
  'noise rock':         { energy: .82, density: .78, brightness: .25, synthetic: .18, abstract: .78, voice: .62 },
  'math rock':          { energy: .70, density: .68, brightness: .48, synthetic: .12, abstract: .80, voice: .42 },
  'slowcore':           { energy: .12, density: .22, brightness: .28, synthetic: .08, abstract: .42, voice: .78 },
  'no wave':            { energy: .80, density: .70, brightness: .20, synthetic: .25, abstract: .95, voice: .58 },

  // --- soul-house ---------------------------------------------------------
  'soul':               { energy: .55, density: .55, brightness: .68, synthetic: .05, abstract: .15, voice: .95 },
  'southern soul':      { energy: .58, density: .58, brightness: .62, synthetic: .02, abstract: .12, voice: .95 },
  'funk':               { energy: .78, density: .68, brightness: .68, synthetic: .18, abstract: .25, voice: .72 },
  'p-funk':             { energy: .80, density: .78, brightness: .70, synthetic: .38, abstract: .55, voice: .78 },
  'disco':              { energy: .80, density: .70, brightness: .82, synthetic: .35, abstract: .18, voice: .78 },
  'boogie':             { energy: .72, density: .58, brightness: .78, synthetic: .58, abstract: .22, voice: .72 },
  'house':              { energy: .78, density: .52, brightness: .68, synthetic: .88, abstract: .32, voice: .42 },
  'deep house':         { energy: .62, density: .45, brightness: .58, synthetic: .85, abstract: .38, voice: .35 },
  'garage house':       { energy: .75, density: .55, brightness: .72, synthetic: .82, abstract: .28, voice: .62 },
  'gospel':             { energy: .60, density: .62, brightness: .82, synthetic: .02, abstract: .12, voice: .98 },

  // --- minimalism ---------------------------------------------------------
  'minimalism':         { energy: .35, density: .40, brightness: .58, synthetic: .35, abstract: .78, voice: .15 },
  'modern classical':   { energy: .30, density: .45, brightness: .48, synthetic: .18, abstract: .70, voice: .18 },
  'contemporary classical':{ energy: .32, density: .48, brightness: .45, synthetic: .25, abstract: .78, voice: .20 },
  'avant-garde':        { energy: .45, density: .55, brightness: .35, synthetic: .45, abstract: .95, voice: .25 },
  'musique concrète':   { energy: .38, density: .58, brightness: .28, synthetic: .72, abstract: .98, voice: .12 },
  'electroacoustic':    { energy: .35, density: .52, brightness: .40, synthetic: .75, abstract: .90, voice: .10 },
  'tape music':         { energy: .30, density: .50, brightness: .35, synthetic: .78, abstract: .92, voice: .10 },
  'serialism':          { energy: .40, density: .62, brightness: .32, synthetic: .15, abstract: .95, voice: .15 },
  'post-minimalism':    { energy: .38, density: .48, brightness: .55, synthetic: .38, abstract: .68, voice: .22 },

  // --- shoegaze -----------------------------------------------------------
  'shoegaze':           { energy: .55, density: .82, brightness: .48, synthetic: .32, abstract: .58, voice: .48 },
  'dream pop':          { energy: .38, density: .62, brightness: .62, synthetic: .42, abstract: .45, voice: .72 },
  'ethereal wave':      { energy: .30, density: .58, brightness: .55, synthetic: .48, abstract: .62, voice: .68 },
  'noise pop':          { energy: .68, density: .75, brightness: .55, synthetic: .22, abstract: .52, voice: .70 },
  'sadcore':            { energy: .15, density: .28, brightness: .22, synthetic: .12, abstract: .40, voice: .82 },
  'jangle pop':         { energy: .58, density: .45, brightness: .75, synthetic: .08, abstract: .20, voice: .85 },
  'twee pop':           { energy: .52, density: .38, brightness: .80, synthetic: .10, abstract: .18, voice: .88 },
  'indie pop':          { energy: .55, density: .48, brightness: .68, synthetic: .25, abstract: .28, voice: .85 },

  // --- country-americana --------------------------------------------------
  'country':            { energy: .45, density: .42, brightness: .58, synthetic: .02, abstract: .10, voice: .92 },
  'bluegrass':          { energy: .62, density: .52, brightness: .68, synthetic: .00, abstract: .12, voice: .82 },
  'honky tonk':         { energy: .55, density: .45, brightness: .58, synthetic: .00, abstract: .08, voice: .92 },
  'outlaw country':     { energy: .52, density: .45, brightness: .48, synthetic: .02, abstract: .20, voice: .92 },
  'country rock':       { energy: .58, density: .52, brightness: .58, synthetic: .05, abstract: .20, voice: .85 },
  'alt-country':        { energy: .45, density: .45, brightness: .42, synthetic: .08, abstract: .35, voice: .88 },
  'americana':          { energy: .42, density: .45, brightness: .52, synthetic: .05, abstract: .25, voice: .88 },
  'singer-songwriter':  { energy: .30, density: .28, brightness: .52, synthetic: .05, abstract: .22, voice: .95 },
  'gothic country':     { energy: .38, density: .40, brightness: .18, synthetic: .10, abstract: .48, voice: .88 },

  // --- global-psych -------------------------------------------------------
  'tropicalia':         { energy: .58, density: .62, brightness: .72, synthetic: .18, abstract: .62, voice: .85 },
  'mpb':                { energy: .45, density: .50, brightness: .72, synthetic: .10, abstract: .32, voice: .90 },
  'afrobeat':           { energy: .78, density: .78, brightness: .68, synthetic: .08, abstract: .35, voice: .62 },
  'highlife':           { energy: .65, density: .58, brightness: .78, synthetic: .05, abstract: .18, voice: .78 },
  'ethio-jazz':         { energy: .48, density: .52, brightness: .45, synthetic: .05, abstract: .55, voice: .38 },
  'cumbia':             { energy: .68, density: .55, brightness: .72, synthetic: .22, abstract: .25, voice: .72 },
  'desert blues':       { energy: .50, density: .45, brightness: .48, synthetic: .05, abstract: .35, voice: .75 },
  'raï':                { energy: .62, density: .55, brightness: .62, synthetic: .35, abstract: .28, voice: .88 },
  'psychedelic rock':   { energy: .62, density: .62, brightness: .52, synthetic: .25, abstract: .68, voice: .68 },
  'anatolian rock':     { energy: .62, density: .58, brightness: .52, synthetic: .18, abstract: .58, voice: .78 },

  // --- metal-doom ---------------------------------------------------------
  'heavy metal':        { energy: .82, density: .72, brightness: .38, synthetic: .05, abstract: .25, voice: .78 },
  'doom metal':         { energy: .48, density: .78, brightness: .15, synthetic: .05, abstract: .45, voice: .62 },
  'stoner rock':        { energy: .68, density: .72, brightness: .42, synthetic: .05, abstract: .35, voice: .68 },
  'sludge metal':       { energy: .72, density: .85, brightness: .15, synthetic: .05, abstract: .52, voice: .62 },
  'black metal':        { energy: .88, density: .88, brightness: .10, synthetic: .12, abstract: .62, voice: .58 },
  'atmospheric black metal':{ energy: .70, density: .88, brightness: .18, synthetic: .22, abstract: .72, voice: .40 },
  'post-metal':         { energy: .62, density: .82, brightness: .25, synthetic: .18, abstract: .68, voice: .35 },
  'drone metal':        { energy: .30, density: .82, brightness: .08, synthetic: .25, abstract: .92, voice: .10 },

  // --- common cross-cutting tags -----------------------------------------
  'rock':               { energy: .65, density: .55, brightness: .52, synthetic: .12, abstract: .25, voice: .80 },
  'pop':                { energy: .58, density: .52, brightness: .75, synthetic: .45, abstract: .12, voice: .92 },
  'electronic':         { energy: .55, density: .50, brightness: .50, synthetic: .90, abstract: .50, voice: .30 },
  'experimental':       { energy: .45, density: .58, brightness: .35, synthetic: .55, abstract: .95, voice: .30 },
  /*
   * Hip hop and R&B, which the lexicon barely spoke.
   *
   * It knew "hip hop" and not "hip-hop", and neither "rap" nor "r&b" at all —
   * so records tagged the way people actually tag them fell below the coverage
   * floor and left the engine entirely. Dr. Dre's 2001, three Kanye albums and
   * most of Kendrick's catalogue were unreachable, which is a genre-shaped
   * hole rather than a handful of misses.
   */
  'hip-hop': { energy: 0.62, density: 0.66, brightness: 0.45, synthetic: 0.62, abstract: 0.35, voice: 0.88 },
  'rap': { energy: 0.66, density: 0.64, brightness: 0.45, synthetic: 0.6, abstract: 0.3, voice: 0.92 },
  'hip hop rap': { energy: 0.64, density: 0.65, brightness: 0.45, synthetic: 0.61, abstract: 0.32, voice: 0.9 },
  'pop rap': { energy: 0.66, density: 0.6, brightness: 0.62, synthetic: 0.7, abstract: 0.2, voice: 0.9 },
  'gangsta rap': { energy: 0.7, density: 0.66, brightness: 0.32, synthetic: 0.58, abstract: 0.25, voice: 0.92 },
  'hardcore hip hop': { energy: 0.8, density: 0.72, brightness: 0.3, synthetic: 0.55, abstract: 0.35, voice: 0.9 },
  'hardcore rap': { energy: 0.8, density: 0.72, brightness: 0.3, synthetic: 0.55, abstract: 0.34, voice: 0.9 },
  'conscious hip hop': { energy: 0.55, density: 0.62, brightness: 0.45, synthetic: 0.5, abstract: 0.45, voice: 0.9 },
  'east coast hip hop': { energy: 0.65, density: 0.7, brightness: 0.38, synthetic: 0.5, abstract: 0.38, voice: 0.9 },
  'east coast rap': { energy: 0.65, density: 0.7, brightness: 0.38, synthetic: 0.5, abstract: 0.38, voice: 0.9 },
  'west coast hip hop': { energy: 0.62, density: 0.6, brightness: 0.5, synthetic: 0.6, abstract: 0.28, voice: 0.9 },
  'west coast rap': { energy: 0.62, density: 0.6, brightness: 0.5, synthetic: 0.6, abstract: 0.28, voice: 0.9 },
  'southern hip hop': { energy: 0.7, density: 0.62, brightness: 0.48, synthetic: 0.68, abstract: 0.25, voice: 0.9 },
  'abstract hip hop': { energy: 0.48, density: 0.6, brightness: 0.42, synthetic: 0.62, abstract: 0.72, voice: 0.78 },
  'r&b': { energy: 0.45, density: 0.52, brightness: 0.6, synthetic: 0.5, abstract: 0.22, voice: 0.92 },
  'contemporary r&b': { energy: 0.45, density: 0.54, brightness: 0.62, synthetic: 0.68, abstract: 0.2, voice: 0.92 },
  'rhythm and blues': { energy: 0.5, density: 0.5, brightness: 0.58, synthetic: 0.25, abstract: 0.2, voice: 0.9 },
  'neo soul': { energy: 0.4, density: 0.55, brightness: 0.55, synthetic: 0.42, abstract: 0.35, voice: 0.9 },
  'alternative r&b': { energy: 0.4, density: 0.55, brightness: 0.48, synthetic: 0.66, abstract: 0.45, voice: 0.88 },
  'vocal jazz': { energy: 0.32, density: 0.42, brightness: 0.6, synthetic: 0.12, abstract: 0.3, voice: 0.95 },
  'hip hop':            { energy: .62, density: .55, brightness: .48, synthetic: .60, abstract: .30, voice: .90 },
  'jazz':               { energy: .48, density: .55, brightness: .55, synthetic: .05, abstract: .50, voice: .25 },
  'blues':              { energy: .48, density: .42, brightness: .42, synthetic: .02, abstract: .15, voice: .88 },
  'soundtrack':         { energy: .35, density: .52, brightness: .45, synthetic: .40, abstract: .48, voice: .20 },
  'lo-fi':              { energy: .40, density: .38, brightness: .38, synthetic: .35, abstract: .52, voice: .70 },
  'psychedelic':        { energy: .55, density: .62, brightness: .52, synthetic: .30, abstract: .70, voice: .60 },

  // --- rock, as most of the world actually tags it ----------------------
  // The lexicon was written for eleven underground corridors and knew
  // 'punk rock' but not 'punk', 'heavy metal' but not 'metal'. Once the
  // catalog broadened these became its most-weighted blind spots.
  'alternative rock':   { energy: .62, density: .55, brightness: .48, synthetic: .18, abstract: .35, voice: .82 },
  'indie rock':         { energy: .58, density: .50, brightness: .52, synthetic: .18, abstract: .38, voice: .82 },
  'alternative/indie rock': { energy: .58, density: .50, brightness: .52, synthetic: .20, abstract: .38, voice: .82 },
  'alternative':        { energy: .58, density: .52, brightness: .50, synthetic: .25, abstract: .40, voice: .78 },
  'alternative and punk': { energy: .72, density: .58, brightness: .45, synthetic: .12, abstract: .35, voice: .82 },
  'indie':              { energy: .52, density: .45, brightness: .55, synthetic: .25, abstract: .40, voice: .80 },
  'pop rock':           { energy: .60, density: .52, brightness: .68, synthetic: .22, abstract: .18, voice: .88 },
  'pop/rock':           { energy: .60, density: .52, brightness: .68, synthetic: .22, abstract: .18, voice: .88 },
  'alternative pop/rock': { energy: .55, density: .50, brightness: .60, synthetic: .28, abstract: .28, voice: .85 },
  'alternative pop':    { energy: .52, density: .50, brightness: .62, synthetic: .38, abstract: .30, voice: .86 },
  'hard rock':          { energy: .78, density: .68, brightness: .48, synthetic: .05, abstract: .22, voice: .82 },
  'blues rock':         { energy: .65, density: .55, brightness: .48, synthetic: .03, abstract: .20, voice: .85 },
  'garage rock':        { energy: .78, density: .58, brightness: .48, synthetic: .05, abstract: .30, voice: .82 },
  'art rock':           { energy: .55, density: .60, brightness: .45, synthetic: .30, abstract: .75, voice: .70 },
  'experimental rock':  { energy: .58, density: .65, brightness: .40, synthetic: .35, abstract: .85, voice: .60 },
  'progressive rock':   { energy: .58, density: .72, brightness: .50, synthetic: .35, abstract: .70, voice: .65 },
  'progressive':        { energy: .55, density: .70, brightness: .48, synthetic: .35, abstract: .68, voice: .60 },
  'space rock':         { energy: .50, density: .65, brightness: .48, synthetic: .45, abstract: .72, voice: .50 },
  'post-rock':          { energy: .45, density: .70, brightness: .42, synthetic: .25, abstract: .62, voice: .18 },
  'new wave':           { energy: .65, density: .48, brightness: .60, synthetic: .55, abstract: .40, voice: .85 },
  'punk/new wave':      { energy: .70, density: .50, brightness: .55, synthetic: .35, abstract: .38, voice: .85 },
  'power pop':          { energy: .68, density: .52, brightness: .75, synthetic: .12, abstract: .18, voice: .88 },
  'grunge':             { energy: .72, density: .72, brightness: .32, synthetic: .05, abstract: .32, voice: .80 },
  'gothic rock':        { energy: .55, density: .62, brightness: .18, synthetic: .30, abstract: .45, voice: .80 },
  'neo-psychedelia':    { energy: .52, density: .62, brightness: .52, synthetic: .35, abstract: .65, voice: .68 },
  'folk rock':          { energy: .48, density: .48, brightness: .55, synthetic: .05, abstract: .25, voice: .85 },
  'indie folk':         { energy: .35, density: .38, brightness: .55, synthetic: .10, abstract: .28, voice: .88 },
  'anti-folk':          { energy: .45, density: .35, brightness: .48, synthetic: .08, abstract: .55, voice: .90 },
  'folk punk':          { energy: .72, density: .48, brightness: .50, synthetic: .03, abstract: .35, voice: .88 },
  'chamber pop':        { energy: .40, density: .60, brightness: .62, synthetic: .15, abstract: .40, voice: .82 },

  // --- punk and its descendants -----------------------------------------
  'punk':               { energy: .85, density: .58, brightness: .45, synthetic: .05, abstract: .25, voice: .82 },
  'pop punk':           { energy: .80, density: .55, brightness: .68, synthetic: .08, abstract: .15, voice: .88 },
  'hardcore':           { energy: .92, density: .70, brightness: .35, synthetic: .08, abstract: .28, voice: .80 },
  'emo':                { energy: .62, density: .58, brightness: .38, synthetic: .10, abstract: .30, voice: .88 },
  'metalcore':          { energy: .88, density: .80, brightness: .28, synthetic: .12, abstract: .35, voice: .72 },

  // --- metal ------------------------------------------------------------
  'metal':              { energy: .82, density: .75, brightness: .32, synthetic: .08, abstract: .30, voice: .75 },
  'alternative metal':  { energy: .78, density: .72, brightness: .35, synthetic: .18, abstract: .38, voice: .78 },
  'industrial metal':   { energy: .82, density: .80, brightness: .22, synthetic: .55, abstract: .45, voice: .70 },
  'industrial rock':    { energy: .72, density: .72, brightness: .25, synthetic: .60, abstract: .48, voice: .75 },
  'progressive metal':  { energy: .75, density: .82, brightness: .38, synthetic: .25, abstract: .62, voice: .65 },
  'thrash metal':       { energy: .92, density: .78, brightness: .35, synthetic: .03, abstract: .30, voice: .75 },
  'nu metal':           { energy: .80, density: .72, brightness: .30, synthetic: .32, abstract: .28, voice: .82 },
  'grindcore':          { energy: .97, density: .90, brightness: .15, synthetic: .05, abstract: .55, voice: .60 },

  // --- electronic and synth pop -----------------------------------------
  'synth-pop':          { energy: .58, density: .48, brightness: .68, synthetic: .88, abstract: .30, voice: .85 },
  'electropop':         { energy: .62, density: .50, brightness: .72, synthetic: .90, abstract: .25, voice: .88 },
  'dance-pop':          { energy: .72, density: .55, brightness: .80, synthetic: .85, abstract: .15, voice: .90 },
  'techno':             { energy: .78, density: .48, brightness: .45, synthetic: .95, abstract: .50, voice: .10 },
  'idm':                { energy: .52, density: .58, brightness: .45, synthetic: .92, abstract: .80, voice: .15 },
  'electronica':        { energy: .52, density: .52, brightness: .52, synthetic: .88, abstract: .48, voice: .35 },
  'downtempo':          { energy: .30, density: .48, brightness: .45, synthetic: .75, abstract: .45, voice: .35 },
  'dark ambient':       { energy: .12, density: .40, brightness: .10, synthetic: .68, abstract: .82, voice: .05 },
  'dark wave':          { energy: .45, density: .52, brightness: .18, synthetic: .62, abstract: .52, voice: .72 },
  'electro-industrial': { energy: .78, density: .70, brightness: .20, synthetic: .90, abstract: .55, voice: .60 },
  'art pop':            { energy: .48, density: .58, brightness: .58, synthetic: .50, abstract: .68, voice: .82 },
  'video game music':   { energy: .55, density: .55, brightness: .58, synthetic: .78, abstract: .45, voice: .10 },

  // --- hip hop ----------------------------------------------------------
  'trap':               { energy: .68, density: .50, brightness: .38, synthetic: .82, abstract: .30, voice: .88 },
  'experimental hip hop': { energy: .58, density: .65, brightness: .38, synthetic: .70, abstract: .82, voice: .82 },

  // --- jazz and composition ---------------------------------------------
  'classical':          { energy: .35, density: .60, brightness: .52, synthetic: .02, abstract: .40, voice: .20 },
  'contemporary jazz':  { energy: .45, density: .55, brightness: .58, synthetic: .18, abstract: .45, voice: .25 },
  'avant-garde jazz':   { energy: .65, density: .75, brightness: .38, synthetic: .10, abstract: .92, voice: .15 },
  'free improvisation': { energy: .55, density: .70, brightness: .35, synthetic: .15, abstract: .95, voice: .12 },
  'post-bop':           { energy: .55, density: .62, brightness: .52, synthetic: .03, abstract: .55, voice: .12 },
  'jazz rock':          { energy: .68, density: .70, brightness: .55, synthetic: .35, abstract: .58, voice: .35 },

  // --- texture and single-axis tags -------------------------------------
  // Deliberately partial: these say one true thing and shouldn't pretend to
  // place a record on axes they know nothing about.
  'noise':              { energy: .70, density: .85, brightness: .20, synthetic: .50, abstract: .95, voice: .20 },
  'reggae':             { energy: .50, density: .48, brightness: .60, synthetic: .15, abstract: .22, voice: .82 },
  'instrumental':       { voice: .04 },
  'male vocalist':      { voice: .92 },
  'female vocalist':    { voice: .92 },
  'energetic':          { energy: .82 },
};

/** Year -> era axis. 1950 maps to 0, the current year to 1. */
const ERA_MIN = 1950;
/*
 * Frozen, not the current year.
 *
 * This was `new Date().getFullYear()`, which made the era axis depend on when
 * the code ran: every album's era value drifts down each January, the axis
 * spread drifts with it, and every distance in the catalog changes slightly
 * for no reason anybody would connect to the calendar. It also meant the
 * server-side engine would disagree with the client whenever the two ran
 * either side of midnight on New Year's Eve.
 *
 * Bump it deliberately when the catalog's recent end genuinely needs more
 * room, and re-run the eval when you do.
 */
const ERA_MAX = 2026;

export { ERA_MIN, ERA_MAX };

export function eraFromYear(year: number | null): number {
  if (year == null) return 0.5;
  return clamp01((year - ERA_MIN) / (ERA_MAX - ERA_MIN));
}

export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Weighted blend of every recognised tag's profile, plus era from the year.
 *
 * Tag vote counts weight the blend, but sub-linearly (sqrt): a tag with 40
 * votes should count for more than one with 4, not ten times more, or the
 * single most-voted genre tag drowns out the descriptive ones that carry the
 * actual character of the record.
 *
 * Axes no tag speaks to settle at 0.5 rather than 0 — an unknown is a shrug,
 * not an assertion that the record is maximally dark and instrumental.
 */
export function deriveVector(tags: ItemTag[], year: number | null): Vector {
  const sums = {} as Record<Axis, number>;
  const weights = {} as Record<Axis, number>;
  for (const axis of AXES) {
    sums[axis] = 0;
    weights[axis] = 0;
  }

  for (const { tag, count } of tags) {
    const profile = TAG_LEXICON[tag.toLowerCase().trim()];
    if (!profile) continue;
    const w = Math.sqrt(Math.max(1, count));
    for (const [axis, value] of Object.entries(profile) as [Axis, number][]) {
      sums[axis] += value * w;
      weights[axis] += w;
    }
  }

  const vector = {} as Vector;
  for (const axis of AXES) {
    vector[axis] = weights[axis] > 0 ? clamp01(sums[axis] / weights[axis]) : 0.5;
  }
  vector.era = eraFromYear(year);
  return vector;
}

/** How much of an item's tag weight we actually recognise. Low = weak signal. */
export function lexiconCoverage(tags: ItemTag[], isMusical?: (t: string) => boolean): number {
  if (tags.length === 0) return 0;
  let known = 0;
  let total = 0;
  for (const { tag, count } of tags) {
    const name = tag.toLowerCase().trim();
    // Bookkeeping does not count against knowing the music.
    //
    // This used to divide by every tag on the record, so an album carrying
    // "offizielle charts", "english", "1-4 wochen" and "plattentests.de"
    // scored badly for having been catalogued thoroughly. To Pimp a Butterfly
    // has 85 tags and scored 0.10, which put it below the floor and out of the
    // engine entirely — along with Dr. Dre's 2001, three Kanye records and
    // most of Kendrick's catalogue.
    if (isMusical && !isMusical(name)) continue;
    const w = Math.sqrt(Math.max(1, count));
    total += w;
    if (TAG_LEXICON[name]) known += w;
  }
  return total > 0 ? known / total : 0;
}
