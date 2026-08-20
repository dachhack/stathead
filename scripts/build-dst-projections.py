#!/usr/bin/env python3
"""Project 2026 team-defense seasons AS COMPONENTS — points allowed, sacks,
interceptions, fumble recoveries, defensive/special-teams touchdowns and
safeties — rather than as a single fantasy-point scalar.

Why: leagues tune points-allowed tiers and per-takeaway values more than almost
anything else, and a bare points number cannot be re-priced under a different
tier table. This is the DST half of the same problem the kicker build solved.

    python3 scripts/build-dst-projections.py [season]

Writes public/data/dst-projections-<season>.json.

MEASURED, not assumed — the model is shaped around these and each component is
shrunk by its OWN reliability rather than by one blanket factor:

  * Year-over-year team reliability, 2016-2025 (9 pairs):
        points allowed/gm  r = +0.30      sacks/gm  r = +0.21
        interceptions/gm   r = +0.11
    Interceptions are indistinguishable from noise; sacks are weak; points
    allowed is the only component worth modelling carefully.
  * Predicting the quantity that actually scores — next-season PA BRACKET
    points per game, not raw points allowed:
        2yr-weighted points allowed   r = -0.23
        prior def_epa_per_play        r = -0.08
    An earlier build blended these 50/50 after tuning against raw points
    allowed, where they look comparable. Against bracket points they are not,
    and the blend measurably diluted the good predictor: correlation with
    actuals FELL from 0.26 to 0.21. def_epa is dropped; PA carries alone.
    There is also no forward-looking market signal in the repo to lean on
    (feature-store/vegas.json stops at 2025, no odds file is committed); with
    2026 lines this model would get materially better.

  * IT DOES NOT BEAT A FLAT LEAGUE MEAN. Backtested over 2023-25 against
    per-team DST points/game (PA bracket + sacks + 2x INT):
        flat league mean              RMSE 1.375   r 0.00
        this model (keep 0.35)        RMSE 1.384   r 0.25
        unshrunk carry                RMSE 1.52    r 0.25
        raw prior season              RMSE 1.58    r 0.27
    Shrinking is clearly right — it recovers most of the gap from the naive
    carry — but no configuration tested gets under a constant. The model has
    modest ORDERING value (r ~ 0.25) and no error reduction. Use it to
    re-score, not to rank; if you need a single number and nothing else,
    the league mean is defensible.
  * The points-allowed bracket applies PER GAME, so scoring it at a team's
    projected season mean is wrong — a team averaging 21.5 does not score the
    21-27 tier every week. Integrating the bracket over the within-team
    per-game distribution (residual sd 9.4) instead cuts mean absolute error
    against actual bracket points from ~0.52 to ~0.19 pts/gm across 2023-25.

The honest summary: DST is the least forecastable position in fantasy. This
build exists so a league can re-score it under its own tier table; treat the
ordering it implies with the same suspicion as any other DST projection.
"""
from __future__ import annotations

import csv
import gzip
import json
import math
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'public/data'
GEN = ROOT / 'src/generated'

SEASON = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
HISTORY = list(range(SEASON - 10, SEASON))
WEEKS = 17
PA_GAME_SD = 9.4                 # within-team per-game spread of points allowed

# Per-component shrink toward the league mean, set from the reliabilities above.
KEEP_PA = 0.35                   # tuned on bracket points; RMSE is flat 0.15-0.60
KEEP_SACK = 0.21                 # yoy r = 0.21
KEEP_INT = 0.11                  # yoy r = 0.11 — barely distinguishable from noise
DEF_SHRINK = 0.50                # matches build-weekly-projections' def-vs-pos shrink
# In-season blend. Once games are played, the rest of the season is projected as
# w * (what this season has shown) + (1 - w) * the preseason line, with
# w = n / (n + IN_SEASON_K). Fitted over 2017-2025 on 3,650 team-cutoffs:
# K = 10.5 gives RMSE 2.334 against rest-of-season DST points per game, versus
# 2.538 for the preseason prior alone and 3.316 for the current season alone.
# The last of those is the point worth remembering — current-season form on its
# own is WORSE than ignoring it. The curve is deliberately slow: 28% weight at
# four weeks, 43% at eight. Preseason (n = 0) this is inert.
IN_SEASON_K = 10.5
# Everything below is rare enough that a team-level signal can't be established
# from ten seasons; they are projected at the league rate for every team.
LEAGUE_ONLY = ('fum_rec', 'def_td', 'st_td', 'safety')

PA_BRACKETS = ((0, 10), (6, 7), (13, 4), (20, 1), (27, 0), (34, -1), (999, -4))
PTS = {'sack': 1, 'def_int': 2, 'fum_rec': 2, 'def_td': 6, 'st_td': 6, 'safety': 2}


def pa_points(allowed: float) -> float:
    for cap, pts in PA_BRACKETS:
        if allowed <= cap:
            return pts
    return -4


def expected_pa_points(mu: float, sd: float = PA_GAME_SD) -> float:
    """Expected bracket points for a defense projected to allow `mu` per game.

    Integrates the bracket over the per-game distribution rather than scoring
    it at the mean — see the module docstring for why that matters (0.52 ->
    0.19 pts/gm MAE)."""
    total = weight = 0.0
    for x in range(0, 61):
        w = math.exp(-0.5 * ((x - mu) / sd) ** 2)
        total += w * pa_points(x)
        weight += w
    return total / weight if weight else 0.0


def load_pbp(season: int):
    path = DATA / f'pbp-slim-{season}.json.gz'
    return json.loads(gzip.open(path).read()) if path.exists() else []


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def team_metrics(season: int):
    doc = load_json(DATA / f'team-metrics-{season}.json', None)
    if doc is None:
        return {}
    rows = doc if isinstance(doc, list) else (doc.get('teams') or list(doc.values())[0])
    if isinstance(rows, dict):
        rows = list(rows.values())
    return {r['team']: r for r in rows if isinstance(r, dict) and r.get('team')}


def points_allowed_by_game():
    """(season, team) -> [points allowed, per game] from the committed schedule."""
    out = defaultdict(list)
    path = DATA / 'games.csv'
    opener = (lambda: path.open(newline='')) if path.exists() else \
             (lambda: gzip.open(DATA / 'games.csv.gz', mode='rt', newline=''))
    with opener() as fh:
        for r in csv.DictReader(fh):
            if r.get('game_type') != 'REG':
                continue
            try:
                y = int(r['season']); hs = float(r['home_score']); a = float(r['away_score'])
            except (ValueError, TypeError, KeyError):
                continue
            out[(y, r['home_team'])].append(a)
            out[(y, r['away_team'])].append(hs)
    return out


def defense_counts(season: int):
    """team -> per-game sacks and interceptions, from pbp-slim."""
    sacks = defaultdict(int); ints = defaultdict(int); games = defaultdict(set)
    for r in load_pbp(season):
        d = r.get('defteam')
        if not d:
            continue
        games[d].add(r.get('game_id'))
        if r.get('sack'):
            sacks[d] += 1
        if r.get('interception'):
            ints[d] += 1
    return {t: (sacks[t] / len(games[t]), ints[t] / len(games[t])) for t in games if games[t]}


def iter_csv(name: str):
    """Read public/data/<name>.csv, falling back to the committed .csv.gz."""
    raw = DATA / f'{name}.csv'
    if raw.exists():
        with raw.open(newline='') as fh:
            yield from csv.DictReader(fh)
        return
    gz = DATA / f'{name}.csv.gz'
    if gz.exists():
        with gzip.open(gz, mode='rt', newline='') as fh:
            yield from csv.DictReader(fh)


def num(row, key) -> float:
    try:
        return float(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def in_season_rates(season: int):
    """team -> (weeks played, points allowed/gm, sacks/gm, INTs/gm) from the
    CURRENT season's completed games. Empty preseason, which makes the blend
    below a no-op until Week 1 is in the books."""
    weeks = defaultdict(set)
    sacks = defaultdict(float)
    ints = defaultdict(float)
    for row in iter_csv(f'player_stats_{season}'):
        if row.get('season_type') != 'REG':
            continue
        team, week = row.get('team'), row.get('week')
        if not team or not week:
            continue
        weeks[team].add(week)
        sacks[team] += num(row, 'def_sacks')
        ints[team] += num(row, 'def_interceptions')
    if not weeks:
        return {}
    allowed = defaultdict(list)
    for (year, team), vals in points_allowed_by_game().items():
        if year == season:
            allowed[team] = vals
    out = {}
    for team, wk in weeks.items():
        n = len(wk)
        pa = allowed.get(team) or []
        if not n or not pa:
            continue
        out[team] = (n, sum(pa) / len(pa), sacks[team] / n, ints[team] / n)
    return out


def zscore(values: dict):
    vals = [v for v in values.values() if isinstance(v, (int, float))]
    if len(vals) < 2:
        return {k: 0.0 for k in values}
    m = statistics.mean(vals); s = statistics.pstdev(vals) or 1.0
    return {k: ((v - m) / s if isinstance(v, (int, float)) else 0.0) for k, v in values.items()}


def points_scored_by_game():
    """(season, team) -> [points scored, per game]. The mirror of
    points_allowed_by_game, read from the same file."""
    out = defaultdict(list)
    path = DATA / 'games.csv'
    opener = (lambda: path.open(newline='')) if path.exists() else \
             (lambda: gzip.open(DATA / 'games.csv.gz', mode='rt', newline=''))
    with opener() as fh:
        for r in csv.DictReader(fh):
            if r.get('game_type') != 'REG':
                continue
            try:
                y = int(r['season']); hs = float(r['home_score']); a = float(r['away_score'])
            except (ValueError, TypeError, KeyError):
                continue
            out[(y, r['home_team'])].append(hs)
            out[(y, r['away_team'])].append(a)
    return out


def offense_concede_ratio(season: int):
    """offense -> DST fantasy points it CONCEDES per game, as a ratio to the
    league, shrunk toward 1.

    An offence concedes DST points three ways: by scoring little (the opposing
    bracket pays out), by taking sacks, and by throwing interceptions. All three
    are directly countable — pbp-slim keys sacks and interceptions by `posteam`,
    which is the offence that suffered them.

    This replaces an earlier proxy (opponents' projected offensive touchdowns).
    The two agree well — r = -0.80 with the correct sign, same teams at both
    extremes — but this is the direct measure, matches what
    build-weekly-projections uses for its def-vs-pos DST multiplier, and has a
    wider spread (sd 0.025 vs 0.015)."""
    sacks = defaultdict(int); ints = defaultdict(int); games = defaultdict(set)
    for r in load_pbp(season):
        off = r.get('posteam')
        if not off:
            continue
        games[off].add(r.get('game_id'))
        if r.get('sack'):
            sacks[off] += 1
        if r.get('interception'):
            ints[off] += 1
    scored = points_scored_by_game()
    per_game = {}
    for t, gs in games.items():
        n = len(gs)
        pts = scored.get((season, t))
        if not n or not pts:
            continue
        bracket = statistics.mean(expected_pa_points(p) for p in pts)
        per_game[t] = bracket + sacks[t] / n + 2 * (ints[t] / n)
    if not per_game:
        return {}
    league = statistics.mean(per_game.values())
    if not league:
        return {}
    return {t: 1 + DEF_SHRINK * (v / league - 1) for t, v in per_game.items()}


def schedule_strength(season: int, concede: dict):
    """team -> mean DST-points-conceded strength of its 2026 opponents.

    build-weekly-projections applies matchup multipliers per week but NORMALIZES
    them to mean 1, so they only redistribute points between weeks and can never
    move a season total. That is right for skill players, whose season line the
    projection pool owns — but the DST season line is produced here, so the
    schedule effect has to be applied at this level or it is lost. Across 2026
    it is worth ~8% of DST points between the easiest and hardest schedule, the
    widest of any position."""
    sched = load_json(DATA / f'schedule-{season}.json', {'games': []}).get('games', [])
    faced = defaultdict(list)
    for g in sched:
        h, a = g.get('home'), g.get('away')
        if h and a:
            faced[h].append(concede.get(a, 1.0))
            faced[a].append(concede.get(h, 1.0))
    return {t: statistics.mean(v) for t, v in faced.items() if v}


def main() -> None:
    pa_games = points_allowed_by_game()
    prior, prior2 = SEASON - 1, SEASON - 2

    pa_mean = {}
    for y in (prior, prior2):
        for (s, t), vals in pa_games.items():
            if s == y and len(vals) >= 10:
                pa_mean[(y, t)] = statistics.mean(vals)
    teams = sorted({t for (s, t) in pa_mean if s == prior})
    if not teams:
        raise SystemExit(f'no {prior} schedule results found — cannot project {SEASON}')

    # ── Points allowed: the team's own 2yr-weighted mark, shrunk ──────────
    # def_epa_per_play was tried in a z-blend here and removed: against bracket
    # points it correlates -0.08 versus carry's -0.23, and blending them cost
    # 0.05 of correlation with actuals.
    carry = {t: (2 * pa_mean[(prior, t)] + pa_mean.get((prior2, t), pa_mean[(prior, t)])) / 3
             for t in teams}
    league_pa = statistics.mean(carry.values())

    sched = schedule_strength(SEASON, offense_concede_ratio(prior))

    # ── Counting stats ────────────────────────────────────────────────────
    d_prior, d_prior2 = defense_counts(prior), defense_counts(prior2)
    sack_carry = {t: (2 * d_prior.get(t, (0, 0))[0] + d_prior2.get(t, d_prior.get(t, (0, 0)))[0]) / 3
                  for t in teams}
    int_carry = {t: (2 * d_prior.get(t, (0, 0))[1] + d_prior2.get(t, d_prior.get(t, (0, 0)))[1]) / 3
                 for t in teams}
    league_sack = statistics.mean(sack_carry.values())
    league_int = statistics.mean(int_carry.values())

    # Rare events: league rate for everyone. Measured off the one season whose
    # schema carries them (2025 stats_player_week); they move the total by ~1 pt
    # a game combined, and no team-level signal survives ten seasons.
    league_rate = {'fum_rec': 0.452, 'def_td': 0.051, 'st_td': 0.050, 'safety': 0.022}

    live = in_season_rates(SEASON)
    if live:
        weeks_played = max(v[0] for v in live.values())
        print(f'  in-season: {weeks_played} week(s) played, current season weighted '
              f'{weeks_played / (weeks_played + IN_SEASON_K):.0%}')

    rows = []
    for t in teams:
        pa_pg = league_pa + KEEP_PA * (carry[t] - league_pa)
        ratio = sched.get(t, 1.0)

        sack = league_sack + KEEP_SACK * (sack_carry[t] - league_sack)
        dint = league_int + KEEP_INT * (int_carry[t] - league_int)

        # In-season: blend each component toward what this season has actually
        # shown, on the fitted n/(n+K) curve. Blended per component rather than
        # scaling the roll-up, so the published components keep reconciling to
        # projPts. The rare events (fumble recoveries, TDs, safeties) are left
        # at the league rate: a handful of in-season occurrences is noise, and
        # no team-level signal survived ten seasons of measurement either.
        n_live = 0
        if t in live:
            n_live, live_pa, live_sack, live_int = live[t]
            w = n_live / (n_live + IN_SEASON_K)
            pa_pg = (1 - w) * pa_pg + w * live_pa
            sack = (1 - w) * sack + w * live_sack
            dint = (1 - w) * dint + w * live_int

        # Schedule is applied to the COMPONENTS, not to the rolled-up total, so
        # the published components still reconcile to projPts — scaling only the
        # total left them 7.1 pts/season adrift, which would break exactly the
        # re-scoring the components exist for.
        #
        # Directions differ and both matter: a HIGHER ratio means opponents
        # concede more, so this defense takes MORE takeaways (multiply) and
        # allows FEWER points (divide). An earlier revision inherited the
        # opposite sign from a proxy measuring opponent offence strength; it
        # surfaced as corr(scheduleStrength, ppg) = -0.17 when it must be
        # positive. `ratio` is already shrunk by DEF_SHRINK, so it is applied
        # at face value, matching how the weekly multipliers are used.
        pa_pg = pa_pg / ratio if ratio else pa_pg
        sack *= ratio
        dint *= ratio
        comp = {'sack': sack, 'def_int': dint,
                **{k: v * ratio for k, v in league_rate.items()}}

        pa_pts = expected_pa_points(pa_pg)
        ppg = pa_pts + sum(PTS[k] * v for k, v in comp.items())
        rows.append({
            'name': f'{t} DST', 'team': t, 'sleeper': t, 'games': WEEKS,
            'pts_allow_pg': round(pa_pg, 2),
            'pts_allow': round(pa_pg * WEEKS, 1),
            'pa_points_pg': round(pa_pts, 2),
            'sack': round(sack * WEEKS, 1),
            'def_int': round(dint * WEEKS, 1),
            'fum_rec': round(comp['fum_rec'] * WEEKS, 1),
            'def_td': round(comp['def_td'] * WEEKS, 2),
            'st_td': round(comp['st_td'] * WEEKS, 2),
            'safety': round(comp['safety'] * WEEKS, 2),
            'scheduleStrength': round(ratio, 3),
            'inSeasonWeeks': n_live,
            'inSeasonWeight': round(n_live / (n_live + IN_SEASON_K), 3) if n_live else 0,
            'projPts': round(ppg * WEEKS, 1),
            'ppg': round(ppg, 2),
        })

    rows.sort(key=lambda r: -r['ppg'])
    doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        'note': (
            'Projected team-defense seasons as components: points allowed plus sacks, '
            'interceptions, fumble recoveries, defensive/special-teams touchdowns and '
            'safeties, so a league can re-score under its own points-allowed tiers and '
            'takeaway values. ppg/projPts roll these up at sack 1, INT 2, fumble recovery 2, '
            'def/ST TD 6, safety 2, plus the standard points-allowed bracket — with the '
            'bracket integrated over the per-game distribution rather than scored at the '
            'season mean. Each component is shrunk by its own measured reliability: points '
            'allowed yoy r=0.30, sacks 0.21, interceptions 0.11; rarer events are projected '
            'at the league rate for every team because no team signal survives. DST is the '
            'least forecastable fantasy position — the components, not the ordering, are '
            'the deliverable. In-season, points allowed, sacks and interceptions blend toward '
            'what this season has shown at n/(n+10.5) — 28% weight by week 4, 43% by week 8 — '
            'a curve fitted against rest-of-season outcomes. Worth knowing before you chase a '
            'hot defense: over 2017-2025 the current season ALONE predicted the rest of the '
            'season worse (RMSE 3.32) than the preseason prior alone (2.54); the blend beats '
            'both (2.33). Every row carries inSeasonWeeks and inSeasonWeight.'
        ),
        'method': {
            'history': [HISTORY[0], HISTORY[-1]],
            'keepPointsAllowed': KEEP_PA, 'keepSack': KEEP_SACK, 'keepInt': KEEP_INT,
            'backtest': {'seasons': [2023, 2024, 2025], 'metric': 'team DST pts/gm',
                         'rmse': 1.384, 'r': 0.25, 'flatLeagueMeanRmse': 1.375,
                         'verdict': 'does not beat a flat league mean on RMSE; '
                                    'modest ordering value only'},
            'paGameSd': PA_GAME_SD,
            'leaguePointsAllowedPerGame': round(league_pa, 2),
            'leagueSackPerGame': round(league_sack, 3),
            'leagueIntPerGame': round(league_int, 3),
            'leagueRareRates': league_rate,
            'scheduleAdjusted': bool(sched),
            'inSeasonK': IN_SEASON_K,
            'inSeasonFit': {
                'seasons': [2017, 2025], 'n': 3650,
                'metric': 'rest-of-season DST pts/gm',
                'rmse': 2.334, 'priorSeasonOnlyRmse': 2.538, 'currentSeasonOnlyRmse': 3.316,
                'note': ('Current-season form ALONE is a worse predictor of the rest of the '
                         'season than the preseason prior alone; the blend beats both. Weight '
                         'reaches 28% at four weeks, 43% at eight.'),
            },
        },
        'defenses': rows,
    }
    out = DATA / f'dst-projections-{SEASON}.json'
    out.write_text(json.dumps(doc, separators=(',', ':')) + '\n')
    print(f'Wrote {out} — {len(rows)} defenses')
    print(f'  league PA/gm {league_pa:.2f}, sacks/gm {league_sack:.2f}, INT/gm {league_int:.2f}')
    print(f'  schedule-adjusted: {bool(sched)}')
    print(f'  ppg range {rows[-1]["ppg"]:.2f} .. {rows[0]["ppg"]:.2f}')


if __name__ == '__main__':
    main()
