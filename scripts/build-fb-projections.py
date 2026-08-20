#!/usr/bin/env python3
"""Project 2026 fullback seasons as a rushing/receiving stat line.

Fullbacks are rosterable in leagues that carry them, and they were projecting at
exactly zero because nothing produced a line for them. They are not in the
season pool: nflverse's 2026 roster files label them position=RB with
depth_chart_position=FB, they are absent from the depth-order model entirely,
and the pool keeps only four running backs a team — so a fullback is squeezed
out before he is ever considered. Rather than reshape a shared builder for
sixteen players, this follows the kicker / team-defense / IDP pattern and
publishes its own small artifact.

    python3 scripts/build-fb-projections.py [season]

Writes public/data/fb-projections-<season>.json.

WHAT THE DATA SUPPORTS, measured over nflverse 2016-2025:

  * The position is disappearing: 22 fullbacks recorded a snap in 2016, 6 in
    2025, and the whole position scored 153 PPR points last year. The best one
    in any recent season lands between 40 and 82 points. Set expectations
    accordingly — this exists so a roster slot is not blank, not because there
    is fantasy value hiding here.
  * What production there is persists: PPR per game correlates +0.68 year over
    year (n=74), and keeping 65% of a fullback's own rate against the
    positional mean scores RMSE 0.95 versus 1.30 for the mean alone — a 27%
    improvement, which is better than the kicker model manages.
  * The positional mean is 1.83 PPR points per game.

In-season the line blends toward what the player is actually doing on the
running back curve (K=3.5), borrowed rather than fitted: there are not enough
fullback-weeks to fit one honestly, and their usage is running-back usage.
"""
from __future__ import annotations

import csv
import gzip
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'public/data'

SEASON = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
HISTORY = list(range(SEASON - 5, SEASON))
KEEP = 0.65                    # fitted: own rate vs the positional mean
HALF_LIFE = 2.0
MIN_HIST_GAMES = 4
IN_SEASON_K = 3.5              # borrowed from RB — fullback usage is RB usage
AVAILABILITY_PSEUDO_COUNT = 5.5
WEEKS = 17

FIELDS = {
    'car': 'carries', 'ry': 'rushing_yards', 'rtd': 'rushing_tds',
    'tgt': 'targets', 'rec': 'receptions', 'recy': 'receiving_yards',
    'rectd': 'receiving_tds',
}


# nflverse's roster files say AZ where its schedule says ARI — the same
# franchise under two codes in one feed. Left alone it is not cosmetic: the
# weekly builder keys matchups on the SCHEDULE's code, so every Arizona player
# sourced from the roster got an all-null weekly strip (34 defenders, silently
# projecting nothing every week). Normalize on the way in.
TEAM_ALIASES = {'AZ': 'ARI', 'LAR': 'LA', 'OAK': 'LV', 'SD': 'LAC', 'STL': 'LA'}


def norm_team(team: str) -> str:
    return TEAM_ALIASES.get((team or '').upper(), (team or '').upper()) or None


def iter_csv(name: str):
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


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def season_lines(season: int):
    """gsis -> {games, per-game components} for players the stats table labels
    FB, plus the weeks elapsed (for the in-season blend)."""
    agg = defaultdict(lambda: defaultdict(float))
    weeks = defaultdict(set)
    elapsed = 0
    for r in iter_csv(f'player_stats_{season}'):
        if r.get('season_type') != 'REG' or r.get('position') != 'FB':
            continue
        pid = r.get('player_id')
        try:
            week = int(r['week'])
        except (ValueError, TypeError, KeyError):
            continue
        if not pid:
            continue
        elapsed = max(elapsed, week)
        weeks[pid].add(week)
        for key, src in FIELDS.items():
            agg[pid][key] += num(r, src)
    out = {}
    for pid, wk in weeks.items():
        n = len(wk)
        out[pid] = {'games': n, **{k: agg[pid][k] / n for k in FIELDS}}
    return out, elapsed


def ppr(line: dict) -> float:
    return (0.1 * line['ry'] + 6 * line['rtd']
            + line['rec'] + 0.1 * line['recy'] + 6 * line['rectd'])


def main() -> None:
    history = {}
    for year in HISTORY:
        rows, _ = season_lines(year)
        if rows:
            history[year] = rows
    if not history:
        raise SystemExit('no fullback history found — cannot project')
    latest = max(history)

    # Positional mean per game, from the most recent season with a real sample.
    pool = [v for v in history[latest].values() if v['games'] >= 6]
    if not pool:
        pool = list(history[latest].values())
    mean = {k: sum(v[k] for v in pool) / len(pool) for k in FIELDS}
    mean_games = sum(v['games'] for v in pool) / len(pool)

    live, weeks_elapsed = season_lines(SEASON)
    if live:
        print(f'  in-season: {weeks_elapsed} week(s) elapsed, {len(live)} fullbacks with {SEASON} games')

    sleeper = {}
    for p in load_json(DATA / 'player-id-map.json', {}).get('players', []):
        if p.get('gsis'):
            sleeper[p['gsis']] = p.get('sleeper')

    rows = []
    for r in iter_csv(f'roster_{SEASON}'):
        if (r.get('depth_chart_position') or '').upper() != 'FB':
            continue
        if (r.get('status') or 'ACT') not in ('ACT', 'RES'):
            continue
        gsis = r.get('gsis_id') or ''
        # Recency-weighted own rate, weighted by games so a cameo cannot outvote
        # a season.
        num_, den, games_num, games_den = defaultdict(float), 0.0, 0.0, 0.0
        for year, rowsy in history.items():
            v = rowsy.get(gsis)
            if not v:
                continue
            w_season = 0.5 ** ((latest - year) / HALF_LIFE)
            games_num += w_season * v['games']; games_den += w_season
            if v['games'] < MIN_HIST_GAMES:
                continue
            w = w_season * v['games']
            den += w
            for k in FIELDS:
                num_[k] += w * v[k]
        if den:
            rates = {k: KEEP * (num_[k] / den) + (1 - KEEP) * mean[k] for k in FIELDS}
            games = min(float(WEEKS), games_num / games_den if games_den else mean_games)
        else:
            # No usable history: the positional mean, discounted — a fullback
            # with no NFL record is not the average starting fullback.
            rates = {k: mean[k] * 0.5 for k in FIELDS}
            games = mean_games * 0.7

        n_live = 0
        if gsis in live:
            v = live[gsis]
            n_live = v['games']
            w_live = n_live / (n_live + IN_SEASON_K)
            rates = {k: (1 - w_live) * rates[k] + w_live * v[k] for k in FIELDS}
            prior_rate = min(1.0, games / WEEKS)
            rate = ((n_live + AVAILABILITY_PSEUDO_COUNT * prior_rate)
                    / (weeks_elapsed + AVAILABILITY_PSEUDO_COUNT)) if weeks_elapsed else prior_rate
            games = min(float(WEEKS), n_live + max(0, WEEKS - weeks_elapsed) * rate)

        line = {k: rates[k] * games for k in FIELDS}
        rows.append({
            'name': r.get('full_name'), 'team': norm_team(r.get('team')), 'pos': 'FB',
            'gsis': gsis or None, 'sleeper': sleeper.get(gsis),
            'games': round(games, 1),
            'rush_att': round(line['car'], 1), 'rush_yd': round(line['ry'], 1),
            'rush_td': round(line['rtd'], 2),
            'tgt': round(line['tgt'], 1), 'rec': round(line['rec'], 1),
            'rec_yd': round(line['recy'], 1), 'rec_td': round(line['rectd'], 2),
            'inSeasonGames': n_live,
            'inSeasonWeight': round(n_live / (n_live + IN_SEASON_K), 3) if n_live else 0,
            'projPts': round(ppr(line), 1),
            'ppg': round(ppr(rates), 2),
        })

    rows.sort(key=lambda r: -r['projPts'])
    doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'note': (
            'Projected fullback seasons as a rushing/receiving stat line, so a league that '
            'rosters the position scores them with the same branch it uses for running backs. '
            'Set expectations: the position is disappearing — 22 fullbacks recorded a snap in '
            '2016 against 6 in 2025, and the whole position scored 153 PPR points last season, '
            'with the best individual season in recent years landing between 40 and 82. What '
            'production exists does persist (PPR/gm yoy r=+0.68), so a fullback keeps 65% of '
            'his own rate against a positional mean of 1.83 points per game — 27% better than '
            'the mean alone. This exists so the roster slot is not blank, not because there is '
            'value hiding here.'
        ),
        'method': {
            'history': [min(history), latest],
            'keep': KEEP,
            'halfLifeSeasons': HALF_LIFE,
            'positionalMeanPerGame': {k: round(v, 3) for k, v in mean.items()},
            'positionalMeanPPRPerGame': round(ppr(mean), 2),
            'inSeasonK': IN_SEASON_K,
            'inSeasonKBorrowedFrom': 'RB (too few fullback-weeks to fit one honestly)',
            'availabilityPseudoCount': AVAILABILITY_PSEUDO_COUNT,
            'measured': {'pprPerGameYoyR': 0.68, 'n': 74, 'rmse': 0.95, 'flatMeanRmse': 1.30},
        },
        'players': rows,
    }
    out = DATA / f'fb-projections-{SEASON}.json'
    out.write_text(json.dumps(doc) + '\n')
    print(f'  Wrote {out} — {len(rows)} fullbacks')
    for r in rows[:5]:
        print(f'    {r["name"]:22s} {r["team"]:3s} {r["games"]:4.1f}g  '
              f'{r["rush_att"]:4.1f} car / {r["rec"]:4.1f} rec -> {r["projPts"]:5.1f} pts ({r["ppg"]} ppg)')


if __name__ == '__main__':
    main()
