#!/usr/bin/env python3
"""Early NFL mock drafts for classes beyond the big board (WalterFootball's
Charlie Campbell mock, walterfootball.com/draft<YEAR>charlie.php and _1).

The devy draft outlook (scripts/build-devy-rankings.py) blends the college
model with a projected pick where one exists: the 2027 class has StatHead's
big board (career-2027.json); classes after it had nothing, and college stats
alone cannot see what decides a QB's draft slot (one season out the model gave
Justin Herbert 7% and Jared Goff 4% for round 1). This mock is published about
two years ahead, round 1 only.

A third-party projection: an INPUT only, never shown. Written to
data/mock-drafts/<year>.json (outside public/, not served):
  {"source": "walterfootball-charlie", "year", "fetchedAt", "updated",
   "picks": [{"pick", "name", "pos", "school"}]}
A page that does not exist yet (the mock for that year not started) is
skipped; a failed fetch leaves the previous file in place.

Usage: python3 scripts/fetch_walter_mock.py [--years 2028 2029]
"""
from __future__ import annotations

import argparse
import html
import json
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path('data/mock-drafts')
BASE = 'https://walterfootball.com/draft{year}charlie{part}.php'
UA = {'User-Agent': 'Mozilla/5.0 (StatHead devy model)'}


def get(url: str) -> str | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
            return r.read().decode('utf-8', 'ignore')
    except Exception:  # noqa: BLE001 -- 404 (no mock yet) or a network error: skip
        return None


def parse(page: str) -> tuple[list[dict], str | None]:
    t = re.sub(r'<script.*?</script>|<style.*?</style>', '', page, flags=re.S)
    lines = [x.strip() for x in html.unescape(re.sub(r'<[^>]+>', '\n', t)).split('\n') if x.strip()]
    picks = []
    for i, x in enumerate(lines):
        m = re.fullmatch(r'(\d{1,3})\.', x)
        if m and i + 3 < len(lines) and lines[i + 1].endswith(':') and lines[i + 2].endswith(','):
            pm = re.match(r'([A-Z/]+), (.+)', lines[i + 3])
            if pm:
                picks.append({'pick': int(m.group(1)), 'name': lines[i + 2].rstrip(','),
                              'pos': pm.group(1), 'school': pm.group(2)})
    up = re.search(r'Updated (\d{1,2}/\d{1,2})', ' '.join(lines[:400]))
    return picks, up.group(1) if up else None


def main() -> None:
    now = datetime.now(timezone.utc)
    ap = argparse.ArgumentParser()
    ap.add_argument('--years', type=int, nargs='*')
    args = ap.parse_args()
    # The draft after next and the one after that (the nearest class has the big board).
    first = now.year + (2 if now.month >= 5 else 1)
    OUT.mkdir(parents=True, exist_ok=True)
    for year in args.years or (first, first + 1):
        picks, updated = [], None
        for part in ('', '_1', '_2', '_3'):
            page = get(BASE.format(year=year, part=part))
            if not page:
                break
            got, up = parse(page)
            if not got:
                break
            picks += got
            updated = updated or up
            time.sleep(1)
        if not picks:
            print(f'{year}: no mock yet')
            continue
        picks = sorted({p['pick']: p for p in picks}.values(), key=lambda p: p['pick'])
        (OUT / f'{year}.json').write_text(json.dumps(
            {'source': 'walterfootball-charlie', 'year': year, 'fetchedAt': now.isoformat(timespec='seconds'),
             'updated': updated, 'picks': picks}, indent=1))
        print(f'{year}: {len(picks)} picks (updated {updated})')


if __name__ == '__main__':
    main()
