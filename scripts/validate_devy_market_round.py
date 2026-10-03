#!/usr/bin/env python3
"""Does a devy price predict the NFL draft round? Run after a draft.

For each devy market snapshot (data/devy-market-history/, written weekly by
scripts/snapshot_devy_market.py) taken before draft YEAR, joins the players
listed for that class to the actual draft (public/data/draft_picks.csv.gz)
and reports, by how far ahead of the draft the snapshot was: AUC of the
superflex price for round 1, for rounds 1-3 and for being drafted, and round-1
rates by price band. Undrafted players count as not drafted.

This is the check the draft outlook's market fallback
(scripts/build-devy-rankings.py, source "model+market") is waiting on; until
then that fallback is calibrated on the 2027 big board, not on drafts.

Usage: python3 scripts/validate_devy_market_round.py YEAR [--draft-date 2027-04-22]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).parent))
from devy_names import norm_name  # noqa: E402

BANDS = ((6000, 1e9), (4000, 6000), (3000, 4000), (2000, 3000), (1000, 2000), (0, 1000))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('year', type=int)
    ap.add_argument('--draft-date', default=None, help='snapshots before this date (default: YEAR-04-20)')
    args = ap.parse_args()
    cutoff = args.draft_date or f'{args.year}-04-20'
    dp = pd.read_csv('public/data/draft_picks.csv.gz')
    dp = dp[dp['season'] == args.year]
    rnd = {norm_name(n): int(r) for n, r in zip(dp['pfr_player_name'], dp['round'])}
    if not rnd:
        sys.exit(f'no {args.year} draft results yet')
    by_month = defaultdict(list)
    for p in sorted(Path('data/devy-market-history').glob('*.json')):
        doc = json.load(open(p))
        if doc['date'] >= cutoff:
            continue
        months = round((pd.Timestamp(cutoff) - pd.Timestamp(doc['date'])).days / 30.4)
        for name, pos, dy, sf, _one in doc['players'].values():
            if dy == args.year and sf:
                by_month[months].append({'name': name, 'pos': pos, 'sf': sf, 'round': rnd.get(norm_name(name), 8)})
    if not by_month:
        sys.exit(f'no devy market snapshots before {cutoff} list {args.year}-class players')
    out = {}
    for m in sorted(by_month):
        D = pd.DataFrame(by_month[m]).groupby('name').agg(sf=('sf', 'mean'), round=('round', 'first'), pos=('pos', 'first'))
        r = {'n': int(len(D)), 'round1': int((D['round'] == 1).sum())}
        for label, y in (('aucRound1', D['round'] == 1), ('aucRounds1to3', D['round'] <= 3), ('aucDrafted', D['round'] <= 7)):
            r[label] = round(float(roc_auc_score(y, D['sf'])), 3) if y.nunique() > 1 else None
        r['bands'] = {f'{lo}-{int(hi) if hi < 1e9 else "+"}': {
            'n': int(((D.sf >= lo) & (D.sf < hi)).sum()),
            'round1': round(float((D.loc[(D.sf >= lo) & (D.sf < hi), 'round'] == 1).mean()), 2) if ((D.sf >= lo) & (D.sf < hi)).any() else None}
            for lo, hi in BANDS}
        out[f'{m}mo'] = r
        print(f'{m} months before the draft:', json.dumps(r))
    Path('data/devy-market-validation').mkdir(parents=True, exist_ok=True)
    json.dump(out, open(f'data/devy-market-validation/{args.year}.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
