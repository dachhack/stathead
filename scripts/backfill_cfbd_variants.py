#!/usr/bin/env python3
"""Backfill CFBD features on the training-rows cache using name-variant
lookups. Rescues historical rows where the prospect name differs from the
CFBD source spelling (Mitchell Trubisky → `mitchtrubisky`, Pat Freiermuth
→ `patfreiermuth`, Josh Jacobs → `joshjacobs`, etc.) — the same structural
fix we shipped for 2026 prospects in precompute-features.ts.

Mirrors the TS nameVariants() function in src/lib/featureTypes.ts so
backfill-time coverage matches 2026 scoring-time coverage exactly.

Usage:  python3 scripts/backfill_cfbd_variants.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
CACHE_PATH = ROOT / 'public/data/training-rows-cache-v49.json'
CFBD_USAGE = ROOT / 'public/data/cfbd-player-usage.json'
CFBD_TALENT = ROOT / 'public/data/cfbd-team-talent.json'
CFBD_RECRUITS = ROOT / 'public/data/cfbd-recruiting.json'
CFBD_STATS = ROOT / 'public/data/cfbd-college-stats.json'
MANUAL_OVERRIDES = ROOT / 'public/data/manual-cfbd-overrides.json'

# Must stay in lock-step with src/lib/featureTypes.ts::EXTENDED_FIRST_NAME_ALIASES
FIRST_NAME_ALIASES = {
    'cam': 'cameron', 'mitch': 'mitchell', 'josh': 'joshua', 'pat': 'patrick',
    'dan': 'daniel', 'jeff': 'jeffrey', 'chig': 'chigoziem',
    'nick': 'nicholas', 'mike': 'michael', 'reggie': 'reginald',
    'jam': 'jamarion', 'chris': 'christopher', 'tony': 'anthony',
    'tom': 'thomas', 'matt': 'matthew', 'alex': 'alexander',
    'jon': 'jonathan', 'kc': 'kevin', 'dj': 'donovan',
    'tank': 'nathaniel',
}
ALIAS_REVERSE: dict[str, list[str]] = {}
for short, long_ in FIRST_NAME_ALIASES.items():
    ALIAS_REVERSE.setdefault(long_, []).append(short)

SUFFIX_TOKENS = {'jr', 'sr', 'ii', 'iii', 'iv', 'v'}


def name_variants(name: str) -> list[str]:
    """Port of src/lib/featureTypes.ts::nameVariants."""
    if not name:
        return []
    cleaned = name.lower()
    for c in ".,'`":
        cleaned = cleaned.replace(c, '')
    cleaned = cleaned.replace('-', ' ')
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    if not cleaned:
        return []
    stripped = re.sub(r'\s+(jr|sr|ii|iii|iv|v)\.?$', '', cleaned).strip()
    # CFBD sometimes keeps the suffix in the key (michaelpenixjr, tyronetracyjr,
    # chrisbrazzellii). If the source name didn't include one, still try the
    # common suffixed forms so the merge covers sources that store them.
    base_set: set[str] = {stripped}
    if stripped != cleaned:
        base_set.add(cleaned)
    if not re.search(r'\s+(jr|sr|ii|iii|iv|v)\.?$', cleaned):
        base_set.add(f'{stripped} jr')
        base_set.add(f'{stripped} ii')
        base_set.add(f'{stripped} iii')
    bases = list(base_set)
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


def cfbd_key(s: str) -> str:
    return ''.join(c for c in s if c.isalnum())


def lookup_variant(table: dict, raw_name: str, make_key) -> dict | None:
    for v in name_variants(raw_name):
        entry = table.get(make_key(cfbd_key(v)))
        if entry is not None:
            return entry
    return None


def main() -> None:
    cache = json.loads(CACHE_PATH.read_text())
    rows = cache['rows']
    cfbd_usage = json.loads(CFBD_USAGE.read_text())
    cfbd_talent = json.loads(CFBD_TALENT.read_text())
    cfbd_recruits = json.loads(CFBD_RECRUITS.read_text())

    # Manual overrides for players missing from CFBD's player-usage file.
    # Each entry: { "Player Name|POS": { school, seasons: { yr: {carries,
    # team_carries, receptions, team_receptions, [targets, team_pass_att]}}}}.
    # Backfill computes usage = touches/total_team_plays where total_team_plays
    # = team_carries + (team_pass_att or team_receptions/0.62).
    manual: dict = {}
    if MANUAL_OVERRIDES.exists():
        raw_overrides = json.loads(MANUAL_OVERRIDES.read_text())
        manual = {k: v for k, v in raw_overrides.items() if not k.startswith('_')}

    # Build (normalized-name → [school, max_season]) from college stats so we
    # can recover school+season for players missing from CFBD's player-usage
    # file (Odell Beckham at LSU 2013 isn't in usage but is in stats).
    stats_rows = json.loads(CFBD_STATS.read_text())
    stats_school_by_name: dict[str, tuple[str, int]] = {}
    for s in stats_rows:
        nm = (s.get('player_name') or '').strip()
        if not nm:
            continue
        school = (s.get('school') or '').lower()
        season = s.get('season')
        if not school or not season:
            continue
        for v in name_variants(nm):
            existing = stats_school_by_name.get(v)
            if existing is None or int(season) > existing[1]:
                stats_school_by_name[v] = (school, int(season))

    # Build per-team earliest-year talent for back-fill. 247 team-talent data
    # starts in 2015; pre-2015 rows (Odell Beckham at LSU 2013, etc.) all lose
    # the signal. For long-stable programs, using the earliest available year
    # is a much better proxy than zero. Only applied when no exact-year match.
    team_earliest_talent: dict[str, float] = {}
    for k, v in cfbd_talent.items():
        if ':' not in k or not isinstance(v, (int, float)):
            continue
        team, yr = k.rsplit(':', 1)
        try:
            yi = int(yr)
        except ValueError:
            continue
        existing = team_earliest_talent.get(team)
        if existing is None or yi < existing[0]:  # type: ignore[misc]
            team_earliest_talent[team] = (yi, float(v))  # type: ignore[assignment]
    team_earliest: dict[str, float] = {t: v for t, (_, v) in team_earliest_talent.items()}  # type: ignore[misc]

    filled = {'usage': 0, 'pass': 0, 'rush': 0, 'talent': 0, 'stars': 0, 'rating': 0}

    for r in rows:
        f = r.setdefault('features', {})
        name = r.get('name') or ''
        pos = r.get('position') or ''
        if not name or pos not in ('QB', 'RB', 'WR', 'TE'):
            continue

        # Recruit — single table, no season anchor
        if not f.get('recruitRating'):
            rec = lookup_variant(cfbd_recruits, name, lambda k: k)
            if isinstance(rec, dict):
                if rec.get('composite_rating') and not f.get('recruitRating'):
                    f['recruitRating'] = rec['composite_rating']
                    filled['rating'] += 1
                if rec.get('stars') and not f.get('recruitStars'):
                    f['recruitStars'] = rec['stars']
                    filled['stars'] += 1

        # Usage + team talent require (name, season, school).
        # Derive season = draftSeason - 1 (their final college year) and try
        # (-2, -3) as fallback for players who declared early or redshirted.
        draft_season = r.get('draftSeason') or r.get('season')
        if not draft_season:
            continue
        candidate_seasons = [draft_season - 1, draft_season, draft_season - 2, draft_season - 3]
        # Find first season that produces a usage hit under any variant
        best_season: int | None = None
        best_team: str | None = None
        for season in candidate_seasons:
            u = lookup_variant(cfbd_usage, name, lambda k, s=season: f'{k}:{s}')
            if isinstance(u, dict):
                best_season = season
                best_team = (u.get('team') or '').lower()
                if not f.get('collegeUsageOverall') and u.get('overall') is not None:
                    f['collegeUsageOverall'] = u['overall']
                    filled['usage'] += 1
                if not f.get('collegeUsagePass') and u.get('pass') is not None:
                    f['collegeUsagePass'] = u['pass']
                    filled['pass'] += 1
                if not f.get('collegeUsageRush') and u.get('rush') is not None:
                    f['collegeUsageRush'] = u['rush']
                    filled['rush'] += 1
                break
        # Manual override — for players genuinely missing from CFBD's player
        # usage file (Duke Johnson, Todd Gurley, Will Fuller, Nick Chubb, Sony
        # Michel, Curtis Samuel, John Brown, Tutu Atwell, Christian Watson,
        # Odell Beckham). Stats sourced manually and stored in
        # public/data/manual-cfbd-overrides.json. Computes usage =
        # touches/total_team_plays, where total_team_plays = team_carries +
        # (team_pass_att or team_receptions/0.62 if pass_att unknown).
        ov = manual.get(f'{name}|{pos}')
        if ov:
            seasons = ov.get('seasons') or {}
            # Pick the latest (final) college season available — that's the
            # one CFBD usage would normally capture and is most representative
            # of the player's mature production. Training rows don't have
            # draftSeason populated, so we can't match by draft - 1.
            chosen_yr: int | None = None
            chosen_data: dict | None = None
            if seasons:
                yr_str = max(seasons.keys(), key=lambda k: int(k))
                chosen_yr = int(yr_str)
                chosen_data = seasons[yr_str]
            if chosen_data:
                tc = float(chosen_data.get('team_carries') or 0)
                tr = float(chosen_data.get('team_receptions') or 0)
                tpa = float(chosen_data.get('team_pass_att') or (tr / 0.62 if tr else 0))
                total_plays = tc + tpa
                if total_plays > 0:
                    car = float(chosen_data.get('carries') or 0)
                    rec = float(chosen_data.get('receptions') or 0)
                    targets = float(chosen_data.get('targets') or rec)
                    if not f.get('collegeUsageRush'):
                        f['collegeUsageRush'] = round(car / total_plays, 4)
                        filled['rush_manual'] = filled.get('rush_manual', 0) + 1
                    if not f.get('collegeUsagePass'):
                        f['collegeUsagePass'] = round(targets / total_plays, 4)
                        filled['pass_manual'] = filled.get('pass_manual', 0) + 1
                    if not f.get('collegeUsageOverall'):
                        f['collegeUsageOverall'] = round((car + rec) / total_plays, 4)
                        filled['usage_manual'] = filled.get('usage_manual', 0) + 1
                if best_season is None:
                    best_season = chosen_yr
                    best_team = (ov.get('school') or '').lower()

        # If CFBD usage didn't have them and no manual override hit, fall back
        # to college-stats for a school+season anchor for team-talent look-up
        # (Odell Beckham at LSU 2013 path).
        if best_season is None:
            for v in name_variants(name):
                hit = stats_school_by_name.get(v)
                if hit:
                    best_team, best_season = hit[0], hit[1]
                    break
        if best_season and best_team and not f.get('collegeTeamTalent'):
            talent = cfbd_talent.get(f'{best_team}:{best_season}')
            if talent:
                f['collegeTeamTalent'] = talent
                filled['talent'] += 1
            else:
                # Fall back to earliest-year value for the team — 247 talent
                # data starts in 2015, so Odell Beckham at LSU 2013 would
                # otherwise stay zero. Long-stable blueblood programs are
                # reasonably approximated by the earliest available year.
                proxy = team_earliest.get(best_team)
                if proxy:
                    f['collegeTeamTalent'] = proxy
                    filled['talent_proxy'] = filled.get('talent_proxy', 0) + 1

    CACHE_PATH.write_text(json.dumps(cache, separators=(',', ':')))
    print(f'Backfilled training-rows-cache-v49.json:')
    print(f'  CFBD: usage={filled["usage"]}  pass={filled["pass"]}  rush={filled["rush"]}')
    print(f'  manual: usage={filled.get("usage_manual",0)}  pass={filled.get("pass_manual",0)}  rush={filled.get("rush_manual",0)}')
    print(f'  teamTalent={filled["talent"]}  teamTalent_proxy={filled.get("talent_proxy", 0)}')
    print(f'  recruitStars={filled["stars"]}  recruitRating={filled["rating"]}')


if __name__ == '__main__':
    main()
