"""Python predictors for the shipped JSON model caches.

Runs the same prediction formula as the TS inference code (src/lib/gbm.ts
and src/lib/ridge.ts) directly from the JSON representation. Used by
any script that needs to score the PPG / residual / ADP models in-process
without a node runtime.

The predictors enforce the init=0 / lr=1 invariant from commit f22f844
(see scripts/tests/test_lgb_js_equivalence.py for the guard test).

──────────────────────────────────────────────────────────────────────────
NULL RESULT — why these aren't used in train_ktc_timeseries.py
──────────────────────────────────────────────────────────────────────────

Commit B.1 was scoped to wire PPG / residual / ADP model predictions in
as KTC features on the hypothesis that they would encode a forward-
looking "player quality" signal orthogonal to KTC's daily price history
— the exact thing the weak long-horizon WR/RB pgR² values seemed to need.

Two configurations were measured:

  Attempt 1 (5 features: modelPpgPredicted, modelPpgDelta,
  modelResidualAdd, modelResidualTotal, modelAdpPpg):
    Net Δ vs Commit B:  -0.043   wins=3   losses=7
    - Biggest wins:     RB H=120 (+0.011), RB H=60 (+0.009)
    - Biggest losses:   QB H=90 (-0.016), TE H=120 (-0.015), QB H=60 (-0.013)

  Attempt 2 (2 "edge" features only: modelPpgDelta, modelResidualAdd):
    Net Δ vs Commit B:  -0.074   wins=0   losses=7
    - Uniformly worse than Commit B.

Root cause: the slow features already wired into the KTC trainer
(priorPPG, priorPPG2yr, ppgTrend, invDraftPick, teamSamePosCount, age,
yearsInLeague, draftPickPctOverall, nflDraftPick, priorTargetShare, ...)
overlap heavily with the input feature lists of the PPG, residual, and
ADP models. A GBM trained on the slow features can recover essentially
the same non-linear combinations the external models compute. Adding
the external model output as an additional feature gives the GBM a
correlated scalar that it splits on in ways that don't generalize —
a classic redundant-feature overfit signature.

Interpretation: the right way to use the existing models to inform KTC
forecasts is NOT "ship their outputs as features." It's one of:

  1. Ensemble KTC predictions with a KTC-agnostic baseline derived from
     the PPG/residual models. Blend at the prediction layer, not the
     feature layer.
  2. Use the external models to *select* which KTC players to forecast
     more aggressively (e.g. high residualAdd → market mispricing →
     larger forecasted log-return). Routing logic, not a feature.
  3. Train a second-layer model that takes only the external model
     outputs (no slow features) and predicts KTC residuals on top of
     the main model. That would avoid the redundancy issue but adds
     pipeline complexity — scoped for a follow-up, not Commit B.

This file is kept as infrastructure for any of those future approaches.
──────────────────────────────────────────────────────────────────────────
"""
import json
from pathlib import Path

import numpy as np


# Per-position GBM/Ridge blend weights for the PPG v56 cache. These are
# hardcoded in scripts/train_projection_models.py's PPG_CONFIG and are
# not stored in the cache JSON itself. If PPG_CONFIG changes, update
# here as well.
PPG_GBM_WEIGHT = {'QB': 0.9, 'RB': 0.8, 'WR': 0.7, 'TE': 0.7}


def walk_tree(tree, sample):
    node = tree
    while node.get('featureIndex', -1) != -1:
        fi = node['featureIndex']
        thr = node['threshold']
        node = node['left'] if sample[fi] <= thr else node['right']
    return node['value']


def predict_gbm_json(gbm_json, X):
    """Apply the TS-side formula (init + lr * Σ leaf_value) to a batch of
    rows. Matches src/lib/gbm.ts::predictGBM() and the guard test at
    scripts/tests/test_lgb_js_equivalence.py."""
    init = gbm_json['initialPrediction']
    lr = gbm_json['learningRate']
    trees = gbm_json['trees']
    n = X.shape[0]
    out = np.full(n, init, dtype=np.float64)
    for t in trees:
        for i in range(n):
            out[i] += lr * walk_tree(t, X[i])
    return out


def predict_ridge_json(ridge_json, X):
    """Replicate train_ridge_js's emitted contract:
      1. Standardize X: (X - featureMeans) / featureStds
      2. Compute z-space prediction: X_std @ coefficients
      3. Un-standardize: z_pred * targetStd + targetMean

    NB: the `intercept` field in the JSON stores target_mean (not a
    conventional ridge intercept) — train_ridge_js fits the Ridge on
    standardized X and y, then bakes the standardization constants
    into the output dict."""
    means = np.array(ridge_json['featureMeans'], dtype=np.float64)
    stds = np.array(ridge_json['featureStds'], dtype=np.float64)
    coefs = np.array(ridge_json['coefficients'], dtype=np.float64)
    tm = float(ridge_json['targetMean'])
    ts = float(ridge_json['targetStd'])
    # Guard against constant-in-training features
    stds = np.where(stds == 0, 1.0, stds)
    X_std = (X - means) / stds
    return (X_std @ coefs) * ts + tm


def load_ppg_residual_adp(data_dir: Path):
    """Load the three shipped model caches into a dict of per-position
    predictors. Missing cache files are skipped; callers should fall
    back to zeros or their own defaults for those positions.

    Returns dict with keys 'ppg', 'residual', 'adp', each a dict
    keyed by position ('QB'/'RB'/'WR'/'TE')."""
    out = {'ppg': {}, 'residual': {}, 'adp': {}}

    ppg_path = data_dir / 'model-cache-ppg-v56.json'
    if ppg_path.exists():
        with open(ppg_path) as f:
            d = json.load(f)
        for m in d.get('ppgModels', []):
            pos = m['position']
            out['ppg'][pos] = {
                'gbm': m['gbmModel'],
                'ridge': m['ridgeModel'],
                'featureNames': m['gbmModel']['featureNames'],
                'weight': PPG_GBM_WEIGHT.get(pos, 0.7),
            }

    resid_path = data_dir / 'model-cache-residual-v56.json'
    if resid_path.exists():
        with open(resid_path) as f:
            d = json.load(f)
        for m in d.get('residualModels', []):
            pos = m['position']
            out['residual'][pos] = {
                'gbm': m['gbmModel'],
                'ridge': m['ridgeModel'],
                'gbmFeats': m['gbmModel']['featureNames'],
                'ridgeFeats': m['ridgeModel']['featureNames'],
                'weight': float(m.get('gbmWeight', 0.7)),
                'adpSlope': float(m.get('adpSlope', 0.0)),
                'adpIntercept': float(m.get('adpIntercept', 0.0)),
            }

    adp_path = data_dir / 'model-cache-adp-v56.json'
    if adp_path.exists():
        with open(adp_path) as f:
            d = json.load(f)
        for m in d.get('models', []):
            pos = m['position']
            out['adp'][pos] = {
                'gbm': m['gbmModel'],
                'ridge': m['ridgeModel'],
                'featureNames': m['gbmModel']['featureNames'],
                'weight': 0.7,
            }

    return out


def assemble_feature_vector(feat_names, features_dict):
    """Pull a feature vector in the requested order from a training-row
    features dict. Unknown keys default to 0.0 — equivalent to the TS
    feature store's behavior when a feature is missing."""
    def _sf(v):
        if v is None or v == '' or v == 'NA' or v == 'NaN':
            return 0.0
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0
    return np.array([_sf((features_dict or {}).get(k, 0.0))
                      for k in feat_names], dtype=np.float64)


def predict_ppg_ensemble(entry, features_dict):
    """PPG model: gbm*w + ridge*(1-w) → predicted rawPPG."""
    X = assemble_feature_vector(entry['featureNames'], features_dict).reshape(1, -1)
    gbm_p = float(predict_gbm_json(entry['gbm'], X)[0])
    ridge_p = float(predict_ridge_json(entry['ridge'], X)[0])
    w = entry['weight']
    return gbm_p * w + ridge_p * (1 - w)


def predict_residual_ensemble(entry, features_dict):
    """Residual model: gbm*w + ridge*(1-w) → additive over ADP baseline."""
    X_gbm = assemble_feature_vector(entry['gbmFeats'], features_dict).reshape(1, -1)
    X_ridge = assemble_feature_vector(entry['ridgeFeats'], features_dict).reshape(1, -1)
    gbm_p = float(predict_gbm_json(entry['gbm'], X_gbm)[0])
    ridge_p = float(predict_ridge_json(entry['ridge'], X_ridge)[0])
    w = entry['weight']
    return gbm_p * w + ridge_p * (1 - w)


def predict_residual_total_ppg(entry, features_dict, adp_value):
    """Residual ensemble output added to the linear ADP baseline →
    predicted rawPPG."""
    baseline = entry['adpSlope'] * adp_value + entry['adpIntercept']
    return baseline + predict_residual_ensemble(entry, features_dict)


def predict_adp_ensemble(entry, features_dict):
    """ADP model: gbm*w + ridge*(1-w) → predicted rawPPG."""
    X = assemble_feature_vector(entry['featureNames'], features_dict).reshape(1, -1)
    gbm_p = float(predict_gbm_json(entry['gbm'], X)[0])
    ridge_p = float(predict_ridge_json(entry['ridge'], X)[0])
    w = entry['weight']
    return gbm_p * w + ridge_p * (1 - w)
