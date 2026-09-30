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

import json
from pathlib import Path

import numpy as np
import pandas as pd

from devy_names import norm_name  # noqa: F401  (re-exported)

CFBD = Path('public/data/cfbd')
POSITIONS = ('QB', 'RB', 'WR', 'TE')
STATS = {
    ('passing', 'YDS'): 'pass_yds', ('passing', 'TD'): 'pass_td', ('passing', 'INT'): 'pass_int',
    ('passing', 'ATT'): 'pass_att', ('passing', 'COMPLETIONS'): 'pass_cmp',
    ('rushing', 'CAR'): 'rush_car', ('rushing', 'YDS'): 'rush_yds', ('rushing', 'TD'): 'rush_td',
    ('receiving', 'REC'): 'rec', ('receiving', 'YDS'): 'rec_yds', ('receiving', 'TD'): 'rec_td',
}
NUM = list(STATS.values())


def load_seasons(years) -> pd.DataFrame:
    """One row per (player_id, season): offensive stats, team, position, and
    the team's totals for share features. Players at every position are kept
    so team totals are complete; callers filter to POSITIONS."""
    frames = []
    for y in years:
        p = CFBD / f'player-season-{y}.json'
        if not p.exists():
            continue
        d = pd.DataFrame(json.load(open(p)))
        d = d[d['category'].isin(['passing', 'rushing', 'receiving'])]
        d['col'] = [STATS.get((c, t)) for c, t in zip(d['category'], d['stat_type'])]
        d = d[d['col'].notna()]
        d['stat'] = pd.to_numeric(d['stat'], errors='coerce').fillna(0)
        w = d.pivot_table(index=['player_id', 'season'], columns='col', values='stat', aggfunc='sum').reset_index()
        meta = d.drop_duplicates(['player_id', 'season'])[['player_id', 'season', 'player', 'position', 'team']]
        frames.append(w.merge(meta, on=['player_id', 'season']))
    s = pd.concat(frames, ignore_index=True)
    for c in NUM:
        if c not in s:
            s[c] = 0.0
    s[NUM] = s[NUM].fillna(0.0)
    team = s.groupby(['team', 'season'])[['pass_yds', 'pass_td', 'rush_yds', 'rush_td', 'rec_yds', 'rec_td']].sum()
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
    return s


def load_recruits(years) -> pd.DataFrame:
    rows = []
    for y in years:
        p = CFBD / f'recruiting-{y}.json'
        if p.exists():
            for r in json.load(open(p)):
                if r.get('recruit_type', 'HighSchool') != 'HighSchool':
                    continue
                rows.append({'player_id': str(r.get('athlete_id') or ''), 'rname': r.get('name'),
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
    return r.sort_values('rating', ascending=False).drop_duplicates('key')


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


def snapshot(seasons: pd.DataFrame, S: int, k: int, recruit: dict | None, talent: dict, sp: dict) -> dict:
    """Features for one player from his season rows (any order) as of season S."""
    s = seasons[seasons['season'] <= S].sort_values('season')
    f = {c: 0.0 for c in FEATURES}
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
        f['yrs_since_hs'] = len(s)
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
