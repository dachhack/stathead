#!/usr/bin/env python3
"""Pretty-print the RSP ablation JSON so the findings are scannable."""
import json
import sys
from pathlib import Path


def print_pos(pos, res):
    ba = res['baseline_all']
    br = res['baseline_recent']
    brt = res['baseline_rtrain']
    print(f'\n── {pos} ' + '─' * 60)
    print(f'  Baseline        all={ba["r2"]:.4f}  score≥22={br["r2"]:.4f}  train≥22={brt["r2"]:.4f}')

    print('  rookie-career R² lifts (score≥22 is the PDF-era honesty test):')
    print(f'    {"variant":<18s} {"Δ all":>10s} {"Δ score≥22":>12s} {"Δ train≥22":>12s}')
    for name, v in res['variants'].items():
        print(f'    {name:<18s} {v.get("delta_all_r2", 0):+10.4f} '
              f'{v.get("delta_recent_r2", 0):+12.4f} {v.get("delta_rtrain_r2", 0):+12.4f}')

    bb = res.get('boom_bust_baseline')
    if not bb:
        return
    bba = bb['all']
    bbr = bb['recent']
    print(f'  Boom baseline   ρ_all={bba["boom_rho"]}  ρ_rec={bbr["boom_rho"]}')
    print(f'  Bust baseline   AUC_all={bba["bust_auc"]}  AUC_rec={bbr["bust_auc"]}')
    print('  Boom/bust lifts:')
    print(f'    {"variant":<24s} {"Δ metric all":>14s} {"Δ metric rec":>14s}')
    for name, v in res.get('boom_bust_variants', {}).items():
        delt_key_all = 'delta_all_rho' if 'boom_' in name else 'delta_all_auc'
        delt_key_r = 'delta_recent_rho' if 'boom_' in name else 'delta_recent_auc'
        da = v.get(delt_key_all)
        dr = v.get(delt_key_r)
        print(f'    {name:<24s} {da if da is not None else 0:+14.4f} '
              f'{dr if dr is not None else 0:+14.4f}')


def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1
                else 'public/data/rsp-career-ablation-predraft.json')
    with open(path) as f:
        data = json.load(f)
    print(f'=== {path.name} ({"post" if data["is_post_draft"] else "pre"}-draft) ===')
    for pos in ('QB', 'RB', 'WR', 'TE'):
        if pos in data['results']:
            print_pos(pos, data['results'][pos])


if __name__ == '__main__':
    main()
