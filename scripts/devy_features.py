"""College-profile features for devy (college) players, shared by
scripts/train_devy_model.py (history) and scripts/build-devy-rankings.py
(current players), so both compute them the same way.

A "snapshot" is a player's profile as of the end of college season S, with
k = draft_year - 1 - S college seasons still to play before he is draft
eligible (k=0: his final season is in; k=1: one to go, e.g. a 2027 prospect
after the 2025 season). Only seasons <= S are read, so a snapshot never sees
the future.

Inputs (public/data/cfbd, CollegeFootballData): player-season-<year>.json
(long rows: season, player_id, player, position, team, category, stat_type,
stat), recruiting-<year>.json (athlete_id = player_id), team-talent-<year>.json.
"""
from __future__ import annotations

import gzip
import json
import os
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from devy_names import norm_name  # noqa: F401  (re-exported)
from devy_stats import STATS  # shared with fetch_cfbd_inseason.py

CFBD = Path('public/data/cfbd')
POSITIONS = ('QB', 'RB', 'WR', 'TE')
NUM = list(STATS.values())


def raw_wide(years) -> pd.DataFrame:
    """One row per (player_id, season) with the NUM stat columns, from the raw
    per-year CFBD files (every position)."""
    frames = []
    for y in years:
        p = CFBD / f'player-season-{y}.json'
        if not p.exists():
            continue
        d = pd.DataFrame(json.load(open(p)))
        d = d[d['category'].isin(['passing', 'rushing', 'receiving', 'kickReturns', 'puntReturns', 'fumbles'])]
        d['col'] = [STATS.get((c, t)) for c, t in zip(d['category'], d['stat_type'])]
        d = d[d['col'].notna()]
        d['stat'] = pd.to_numeric(d['stat'], errors='coerce').fillna(0)
        w = d.pivot_table(index=['player_id', 'season'], columns='col', values='stat', aggfunc='sum').reset_index()
        meta = d.drop_duplicates(['player_id', 'season'])[['player_id', 'season', 'player', 'position', 'team', 'conference']]
        frames.append(w.merge(meta, on=['player_id', 'season']))
    return fix_positions(_fill(pd.concat(frames, ignore_index=True))) if frames else _fill(pd.DataFrame())


def fix_positions(w: pd.DataFrame) -> pd.DataFrame:
    """CFBD leaves the position blank ('?') on ~1,150 player-seasons, mostly
    2007-2018 and disproportionately productive ones (Nick Chubb, Sony Michel,
    Giovani Bernard), which dropped those players from every QB/RB/WR/TE
    filter. Fill it from the player's other seasons, else from the season's
    own stats (passing -> QB, carries over catches -> RB, catches -> WR; a TE
    reads as a WR). Never from the draft, which would leak the outcome."""
    q = w['position'].isin(['?', '', None]) | w['position'].isna()
    if not q.any():
        return w
    known = w.loc[~q & w['position'].notna()]
    mode = known.groupby('player_id')['position'].agg(lambda x: x.mode().iloc[0])
    fill = w.loc[q, 'player_id'].map(mode)
    by_stats = np.where(w.loc[q, 'pass_att'] >= 20, 'QB',
                        np.where(w.loc[q, 'rush_car'] > w.loc[q, 'rec'], 'RB',
                                 np.where(w.loc[q, 'rec'] > 0, 'WR', '?')))
    w.loc[q, 'position'] = fill.fillna(pd.Series(by_stats, index=fill.index))
    return w


def _fill(w: pd.DataFrame) -> pd.DataFrame:
    for c in NUM:
        if c not in w:
            w[c] = 0.0
    w[NUM] = w[NUM].astype(float).fillna(0.0)
    if len(w):
        w['player_id'] = w['player_id'].astype(str)
        w['season'] = w['season'].astype(int)
    return w


def load_seasons(years, extra: pd.DataFrame | None = None) -> pd.DataFrame:
    """One row per (player_id, season): offensive stats, team, position, and
    the team's totals for share features. Players at every position are kept
    so team totals are complete; callers filter to POSITIONS. `extra`: wide
    rows (raw_wide's shape) for more seasons, e.g. a season-to-date estimate;
    they replace any rows already loaded for those seasons."""
    w = raw_wide(years)
    if extra is not None and len(extra):
        w = pd.concat([w[~w['season'].isin(set(extra['season']))], _fill(extra.copy())], ignore_index=True)
    return derive(w)


def derive(s: pd.DataFrame) -> pd.DataFrame:
    """Team totals, shares and rates for wide season rows."""
    s = s.copy()
    team = s.groupby(['team', 'season'])[['pass_yds', 'pass_td', 'rush_yds', 'rush_td', 'rec_yds', 'rec_td',
                                          'pass_att', 'rush_car', 'rec']].sum()
    team.columns = ['tm_' + c for c in team.columns]
    s = s.merge(team.reset_index(), on=['team', 'season'], how='left')
    # Shares of the team's offense. Receiving: the "dominator" (yards + TDs).
    s['rec_yds_sh'] = s['rec_yds'] / s['tm_rec_yds'].clip(lower=1)
    s['rec_td_sh'] = s['rec_td'] / s['tm_rec_td'].clip(lower=1)
    s['dominator'] = (s['rec_yds_sh'] + s['rec_td_sh']) / 2
    s['rush_yds_sh'] = s['rush_yds'] / s['tm_rush_yds'].clip(lower=1)
    s['scrim_yds'] = s['rush_yds'] + s['rec_yds']
    s['scrim_td'] = s['rush_td'] + s['rec_td']
    s['pass_ypa'] = np.where(s['pass_att'] > 0, s['pass_yds'] / s['pass_att'].clip(lower=1), 0.0)
    s['pass_cmp_pct'] = np.where(s['pass_att'] > 0, s['pass_cmp'] / s['pass_att'].clip(lower=1), 0.0)
    s['pass_td_rate'] = np.where(s['pass_att'] > 0, (s['pass_td'] - s['pass_int']) / s['pass_att'].clip(lower=1), 0.0)
    s['ypc'] = np.where(s['rush_car'] >= 10, s['rush_yds'] / s['rush_car'].clip(lower=1), 0.0)
    s['ypr'] = np.where(s['rec'] >= 5, s['rec_yds'] / s['rec'].clip(lower=1), 0.0)
    s['ret_yds'] = s['kr_yds'] + s['pr_yds']
    s['tm_pass_rate'] = s['tm_pass_att'] / (s['tm_pass_att'] + s['tm_rush_car']).clip(lower=1)
    # Target competition: the best dominator among his teammates that season.
    grp = s.groupby(['team', 'season'])['dominator']
    first = grp.transform('max')
    second = grp.transform(lambda x: x.nlargest(2).iloc[-1] if len(x) > 1 else 0.0)
    s['teammate_best_dom'] = np.where(s['dominator'] >= first, second, first)
    return s


def snake_keys(d):
    """camelCase keys -> snake_case, recursively. The CFBD v5 client writes
    camelCase (recruiting-2026.json); the older files are snake_case."""
    if isinstance(d, dict):
        return {re.sub(r'(?<!^)(?=[A-Z])', '_', k).lower(): snake_keys(v) for k, v in d.items()}
    if isinstance(d, list):
        return [snake_keys(v) for v in d]
    return d


# Recruit -> player. CFBD leaves athlete_id empty on ~half its recruits
# (Demond Williams Jr., a 4-star, among them), which dropped their rating and
# stars and dated their age from the first CFBD season instead of the
# recruiting class. Link those by name: a player whose first CFBD season is
# within three years of the class, at the school he committed to, else the
# only such player at a compatible position. Checked on recruits CFBD does
# link (hide the id, rerun): 97.6% right on the school match, 89% on name
# alone (before the position check).
RECRUIT_POS = {'PRO': 'QB', 'DUAL': 'QB', 'QB': 'QB', 'RB': 'RB', 'APB': 'RB', 'WR': 'WR', 'TE': 'TE'}


@lru_cache(maxsize=1)
def _first_seasons() -> dict:
    """norm_name -> [(player_id, first season, first team, position)] over
    every CFBD season on disk (the in-progress one included)."""
    first = {}
    files = sorted(CFBD.glob('player-season-*.json')) + sorted((CFBD / 'inseason').glob('player-season-*.json.gz'))
    for p in files:
        d = json.load(gzip.open(p) if p.suffix == '.gz' else open(p))
        rows = snake_keys(d['rows']) if isinstance(d, dict) else d
        for r in rows:
            pid = str(r['player_id'])
            y = int(r['season'])
            if pid not in first or y < first[pid][0]:
                first[pid] = (y, r.get('team'), r.get('player'), r.get('position'))
    idx = {}
    for pid, (y, team, name, pos) in first.items():
        idx.setdefault(norm_name(name), []).append((pid, y, team, pos))
    return idx


def _link_recruit(r: dict, rclass: int) -> str:
    if os.environ.get('DEVY_RECRUIT_LINK', '1') == '0':  # off switch, for comparisons
        return ''
    cand = [c for c in _first_seasons().get(norm_name(r.get('name') or ''), []) if rclass <= c[1] <= rclass + 3]
    same = [c for c in cand if c[2] == r.get('committed_to')]
    if len(same) == 1:
        return same[0][0]
    want = RECRUIT_POS.get(r.get('position'))
    cand = [c for c in cand if want is None or c[3] in (want, '?', None)]
    return cand[0][0] if len(cand) == 1 else ''


@lru_cache(maxsize=1)
def _espn_entry() -> dict:
    """cfbdId -> latest possible entry season from ESPN (college-entry.json,
    scripts/fetch_espn_college_entry.py): his first stat-log season, any
    division, and season - class + 1 while active."""
    p = CFBD / 'college-entry.json'
    if not p.exists() or os.environ.get('DEVY_ESPN_ENTRY', '1') == '0':  # off switch, for comparisons
        return {}
    out = {}
    for pid, e in json.load(open(p))['players'].items():
        c = [e['log']] if e.get('log') else []
        if e.get('cls') and e.get('clsSeason'):
            c.append(e['clsSeason'] - e['cls'] + 1)
        if c:
            out[pid] = min(c)
    return out


# A stat log or class that puts him in college more than four years before
# his first CFBD season is more likely a data error than a career.
MAX_ENTRY_SHIFT = 4


def college_entry(pid: str, seasons: pd.DataFrame) -> int | None:
    """First college season for a player WITHOUT a recruiting record: his
    first CFBD season, or earlier where ESPN shows seasons CFBD does not carry
    (Division II, JUCO) or a class that implies a redshirt."""
    first = int(seasons['season'].min()) if len(seasons) else None
    e = _espn_entry().get(str(pid))
    if first is None:
        return e
    if e is None:
        return first
    return max(min(first, e), first - MAX_ENTRY_SHIFT)


@lru_cache(maxsize=1)
def _pid_names() -> dict:
    return {pid: name for name, v in _first_seasons().items() for pid, _, _, _ in v}


def _names_agree(a: str, b: str) -> bool:
    """Same person by name: surnames contain one another (Lendsey-Vann / Vann)
    and first names share an initial (Rob / Robert, CJ / Clinton)."""
    ta, tb = a.split(), b.split()
    if not ta or not tb:
        return False
    sa, sb = a.replace(' ', ''), b.replace(' ', '')
    return (ta[-1] in sb or tb[-1] in sa) and ta[0][0] == tb[0][0]


def _recruit_id(r: dict, rclass: int) -> str:
    """CFBD's athlete_id, unless it names a player with another name: CFBD put
    Roydell Williams's id (FSU, in college since 2020) on Hykeem Williams's 2023
    5-star record, which made Roydell a 21-year-old elite recruit. Such a
    record, or one whose id has no stats (an old id: Roydell's own record), is
    linked by name instead (_link_recruit); an id with no stats and no name
    match is kept (a recruit yet to play)."""
    a = str(r.get('athlete_id') or '')
    if not a:
        return _link_recruit(r, rclass)
    if os.environ.get('DEVY_RECRUIT_LINK', '1') == '0' or os.environ.get('DEVY_RECRUIT_GUARD', '1') == '0':
        return a
    have = _pid_names().get(a)
    if have is None:
        return _link_recruit(r, rclass) or a
    if _names_agree(norm_name(r.get('name') or ''), have):
        return a
    return _link_recruit(r, rclass)


def load_recruits(years) -> pd.DataFrame:
    rows = []
    for y in years:
        p = CFBD / f'recruiting-{y}.json'
        if p.exists():
            for r in map(snake_keys, json.load(open(p))):
                if r.get('recruit_type', 'HighSchool') != 'HighSchool':
                    continue
                rows.append({'player_id': _recruit_id(r, y), 'rname': r.get('name'),
                             'state': r.get('state_province'),
                             'rpos': r.get('position'), 'rclass': r.get('year'),
                             'stars': r.get('stars'), 'rating': r.get('rating'),
                             'rrank': r.get('ranking'), 'height': r.get('height'),
                             'weight': r.get('weight'), 'committed': r.get('committed_to')})
    r = pd.DataFrame(rows)
    if not len(r):
        return r
    # One row per athlete (a name is not unique: two Jeremiah Smiths, 2023 and
    # 2024); unlinked recruits keep one row per name and class.
    r['key'] = np.where(r['player_id'] != '', r['player_id'], r['rname'].fillna('') + '|' + r['rclass'].astype(str))
    r = r.sort_values('rating', ascending=False).drop_duplicates('key')
    # Missing grades / sizes as None, not NaN: callers default with `x or 0`,
    # and NaN is truthy (unrated recruits in the 2026 class).
    return r.astype(object).where(r.notna(), None)


def load_sp(years) -> dict:
    """(team, year) -> SP+ rating. Only FBS teams are rated, so membership is
    also the FBS flag: 3,000 FCS passing yards are not 3,000 SEC ones."""
    out = {}
    for y in years:
        p = CFBD / f'sp-ratings-{y}.json'
        if p.exists():
            for t in json.load(open(p)):
                if t.get('team') and t.get('rating') is not None:
                    out[(t['team'], t['year'])] = t['rating']
    return out


def load_team_games(years) -> dict:
    """(team, season) -> {'ppg': points per game, 'elo': mean pregame Elo}."""
    acc = {}
    for y in years:
        p = CFBD / f'games-{y}.json'
        if not p.exists():
            continue
        for g in json.load(open(p)):
            for side in ('home', 'away'):
                t, pts, elo = g.get(f'{side}_team'), g.get(f'{side}_points'), g.get(f'{side}_pregame_elo')
                if not t or pts is None:
                    continue
                a = acc.setdefault((t, int(g['season'])), [0.0, 0, 0.0, 0])
                a[0] += pts
                a[1] += 1
                if elo is not None:
                    a[2] += elo
                    a[3] += 1
    return {k: {'ppg': v[0] / v[1], 'elo': (v[2] / v[3]) if v[3] else None} for k, v in acc.items() if v[1]}


# Talent-rich recruiting states: a recruit there is ranked against the deepest
# competition.
TALENT_STATES = {'FL', 'TX', 'CA', 'GA', 'LA', 'AL', 'OH'}

# Features available for every season back to 2005 (so both models use them).
EXTRA_FEATURES = [
    'last_ypc', 'last_ypr', 'best_long', 'ret_yds_last', 'fum_lost_last',
    'tm_pass_rate_last', 'teammate_best_dom', 'n_teams', 'transferred',
    'last_third_down_usage', 'last_passing_downs_usage', 'last_standard_downs_usage',
    'team_ppg_last', 'team_elo_last', 'recruit_rank_log', 'talent_state',
]


def extra_features(s: pd.DataFrame, recruit: dict | None, usage: dict, games: dict, pid: str) -> dict:
    """EXTRA_FEATURES from season rows already cut at the snapshot season."""
    f = {c: 0.0 for c in EXTRA_FEATURES}
    rk = (recruit or {}).get('rrank')
    f['recruit_rank_log'] = float(np.log(rk)) if rk else float(np.log(4000))
    f['talent_state'] = float((recruit or {}).get('state') in TALENT_STATES)
    f['team_elo_last'] = 1200.0
    if not len(s):
        return f
    last = s.iloc[-1]
    ls = int(last['season'])
    f['last_ypc'] = float(last['ypc'])
    f['last_ypr'] = float(last['ypr'])
    f['best_long'] = float(max(s['rush_long'].max(), s['rec_long'].max()))
    f['ret_yds_last'] = float(last['ret_yds'])
    f['fum_lost_last'] = float(last['fum_lost'])
    f['tm_pass_rate_last'] = float(last['tm_pass_rate'])
    f['teammate_best_dom'] = float(last['teammate_best_dom'])
    teams = list(s['team'])
    f['n_teams'] = float(len(set(teams)))
    f['transferred'] = float(len(teams) >= 2 and teams[-1] != teams[-2])
    u = usage.get((pid, ls), {}) if usage else {}
    f['last_third_down_usage'] = float(u.get('third_down') or 0)
    f['last_passing_downs_usage'] = float(u.get('passing_downs') or 0)
    f['last_standard_downs_usage'] = float(u.get('standard_downs') or 0)
    tg = games.get((last['team'], ls)) if games else None
    if tg:
        f['team_ppg_last'] = float(tg['ppg'])
        f['team_elo_last'] = float(tg['elo'] or 1200.0)
    return f


def load_talent(years) -> dict:
    out = {}
    for y in years:
        p = CFBD / f'team-talent-{y}.json'
        if p.exists():
            for t in json.load(open(p)):
                out[(t['team'], t['year'])] = t['talent']
    return out


FEATURES = [
    'k', 'n_seasons', 'yrs_since_hs', 'stars', 'rating', 'height', 'weight', 'has_recruit',
    # best and last season
    'best_rec_yds', 'best_dominator', 'best_rush_yds', 'best_rush_yds_sh', 'best_scrim_yds',
    'best_pass_yds', 'best_pass_ypa', 'best_pass_td_rate',
    'last_rec_yds', 'last_dominator', 'last_rush_yds', 'last_scrim_yds', 'last_scrim_td',
    'last_pass_yds', 'last_pass_ypa', 'last_pass_cmp_pct', 'last_pass_td_rate', 'last_rush_car',
    # career per season, and the season-over-season jump
    'car_scrim_ypg', 'car_pass_ypg', 'jump_scrim', 'jump_pass',
    # breakout: seasons into his career of the first 20% dominator / 800 scrimmage / 2000 pass yds
    'breakout_n', 'talent_last',
    # level of competition: FBS (has an SP+ rating) and the team's SP+
    'fbs_last', 'fbs_share', 'sp_last',
]


def snapshot(seasons: pd.DataFrame, S: int, k: int, recruit: dict | None, talent: dict, sp: dict,
             usage: dict | None = None, games: dict | None = None, pid: str = '') -> dict:
    """Features for one player from his season rows (any order) as of season S."""
    s = seasons[seasons['season'] <= S].sort_values('season')
    f = {c: 0.0 for c in FEATURES}
    f.update(extra_features(s, recruit, usage or {}, games or {}, pid))
    f['k'] = k
    f['n_seasons'] = len(s)
    if recruit:
        f['has_recruit'] = 1.0
        f['stars'] = recruit.get('stars') or 0
        f['rating'] = recruit.get('rating') or 0
        f['height'] = recruit.get('height') or 0
        f['weight'] = recruit.get('weight') or 0
        if recruit.get('rclass'):
            f['yrs_since_hs'] = S - recruit['rclass'] + 1
    if not f['yrs_since_hs']:
        e = college_entry(pid, s)
        f['yrs_since_hs'] = S - e + 1 if e else len(s)
    if not len(s):
        return f
    last = s.iloc[-1]
    for c in ('rec_yds', 'dominator', 'rush_yds', 'rush_yds_sh', 'scrim_yds', 'pass_yds', 'pass_ypa', 'pass_td_rate'):
        f[f'best_{c}'] = float(s[c].max())
    for c in ('rec_yds', 'dominator', 'rush_yds', 'scrim_yds', 'scrim_td', 'pass_yds', 'pass_ypa',
              'pass_cmp_pct', 'pass_td_rate', 'rush_car'):
        f[f'last_{c}'] = float(last[c])
    f['car_scrim_ypg'] = float(s['scrim_yds'].sum() / len(s))
    f['car_pass_ypg'] = float(s['pass_yds'].sum() / len(s))
    if len(s) >= 2:
        f['jump_scrim'] = float(s['scrim_yds'].iloc[-1] - s['scrim_yds'].iloc[-2])
        f['jump_pass'] = float(s['pass_yds'].iloc[-1] - s['pass_yds'].iloc[-2])
    hit = s[(s['dominator'] >= 0.2) | (s['scrim_yds'] >= 800) | (s['pass_yds'] >= 2000)]
    f['breakout_n'] = float(len(s[s['season'] <= hit['season'].iloc[0]])) if len(hit) else 9.0
    f['talent_last'] = talent.get((last['team'], int(last['season'])), 0.0) or 0.0
    fbs = [(t, int(y)) in sp for t, y in zip(s['team'], s['season'])]
    f['fbs_last'] = float(fbs[-1])
    f['fbs_share'] = float(np.mean(fbs))
    f['sp_last'] = float(sp.get((last['team'], int(last['season'])), -30.0))
    return f


# ── Market (KTC devy value) features ─────────────────────────────────────
# What the devy market prices, as of the end of season S: age, breakout
# age, share of the offense, raw production, program and competition level,
# and recruiting pedigree (for freshmen nearly the only signal). CFBD, ESPN
# and KTC carry no college birthdates, so age is ESTIMATED: a high-school
# class of year R turns ~18.9 by the end of its first college season (R);
# without a recruiting record, from the first CFBD season. Redshirts and
# reclassified players are off by up to a year. Without a recruiting record,
# from college_entry (ESPN stat log and class, so a JUCO or Division II year
# counts).

P4 = {'SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'}

MARKET_FEATURES = [
    'pos_QB', 'pos_RB', 'pos_WR', 'pos_TE',
    'est_age', 'est_draft_age', 'k', 'n_seasons',
    'breakout_age', 'broke_out',
    'best_dominator', 'last_dominator', 'last_rec_yds_sh', 'last_rush_yds_sh', 'best_rush_yds_sh',
    'last_usage', 'best_usage', 'last_pass_usage', 'last_rush_usage',
    'last_rec', 'last_rec_yds', 'last_rec_td', 'last_rush_car', 'last_rush_yds', 'last_rush_td',
    'last_pass_att', 'last_pass_yds', 'last_pass_td', 'last_pass_int', 'last_pass_ypa',
    'car_rec_yds', 'car_rush_yds', 'car_pass_yds', 'car_td',
    'talent_last', 'p4_last', 'sp_last', 'sp_off_last', 'fbs_last', 'fbs_share',
    'rating', 'stars', 'has_recruit', 'height', 'weight',
    # Draft boards (the 2027 class only: consensus big board, PFF, mock
    # pick; public/data/prospect-grades-<year>.json). None exists for past
    # classes, so the career model cannot use them.
    'on_board', 'board_pick_log', 'board_consensus_log',
]


def load_usage(years) -> dict:
    """(player_id, season) -> usage dict (overall / pass / rush ...)."""
    out = {}
    for y in years:
        p = CFBD / f'player-usage-{y}.json'
        if p.exists():
            for u in json.load(open(p)):
                out[(str(u['id']), int(u['season']))] = u.get('usage') or {}
    return out


def load_sp_off(years) -> dict:
    out = {}
    for y in years:
        p = CFBD / f'sp-ratings-{y}.json'
        if p.exists():
            for t in json.load(open(p)):
                off = (t.get('offense') or {}).get('rating')
                if t.get('team') and off is not None:
                    out[(t['team'], t['year'])] = off
    return out


def market_features(seasons: pd.DataFrame, pos: str, S: int, draft_year: int, recruit: dict | None,
                    talent: dict, sp: dict, sp_off: dict, usage: dict, pid: str,
                    games: dict | None = None, board: dict | None = None) -> dict:
    s = seasons[seasons['season'] <= S].sort_values('season')
    f = {c: 0.0 for c in MARKET_FEATURES}
    f.update(extra_features(s, recruit, usage, games or {}, pid))
    # Draft board (his class's big boards, when one exists for it).
    f['board_pick_log'] = f['board_consensus_log'] = float(np.log(300))
    if board:
        f['on_board'] = 1.0
        if board.get('projPick'):
            f['board_pick_log'] = float(np.log(board['projPick']))
        if board.get('consensusRank'):
            f['board_consensus_log'] = float(np.log(board['consensusRank']))
    f[f'pos_{pos}'] = 1.0
    f['k'] = draft_year - 1 - S
    f['n_seasons'] = len(s)
    first = (recruit or {}).get('rclass') or college_entry(pid, s) or S + 1
    age_at = lambda season: 18.9 + (season - first)  # noqa: E731
    f['est_age'] = age_at(S)
    f['est_draft_age'] = age_at(draft_year - 1) + 0.4
    if recruit:
        f['has_recruit'] = 1.0
        for c in ('rating', 'stars', 'height', 'weight'):
            f[c] = recruit.get(c) or 0.0
    f['breakout_age'] = 25.0
    if not len(s):
        return f
    hit = s[(s['dominator'] >= 0.2) | (s['scrim_yds'] >= 800) | (s['pass_yds'] >= 2000)]
    if len(hit):
        f['breakout_age'] = age_at(int(hit['season'].iloc[0]))
        f['broke_out'] = 1.0
    last = s.iloc[-1]
    ls = int(last['season'])
    f['best_dominator'] = float(s['dominator'].max())
    f['last_dominator'] = float(last['dominator'])
    f['last_rec_yds_sh'] = float(last['rec_yds_sh'])
    f['last_rush_yds_sh'] = float(last['rush_yds_sh'])
    f['best_rush_yds_sh'] = float(s['rush_yds_sh'].max())
    us = [usage.get((pid, int(y)), {}) for y in s['season']]
    f['last_usage'] = float(us[-1].get('overall') or 0)
    f['best_usage'] = float(max((u.get('overall') or 0) for u in us))
    f['last_pass_usage'] = float(us[-1].get('pass') or 0)
    f['last_rush_usage'] = float(us[-1].get('rush') or 0)
    for c in ('rec', 'rec_yds', 'rec_td', 'rush_car', 'rush_yds', 'rush_td', 'pass_att', 'pass_yds',
              'pass_td', 'pass_int', 'pass_ypa'):
        f[f'last_{c}'] = float(last[c])
    f['car_rec_yds'] = float(s['rec_yds'].sum())
    f['car_rush_yds'] = float(s['rush_yds'].sum())
    f['car_pass_yds'] = float(s['pass_yds'].sum())
    f['car_td'] = float(s['scrim_td'].sum() + s['pass_td'].sum())
    f['talent_last'] = float(talent.get((last['team'], ls), 0.0) or 0.0)
    f['p4_last'] = float(last.get('conference') in P4 or last['team'] == 'Notre Dame')
    f['sp_last'] = float(sp.get((last['team'], ls), -30.0))
    f['sp_off_last'] = float(sp_off.get((last['team'], ls), -10.0))
    fbs = [(t, int(y)) in sp for t, y in zip(s['team'], s['season'])]
    f['fbs_last'] = float(fbs[-1])
    f['fbs_share'] = float(np.mean(fbs))
    return f


def _college_key(s: str) -> str:
    return re.sub(r'[^a-z0-9]', '', (s or '').lower().replace('state', 'st'))


def nfl_departed(data: Path = Path('public/data'), since: int = 0):
    """A predicate (name, pos, college) -> True if the player is already in the
    NFL: drafted since `since`, or on a current NFL roster (undrafted signings
    included) under the same surname and position from the same college. The
    surname + first initial + college key catches nicknames a name match
    misses ("Kevin" Concepcion at Texas A&M is the Browns' KC Concepcion)."""
    import glob
    keys = set()
    names = set()
    rosters = sorted(glob.glob(str(data / 'roster_20*.csv.gz')))
    if rosters:
        r = pd.read_csv(rosters[-1], low_memory=False,
                        usecols=['full_name', 'last_name', 'position', 'college', 'rookie_year'])
        # Only players who entered the league since `since`: a college player
        # who left after that season is a rookie now, and a veteran namesake
        # from the same school (Oregon's Juwan Johnson) is not him.
        r = r[pd.to_numeric(r['rookie_year'], errors='coerce').fillna(0) > since]
        for fn, ln, pos, col in zip(r['full_name'], r['last_name'], r['position'], r['college']):
            for c in str(col).split(';'):
                keys.add((norm_name(str(fn))[:1], norm_name(str(ln)).split(' ')[-1] if isinstance(ln, str) else '',
                          pos, _college_key(c)))
    dp = pd.read_csv(data / 'draft_picks.csv.gz', usecols=['season', 'pfr_player_name', 'position', 'college'])
    dp = dp[dp['season'] >= since]
    for n, pos, col in zip(dp['pfr_player_name'], dp['position'], dp['college']):
        names.add(norm_name(str(n)))
        keys.add((norm_name(str(n))[:1], norm_name(str(n)).split(' ')[-1], pos, _college_key(str(col))))

    def gone(name: str, pos: str, college: str | None) -> bool:
        nn = norm_name(name or '')
        if nn in names:
            return True
        # Surname + first initial + position + college: a nickname keeps its
        # initial (Kevin / KC), a teammate's brother or namesake usually does
        # not (Jamari Johnson is not Oregon's NFL Johnson).
        return (nn[:1], nn.split(' ')[-1] if nn else '', pos, _college_key(college or '')) in keys
    return gone


# ── Season to date ───────────────────────────────────────────────────────
# During a season, scripts/fetch_cfbd_inseason.py stores the current season
# through week W and the same cutoff for every past season. The models are
# trained on whole seasons, so the season-to-date row is turned into a
# FULL-SEASON ESTIMATE first: per stat and position, a regression fitted on
# history (through week W -> the full season) of the season-to-date total
# prorated to the team's schedule, last season's total and whether he had one.
# Four games of a breakout are shrunk toward what he did last year by exactly
# as much as history says they should be. Team context the market could not
# know at week W is replaced: SP+ is last season's (the final rating is set by
# games not yet played), usage by down is last season's (CFBD has no weekly
# cut to replay), team scoring and Elo run through week W.

INSEASON = CFBD / 'inseason'
LONG_COLS = ('rush_long', 'rec_long')
COUNT_COLS = tuple(c for c in NUM if c not in LONG_COLS)


def _gz(path: Path):
    import gzip
    with gzip.open(path, 'rt') as f:
        return json.load(f)


def team_schedule(games: list[dict], season: int, week: int) -> dict:
    """team -> {'played': completed regular-season games through `week`,
    'sched': regular-season games scheduled, 'ppg', 'elo'} for one season."""
    out = {}
    for gm in games:
        if int(gm.get('season') or season) != season or str(gm.get('season_type', 'regular')).split('.')[-1] != 'regular':
            continue
        wk = int(gm.get('week') or 0)
        for side in ('home', 'away'):
            t = gm.get(f'{side}_team')
            if not t:
                continue
            a = out.setdefault(t, {'played': 0, 'sched': 0, 'pts': 0.0, 'elo': [], 'ppg': None})
            a['sched'] += 1
            pts = gm.get(f'{side}_points')
            if wk <= week and pts is not None and gm.get('completed', True):
                a['played'] += 1
                a['pts'] += pts
                if gm.get(f'{side}_pregame_elo') is not None:
                    a['elo'].append(gm[f'{side}_pregame_elo'])
    for a in out.values():
        a['ppg'] = a['pts'] / a['played'] if a['played'] else None
        a['elo'] = float(np.mean(a['elo'])) if a['elo'] else None
    return out


def _factor(team: str, sched: dict) -> float:
    a = sched.get(team)
    if not a or not a['played']:
        return 1.0
    return max(1.0, a['sched'] / a['played'])


def _design(part: pd.DataFrame, prior: pd.DataFrame, sched: dict, col: str) -> np.ndarray:
    f = np.array([_factor(t, sched) for t in part['team']])
    pro = part[col].values * (1.0 if col in LONG_COLS else f)
    pv = prior.reindex(part['player_id'])[col].values
    has = ~np.isnan(pv)
    return np.column_stack([pro, np.nan_to_num(pv), has.astype(float), np.ones(len(part))])


def fit_inseason(hist: pd.DataFrame, full: pd.DataFrame, games_by_year: dict, week: int) -> dict:
    """Per position and stat, least squares of the full-season total on
    [season-to-date prorated, last season, had a last season, 1], over every
    past season with the same cutoff. Returns coefficients plus fit quality
    against plain proration."""
    rows = {pos: {c: ([], []) for c in NUM} for pos in POSITIONS}
    full_i = full.set_index(['player_id', 'season'])
    for y in sorted(set(hist['season'])):
        if y - 1 not in set(full['season']) or y not in games_by_year:
            continue
        part = hist[(hist['season'] == y) & hist['position'].isin(POSITIONS)]
        sched = team_schedule(games_by_year[y], y, week)
        prior = full[full['season'] == y - 1].drop_duplicates('player_id').set_index('player_id')
        tgt = full_i.reindex(list(zip(part['player_id'], [y] * len(part))))
        for pos in POSITIONS:
            m = (part['position'] == pos).values
            if not m.any():
                continue
            for c in NUM:
                X = _design(part[m], prior, sched, c)
                yv = np.nan_to_num(tgt[c].values[m])
                rows[pos][c][0].append(X)
                rows[pos][c][1].append(yv)
    coefs, quality = {}, {}
    for pos in POSITIONS:
        for c in NUM:
            if not rows[pos][c][0]:
                continue
            X, yv = np.vstack(rows[pos][c][0]), np.concatenate(rows[pos][c][1])
            b = np.linalg.lstsq(X, yv, rcond=None)[0]
            coefs.setdefault(pos, {})[c] = [round(float(v), 4) for v in b]
            if c in ('pass_yds', 'rush_yds', 'rec_yds', 'rec', 'rush_car', 'pass_td', 'rush_td', 'rec_td'):
                ss = float(((yv - yv.mean()) ** 2).sum()) or 1.0
                quality.setdefault(pos, {})[c] = {
                    'n': int(len(yv)),
                    'r2Estimate': round(1 - float(((yv - X @ b) ** 2).sum()) / ss, 3),
                    'r2Prorated': round(1 - float(((yv - X[:, 0]) ** 2).sum()) / ss, 3),
                    'r2LastSeason': round(1 - float(((yv - X[:, 1]) ** 2).sum()) / ss, 3),
                }
    return {'week': week, 'coefs': coefs, 'quality': quality}


def estimate_full(part: pd.DataFrame, prior_full: pd.DataFrame, sched: dict, fit: dict) -> pd.DataFrame:
    """Season-to-date wide rows (all positions) -> full-season estimates.
    QB/RB/WR/TE use the fitted regression (never below what he already has);
    other positions are prorated (they only feed team totals)."""
    y = int(part['season'].iloc[0])
    prior = prior_full[prior_full['season'] == y - 1].drop_duplicates('player_id').set_index('player_id')
    out = part.copy()
    f = np.array([_factor(t, sched) for t in part['team']])
    for c in COUNT_COLS:
        out[c] = part[c].values * f
    for pos, by_c in fit['coefs'].items():
        m = (part['position'] == pos).values
        if not m.any():
            continue
        for c, b in by_c.items():
            est = _design(part[m], prior, sched, c) @ np.array(b)
            out.loc[m, c] = np.maximum(est, part.loc[m, c].values)
    return out


def load_history_cutoff():
    """(week, wide rows for every past season through that week) or (None, None)."""
    ps = sorted(INSEASON.glob('history-wk*.json.gz'))
    if not ps:
        return None, None
    d = _gz(ps[-1])
    return int(d['throughWeek']), _fill(pd.DataFrame(d['rows']))


def load_current():
    """The season in progress: {'season', 'week', 'rows' (wide), 'games',
    'talent'} or None (none on disk, or the complete season already is)."""
    ps = sorted(INSEASON.glob('player-season-*.json.gz'))
    if not ps:
        return None
    d = _gz(ps[-1])
    y = int(d['season'])
    if (CFBD / f'player-season-{y}.json').exists():
        return None
    # snake_case like every full-season games file: the CFBD v5 client writes
    # camelCase, which team_schedule could not read (no proration, no team
    # context for the season in progress).
    games = snake_keys(_gz(INSEASON / f'games-{y}.json.gz')) if (INSEASON / f'games-{y}.json.gz').exists() else []
    talent = {}
    if (INSEASON / f'team-talent-{y}.json.gz').exists():
        for t in _gz(INSEASON / f'team-talent-{y}.json.gz'):
            talent[(t['team'], int(t.get('year') or y))] = t['talent']
    return {'season': y, 'week': int(d['throughWeek']), 'fetchedAt': d.get('fetchedAt'),
            'rows': _fill(pd.DataFrame(d['rows'])), 'games': games, 'talent': talent}


def load_games_raw(years) -> dict:
    out = {}
    for y in years:
        p = CFBD / f'games-{y}.json'
        if p.exists():
            out[y] = json.load(open(p))
    return out


def inseason_fit(week: int, hist: pd.DataFrame) -> dict:
    """fit_inseason at this cutoff, cached in inseason/estimator-wk<W>.json
    (it reads every past season; the daily value model reuses it)."""
    path = INSEASON / f'estimator-wk{week}.json'
    if path.exists():
        return json.load(open(path))
    years = sorted(set(hist['season']) | {min(hist['season']) - 1})
    fit = fit_inseason(hist, raw_wide(years), load_games_raw(years), week)
    for old in INSEASON.glob('estimator-wk*.json'):
        old.unlink()
    json.dump(fit, open(path, 'w'), indent=1)
    return fit


def current_estimate(cur: dict, prior: pd.DataFrame, fit: dict) -> pd.DataFrame:
    """The season in progress as full-season estimated wide rows."""
    return estimate_full(cur['rows'], prior, team_schedule(cur['games'], cur['season'], cur['week']), fit)


class Shifted:
    """A read-only view of a {(key, season): value} dict where season y reads
    season y-1's value (what was known at a cutoff inside season y)."""

    def __init__(self, base: dict, y: int):
        self.base, self.y = base, y

    def _k(self, k):
        return (k[0], self.y - 1) if k[1] == self.y else k

    def get(self, k, default=None):
        return self.base.get(self._k(k), default)

    def __contains__(self, k) -> bool:
        return self._k(k) in self.base

    def __getitem__(self, k):
        return self.base[self._k(k)]


def inseason_context(y: int, week: int, games: list[dict], sp: dict, sp_off: dict, usage: dict,
                     team_games: dict) -> tuple:
    """Views of (sp, sp_off, usage, team_games) as they stood at week `week`
    of season y: y's SP+ and usage replaced by y-1's, y's team scoring and
    Elo through the cutoff. Earlier seasons are untouched."""
    sched = team_schedule(games, y, week)
    tg = {k: v for k, v in team_games.items() if k[1] != y}
    tg.update({(t, y): {'ppg': a['ppg'], 'elo': a['elo']} for t, a in sched.items() if a['ppg'] is not None})
    return Shifted(sp, y), Shifted(sp_off, y), Shifted(usage, y), tg


# Both models also use the extended features (all available back to 2005).
FEATURES = FEATURES + EXTRA_FEATURES
MARKET_FEATURES = MARKET_FEATURES + EXTRA_FEATURES
