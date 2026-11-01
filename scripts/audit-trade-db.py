#!/usr/bin/env python3
"""Aggregate-only audit of the trade database (docs/sleeper-trade-db.md).

Reads the SQLite built by scripts/build-sleeper-trade-db.py (--lite is enough)
and streams the waiver shards, and writes counts only: no trade, league or
manager ids, and every count below MIN_CELL is suppressed (null). The output
is safe to publish next to metrics.json.

  formats      league-seasons and trades by format and season
  settings     team counts, TE premium, PPR, best ball, IDP, pick trading
  rate         trades per league-season by format (quantiles), share with none
  timing       trades by week (leg) and calendar month
  shapes       what each side gets (players / picks / FAAB), most common pairs
  picks        resolution status by how far ahead the pick was
  quality      screens for trades a value fit should drop or down-weight
  population   the format mix of the sampled managers' whole league lists
               (the crawl reaches dynasty first; this is the population)
  waivers      claims by format, won / lost, bid as a share of the budget
  playerActivity  how often players are traded, by rank tier (last 52 weeks):
               trades per week and weeks to gather 20 / 50 trades, which sets
               how long a window a point-in-time value needs
  crawlLag     hours from a trade being made to the crawl that first saw it

Usage: python3 scripts/audit-trade-db.py <dir> [--platform=sleeper] [--out=audit.json]
       [--skip-waivers --waivers-from=<previous audit.json>]   (weekly runs)
"""
from __future__ import annotations

import gzip
import glob
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

MIN_CELL = 10


def sup(n):
    return n if n >= MIN_CELL else None


def sup_dict(d):
    return {str(k): sup(v) for k, v in sorted(d.items(), key=lambda kv: str(kv[0]))}


def quantiles(values, qs=(0.1, 0.25, 0.5, 0.75, 0.9, 0.99)):
    if len(values) < MIN_CELL:
        return None
    v = sorted(values)
    return {f'p{int(q * 100)}': v[min(len(v) - 1, int(q * len(v)))] for q in qs}


def hist_quantiles(hist, total, qs=(0.1, 0.25, 0.5, 0.75, 0.9, 0.99)):
    """Quantiles from a {bin: count} histogram (bins are sortable numbers)."""
    if total < MIN_CELL:
        return None
    out, acc, keys = {}, 0, sorted(hist)
    targets = [(q, q * total) for q in qs]
    i = 0
    for k in keys:
        acc += hist[k]
        while i < len(targets) and acc >= targets[i][1]:
            out[f'p{int(targets[i][0] * 100)}'] = k
            i += 1
    return out


def fmt_key(t, sf):
    return f'{t or "?"}{" sf" if sf else ""}'


def side_shape(players, picks, faab):
    parts = []
    if players:
        parts.append(f'{players}P')
    if picks:
        parts.append(f'{picks}K')
    if faab:
        parts.append('F')
    return '+'.join(parts) or 'nothing'


def audit(d: Path) -> dict:
    db = sqlite3.connect(d / 'sleeper-trades.sqlite')
    q = lambda sql, *a: db.execute(sql, a).fetchall()
    out: dict = {}
    meta = dict(q('SELECT key, value FROM meta'))
    out['meta'] = {
        'builtAt': meta.get('built_at'), 'lite': meta.get('lite') == '1',
        'leagueSeasons': q('SELECT COUNT(*) FROM leagues')[0][0],
        'lineages': q('SELECT COUNT(DISTINCT lineage) FROM leagues')[0][0],
        'trades': q('SELECT COUNT(*) FROM trades')[0][0],
    }

    # Formats.
    out['formats'] = {
        'leagueSeasonsByFormat': sup_dict({fmt_key(t, sf): n for t, sf, n in q('SELECT type, sf, COUNT(*) FROM leagues GROUP BY 1, 2')}),
        'tradesByFormat': sup_dict({fmt_key(t, sf): n for t, sf, n in q('SELECT type, sf, COUNT(*) FROM trades GROUP BY 1, 2')}),
        'tradesBySeasonFormat': {str(y): sup_dict({fmt_key(t, sf): n for yy, t, sf, n in rows if yy == y})
                                 for rows in [q('SELECT season, type, sf, COUNT(*) FROM trades GROUP BY 1, 2, 3')]
                                 for y in sorted({r[0] for r in rows})},
    }

    # League settings, over league-seasons and weighted by trades.
    def dist(col, where=''):
        return {
            'leagueSeasons': sup_dict(dict(q(f'SELECT {col}, COUNT(*) FROM leagues {where} GROUP BY 1'))),
            'trades': sup_dict(dict(q(f'SELECT l.{col}, COUNT(*) FROM trades t JOIN leagues l ON l.lg = t.lg {where.replace("WHERE", "WHERE l.")} GROUP BY 1'))),
        }
    out['settings'] = {c: dist(c) for c in ('teams', 'tep', 'pass_td', 'ppr', 'best_ball', 'idp', 'pick_trading', 'superflex', 'taxi')}
    # The scoring the player-value fit prices separately (TE premium, 6-point
    # passing TDs), by format: trades in dynasty / keeper leagues.
    def tier(tep, ptd):
        te = 'none' if not tep or tep <= 0 else 'under0.75' if tep < 0.75 else '0.75plus'
        return f"te-{te}|passtd-{'6' if ptd is not None and ptd >= 5.5 else '4'}"
    sc = Counter()
    for sf, tep, ptd, n in q("SELECT t.sf, t.tep, l.pass_td, COUNT(*) FROM trades t JOIN leagues l ON l.lg = t.lg "
                             "WHERE t.type IN ('dynasty', 'keeper') GROUP BY 1, 2, 3"):
        sc[('superflex' if sf else '1qb', tier(tep, ptd))] += n
    out['settings']['scoringByFormat'] = {f: sup_dict({k: n for (ff, k), n in sc.items() if ff == f}) for f in ('superflex', '1qb')}

    # Trade rate per league-season.
    rate = {}
    for t, sf in q('SELECT DISTINCT type, sf FROM leagues'):
        ns = [r[0] for r in q('SELECT n_trades FROM leagues WHERE type IS ? AND sf IS ? AND status = ?', t, sf, 'complete')]
        if len(ns) >= MIN_CELL:
            rate[fmt_key(t, sf)] = {'completedSeasons': len(ns), 'noTrades': round(sum(1 for n in ns if not n) / len(ns), 3),
                                    'tradesPerSeason': quantiles(ns)}
    out['rate'] = rate

    # Timing.
    month = Counter()
    for (created,) in db.execute('SELECT created FROM trades WHERE created IS NOT NULL'):
        month[datetime.fromtimestamp(created / 1000, timezone.utc).month] += 1
    out['timing'] = {'byLeg': sup_dict(dict(q('SELECT leg, COUNT(*) FROM trades GROUP BY 1'))), 'byMonth': sup_dict(month)}

    # Shapes: what each side gets, as a pair of sides.
    pairs, side_kinds = Counter(), Counter()
    with_picks = with_faab = multi = 0
    cur, shapes = None, []
    for tid, n_sides, pi, ki, fi in db.execute(
            'SELECT s.trade_id, t.n_sides, s.players_in, s.picks_in, s.faab_in FROM trade_sides s '
            'JOIN trades t ON t.id = s.trade_id ORDER BY s.trade_id'):
        if tid != cur:
            if shapes:
                pairs[' <> '.join(sorted(shapes))] += 1
            cur, shapes = tid, []
        shapes.append(side_shape(pi, ki, fi))
    if shapes:
        pairs[' <> '.join(sorted(shapes))] += 1
    with_picks = q('SELECT COUNT(*) FROM trades WHERE n_picks > 0')[0][0]
    with_faab = q('SELECT COUNT(*) FROM trades WHERE faab_total > 0')[0][0]
    multi = q('SELECT COUNT(*) FROM trades WHERE n_sides > 2')[0][0]
    total = max(out['meta']['trades'], 1)
    out['shapes'] = {
        'withPicks': round(with_picks / total, 3), 'withFaab': round(with_faab / total, 3),
        'multiTeam': round(multi / total, 4),
        'pickOnly': sup(q('SELECT COUNT(*) FROM trades WHERE n_picks > 0 AND n_players = 0 AND faab_total = 0 AND n_sides = 2')[0][0]),
        'topPairs': {k: sup(v) for k, v in pairs.most_common(30)},
    }

    # Picks: status by how far ahead (pick season minus the next draft year).
    ahead = defaultdict(Counter)
    for status, pseason, created, rnd in db.execute(
            "SELECT a.pick_status, a.pick_season, t.created, a.pick_round FROM trade_assets a "
            "JOIN trades t ON t.id = a.trade_id WHERE a.kind = 'pick'"):
        if pseason is None or created is None:
            ahead['unknown'][status] += 1
            continue
        dt = datetime.fromtimestamp(created / 1000, timezone.utc)
        ya = pseason - (dt.year if dt.month < 9 else dt.year + 1)
        ahead[str(max(-1, min(ya, 3)))][status] += 1
    out['picks'] = {
        'byStatus': sup_dict(dict(q("SELECT pick_status, COUNT(*) FROM trade_assets WHERE kind = 'pick' GROUP BY 1"))),
        'byRound': sup_dict(dict(q("SELECT MIN(pick_round, 6), COUNT(*) FROM trade_assets WHERE kind = 'pick' GROUP BY 1"))),
        'byYearsAheadStatus': {k: sup_dict(v) for k, v in sorted(ahead.items())},
        'yearsAheadNote': 'pick season minus the next rookie-draft year at the trade (calendar: Jan-Aug = this year, '
                          'Sep-Dec = next); -1 = an older season, a data oddity',
    }

    # Quality screens (counts of trades flagged; a trade can carry several).
    flags = Counter()
    flags['multiTeam'] = multi
    flags['mega10Assets'] = q('SELECT COUNT(*) FROM trades WHERE n_players + n_picks >= 10')[0][0]
    flags['gift'] = q('SELECT COUNT(DISTINCT trade_id) FROM trade_sides WHERE players_in + picks_in + faab_in = 0')[0][0]
    flags['sameOwnerBothSides'] = q(
        'SELECT COUNT(*) FROM (SELECT trade_id FROM trade_sides WHERE owner IS NOT NULL '
        'GROUP BY trade_id HAVING COUNT(DISTINCT owner) < COUNT(*))')[0][0]
    flags['orphanSide'] = q('SELECT COUNT(DISTINCT trade_id) FROM trade_sides WHERE owner IS NULL')[0][0]
    # The same two managers trading 6+ times in one league-season.
    flags['repeatPair6'] = q(
        'SELECT COALESCE(SUM(n), 0) FROM (SELECT lg, a, b, COUNT(*) n FROM ('
        '  SELECT t.lg lg, MIN(s.owner) a, MAX(s.owner) b FROM trades t JOIN trade_sides s ON s.trade_id = t.id '
        '  WHERE t.n_sides = 2 AND s.owner IS NOT NULL GROUP BY t.id) GROUP BY lg, a, b HAVING COUNT(*) >= 6)')[0][0]
    # League-seasons trading more than four times per team.
    flags['hyperactiveLeague'] = q(
        'SELECT COALESCE(SUM(n_trades), 0) FROM leagues WHERE teams > 0 AND n_trades > 4 * teams')[0][0]
    flags['afterDeadline'] = q(
        'SELECT COUNT(*) FROM trades t JOIN leagues l ON l.lg = t.lg '
        'WHERE l.trade_deadline > 0 AND l.trade_deadline < 99 AND t.leg > l.trade_deadline AND t.leg < 18')[0][0]
    out['quality'] = {'flags': sup_dict(flags), 'note': (
        'multiTeam: 3+ sides. mega10Assets: 10+ players and picks. gift: a side gets nothing. '
        'sameOwnerBothSides: one manager on two sides. orphanSide: a side with no manager. '
        'repeatPair6: trades between two managers who traded 6+ times that league-season. '
        'hyperactiveLeague: trades in league-seasons with more than 4 per team. '
        'afterDeadline: weeks past the league trade deadline, before the offseason (commissioner).')}

    # Population: the sampled managers' whole league lists.
    pop = {}
    for season, n, dyn, kee, red, bb, sf in q(
            'SELECT season, COUNT(*), SUM(dynasty), SUM(keeper), SUM(redraft), SUM(best_ball), SUM(sf) '
            'FROM managers GROUP BY season'):
        leagues = (dyn or 0) + (kee or 0) + (red or 0)
        if n < MIN_CELL or not leagues:
            continue
        pop[str(season)] = {
            'managers': n, 'leagues': leagues,
            'leagueShare': {'dynasty': round(dyn / leagues, 3), 'keeper': round(kee / leagues, 3), 'redraft': round(red / leagues, 3)},
            'bestBallShare': round((bb or 0) / leagues, 3), 'sfShare': round((sf or 0) / leagues, 3),
            'managersWithAnyRedraft': round(q('SELECT COUNT(*) FROM managers WHERE season = ? AND redraft > 0', season)[0][0] / n, 3),
        }
    out['population'] = {'bySeason': pop, 'note': (
        'Managers the crawl looked up (sampled through the leagues it reached, so dynasty players are '
        'over-represented): every league they were in that season, counted by format.')}
    db.close()
    return out


WEEK_MS = 7 * 86400 * 1000
RANK_TIERS = ((1, 50), (51, 200), (201, 500), (501, 10 ** 9))


def player_activity(d: Path) -> dict:
    """How often each player is traded: what a point-in-time value can lean on.

    Over the last 52 weeks of trades: players ranked by how many trades they
    were in, and per rank tier the weekly rate (quantiles over players) and
    the weeks it takes to gather 20 and 50 trades at that rate. No player ids.
    """
    db = sqlite3.connect(d / 'sleeper-trades.sqlite')
    last = db.execute('SELECT MAX(created) FROM trades').fetchone()[0]
    if not last:
        return {}
    start = last - 52 * WEEK_MS
    per_player = Counter()
    per_week = Counter()
    for pid, created in db.execute(
            "SELECT a.player_id, t.created FROM trade_assets a JOIN trades t ON t.id = a.trade_id "
            "WHERE a.kind = 'player' AND a.player_id IS NOT NULL AND t.created >= ?", (start,)):
        per_player[pid] += 1
        per_week[(pid, (created - start) // WEEK_MS)] += 1
    db.close()
    weeks = 52
    ranked = [n for _, n in per_player.most_common()]
    tiers = {}
    for lo, hi in RANK_TIERS:
        group = ranked[lo - 1:hi]
        if len(group) < MIN_CELL:
            continue
        rates = [n / weeks for n in group]
        med = sorted(rates)[len(rates) // 2]
        tiers[f'{lo}-{hi}' if hi < 10 ** 9 else f'{lo}+'] = {
            'players': len(group),
            'tradesPerWeek': {k: round(v, 2) for k, v in quantiles(rates, (0.1, 0.5, 0.9)).items()},
            'weeksFor20Trades': round(20 / med, 1) if med else None,
            'weeksFor50Trades': round(50 / med, 1) if med else None,
        }
    return {
        'window': {'from': datetime.fromtimestamp(start / 1000, timezone.utc).date().isoformat(),
                   'to': datetime.fromtimestamp(last / 1000, timezone.utc).date().isoformat(), 'weeks': weeks},
        'playersTraded': len(per_player),
        'byRankTier': tiers,
        'tradesPerPlayerWeek': quantiles(list(per_week.values())),
        'note': ('Players ranked by trades they were in over the window. tradesPerWeek: quantiles over the '
                 'tier\'s players of trades per week (averaged over the window, so seasonal peaks run higher). '
                 'weeksForNTrades: weeks for the tier\'s median player to appear in N trades. '
                 'tradesPerPlayerWeek: over player-weeks with at least one trade.'),
    }


def crawl_lag(d: Path) -> dict:
    """How long after a trade is made it first appears in a crawl: the floor on
    how current a value can be. Only trades made after the first run started
    count (older ones are history the crawl backfills)."""
    files = sorted(glob.glob(str(d / 'shards' / '*-trades.jsonl.gz')))
    if not files:
        return {}

    def run_ms(f):
        stamp = Path(f).name.split('-')[0]
        try:
            return int(datetime.strptime(stamp, '%Y%m%dT%H%M%S').replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            return None

    first_run = run_ms(files[0])
    if first_run is None:
        return {}
    seen, lags = set(), []
    for f in files:
        ts = run_ms(f)
        with gzip.open(f, 'rt') as fh:
            for line in fh:
                if not line.strip():
                    continue
                t = json.loads(line)
                if t['id'] in seen:
                    continue
                seen.add(t['id'])
                created = t.get('created')
                if ts and created and created >= first_run:
                    # The run's start stamps the shard; the trade was fetched
                    # during that run, so the lag is approximate (up to ~5.5 h).
                    lags.append(max(0.0, (ts - created) / 3600000))
    q = quantiles(lags, (0.25, 0.5, 0.75, 0.9))
    return {
        'since': datetime.fromtimestamp(first_run / 1000, timezone.utc).isoformat(timespec='minutes'),
        'trades': len(lags),
        'lagHours': {k: round(v, 1) for k, v in q.items()} if q else None,
        'note': ('Hours from a trade being made to the start of the run that first saw it, for trades made '
                 'since the first run. Current-season leagues already crawled are re-read daily for new trades (crawler --refreshCurrent=auto).'),
    }


def audit_waivers(d: Path) -> dict:
    by_fmt, status = Counter(), Counter()
    share_hist = defaultdict(Counter)  # format -> {percent of budget: n}, won FAAB claims
    zero = Counter()
    seen = set()
    for f in sorted(glob.glob(str(d / 'shards' / '*-waivers.jsonl.gz')), reverse=True):
        with gzip.open(f, 'rt') as fh:
            for line in fh:
                if not line.strip():
                    continue
                w = json.loads(line)
                if w['id'] in seen:
                    continue
                seen.add(w['id'])
                k = fmt_key(w.get('leagueType'), w.get('sf'))
                by_fmt[k] += 1
                status[w.get('status')] += 1
                budget, bid = w.get('faabBudget') or 0, w.get('bid')
                if w.get('status') == 'complete' and budget > 0 and bid is not None:
                    if bid == 0:
                        zero[k] += 1
                    share_hist[k][min(100, round(100 * bid / budget))] += 1
    return {
        'claims': sum(by_fmt.values()), 'byFormat': sup_dict(by_fmt), 'byStatus': sup_dict(status),
        'wonBidShareOfBudgetPct': {k: hist_quantiles(h, sum(h.values())) for k, h in share_hist.items()},
        'wonZeroBidShare': {k: round(zero[k] / sum(h.values()), 3) for k, h in share_hist.items() if sum(h.values()) >= MIN_CELL},
    }


def main() -> None:
    args = dict(a.lstrip('-').split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    d = Path(next(a for a in sys.argv[1:] if not a.startswith('--')))
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    if '--skip-waivers' in sys.argv[1:]:
        # Reading every waiver claim (18M) is most of the audit's time; the
        # weekly run carries the last full (monthly) audit's waiver section.
        old = Path(args['waivers-from']) if args.get('waivers-from') else None
        prev = json.loads(old.read_text()).get('waivers') if old and old.exists() else None
        waivers = {**prev, 'carriedFrom': prev.get('asOf') or prev.get('carriedFrom')} if prev else {'claims': 0, 'skipped': True}
    else:
        waivers = {**audit_waivers(d), 'asOf': now}
    report = {'platform': args.get('platform', 'sleeper'), 'generatedAt': now,
              'minCell': MIN_CELL, **audit(d), 'waivers': waivers,
              'playerActivity': player_activity(d), 'crawlLag': crawl_lag(d)}
    out = Path(args.get('out', d / 'audit.json'))
    out.write_text(json.dumps(report, indent=1) + '\n')
    m = report['meta']
    print(f"Audit ({report['platform']}): {m['trades']:,} trades, {m['leagueSeasons']:,} league-seasons, "
          f"{report['waivers'].get('claims', 0):,} waiver claims"
          f"{' (carried from ' + str(report['waivers'].get('carriedFrom')) + ')' if report['waivers'].get('carriedFrom') else ''} -> {out}")
    print('  trades by format:', report['formats']['tradesByFormat'])
    print('  quality flags:', report['quality']['flags'])
    print('  population:', {s: p['leagueShare'] for s, p in report['population']['bySeason'].items()})
    print('  player activity:', report['playerActivity'].get('byRankTier'))
    print('  crawl lag:', report['crawlLag'].get('lagHours'))


if __name__ == '__main__':
    main()
