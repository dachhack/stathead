#!/usr/bin/env python3
"""Devy rankings: two scores per college player, priced on the dynasty scale.

1. Devy value, the market's price: KTC's own devy value for the ~100 players it
   lists (public/data/ktc_rankings_devy.json, fetched daily); for everyone else,
   the devy value model (scripts/train_devy_value_model.py →
   devy-value-scores.json): P(KTC would list him) x the value KTC would put on a
   listed player with his profile (estimated age and draft age, breakout age,
   share of the offense, counting stats, program, competition level,
   recruiting). Same 0-9999 scale, superflex and 1QB.
2. Career score, our projection: scripts/train_devy_model.py →
   devy-model-scores.json, the expected mean of his best two NFL PPR PPG
   seasons in his first four, from his college profile (0 = never matters).

The board is ordered by devy value. careerVsValue = a player's position rank
by devy value minus his position rank by career score (positive: our NFL
projection likes him more than the market does).

Dynasty scale: within each draft class, a player's devy-value rank is his
expected rookie-draft slot (12 teams: 1-4 Early 1st, 5-8 Mid, 9-12 Late, ...),
priced from KTC's own future pick values for that year and format,
interpolated between tiers; the 1.01-1.02 extend the Early-to-Mid slope
(capped +25%). So a 2028 devy WR reads against NFL players and picks
(get_dynasty_values).

Output: public/data/devy-rankings.json. Stdlib only. Usage:
python3 scripts/build-devy-rankings.py [data_dir]
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from devy_names import norm_name  # noqa: E402

# The first draft class still in college: next year's until this year's NFL
# draft (late April) is done, then the one after.
_TODAY = datetime.now(timezone.utc)
FIRST_CLASS = _TODAY.year + (1 if _TODAY.month >= 5 else 0)
POSITIONS = ('QB', 'RB', 'WR', 'TE')
# Unlisted players shown: modelled SF or 1QB value at least this (KTC's own
# list bottoms out near 20; its 10th percentile is ~500).
MIN_MODELLED = 40
MAX_PLAYERS = 400
TIERS = ('Early', 'Mid', 'Late')
TIER_SLOT = {'Early': 2.5, 'Mid': 6.5, 'Late': 10.5}
ROUND_WORD = {1: '1st', 2: '2nd', 3: '3rd', 4: '4th'}
FMTS = ('sf', 'oneQB')


def load(p: Path, default=None):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def pick_curve(ktc_rows, value_key) -> dict:
    """year -> sorted [(slot, value)] from KTC's '2027 Early 1st' rows."""
    out = {}
    for r in ktc_rows:
        m = re.match(r'^(\d{4}) (Early|Mid|Late) (\d)(?:st|nd|rd|th)$', r.get('playerName', ''))
        if not m:
            continue
        y, tier, rnd = int(m.group(1)), m.group(2), int(m.group(3))
        out.setdefault(y, []).append(((rnd - 1) * 12 + TIER_SLOT[tier], float(r.get(value_key) or 0)))
    return {y: sorted(v) for y, v in out.items()}


def slot_value(curve, slot: float) -> float:
    if not curve:
        return 0.0
    if slot <= curve[0][0]:
        # Above the Early-tier centre (the 1.01 and 1.02 are worth more than an
        # average Early 1st), extend the Early-to-Mid slope, capped at +25%.
        if len(curve) > 1:
            slope = (curve[0][1] - curve[1][1]) / (curve[1][0] - curve[0][0])
            return min(curve[0][1] * 1.25, curve[0][1] + slope * (curve[0][0] - slot))
        return curve[0][1]
    for (s0, v0), (s1, v1) in zip(curve, curve[1:]):
        if slot <= s1:
            return v0 + (v1 - v0) * (slot - s0) / (s1 - s0)
    s_last, v_last = curve[-1]
    return v_last * math.exp(-(slot - s_last) / 12)


def slot_label(year: int, slot: int) -> str:
    rnd = (slot - 1) // 12 + 1
    tier = TIERS[min(2, ((slot - 1) % 12) // 4)]
    return f'{year} {tier} {ROUND_WORD[rnd]}' if rnd <= 4 else f'{year} beyond round 4'


def main() -> None:
    data = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/data')
    ktc = [k for k in load(data / 'ktc_rankings_devy.json', []) if (k.get('draftYear') or FIRST_CLASS) >= FIRST_CLASS
           and k.get('position') in POSITIONS]
    vdoc = load(data / 'devy-value-scores.json', {}) or {}
    cdoc = load(data / 'devy-model-scores.json', {}) or {}
    vmodel = load(data / 'devy-value-model.json', {}) or {}
    career_by_id = {c['cfbdId']: c for c in cdoc.get('players', [])}
    career_2027 = {norm_name(r['name']): r for r in load(data / 'career-2027.json', []) or []}
    curves = {'sf': pick_curve(load(data / 'ktc_rankings_superflex.json', []), 'superflexValue'),
              'oneQB': pick_curve(load(data / 'ktc_rankings_1qb.json', []), 'value')}

    vals = vdoc.get('players', [])
    by_ktc = {v['ktcId']: v for v in vals if v.get('ktcId')}

    def row(name, pos, school, draft_year, v, k):
        cs = career_by_id.get((v or {}).get('cfbdId')) if v else None
        c27 = career_2027.get(norm_name(name))
        ktc_val = {'sf': (k or {}).get('superflexValue') or 0, 'oneQB': (k or {}).get('value') or 0}
        return {
            'name': name, 'pos': pos, 'school': school, 'draftYear': draft_year,
            'ktcId': (k or {}).get('playerID'), 'cfbdId': (v or {}).get('cfbdId'),
            # Devy value: KTC's own where it lists him, else the model's.
            'devyValue': {f: int(round(ktc_val[f])) if ktc_val[f] > 0 else int(round(((v or {}).get('value') or {}).get(f) or 0))
                          for f in FMTS},
            'valueSource': 'ktc' if k else 'model',
            'ktc': {'sf': ktc_val['sf'] or None, 'oneQB': ktc_val['oneQB'] or None,
                    'sfRank': (k or {}).get('superflexRank') or None, 'oneQBRank': (k or {}).get('oneQBRank') or None},
            # The value model's read, for listed players out of fold (without
            # having seen him), so it can be set against KTC's actual.
            'modelValue': ((v or {}).get('valueOOF') if k else (v or {}).get('value')) or None,
            'pListed': (v or {}).get('pListed'),
            'careerScore': (cs or {}).get('score', {}).get(str(draft_year)),
            'profile': (v or {}).get('profile'),
            'careerModel2027': ({'ppg': c27['model']['predictedCareerPPG'], 'tier': c27['model']['tierLabel'],
                                 'projPick': c27.get('projPick')} if c27 and c27.get('model') else None),
        }

    players = [row(k['playerName'], k['position'], k.get('teamLongName') or k.get('team'),
                   k.get('draftYear') or FIRST_CLASS, by_ktc.get(k.get('playerID')), k) for k in ktc]
    unlisted = [v for v in vals if not v.get('ktcId') and v['draftYear'] >= FIRST_CLASS
                and max(v['value'].get('sf') or 0, v['value'].get('oneQB') or 0) >= MIN_MODELLED]
    unlisted.sort(key=lambda v: -max(v['value'].get('sf') or 0, v['value'].get('oneQB') or 0))
    for v in unlisted[:max(0, MAX_PLAYERS - len(players))]:
        players.append(row(v['name'], v['pos'], v.get('team'), v['draftYear'], v, None))

    # Career-score percentile within position (the population on the board).
    for pos in POSITIONS:
        grp = sorted((p for p in players if p['pos'] == pos and p['careerScore'] is not None), key=lambda p: p['careerScore'])
        for i, p in enumerate(grp):
            p['careerPct'] = round(100 * (i + 0.5) / len(grp))

    for f in FMTS:
        order = sorted(players, key=lambda p: -p['devyValue'][f])
        for i, p in enumerate(order):
            p.setdefault('rank', {})[f] = i + 1
        for pos in POSITIONS:
            grp = [p for p in order if p['pos'] == pos]
            for j, p in enumerate(grp):
                p.setdefault('posRank', {})[f] = j + 1
            by_career = sorted((p for p in grp if p['careerScore'] is not None), key=lambda p: -p['careerScore'])
            for j, p in enumerate(by_career):
                p.setdefault('careerPosRank', {})[f] = j + 1
                p.setdefault('careerVsValue', {})[f] = p['posRank'][f] - (j + 1)
        for dy in {p['draftYear'] for p in players}:
            cls = [p for p in order if p['draftYear'] == dy]
            curve = curves[f].get(dy) or (curves[f].get(max(curves[f])) if curves[f] else [])
            for j, p in enumerate(cls):
                p.setdefault('dynasty', {})[f] = {'value': int(round(slot_value(curve, j + 1))),
                                                  'classRank': j + 1, 'pickEquiv': slot_label(dy, j + 1)}

    players.sort(key=lambda p: p['rank']['sf'])
    met = vmodel.get('metrics', {})
    doc = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'modelAsOfSeason': vdoc.get('asOfSeason') or cdoc.get('asOfSeason'),
        'classes': sorted({p['draftYear'] for p in players}),
        'valueModel': {'spearmanIfListed': {f: met.get(f, {}).get('ridge_spearmanIfListed') for f in FMTS},
                       'aucListed': met.get('pListed', {}).get('aucListedVsUnlistedFBS')},
        'note': ('Two scores per college player. devyValue = the market price on KTC\'s 0-9999 devy scale: '
                 'KTC\'s own value where it lists him (valueSource ktc), else the devy value model '
                 '(valueSource model: P(KTC lists him) x the value KTC would put on a listed player with his '
                 'profile). careerScore = our NFL projection: expected mean of his best two NFL PPR PPG seasons '
                 'in his first four (careerPct = percentile in position on this board). careerVsValue = position '
                 'rank by devy value minus position rank by career score (positive: the projection likes him '
                 'more than the market). dynasty.value = priced as the rookie-draft slot his class rank by devy '
                 'value implies, from KTC future pick values. Age is estimated from the high-school class (no '
                 'public college birthdates). Profiles run through the ' + str(vdoc.get('asOfSeason')) + ' season.'),
        'players': players,
    }
    with open(data / 'devy-rankings.json', 'w') as f:
        json.dump(doc, f, indent=1)
    print(f'devy rankings: {len(players)} players ({sum(p["valueSource"] == "ktc" for p in players)} KTC-listed, '
          f'{sum(p["valueSource"] == "model" for p in players)} modelled), classes {doc["classes"]}')


if __name__ == '__main__':
    main()
