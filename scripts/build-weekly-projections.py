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


# Once current-season weeks accumulate, blend the current season's def-vs-pos
# signal over the prior season's: weight = n_weeks / (n_weeks + BLEND_K).
BLEND_K = 6

# K / DST season projections: league average + a shrunk fraction of the
# team's prior-season deviation (kicker points track offense quality, which
# is moderately stable; DST fantasy signal is weaker).
K_SHRINK = 0.50
DST_SHRINK = 0.40

# IDP matchup. How much an OFFENSE concedes to each defensive bucket varies a
# lot within a season — 43% between the easiest and hardest offense for DL, 38%
# for LB, 29% for DB — but barely repeats across seasons: yoy r = +0.25 (DL),
# +0.24 (LB), +0.08 (DB) over 2016-2025. Each keep below is the RMSE-minimising
# value on that measurement, so the DB multiplier is nearly flat by design.
# Once current-season weeks accumulate they blend in on the same BLEND_K curve
# as everything else, and that is where this actually earns its place.
IDP_BUCKETS = ('DL', 'LB', 'DB')
IDP_KEEP = {'DL': 0.24, 'LB': 0.24, 'DB': 0.08}
IDP_POS_BUCKET = {
    'DE': 'DL', 'DT': 'DL', 'NT': 'DL', 'DL': 'DL',
    'LB': 'LB', 'OLB': 'LB', 'ILB': 'LB', 'MLB': 'LB',
    'CB': 'DB', 'SAF': 'DB', 'FS': 'DB', 'SS': 'DB', 'DB': 'DB', 'S': 'DB',
}
# The default IDP catalog build-idp-projections.py rolls up under, so the
# weekly feed and the season board quote one number.
IDP_POINTS = {'tackle': 1.0, 'sack': 2.0, 'int': 3.0, 'fum_rec': 2.0,
              'def_td': 6.0, 'safety': 2.0}
# Weekly strips for the top N defenders in EACH bucket. A flat points cut looks
# simpler but mixes the buckets badly: under tackle-1 scoring a DB or LB clears
# any threshold a pass-rushing DL cannot, so 40 points kept 181 DBs and 45 DL.
# The cut is by the DEFAULT catalog (tackle 1, sack 2, ...), which undervalues
# pass rushers: Micah Parsons ranks LB #69 on tackle-weighted points and would
# have been dropped from the weekly feed entirely, though any sack-heavy league
# starts him. 96 apiece keeps that kind of player while staying small; the
# season board (get_projections) carries all 963 for re-scoring.
IDP_TOP_PER_BUCKET = 96

# Standard DST points-allowed brackets: (max points allowed, fantasy pts).
PA_BRACKETS = ((0, 10), (6, 7), (13, 4), (20, 1), (27, 0), (34, -1), (999, -4))


def pa_points(allowed):
    for cap, pts in PA_BRACKETS:
        if allowed <= cap:
            return pts
    return -4


def load_json(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def iter_csv_rows(base):
    """Yield rows from public/data/<base>.csv, preferring the
    freshly-downloaded .csv (CI) over the committed .csv.gz snapshot.
    Yields nothing when neither exists."""
    plain = os.path.join(DATA, f'{base}.csv')
    gz = os.path.join(DATA, f'{base}.csv.gz')
    if os.path.exists(plain):
        with open(plain, newline='') as f:
            yield from csv.DictReader(f)
    elif os.path.exists(gz):
        with gzip.open(gz, 'rt') as f:
            yield from csv.DictReader(f)


def iter_weekly_rows(season):
    yield from iter_csv_rows(f'player_stats_{season}')


def def_ratios(season):
    """(team, pos) -> PPR-allowed-per-game ratio vs league average for a
    season's REG weeks, plus the number of defense-weeks observed."""
    pts = defaultdict(float)            # (def_team, pos) -> total PPR allowed
    games = defaultdict(set)            # def_team -> {game weeks}
    for row in iter_weekly_rows(season):
        if row.get('season_type') != 'REG':
            continue
        pos = row.get('position')
        opp = row.get('opponent_team')
        if pos not in POSITIONS or not opp:
            continue
        pts[(opp, pos)] += float(row.get('fantasy_points_ppr') or 0)
        games[opp].add(row.get('week'))
    if not games:
        return {}, 0
    per_game = {k: total / (len(games[k[0]]) or 1) for k, total in pts.items()}
    ratios = {}
    for pos in POSITIONS:
        vals = [per_game[(t, pos)] for t in games if (t, pos) in per_game]
        avg = sum(vals) / len(vals)
        for t in games:
            ratios[(t, pos)] = per_game.get((t, pos), avg) / avg
    n_weeks = max(len(w) for w in games.values())
    return ratios, n_weeks


def idp_concede_ratios(season):
    """(offense, bucket) -> IDP points that offense concedes per game, as a
    ratio to the league average, plus the number of weeks observed. The
    defender's `opponent_team` IS the offense being scored against."""
    pts = defaultdict(float)
    games = defaultdict(set)
    for row in iter_weekly_rows(season):
        if row.get('season_type') != 'REG':
            continue
        bucket = IDP_POS_BUCKET.get(row.get('position') or '')
        opp = row.get('opponent_team')
        if not bucket or not opp:
            continue
        f = lambda k: float(row.get(k) or 0)
        pts[(opp, bucket)] += (
            IDP_POINTS['tackle'] * (f('def_tackles_solo') + f('def_tackle_assists'))
            + IDP_POINTS['sack'] * f('def_sacks')
            + IDP_POINTS['int'] * f('def_interceptions')
            + IDP_POINTS['fum_rec'] * f('fumble_recovery_opp')
            + IDP_POINTS['def_td'] * f('def_tds')
            + IDP_POINTS['safety'] * f('def_safeties')
        )
        games[opp].add(row.get('week'))
    if not games:
        return {}, 0
    per_game = {k: total / (len(games[k[0]]) or 1) for k, total in pts.items()}
    ratios = {}
    for bucket in IDP_BUCKETS:
        vals = [per_game[(t, bucket)] for t in games if (t, bucket) in per_game]
        if not vals:
            continue
        avg = sum(vals) / len(vals)
        for t in games:
            ratios[(t, bucket)] = per_game.get((t, bucket), avg) / avg if avg else 1.0
    return ratios, max(len(w) for w in games.values())


def build_def_vs_pos():
    """Defense-vs-position multipliers: prior-season PPR allowed per game vs
    league average, blended with current-season numbers as weeks accumulate,
    shrunk toward 1.0 (defensive signal is weak) and clamped."""
    prior_ratios, _ = def_ratios(PRIOR)
    cur_ratios, cur_weeks = def_ratios(SEASON)
    w_cur = cur_weeks / (cur_weeks + BLEND_K) if cur_weeks else 0.0

    mults = {}
    teams = {t for t, _ in prior_ratios} | {t for t, _ in cur_ratios}
    for t in teams:
        for pos in POSITIONS:
            prior = prior_ratios.get((t, pos), 1.0)
            cur = cur_ratios.get((t, pos), prior)
            ratio = (1 - w_cur) * prior + w_cur * cur
            m = 1 + DEF_SHRINK * (ratio - 1)
            mults.setdefault(t, {})[pos] = round(max(MULT_MIN, min(MULT_MAX, m)), 3)
    return mults, w_cur, cur_weeks


def build_id_map():
    """(normalized name, pos) -> {gsis, sleeper} from the player crosswalk,
    including alternate names, so projection rows carry stable ids."""
    def norm(s):
        s = s.lower().replace('.', '').replace("'", '')
        for suf in (' jr', ' sr', ' iii', ' ii', ' iv', ' v'):
            if s.endswith(suf):
                s = s[: -len(suf)]
        return ' '.join(s.split())

    ids = {}
    for r in load_json('player-crosswalk.json').get('players', []):
        pos = r.get('position')
        if pos not in POSITIONS + ('K',):
            continue
        rec = {'gsis': r.get('gsis_id') or None, 'sleeper': r.get('sleeper_id') or None}
        names = {r.get('display_name') or ''} | set(r.get('all_names') or [])
        for n in names:
            if n:
                ids.setdefault((norm(n), pos), rec)
    return ids, norm


def game_opponents(season):
    """(team, week) -> (opponent, points_allowed) for completed REG games."""
    out = {}
    for g in iter_csv_rows('games'):
        if g.get('season') != str(season) or g.get('game_type') != 'REG':
            continue
        try:
            hs, aw = int(g['home_score']), int(g['away_score'])
        except (ValueError, TypeError):
            continue  # unplayed
        w = g['week']
        out[(g['home_team'], w)] = (g['away_team'], aw)
        out[(g['away_team'], w)] = (g['home_team'], hs)
    return out


def unit_week_points(season):
    """Per-(team, week) kicker and DST fantasy points for a season's
    completed REG games (standard scoring), plus per-kicker totals.

    Kicker: FG 0-39 = 3, 40-49 = 4, 50+ = 5, XP = 1.
    DST: sack 1, INT 2, opponent-fumble recovery 2, def/ST TD 6, safety 2,
    plus the standard points-allowed bracket (final opponent score).
    """
    opp = game_opponents(season)
    k_team = defaultdict(float)                 # (team, wk) -> K pts
    k_player = defaultdict(lambda: [0.0, 0])    # kicker name -> [pts, games]
    dst_raw = defaultdict(float)                # (team, wk) -> DST pts pre-PA
    for row in iter_weekly_rows(season):
        if row.get('season_type') != 'REG':
            continue
        team, wk = row.get('team'), row.get('week')
        if not team or (team, wk) not in opp:
            continue

        def g(c):
            return float(row.get(c) or 0)
        if row.get('position') == 'K':
            pts = (3 * (g('fg_made_0_19') + g('fg_made_20_29') + g('fg_made_30_39'))
                   + 4 * g('fg_made_40_49')
                   + 5 * (g('fg_made_50_59') + g('fg_made_60_'))
                   + g('pat_made'))
            k_team[(team, wk)] += pts
            name = row.get('player_display_name') or row.get('player_name')
            if name:
                k_player[name][0] += pts
                k_player[name][1] += 1
        dst_raw[(team, wk)] += (g('def_sacks') + 2 * g('def_interceptions')
                                + 2 * g('fumble_recovery_opp') + 6 * g('def_tds')
                                + 2 * g('def_safeties') + 6 * g('special_teams_tds'))
    dst = {}
    for key, base in dst_raw.items():
        dst[key] = base + pa_points(opp[key][1])
    return k_team, dst, k_player, opp


def per_game_and_ratio(points_by_teamweek, by_key=None):
    """Aggregate (team, wk) -> pts into per-game averages and ratios vs the
    league average. by_key remaps each (team, wk) to a different team first
    (e.g. credit kicker points to the DEFENSE that allowed them)."""
    tot = defaultdict(float)
    games = defaultdict(int)
    for (team, wk), pts in points_by_teamweek.items():
        key = by_key((team, wk)) if by_key else team
        if key is None:
            continue
        tot[key] += pts
        games[key] += 1
    if not games:
        return {}, {}, 0.0
    per_game = {t: tot[t] / games[t] for t in games}
    avg = sum(per_game.values()) / len(per_game)
    ratios = {t: (per_game[t] / avg if avg else 1.0) for t in per_game}
    return per_game, ratios, avg


def blend2(prior, cur, w_cur):
    """Blend two {key: value} maps at weight w_cur on the current one."""
    out = dict(prior)
    if w_cur and cur:
        for k in set(prior) | set(cur):
            p = prior.get(k, 1.0 if not prior else sum(prior.values()) / len(prior))
            c = cur.get(k, p)
            out[k] = (1 - w_cur) * p + w_cur * c
    return out


def starting_kickers(season):
    """team -> {name, gsis} for the newest depth-chart PK1 per team."""
    best = {}
    for r in iter_csv_rows(f'depth_charts_{season}'):
        if r.get('pos_abb') != 'PK':
            continue
        team = r.get('team')
        dt = r.get('dt') or ''
        try:
            rank = int(r.get('pos_rank') or 99)
        except ValueError:
            rank = 99
        cur = best.get(team)
        if not cur or dt > cur[0] or (dt == cur[0] and rank < cur[1]):
            best[team] = (dt, rank, r.get('player_name'), r.get('gsis_id') or None)
    return {t: {'name': v[2], 'gsis': v[3]} for t, v in best.items()}


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
    def_vs_pos, w_cur, cur_weeks = build_def_vs_pos()
    team_weeks = build_team_weeks(schedule)
    id_map, norm = build_id_map()

    # K + DST: team-week fantasy points (prior + current season), converted to
    # opponent multipliers on the same shrink/clamp scale as the skill spots.
    #  - defVsPos[T]['K']   = kicker points DEFENSE T allows, vs league avg
    #  - defVsPos[T]['DST'] = DST points OFFENSE T concedes, vs league avg
    k_prior, dst_prior, k_player_prior, opp_prior = unit_week_points(PRIOR)
    k_cur, dst_cur, _kp_cur, opp_cur = unit_week_points(SEASON)
    _, k_allow_prior, _ = per_game_and_ratio(k_prior, lambda tw: opp_prior[tw][0])
    _, k_allow_cur, _ = per_game_and_ratio(k_cur, lambda tw: opp_cur[tw][0] if tw in opp_cur else None)
    _, dst_conc_prior, _ = per_game_and_ratio(dst_prior, lambda tw: opp_prior[tw][0])
    _, dst_conc_cur, _ = per_game_and_ratio(dst_cur, lambda tw: opp_cur[tw][0] if tw in opp_cur else None)
    for team, ratio in blend2(k_allow_prior, k_allow_cur, w_cur).items():
        m = 1 + DEF_SHRINK * (ratio - 1)
        def_vs_pos.setdefault(team, {})['K'] = round(max(MULT_MIN, min(MULT_MAX, m)), 3)
    for team, ratio in blend2(dst_conc_prior, dst_conc_cur, w_cur).items():
        m = 1 + DEF_SHRINK * (ratio - 1)
        def_vs_pos.setdefault(team, {})['DST'] = round(max(MULT_MIN, min(MULT_MAX, m)), 3)

    # IDP: how much each OFFENSE concedes to DL / LB / DB, blended prior +
    # current season and shrunk by the bucket's own measured persistence.
    idp_prior, _ = idp_concede_ratios(PRIOR)
    idp_cur, _ = idp_concede_ratios(SEASON)
    for team in {t for t, _ in idp_prior} | {t for t, _ in idp_cur}:
        for bucket in IDP_BUCKETS:
            prior = idp_prior.get((team, bucket), 1.0)
            cur = idp_cur.get((team, bucket), prior)
            ratio = (1 - w_cur) * prior + w_cur * cur
            m = 1 + IDP_KEEP[bucket] * (ratio - 1)
            def_vs_pos.setdefault(team, {})[bucket] = round(max(MULT_MIN, min(MULT_MAX, m)), 3)

    # Season-level K / DST projections: league avg + shrunk team deviation.
    k_team_pg_prior, _, k_avg = per_game_and_ratio(k_prior)
    k_team_pg_cur, _, _ = per_game_and_ratio(k_cur)
    k_team_pg = blend2(k_team_pg_prior, k_team_pg_cur, w_cur)
    dst_pg_prior, _, dst_avg = per_game_and_ratio(dst_prior)
    dst_pg_cur, _, _ = per_game_and_ratio(dst_cur)
    dst_pg = blend2(dst_pg_prior, dst_pg_cur, w_cur)
    kickers = starting_kickers(SEASON)

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
            ids = id_map.get((norm(p['name']), pos), {})
            players.append({
                'name': p['name'],
                'pos': pos,
                'team': p['team'],
                'gsis': ids.get('gsis'),
                'sleeper': ids.get('sleeper'),
                'gp': g,
                'ppg': round(ppg, 2),
                'recPG': round(rec_pg, 2),
                'wk': wk,
            })

    # K rows: prefer the component build (scripts/build-kicker-projections.py),
    # which projects FG attempts/makes by distance band plus extra points and
    # rolls them up under this same scoring. Using it here keeps one kicker
    # number across the weekly feed, the season board and the components, rather
    # than two that disagree. Falls back to the old team-context scalar (league
    # average + shrunk team deviation, blended with the kicker's own prior) when
    # the artifact is absent.
    kproj = {}
    try:
        with open(os.path.join(DATA, f'kicker-projections-{SEASON}.json')) as fh:
            kdoc = json.load(fh)
        kproj = {r['team']: r for r in kdoc.get('kickers', []) if r.get('team')}
    except Exception:
        kproj = {}
    for team in sorted(team_weeks):
        team_ppg = k_avg + K_SHRINK * (k_team_pg.get(team, k_avg) - k_avg)
        k = kickers.get(team) or {}
        name = k.get('name') or f'{team} K'
        own = k_player_prior.get(name)
        ppg = (0.5 * (own[0] / own[1]) + 0.5 * team_ppg) if own and own[1] >= 8 else team_ppg
        if team in kproj:
            ppg = kproj[team]['ppg']
            name = kproj[team].get('name') or name
        mults = week_mults(team, 'K')
        ids = id_map.get((norm(name), 'K'), {})
        players.append({
            'name': name,
            'pos': 'K',
            'team': team,
            'gsis': k.get('gsis') or ids.get('gsis'),
            'sleeper': ids.get('sleeper'),
            'gp': 17,
            'ppg': round(ppg, 2),
            'recPG': 0.0,
            'wk': [round(ppg * mults[w], 2) if w in mults else None for w in range(1, WEEKS + 1)],
        })

    # DST rows: one per team. Sleeper's DST ids are the team codes themselves.
    # Prefer the component build (scripts/build-dst-projections.py) so the
    # weekly feed, the season board and the components quote one number; falls
    # back to the team-context scalar when the artifact is absent.
    dproj = {}
    try:
        with open(os.path.join(DATA, f'dst-projections-{SEASON}.json')) as fh:
            dproj = {r['team']: r for r in json.load(fh).get('defenses', []) if r.get('team')}
    except Exception:
        dproj = {}
    for team in sorted(team_weeks):
        ppg = dst_avg + DST_SHRINK * (dst_pg.get(team, dst_avg) - dst_avg)
        if team in dproj:
            ppg = dproj[team]['ppg']
        mults = week_mults(team, 'DST')
        players.append({
            'name': f'{team} DST',
            'pos': 'DST',
            'team': team,
            'gsis': None,
            'sleeper': team,
            'gp': 17,
            'ppg': round(ppg, 2),
            'recPG': 0.0,
            'wk': [round(ppg * mults[w], 2) if w in mults else None for w in range(1, WEEKS + 1)],
        })

    # IDP rows: the season components build (scripts/build-idp-projections.py)
    # split across the schedule, so the weekly feed and the season board quote
    # one number. Only the top IDP_TOP_PER_BUCKET of each bucket — a weekly
    # strip for a projected 12-point season is noise, and there are hundreds.
    iproj = []
    try:
        with open(os.path.join(DATA, f'idp-projections-{SEASON}.json')) as fh:
            iproj = json.load(fh).get('players', [])
    except Exception:
        iproj = []
    by_bucket = defaultdict(list)
    for r in iproj:
        if r.get('team') and r.get('pos') in IDP_BUCKETS and (r.get('ppg') or 0) > 0:
            by_bucket[r['pos']].append(r)
    keep = []
    for bucket, rows in by_bucket.items():
        rows.sort(key=lambda r: -(r.get('projPts') or 0))
        keep.extend(rows[:IDP_TOP_PER_BUCKET])
    for r in keep:
        team, bucket = r['team'], r['pos']
        ppg = r['ppg']
        mults = week_mults(team, bucket)
        players.append({
            'name': r['name'],
            'pos': bucket,
            'team': team,
            'gsis': r.get('gsis'),
            'sleeper': r.get('sleeper'),
            'gp': r.get('games') or 0,
            'ppg': round(ppg, 2),
            'recPG': 0.0,
            'wk': [round(ppg * mults[w], 2) if w in mults else None for w in range(1, WEEKS + 1)],
        })

    # ── Schedule strength artifact ────────────────────────────────────────
    # Published separately because week_mults normalizes its multipliers to
    # mean 1: they redistribute points between weeks and can never move a
    # season total. That is deliberate for skill players (the projection pool
    # owns their season line), so the SEASON-level schedule effect is not
    # applied to QB/RB/WR/TE anywhere — it is emitted here instead, for
    # consumers that want to apply it themselves.
    #
    # K and DST are different: their season lines come from
    # build-kicker-projections.py / build-dst-projections.py, which DO apply
    # this at season level, so their factors below are already reflected in
    # the projections and must not be applied a second time.
    #
    # factor > 1 means an easier schedule for that position (opponents concede
    # more). Derived from the same def_vs_pos the weekly multipliers use, so
    # published and applied numbers can never drift.
    SS_POSITIONS = list(POSITIONS) + ['K', 'DST'] + list(IDP_BUCKETS)
    strength = {}
    for team, sched in team_weeks.items():
        per_pos = {}
        for pos in SS_POSITIONS:
            vals = [def_vs_pos.get(g['opp'], {}).get(pos, 1.0) for g in sched]
            if vals:
                per_pos[pos] = round(sum(vals) / len(vals), 4)
        strength[team] = {
            'season': per_pos,
            'games': [
                {'week': g['w'], 'opp': g['opp'], 'home': g['home'],
                 'factors': {pos: def_vs_pos.get(g['opp'], {}).get(pos, 1.0)
                             for pos in SS_POSITIONS}}
                for g in sched
            ],
        }
    ss_doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'note': (
            'Strength of schedule per team, per position, for every game. '
            'factor > 1 = easier (opponents concede more of that position). '
            'Season factors are the mean over that team\'s games. IMPORTANT: '
            'these are ALREADY APPLIED to K and DST projections (their season '
            'lines are built here), but NOT to QB/RB/WR/TE — the weekly '
            'multipliers for skill players are normalized to mean 1, so the '
            'season-level effect is deliberately left out of the projection '
            'pool. Apply the skill-position factors yourself if you want them; '
            'do not re-apply the K/DST ones. DL/LB/DB factors follow the same '
            'rule as the skill positions: published here, normalized out of the '
            'weekly IDP strip, never applied to the season line. They are '
            'deliberately close to 1 — how much an offense concedes to a '
            'defensive bucket barely repeats year over year (r = +0.25 DL, '
            '+0.24 LB, +0.08 DB), so the multiplier is shrunk to that.'
        ),
        'appliedInProjections': ['K', 'DST'],
        'notAppliedInProjections': list(POSITIONS) + list(IDP_BUCKETS),
        'teams': strength,
    }
    ss_path = os.path.join(DATA, f'schedule-strength-{SEASON}.json')
    with open(ss_path, 'w') as fh:
        json.dump(ss_doc, fh, separators=(',', ':'))
        fh.write('\n')
    print(f'Wrote {ss_path}: {len(strength)} teams x {len(SS_POSITIONS)} positions')

    players.sort(key=lambda r: -r['ppg'])
    blend_note = (
        f'def-vs-pos blends {SEASON} weeks 1-{cur_weeks} at {w_cur:.0%} over {PRIOR}'
        if cur_weeks else f'def-vs-pos from {PRIOR} (no {SEASON} weeks yet; '
        f'blends in-season at n/(n+{BLEND_K}))'
    )
    out = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'baseGeneratedAt': pool.get('generatedAt'),
        'note': (
            f'Weekly per-game PPR projections: season ppg x opponent def-vs-pos '
            f'multiplier (PPR allowed/gm vs league avg — {blend_note} — deviation '
            f'shrunk to {DEF_SHRINK:.0%} of observed, clamped [{MULT_MIN},{MULT_MAX}]) x '
            f'home/away ({HOME_MULT}/{AWAY_MULT}), '
            f'normalized to mean 1.0 per team so weeks sum to the season line. '
            f'null = bye. Points assume the player plays; gp carries the season '
            f'games discount. Half/Std: pts - 0.5*rec or pts - rec, where weekly '
            f'rec scales with the same multiplier (rec_w = recPG * pts_w / ppg). '
            f'gsis/sleeper ids stamped from the player crosswalk (null when the '
            f'player has no NFL gsis yet). K/DST (one per team): season line = '
            f'league avg + shrunk team deviation ({K_SHRINK}/{DST_SHRINK}); K rows '
            f'use the current depth-chart PK1 (own prior PPG blended 50/50 when '
            f'>=8 games); K scoring FG 3/4/5 by distance + XP; DST scoring '
            f'sack 1 / INT 2 / fum rec 2 / TD 6 / safety 2 + standard '
            f'points-allowed brackets; defVsPos[T].K = K pts defense T allows, '
            f'defVsPos[T].DST = DST pts offense T concedes. Sleeper DST id = '
            f'team code. IDP (DL/LB/DB, top {IDP_TOP_PER_BUCKET} per bucket by '
            f'default-catalog points): the season component build split across '
            f'the schedule, scored tackle 1 / sack 2 / INT 3 / fum rec 2 / '
            f'TD 6 / safety 2 — re-price from the components on the season '
            f'board. The IDP matchup swing is small by construction: how much '
            f'an offense concedes to a bucket barely repeats year over year '
            f'(r = +0.25 DL, +0.24 LB, +0.08 DB), so the deviation is kept at '
            f'{IDP_KEEP["DL"]:.0%}/{IDP_KEEP["LB"]:.0%}/{IDP_KEEP["DB"]:.0%} of '
            f'observed and sharpens as in-season weeks blend in.'
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
