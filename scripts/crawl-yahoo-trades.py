#!/usr/bin/env python3
"""Yahoo trade-market crawler: trades, FAAB adds and league context from every
publicly viewable Yahoo NFL league the app can read.

The companion of scripts/crawl-sleeper-trades.ts. It writes shards in the same
row shapes, so scripts/build-sleeper-trade-db.py builds a database from them
too (docs/sleeper-trade-db.md, "Yahoo").

How it finds leagues: Yahoo league ids are integers within each season's game
(nfl 2026 = game 470), and about 15% of them are publicly viewable to an app
key alone (scripts/probe-yahoo-fantasy.py, Oct 2026). The crawl walks the ids
per season from a saved cursor, checking 25 at a time with the batch
/leagues;league_keys= call when Yahoo allows it, and follows each readable
league's `renew` link back through its earlier seasons.

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
        [--seasons 2026,2025,2024] [--hours 5] [--rpm 240] [--max-id 2500000]
"""
from __future__ import annotations

import gzip
import hashlib
import json
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
    """/league/{key};out=settings,standings,draftresults → parts."""
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
            'guids': [m.get('guid') for m in managers if m.get('guid')],
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
        return st
    return {'version': STATE_VERSION, 'saltCheck': check, 'cursor': {}, 'done': {}, 'history': [],
            'batchOk': None, 'totals': {'leagues': 0, 'trades': 0, 'waivers': 0, 'requests': 0, 'runs': 0, 'scanned': 0}}


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
    pause = 60.0 / float(opt.get('rpm', '240'))

    client = probe.Client('app', cid, csec)
    client.pause = pause

    state = load_state(d, salt)
    state['totals']['runs'] += 1
    run = time.strftime('%Y%m%dT%H%M%S', time.gmtime())
    out = Shards(d, run)
    ys = crosswalk()
    ysid = lambda yid: ys.get(str(yid), f'y:{yid}')
    seen_players: set[str] = set()
    stats = {'scanned': 0, 'readable': 0, 'leagues': 0, 'trades': 0, 'waivers': 0, 'parseMisses': 0,
             'types': {}, 'errors': {}}

    st, games = client.get(f'/games;game_codes=nfl;seasons={",".join(seasons)}')
    if st != 200:
        sys.exit(f'/games failed: {st} {games}')
    game_keys = {str(probe.first(g, 'season')): str(probe.first(g, 'game_key')) for g in probe.find(games, 'game')}
    season_of = {v: k for k, v in game_keys.items()}
    print(f'Yahoo trade crawl: games {game_keys}; state {state["totals"]}', flush=True)

    def crawl_league(lkey: str) -> None:
        if lkey in state['done']:
            return
        st, doc = client.get(f'/league/{lkey};out=settings,standings,draftresults')
        if st != 200:
            stats['errors'][f'league {st}'] = stats['errors'].get(f'league {st}', 0) + 1
            if stats['errors'][f'league {st}'] <= 3:
                print(f'  league → {st}: {str(doc)[:120]}', flush=True)
            return
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
        owners = {team_num(t['team_key']): (H(salt, 'yuser', t['guids'][0]) if t['guids'] else None) for t in lg['teams']}

        # Transactions: trades and adds (FAAB). Paged defensively.
        txs, start = [], 0
        while True:
            st, tdoc = client.get(f'/league/{lkey}/transactions;types=add,trade;start={start};count=25')
            if st != 200:
                stats['errors'][f'tx {st}'] = stats['errors'].get(f'tx {st}', 0) + 1
                if stats['errors'][f'tx {st}'] <= 3:
                    print(f'  transactions → {st}: {str(tdoc)[:120]}', flush=True)
                break
            try:
                page = parse_transactions(tdoc)
            except Exception as e:  # noqa: BLE001
                stats['parseMisses'] += 1
                print(f'  parse miss (transactions): {type(e).__name__}: {e}', flush=True)
                break
            new = [t for t in page if t['meta'].get('transaction_key') not in {x['meta'].get('transaction_key') for x in txs}]
            txs += new
            if len(page) < 25 or not new:
                break
            start += 25

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
        state['done'][lkey] = 1
        stats['leagues'] += 1
        stats['trades'] += ntr
        stats['types'][typ] = stats['types'].get(typ, 0) + 1
        # History: the league's earlier seasons, crawled before new ids.
        if prev_key and prev_key not in state['done'] and season_of.get(prev_key.split('.')[0]):
            state['history'].append(prev_key)

    def scan(gk: str, ids: list[int]) -> list[str]:
        """Readable league keys among ids, batched when Yahoo allows it."""
        keys = [f'{gk}.l.{i}' for i in ids]
        if state['batchOk'] is not False:
            st, doc = client.get(f'/leagues;league_keys={",".join(keys)}')
            if st == 200:
                state['batchOk'] = True
                return [str(k) for k in probe.find(doc, 'league_key')]
            if state['batchOk'] is None:
                state['batchOk'] = False
                print(f'  batch league lookup refused ({st}: {str(doc)[:80]}); scanning one at a time', flush=True)
        readable = []
        for k in keys:
            st, _ = client.get(f'/league/{k}/metadata')
            if st == 200:
                readable.append(k)
        return readable

    t0 = time.time()
    last = 0
    try:
        while time.time() < deadline:
            while state['history'] and time.time() < deadline:
                crawl_league(state['history'].pop())
            # Newest season first; each season walks its ids from the cursor.
            todo = [s for s in seasons if s in game_keys and state['cursor'].get(s, 1) <= max_id]
            if not todo:
                print('  every season scanned to --max-id', flush=True)
                break
            season = todo[0]
            gk = game_keys[season]
            start = state['cursor'].get(season, 1)
            ids = list(range(start, min(start + 25, max_id + 1)))
            readable = scan(gk, ids)
            state['cursor'][season] = ids[-1] + 1
            stats['scanned'] += len(ids)
            stats['readable'] += len(readable)
            for k in readable:
                if time.time() >= deadline:
                    break
                crawl_league(k)
            if stats['leagues'] - last >= 50:
                last = stats['leagues']
                mins = (time.time() - t0) / 60
                print(f'  {season} id {state["cursor"][season]:,} · scanned {stats["scanned"]:,} · readable {stats["readable"]:,} · '
                      f'leagues {stats["leagues"]:,} {stats["types"]} · trades {stats["trades"]:,} · FAAB adds {stats["waivers"]:,} · '
                      f'{client.requests / max(mins, 0.01):.0f} req/min', flush=True)
    finally:
        out.flush()
        for k in ('leagues', 'trades', 'waivers'):
            state['totals'][k] += stats[k]
        state['totals']['requests'] += client.requests
        state['totals']['scanned'] += stats['scanned']
        save_state(d, state)
        print(f'\nthis run: {json.dumps(stats)}\nrequests: {client.requests}\ncursor: {state["cursor"]}\n'
              f'all runs: {state["totals"]}', flush=True)


if __name__ == '__main__':
    main()
