"""
Test: relax `teamSamePosCount` roster status filter.

Current: only `status == 'ACT'` counts. Pre-2026 training data had
finalized rosters where backups were ACT, but the 2026 build runs
during free agency where many backup QBs are still UFA — leaving
Lamar Jackson, etc. at teamSamePosCount=0 (the "backup" tier the
model learned).

Test: drop the status filter or relax it to ACT/UFA/RFA/RES/PUP.
Re-augment teamSamePosCount on training rows and on predRows;
retrain QB; see if LOSO improves and Lamar's prediction shifts.
"""

import sys, json, gzip, csv
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))
from train_projection_models import load_rows  # type: ignore
import warnings
warnings.filterwarnings('ignore')

from eval_ppg_features import PPG_CONFIG, loso_eval, train_full_model, predict_2026  # type: ignore

CURRENT = [
    'yearsInLeague', 'invDraftPick', 'draftPickPctOverall',
    'priorTimeToThrow', 'priorPPG', 'priorPPG2yr',
    'teamSamePosCount', 'newArrivalBestPPR',
    'teamNeutralPassRate', 'teamShotgunRate', 'vegasImpliedSpread', 'vegasWinPct',
    'collegeQBR', 'collegeSosFinalYr', 'ppgTrend', 'teamRosterTurnover',
    'priorInjuryWeeks',
    'ppgTrend3yr', 'ppgTrend4yr',
]


def normname(n):
    s = (n or '').lower()
    s = s.replace('.', '').replace("'", "")
    for suf in [' jr', ' sr', ' ii', ' iii', ' iv', ' v']:
        if s.endswith(suf):
            s = s[: -len(suf)]
    return ' '.join(s.split())


def load_roster(season, allowed_statuses):
    """Returns dict keyed by (team, position) → set of player names."""
    path = Path('public/data') / f'roster_{season}.csv.gz'
    if not path.exists():
        return {}
    out = {}
    with gzip.open(path, 'rt') as f:
        rdr = csv.DictReader(f)
        for r in rdr:
            if r['position'] not in ('QB', 'RB', 'WR', 'TE'):
                continue
            if r['status'] not in allowed_statuses:
                continue
            key = (r['team'], r['position'])
            out.setdefault(key, set()).add(normname(r['full_name']))
    return out


def recompute_team_same_pos(rows, allowed):
    """Re-augment teamSamePosCount on training rows using the loosened filter."""
    by_season = {}
    for r in rows:
        s = r['season']
        if s not in by_season:
            by_season[s] = load_roster(s, allowed)
    for r in rows:
        rosters = by_season[r['season']]
        team = (r.get('features') or {}).get('recent_team') or r.get('team') or ''
        # The training data uses recent_team or team. Pull from the row's
        # cached features.
        # Look up by name in any team's QB set first.
        nm = normname(r.get('name', ''))
        # Find this player in the rosters of their season
        found_team = None
        for (t, p), names in rosters.items():
            if p == r['position'] and nm in names:
                found_team = t
                break
        if found_team:
            teammates = rosters.get((found_team, r['position']), set())
            r['features']['teamSamePosCount'] = len(teammates) - (1 if nm in teammates else 0)
        # If not found, leave as-is (carried forward from training cache)


def main():
    print('Loading…')
    rows = load_rows()
    fm = json.load(open('public/data/feature-matrix.json'))
    qb_train = [r for r in rows if r['position'] == 'QB' and r.get('adp', 999) <= 250]
    qb_pred = [r for r in fm['predRows'] if r['position'] == 'QB' and r.get('adp', 999) <= 250]
    cfg = PPG_CONFIG['QB']

    # Baseline (current filter, ACT only)
    base_mae = loso_eval(qb_train, CURRENT, cfg)['mae']
    print(f'Baseline (ACT only): MAE {base_mae:.3f}')

    # Try a few relaxations
    variants = [
        ('ACT + UFA',                {'ACT', 'UFA'}),
        ('ACT + UFA + RFA',          {'ACT', 'UFA', 'RFA'}),
        ('ACT + UFA + RFA + RES + PUP', {'ACT', 'UFA', 'RFA', 'RES', 'PUP'}),
    ]

    # Save baseline values to restore later
    saved = {(normname(r['name']), r['position'], r['season']): r['features'].get('teamSamePosCount')
             for r in rows}

    for label, allowed in variants:
        # Reload rows fresh to avoid mutation state
        fresh = load_rows()
        recompute_team_same_pos(fresh, allowed)
        qb_fresh = [r for r in fresh if r['position'] == 'QB' and r.get('adp', 999) <= 250]
        e = loso_eval(qb_fresh, CURRENT, cfg)
        d = e['mae'] - base_mae
        marker = '✓' if d < -0.005 else ('·' if abs(d) <= 0.005 else '✗')
        # Distribution
        vals = [int(r['features'].get('teamSamePosCount', 0)) for r in qb_fresh]
        from collections import Counter
        c = Counter(vals)
        dist = ', '.join(f'{k}: {c[k]}' for k in sorted(c.keys()))
        print(f'  {label:<35} MAE {e["mae"]:.3f} ΔMAE {d:>+7.3f}  {marker}')
        print(f'    distribution: {dist}')

    # Show what Lamar's value WOULD be under each filter
    print('\nLamar Jackson 2026 teamSamePosCount under each filter:')
    for label, allowed in [('ACT only (current)', {'ACT'})] + variants:
        rosters = load_roster(2026, allowed)
        bal_qbs = rosters.get(('BAL', 'QB'), set())
        nm = normname('Lamar Jackson')
        cnt = len(bal_qbs) - (1 if nm in bal_qbs else 0)
        print(f'  {label:<35} = {cnt}  (BAL QBs: {sorted(bal_qbs)})')


if __name__ == '__main__':
    main()
