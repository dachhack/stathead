"""
Augment redraft-projections.json with 2026 drafted skill-position rookies.

The file is a hand-curated snapshot of veteran 2026 PPG projections (60% of
2025 actuals + 40% 2yr avg + age curve) and was generated 2026-04-12 — pre-
draft, with no rookies. This script adds drafted QB/RB/WR/TE rookies, with
Year-1 PPG derived from the rookie career model (`careerPredictions2026`)
discounted by a per-position pick-based factor that reflects typical first-
year usage curves.

Heuristic Y1 fractions of the model's best-2-of-3 first-3-year PPG:

  RB  R1=0.85  R2=0.60  R3=0.45  R4-5=0.30  late=0.20
  WR  R1=0.60  R2=0.45  R3=0.35  R4-5=0.25  late=0.15
  TE  R1=0.45  R2=0.35  R3=0.25  R4-5=0.20  late=0.10
  QB  P1-3=0.75  P4-15=0.40  P16-50=0.20  P51+=0.10

recPG estimated from the existing veteran-cohort recPG/ppg ratio per
position. UDFAs (no actual draft slot) keep their projected pick + a
late-round discount.
"""
import json
import datetime
from pathlib import Path

ROOT = Path('/home/user/stathead')
PROJ = ROOT / 'public/data/redraft-projections.json'
FM = ROOT / 'public/data/feature-matrix.json'

# Y1 PPG fraction by position + pick range. Calibrated against Mike Clay's
# 2026 projection set. Keep in sync with `y1Fraction` in
# scripts/precompute-features.ts.
def y1_fraction(pos: str, pick: int) -> float:
    if pos == 'RB':
        if pick <= 32:  return 0.85
        if pick <= 64:  return 0.55
        if pick <= 100: return 0.30
        if pick <= 150: return 0.18
        return 0.10
    if pos == 'WR':
        if pick <= 16:  return 0.95
        if pick <= 32:  return 0.85
        if pick <= 64:  return 0.60
        if pick <= 100: return 0.45
        if pick <= 150: return 0.30
        return 0.18
    if pos == 'TE':
        if pick <= 16:  return 0.80
        if pick <= 32:  return 0.55
        if pick <= 64:  return 0.40
        if pick <= 100: return 0.30
        if pick <= 150: return 0.20
        return 0.10
    if pos == 'QB':
        if pick <= 3:   return 0.75
        if pick <= 15:  return 0.40
        if pick <= 50:  return 0.20
        return 0.10
    return 0.30

# rec/ppg ratio per position (typical of veteran cohort in this file)
RECPG_RATIO = {'QB': 0.0, 'RB': 0.16, 'WR': 0.33, 'TE': 0.28}


def main() -> int:
    data = json.loads(PROJ.read_text())
    fm = json.loads(FM.read_text())
    preds = {p['name']: p for p in fm.get('careerPredictions2026', [])}
    by_name = {p['name']: p for p in data.get('players', [])}

    added = 0
    updated = 0
    skipped_no_pred = 0
    for name, p in preds.items():
        pos = p['position']
        if pos not in ('QB', 'RB', 'WR', 'TE'):
            continue
        career_ppg = p.get('predictedCareerPPG', 0)
        if not career_ppg or career_ppg <= 0:
            skipped_no_pred += 1
            continue
        feats = p.get('features', {}) or {}
        pick = int(feats.get('nflDraftPick') or 999)
        frac = y1_fraction(pos, pick)
        y1_ppg = round(career_ppg * frac, 1)
        recpg = round(y1_ppg * RECPG_RATIO[pos], 2)
        existing = by_name.get(name)
        if existing:
            # Refresh in place — heuristic constants may have changed
            # since the last run (e.g. Clay-calibrated bumps to R1 WR/TE).
            existing['ppg'] = y1_ppg
            existing['recPG'] = recpg
            existing['position'] = pos
            updated += 1
        else:
            data.setdefault('players', []).append({
                'name': name,
                'position': pos,
                'ppg': y1_ppg,
                'recPG': recpg,
            })
            added += 1

    # Re-sort by ppg desc within position so the file is browseable
    data['players'].sort(key=lambda r: -r.get('ppg', 0))

    # Bump metadata. Keep original generatedAt for the curated cohort and
    # add a separate field documenting the rookie augmentation date so
    # downstream readers can tell the parts apart.
    data['rookieAugmentedAt'] = datetime.date.today().isoformat()
    data['note'] = (
        'ppg = 2026 projected. Veterans: 60% 2025 actual + 40% 2yr avg + age '
        'curve (2026-04-12). Rookies: rookie career model best-2-of-3 PPG × '
        'per-position pick-based Y1 discount (added '
        f'{data["rookieAugmentedAt"]}). recPG = rec/game for TEP scoring.'
    )

    PROJ.write_text(json.dumps(data, indent=2))
    print(f'Added {added} rookies')
    print(f'  updated in place: {updated}')
    print(f'  skipped (no career prediction): {skipped_no_pred}')
    print(f'New total players: {len(data["players"])}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
