#!/usr/bin/env python3
"""Build the unified player crosswalk.

Walks nflverse rosters to assemble the NFL-side spine (gsis_id + every
alt ID: pfr, espn, sleeper, pff, yahoo, sportradar, fantasy_data, esb),
then matches every other source (KTC, career backtest, career 2026,
prospects, adp_historical) via the same nameVariants logic the TS
merge uses. Writes:

  public/data/player-crosswalk.json — one entry per canonical player
                                      with every ID + alias history
  public/data/player-aliases.json   — seeded template of unresolved or
                                      ambiguous cases to hand-edit

Canonical key format: sh_<10 hex chars> = blake2b-80 of the identity
tuple. NFL-registered players: hash("NFL:<gsis_id>"). College-only:
hash("COL:<norm>:<pos>:<draft_class>"). Keys are stable across rebuilds.

Usage:  python3 scripts/build-player-crosswalk.py
"""
from __future__ import annotations

import csv
import glob
import gzip
import hashlib
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent.parent
ROSTER_GLOB_GZ = str(ROOT / 'public/data/roster_*.csv.gz')
ROSTER_GLOB_CSV = str(ROOT / 'public/data/roster_*.csv')
CROSSWALK_OUT = ROOT / 'public/data/player-crosswalk.json'
ALIASES_OUT = ROOT / 'public/data/player-aliases.json'
PROMOTIONS_OUT = ROOT / 'public/data/player-promotions.json'

# ── Name normalization (mirrors src/lib/featureTypes.ts::nameVariants) ──

FIRST_NAME_ALIASES = {
    'cam': 'cameron', 'mitch': 'mitchell', 'josh': 'joshua', 'pat': 'patrick',
    'dan': 'daniel', 'jeff': 'jeffrey', 'chig': 'chigoziem',
    'nick': 'nicholas', 'mike': 'michael', 'reggie': 'reginald',
    'jam': 'jamarion', 'chris': 'christopher', 'tony': 'anthony',
    'tom': 'thomas', 'matt': 'matthew', 'alex': 'alexander',
    'jon': 'jonathan', 'kc': 'kevin', 'dj': 'donovan', 'tank': 'nathaniel',
}
ALIAS_REVERSE: dict[str, list[str]] = {}
for short, long_ in FIRST_NAME_ALIASES.items():
    ALIAS_REVERSE.setdefault(long_, []).append(short)
SUFFIX_TOKENS = {'jr', 'sr', 'ii', 'iii', 'iv', 'v'}


def norm(s: str | None) -> str:
    """Backward-compatible aggressive normalizer: lowercase, strip accents,
    punctuation, hyphens, trailing generational suffixes, collapse spaces."""
    if not s:
        return ''
    s = unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r"[.,'`]", '', s)
    s = re.sub(r'-', ' ', s)
    s = re.sub(r'\s+(jr|sr|ii|iii|iv|v)\.?\b', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def name_variants(name: str | None) -> list[str]:
    """Every plausible canonical form — both alias directions, middle-name
    collapsed + preserved, suffix stripped + preserved. Matches
    src/lib/featureTypes.ts::nameVariants."""
    if not name:
        return []
    cleaned = unicodedata.normalize('NFD', name).encode('ascii', 'ignore').decode().lower()
    cleaned = re.sub(r"[.,'`]", '', cleaned)
    cleaned = re.sub(r'-', ' ', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    if not cleaned:
        return []
    stripped = re.sub(r'\s+(jr|sr|ii|iii|iv|v)\.?$', '', cleaned).strip()
    bases: set[str] = {stripped}
    if stripped != cleaned:
        bases.add(cleaned)
    if not re.search(r'\s+(jr|sr|ii|iii|iv|v)\.?$', cleaned):
        bases.add(f'{stripped} jr')
        bases.add(f'{stripped} ii')
        bases.add(f'{stripped} iii')
    out: set[str] = set()
    for base in bases:
        parts = base.split(' ')
        forms = [base]
        if len(parts) >= 3 and parts[-1] not in SUFFIX_TOKENS:
            forms.append(f'{parts[0]} {parts[-1]}')
        for form in forms:
            out.add(form)
            if ' ' not in form:
                continue
            first, *rest = form.split(' ')
            if first in FIRST_NAME_ALIASES:
                out.add(f'{FIRST_NAME_ALIASES[first]} {" ".join(rest)}')
            for s in ALIAS_REVERSE.get(first, []):
                out.add(f'{s} {" ".join(rest)}')
    return list(out)


def hash_key(identity: str) -> str:
    h = hashlib.blake2b(identity.encode('utf-8'), digest_size=5).hexdigest()
    return f'sh_{h}'


# ── Spine build ──

SPINE_ID_COLUMNS = [
    'gsis_id', 'pfr_id', 'sleeper_id', 'espn_id', 'pff_id',
    'yahoo_id', 'sportradar_id', 'rotowire_id', 'fantasy_data_id', 'esb_id',
]


def roster_paths() -> list[str]:
    """Return one roster file per season, preferring the uncompressed
    `.csv` over `.csv.gz` if both exist for the same season.

    Rationale: the nflverse CSVs committed to git are gzipped (smaller
    diffs). In CI, `download-data.sh` refreshes the current season by
    writing the uncompressed `.csv` directly and never regzips, so the
    freshest 2026 data lives in `roster_2026.csv` while the stale
    committed snapshot is still at `roster_2026.csv.gz`. Preferring the
    uncompressed copy ensures a CI crosswalk rebuild sees post-draft
    rookies as soon as nflverse publishes them."""
    by_season: dict[str, str] = {}
    for path in glob.glob(ROSTER_GLOB_GZ):
        season = Path(path).name.replace('roster_', '').replace('.csv.gz', '')
        by_season[season] = path
    for path in glob.glob(ROSTER_GLOB_CSV):
        season = Path(path).name.replace('roster_', '').replace('.csv', '')
        by_season[season] = path  # .csv wins over .csv.gz
    return [by_season[s] for s in sorted(by_season)]


def build_spine() -> list[dict[str, Any]]:
    """Scan every roster_*.csv(.gz) and aggregate into one record per gsis_id.

    Keeps latest-season values for mutable fields, earliest birth_date +
    college, AND the union of every position + display_name the player has
    held across their career — many players switch (RB↔WR like McCluster,
    DB↔WR like Travis Hunter) or get renamed (Dee ↔ D'Wayne Eskridge)."""
    by_gid: dict[str, dict[str, Any]] = {}
    for path in roster_paths():
        opener = gzip.open if path.endswith('.gz') else open
        with opener(path, 'rt') as f:
            for r in csv.DictReader(f):
                gid = (r.get('gsis_id') or '').strip()
                if not gid:
                    continue
                existing = by_gid.get(gid)
                season = int(r.get('season') or 0)
                rec = {
                    'gsis_id': gid,
                    'display_name': r.get('full_name') or '',
                    'first_name': r.get('first_name') or '',
                    'last_name': r.get('last_name') or '',
                    'position': r.get('position') or '',
                    'all_positions': {r.get('position') or ''} - {''},
                    'all_names': {r.get('full_name') or ''} - {''},
                    'birth_date': r.get('birth_date') or '',
                    'college': r.get('college') or '',
                    'latest_season': season,
                    'earliest_season': season,
                }
                for col in SPINE_ID_COLUMNS:
                    val = (r.get(col) or '').strip()
                    if val:
                        rec[col] = val
                if existing:
                    rec['earliest_season'] = min(existing['earliest_season'], season)
                    rec['all_positions'] |= existing['all_positions']
                    rec['all_names'] |= existing['all_names']
                    if existing['latest_season'] > season:
                        rec['display_name'] = existing['display_name']
                        rec['position'] = existing['position']
                        rec['latest_season'] = existing['latest_season']
                    for col in SPINE_ID_COLUMNS + ['birth_date', 'college']:
                        if not rec.get(col) and existing.get(col):
                            rec[col] = existing[col]
                by_gid[gid] = rec
    # Convert sets to sorted lists for JSON-ability
    for rec in by_gid.values():
        rec['all_positions'] = sorted(rec['all_positions'])
        rec['all_names'] = sorted(rec['all_names'])
    return list(by_gid.values())


# ── Matching ──

def build_indexes(spine: list[dict[str, Any]]):
    """Index spine rows under (norm_name, position) for EVERY name the
    player has used and EVERY position they have held — fixes RB↔WR
    crossovers (McCluster) and Dee ↔ D'Wayne rename (Eskridge)."""
    by_normpos: dict[tuple[str, str], list[dict]] = defaultdict(list)
    by_norm: dict[str, list[dict]] = defaultdict(list)
    for rec in spine:
        names = set(rec.get('all_names') or [rec['display_name']])
        names.add(rec['display_name'])
        positions = set(rec.get('all_positions') or [rec['position']])
        positions.add(rec['position'])
        for nm in names:
            n = norm(nm)
            if not n:
                continue
            seen_pos = set()
            for p in positions:
                if p in seen_pos:
                    continue
                seen_pos.add(p)
                # Dedupe per (key) — a single spine rec shouldn't appear
                # multiple times for the same key because of multiple
                # names.
                bucket = by_normpos[(n, p)]
                if rec not in bucket:
                    bucket.append(rec)
            if rec not in by_norm[n]:
                by_norm[n].append(rec)
    return by_normpos, by_norm


def match_one(
    name: str,
    position: str | None,
    year: int | None,
    by_normpos: dict,
    by_norm: dict,
) -> tuple[str, list[dict]]:
    """Returns (outcome, candidates) where outcome is one of:
    'clean', 'exact_name', 'pos_free', 'era', 'latest', 'ambiguous', 'none'.
    """
    cands: list[dict] = []
    seen: set[str] = set()
    for v in name_variants(name):
        pool = by_normpos.get((v, position), []) if position else by_norm.get(v, [])
        for c in pool:
            if c['gsis_id'] in seen:
                continue
            seen.add(c['gsis_id'])
            cands.append(c)

    # Position-agnostic fallback — only fires when the ONE candidate
    # plays at a position that's plausibly compatible with the requested
    # one. Owen Marecic FB vs backtest-RB is fine (FB/RB are the same
    # role in practice, nflverse just uses FB). Evan Rodriguez FB vs
    # TE is fine (FB/TE tweener). But Antonio Williams RB should NOT
    # match a KTC query for Antonio Williams WR — those are different
    # players. COMPAT maps position-pairs we accept; everything else
    # bounces to the unresolved list.
    COMPAT = {
        'RB': {'FB'}, 'FB': {'RB'},
        'TE': {'FB'}, 'WR': set(),  # WR never falls through pos-free
        'QB': set(),
        'DB': {'CB', 'S', 'SAF'}, 'CB': {'DB', 'S', 'SAF'},
        'LB': {'DE', 'EDGE'}, 'DE': {'LB', 'EDGE'}, 'EDGE': {'DE', 'LB'},
        'DT': {'NT'}, 'NT': {'DT'},
        'OL': {'OT', 'OG', 'C'}, 'OT': {'OL', 'OG'}, 'OG': {'OL', 'OT', 'C'}, 'C': {'OL', 'OG'},
    }
    if not cands and position:
        direct = by_norm.get(norm(name), [])
        for v in name_variants(name):
            direct = direct + [c for c in by_norm.get(v, []) if c not in direct]
        if len(direct) == 1:
            cand_pos = direct[0].get('position', '')
            all_pos = set(direct[0].get('all_positions') or [cand_pos])
            if position in all_pos or cand_pos in COMPAT.get(position, set()):
                return ('pos_free', direct)
            # A single same-name spine record but an incompatible position
            # (e.g. retired RB Antonio Williams vs rookie WR Antonio Williams).
            # These are different players — bounce to unresolved instead of
            # falling through to a 'clean' single-candidate match below.
            return ('none', [])
        cands = direct  # >1 same-name records: disambiguate by year/era below

    if not cands:
        return ('none', [])
    if len(cands) == 1:
        return ('clean', cands)

    # Prefer an exact display-name match over alias-expanded matches.
    # This disambiguates Michael Thomas vs Mike Thomas: the query name
    # "Michael Thomas" matches a spine record whose normalized display
    # name is "michael thomas" — reject the Mike Thomas found only via
    # the michael↔mike alias expansion.
    query_norm = norm(name)
    exact = [c for c in cands if norm(c['display_name']) == query_norm]
    if len(exact) == 1:
        return ('exact_name', exact)
    if len(exact) > 1:
        cands = exact

    if year:
        # A player "was in the league in `year`" means their career spans
        # it: earliest roster appearance <= year + 1 AND latest >= year - 1.
        # This eliminates Frank Gore Jr. (earliest 2022) from matching
        # Frank Gore 2010, etc.
        in_league = [c for c in cands
                     if c.get('earliest_season', 0) <= year + 1
                     and c.get('latest_season', 0) >= year - 1]
        if len(in_league) == 1:
            return ('era', in_league)
        if len(in_league) > 1:
            cands = in_league

    # Last-resort tiebreak: prefer the candidate whose career is closest
    # to the source year (post-date if possible).
    if year:
        cands.sort(key=lambda c: (
            -1 if c.get('latest_season', 0) >= year else 0,
            abs(c.get('latest_season', 0) - year),
        ))
        if cands[0].get('latest_season', 0) >= year and (
            len(cands) == 1
            or cands[1].get('latest_season', 0) < year
        ):
            return ('latest', [cands[0]])
    return ('ambiguous', cands)


# ── Main ──

FC_SNAPSHOT = ROOT / 'public/data/fantasycalc_dynasty_sf.json'
SLEEPER_SNAPSHOT = ROOT / 'public/data/sleeper-players.json'


def backfill_sleeper_ids_from_fc(records: list[dict[str, Any]]) -> int:
    """Fill sleeper_id on records that lack one (gsis-less rookies who only
    exist as synthetic college records) from FantasyCalc's authoritative
    sleeperId, matched by a UNIQUE (normalized name, position). Never
    overwrites an existing id, and never assigns an id already used elsewhere."""
    if not FC_SNAPSHOT.exists():
        return 0
    try:
        raw = json.loads(FC_SNAPSHOT.read_text())
    except Exception:
        return 0
    items = raw if isinstance(raw, list) else raw.get('players', [])
    fc: dict[tuple[str, str], set[str]] = {}
    for it in items:
        pl = it.get('player', it)
        nm, pos = pl.get('name'), pl.get('position')
        sid = pl.get('sleeperId') or pl.get('sleeper_id')
        if nm and pos and sid:
            fc.setdefault((norm(nm), pos), set()).add(str(sid))

    assigned = {str(r['sleeper_id']) for r in records if r.get('sleeper_id')}
    n = 0
    for r in records:
        if r.get('sleeper_id'):
            continue
        positions = set(r.get('all_positions') or [])
        if r.get('position'):
            positions.add(r['position'])
        cand: set[str] = set()
        for pos in positions:
            cand |= fc.get((norm(r.get('display_name', '')), pos), set())
        cand -= assigned
        if len(cand) == 1:
            sid = next(iter(cand))
            r['sleeper_id'] = sid
            assigned.add(sid)
            n += 1
    return n


def backfill_sleeper_ids_from_sleeper(records: list[dict[str, Any]]) -> int:
    """Fill sleeper_id on records that still lack one, from the full Sleeper
    players list (public/data/sleeper-players.json). FantasyCalc only lists
    dynasty-relevant players, so deeper rookies stay unresolved after the FC
    pass; Sleeper's list is far broader. Matched by a UNIQUE (normalized name,
    position), same guardrails as the FC pass: never overwrites an existing id,
    and never assigns an id already used elsewhere. Run after the FC backfill so
    the more curated source wins ties."""
    if not SLEEPER_SNAPSHOT.exists():
        return 0
    try:
        raw = json.loads(SLEEPER_SNAPSHOT.read_text())
    except Exception:
        return 0
    items = raw.get('players', []) if isinstance(raw, dict) else raw
    sl: dict[tuple[str, str], set[str]] = {}
    for it in items:
        nm, sid = it.get('name'), it.get('player_id')
        if not (nm and sid):
            continue
        # Index under every position Sleeper lists for the player so a
        # crosswalk record's position (which may differ in source) still hits.
        poss = set(it.get('fantasy_positions') or [])
        if it.get('position'):
            poss.add(it['position'])
        for pos in poss:
            sl.setdefault((norm(nm), pos), set()).add(str(sid))

    assigned = {str(r['sleeper_id']) for r in records if r.get('sleeper_id')}
    n = 0
    for r in records:
        if r.get('sleeper_id'):
            continue
        positions = set(r.get('all_positions') or [])
        if r.get('position'):
            positions.add(r['position'])
        cand: set[str] = set()
        for pos in positions:
            cand |= sl.get((norm(r.get('display_name', '')), pos), set())
        cand -= assigned
        if len(cand) == 1:
            sid = next(iter(cand))
            r['sleeper_id'] = sid
            assigned.add(sid)
            n += 1
    return n


def main():
    spine = build_spine()
    print(f'Spine: {len(spine)} players from nflverse rosters')

    by_normpos, by_norm = build_indexes(spine)

    # Load the PREVIOUS crosswalk (if any) so we can detect rookie
    # key-promotions: players who were minted as synthetic COL records
    # in a prior build (no NFL gsis_id yet) and now resolve to a spine
    # gsis_id this run. Downstream consumers that cached the old COL
    # hash need a back-reference so their lookups don't go cold.
    prev_col_records: list[dict[str, Any]] = []
    prev_alias_keys: dict[str, list[str]] = {}
    if CROSSWALK_OUT.exists():
        try:
            prev_doc = json.loads(CROSSWALK_OUT.read_text())
            prev_players = prev_doc.get('players') or []
            prev_col_records = [p for p in prev_players if p.get('is_college_only')]
            # Preserve previously-stamped promotion back-references. alias_keys
            # is rebuilt from scratch each run, and a promoted COL drops out of
            # prev_col_records after its first promoted build, so without this
            # carry-forward the back-reference would evaporate on the very next
            # rebuild (now daily via fetch-sleeper-players.yml) and cached old
            # COL keys would go cold again. Keyed by the stable player_key
            # (hash of NFL:<gsis>).
            for p in prev_players:
                aks = p.get('alias_keys')
                if aks and p.get('player_key'):
                    prev_alias_keys[p['player_key']] = list(aks)
            print(f'Loaded {len(prev_col_records)} COL records from previous crosswalk')
        except Exception as e:
            print(f'  warning: could not load previous crosswalk: {e}')

    # Every spine player gets a canonical key. We keep the multi-value
    # `all_positions` and `all_names` on the record for downstream
    # consumers that want them; SQL users can always CROSS JOIN unnest.
    canonical: dict[str, dict[str, Any]] = {}
    for rec in spine:
        key = hash_key(f'NFL:{rec["gsis_id"]}')
        cw = {
            'player_key': key,
            'display_name': rec['display_name'],
            'position': rec['position'],
            'all_positions': rec.get('all_positions', []),
            'all_names': rec.get('all_names', []),
            'birth_date': rec.get('birth_date', ''),
            'college': rec.get('college', ''),
            'earliest_season': rec.get('earliest_season'),
            'latest_season': rec.get('latest_season'),
        }
        for col in SPINE_ID_COLUMNS:
            if rec.get(col):
                cw[col] = rec[col]
        cw['aliases'] = []
        canonical[rec['gsis_id']] = cw

    # Load manual aliases (if any); gets applied first, wins over auto-match.
    manual: dict[tuple[str, str, str, int | None], str] = {}
    if ALIASES_OUT.exists():
        try:
            raw = json.loads(ALIASES_OUT.read_text())
            for o in raw.get('overrides') or []:
                key = (o.get('source', ''), norm(o.get('name', '')),
                       o.get('position', ''), o.get('year'))
                if o.get('gsis_id'):
                    manual[key] = o['gsis_id']
        except Exception as e:
            print(f'  warning: could not parse {ALIASES_OUT}: {e}')

    # Aliases we couldn't auto-resolve, to seed the manual file for editing.
    unresolved: list[dict] = []

    # Unified college-only / off-roster synthetic minting.
    # Any source row that can't resolve to the NFL spine ends up here
    # keyed on (norm_name, position) — NO year — so the same player
    # across sources/years collapses to a single key (Clyde Gates across
    # backtest 2011 + adp 2011-13, Cade Klubnik future-years in KTC,
    # Jeremiyah Love across career_2026 + KTC).
    col_by_normpos: dict[tuple[str, str], str] = {}  # (norm, pos) → col_id

    def mint_col(name: str, pos: str, source: str, year: int | None,
                 draft_class: int | None = None,
                 ktc_id: int | None = None) -> str:
        key_nkey = (norm(name), pos)
        if key_nkey in col_by_normpos:
            col_id = col_by_normpos[key_nkey]
        else:
            col_id = f'COL:{norm(name)}:{pos}'
            col_by_normpos[key_nkey] = col_id
        if col_id not in canonical:
            rec: dict[str, Any] = {
                'player_key': hash_key(col_id),
                'display_name': name,
                'position': pos,
                'is_college_only': True,
                'aliases': [],
            }
            if draft_class:
                rec['draft_class'] = draft_class
            canonical[col_id] = rec
        rec = canonical[col_id]
        rec['aliases'].append({'source': source, 'name': name,
                               'position': pos, 'year': year, 'via': 'synthetic'})
        if ktc_id and 'ktc_id' not in rec:
            rec['ktc_id'] = ktc_id
        if draft_class and not rec.get('draft_class'):
            rec['draft_class'] = draft_class
        return rec['player_key']

    def resolve(source: str, name: str, position: str | None, year: int | None,
                ktc_id: int | None = None) -> str | None:
        """Return a canonical player_key for this source row, or None if
        unresolved. Records an alias entry on the canonical record for
        traceability, and logs unresolved/ambiguous cases to `unresolved`."""
        mkey = (source, norm(name), position or '', year)
        if mkey in manual:
            gid = manual[mkey]
            rec = canonical.get(gid)
            if rec:
                rec['aliases'].append({'source': source, 'name': name,
                                       'position': position, 'year': year,
                                       'via': 'manual'})
                if ktc_id and 'ktc_id' not in rec:
                    rec['ktc_id'] = ktc_id
                return rec['player_key']

        outcome, cands = match_one(name, position, year, by_normpos, by_norm)
        if outcome in ('clean', 'era', 'latest', 'exact_name', 'pos_free') and len(cands) == 1:
            gid = cands[0]['gsis_id']
            rec = canonical[gid]
            rec['aliases'].append({'source': source, 'name': name,
                                   'position': position, 'year': year,
                                   'via': outcome})
            if ktc_id and 'ktc_id' not in rec:
                rec['ktc_id'] = ktc_id
            return rec['player_key']

        # Ambiguous spine matches stay in unresolved — hand-resolve these
        # in player-aliases.json. No-match rows get a synthetic COL key
        # minted lazily (so Clyde Gates / Beanie-era ghosts / pre-draft
        # 2027 prospects all collapse into a single canonical record).
        if outcome == 'ambiguous':
            unresolved.append({
                'source': source, 'name': name, 'position': position,
                'year': year, 'outcome': outcome,
                'candidates': [
                    {'gsis_id': c['gsis_id'], 'display_name': c['display_name'],
                     'birth_date': c.get('birth_date', ''), 'college': c.get('college', ''),
                     'latest_season': c.get('latest_season')}
                    for c in cands[:5]
                ],
                **({'ktc_id': ktc_id} if ktc_id else {}),
            })
            return None
        if position:
            return mint_col(name, position, source, year)
        return None

    # ── Match each external source ──

    # KTC processed last — after career_2026 mints COL synthetic keys
    # so KTC rookies can fall back to those. Just collect rows here.
    ktc_rows: list[dict] = []
    ktc_path = ROOT / 'public/data/ktc_rankings_1qb.json'
    if ktc_path.exists():
        for p in json.loads(ktc_path.read_text()):
            if p.get('position') == 'RDP':
                continue
            ktc_rows.append(p)

    # Backtest — position + draftSeason
    cache_path = ROOT / 'public/data/model-cache-career-v72.json'
    if cache_path.exists():
        cache = json.loads(cache_path.read_text())
        for pos, m in (cache.get('rookieCareerModels') or {}).items():
            for r in m.get('backtestRows') or []:
                resolve('stathead_backtest', r.get('name', ''),
                        r.get('position') or pos, r.get('draftSeason'))

    # adp_historical (profile.json × players.json)
    profile_path = ROOT / 'public/data/feature-store/profile.json'
    players_path = ROOT / 'public/data/feature-store/players.json'
    if profile_path.exists() and players_path.exists():
        profile = json.loads(profile_path.read_text())
        players = json.loads(players_path.read_text())
        for key in profile:
            info = players.get(key) or {}
            name = info.get('displayName') or key.rsplit('::', 1)[0]
            pos = info.get('position') or ''
            year = None
            try:
                year = int(key.rsplit('::', 1)[-1])
            except ValueError:
                pass
            if pos:
                resolve('stathead_adp', name, pos, year)

    # career_2026 — pre-draft rookies, 2026 draft class
    fm_path = ROOT / 'public/data/feature-matrix.json'
    if fm_path.exists():
        fm = json.loads(fm_path.read_text())
        for p in fm.get('careerPredictions2026') or []:
            name = p.get('name', '')
            pos = p.get('position', '')
            if not name or not pos:
                continue
            key = resolve('stathead_career_2026', name, pos, 2026)
            if key is None:
                mint_col(name, pos, 'stathead_career_2026', 2026, draft_class=2026)

    # KTC — run now so it can fall back to COL synthetic keys for 2026
    # prospects that aren't on an NFL roster yet. Also use KTC's isRookie
    # flag to break spine ambiguities (Kyle Williams old vs young, etc.).
    for p in ktc_rows:
        name = p.get('playerName', '')
        pos = p.get('position')
        is_rookie = bool(p.get('isRookie'))
        outcome, cands = match_one(name, pos, None, by_normpos, by_norm)
        pick = None
        via = outcome
        if outcome in ('clean', 'era', 'latest', 'exact_name', 'pos_free') and len(cands) == 1:
            pick = cands[0]
        elif outcome == 'ambiguous':
            # isRookie = youngest candidate; veteran = oldest.
            if is_rookie:
                pick = max(cands, key=lambda c: c.get('earliest_season', 0))
                via = 'isRookie'
            else:
                pick = min(cands, key=lambda c: c.get('earliest_season', 99999))
                via = 'ktc_veteran'
        if pick:
            rec = canonical[pick['gsis_id']]
            rec['aliases'].append({'source': 'ktc', 'name': name,
                                   'position': pos, 'year': None, 'via': via})
            rec.setdefault('ktc_id', p.get('playerID'))
            continue
        # Fallback: match to existing COL synthetic (e.g. a 2026 rookie
        # also listed in KTC). Try every name variant.
        col_id = col_by_normpos.get((norm(name), pos))
        if not col_id:
            for v in name_variants(name):
                if (v, pos) in col_by_normpos:
                    col_id = col_by_normpos[(v, pos)]
                    break
        if col_id:
            rec = canonical[col_id]
            rec['aliases'].append({'source': 'ktc', 'name': name,
                                   'position': pos, 'year': None, 'via': 'col_fallback'})
            rec.setdefault('ktc_id', p.get('playerID'))
            continue
        # No spine, no COL match — mint a new college/off-roster synthetic
        # (future prospects like Cade Klubnik, NFL-but-not-in-rosters like
        # Clyde Gates / Owen Marecic if we missed them upstream).
        mint_col(name, pos, 'ktc', None, ktc_id=p.get('playerID'))

    # ── Rookie key-promotion ──
    # For every COL record that existed in the PREVIOUS build but does
    # NOT exist in this build (i.e., the rookie got promoted to the NFL
    # spine), find the new canonical record that absorbed them and
    # stamp the old COL player_key as an `alias_keys` back-reference.
    # Fail-closed on ambiguity: if 0 or 2+ new-canonical candidates
    # match (norm_name, position), skip + log to unresolved_promotions.
    promotions_log: list[dict[str, Any]] = []
    unresolved_promotions: list[dict[str, Any]] = []

    if prev_col_records:
        # Build lookup for the current build's COL identities.
        new_col_ids: set[str] = {
            f'COL:{norm(p["display_name"])}:{p["position"]}'
            for p in canonical.values() if p.get('is_college_only')
        }
        # Build lookup of NFL-spine records by (norm_name, position), covering
        # EVERY name + position the player has held (same coverage as
        # build_indexes above), so renames / position switches still resolve.
        new_nfl_by_normpos: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for rec in canonical.values():
            if rec.get('is_college_only'):
                continue
            names = set(rec.get('all_names') or [])
            names.add(rec.get('display_name', ''))
            positions = set(rec.get('all_positions') or [])
            positions.add(rec.get('position', ''))
            for nm in names:
                n = norm(nm)
                if not n:
                    continue
                for p in positions:
                    bucket = new_nfl_by_normpos[(n, p)]
                    if rec not in bucket:
                        bucket.append(rec)

        for old in prev_col_records:
            old_name = old.get('display_name', '')
            old_pos = old.get('position', '')
            old_key = old.get('player_key')
            col_id = f'COL:{norm(old_name)}:{old_pos}'
            # Still a COL in the new build → nothing to promote.
            if col_id in new_col_ids:
                continue
            # COL identity is gone. Try to find the new NFL canonical.
            cands = new_nfl_by_normpos.get((norm(old_name), old_pos), [])
            if len(cands) == 1:
                new_rec = cands[0]
                new_rec.setdefault('alias_keys', [])
                if old_key and old_key not in new_rec['alias_keys']:
                    new_rec['alias_keys'].append(old_key)
                promotions_log.append({
                    'old_player_key': old_key,
                    'new_player_key': new_rec.get('player_key'),
                    'name': old_name,
                    'position': old_pos,
                    'gsis_id': new_rec.get('gsis_id'),
                    'college': new_rec.get('college', ''),
                    'earliest_season': new_rec.get('earliest_season'),
                })
            elif len(cands) == 0:
                # COL gone, no NFL match — the source (career_2026 / KTC)
                # likely dropped or renamed this player between builds.
                # No promotion to write, but worth surfacing.
                unresolved_promotions.append({
                    'old_player_key': old_key,
                    'name': old_name,
                    'position': old_pos,
                    'reason': 'col_gone_no_spine_match',
                    'candidates': [],
                })
            else:
                # 2+ NFL candidates share (name, position). Fail-closed —
                # user must hand-resolve which to promote to.
                unresolved_promotions.append({
                    'old_player_key': old_key,
                    'name': old_name,
                    'position': old_pos,
                    'reason': 'ambiguous_spine_match',
                    'candidates': [
                        {'player_key': c.get('player_key'),
                         'gsis_id': c.get('gsis_id'),
                         'display_name': c.get('display_name'),
                         'college': c.get('college', ''),
                         'earliest_season': c.get('earliest_season'),
                         'latest_season': c.get('latest_season')}
                        for c in cands[:5]
                    ],
                })

    # Carry forward promotion back-references stamped in earlier builds so they
    # accumulate permanently across rebuilds, rather than surviving only the one
    # build in which the COL→spine transition was diffed (see prev_alias_keys).
    carried = 0
    if prev_alias_keys:
        for rec in canonical.values():
            prev_aks = prev_alias_keys.get(rec.get('player_key'))
            if not prev_aks:
                continue
            existing = rec.setdefault('alias_keys', [])
            for ak in prev_aks:
                if ak not in existing:
                    existing.append(ak)
                    carried += 1
        if carried:
            print(f'Carried forward {carried} promotion back-reference(s) from previous crosswalk')

    # ── Emit crosswalk ──
    records = list(canonical.values())
    n_bf = backfill_sleeper_ids_from_fc(records)
    if n_bf:
        print(f'Backfilled sleeper_id on {n_bf} records from FantasyCalc snapshot')
    n_sl = backfill_sleeper_ids_from_sleeper(records)
    if n_sl:
        print(f'Backfilled sleeper_id on {n_sl} more records from Sleeper players list')
    out = {'version': 1, 'generated_at': None, 'total': len(records),
           'players': records}
    CROSSWALK_OUT.write_text(json.dumps(out, separators=(',', ':')))
    print(f'Wrote {CROSSWALK_OUT} — {len(records)} players '
          f'({sum(1 for r in records if r.get("is_college_only")) } college-only)')

    # ── Emit promotions log ──
    promotions_doc = {
        '_about': (
            'Rookie key-promotion log. When a player who was previously '
            'minted as a synthetic COL record (no NFL gsis_id) gets placed '
            'on an nflverse roster, build-player-crosswalk.py rebinds them '
            'to an NFL-spine canonical record and back-references the old '
            'COL player_key via the `alias_keys` field on the new record. '
            'Entries under `unresolved` are fail-closed: either the COL '
            'vanished with no spine match (reason=col_gone_no_spine_match) '
            'or multiple spine candidates collide on (name, position) — '
            'hand-resolve these by adding a matching entry to '
            'player-aliases.json overrides and rerunning.'
        ),
        'version': 1,
        'promotions': promotions_log,
        'unresolved': unresolved_promotions,
    }
    PROMOTIONS_OUT.write_text(json.dumps(promotions_doc, separators=(',', ':'), indent=2))
    print(f'Wrote {PROMOTIONS_OUT} — {len(promotions_log)} promotions, '
          f'{len(unresolved_promotions)} unresolved')

    # ── Emit unresolved seed for the manual aliases file ──
    # Only write if the file doesn't already exist OR is empty; don't
    # trample user edits.
    existing_overrides = []
    existing_raw = {}
    if ALIASES_OUT.exists():
        try:
            existing_raw = json.loads(ALIASES_OUT.read_text())
            existing_overrides = existing_raw.get('overrides') or []
        except Exception:
            pass

    aliases_doc = {
        '_about': (
            'Manual player-key overrides. The auto-matcher in '
            'build-player-crosswalk.py couldn\'t cleanly resolve the rows '
            'listed under `unresolved` below — edit them (fill in '
            '`gsis_id`) and move them into `overrides`. Rerun the script '
            'to pick them up.'
        ),
        'version': 1,
        'overrides': existing_overrides,
        'unresolved': unresolved,
    }
    ALIASES_OUT.write_text(json.dumps(aliases_doc, separators=(',', ':'), indent=2))
    print(f'Wrote {ALIASES_OUT} — {len(unresolved)} unresolved / ambiguous cases '
          f'({len(existing_overrides)} already resolved)')

    # ── Summary ──
    print()
    print('Resolution outcomes by source:')
    by_source: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for rec in records:
        for a in rec.get('aliases') or []:
            by_source[a['source']][a.get('via', '?')] += 1
    for u in unresolved:
        by_source[u['source']][u['outcome']] += 1
    for src, counts in sorted(by_source.items()):
        total = sum(counts.values())
        parts = ' · '.join(f'{k}={v}' for k, v in sorted(counts.items()))
        print(f'  {src:<26} {total:>5}  {parts}')


if __name__ == '__main__':
    main()
