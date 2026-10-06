#!/usr/bin/env python3
"""Backtest the strength-of-matchup ledger (scripts/build-matchups.py) on past
seasons: after N weeks, how well do a defense's points / metrics allowed per
game — raw, and over expected — predict the rest of that season, and how much
of the deviation actually shows up in the players who face that defense?

Two tests per (position, metric, N):

1. Defense-level stability. Spearman rank correlation, across the 32
   defenses, between what a defense allowed per game over weeks 1..N and what
   it allowed over weeks N+1..end of the same season. Computed for the raw
   ledger, for over-expected (OE, the leave-one-out schedule adjustment the
   builder publishes), for the prior season's full ledger (the model's other
   input), and for the model's blend of the two. Averaged over seasons.

2. Player-level carry. For every player-game in weeks N+1..end (players with
   8+ games), rel = the player's value in that game divided by his mean in his
   other games that season. Regress rel on (opponent ratio - 1), where the
   ratio is the opponent's weeks-1..N allowed per game over the league
   average (raw) or 1 + OE / league average. The slope is the fraction of a
   defense's early-season deviation that shows up in the players facing it:
   1.0 means take the ledger at face value, 0 means it is noise. The weekly
   projections shrink the blended ratio by DEF_SHRINK = 0.40; this measures
   what the shrink should be for each metric. Also reports mean rel for
   players facing a top-8 (soft) and bottom-8 (tough) defense.

Seasons 2016-<last complete> from public/data/player_stats_<season>.csv.gz.

Output: public/data/matchups-backtest.json (read by build-matchups.py, which
stamps per-metric reliability into matchups-<season>.json) and a summary on
stdout. Run: python3 scripts/backtest_matchups.py [first_season] [last_season]
"""

import importlib.util
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')

# Metric definitions come from the builder so the two cannot drift.
_spec = importlib.util.spec_from_file_location('build_matchups', os.path.join(ROOT, 'scripts', 'build-matchups.py'))
_bm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bm)
METRIC_COLS, COMPOSITES, RATES, METRICS, POSITIONS = _bm.METRIC_COLS, _bm.COMPOSITES, _bm.RATES, _bm.METRICS, _bm.POSITIONS

FIRST = int(sys.argv[1]) if len(sys.argv) > 1 else 2016
LAST = int(sys.argv[2]) if len(sys.argv) > 2 else 2025
CUTS = (3, 4, 6, 9, 12)
BLEND_K, DEF_SHRINK = 6, 0.40          # as in build-weekly-projections.py
MIN_PLAYER_GAMES = 8


def load_season(season):
    path = os.path.join(DATA, f'player_stats_{season}.csv.gz')
    if not os.path.exists(path):
        return None
    cols = ['season_type', 'week', 'team', 'opponent_team', 'position', 'player_id'] + list(METRIC_COLS.values())
    df = pd.read_csv(path, usecols=cols, low_memory=False)
    df = df[(df.season_type == 'REG') & df.position.isin(POSITIONS) & df.opponent_team.notna()].copy()
    for m, c in METRIC_COLS.items():
        df[m] = pd.to_numeric(df[c], errors='coerce').fillna(0.0)
    for m, parts in COMPOSITES.items():
        df[m] = sum(coef * df[k] for k, coef in parts.items())
    return df


def cells(df):
    """One row per (defense, pos, week): summed metrics plus the offense faced."""
    keys = list(METRIC_COLS) + list(COMPOSITES)
    g = df.groupby(['opponent_team', 'position', 'week'], as_index=False)
    out = g[keys].sum()
    out['off'] = g['team'].first()['team'].values
    return out.rename(columns={'opponent_team': 'def', 'position': 'pos'})


def def_games(c):
    return c.groupby('def')['week'].nunique()


def allowed_pg(c, pos, m):
    """Per-defense per-game allowed for metric m at position pos (rates are
    totals over totals)."""
    sub = c[c.pos == pos]
    n = def_games(c)
    if m in RATES:
        num, den = RATES[m]
        s = sub.groupby('def')[[num, den]].sum()
        return (s[num] / s[den].where(s[den] > 0)).reindex(n.index)
    return (sub.groupby('def')[m].sum() / n).reindex(n.index).fillna(0.0)


def league_pg(c, pos, m):
    sub = c[c.pos == pos]
    if m in RATES:
        num, den = RATES[m]
        d = sub[den].sum()
        return sub[num].sum() / d if d else np.nan
    return sub[m].sum() / def_games(c).sum()


def over_expected(c, pos, m):
    """Per-defense OE for metric m: allowed minus the leave-one-out
    expectation set by the offense faced, within the cell window c."""
    sub = c[c.pos == pos].copy()
    n = def_games(c)
    lg = league_pg(c, pos, m)
    if m in RATES:
        num, den = RATES[m]
        tot = sub.groupby('off')[[num, den]].transform('sum')
        o_num, o_den = tot[num] - sub[num], tot[den] - sub[den]
        exp_rate = np.where(o_den > 0, o_num / o_den.where(o_den > 0), lg)
        sub['exp'] = exp_rate * sub[den]
        s = sub.groupby('def')[[num, 'exp', den]].sum()
        return ((s[num] - s['exp']) / s[den].where(s[den] > 0)).reindex(n.index)
    tot = sub.groupby('off')[m].transform('sum')
    cnt = sub.groupby('off')[m].transform('count')
    sub['exp'] = np.where(cnt > 1, (tot - sub[m]) / (cnt - 1).replace(0, np.nan), lg)
    s = sub.groupby('def')[[m, 'exp']].sum()
    return ((s[m] - s['exp']) / n).reindex(n.index)


def spearman(a, b):
    j = pd.concat([a, b], axis=1).dropna()
    if len(j) < 8:
        return np.nan
    return j.iloc[:, 0].rank().corr(j.iloc[:, 1].rank())


def slope(x, y):
    """OLS slope of y on x (with intercept)."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = np.isfinite(x) & np.isfinite(y)
    if ok.sum() < 30 or np.nanstd(x[ok]) == 0:
        return np.nan
    return float(np.polyfit(x[ok], y[ok], 1)[0])


def main():
    seasons = {}
    for s in range(FIRST - 1, LAST + 1):
        df = load_season(s)
        if df is not None and len(df):
            seasons[s] = (df, cells(df))
    print(f'Loaded {len(seasons)} seasons: {min(seasons)}-{max(seasons)}')

    # Results accumulators: (pos, m, N) -> lists over seasons / pooled rows.
    stab = {}
    carry_rows = {}
    for season in sorted(s for s in seasons if s >= FIRST):
        df, c = seasons[season]
        prior_c = seasons.get(season - 1, (None, None))[1]
        last_week = int(c.week.max())
        # Player baselines: value per game and LOO mean over the whole season.
        for N in CUTS:
            if N + 3 > last_week:
                continue
            early, rest = c[c.week <= N], c[c.week > N]
            next4 = c[(c.week > N) & (c.week <= N + 4)]
            for pos in POSITIONS:
                for m in METRICS[pos] + ['ppr']:
                    raw_e, raw_r = allowed_pg(early, pos, m), allowed_pg(rest, pos, m)
                    raw_n4 = allowed_pg(next4, pos, m)
                    oe_e, oe_r = over_expected(early, pos, m), over_expected(rest, pos, m)
                    lg_e = league_pg(early, pos, m)
                    key = (pos, m, N)
                    d = stab.setdefault(key, {'raw': [], 'oe': [], 'oe_oe': [], 'raw_n4': [], 'oe_n4': [], 'prior': [], 'blend': [], 'lg': []})
                    d['raw'].append(spearman(raw_e, raw_r))
                    d['oe'].append(spearman(oe_e, raw_r))
                    d['oe_oe'].append(spearman(oe_e, oe_r))
                    d['raw_n4'].append(spearman(raw_e, raw_n4))
                    d['oe_n4'].append(spearman(oe_e, raw_n4))
                    d['lg'].append(lg_e)
                    if prior_c is not None and m == 'ppr':
                        prior = allowed_pg(prior_c, pos, m)
                        plg = league_pg(prior_c, pos, m)
                        w = N / (N + BLEND_K)
                        blend = (1 - w) * (prior / plg).reindex(raw_e.index).fillna(1.0) + w * (raw_e / lg_e)
                        d['prior'].append(spearman(prior.reindex(raw_e.index), raw_r))
                        d['blend'].append(spearman(blend, raw_r))

                    # Player-level carry, pooled over seasons.
                    if m in RATES or m.endswith('TD'):
                        continue   # a player's per-game rate, or his TD count, is too noisy to be a target
                    p = df[df.position == pos][['player_id', 'week', 'opponent_team', m]].copy()
                    cnt = p.groupby('player_id')[m].transform('count')
                    p = p[cnt >= MIN_PLAYER_GAMES]
                    tot = p.groupby('player_id')[m].transform('sum')
                    cnt = p.groupby('player_id')[m].transform('count')
                    p['base'] = (tot - p[m]) / (cnt - 1)
                    p = p[(p.week > N) & (p.base > 0)]
                    # Players with a trivial baseline (a WR averaging 0.5 targets) swing wildly in ratio terms.
                    floor = {'ppr': 3.0}.get(m, max(0.5, 0.15 * (lg_e or 1)))
                    p = p[p.base >= floor]
                    p['rel'] = p[m] / p['base']
                    p['ratio_raw'] = p.opponent_team.map(raw_e / lg_e)
                    p['ratio_oe'] = p.opponent_team.map(1 + oe_e / lg_e)
                    p['rank_raw'] = p.opponent_team.map(raw_e.rank(ascending=False))
                    p['next4'] = p.week <= N + 4
                    if prior_c is not None and m == 'ppr':
                        p['ratio_blend'] = p.opponent_team.map(blend)
                    carry_rows.setdefault(key, []).append(p[['rel', 'ratio_raw', 'ratio_oe', 'rank_raw', 'next4'] + (['ratio_blend'] if 'ratio_blend' in p else [])])

    out = {}
    for (pos, m, N), d in stab.items():
        rec = {
            'seasons': len(d['raw']),
            'r_raw': round(float(np.nanmean(d['raw'])), 3),
            'r_oe': round(float(np.nanmean(d['oe'])), 3),
            'r_oe_vs_oe': round(float(np.nanmean(d['oe_oe'])), 3),
            'r_raw_next4': round(float(np.nanmean(d['raw_n4'])), 3),
            'r_oe_next4': round(float(np.nanmean(d['oe_n4'])), 3),
            'league_pg': round(float(np.nanmean(d['lg'])), 2),
        }
        if d['prior']:
            rec['r_prior'] = round(float(np.nanmean(d['prior'])), 3)
            rec['r_blend'] = round(float(np.nanmean(d['blend'])), 3)
        rows = carry_rows.get((pos, m, N))
        if rows:
            p = pd.concat(rows)
            rec['player_games'] = int(len(p))
            rec['slope_raw'] = round(slope(p.ratio_raw - 1, p.rel), 3)
            rec['slope_oe'] = round(slope(p.ratio_oe - 1, p.rel), 3)
            n4 = p[p.next4]
            rec['slope_raw_next4'] = round(slope(n4.ratio_raw - 1, n4.rel), 3)
            rec['slope_oe_next4'] = round(slope(n4.ratio_oe - 1, n4.rel), 3)
            if 'ratio_blend' in p:
                rec['slope_blend'] = round(slope(p.ratio_blend - 1, p.rel), 3)
            rec['rel_soft8'] = round(float(p[p.rank_raw <= 8].rel.mean()), 3)
            rec['rel_mid'] = round(float(p[(p.rank_raw > 8) & (p.rank_raw <= 24)].rel.mean()), 3)
            rec['rel_tough8'] = round(float(p[p.rank_raw > 24].rel.mean()), 3)
        out.setdefault(pos, {}).setdefault(m, {})[str(N)] = rec

    doc = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'seasons': f'{FIRST}-{LAST}',
        'cuts': list(CUTS),
        'note': (
            'Backtest of the strength-of-matchup ledger. For each position, metric '
            'and N weeks played: r_raw = mean Spearman correlation across defenses '
            'between weeks 1..N allowed per game and weeks N+1..end; r_oe = the same '
            'with over-expected as the predictor; r_oe_vs_oe = OE predicting rest-of-'
            'season OE; r_prior / r_blend (points only) = the prior season alone and '
            'the weekly projections blend (w = N/(N+6)) predicting the rest of the '
            'season. slope_* = fraction of the opponent deviation that shows up in '
            'the players facing it (rel = player value / his mean in his other '
            'games, regressed on ratio - 1); rel_soft8 / rel_mid / rel_tough8 = mean '
            'rel against a top-8, middle-16 and bottom-8 defense by raw rank. '
            '*_next4 variants score only weeks N+1..N+4 instead of the rest of the '
            'season. Rates (ypc, ypr) and TD counts have no player-level test.'
        ),
        'results': out,
    }
    path = os.path.join(DATA, 'matchups-backtest.json')
    with open(path, 'w') as fh:
        json.dump(doc, fh, indent=1)
        fh.write('\n')
    print(f'Wrote {path}')

    # Console summary at N=4 and N=9.
    for N in (4, 9):
        print(f'\n=== After {N} weeks ===')
        print(f"{'pos':3} {'metric':8} {'r_raw':>6} {'r_oe':>6} {'r_n4':>6} {'r_prior':>7} {'r_blend':>7} | {'slope_raw':>9} {'slope_oe':>8} {'sl_n4':>6} {'soft8':>6} {'tough8':>6} {'n':>7}")
        for pos in POSITIONS:
            for m in ['ppr'] + METRICS[pos]:
                r = out.get(pos, {}).get(m, {}).get(str(N))
                if not r:
                    continue
                print(f"{pos:3} {m:8} {r['r_raw']:6.2f} {r['r_oe']:6.2f} {r['r_raw_next4']:6.2f} {r.get('r_prior', float('nan')):7.2f} {r.get('r_blend', float('nan')):7.2f} | "
                      f"{r.get('slope_raw', float('nan')):9.2f} {r.get('slope_oe', float('nan')):8.2f} {r.get('slope_raw_next4', float('nan')):6.2f} {r.get('rel_soft8', float('nan')):6.2f} {r.get('rel_tough8', float('nan')):6.2f} {r.get('player_games', 0):7d}")


if __name__ == '__main__':
    main()
