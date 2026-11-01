"""Proxy back test of pick-line pricing, weeks 1-6 of 2026.

Proxy back test of pick-line pricing (the basis of CAL_SHRINK in
scripts/price-lines.py). Run from the repo root; needs the benchmark stat
projections cached under .cache/ by scripts/score-weekly-projections.py
(run it once without --no-benchmark) and the pre-kickoff feed snapshots
in git.

Result on 2026 weeks 1-6 (2,429 proxy lines): hit rate by raw P(lean)
bucket 50.6 / 52.8 / 56.9 / 57.6 / 62.4% against the simulation's own
51.9 / 56.0 / 60.0 / 65.5 / 80.8% -- correctly ranked, overstated by about
half. Leans clearing the 1.78x break-even hit 58.6% (+4.2% per pick), almost
all on unders: a line set at a mean is beaten by the under 56.3% of the time
on its own, so against a real (median-set) line expect less.

No historical pick lines exist, so the external benchmark projection's own
stat number stands in for the line (rounded to .5 like an app line), for
receiving yards, rushing yards, passing yards and receptions. For every
player-week with a pre-kickoff StatHead stat line, a benchmark number and an
actual, price P(over the proxy line) with the simulation fitted on the weeks
before (walk-forward from week 4; weeks 1-3 use the week-3 fit), take the
lean, and grade it. Calibration = hit rate by P(lean) bucket; "edge" = hit
rate when P(lean) clears the 1.78x break-even (56.2%).
"""
import json, importlib.util, sys
import numpy as np
from collections import defaultdict
spec = importlib.util.spec_from_file_location('sc', 'scripts/score-weekly-projections.py'); sc = importlib.util.module_from_spec(spec); spec.loader.exec_module(sc)
season = 2026; path = 'public/data/weekly-projections-2026.json'; kick = sc.kickoffs(season); act_stats = sc.load_actual_stats(season)
STATS = {'recYds': ('WR', 'TE', 'RB'), 'rushYds': ('RB', 'QB'), 'passYds': ('QB',), 'rec': ('WR', 'TE', 'RB')}
MIN_LINE = {'recYds': 15, 'rushYds': 15, 'passYds': 150, 'rec': 1.5}
srows = []   # for fitting
rows = []    # for pricing
for w in range(1, 7):
    commit, _ = sc.snapshot_before(path, kick[w]); snap = json.loads(sc.git('show', f'{commit}:{path}')); pool = sc.pool_lines_before(season, kick[w])
    bench = sc.benchmark_stats(season, w) or {}
    for p in snap['players']:
        if p['pos'] not in sc.POS or not p.get('gsis') or not p.get('ppg'): continue
        proj = p['wk'][w - 1]; sa = act_stats.get((p['gsis'], w)); flat = p.get('statsPG') or pool.get((sc.norm_name(p['name']), p['pos']))
        if proj is None or not sa or not flat: continue
        line = sc.split_line(flat, p.get('statSplit'), proj / p['ppg'])
        srows.append({'w': w, 'pos': p['pos'], 'proj': line, 'act': sa})
        b = bench.get(str(p.get('sleeper') or ''))
        if b: rows.append({'w': w, 'pos': p['pos'], 'name': p['name'], 'line': line, 'act': sa, 'bench': b})
print('player-weeks with a benchmark stat line:', len(rows), file=sys.stderr)
fits = {w: sc.fit_sim_params([r for r in srows if r['w'] < w]) if w >= 4 else None for w in range(1, 7)}
fit3 = sc.fit_sim_params([r for r in srows if r['w'] <= 3])
picks = []
for r in rows:
    params_all = fits[r['w']] or fit3
    params = params_all.get(r['pos'])
    if not params: continue
    rng = np.random.default_rng(1); d = sc.simulate_stats(r['line'], r['pos'], params, rng, 4000)
    for st, poss in STATS.items():
        if r['pos'] not in poss or st not in d: continue
        bl = r['bench'].get(st, 0.0)
        if bl < MIN_LINE[st] or r['line'].get(st, 0) <= 0: continue
        L = np.floor(bl) + 0.5                      # an app-style line at the benchmark's number
        p_over = float(np.mean(d[st] > L)); lean = 'over' if p_over > 0.5 else 'under'; pl = max(p_over, 1 - p_over)
        a = r['act'].get(st, 0.0); hit = (a > L) if lean == 'over' else (a < L)
        picks.append({'w': r['w'], 'pos': r['pos'], 'stat': st, 'pl': pl, 'lean': lean, 'hit': hit, 'ours': r['line'][st], 'bench': bl, 'act': a})
print('priced proxy lines:', len(picks), file=sys.stderr)
def summ(ps):
    if not ps: return 'n=0'
    h = np.mean([p['hit'] for p in ps]); e = np.mean([p['pl'] for p in ps]); ret = sum((0.78 if p['hit'] else -1) for p in ps) / len(ps)
    return f"n={len(ps):4d} hit {h:.1%} expected {e:.1%} ROI@1.78x {ret:+.1%}"
print('\nAll proxy lines:', summ(picks))
print('\nBy P(lean) bucket (calibration):')
for lo, hi in ((0.5, 0.54), (0.54, 0.58), (0.58, 0.62), (0.62, 0.70), (0.70, 1.01)):
    print(f"  {lo:.0%}-{min(hi,1):.0%}: {summ([p for p in picks if lo <= p['pl'] < hi])}")
print('\nLeans clearing the 1.78x break-even (P >= 56.2%):', summ([p for p in picks if p['pl'] >= 0.562]))
print('  by stat:'); [print(f"    {st:8s} {summ([p for p in picks if p['pl'] >= 0.562 and p['stat'] == st])}") for st in STATS]
print('  by lean:'); [print(f"    {ln:6s} {summ([p for p in picks if p['pl'] >= 0.562 and p['lean'] == ln])}") for ln in ('over', 'under')]
print('  by week:'); [print(f"    wk{w}: {summ([p for p in picks if p['pl'] >= 0.562 and p['w'] == w])}") for w in range(1, 7)]
print('\nSanity: lines where benchmark and we agree within 5% (no edge expected):', summ([p for p in picks if abs(p['ours'] - p['bench']) / max(p['bench'], 1) < 0.05]))
print('Baseline: always under at the proxy line:', f"{np.mean([p['act'] < np.floor(p['bench']) + 0.5 for p in picks]):.1%}")
