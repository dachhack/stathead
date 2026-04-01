import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import {
  POSITIONS, POS_COLORS, FEATURES, CATEGORY_COLORS,
} from '../lib/featureTypes';
import { trainRookieCareerModels } from '../lib/rookieCareerModel';
import type { RookieCareerModelResult } from '../lib/rookieCareerModel';
import projectionConfig from '../generated/projection-config.json';

interface PositionModelData {
  position: string;
  featureNames: string[];
  featureLabels: string[];
  n: number;
  hitRate: number;
  bustRate: number;
  cvR2Gbm: number;
  cvMaeGbm: number;
  cvR2Ridge: number;
  cvMaeRidge: number;
  cvR2GbmBaseline: number;
  gbmModel?: unknown;
  ridgeModel?: { coefficients: number[] };
}

export function ModelDocumentation() {
  const [data, setData] = useState<{
    models: PositionModelData[];
    featureImportance: Record<string, Array<{ key: string; label: string; category: string; importance: number }>>;
    rookieFeatureImportance?: Record<string, Array<{ key: string; label: string; category: string; importance: number }>>;
    rookiePreDraftFeatureImportance?: Record<string, Array<{ key: string; label: string; category: string; importance: number }>>;
    vetFeatureImportance?: Record<string, Array<{ key: string; label: string; category: string; importance: number }>>;
    ppgModels?: Array<{ position: string; n: number; cvR2Gbm: number; cvR2Ridge: number; cvMaeGbm: number; featureNames: string[] }>;
    residualModels?: Array<{ position: string; n: number; bestAlpha: number; backtest: any }>;
    draftSim2025?: {
      adpTeam: Array<{ name: string; position: string; adp: number; round: number; pick: number; actualPPG: number; modelPPG: number; isHit: boolean; isBust: boolean; isStarter?: boolean }>;
      modelTeam: Array<{ name: string; position: string; adp: number; round: number; pick: number; actualPPG: number; modelPPG: number; isHit: boolean; isBust: boolean; isStarter?: boolean }>;
      adpLineupPPG: number; adpSeasonPPR: number;
      modelLineupPPG: number; modelSeasonPPR: number;
      adpHits: number; adpBusts: number; modelHits: number; modelBusts: number;
      avgAdpPPG?: number; avgModelPPG?: number; avgDeltaPPG?: number;
      avgAdpHits?: number; avgAdpBusts?: number; avgModelHits?: number; avgModelBusts?: number;
      winsCount?: number; totalSims?: number; avgWinRate?: number;
      perPick?: Array<{ pick: number; adpPPG: number; modelPPG: number; delta: number; modelHits: number; adpHits: number; modelBusts: number; adpBusts: number; winRate?: number }>;
      settings: { numTeams: number; pickPosition?: number; rounds: number; season?: number; qbDeadline?: number; simsPerPick?: number };
    };
    shareModelSummary?: Record<string, { cvR2: number; cvMAE: number; n: number }>;
    rookieCareerModels?: Record<string, {
      n: number; cvR2: number; cvMAE: number; rankCorr: number; seasons: number;
      featureKeys: string[];
      topN: Record<number, { precision: number; recall: number; n: number }>;
      residualStd?: number;
      thresholds?: number[];
      thresholdTable?: {
        thresholds: number[];
        tiers: Array<{ label: string; min: number; max: number; n: number; hitRates: number[] }>;
      };
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPos, setSelectedPos] = useState('RB');
  const [modelType, setModelType] = useState<'gbm' | 'ridge'>('gbm');
  const [modelView, setModelView] = useState<'combined' | 'rookie' | 'rookie-predraft' | 'veteran'>('combined');
  const [modelCategory, setModelCategory] = useState<'vor' | 'ppg' | 'shares' | 'hitbust' | 'career'>('vor');

  useEffect(() => {
    async function load() {
      let d: any = null;
      try {
        const resp = await fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`);
        if (resp.ok) d = await resp.json();
      } catch { /* network error */ }

      // Fallback to localStorage
      if (!d || !d.models?.length) {
        try {
          const cached = localStorage.getItem('adp_features_v3_total_none');
          if (cached) d = JSON.parse(cached);
        } catch {}
      }

      if (d) {
        // Train career models at runtime if not present but rows are available
        let careerModels = d.rookieCareerModels;
        if ((!careerModels || Object.keys(careerModels).length === 0) && d.rows?.length > 0) {
          try {
            careerModels = trainRookieCareerModels(d.rows);
          } catch { /* training failed */ }
        }
        setData({
          models: d.models || [], featureImportance: d.featureImportance || {},
          rookieFeatureImportance: d.rookieFeatureImportance,
          rookiePreDraftFeatureImportance: d.rookiePreDraftFeatureImportance,
          vetFeatureImportance: d.vetFeatureImportance,
          ppgModels: d.ppgModels, residualModels: d.residualModels,
          draftSim2025: d.draftSim2025, shareModelSummary: d.shareModelSummary,
          rookieCareerModels: careerModels,
        });
      }
      setLoading(false);
    }
    load();
  }, []);

  const model = useMemo(
    () => data?.models.find((m) => m.position === selectedPos) || null,
    [data, selectedPos],
  );

  // Feature importance — precomputed at build time (GBM), or from Ridge coefficients
  const featureImportance = useMemo(() => {
    if (!model || !data) return [];

    if (modelType === 'gbm') {
      // Select the right importance map based on model view
      let precomputed: typeof data.featureImportance[string] | undefined;
      if (modelView === 'rookie') {
        precomputed = data.rookieFeatureImportance?.[selectedPos];
      } else if (modelView === 'rookie-predraft') {
        precomputed = data.rookiePreDraftFeatureImportance?.[selectedPos];
      } else if (modelView === 'veteran') {
        precomputed = data.vetFeatureImportance?.[selectedPos];
      } else {
        precomputed = data.featureImportance[selectedPos];
      }
      if (precomputed && precomputed.length > 0) return precomputed;
      // Fall back to combined if selected view not available
      const fallback = data.featureImportance[selectedPos];
      if (fallback && fallback.length > 0) return fallback;
    }

    // Ridge: use coefficients directly (always instant, only for combined view)
    if (model.ridgeModel && modelView === 'combined') {
      return model.featureNames
        .map((key, i) => {
          const def = FEATURES.find((f) => f.key === key);
          return {
            key,
            label: model.featureLabels[i],
            category: def?.category || 'Other',
            importance: Math.abs(model.ridgeModel!.coefficients[i]),
          };
        })
        .sort((a, b) => b.importance - a.importance);
    }
    return [];
  }, [model, data, selectedPos, modelType, modelView]);

  // Group features by category
  const featuresByCategory = useMemo(() => {
    const cats = new Map<string, typeof featureImportance>();
    for (const f of featureImportance) {
      if (!cats.has(f.category)) cats.set(f.category, []);
      cats.get(f.category)!.push(f);
    }
    return cats;
  }, [featureImportance]);

  // Category importance (sum of feature importances)
  const categoryImportance = useMemo(() => {
    const cats = new Map<string, number>();
    for (const f of featureImportance) {
      cats.set(f.category, (cats.get(f.category) || 0) + f.importance);
    }
    return [...cats.entries()]
      .map(([cat, imp]) => ({ category: cat, importance: imp, color: CATEGORY_COLORS[cat] || '#6b7280' }))
      .sort((a, b) => b.importance - a.importance);
  }, [featureImportance]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading model data...</div>
      </div>
    );
  }

  if (!data || data.models.length === 0) {
    return (
      <div className="empty-state">
        <h3>No Model Data Available</h3>
        <p>The model needs to be trained first. Visit the Draft Optimizer tab to trigger model training.</p>
      </div>
    );
  }

  return (
    <>
      {/* Methodology */}
      <div style={{ padding: '16px', maxWidth: 900 }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 20 }}>Model Documentation</h2>

        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 20, border: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Overview</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            StatHead uses a multi-stage prediction pipeline to evaluate fantasy football players.
            The system combines team-level volume projections with player-level models to identify
            players likely to outperform or underperform their draft position.
          </p>
        </div>

        {/* Stage 1: Team Volume */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 20, border: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Stage 1: Team Volume Projections</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            Team-level volumes (pass attempts, rush attempts, targets, TDs) are projected using a
            <strong> regression-to-mean blend</strong>: each team's prior-season totals are weighted against league
            averages to produce stable baseline projections. A <strong>delta model</strong> (Ridge regression with 11 features)
            predicts year-over-year volume changes from coaching changes, QB mobility, Vegas implied totals, and
            offensive trends. The projected team volumes flow into player-level share models.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '8px 0 0' }}>
            Key predictors of team volume changes: new QB (strongest signal), new head coach, QB rush attempts,
            Vegas implied points per game, prior win percentage, and 2-year passing trend.
          </p>
        </div>

        {/* Stage 1b: Team Volume Evaluation */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 20, border: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Team Volume Projection Accuracy</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 12px' }}>
            Backtested over {projectionConfig.testSeasons.length} seasons ({projectionConfig.testSeasons[projectionConfig.testSeasons.length - 1]}–{projectionConfig.testSeasons[0]}).
            Optimal blend: <strong>{Math.round(projectionConfig.winner.teamWeight * 100)}% team prior</strong> / <strong>{Math.round(projectionConfig.winner.leagueWeight * 100)}% league avg</strong> (selected
            from {projectionConfig.configsTested} configurations). Average error: <strong>{projectionConfig.avgPctError}%</strong>.
          </p>

          {/* Bar chart */}
          {(() => {
            const STAT_LABELS: Record<string, string> = {
              passAtt: 'Pass Att', passComp: 'Pass Comp', passYds: 'Pass Yds',
              passTD: 'Pass TDs', int: 'INTs', rushAtt: 'Rush Att',
              rushYds: 'Rush Yds', rushTD: 'Rush TDs', targets: 'Targets',
              receptions: 'Receptions', recYds: 'Rec Yds', recTD: 'Rec TDs',
            };
            const detail = projectionConfig.perStatDetail as Record<string, { mae: number; rmse: number; meanActual: number; pctError: number }>;
            const chartData = Object.entries(detail).map(([key, d]) => ({
              stat: STAT_LABELS[key] || key,
              pctError: d.pctError,
              mae: d.mae,
              meanActual: d.meanActual,
            }));
            const pctColor = (pct: number) => pct <= 10 ? '#22c55e' : pct <= 15 ? '#eab308' : pct <= 20 ? '#f97316' : '#ef4444';
            return (
              <>
                <div style={{ width: '100%', height: 260, marginBottom: 12 }}>
                  <ResponsiveContainer>
                    <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="stat" tick={{ fontSize: 10 }} interval={0} angle={-35} textAnchor="end" height={55} />
                      <YAxis tick={{ fontSize: 10 }} domain={[0, 30]} unit="%" />
                      <Tooltip
                        contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                        formatter={((value: number) => [`${value}%`, '% Error']) as any}
                      />
                      <Bar dataKey="pctError" radius={[4, 4, 0, 0]}>
                        {chartData.map((d, i) => <Cell key={i} fill={pctColor(d.pctError)} />)}
                        <LabelList dataKey="pctError" position="top" fontSize={9} formatter={((v: number) => `${v}%`) as any} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Per-stat table */}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border)' }}>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Stat</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>MAE</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>Mean Actual</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>% Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chartData.map((d) => (
                      <tr key={d.stat} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '5px 8px', fontWeight: 600 }}>{d.stat}</td>
                        <td style={{ textAlign: 'right', padding: '5px 8px' }}>{d.mae}</td>
                        <td style={{ textAlign: 'right', padding: '5px 8px' }}>{d.meanActual.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', padding: '5px 8px', color: pctColor(d.pctError), fontWeight: 700 }}>{d.pctError}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            );
          })()}
        </div>

        {/* Stage 2: Player VOR Model */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 20, border: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Stage 2: Player VOR Model</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            Separate models are trained per position (QB, RB, WR, TE) predicting <strong>VOR Score</strong> — total season
            PPR fantasy points above a positional replacement level (QB12, RB24, WR24, TE12), z-scored to be
            comparable across positions. +1.0σ = one standard deviation above the positional mean.
            Training data spans {data.models.reduce((s, m) => s + m.n, 0)} player-seasons from 2018-2025 with ADP ≤ 150.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '8px 0 0' }}>
            Position-specific tuning prevents overfitting: QB and TE use fewer features (20-24) with shallower
            trees (depth 2) and higher regularization due to smaller sample sizes. RB and WR use 50-80 features
            with deeper trees (depth 3). Feature selection uses a preliminary GBM to rank features by importance,
            keeping only the top K per position.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '8px 0 0' }}>
            Three model variants are evaluated: <strong>GBM</strong> (Gradient Boosted Trees),
            <strong> Ridge Regression</strong>, and a <strong>70/30 GBM+Ridge ensemble</strong>.
            A <strong>Rookie/Veteran split</strong> trains separate models for players with ≤1 year vs 2+ years in the league.
            All metrics use <strong>Leave-One-Season-Out cross-validation</strong> for honest out-of-sample estimates.
          </p>
        </div>

        {/* Stage 3: PPG Model */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 20, border: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Stage 3: ADP-Free PPG Model</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            A separate model predicts raw <strong>fantasy PPG</strong> (points per game) using all features
            <strong> except ADP-derived ones</strong> (8 ADP features excluded). This provides an ADP-independent
            assessment of player quality based purely on talent, situation, and opportunity signals.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '8px 0 0' }}>
            Comparing PPG model predictions to ADP-implied PPG reveals <strong>value gaps</strong>: players whose
            fundamentals predict higher PPG than their ADP suggests are potential values; players whose
            fundamentals predict lower PPG than ADP implies are bust risks.
          </p>
        </div>

        {/* Features overview */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 20, border: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Feature Categories ({FEATURES.length} total)</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            Prior season stats and efficiency metrics · Advanced analytics (WOPR, RACR, aDOT) ·
            Next Gen Stats (separation, RYOE, CPOE) · Combine measurables · NFL draft capital ·
            Injury history and recurrence risk · Roster competition and depth chart ·
            Coaching scheme tendencies (pace, pass rate, personnel) · Vegas implied totals and win probability ·
            Team projections (pass/rush volume) · Reddit sentiment (r/fantasyfootball mentions and hype) ·
            Strength of schedule · College production · Contract value and years · Age and aging curves ·
            2-year momentum trends · Feature interactions (ADP×age, PPG×snap%, etc.) ·
            QB impact on skill positions (rushing tendencies, passer rating) ·
            Weekly consistency (boom/bust rates) · Team environment (dome, O-line quality, roster turnover).
          </p>
        </div>

        {/* ── Model Evaluation Selector ── */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 20, border: '1px solid var(--border)' }}>
          {/* Row 1: Category selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)', marginRight: 4, minWidth: 60 }}>Evaluate:</span>
            {([
              { key: 'vor' as const, label: 'VOR Score', desc: 'Value Over Replacement' },
              { key: 'ppg' as const, label: 'PPG', desc: 'ADP-Free Points Per Game' },
              { key: 'shares' as const, label: 'Player Shares', desc: 'Team Volume Shares' },
              { key: 'hitbust' as const, label: 'Hit / Bust', desc: 'ADP-Residual Model' },
              { key: 'career' as const, label: 'Rookie Career', desc: 'Best 2-of-3 Seasons' },
            ]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setModelCategory(key)}
                style={{
                  padding: '6px 16px', borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  border: `2px solid ${modelCategory === key ? '#a78bfa' : 'var(--border)'}`,
                  background: modelCategory === key ? 'rgba(167,139,250,0.12)' : 'transparent',
                  color: modelCategory === key ? '#a78bfa' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Row 2: Position selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)', marginRight: 4, minWidth: 60 }}>Position:</span>
            {POSITIONS.map((pos) => {
              const disabled = modelCategory === 'shares' && pos === 'QB';
              return (
                <button
                  key={pos}
                  onClick={() => !disabled && setSelectedPos(pos)}
                  style={{
                    padding: '6px 16px', borderRadius: 6, fontWeight: 700, fontSize: 13,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.3 : 1,
                    border: `2px solid ${selectedPos === pos && !disabled ? POS_COLORS[pos] : 'var(--border)'}`,
                    background: selectedPos === pos && !disabled ? POS_COLORS[pos] + '22' : 'transparent',
                    color: selectedPos === pos && !disabled ? POS_COLORS[pos] : 'var(--text-secondary)',
                  }}
                >
                  {pos}
                </button>
              );
            })}

            {/* Model algo (VOR + PPG only) */}
            {(modelCategory === 'vor' || modelCategory === 'ppg') && (
              <>
                <span style={{ marginLeft: 16, fontSize: 13, color: 'var(--text-muted)' }}>Model:</span>
                {(['gbm', 'ridge'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => { setModelType(m); if (m === 'ridge') setModelView('combined'); }}
                    style={{
                      padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                      border: `2px solid ${modelType === m ? '#6366f1' : 'var(--border)'}`,
                      background: modelType === m ? 'rgba(99,102,241,0.12)' : 'transparent',
                      color: modelType === m ? '#6366f1' : 'var(--text-secondary)',
                    }}
                  >
                    {m === 'gbm' ? 'GBM' : 'Ridge'}
                  </button>
                ))}
              </>
            )}

            {/* View (VOR only, GBM only) */}
            {modelCategory === 'vor' && modelType === 'gbm' && (
              <>
                <span style={{ marginLeft: 16, fontSize: 13, color: 'var(--text-muted)' }}>View:</span>
                {([
                  { key: 'combined' as const, label: 'Combined' },
                  { key: 'veteran' as const, label: 'Veteran' },
                  { key: 'rookie' as const, label: 'Rookie' },
                  { key: 'rookie-predraft' as const, label: 'Rookie (Pre-Draft)' },
                ]).map(({ key, label }) => {
                  const hasData = key === 'combined'
                    ? true
                    : key === 'veteran'
                    ? !!data?.vetFeatureImportance?.[selectedPos]
                    : key === 'rookie'
                    ? !!data?.rookieFeatureImportance?.[selectedPos]
                    : !!data?.rookiePreDraftFeatureImportance?.[selectedPos];
                  return (
                    <button
                      key={key}
                      onClick={() => hasData && setModelView(key)}
                      style={{
                        padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 700,
                        cursor: hasData ? 'pointer' : 'not-allowed',
                        opacity: hasData ? 1 : 0.3,
                        border: `2px solid ${modelView === key ? '#14b8a6' : 'var(--border)'}`,
                        background: modelView === key ? 'rgba(20,184,166,0.12)' : 'transparent',
                        color: modelView === key ? '#14b8a6' : 'var(--text-secondary)',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* ── Metric Cards ── */}
        {model && modelCategory === 'vor' && (
          <>
            <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
              {[
                { label: 'Training Samples', value: model.n.toString(), color: 'var(--text-primary)' },
                { label: 'GBM CV R²', value: (model.cvR2Gbm ?? 0).toFixed(3), color: (model.cvR2Gbm ?? 0) > 0.1 ? '#22c55e' : (model.cvR2Gbm ?? 0) > 0 ? '#facc15' : '#ef4444' },
                { label: 'GBM CV MAE', value: (model.cvMaeGbm ?? 0).toFixed(3), color: 'var(--text-primary)' },
                { label: 'Ridge CV R²', value: (model.cvR2Ridge ?? 0).toFixed(3), color: (model.cvR2Ridge ?? 0) > 0.1 ? '#22c55e' : (model.cvR2Ridge ?? 0) > 0 ? '#facc15' : '#ef4444' },
                { label: 'Ridge CV MAE', value: (model.cvMaeRidge ?? 0).toFixed(3), color: 'var(--text-primary)' },
                { label: 'Ensemble R² (GBM+Ridge)', value: ((model as any).cvR2Ensemble ?? 0).toFixed(3), color: ((model as any).cvR2Ensemble ?? 0) > 0.1 ? '#22c55e' : ((model as any).cvR2Ensemble ?? 0) > 0 ? '#facc15' : '#ef4444' },
                { label: 'Rookie/Vet R²', value: ((model as any).cvR2RookieVet ?? 0).toFixed(3), color: ((model as any).cvR2RookieVet ?? 0) > 0.1 ? '#22c55e' : ((model as any).cvR2RookieVet ?? 0) > 0 ? '#facc15' : '#ef4444' },
                { label: 'Baseline R² (no proj)', value: (model.cvR2GbmBaseline ?? 0).toFixed(3), color: 'var(--text-muted)' },
                { label: 'Hit Rate', value: `${model.hitRate}%`, color: '#22c55e' },
                { label: 'Bust Rate', value: `${model.bustRate}%`, color: '#ef4444' },
              ].map((m) => (
                <div key={m.label} style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: '10px 16px', minWidth: 120,
                }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{m.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: m.color }}>{m.value}</div>
                </div>
              ))}
            </div>

            {/* Category importance chart */}
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>Feature Category Importance</h3>
            <div style={{ marginBottom: 20 }}>
              <ResponsiveContainer width="100%" height={Math.max(200, categoryImportance.length * 32)}>
                <BarChart data={categoryImportance} layout="vertical" margin={{ left: 120, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis type="number" stroke="var(--text-muted)" fontSize={10} />
                  <YAxis type="category" dataKey="category" stroke="var(--text-muted)" fontSize={11} width={110} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={((v: any) => [Number(v).toFixed(4), 'Importance']) as any}
                  />
                  <Bar dataKey="importance" radius={[0, 4, 4, 0]} maxBarSize={24}>
                    {categoryImportance.map((c) => (
                      <rect key={c.category} fill={c.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Top 20 individual features */}
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>
              Top {Math.min(20, featureImportance.length)} Features ({modelType === 'gbm' ? 'Avg |Contribution|' : '|Coefficient|'})
            </h3>
            <div style={{ marginBottom: 20 }}>
              <ResponsiveContainer width="100%" height={Math.min(20, featureImportance.length) * 28 + 40}>
                <BarChart
                  data={featureImportance.slice(0, 20).map((f) => ({
                    label: f.label,
                    value: f.importance,
                    fill: CATEGORY_COLORS[f.category] || '#6b7280',
                  }))}
                  layout="vertical"
                  margin={{ left: 180, right: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis type="number" stroke="var(--text-muted)" fontSize={10} />
                  <YAxis type="category" dataKey="label" stroke="var(--text-muted)" fontSize={11} width={170} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={((v: any) => [Number(v).toFixed(4), modelType === 'gbm' ? 'Avg Contribution' : 'Coefficient']) as any}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={20} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Full feature table by category */}
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>All {featureImportance.length} Features by Category</h3>
            {[...featuresByCategory.entries()].map(([category, features]) => (
              <div key={category} style={{ marginBottom: 16 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
                  padding: '4px 0', borderBottom: `2px solid ${CATEGORY_COLORS[category] || '#6b7280'}`,
                }}>
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: CATEGORY_COLORS[category] || '#6b7280',
                  }} />
                  <span style={{ fontWeight: 700, fontSize: 13, color: CATEGORY_COLORS[category] || 'var(--text-primary)' }}>
                    {category}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    ({features.length} features)
                  </span>
                </div>
                <div className="table-container">
                  <table style={{ fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 30 }}>#</th>
                        <th>Feature</th>
                        <th style={{ width: 100, textAlign: 'right' }}>Importance</th>
                        <th style={{ width: 200 }}>Bar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {features.map((f) => {
                        const maxImp = featureImportance[0]?.importance || 1;
                        const pct = (f.importance / maxImp) * 100;
                        const globalRank = featureImportance.indexOf(f) + 1;
                        return (
                          <tr key={f.key}>
                            <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{globalRank}</td>
                            <td>
                              <strong>{f.label}</strong>
                              <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>{f.key}</span>
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                              {(f.importance ?? 0).toFixed(4)}
                            </td>
                            <td>
                              <div style={{
                                height: 12, borderRadius: 3,
                                width: `${Math.max(1, pct)}%`,
                                background: CATEGORY_COLORS[f.category] || '#6b7280',
                                opacity: 0.7,
                              }} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {/* Cross-position VOR comparison table */}
            <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Cross-Position Comparison</h3>
            <div className="table-container">
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Position</th>
                    <th style={{ textAlign: 'right' }}>N</th>
                    <th style={{ textAlign: 'right' }}>GBM R²</th>
                    <th style={{ textAlign: 'right' }}>Ridge R²</th>
                    <th style={{ textAlign: 'right' }}>Ensemble R²</th>
                    <th style={{ textAlign: 'right' }}>R/V R²</th>
                    <th style={{ textAlign: 'right' }}>Rookie R²</th>
                    <th style={{ textAlign: 'right' }}>Vet R²</th>
                    <th style={{ textAlign: 'right' }}>Hit %</th>
                    <th style={{ textAlign: 'right' }}>Bust %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((m) => {
                    const ma = m as any;
                    return (
                      <tr key={m.position} style={{ background: m.position === selectedPos ? 'var(--bg-tertiary)' : undefined, cursor: 'pointer' }} onClick={() => setSelectedPos(m.position)}>
                        <td><strong style={{ color: POS_COLORS[m.position] }}>{m.position}</strong></td>
                        <td style={{ textAlign: 'right' }}>{m.n}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: (m.cvR2Gbm ?? 0) > 0.1 ? '#22c55e' : '#facc15' }}>{(m.cvR2Gbm ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right', color: (m.cvR2Ridge ?? 0) > 0.1 ? '#22c55e' : '#facc15' }}>{(m.cvR2Ridge ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: ((ma).cvR2Ensemble ?? 0) > 0.1 ? '#22c55e' : '#facc15' }}>{((ma).cvR2Ensemble ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right', color: ((ma).cvR2RookieVet ?? 0) > 0.1 ? '#22c55e' : '#facc15' }}>{((ma).cvR2RookieVet ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right', color: (ma.cvR2RookieOnly ?? 0) > 0 ? '#22c55e' : '#ef4444' }}>{(ma.cvR2RookieOnly ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right', color: (ma.cvR2VetOnly ?? 0) > 0.1 ? '#22c55e' : '#facc15' }}>{(ma.cvR2VetOnly ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right', color: '#22c55e' }}>{m.hitRate}%</td>
                        <td style={{ textAlign: 'right', color: '#ef4444' }}>{m.bustRate}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

          </>
        )}

        {/* ── PPG Model Cards ── */}
        {modelCategory === 'ppg' && (() => {
          const ppgModel = data.ppgModels?.find((m) => m.position === selectedPos);
          if (!ppgModel) return <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No PPG model data available for {selectedPos}.</p>;
          const r2Color = (v: number) => v > 0.3 ? '#22c55e' : v > 0.1 ? '#facc15' : v > 0 ? '#fb923c' : '#ef4444';
          return (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'Training Samples', value: ppgModel.n.toString(), color: 'var(--text-primary)' },
                  { label: 'GBM CV R²', value: (ppgModel.cvR2Gbm ?? 0).toFixed(3), color: r2Color(ppgModel.cvR2Gbm ?? 0) },
                  { label: 'Ridge CV R²', value: (ppgModel.cvR2Ridge ?? 0).toFixed(3), color: r2Color(ppgModel.cvR2Ridge ?? 0) },
                  { label: 'GBM CV MAE', value: (ppgModel.cvMaeGbm ?? 0).toFixed(1), color: 'var(--text-primary)' },
                  { label: 'Features', value: (ppgModel.featureNames?.length || 0).toString(), color: 'var(--text-primary)' },
                ].map((m) => (
                  <div key={m.label} style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '10px 16px', minWidth: 120,
                  }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{m.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: m.color }}>{m.value}</div>
                  </div>
                ))}
              </div>

              {/* Cross-position PPG table */}
              <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Cross-Position Comparison</h3>
              <div className="table-container">
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th style={{ textAlign: 'right' }}>N</th>
                      <th style={{ textAlign: 'right' }}>GBM R²</th>
                      <th style={{ textAlign: 'right' }}>Ridge R²</th>
                      <th style={{ textAlign: 'right' }}>GBM MAE</th>
                      <th style={{ textAlign: 'right' }}>Features</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ppgModels?.map((m) => (
                      <tr key={m.position} style={{ background: m.position === selectedPos ? 'var(--bg-tertiary)' : undefined, cursor: 'pointer' }} onClick={() => setSelectedPos(m.position)}>
                        <td><strong style={{ color: POS_COLORS[m.position] }}>{m.position}</strong></td>
                        <td style={{ textAlign: 'right' }}>{m.n}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: r2Color(m.cvR2Gbm ?? 0) }}>{(m.cvR2Gbm ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right', color: r2Color(m.cvR2Ridge ?? 0) }}>{(m.cvR2Ridge ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right' }}>{(m.cvMaeGbm ?? 0).toFixed(1)}</td>
                        <td style={{ textAlign: 'right' }}>{m.featureNames?.length || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}

        {/* ── Share Model Cards ── */}
        {modelCategory === 'shares' && (() => {
          const sm = data.shareModelSummary;
          if (!sm || Object.keys(sm).length === 0) return <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No share model data available. Run a build to generate.</p>;
          const pos = selectedPos === 'QB' ? 'RB' : selectedPos; // QB has no share models
          const shareTypes = [
            { label: 'Target Share', suffix: 'predTargetShare', positions: ['RB', 'WR', 'TE'] },
            { label: 'Rush Share', suffix: 'predRushShare', positions: ['RB'] },
            { label: 'Reception Share', suffix: 'predReceptionShare', positions: ['RB', 'WR', 'TE'] },
            { label: 'Rec Yds Share', suffix: 'predRecYdsShare', positions: ['RB', 'WR', 'TE'] },
            { label: 'Rush Yds Share', suffix: 'predRushYdsShare', positions: ['RB'] },
            { label: 'Pass TD Share', suffix: 'predPassTDShare', positions: ['RB', 'WR', 'TE'] },
            { label: 'Rush TD Share', suffix: 'predRushTDShare', positions: ['RB'] },
          ];
          const posShareTypes = shareTypes.filter(s => s.positions.includes(pos));
          const r2Color = (v: number) => v > 0.3 ? '#22c55e' : v > 0.1 ? '#facc15' : v > 0 ? '#fb923c' : '#ef4444';
          return (
            <>
              {/* Metric cards for selected position */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {posShareTypes.map(({ label, suffix }) => {
                  const key = `${pos}_${suffix}`;
                  const m = sm[key];
                  if (!m) return null;
                  return (
                    <div key={key} style={{
                      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                      borderRadius: 8, padding: '10px 16px', minWidth: 140,
                    }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
                      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>R²</div>
                          <div style={{ fontSize: 20, fontWeight: 700, color: r2Color(m.cvR2) }}>{m.cvR2.toFixed(3)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>MAE</div>
                          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>{m.cvMAE.toFixed(3)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>N</div>
                          <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{m.n}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Full cross-position share grid */}
              <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>All Positions</h3>
              <div className="table-container">
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Share Metric</th>
                      {['RB', 'WR', 'TE'].map(p => (
                        <th key={p} colSpan={2} style={{ textAlign: 'center', color: POS_COLORS[p] }}>{p}</th>
                      ))}
                    </tr>
                    <tr>
                      <th></th>
                      {['RB', 'WR', 'TE'].map(p => (
                        <React.Fragment key={p}>
                          <th style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)' }}>R²</th>
                          <th style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)' }}>MAE</th>
                        </React.Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shareTypes.map(({ label, suffix, positions }) => (
                      <tr key={suffix}>
                        <td style={{ fontWeight: 500 }}>{label}</td>
                        {['RB', 'WR', 'TE'].map(p => {
                          const key = `${p}_${suffix}`;
                          const m = sm[key];
                          if (!positions.includes(p) || !m) {
                            return (
                              <React.Fragment key={p}>
                                <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>—</td>
                                <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>—</td>
                              </React.Fragment>
                            );
                          }
                          return (
                            <React.Fragment key={p}>
                              <td style={{ textAlign: 'right', fontWeight: 700, color: r2Color(m.cvR2) }}>{m.cvR2.toFixed(3)}</td>
                              <td style={{ textAlign: 'right' }}>{m.cvMAE.toFixed(3)}</td>
                            </React.Fragment>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                Ensemble model (40% Ridge + 60% GBM). LOSO cross-validated.
                R² &gt; 0.3 = strong signal. TD shares are noisier due to small counts.
                WR/TE rush shares are carried forward from prior season (not predicted).
              </p>
            </>
          );
        })()}

        {/* ── Hit/Bust (Residual) Model Cards ── */}
        {modelCategory === 'hitbust' && (() => {
          const rm = data.residualModels?.find((m: any) => m.position === selectedPos) as any;
          if (!rm?.backtest) return <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No residual model data available for {selectedPos}.</p>;
          const b = rm.backtest;
          const blendBetter = b.blendedRankCorr > b.adpRankCorr;
          const delta = b.blendedRankCorr - b.adpRankCorr;
          const edge = b.topNModelHitRate - b.topNAdpHitRate;
          return (
            <>
              {/* Top-level metrics */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'ADP Rank Corr', value: b.adpRankCorr.toFixed(3), color: 'var(--text-secondary)' },
                  { label: 'Blended Rank Corr', value: b.blendedRankCorr.toFixed(3), color: blendBetter ? '#22c55e' : '#ef4444' },
                  { label: 'vs ADP', value: `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`, color: blendBetter ? '#22c55e' : '#ef4444' },
                  { label: `Best α`, value: b.bestAlpha.toString(), color: '#a78bfa' },
                  { label: 'Buy PPG', value: b.buyActualPPG.toFixed(1), color: b.buyActualPPG > b.sellActualPPG ? '#22c55e' : 'var(--text-secondary)' },
                  { label: 'Sell PPG', value: b.sellActualPPG.toFixed(1), color: 'var(--text-secondary)' },
                  { label: 'PPG Lift', value: `${b.liftPct > 0 ? '+' : ''}${b.liftPct}%`, color: b.liftPct > 0 ? '#22c55e' : '#ef4444' },
                  { label: 'Buy Hit Rate', value: `${b.buyHitRate}%`, color: '#22c55e' },
                  { label: 'Sell Hit Rate', value: `${b.sellHitRate}%`, color: 'var(--text-secondary)' },
                  { label: 'Buy Bust Rate', value: `${b.buyBustRate}%`, color: b.buyBustRate < b.sellBustRate ? '#22c55e' : '#ef4444' },
                  { label: 'Sell Bust Rate', value: `${b.sellBustRate}%`, color: '#ef4444' },
                  ...(b.topN ? [{ label: `Top-${b.topN} Edge`, value: `${edge > 0 ? '+' : ''}${edge}pp`, color: edge > 0 ? '#22c55e' : '#ef4444' }] : []),
                ].map((m) => (
                  <div key={m.label} style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '10px 16px', minWidth: 120,
                  }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{m.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: m.color }}>{m.value}</div>
                  </div>
                ))}
              </div>

              {/* Cross-position residual table */}
              <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Cross-Position Comparison</h3>
              <div className="table-container">
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th style={{ textAlign: 'right' }}>ADP Corr</th>
                      <th style={{ textAlign: 'right' }}>Blended</th>
                      <th style={{ textAlign: 'right' }}>vs ADP</th>
                      <th style={{ textAlign: 'right' }}>α</th>
                      <th style={{ textAlign: 'right' }}>Lift</th>
                      <th style={{ textAlign: 'right' }}>Buy Hit%</th>
                      <th style={{ textAlign: 'right' }}>Sell Bust%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.residualModels?.filter((m: any) => m.backtest?.blendedRankCorr).map((m: any) => {
                      const bt = m.backtest;
                      const better = bt.blendedRankCorr > bt.adpRankCorr;
                      const d = bt.blendedRankCorr - bt.adpRankCorr;
                      return (
                        <tr key={m.position} style={{ background: m.position === selectedPos ? 'var(--bg-tertiary)' : undefined, cursor: 'pointer' }} onClick={() => setSelectedPos(m.position)}>
                          <td><strong style={{ color: POS_COLORS[m.position] }}>{m.position}</strong></td>
                          <td style={{ textAlign: 'right' }}>{bt.adpRankCorr.toFixed(3)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: better ? '#22c55e' : '#ef4444' }}>{bt.blendedRankCorr.toFixed(3)}</td>
                          <td style={{ textAlign: 'right', color: better ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{d > 0 ? '+' : ''}{d.toFixed(3)}</td>
                          <td style={{ textAlign: 'right' }}>{bt.bestAlpha}</td>
                          <td style={{ textAlign: 'right', color: bt.liftPct > 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{bt.liftPct > 0 ? '+' : ''}{bt.liftPct}%</td>
                          <td style={{ textAlign: 'right', color: '#22c55e' }}>{bt.buyHitRate}%</td>
                          <td style={{ textAlign: 'right', color: '#ef4444' }}>{bt.sellBustRate}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                α controls how much the model adjusts ADP (α=0 = pure ADP, α=1 = full model).
                Hit = beat replacement level (VOR ≥ 0). Bust = 50+ PPR points below replacement.
                Lift = % PPG difference between buy and sell groups.
              </p>
            </>
          );
        })()}

        {/* ── Rookie Career Model Cards ── */}
        {modelCategory === 'career' && (() => {
          const cm = data.rookieCareerModels;
          if (!cm || Object.keys(cm).length === 0) return (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, textAlign: 'center' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--text-primary)' }}>No Rookie Career Model Data</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                Career model data needs to be generated by running the build pipeline.
                Visit the Draft Optimizer tab to trigger model training.
              </p>
            </div>
          );
          const m = cm[selectedPos];
          if (!m) return (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>No career model for <strong>{selectedPos}</strong>. Insufficient training data.</p>
            </div>
          );
          const r2Color = (v: number) => v > 0.3 ? '#22c55e' : v > 0.1 ? '#facc15' : v > 0 ? '#fb923c' : '#ef4444';
          // Heat map color: green for high hit rates, red for low
          const heatColor = (pct: number) => {
            if (pct >= 80) return { bg: 'rgba(34,197,94,0.45)', text: '#000' };
            if (pct >= 60) return { bg: 'rgba(34,197,94,0.30)', text: '#000' };
            if (pct >= 40) return { bg: 'rgba(34,197,94,0.15)', text: 'var(--text-primary)' };
            if (pct >= 20) return { bg: 'rgba(251,146,60,0.15)', text: 'var(--text-primary)' };
            if (pct > 5)  return { bg: 'rgba(239,68,68,0.18)', text: 'var(--text-primary)' };
            return { bg: 'rgba(239,68,68,0.35)', text: 'var(--text-secondary)' };
          };
          return (
            <>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Predicts the <strong>average of a rookie&apos;s best 2 PPG seasons</strong> in their first 3 NFL years
                using only pre-draft data (college stats, combine, draft pick). No NFL stats used.
                LOSO cross-validated across {m.seasons ?? '?'} draft classes.
              </p>

              {/* Regression metrics */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'Rookies', value: (m.n ?? 0).toString(), color: 'var(--text-primary)' },
                  { label: 'CV R²', value: (m.cvR2 ?? 0).toFixed(3), color: r2Color(m.cvR2 ?? 0) },
                  { label: 'CV MAE', value: (m.cvMAE ?? 0).toFixed(1), color: 'var(--text-primary)' },
                  { label: 'Rank Corr (ρ)', value: (m.rankCorr ?? 0).toFixed(3), color: (m.rankCorr ?? 0) > 0.3 ? '#22c55e' : (m.rankCorr ?? 0) > 0.1 ? '#facc15' : '#ef4444' },
                  { label: 'Features', value: (m.featureKeys?.length ?? 0).toString(), color: 'var(--text-secondary)' },
                ].map((c) => (
                  <div key={c.label} style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '10px 16px', minWidth: 120,
                  }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{c.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: c.color }}>{c.value}</div>
                  </div>
                ))}
              </div>

              {/* PPG Threshold Hit-Rate Table */}
              {m.thresholdTable && m.thresholdTable.tiers.some(t => t.n > 0) && (
                <>
                  <h3 style={{ fontSize: 16, margin: '0 0 4px', fontWeight: 800, textAlign: 'center' }}>
                    {selectedPos} (Best Two-Year Average; Years 1-3)
                  </h3>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, textAlign: 'center' }}>
                    Given the model&apos;s predicted PPG tier, what % of rookies actually hit each threshold?
                    Based on LOSO cross-validated predictions.
                  </p>
                  <div className="table-container" style={{ marginBottom: 20 }}>
                    <table style={{ fontSize: 13, borderCollapse: 'collapse', width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'right', padding: '8px 12px', borderBottom: '2px solid var(--border)', minWidth: 160 }}></th>
                          {m.thresholdTable.thresholds.map(t => (
                            <th key={t} style={{ textAlign: 'center', padding: '8px 12px', borderBottom: '2px solid var(--border)', fontWeight: 800, fontSize: 14, minWidth: 70 }}>
                              &gt;{t}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {m.thresholdTable.tiers.filter(tier => tier.n > 0).map((tier) => (
                          <tr key={tier.label}>
                            <td style={{ textAlign: 'right', padding: '7px 12px', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' }}>
                              {tier.label}
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>n={tier.n}</span>
                            </td>
                            {tier.hitRates.map((rate, i) => {
                              const c = heatColor(rate);
                              return (
                                <td key={i} style={{
                                  textAlign: 'center', padding: '7px 8px', fontWeight: 700, fontSize: 13,
                                  background: c.bg, color: c.text,
                                  borderBottom: '1px solid var(--border)',
                                }}>
                                  {rate.toFixed(1)}%
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* Probability model explanation */}
              {m.residualStd != null && m.residualStd > 0 && (
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                  <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>Threshold Probability Model</h4>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
                    Individual rookie probabilities are derived from the regression model using:
                    P(PPG &ge; T) = 1 - &Phi;((T - predicted) / &sigma;), where &sigma; = {m.residualStd.toFixed(2)} is
                    the LOSO cross-validated residual standard deviation. The table above shows empirical hit rates
                    by prediction tier; per-rookie probabilities on the Prospects tab use this normal approximation.
                  </p>
                </div>
              )}

              {/* Cross-position comparison */}
              <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Cross-Position Comparison</h3>
              <div className="table-container">
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th style={{ textAlign: 'right' }}>N</th>
                      <th style={{ textAlign: 'right' }}>R²</th>
                      <th style={{ textAlign: 'right' }}>MAE</th>
                      <th style={{ textAlign: 'right' }}>Rank ρ</th>
                      {[12, 24, 36].map(t => (
                        <th key={t} style={{ textAlign: 'right' }}>Top-{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {['QB', 'RB', 'WR', 'TE'].map(pos => {
                      const pm = cm[pos];
                      if (!pm) return (
                        <tr key={pos}>
                          <td><strong style={{ color: POS_COLORS[pos] }}>{pos}</strong></td>
                          <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>insufficient data</td>
                        </tr>
                      );
                      return (
                        <tr key={pos} style={{ background: pos === selectedPos ? 'var(--bg-tertiary)' : undefined, cursor: 'pointer' }} onClick={() => setSelectedPos(pos)}>
                          <td><strong style={{ color: POS_COLORS[pos] }}>{pos}</strong></td>
                          <td style={{ textAlign: 'right' }}>{pm.n}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: r2Color(pm.cvR2) }}>{pm.cvR2.toFixed(3)}</td>
                          <td style={{ textAlign: 'right' }}>{pm.cvMAE.toFixed(1)}</td>
                          <td style={{ textAlign: 'right', color: pm.rankCorr > 0.3 ? '#22c55e' : pm.rankCorr > 0.1 ? '#facc15' : '#ef4444' }}>{pm.rankCorr.toFixed(3)}</td>
                          {[12, 24, 36].map(t => {
                            const topN = pm.topN?.[t];
                            return (
                              <td key={t} style={{ textAlign: 'right', fontWeight: 600, color: topN && topN.n > 0 ? (topN.precision > 50 ? '#22c55e' : '#facc15') : 'var(--text-muted)' }}>
                                {topN && topN.n > 0 ? `${topN.precision}%` : '—'}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                Target = average of best 2 PPG seasons in first 3 NFL years. Minimum 4 games per season to qualify.
                Tiers are based on model&apos;s predicted PPG. Hit rates show % of that tier&apos;s rookies exceeding each threshold.
              </p>
            </>
          );
        })()}

        {model && (
          <>
            {/* Draft Simulation */}
            {data.draftSim2025 && data.draftSim2025.adpTeam.length > 0 && (() => {
              const sim = data.draftSim2025!;
              const season = sim.settings.season || 2025;
              const hasAvg = sim.avgDeltaPPG !== undefined;

              const renderTeam = (team: typeof sim.adpTeam, label: string, lineupPPG: number, hits: number, busts: number) => (
                <div style={{ flex: 1, minWidth: 280 }}>
                  <h4 style={{ fontSize: 13, margin: '0 0 6px', color: 'var(--text-secondary)' }}>{label}</h4>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                    Starters: <strong style={{ color: 'var(--text-primary)' }}>{lineupPPG} PPG</strong>
                    &nbsp;|&nbsp; Hits: <span style={{ color: '#22c55e' }}>{hits}</span> Busts: <span style={{ color: '#ef4444' }}>{busts}</span>
                  </div>
                  <div className="table-container">
                    <table style={{ fontSize: 11, width: '100%' }}>
                      <thead>
                        <tr>
                          <th>Rd</th>
                          <th>Player</th>
                          <th>Pos</th>
                          <th style={{ textAlign: 'right' }}>ADP</th>
                          <th style={{ textAlign: 'right' }}>Actual PPG</th>
                          <th style={{ textAlign: 'center' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {team.map((p, i) => (
                          <tr key={i} style={{ opacity: p.isStarter ? 1 : 0.5 }}>
                            <td>{p.round}</td>
                            <td style={{ fontWeight: p.isStarter ? 600 : 400, color: 'var(--text-primary)' }}>{p.name}</td>
                            <td style={{ color: POS_COLORS[p.position] || 'var(--text-secondary)' }}>{p.position}</td>
                            <td style={{ textAlign: 'right' }}>{Math.round(p.adp)}</td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{p.actualPPG.toFixed(1)}</td>
                            <td style={{ textAlign: 'center' }}>
                              {p.isHit ? <span style={{ color: '#22c55e' }}>&#x2713;</span> : p.isBust ? <span style={{ color: '#ef4444' }}>&#x2717;</span> : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );

              return (
                <>
                  <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Simulated {season} Draft</h3>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                    {sim.settings.numTeams}-team snake draft, {sim.settings.simsPerPick || 1} sims per pick position ({sim.totalSims} total drafts) with variance around each pick.
                    QB required before round {sim.settings.qbDeadline || 10}.
                    ADP drafter picks near top of board with slight noise. Optimized model drafter uses Value Over Next Available (VONA):
                    at each pick, estimates positional scarcity at the next turn and drafts the player whose value drops most if waited on.
                    Factors in starter vs bench marginal value, buy/sell residual signal, and full roster composition.
                    Other teams draft near ADP with variance. Trained on all seasons except {season} (honest out-of-sample).
                  </p>

                  {/* Average results banner */}
                  {hasAvg && (
                    <div style={{
                      padding: '12px 16px', margin: '8px 0',
                      borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                    }}>
                      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                        Average Across {sim.totalSims} Simulated Drafts
                        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                          ({sim.settings.simsPerPick || 1} sims &times; {sim.settings.numTeams} pick positions)
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>Starter PPG Delta: </span>
                          <strong style={{ color: (sim.avgDeltaPPG || 0) > 0 ? '#22c55e' : '#ef4444' }}>
                            {(sim.avgDeltaPPG || 0) > 0 ? '+' : ''}{sim.avgDeltaPPG} PPG/wk
                          </strong>
                          <span style={{ color: 'var(--text-muted)' }}> ({(sim.avgDeltaPPG || 0) > 0 ? '+' : ''}{Math.round((sim.avgDeltaPPG || 0) * 17)} season pts)</span>
                        </div>
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>Model win rate: </span>
                          <strong style={{ color: (sim.avgWinRate || 0) > 50 ? '#22c55e' : '#ef4444' }}>
                            {sim.avgWinRate || 0}%
                          </strong>
                          <span style={{ color: 'var(--text-muted)' }}> ({sim.winsCount}/{sim.settings.numTeams} picks avg better)</span>
                        </div>
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>Avg Hits: </span>
                          <strong style={{ color: (sim.avgModelHits || 0) > (sim.avgAdpHits || 0) ? '#22c55e' : 'var(--text-secondary)' }}>{sim.avgModelHits}</strong>
                          <span style={{ color: 'var(--text-muted)' }}> vs {sim.avgAdpHits}</span>
                        </div>
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>Avg Busts: </span>
                          <strong style={{ color: (sim.avgModelBusts || 0) < (sim.avgAdpBusts || 0) ? '#22c55e' : '#ef4444' }}>{sim.avgModelBusts}</strong>
                          <span style={{ color: 'var(--text-muted)' }}> vs {sim.avgAdpBusts}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Per-pick breakdown table */}
                  {sim.perPick && sim.perPick.length > 0 && (
                    <>
                      <h4 style={{ fontSize: 13, margin: '12px 0 4px', color: 'var(--text-secondary)' }}>Results by Pick Position</h4>
                      <div className="table-container">
                        <table style={{ fontSize: 12 }}>
                          <thead>
                            <tr>
                              <th>Pick</th>
                              <th style={{ textAlign: 'right' }}>ADP PPG</th>
                              <th style={{ textAlign: 'right' }}>Model PPG</th>
                              <th style={{ textAlign: 'right' }}>Delta</th>
                              <th style={{ textAlign: 'right' }}>Win%</th>
                              <th style={{ textAlign: 'right' }}>Hits (M/A)</th>
                              <th style={{ textAlign: 'right' }}>Busts (M/A)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sim.perPick.map((r) => (
                              <tr key={r.pick}>
                                <td style={{ fontWeight: 600 }}>#{r.pick}</td>
                                <td style={{ textAlign: 'right' }}>{r.adpPPG.toFixed(1)}</td>
                                <td style={{ textAlign: 'right' }}>{r.modelPPG.toFixed(1)}</td>
                                <td style={{ textAlign: 'right', color: r.delta > 0 ? '#22c55e' : r.delta < 0 ? '#ef4444' : 'var(--text-secondary)', fontWeight: 600 }}>
                                  {r.delta > 0 ? '+' : ''}{r.delta.toFixed(1)}
                                </td>
                                <td style={{ textAlign: 'right', color: (r.winRate || 0) > 50 ? '#22c55e' : (r.winRate || 0) < 50 ? '#ef4444' : 'var(--text-secondary)', fontWeight: 600 }}>
                                  {r.winRate || 0}%
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  <span style={{ color: r.modelHits > r.adpHits ? '#22c55e' : 'var(--text-secondary)', fontWeight: r.modelHits > r.adpHits ? 600 : 400 }}>{r.modelHits}</span>
                                  <span style={{ color: 'var(--text-muted)' }}>/{r.adpHits}</span>
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  <span style={{ color: r.modelBusts < r.adpBusts ? '#22c55e' : r.modelBusts > r.adpBusts ? '#ef4444' : 'var(--text-secondary)', fontWeight: r.modelBusts < r.adpBusts ? 600 : 400 }}>{r.modelBusts}</span>
                                  <span style={{ color: 'var(--text-muted)' }}>/{r.adpBusts}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {/* Example draft: pick #6 side-by-side */}
                  <h4 style={{ fontSize: 13, margin: '16px 0 4px', color: 'var(--text-secondary)' }}>Best Sim from Pick #6</h4>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {renderTeam(sim.adpTeam, 'ADP Drafter', sim.adpLineupPPG, sim.adpHits, sim.adpBusts)}
                    {renderTeam(sim.modelTeam, 'Model Drafter', sim.modelLineupPPG, sim.modelHits, sim.modelBusts)}
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                    Bold = starters (QB1, RB1-2, WR1-2, TE1, FLEX) set by draft order — earliest picks start.
                    Faded = bench. &#x2713; = hit (beat replacement), &#x2717; = bust (50+ PPR pts below replacement).
                    Starter PPG = sum of starters&apos; actual PPG. QB must be drafted before round {sim.settings.qbDeadline || 10}.
                  </p>
                </>
              );
            })()}

            {/* Model Pipeline Diagram */}
            <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Prediction Pipeline</h3>
            <div style={{
              background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px',
              border: '1px solid var(--border)', fontFamily: 'monospace', fontSize: 11,
              lineHeight: 1.8, color: 'var(--text-secondary)', overflowX: 'auto',
            }}>
              <div>{'┌─────────────────────────────────────────────────────────────┐'}</div>
              <div>{'│  Team Volume Projection (regression to mean + delta model)  │'}</div>
              <div>{'│  → projected pass att, rush att, targets, TDs per team      │'}</div>
              <div>{'└──────────────────────────┬──────────────────────────────────┘'}</div>
              <div>{'                           │'}</div>
              <div>{'                           ▼'}</div>
              <div>{'┌─────────────────────────────────────────────────────────────┐'}</div>
              <div>{'│  Player Share × Team Volume → Player Volume                 │'}</div>
              <div>{'│  target_share × team_targets = projected_targets             │'}</div>
              <div>{'│  rush_share × team_rushes = projected_carries                │'}</div>
              <div>{'│  + prior efficiency rates → mlProjPlayerPPG                 │'}</div>
              <div>{'└──────────────────────────┬──────────────────────────────────┘'}</div>
              <div>{'                           │'}</div>
              <div>{'     ┌──────────────┴──────────────┬─────────────────────┐'}</div>
              <div>{'     ▼                             ▼                     ▼'}</div>
              <div>{'┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐'}</div>
              <div>{'│  VOR Model      │  │  PPG Model      │  │  ADP-Residual Model │'}</div>
              <div>{'│  (with ADP)     │  │  (ADP-free)     │  │  (learns ADP errors)│'}</div>
              <div>{'│  GBM+Ridge      │  │  GBM+Ridge      │  │  target = actual -  │'}</div>
              <div>{'│  ensemble       │  │  ensemble       │  │  ADP-implied PPG    │'}</div>
              <div>{'└────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘'}</div>
              <div>{'         │                    │                      │'}</div>
              <div>{'         └─────────┬──────────┘            ADP + α × residual'}</div>
              <div>{'                   ▼                      (α tuned per position)'}</div>
              <div>{'  PPG prediction vs ADP-implied = VALUE or BUST'}</div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
