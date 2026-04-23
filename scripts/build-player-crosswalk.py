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
ROSTER_GLOB = str(ROOT / 'public/data/roster_*.csv.gz')
CROSSWALK_OUT = ROOT / 'public/data/player-crosswalk.json'
ALIASES_OUT = ROOT / 'public/data/player-aliases.json'

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


def build_spine() -> list[dict[str, Any]]:
    """Scan every roster_*.csv.gz and aggregate into one record per gsis_id.
    Keep the latest-season values for mutable fields (team, position) but
    preserve the earliest birth_date + college (those don't change)."""
    by_gid: dict[str, dict[str, Any]] = {}
    for path in sorted(glob.glob(ROSTER_GLOB)):
        with gzip.open(path, 'rt') as f:
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
                    # Merge: keep latest mutable, earliest nonempty for IDs/DOB
                    rec['earliest_season'] = min(existing['earliest_season'], season)
                    if existing['latest_season'] > season:
                        # Preserve latest-season mutable fields
                        rec['display_name'] = existing['display_name']
                        rec['position'] = existing['position']
                        rec['latest_season'] = existing['latest_season']
                    for col in SPINE_ID_COLUMNS + ['birth_date', 'college']:
                        if not rec.get(col) and existing.get(col):
                            rec[col] = existing[col]
                by_gid[gid] = rec
    return list(by_gid.values())


# ── Matching ──

def build_indexes(spine: list[dict[str, Any]]):
    """(norm_name, position) → [spine rows]. Position-agnostic fallback too."""
    by_normpos: dict[tuple[str, str], list[dict]] = defaultdict(list)
    by_norm: dict[str, list[dict]] = defaultdict(list)
    for rec in spine:
        n = norm(rec['display_name'])
        by_normpos[(n, rec['position'])].append(rec)
        by_norm[n].append(rec)
    return by_normpos, by_norm


def match_one(
    name: str,
    position: str | None,
    year: int | None,
    by_normpos: dict,
    by_norm: dict,
) -> tuple[str, list[dict]]:
    """Returns (outcome, candidates) where outcome is:
    'clean' — single candidate
    'era'   — single candidate after era filter
    'latest'— single after max-latest-season tiebreak
    'ambiguous' — multiple after all filters
    'none'  — no candidates
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
    if not cands:
        return ('none', [])
    if len(cands) == 1:
        return ('clean', cands)

    if year:
        era = [c for c in cands if c.get('latest_season', 0) >= year - 1]
        if len(era) == 1:
            return ('era', era)
        if len(era) > 1:
            cands = era

    # Last-resort tiebreak: prefer the one whose career is nearest the
    # source year (post-date if possible)
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

def main():
    spine = build_spine()
    print(f'Spine: {len(spine)} players from nflverse rosters')

    by_normpos, by_norm = build_indexes(spine)

    # Every spine player gets a canonical key.
    canonical: dict[str, dict[str, Any]] = {}  # gsis_id → crosswalk record
    for rec in spine:
        key = hash_key(f'NFL:{rec["gsis_id"]}')
        cw = {
            'player_key': key,
            'display_name': rec['display_name'],
            'position': rec['position'],
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
        if outcome in ('clean', 'era', 'latest') and len(cands) == 1:
            gid = cands[0]['gsis_id']
            rec = canonical[gid]
            rec['aliases'].append({'source': source, 'name': name,
                                   'position': position, 'year': year,
                                   'via': outcome})
            if ktc_id and 'ktc_id' not in rec:
                rec['ktc_id'] = ktc_id
            return rec['player_key']

        # Unresolved / ambiguous — collect for the aliases file
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

    # ── Match each external source ──

    # KTC — has position, no year
    ktc_path = ROOT / 'public/data/ktc_rankings_1qb.json'
    if ktc_path.exists():
        ktc = json.loads(ktc_path.read_text())
        for p in ktc:
            if p.get('position') == 'RDP':  # draft pick meta-entry, skip
                continue
            resolve('ktc', p.get('playerName', ''), p.get('position'),
                    None, ktc_id=p.get('playerID'))

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

    # career_2026 — pre-draft rookies, almost all unmatched (expected)
    fm_path = ROOT / 'public/data/feature-matrix.json'
    if fm_path.exists():
        fm = json.loads(fm_path.read_text())
        preds = fm.get('careerPredictions2026') or []
        for p in preds:
            name = p.get('name', '')
            pos = p.get('position', '')
            # Check if they landed on a roster yet — unlikely pre-draft
            key = resolve('stathead_career_2026', name, pos, 2026)
            if key is None and name and pos:
                # Mint a college-only canonical key
                col_id = f'COL:{norm(name)}:{pos}:2026'
                col_key = hash_key(col_id)
                # Use col_id as the pseudo-gsis slot so canonical dict is keyed
                if col_id not in canonical:
                    canonical[col_id] = {
                        'player_key': col_key,
                        'display_name': name,
                        'position': pos,
                        'draft_class': 2026,
                        'is_college_only': True,
                        'aliases': [{'source': 'stathead_career_2026',
                                     'name': name, 'position': pos,
                                     'year': 2026, 'via': 'synthetic'}],
                    }

    # ── Emit crosswalk ──
    records = list(canonical.values())
    out = {'version': 1, 'generated_at': None, 'total': len(records),
           'players': records}
    CROSSWALK_OUT.write_text(json.dumps(out, separators=(',', ':')))
    print(f'Wrote {CROSSWALK_OUT} — {len(records)} players '
          f'({sum(1 for r in records if r.get("is_college_only")) } college-only)')

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
