# Legacy JS Training Code

These files are archived copies of the original JavaScript model training
implementations, preserved in case we need to revert from the Python
(LightGBM + scikit-learn) training pipeline.

## Files

- `rookieCareerModel.ts` — Rookie career model (Ridge + bagged GBM, LOSO CV)
- `ridge.ts` — Pure JS Ridge regression implementation
- `gbm.ts` — Pure JS gradient boosted model implementation  
- `trainCareerModelsParallel.ts` — Worker thread parallelization (didn't work reliably)
- `careerModelWorker.ts` — Worker entry point

## Why we migrated

The JS training was single-threaded and took 30+ minutes for career models
(WR alone was 10+ min per run). Container timeouts on the cloud instance
made it impossible to train both pre-draft and post-draft models in one run.

Python with LightGBM + scikit-learn is 50-100x faster for the same math.

## How to revert

The `predict()` and `predictGBM()` functions in the live `ridge.ts` and
`gbm.ts` are still used by the TypeScript site for browser-side scoring.
Only the training functions were replaced. To revert:

1. Copy these files back to `src/lib/`
2. Update `precompute-features.ts` to call `trainRookieCareerModels()` instead of the Python script
3. Remove `scripts/train_models.py`
