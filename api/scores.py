#!/usr/bin/env python3
"""
The two absolute scores, in one place.

Popularity and quality were written out three times — the export, the API and
the full-scale eval — and three copies of a scoring formula drift. They did:
the rating prior was chosen before there was enough rating data to know the
distribution, and stayed wrong in all three at once because nothing compared
them.

Both scales are absolute rather than percentile, so a given album scores the
same wherever it is computed. See the note on PRIOR_DEVOTION for why the
constants are frozen rather than measured per run.
"""
from __future__ import annotations

import math

DEVOTION_CAP = 30.0

# Frozen, not measured. The catalog median devotion (plays per listener) when
# the scale was fixed. Recomputing it per export would make quality describe
# the population again, which is the fault absolute scales exist to remove.
PRIOR_DEVOTION = 7.85

# The expected MusicBrainz rating for an album nothing is known about.
#
# This was 3.4, chosen before a full ratings pass existed to measure against.
# With 11,143 albums now carrying a usable rating, the mean is 3.87 and the
# median 4.00 — so at 3.4, 80% of rated albums sat above the prior and were
# lifted by it. Having a rating was therefore a bonus in itself, and rated
# albums have a median 1,415 listeners against 20 for unrated ones, so the
# bonus tracked popularity almost exactly. That is the bias this whole scoring
# scheme exists to keep out of quality, reintroduced through the back door by
# a constant that was merely stale.
#
# At 3.87 the adjustment is symmetric again: above-average ratings lift, below
# average cut, and having been rated at all is worth nothing by itself.
PRIOR_RATING = 3.87

# Devotion deciles p10=3.05 and p90=21.2 mapped onto quality 2 and 8.
QUALITY_SLOPE = 6.0 / (math.log10(21.2) - math.log10(3.05))
QUALITY_INTERCEPT = 2.0 - QUALITY_SLOPE * math.log10(3.05)


def absolute_popularity(listeners: int | None) -> float:
    """
    Listeners on a fixed 0-10 scale, independent of any population.

    Log because reach is multiplicative: the gap between 100 and 1,000
    listeners matters as much as the one between 10,000 and 100,000.
    """
    return round(min(10.0, 2.0 * math.log10(1.0 + max(0, listeners or 0))), 2)


def absolute_quality(listens: int | None, listeners: int | None,
                     rating: float | None, votes: int | None) -> float:
    """
    Devotion — plays per listener — on a fixed 0-10 scale.

    Separates records people return to from records they tried once. Shrunk
    toward the prior by listener count, because a ratio over nine people is
    noise rather than acclaim, and log-scaled onto fixed anchors so a given
    ratio always scores the same.
    """
    n = max(0, listeners or 0)
    if n == 0:
        # Unknown sits just below the middle: not rewarded like a loved record,
        # not buried like a bad one.
        return 4.5
    plays = min(max(0, listens or 0), DEVOTION_CAP * n)
    devotion = (plays + PRIOR_DEVOTION * 80) / (n + 80)

    votes = votes or 0
    if rating is not None and votes >= 2:
        adj = (rating * votes + PRIOR_RATING * 6) / (votes + 6)
        devotion *= 1 + ((adj - PRIOR_RATING) / 5.0) * 1.2

    if devotion <= 0:
        return 0.0
    q = QUALITY_SLOPE * math.log10(devotion) + QUALITY_INTERCEPT
    return round(max(0.0, min(10.0, q)), 2)
