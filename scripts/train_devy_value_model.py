#!/usr/bin/env python3
"""Devy VALUE model: what the devy market (KTC) would pay for a college
player, from his profile, so players beyond KTC's ~100-player list get a
value on the same scale.

Target: log KTC devy value, superflex and 1QB (one model each), for the
players KTC lists. KTC lists only its top ~100, so a model fit on those alone
would price every unlisted player like a listed one. Two parts instead:
P(listed) over the whole current college skill population, and the value
if listed from the listed players; expected value = P(listed) x value if
listed (see CLF / REG below).

Features (scripts/devy_features.py MARKET_FEATURES), as of the end of the
last complete college season: position; estimated age and draft age (no
public college birthdates: from the high-school class); breakout age (first
season with a 20% dominator, 800 scrimmage or 2,000 passing yards); share of
the offense (dominator, receiving / rushing yardage share, CFBD usage rate);
raw counting stats (last season and career); efficiency and explosiveness
(yards per carry / catch, longest play), return yards, fumbles lost; usage
by down (third down, passing / standard downs); team context (pass rate,
points per game, Elo, the best teammate's dominator), transfers; program
(recruiting talent, power conference, SP+ and SP+ offense); competition
level (FBS); recruiting (rating, stars, national rank, talent-rich home
state), height, weight; and, for the class that has one (2027), the draft
board (consensus rank, projected pick).

Validation: 5-fold CV. P(listed): AUC of listed vs the PLAUSIBLE unlisted
players (FBS and a 4-star recruit or real production; against every unlisted
FBS player the task is easy and the AUC flatters), and the share of the
model's top K that KTC lists.
Value if listed: Spearman, R^2 and median log error on held-out listed
players, LightGBM vs ridge (both reported; ridge ships, being the stabler
on ~95 rows), against recruit rating.

Writes public/data/devy-value-model.json (metrics, importances) and
public/data/devy-value-scores.json (current college skill players the model
prices at 5+, and every KTC-listed one: predicted SF / 1QB devy value on
KTC's scale, estimated draft class, the profile features shown on the
board). Run after the KTC snapshot.

Usage: python3 scripts/train_devy_value_model.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold

sys.path.insert(0, str(Path(__file__).parent))
from devy_features import (MARKET_FEATURES, POSITIONS, load_recruits, load_seasons,  # noqa: E402
                           load_sp, load_sp_off, load_talent, load_team_games, load_usage,
                           market_features, nfl_departed, load_current, load_history_cutoff,
                           inseason_fit, current_estimate, inseason_context)
from devy_names import norm_name  # noqa: E402

OUT = Path('public/data')
_TODAY = datetime.now(timezone.utc)
_DONE = _TODAY.year - 1 if _TODAY.month >= 2 else _TODAY.year - 2
LAST_SEASON = max(y for y in range(2005, _DONE + 1) if (OUT / 'cfbd' / f'player-season-{y}.json').exists())
FIRST_CLASS = LAST_SEASON + 2
# Two parts. P(listed): a classifier over every current college skill player
# (is he on KTC's list at all?). Value if listed: a regressor on the listed
# players' log value. Expected value = P(listed) x value if listed: what the
# market pays for a player like him, times the chance he is one it prices.
# (Blending toward the list's floor instead put 5,100 unlisted players at
# ~530, a walk-on priced like KTC's #100.)
CLF = dict(objective='binary', learning_rate=0.04, num_leaves=15, min_data_in_leaf=20,
           feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=3.0, verbose=-1, seed=7, deterministic=True)
CLF_ROUNDS = 300
REG = dict(objective='regression', learning_rate=0.03, num_leaves=4, min_data_in_leaf=8,
           feature_fraction=0.7, bagging_fraction=0.8, bagging_freq=1, lambda_l2=5.0, verbose=-1, seed=7, deterministic=True)
REG_ROUNDS = 300
# Ridge strength, chosen per format by cross-validated Spearman on the
# listed players (64 features on ~95 rows needs it tuned, not fixed).
RIDGE_ALPHAS = (10.0, 30.0, 100.0, 300.0, 1000.0)
SHOW = ['est_age', 'est_draft_age', 'breakout_age', 'best_dominator', 'last_usage', 'last_rec_yds',
        'last_rush_yds', 'last_pass_yds', 'car_td', 'talent_last', 'p4_last', 'sp_last', 'fbs_last',
        'rating', 'stars']


def main() -> None:
    years = range(LAST_SEASON - 4, LAST_SEASON + 1)
    seasons = load_seasons(years)
    talent, sp, sp_off, usage = load_talent(years), load_sp(years), load_sp_off(years), load_usage(years)
    games = load_team_games(years)
    # Season to date: KTC prices what players are doing THIS season, so the
    # profile runs through the latest week, as a full-season estimate (the
    # career model's calibrated estimator; scripts/devy_features.py). Team
    # context as known at the cutoff: last season's SP+ and usage, team
    # scoring through the week. DEVY_INSEASON=0 turns it off.
    S = LAST_SEASON
    cur = load_current() if os.environ.get('DEVY_INSEASON', '1') != '0' else None
    hist_week, hist = load_history_cutoff() if cur else (None, None)
    in_season = None
    if cur and hist_week == cur['week']:
        S = cur['season']
        seasons = load_seasons(years, extra=current_estimate(cur, seasons, inseason_fit(hist_week, hist)))
        sp, sp_off, usage, games = inseason_context(S, cur['week'], cur['games'], sp, sp_off, usage, games)
        talent = {**talent, **cur['talent']}
        in_season = {'season': S, 'throughWeek': cur['week']}
        print(f'in-season: profiles through {S} week {cur["week"]}')
    skill = seasons[seasons['position'].isin(POSITIONS)].copy()
    skill['player_id'] = skill['player_id'].astype(str)
    rec = load_recruits(range(LAST_SEASON - 6, S + 1))
    rec_by_id = {r['player_id']: r for r in rec.to_dict('records') if r['player_id']}
    # Draft boards by class (public/data/prospect-grades-<year>.json), by name + position.
    boards = {}
    for y in range(FIRST_CLASS, FIRST_CLASS + 3):
        try:
            for b in json.load(open(OUT / f'prospect-grades-{y}.json')):
                boards[(y, norm_name(b.get('name', '')), b.get('pos'))] = b
        except (OSError, ValueError):
            pass
    groups = {pid: g for pid, g in skill.groupby('player_id')}

    gone = nfl_departed(OUT, since=LAST_SEASON)

    # Current college skill players: a season in LAST_SEASON, or that year's
    # recruit with no stats yet; not already drafted.
    pool = set(skill.loc[skill['season'].isin({LAST_SEASON, S}), 'player_id'])
    pool |= {pid for pid, r in rec_by_id.items() if (r.get('rclass') or 0) in (LAST_SEASON, S)
             and r.get('rpos') in POSITIONS and pid not in groups}
    people = []
    for pid in sorted(pool):
        g = groups.get(pid, skill.iloc[0:0])
        r = rec_by_id.get(pid)
        pos = g['position'].mode().iloc[0] if len(g) else (r or {}).get('rpos')
        name = g['player'].iloc[-1] if len(g) else (r or {}).get('rname')
        team = g['team'].iloc[-1] if len(g) else (r or {}).get('committed')
        if pos not in POSITIONS or not name or gone(name, pos, team):
            continue
        first = (r or {}).get('rclass') or (int(g['season'].min()) if len(g) else S)
        # In season: no stats yet this season and a fifth college year or
        # later = out of eligibility (or not playing), not a devy asset.
        if in_season and len(g) and int(g['season'].max()) < S and first <= S - 4:
            continue
        people.append({'pid': pid, 'name': name, 'pos': pos, 'team': g['team'].iloc[-1] if len(g) else (r or {}).get('committed'),
                       'g': g, 'r': r, 'draftEst': max(FIRST_CLASS, first + 3)})

    # KTC devy list → CFBD ids (name + position, school to break ties).
    ktc = json.load(open(OUT / 'ktc_rankings_devy.json'))
    by_name = {}
    for p in people:
        by_name.setdefault((norm_name(p['name']), p['pos']), []).append(p)
    listed = {}
    for k in ktc:
        if (k.get('draftYear') or FIRST_CLASS) < FIRST_CLASS:
            continue
        c = by_name.get((norm_name(k['playerName']), k['position']), [])
        if not c:
            # A changed or hyphenated surname ("Ryan Williams" is KTC's "Ryan
            # Coleman-Williams"): same first name, same position, same school,
            # and CFBD's surname is one of KTC's.
            toks = norm_name(k['playerName'].replace('-', ' ')).split()
            tl = (k.get('teamLongName') or '').lower()
            c = [p for p in people if p['pos'] == k['position'] and p['team'] and tl.startswith(str(p['team']).lower())
                 and norm_name(p['name']).split()[:1] == toks[:1] and norm_name(p['name']).split()[-1] in toks[1:]]
        if not c:
            # A nickname ("Hollywood" Smothers): same surname, position and
            # school, when that is a single player.
            tl = (k.get('teamLongName') or '').lower()
            c = [p for p in people if p['pos'] == k['position'] and p['team'] and tl.startswith(str(p['team']).lower())
                 and norm_name(p['name']).split()[-1] == toks[-1]]
            c = c if len(c) == 1 else []
        if not c:
            # A transfer under a nickname ("Hollywood" Smothers, NC State in
            # the CFBD data, Texas on KTC): same surname and position at any
            # school, when that is a single 4-star+ recruit (a KTC devy asset
            # nearly always is; it keeps Naeem Burroughs off WKU's Quincy).
            c = [p for p in people if p['pos'] == k['position'] and norm_name(p['name']).split()[-1] == toks[-1]
                 and ((p['r'] or {}).get('stars') or 0) >= 4]
            c = c if len(c) == 1 else []
        if len(c) > 1:
            tl = (k.get('teamLongName') or '').lower()
            c = [p for p in c if p['team'] and tl.startswith(str(p['team']).lower())] or c
        if c:
            listed[c[0]['pid']] = k

    rows = []
    for p in people:
        k = listed.get(p['pid'])
        dy = (k or {}).get('draftYear') or p['draftEst']
        # Features use the ESTIMATED draft class for everyone. KTC's own draft
        # year exists only for listed players, and computing seasons-to-draft
        # and draft age from it leaked the label (13 of 98 listed players
        # differ from the estimate, a combination no unlisted player can have).
        # KTC's year still sets the class shown on the board.
        est = p['draftEst']
        f = market_features(p['g'], p['pos'], S, est, p['r'], talent, sp, sp_off, usage, p['pid'],
                            games, boards.get((est, norm_name(p['name']), p['pos'])))
        rows.append({'pid': p['pid'], 'name': p['name'], 'pos': p['pos'], 'team': p['team'], 'draftYear': dy,
                     'draftEst': est,
                     'listed': int(k is not None), 'ktcId': (k or {}).get('playerID'),
                     'sf': (k or {}).get('superflexValue') or 0, 'oneQB': (k or {}).get('value') or 0, **f})
    D = pd.DataFrame(rows)
    if os.environ.get('DEVY_DUMP'):
        D.to_pickle(os.environ['DEVY_DUMP'])
        print('dumped', len(D))
        return
    print(f'{len(D)} current college skill players, {D.listed.sum()} on the KTC devy list '
          f'(of {sum(1 for k in ktc if (k.get("draftYear") or FIRST_CLASS) >= FIRST_CLASS)})')

    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    X = D[MARKET_FEATURES]
    listed_any = D['listed'].astype(bool).values
    # P(listed): out-of-fold for the metrics, then on everyone.
    p_oof = np.zeros(len(D))
    folds = list(StratifiedKFold(5, shuffle=True, random_state=7).split(X, listed_any))
    for tr, te in folds:
        c = lgb.train(CLF, lgb.Dataset(X.iloc[tr], listed_any[tr].astype(int)), CLF_ROUNDS)
        p_oof[te] = c.predict(X.iloc[te])
    clf = lgb.train(CLF, lgb.Dataset(X, listed_any.astype(int)), CLF_ROUNDS)
    p_all = clf.predict(X)
    # Listing accuracy. Against every unlisted FBS player the task is easy (most
    # are walk-ons and backups: recruit rating alone scores AUC ~0.83 there),
    # so the headline is the PLAUSIBLE set: unlisted FBS players who look like
    # prospects (4-star+, or 700+ scrimmage / 2,000+ passing yards, or 20%+
    # usage last season). precisionAtK = the share of the model's top K (K =
    # the number KTC lists) that KTC actually lists.
    fbs = (D['fbs_last'] > 0).values | listed_any
    plaus = ((D['fbs_last'] > 0) & ((D['stars'] >= 4) | ((D['last_rush_yds'] + D['last_rec_yds']) >= 700)
             | (D['last_pass_yds'] >= 2000) | (D['last_usage'] >= 0.2))).values | listed_any

    def prec_at_k(score, mask):
        idx = np.where(mask)[0]
        top = idx[np.argsort(-score[idx])[:int(listed_any.sum())]]
        return round(float(listed_any[top].mean()), 3)
    rating = D['rating'].values
    metrics, importance, preds = {'pListed': {
        'aucListedVsUnlistedFBS': round(float(roc_auc_score(listed_any[fbs], p_oof[fbs])), 3),
        'aucListedVsPlausible': round(float(roc_auc_score(listed_any[plaus], p_oof[plaus])), 3),
        'precisionAtK': prec_at_k(p_oof, plaus),
        'nPlausibleUnlisted': int((plaus & ~listed_any).sum()),
        'recruitRating': {'aucFBS': round(float(roc_auc_score(listed_any[fbs], rating[fbs])), 3),
                          'aucPlausible': round(float(roc_auc_score(listed_any[plaus], rating[plaus])), 3),
                          'precisionAtK': prec_at_k(rating, plaus)},
    }}, {}, {}
    contrib = clf.predict(X, pred_contrib=True)[:, :-1]
    imp = {}
    for i, f in enumerate(MARKET_FEATURES):
        sv, xv = contrib[:, i], X[f].values
        rho = spearmanr(xv, sv).statistic if np.std(xv) > 0 and np.std(sv) > 0 else 0.0
        imp[f] = {'meanAbsShap': round(float(np.mean(np.abs(sv))), 4),
                  'direction': round(float(0.0 if np.isnan(rho) else rho), 3)}
    importance['pListed'] = dict(sorted(imp.items(), key=lambda kv: -kv[1]['meanAbsShap']))
    from sklearn.metrics import roc_curve
    fpr, tpr, _ = roc_curve(listed_any[plaus], p_oof[plaus])
    step = max(1, len(fpr) // 60)
    metrics['pListed']['roc'] = [[round(float(a), 3), round(float(b), 3)] for a, b in zip(fpr[::step], tpr[::step])] + [[1.0, 1.0]]
    for fmt in ('sf', 'oneQB'):
        L = listed_any & (D[fmt] > 0).values
        yL = np.log(D.loc[L, fmt].values)
        XL = X[L]
        # Value-if-listed: compare LightGBM with ridge out of fold on the listed.
        idx = np.where(L)[0]
        kf = StratifiedKFold(5, shuffle=True, random_state=11)
        strat = D.loc[L, 'pos'].values
        splits = list(kf.split(XL, strat))
        ridge_oof = {}
        for a in RIDGE_ALPHAS:
            o = np.zeros(L.sum())
            for tr, te in splits:
                r = make_pipeline(StandardScaler(), Ridge(alpha=a)).fit(XL.iloc[tr], yL[tr])
                o[te] = r.predict(XL.iloc[te])
            ridge_oof[a] = o
        alpha = max(RIDGE_ALPHAS, key=lambda a: spearmanr(ridge_oof[a], yL).statistic)
        oof = {'lgb': np.zeros(L.sum()), 'ridge': ridge_oof[alpha]}
        for tr, te in splits:
            m = lgb.train(REG, lgb.Dataset(XL.iloc[tr], yL[tr]), REG_ROUNDS)
            oof['lgb'][te] = m.predict(XL.iloc[te])
        res = {}
        for name, o in oof.items():
            comb = np.log(p_oof[idx]) + o
            res[name] = {
                'spearmanIfListed': round(float(spearmanr(o, yL).statistic), 3),
                'r2IfListed': round(float(1 - np.sum((o - yL) ** 2) / np.sum((yL - yL.mean()) ** 2)), 3),
                'spearmanCombined': round(float(spearmanr(comb, yL).statistic), 3),
                'medianAbsLogErr': round(float(np.median(np.abs(o - yL))), 3),
            }
        # Ridge ships: with ~95 listed rows the LightGBM/ridge ranking flips
        # between runs (within noise), and ridge is the stabler of the two.
        best = 'ridge'
        if best == 'lgb':
            reg = lgb.train(REG, lgb.Dataset(XL, yL), REG_ROUNDS)
            v_all = reg.predict(X)
            importance[fmt] = dict(sorted(zip(MARKET_FEATURES, (float(v) for v in reg.feature_importance('gain'))),
                                          key=lambda x: -x[1])[:12])
        else:
            reg = make_pipeline(StandardScaler(), Ridge(alpha=alpha)).fit(XL, yL)
            v_all = reg.predict(X)
            coef = reg[-1].coef_
            # Standardized coefficients: change in log value per 1 SD of the
            # feature; sign = direction.
            importance[fmt] = dict(sorted(((f, {'coef': round(float(c), 4)}) for f, c in zip(MARKET_FEATURES, coef)),
                                          key=lambda kv: -abs(kv[1]['coef'])))
        # KTC's scale tops out at 9999.
        preds[fmt] = np.minimum(9999.0, p_all * np.exp(v_all))
        v_all = np.minimum(np.log(9999.0), v_all)
        oofv = np.full(len(D), np.nan)
        # For a listed player the question is what KTC should pay him, so the
        # out-of-fold read is the value-if-listed alone.
        oofv[idx] = np.minimum(9999.0, np.exp(oof[best]))
        D[f'oof_{fmt}'] = oofv
        D[f'ifListed_{fmt}'] = np.exp(v_all)
        # Held-out points for the accuracy chart: KTC value vs the value-if-listed read.
        metrics.setdefault('oofPoints', {})[fmt] = [
            {'name': D.loc[i, 'name'], 'pos': D.loc[i, 'pos'], 'ktc': round(float(np.exp(a)), 0),
             'model': round(float(min(9999.0, np.exp(b))), 0)} for i, a, b in zip(idx, yL, oof[best])]
        metrics[fmt] = {'nListed': int(L.sum()), 'regressor': best, 'ridgeAlpha': alpha,
                        'spearmanRecruitRating': round(float(spearmanr(D.loc[L, 'rating'], yL).statistic), 3),
                        **{f'{k}_{kk}': vv for k, v in res.items() for kk, vv in v.items()}}
        print(fmt, json.dumps(metrics[fmt]))
    D['pListed'] = p_all
    print('P(listed) AUC', metrics['pListed'])

    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    out = []
    for i, r in D.iterrows():
        out.append({'cfbdId': r['pid'], 'name': r['name'], 'nameKey': norm_name(r['name']), 'pos': r['pos'],
                    'team': r['team'], 'draftYear': int(r['draftYear']),
                    'ktcId': int(r['ktcId']) if r['listed'] else None,
                    'value': {'sf': round(float(preds['sf'][i]), 1), 'oneQB': round(float(preds['oneQB'][i]), 1)},
                    'pListed': round(float(r['pListed']), 3),
                    'valueIfListed': {'sf': round(float(r['ifListed_sf']), 1), 'oneQB': round(float(r['ifListed_oneQB']), 1)},
                    # Listed players: the value-if-listed out of fold (what the model
                    # says KTC should pay, without having seen his price).
                    'valueOOF': {f: (None if np.isnan(r[f'oof_{f}']) else round(float(r[f'oof_{f}']), 1)) for f in ('sf', 'oneQB')},
                    'profile': {c: (round(float(r[c]), 3) if isinstance(r[c], (int, float, np.floating)) else r[c]) for c in SHOW}})
    # Keep the file small (it is committed daily): KTC-listed players plus
    # anyone the model prices at 5+ in either format; below that a college
    # player is not a devy asset (KTC's own list bottoms out near 20).
    out = [o for o in out if o['ktcId'] or max(o['value'].values()) >= 5]
    out.sort(key=lambda o: -o['value']['sf'])
    json.dump({'generatedAt': now, 'asOfSeason': LAST_SEASON, 'inSeason': in_season, 'metrics': metrics, 'importance': importance,
               'features': MARKET_FEATURES,
               'clf': CLF, 'reg': REG, 'ridgeAlphas': RIDGE_ALPHAS}, open(OUT / 'devy-value-model.json', 'w'), indent=1)
    json.dump({'generatedAt': now, 'asOfSeason': LAST_SEASON, 'inSeason': in_season,
               'note': 'value = modelled KTC devy value (SF / 1QB, KTC 0-9999 scale) from the college profile; '
                       'scripts/train_devy_value_model.py. ktcId set = on the KTC list (its real value wins).',
               'players': out}, open(OUT / 'devy-value-scores.json', 'w'))
    print(f'scored {len(out)}')


if __name__ == '__main__':
    main()
