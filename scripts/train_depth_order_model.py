#!/usr/bin/env python3
"""Depth-order model: predict each team's QB/RB/WR/TE depth ordering.

Trains a small logistic classifier ("is this player his team's #1 at his
position this season?") on PUBLIC data only — prior-season production
(nflverse player_stats), preseason depth-chart rank (nflverse depth_charts),
rookie draft capital (nflverse draft_picks), and community ADP. No proprietary projections
are used or shipped; Mike Clay's projections were only an offline yardstick
during development (RB matches within ~5 pts of his top-1 hit rate, TE
matches it).

Outputs `public/data/depth-order-<season>.json`: per RB/TE on the prediction
season's rosters, a depth score (modeled P(team #1)) and the implied within-
team rank. StatProjections consumes this to seed the "primary" RB/TE instead
of relying on ADP order alone.

Covers all four positions. WR1 is the hardest from public signals (Clay's
human synthesis still leads there), but a target-share + 2-year-prior + ADP feature
set keeps it respectable and, crucially, removes the proprietary dependency.

Usage:
  python3 scripts/train_depth_order_model.py [--season 2026] [--clay /tmp/clay_all.json]

Requires: scikit-learn, numpy  (already used by the training pipeline)
"""
from __future__ import annotations
import csv, json, glob, re, gzip, sys, os
from collections import defaultdict

POSITIONS = ('QB', 'RB', 'WR', 'TE')
TEAM_CANON = {'AZ': 'ARI', 'ARZ': 'ARI', 'JAC': 'JAX', 'LAR': 'LA', 'STL': 'LA',
              'SD': 'LAC', 'OAK': 'LV', 'LVR': 'LV', 'WSH': 'WAS', 'GNB': 'GB',
              'KAN': 'KC', 'NWE': 'NE', 'NOR': 'NO', 'SFO': 'SF', 'TAM': 'TB',
              'CLV': 'CLE', 'BLT': 'BAL', 'HST': 'HOU'}
def norm_team(t): t = (t or '').upper(); return TEAM_CANON.get(t, t)
def norm(n):
    s = re.sub(r'[^a-z ]', '', (n or '').lower())
    return re.sub(r'\s+(jr|sr|ii|iii|iv|v)$', '', s).strip()


def load_actuals():
    act = {}
    for f in glob.glob('public/data/player_stats_20*.csv'):
        yr = int(re.search(r'(\d{4})', f).group(1))
        agg = defaultdict(lambda: {'ppr': 0.0, 'tgt': 0.0, 'att': 0.0, 'team': None, 'pos': None})
        for r in csv.DictReader(open(f)):
            if r.get('season_type') != 'REG' or r.get('position') not in ('QB', 'RB', 'WR', 'TE'):
                continue
            a = agg[(norm(r.get('player_display_name')), yr)]
            a['ppr'] += float(r.get('fantasy_points_ppr') or 0)
            a['tgt'] += float(r.get('targets') or 0)
            a['att'] += float(r.get('attempts') or 0)  # passing attempts (QB volume)
            a['team'] = norm_team(r.get('team') or r.get('recent_team'))
            a['pos'] = r.get('position')
        act.update(agg)
    return act


def load_depth():
    """Modal preseason depth-chart rank per (name, year), plus the set of
    fullbacks to exclude from the RB pool. Handles old + new schema.

    Uses the MODE rank across snapshots, not the min: depth charts churn week to
    week (and list multiple formations), so a backup briefly shown at the top
    would otherwise collapse every player to rank 1 and wipe out the signal.
    """
    from collections import Counter
    ranks = defaultdict(Counter)
    fb = set()
    for g in glob.glob('public/data/depth_charts_20*.csv.gz'):
        yr = int(re.search(r'(\d{4})', g).group(1))
        for r in csv.DictReader(gzip.open(g, 'rt')):
            if 'pos_rank' in r:  # new schema (2026+)
                nm = norm(r.get('player_name')); pos = (r.get('pos_abb') or '').upper()
                try: rank = int(float(r.get('pos_rank')))
                except (TypeError, ValueError): continue
            else:                # old schema (<=2025): weekly
                try:
                    if int(float(r.get('week') or 1)) > 4: continue
                except (TypeError, ValueError): pass
                nm = norm(r.get('full_name') or '')
                pos = (r.get('position') or r.get('depth_position') or '').upper()
                try: rank = int(float(r.get('depth_team')))
                except (TypeError, ValueError): continue
            if not nm: continue
            if pos == 'FB': fb.add((nm, yr))
            ranks[(nm, yr)][rank] += 1
    dc = {k: c.most_common(1)[0][0] for k, c in ranks.items()}
    return dc, fb


def load_draft():
    d = {}
    for r in csv.DictReader(gzip.open('public/data/draft_picks.csv.gz', 'rt')):
        try: d[(norm(r.get('pfr_player_name')), int(r.get('season')))] = int(r.get('pick'))
        except (TypeError, ValueError): pass
    return d


def load_adp():
    """Community ADP per (name, season). 2019-2025 from the training cache,
    current season from the committed FFC snapshot. ADP is public/community
    data (already shipped in the repo) — not a proprietary projection."""
    adp = {}
    try:
        for r in json.load(open('public/data/training-rows-cache-v49.json')).get('rows', []):
            a = r.get('adp')
            if a and a > 0:
                adp[(norm(r.get('name')), r.get('season'))] = float(a)
    except Exception:
        pass
    for f in glob.glob('public/data/ffc_adp_ppr_*.json'):
        try:
            yr = int(re.search(r'(\d{4})', f).group(1))
            for p in (json.load(open(f)).get('players') or []):
                a = p.get('adp')
                if a and a > 0:
                    adp.setdefault((norm(p.get('name')), yr), float(a))
        except Exception:
            pass
    return adp


def load_rosters(season):
    """name -> (team, pos) for the prediction season."""
    out = {}
    p = 'public/data/roster_%d.csv' % season
    pgz = p + '.gz'
    src = open(p) if os.path.exists(p) else (gzip.open(pgz, 'rt') if os.path.exists(pgz) else None)
    if not src: return out
    for r in csv.DictReader(src):
        if r.get('position') in ('QB', 'RB', 'WR', 'TE'):
            out[norm(r.get('full_name'))] = (norm_team(r.get('team')), r.get('position'), r.get('full_name'))
    return out


def main(argv):
    season = 2026
    clay_path = None
    if '--season' in argv: season = int(argv[argv.index('--season') + 1])
    if '--clay' in argv: clay_path = argv[argv.index('--clay') + 1]

    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import make_pipeline
    # Monotonic learner on purpose: the feature set is tiny and elite returnees
    # (e.g. a 400+ PPR RB) sit far outside the training range, where a tree
    # ensemble extrapolates pathologically (it ranked McCaffrey as SF RB3).
    # Logistic stays monotonic in prior production and matches/beats GBM here.
    def make_model():
        return make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000))

    act, (dc, fbset), draft, adp_map = load_actuals(), load_depth(), load_draft(), load_adp()

    # team prior-season volume totals, for the share feature
    team_tgt = defaultdict(float); team_att = defaultdict(float)
    for (nm, yr), a in act.items():
        if a['team']:
            team_tgt[(a['team'], yr)] += a['tgt']
            team_att[(a['team'], yr)] += a['att']

    def feats(nm, yr, pos):
        p1 = act.get((nm, yr - 1)) or {}
        p2 = act.get((nm, yr - 2)) or {}
        prior_ppr = max(p1.get('ppr', 0), p2.get('ppr', 0))  # 2-yr max: robust to a lost season
        if pos == 'QB':
            vol = p1.get('att', 0); tv = team_att.get((p1.get('team'), yr - 1), 0)
        else:
            vol = p1.get('tgt', 0); tv = team_tgt.get((p1.get('team'), yr - 1), 0)
        share = vol / tv if tv > 0 else 0.0
        adp_score = (300 - min(adp_map.get((nm, yr), 300), 300)) / 300.0  # market signal; 0 if undrafted
        return [prior_ppr, vol, share, adp_score, 1.0 / dc.get((nm, yr), 99),
                1.0 if dc.get((nm, yr), 99) == 1 else 0.0,
                300 - min(draft.get((nm, yr), 300), 300)]

    def is_real(a):
        return (a['ppr'] >= 50 or a['att'] >= 100) if a['pos'] == 'QB' \
            else (a['tgt'] >= 15 or a['ppr'] >= 40)

    # training groups from actual rosters 2019..season-1
    groups = defaultdict(list)
    for (nm, yr), a in act.items():
        if a['team'] and a['pos'] in POSITIONS and 2019 <= yr <= season - 1 and is_real(a):
            groups[(a['team'], yr, a['pos'])].append(nm)

    clay = None
    if clay_path and os.path.exists(clay_path):
        clay = {(norm(p['name']), p['season']): p for p in json.load(open(clay_path))}

    models = {}
    for pos in POSITIONS:
        G = [(k, v) for k, v in groups.items() if k[2] == pos and len(v) >= 2]
        seasons = sorted({k[1] for k, _ in G})
        # LOSO accuracy report (model vs prior vs Clay)
        n = t1m = t1p = t1c = 0
        for hold in seasons:
            Xtr, ytr = [], []
            for (t, yr, p), names in G:
                if yr == hold: continue
                truth = max(names, key=lambda nm: act[(nm, yr)]['ppr'])
                for nm in names:
                    Xtr.append(feats(nm, yr, pos)); ytr.append(1 if nm == truth else 0)
            clf = make_model().fit(np.array(Xtr), np.array(ytr))
            for (t, yr, p), names in G:
                if yr != hold: continue
                truth = max(names, key=lambda nm: act[(nm, yr)]['ppr'])
                probs = {nm: clf.predict_proba([feats(nm, yr, pos)])[0, 1] for nm in names}
                n += 1
                t1m += (max(names, key=lambda nm: probs[nm]) == truth)
                t1p += (max(names, key=lambda nm: (act.get((nm, yr - 1)) or {}).get('ppr', 0)) == truth)
                if clay is not None:
                    t1c += (max(names, key=lambda nm: (clay.get((nm, yr)) or {}).get('pts', 0)) == truth)
        msg = '  %s LOSO top-1: model=%.1f%%  prior=%.1f%%' % (pos, 100 * t1m / n, 100 * t1p / n)
        if clay is not None: msg += '  clay=%.1f%%' % (100 * t1c / n)
        print(msg)
        # final model on all training seasons
        Xtr, ytr = [], []
        for (t, yr, p), names in G:
            truth = max(names, key=lambda nm: act[(nm, yr)]['ppr'])
            for nm in names:
                Xtr.append(feats(nm, yr, pos)); ytr.append(1 if nm == truth else 0)
        clf = make_model().fit(np.array(Xtr), np.array(ytr))
        models[pos] = clf

    # ---- predict the target season from current rosters ----
    rosters = load_rosters(season)
    pos_players = defaultdict(list)
    for nm, (team, pos, disp) in rosters.items():
        if pos in POSITIONS and (nm, season) not in fbset:
            pos_players[(team, pos)].append((nm, disp))
    out = []
    for (team, pos), members in pos_players.items():
        clf = models[pos]
        scored = sorted(((nm, disp, float(clf.predict_proba([feats(nm, season, pos)])[0, 1]))
                         for nm, disp in members), key=lambda x: -x[2])
        for rank, (nm, disp, score) in enumerate(scored, 1):
            out.append({'name': disp, 'team': team, 'pos': pos,
                        'depthScore': round(score, 4), 'teamRank': rank})
    outpath = 'public/data/depth-order-%d.json' % season
    json.dump({'season': season, 'positions': list(POSITIONS), 'players': out},
              open(outpath, 'w'))
    print('wrote %d QB/RB/WR/TE depth-order predictions -> %s' % (len(out), outpath))
    # sample: a few teams' predicted RB1/TE1
    by = defaultdict(list)
    for r in out: by[(r['team'], r['pos'])].append(r)
    print('  sample predicted #1s:')
    shown = 0
    for (team, pos), rs in sorted(by.items()):
        if pos == 'RB' and shown < 6:
            top = sorted(rs, key=lambda x: x['teamRank'])[:2]
            print('    %s %s: %s' % (team, pos, ', '.join('%s(%.2f)' % (t['name'], t['depthScore']) for t in top)))
            shown += 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
