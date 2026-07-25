#!/usr/bin/env python3
"""Build per-week 2026 fantasy projections from the season projection pool.

Method (v1, deterministic + explainable):
  weekly_pts[player, w] = season_ppg * matchup_mult(team, pos, w)

  matchup_mult = defense-vs-position factor for that week's opponent
                 (2025 PPR points allowed per game to the position, as a
                 ratio to league average, shrunk toward 1.0 because
                 year-over-year defensive signal is weak)
               * home/away nudge
  … then normalized so each (team, pos) multiplier set averages 1.0 across
  the team's 17 scheduled games — weekly numbers always sum back to the
  season projection (ppg * 17), keeping season rankings authoritative.

Weekly points are "if he plays" per-game projections; the pool's projected
`games` (rest/injury discount) is carried through as `gp` for consumers that
want expected-value weeks instead.

Inputs (all committed):
  public/data/projection-base-<season>.json   season pool (stat lines + pprPts)
  public/data/schedule-<season>.json          nflverse schedule (opp/home/bye)
  public/data/player_stats_<season-1>.csv.gz  weekly actuals for def-vs-pos

Output:
  public/data/weekly-projections-<season>.json

Run: python3 scripts/build-weekly-projections.py
"""

import csv
import gzip
import json
import os
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')

SEASON = 2026
PRIOR = SEASON - 1
WEEKS = 18
POSITIONS = ('QB', 'RB', 'WR', 'TE')

# Defensive points-allowed signal barely persists season to season; keep only
# a shrunk fraction of the observed deviation and clamp the extremes.
DEF_SHRINK = 0.40
MULT_MIN, MULT_MAX = 0.82, 1.18
HOME_MULT, AWAY_MULT = 1.02, 0.98


def load_json(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def build_def_vs_pos():
    """2025 REG-season PPR points allowed per game by each defense to each
    position, shrunk toward league average → multiplier per (team, pos)."""
    pts = defaultdict(float)            # (def_team, pos) -> total PPR allowed
    games = defaultdict(set)            # def_team -> {game weeks}
    path = os.path.join(DATA, f'player_stats_{PRIOR}.csv.gz')
    with gzip.open(path, 'rt') as f:
        for row in csv.DictReader(f):
            if row.get('season_type') != 'REG':
                continue
            pos = row.get('position')
            opp = row.get('opponent_team')
            if pos not in POSITIONS or not opp:
                continue
            pts[(opp, pos)] += float(row.get('fantasy_points_ppr') or 0)
            games[opp].add(row.get('week'))

    per_game = {}
    for (team, pos), total in pts.items():
        n = len(games[team]) or 1
        per_game[(team, pos)] = total / n

    mults = {}
    for pos in POSITIONS:
        vals = [per_game[(t, pos)] for t in games if (t, pos) in per_game]
        avg = sum(vals) / len(vals)
        for t in games:
            ratio = per_game.get((t, pos), avg) / avg
            m = 1 + DEF_SHRINK * (ratio - 1)
            mults.setdefault(t, {})[pos] = round(max(MULT_MIN, min(MULT_MAX, m)), 3)
    return mults


def build_team_weeks(schedule):
    """team -> [ {w, opp, home} … ] for weeks 1..18 (bye weeks absent)."""
    by_team = defaultdict(dict)
    for g in schedule['games']:
        w = g['week']
        if not (1 <= w <= WEEKS):
            continue
        by_team[g['home']][w] = {'w': w, 'opp': g['away'], 'home': True}
        by_team[g['away']][w] = {'w': w, 'opp': g['home'], 'home': False}
    return {t: [wk[w] for w in sorted(wk)] for t, wk in by_team.items()}


def main():
    pool = load_json(f'projection-base-{SEASON}.json')
    schedule = load_json(f'schedule-{SEASON}.json')
    def_vs_pos = build_def_vs_pos()
    team_weeks = build_team_weeks(schedule)

    # Per (team, pos): raw multiplier per scheduled week, normalized to mean 1
    # so weekly projections always sum back to the season line.
    def week_mults(team, pos):
        sched = team_weeks.get(team, [])
        raw = [
            def_vs_pos.get(g['opp'], {}).get(pos, 1.0) * (HOME_MULT if g['home'] else AWAY_MULT)
            for g in sched
        ]
        mean = (sum(raw) / len(raw)) if raw else 1.0
        return {g['w']: r / mean for g, r in zip(sched, raw)}

    players = []
    for grp, pos in (('qbs', 'QB'), ('rbs', 'RB'), ('wrs', 'WR'), ('tes', 'TE')):
        for p in pool.get(grp, []):
            g = p.get('games') or 0
            ppr = p.get('pprPts') or 0
            if not p.get('team') or g <= 0 or ppr <= 0:
                continue
            ppg = ppr / g
            rec_pg = (p.get('rec') or 0) / g
            mults = week_mults(p['team'], pos)
            wk = [
                round(ppg * mults[w], 2) if w in mults else None
                for w in range(1, WEEKS + 1)
            ]
            players.append({
                'name': p['name'],
                'pos': pos,
                'team': p['team'],
                'gp': g,
                'ppg': round(ppg, 2),
                'recPG': round(rec_pg, 2),
                'wk': wk,
            })

    players.sort(key=lambda r: -r['ppg'])
    out = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'note': (
            f'Weekly per-game PPR projections: season ppg x opponent def-vs-pos '
            f'multiplier ({PRIOR} PPR allowed/gm vs league avg, shrunk {DEF_SHRINK:.0%}, '
            f'clamped [{MULT_MIN},{MULT_MAX}]) x home/away ({HOME_MULT}/{AWAY_MULT}), '
            f'normalized to mean 1.0 per team so weeks sum to the season line. '
            f'null = bye. Points assume the player plays; gp carries the season '
            f'games discount. Half/Std: pts - 0.5*rec or pts - rec, where weekly '
            f'rec scales with the same multiplier (rec_w = recPG * pts_w / ppg).'
        ),
        'weeks': WEEKS,
        'defVsPos': def_vs_pos,
        'teamWeeks': team_weeks,
        'players': players,
    }

    out_path = os.path.join(DATA, f'weekly-projections-{SEASON}.json')
    with open(out_path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    kb = os.path.getsize(out_path) / 1024
    n_byes = sum(1 for t, wks in team_weeks.items() if len(wks) != 17)
    print(f'Wrote {out_path} ({kb:.0f} KB): {len(players)} players, '
          f'{len(team_weeks)} teams ({n_byes} with !=17 games)')

    # Sanity: weekly sum == ppg * scheduled games for a few players
    for p in players[:3]:
        s = sum(v for v in p['wk'] if v is not None)
        sched_g = sum(1 for v in p['wk'] if v is not None)
        print(f"  {p['name']} ({p['team']} {p['pos']}): ppg {p['ppg']}, "
              f"sum {s:.1f} vs {p['ppg'] * sched_g:.1f} over {sched_g} games")


if __name__ == '__main__':
    main()
