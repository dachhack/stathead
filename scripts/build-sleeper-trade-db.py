#!/usr/bin/env python3
"""Merge the Sleeper trade-crawl shards into one SQLite database.

Input:  <dir>/shards/*-{leagues,trades,waivers}.jsonl.gz
        (scripts/crawl-sleeper-trades.ts; docs/sleeper-trade-db.md)
        (Yahoo shards from scripts/crawl-yahoo-trades.py build the same way)
Output: <dir>/sleeper-trades.sqlite  (rebuilt from scratch each time)

Shards from every run are merged. A league-season crawled twice (the current
season is re-crawled as it goes on) keeps its latest, furthest-along row; a
trade or waiver claim seen twice is kept once.

Tables
  leagues       one row per league-season: format summary columns, the full
                settings / scoring / roster slots as JSON, lineage root
  rosters       one row per team per league-season: record, points, final rank,
                champion, players / taxi / IR / starters as JSON
  trades        one row per trade, with the league format repeated
  trade_sides   one row per team per trade: record and rank at the time of the
                trade, last season's finish in the same league, what moved
  trade_assets  one row per asset moved (player, pick or FAAB), from → to;
                picks resolved through the league's lineage to the draft they
                were used in: overall pick number, slot and the player taken
  drafts, draft_picks   every draft (startup, rookie, redraft) and its picks
  waivers       FAAB / waiver claims, won and lost, with the bid
  players       Sleeper id → name / position (public/data/sleeper-players.json)
  managers      for managers the crawl looked up: their whole league list per
                season (count by format), joinable to rosters.owner

Usage: python3 scripts/build-sleeper-trade-db.py [dir] [--lite]
       (default data-private/sleeper-trades)

--lite builds what the analysis jobs need from every run at once
(scripts/audit-trade-db.py, scripts/fit-pick-values.py) on a CI runner: no
waivers table (the audit streams the waiver shards itself), no raw / settings
/ scoring JSON and no roster player lists. The full build of all runs would
not fit in a runner's memory.
"""
from __future__ import annotations

import glob
import gzip
import json
import os
import sqlite3
import sys
from pathlib import Path

SCHEMA = """
CREATE TABLE leagues (
  lg TEXT PRIMARY KEY, prev TEXT, lineage TEXT, season INTEGER, season_type TEXT,
  status TEXT, through_leg INTEGER, type TEXT, teams INTEGER, sf INTEGER, qb INTEGER,
  superflex INTEGER, rb INTEGER, wr INTEGER, te INTEGER, flex INTEGER, starters INTEGER,
  bench INTEGER, taxi INTEGER, ir INTEGER, idp INTEGER, ppr REAL, tep REAL, pass_td REAL,
  ppc REAL, best_ball INTEGER, faab_budget INTEGER, trade_deadline INTEGER,
  playoff_teams INTEGER, playoff_week_start INTEGER, draft_rounds INTEGER,
  pick_trading INTEGER, champion INTEGER, runner_up INTEGER, n_trades INTEGER,
  crawled_at TEXT, settings TEXT, scoring TEXT, roster_positions TEXT, txn_counts TEXT
);
CREATE TABLE rosters (
  lg TEXT, rid INTEGER, owner TEXT, co_owners TEXT, w INTEGER, l INTEGER, t INTEGER,
  pf REAL, pa REAL, max_pf REAL, rank INTEGER, champion INTEGER, runner_up INTEGER,
  faab_used INTEGER, moves INTEGER, players TEXT, starters TEXT, taxi TEXT, reserve TEXT,
  keepers TEXT, PRIMARY KEY (lg, rid)
);
CREATE TABLE trades (
  id TEXT PRIMARY KEY, lg TEXT, lineage TEXT, season INTEGER, leg INTEGER, created INTEGER,
  completed INTEGER, creator_rid INTEGER, n_sides INTEGER, type TEXT, teams INTEGER,
  sf INTEGER, tep REAL, ppr REAL, faab_budget INTEGER, best_ball INTEGER,
  n_players INTEGER, n_picks INTEGER, faab_total INTEGER, raw TEXT
);
CREATE TABLE trade_sides (
  trade_id TEXT, rid INTEGER, owner TEXT,
  w INTEGER, l INTEGER, t INTEGER, pf REAL, pa REAL, rank_at_trade INTEGER,
  final_rank INTEGER, final_w INTEGER, final_l INTEGER,
  prev_rank INTEGER, prev_champion INTEGER,
  players_in INTEGER, picks_in INTEGER, faab_in INTEGER,
  players_out INTEGER, picks_out INTEGER, faab_out INTEGER,
  cut TEXT, added TEXT, PRIMARY KEY (trade_id, rid)
);
CREATE TABLE trade_assets (
  trade_id TEXT, from_rid INTEGER, to_rid INTEGER, kind TEXT,
  player_id TEXT, pick_season INTEGER, pick_round INTEGER, pick_orig_rid INTEGER,
  faab INTEGER, pick_status TEXT, pick_draft TEXT, pick_no INTEGER, pick_slot INTEGER,
  pick_player_id TEXT
);
CREATE TABLE drafts (
  draft TEXT PRIMARY KEY, lg TEXT, season INTEGER, type TEXT, status TEXT,
  start_time INTEGER, scoring_type TEXT, rounds INTEGER, teams INTEGER,
  player_type INTEGER, reversal_round INTEGER, settings TEXT, slot_to_roster TEXT
);
CREATE TABLE draft_picks (
  draft TEXT, pick_no INTEGER, round INTEGER, slot INTEGER, rid INTEGER,
  player_id TEXT, keeper INTEGER, amount REAL, PRIMARY KEY (draft, pick_no)
);
CREATE TABLE waivers (
  id TEXT PRIMARY KEY, lg TEXT, season INTEGER, leg INTEGER, type TEXT, status TEXT,
  created INTEGER, rid INTEGER, owner TEXT, player_id TEXT, adds TEXT, drops TEXT,
  bid INTEGER, faab_budget INTEGER, teams INTEGER, league_type TEXT, sf INTEGER
);
CREATE TABLE players (player_id TEXT PRIMARY KEY, name TEXT, position TEXT);
CREATE TABLE managers (
  owner TEXT, season INTEGER, leagues INTEGER, dynasty INTEGER, keeper INTEGER, redraft INTEGER,
  best_ball INTEGER, sf INTEGER, trades_off INTEGER, teams_avg REAL, PRIMARY KEY (owner, season)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""

INDEXES = """
CREATE INDEX trades_season ON trades(season, type, sf);
CREATE INDEX trades_lg ON trades(lg);
CREATE INDEX assets_player ON trade_assets(player_id);
CREATE INDEX assets_pick ON trade_assets(pick_season, pick_round);
CREATE INDEX assets_trade ON trade_assets(trade_id);
CREATE INDEX waivers_player ON waivers(player_id, season);
CREATE INDEX leagues_lineage ON leagues(lineage, season);
CREATE INDEX drafts_lg ON drafts(lg, season);
"""


def read_shards(d: Path, kind: str, newest_first: bool = False):
    # Shard names start with the run's timestamp, so name order is run order.
    for f in sorted(glob.glob(str(d / 'shards' / f'*-{kind}.jsonl.gz')), reverse=newest_first):
        try:
            with gzip.open(f, 'rt') as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        yield json.loads(line)
        except (EOFError, OSError) as e:  # a run killed mid-block: keep what decoded
            print(f'  warning: {f}: {e}', file=sys.stderr)


def j(x):
    return json.dumps(x, separators=(',', ':')) if x is not None else None


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    lite = '--lite' in sys.argv[1:]
    d = Path(args[0] if args else 'data-private/sleeper-trades')
    out = d / 'sleeper-trades.sqlite'
    tmp = d / 'sleeper-trades.sqlite.tmp'
    if tmp.exists():
        tmp.unlink()

    db = sqlite3.connect(tmp)
    db.executescript(SCHEMA)
    db.execute('CREATE INDEX draft_picks_slot ON draft_picks(draft, round, slot)')

    # Leagues: the furthest-along, latest crawl of each league-season wins.
    # Drafts go straight to the database in run order (a later crawl of a
    # draft replaces an earlier one), and only their metadata stays in memory:
    # tens of millions of selections across every run do not fit otherwise.
    leagues: dict[str, dict] = {}
    for r in read_shards(d, 'leagues'):
        for dr in r.get('drafts', []):
            s = dr.get('settings') or {}
            db.execute('INSERT OR REPLACE INTO drafts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', (
                dr['draft'], r['lg'], int(dr['season']) if dr.get('season') else None, dr.get('type'), dr.get('status'),
                dr.get('startTime'), dr.get('scoringType'), s.get('rounds'), s.get('teams'),
                s.get('player_type'), s.get('reversal_round'), j(s), j(dr.get('slotToRoster'))))
            db.execute('DELETE FROM draft_picks WHERE draft = ?', (dr['draft'],))
            db.executemany('INSERT OR REPLACE INTO draft_picks VALUES (?,?,?,?,?,?,?,?)',
                           [(dr['draft'], *p) for p in dr.get('picks') or []])
            dr.pop('picks', None)
        # Weekly matchups are only used by the crawler (records at trade time).
        r.pop('matchups', None)
        if lite:
            for k in ('settings', 'scoring', 'rosterPositions'):
                r.pop(k, None)
            for ro in r.get('rosters', []):
                for k in ('players', 'starters', 'taxi', 'reserve', 'keepers'):
                    ro.pop(k, None)
        cur = leagues.get(r['lg'])
        if cur is None or (r.get('throughLeg', 0), r.get('crawledAt', '')) >= (cur.get('throughLeg', 0), cur.get('crawledAt', '')):
            leagues[r['lg']] = r
    print(f'  {len(leagues)} league-seasons')

    # Lineage: follow prev back to the first season we know of.
    def root(lg: str) -> str:
        seen = set()
        while lg in leagues and leagues[lg].get('prev') and leagues[lg]['prev'] in leagues and lg not in seen:
            seen.add(lg)
            lg = leagues[lg]['prev']
        return lg
    lineage = {lg: root(lg) for lg in leagues}
    # (lineage, season) → league-season, for resolving picks and last-season finish.
    by_lineage_season: dict[tuple[str, int], str] = {}
    for lg, r in leagues.items():
        by_lineage_season[(lineage[lg], int(r['season']))] = lg

    roster_index: dict[tuple[str, int], dict] = {}
    drafts_by_lg_season: dict[tuple[str, int], list[dict]] = {}
    n_trades: dict[str, int] = {}

    for lg, r in leagues.items():
        f = r.get('format', {})
        for ro in r.get('rosters', []):
            roster_index[(lg, ro['rid'])] = ro
            db.execute('INSERT INTO rosters VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
                lg, ro['rid'], ro.get('owner'), j(ro.get('coOwners')), ro.get('w'), ro.get('l'), ro.get('t'),
                ro.get('pf'), ro.get('pa'), ro.get('maxPf'), ro.get('rank'),
                int(r.get('champion') == ro['rid']), int(r.get('runnerUp') == ro['rid']),
                ro.get('faabUsed'), ro.get('moves'), j(ro.get('players')), j(ro.get('starters')),
                j(ro.get('taxi')), j(ro.get('reserve')), j(ro.get('keepers'))))
        for dr in r.get('drafts', []):
            if dr.get('season'):
                drafts_by_lg_season.setdefault((lg, int(dr['season'])), []).append(dr)

    def resolve_pick(lg: str, season: int, rnd: int, orig: int, traded_at: int | None):
        target = by_lineage_season.get((lineage[lg], season))
        if target is None:
            # The season's league-season is not in the crawl (yet): either the
            # draft has not happened or that season was never crawled.
            return ('not_crawled', None, None, None, None)
        cands = sorted(drafts_by_lg_season.get((target, season), []), key=lambda d: d.get('startTime') or 0)
        if not cands:
            return ('no_draft', None, None, None, None)
        # A startup year can hold a startup and a rookie draft in the same
        # season. The pick is spent in a draft that has its round (a round-12
        # pick is a startup pick, even when traded mid-draft), the first one
        # starting after the trade, else the last that started before it (a
        # slow draft still running when the trade was made).
        deep = [d for d in cands if ((d.get('settings') or {}).get('rounds') or 99) >= rnd] or cands
        after = [d for d in deep if traded_at and (d.get('startTime') or 0) >= traded_at]
        dr = after[0] if after else deep[-1]
        slot = None
        for sl, rid in (dr.get('slotToRoster') or {}).items():
            # Sleeper's slot map can hold a blank key (the first full crawl,
            # Oct 2026): only numeric slots count.
            if rid == orig and str(sl).strip().isdigit():
                slot = int(sl)
        if slot is None:
            return ('order_not_set', dr['draft'], None, None, None)
        hit = db.execute('SELECT pick_no, player_id FROM draft_picks WHERE draft = ? AND round = ? AND slot = ? LIMIT 1',
                         (dr['draft'], rnd, slot)).fetchone()
        if hit:
            return ('resolved', dr['draft'], hit[0], slot, hit[1])
        # Slot known; the pick is not made yet (or the draft had fewer rounds).
        return ('slotted', dr['draft'], None, slot, None)

    seen_trades = set()
    n_assets = 0
    # Newest shard first, streamed: the latest copy of a trade is kept.
    for t in read_shards(d, 'trades', newest_first=True):
        if t['id'] in seen_trades or t['lg'] not in leagues:
            continue
        seen_trades.add(t['id'])
        lg = t['lg']
        f = t.get('format', {})
        sides = t.get('sides', [])
        n_players = sum(len(s['gets']['players']) for s in sides)
        n_picks = sum(len(s['gets']['picks']) for s in sides)
        faab = sum(s['gets']['faab'] for s in sides)
        db.execute('INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
            t['id'], lg, lineage[lg], int(t['season']), t.get('leg'), t.get('created'), t.get('completed'),
            t.get('creatorRid'), t.get('nSides'), f.get('type'), f.get('teams'), int(bool(f.get('sf'))),
            f.get('tep'), f.get('ppr'), f.get('faabBudget'), int(bool(f.get('bestBall'))),
            n_players, n_picks, faab, None if lite else j(t.get('raw'))))
        n_trades[lg] = n_trades.get(lg, 0) + 1

        prev_lg = by_lineage_season.get((lineage[lg], int(t['season']) - 1))
        for s in sides:
            rec = s.get('record') or {}
            fin = roster_index.get((lg, s['rid'])) or {}
            prev = roster_index.get((prev_lg, s['rid'])) if prev_lg else None
            prev_champ = int(leagues[prev_lg].get('champion') == s['rid']) if prev_lg else None
            db.execute('INSERT OR REPLACE INTO trade_sides VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
                t['id'], s['rid'], s.get('owner'),
                rec.get('w'), rec.get('l'), rec.get('t'), rec.get('pf'), rec.get('pa'), rec.get('rank'),
                fin.get('rank'), fin.get('w'), fin.get('l'),
                prev.get('rank') if prev else None, prev_champ,
                len(s['gets']['players']), len(s['gets']['picks']), s['gets']['faab'],
                len(s['gives']['players']), len(s['gives']['picks']), s['gives']['faab'],
                j(s.get('cut')), j(s.get('added'))))

        # Asset rows from the raw encoding: each asset's giver and receiver.
        raw = t.get('raw') or {}
        adds, drops = raw.get('adds') or {}, raw.get('drops') or {}
        rows = []
        for pid, to in adds.items():
            if pid in drops:
                rows.append((t['id'], drops[pid], to, 'player', pid, None, None, None, None, None, None, None, None, None))
        for p in raw.get('draft_picks') or []:
            try:
                status, draft, pick_no, slot, chosen = resolve_pick(lg, int(p['season']), p['round'], p['roster_id'], t.get('created'))
            except (TypeError, ValueError, KeyError):
                # One odd pick must not stop a build of hundreds of thousands.
                status, draft, pick_no, slot, chosen = 'error', None, None, None, None
            rows.append((t['id'], p['previous_owner_id'], p['owner_id'], 'pick', None, int(p['season']), p['round'],
                         p['roster_id'], None, status, draft, pick_no, slot, chosen))
        for w in raw.get('waiver_budget') or []:
            rows.append((t['id'], w['sender'], w['receiver'], 'faab', None, None, None, None, w['amount'],
                         None, None, None, None, None))
        if 'yahoo' in raw:
            # Yahoo trades (scripts/crawl-yahoo-trades.py) carry no Sleeper
            # encoding: read the moves off the sides. A Yahoo pick names its
            # round and original team but not its season, so it stays unresolved.
            giver = {}
            for s in sides:
                for pid in s['gives']['players']:
                    giver[pid] = s['rid']
            for s in sides:
                for pid in s['gets']['players']:
                    rows.append((t['id'], giver.get(pid), s['rid'], 'player', pid, None, None, None, None,
                                 None, None, None, None, None))
                for pk in s['gets']['picks']:
                    src = next((o['rid'] for o in sides if pk in o['gives']['picks']), None)
                    rows.append((t['id'], src, s['rid'], 'pick', None, None, pk.get('round'), pk.get('orig'), None,
                                 'yahoo_no_season', None, None, None, None))
        db.executemany('INSERT INTO trade_assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
        n_assets += len(rows)
    print(f'  {len(seen_trades)} trades, {n_assets} assets')

    for lg, r in leagues.items():
        f = r.get('format', {})
        db.execute('INSERT INTO leagues VALUES (' + ','.join(['?'] * 40) + ')', (
            lg, r.get('prev'), lineage[lg], int(r['season']), r.get('seasonType'), r.get('status'),
            r.get('throughLeg'), f.get('type'), f.get('teams'), int(bool(f.get('sf'))), f.get('qb'),
            f.get('superflex'), f.get('rb'), f.get('wr'), f.get('te'), f.get('flex'), f.get('starters'),
            f.get('bench'), f.get('taxi'), f.get('ir'), int(bool(f.get('idp'))), f.get('ppr'), f.get('tep'),
            f.get('passTd'), f.get('ppc'), int(bool(f.get('bestBall'))), f.get('faabBudget'),
            f.get('tradeDeadline'), f.get('playoffTeams'), f.get('playoffWeekStart'), f.get('draftRounds'),
            int(bool(f.get('pickTrading'))), r.get('champion'), r.get('runnerUp'), n_trades.get(lg, 0),
            r.get('crawledAt'), j(r.get('settings')), j(r.get('scoring')), j(r.get('rosterPositions')),
            j(r.get('txnCounts'))))

    seen_w = set()
    n_w = 0
    for w in ([] if lite else read_shards(d, 'waivers', newest_first=True)):
        if w['id'] in seen_w:
            continue
        seen_w.add(w['id'])
        adds = w.get('adds') or []
        db.execute('INSERT INTO waivers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
            w['id'], w['lg'], int(w['season']), w.get('leg'), w.get('type'), w.get('status'), w.get('created'),
            w.get('rid'), w.get('owner'), adds[0] if adds else None, j(adds), j(w.get('drops')),
            w.get('bid'), w.get('faabBudget'), w.get('teams'), w.get('leagueType'), int(bool(w.get('sf')))))
        n_w += 1
    print(f'  {n_w} waiver claims')

    players_path = Path('public/data/sleeper-players.json')
    if players_path.exists():
        pl = json.loads(players_path.read_text()).get('players', [])
        db.executemany('INSERT OR REPLACE INTO players VALUES (?,?,?)',
                       [(p['player_id'], p.get('name'), p.get('position')) for p in pl])
    # Whole league lists of the managers the crawl looked up (latest wins).
    db.executemany('INSERT OR REPLACE INTO managers VALUES (?,?,?,?,?,?,?,?,?,?)', [
        (m['owner'], int(m['season']), m.get('leagues'), m.get('dynasty'), m.get('keeper'), m.get('redraft'),
         m.get('bestBall'), m.get('sf'), m.get('tradesOff'), m.get('teamsAvg'))
        for m in read_shards(d, 'managers')])
    # Players a crawler could not map to a Sleeper id (Yahoo: "y:<id>").
    db.executemany('INSERT OR IGNORE INTO players VALUES (?,?,?)',
                   [(p['player_id'], p.get('name'), p.get('position')) for p in read_shards(d, 'players')])

    db.executemany('INSERT INTO meta VALUES (?,?)', [
        ('built_at', __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(timespec='seconds')),
        ('league_seasons', str(len(leagues))), ('trades', str(len(seen_trades))), ('waivers', str(n_w)),
        ('lite', str(int(lite))),
    ])
    db.executescript(INDEXES)
    db.commit()
    db.close()
    os.replace(tmp, out)

    db = sqlite3.connect(out)
    q = lambda sql: db.execute(sql).fetchall()
    print('  by format:', q("SELECT type, sf, COUNT(*) FROM trades GROUP BY type, sf ORDER BY 3 DESC"))
    print('  by season:', q("SELECT season, COUNT(*) FROM trades GROUP BY season ORDER BY season"))
    print('  pick resolution:', q("SELECT pick_status, COUNT(*) FROM trade_assets WHERE kind='pick' GROUP BY 1 ORDER BY 2 DESC"))
    print(f'  → {out} ({out.stat().st_size / 1e6:.1f} MB)')
    # Aggregate counts for scripts/publish-crawl-metrics.py (no ids).
    picks = dict(q("SELECT pick_status, COUNT(*) FROM trade_assets WHERE kind='pick' GROUP BY 1"))
    (d / 'build-summary.json').write_text(json.dumps({
        'leagueSeasons': q('SELECT COUNT(*) FROM leagues')[0][0],
        'lineages': q('SELECT COUNT(DISTINCT lineage) FROM leagues')[0][0],
        'trades': q('SELECT COUNT(*) FROM trades')[0][0],
        'waivers': q('SELECT COUNT(*) FROM waivers')[0][0],
        'managers': q('SELECT COUNT(DISTINCT owner) FROM rosters WHERE owner IS NOT NULL')[0][0],
        'tradesByType': {f'{t}{" sf" if sf else ""}': n for t, sf, n in q('SELECT type, sf, COUNT(*) FROM trades GROUP BY 1, 2')},
        'tradesBySeason': {str(y): n for y, n in q('SELECT season, COUNT(*) FROM trades GROUP BY 1')},
        'pickResolution': picks,
        'pickResolvedShare': round(picks.get('resolved', 0) / max(sum(picks.values()), 1), 3),
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
