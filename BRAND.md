# album.guide brand assets

Favicons, app icons, social cards, logo lockups, source SVGs, the typeface, and design
tokens.

## Palette

| Token | Hex | Use |
| --- | --- | --- |
| `--ag-ink` | `#1F1E1C` | Text, reels, cassette shell |
| `--ag-blue` | `#185FA5` | Accent — the destination reel only |
| `--ag-grey` | `#8E8C86` | Tape, rules, secondary text |
| `--ag-paper` | `#FBFAF7` | Page and badge background |
| `--ag-light` | `#F5F3EE` | Text and marks on dark |

Blue was chosen by elimination. Amazon owns orange, TripAdvisor owns green, and Target
owns red — and the mark's circular geometry is close enough to all three that colour is
the main thing keeping distance. Don't drift the accent warm.

On dark backgrounds the accent lightens to `#5A9BD8`; `#185FA5` doesn't carry enough
contrast against ink.

## Typeface

Jost, weights 400 and 500. Open Font License, bundled in `fonts/`, or
`npm i @fontsource/jost`.

Jost is load-bearing, not a preference. Its `a` is single-storey — a circle with a stem —
which is what lets the drawn reel replace it without looking like a foreign object
dropped into the word. Any face with a double-storey `a` (Outfit, DM Sans, Lexend, most
grotesques) breaks the whole conceit. If you ever swap the typeface, that's the one
property that has to survive.

## The mark

The `a` and the raised dot in `album.guide` are the two tape reels. The dot sits at the
centre of the x-height rather than on the baseline, making it an interpunct — this is
what lets the tape run level between the two reels.

The icon is that same pair with the letters removed, so the favicon is a crop of the
wordmark rather than a separate drawing.

**Reel hubs are hollow, with cog teeth on the inner edge of the ring.** A ring with a
solid centre dot is a bullseye and reads as Target. The teeth also break the circular
silhouette, which is what separates it from TripAdvisor. Never fill the hub.

**Spacing is optically corrected, not measured.** The gap between `m` and the dot is
crossed by the tape arcs, which visually caps it; the gap between the dot and `g` is open
and bleeds outward. They're set to different values (14px and 10px at 40pt) so they
*appear* equal. Don't normalise them.

## Size tiers

The icon degrades in two steps rather than scaling one drawing:

- `icon-lg` — 40px and up. Shell, cog teeth, tape runs, and the two holes along the
  bottom edge.
- `icon-sm` — below 40px. Shell and plain hollow reels. Teeth, tape and holes all fill in
  at small sizes, so they're dropped rather than muddied.

The holes are solid dots rather than strokes, which is why they survive further down than
the tape does.

Wire each favicon size to its matching tier. Don't downscale one source.

## Files

```
svg/          Source vectors — scale these, never the PNGs
  logo-primary.svg          Full lockup. Site header.
  logo-primary-reversed.svg Same, for dark backgrounds.
  logo-wordmark.svg         Tight-cropped lockup, no side padding.
  icon-lg.svg               Outline icon, 40px+.
  icon-sm.svg               Outline icon, below 40px.
  icon-lg-reversed.svg      Outline icon for dark backgrounds.
  icon-mono.svg             Single-ink, no accent. Print, stamps, watermarks.
  app-icon.svg              Filled shell on a rounded badge.
  app-icon-square.svg       Same, square corners, for iOS.
  app-icon-maskable.svg     12% safe padding for Android adaptive icons.

favicon/      favicon.ico (16/32/48) + individual PNGs
icons/        apple-touch-icon, icon-192, icon-512, icon-maskable-512
social/       og-image, og-image-dark (1200x630), twitter-card (1200x600)
logo/         Raster exports, 1x and 2x, light and reversed
fonts/        Jost 400 and 500, TTF
brand-tokens.css   Custom properties with a dark-mode block
site.webmanifest   PWA manifest
```

The outline icon is for UI — headers, tabs, inline. The filled `app-icon` is for home
screens and anywhere the mark sits on an unpredictable background, where outline-only
would disappear.

The apple-touch-icon is square on purpose. iOS applies its own corner mask, and a
pre-rounded source gets rounded twice.

## HTML

```html
<link rel="icon" href="/favicon/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#185FA5">

<meta property="og:image" content="https://album.guide/social/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://album.guide/social/twitter-card.png">
```

## Clear space and minimums

Clear space around the lockup equals the height of the `b` in `lbum`.
Minimum lockup width 200px. Minimum icon 16px.

Don't recolour the reels, fill the hubs, straighten the tape arcs in the lockup, or curve
them in the icon — the lockup curves, the icon runs straight, and that difference is
deliberate.

## Placeholder

The social card tagline — "a route through the albums you haven't found yet" — is a
placeholder. Swap it for the site's actual line and re-export.
