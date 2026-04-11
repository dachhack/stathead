/**
 * Prior Multi-Year feature group: multi-season derived features computed
 * from playerHistoryMap.
 *
 * Mirrors the Python training-time helper in
 * scripts/train_projection_models.py::augment_derived_features so the
 * on-disk training cache and the feature store agree.
 *
 * Features:
 *   priorPPG2yr        — 0.65 * Y-1 ppg + 0.35 * Y-2 ppg (falls back to Y-1
 *                        if Y-2 missing, 0 if both missing)
 *   durabilityStreak   — consecutive prior seasons with ≥15 games played,
 *                        counting back from Y-1 until a sub-15 season
 *
 * Evidence: priorPPG2yr substituted for priorPPG gives QB +0.0064 R² on the
 * ADP-free PPG model. durabilityStreak adds +0.0013 R² for TE. See
 * scripts/ablate_ppg_features.py and the PPG leakage-fix arc for context.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const priorMultiYearGroup: FeatureGroup = {
  def: {
    id: 'priorMultiYear',
    label: 'Multi-Year Prior Stats',
    featureKeys: ['priorPPG2yr', 'durabilityStreak'],
    dataDeps: ['priorStats', 'priorSnaps'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const hist = ctx.data.playerHistoryMap?.get(player.normalName) || [];
      // History entries carry season = S-1 for the row at season S.
      // Look up Y-1 (season-1) and Y-2 (season-2) directly.
      const y1 = hist.find((h: any) => h.season === season - 1);
      const y2 = hist.find((h: any) => h.season === season - 2);

      const y1ppg = y1?.ppg || 0;
      const y2ppg = y2?.ppg || 0;

      let priorPPG2yr: number;
      if (y1ppg > 0 && y2ppg > 0) {
        priorPPG2yr = 0.65 * y1ppg + 0.35 * y2ppg;
      } else if (y1ppg > 0) {
        priorPPG2yr = y1ppg;
      } else {
        priorPPG2yr = 0;
      }

      // durabilityStreak: consecutive priorGames ≥ 15 looking back from Y-1
      const sortedDesc = [...hist].sort((a: any, b: any) => b.season - a.season);
      let streak = 0;
      for (const entry of sortedDesc) {
        if ((entry.games || 0) >= 15) {
          streak += 1;
        } else {
          break;
        }
      }

      results.set(pk, {
        priorPPG2yr: Math.round(priorPPG2yr * 100) / 100,
        durabilityStreak: streak,
      });
    }
    return results;
  },
};

registerGroup(priorMultiYearGroup);
