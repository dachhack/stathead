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

Target: the career model's, for the recruit: the mean of his best two PPR
points-per-game seasons in his first four NFL seasons, 0 if he was never
drafted at a skill position; and the same above replacement per format
(12 teams; 1QB QB13 / RB30 / WR42 / TE13, superflex QB25), at the position
he was drafted at. Plus P(drafted as a QB/RB/WR/TE).

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
points per game above replacement per format. It orders a class's NFL
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
    if tname == 'drafted':
        return LogisticRegression(max_iter=2000).fit(x, P[ycol])
    return TweedieRegressor(power=TWEEDIE_POWER, alpha=0.0, link='log', max_iter=5000).fit(x, P[ycol])


def predict(tname: str, m, X: pd.DataFrame) -> np.ndarray:
    x = X[FEATURES].values
    return m.predict_proba(x)[:, 1] if tname == "drafted" else m.predict(x)


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
    print(f'{len(D)} recruits {TRAIN_CLASSES.start}-{TRAIN_CLASSES.stop - 1}, {int(D.drafted.sum())} drafted, '
          f'{int((D.y > 0).sum())} with an NFL season')

    TARGETS = {'ppg': 'y', 'vor_oneQB': 'y_vor_oneQB', 'vor_sf': 'y_vor_sf', 'drafted': 'drafted'}
    models, metrics = {}, {}
    for g in GROUPS:
        P = D[D['group'] == g].reset_index(drop=True)
        for tname, ycol in TARGETS.items():
            if tname == 'vor_sf' and g != 'QB':
                models[(tname, g)] = models[('vor_oneQB', g)]
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
    # The board: one class across positions, by projected value above
    # replacement, against the raw rating across positions (which ignores
    # what a position is worth).
    board = {}
    for f in FMTS:
        res = {}
        for col, name in ((f'oof_vor_{f}', 'model'), ('rating', 'rating')):
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
        ppg = float(predict('ppg', models[('ppg', g)], X)[0])
        players.append({
            'id': r['key'], 'name': r['rname'], 'pos': g, 'hsSchool': None, 'city': None, 'state': r.get('state'),
            'committed': r.get('committed') or None, 'class': int(r['rclass']),
            'earliestDraft': int(r['rclass']) + 3,
            'height': r.get('height'), 'weight': r.get('weight'),
            'pDrafted': round(float(predict('drafted', models[('drafted', g)], X)[0]), 3),
            'careerPPG': round(ppg, 2),
            'careerScore': {f: round(max(0.0, float(predict('vor', models[(f'vor_{f}', g)], X)[0])), 3) for f in FMTS}})
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
        order = sorted(players, key=lambda p: (-p['careerScore'][f], -p['careerPPG']))
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
    doc = {'generatedAt': now.isoformat(timespec='seconds'), 'classes': hs_classes,
           'trainClasses': [TRAIN_CLASSES.start, TRAIN_CLASSES.stop - 1], 'replacementPPG': repl,
           'replacementRank': REPL_RANK, 'metrics': {'byPosition': metrics, 'board': board},
           'note': ('High-school QB/RB/WR/TE/ATH recruits in classes not yet in college, ranked by StatHead\'s '
                    'high-school model (scripts/train_devy_hs_model.py): careerScore = expected mean of his best two '
                    'NFL seasons in his first four, PPR points per game above replacement per format (12 teams); '
                    'careerPPG = the raw projection; pDrafted = chance he is drafted at a skill position. Trained on '
                    'every 2007-2016 high-school skill recruit, busts included. The input is the recruiting '
                    'composite rating (never shown); within a position the order is the composite\'s, so there is '
                    'no position rank. rank / classRank = across positions, on careerScore (raw PPG breaks ties).'),
           'players': players}
    json.dump(doc, open(OUT / 'devy-hs-rankings.json', 'w'), separators=(',', ':'))
    print(f'high-school board: {len(players)} players, classes {hs_classes}')


if __name__ == '__main__':
    main()
