#!/usr/bin/env python3
"""Aggregate Sleeper activity for a PRIVATE list of "expert" users.

Reads a gitignored list of expert Sleeper usernames and writes anonymized,
aggregate JSON the site can display — WITHOUT ever publishing the usernames
themselves. Run as part of the regular data update (see
scripts/pull-all-data-sources.sh); the output files are committed/deployed, the
username list is not.

Privacy: the input list (expert-usernames.txt) is gitignored; CI reconstructs
it from the EXPERT_USERNAMES repo secret (see refresh-data.yml) so it's never
committed. The output contains only counts and player ids — no usernames,
display names, or league names — so the committed/deployed data can't be used to
reconstruct the list.

Input:  private/expert-usernames.txt  (gitignored; see the .example template)
          one Sleeper username per line; blank lines and #comments ignored.
Output: public/data/expert-ownership.json
        public/data/expert-adds.json
        public/data/expert-trades.json

Usage:  python3 scripts/build_expert_data.py [--season 2026] [--no-transactions]

Optional: to make usernames unlockable on the DEPLOYED Social Graph, encrypt
the name map with `node scripts/encrypt-expert-names.mjs <passphrase>` and
commit expert-names.enc.json. refresh-data.yml does this automatically when
the EXPERT_NAMES_PASSPHRASE repo secret is set (plaintext still never ships).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = 'https://api.sleeper.app/v1'
LIST_FILE = Path('private/expert-usernames.txt')
OUT_DIR = Path('public/data')


def get(url: str, retries: int = 3):
    """GET JSON with light retry; returns None on persistent failure."""
    for i in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception:
            if i == retries - 1:
                return None
            time.sleep(1.5 * (i + 1))
    return None


def read_usernames() -> list[str]:
    if not LIST_FILE.exists():
        print(f"No {LIST_FILE} found — skipping expert data build.", file=sys.stderr)
        return []
    out: list[str] = []
    for line in LIST_FILE.read_text().splitlines():
        name = line.strip().lstrip('@')
        if name and not name.startswith('#'):
            out.append(name)
    return out


def is_superflex(roster_positions: list[str]) -> bool:
    if 'SUPER_FLEX' in roster_positions:
        return True
    return sum(1 for p in roster_positions if p == 'QB') >= 2


def is_dynasty(league: dict) -> bool:
    return (league.get('settings') or {}).get('type') == 2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', default='2026')
    ap.add_argument('--no-transactions', action='store_true',
                    help='Skip the (heavy) adds/trades transaction scan.')
    ap.add_argument('--weeks', type=int, default=18)
    args = ap.parse_args()

    usernames = read_usernames()
    if not usernames:
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).isoformat(timespec='seconds')

    # player_id -> aggregate ownership counts (anonymized)
    own: dict[str, dict] = {}
    experts_by_player: dict[str, set[str]] = {}
    roster_totals = {'all': 0, 'dynasty': 0, 'redraft': 0, 'sf': 0, '1qb': 0}
    add_counts: dict[str, dict] = {}        # pid -> {count, experts:set, last}
    trades: list[dict] = []
    league_experts: dict[str, dict] = {}  # league_id -> {dynasty, sf, experts:set[int]}
    experts_with_data = 0

    def bump(pid: str, dyn: bool, sf: bool, started: bool, expert: str):
        e = own.setdefault(pid, {'rosters': 0, 'dynasty': 0, 'redraft': 0, 'sf': 0, '1qb': 0, 'starters': 0})
        e['rosters'] += 1
        e['dynasty' if dyn else 'redraft'] += 1
        e['sf' if sf else '1qb'] += 1
        if started:
            e['starters'] += 1
        experts_by_player.setdefault(pid, set()).add(expert)

    for n, username in enumerate(usernames, 1):
        eidx = n - 1
        print(f"[{n}/{len(usernames)}] {username}", file=sys.stderr)
        user = get(f"{API}/user/{username}")
        uid = user.get('user_id') if user else None
        if not uid:
            print(f"  skip — no user_id", file=sys.stderr)
            continue
        leagues = get(f"{API}/user/{uid}/leagues/nfl/{args.season}") or []
        if not leagues:
            continue
        experts_with_data += 1
        for lg in leagues:
            lid = lg.get('league_id')
            if not lid:
                continue
            dyn = is_dynasty(lg)
            sf = is_superflex(lg.get('roster_positions') or [])
            rosters = get(f"{API}/league/{lid}/rosters") or []
            mine = next((r for r in rosters if r.get('owner_id') == uid), None)
            if not mine:
                continue
            roster_totals['all'] += 1
            roster_totals['dynasty' if dyn else 'redraft'] += 1
            roster_totals['sf' if sf else '1qb'] += 1
            league_experts.setdefault(lid, {'dynasty': dyn, 'sf': sf, 'experts': set()})['experts'].add(eidx)
            starters = set(mine.get('starters') or [])
            for pid in (mine.get('players') or []):
                if not pid or pid == '0':
                    continue
                bump(pid, dyn, sf, pid in starters, username)

            if args.no_transactions:
                continue
            my_rid = mine.get('roster_id')
            # Week 0 holds offseason transactions (dynasty trades/adds in the
            # spring), so scan from 0 through the regular season.
            for wk in range(0, args.weeks + 1):
                txns = get(f"{API}/league/{lid}/transactions/{wk}")
                if not txns:
                    continue
                for t in txns:
                    if t.get('status') != 'complete':
                        continue
                    rids = t.get('roster_ids') or []
                    if my_rid not in rids:
                        continue
                    ttype = t.get('type')
                    created = t.get('created')
                    if ttype == 'trade':
                        adds = t.get('adds') or {}
                        drops = t.get('drops') or {}
                        recv = [pid for pid, rid in adds.items() if rid == my_rid]
                        gave = [pid for pid, rid in drops.items() if rid == my_rid]
                        picks = []
                        for pk in (t.get('draft_picks') or []):
                            picks.append({'season': pk.get('season'), 'round': pk.get('round'),
                                          'to': pk.get('owner_id') == my_rid})
                        trades.append({'created': created, 'dynasty': dyn, 'sf': sf, 'expert': eidx,
                                       'received': recv, 'gave': gave, 'picks': picks})
                    elif ttype in ('waiver', 'free_agent'):
                        adds = t.get('adds') or {}
                        for pid, rid in adds.items():
                            if rid != my_rid:
                                continue
                            a = add_counts.setdefault(pid, {'count': 0, 'experts': set(), 'last': 0})
                            a['count'] += 1
                            a['experts'].add(username)
                            if created and created > a['last']:
                                a['last'] = created

    # ── serialize (anonymized) ──
    players = []
    for pid, e in own.items():
        players.append({'id': pid, 'experts': len(experts_by_player.get(pid, ())), **e})
    players.sort(key=lambda p: (-p['experts'], -p['rosters']))

    (OUT_DIR / 'expert-ownership.json').write_text(json.dumps({
        'generated': generated, 'season': args.season,
        'expert_count': experts_with_data, 'roster_totals': roster_totals,
        'players': players,
    }, separators=(',', ':')))

    adds = [{'id': pid, 'count': a['count'], 'experts': len(a['experts']), 'last': a['last']}
            for pid, a in add_counts.items()]
    adds.sort(key=lambda a: (-a['experts'], -a['count']))
    (OUT_DIR / 'expert-adds.json').write_text(json.dumps({
        'generated': generated, 'season': args.season, 'adds': adds,
    }, separators=(',', ':')))

    trades.sort(key=lambda t: -(t.get('created') or 0))
    (OUT_DIR / 'expert-trades.json').write_text(json.dumps({
        'generated': generated, 'season': args.season, 'trades': trades[:3000],
    }, separators=(',', ':')))

    # ── social graph (anonymized): experts as indices; edges = shared leagues ──
    edges: dict[tuple, dict] = {}
    for lg in league_experts.values():
        members = sorted(lg['experts'])
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                key = (members[i], members[j])
                e = edges.setdefault(key, {'a': members[i], 'b': members[j], 'dynasty': 0, 'redraft': 0, 'total': 0})
                e['total'] += 1
                e['dynasty' if lg['dynasty'] else 'redraft'] += 1
    nodes = []
    for idx in range(len(usernames)):
        mine_lgs = [lg for lg in league_experts.values() if idx in lg['experts']]
        nodes.append({'i': idx, 'leagues': len(mine_lgs),
                      'dynasty': sum(1 for lg in mine_lgs if lg['dynasty']),
                      'redraft': sum(1 for lg in mine_lgs if not lg['dynasty'])})
    (OUT_DIR / 'expert-graph.json').write_text(json.dumps({
        'generated': generated, 'season': args.season, 'expert_count': len(usernames),
        'nodes': nodes, 'edges': sorted(edges.values(), key=lambda e: -e['total']),
    }, separators=(',', ':')))

    # ── gitignored name map (index -> username). LOCAL ONLY: never committed or
    # deployed (see .gitignore; refresh-data.yml strips it before the build). ──
    (OUT_DIR / 'expert-names.json').write_text(json.dumps(
        {'names': {str(i): u for i, u in enumerate(usernames)}}, separators=(',', ':')))

    print(f"Wrote expert data: {len(players)} players, {len(adds)} adds, {len(trades)} trades, "
          f"{len(edges)} graph edges from {experts_with_data} experts ({roster_totals['all']} rosters).", file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
