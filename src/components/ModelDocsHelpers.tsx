/**
 * Reusable components for ModelDocumentation: pipeline diagrams + stat tooltips.
 */

import { useState } from 'react';

// ── Tooltip ─────────────────────────────────────────────────────────

interface InfoTipProps {
  title: string;
  description: string;
  benchmark?: string;
  children?: React.ReactNode;
}

export function InfoTip({ title, description, benchmark, children }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%',
          background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
          fontSize: 9, fontWeight: 700, cursor: 'pointer',
          marginLeft: 4, verticalAlign: 'middle',
        }}
      >?</span>
      {children}
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              zIndex: 999,
            }}
          />
          <div style={{
            position: 'absolute', top: 18, left: 0, zIndex: 1000,
            background: 'var(--bg-primary)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 10, minWidth: 240, maxWidth: 280,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>
              {title}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {description}
            </div>
            {benchmark && (
              <div style={{
                marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)',
                fontSize: 10, color: 'var(--text-muted)',
              }}>
                <strong style={{ color: 'var(--text-secondary)' }}>Benchmark:</strong> {benchmark}
              </div>
            )}
          </div>
        </>
      )}
    </span>
  );
}

// ── Pipeline diagrams ───────────────────────────────────────────────

interface PipelineStep {
  label: string;
  desc?: string;
  color?: string;
}

export function PipelineDiagram({ steps, title }: { steps: PipelineStep[]; title?: string }) {
  return (
    <div style={{
      background: 'var(--bg-tertiary)', borderRadius: 8, padding: 12,
      marginBottom: 16, border: '1px solid var(--border)',
    }}>
      {title && (
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
          {title}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {steps.map((step, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              flexShrink: 0, width: 28, height: 28, borderRadius: '50%',
              background: step.color || '#8b5cf6', color: 'white',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700,
            }}>{i + 1}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                {step.label}
              </div>
              {step.desc && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  {step.desc}
                </div>
              )}
            </div>
            {i < steps.length - 1 && (
              <div style={{ position: 'absolute', marginLeft: 14, marginTop: 32, width: 0, height: 0 }}>
                {/* arrow handled by next item layout */}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stat definitions ────────────────────────────────────────────────

export const STAT_DEFS: Record<string, { title: string; desc: string; benchmark: string }> = {
  r2: {
    title: 'R² (Coefficient of Determination)',
    desc: 'Proportion of variance in actual outcomes explained by the model. Range: -∞ to 1.0. Higher = better predictive power.',
    benchmark: 'NFL projection R² is typically 0.10-0.30. Above 0.20 is strong; negative means worse than predicting the mean.',
  },
  mae: {
    title: 'MAE (Mean Absolute Error)',
    desc: 'Average absolute difference between predicted and actual values. Lower = better.',
    benchmark: 'For PPG predictions: 2-3 PPG MAE is excellent, 3-5 is good, 5+ needs improvement.',
  },
  rmse: {
    title: 'RMSE (Root Mean Squared Error)',
    desc: 'Like MAE but penalizes large errors more heavily. Lower = better.',
    benchmark: 'Usually 25-50% higher than MAE. Big gaps between RMSE and MAE indicate outliers.',
  },
  rankCorr: {
    title: 'Spearman Rank Correlation',
    desc: 'Measures whether predictions rank players in the same order as actual outcomes. Range: -1 to 1. Higher = better ordering.',
    benchmark: '> 0.4 = strong, 0.2-0.4 = moderate, < 0.2 = weak. ZAP achieves ~0.30 for WRs.',
  },
  loso: {
    title: 'LOSO (Leave-One-Season-Out) Cross-Validation',
    desc: 'For each draft class, train the model on all OTHER classes and predict the held-out class. Tests generalization to truly unseen data.',
    benchmark: 'Standard for time-series ML where future data leakage matters. More honest than random k-fold for draft prediction.',
  },
  auc: {
    title: 'AUC (Area Under ROC Curve)',
    desc: 'Probability that the model ranks a random positive higher than a random negative. Range: 0.5 (random) to 1.0 (perfect).',
    benchmark: '> 0.70 = strong classifier, 0.60-0.70 = moderate, < 0.60 = weak. NFL hit/bust classifiers typically reach 0.62-0.68.',
  },
  brier: {
    title: 'Brier Score',
    desc: 'Mean squared error of probability predictions. Lower = better-calibrated probabilities. Range: 0 (perfect) to 1.',
    benchmark: '< 0.15 = well-calibrated, 0.15-0.20 = decent, > 0.20 = poor calibration.',
  },
  hitRate: {
    title: 'Hit Rate',
    desc: 'Percentage of model-predicted "Tier 1-3" players who actually finished above the median for their position.',
    benchmark: '> 60% = strong, 50-60% = decent, < 50% = at/below random. Median-by-construction means random = 50%.',
  },
  baseRate: {
    title: 'Base Rate',
    desc: 'Percentage of players in the dataset who actually hit the threshold. The "no-skill" baseline.',
    benchmark: 'Compare to model accuracy. Beating base rate by 5+ percentage points indicates real signal.',
  },
  precision: {
    title: 'Precision',
    desc: 'Of players the model predicted to hit (>50% probability), what fraction actually hit?',
    benchmark: 'Higher = fewer false positives. Trade-off with recall — high precision often means missed hits.',
  },
  recall: {
    title: 'Recall',
    desc: 'Of all players who actually hit, what fraction did the model predict?',
    benchmark: 'Higher = fewer missed hits. Trade-off with precision.',
  },
  threshold: {
    title: 'PPG Threshold Classifier',
    desc: 'Per-threshold binary classifier predicting P(best 2-of-3 PPG ≥ threshold). Multiple thresholds (12, 14, 16, 18 for WR/RB) provide a probability distribution.',
    benchmark: 'AUC ~0.65-0.75 is achievable for top thresholds. Lower thresholds are easier to predict.',
  },
  bestOf3: {
    title: 'Best 2-of-3 PPG',
    desc: 'Average of the player\'s top 2 PPG seasons from their first 3 NFL years (qualifying = 4+ games). Reduces injury noise vs first-year-only.',
    benchmark: 'WR ≥ 14 PPG = elite, ≥ 10 = starter, ≥ 6 = flex, < 6 = bench.',
  },
  percentile: {
    title: 'Cross-Year Percentile',
    desc: 'Each player\'s predicted PPG ranked against ALL historical rookies at their position (2018-2025). 90th percentile means better than 90% of all rookie predictions ever.',
    benchmark: 'Comparable across draft classes — a 90th-percentile WR means the same in 2023 as 2025.',
  },
};
