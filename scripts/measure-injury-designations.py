#!/usr/bin/env python3
"""What an official game-status designation is worth, measured.

For every QB/RB/WR/TE designated Questionable / Doubtful / Out on the nflverse
injury report (2016-2025 REG weeks 1-16), compare what he scored that week
against his own baseline: mean PPR in that season's OTHER weeks where he played
with no designation (min 4 such games, baseline >= 5 PPR/gm so the ratio means
something). A player with no stat row scored 0.

  mult = sum(actual) / sum(baseline)      -- the expected-value multiplier
  play = share of designated weeks with a stat row

Questionable is split by the player's final practice status that week (the
report's practice_status), since that is on the report before the game status
is, and Sleeper's Questionable arrives earlier still.

Run: python3 scripts/measure-injury-designations.py
Output: public/data/injury-designation-multipliers.json (+ printed table)
"""

import json
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
SEASONS = range(2016, 2026)
RECENT = range(2021, 2026)
POS = ('QB', 'RB', 'WR', 'TE')
MIN_BASE_GAMES = 4
MIN_BASE_PPG = 5.0
BOOT = 1000
rng = np.random.default_rng(11)


def practice_bucket(s):
    s = s.lower() if isinstance(s, str) else ''
    if 'did not' in s:
        return 'DNP'
    if 'limited' in s:
        return 'Limited'
    if 'full' in s:
        return 'Full'
    return 'none'


def load():
    stats, inj = [], []
    for s in SEASONS:
        st = pd.read_csv(os.path.join(DATA, f'player_stats_{s}.csv.gz'), low_memory=False,
                         usecols=['player_id', 'position', 'season', 'week', 'season_type', 'fantasy_points_ppr'])
        stats.append(st[(st.season_type == 'REG') & (st.week <= 16) & st.position.isin(POS)])
        ij = pd.read_csv(os.path.join(DATA, f'injuries_{s}.csv.gz'), low_memory=False,
                         usecols=['season', 'game_type', 'week', 'gsis_id', 'position', 'report_status', 'practice_status'])
        inj.append(ij[(ij.game_type == 'REG') & (ij.week <= 16) & ij.position.isin(POS)])
    st = pd.concat(stats)
    st['ppr'] = pd.to_numeric(st.fantasy_points_ppr, errors='coerce').fillna(0)
    st = st.groupby(['season', 'player_id', 'week'], as_index=False).ppr.sum()
    ij = pd.concat(inj)
    ij = ij[ij.report_status.isin(['Questionable', 'Doubtful', 'Out'])].copy()
    ij['practice'] = ij.practice_status.map(practice_bucket)
    ij = ij.drop_duplicates(['season', 'week', 'gsis_id'])
    return st, ij


def main():
    st, ij = load()
    designated = set(zip(ij.season, ij.gsis_id, ij.week))
    st['designated'] = [k in designated for k in zip(st.season, st.player_id, st.week)]
    clean = st[~st.designated]
    g = clean.groupby(['season', 'player_id']).ppr.agg(['sum', 'count']).reset_index()
    played = dict(((r.season, r.player_id, r.week), r.ppr) for r in st.itertuples())
    rows = []
    for r in ij.itertuples():
        base = g[(g.season == r.season) & (g.player_id == r.gsis_id)]
        if base.empty or base['count'].iloc[0] < MIN_BASE_GAMES:
            continue
        b = base['sum'].iloc[0] / base['count'].iloc[0]
        if b < MIN_BASE_PPG:
            continue
        k = (r.season, r.gsis_id, r.week)
        rows.append(dict(season=r.season, pos=r.position, status=r.report_status, practice=r.practice,
                         base=b, actual=played.get(k, 0.0), played=k in played))
    t = pd.DataFrame(rows)

    def summarize(d):
        mult = d.actual.sum() / d.base.sum()
        bs = []
        a, bb = d.actual.values, d.base.values
        for _ in range(BOOT):
            i = rng.integers(0, len(d), len(d))
            bs.append(a[i].sum() / bb[i].sum())
        lo, hi = np.percentile(bs, [5, 95])
        pl = d[d.played]
        return dict(n=len(d), play=round(float(d.played.mean()), 3), mult=round(float(mult), 3),
                    ci90=[round(float(lo), 3), round(float(hi), 3)],
                    multIfPlayed=round(float(pl.actual.sum() / pl.base.sum()), 3) if len(pl) else None)

    out = {'seasons': [min(SEASONS), max(SEASONS)], 'recent': [min(RECENT), max(RECENT)],
           'minBaseGames': MIN_BASE_GAMES, 'minBasePPG': MIN_BASE_PPG, 'byStatus': {}, 'recentByStatus': {},
           'questionableByPractice': {}, 'questionableByPos': {}}
    for s in ('Questionable', 'Doubtful', 'Out'):
        out['byStatus'][s] = summarize(t[t.status == s])
        out['recentByStatus'][s] = summarize(t[(t.status == s) & t.season.isin(RECENT)])
    q = t[t.status == 'Questionable']
    for p in ('Full', 'Limited', 'DNP', 'none'):
        if (q.practice == p).sum() >= 30:
            out['questionableByPractice'][p] = summarize(q[q.practice == p])
    for p in POS:
        out['questionableByPos'][p] = summarize(q[q.pos == p])
    with open(os.path.join(DATA, 'injury-designation-multipliers.json'), 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
