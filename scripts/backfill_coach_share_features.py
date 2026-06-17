#!/usr/bin/env python3
"""Backfill scheme coach features onto the training-rows cache for the share model.

Adds four leakage-safe head-coach features to each row (computed from ONLY the
coach's seasons strictly before the row's season, so nothing from the row's own
season leaks):

  coachHistNeutralPass  coach's career neutral-script pass rate (0-1)
  coachHistTargetHHI    coach's career team target concentration (HHI)
  coachHistWR1Share     coach's career WR1 target share (0-1)
  newCoachFlag          1 if the team changed head coach that season

Source: public/data/coach-tendencies.json (built by build-coach-tendencies.mjs).
The same four features are computed for 2026 prediction rows in
precompute-features.ts, so training and scoring stay in sync.

Idempotent: re-running overwrites the four keys. Rows whose (player, season)
team/coach can't be resolved (e.g. pre-2016, before coach-tendencies coverage)
get 0s — LightGBM/Ridge treat that as "no coach signal".

Usage: python3 scripts/backfill_coach_share_features.py
"""
import json
from pathlib import Path

DATA = Path('public/data')
CACHE = DATA / 'training-rows-cache-v51.json'
KEYS = ['coachHistNeutralPass', 'coachHistTargetHHI', 'coachHistWR1Share', 'newCoachFlag']


def norm(s):
    return ''.join(c for c in str(s).lower() if c.isalnum())


def mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return sum(xs) / len(xs) if xs else 0.0


def main():
    coach = json.loads((DATA / 'coach-tendencies.json').read_text())
    reun = coach['reunionsByPlayer']
    coaches = coach['coaches']
    by_ts = coach['byTeamSeason']
    # (normname, season) -> {coach, team}
    player_season = {}
    for nm, entries in reun.items():
        for e in entries:
            player_season[(nm, e['season'])] = e

    def feats(name, season):
        cur = player_season.get((norm(name), season))
        if not cur:
            return {k: 0.0 for k in KEYS}
        co, team = cur['coach'], cur['team']
        cs = [s for s in coaches.get(co, {}).get('seasons', []) if s['season'] < season]
        prevc = by_ts.get(f'{season - 1}:{team}')
        return {
            'coachHistNeutralPass': mean([s.get('neutralPassRate') for s in cs]) / 100.0,
            'coachHistTargetHHI': mean([s.get('targetHHI') for s in cs]),
            'coachHistWR1Share': mean([s.get('wr1TargetShare') for s in cs]) / 100.0,
            'newCoachFlag': 1.0 if (prevc and prevc != co) else 0.0,
        }

    data = json.loads(CACHE.read_text())
    rows = data['rows']
    nonzero = 0
    for r in rows:
        f = feats(r['name'], r['season'])
        r.setdefault('features', {}).update(f)
        if any(v for v in f.values()):
            nonzero += 1
    CACHE.write_text(json.dumps(data, separators=(',', ':')))
    print(f'Patched {len(rows)} rows ({nonzero} with non-zero coach signal) → {CACHE.name}')


if __name__ == '__main__':
    main()
