#!/usr/bin/env python3
"""Build rest-of-game quarter splits from play-by-play.

Turns a full-game projection into a **rest-of-game** projection at any point
in a game — before kickoff, after Q1, at half, after Q3 — and gives the
spread needed to price the remainder as a prop.

Three empirical pieces, all measured off the prior season's play-by-play:

1. `share`  — the fraction of a full game's production that lands in each
   quarter, per position and stat (OT folded into Q4). `remaining[q]` is the
   running tail: what is still to come after quarter q.

2. `script` — game-script multipliers. Offenses trailing throw more and run
   less; offenses ahead do the opposite. Each play is bucketed by the
   possession team's pre-play score differential, and the buckets are scored
   on plays per minute, pass share and yards per attempt relative to the
   league average, then combined into per-stat multipliers.

3. `blend`  — how much a player's *in-game* production so far should override
   his pre-game expectation. For every player-game in the sample, rest-of-game
   production is regressed (through the origin, two predictors, no intercept)
   on his leave-this-game-out season rate and on his pace through quarter q.
   The fitted weights say how fast to trust a hot start.

Rest-of-game mean for stat s after quarter q:

    mu_rog = remaining[q][pos][s]
             * (wSeason * fullGameProjection_s + wInGame * paceImplied_s)
             * script[bucket][s]

…where `paceImplied_s = observed_s_through_q / cumulative[q][pos][s]`. The
matching spread comes from `dispersion[q][pos][s]` (negative binomial `k` for
counting stats, coefficient of variation for yardage), measured on the same
partial-game windows rather than assumed from the full-game numbers.

Inputs (committed):
  public/data/pbp-slim-<season>.json.gz    play-by-play
  public/data/player_stats_<season>.csv.gz position lookup

Output:
  public/data/quarter-splits-<season>.json

Run: python3 scripts/build-quarter-splits.py
"""

import csv
import gzip
import json
import math
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')

SEASON = 2025
SEASONS = (2025, 2024)      # pooled for the spread / blend estimates
WEEKS = 18
POSITIONS = ('QB', 'RB', 'WR', 'TE')
QUARTERS = (1, 2, 3, 4)

# Score-differential buckets, from the possession team's point of view.
# (lower bound inclusive, label) — scanned high to low.
SCRIPT_BUCKETS = (
    (15, 'lead15'),
    (9, 'lead9'),
    (4, 'lead4'),
    (-3, 'close'),
    (-8, 'trail4'),
    (-14, 'trail9'),
    (-999, 'trail15'),
)
NEUTRAL_BUCKET = 'close'

QB_STATS = ('passAtt', 'passComp', 'passYds', 'passTD', 'int',
            'rushAtt', 'rushYds', 'rushTD')
SKILL_STATS = ('rushAtt', 'rushYds', 'rushTD', 'tgt', 'rec', 'recYds', 'recTD')
POS_STATS = {
    'QB': QB_STATS,
    'RB': SKILL_STATS,
    'WR': SKILL_STATS,
    'TE': SKILL_STATS,
}
COUNT_STATS = {'passAtt', 'passComp', 'passTD', 'int', 'rushAtt', 'rushTD',
               'tgt', 'rec', 'recTD'}

# Which script multiplier drives each stat.
SCRIPT_FAMILY = {
    'passAtt': 'passAtt', 'passComp': 'passAtt', 'passYds': 'passYds',
    'passTD': 'passYds', 'int': 'passAtt',
    'rushAtt': 'rushAtt', 'rushYds': 'rushYds', 'rushTD': 'rushYds',
    'tgt': 'passAtt', 'rec': 'passAtt', 'recYds': 'passYds', 'recTD': 'passYds',
}

MIN_PLAYER_GAMES = 6        # games needed before a player joins the estimates


def load_pbp(season):
    path = os.path.join(DATA, f'pbp-slim-{season}.json.gz')
    if not os.path.exists(path):
        return []
    with gzip.open(path, 'rt') as f:
        return json.load(f)


def iter_csv_rows(base):
    plain = os.path.join(DATA, f'{base}.csv')
    gz = os.path.join(DATA, f'{base}.csv.gz')
    if os.path.exists(plain):
        with open(plain, newline='') as f:
            yield from csv.DictReader(f)
    elif os.path.exists(gz):
        with gzip.open(gz, 'rt') as f:
            yield from csv.DictReader(f)


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def positions_for(seasons):
    """gsis id -> the position he played most often."""
    seen = defaultdict(Counter)
    for season in seasons:
        for r in iter_csv_rows(f'player_stats_{season}'):
            pid, pos = r.get('player_id'), r.get('position')
            if pid and pos:
                seen[pid][pos] += 1
    return {pid: c.most_common(1)[0][0] for pid, c in seen.items()}


def clock_seconds(t):
    """'12:34' -> seconds remaining in the quarter."""
    try:
        m, s = t.split(':')
        return int(m) * 60 + int(s)
    except (AttributeError, ValueError):
        return 0


def bucket_for(diff):
    for lo, label in SCRIPT_BUCKETS:
        if diff >= lo:
            return label
    return 'trail15'


def counts_from_play(p):
    """[(player_id, stat, value)] for a single scrimmage play."""
    out = []
    if p.get('two_point_attempt') or p.get('play_type') not in ('pass', 'run'):
        return out
    if p.get('play_type') == 'pass':
        passer = p.get('passer_player_id')
        recv = p.get('receiver_player_id')
        sacked = bool(num(p.get('sack')))
        if passer and not sacked:
            out.append((passer, 'passAtt', 1))
            out.append((passer, 'passYds', num(p.get('passing_yards'))))
            if num(p.get('complete_pass')):
                out.append((passer, 'passComp', 1))
            if num(p.get('pass_touchdown')):
                out.append((passer, 'passTD', 1))
            if num(p.get('interception')):
                out.append((passer, 'int', 1))
        if recv and not sacked:
            out.append((recv, 'tgt', 1))
            if num(p.get('complete_pass')):
                out.append((recv, 'rec', 1))
                out.append((recv, 'recYds', num(p.get('receiving_yards'))))
                if num(p.get('pass_touchdown')):
                    out.append((recv, 'recTD', 1))
    else:
        rusher = p.get('rusher_player_id')
        if rusher:
            out.append((rusher, 'rushAtt', 1))
            out.append((rusher, 'rushYds', num(p.get('rushing_yards'))))
            if num(p.get('rush_touchdown')):
                out.append((rusher, 'rushTD', 1))
    return out


def collect(seasons, pos_of):
    """Walk the play-by-play once and gather everything the outputs need.

    Returns:
      per_qtr[(pid, game, qtr)][stat]   player production by quarter
      team_qtr[qtr]                     team-level plays / points by quarter
      script                            per-bucket play counts, yards, seconds
    """
    per_qtr = defaultdict(lambda: defaultdict(float))
    team_qtr = defaultdict(lambda: defaultdict(float))
    script = defaultdict(lambda: defaultdict(float))
    plays_by_game = defaultdict(list)

    for season in seasons:
        for p in load_pbp(season):
            if p.get('week', 99) > WEEKS:
                continue
            q = p.get('qtr') or 0
            if not q:
                continue
            qi = 4 if q >= 4 else q            # OT folds into Q4
            gid = f"{season}:{p['game_id']}"
            if p.get('play_type') in ('pass', 'run') and not p.get('two_point_attempt'):
                team_qtr[qi]['plays'] += 1
                team_qtr[qi]['yards'] += num(p.get('yards_gained'))
                plays_by_game[gid].append(p)
            for pid, stat, val in counts_from_play(p):
                if pos_of.get(pid) in POSITIONS:
                    per_qtr[(pid, gid, qi)][stat] += val
            # Scoring plays, by quarter, for team-level game props.
            if num(p.get('touchdown')):
                team_qtr[qi]['td'] += 1
            if p.get('field_goal_result') == 'made':
                team_qtr[qi]['fg'] += 1

    # Script buckets: plays, pass share, yards per attempt and elapsed clock.
    for gid, plays in plays_by_game.items():
        home = gid.split('_')[-1]
        plays.sort(key=lambda p: (p['qtr'], -clock_seconds(p.get('time'))))
        for i, p in enumerate(plays):
            pos_team = p.get('posteam')
            if not pos_team:
                continue
            hs, aws = num(p.get('total_home_score')), num(p.get('total_away_score'))
            diff = (hs - aws) if pos_team == home else (aws - hs)
            b = bucket_for(diff)
            q = min(p.get('qtr') or 1, 4)
            elapsed_now = (q - 1) * 900 + (900 - clock_seconds(p.get('time')))
            nxt = plays[i + 1] if i + 1 < len(plays) else None
            if nxt is not None:
                qn = min(nxt.get('qtr') or q, 4)
                elapsed_next = (qn - 1) * 900 + (900 - clock_seconds(nxt.get('time')))
                dt = max(0.0, min(elapsed_next - elapsed_now, 120.0))
            else:
                dt = 0.0
            s = script[b]
            s['plays'] += 1
            s['seconds'] += dt
            if p.get('play_type') == 'pass' and not num(p.get('sack')):
                s['passAtt'] += 1
                s['passYds'] += num(p.get('passing_yards'))
            elif p.get('play_type') == 'run':
                s['rushAtt'] += 1
                s['rushYds'] += num(p.get('rushing_yards'))
    return per_qtr, team_qtr, script


def pooled_shares(per_qtr, pos_of):
    agg = defaultdict(float)
    for (pid, _gid, q), stats in per_qtr.items():
        pos = pos_of.get(pid)
        if pos not in POSITIONS:
            continue
        for stat, v in stats.items():
            if stat in POS_STATS[pos]:
                agg[(pos, stat, q)] += v
    share, cumulative, remaining = {}, {}, {}
    for pos in POSITIONS:
        for stat in POS_STATS[pos]:
            vals = [agg.get((pos, stat, q), 0.0) for q in QUARTERS]
            total = sum(vals) or 1.0
            sh = [v / total for v in vals]
            share.setdefault(pos, {})[stat] = [round(v, 4) for v in sh]
            cum, run = [], 0.0
            for v in sh:
                run += v
                cum.append(round(run, 4))
            cumulative.setdefault(pos, {})[stat] = cum
            # remaining[q] = share still to come AFTER quarter q (q = 0..3)
            remaining.setdefault(pos, {})[stat] = [
                round(1.0 - (cum[q - 1] if q else 0.0), 4) for q in range(0, 4)
            ]
    return share, cumulative, remaining


def script_multipliers(script):
    """bucket -> {passAtt, rushAtt, passYds, rushYds, plays} multipliers vs the
    league-average play mix and pace."""
    tot = defaultdict(float)
    for b, s in script.items():
        for k, v in s.items():
            tot[k] += v
    if not tot.get('plays'):
        return {}
    all_ppm = tot['plays'] / (tot['seconds'] / 60) if tot['seconds'] else 0.0
    all_pass_share = tot['passAtt'] / tot['plays']
    all_rush_share = tot['rushAtt'] / tot['plays']
    all_ypa = tot['passYds'] / tot['passAtt'] if tot['passAtt'] else 0.0
    all_ypc = tot['rushYds'] / tot['rushAtt'] if tot['rushAtt'] else 0.0

    out = {}
    for b, s in script.items():
        if s['plays'] < 200:
            continue
        ppm = s['plays'] / (s['seconds'] / 60) if s['seconds'] else all_ppm
        pace = (ppm / all_ppm) if all_ppm else 1.0
        pass_mult = pace * ((s['passAtt'] / s['plays']) / all_pass_share)
        rush_mult = pace * ((s['rushAtt'] / s['plays']) / all_rush_share)
        ypa = (s['passYds'] / s['passAtt']) if s['passAtt'] else all_ypa
        ypc = (s['rushYds'] / s['rushAtt']) if s['rushAtt'] else all_ypc
        out[b] = {
            'plays': round(pace, 3),
            'passAtt': round(pass_mult, 3),
            'rushAtt': round(rush_mult, 3),
            'passYds': round(pass_mult * (ypa / all_ypa if all_ypa else 1.0), 3),
            'rushYds': round(rush_mult * (ypc / all_ypc if all_ypc else 1.0), 3),
            'playsPerMin': round(ppm, 3),
            'passShare': round(s['passAtt'] / s['plays'], 3),
            'n': int(s['plays']),
        }
    return out


def rest_of_game_stats(per_qtr, pos_of):
    """Per-player-game partial sums, keyed by the quarter you're standing at.

    through[(pid, gid, q)][stat] = production in quarters 1..q
    rest[(pid, gid, q)][stat]    = production in quarters q+1..4
    """
    by_game = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    for (pid, gid, q), stats in per_qtr.items():
        for stat, v in stats.items():
            by_game[(pid, gid)][q][stat] += v
    through, rest = {}, {}
    for key, qmap in by_game.items():
        pos = pos_of.get(key[0])
        if pos not in POSITIONS:
            continue
        for q in range(0, 4):
            t = defaultdict(float)
            r = defaultdict(float)
            for qq, stats in qmap.items():
                target = t if qq <= q else r
                for stat, v in stats.items():
                    if stat in POS_STATS[pos]:
                        target[stat] += v
            through[(key[0], key[1], q)] = t
            rest[(key[0], key[1], q)] = r
    return through, rest


def fit(per_qtr, pos_of, cumulative, remaining):
    """Spread and season/in-game blend weights for each remaining-game window.

    Two passes. The first fits, per (quarter, position, stat), the weights on
    the pre-game expectation vs the in-game pace. The second measures the
    residual spread *around that fitted prediction* — a prop needs the
    conditional spread for one player, not the pooled spread across a whole
    position group (which is dominated by WR1-vs-WR5 talent gaps).

      dispersion[q][pos][stat] = {k, cv, mean, n}
      blend[q][pos][stat]      = {wSeason, wInGame, n}
    """
    through, rest = rest_of_game_stats(per_qtr, pos_of)

    # Season totals per (player, stat) and games played, for leave-one-out rates.
    season_tot = defaultdict(float)
    games = defaultdict(set)
    for (pid, gid, _q), stats in per_qtr.items():
        games[pid].add(gid)
        for stat, v in stats.items():
            season_tot[(pid, stat)] += v

    def predictors(pid, gid, q, pos, stat):
        """(observed rest-of-game, pre-game expectation, in-game pace estimate)
        for one player-game window, using a leave-this-game-out season rate so
        the fit never sees the game it is predicting."""
        y = rest[(pid, gid, q)].get(stat, 0.0)
        t = through[(pid, gid, q)].get(stat, 0.0)
        n_games = len(games[pid])
        loo = (season_tot[(pid, stat)] - (t + y)) / max(n_games - 1, 1)
        rem = remaining[pos][stat][q]
        cum = cumulative[pos][stat][q - 1] if q else 0.0
        x1 = loo * rem
        x2 = (t / cum * rem) if cum > 0.02 else x1
        return y, x1, x2

    def windows(q):
        for (pid, gid, qq) in rest:
            if qq != q:
                continue
            pos = pos_of.get(pid)
            if pos in POSITIONS and len(games[pid]) >= MIN_PLAYER_GAMES:
                yield pid, gid, pos

    dispersion, blend = {}, {}
    for q in range(0, 4):
        # --- pass 1: least squares through the origin, y ~ a*x1 + b*x2 -----
        reg = defaultdict(lambda: {'x11': 0.0, 'x22': 0.0, 'x12': 0.0,
                                   'y1': 0.0, 'y2': 0.0, 'n': 0})
        for pid, gid, pos in windows(q):
            for stat in POS_STATS[pos]:
                y, x1, x2 = predictors(pid, gid, q, pos, stat)
                a = reg[(pos, stat)]
                a['x11'] += x1 * x1
                a['x22'] += x2 * x2
                a['x12'] += x1 * x2
                a['y1'] += y * x1
                a['y2'] += y * x2
                a['n'] += 1

        weights = {}
        for (pos, stat), a in reg.items():
            det = a['x11'] * a['x22'] - a['x12'] ** 2
            if a['n'] < 100 or abs(det) < 1e-9:
                w_season, w_in = 1.0, 0.0
            else:
                w_season = (a['y1'] * a['x22'] - a['y2'] * a['x12']) / det
                w_in = (a['y2'] * a['x11'] - a['y1'] * a['x12']) / det
            # Keep the pair on the simplex: no negative weights, sums to 1 so
            # the fitted line can't drift away from the projection's scale.
            w_season, w_in = max(w_season, 0.0), max(w_in, 0.0)
            total = (w_season + w_in) or 1.0
            weights[(pos, stat)] = (w_season / total, w_in / total)
            if a['n'] >= 100:
                blend.setdefault(str(q), {}).setdefault(pos, {})[stat] = {
                    'wSeason': round(weights[(pos, stat)][0], 3),
                    'wInGame': round(weights[(pos, stat)][1], 3),
                    'n': a['n'],
                }

        # --- pass 2: residual spread around the fitted prediction ----------
        acc = defaultdict(lambda: {'smu': 0.0, 'smu2': 0.0, 'sse': 0.0, 'n': 0})
        for pid, gid, pos in windows(q):
            for stat in POS_STATS[pos]:
                y, x1, x2 = predictors(pid, gid, q, pos, stat)
                ws, wi = weights.get((pos, stat), (1.0, 0.0))
                mu = max(ws * x1 + wi * x2, 1e-6)
                a = acc[(pos, stat)]
                a['smu'] += mu
                a['smu2'] += mu * mu
                a['sse'] += (y - mu) ** 2
                a['n'] += 1

        for (pos, stat), a in acc.items():
            if a['n'] < 100 or a['smu2'] <= 1e-9:
                continue
            mean_mu = a['smu'] / a['n']
            # var = mu + mu^2/k  ->  k = sum(mu^2) / sum(residual^2 - mu)
            excess = a['sse'] - a['smu']
            k = (a['smu2'] / excess) if excess > 1e-6 else 50.0
            dispersion.setdefault(str(q), {}).setdefault(pos, {})[stat] = {
                'mean': round(mean_mu, 3),
                'k': round(min(max(k, 0.3), 50.0), 3),
                'cv': round(math.sqrt(a['sse'] / a['smu2']), 4),
                'n': a['n'],
            }
    return dispersion, blend


def main():
    pos_of = positions_for(SEASONS)
    per_qtr, team_qtr, script = collect(SEASONS, pos_of)
    share, cumulative, remaining = pooled_shares(per_qtr, pos_of)
    scripts = script_multipliers(script)
    disp, blend = fit(per_qtr, pos_of, cumulative, remaining)

    plays_total = sum(team_qtr[q]['plays'] for q in QUARTERS) or 1.0
    pts_total = sum(6 * team_qtr[q]['td'] + 3 * team_qtr[q]['fg'] for q in QUARTERS) or 1.0
    team = {
        'playShare': [round(team_qtr[q]['plays'] / plays_total, 4) for q in QUARTERS],
        'scoreShare': [
            round((6 * team_qtr[q]['td'] + 3 * team_qtr[q]['fg']) / pts_total, 4)
            for q in QUARTERS
        ],
        'yardShare': [
            round(team_qtr[q]['yards'] / (sum(team_qtr[x]['yards'] for x in QUARTERS) or 1.0), 4)
            for q in QUARTERS
        ],
    }

    out = {
        'season': SEASON,
        'seasons': list(SEASONS),
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'quarters': list(QUARTERS),
        'note': (
            'Rest-of-game quarter splits measured from play-by-play (OT folded '
            'into Q4). `share[pos][stat]` is the fraction of a full game that '
            'lands in each quarter; `cumulative[pos][stat][q-1]` is the fraction '
            'through quarter q and `remaining[pos][stat][q]` the fraction still '
            'to come after quarter q (index 0 = pre-kickoff = 1.0). '
            '`script[bucket]` scales the remainder for game state: each play is '
            'bucketed by the possession team\'s pre-play score differential '
            '(lead15/lead9/lead4/close/trail4/trail9/trail15) and the bucket is '
            'measured on plays per minute, pass share and yards per attempt vs '
            'the league average. `blend[q][pos][stat]` are least-squares weights '
            '(fit through the origin, normalized to sum to 1) on the pre-game '
            'projection vs the pace implied by production through quarter q — '
            'how fast to trust a hot start. `dispersion[q][pos][stat]` is the '
            'spread of actual rest-of-game production: negative binomial k '
            '(var = mu + mu^2/k) for counting stats, coefficient of variation '
            'for yardage. Rest-of-game mean = remaining * (wSeason * projection '
            '+ wInGame * paceImplied) * script[bucket]; see '
            'src/lib/playerProps.ts / stathead.props.'
        ),
        'scriptBuckets': [label for _lo, label in SCRIPT_BUCKETS],
        'neutralBucket': NEUTRAL_BUCKET,
        'countStats': sorted(COUNT_STATS),
        'scriptFamily': SCRIPT_FAMILY,
        'share': share,
        'cumulative': cumulative,
        'remaining': remaining,
        'script': scripts,
        'blend': blend,
        'dispersion': disp,
        'team': team,
    }

    path = os.path.join(DATA, f'quarter-splits-{SEASON}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    kb = os.path.getsize(path) / 1024
    print(f'Wrote {path} ({kb:.0f} KB)')
    print('  team play share by quarter:', team['playShare'])
    print('  team score share by quarter:', team['scoreShare'])
    for pos in POSITIONS:
        key = 'passYds' if pos == 'QB' else 'recYds'
        print(f'  {pos} {key} share {share[pos][key]} remaining {remaining[pos][key]}')
    for b in ('trail15', 'close', 'lead15'):
        if b in scripts:
            s = scripts[b]
            print(f'  script {b}: passAtt x{s["passAtt"]}, rushAtt x{s["rushAtt"]}, '
                  f'pace x{s["plays"]} (n={s["n"]})')


if __name__ == '__main__':
    main()
