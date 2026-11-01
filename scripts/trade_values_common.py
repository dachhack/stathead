"""Shared pieces of the trade-value fits (scripts/fit-pick-values.py,
scripts/fit-player-values.py): which picks are rookie picks, how far ahead a
pick's draft is at the trade, and the early / mid / late tier from the
original owner's standing.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

STARTUP_ROUNDS = 6   # a draft with more rounds is a startup (or redraft-style) draft
ROUNDS = 5           # round classes: 1-4, 5 = fifth or later
AHEAD = 4            # 0 = next rookie draft, 1, 2, 3 = 3+
TIERS = 'EMLU'
DRAFT_DAYS = 30      # a rookie draft counts as finished this long after it starts


class DraftCalendar:
    """When is a league's next rookie draft, at the moment of a trade?

    A league holds its rookie draft for year Y at its own date (May to
    September, mostly). Before that date the next draft is Y's; after it, Y+1's.
    Where the league's Y draft is not crawled, a calendar fallback: Jan-Aug is
    Y's, Sep-Dec is Y+1's. (Calendar-only put June trades made after a May
    draft a season too far ahead.)
    """

    def __init__(self, db):
        self.start: dict[tuple[str, int], int] = {}
        for lineage, season, start in db.execute(
                'SELECT l.lineage, d.season, MIN(d.start_time) FROM drafts d JOIN leagues l ON l.lg = d.lg '
                'WHERE d.rounds <= ? AND d.start_time IS NOT NULL AND d.season IS NOT NULL GROUP BY 1, 2',
                (STARTUP_ROUNDS,)):
            self.start[(lineage, int(season))] = start

    def ahead(self, lineage: str, created_ms: int, pick_season: int) -> int:
        """Seasons from the next rookie draft to the pick's draft (0 = the
        next one; negative = a draft already held, which a trade cannot hold).

        A trade after the league's Y draft started, of a pick in that Y draft,
        is a trade during the draft: slow drafts run for days or weeks and picks
        change hands while they do. That pick is in the next draft (0). The
        first run with the draft calendar (2026-10-20) missed this and dropped
        227k trades as holding used picks."""
        dt = datetime.fromtimestamp(created_ms / 1000, timezone.utc)
        st = self.start.get((lineage, dt.year))
        if st:
            if created_ms >= st and pick_season == dt.year:
                return 0
            # Next year's picks are a season out until this year's draft ends;
            # with no end time recorded, a draft counts as over DRAFT_DAYS in.
            nxt = dt.year if created_ms < st + DRAFT_DAYS * 86400 * 1000 else dt.year + 1
        else:
            nxt = dt.year if dt.month < 9 else dt.year + 1
        return pick_season - nxt


class StartupFilter:
    """Startup picks are not rookie picks (a startup 1.01 is a top-ten player).
    A pick is a startup pick when it resolved to a draft of more than
    STARTUP_ROUNDS rounds, is from a later round, or is for the trade's own
    season in a league-season that holds such a draft (traded during the
    startup, before it resolves)."""

    def __init__(self, db):
        self.big_draft = set()
        self.startup_seasons = set()
        for draft, lg, season, rounds in db.execute('SELECT draft, lg, season, rounds FROM drafts'):
            if (rounds or 0) > STARTUP_ROUNDS:
                self.big_draft.add(draft)
                self.startup_seasons.add((lg, season))

    def is_startup(self, lg: str, trade_season: int, pick_season: int, rnd: int, draft: str | None) -> bool:
        return (rnd > STARTUP_ROUNDS or (draft is not None and draft in self.big_draft)
                or (pick_season == trade_season and (lg, pick_season) in self.startup_seasons))


def standings(db, trade_where: str) -> dict:
    """trade -> rid -> (rank, teams): the record at the trade in season (3+
    games), else last season's finish, which also sets the next draft's
    order in most leagues. `trade_where` filters trades (alias t)."""
    out = defaultdict(dict)
    for tid, rid, w, l, rank, prev_rank, teams in db.execute(
            'SELECT s.trade_id, s.rid, s.w, s.l, s.rank_at_trade, s.prev_rank, t.teams FROM trade_sides s '
            f'JOIN trades t ON t.id = s.trade_id WHERE {trade_where}'):
        if rank and (w or 0) + (l or 0) >= 3:
            out[tid][rid] = (rank, teams)
        else:
            out[tid][rid] = (prev_rank or None, teams)
    return out


def tier_of(rank, teams) -> str:
    if not rank or not teams or teams < 2:
        return 'U'
    r = (rank - 1) / (teams - 1)   # 0 = best team (late pick), 1 = worst (early)
    return 'E' if r >= 2 / 3 else 'L' if r < 1 / 3 else 'M'


def cell(rnd: int, ahead: int, tier: str) -> int:
    return ((min(rnd, ROUNDS) - 1) * AHEAD + min(ahead, AHEAD - 1)) * len(TIERS) + TIERS.index(tier)


def cell_key(c: int) -> tuple[int, int, str]:
    t = c % len(TIERS)
    a = (c // len(TIERS)) % AHEAD
    r = c // (len(TIERS) * AHEAD) + 1
    return r, a, TIERS[t]


N_CELLS = ROUNDS * AHEAD * len(TIERS)
