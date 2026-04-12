# KTC time-series model: feature backlog

Ideas for feature additions to `scripts/train_ktc_timeseries.py` beyond
what's currently in `FAST_FEATURE_NAMES` / `SLOW_COMMON` / `SLOW_POS` /
`WEEKLY_FEATURE_NAMES`. Ordered roughly by expected impact × effort.

Each entry: **name** — *what it captures*, *data source*, *why current
state falls short*, *rough effort*.

---

## Near-term (after Commit C.2b ships)

### Point-in-time injury status (`statusAtT`)
*What it captures*: the player's injury designation on date *t*, not
averaged across a window.
*Data source*: `nflverse_weekly_2025.json` → `injuryStatus` column on
the most-recent completed week ≤ *t*.
*Current state*: we have `injuryOut2wk` (count of last-2-weeks rows
where injuryStatus ∈ {Out, IR, Doubtful}) and `priorInjuryWeeks`
(prior-season missed-games count). Both ablated to near-zero or
slightly negative in Commit C.1 — likely because the 2-week smoothing
blurs the signal the model actually needs: *"is this player hurt
right now?"* Dynasty value drops sharply the instant a player's
status flips to IR; a trailing *count* can't learn that transition.
*Encoding*: ordinal `{None→0, Questionable→1, Doubtful→2, Out/IR→3}`
or one-hot. Distribution across the weekly cache:
`None 6143 / nan 987 / Out 444 / Questionable 371 / Doubtful 26`, so
~10% of rows would see a non-zero feature value.
*Effort*: ~20 lines in `compute_weekly_features_for_player`, no new
data source. One new feature added to `WEEKLY_FEATURE_NAMES`.
*Expected impact*: WR H=60/90/120 are stuck near zero pgR² — injury
risk is a huge component at those horizons and the current features
can't encode it properly. Not guaranteed to move them (the data
envelope limit is also real), but it's the cheapest feature-quality
lever on the table.

---

## Medium-term

### Practice participation reports (`practice_wed/thu/fri`)
*What it captures*: the DNP / LP / FP designation from each of the
three practice days in the week leading up to game day. Canonical
Vegas signal — the market moves on these before game-time injury
designations update.
*Data source*: nflverse has an `injuries` feed separate from weekly
stats. Requires a new cache file (similar to `nflverse_weekly_2025.json`)
and an augmentation step in a new `scripts/build_nflverse_injuries_cache.py`.
*Current state*: completely absent.
*Effort*: ~1 commit for the cache builder + ~20 lines to join into
`compute_weekly_features_for_player`. Three new features (one per
practice day), encoded as `{DNP:0, LP:1, FP:2, no_report:-1}`.
*Expected impact*: orthogonal to `statusAtT` (practice reports
*predict* Sunday's status) so should stack with it.

### Days-on-IR / games-missed-to-date counter
*What it captures*: cumulative games missed in the current season as
of date *t*. Complements `gamesPlayedSeason` (which counts appearances)
with the negation (missed opportunities).
*Data source*: derivable from the existing weekly cache by differencing
`weeksSinceLastPlayed` against week index.
*Effort*: 10 lines. One new feature.

---

## Longer-term

### Injury type / location
*What it captures*: hamstring vs ACL vs concussion, soft-tissue vs
skeletal. Different injury types have very different recovery curves
and recurrence rates.
*Data source*: would need to pull from a source like Fantasy Data or
Sportradar — nflverse doesn't expose injury type in a structured way.
Out of scope until we have a data contract.

### Depth-chart-driven snap-share projection
*What it captures*: if the starter ahead of this player goes on IR,
this player's snap share projects to double. Captures the
"handcuff becomes RB1" dynamic that drives sharp KTC jumps.
*Data source*: combine existing `depthRankLatest` + `injuryStatus` of
the player(s) above in the depth chart.
*Effort*: medium — requires cross-player lookup in the weekly compute
closure. Would need a depth-chart-by-team aggregate to access
"the player at `depthRank-1` on the same team."

### Second season of KTC history
*What it captures*: doubles the training-sample envelope, directly
addresses the WR H=90 ceiling and lets walk-forward CV work at H=60.
*Data source*: KTC historical dumps older than the current 179-day
window. Requires checking whether `ktc_history.json` contains earlier
data (or backfilling from the KTC site).
*Effort*: large — data collection, re-augmentation, retraining everything.
*Expected impact*: *this is the lever*. Every other idea on this list
is capped by the 179-day data envelope. With a full year or two,
the ceiling moves significantly for every H ≥ 60 pair.
