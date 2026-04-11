#!/usr/bin/env python3
"""Regression test: LightGBM Python training output must match the JS predictor.

Guard against reintroducing the pre-fix bug where the converter emitted
`initialPrediction = mean(y)` and `learningRate = cfg['lr']` while LightGBM
had already baked both into the dumped leaf_values. That bug shipped silently
for 10+ PRs because CV R² was measured from `lgb.predict()` (correct) while
production went through the JS formula `init + lr * sum(leaf)` (double-shrunk,
near-constant predictor collapsed around mean(y)).

Run:
    python3 scripts/tests/test_lgb_js_equivalence.py

Exits 0 on success, 1 on failure.
"""
import sys
from pathlib import Path

import numpy as np
import lightgbm as lgb

# Import the fixed converter from the project
sys.path.insert(0, str(Path(__file__).parent.parent))
from train_projection_models import lgb_to_js_gbm, _convert_node, train_lgb_model  # noqa: E402


TOLERANCE = 1e-8


def predict_via_js_formula(gbm_js: dict, X: np.ndarray) -> np.ndarray:
    """Replicate src/lib/gbm.ts::predictGBM() in Python.

    This is exactly what the shipped TS code does at inference time:
        pred = initialPrediction + learningRate * sum(tree_leaf for each tree)
    """
    init = gbm_js['initialPrediction']
    lr = gbm_js['learningRate']
    trees = gbm_js['trees']

    def walk(tree, sample):
        node = tree
        while node.get('featureIndex', -1) != -1:
            fi = node['featureIndex']
            thr = node['threshold']
            node = node['left'] if sample[fi] <= thr else node['right']
        return node['value']

    n = X.shape[0]
    out = np.zeros(n)
    for i in range(n):
        sample = X[i]
        s = 0.0
        for t in trees:
            s += walk(t, sample)
        out[i] = init + lr * s
    return out


def make_synthetic_data(n: int = 300, seed: int = 7):
    rng = np.random.default_rng(seed)
    X = rng.normal(size=(n, 5))
    # Realistic-ish PPG target: non-zero mean, interactions, noise
    y = 12.0 + 2.0 * X[:, 0] + 1.5 * X[:, 1] - 0.8 * X[:, 2] * X[:, 3] + rng.normal(0, 0.5, n)
    return X, y


def check(name: str, passed: bool, detail: str = '') -> bool:
    mark = 'PASS' if passed else 'FAIL'
    print(f'  [{mark}] {name}' + (f' — {detail}' if detail else ''))
    return passed


def run_tests() -> int:
    failures = 0

    print('test_lgb_js_equivalence.py')
    print()

    # ── Test 1: squared loss, realistic PPG-style hyperparams ────────
    print('Test 1: squared-loss GBM matches LGB.predict() exactly')
    X, y = make_synthetic_data()
    feature_names = [f'f{i}' for i in range(X.shape[1])]
    params = {
        'objective': 'regression', 'metric': 'mae',
        'learning_rate': 0.08, 'max_depth': 3,
        'min_child_samples': 8, 'subsample': 0.8,
        'seed': 42, 'n_jobs': 1,
    }
    model = train_lgb_model(X, y, feature_names, params, 60)
    gbm_js = lgb_to_js_gbm(model, X, y, feature_names)

    lgb_pred = model.predict(X)
    js_pred = predict_via_js_formula(gbm_js, X)
    max_diff = float(np.max(np.abs(lgb_pred - js_pred)))
    if not check('predictions match LGB exactly',
                 max_diff < TOLERANCE,
                 f'max|lgb - js| = {max_diff:.2e}'):
        failures += 1

    # ── Test 2: the emitted metadata MUST be 0 / 1 ────────────────────
    print()
    print('Test 2: metadata is the neutral 0 / 1 pair')
    if not check('initialPrediction == 0.0',
                 gbm_js['initialPrediction'] == 0.0,
                 f'got {gbm_js["initialPrediction"]}'):
        failures += 1
    if not check('learningRate == 1.0',
                 gbm_js['learningRate'] == 1.0,
                 f'got {gbm_js["learningRate"]}'):
        failures += 1

    # ── Test 3: quantile loss also works (used for gbmLower/gbmUpper) ─
    print()
    print('Test 3: quantile GBM matches LGB.predict() exactly')
    q_params = dict(params)
    q_params.update({'objective': 'quantile', 'alpha': 0.10, 'metric': 'quantile'})
    q_model = train_lgb_model(X, y, feature_names, q_params, 60)
    q_js = lgb_to_js_gbm(q_model, X, y, feature_names, loss='quantile', quantile=0.10)
    q_lgb = q_model.predict(X)
    q_js_pred = predict_via_js_formula(q_js, X)
    max_diff_q = float(np.max(np.abs(q_lgb - q_js_pred)))
    if not check('quantile predictions match',
                 max_diff_q < TOLERANCE,
                 f'max|lgb - js| = {max_diff_q:.2e}'):
        failures += 1

    # ── Test 4: the old buggy formula must NOT match ──────────────────
    # Anti-regression: if someone reintroduces mean(y) + lr*sum, this test
    # demonstrates the predictions diverge significantly.
    print()
    print('Test 4: buggy formula (mean(y) + lr*sum) is measurably wrong')
    buggy_init = float(np.mean(y))
    buggy_lr = 0.08
    buggy_js = dict(gbm_js)
    buggy_js['initialPrediction'] = buggy_init
    buggy_js['learningRate'] = buggy_lr
    buggy_pred = predict_via_js_formula(buggy_js, X)
    buggy_spread = float(np.max(buggy_pred) - np.min(buggy_pred))
    real_spread = float(np.max(lgb_pred) - np.min(lgb_pred))
    if not check('buggy formula collapses prediction spread',
                 buggy_spread < 0.2 * real_spread,
                 f'buggy spread {buggy_spread:.3f} vs correct {real_spread:.3f}'):
        failures += 1

    print()
    if failures == 0:
        print(f'All tests passed.')
        return 0
    print(f'{failures} test(s) failed.')
    return 1


if __name__ == '__main__':
    sys.exit(run_tests())
