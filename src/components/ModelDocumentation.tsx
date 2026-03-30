import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import {
  POSITIONS, POS_COLORS, FEATURES, CATEGORY_COLORS,
} from '../lib/featureTypes';
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
    ppgModels?: Array<{ position: string; n: number; cvR2Gbm: number; cvR2Ridge: number; cvMaeGbm: number; featureNames: string[] }>;
    residualModels?: Array<{ position: string; n: number; bestAlpha: number; backtest: any }>;
    draftSim2025?: {
      adpTeam: Array<{ name: string; position: string; adp: number; round: number; pick: number; actualPPG: number; modelPPG: number; isHit: boolean; isBust: boolean }>;
      modelTeam: Array<{ name: string; position: string; adp: number; round: number; pick: number; actualPPG: number; modelPPG: number; isHit: boolean; isBust: boolean }>;
      adpLineupPPG: number; adpSeasonPPR: number;
      modelLineupPPG: number; modelSeasonPPR: number;
      adpHits: number; adpBusts: number; modelHits: number; modelBusts: number;
      settings: { numTeams: number; pickPosition: number; rounds: number; season?: number };
    };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPos, setSelectedPos] = useState('RB');
  const [modelType, setModelType] = useState<'gbm' | 'ridge'>('gbm');

  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`);
        if (resp.ok) {
          const d = await resp.json();
          setData({ models: d.models || [], featureImportance: d.featureImportance || {}, ppgModels: d.ppgModels, residualModels: d.residualModels, draftSim2025: d.draftSim2025 });
        }
      } catch { /* fallback to localStorage */
        try {
          const cached = localStorage.getItem('adp_features_v3_total_none');
          if (cached) {
            const d = JSON.parse(cached);
            setData({ models: d.models || [], featureImportance: d.featureImportance || {}, ppgModels: d.ppgModels, residualModels: d.residualModels, draftSim2025: d.draftSim2025 });
          }
        } catch {}
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
      // Use precomputed GBM importance (no runtime computation needed)
      const precomputed = data.featureImportance[selectedPos];
      if (precomputed && precomputed.length > 0) return precomputed;
    }

    // Ridge: use coefficients directly (always instant)
    if (model.ridgeModel) {
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
  }, [model, data, selectedPos, modelType]);

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

        {/* Position selector */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', marginRight: 4 }}>Position:</span>
          {POSITIONS.map((pos) => (
            <button
              key={pos}
              onClick={() => setSelectedPos(pos)}
              style={{
                padding: '6px 16px', borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                border: `2px solid ${selectedPos === pos ? POS_COLORS[pos] : 'var(--border)'}`,
                background: selectedPos === pos ? POS_COLORS[pos] + '22' : 'var(--bg-secondary)',
                color: selectedPos === pos ? POS_COLORS[pos] : 'var(--text-secondary)',
              }}
            >
              {pos}
            </button>
          ))}
          <span style={{ marginLeft: 16, fontSize: 13, color: 'var(--text-muted)' }}>Model:</span>
          {(['gbm', 'ridge'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setModelType(m)}
              style={{
                padding: '4px 12px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `2px solid ${modelType === m ? '#6366f1' : 'var(--border)'}`,
                background: modelType === m ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)',
                color: modelType === m ? '#6366f1' : 'var(--text-secondary)',
              }}
            >
              {m === 'gbm' ? 'GBM' : 'Ridge'}
            </button>
          ))}
        </div>

        {model && (
          <>
            {/* Validation metrics */}
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

            {/* Cross-position comparison */}
            <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Cross-Position Model Comparison</h3>
            <div className="table-container">
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Position</th>
                    <th style={{ textAlign: 'right' }}>N</th>
                    <th style={{ textAlign: 'right' }}>GBM R²</th>
                    <th style={{ textAlign: 'right' }}>GBM MAE</th>
                    <th style={{ textAlign: 'right' }}>Ridge R²</th>
                    <th style={{ textAlign: 'right' }}>Ensemble R²</th>
                    <th style={{ textAlign: 'right' }}>R/V R²</th>
                    <th style={{ textAlign: 'right' }}>Features</th>
                    <th style={{ textAlign: 'right' }}>Hit %</th>
                    <th style={{ textAlign: 'right' }}>Bust %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((m) => (
                    <tr key={m.position} style={{ background: m.position === selectedPos ? 'var(--bg-tertiary)' : undefined }}>
                      <td><strong style={{ color: POS_COLORS[m.position] }}>{m.position}</strong></td>
                      <td style={{ textAlign: 'right' }}>{m.n}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: (m.cvR2Gbm ?? 0) > 0.1 ? '#22c55e' : '#facc15' }}>{(m.cvR2Gbm ?? 0).toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }}>{(m.cvMaeGbm ?? 0).toFixed(3)}</td>
                      <td style={{ textAlign: 'right', color: (m.cvR2Ridge ?? 0) > 0.1 ? '#22c55e' : '#facc15' }}>{(m.cvR2Ridge ?? 0).toFixed(3)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: ((m as any).cvR2Ensemble ?? 0) > 0.1 ? '#22c55e' : '#facc15' }}>{((m as any).cvR2Ensemble ?? 0).toFixed(3)}</td>
                      <td style={{ textAlign: 'right', color: ((m as any).cvR2RookieVet ?? 0) > 0.1 ? '#22c55e' : '#facc15' }}>{((m as any).cvR2RookieVet ?? 0).toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }}>{m.featureNames.length}</td>
                      <td style={{ textAlign: 'right', color: '#22c55e' }}>{m.hitRate}%</td>
                      <td style={{ textAlign: 'right', color: '#ef4444' }}>{m.bustRate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Rookie vs Veteran Model Comparison */}
            <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Rookie vs Veteran Model Performance</h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              Separate GBM models trained for rookies (≤1 year) vs veterans (2+ years). Rookies rely more on college stats,
              draft capital, and combine data. Veterans rely more on prior NFL production, snap %, and target share.
            </p>
            <div className="table-container">
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Position</th>
                    <th style={{ textAlign: 'right' }}>Rookies N</th>
                    <th style={{ textAlign: 'right' }}>Rookie R²</th>
                    <th style={{ textAlign: 'right' }}>Rookie MAE</th>
                    <th style={{ textAlign: 'right' }}>Vets N</th>
                    <th style={{ textAlign: 'right' }}>Vet R²</th>
                    <th style={{ textAlign: 'right' }}>Vet MAE</th>
                    <th style={{ textAlign: 'right' }}>Combined R²</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((m) => {
                    const ma = m as any;
                    return (
                      <tr key={m.position} style={{ background: m.position === selectedPos ? 'var(--bg-tertiary)' : undefined }}>
                        <td><strong style={{ color: POS_COLORS[m.position] }}>{m.position}</strong></td>
                        <td style={{ textAlign: 'right' }}>{ma.nRookies ?? '?'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: (ma.cvR2RookieOnly ?? 0) > 0.1 ? '#22c55e' : (ma.cvR2RookieOnly ?? 0) > 0 ? '#facc15' : '#ef4444' }}>
                          {(ma.cvR2RookieOnly ?? 0).toFixed(3)}
                        </td>
                        <td style={{ textAlign: 'right' }}>{(ma.cvMaeRookieOnly ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right' }}>{ma.nVets ?? '?'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: (ma.cvR2VetOnly ?? 0) > 0.1 ? '#22c55e' : (ma.cvR2VetOnly ?? 0) > 0 ? '#facc15' : '#ef4444' }}>
                          {(ma.cvR2VetOnly ?? 0).toFixed(3)}
                        </td>
                        <td style={{ textAlign: 'right' }}>{(ma.cvMaeVetOnly ?? 0).toFixed(3)}</td>
                        <td style={{ textAlign: 'right', color: ((ma.cvR2RookieVet ?? 0) > 0.1 ? '#22c55e' : '#facc15') }}>
                          {(ma.cvR2RookieVet ?? 0).toFixed(3)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* PPG Model Comparison */}
            {data.ppgModels && data.ppgModels.length > 0 && (
              <>
                <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>ADP-Free PPG Model Comparison</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  Predicts raw fantasy PPG without any ADP information. Compares predicted PPG to ADP-implied PPG to find value.
                </p>
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
                      {data.ppgModels.map((m) => (
                        <tr key={m.position}>
                          <td><strong style={{ color: POS_COLORS[m.position] }}>{m.position}</strong></td>
                          <td style={{ textAlign: 'right' }}>{m.n}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: (m.cvR2Gbm ?? 0) > 0.1 ? '#22c55e' : (m.cvR2Gbm ?? 0) > 0 ? '#facc15' : '#ef4444' }}>{(m.cvR2Gbm ?? 0).toFixed(3)}</td>
                          <td style={{ textAlign: 'right', color: (m.cvR2Ridge ?? 0) > 0.1 ? '#22c55e' : (m.cvR2Ridge ?? 0) > 0 ? '#facc15' : '#ef4444' }}>{(m.cvR2Ridge ?? 0).toFixed(3)}</td>
                          <td style={{ textAlign: 'right' }}>{(m.cvMaeGbm ?? 0).toFixed(1)}</td>
                          <td style={{ textAlign: 'right' }}>{m.featureNames?.length || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* ADP-Residual Model Backtest */}
            {data.residualModels && data.residualModels.some((m: any) => m.backtest?.blendedRankCorr) && (
              <>
                <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Can the Model Beat ADP?</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  ADP-residual model: learns WHERE ADP is wrong, then adjusts.
                  Final prediction = ADP-implied PPG + &alpha; &times; model residual.
                  &alpha; is tuned per position via LOSO CV to maximize rank correlation.
                </p>

                <h4 style={{ fontSize: 13, margin: '16px 0 4px', color: 'var(--text-secondary)' }}>Ranking Accuracy (Spearman Correlation)</h4>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Does the blended prediction rank players better than ADP alone?
                </p>
                <div className="table-container">
                  <table style={{ fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>Position</th>
                        <th style={{ textAlign: 'right' }}>ADP Alone</th>
                        <th style={{ textAlign: 'right' }}>Model (&alpha;=1)</th>
                        <th style={{ textAlign: 'right' }}>Best &alpha;</th>
                        <th style={{ textAlign: 'right' }}>Blended</th>
                        <th style={{ textAlign: 'right' }}>vs ADP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.residualModels.filter((m: any) => m.backtest?.blendedRankCorr).map((m: any) => {
                        const b = m.backtest;
                        const blendBetter = b.blendedRankCorr > b.adpRankCorr;
                        const delta = b.blendedRankCorr - b.adpRankCorr;
                        return (
                          <tr key={m.position}>
                            <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{m.position}</td>
                            <td style={{ textAlign: 'right' }}>{b.adpRankCorr.toFixed(3)}</td>
                            <td style={{ textAlign: 'right', color: b.modelRankCorr > b.adpRankCorr ? '#22c55e' : '#ef4444' }}>{b.modelRankCorr.toFixed(3)}</td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{b.bestAlpha}</td>
                            <td style={{ textAlign: 'right', color: blendBetter ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{b.blendedRankCorr.toFixed(3)}</td>
                            <td style={{ textAlign: 'right', color: blendBetter ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{delta > 0 ? '+' : ''}{delta.toFixed(3)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <h4 style={{ fontSize: 13, margin: '16px 0 4px', color: 'var(--text-secondary)' }}>Buy vs Sell: PPG and Hit/Bust Rates</h4>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  When the model says &quot;buy&quot; (undervalued) or &quot;sell&quot; (overvalued) vs ADP, what actually happens?
                </p>
                <div className="table-container">
                  <table style={{ fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>Position</th>
                        <th style={{ textAlign: 'right' }}>Buy PPG</th>
                        <th style={{ textAlign: 'right' }}>Sell PPG</th>
                        <th style={{ textAlign: 'right' }}>Lift</th>
                        <th style={{ textAlign: 'right' }}>Buy Hit%</th>
                        <th style={{ textAlign: 'right' }}>Sell Hit%</th>
                        <th style={{ textAlign: 'right' }}>Buy Bust%</th>
                        <th style={{ textAlign: 'right' }}>Sell Bust%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.residualModels.filter((m: any) => m.backtest?.blendedRankCorr).map((m: any) => {
                        const b = m.backtest;
                        return (
                          <tr key={m.position}>
                            <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{m.position}</td>
                            <td style={{ textAlign: 'right', color: b.buyActualPPG > b.sellActualPPG ? '#22c55e' : 'var(--text-secondary)', fontWeight: 600 }}>{b.buyActualPPG.toFixed(1)}</td>
                            <td style={{ textAlign: 'right' }}>{b.sellActualPPG.toFixed(1)}</td>
                            <td style={{ textAlign: 'right', color: b.liftPct > 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{b.liftPct > 0 ? '+' : ''}{b.liftPct}%</td>
                            <td style={{ textAlign: 'right', color: b.buyHitRate > b.sellHitRate ? '#22c55e' : 'var(--text-secondary)', fontWeight: 600 }}>{b.buyHitRate}%</td>
                            <td style={{ textAlign: 'right' }}>{b.sellHitRate}%</td>
                            <td style={{ textAlign: 'right', color: b.buyBustRate < b.sellBustRate ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{b.buyBustRate}%</td>
                            <td style={{ textAlign: 'right' }}>{b.sellBustRate}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <h4 style={{ fontSize: 13, margin: '16px 0 4px', color: 'var(--text-secondary)' }}>Top-N Accuracy</h4>
                <div className="table-container">
                  <table style={{ fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>Position</th>
                        <th style={{ textAlign: 'right' }}>N</th>
                        <th style={{ textAlign: 'right' }}>Model Hit Rate</th>
                        <th style={{ textAlign: 'right' }}>ADP Hit Rate</th>
                        <th style={{ textAlign: 'right' }}>Edge</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.residualModels.filter((m: any) => m.backtest?.topN).map((m: any) => {
                        const b = m.backtest;
                        const edge = b.topNModelHitRate - b.topNAdpHitRate;
                        return (
                          <tr key={m.position}>
                            <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{m.position}</td>
                            <td style={{ textAlign: 'right' }}>Top-{b.topN}</td>
                            <td style={{ textAlign: 'right', color: edge > 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{b.topNModelHitRate}%</td>
                            <td style={{ textAlign: 'right' }}>{b.topNAdpHitRate}%</td>
                            <td style={{ textAlign: 'right', color: edge > 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{edge > 0 ? '+' : ''}{edge}pp</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                  &alpha; controls how much the model adjusts ADP (&alpha;=0 = pure ADP, &alpha;=1 = full model).
                  Hit = beat replacement level (VOR &ge; 0). Bust = 50+ PPR points below replacement.
                  Lift = % PPG difference between buy and sell groups. Green = model adds value vs ADP.
                </p>
              </>
            )}

            {/* 2025 Draft Simulation */}
            {data.draftSim2025 && data.draftSim2025.adpTeam.length > 0 && (() => {
              const sim = data.draftSim2025!;
              const ppgDelta = sim.modelLineupPPG - sim.adpLineupPPG;
              const pprDelta = sim.modelSeasonPPR - sim.adpSeasonPPR;

              const renderTeam = (team: typeof sim.adpTeam, label: string, lineupPPG: number, seasonPPR: number, hits: number, busts: number) => (
                <div style={{ flex: 1, minWidth: 280 }}>
                  <h4 style={{ fontSize: 13, margin: '0 0 6px', color: 'var(--text-secondary)' }}>{label}</h4>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                    Lineup: <strong style={{ color: 'var(--text-primary)' }}>{lineupPPG} PPG</strong> ({seasonPPR} season pts)
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
                          <tr key={i} style={{ opacity: i >= 7 ? 0.5 : 1 }}>
                            <td>{p.round}</td>
                            <td style={{ fontWeight: i < 7 ? 600 : 400, color: 'var(--text-primary)' }}>{p.name}</td>
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
                  <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Simulated {sim.settings.season || 2025} Draft</h3>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                    12-team snake draft, pick #{sim.settings.pickPosition}. ADP drafter always takes best available by ADP.
                    Model drafter uses the ADP-residual model to find value. Other teams draft by ADP.
                    Trained on all seasons except {sim.settings.season || 2025}, tested on {sim.settings.season || 2025} (honest out-of-sample).
                  </p>
                  <div style={{
                    display: 'flex', gap: 12, padding: '10px 12px', margin: '8px 0',
                    borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                    fontSize: 13, fontWeight: 600,
                  }}>
                    <span>Lineup Delta:</span>
                    <span style={{ color: ppgDelta > 0 ? '#22c55e' : ppgDelta < 0 ? '#ef4444' : 'var(--text-secondary)' }}>
                      {ppgDelta > 0 ? '+' : ''}{ppgDelta.toFixed(1)} PPG/week
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>|</span>
                    <span style={{ color: pprDelta > 0 ? '#22c55e' : pprDelta < 0 ? '#ef4444' : 'var(--text-secondary)' }}>
                      {pprDelta > 0 ? '+' : ''}{pprDelta} season points
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>|</span>
                    <span>
                      Hits: <span style={{ color: sim.modelHits > sim.adpHits ? '#22c55e' : 'var(--text-secondary)' }}>{sim.modelHits}</span> vs {sim.adpHits}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>|</span>
                    <span>
                      Busts: <span style={{ color: sim.modelBusts < sim.adpBusts ? '#22c55e' : '#ef4444' }}>{sim.modelBusts}</span> vs {sim.adpBusts}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {renderTeam(sim.adpTeam, 'ADP Drafter', sim.adpLineupPPG, sim.adpSeasonPPR, sim.adpHits, sim.adpBusts)}
                    {renderTeam(sim.modelTeam, 'Model Drafter', sim.modelLineupPPG, sim.modelSeasonPPR, sim.modelHits, sim.modelBusts)}
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                    Bold rows = starters (QB1, RB1-2, WR1-2, TE1, FLEX). Faded = bench.
                    &#x2713; = hit (beat replacement), &#x2717; = bust (50+ PPR pts below replacement).
                    Lineup PPG = sum of best starter PPGs.
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
