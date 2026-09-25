#!/usr/bin/env python3
"""Snapshot Sleeper's live injury statuses for rostered skill players.

The official NFL report (nflverse injuries_<season>) only carries game
statuses once they are posted (Friday for Sunday games) and does not carry a
status forward from one week to the next. Sleeper's /v1/players/nfl does both:
on 2026-09-24 it already had Jayden Daniels Out, Caleb Williams Doubtful and
Jaxson Dart on IR while the week-3 nflverse file had 8 designations, all
practice-only. The weekly builder stamps these on its rows as `slp` and the MCP
applies them to the current week when the official report has nothing.

Only players on an NFL team with a non-empty injury_status are kept, sorted
by id, so the file is small and its diffs readable.

Usage: python3 scripts/fetch-sleeper-injuries.py [out_dir]   (default public/data)
Output: <out_dir>/sleeper-injuries-<season>.json
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = 'https://api.sleeper.app/v1/players/nfl'
SEASON = 2026
POSITIONS = {'QB', 'RB', 'WR', 'TE', 'K'}


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/data')
    raw = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(URL, headers={'User-Agent': 'stathead-injuries/1.0'})
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = json.loads(resp.read().decode())
            break
        except Exception as e:  # network hiccup: keep the last snapshot
            print(f'attempt {attempt + 1} failed: {e}', file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    if raw is None:
        print('Sleeper unreachable; keeping the existing snapshot.', file=sys.stderr)
        sys.exit(0)

    players = []
    for p in raw.values():
        if p.get('position') not in POSITIONS or not p.get('team') or not p.get('injury_status'):
            continue
        rec = {
            'sleeper_id': str(p.get('player_id')),
            'gsis_id': (p.get('gsis_id') or '').strip() or None,
            'name': p.get('full_name') or f"{p.get('first_name', '')} {p.get('last_name', '')}".strip(),
            'pos': p.get('position'),
            'team': p.get('team'),
            'injury_status': p.get('injury_status'),
            'status': p.get('status'),
            'body_part': p.get('injury_body_part'),
            'news_updated': p.get('news_updated'),
        }
        players.append({k: v for k, v in rec.items() if v not in (None, '')})
    players.sort(key=lambda r: int(r['sleeper_id']) if r['sleeper_id'].isdigit() else 1 << 62)
    if len(players) < 50:  # a partial / broken response: never overwrite with it
        print(f'Only {len(players)} injured players returned; keeping the existing snapshot.', file=sys.stderr)
        sys.exit(0)
    out = {
        'season': SEASON,
        'source': URL,
        'fetchedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'players': players,
    }
    path = out_dir / f'sleeper-injuries-{SEASON}.json'
    path.write_text(json.dumps(out, indent=0, ensure_ascii=False) + '\n')
    print(f'Wrote {path}: {len(players)} players with a Sleeper injury status')


if __name__ == '__main__':
    main()
