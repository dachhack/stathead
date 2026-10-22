#!/usr/bin/env python3
"""Yahoo trade-market crawler: trades, FAAB adds and league context from every
publicly viewable Yahoo NFL league the app can read.

The companion of scripts/crawl-sleeper-trades.ts. It writes shards in the same
row shapes, so scripts/build-sleeper-trade-db.py builds a database from them
too (docs/sleeper-trade-db.md, "Yahoo").

How it finds leagues: Yahoo league ids are integers within each season's game
(nfl 2026 = game 470), and about 15% of them are publicly viewable to an app
key alone (scripts/probe-yahoo-fantasy.py, Oct 2026). The crawl walks the ids
per season in a spread-out order from a saved cursor, checking 25 at a time with the batch
/leagues;league_keys= call when Yahoo allows it, and follows each readable
league's `renew` link back through its earlier seasons.

New trades: past seasons never change, so a league-season is crawled once.
This season's leagues are re-read for new trades (--refresh-current, or
=auto: only when the last refresh was 20+ hours ago, so the first run each
day does it). A re-read is 2 requests: standings (which carry the league's
status and current week, and the records) and transactions; the format and
type are cached in the state when the league is first crawled. Refresh rows
are marked `delta` and the builder keeps the earlier row's settings, scoring
and drafts. A current-season league crawled before the cache existed is read
once more in full to fill it.

League type: Yahoo has no dynasty switch. `type` is inferred and the evidence
kept (`typeEvidence`):
  dynasty  renewed from last season and the draft is short (<= 40% of roster
           spots per team), or keepers fill most of the roster
  keeper   some drafted players are keepers, or the league sets keepers
  redraft  otherwise
Raw settings are stored, so the rule can be refined at build time.

Per league-season: metadata, full settings (roster slots, stat modifiers, FAAB,
trade rules), final standings, draft results. Per trade: each side's players
(Yahoo ids, mapped to Sleeper ids through public/data/player-crosswalk.json),
picks (round, original owner) and the raw transaction. Per FAAB add: player
and bid (Yahoo shows winning bids only).

Privacy as for Sleeper: league keys, team keys and manager guids are salted
hashes (SLEEPER_CRAWL_SALT, shared so ids stay one namespace), no names are
stored, and the output stays out of git.

Usage:
  YAHOO_CLIENT_ID=... YAHOO_CLIENT_SECRET=... SLEEPER_CRAWL_SALT=... \\
    python3 scripts/crawl-yahoo-trades.py [--dir data-private/yahoo-trades]
        [--seasons 2026,2025,2024] [--hours 5] [--rpm 75] [--workers 2] [--max-id 2500000]
        [--refresh-current[=auto]]
"""
from __future__ import annotations

import gzip
import hashlib
import math
import threading
from concurrent.futures import ThreadPoolExecutor
import json
from collections import Counter
import os
import re
import sys
import time
from pathlib import Path


def _load_probe():
    # probe-yahoo-fantasy.py has dashes in its name; load it by path.
    import importlib.util
    spec = importlib.util.spec_from_file_location('probe_yahoo', Path(__file__).parent / 'probe-yahoo-fantasy.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


probe = _load_probe()

STATE_VERSION = 1


# ── Yahoo JSON helpers ──
#
# Yahoo nests a resource as a list whose items are dicts (or lists of dicts)
# holding its fields, and collections as {"0": {...}, "1": {...}, "count": n}.

def merged(node) -> dict:
    """Flatten Yahoo's list-of-fragments into one dict (first level only)."""
    out: dict = {}
    if isinstance(node, dict):
        return dict(node)
    if isinstance(node, list):
        for part in node:
            if isinstance(part, dict):
                out.update(part)
            elif isinstance(part, list):
                for p in part:
                    if isinstance(p, dict):
                        out.update(p)
    return out


def items(coll, key: str) -> list:
    """Members of a Yahoo collection {"0": {key: ...}, ..., "count": n}."""
    if isinstance(coll, list):
        return [x[key] for x in coll if isinstance(x, dict) and key in x]
    if not isinstance(coll, dict):
        return []
    out = []
    for k, v in coll.items():
        if k.isdigit() and isinstance(v, dict) and key in v:
            out.append(v[key])
    return out


def team_num(team_key: str | None) -> int | None:
    m = re.search(r'\.t\.(\d+)$', team_key or '')
    return int(m.group(1)) if m else None


def H(salt: str, kind: str, ident: str) -> str:
    return hashlib.sha256(f'{salt}:{kind}:{ident}'.encode()).hexdigest()[:16]


# ── parsing (pure; tested offline by scripts/test-yahoo-trade-crawler.py) ──

def parse_league(doc) -> dict:
    """/league/{key} plus its settings, standings and draftresults
    sub-resources, concatenated into one league list → parts."""
    league = doc['fantasy_content']['league']
    meta = merged(league[0] if isinstance(league, list) else league)
    rest = merged(league[1:]) if isinstance(league, list) else {}
    settings = merged(rest.get('settings', {}))
    standings = rest.get('standings')
    teams = []
    for t in items(merged(standings).get('teams', {}) if standings else {}, 'team'):
        tm = merged(t[0]) if isinstance(t, list) else merged(t)
        extra = merged(t[1:]) if isinstance(t, list) else {}
        ts = merged(extra.get('team_standings', {}))
        ot = merged(ts.get('outcome_totals', {}))
        managers = [merged(m.get('manager', m)) for m in (tm.get('managers') or []) if isinstance(m, dict)]
        teams.append({
            'team_key': tm.get('team_key'),
            # App-only access sees public leagues' managers as "--hidden--":
            # hashing that would make every manager one person.
            'guids': [m.get('guid') for m in managers if m.get('guid') and not str(m.get('guid')).startswith('--')],
            'rank': int(ts['rank']) if str(ts.get('rank', '')).isdigit() else None,
            'w': int(ot.get('wins') or 0), 'l': int(ot.get('losses') or 0), 't': int(ot.get('ties') or 0),
            'pf': float(ts.get('points_for') or 0), 'pa': float(ts.get('points_against') or 0),
            'faab': int(tm['faab_balance']) if str(tm.get('faab_balance', '')).lstrip('-').isdigit() else None,
            'moves': int(tm.get('number_of_moves') or 0), 'trades': int(tm.get('number_of_trades') or 0),
        })
    picks = []
    for d in items(merged(rest.get('draft_results', {})) if rest.get('draft_results') else {}, 'draft_result'):
        d = merged(d)
        picks.append({'pick': int(d.get('pick') or 0), 'round': int(d.get('round') or 0),
                      'team_key': d.get('team_key'), 'player_key': d.get('player_key'),
                      'cost': d.get('cost'), 'keeper': d.get('is_keeper')})
    return {'meta': meta, 'settings': settings, 'teams': teams, 'picks': picks}


def roster_slots(settings: dict) -> list[str]:
    out = []
    for rp in settings.get('roster_positions') or []:
        p = merged(rp.get('roster_position', rp)) if isinstance(rp, dict) else {}
        out += [p.get('position')] * int(p.get('count') or 0)
    return [x for x in out if x]


def stat_modifiers(settings: dict) -> dict[str, float]:
    mods = {}
    sm = merged(settings.get('stat_modifiers') or {})
    for s in sm.get('stats') or []:
        st = merged(s.get('stat', s)) if isinstance(s, dict) else {}
        if 'stat_id' in st:
            try:
                mods[str(st['stat_id'])] = float(st.get('value'))
            except (TypeError, ValueError):
                pass
    return mods


def infer_type(meta: dict, settings: dict, picks: list[dict], slots: list[str]) -> tuple[str, dict]:
    teams = int(meta.get('num_teams') or 0) or 1
    roster = len([s for s in slots if s not in ('IR', 'IR+', 'NA')]) or 1
    drafted = [p for p in picks if p.get('player_key')]
    keepers = [p for p in drafted if str(p.get('keeper')) in ('1', 'True', 'true')]
    rounds = max((p['round'] for p in drafted), default=0)
    renewed = bool(meta.get('renew'))
    ev = {'renewed': renewed, 'draftRounds': rounds, 'rosterSpots': roster,
          'keepers': len(keepers), 'keeperSetting': settings.get('max_keepers') or settings.get('uses_keeper')}
    short_draft = 0 < rounds <= 0.4 * roster
    if (renewed and short_draft) or (keepers and len(keepers) >= 0.6 * roster * teams):
        return 'dynasty', ev
    if keepers or str(ev['keeperSetting'] or '0') not in ('0', 'None', ''):
        return 'keeper', ev
    return 'redraft', ev


# Yahoo stat ids used in the format summary (NFL).
STAT_REC, STAT_PASS_TD = '11', '5'


def format_summary(meta: dict, settings: dict, slots: list[str], typ: str) -> dict:
    mods = stat_modifiers(settings)
    count = lambda p: slots.count(p)
    return {
        'type': typ,
        'teams': int(meta.get('num_teams') or 0),
        'qb': count('QB'),
        'superflex': count('Q/W/R/T'),
        'sf': count('Q/W/R/T') > 0 or count('QB') >= 2,
        'rb': count('RB'), 'wr': count('WR'), 'te': count('TE'),
        'flex': count('W/R/T') + count('W/R') + count('W/T'),
        'starters': len([s for s in slots if s not in ('BN', 'IR', 'IR+', 'NA')]),
        'bench': count('BN'), 'taxi': 0, 'ir': count('IR') + count('IR+'),
        'idp': any(s in slots for s in ('D', 'DL', 'LB', 'DB', 'DE', 'DT', 'CB', 'S')),
        'ppr': mods.get(STAT_REC, 0.0), 'tep': 0, 'passTd': mods.get(STAT_PASS_TD, 4.0), 'ppc': 0,
        'pprFirstDown': 0, 'bestBall': False,
        'faabBudget': 100 if str(settings.get('uses_faab')) in ('1', 'True', 'true') else 0,
        'tradeDeadline': settings.get('trade_end_date'),
        'playoffTeams': int(settings.get('num_playoff_teams') or 0),
        'playoffWeekStart': int(settings.get('playoff_start_week') or 0),
        'draftRounds': max(0, len(slots)),
        'pickTrading': str(settings.get('can_trade_draft_picks')) in ('1', 'True', 'true'),
        'scoringType': meta.get('scoring_type'),
        'draftType': settings.get('draft_type'),
        'leagueType': meta.get('league_type'),
    }


def parse_transactions(doc) -> list[dict]:
    """/league/{key}/transactions → [{meta, players: [{player_key, player_id,
    name, position, type, source_team_key, destination_team_key}], picks}]."""
    league = doc['fantasy_content']['league']
    rest = merged(league[1:]) if isinstance(league, list) else {}
    out = []
    for t in items(rest.get('transactions', {}), 'transaction'):
        meta = merged(t[0]) if isinstance(t, list) else merged(t)
        body = merged(t[1:]) if isinstance(t, list) else {}
        players = []
        for p in items(body.get('players', {}), 'player'):
            info = merged(p[0]) if isinstance(p, list) else {}
            td = merged((p[1] if isinstance(p, list) and len(p) > 1 else {}).get('transaction_data', {}))
            name = info.get('name')
            players.append({
                'player_key': info.get('player_key'), 'player_id': str(info.get('player_id') or ''),
                'name': merged(name).get('full') if name else None,
                'position': info.get('display_position'),
                'type': td.get('type'),
                'source_team_key': td.get('source_team_key'),
                'destination_team_key': td.get('destination_team_key'),
            })
        picks = []
        for pk in meta.get('picks') or body.get('picks') or []:
            pk = merged(pk.get('pick', pk)) if isinstance(pk, dict) else {}
            if pk:
                picks.append({'round': int(pk.get('round') or 0), 'source': pk.get('source_team_key'),
                              'dest': pk.get('destination_team_key'), 'orig': pk.get('original_team_key')})
        out.append({'meta': meta, 'players': players, 'picks': picks, 'raw': t})
    return out


def trade_sides(tx: dict, owner_of, ysid) -> list[dict]:
    """A Yahoo trade → Sleeper-shaped sides (rid = team number)."""
    rids = set()
    for p in tx['players']:
        for k in ('source_team_key', 'destination_team_key'):
            if team_num(p.get(k)) is not None:
                rids.add(team_num(p[k]))
    for pk in tx['picks']:
        for k in ('source', 'dest'):
            if team_num(pk.get(k)) is not None:
                rids.add(team_num(pk[k]))
    for k in ('trader_team_key', 'tradee_team_key'):
        if team_num(tx['meta'].get(k)) is not None:
            rids.add(team_num(tx['meta'][k]))
    empty = lambda: {'players': [], 'picks': [], 'faab': 0}
    sides = {r: {'rid': r, 'owner': owner_of(r), 'gets': empty(), 'gives': empty(), 'cut': [], 'added': []} for r in sorted(rids)}
    for p in tx['players']:
        pid = ysid(p['player_id'])
        src, dst = team_num(p.get('source_team_key')), team_num(p.get('destination_team_key'))
        if p.get('type') == 'trade' and src in sides and dst in sides:
            sides[dst]['gets']['players'].append(pid)
            sides[src]['gives']['players'].append(pid)
        elif p.get('type') == 'drop' and src in sides:
            sides[src]['cut'].append(pid)
        elif p.get('type') == 'add' and dst in sides:
            sides[dst]['added'].append(pid)
    for pk in tx['picks']:
        src, dst = team_num(pk['source']), team_num(pk['dest'])
        pick = {'season': 'next', 'round': pk['round'], 'orig': team_num(pk['orig'])}
        if src in sides and dst in sides:
            sides[dst]['gets']['picks'].append(pick)
            sides[src]['gives']['picks'].append(pick)
    for s in sides.values():
        for k in ('gets', 'gives'):
            s[k]['players'].sort()
        s['cut'].sort()
        s['added'].sort()
    return list(sides.values())


DROP_KEYS = re.compile(r'team_name|nickname|manager|guid|email|url|image|logo', re.I)
LEAGUE_KEY = re.compile(r'\b(\d+\.l\.\d+)')


def scrub(raw, salt: str):
    """A raw Yahoo transaction with no league key, team or manager names:
    league keys (inside team and transaction keys too) become salted hashes."""
    def walk(x):
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items() if not DROP_KEYS.search(k)}
        if isinstance(x, list):
            return [walk(v) for v in x]
        if isinstance(x, str):
            return LEAGUE_KEY.sub(lambda m: 'L' + H(salt, 'yleague', m.group(1)), x)
        return x
    return walk(raw)


# ── crawl ──

# Transaction collection forms, tried in order until one answers.
TX_VARIANTS = ['transactions', 'transactions;type=trade', 'transactions;types=trade,add']


def is_throttle(st: int, body) -> bool:
    """Worth retrying: 429 / 999 (throttled), 5xx, a network failure (0:
    timeout, reset), and Yahoo's 400 'temporary problem'. Only 429 / 999 slow
    the crawl down (Throttled.get)."""
    return st in (0, 429, 999) or st >= 500 or (st == 400 and 'temporary problem' in str(body))


MIN_RPM = 15   # the pace never drops below this, however often Yahoo throttles


class Throttled:
    """Wraps the probe client with adaptive pacing shared by every worker
    thread. Yahoo publishes no rate limit. Measured Oct 2026: 56 req/min ran
    clean for 30 minutes; 144 req/min drew 999s ('request denied') after
    about 10. So requests are spaced on one clock across threads. On a
    throttle, everyone waits (30 s doubling to 10 min) and the pace drops by
    a third, never below MIN_RPM. Every 50 clean requests it speeds up by 20%,
    never past --rpm. (Halving with 10% per 200 had sunk to 5 req/min, too
    slow to recover within a run.)"""

    def __init__(self, client, rpm: float, deadline: float, log=print):
        self.c, self.deadline, self.log = client, deadline, log
        self.floor = 60.0 / rpm
        self.pace = self.floor
        self.c.pause = 0.0
        self.c.retries = 1
        self.wait = 0.0
        self.clean = 0
        self.throttles = 0
        self._lock = threading.Lock()
        self._next = 0.0
        self._hold = 0.0

    def _slot(self) -> None:
        with self._lock:
            now = time.time()
            t = max(now, self._next, self._hold)
            self._next = t + self.pace
        if t > now:
            time.sleep(t - now)

    def get(self, path: str, temp_tries: int = 2):
        tries = 0
        while True:
            self._slot()
            st, body = self.c.get(path)
            if not is_throttle(st, body):
                with self._lock:
                    self.wait = 0.0
                    self.clean += 1
                    if self.clean % 50 == 0 and self.pace > self.floor:
                        self.pace = max(self.floor, self.pace / 1.2)
                return st, body
            tries += 1
            # Yahoo's 400 'temporary problem' is mostly an id with no league
            # (about 1 in 5 in older seasons), and a 500 can repeat for one
            # request forever (the combined ;out= league call did, Oct 2026):
            # quick retries, no slowdown, then give the error back.
            if st not in (429, 999):
                # The 400 is consistent for an id with no league: no retry.
                if tries >= temp_tries or st == 400:
                    return st, body
                time.sleep(2)
                continue
            with self._lock:
                self.throttles += 1
                self.clean = 0
                self.wait = min(600.0, self.wait * 2 or 30.0)
                self.pace = min(60.0 / MIN_RPM, self.pace * 1.5)
                self._hold = max(self._hold, time.time() + self.wait)
                n, w, rate = self.throttles, self.wait, 60 / self.pace
            if n <= 5 or n % 50 == 0:
                self.log(f'  throttled ({st}) x{n}: waiting {w:.0f}s, now {rate:.0f} req/min', flush=True)
            if time.time() + w >= self.deadline:
                return st, body

    @property
    def requests(self):
        return self.c.requests


class Unlocking:
    """Lets worker threads share the crawl's bookkeeping safely: a league is
    processed holding one lock, which is released only while a request is in
    flight. So the crawl logic runs one thread at a time and the waiting on
    Yahoo overlaps."""

    def __init__(self, inner, lock):
        self.inner, self.lock = inner, lock

    def get(self, path: str):
        self.lock.release()
        try:
            return self.inner.get(path)
        finally:
            self.lock.acquire()

    def __getattr__(self, name):
        return getattr(self.inner, name)


class Shards:
    def __init__(self, d: Path, run: str):
        (d / 'shards').mkdir(parents=True, exist_ok=True)
        self.paths = {k: d / 'shards' / f'yahoo-{run}-{k}.jsonl.gz' for k in ('leagues', 'trades', 'waivers', 'players')}
        self.buf = {k: [] for k in self.paths}

    def add(self, kind: str, row: dict) -> None:
        self.buf[kind].append(json.dumps(row, separators=(',', ':')) + '\n')
        if len(self.buf[kind]) >= 500:
            self.flush(kind)

    def flush(self, kind: str | None = None) -> None:
        for k in ([kind] if kind else list(self.buf)):
            if self.buf[k]:
                with open(self.paths[k], 'ab') as f:
                    f.write(gzip.compress(''.join(self.buf[k]).encode()))
                self.buf[k] = []


def load_state(d: Path, salt: str) -> dict:
    p = d / 'state.json.gz'
    check = H(salt, 'check', 'stathead')
    if p.exists():
        st = json.loads(gzip.decompress(p.read_bytes()))
        if st.get('saltCheck') != check:
            sys.exit('Salt differs from the one this state was built with; ids would stop joining.')
        if 'retry' not in st:
            # State from the first crawl, which recorded throttled leagues as
            # trade-free: fetch every league it finished again. The builder
            # keeps the newest copy of each league and each trade.
            st['retry'] = {k: 0 for k in st.get('done', {})}
            st['done'] = {}
        return st
    return {'version': STATE_VERSION, 'saltCheck': check, 'cursor': {}, 'done': {}, 'history': [],
            'batchOk': None, 'totals': {'leagues': 0, 'trades': 0, 'waivers': 0, 'requests': 0, 'runs': 0, 'scanned': 0}}


REFRESH_EVERY_S = 20 * 3600


def queue_refresh(st: dict, mode: str, now: float, current_game: str | None) -> int:
    """Queue this season's unfinished leagues for a re-read of new trades.
    mode 'auto' only refreshes 20+ hours after the last one. Leagues of the
    current game crawled before the format cache existed go back on the
    history queue for one full read (it fills the cache). Returns how many
    were queued."""
    if mode == 'auto' and now - st.get('lastRefreshAt', 0) < REFRESH_EVERY_S:
        return 0
    cur = st.setdefault('current', {})
    q = st.setdefault('refresh', [])
    queued = set(q)
    n = 0
    for lkey in cur:
        if lkey not in queued:
            q.append(lkey)
            n += 1
    if current_game:
        for lkey, v in list(st['done'].items()):
            if v == 1 and lkey.split('.')[0] == current_game and lkey not in cur:
                del st['done'][lkey]
                st['history'].append(lkey)
                n += 1
    st['lastRefreshAt'] = now
    return n


def save_state(d: Path, st: dict) -> None:
    tmp = d / 'state.json.gz.tmp'
    tmp.write_bytes(gzip.compress(json.dumps(st).encode()))
    tmp.replace(d / 'state.json.gz')


def crosswalk() -> dict[str, str]:
    p = Path('public/data/player-crosswalk.json')
    if not p.exists():
        return {}
    rows = json.loads(p.read_text()).get('players', [])
    return {str(r['yahoo_id']): str(r['sleeper_id']) for r in rows if r.get('yahoo_id') and r.get('sleeper_id')}


def main() -> None:
    opt = {a.split('=')[0].lstrip('-'): (a.split('=', 1)[1] if '=' in a else 'true') for a in sys.argv[1:]}
    cid, csec = os.environ.get('YAHOO_CLIENT_ID', ''), os.environ.get('YAHOO_CLIENT_SECRET', '')
    salt = os.environ.get('SLEEPER_CRAWL_SALT', '')
    if not (cid and csec and salt):
        sys.exit('Set YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET and SLEEPER_CRAWL_SALT.')
    d = Path(opt.get('dir', 'data-private/yahoo-trades'))
    d.mkdir(parents=True, exist_ok=True)
    seasons = opt.get('seasons', '2026,2025,2024,2023,2022').split(',')
    deadline = time.time() + float(opt.get('hours', '5')) * 3600
    max_id = int(opt.get('max-id', '2500000'))

    throttled = Throttled(probe.Client('app', cid, csec), float(opt.get('rpm', '75')), deadline)
    logic = threading.Lock()
    client = Unlocking(throttled, logic)
    workers = max(1, int(opt.get('workers', '2')))

    state = load_state(d, salt)
    state['totals']['runs'] += 1
    run = time.strftime('%Y%m%dT%H%M%S', time.gmtime())
    out = Shards(d, run)
    ys = crosswalk()
    ysid = lambda yid: ys.get(str(yid), f'y:{yid}')
    seen_players: set[str] = set()
    stats = {'scanned': 0, 'readable': 0, 'private': 0, 'gone': 0, 'leagues': 0, 'trades': 0, 'waivers': 0,
             'refreshed': 0, 'refreshTrades': 0, 'retryLater': 0, 'parseMisses': 0, 'types': {}, 'errors': {}}
    state.setdefault('retry', {})

    def later(lkey: str) -> None:
        """Throttled or failed midway: try the whole league again next time
        (nothing of it was written), up to three times."""
        n = state['retry'].get(lkey, 0) + 1
        if n <= 3:
            state['retry'][lkey] = n
        else:
            state['retry'].pop(lkey, None)
        stats['retryLater'] += 1

    st, games = throttled.get(f'/games;game_codes=nfl;seasons={",".join(seasons)}')
    if st != 200:
        sys.exit(f'/games failed: {st} {games}')
    game_keys = {str(probe.first(g, 'season')): str(probe.first(g, 'game_key')) for g in probe.find(games, 'game')}
    season_of = {v: k for k, v in game_keys.items()}
    print(f'Yahoo trade crawl: games {game_keys}; state {state["totals"]}', flush=True)
    mode = opt.get('refresh-current')
    if mode in ('true', 'auto'):
        newest = max((s for s in game_keys), key=int, default=None)
        n = queue_refresh(state, mode, time.time(), game_keys.get(newest) if newest else None)
        print(f'  refresh: queued {n} current-season leagues' if n else '  refresh: last one under 20 hours ago', flush=True)

    inflight: set[str] = set()

    def run_league(lkey: str) -> bool:
        """Worker entry: crawl one league holding the logic lock (released
        during requests). False when the deadline stopped it before starting."""
        with logic:
            if time.time() >= deadline:
                return False
            if lkey in inflight:
                return True
            inflight.add(lkey)
            try:
                crawl_league(lkey)
            finally:
                inflight.discard(lkey)
            return True

    def run_all(keys: list[str]) -> int:
        """Crawl leagues on the worker pool; how many were started."""
        return sum(pool.map(run_league, keys))

    def fetch_transactions(lkey: str, refresh: bool = False):
        """Every transaction of a league, or None (handled: retried later,
        skipped for good, or for a refresh, left for the next one).
        The filtered, paged form 500'd on Yahoo (Oct 2026), so try the plain
        collection first, then filtered forms, and keep using whichever
        answers. Never record a league without its transactions: it would
        read as a league that made no trades."""
        txs = None
        codes = []
        order = sorted(TX_VARIANTS, key=lambda v: v != state.get('txVariant'))
        for variant in order:
            st, tdoc = client.get(f'/league/{lkey}/{variant}')
            codes.append(st)
            if st != 200:
                stats['errors'][f'tx {st} {variant}'] = stats['errors'].get(f'tx {st} {variant}', 0) + 1
                if stats['errors'][f'tx {st} {variant}'] <= 2:
                    print(f'  {variant} → {st}: {str(tdoc)[:120]}', flush=True)
                continue
            try:
                txs = parse_transactions(tdoc)
            except Exception as e:  # noqa: BLE001
                stats['parseMisses'] += 1
                print(f'  parse miss ({variant}): {type(e).__name__}: {e}', flush=True)
                return None
            if state.get('txVariant') != variant:
                state['txVariant'] = variant
                print(f'  transactions: using /{variant}', flush=True)
            break
        if txs is None:
            if refresh:
                return None
            if any(c in (0, 429, 999) for c in codes):
                later(lkey)
            else:
                # Every form 500s for a few leagues (the lowest ids of a
                # season, Oct 2026) while random public leagues answer: skip
                # the league for good rather than retry or record it.
                stats['txBroken'] = stats.get('txBroken', 0) + 1
                state['done'][lkey] = -1
            return None
        # A round count suggests Yahoo capped the list (two leagues of 115
        # came back with exactly 25 or 50, Oct 2026): page on with ;start=
        # while pages bring new transactions. Counted either way.
        if len(txs) in (25, 50, 100):
            stats['txMaybeCapped'] = stats.get('txMaybeCapped', 0) + 1
            seen_tx = {t['meta'].get('transaction_key') for t in txs}
            for _ in range(40):
                st, pdoc = client.get(f'/league/{lkey}/{state["txVariant"]};start={len(txs)}')
                if st != 200:
                    stats['errors'][f'tx page {st}'] = stats['errors'].get(f'tx page {st}', 0) + 1
                    break
                try:
                    page = [t for t in parse_transactions(pdoc) if t['meta'].get('transaction_key') not in seen_tx]
                except Exception:  # noqa: BLE001
                    break
                if not page:
                    break
                stats['txPaged'] = stats.get('txPaged', 0) + len(page)
                seen_tx |= {t['meta'].get('transaction_key') for t in page}
                txs += page
        return txs

    def emit(txs, lg_hash: str, season: str, fmt: dict, typ: str, owners: dict) -> int:
        """Write a league's trades and FAAB adds; the number of trades."""
        ntr = 0
        for tx in txs:
            m = tx['meta']
            for p in tx['players']:
                pid = ysid(p['player_id'])
                if p['player_id'] and pid.startswith('y:') and pid not in seen_players:
                    seen_players.add(pid)
                    out.add('players', {'player_id': pid, 'name': p.get('name'), 'position': p.get('position')})
            if m.get('type') == 'trade' and m.get('status') == 'successful':
                sides = trade_sides(tx, lambda r: owners.get(r), ysid)
                out.add('trades', {
                    'id': H(salt, 'ytxn', str(m.get('transaction_key'))), 'lg': lg_hash, 'season': season,
                    'leg': None, 'created': int(m.get('timestamp') or 0) * 1000 or None, 'completed': None,
                    'creatorRid': team_num(m.get('trader_team_key')), 'nSides': len(sides), 'sides': sides,
                    'format': fmt, 'platform': 'yahoo', 'raw': {'yahoo': scrub(tx['raw'], salt)},
                })
                ntr += 1
            elif m.get('type') in ('add', 'add/drop') and m.get('faab_bid') is not None:
                adds = [ysid(p['player_id']) for p in tx['players'] if p.get('type') == 'add']
                drops = [ysid(p['player_id']) for p in tx['players'] if p.get('type') == 'drop']
                rid = next((team_num(p.get('destination_team_key')) for p in tx['players'] if p.get('type') == 'add'), None)
                out.add('waivers', {
                    'id': H(salt, 'ytxn', str(m.get('transaction_key'))), 'lg': lg_hash, 'season': season,
                    'leg': None, 'type': 'waiver', 'status': 'complete',
                    'created': int(m.get('timestamp') or 0) * 1000 or None, 'rid': rid, 'owner': owners.get(rid),
                    'adds': adds, 'drops': drops, 'bid': int(m['faab_bid']), 'faabBudget': fmt['faabBudget'],
                    'teams': fmt['teams'], 'leagueType': typ, 'sf': fmt['sf'],
                })
                stats['waivers'] += 1

        return ntr

    def crawl_league(lkey: str) -> None:
        """Fetch one league-season. The league request doubles as the
        readability check, so a private id costs one request."""
        if lkey in state['done']:
            return
        st, doc = client.get(f'/league/{lkey}')
        if st == 401:
            stats['private'] += 1
            return
        if st == 400 and 'temporary problem' in str(doc):
            stats['gone'] += 1
            return
        if st != 200:
            stats['errors'][f'league {st}'] = stats['errors'].get(f'league {st}', 0) + 1
            if stats['errors'][f'league {st}'] <= 3:
                print(f'  league → {st}: {str(doc)[:120]}', flush=True)
            if st in (0, 429, 999):
                later(lkey)
            return
        stats['readable'] += 1
        # Settings, standings and draft results one by one (the combined
        # ;out= call 500s). Settings are required; the others are not.
        league = list(doc['fantasy_content']['league'])
        league = league if isinstance(league, list) else [league]
        for part, required in (('settings', True), ('standings', False), ('draftresults', False)):
            st, sub = client.get(f'/league/{lkey}/{part}')
            if st == 200:
                sl = sub['fantasy_content']['league']
                league += sl[1:] if isinstance(sl, list) else []
                continue
            if part == 'standings' and st == 400 and 'No team IDs' in str(sub):
                # A league nobody joined: no teams, so no transactions either
                # (they 500). Skip it before spending more requests.
                stats['empty'] = stats.get('empty', 0) + 1
                state['done'][lkey] = -1
                return
            stats['errors'][f'{part} {st}'] = stats['errors'].get(f'{part} {st}', 0) + 1
            if stats['errors'][f'{part} {st}'] <= 3:
                print(f'  {part} → {st}: {str(sub)[:120]}', flush=True)
            if required:
                later(lkey)
                return
        doc = {'fantasy_content': {'league': league}}
        try:
            lg = parse_league(doc)
        except Exception as e:  # noqa: BLE001
            stats['parseMisses'] += 1
            print(f'  parse miss (league): {type(e).__name__}: {e}', flush=True)
            return
        meta, settings = lg['meta'], lg['settings']
        slots = roster_slots(settings)
        typ, evidence = infer_type(meta, settings, lg['picks'], slots)
        fmt = format_summary(meta, settings, slots, typ)
        season = str(meta.get('season') or season_of.get(lkey.split('.')[0], ''))
        lg_hash = H(salt, 'yleague', lkey)
        # A guid shared by two teams is a placeholder, not a manager.
        guid_n = Counter(t['guids'][0] for t in lg['teams'] if t['guids'])
        owners = {team_num(t['team_key']): (H(salt, 'yuser', t['guids'][0]) if t['guids'] and guid_n[t['guids'][0]] == 1 else None)
                  for t in lg['teams']}

        txs = fetch_transactions(lkey)
        if txs is None:
            return
        ntr = emit(txs, lg_hash, season, fmt, typ, owners)

        prev = meta.get('renew')   # "449_12345" → previous season's league
        prev_key = f'{prev.split("_")[0]}.l.{prev.split("_")[1]}' if prev and '_' in str(prev) else None
        out.add('leagues', {
            'lg': lg_hash, 'prev': H(salt, 'yleague', prev_key) if prev_key else None, 'season': season,
            'seasonType': 'regular', 'status': 'complete' if str(meta.get('is_finished')) == '1' else 'in_season',
            'throughLeg': 99 if str(meta.get('is_finished')) == '1' else int(meta.get('current_week') or 0),
            'crawledAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'platform': 'yahoo',
            'format': fmt, 'typeEvidence': evidence, 'totalRosters': fmt['teams'], 'rosterPositions': slots,
            'settings': {k: v for k, v in settings.items() if k not in ('stat_modifiers', 'stat_categories', 'roster_positions')},
            'scoring': stat_modifiers(settings), 'txnCounts': {'trade': ntr},
            'champion': next((team_num(t['team_key']) for t in lg['teams'] if t['rank'] == 1 and str(meta.get('is_finished')) == '1'), None),
            'runnerUp': None,
            'rosters': [{'rid': team_num(t['team_key']), 'owner': owners.get(team_num(t['team_key'])), 'coOwners': [],
                         'w': t['w'], 'l': t['l'], 't': t['t'], 'pf': t['pf'], 'pa': t['pa'], 'maxPf': None,
                         'rank': t['rank'], 'faabUsed': (100 - t['faab']) if t['faab'] is not None and fmt['faabBudget'] else None,
                         'moves': t['moves'], 'players': [], 'starters': [], 'taxi': [], 'reserve': [], 'keepers': []}
                        for t in lg['teams']],
            'matchups': {},
            'drafts': [{'draft': H(salt, 'ydraft', lkey), 'type': fmt['draftType'], 'status': 'complete' if lg['picks'] else None,
                        'season': season, 'seasonType': 'regular', 'startTime': None, 'scoringType': None,
                        'settings': {'rounds': evidence['draftRounds'], 'teams': fmt['teams']}, 'slotToRoster': None,
                        'picks': [[p['pick'], p['round'], None, team_num(p['team_key']),
                                   ysid((p['player_key'] or '').split('.p.')[-1]) if p['player_key'] else None,
                                   1 if str(p.get('keeper')) in ('1', 'True', 'true') else 0,
                                   float(p['cost']) if p.get('cost') not in (None, '') else None]
                                  for p in lg['picks'] if p.get('player_key')]}],
        })
        # This season's unfinished leagues are re-read for new trades: cache
        # what a 2-request refresh cannot read again.
        if str(meta.get('is_finished')) != '1':
            state.setdefault('current', {})[lkey] = {'fmt': fmt, 'typ': typ, 'season': season, 'prev': prev_key}
        else:
            state.setdefault('current', {}).pop(lkey, None)
        state['done'][lkey] = 1
        state['retry'].pop(lkey, None)
        stats['leagues'] += 1
        stats['trades'] += ntr
        stats['types'][typ] = stats['types'].get(typ, 0) + 1
        # History: the league's earlier seasons, crawled before new ids.
        if prev_key and prev_key not in state['done'] and season_of.get(prev_key.split('.')[0]):
            state['history'].append(prev_key)

    def refresh_league(lkey: str) -> None:
        """Re-read a current-season league for new trades: standings (status,
        current week, records) and transactions. The builder dedupes trades
        and waivers by id and keeps this row's settings-free fields."""
        info = state.get('current', {}).get(lkey)
        if not info:
            return
        st, doc = client.get(f'/league/{lkey}/standings')
        if st in (401, 404) or (st == 400 and 'temporary problem' in str(doc)):
            state['current'].pop(lkey, None)   # gone private or deleted
            return
        if st != 200:
            stats['errors'][f'refresh {st}'] = stats['errors'].get(f'refresh {st}', 0) + 1
            return                             # tried again at the next refresh
        try:
            lg = parse_league(doc)
        except Exception as e:  # noqa: BLE001
            stats['parseMisses'] += 1
            print(f'  parse miss (refresh): {type(e).__name__}: {e}', flush=True)
            return
        txs = fetch_transactions(lkey, refresh=True)
        if txs is None:
            return
        meta, fmt, typ, season = lg['meta'], info['fmt'], info['typ'], info['season']
        finished = str(meta.get('is_finished')) == '1'
        lg_hash = H(salt, 'yleague', lkey)
        guid_n = Counter(t['guids'][0] for t in lg['teams'] if t['guids'])
        owners = {team_num(t['team_key']): (H(salt, 'yuser', t['guids'][0]) if t['guids'] and guid_n[t['guids'][0]] == 1 else None)
                  for t in lg['teams']}
        ntr = emit(txs, lg_hash, season, fmt, typ, owners)
        out.add('leagues', {
            'lg': lg_hash, 'prev': H(salt, 'yleague', info['prev']) if info.get('prev') else None, 'season': season,
            'seasonType': 'regular', 'status': 'complete' if finished else 'in_season',
            'throughLeg': 99 if finished else int(meta.get('current_week') or 0),
            'crawledAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'platform': 'yahoo', 'delta': True,
            'format': fmt, 'totalRosters': fmt['teams'], 'txnCounts': {'trade': ntr},
            'champion': next((team_num(t['team_key']) for t in lg['teams'] if t['rank'] == 1 and finished), None),
            'runnerUp': None,
            'rosters': [{'rid': team_num(t['team_key']), 'owner': owners.get(team_num(t['team_key'])), 'coOwners': [],
                         'w': t['w'], 'l': t['l'], 't': t['t'], 'pf': t['pf'], 'pa': t['pa'], 'maxPf': None,
                         'rank': t['rank'], 'faabUsed': (100 - t['faab']) if t['faab'] is not None and fmt['faabBudget'] else None,
                         'moves': t['moves'], 'players': [], 'starters': [], 'taxi': [], 'reserve': [], 'keepers': []}
                        for t in lg['teams']],
            'matchups': {},
        })
        if finished:
            state['current'].pop(lkey, None)
        stats['refreshed'] += 1
        stats['refreshTrades'] += ntr

    def run_refresh(lkey: str) -> bool:
        with logic:
            if time.time() >= deadline:
                return False
            if lkey in inflight:
                return True
            inflight.add(lkey)
            try:
                refresh_league(lkey)
            finally:
                inflight.discard(lkey)
            return True

    def scan(gk: str, ids: list[int]) -> list[str]:
        """League keys worth fetching among ids. A batch lookup narrows them
        to the readable ones when Yahoo allows it; Yahoo refuses a batch that
        holds any private league (Oct 2026), so usually every id is a
        candidate and crawl_league's own request sorts them."""
        keys = [f'{gk}.l.{i}' for i in ids]
        if state['batchOk'] is not False:
            st, doc = throttled.get(f'/leagues;league_keys={",".join(keys)}')
            if st == 200:
                state['batchOk'] = True
                return [str(k) for k in probe.find(doc, 'league_key')]
            if state['batchOk'] is None and not is_throttle(st, doc):
                state['batchOk'] = False
                print(f'  batch league lookup refused ({st}: {str(doc)[:80]}); fetching each id directly', flush=True)
        return keys

    pool = ThreadPoolExecutor(max_workers=workers)
    t0 = time.time()
    last = 0
    last_save = time.time()
    # A step coprime with max_id visits every id exactly once.
    stride = 1_000_003
    while math.gcd(stride, max_id) != 1:
        stride += 2
    try:
        while time.time() < deadline:
            # New trades in this season's leagues before anything else.
            while state.get('refresh') and time.time() < deadline:
                batch, state['refresh'] = state['refresh'][:25], state['refresh'][25:]
                ok = list(pool.map(run_refresh, batch))
                # Any the deadline stopped before starting stay queued.
                state['refresh'] = [k for k, o in zip(batch, ok) if not o] + state['refresh']
            while state['history'] and time.time() < deadline:
                batch, state['history'] = state['history'][-25:], state['history'][:-25]
                run_all(batch)
            run_all(list(state['retry'])[:25])
            # Newest season first. Each season walks every id in 1..max_id in a
            # spread-out order (step `stride` mod max_id), so a run of broken
            # or empty ids cannot stall it; the cursor counts steps taken.
            todo = [s for s in seasons if s in game_keys and state['cursor'].get(s, 0) < max_id]
            if not todo:
                print('  every season scanned to --max-id', flush=True)
                break
            season = todo[0]
            gk = game_keys[season]
            start = state['cursor'].get(season, 0)
            steps = list(range(start, min(start + 25, max_id)))
            ids = [1 + (k * stride) % max_id for k in steps]
            cands = scan(gk, ids)
            done_ids = run_all(cands)
            # Advance only past ids actually tried, so a deadline mid-batch
            # loses nothing.
            if done_ids == len(cands):
                state['cursor'][season] = steps[-1] + 1
                stats['scanned'] += len(ids)
            # Save as we go: a cancelled run keeps everything up to here.
            if time.time() - last_save >= 300:
                out.flush()
                save_state(d, state)
                last_save = time.time()
            if stats['scanned'] - last >= 200:
                last = stats['scanned']
                mins = (time.time() - t0) / 60
                print(f'  {season} step {state["cursor"][season]:,} · scanned {stats["scanned"]:,} · readable {stats["readable"]:,} '
                      f'(private {stats["private"]:,}, gone {stats["gone"]:,}, empty {stats.get("empty", 0)}, tx-broken {stats.get("txBroken", 0)}, retry {len(state["retry"])}) · '
                      f'leagues {stats["leagues"]:,} {stats["types"]} · trades {stats["trades"]:,} · FAAB adds {stats["waivers"]:,} · '
                      f'{client.requests / max(mins, 0.01):.0f} req/min', flush=True)
    finally:
        out.flush()
        for k in ('leagues', 'trades', 'waivers'):
            state['totals'][k] += stats[k]
        state['totals']['requests'] += client.requests
        state['totals']['scanned'] += stats['scanned']
        save_state(d, state)
        stats['throttles'] = client.throttles
        mins = (time.time() - t0) / 60
        # Aggregate counts only (no ids): published unencrypted for the daily
        # report by scripts/publish-crawl-metrics.py.
        (d / 'run-metrics.json').write_text(json.dumps({
            'platform': 'yahoo',
            'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t0)),
            'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'minutes': round(mins, 2),
            'run': {'leagueSeasons': stats['leagues'], 'trades': stats['trades'], 'waivers': stats['waivers'],
                    'requests': client.requests, 'reqPerMin': round(client.requests / max(mins, 0.01)),
                    'scanned': stats['scanned'], 'readable': stats['readable'], 'private': stats['private'],
                    'gone': stats['gone'], 'empty': stats.get('empty', 0), 'txBroken': stats.get('txBroken', 0),
                    'throttles': client.throttles, 'parseMisses': stats['parseMisses'], 'types': stats['types'],
                    'refreshed': stats['refreshed'], 'refreshTrades': stats['refreshTrades'],
                    'refreshPending': len(state.get('refresh', [])), 'currentLeagues': len(state.get('current', {}))},
            'totals': state['totals'],
            'cursor': state['cursor'],
        }, indent=2) + '\n')
        print(f'\nthis run: {json.dumps(stats)}\nrequests: {client.requests}\ncursor: {state["cursor"]}\n'
              f'all runs: {state["totals"]}', flush=True)


if __name__ == '__main__':
    main()
