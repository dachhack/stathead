#!/usr/bin/env python3
"""Game-day active / inactive calls for designated players, from RotoWire.

Teams post their inactive lists about 90 minutes before kickoff. Until then a
Questionable player is a coin flip we price at ×0.63; after it he is either
out (×0) or playing (×0.88, what a Questionable player who plays scores
against his own healthy baseline, 2016-2025). Neither the nflverse report nor
Sleeper carries the list: in week 3 of 2026 Sleeper never flipped a single
Questionable skill player to Out, and ESPN's game rosters only fill in after
the game. RotoWire does, on ESPN's athlete overview, within minutes: in week 3
"Bowers (knee) is active" at 19:00 UTC for a 20:25 kickoff, "Legette (knee) is
inactive" at 15:45 for 17:00. We had Bowers at 5.3 (he scored 27.6).

Each run looks only at teams kicking off in the next GAMEDAY_LEAD_H hours (or
kicked off in the last 30 minutes), and only at the players whose status is in
doubt: the current week's Questionable / Doubtful designations (official report
or Sleeper), plus every depth-chart QB of a team whose QB is designated, since
a backup QB's own call decides who starts. Calls are sticky for the week: the
blurb on ESPN is replaced by in-game notes once the game starts, so a call
seen before kickoff is kept, and a newer pre-kickoff call replaces an older.

Usage: python3 scripts/fetch-gameday-inactives.py [data_dir]   (default public/data)
       GAMEDAY_NOW=2026-09-27T16:00:00Z  pretend it is that time (testing)
Output: <data_dir>/gameday-<season>.json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SEASON = 2026
LEAD_H = float(os.environ.get('GAMEDAY_LEAD_H', '4'))
AFTER_KICK = timedelta(minutes=30)
# A blurb only counts as a game-day call if it was published this close to
# kickoff: a Wednesday "is expected to be active" is not the inactive list.
CALL_WINDOW = timedelta(hours=5)
POSITIONS = {'QB', 'RB', 'WR', 'TE', 'K'}
DOUBT = {'Questionable', 'Doubtful'}
URL = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/{}/overview?region=us&lang=en'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.espn.com/',
}

# "is inactive", "listed as inactive", "won't play", "has been ruled out".
INACTIVE_RE = re.compile(
    r"\b(?:is|are|was|listed as|been)\s+(?:listed\s+as\s+)?inactive\b"
    r"|\bwon't play\b|\bwill not play\b|\bruled out\b|\bwon't suit up\b|\bwill not suit up\b",
    re.I)
# "is active", "listed as active", "will play", "is available", "will suit up".
# (?<!in) keeps "inactive" out; "expected to be active" is a forecast, not the
# list, so the verb must be the call itself.
ACTIVE_RE = re.compile(
    r"\b(?:is|are|was|listed as)\s+(?:listed\s+as\s+)?(?<!in)active\b"
    r"|\bwill play\b|\bwill suit up\b|\bis available\b|\bhas been cleared to play\b",
    re.I)


def classify(headline: str) -> str | None:
    """'inactive' / 'active' / None for a RotoWire headline."""
    h = headline or ''
    if re.search(r'\b(?:rest|remainder) of\b', h, re.I):
        return None   # an in-game exit, not the inactive list
    if INACTIVE_RE.search(h):
        return 'inactive'
    if re.search(r'\bexpected to\b|\blikely to\b|\bshould\b|\bplans? to\b|\bhopes? to\b', h, re.I):
        return None
    if ACTIVE_RE.search(h):
        return 'active'
    return None


def norm(s: str) -> str:
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    s = re.sub(r"[.'’]", '', s)
    s = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def load(p: Path):
    with open(p) as f:
        return json.load(f)


def fetch_overview(espn_id: str):
    for attempt in range(2):
        try:
            req = urllib.request.Request(URL.format(espn_id), headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:  # one retry, then skip the player this run
            if attempt:
                print(f'  espn {espn_id}: {e}', file=sys.stderr)
            time.sleep(1)
    return None


def parse_ts(v) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace('Z', '+00:00')).astimezone(timezone.utc)
    except ValueError:
        return None


def main() -> None:
    data = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/data')
    now = parse_ts(os.environ['GAMEDAY_NOW']) if os.environ.get('GAMEDAY_NOW') else datetime.now(timezone.utc)
    weekly = load(data / f'weekly-projections-{SEASON}.json')
    week = weekly.get('currentWeek')
    schedule = load(data / f'schedule-{SEASON}.json')
    out_path = data / f'gameday-{SEASON}.json'

    prev = {}
    if out_path.exists():
        try:
            doc = load(out_path)
            if doc.get('week') == week:
                prev = doc.get('calls', {})
        except (OSError, ValueError):
            pass

    kick = {}
    for g in schedule['games']:
        if g['week'] == week and g.get('date'):
            t = parse_ts(g['date'])
            for team in (g['home'], g['away']):
                kick[team] = t
    teams = {t for t, k in kick.items() if k - timedelta(hours=LEAD_H) <= now <= k + AFTER_KICK}

    espn = {}
    for p in load(data / 'espn-nfl-ids.json')['players']:
        espn.setdefault((norm(p['name']), p['position'], p['team']), p['espn_id'])
        espn.setdefault((norm(p['name']), p['position']), p['espn_id'])

    def designation(p):
        inj = p.get('inj') or {}
        if inj.get('week') == week and inj.get('status') in DOUBT:
            return inj['status']
        slp = p.get('slp') or {}
        if slp.get('week') == week and slp.get('status') in DOUBT:
            return slp['status']
        return None

    rows = [p for p in weekly['players'] if p.get('team') in teams and p.get('pos') in POSITIONS
            and p.get('active', True)]
    cands = [p for p in rows if designation(p)]
    qb_teams = {p['team'] for p in cands if p['pos'] == 'QB'}
    cands += [p for p in rows if p['pos'] == 'QB' and p['team'] in qb_teams and not designation(p)
              and (p.get('depth') or 9) <= 3]

    calls = dict(prev)
    n_new = 0
    for p in cands:
        eid = espn.get((norm(p['name']), p['pos'], p['team'])) or espn.get((norm(p['name']), p['pos']))
        if not eid:
            print(f"  no ESPN id: {p['name']} ({p['team']} {p['pos']})", file=sys.stderr)
            continue
        ov = fetch_overview(eid)
        time.sleep(0.3)
        ro = (ov or {}).get('rotowire') or {}
        headline = ro.get('headline') or ''
        published = parse_ts(ro.get('published'))
        k = kick[p['team']]
        if not headline or not published or not (k - CALL_WINDOW <= published <= k):
            continue
        call = classify(headline)
        if not call:
            continue
        key = p.get('gsis') or f"{norm(p['name'])}|{p['pos']}"
        old = calls.get(key)
        if old and old.get('published', '') >= published.isoformat():
            continue
        calls[key] = {
            'name': p['name'], 'pos': p['pos'], 'team': p['team'], 'gsis': p.get('gsis'),
            'call': call, 'headline': headline[:200],
            'published': published.isoformat(timespec='minutes'),
            'kickoff': k.isoformat(timespec='minutes'),
        }
        n_new += 1
        print(f"  {call:8} {p['name']} ({p['team']} {p['pos']}, {designation(p) or 'QB depth'}): {headline[:90]}")

    doc = {
        'season': SEASON,
        'week': week,
        'fetchedAt': now.isoformat(timespec='seconds'),
        'note': ('Game-day active / inactive calls from RotoWire (ESPN athlete overview), '
                 'for players designated Questionable / Doubtful this week and the QBs of a '
                 'team whose QB is designated, published within 5 hours before kickoff. '
                 'Sticky for the week; reset when the week turns. Consumers: inactive -> 0; '
                 'active -> the measured if-played multiplier (Questionable Full 0.91 / '
                 'Limited 0.88 / DNP 0.77, else 0.88; Doubtful 0.58).'),
        'teamsInWindow': sorted(teams),
        'calls': dict(sorted(calls.items())),
    }
    tmp = out_path.with_suffix('.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    tmp.replace(out_path)
    print(f'Game-day calls: week {week}, {len(teams)} team(s) in window, {len(cands)} candidate(s), '
          f'{n_new} new, {len(calls)} total -> {out_path}')


if __name__ == '__main__':
    main()
