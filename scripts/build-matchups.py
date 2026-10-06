#!/usr/bin/env python3
"""Build the weekly strength-of-matchup file: fantasy points each defense
allows per game to QB / RB / WR / TE this season, ranked, and laid over every
team's schedule so each upcoming week's opponent can be read as a matchup.

Why this exists next to schedule-strength-<season>.json: that file publishes
the StatHead *model* multiplier, which blends the prior season in and shrinks
toward 1 because defensive points-allowed is a weak year-to-year signal. It
is the right number to move a projection by. It is NOT the right number for
the question "is this the defense that gives up the most to tight ends", so
this file carries the raw season-to-date ledger (PPR points and receptions
allowed per game, so any scoring can be derived exactly) alongside the model
factor, and ranks both.

Every number here is computed by StatHead from nflverse weekly player stats
and the nflverse schedule, so nothing in it is third-party output.

Inputs (all committed; CI's fresh .csv is preferred over the .csv.gz):
  public/data/player_stats_<season>.csv(.gz)    weekly actuals (season to date)
  public/data/player_stats_<season-1>.csv(.gz)  prior season, for context
  public/data/games.csv(.gz)                    final scores -> completed weeks
  public/data/schedule-<season>.json            opponent / home / bye per week
  public/data/schedule-strength-<season>.json   StatHead model factor per game

Output:
  public/data/matchups-<season>.json

Run: python3 scripts/build-matchups.py [season]
"""

import csv
import gzip
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')

SEASON = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 2026
PRIOR = SEASON - 1
WEEKS = 18
POSITIONS = ('QB', 'RB', 'WR', 'TE')
# Scorings whose ranks are precomputed in the file. TE-premium ranks are
# derived by consumers from ppr + rec (ppr + 0.5*rec or ppr + rec for TEs).
SCORINGS = {'ppr': 0.0, 'half': -0.5, 'std': -1.0}   # pts = ppr + coef * rec


def load_json(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def iter_csv_rows(base):
    """Rows from public/data/<base>.csv, preferring CI's fresh .csv over the
    committed .csv.gz. Yields nothing when neither exists."""
    plain = os.path.join(DATA, f'{base}.csv')
    gz = os.path.join(DATA, f'{base}.csv.gz')
    if os.path.exists(plain):
        with open(plain, newline='') as f:
            yield from csv.DictReader(f)
    elif os.path.exists(gz):
        with gzip.open(gz, 'rt') as f:
            yield from csv.DictReader(f)


def weeks_played(season):
    """Highest REG week in which every scheduled game has a final score, and
    the set of (team, week) pairs that are final. 0 preseason. A half-played
    week (Thursday done, Sunday not) is not 'played', but its final games
    still count toward each defense's per-game ledger below."""
    scheduled = defaultdict(int)
    sched = load_json(f'schedule-{season}.json') or {}
    for g in sched.get('games', []):
        if 1 <= g.get('week', 0) <= WEEKS:
            scheduled[g['week']] += 1
    finals = defaultdict(int)
    final_pairs = set()
    for row in iter_csv_rows('games'):
        if row.get('season') != str(season) or row.get('game_type') != 'REG':
            continue
        if not (row.get('home_score') or '').strip():
            continue
        try:
            w = int(row['week'])
        except (ValueError, TypeError):
            continue
        finals[w] += 1
        final_pairs.add((row['home_team'], w))
        final_pairs.add((row['away_team'], w))
    latest = 0
    for w in range(1, WEEKS + 1):
        if scheduled.get(w) and finals.get(w, 0) >= scheduled[w]:
            latest = w
        else:
            break
    return latest, final_pairs


def allowed_ledger(season, final_pairs=None):
    """(def_team, pos) -> {week: {'opp': offense, 'ppr': pts, 'rec': n}} from
    a season's REG weekly rows. When final_pairs is given, only games that
    are final in games.csv count (guards against a feed publishing a game's
    rows mid-game)."""
    led = defaultdict(lambda: defaultdict(lambda: {'opp': None, 'ppr': 0.0, 'rec': 0.0}))
    for row in iter_csv_rows(f'player_stats_{season}'):
        if row.get('season_type') != 'REG':
            continue
        pos = row.get('position')
        d = row.get('opponent_team')
        if pos not in POSITIONS or not d:
            continue
        try:
            w = int(row.get('week') or 0)
        except ValueError:
            continue
        if not 1 <= w <= WEEKS:
            continue
        if final_pairs is not None and (d, w) not in final_pairs:
            continue
        cell = led[(d, pos)][w]
        cell['opp'] = row.get('team') or cell['opp']
        cell['ppr'] += float(row.get('fantasy_points_ppr') or 0)
        cell['rec'] += float(row.get('receptions') or 0)
    return led


def per_game(led):
    """(def_team, pos) -> (games, ppr/g, rec/g). A defense's game count is the
    number of weeks it has ANY position row for, so a week where nobody at a
    position scored still counts as a game with 0 allowed."""
    weeks_by_def = defaultdict(set)
    for (d, _pos), by_week in led.items():
        weeks_by_def[d] |= set(by_week)
    out = {}
    for d, weeks in weeks_by_def.items():
        n = len(weeks)
        for pos in POSITIONS:
            by_week = led.get((d, pos), {})
            ppr = sum(c['ppr'] for c in by_week.values())
            rec = sum(c['rec'] for c in by_week.values())
            out[(d, pos)] = (n, ppr / n if n else 0.0, rec / n if n else 0.0)
    return out


def rank_desc(values):
    """{key: value} -> {key: rank}, 1 = largest. Ties share the better rank."""
    order = sorted(values.items(), key=lambda kv: -kv[1])
    ranks, prev, prev_rank = {}, None, 0
    for i, (k, v) in enumerate(order, start=1):
        if prev is None or v != prev:
            prev_rank = i
        ranks[k] = prev_rank
        prev = v
    return ranks


def main():
    played_through, final_pairs = weeks_played(SEASON)
    current_week = min(played_through + 1, WEEKS)

    cur_led = allowed_ledger(SEASON, final_pairs)
    cur_pg = per_game(cur_led)
    prior_pg = per_game(allowed_ledger(PRIOR))

    sched = load_json(f'schedule-{SEASON}.json') or {}
    team_weeks = defaultdict(list)
    for g in sched.get('games', []):
        w = g.get('week')
        if not (1 <= (w or 0) <= WEEKS):
            continue
        team_weeks[g['home']].append({'w': w, 'opp': g['away'], 'home': True})
        team_weeks[g['away']].append({'w': w, 'opp': g['home'], 'home': False})
    for rows in team_weeks.values():
        rows.sort(key=lambda r: r['w'])

    # StatHead model factor per defense per position: schedule-strength lists
    # it per game as the OPPONENT's def-vs-pos multiplier, so invert it.
    ss = load_json(f'schedule-strength-{SEASON}.json') or {}
    factor = {}
    for t, v in (ss.get('teams') or {}).items():
        for g in v.get('games', []):
            for pos in POSITIONS:
                f = (g.get('factors') or {}).get(pos)
                if f is not None:
                    factor[(g['opp'], pos)] = f

    teams = sorted(set(team_weeks) | {d for d, _ in cur_pg} | {d for d, _ in prior_pg})
    if not teams:
        print('No teams found (no schedule and no stats); nothing written')
        return

    # League averages: mean over defenses of their per-game allowed, among
    # defenses that have played.
    league = {}
    for pos in POSITIONS:
        vals = [(ppr, rec) for (d, p), (n, ppr, rec) in cur_pg.items() if p == pos and n]
        pri = [(ppr, rec) for (d, p), (n, ppr, rec) in prior_pg.items() if p == pos and n]
        league[pos] = {
            'ppr': round(sum(v[0] for v in vals) / len(vals), 2) if vals else None,
            'rec': round(sum(v[1] for v in vals) / len(vals), 2) if vals else None,
            'priorPpr': round(sum(v[0] for v in pri) / len(pri), 2) if pri else None,
            'priorRec': round(sum(v[1] for v in pri) / len(pri), 2) if pri else None,
        }

    # Ranks: 1 = most points allowed (softest matchup for the offense), per
    # scoring, among defenses that have played. The model factor is ranked
    # the same way (1 = highest multiplier).
    ranks = {}
    for pos in POSITIONS:
        for sc, coef in SCORINGS.items():
            vals = {d: ppr + coef * rec for (d, p), (n, ppr, rec) in cur_pg.items() if p == pos and n}
            ranks[(pos, sc)] = rank_desc(vals) if vals else {}
        fvals = {d: f for (d, p), f in factor.items() if p == pos}
        ranks[(pos, 'factor')] = rank_desc(fvals) if fvals else {}

    defenses = {}
    for d in teams:
        entry = {}
        for pos in POSITIONS:
            n, ppr, rec = cur_pg.get((d, pos), (0, 0.0, 0.0))
            pn, pppr, prec = prior_pg.get((d, pos), (0, 0.0, 0.0))
            by_week = cur_led.get((d, pos), {})
            entry[pos] = {
                'g': n,
                'ppr': round(ppr, 2) if n else None,
                'rec': round(rec, 2) if n else None,
                'rank': {sc: ranks[(pos, sc)].get(d) for sc in SCORINGS},
                'prior': {'g': pn, 'ppr': round(pppr, 2) if pn else None,
                          'rec': round(prec, 2) if pn else None},
                'factor': factor.get((d, pos)),
                'factorRank': ranks[(pos, 'factor')].get(d),
                # Game log, oldest first: what each offense took off them.
                'byWeek': [
                    {'w': w, 'opp': c['opp'], 'ppr': round(c['ppr'], 1), 'rec': round(c['rec'], 0)}
                    for w, c in sorted(by_week.items())
                ],
            }
        defenses[d] = entry

    schedule = {}
    for t in teams:
        rows = []
        for g in team_weeks.get(t, []):
            rows.append({
                'w': g['w'], 'opp': g['opp'], 'home': g['home'],
                'played': (t, g['w']) in final_pairs,
                'factor': {pos: factor.get((g['opp'], pos)) for pos in POSITIONS},
            })
        schedule[t] = rows

    doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'playedThrough': played_through,
        'currentWeek': current_week,
        'positions': list(POSITIONS),
        'note': (
            f'Weekly strength of matchup, {SEASON}. defenses[D][pos] is what '
            f'defense D has allowed per game to that position this season: ppr '
            f'= PPR fantasy points, rec = receptions, so half = ppr - 0.5*rec, '
            f'std = ppr - rec and TE-premium = ppr + bonus*rec (TEs only). '
            f'rank.<scoring> is 1 = most points allowed = softest matchup for '
            f'the offense, among defenses that have played. prior is the same '
            f'ledger for {PRIOR}. factor is the StatHead model multiplier the '
            f'weekly projections apply for that opponent (prior season blended '
            f'with this one, shrunk toward 1, clamped) and factorRank ranks it '
            f'the same way; it is the regressed view, the raw ledger is the '
            f'loud one. schedule[T] lists every game for team T with the '
            f'opponent, venue, whether it is final and the opponent\'s factor '
            f'per position; byes are the missing weeks. Season to date means '
            f'every final game, including the finished games of a week in '
            f'progress. Computed by StatHead from nflverse weekly stats.'
        ),
        'league': league,
        'defenses': defenses,
        'schedule': schedule,
    }
    out = os.path.join(DATA, f'matchups-{SEASON}.json')
    with open(out, 'w') as fh:
        json.dump(doc, fh, separators=(',', ':'))
        fh.write('\n')
    n_def = sum(1 for d in defenses if defenses[d]['QB']['g'])
    print(f'Wrote {out}: {len(defenses)} teams ({n_def} with games), '
          f'played through week {played_through}, current week {current_week}')


if __name__ == '__main__':
    main()
