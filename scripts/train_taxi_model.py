#!/usr/bin/env python3
"""Train the taxi ramp models and emit public/data/score-store/taxi.json.

Two model families, three probability heads each:

YEAR-2 (player drafted in class C, decision entering season C+1):
    p1    — P(streamable in season C+1)   "his value is NOW"
    p2    — P(streamable in season C+2)   "his value is NEXT year"
    pEver — P(streamable within 4 years)  "his value ever comes"

ROOKIE (decision entering season C, before any NFL games):
    p1    — P(streamable in season C)
    p2    — P(streamable in season C+1)
    pEver — P(streamable in C..C+3)
    Rookie features add the LANDING SPOT, computed from committed roster
    + weekly-stat files for ~98% of the population: best/total prior-year
    PPG of same-position roster mates (is he blocked?), count of
    startable incumbents, room size, other same-position rookies, the
    team's best QB prior-year PPG, and team offensive PPR. Ablation:
    landing spot adds +.013 AUC on p1/pEver over the prospect profile
    alone. Rookie heads are weaker than year-2 (no NFL production):
    LOSO AUC ≈ .78/.75/.80, and p_ever beats the career-model startProb
    baseline (.796 vs .779). The advisor uses rookie scores for
    Roster/Taxi only — rookie DROPS stay on the conservative rule tree
    (model-driven rookie drops ran 17% regret in validation; too hot).

"Streamable" = the QB32 / RB60 / WR72 / TE36 season-PPG line (QB 11.5 /
RB 6.0 / WR 7.5 / TE 5.5 PPR PPG, >=6 games) — see DraftKitValidation.

Validation is leave-one-class-out (no class predicts itself). Year-2
verdict thresholds (p1 >= 0.50 -> Roster; pEver <= 0.12 -> Drop) were
chosen so the Taxi bucket is forward-loaded at low drop regret; rookie
Roster threshold matches (p1 >= 0.50).

Rerun after a data refresh:
    pip install scikit-learn pandas
    python3 scripts/train_taxi_model.py
Then commit public/data/score-store/taxi.json.
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


# ── Rookie decision (landing-spot features from committed rosters/stats) ──

def load_rosters():
    rosters = {}
    for season in range(2010, CURRENT_SEASON + 1):
        try:
            ro = pd.read_csv(ROOT / f'public/data/roster_{season}.csv.gz', low_memory=False)
        except FileNotFoundError:
            continue
        namec = 'full_name' if 'full_name' in ro.columns else 'player_name'
        cols = [namec, 'team', 'position'] + (['entry_year'] if 'entry_year' in ro.columns else [])
        ro = ro[cols].dropna(subset=[namec]).copy()
        ro['n'] = ro[namec].map(norm)
        rosters[season] = ro
    return rosters


def load_team_context():
    """(team, season) -> best-QB prior PPG / team offensive PPR, from weekly stats."""
    qb_best, team_off = {}, {}
    for season in range(2010, LAST_PLAYED_SEASON + 1):
        df = pd.read_csv(ROOT / f'public/data/player_stats_{season}.csv.gz', low_memory=False)
        if 'season_type' in df.columns:
            df = df[df.season_type == 'REG']
        namec = 'player_display_name' if 'player_display_name' in df.columns else 'player_name'
        posc = 'position' if 'position' in df.columns else 'position_group'
        teamc = 'recent_team' if 'recent_team' in df.columns else 'team'
        if teamc not in df.columns:
            continue
        for t, row in df.groupby(teamc).agg(ppr=('fantasy_points_ppr', 'sum')).iterrows():
            team_off[(t, season)] = float(row.ppr)
        qb = df[df[posc] == 'QB'].groupby([teamc, namec]).agg(
            pts=('fantasy_points_ppr', 'sum'), g=('fantasy_points_ppr', 'count')).reset_index()
        qb['ppgv'] = qb.pts / qb.g.clip(lower=1)
        for t, grp in qb.groupby(teamc):
            sub = grp[grp.g >= 6]
            qb_best[(t, season)] = float((sub if len(sub) else grp).ppgv.max())
    return qb_best, team_off


def build_rookie_rows(career, truth, rosters, qb_best, team_off, classes):
    rows = []
    for r in career:
        C = r['draftSeason']
        if C not in classes:
            continue
        n = norm(r['name'])
        pos = r['position']
        if pos not in CUT:
            continue
        f = r.get('features', {})
        ro = rosters.get(C)
        me = ro[ro.n == n] if ro is not None else None
        team = me.team.iloc[0] if me is not None and len(me) else None
        inc_best = inc_n = room_sum = room_size = rook_same = np.nan
        qbq = toff = np.nan
        if team is not None:
            mates = ro[(ro.team == team) & (ro.position == pos) & (ro.n != n)]
            uniq = mates.n.unique()
            room_size = float(len(uniq))
            vals = [p for p, g in (truth.get((m, pos, C - 1), (0.0, 0)) for m in uniq) if g >= 4]
            inc_best = max(vals) if vals else 0.0
            room_sum = float(sum(vals)) if vals else 0.0
            inc_n = float(sum(1 for v in vals if v >= CUT[pos]))
            if 'entry_year' in mates.columns:
                rook_same = float((mates.entry_year == C).sum())
            qbq = qb_best.get((team, C - 1), np.nan)
            toff = team_off.get((team, C - 1), np.nan)
        rows.append(dict(
            name=r['name'], pos=pos, C=C,
            draftRound=f.get('nflDraftRound', 8), logPick=f.get('logDraftPick', np.nan),
            age=f.get('age', np.nan), weight=f.get('weight', np.nan), forty=f.get('forty', np.nan),
            adp=f.get('adp', np.nan), pct=r['percentile'],
            sp=r.get('thresholdProbs', {}).get(SK[pos], np.nan),
            boom=r['boomProb'], bust=r['bustProb'], predPPG=r['predictedPPG'],
            isQB=int(pos == 'QB'), isRB=int(pos == 'RB'), isWR=int(pos == 'WR'), isTE=int(pos == 'TE'),
            incBest=inc_best, incBestGap=(inc_best - CUT[pos]) if inc_best == inc_best else np.nan,
            incStartable=inc_n, roomSum=room_sum, roomSize=room_size, samePosRookies=rook_same,
            qbQuality=qbq, teamOffPPR=toff, hasTeam=int(team is not None),
            s1=int(streamable(truth, n, pos, C)) if C <= LAST_PLAYED_SEASON else np.nan,
            s2=int(streamable(truth, n, pos, C + 1)) if C + 1 <= LAST_PLAYED_SEASON else np.nan,
            ever=int(any(streamable(truth, n, pos, C + k) for k in (0, 1, 2, 3)))
                if C + 3 <= LAST_PLAYED_SEASON else np.nan,
        ))
    return pd.DataFrame(rows)


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

    # ── Rookie decision models ──
    rosters = load_rosters()
    qb_best, team_off = load_team_context()
    rtrain = build_rookie_rows(career, truth, rosters, qb_best, team_off,
                               classes=set(range(2010, CURRENT_SEASON)))
    rfeats = [c for c in rtrain.columns if c not in ('name', 'pos', 'C', 's1', 's2', 'ever')]
    meta['rookie'] = {'loso': {}, 'features': len(rfeats)}
    rmodels = {}
    for target in ('s1', 's2', 'ever'):
        d = rtrain.dropna(subset=[target])
        preds = np.full(len(d), np.nan)
        idx = d.reset_index(drop=True)
        for C in sorted(idx.C.unique()):
            tr, te = idx[idx.C != C], idx[idx.C == C]
            if te.empty or tr[target].nunique() < 2:
                continue
            m = make_model().fit(tr[rfeats], tr[target].astype(int))
            preds[idx.C == C] = m.predict_proba(te[rfeats])[:, 1]
        mask = ~np.isnan(preds)
        auc = roc_auc_score(idx[target].astype(int)[mask], preds[mask])
        meta['rookie']['loso'][target] = {'auc': round(float(auc), 3), 'n': int(len(d))}
        rmodels[target] = make_model().fit(d[rfeats], d[target].astype(int))
        print(f"rookie {target}: n={len(d)} LOSO AUC={auc:.3f}")
    rlive = build_rookie_rows(career, truth, rosters, qb_best, team_off, classes={CURRENT_SEASON})
    rookies = []
    for i, r in rlive.iterrows():
        x = rlive.loc[[i], rfeats]
        rookies.append({
            'name': r['name'], 'position': r['pos'],
            'p1': round(float(rmodels['s1'].predict_proba(x)[0, 1]), 3),
            'p2': round(float(rmodels['s2'].predict_proba(x)[0, 1]), 3),
            'pEver': round(float(rmodels['ever'].predict_proba(x)[0, 1]), 3),
        })
    meta['rookie']['scoredClass'] = CURRENT_SEASON
    meta['rookie']['scored'] = len(rookies)

    OUT.write_text(json.dumps({'meta': meta, 'players': players, 'rookies': rookies}) + '\n')
    print(f"wrote {OUT.relative_to(ROOT)}: {len(players)} year-2 + {len(rookies)} rookies, "
          f"meta={meta['loso']} rookie={meta['rookie']['loso']}")


if __name__ == '__main__':
    main()
