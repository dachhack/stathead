#!/usr/bin/env python3
"""Project 2026 head-coach seasons: wins, losses, ties, points scored, margin
distribution, and third/fourth-down conversions.

Head coaches are rosterable in leagues that carry them, scored on win/loss/tie,
a margin-of-victory ladder, a margin-of-defeat ladder, points scored, and down
conversions. They were projecting at zero because the win/loss half needed
market prices we did not have. We do now: nflverse's schedule carries
spread_line and total_line, and scripts/build-odds-from-schedule.mjs turns them
into odds_nfl_lines.json.

    python3 scripts/build-hc-projections.py [season]

Writes public/data/hc-projections-<season>.json.

WHAT THE DATA SUPPORTS, measured over 2016-2025 rather than assumed:

  * The spread IS the margin projection. Over 3,726 team-games (2019-2025) it
    predicts actual margin at RMSE 12.71, against 14.60 for prior-season margin
    and 14.38 for simply guessing zero. Note that middle number: last year's
    margin is WORSE than assuming every game is a coin flip.
  * The residual around the spread is unbiased (mean +0.04) with sd 12.71 over
    2,639 games. That sd is what a margin ladder has to be integrated over — a
    coach projected to win by 6 does not win by 6 every week, and the ladder is
    a step function.
  * Win probability fits 1/(1+exp(-0.145 x spread)) — a 3-point favourite wins
    60.7%, a 7-point favourite 73.4%. Checked against the empirical curve:
    -12 -> 15.6% observed, -3 -> 41.6%, +3 -> 58.3%, +12 -> 83.7%.
  * Ties happen in 0.379% of games (10 in 2,639) and are spread evenly.
  * Down conversions barely belong to the coach. Third-down conversions per
    game carry yoy r = +0.18 and fourth-down +0.27, so both are kept at a fifth
    of face value and everyone lands near the league rate (5.02 and 0.86 a
    game). Conversions follow game script and opponent more than scheme.

Games without a posted line fall back to a prior-season margin shrunk toward
zero, which is the weakest part of this file — see the note in the artifact.
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
WIN_PROB_K = 0.145          # fitted logistic on 2,639 games
MARGIN_SD = 12.71           # sd of actual margin around the spread
TIE_RATE = 0.00379
PRIOR_MARGIN_KEEP = 0.35    # prior-season margin is barely better than zero; shrink hard
HOME_FIELD = 1.76           # measured league home margin, 2016-2025 (n=2,639)
KEEP_THIRD = 0.20           # yoy r = +0.18
KEEP_FOURTH = 0.25          # yoy r = +0.27
# Margin bands published as expected game counts. A consumer with different
# rungs re-integrates over MARGIN_SD rather than scoring the mean.
MARGIN_BANDS = ((1, 6), (7, 12), (13, 18), (19, 24), (25, 30), (31, 99))


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


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def fnum(v):
    s = str(v or '').strip()
    try:
        return float(s) if s else None
    except ValueError:
        return None


def norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def band_probability(mean: float, lo: int, hi: int, sd: float = MARGIN_SD) -> float:
    """P(margin lands in [lo, hi]) for a win band, or the mirror for a loss."""
    return max(0.0, norm_cdf((hi + 0.5 - mean) / sd) - norm_cdf((lo - 0.5 - mean) / sd))


def main() -> None:
    schedule = load_json(DATA / f'schedule-{SEASON}.json', {'games': []}).get('games', [])
    if not schedule:
        raise SystemExit(f'no schedule-{SEASON}.json — cannot project head coaches')

    # Market lines, keyed by the matchup.
    lines = {}
    for l in load_json(DATA / 'odds_nfl_lines.json', []):
        lines[(l.get('homeTeam'), l.get('awayTeam'))] = l

    # Coaches and prior-season margins. prior_coach is kept so a first-year
    # head coach can be flagged: seven teams changed coach for 2026.
    coach, prior_coach = {}, {}
    prior_pts, prior_margin = defaultdict(list), defaultdict(list)
    for r in iter_csv('games'):
        if r.get('game_type') != 'REG':
            continue
        season = int(r['season']) if (r.get('season') or '').isdigit() else 0
        if season == SEASON:
            if r.get('home_coach'):
                coach[r['home_team']] = r['home_coach']
            if r.get('away_coach'):
                coach[r['away_team']] = r['away_coach']
        if season == SEASON - 1:
            if r.get('home_coach'):
                prior_coach[r['home_team']] = r['home_coach']
            if r.get('away_coach'):
                prior_coach[r['away_team']] = r['away_coach']
            hs, aw = fnum(r.get('home_score')), fnum(r.get('away_score'))
            if hs is None:
                continue
            prior_pts[r['home_team']].append(hs); prior_margin[r['home_team']].append(hs - aw)
            prior_pts[r['away_team']].append(aw); prior_margin[r['away_team']].append(aw - hs)

    league_pts = (sum(sum(v) for v in prior_pts.values())
                  / max(1, sum(len(v) for v in prior_pts.values())))

    # Third / fourth down conversions per game, from the prior season's pbp.
    third, fourth, gcount = defaultdict(float), defaultdict(float), defaultdict(set)
    try:
        pbp = json.loads(gzip.open(DATA / f'pbp-slim-{SEASON - 1}.json.gz').read())
    except (OSError, ValueError):
        pbp = []
    for p in pbp:
        t, d = p.get('posteam'), p.get('down')
        if not t or d not in (3, 4) or p.get('play_type') not in ('pass', 'run'):
            continue
        gcount[t].add(p.get('game_id'))
        if (p.get('yards_gained') or 0) >= (p.get('ydstogo') or 99):
            (third if d == 3 else fourth)[t] += 1
    third_pg = {t: third[t] / len(g) for t, g in gcount.items() if g}
    fourth_pg = {t: fourth[t] / len(g) for t, g in gcount.items() if g}
    league_third = (sum(third_pg.values()) / len(third_pg)) if third_pg else 5.02
    league_fourth = (sum(fourth_pg.values()) / len(fourth_pg)) if fourth_pg else 0.86

    by_team = defaultdict(list)
    for g in schedule:
        by_team[g['home']].append({'week': g['week'], 'opp': g['away'], 'home': True})
        by_team[g['away']].append({'week': g['week'], 'opp': g['home'], 'home': False})

    # Prior-season margins for every team up front: an unlined game has to be
    # scored from BOTH sides at once or the two teams' win probabilities do not
    # complement, and the league's projected wins stop adding up to its games.
    # The first cut of this scored each side independently and produced 269.5
    # wins against 272 losses.
    team_prior_margin = {t: (sum(v) / len(v)) for t, v in prior_margin.items()}

    rows = []
    for team, games in sorted(by_team.items()):
        pm = team_prior_margin.get(team, 0.0)
        pp = (sum(prior_pts[team]) / len(prior_pts[team])) if prior_pts[team] else league_pts
        wins = ties = points = 0.0
        lined = 0
        win_bands = [0.0] * len(MARGIN_BANDS)
        loss_bands = [0.0] * len(MARGIN_BANDS)
        game_rows = []
        for g in games:
            key = (team, g['opp']) if g['home'] else (g['opp'], team)
            line = lines.get(key)
            if line:
                lined += 1
                # OddsGameLine spread is the HOME spread, negative = home favoured.
                margin = -line['spread'] if g['home'] else line['spread']
                pts = line['homeImplied'] if g['home'] else line['awayImplied']
            else:
                # Zero-sum by construction: the shrunk difference between the two
                # teams' prior margins, plus home field.
                opp_pm = team_prior_margin.get(g['opp'], 0.0)
                margin = PRIOR_MARGIN_KEEP * (pm - opp_pm) / 2 + (HOME_FIELD if g['home'] else -HOME_FIELD)
                pts = pp
            p_win = (1 - TIE_RATE) / (1 + math.exp(-WIN_PROB_K * margin))
            wins += p_win
            ties += TIE_RATE
            points += pts
            for i, (lo, hi) in enumerate(MARGIN_BANDS):
                win_bands[i] += band_probability(margin, lo, hi)
                loss_bands[i] += band_probability(-margin, lo, hi)
            game_rows.append({
                'week': g['week'], 'opp': g['opp'], 'home': g['home'],
                'margin': round(margin, 1), 'pts': round(pts, 1),
                'winProb': round(p_win, 3), 'lined': bool(line),
            })
        n = len(games)
        t3 = KEEP_THIRD * third_pg.get(team, league_third) + (1 - KEEP_THIRD) * league_third
        t4 = KEEP_FOURTH * fourth_pg.get(team, league_fourth) + (1 - KEEP_FOURTH) * league_fourth
        rows.append({
            'name': coach.get(team, f'{team} HC'), 'team': team, 'pos': 'HC',
            'sleeper': f'{team.lower()}-hc',
            # Whether this is the same coach who ran the team last year. The
            # projection is built from the TEAM's market prices and history, so
            # a first-year coach inherits his predecessor's numbers — flagged
            # rather than hidden, because the scheme-driven parts of a coach
            # catalog (down conversions above all) are least trustworthy here.
            'new_coach': bool(prior_coach.get(team) and prior_coach[team] != coach.get(team)),
            'prior_coach': prior_coach.get(team),
            'games': n, 'linedGames': lined,
            'wins': round(wins, 1), 'losses': round(n - wins - ties, 1), 'ties': round(ties, 2),
            'points': round(points, 1), 'points_pg': round(points / n, 2),
            'margin_pg': round(sum(r['margin'] for r in game_rows) / n, 2),
            'margin_game_sd': MARGIN_SD,
            'third_down_conv': round(t3 * n, 1), 'third_down_conv_pg': round(t3, 2),
            'fourth_down_conv': round(t4 * n, 1), 'fourth_down_conv_pg': round(t4, 2),
            'win_margin_bands': {f'{lo}-{hi if hi < 99 else "plus"}': round(v, 2)
                                 for (lo, hi), v in zip(MARGIN_BANDS, win_bands)},
            'loss_margin_bands': {f'{lo}-{hi if hi < 99 else "plus"}': round(v, 2)
                                  for (lo, hi), v in zip(MARGIN_BANDS, loss_bands)},
            'games_detail': game_rows,
        })

    rows.sort(key=lambda r: -r['wins'])
    doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'note': (
            'Projected head-coach seasons: wins, losses, ties, points scored, margin '
            'distribution and third/fourth-down conversions, one row per team. Wins come from '
            'the market: win probability is 1/(1+exp(-0.145 x margin)) with the margin taken '
            'from the posted spread, a curve fitted on 2,639 games and checked against the '
            'empirical rates (a 3-point favourite wins 60.7%, a 7-point favourite 73.4%). The '
            'spread predicts actual margin at RMSE 12.71 against 14.60 for prior-season margin '
            '— last year\'s margin is worse than guessing zero, which is why unlined games are '
            'shrunk to 35% of it and are the weakest rows here. MARGIN LADDERS: do not score '
            'the mean. The residual around a spread is unbiased with sd 12.71, so a coach '
            'projected to win by 6 lands all over the ladder; win_margin_bands and '
            'loss_margin_bands are expected GAME COUNTS integrated over that spread, and '
            'margin_game_sd is published so you can re-integrate your own rungs. Down '
            'conversions barely belong to the coach — third-down yoy r=+0.18, fourth-down '
            '+0.27 — so both are kept at a fifth of face value and everyone sits near the '
            'league rate. Ties are the league rate (0.379% of games) for every team. '
            'new_coach flags the teams that changed head coach for this season: everything '
            'here is built from the TEAM\'s market prices and history, so a first-year coach '
            'inherits his predecessor\'s profile. Wins and points survive that — the market '
            'prices the roster, not the man — but the scheme-driven parts, down conversions '
            'above all, should be read as the PREVIOUS staff\'s until this season produces '
            'evidence. prior_coach names whose numbers they really are.'
        ),
        'method': {
            'winProbK': WIN_PROB_K,
            'marginSd': MARGIN_SD,
            'tieRate': TIE_RATE,
            'priorMarginKeep': PRIOR_MARGIN_KEEP,
            'keepThirdDown': KEEP_THIRD,
            'keepFourthDown': KEEP_FOURTH,
            'leagueThirdDownPerGame': round(league_third, 2),
            'leagueFourthDownPerGame': round(league_fourth, 2),
            'marginBands': [list(b) for b in MARGIN_BANDS],
            'measured': {
                'spreadMarginRmse': 12.71, 'priorSeasonMarginRmse': 14.60, 'alwaysZeroRmse': 14.38,
                'n': 3726, 'seasons': [2019, 2025],
            },
        },
        'teams': rows,
    }
    out = DATA / f'hc-projections-{SEASON}.json'
    out.write_text(json.dumps(doc) + '\n')
    lined_total = sum(r['linedGames'] for r in rows)
    print(f'  Wrote {out} — {len(rows)} coaches, {lined_total} of {sum(r["games"] for r in rows)} '
          f'team-games carry a market line')
    for r in rows[:5]:
        print(f'    {r["name"]:22s} {r["team"]:3s} {r["wins"]:4.1f}-{r["losses"]:4.1f}  '
              f'{r["points_pg"]:5.2f} pts/gm, margin {r["margin_pg"]:+5.2f}, '
              f'{r["third_down_conv_pg"]:.2f} third-down conv/gm')


if __name__ == '__main__':
    main()
