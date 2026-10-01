#!/usr/bin/env python3
"""Devy player cards: college season lines and the current season's game log
for every player on the devy board (public/data/devy-rankings.json).

Inputs (CollegeFootballData.com, already on disk):
  public/data/cfbd/player-season-<Y>.json          complete seasons (long format)
  public/data/cfbd/inseason/player-season-<Y>.json.gz   the season to date
  public/data/cfbd/inseason/player-games-<Y>.json.gz    per-game box-score lines
  public/data/cfbd/inseason/games-<Y>.json.gz           schedule and scores
  public/data/devy-value-scores.json               who is on the board (cfbdId)

Output: public/data/devy-cards/<shard>.json, shard = int(cfbdId) % SHARDS, so a
card loads one small file: {"season", "throughWeek", "players": {cfbdId:
{"seasons": [...], "games": [...]}}}. Season lines run from SEASONS_BACK seasons
before the current one; the current season is to date (calibrated estimates
are the models' business, the card shows what happened). Stats are facts, not
rankings or values, so the third-party rule does not apply to them.

Stdlib only. Usage: python3 scripts/build_devy_cards.py [data_dir]
"""
from __future__ import annotations

import gzip
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fetch_cfbd_inseason import compact  # noqa: E402

SHARDS = 64
SEASONS_BACK = 5
COLS = ('pass_cmp', 'pass_att', 'pass_yds', 'pass_td', 'pass_int', 'rush_car', 'rush_yds', 'rush_td',
        'rush_long', 'rec', 'rec_yds', 'rec_td', 'rec_long', 'fum_lost')


def load(path: Path, default=None):
    try:
        if path.suffix == '.gz':
            with gzip.open(path, 'rt') as f:
                return json.load(f)
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def line(stats: dict) -> dict:
    """The card's stat columns, integers, zeros dropped."""
    return {c: int(round(stats[c])) for c in COLS if stats.get(c)}


def shard(pid: str) -> int:
    try:
        return int(pid) % SHARDS
    except ValueError:
        return sum(map(ord, pid)) % SHARDS


def main() -> None:
    data = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/data')
    cfbd = data / 'cfbd'
    ids = {str(p['cfbdId']) for p in (load(data / 'devy-value-scores.json', {}) or {}).get('players', [])
           if p.get('cfbdId')}
    if not ids:
        sys.exit('no devy players (devy-value-scores.json)')

    full = sorted(int(p.stem.split('-')[-1]) for p in cfbd.glob('player-season-*.json'))
    cur = load(cfbd / 'inseason' / f'player-season-{full[-1] + 1}.json.gz') if full else None
    season = cur['season'] if cur else full[-1]
    seasons: dict[str, list] = {}
    for y in [y for y in full if y >= season - SEASONS_BACK]:
        for r in compact(load(cfbd / f'player-season-{y}.json', []) or []):
            if r['player_id'] in ids:
                seasons.setdefault(r['player_id'], []).append(r)
    if cur:
        for r in cur['rows']:
            if r['player_id'] in ids:
                seasons.setdefault(r['player_id'], []).append({**r, '_toDate': cur['throughWeek']})

    # Current-season game log, with opponent and score from the schedule.
    games: dict[str, list] = {}
    pg = load(cfbd / 'inseason' / f'player-games-{season}.json.gz') if cur else None
    sched = {g['id']: g for g in (load(cfbd / 'inseason' / f'games-{season}.json.gz', []) or [])}
    for w, rows in ((pg or {}).get('weeks') or {}).items():
        for r in rows:
            if r['player_id'] not in ids:
                continue
            gm = sched.get(r['game']) or {}
            home = gm.get('homeTeam') == r['team']
            opp = gm.get('awayTeam') if home else gm.get('homeTeam')
            pf, pa = (gm.get('homePoints'), gm.get('awayPoints')) if home else (gm.get('awayPoints'), gm.get('homePoints'))
            games.setdefault(r['player_id'], []).append({
                'week': int(w), 'date': (gm.get('startDate') or '')[:10] or None, 'team': r['team'], 'opp': opp,
                'site': 'neutral' if gm.get('neutralSite') else 'home' if home else 'away',
                'result': (f"{'W' if pf > pa else 'L' if pf < pa else 'T'} {pf}-{pa}"
                           if isinstance(pf, int) and isinstance(pa, int) else None),
                **line(r['stats'])})

    out: dict[int, dict] = {}
    for pid in ids:
        ss, gs = seasons.get(pid), games.get(pid)
        if not ss and not gs:
            continue
        card = {'seasons': [{'season': r['season'], 'team': r.get('team'), 'conf': r.get('conference'),
                             **({'throughWeek': r['_toDate']} if r.get('_toDate') else {}),
                             **({'games': len(gs)} if r.get('_toDate') and gs else {}), **line(r)}
                            for r in sorted(ss or [], key=lambda r: r['season'])],
                'games': sorted(gs or [], key=lambda g: g['week'])}
        out.setdefault(shard(pid), {})[pid] = card

    dest = data / 'devy-cards'
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    meta = {'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'season': season,
            'throughWeek': cur['throughWeek'] if cur else None, 'shards': SHARDS,
            'gameLogs': bool(pg)}
    for n in range(SHARDS):
        with open(dest / f'{n}.json', 'w') as f:
            json.dump({**meta, 'players': out.get(n, {})}, f, separators=(',', ':'))
    print(f'devy cards: {sum(len(v) for v in out.values())} players, {sum(map(len, games.values()))} game lines, '
          f'season {season}' + (f' through week {meta["throughWeek"]}' if meta['throughWeek'] else ''))


if __name__ == '__main__':
    main()
