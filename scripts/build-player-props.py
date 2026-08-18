#!/usr/bin/env python3
"""Build weekly player props + stat-line projections for the current season.

Where `build-weekly-projections.py` splits the season *fantasy point* line
across the schedule, this builder splits the whole **stat line** — attempts,
completions, yards, TDs, targets, receptions — and ships the distribution
parameters a consumer needs to turn each projected mean into a **prop line**
(median + over/under probabilities). Consumers do the distribution math with
`src/lib/playerProps.ts` (TS) or `stathead.props` (Python).

Method (v1, deterministic + explainable):

  weekly_stat[player, s, w] = base_pg[player, s] * matchup_mult[team, pos, s, w]

  base_pg     = season pool projection / projected games (the season line
                stays authoritative — see normalization below)
  matchup_mult= def-vs-pos-vs-stat factor for that week's opponent
                (prior-season per-game *allowed to that position, in that
                stat*, as a ratio to league average, shrunk toward 1.0 and
                clamped, blended with current-season weeks as they land)
              * home/away nudge
              … then normalized per (team, pos, stat) to mean 1.0 across the
                team's scheduled games, so weekly numbers always sum back to
                the season projection.

Strength of matchup is emitted three ways, per the same 2025 evidence:
  * overall  — EPA/play allowed, points/yards/plays allowed per game, sack
               and explosive rate, pace; rolled into a 0-100 grade + rank
  * by fantasy position — PPR allowed per game to QB/RB/WR/TE vs league
               average, as a ratio, grade and rank
  * by stat  — the per-(pos, stat) multipliers that actually drive the props

Availability blends the pool's projected games with prior-season injury-report
history, and is overridden by the current season's injury report when one
exists. Bye weeks come from the schedule (a bye week is emitted as null).

Inputs (all committed):
  public/data/projection-base-<season>.json   season pool (stat lines)
  public/data/schedule-<season>.json          nflverse schedule (opp/home/bye)
  public/data/player_stats_<year>.csv.gz      weekly actuals (def-vs-pos, spread)
  public/data/pbp-slim-<year>.json.gz         play-by-play (defense/pace)
  public/data/games.csv.gz                    scores (points allowed)
  public/data/injuries_<year>.csv.gz          injury reports (availability)
  public/data/player-crosswalk.json           gsis / sleeper ids

Output:
  public/data/player-props-<season>.json

Run: python3 scripts/build-player-props.py
"""

import csv
import gzip
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')

SEASON = 2026
PRIOR = SEASON - 1
WEEKS = 18
POSITIONS = ('QB', 'RB', 'WR', 'TE')

# Defense-vs-position signal barely persists year over year: keep a shrunk
# fraction of the observed deviation and clamp the extremes. Volume stats
# (attempts, targets) persist slightly better than scoring stats, which are
# mostly noise at a 17-game sample.
SHRINK_VOLUME = 0.40
SHRINK_YARDS = 0.35
SHRINK_SCORE = 0.25
MULT_MIN, MULT_MAX = 0.82, 1.18
HOME_MULT, AWAY_MULT = 1.02, 0.98

# Current-season def-vs-pos gets weight n_weeks / (n_weeks + BLEND_K).
BLEND_K = 6

# Skip multipliers for (pos, stat) cells that barely happen (TE carries, WR
# pass attempts): league mean below this many per defense-game -> 1.0.
MIN_LEAGUE_PG = 0.35

# Availability: pool games share vs prior-season injury-report durability.
AVAIL_POOL_W = 0.65
# Injury report status -> probability the player suits up.
STATUS_PLAY_PROB = {
    'out': 0.02,
    'doubtful': 0.15,
    'questionable': 0.72,
    'injured reserve': 0.0,
    'ir': 0.0,
    'physically unable to perform': 0.0,
    'pup': 0.0,
    'did not participate in practice': 0.6,
    'limited participation in practice': 0.88,
    'full participation in practice': 0.97,
}

# Stat key -> nflverse weekly column, and the family used for shrink choice.
STAT_COLS = {
    'passAtt': ('attempts', 'volume'),
    'passComp': ('completions', 'volume'),
    'passYds': ('passing_yards', 'yards'),
    'passTD': ('passing_tds', 'score'),
    'int': ('passing_interceptions', 'score'),
    'rushAtt': ('carries', 'volume'),
    'rushYds': ('rushing_yards', 'yards'),
    'rushTD': ('rushing_tds', 'score'),
    'tgt': ('targets', 'volume'),
    'rec': ('receptions', 'volume'),
    'recYds': ('receiving_yards', 'yards'),
    'recTD': ('receiving_tds', 'score'),
    'pprPts': ('fantasy_points_ppr', 'yards'),
}
SHRINK_BY_FAMILY = {
    'volume': SHRINK_VOLUME,
    'yards': SHRINK_YARDS,
    'score': SHRINK_SCORE,
}

# Which stats each position carries in the output (keeps the file compact and
# stops consumers from rendering meaningless zero columns).
POS_STATS = {
    'QB': ('passAtt', 'passComp', 'passYds', 'passTD', 'int',
           'rushAtt', 'rushYds', 'rushTD', 'pprPts'),
    'RB': ('rushAtt', 'rushYds', 'rushTD', 'tgt', 'rec', 'recYds', 'recTD', 'pprPts'),
    'WR': ('rushAtt', 'rushYds', 'rushTD', 'tgt', 'rec', 'recYds', 'recTD', 'pprPts'),
    'TE': ('tgt', 'rec', 'recYds', 'recTD', 'rushAtt', 'rushYds', 'rushTD', 'pprPts'),
}

# Pool field -> stat key. Pool season totals are per season, not per game.
POOL_FIELDS = {
    'passAtt': 'passAtt', 'passComp': 'passComp', 'passYds': 'passYds',
    'passTD': 'passTD', 'int': 'int', 'rushAtt': 'rushAtt', 'rushYds': 'rushYds',
    'rushTD': 'rushTD', 'tgt': 'tgt', 'rec': 'rec', 'recYds': 'recYds',
    'recTD': 'recTD', 'pprPts': 'pprPts',
}

# Counting stats get a negative-binomial spread (var = mu + mu^2/k); yardage
# stats get a lognormal-ish spread parameterized by coefficient of variation.
COUNT_STATS = {'passAtt', 'passComp', 'passTD', 'int', 'rushAtt', 'rushTD',
               'tgt', 'rec', 'recTD'}


# --------------------------------------------------------------------------
# small IO helpers (mirrors build-weekly-projections.py: prefer the freshly
# downloaded .csv in CI over the committed .csv.gz snapshot)
# --------------------------------------------------------------------------

def load_json(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


# nflverse renamed several weekly-stats columns for 2025+; seasons through
# 2024 still ship the old names. Normalize on read — without this every
# prior-season lookup silently comes back empty and the model quietly falls
# through to its replacement-level defaults.
LEGACY_COLS = {
    'recent_team': 'team',
    'interceptions': 'passing_interceptions',
    'sacks': 'sacks_suffered',
    'sack_yards': 'sack_yards_lost',
}


def _normalize_row(row):
    for old, new in LEGACY_COLS.items():
        if old in row and not row.get(new):
            row[new] = row[old]
    return row


def iter_csv_rows(base):
    plain = os.path.join(DATA, f'{base}.csv')
    gz = os.path.join(DATA, f'{base}.csv.gz')
    if os.path.exists(plain):
        with open(plain, newline='') as f:
            for row in csv.DictReader(f):
                yield _normalize_row(row)
    elif os.path.exists(gz):
        with gzip.open(gz, 'rt') as f:
            for row in csv.DictReader(f):
                yield _normalize_row(row)


def load_pbp(season):
    path = os.path.join(DATA, f'pbp-slim-{season}.json.gz')
    if not os.path.exists(path):
        return []
    with gzip.open(path, 'rt') as f:
        return json.load(f)


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def clamp_mult(ratio, shrink):
    m = 1 + shrink * (ratio - 1)
    return max(MULT_MIN, min(MULT_MAX, m))


# --------------------------------------------------------------------------
# strength of matchup
# --------------------------------------------------------------------------

def def_allowed(season):
    """(def_team, pos, stat) -> allowed per defensive game, plus games played
    per defense and the number of weeks observed."""
    tot = defaultdict(float)
    weeks = defaultdict(set)
    for row in iter_csv_rows(f'player_stats_{season}'):
        if row.get('season_type') != 'REG':
            continue
        pos, opp = row.get('position'), row.get('opponent_team')
        if pos not in POSITIONS or not opp:
            continue
        weeks[opp].add(row.get('week'))
        for stat, (col, _fam) in STAT_COLS.items():
            v = row.get(col)
            if v:
                tot[(opp, pos, stat)] += num(v)
    if not weeks:
        return {}, {}, 0
    games = {t: len(w) for t, w in weeks.items()}
    per_game = {k: v / games[k[0]] for k, v in tot.items() if games.get(k[0])}
    return per_game, games, max(games.values())


def stat_ratios(per_game, teams):
    """(team, pos, stat) -> allowed-per-game ratio vs the league average,
    plus the league averages themselves."""
    league = {}
    for pos in POSITIONS:
        for stat in STAT_COLS:
            vals = [per_game.get((t, pos, stat), 0.0) for t in teams]
            league[(pos, stat)] = (sum(vals) / len(vals)) if vals else 0.0
    ratios = {}
    for t in teams:
        for pos in POSITIONS:
            for stat in STAT_COLS:
                avg = league[(pos, stat)]
                if avg < MIN_LEAGUE_PG:
                    ratios[(t, pos, stat)] = 1.0
                else:
                    ratios[(t, pos, stat)] = per_game.get((t, pos, stat), avg) / avg
    return ratios, league


def build_def_stat_mults():
    """team -> pos -> stat -> multiplier, blending the current season's weeks
    over the prior season's as they accumulate."""
    prior_pg, prior_games, _ = def_allowed(PRIOR)
    cur_pg, cur_games, cur_weeks = def_allowed(SEASON)
    teams = sorted(set(prior_games) | set(cur_games))
    w_cur = cur_weeks / (cur_weeks + BLEND_K) if cur_weeks else 0.0

    prior_ratios, prior_league = stat_ratios(prior_pg, teams)
    cur_ratios, _ = stat_ratios(cur_pg, teams) if cur_games else ({}, {})

    mults = {}
    for t in teams:
        for pos in POSITIONS:
            for stat in STAT_COLS:
                pr = prior_ratios.get((t, pos, stat), 1.0)
                cu = cur_ratios.get((t, pos, stat), pr)
                ratio = (1 - w_cur) * pr + w_cur * cu
                shrink = SHRINK_BY_FAMILY[STAT_COLS[stat][1]]
                mults.setdefault(t, {}).setdefault(pos, {})[stat] = round(
                    clamp_mult(ratio, shrink), 3)
    return mults, teams, w_cur, cur_weeks, prior_pg, prior_league, prior_games


def pbp_defense(season):
    """team -> descriptive defensive profile from play-by-play: EPA/play and
    success rate allowed, plays faced per game, pass rate faced, sack rate,
    explosive rate allowed, seconds per play (pace)."""
    plays = defaultdict(int)
    epa = defaultdict(float)
    success = defaultdict(int)
    passes = defaultdict(int)
    sacks = defaultdict(int)
    explosive = defaultdict(int)
    yards = defaultdict(float)
    games = defaultdict(set)
    for p in load_pbp(season):
        if p.get('week', 99) > WEEKS:
            continue
        d = p.get('defteam')
        if not d or p.get('play_type') not in ('pass', 'run'):
            continue
        games[d].add(p['game_id'])
        plays[d] += 1
        epa[d] += num(p.get('epa'))
        if num(p.get('epa')) > 0:
            success[d] += 1
        if p.get('play_type') == 'pass':
            passes[d] += 1
        if num(p.get('sack')):
            sacks[d] += 1
        gained = num(p.get('yards_gained'))
        yards[d] += gained
        if gained >= 20:
            explosive[d] += 1
    out = {}
    for d, n in plays.items():
        g = len(games[d]) or 1
        out[d] = {
            'epaPlay': round(epa[d] / n, 4),
            'successRate': round(success[d] / n, 4),
            'playsGm': round(n / g, 1),
            'passRateFaced': round(passes[d] / n, 3),
            'sackRate': round(sacks[d] / passes[d], 3) if passes[d] else 0.0,
            'explosiveRate': round(explosive[d] / n, 4),
            'ydsGm': round(yards[d] / g, 1),
        }
    return out


def points_allowed(season):
    """team -> points allowed per game over completed REG games."""
    pts = defaultdict(float)
    games = defaultdict(int)
    for g in iter_csv_rows('games'):
        if g.get('season') != str(season) or g.get('game_type') != 'REG':
            continue
        try:
            hs, aw = int(g['home_score']), int(g['away_score'])
        except (ValueError, TypeError, KeyError):
            continue
        pts[g['home_team']] += aw
        games[g['home_team']] += 1
        pts[g['away_team']] += hs
        games[g['away_team']] += 1
    return {t: round(pts[t] / games[t], 2) for t in games if games[t]}


def rank_map(values, tougher_is_low):
    """value dict -> {team: rank}, rank 1 = toughest defense."""
    items = sorted(values.items(), key=lambda kv: kv[1], reverse=not tougher_is_low)
    return {t: i + 1 for i, (t, _v) in enumerate(items)}


def grade_from(values, tougher_is_low):
    """0-100 grade, 100 = toughest defense (hardest matchup), 0 = softest.

    `tougher_is_low` says which end of the input is the tough end: EPA/play
    allowed and PPR allowed per game are both lower-is-tougher."""
    if not values:
        return {}
    vals = list(values.values())
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or 1.0
    out = {}
    for t, v in values.items():
        frac = (v - lo) / span
        out[t] = round(100 * (1 - frac) if tougher_is_low else 100 * frac, 1)
    return out


# --------------------------------------------------------------------------
# weekly spread (distribution parameters for prop pricing)
# --------------------------------------------------------------------------

def dispersion(seasons):
    """pos -> stat -> {k, cv, n}: how much a player's weekly stat scatters
    around his own season mean.

      counts : negative binomial, var = mu + mu^2/k  (k estimated by pooling
               (var_i - mu_i) against mu_i^2 over qualifying players)
      yards  : coefficient of variation, cv^2 = E[var_i] / E[mu_i^2]

    Only players with >= MIN_GAMES games and a non-trivial mean qualify, so
    the estimate reflects real starters rather than one-week cameos."""
    MIN_GAMES = 8
    by_player = defaultdict(lambda: defaultdict(list))  # (pid,pos) -> stat -> vals
    for season in seasons:
        for row in iter_csv_rows(f'player_stats_{season}'):
            if row.get('season_type') != 'REG':
                continue
            pos = row.get('position')
            pid = row.get('player_id')
            if pos not in POSITIONS or not pid:
                continue
            rec = by_player[(pid, pos, season)]
            for stat, (col, _f) in STAT_COLS.items():
                rec[stat].append(num(row.get(col)))

    acc = defaultdict(lambda: {'sm2': 0.0, 'svar': 0.0, 'sexcess': 0.0,
                               'smu': 0.0, 'n': 0})
    for (_pid, pos, _season), stats in by_player.items():
        for stat, vals in stats.items():
            if len(vals) < MIN_GAMES:
                continue
            mu = sum(vals) / len(vals)
            floor = 0.5 if stat in COUNT_STATS else 8.0
            if stat in ('passTD', 'rushTD', 'recTD', 'int'):
                floor = 0.15
            if mu < floor:
                continue
            var = sum((v - mu) ** 2 for v in vals) / (len(vals) - 1)
            a = acc[(pos, stat)]
            a['sm2'] += mu * mu
            a['svar'] += var
            a['sexcess'] += max(var - mu, 0.0)
            a['smu'] += mu
            a['n'] += 1

    def params(a):
        cv = math.sqrt(a['svar'] / a['sm2']) if a['sm2'] else 0.0
        # k from var = mu + mu^2/k  ->  k = sum(mu^2) / sum(var - mu)
        k = (a['sm2'] / a['sexcess']) if a['sexcess'] > 1e-9 else 50.0
        return round(min(max(k, 0.5), 50.0), 3), round(cv, 4)

    out = {}
    for (pos, stat), a in acc.items():
        if a['n'] < 5:
            continue
        k, cv = params(a)
        out.setdefault(pos, {})[stat] = {'k': k, 'cv': cv, 'n': a['n'], 'src': 'pos'}

    # Thin cells (a TE's carries, a WR's rushing yards) get the league-wide
    # estimate for that stat, then a conservative default. Every (pos, stat)
    # a consumer can ask for must be priceable.
    league = defaultdict(lambda: {'sm2': 0.0, 'svar': 0.0, 'sexcess': 0.0,
                                  'smu': 0.0, 'n': 0})
    for (_pos, stat), a in acc.items():
        for f in ('sm2', 'svar', 'sexcess', 'smu', 'n'):
            league[stat][f] += a[f]
    for pos, stats in POS_STATS.items():
        for stat in stats:
            if out.get(pos, {}).get(stat):
                continue
            a = league.get(stat)
            if a and a['n'] >= 5:
                k, cv = params(a)
                out.setdefault(pos, {})[stat] = {'k': k, 'cv': cv, 'n': a['n'],
                                                 'src': 'league'}
            else:
                out.setdefault(pos, {})[stat] = {'k': 3.0, 'cv': 1.2, 'n': 0,
                                                 'src': 'default'}
    return out


# --------------------------------------------------------------------------
# availability (injuries)
# --------------------------------------------------------------------------

OUT_STATUSES = {'out', 'injured reserve', 'ir', 'doubtful',
                'physically unable to perform', 'pup'}


def injury_history(season):
    """gsis -> {missed, weeks, dnp}: weeks the player was ruled out or worse
    on the prior season's injury report, and weeks he appeared on it at all."""
    hist = defaultdict(lambda: {'missed': 0, 'weeks': 0, 'dnp': 0})
    for r in iter_csv_rows(f'injuries_{season}'):
        if r.get('season_type') != 'REG':
            continue
        gid = r.get('gsis_id')
        if not gid:
            continue
        h = hist[gid]
        h['weeks'] += 1
        status = (r.get('report_status') or '').strip().lower()
        practice = (r.get('practice_status') or '').strip().lower()
        if status in OUT_STATUSES:
            h['missed'] += 1
        elif practice.startswith('did not participate'):
            h['dnp'] += 1
    return hist


def current_injuries(season):
    """gsis -> {'status', 'injury', 'week', 'p'} from the latest week of the
    current season's injury report, when that file exists yet."""
    latest = {}
    for r in iter_csv_rows(f'injuries_{season}'):
        gid = r.get('gsis_id')
        if not gid:
            continue
        try:
            wk = int(r.get('week') or 0)
        except ValueError:
            continue
        if gid in latest and latest[gid]['week'] > wk:
            continue
        status = (r.get('report_status') or '').strip()
        practice = (r.get('practice_status') or '').strip()
        key = (status or practice).lower()
        p = STATUS_PLAY_PROB.get(key)
        if p is None:
            continue
        latest[gid] = {
            'week': wk,
            'status': status or practice,
            'injury': r.get('report_primary_injury') or r.get('practice_primary_injury') or '',
            'p': p,
        }
    return latest


# --------------------------------------------------------------------------
# ids + schedule
# --------------------------------------------------------------------------

def norm_name(s):
    s = (s or '').lower().replace('.', '').replace("'", '')
    for suf in (' jr', ' sr', ' iii', ' ii', ' iv', ' v'):
        if s.endswith(suf):
            s = s[: -len(suf)]
    return ' '.join(s.split())


def build_id_map():
    ids = {}
    for r in load_json('player-crosswalk.json').get('players', []):
        pos = r.get('position')
        if pos not in POSITIONS:
            continue
        rec = {'gsis': r.get('gsis_id') or None, 'sleeper': r.get('sleeper_id') or None}
        for n in {r.get('display_name') or ''} | set(r.get('all_names') or []):
            if n:
                ids.setdefault((norm_name(n), pos), rec)
    return ids


def build_team_weeks(schedule):
    by_team = defaultdict(dict)
    for g in schedule['games']:
        w = g['week']
        if not (1 <= w <= WEEKS):
            continue
        by_team[g['home']][w] = {'w': w, 'opp': g['away'], 'home': True}
        by_team[g['away']][w] = {'w': w, 'opp': g['home'], 'home': False}
    return {t: [wk[w] for w in sorted(wk)] for t, wk in by_team.items()}


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    pool = load_json(f'projection-base-{SEASON}.json')
    schedule = load_json(f'schedule-{SEASON}.json')
    team_weeks = build_team_weeks(schedule)
    id_map = build_id_map()

    def_mults, def_teams, w_cur, cur_weeks, prior_pg, prior_league, prior_games = \
        build_def_stat_mults()
    pbp_prof = pbp_defense(PRIOR)
    pa = points_allowed(PRIOR)

    # --- overall strength of matchup ------------------------------------
    # Composite = z(EPA/play allowed) + z(points allowed/gm), equally weighted.
    def zmap(vals):
        if not vals:
            return {}
        mu = sum(vals.values()) / len(vals)
        sd = math.sqrt(sum((v - mu) ** 2 for v in vals.values()) / len(vals)) or 1.0
        return {t: (v - mu) / sd for t, v in vals.items()}

    z_epa = zmap({t: p['epaPlay'] for t, p in pbp_prof.items()})
    z_pa = zmap(pa)
    composite = {t: 0.5 * z_epa.get(t, 0.0) + 0.5 * z_pa.get(t, 0.0)
                 for t in set(z_epa) | set(z_pa)}
    ovr_rank = rank_map(composite, tougher_is_low=True)
    ovr_grade = grade_from(composite, tougher_is_low=True)

    # --- strength of matchup by fantasy position ------------------------
    pos_ratio, pos_rank, pos_grade, pos_pg = {}, {}, {}, {}
    for pos in POSITIONS:
        pg = {t: prior_pg.get((t, pos, 'pprPts'), 0.0) for t in def_teams}
        avg = (sum(pg.values()) / len(pg)) if pg else 0.0
        ratios = {t: (v / avg if avg else 1.0) for t, v in pg.items()}
        pos_pg[pos] = pg
        pos_ratio[pos] = ratios
        pos_rank[pos] = rank_map(ratios, tougher_is_low=True)
        pos_grade[pos] = grade_from(ratios, tougher_is_low=True)

    defense = {}
    for t in sorted(set(def_teams) | set(pbp_prof) | set(pa)):
        prof = dict(pbp_prof.get(t, {}))
        prof['pointsGm'] = pa.get(t)
        prof['gp'] = prior_games.get(t)
        defense[t] = {
            'overall': {**prof, 'grade': ovr_grade.get(t), 'rank': ovr_rank.get(t)},
            'pos': {
                pos: {
                    'pprGm': round(pos_pg[pos].get(t, 0.0), 2),
                    'ratio': round(pos_ratio[pos].get(t, 1.0), 3),
                    'grade': pos_grade[pos].get(t),
                    'rank': pos_rank[pos].get(t),
                }
                for pos in POSITIONS
            },
            # Only the stats each position actually posts — keeps the doc
            # readable and stops consumers rendering 1.0 filler columns.
            'stat': {
                pos: {s: m[s] for s in POS_STATS[pos] if s in m}
                for pos, m in def_mults.get(t, {}).items()
            },
        }

    # --- per (team, pos, stat) weekly multipliers, normalized to mean 1 ---
    def week_mults(team, pos, stat):
        sched = team_weeks.get(team, [])
        raw = [
            def_mults.get(g['opp'], {}).get(pos, {}).get(stat, 1.0)
            * (HOME_MULT if g['home'] else AWAY_MULT)
            for g in sched
        ]
        mean = (sum(raw) / len(raw)) if raw else 1.0
        return {g['w']: r / mean for g, r in zip(sched, raw)}

    # Display multiplier per (team, pos): the normalized fantasy-points factor.
    pos_mult = {}
    for team in sorted(team_weeks):
        pos_mult[team] = {}
        for pos in POSITIONS:
            m = week_mults(team, pos, 'pprPts')
            pos_mult[team][pos] = [
                round(m[w], 3) if w in m else None for w in range(1, WEEKS + 1)
            ]

    spread = dispersion([PRIOR, PRIOR - 1])
    hist = injury_history(PRIOR)
    current = current_injuries(SEASON)

    players = []
    for grp, pos in (('qbs', 'QB'), ('rbs', 'RB'), ('wrs', 'WR'), ('tes', 'TE')):
        for p in pool.get(grp, []):
            team, g = p.get('team'), p.get('games') or 0
            if not team or g <= 0 or team not in team_weeks:
                continue
            keys = POS_STATS[pos]
            base = {s: (num(p.get(POOL_FIELDS[s])) / g) for s in keys}
            if base.get('pprPts', 0) <= 0:
                continue

            mults = {s: week_mults(team, pos, s) for s in keys}
            wk = []
            for w in range(1, WEEKS + 1):
                if w not in mults['pprPts']:
                    wk.append(None)          # bye
                    continue
                wk.append([round(base[s] * mults[s][w], 2) for s in keys])

            ids = id_map.get((norm_name(p['name']), pos), {})
            gsis = ids.get('gsis')
            h = hist.get(gsis) if gsis else None
            durability = 1 - (h['missed'] / 17) if h else 1.0
            avail = AVAIL_POOL_W * (g / 17) + (1 - AVAIL_POOL_W) * durability
            cur = current.get(gsis) if gsis else None

            row = {
                'name': p['name'],
                'pos': pos,
                'team': team,
                'gsis': gsis,
                'sleeper': ids.get('sleeper'),
                'gp': g,
                'avail': round(min(max(avail, 0.0), 1.0), 3),
                'base': [round(base[s], 3) for s in keys],
                'wk': wk,
            }
            if cur:
                # A current-season report supersedes the season-level number
                # for the week it covers; `avail` stays the season baseline.
                row['injury'] = {'status': cur['status'], 'detail': cur['injury'],
                                 'week': cur['week'], 'pPlay': cur['p']}
            elif h and h['missed']:
                row['injury'] = {'priorMissed': h['missed']}
            players.append(row)

    players.sort(key=lambda r: -(r['base'][POS_STATS[r['pos']].index('pprPts')]))

    byes = {t: next((w for w in range(1, WEEKS + 1)
                     if all(g['w'] != w for g in wks)), None)
            for t, wks in team_weeks.items()}

    blend_note = (
        f'{SEASON} weeks 1-{cur_weeks} blended at {w_cur:.0%} over {PRIOR}'
        if cur_weeks else f'{PRIOR} only (no {SEASON} weeks yet; blends '
        f'in-season at n/(n+{BLEND_K}))'
    )
    out = {
        'season': SEASON,
        'priorSeason': PRIOR,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'baseGeneratedAt': pool.get('generatedAt'),
        'weeks': WEEKS,
        'note': (
            'Weekly stat-line projections and prop inputs. Each weekly line is '
            'the season pool projection per game x the opponent def-vs-position-'
            f'vs-stat multiplier ({blend_note}; deviation shrunk to '
            f'{SHRINK_VOLUME:.0%}/{SHRINK_YARDS:.0%}/{SHRINK_SCORE:.0%} of '
            f'observed for volume/yardage/scoring stats, clamped '
            f'[{MULT_MIN},{MULT_MAX}]) x home/away ({HOME_MULT}/{AWAY_MULT}), '
            'normalized per (team, pos, stat) to mean 1.0 across the team\'s '
            'scheduled games so weekly numbers sum back to the season line. '
            'null = bye week. Lines are conditional on playing; `avail` is the '
            'probability he suits up in a given week (pool games share blended '
            'with prior-season injury-report durability); when the current '
            'season\'s report covers him, `injury.pPlay` supersedes it for '
            'that week. `dispersion` carries the weekly spread '
            'around each mean: counting stats are negative binomial '
            '(var = mu + mu^2/k), yardage stats use the coefficient of variation; '
            '`src` says whether the cell was estimated for that position, pooled across positions, or fell back to a default '
            '- feed both into src/lib/playerProps.ts (or stathead.props) to get '
            'prop lines and over/under probabilities. `defense` is strength of '
            'matchup three ways: overall (EPA/play + points allowed, graded '
            '0-100 where 100 = toughest), by fantasy position (PPR allowed per '
            'game vs league average) and by stat (the multipliers above). '
            'K and DST are not covered here - see weekly-projections-<season>.json.'
        ),
        'statKeys': {pos: list(keys) for pos, keys in POS_STATS.items()},
        'countStats': sorted(COUNT_STATS),
        'dispersion': spread,
        'defense': defense,
        'teamWeeks': team_weeks,
        'byeWeeks': byes,
        'posMult': pos_mult,
        'players': players,
    }

    path = os.path.join(DATA, f'player-props-{SEASON}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    kb = os.path.getsize(path) / 1024
    print(f'Wrote {path} ({kb:.0f} KB): {len(players)} players, '
          f'{len(defense)} defenses, {len(team_weeks)} teams')

    # Sanity: weekly stat lines must sum back to the season pool line.
    for p in players[:3]:
        keys = POS_STATS[p['pos']]
        i = keys.index('pprPts')
        s = sum(w[i] for w in p['wk'] if w)
        n = sum(1 for w in p['wk'] if w)
        print(f"  {p['name']} ({p['team']} {p['pos']}): base {p['base'][i]} ppg, "
              f"weekly sum {s:.1f} vs {p['base'][i] * n:.1f} over {n} games, "
              f"avail {p['avail']}")


if __name__ == '__main__':
    main()
