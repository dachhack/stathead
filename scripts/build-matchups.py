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

# Component metrics per position, where the position has the volume for the
# number to mean something. Counting metrics are per game; rates (ypc, ypr)
# are total yards over total volume across the defense's games. Composite
# points use the usual PPR components (0.04/yd + 4/TD - 2/INT passing;
# 0.1/yd + 6/TD - 2/fumble lost rushing; 1/rec + 0.1/yd + 6/TD - 2/fumble
# lost receiving) so a QB's or RB's line splits into its halves.
METRIC_COLS = {
    'passAtt': 'attempts', 'passYds': 'passing_yards', 'passTD': 'passing_tds',
    'int': 'passing_interceptions', 'carries': 'carries', 'rushYds': 'rushing_yards',
    'rushTD': 'rushing_tds', 'rushFumLost': 'rushing_fumbles_lost', 'targets': 'targets',
    'rec': 'receptions', 'recYds': 'receiving_yards', 'recTD': 'receiving_tds',
    'recFumLost': 'receiving_fumbles_lost', 'ppr': 'fantasy_points_ppr',
}
COMPOSITES = {
    'passPts': {'passYds': 0.04, 'passTD': 4, 'int': -2},
    'rushPts': {'rushYds': 0.1, 'rushTD': 6, 'rushFumLost': -2},
    'recPts': {'rec': 1, 'recYds': 0.1, 'recTD': 6, 'recFumLost': -2},
}
RATES = {'ypc': ('rushYds', 'carries'), 'ypr': ('recYds', 'rec')}
METRICS = {
    'QB': ['passPts', 'passAtt', 'passYds', 'passTD', 'int', 'rushPts', 'carries', 'rushYds', 'rushTD'],
    'RB': ['rushPts', 'carries', 'rushYds', 'rushTD', 'ypc', 'recPts', 'targets', 'rec', 'recYds', 'recTD'],
    'WR': ['recPts', 'targets', 'rec', 'recYds', 'recTD', 'ypr'],
    'TE': ['recPts', 'targets', 'rec', 'recYds', 'recTD', 'ypr'],
}
METRIC_LABELS = {
    'passPts': 'passing fantasy points (0.04/yd, 4/TD, -2/INT)', 'passAtt': 'pass attempts',
    'passYds': 'passing yards', 'passTD': 'passing TDs', 'int': 'interceptions thrown',
    'rushPts': 'rushing fantasy points (0.1/yd, 6/TD, -2/fumble lost)', 'carries': 'carries',
    'rushYds': 'rushing yards', 'rushTD': 'rushing TDs', 'ypc': 'yards per carry',
    'recPts': 'receiving fantasy points, PPR (1/rec, 0.1/yd, 6/TD, -2/fumble lost)',
    'targets': 'targets', 'rec': 'receptions', 'recYds': 'receiving yards',
    'recTD': 'receiving TDs', 'ypr': 'yards per reception',
}


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
    led = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
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
        cell['opp'] = row.get('team') or cell.get('opp')
        for m, col in METRIC_COLS.items():
            cell[m] += float(row.get(col) or 0)
    return led


def game_value(cell, m):
    """A metric's value in one defense-game cell (counting metrics and
    composites; rates are handled on totals by the caller)."""
    if m in COMPOSITES:
        return sum(coef * cell.get(k, 0.0) for k, coef in COMPOSITES[m].items())
    return cell.get(m, 0.0)


def metric_tables(led, n_games):
    """Per (defense, pos, metric): per-game allowed and allowed over expected,
    where expected is what the offense faced produces in that metric in its
    OTHER games this season (leave-one-out, so the game itself does not set
    its own bar; league average when the offense has no other game). Rates
    (ypc, ypr) are totals over totals, and their expectation is the offense's
    other-games rate applied to the volume it actually had in the game.
    Returns ({(d, pos, m): (pg, oe)}, {(pos, m): league_pg})."""
    # Offense-side totals per (offense, pos): per-game sums by week.
    off = defaultdict(dict)                      # (o, pos) -> {w: cell}
    for (d, pos), by_week in led.items():
        for w, cell in by_week.items():
            if cell.get('opp'):
                off[(cell['opp'], pos)][w] = cell
    base_keys = set(METRIC_COLS) | set(COMPOSITES)
    league_tot = defaultdict(float)              # (pos, m) -> total
    league_g = defaultdict(int)                  # pos -> defense-games
    for (d, pos), by_week in led.items():
        league_g[pos] += n_games.get(d, 0)
        for cell in by_week.values():
            for m in base_keys:
                league_tot[(pos, m)] += game_value(cell, m)
    league_pg = {k: (v / league_g[k[0]] if league_g[k[0]] else 0.0) for k, v in league_tot.items()}

    def loo_avg(o, pos, w, m):
        """Offense o's per-game m in its games other than week w."""
        games = off.get((o, pos), {})
        others = [game_value(c, m) for ww, c in games.items() if ww != w]
        return sum(others) / len(others) if others else league_pg.get((pos, m), 0.0)

    def loo_rate(o, pos, w, num, den):
        games = off.get((o, pos), {})
        n = sum(c.get(num, 0.0) for ww, c in games.items() if ww != w)
        dn = sum(c.get(den, 0.0) for ww, c in games.items() if ww != w)
        if dn > 0:
            return n / dn
        ld = league_pg.get((pos, den), 0.0)
        return league_pg.get((pos, num), 0.0) / ld if ld else 0.0

    out = {}
    league = {}
    for pos, metrics in METRICS.items():
        for m in metrics + ['ppr']:
            if m in RATES:
                num, den = RATES[m]
                ld = league_pg.get((pos, den), 0.0)
                league[(pos, m)] = league_pg.get((pos, num), 0.0) / ld if ld else None
            else:
                league[(pos, m)] = league_pg.get((pos, m))
        for d in n_games:
            by_week = led.get((d, pos), {})
            n = n_games[d]
            if not n:
                continue
            for m in metrics + ['ppr']:
                if m in RATES:
                    num, den = RATES[m]
                    tot_n = sum(c.get(num, 0.0) for c in by_week.values())
                    tot_d = sum(c.get(den, 0.0) for c in by_week.values())
                    exp_n = sum(loo_rate(c['opp'], pos, w, num, den) * c.get(den, 0.0)
                                for w, c in by_week.items() if c.get('opp'))
                    pg = tot_n / tot_d if tot_d else None
                    oe = (tot_n - exp_n) / tot_d if tot_d else None
                else:
                    tot = sum(game_value(c, m) for c in by_week.values())
                    exp = sum(loo_avg(c['opp'], pos, w, m) for w, c in by_week.items() if c.get('opp'))
                    pg = tot / n
                    oe = (tot - exp) / n
                out[(d, pos, m)] = (pg, oe)
    return out, league


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
            ppr = sum(c.get('ppr', 0.0) for c in by_week.values())
            rec = sum(c.get('rec', 0.0) for c in by_week.values())
            out[(d, pos)] = (n, ppr / n if n else 0.0, rec / n if n else 0.0)
    return out


def games_by_defense(pg):
    return {d: n for (d, pos), (n, _p, _r) in pg.items() if pos == POSITIONS[0]}


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
    metrics, league_metrics = metric_tables(cur_led, games_by_defense(cur_pg))

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
        for m in METRICS[pos] + ['ppr']:
            pgv = {d: v[0] for (d, p, mm), v in metrics.items() if p == pos and mm == m and v[0] is not None}
            oev = {d: v[1] for (d, p, mm), v in metrics.items() if p == pos and mm == m and v[1] is not None}
            ranks[(pos, 'm', m)] = rank_desc(pgv) if pgv else {}
            ranks[(pos, 'oe', m)] = rank_desc(oev) if oev else {}
        # Receptions over expected ride along so over-expected points convert
        # to half / standard / TE-premium the same way the ledger does.
    for pos in POSITIONS:
        league[pos]['metrics'] = {
            m: (round(v, 3) if m in RATES else round(v, 2)) if v is not None else None
            for m, v in ((m, league_metrics.get((pos, m))) for m in METRICS[pos])
        }

    defenses = {}
    for d in teams:
        entry = {}
        for pos in POSITIONS:
            n, ppr, rec = cur_pg.get((d, pos), (0, 0.0, 0.0))
            pn, pppr, prec = prior_pg.get((d, pos), (0, 0.0, 0.0))
            by_week = cur_led.get((d, pos), {})
            oe_ppr = metrics.get((d, pos, 'ppr'), (None, None))[1]
            oe_rec = metrics.get((d, pos, 'rec'), (None, None))[1] if pos != 'QB' else 0.0
            entry[pos] = {
                'g': n,
                'ppr': round(ppr, 2) if n else None,
                'rec': round(rec, 2) if n else None,
                'rank': {sc: ranks[(pos, sc)].get(d) for sc in SCORINGS},
                # PPR points allowed per game over what the offenses faced
                # score elsewhere (schedule-adjusted), and its rank.
                'oe': round(oe_ppr, 2) if oe_ppr is not None else None,
                'oeRec': round(oe_rec, 2) if oe_rec is not None else None,
                'oeRank': ranks[(pos, 'oe', 'ppr')].get(d),
                'metrics': {
                    m: {
                        'pg': (round(v[0], 2) if m in RATES else round(v[0], 2)) if v[0] is not None else None,
                        'oe': round(v[1], 2) if v[1] is not None else None,
                        'rank': ranks[(pos, 'm', m)].get(d),
                        'oeRank': ranks[(pos, 'oe', m)].get(d),
                    }
                    for m, v in ((m, metrics.get((d, pos, m), (None, None))) for m in METRICS[pos])
                } if n else {},
                'prior': {'g': pn, 'ppr': round(pppr, 2) if pn else None,
                          'rec': round(prec, 2) if pn else None},
                'factor': factor.get((d, pos)),
                'factorRank': ranks[(pos, 'factor')].get(d),
                # Game log, oldest first: what each offense took off them.
                'byWeek': [
                    {'w': w, 'opp': c.get('opp'), 'ppr': round(c.get('ppr', 0.0), 1), 'rec': round(c.get('rec', 0.0), 0)}
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

    # Rest of schedule per team and position: the mean of what the remaining
    # opponents allow (points, receptions, over-expected and the model factor),
    # ranked 1 = softest, plus the fantasy-playoff weeks 15-17 on their own.
    PLAYOFF_WEEKS = (15, 16, 17)
    ros = {}
    bye = {}
    for t in teams:
        games = schedule.get(t, [])
        played_weeks = {g['w'] for g in games}
        missing = [w for w in range(1, WEEKS + 1) if w not in played_weeks]
        bye[t] = missing[0] if len(missing) == 1 else None
        remaining = [g for g in games if not g['played'] and g['w'] >= current_week]
        ros[t] = {}
        for pos in POSITIONS:
            def mean(vals):
                vals = [v for v in vals if v is not None]
                return sum(vals) / len(vals) if vals else None
            opp_pg = [cur_pg.get((g['opp'], pos)) for g in remaining]
            pprs = [p[1] for p in opp_pg if p and p[0]]
            recs = [p[2] for p in opp_pg if p and p[0]]
            oes = [metrics.get((g['opp'], pos, 'ppr'), (None, None))[1] for g in remaining]
            facs = [g['factor'].get(pos) for g in remaining]
            po = [cur_pg.get((g['opp'], pos)) for g in remaining if g['w'] in PLAYOFF_WEEKS]
            ros[t][pos] = {
                'g': len(remaining),
                'ppr': round(mean(pprs), 2) if pprs else None,
                'rec': round(mean(recs), 2) if recs else None,
                'oe': round(mean(oes), 2) if mean(oes) is not None else None,
                'factor': round(mean(facs), 4) if mean(facs) is not None else None,
                'playoffPpr': round(mean([p[1] for p in po if p and p[0]]), 2) if any(p and p[0] for p in po) else None,
                'playoffRec': round(mean([p[2] for p in po if p and p[0]]), 2) if any(p and p[0] for p in po) else None,
            }
    for pos in POSITIONS:
        for sc, coef in SCORINGS.items():
            vals = {t: ros[t][pos]['ppr'] + coef * ros[t][pos]['rec'] for t in teams if ros[t][pos]['ppr'] is not None}
            rk = rank_desc(vals) if vals else {}
            for t in teams:
                ros[t][pos].setdefault('rank', {})[sc] = rk.get(t)
        for key in ('oe', 'factor'):
            vals = {t: ros[t][pos][key] for t in teams if ros[t][pos][key] is not None}
            rk = rank_desc(vals) if vals else {}
            for t in teams:
                ros[t][pos][f'{key}Rank'] = rk.get(t)

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
            f'progress. Computed by StatHead from nflverse weekly stats. '
            f'oe = points allowed per game OVER EXPECTED: the offense faced is '
            f'expected to score what it scores in its other games this season '
            f'(leave-one-out; league average when it has none), so oe is the '
            f'schedule-adjusted ledger; oeRec is the same for receptions so '
            f'oe converts to other scorings; oeRank is 1 = most over expected. '
            f'metrics[m] = {{pg, oe, rank, oeRank}} per component metric (see '
            f'metricLabels); rates (ypc, ypr) are totals over totals and their '
            f'expectation applies the offense\'s other-games rate to the volume '
            f'it had in the game. ros[T][pos] averages the remaining opponents '
            f'(from currentWeek, unplayed): ppr, rec, oe, factor, playoff weeks '
            f'15-17, with ranks 1 = softest rest of schedule.'
        ),
        'metricLabels': METRIC_LABELS,
        'metricsByPosition': METRICS,
        'league': league,
        'defenses': defenses,
        'ros': ros,
        'bye': bye,
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
