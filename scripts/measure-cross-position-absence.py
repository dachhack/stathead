#!/usr/bin/env python3
"""Measure how one position's absence moves the OTHER positions on the team.

The MCP's next-man-up pass (VACATED_CAPTURE in mcp/dist/server.mjs) hands a
missing starter's line to his own position only. This measures the rest of
the matrix over 2016-2025 REG weeks 1-16 (later weeks carry rest games) and
checks each effect out of sample: fit on 2016-2021, predict each established
teammate's per-game PPR in the leader's out-weeks on 2022-2025, compare RMSE
against no adjustment (the current rule).

Leader: the team's top player at the position (QB by pass attempts, others by
PPR per game), min 6 games, on no other team that season. In-week: he has a
stat row (a QB needs 15+ attempts). Out-week: the team played and he did not.
A QB with 1-14 attempts left early or came in late; those weeks are dropped.
Established teammate: 3+ in-weeks and 1+ out-week.

QB1 out is modelled as a multiplier on each teammate's points:
    m = 1 + a + e * (r - 1)
r = replacement's passing level / starter's, from what was known BEFORE the
season (pass yds per 15+-attempt game over the prior three seasons, shrunk
toward 85% of league average for a backup and league average for a starter),
never from the out-weeks themselves (that would be receiving yards measuring
passing yards). At projection time r is the heir's projected pass yds/gm over
the starter's.

Run: python3 scripts/measure-cross-position-absence.py
Output: public/data/cross-position-absence.json (+ printed summary)
"""

import json
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
SEASONS = range(2016, 2026)
FIT = range(2016, 2022)
TEST = range(2022, 2026)
MAX_WEEK = 16
POS = ('QB', 'RB', 'WR', 'TE')
MIN_GAMES = 6
QB_FULL_ATT = 15
PRIOR_K = 4          # games of shrinkage on a QB's prior pass yds/gm
BACKUP_LEVEL = 0.85  # a backup with no history: 85% of league average
R_CLAMP = (0.5, 1.2)
BOOT = 2000
rng = np.random.default_rng(7)
NUM = ('attempts', 'passing_yards', 'passing_tds', 'passing_interceptions', 'fantasy_points_ppr', 'targets')


def load():
    frames = []
    for s in range(min(SEASONS) - 3, max(SEASONS) + 1):
        df = pd.read_csv(os.path.join(DATA, f'player_stats_{s}.csv.gz'), low_memory=False)
        df = df[(df.season_type == 'REG') & df.position.isin(POS)]
        if s < min(SEASONS):
            df = df[df.position == 'QB']   # prior-season QB passing only
        frames.append(df[['player_id', 'player_display_name', 'position', 'season', 'week', 'team', *NUM]])
    df = pd.concat(frames, ignore_index=True).copy()
    for c in NUM:
        df[c] = pd.to_numeric(df[c], errors='coerce').fillna(0)
    df['ppr'] = df.fantasy_points_ppr
    full = df[(df.position == 'QB') & (df.attempts >= QB_FULL_ATT)]
    prior_qb = full[['player_id', 'season', 'passing_yards']]
    lg = full.groupby('season').passing_yards.mean()
    df = df[df.season.isin(SEASONS) & (df.week <= MAX_WEEK)]
    return df, prior_qb, lg


def leaders(df):
    team_weeks = df.groupby(['season', 'team']).week.apply(set).to_dict()
    multi = df.groupby(['season', 'player_id']).team.nunique()
    multi = set(multi[multi > 1].index)
    out = []
    for (season, team, pos), g in df.groupby(['season', 'team', 'position']):
        by_p = g.groupby('player_id').agg(games=('week', 'nunique'), ppr=('ppr', 'sum'), att=('attempts', 'sum'))
        by_p = by_p[by_p.games >= MIN_GAMES]
        if by_p.empty:
            continue
        pid = by_p.att.idxmax() if pos == 'QB' else (by_p.ppr / by_p.games).idxmax()
        if (season, pid) in multi:
            continue
        rows = g[g.player_id == pid].set_index('week')
        tw = team_weeks[(season, team)]
        if pos == 'QB':
            inw = set(rows.index[rows.attempts >= QB_FULL_ATT])
            outw = tw - set(rows.index[rows.attempts > 0])
        else:
            inw = set(rows.index)
            outw = tw - inw
        if len(inw) < 4 or not outw:
            continue
        out.append(dict(season=season, team=team, pos=pos, pid=pid, inw=inw, outw=outw,
                        rate=rows.loc[sorted(inw), 'ppr'].mean()))
    return out


def teammates(df, L, q):
    """Established teammates at q: (in-rate, out-rate, out-weeks, player_id)."""
    g = df[(df.season == L['season']) & (df.team == L['team']) & (df.position == q) & (df.player_id != L['pid'])]
    res = []
    for pid, pr in g.groupby('player_id'):
        wi, wo = pr[pr.week.isin(L['inw'])], pr[pr.week.isin(L['outw'])]
        if len(wi) >= 3 and len(wo) >= 1:
            res.append((wi.ppr.mean(), wo.ppr.mean(), len(wo), pid))
    return res


def rmse(a, p, w):
    return float(np.sqrt(np.average((np.asarray(a) - np.asarray(p)) ** 2, weights=w)))


def boot(fn, t, key='team_season'):
    groups = t[key].unique()
    idx = {k: t.index[t[key] == k] for k in groups}
    vals = []
    for _ in range(BOOT):
        pick = rng.choice(groups, len(groups))
        vals.append(fn(t.loc[np.concatenate([idx[k] for k in pick])]))
    # Scalar -> [lo, hi]; vector -> one [lo, hi] per component.
    return np.percentile(vals, [5, 95], axis=0).T.round(3).tolist()


def non_qb(df, Ls):
    """RB1 / WR1 / TE1 out: capture by each other position's established
    players (Δ per game ÷ leader's line), split by in-rate share."""
    recs = []
    for L in Ls:
        if L['pos'] == 'QB':
            continue
        for q in POS:
            if q == L['pos']:
                continue
            tm = teammates(df, L, q)
            tot = sum(x[0] for x in tm)
            for rin, rout, w, _ in tm:
                recs.append(dict(team_season=f"{L['season']}{L['team']}{L['pos']}", s=L['season'], p=L['pos'], q=q,
                                 lead=L['rate'], rin=rin, rout=rout, w=w, sh=rin / tot if tot else 0))
    t = pd.DataFrame(recs)
    out = {}
    for (p, q), g in t.groupby(['p', 'q']):
        def cap(d):
            x, y = d.lead * d.sh, d.rout - d.rin
            return (d.w * x * y).sum() / (d.w * x * x).sum()
        f, te = g[g.s.isin(FIT)], g[g.s.isin(TEST)]
        c_fit = cap(f)
        out[f'{p}->{q}'] = dict(
            capture=round(float(cap(g)), 3), ci90=boot(cap, g.reset_index(drop=True)),
            holdout=dict(n=len(te), rmse_none=round(rmse(te.rout, te.rin, te.w), 3),
                         rmse_capture=round(rmse(te.rout, te.rin + c_fit * te.lead * te.sh, te.w), 3)))
    return out


def qb_out(df, Ls, prior_qb, lg):
    def prior_level(pid, s, backup):
        h = prior_qb[(prior_qb.player_id == pid) & (prior_qb.season < s) & (prior_qb.season >= s - 3)]
        base = lg.get(s - 1, lg.mean()) * (BACKUP_LEVEL if backup else 1.0)
        return (h.passing_yards.sum() + PRIOR_K * base) / (len(h) + PRIOR_K)

    recs = []
    for L in Ls:
        if L['pos'] != 'QB':
            continue
        s, team = L['season'], L['team']
        g = df[(df.season == s) & (df.team == team) & (df.position == 'QB') & df.week.isin(L['outw'])]
        if g.empty:
            continue
        heir = g.groupby('player_id').attempts.sum().idxmax()
        r = float(np.clip(prior_level(heir, s, True) / prior_level(L['pid'], s, False), *R_CLAMP))
        for q in ('RB', 'WR', 'TE'):
            for rin, rout, w, _ in teammates(df, L, q):
                recs.append(dict(team_season=f'{s}{team}', s=s, q=q, r=r, rin=rin, rout=rout, w=w))
    t = pd.DataFrame(recs)

    def fit(d):
        # (rout - rin) = rin * (a + e*(r-1)), weighted LS
        X = np.c_[d.rin, d.rin * (d.r - 1)]
        W = np.sqrt(d.w.values)
        return np.linalg.lstsq(X * W[:, None], (d.rout - d.rin).values * W, rcond=None)[0]

    def fit_const(d):
        return (d.w * d.rin * (d.rout - d.rin)).sum() / (d.w * d.rin ** 2).sum()

    out = {'meanR': round(float(t.r.mean()), 3)}
    for q, g in t.groupby('q'):
        g = g.reset_index(drop=True)
        f, te = g[g.s.isin(FIT)], g[g.s.isin(TEST)]
        a_f, e_f = fit(f)
        c_f = fit_const(f)
        a, e = fit(g)
        ci = boot(lambda d: fit(d), g)
        out[q] = dict(
            a=round(float(a), 3), e=round(float(e), 3), a_ci90=ci[0], e_ci90=ci[1],
            multAtMeanR=round(float(1 + a + e * (t.r.mean() - 1)), 3),
            n=len(g),
            holdout=dict(n=len(te), rmse_none=round(rmse(te.rout, te.rin, te.w), 3),
                         rmse_const=round(rmse(te.rout, te.rin * (1 + c_f), te.w), 3),
                         rmse_model=round(rmse(te.rout, te.rin * (1 + a_f + e_f * (te.r - 1)), te.w), 3)))
    return out


def qb_heir(df, Ls):
    """The QB who replaces QB1: what does he score per start (15+ attempts)?
    Candidates: his own line (proxy for the pool's backup line = the team's
    passing budget at slightly worse efficiency: 0.9 x the starter's passing
    points + 1 rushing point), the measured next-man-up share (0.56 x the
    starter's line), and their sum (what the MCP did)."""
    rows = []
    for L in Ls:
        if L['pos'] != 'QB':
            continue
        t = df[(df.season == L['season']) & (df.team == L['team']) & (df.position == 'QB')]
        st = t[(t.player_id == L['pid']) & t.week.isin(L['inw'])]
        o = t[(t.player_id != L['pid']) & t.week.isin(L['outw'])]
        if o.empty:
            continue
        heir = o.groupby('player_id').attempts.sum().idxmax()
        ho = o[(o.player_id == heir) & (o.attempts >= QB_FULL_ATT)]
        if ho.empty:
            continue
        sp = (0.04 * st.passing_yards + 4 * st.passing_tds - 2 * st.passing_interceptions).mean()
        rows.append(dict(s=L['season'], w=len(ho), act=ho.ppr.mean(), own=0.9 * sp + 1, share=0.56 * st.ppr.mean()))
    t = pd.DataFrame(rows)

    def score(pred, d):
        return dict(bias=round(float(np.average(pred - d.act, weights=d.w)), 2),
                    rmse=round(rmse(d.act, pred, d.w), 2))
    te = t[t.s.isin(TEST)]
    return {'n': len(t), 'meanActual': round(float(np.average(t.act, weights=t.w)), 2),
            'ownLine': score(t.own, t), 'shareOnly': score(t.share, t), 'ownPlusShare': score(t.own + t.share, t),
            'test': {'ownLine': score(te.own, te), 'shareOnly': score(te.share, te), 'ownPlusShare': score(te.own + te.share, te)}}


def main():
    df, prior_qb, lg = load()
    Ls = leaders(df)
    doc = {
        'seasons': [min(SEASONS), max(SEASONS)], 'maxWeek': MAX_WEEK,
        'fit': [min(FIT), max(FIT)], 'test': [min(TEST), max(TEST)],
        'leaders': {p: sum(1 for L in Ls if L['pos'] == p) for p in POS},
        'qbOut': qb_out(df, Ls, prior_qb, lg),
        'nonQb': non_qb(df, Ls),
        'qbHeir': qb_heir(df, Ls),
    }
    with open(os.path.join(DATA, 'cross-position-absence.json'), 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print(json.dumps(doc, indent=1))


if __name__ == '__main__':
    main()
