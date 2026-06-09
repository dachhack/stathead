#!/usr/bin/env python3
"""Fetch the full Sleeper NFL players list and write a slim, stable snapshot.

Sleeper's /v1/players/nfl endpoint is ~15 MB and covers every player they
track (not just dynasty-relevant ones like FantasyCalc), so it is the broadest
source of (name, position) -> sleeper_id we have. The crosswalk builder uses
this to backfill sleeper_id on gsis-less rookies that FantasyCalc doesn't list
yet (see backfill_sleeper_ids_from_sleeper in build-player-crosswalk.py).

We keep only fantasy-relevant positions (QB/RB/WR/TE/K, or anyone whose
fantasy_positions include one) and only the identity fields we need, sorted by
player_id for stable, reviewable diffs.

Usage:  python3 scripts/fetch-sleeper-players.py [out_dir]
        (out_dir defaults to public/data)
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

URL = 'https://api.sleeper.app/v1/players/nfl'
SKILL = {'QB', 'RB', 'WR', 'TE', 'K'}


def slim(p: dict) -> dict | None:
    name = p.get('full_name') or f"{p.get('first_name', '')} {p.get('last_name', '')}".strip()
    pos = p.get('position')
    if not name or not pos:
        return None
    fantasy = p.get('fantasy_positions') or []
    if pos not in SKILL and not (set(fantasy) & SKILL):
        return None
    rec: dict = {
        'player_id': p.get('player_id'),
        'name': name,
        'position': pos,
        'team': p.get('team'),
        'gsis_id': p.get('gsis_id'),
        'espn_id': p.get('espn_id'),
    }
    if fantasy:
        rec['fantasy_positions'] = fantasy
    # Drop empty optional fields so the file stays compact.
    return {k: v for k, v in rec.items() if v not in (None, '')}


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/data')
    out_dir.mkdir(parents=True, exist_ok=True)

    req = urllib.request.Request(URL, headers={'User-Agent': 'stathead-crosswalk/1.0'})
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = json.loads(resp.read().decode())

    players = [s for p in raw.values() if (s := slim(p))]
    players.sort(key=lambda r: int(r['player_id']) if str(r.get('player_id', '')).isdigit() else 1 << 62)

    out = out_dir / 'sleeper-players.json'
    out.write_text(json.dumps({'players': players}, separators=(',', ':')))
    with_gsis = sum(1 for r in players if r.get('gsis_id'))
    print(f'Wrote {out} — {len(players)} fantasy-relevant players '
          f'({with_gsis} with gsis, {len(players) - with_gsis} without)')


if __name__ == '__main__':
    main()
