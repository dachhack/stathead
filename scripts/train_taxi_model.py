#!/usr/bin/env python3
"""Train the taxi ramp model and emit public/data/score-store/taxi.json.

The model scores YEAR-2 taxi decisions (player drafted in class C, decision
made entering season C+1) with three calibrated-ish probabilities:

    p1    — P(streamable in season C+1)   "his value is NOW"
    p2    — P(streamable in season C+2)   "his value is NEXT year"
    pEver — P(streamable within 4 years)  "his value ever comes"

"Streamable" = the QB32 / RB60 / WR72 / TE36 season-PPG line (QB 11.5 /
RB 6.0 / WR 7.5 / TE 5.5 PPR PPG, >=6 games) — see DraftKitValidation.

Features come from the committed feature store at the decision season
(::C+1): rookie-year production (priorStats + weekly truth), year-2 market
ADP (profile / momentum), situation shards where available (competition
depth rank, new teammates drafted, routes YPRR, injuries, coaching, vegas
win totals — ~33% coverage, NaN elsewhere; HistGradientBoosting treats
missingness as signal, and "no year-2 ADP row" IS signal), plus the
draft-time career-model profile (capital, combine, college percentile,
threshold probs).

Validation: leave-one-class-out across 2010-2023 (no class predicts
itself). Verdict thresholds (p1 >= 0.50 -> Roster; pEver <= 0.12 -> Drop;
else Taxi) were chosen so the Taxi bucket is forward-loaded (streamable %
rises from the stash season to the next) while drop regret stays at/below
the hand-tuned rule tree it replaces. Headline LOSO numbers live in the
emitted meta and on the Model Docs page.

Rerun after a data refresh:
    pip install scikit-learn pandas
    python3 scripts/train_taxi_model.py
Then commit public/data/score-store/taxi.json. Rookie verdicts are NOT
model-scored (no NFL data yet) — the advisor keeps the rule tree for them.
"""
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
FS = ROOT / 'public/data/feature-store'
OUT = ROOT / 'public/data/score-store/taxi.json'

CUT = {'QB': 11.5, 'RB': 6.0, 'WR': 7.5, 'TE': 5.5}
SK = {'QB': '16', 'RB': '12', 'WR': '12', 'TE': '9'}
THRESHOLDS = {'roster': 0.50, 'drop': 0.12}
SEED = 7
LAST_PLAYED_SEASON = 2025   # bump yearly
CURRENT_SEASON = 2026       # the season the live year-2 class is entering


def norm(s: str) -> str:
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r"[^a-z ]", "", s)
    s = re.sub(r"\s+(jr|sr|ii|iii|iv|v)$", "", s)
    return re.sub(r"\s+", " ", s).strip()


def load_truth():
    """(normName, pos, season) -> (ppg, games) from committed weekly stats."""
    truth = {}
    for season in range(2010, LAST_PLAYED_SEASON + 1):
        df = pd.read_csv(ROOT / f'public/data/player_stats_{season}.csv.gz', low_memory=False)
        if 'season_type' in df.columns:
            df = df[df.season_type == 'REG']
        namecol = 'player_display_name' if 'player_display_name' in df.columns else 'player_name'
        poscol = 'position' if 'position' in df.columns else 'position_group'
        g = df.groupby([namecol, poscol]).agg(
            pts=('fantasy_points_ppr', 'sum'), games=('fantasy_points_ppr', 'count')).reset_index()
        for _, r in g.iterrows():
            truth[(norm(r[namecol]), r[poscol], season)] = (
                r.pts / r.games if r.games else 0.0, int(r.games))
    return truth


def streamable(truth, n, pos, season):
    v = truth.get((n, pos, season))
    return bool(v and v[1] >= 6 and v[0] >= CUT[pos])


def build_rows(career, truth, shards, classes, decision_offset=1, live_adp=None):
    rows = []
    for r in career:
        C = r['draftSeason']
        if C not in classes:
            continue
        n = norm(r['name'])
        pos = r['position']
        if pos not in CUT:
            continue
        D = C + decision_offset            # decision season
        key = f"{n}::{D}"
        f = r.get('features', {})
        y1 = truth.get((n, pos, C), (0.0, 0))
        g = lambda shard, k: shards[shard].get(key, {}).get(k, np.nan)  # noqa: E731
        # Year-2 market ADP: the profile shard for historical seasons; the
        # live market files for the current season (the shard has no
        # current-season rows, and "no ADP" must mean "market is out",
        # not "data missing").
        adp, has_adp = g('profile', 'adp'), int(key in shards['profile'])
        if live_adp is not None and not has_adp:
            ov = live_adp.get(f"{n}::{pos}")
            if ov is not None:
                adp, has_adp = ov, 1
        rows.append(dict(
            name=r['name'], pos=pos, C=C,
            # draft-time profile + career-model outputs
            draftRound=f.get('nflDraftRound', 8), logPick=f.get('logDraftPick', np.nan),
            age=f.get('age', np.nan), weight=f.get('weight', np.nan), forty=f.get('forty', np.nan),
            pct=r['percentile'], sp=r.get('thresholdProbs', {}).get(SK[pos], np.nan),
            boom=r['boomProb'], bust=r['bustProb'], predPPG=r['predictedPPG'],
            isQB=int(pos == 'QB'), isRB=int(pos == 'RB'), isWR=int(pos == 'WR'), isTE=int(pos == 'TE'),
            # rookie-year production
            y1ppg=y1[0], y1games=y1[1], y1gap=y1[0] - CUT[pos],
            y1snapPct=g('priorStats', 'priorSnapPct'), y1touches=g('priorStats', 'priorTotalTouches'),
            y1targets=g('priorStats', 'priorTargets'), y1recYds=g('priorStats', 'priorRecYards'),
            y1rushYds=g('priorStats', 'priorRushYards'), y1gamesMissed=g('priorStats', 'priorGamesMissed'),
            # year-2 market
            adp=adp, hasAdp=has_adp,
            adpTrend=g('momentum', 'adpTrend'),
            # situation (sparse, missingness = signal)
            depthRank=g('competition', 'depthChartRank'), newSamePos=g('competition', 'newSamePosAdded'),
            draftedSamePos=g('competition', 'teamDraftedSamePos'),
            capSamePos=g('competition', 'draftCapitalSamePos'),
            matePPR=g('competition', 'teammatePriorPPR'),
            teamTouchShare=g('competition', 'priorTeamTouchShare'),
            tgtShare=g('advanced', 'priorTargetShare'), wopr=g('advanced', 'priorWOPR'),
            rzShare=g('advanced', 'priorRZTargetShare'),
            yprr=g('routes', 'priorYPRR'), routes=g('routes', 'priorRoutesRun'),
            injWeeks=g('injuries', 'priorInjuryWeeks'),
            newHC=g('coaching', 'newHeadCoach'), teamPassRate=g('coaching', 'teamPassRate'),
            winTotal=g('vegas', 'vegasSeasonWinTotal'),
            sep=g('ngs', 'priorSeparation'), boomRate=g('consistency', 'priorBoomRate'),
            # targets (NaN when the season hasn't been played)
            s1=int(streamable(truth, n, pos, C + 1)) if C + 1 <= LAST_PLAYED_SEASON else np.nan,
            s2=int(streamable(truth, n, pos, C + 2)) if C + 2 <= LAST_PLAYED_SEASON else np.nan,
            ever=int(any(streamable(truth, n, pos, C + k) for k in (1, 2, 3, 4)))
                if C + 4 <= LAST_PLAYED_SEASON + 1 else np.nan,
        ))
    return pd.DataFrame(rows)


def make_model():
    return HistGradientBoostingClassifier(
        max_iter=200, learning_rate=0.06, max_depth=3,
        min_samples_leaf=25, l2_regularization=1.0, random_state=SEED)


def main():
    truth = load_truth()
    shards = {f: json.load(open(FS / f'{f}.json')) for f in
              ['priorStats', 'advanced', 'competition', 'coaching', 'injuries', 'routes',
               'momentum', 'profile', 'vegas', 'ngs', 'consistency']}
    career = json.load(open(ROOT / 'public/data/score-store/career.json'))

    train = build_rows(career, truth, shards, classes=set(range(2010, 2025)))
    feats = [c for c in train.columns if c not in ('name', 'pos', 'C', 's1', 's2', 'ever')]

    meta = {'trainedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'thresholds': THRESHOLDS, 'features': len(feats), 'loso': {}}
    models = {}
    for target in ('s1', 's2', 'ever'):
        d = train.dropna(subset=[target])
        # LOSO validation
        preds = np.full(len(d), np.nan)
        idx = d.reset_index(drop=True)
        for C in sorted(idx.C.unique()):
            tr, te = idx[idx.C != C], idx[idx.C == C]
            if te.empty or tr[target].nunique() < 2:
                continue
            m = make_model().fit(tr[feats], tr[target].astype(int))
            preds[idx.C == C] = m.predict_proba(te[feats])[:, 1]
        mask = ~np.isnan(preds)
        auc = roc_auc_score(idx[target].astype(int)[mask], preds[mask])
        meta['loso'][target] = {'auc': round(float(auc), 3), 'n': int(len(d))}
        # final fit on everything with a known target
        models[target] = make_model().fit(d[feats], d[target].astype(int))
        print(f"{target}: n={len(d)} LOSO AUC={auc:.3f}")

    # Score the live year-2 class, with current market ADP (FFC, then
    # FantasyCalc consensus rank as a pick proxy) standing in for the
    # profile shard's not-yet-built current-season rows.
    live_adp = {}
    fc = json.load(open(ROOT / 'public/data/fantasycalc_redraft_1qb.json'))
    for v in fc:
        p = v.get('player') or {}
        if p.get('name'):
            live_adp[f"{norm(p['name'])}::{p.get('position')}"] = float(v['overallRank'])
    ffc = json.load(open(ROOT / f'public/data/ffc_adp_ppr_{CURRENT_SEASON}.json'))
    for p in (ffc.get('players') if isinstance(ffc, dict) else ffc) or []:
        if p.get('name'):
            live_adp[f"{norm(p['name'])}::{p.get('position')}"] = float(p['adp'])
    live = build_rows(career, truth, shards, classes={CURRENT_SEASON - 1}, live_adp=live_adp)
    players = []
    for i, r in live.iterrows():
        x = live.loc[[i], feats]
        players.append({
            'name': r['name'], 'position': r['pos'],
            'p1': round(float(models['s1'].predict_proba(x)[0, 1]), 3),
            'p2': round(float(models['s2'].predict_proba(x)[0, 1]), 3),
            'pEver': round(float(models['ever'].predict_proba(x)[0, 1]), 3),
        })
    meta['scoredClass'] = CURRENT_SEASON - 1
    meta['scored'] = len(players)
    OUT.write_text(json.dumps({'meta': meta, 'players': players}) + '\n')
    print(f"wrote {OUT.relative_to(ROOT)}: {len(players)} players, meta={meta['loso']}")


if __name__ == '__main__':
    main()
