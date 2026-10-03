#!/usr/bin/env python3
"""Weekly snapshots of the devy market's prices, so that "does a devy price
predict the draft round?" can be measured on real drafts.

Today there is no devy price history before September 2026, so the draft
outlook's market fallback (scripts/build-devy-rankings.py) is calibrated on
the 2027 big board, not on drafts. These snapshots fix that: after the 2027
draft, scripts/validate_devy_market_round.py scores each snapshot's prices
against the actual rounds (one season out, and later two).

A third-party price: an INPUT only, never shown. Writes
data/devy-market-history/<YYYY-MM-DD>.json (outside public/, not served):
  {"date", "players": {ktcId: [name, pos, draftYear, superflexValue, oneQBValue]}}
--backfill writes one snapshot per day the file changed in git history.

Usage: python3 scripts/snapshot_devy_market.py [--backfill]
"""
from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

SRC = 'public/data/ktc_rankings_devy.json'
OUT = Path('data/devy-market-history')


def compact(rows: list) -> dict:
    return {str(k['playerID']): [k.get('playerName'), k.get('position'), k.get('draftYear'),
                                 k.get('superflexValue'), k.get('value')] for k in rows if k.get('playerID')}


def write(date: str, rows: list) -> bool:
    p = OUT / f'{date}.json'
    if p.exists() or not rows:
        return False
    p.write_text(json.dumps({'date': date, 'players': compact(rows)}, separators=(',', ':')))
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--backfill', action='store_true')
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    n = 0
    if args.backfill:
        log = subprocess.run(['git', 'log', '--format=%H %ad', '--date=short', '--', SRC],
                             capture_output=True, text=True, check=True).stdout.split('\n')
        for line in log:
            if not line.strip():
                continue
            sha, date = line.split()
            try:
                rows = json.loads(subprocess.run(['git', 'show', f'{sha}:{SRC}'], capture_output=True, text=True,
                                                 check=True).stdout)
            except (subprocess.CalledProcessError, json.JSONDecodeError):
                continue
            n += write(date, rows)
    if Path(SRC).exists():
        n += write(datetime.now(timezone.utc).strftime('%Y-%m-%d'), json.load(open(SRC)))
    print(f'devy market snapshots: {n} new, {len(list(OUT.glob("*.json")))} total')


if __name__ == '__main__':
    main()
