#!/usr/bin/env python3
"""Project 2026 IDP seasons AS COMPONENTS — tackles, sacks, tackles for loss,
QB hits, passes defended, interceptions, forced fumbles, fumble recoveries,
defensive touchdowns and safeties — rather than as a single fantasy-point
scalar.

Why components: IDP scoring varies more between leagues than any offensive
position. Tackle value, solo/assist premiums, sack value, TFL, QB hits and
passes defended are all separately priced, and two leagues with the same roster
slots can disagree on a defender's value by 40%. A points number cannot be
re-priced; components can.

    python3 scripts/build-idp-projections.py [season]

Writes public/data/idp-projections-<season>.json.

WHAT THE DATA SUPPORTS, measured over nflverse 2016-2025 (3,687 player-seasons
with 8+ games and prior history) rather than assumed:

  * IDP is the MOST forecastable fantasy position group we carry, by a wide
    margin. Year-over-year per-game correlations: QB hits +0.82, sacks +0.74,
    solo tackles +0.73, assists +0.70, TFL +0.65, passes defended +0.69,
    interceptions +0.49, forced fumbles +0.27. For scale, team DST points
    per game manages +0.25 and kicker points per game +0.29.
  * So the shrinkage is light where the signal is strong and heavy where it is
    not. Each KEEP below is the value that minimises RMSE against the next
    season on that measurement set — not a guess. Against a flat positional
    mean the fitted keeps cut RMSE by 34% (QB hits), 25% (sacks), 22% (solo
    tackles), 21% (assists), 17% (TFL), 15% (passes defended) and 5%
    (interceptions).
  * Fumble recoveries (+0.08), defensive touchdowns (+0.09) and safeties
    (+0.01) carry no year-over-year signal at all, exactly as for team
    defenses. They are projected at the positional rate for everyone; a
    per-player number there would be noise wearing a name.
  * Availability is the weak link, not production: games played carries
    r = +0.45 and 88.7% of defenders with 8+ games appear again the next
    season. GAMES_KEEP and its shrink target are fitted on the population this
    file actually projects — players with prior history — at 0.58 toward 10.0.
  * Rookies have no history, so they are projected from the positional mean
    scaled by DRAFT PICK, measured over 991 rookie defenders: picks 1-10 land
    at 1.21x the veteran positional mean over 13.6 games, picks 11-32 at 0.97x
    over 12.7, picks 65-105 at 0.76x over 10.5, picks 161+ at 0.54x over 6.6.
    Round buckets were the first cut and tied a top-10 pick to a late first.

THRESHOLD BONUSES. Leagues commonly pay a bonus for 2+ sacks or 3+ passes
defended in a week. A season mean cannot be scored against a weekly threshold,
so this file publishes the integral AND the spread behind it (the same lesson
as the team-defense points-allowed bracket):

  * weeks_2plus_sack / weeks_3plus_pd — the expected NUMBER of games clearing
    the threshold, integrated over a per-game Poisson and calibrated against
    what actually happened.
  * Poisson overstates multi-sack games by a quarter (observed 1,269 vs 1,689
    expected over 2016-25, calibration 0.751) because sacks are credited in
    half increments; it is nearly exact for passes defended (0.962).
  * sack_game_sd / pd_game_sd / tackles_game_sd — per-game standard deviations
    for anyone integrating a different threshold. Measured dispersion
    (variance / mean): sacks 0.945, passes defended 1.061, tackles 1.210.

NOT modelled: schedule strength (the defense-vs-position table we publish is
about offenses facing defenses, not the reverse), snap-share projection for
role changes, and coverage-scheme effects. Team changes are carried implicitly
through a player's own history only.
"""
from __future__ import annotations

import csv
import gzip
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'public/data'

SEASON = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
HISTORY = list(range(SEASON - 10, SEASON))
HALF_LIFE = 2.0          # seasons; recency weight on a player's own history
LOOKBACK = 3             # seasons of history to blend
MIN_HIST_GAMES = 4       # a season below this tells you nothing about a rate
MIN_EVAL_GAMES = 8       # evaluation/backtest population

# Fitted per component: the weight on the player's own history, with the
# remainder going to the positional (DL/LB/DB) mean. Each is the RMSE-minimising
# value over 2019-2025, not an intuition. See the module docstring.
KEEP = {
    'solo': 0.68, 'assist': 0.76, 'tfl': 0.66, 'sack': 0.74, 'qb_hit': 0.82,
    'pd': 0.58, 'int': 0.38, 'ff': 0.30,
    # No year-over-year signal survives measurement — positional rate for all.
    'fum_rec': 0.08, 'def_td': 0.08, 'safety': 0.02,
}
GAMES_KEEP = 0.58        # fitted on players WITH history — the population projected here
GAMES_TARGET = 10.0      # ...and the shrink target that minimises RMSE with it
# Rookie seasons, by DRAFT PICK rather than round: production and availability
# both fall smoothly across the draft, and a round bucket ties a top-10 pick to
# a late first. Measured over 991 drafted defenders' rookie seasons, 2017-2025;
# each entry is (pick, IDP pts/gm as a fraction of the veteran positional mean,
# games played). Interpolated linearly, flat outside the ends.
ROOKIE_BY_PICK = ((5, 1.21, 13.6), (21, 0.97, 12.7), (48, 0.95, 11.8),
                  (85, 0.76, 10.5), (133, 0.69, 8.5), (230, 0.54, 6.6))
UNDRAFTED_FACTOR = 0.45  # below the last band; most never take a real role
UNDRAFTED_GAMES = 5.5

# Weekly threshold integration — Poisson, calibrated against observed rates.
SACK2_CALIBRATION = 0.751
PD3_CALIBRATION = 0.962
DISPERSION = {'sack': 0.945, 'pd': 1.061, 'tackles': 1.210}

# The consumer's DEFAULT IDP catalog, used only to roll the components up into
# a comparable ppg/projPts. Every league re-prices these; the components, not
# this number, are the deliverable.
POINTS = {'tackle': 1.0, 'sack': 2.0, 'int': 3.0, 'fum_rec': 2.0, 'def_td': 6.0, 'safety': 2.0}

COMPS = ('solo', 'assist', 'tfl', 'sack', 'qb_hit', 'pd', 'int', 'ff', 'fum_rec', 'def_td', 'safety')
SRC = {
    'solo': 'def_tackles_solo', 'assist': 'def_tackle_assists',
    'tfl': 'def_tackles_for_loss', 'sack': 'def_sacks', 'qb_hit': 'def_qb_hits',
    'pd': 'def_pass_defended', 'int': 'def_interceptions',
    'ff': 'def_fumbles_forced', 'fum_rec': 'fumble_recovery_opp',
    'def_td': 'def_tds', 'safety': 'def_safeties',
}
# nflverse position codes -> the DL/LB/DB buckets leagues actually roster.
BUCKET = {
    'DE': 'DL', 'DT': 'DL', 'NT': 'DL', 'DL': 'DL',
    'LB': 'LB', 'OLB': 'LB', 'ILB': 'LB', 'MLB': 'LB',
    'CB': 'DB', 'SAF': 'DB', 'FS': 'DB', 'SS': 'DB', 'DB': 'DB', 'S': 'DB',
}


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


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def num(row, key) -> float:
    try:
        return float(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def load_season(season: int):
    """gsis -> season totals, plus per-game sack/PD/tackle vectors."""
    agg: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    meta: dict[str, tuple] = {}
    weekly: dict[str, list] = defaultdict(list)
    seen_any = False
    for r in iter_csv(f'player_stats_{season}'):
        seen_any = True
        if r.get('season_type') != 'REG':
            continue
        bucket = BUCKET.get(r.get('position') or '')
        if not bucket:
            continue
        pid = r.get('player_id')
        if not pid:
            continue
        agg[pid]['games'] += 1
        for comp, src in SRC.items():
            agg[pid][comp] += num(r, src)
        weekly[pid].append((num(r, 'def_sacks'), num(r, 'def_pass_defended'),
                            num(r, 'def_tackles_solo') + num(r, 'def_tackle_assists')))
        meta[pid] = (r.get('player_display_name') or r.get('player_name'), bucket,
                     r.get('team'), r.get('position'))
    if not seen_any:
        return None
    return {'agg': agg, 'meta': meta, 'weekly': weekly}


def bucket_means(seasons: dict, upto: int) -> dict:
    """Per-game positional means from the most recent completed season with
    data. Only players with a real role (MIN_EVAL_GAMES) define the mean."""
    for year in range(upto - 1, upto - 4, -1):
        s = seasons.get(year)
        if not s:
            continue
        out = defaultdict(lambda: defaultdict(list))
        for pid, v in s['agg'].items():
            if v['games'] < MIN_EVAL_GAMES:
                continue
            for comp in COMPS:
                out[s['meta'][pid][1]][comp].append(v[comp] / v['games'])
        if out:
            return {b: {c: (sum(x) / len(x) if x else 0.0) for c, x in d.items()}
                    for b, d in out.items()}
    return {}


def history_pg(seasons: dict, pid: str, upto: int):
    """Recency-weighted per-game rates from a player's own last LOOKBACK
    seasons, weighted by games played so a 3-game cameo cannot outvote a full
    season. Returns None when there is nothing to learn from."""
    num_, den = defaultdict(float), 0.0
    games_num, games_den = 0.0, 0.0
    for year in range(upto - LOOKBACK, upto):
        s = seasons.get(year)
        if not s:
            continue
        v = s['agg'].get(pid)
        if not v:
            continue
        w_season = 0.5 ** ((upto - 1 - year) / HALF_LIFE)
        games_num += w_season * v['games']
        games_den += w_season
        if v['games'] < MIN_HIST_GAMES:
            continue
        w = w_season * v['games']
        den += w
        for comp in COMPS:
            num_[comp] += w * v[comp] / v['games']
    if not den:
        return None
    return ({c: num_[c] / den for c in COMPS},
            games_num / games_den if games_den else None)


def rookie_prior(pick: int | None):
    """(rate factor, games) for a rookie at this draft pick."""
    if pick is None:
        return UNDRAFTED_FACTOR, UNDRAFTED_GAMES
    lo = ROOKIE_BY_PICK[0]
    if pick <= lo[0]:
        return lo[1], lo[2]
    for a, b in zip(ROOKIE_BY_PICK, ROOKIE_BY_PICK[1:]):
        if pick <= b[0]:
            t = (pick - a[0]) / (b[0] - a[0])
            return a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])
    hi = ROOKIE_BY_PICK[-1]
    return hi[1], hi[2]


def poisson_at_least(lam: float, k: int) -> float:
    if lam <= 0:
        return 0.0
    below = sum(math.exp(-lam) * lam ** i / math.factorial(i) for i in range(k))
    return max(0.0, 1.0 - below)


def project_player(hist, bucket_mean: dict, pick: int | None,
                   hist_games: float | None) -> dict:
    """Per-game component rates + projected games for one player."""
    if hist is None:
        # No NFL history: the positional mean scaled by what rookies drafted at
        # that pick actually did in their first season.
        factor, games = rookie_prior(pick)
        rates = {c: bucket_mean.get(c, 0.0) * factor for c in COMPS}
    else:
        rates = {c: KEEP[c] * hist[c] + (1 - KEEP[c]) * bucket_mean.get(c, 0.0)
                 for c in COMPS}
        games = (GAMES_KEEP * hist_games + (1 - GAMES_KEEP) * GAMES_TARGET
                 if hist_games is not None else GAMES_TARGET)
    return {'rates': rates, 'games': max(1.0, min(17.0, games))}


def score(rates: dict, games: float) -> float:
    per_game = (POINTS['tackle'] * (rates['solo'] + rates['assist'])
                + POINTS['sack'] * rates['sack']
                + POINTS['int'] * rates['int']
                + POINTS['fum_rec'] * rates['fum_rec']
                + POINTS['def_td'] * rates['def_td']
                + POINTS['safety'] * rates['safety'])
    return per_game * games


def backtest(seasons: dict, years: list[int]) -> dict:
    """Same model, run on completed seasons: does it beat a flat positional
    mean at projecting IDP points per game? Reported honestly either way."""
    errs, flat_errs, xs, ys = [], [], [], []
    for year in years:
        s = seasons.get(year)
        if not s:
            continue
        means = bucket_means(seasons, year)
        if not means:
            continue
        league_games = league_mean_games(seasons, year)
        for pid, actual in s['agg'].items():
            if actual['games'] < MIN_EVAL_GAMES:
                continue
            hist = history_pg(seasons, pid, year)
            if hist is None:                       # rookies: no history to test
                continue
            bucket = s['meta'][pid][1]
            proj = project_player(hist[0], means.get(bucket, {}), None, hist[1])
            actual_pg = score({c: actual[c] / actual['games'] for c in COMPS}, 1.0)
            pred_pg = score(proj['rates'], 1.0)
            flat_pg = score(means.get(bucket, {}), 1.0)
            errs.append((pred_pg - actual_pg) ** 2)
            flat_errs.append((flat_pg - actual_pg) ** 2)
            xs.append(pred_pg)
            ys.append(actual_pg)
    if not errs:
        return {}
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    r = (sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)) if sx and sy else 0.0
    return {
        'seasons': [years[0], years[-1]],
        'metric': 'IDP pts/gm under the default catalog',
        'n': n,
        'rmse': round(math.sqrt(sum(errs) / n), 3),
        'r': round(r, 3),
        'flatPositionalMeanRmse': round(math.sqrt(sum(flat_errs) / n), 3),
    }


def league_mean_games(seasons: dict, upto: int) -> float:
    """Mean games played by defenders in the most recent completed season.
    Deliberately the whole population, not just starters: it is the shrink
    target for availability, and injuries and lost roles are part of it."""
    for year in range(upto - 1, upto - 4, -1):
        s = seasons.get(year)
        if not s:
            continue
        vals = [v['games'] for v in s['agg'].values()]
        if vals:
            return sum(vals) / len(vals)
    return 10.5


def main() -> None:
    seasons = {}
    for year in HISTORY:
        s = load_season(year)
        if s:
            seasons[year] = s
    if not seasons:
        raise SystemExit('no player_stats history found — cannot project IDP')
    latest = max(seasons)
    print(f'  history: {min(seasons)}-{latest} '
          f'({sum(len(s["agg"]) for s in seasons.values())} defensive player-seasons)')

    means = bucket_means(seasons, SEASON)
    league_games = league_mean_games(seasons, SEASON)

    # Draft pick, for the rookie prior. Matched on gsis where the pick has one
    # (230 of 257 in 2026) and on name otherwise — a just-drafted rookie often
    # has no gsis id yet.
    draft_pick, draft_pick_by_name = {}, {}
    for r in iter_csv('draft_picks'):
        if r.get('season') != str(SEASON):
            continue
        try:
            pick = int(r.get('pick') or 300)
        except ValueError:
            pick = 300
        if r.get('gsis_id'):
            draft_pick[r['gsis_id']] = pick
        name = (r.get('pfr_player_name') or '').strip().lower()
        if name:
            draft_pick_by_name[name] = pick

    sleeper_by_gsis = {}
    for p in load_json(DATA / 'player-id-map.json', {}).get('players', []):
        if p.get('gsis'):
            sleeper_by_gsis[p['gsis']] = p.get('sleeper')

    rows = []
    skipped = 0
    for r in iter_csv(f'roster_{SEASON}'):
        if (r.get('status') or 'ACT') not in ('ACT', 'RES'):
            continue
        bucket = BUCKET.get(r.get('position') or '')
        if not bucket:
            continue
        gsis = r.get('gsis_id') or ''
        name = r.get('full_name') or r.get('football_name') or ''
        hist = history_pg(seasons, gsis, SEASON) if gsis else None
        pick = draft_pick.get(gsis) or draft_pick_by_name.get(name.strip().lower())
        if hist is None and pick is None:
            # No NFL history and not a 2026 draft pick: a camp body. Projecting
            # one would be inventing a number, so it is left out and counted.
            skipped += 1
            continue
        bucket_mean = means.get(bucket, {})
        proj = project_player(hist[0] if hist else None, bucket_mean, pick,
                              hist[1] if hist else None)
        rates, games = proj['rates'], proj['games']

        row = {
            'name': name, 'team': r.get('team'), 'pos': bucket,
            'nfl_pos': r.get('depth_chart_position') or r.get('position'),
            'gsis': gsis or None, 'sleeper': sleeper_by_gsis.get(gsis),
            'games': round(games, 1),
            'rookie': hist is None,
            'draft_pick': pick if hist is None else None,
        }
        for comp in COMPS:
            key = {'int': 'def_int', 'def_td': 'def_td'}.get(comp, comp)
            row[key] = round(rates[comp] * games, 1)
        row['tackles'] = round((rates['solo'] + rates['assist']) * games, 1)

        # Threshold bonuses: the integral AND the spread behind it.
        sack_lam, pd_lam = rates['sack'], rates['pd']
        tackle_lam = rates['solo'] + rates['assist']
        row['sack_pg'] = round(sack_lam, 3)
        row['pd_pg'] = round(pd_lam, 3)
        row['sack_game_sd'] = round(math.sqrt(DISPERSION['sack'] * sack_lam), 3)
        row['pd_game_sd'] = round(math.sqrt(DISPERSION['pd'] * pd_lam), 3)
        row['tackles_game_sd'] = round(math.sqrt(DISPERSION['tackles'] * tackle_lam), 3)
        row['weeks_2plus_sack'] = round(games * SACK2_CALIBRATION * poisson_at_least(sack_lam, 2), 2)
        row['weeks_3plus_pd'] = round(games * PD3_CALIBRATION * poisson_at_least(pd_lam, 3), 2)

        row['projPts'] = round(score(rates, games), 1)
        row['ppg'] = round(score(rates, 1.0), 2)
        rows.append(row)

    rows.sort(key=lambda x: -x['projPts'])
    bt = backtest(seasons, [y for y in (latest - 2, latest - 1, latest) if y in seasons])
    if bt:
        verdict = ('beats a flat positional mean by '
                   f'{100 * (1 - bt["rmse"] / bt["flatPositionalMeanRmse"]):.0f}% on RMSE'
                   if bt['rmse'] < bt['flatPositionalMeanRmse']
                   else 'does NOT beat a flat positional mean on RMSE')
        bt['verdict'] = verdict
        print(f'  backtest {bt["seasons"]}: RMSE {bt["rmse"]} vs flat {bt["flatPositionalMeanRmse"]}, '
              f'r={bt["r"]} (n={bt["n"]}) — {verdict}')

    doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'note': (
            'Projected individual defensive player (IDP) seasons as components: solo and assisted '
            'tackles, tackles for loss, sacks, QB hits, passes defended, interceptions, forced '
            'fumbles, fumble recoveries, defensive touchdowns and safeties, so a league can re-score '
            'under its own catalog instead of inheriting one. ppg/projPts roll them up at tackle 1, '
            'sack 2, interception 3, fumble recovery 2, defensive TD 6, safety 2 — the common default '
            'set, and only a convenience: re-price from the components. Each component is shrunk by '
            'its own measured year-over-year reliability, which for IDP is high: QB hits r=0.82, '
            'sacks 0.74, solo tackles 0.73, assists 0.70, passes defended 0.69, TFL 0.65, '
            'interceptions 0.49. Fumble recoveries, defensive TDs and safeties carry no signal and are '
            'projected at the positional rate for everyone. Rookies come from the positional mean '
            'scaled by draft round. Weekly threshold bonuses (2+ sacks, 3+ passes defended) are '
            'published as expected game counts plus the per-game standard deviations behind them — '
            'do not score a season mean against a weekly threshold.'
        ),
        'method': {
            'history': [min(seasons), latest],
            'keep': KEEP,
            'gamesKeep': GAMES_KEEP,
            'halfLifeSeasons': HALF_LIFE,
            'lookbackSeasons': LOOKBACK,
            'rookieByPick': [{'pick': p, 'rateFactor': f, 'games': g} for p, f, g in ROOKIE_BY_PICK],
            'undraftedFactor': UNDRAFTED_FACTOR,
            'gamesTarget': GAMES_TARGET,
            'leagueMeanGames': round(league_games, 2),
            'positionalMeansPerGame': {b: {c: round(v, 3) for c, v in d.items()}
                                       for b, d in means.items()},
            'thresholds': {
                'sack2PoissonCalibration': SACK2_CALIBRATION,
                'pd3PoissonCalibration': PD3_CALIBRATION,
                'dispersionVarianceOverMean': DISPERSION,
                'note': ('Poisson overstates multi-sack games by a quarter because sacks are '
                         'credited in half increments; it is nearly exact for passes defended. '
                         'Integrate any other threshold over a per-game Poisson with the published '
                         'sd, then apply the matching calibration.'),
            },
            'defaultScoring': POINTS,
            'backtest': bt,
            'scheduleAdjusted': False,
            'excludedNoHistoryOrDraft': skipped,
        },
        'players': rows,
    }
    out = DATA / f'idp-projections-{SEASON}.json'
    out.write_text(json.dumps(doc) + '\n')
    print(f'  Wrote {out} — {len(rows)} defenders '
          f'({sum(1 for r in rows if r["rookie"])} rookies, {skipped} camp bodies excluded)')
    for r in rows[:5]:
        print(f'    {r["name"]:24s} {r["pos"]} {r["team"]:3s} {r["games"]:4.1f}g '
              f'tkl {r["tackles"]:5.1f} sk {r["sack"]:4.1f} pd {r["pd"]:4.1f} '
              f'int {r["def_int"]:3.1f} -> {r["projPts"]:5.1f} pts')


if __name__ == '__main__':
    main()
