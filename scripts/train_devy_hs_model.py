#!/usr/bin/env python3
"""High-school devy model: what a recruit's profile says about his NFL
fantasy future, before he plays a college snap.

The career model (scripts/train_devy_model.py) scores players from their
college seasons; its only recruit-only rows are players who left college
after three seasons (mostly early entrants), so it would score every
high-schooler like a future first-rounder. This model trains on EVERY
high-school QB / RB / WR / TE / ATH recruit in the 2007-2016 classes (each
class's draft window, class + 3 to class + 6, is measured through 2022),
busts included.

Target: the career model's, for the recruit: HIT, at least one fantasy-
starter season in his first four NFL seasons (6+ games above replacement PPR
PPG per format, 12 teams; 1QB QB13 / RB30 / WR42 / TE13, superflex QB25), at
the position he was drafted at; a logistic in the rating per position group.
Plus P(drafted as a QB/RB/WR/TE). The expected-PPG and value-over-replacement
fits remain only for the held-out metrics.

Recruits are linked to the draft by name within their draft window (school
breaks ties): CFBD's athlete ids cover only 20-60% of the older classes.

Feature: the recruiting composite rating (247; an INPUT, never shown). Held
out one class at a time, nothing beat the rating alone at ordering a
position (size, BMI, dual-threat / all-purpose, committed program's talent
and SP+ all made it worse; so did a gradient-boosted model on the rating
alone, whose steps tie players), so the model is the rating, calibrated per
position group on a smooth increasing curve: a Tweedie GLM (log link, power
1.2) for expected NFL value and a logistic in the rating for
P(drafted). What is ours is that calibration: one cross-position board in
hit chance per format. It orders a class's NFL
outcomes as well as the raw rating does, not better (metrics.board), and
differs from the composite's national order (superflex lifts QBs). Within a
position the order is the composite's, so the board carries no position
rank or position filter (the third-party rule; docs/third-party-data-policy.md).

Scores the classes still in high school (recruiting files newer than the
last enrolled class; DEVY_HS_CLASSES=2027,2028 overrides) and writes
public/data/devy-hs-rankings.json. No third-party grade or rank is written.

Usage: python3 scripts/train_devy_hs_model.py
"""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.linear_model import LogisticRegression, TweedieRegressor
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).parent))
from devy_features import _college_key, load_recruits, load_sp, load_talent  # noqa: E402
from devy_names import norm_name  # noqa: E402
from train_devy_model import FMTS, LAST_SEASON, OUT, REPL_RANK, nfl_outcomes, target  # noqa: E402

TRAIN_CLASSES = range(2007, 2017)
GROUP = {'QB': 'QB', 'PRO': 'QB', 'DUAL': 'QB', 'RB': 'RB', 'APB': 'RB', 'WR': 'WR', 'TE': 'TE', 'ATH': 'ATH'}
GROUPS = ('QB', 'RB', 'WR', 'TE', 'ATH')
NFL_POS = {'FB': 'RB'}
# Tested and rejected (held out by class): height, weight, BMI, sub-position,
# committed program talent / SP+, and a boosted model of the rating.
FEATURES = ['rating']
TWEEDIE_POWER = 1.2


def fit(tname: str, P: pd.DataFrame, ycol: str):
    x = P[FEATURES].values
    if tname == 'drafted' or tname.startswith('hit_'):
        # Unpenalized: the rating spans ~0.7-1.0, and the default penalty
        # flattened the slope until fold-to-fold intercepts decided the order.
        return LogisticRegression(C=1e6, max_iter=5000).fit(x, P[ycol])
    return TweedieRegressor(power=TWEEDIE_POWER, alpha=0.0, link='log', max_iter=5000).fit(x, P[ycol])


def predict(tname: str, m, X: pd.DataFrame) -> np.ndarray:
    x = X[FEATURES].values
    return m.predict_proba(x)[:, 1] if tname == 'drafted' or tname.startswith('hit_') else m.predict(x)


def enrolled_class(now: datetime) -> int:
    return now.year if now.month >= 7 else now.year - 1


def features(r: dict, talent: dict, sp: dict) -> dict:
    h, w = float(r.get('height') or 0), float(r.get('weight') or 0)
    team, Y = r.get('committed'), int(r['rclass'])
    return {'rating': float(r.get('rating') or 0), 'stars': float(r.get('stars') or 0), 'height': h, 'weight': w,
            'bmi': 703 * w / h ** 2 if h > 0 and w > 0 else 0.0,
            'sub_dual': float(r.get('rpos') == 'DUAL'), 'sub_apb': float(r.get('rpos') == 'APB'),
            'committed': float(bool(team)),
            # Program as of his class year (the latest on disk for classes ahead).
            'talent_committed': float(talent.get((team, Y)) or talent.get((team, LAST_SEASON)) or 0) if team else 0.0,
            'sp_committed': float(sp.get((team, Y - 1)) or sp.get((team, LAST_SEASON)) or -30.0) if team else -30.0}


def link_drafts(rec: pd.DataFrame) -> dict:
    """recruit key -> (draft year, pick, gsis, NFL position), by name within
    class + 3 .. class + 6; the school breaks ties."""
    dp = pd.read_csv(OUT / 'draft_picks.csv.gz')
    dp = dp[dp['position'].isin(['QB', 'RB', 'WR', 'TE', 'FB'])]
    by_name = defaultdict(list)
    for r in dp.itertuples():
        by_name[norm_name(str(r.pfr_player_name))].append(
            (int(r.season), int(r.pick), r.gsis_id if isinstance(r.gsis_id, str) else None,
             NFL_POS.get(r.position, r.position), _college_key(str(r.college))))
    out, ambiguous = {}, 0
    for r in rec.itertuples():
        Y = int(r.rclass)
        cand = [d for d in by_name.get(norm_name(str(r.rname)), []) if Y + 3 <= d[0] <= Y + 6]
        if len(cand) > 1:
            school = _college_key(str(r.committed or ''))
            cand = [d for d in cand if d[4] == school] or cand
        if len(cand) == 1:
            out[r.key] = cand[0][:4]
        elif cand:
            ambiguous += 1
    print(f'draft links: {len(out)} recruits drafted at a skill position ({ambiguous} ambiguous, left unlinked)')
    return out


def main() -> None:
    now = datetime.now(timezone.utc)
    e = enrolled_class(now)
    on_disk = sorted(int(p.stem.split('-')[-1]) for p in (OUT / 'cfbd').glob('recruiting-*.json'))
    env = os.environ.get('DEVY_HS_CLASSES')
    hs_classes = [int(x) for x in env.split(',')] if env else [y for y in on_disk if y > e]

    talent = load_talent(range(2005, LAST_SEASON + 1))
    sp = load_sp(range(2005, LAST_SEASON + 1))
    nfl, repl = nfl_outcomes()

    rec = load_recruits(TRAIN_CLASSES)
    rec = rec[rec['rpos'].isin(GROUP)].copy()
    links = link_drafts(rec)
    rows = []
    for r in rec.to_dict('records'):
        d = links.get(r['key'])
        draft, gsis, npos = (d[0], d[2], d[3]) if d else (int(r['rclass']) + 4, None, None)
        npos = npos or GROUP[r['rpos']] if GROUP[r['rpos']] != 'ATH' else (npos or 'WR')
        rows.append({'key': r['key'], 'cls': int(r['rclass']), 'group': GROUP[r['rpos']],
                     'drafted': float(d is not None), 'y': target(gsis, draft, nfl),
                     **{f'y_vor_{f}': target(gsis, draft, nfl, repl[f][npos]) for f in FMTS},
                     **features(r, talent, sp)})
    D = pd.DataFrame(rows)
    for f in FMTS:
        D[f'hit_{f}'] = (D[f'y_vor_{f}'] > 0).astype(int)
    print(f'{len(D)} recruits {TRAIN_CLASSES.start}-{TRAIN_CLASSES.stop - 1}, {int(D.drafted.sum())} drafted, '
          f'{int((D.y > 0).sum())} with an NFL season')

    # hit_<fmt>: a fantasy-starter season in his first four NFL seasons (the
    # career model's target, scripts/train_devy_model.py). The expected-PPG and
    # value-over-replacement targets stay for the held-out metrics only.
    TARGETS = {'ppg': 'y', 'vor_oneQB': 'y_vor_oneQB', 'vor_sf': 'y_vor_sf', 'drafted': 'drafted',
               'hit_oneQB': 'hit_oneQB', 'hit_sf': 'hit_sf'}
    models, metrics = {}, {}
    for g in GROUPS:
        P = D[D['group'] == g].reset_index(drop=True)
        for tname, ycol in TARGETS.items():
            if tname in ('vor_sf', 'hit_sf') and g != 'QB':
                base = tname.replace('_sf', '_oneQB')
                models[(tname, g)] = models[(base, g)]
                P[f'oof_{tname}'] = P[f'oof_{base}']
                continue
            if tname.startswith('hit_') and P[ycol].nunique() < 2:
                continue
            oof = np.zeros(len(P))
            for c in TRAIN_CLASSES:
                tr, te = P['cls'] != c, P['cls'] == c
                if te.any():
                    oof[te.values] = predict(tname, fit(tname, P[tr], ycol), P[te])
            models[(tname, g)] = fit(tname, P, ycol)
            P[f'oof_{tname}'] = oof
            D.loc[D.index[D['group'] == g], f'oof_{tname}'] = oof
        # Held out by class, within the position: the model is increasing in
        # the rating, so it orders a position exactly as the rating does (shown
        # for the record); AUC for drafted.
        res = {'n': int(len(P)), 'drafted': int(P['drafted'].sum()), 'producers': int((P['y'] > 0).sum())}
        for col, name in (('oof_ppg', 'model'), ('rating', 'rating')):
            rhos, hits = [], []
            for _, G in P.groupby('cls'):
                if G['y'].std() > 0:
                    rhos.append(spearmanr(G[col], G['y']).statistic)
                    top = set(G[G['y'] > 0].nlargest(12, 'y').index)
                    hits.append(len(set(G.nlargest(12, col).index) & top))
            res[name] = {'spearman': round(float(np.nanmean(rhos)), 3), 'top12Hits': round(float(np.mean(hits)), 2),
                         'aucDrafted': round(float(roc_auc_score(P['drafted'], P['oof_drafted' if name == 'model' else 'rating'])), 3)
                         if P['drafted'].nunique() > 1 else None}
        metrics[g] = res
        print(g, json.dumps(res))
    D.loc[D['group'] != 'QB', 'oof_vor_sf'] = D.loc[D['group'] != 'QB', 'oof_vor_oneQB']
    D.loc[D['group'] != 'QB', 'oof_hit_sf'] = D.loc[D['group'] != 'QB', 'oof_hit_oneQB']
    # Across positions a hit is not worth the same: rank by P(hit) x the mean
    # value above replacement of a hit at that position (hitValue), so the order
    # within a position is the hit chance's and positions share one scale.
    hit_value = {f: {g: float(G.loc[G[f'hit_{f}'] == 1, f'y_vor_{f}'].mean()) if G[f'hit_{f}'].sum() else 0.0
                     for g, G in D.groupby('group')} for f in FMTS}
    for f in FMTS:
        D[f'oof_rank_{f}'] = D[f'oof_hit_{f}'] * D['group'].map(hit_value[f])
    # The board: one class across positions, by projected value above
    # replacement, against the raw rating across positions (which ignores
    # what a position is worth).
    board = {}
    for f in FMTS:
        res = {}
        for col, name in ((f'oof_rank_{f}', 'model'), ('rating', 'rating')):
            rhos, hits = [], []
            for _, G in D.groupby('cls'):
                y = G[f'y_vor_{f}']
                rhos.append(spearmanr(G[col], y).statistic)
                hits.append(len(set(G.nlargest(24, col).index) & set(G[y > 0].nlargest(24, f'y_vor_{f}').index)))
            res[name] = {'spearman': round(float(np.nanmean(rhos)), 3), 'top24Hits': round(float(np.mean(hits)), 2)}
        board[f] = res
        print('board', f, json.dumps(res))

    # Score the classes still in high school.
    players = []
    H = load_recruits(hs_classes) if hs_classes else pd.DataFrame()
    for r in (H[H['rpos'].isin(GROUP)].to_dict('records') if len(H) else []):
        g = GROUP[r['rpos']]
        X = pd.DataFrame([features(r, talent, sp)])[FEATURES]
        hit = {f: float(predict(f'hit_{f}', models[(f'hit_{f}', g)], X)[0]) if (f'hit_{f}', g) in models else 0.0
               for f in FMTS}
        players.append({
            'id': r['key'], 'name': r['rname'], 'pos': g, 'hsSchool': None, 'city': None, 'state': r.get('state'),
            'committed': r.get('committed') or None, 'class': int(r['rclass']),
            'earliestDraft': int(r['rclass']) + 3,
            'height': r.get('height'), 'weight': r.get('weight'),
            'pDrafted': round(float(predict('drafted', models[('drafted', g)], X)[0]), 3),
            # Chance (percent) of a fantasy-starter season in his first four NFL seasons, per format.
            'hitProb': {f: round(100 * hit[f], 1) for f in FMTS},
            '_hit': {f: hit[f] * hit_value[f].get(g, 0.0) for f in FMTS}})
    # High-school name and hometown (facts, not grades) from the raw file.
    raw = {}
    for y in hs_classes:
        p = OUT / 'cfbd' / f'recruiting-{y}.json'
        if p.exists():
            for x in json.load(open(p)):
                k = str(x.get('athlete_id') or x.get('athleteId') or '') or f"{x.get('name')}|{y}"
                raw[k] = x
    for p in players:
        x = raw.get(p['id']) or {}
        p['hsSchool'], p['city'] = x.get('school'), x.get('city')
    for f in FMTS:
        order = sorted(players, key=lambda p: -p['_hit'][f])
        for i, p in enumerate(order):
            p.setdefault('rank', {})[f] = i + 1
        # No position rank: within a position the order is the recruiting
        # composite's (see the docstring).
        for key, grp in (('classRank', 'class'),):
            seen = defaultdict(int)
            for p in order:
                seen[p[grp]] += 1
                p.setdefault(key, {})[f] = seen[p[grp]]
    players.sort(key=lambda p: p['rank']['sf'])
    for p in players:
        p.pop('_hit', None)
    doc = {'generatedAt': now.isoformat(timespec='seconds'), 'classes': hs_classes,
           'trainClasses': [TRAIN_CLASSES.start, TRAIN_CLASSES.stop - 1], 'replacementPPG': repl,
           'replacementRank': REPL_RANK,
           'hitValue': {f: {g: round(v, 2) for g, v in hv.items()} for f, hv in hit_value.items()}, 'metrics': {'byPosition': metrics, 'board': board},
           'note': ('High-school QB/RB/WR/TE/ATH recruits in classes not yet in college, ranked by StatHead\'s '
                    'high-school model (scripts/train_devy_hs_model.py): hitProb = chance (percent) of at least one '
                    'fantasy-starter season in his first four NFL seasons, per format (above replacement PPR PPG, 12 '
                    'teams; 1QB QB13/RB30/WR42/TE13, superflex QB25); pDrafted = chance he is drafted at a skill '
                    'position. Trained on '
                    'every 2007-2016 high-school skill recruit, busts included. The input is the recruiting '
                    'composite rating (never shown); within a position the order is the composite\'s, so there is '
                    'no position rank. rank / classRank = across positions, on hitProb x the mean value above '
                    'replacement of a past hit at his position (hitValue), so positions share one scale.'),
           'players': players}
    json.dump(doc, open(OUT / 'devy-hs-rankings.json', 'w'), separators=(',', ':'))
    print(f'high-school board: {len(players)} players, classes {hs_classes}')


if __name__ == '__main__':
    main()
