#!/usr/bin/env python3
"""Fetch Sleeper market ADP and write a slim snapshot.

Sleeper's (undocumented) projections endpoint carries per-player ADP from
their own draft rooms — real market data that covers rookies and deep vets
long before FFC's offseason ADP fills out:

    https://api.sleeper.app/projections/nfl/<season>?season_type=regular
        &position[]=QB&position[]=RB&position[]=WR&position[]=TE
        &order_by=adp_ppr

Each row's `stats` object includes adp_ppr / adp_half_ppr / adp_std /
adp_2qb / adp_dynasty (overall pick numbers). This is the same source the
ffscrapr / dynastyprocess ecosystems read.

Like the FFC fetcher, this endpoint is reachable from GitHub runners but
403s ("Host not in allowlist") from the dev sandbox and many networks, so
it runs in CI (.github/workflows/fetch-sleeper-players.yml).

Behaviour is non-destructive: the snapshot is only written when the fetch
returns rows with a usable ADP, so a transient hiccup or an unpopulated
season can never blank out good committed data.

Writes: public/data/sleeper-adp-<season>.json
        { "season": N, "fetchedAt": ISO, "players": [
            { "sleeper_id", "name", "position", "team",
              "adp_ppr", "adp_half_ppr", "adp_std", "adp_2qb", "adp_dynasty" } ] }

Usage:  python3 scripts/fetch-sleeper-adp.py [out_dir] [season]
        (defaults: public/data, 2026)
"""
from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

POSITIONS = ['QB', 'RB', 'WR', 'TE']
ADP_KEYS = ['adp_ppr', 'adp_half_ppr', 'adp_std', 'adp_2qb', 'adp_dynasty']


def fetch(season: int) -> list:
    pos_q = '&'.join(f'position[]={p}' for p in POSITIONS)
    url = (f'https://api.sleeper.app/projections/nfl/{season}'
           f'?season_type=regular&{pos_q}&order_by=adp_ppr')
    req = urllib.request.Request(url, headers={'User-Agent': 'stathead-adp/1.0'})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())
    if isinstance(data, dict):  # some deployments key rows by player_id
        data = list(data.values())
    return data if isinstance(data, list) else []


def slim(row: dict) -> dict | None:
    if not isinstance(row, dict):
        return None
    stats = row.get('stats') or {}
    if not isinstance(stats, dict):
        stats = {}
    # Tolerate adp fields at the top level too. Sleeper reports 999 for
    # "undrafted in this format" — that's a sentinel, not an ADP.
    adp = {}
    for k in ADP_KEYS:
        v = stats.get(k, row.get(k))
        if isinstance(v, (int, float)) and 0 < v < 999:
            adp[k] = round(float(v), 1)
    if not adp:
        return None
    player = row.get('player') or {}
    name = (player.get('full_name')
            or f"{player.get('first_name', '')} {player.get('last_name', '')}".strip())
    pos = player.get('position') or row.get('position')
    if not name or pos not in POSITIONS:
        return None
    rec = {
        'sleeper_id': row.get('player_id') or player.get('player_id'),
        'name': name,
        'position': pos,
        'team': player.get('team') or row.get('team'),
        **adp,
    }
    return {k: v for k, v in rec.items() if v not in (None, '')}


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/data')
    season = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f'sleeper-adp-{season}.json'

    try:
        raw = fetch(season)
    except Exception as e:  # noqa: BLE001 — keep the parent CI job alive
        print(f'[warn] Sleeper ADP fetch failed ({e}); keeping existing {dest.name}')
        return

    players = [s for r in raw if (s := slim(r))]
    players.sort(key=lambda r: r.get('adp_ppr', 1e9))
    if not players:
        print(f'[warn] Sleeper returned {len(raw)} rows but none with a usable ADP; '
              f'keeping existing {dest.name}')
        return

    doc = {
        'season': season,
        'fetchedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'players': players,
    }
    dest.write_text(json.dumps(doc, separators=(',', ':')) + '\n')
    with_team = sum(1 for p in players if p.get('team'))
    print(f'[ok] {dest.name}: {len(players)} players with ADP ({with_team} with a team)')


if __name__ == '__main__':
    main()
