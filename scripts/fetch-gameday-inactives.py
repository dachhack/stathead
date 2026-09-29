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

QB starter calls ride along. All week, every depth-chart QB (1-3) of a team
that has not kicked off yet is checked for a RotoWire start / not-start call
published since the team's last game ("Rush will start", "Keenum is in line
to start", "Wentz will serve as the backup"): `qbCalls`, one per QB, the
newest wins. Over weeks 1-3 of 2026 a team's newest start call named the QB
who threw the most passes in 12 team-weeks out of 12 (8 firm, 4 likely), and
"not starting" calls held 10 of 11 times; single calls were right 30 of 33
times, the three misses superseded by a later call the same week. The
consumer resolves them per team (MCP get_weekly_projections, "named
starter").

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


# QB start / not-start calls. The EARLIEST match in the headline wins: the
# blurb sits on the player's own page, so the first clause is about him
# ("Sanders will open the season as the backup after the team named Watson
# its starter" is Sanders not starting).
_OWN = r"(?:the |a |an )?(?:[\w.'’-]+ ){0,3}?"
QB_PATTERNS = [
    ('not', r"\bwon't start\b|\bwill not start\b|\bnot (?:be )?start(?:ing)?\b"
            rf"|\b(?:as|be|remain|to|return to) {_OWN}(?:top |primary |No\. 2 |new )?backup(?: quarterback| role| job|\b)"
            rf"|\bwon {_OWN}backup\b|\bhas been benched\b|\bwill be benched\b|\blost (?:his|the) starting (?:job|role)\b"),
    ('firm', r"\bwill start\b|\bstill will start\b|\bwill make (?:his|the|a) (?:first )?start\b|\bwill get the start\b"
             r"|\bwill have [\w.'’-]+ start\b"
             rf"|\bnamed {_OWN}(?:new )?start(?:ing quarterback|er)\b"
             rf"|\b(?:will (?:be|remain|step in as)|is|remains) {_OWN}(?:new )?starting quarterback\b"
             r"|\bwill return to the starting lineup\b|\bwill (?:be )?under center\b"),
    ('likely', r"\b(?:expected|likely|on track|set|poised|slated|(?<!next )in line) to (?:make the )?start\b"
               r"|\banticipates sticking with\b"),
]
QB_RX = [(k, re.compile(p, re.I)) for k, p in QB_PATTERNS]
QB_HEDGE = re.compile(r"\b(?:could|may|might|if|plans? for|hopes?|eventually)\b", re.I)


def qb_call(headline: str) -> str | None:
    """'firm' / 'likely' (he starts), 'not' (he does not), or None."""
    h = headline or ''
    best = None
    for k, rx in QB_RX:
        m = rx.search(h)
        if m and (best is None or m.start() < best[1]):
            best = (k, m.start())
    if not best or QB_HEDGE.search(h[:best[1]]):
        return None
    return best[0]


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


# ESPN's RotoWire timestamps read "Mon Sep 28 13:04:41 PDT 2026", not ISO.
TZ_OFFSET = {'PDT': -7, 'PST': -8, 'MDT': -6, 'MST': -7, 'CDT': -5, 'CST': -6,
             'EDT': -4, 'EST': -5, 'UTC': 0, 'GMT': 0}


def parse_ts(v) -> datetime | None:
    if not v:
        return None
    v = str(v).strip()
    try:
        return datetime.fromisoformat(v.replace('Z', '+00:00')).astimezone(timezone.utc)
    except ValueError:
        pass
    m = re.match(r'\w{3} (\w{3} \d{1,2} \d{2}:\d{2}:\d{2}) ([A-Z]{3}) (\d{4})$', v)
    if m and m.group(2) in TZ_OFFSET:
        t = datetime.strptime(f'{m.group(1)} {m.group(3)}', '%b %d %H:%M:%S %Y')
        return t.replace(tzinfo=timezone(timedelta(hours=TZ_OFFSET[m.group(2)]))).astimezone(timezone.utc)
    print(f'  unparsed timestamp: {v!r}', file=sys.stderr)
    return None


def main() -> None:
    data = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/data')
    now = parse_ts(os.environ['GAMEDAY_NOW']) if os.environ.get('GAMEDAY_NOW') else datetime.now(timezone.utc)
    weekly = load(data / f'weekly-projections-{SEASON}.json')
    week = weekly.get('currentWeek')
    schedule = load(data / f'schedule-{SEASON}.json')
    out_path = data / f'gameday-{SEASON}.json'

    prev, prev_qb = {}, {}
    if out_path.exists():
        try:
            doc = load(out_path)
            if doc.get('week') == week:
                prev = doc.get('calls', {})
                prev_qb = doc.get('qbCalls', {})
        except (OSError, ValueError):
            pass

    kick = {}
    for g in schedule['games']:
        if g['week'] == week and g.get('date'):
            t = parse_ts(g['date'])
            for team in (g['home'], g['away']):
                kick[team] = t
    teams = {t for t, k in kick.items() if k - timedelta(hours=LEAD_H) <= now <= k + AFTER_KICK}
    # Each team's last kickoff before this week: a QB call counts only if it
    # was published after it (this week's news, not last week's).
    last_kick = {}
    for g in schedule['games']:
        if g['week'] < week and g.get('date'):
            t = parse_ts(g['date'])
            for team in (g['home'], g['away']):
                last_kick[team] = max(last_kick.get(team, t), t)

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

    cache = {}

    def blurb(p):
        """(headline, published) of the player's current RotoWire blurb."""
        eid = espn.get((norm(p['name']), p['pos'], p['team'])) or espn.get((norm(p['name']), p['pos']))
        if not eid:
            print(f"  no ESPN id: {p['name']} ({p['team']} {p['pos']})", file=sys.stderr)
            return '', None
        if eid not in cache:
            cache[eid] = fetch_overview(eid)
            time.sleep(0.3)
        ro = (cache[eid] or {}).get('rotowire') or {}
        return ro.get('headline') or '', parse_ts(ro.get('published'))

    calls = dict(prev)
    n_new = 0
    for p in cands:
        headline, published = blurb(p)
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

    # QB starter calls: every team still to play this week, QBs 1-3 on the
    # depth chart plus any designated QB.
    qb_calls = dict(prev_qb)
    n_qb = 0
    # Midweek news moves by the hour: sweep every team on the first run of
    # the hour (the :07 slot), and teams in their pre-kickoff window every run.
    sweep_all = now.minute < 20 or bool(os.environ.get('GAMEDAY_QB_ALL'))
    for p in weekly['players']:
        k = kick.get(p.get('team'))
        if p.get('pos') != 'QB' or not k or now > k or not p.get('active', True):
            continue
        if not sweep_all and p['team'] not in teams:
            continue
        if (p.get('depth') or 9) > 3 and not designation(p):
            continue
        headline, published = blurb(p)
        lk = last_kick.get(p['team'])
        if not headline or not published or published > k or (lk and published <= lk):
            continue
        call = qb_call(headline)
        if not call:
            continue
        key = p.get('gsis') or f"{norm(p['name'])}|QB"
        old = qb_calls.get(key)
        if old and old.get('published', '') >= published.isoformat(timespec='minutes'):
            continue
        qb_calls[key] = {
            'name': p['name'], 'pos': 'QB', 'team': p['team'], 'gsis': p.get('gsis'),
            'depth': p.get('depth'), 'call': call, 'headline': headline[:200],
            'published': published.isoformat(timespec='minutes'),
        }
        n_qb += 1
        print(f"  QB {call:6} {p['name']} ({p['team']}, depth {p.get('depth')}): {headline[:90]}")

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
        'qbNote': ('QB starter calls from RotoWire, published since the team\'s last game: '
                   'firm ("will start", "named the starter"), likely ("expected / in line to '
                   'start"), not ("will serve as the backup", "won\'t start"); newest per QB. '
                   'Consumers resolve per team: the newest start call names the starter '
                   '(P start: firm 0.95, likely 0.85); a not call on the QB1 alone leaves '
                   'him 5%.'),
        'qbCalls': dict(sorted(qb_calls.items())),
    }
    tmp = out_path.with_suffix('.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    tmp.replace(out_path)
    print(f'Game-day calls: week {week}, {len(teams)} team(s) in window, {len(cands)} candidate(s), '
          f'{n_new} new, {len(calls)} total; QB calls {n_qb} new, {len(qb_calls)} total -> {out_path}')


if __name__ == '__main__':
    main()
