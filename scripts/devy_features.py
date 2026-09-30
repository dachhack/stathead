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
import re
from pathlib import Path

import numpy as np
import pandas as pd

from devy_names import norm_name  # noqa: F401  (re-exported)
from devy_stats import STATS  # shared with fetch_cfbd_inseason.py

CFBD = Path('public/data/cfbd')
POSITIONS = ('QB', 'RB', 'WR', 'TE')
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
        d = d[d['category'].isin(['passing', 'rushing', 'receiving', 'kickReturns', 'puntReturns', 'fumbles'])]
        d['col'] = [STATS.get((c, t)) for c, t in zip(d['category'], d['stat_type'])]
        d = d[d['col'].notna()]
        d['stat'] = pd.to_numeric(d['stat'], errors='coerce').fillna(0)
        w = d.pivot_table(index=['player_id', 'season'], columns='col', values='stat', aggfunc='sum').reset_index()
        meta = d.drop_duplicates(['player_id', 'season'])[['player_id', 'season', 'player', 'position', 'team', 'conference']]
        frames.append(w.merge(meta, on=['player_id', 'season']))
    s = pd.concat(frames, ignore_index=True)
    for c in NUM:
        if c not in s:
            s[c] = 0.0
    s[NUM] = s[NUM].fillna(0.0)
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


def load_recruits(years) -> pd.DataFrame:
    rows = []
    for y in years:
        p = CFBD / f'recruiting-{y}.json'
        if p.exists():
            for r in json.load(open(p)):
                if r.get('recruit_type', 'HighSchool') != 'HighSchool':
                    continue
                rows.append({'player_id': str(r.get('athlete_id') or ''), 'rname': r.get('name'),
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


# ── Market (KTC devy value) features ─────────────────────────────────────
# What the devy market prices, as of the end of season S: age, breakout
# age, share of the offense, raw production, program and competition level,
# and recruiting pedigree (for freshmen nearly the only signal). CFBD, ESPN
# and KTC carry no college birthdates, so age is ESTIMATED: a high-school
# class of year R turns ~18.9 by the end of its first college season (R);
# without a recruiting record, from the first CFBD season. Redshirts and
# reclassified players are off by up to a year.

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
    first = (recruit or {}).get('rclass') or (int(s['season'].iloc[0]) if len(s) else S + 1)
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


# Both models also use the extended features (all available back to 2005).
FEATURES = FEATURES + EXTRA_FEATURES
MARKET_FEATURES = MARKET_FEATURES + EXTRA_FEATURES
