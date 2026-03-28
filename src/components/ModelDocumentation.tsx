import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { predictGBM } from '../lib/gbm';
import {
  POSITIONS, POS_COLORS, FEATURES, CATEGORY_COLORS,
  type PlayerRow,
} from '../lib/featureTypes';

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
    rows: PlayerRow[];
    models: PositionModelData[];
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
          setData({ rows: d.rows || [], models: d.models || [] });
        }
      } catch { /* fallback to localStorage */
        try {
          const cached = localStorage.getItem('adp_features_v3_total_none');
          if (cached) {
            const d = JSON.parse(cached);
            setData({ rows: d.rows || [], models: d.models || [] });
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

  // Compute feature importance from GBM
  const featureImportance = useMemo(() => {
    if (!model || !data) return [];

    if (modelType === 'gbm' && model.gbmModel) {
      const posRows = data.rows.filter((r) => r.position === selectedPos && r.adp <= 150);
      const contribSums = new Array(model.featureNames.length).fill(0);
      for (const row of posRows) {
        const result = predictGBM(model.gbmModel as any, row.features);
        for (const fc of result.featureContributions) {
          const idx = model.featureNames.indexOf(fc.name);
          if (idx >= 0) contribSums[idx] += Math.abs(fc.contribution);
        }
      }
      const n = posRows.length || 1;
      return model.featureNames
        .map((key, i) => {
          const def = FEATURES.find((f) => f.key === key);
          return {
            key,
            label: model.featureLabels[i],
            category: def?.category || 'Other',
            importance: contribSums[i] / n,
          };
        })
        .sort((a, b) => b.importance - a.importance);
    }

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
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Methodology</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            Separate models are trained for each position (QB, RB, WR, TE) predicting <strong>VOR Score</strong> — a z-scored
            Value Over Replacement metric that's comparable across positions (+1.0 = 1 standard deviation above the positional mean).
            Training data spans {data.rows.length} player-seasons from 2021-2025 with ADP ≤ 150.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '8px 0 0' }}>
            Two model types are trained: <strong>Gradient Boosted Trees</strong> (150 estimators, depth 3, learning rate 0.08)
            and <strong>Ridge Regression</strong> (λ=5). All metrics use <strong>Leave-One-Season-Out cross-validation</strong> —
            each season is held out while training on the others, providing honest out-of-sample estimates.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '8px 0 0' }}>
            Features include {FEATURES.length} signals spanning prior stats, advanced metrics (WOPR, RACR, aDOT),
            Next Gen Stats (separation, RYOE, CPOE), combine measurables, draft capital, injury history, roster competition,
            coaching/scheme tendencies, Vegas lines, team projections, and Reddit sentiment.
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
                { label: 'GBM CV R²', value: model.cvR2Gbm.toFixed(3), color: model.cvR2Gbm > 0.1 ? '#22c55e' : model.cvR2Gbm > 0 ? '#facc15' : '#ef4444' },
                { label: 'GBM CV MAE', value: model.cvMaeGbm.toFixed(3), color: 'var(--text-primary)' },
                { label: 'Ridge CV R²', value: model.cvR2Ridge.toFixed(3), color: model.cvR2Ridge > 0.1 ? '#22c55e' : model.cvR2Ridge > 0 ? '#facc15' : '#ef4444' },
                { label: 'Ridge CV MAE', value: model.cvMaeRidge.toFixed(3), color: 'var(--text-primary)' },
                { label: 'Baseline R² (no proj)', value: model.cvR2GbmBaseline.toFixed(3), color: 'var(--text-muted)' },
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
                              {f.importance.toFixed(4)}
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
                    <th style={{ textAlign: 'right' }}>Ridge MAE</th>
                    <th style={{ textAlign: 'right' }}>Baseline R²</th>
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
                      <td style={{ textAlign: 'right', fontWeight: 700, color: m.cvR2Gbm > 0.1 ? '#22c55e' : '#facc15' }}>{m.cvR2Gbm.toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }}>{m.cvMaeGbm.toFixed(3)}</td>
                      <td style={{ textAlign: 'right', color: m.cvR2Ridge > 0.1 ? '#22c55e' : '#facc15' }}>{m.cvR2Ridge.toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }}>{m.cvMaeRidge.toFixed(3)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{m.cvR2GbmBaseline.toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }}>{m.featureNames.length}</td>
                      <td style={{ textAlign: 'right', color: '#22c55e' }}>{m.hitRate}%</td>
                      <td style={{ textAlign: 'right', color: '#ef4444' }}>{m.bustRate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
