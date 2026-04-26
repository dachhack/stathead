"""
Re-augment teamSamePosCount on the cached training rows using the
relaxed roster-status filter (ACT + UFA + RFA + RES + PUP).

Original filter was ACT-only, which during off-season builds left many
players with the missing-data sentinel (0). Both LOSO and the per-team
inspection (Lamar Jackson on BAL with two UFA backups) show the
relaxed filter is a clear win across QB/RB while WR/TE stay flat.

Mutates the cache file in place. Re-run after this is the standard
training pipeline (python3 scripts/train_projection_models.py --only ppg).
"""
import json, gzip, csv, sys
from pathlib import Path

CACHE_PATH = Path('public/data/training-rows-cache-v49.json')
ALLOWED = {'ACT', 'UFA', 'RFA', 'RES', 'PUP'}


def normname(n):
    s = (n or '').lower().replace('.', '').replace("'", '')
    for suf in [' jr', ' sr', ' ii', ' iii', ' iv', ' v']:
        if s.endswith(suf):
            s = s[:-len(suf)]
    return ' '.join(s.split())


def load_roster(season):
    path = Path('public/data') / f'roster_{season}.csv.gz'
    if not path.exists():
        return {}
    out = {}
    with gzip.open(path, 'rt') as f:
        for r in csv.DictReader(f):
            if r['position'] not in ('QB', 'RB', 'WR', 'TE'):
                continue
            if r['status'] not in ALLOWED:
                continue
            out.setdefault((r['team'], r['position']), set()).add(normname(r['full_name']))
    return out


def main():
    print(f'Loading {CACHE_PATH}…')
    with open(CACHE_PATH) as f:
        cache = json.load(f)
    rows = cache['rows']
    print(f'  {len(rows)} rows')

    # Cache rosters by season
    by_season = {}
    seasons = sorted({r['season'] for r in rows})
    for s in seasons:
        by_season[s] = load_roster(s)
        if not by_season[s]:
            print(f'  warn: no roster for season {s}')

    # Track changes
    changed = 0
    samples = []
    for r in rows:
        rosters = by_season.get(r['season'], {})
        if not rosters:
            continue
        nm = normname(r.get('name', ''))
        # Find the player on a roster for that season
        for (t, p), names in rosters.items():
            if p == r['position'] and nm in names:
                teammates = rosters.get((t, r['position']), set())
                new_count = len(teammates) - (1 if nm in teammates else 0)
                old_count = r['features'].get('teamSamePosCount', 0)
                if old_count != new_count:
                    changed += 1
                    if len(samples) < 6 and r['season'] >= 2023:
                        samples.append((r['name'], r['season'], r['position'], old_count, new_count))
                r['features']['teamSamePosCount'] = new_count
                break

    print(f'\n  Changed {changed} rows ({100*changed/len(rows):.1f}% of cache).')
    if samples:
        print(f'  Recent-year samples (old → new):')
        for nm, s, p, o, n in samples:
            print(f'    {nm} ({p}, {s}): {o} → {n}')

    # Sanity: distribution before vs after
    print('\nNew teamSamePosCount distribution:')
    from collections import Counter
    c = Counter(int(r['features'].get('teamSamePosCount', 0)) for r in rows)
    for k in sorted(c.keys()):
        print(f'  {k}: {c[k]}')

    print(f'\nWriting cache back…')
    with open(CACHE_PATH, 'w') as f:
        json.dump(cache, f)
    size_mb = CACHE_PATH.stat().st_size / 1024 / 1024
    print(f'  Wrote {CACHE_PATH} ({size_mb:.1f} MB)')


if __name__ == '__main__':
    main()
