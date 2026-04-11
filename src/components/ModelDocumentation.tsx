import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import {
  POSITIONS, POS_COLORS, FEATURES, CATEGORY_COLORS,
} from '../lib/featureTypes';
import { trainRookieCareerModels } from '../lib/rookieCareerModel';
import { assemblePlayerRows } from '../lib/featureStoreClient';
import { InfoTip, PipelineDiagram, STAT_DEFS } from './ModelDocsHelpers';
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

function MobileBarList({
  items,
  format,
}: {
  items: Array<{ label: string; value: number; color: string }>;
  format: (v: number) => string;
}) {
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
      {items.map((item, idx) => {
        const pct = Math.max(2, (item.value / max) * 100);
        return (
          <div key={idx}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              fontSize: 11, marginBottom: 3, gap: 8,
            }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600, lineHeight: 1.2, flex: 1, minWidth: 0 }}>
                {item.label}
              </span>
              <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                {format(item.value)}
              </span>
            </div>
            <div style={{ background: 'var(--bg-tertiary)', borderRadius: 4, height: 10, overflow: 'hidden' }}>
              <div style={{
                width: `${pct}%`, height: '100%',
                background: item.color, borderRadius: 4,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface RookieSimPlayer {
  name: string;
  position: string;
  actualPPG: number;
  predictedPPG: number;
  nflPick: number;
}

interface RookieSimTeam {
  picks: Array<RookieSimPlayer & { round: number }>;
  starterPPG: number;
}

interface RookieSimResult {
  season: number;
  format: '1qb' | 'superflex';
  numTeams: number;
  rounds: number;
  adpTeam: RookieSimTeam;
  modelTeam: RookieSimTeam;
}

function simulateRookieDynastyDraft(
  rows: Array<{ name: string; position: string; draftSeason: number; actualPPG: number; predictedPPG: number; features?: Record<string, number> }>,
  format: '1qb' | 'superflex',
  season: number,
  pickPosition = 6,
): RookieSimResult | null {
  const numTeams = 12;
  const rounds = 4;
  const pool: RookieSimPlayer[] = rows
    .filter((r) => r.draftSeason === season && isFinite(r.actualPPG) && isFinite(r.predictedPPG))
    .map((r) => ({
      name: r.name,
      position: r.position,
      actualPPG: r.actualPPG,
      predictedPPG: r.predictedPPG,
      nflPick: r.features?.nflDraftPick ?? 300,
    }));
  if (pool.length < numTeams * rounds) return null;

  // ADP ordering: NFL draft pick (lower = better). Superflex bumps QBs up.
  const adpRank = (p: RookieSimPlayer): number => {
    const sfBonus = format === 'superflex' && p.position === 'QB' ? -40 : 0;
    return p.nflPick + sfBonus;
  };
  // Model ordering: predicted PPG (higher = better). Superflex applies a QB premium.
  const modelScore = (p: RookieSimPlayer): number => {
    const sfBonus = format === 'superflex' && p.position === 'QB' ? 6 : 0;
    return p.predictedPPG + sfBonus;
  };

  // Snake draft order across all picks
  const draftOrder: number[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let t = 0; t < numTeams; t++) {
      draftOrder.push(r % 2 === 0 ? t : numTeams - 1 - t);
    }
  }

  const taken = new Set<string>();
  const adpAvailable = [...pool].sort((a, b) => adpRank(a) - adpRank(b));
  const adpTeamPicks: Array<RookieSimPlayer & { round: number }> = [];
  const modelTeamPicks: Array<RookieSimPlayer & { round: number }> = [];

  for (let i = 0; i < draftOrder.length; i++) {
    const team = draftOrder[i];
    const round = Math.floor(i / numTeams) + 1;
    const isUserPick = team === pickPosition - 1;

    if (isUserPick) {
      // Model picks: best remaining by model score
      const remaining = pool.filter((p) => !taken.has(p.name));
      remaining.sort((a, b) => modelScore(b) - modelScore(a));
      const pick = remaining[0];
      if (pick) {
        taken.add(pick.name);
        modelTeamPicks.push({ ...pick, round });
      }
    } else {
      // ADP drafter: take next best available by ADP
      while (adpAvailable.length && taken.has(adpAvailable[0].name)) adpAvailable.shift();
      const pick = adpAvailable.shift();
      if (pick) {
        taken.add(pick.name);
        if (i % numTeams === pickPosition - 1) adpTeamPicks.push({ ...pick, round });
      }
    }
  }

  // Now run a parallel ADP-only sim for the same pick position to populate adpTeam fairly
  const taken2 = new Set<string>();
  const adpAvailable2 = [...pool].sort((a, b) => adpRank(a) - adpRank(b));
  const adpOnlyTeam: Array<RookieSimPlayer & { round: number }> = [];
  for (let i = 0; i < draftOrder.length; i++) {
    const team = draftOrder[i];
    const round = Math.floor(i / numTeams) + 1;
    while (adpAvailable2.length && taken2.has(adpAvailable2[0].name)) adpAvailable2.shift();
    const pick = adpAvailable2.shift();
    if (!pick) continue;
    taken2.add(pick.name);
    if (team === pickPosition - 1) adpOnlyTeam.push({ ...pick, round });
  }

  const starterPPG = (picks: RookieSimPlayer[]) =>
    picks.length ? Math.round((picks.reduce((s, p) => s + p.actualPPG, 0) / picks.length) * 10) / 10 : 0;

  return {
    season,
    format,
    numTeams,
    rounds,
    adpTeam: { picks: adpOnlyTeam, starterPPG: starterPPG(adpOnlyTeam) },
    modelTeam: { picks: modelTeamPicks, starterPPG: starterPPG(modelTeamPicks) },
  };
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
      featureImportance?: Array<{ key: string; importance: number; direction?: 'positive' | 'negative' }>;
      topN?: Record<number, { precision: number; recall: number; n: number }>;
      residualStd?: number;
      thresholds?: number[];
      thresholdMetrics?: Array<{
        threshold: number; accuracy: number; precision: number; recall: number;
        brierScore: number; baseRate: number; auc: number;
      }>;
      thresholdTable?: {
        thresholds: number[];
        tiers: Array<{ label: string; min: number; max: number; n: number; hitRates: number[] }>;
      };
      boomRate?: number;
      bustRate?: number;
      boomMetrics?: { auc: number; accuracy: number; precision: number; recall: number };
      bustMetrics?: { auc: number; accuracy: number; precision: number; recall: number };
      boomFeatureImportance?: Array<{ key: string; importance: number; direction?: 'positive' | 'negative' }>;
      bustFeatureImportance?: Array<{ key: string; importance: number; direction?: 'positive' | 'negative' }>;
      backtestRows?: Array<{
        name: string; position: string; draftSeason: number;
        actualPPG: number; predictedPPG: number;
        features?: Record<string, number>;
      }>;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPos, setSelectedPos] = useState('RB');
  const [modelType, setModelType] = useState<'gbm' | 'ridge'>('gbm');
  const [modelView, setModelView] = useState<'combined' | 'rookie' | 'rookie-predraft' | 'veteran'>('combined');
  const [modelCategory, setModelCategory] = useState<'vor' | 'ppg' | 'shares' | 'hitbust' | 'career' | 'rookie-boombust'>('vor');
  const [section, setSection] = useState<'projection' | 'rookie'>('projection');
  const [rookieSimFormat, setRookieSimFormat] = useState<'1qb' | 'superflex'>('1qb');

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
        // Use precomputed career models if available, train basic version at runtime only if missing entirely
        let careerModels = d.rookieCareerModels;
        if ((!careerModels || Object.keys(careerModels).length === 0)) {
          // Try assembling rows from feature store
          let rows = d.rows;
          if (!rows?.length) {
            try { rows = await assemblePlayerRows(); } catch {}
          }
          if (rows?.length > 0) {
            try { careerModels = trainRookieCareerModels(rows); } catch {}
          }
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

        {/* Section toggle */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {([
            { key: 'projection' as const, label: 'Projection Validation', desc: 'Veteran VOR / PPG / Hit-Bust' },
            { key: 'rookie' as const, label: 'Rookie Career Validation', desc: 'Best 2-of-3 PPG model' },
          ]).map(({ key, label, desc }) => (
            <button
              key={key}
              onClick={() => {
                setSection(key);
                if (key === 'projection') setModelCategory('vor');
                else setModelCategory('career');
              }}
              style={{
                flex: 1, padding: '12px 16px', borderRadius: 8, cursor: 'pointer',
                border: `2px solid ${section === key ? '#a78bfa' : 'var(--border)'}`,
                background: section === key ? 'rgba(167,139,250,0.12)' : 'transparent',
                color: section === key ? '#a78bfa' : 'var(--text-secondary)',
                textAlign: 'left',
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700 }}>{label}</div>
              <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{desc}</div>
            </button>
          ))}
        </div>

        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 20, border: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>
            {section === 'projection' ? 'Projection Pipeline Overview' : 'Rookie Career Pipeline Overview'}
          </h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 12px' }}>
            {section === 'projection' ? (
              <>StatHead\'s projection pipeline predicts veteran NFL fantasy production using team volume projections, player share models, and ADP-residual hit/bust classifiers. Validated via leave-one-season-out cross-validation across 2018-2025.</>
            ) : (
              <>StatHead\'s rookie career model predicts a player\'s best 2-of-3 PPG across their first 3 NFL seasons using only pre-draft features (college production, combine, draft capital). Validated via LOSO across 2018-2025 draft classes.</>
            )}
          </p>

          {/* Pipeline diagram */}
          {section === 'projection' ? (
            <PipelineDiagram
              steps={[
                { label: 'Team Volume Projection', desc: 'Pass attempts, rush attempts, targets per team (regression to mean + delta model)', color: '#3b82f6' },
                { label: 'Player Share Allocation', desc: 'Predict each player\'s share of team volume from prior production + competition', color: '#06b6d4' },
                { label: 'PPG Conversion', desc: 'Translate volume × efficiency into points per game', color: '#10b981' },
                { label: 'VOR + Hit/Bust Models', desc: 'GBM + Ridge ensemble vs ADP, with α-blended residual to flag outliers', color: '#a78bfa' },
                { label: 'Cross-Position Ranking', desc: 'Z-scored VOR comparable across QB/RB/WR/TE', color: '#ec4899' },
              ]}
            />
          ) : (
            <PipelineDiagram
              steps={[
                { label: 'Pre-Draft Features Only', desc: 'College stats, combine, draft capital, ZAP-style metrics — NO NFL data', color: '#3b82f6' },
                { label: 'LOSO Cross-Validation', desc: 'For each draft class, train on all OTHER classes; test on held-out class', color: '#06b6d4' },
                { label: 'Per-Threshold Classifiers', desc: 'P(best 2-of-3 PPG ≥ 12), ≥ 14, ≥ 16, ≥ 18 — separate binary models', color: '#10b981' },
                { label: 'Regression Predictor', desc: 'Direct best-2-of-3 PPG prediction (Ridge + Bagged GBM ensemble)', color: '#f59e0b' },
                { label: 'Cross-Year Percentile', desc: 'Rank predicted PPG vs ALL historical rookies at position (2018-2025)', color: '#a78bfa' },
                { label: 'Tier Assignment', desc: 'Alpha (95+), Blue Chip (85+), Starter (70+), Contributor (50+), Depth (30+), Longshot (<30)', color: '#ec4899' },
              ]}
            />
          )}

          {/* Validation stats explainer */}
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            <strong style={{ color: 'var(--text-secondary)' }}>Validation metrics</strong> (hover the <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, borderRadius: '50%', background: 'var(--bg-primary)', color: 'var(--text-muted)', fontSize: 8, fontWeight: 700 }}>?</span> icons throughout):
            <span style={{ marginLeft: 4 }}>
              R²<InfoTip title={STAT_DEFS.r2.title} description={STAT_DEFS.r2.desc} benchmark={STAT_DEFS.r2.benchmark} /> ·
              MAE<InfoTip title={STAT_DEFS.mae.title} description={STAT_DEFS.mae.desc} benchmark={STAT_DEFS.mae.benchmark} /> ·
              Rank Corr<InfoTip title={STAT_DEFS.rankCorr.title} description={STAT_DEFS.rankCorr.desc} benchmark={STAT_DEFS.rankCorr.benchmark} /> ·
              {section === 'projection' ? (
                <>Hit Rate<InfoTip title={STAT_DEFS.hitRate.title} description={STAT_DEFS.hitRate.desc} benchmark={STAT_DEFS.hitRate.benchmark} /></>
              ) : (
                <>
                  AUC<InfoTip title={STAT_DEFS.auc.title} description={STAT_DEFS.auc.desc} benchmark={STAT_DEFS.auc.benchmark} /> ·
                  Brier<InfoTip title={STAT_DEFS.brier.title} description={STAT_DEFS.brier.desc} benchmark={STAT_DEFS.brier.benchmark} /> ·
                  LOSO<InfoTip title={STAT_DEFS.loso.title} description={STAT_DEFS.loso.desc} benchmark={STAT_DEFS.loso.benchmark} /> ·
                  Best 2-of-3<InfoTip title={STAT_DEFS.bestOf3.title} description={STAT_DEFS.bestOf3.desc} benchmark={STAT_DEFS.bestOf3.benchmark} /> ·
                  Percentile<InfoTip title={STAT_DEFS.percentile.title} description={STAT_DEFS.percentile.desc} benchmark={STAT_DEFS.percentile.benchmark} />
                </>
              )}
            </span>
          </div>
        </div>

        {section === 'projection' && (<>
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
        </>)}

        {/* ── Model Evaluation Selector ── */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 20, border: '1px solid var(--border)' }}>
          {/* Row 1: Category selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)', marginRight: 4, minWidth: 60 }}>Evaluate:</span>
            {([
              { key: 'vor' as const, label: 'VOR Score', desc: 'Value Over Replacement', section: 'projection' as const },
              { key: 'ppg' as const, label: 'PPG', desc: 'ADP-Free Points Per Game', section: 'projection' as const },
              { key: 'shares' as const, label: 'Player Shares', desc: 'Team Volume Shares', section: 'projection' as const },
              { key: 'hitbust' as const, label: 'Hit / Bust', desc: 'ADP-Residual Model', section: 'projection' as const },
              { key: 'career' as const, label: 'Rookie Career', desc: 'Best 2-of-3 Seasons', section: 'rookie' as const },
              { key: 'rookie-boombust' as const, label: 'Rookie Boom/Bust', desc: 'Outlier Overlay', section: 'rookie' as const },
            ]).filter(({ section: s }) => s === section).map(({ key, label }) => (
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
              <MobileBarList
                items={categoryImportance.map((c) => ({ label: c.category, value: c.importance, color: c.color }))}
                format={(v) => v.toFixed(4)}
              />
            </div>

            {/* Top 20 individual features */}
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>
              Top {Math.min(20, featureImportance.length)} Features ({modelType === 'gbm' ? 'Avg |Contribution|' : '|Coefficient|'})
            </h3>
            <div style={{ marginBottom: 20 }}>
              <MobileBarList
                items={featureImportance.slice(0, 20).map((f) => ({
                  label: f.label,
                  value: f.importance,
                  color: CATEGORY_COLORS[f.category] || '#6b7280',
                }))}
                format={(v) => v.toFixed(4)}
              />
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
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                Note: PPG model R² corrected after removing data-leaking features (current-season actual share data).
                Prior metrics were inflated by up to 0.26 R² (RB). Current metrics are honest LOSO on pre-season features.
                Pipeline: (1) leakage fix → honest baseline, (2) ablation-driven pruning (<code>scripts/ablate_ppg_features.py</code>)
                 to 19/21/22/14 features, (3) multi-year derived features (priorPPG2yr for QB/RB/WR, durabilityStreak for TE),
                (4) per-position hyperparameter tuning (<code>scripts/sweep_ppg_hyperparams.py</code>), (5) forward-selection
                of populated-but-unused features — RB finally broke through its 0.504 plateau by adding combine athleticism
                (forty), coarser draft-capital encoding (nflDraftRound), and schedule difficulty (sosAvgSpread).
                Cumulative lift vs honest baseline: QB +0.021, RB +0.023, WR +0.018, TE +0.013.
              </p>
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

              {/* ADP Hit/Bust Classifier Validation */}
              <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>ADP Hit/Bust Classifiers</h3>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                Dedicated binary classifiers for hit (VOR &gt; 67th pctl) and bust (VOR &lt; 33rd pctl) prediction.
                LOSO cross-validated on clean features (no data leakage from current-season actuals).
              </p>
              <div className="table-container">
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th style={{ textAlign: 'right' }}>N</th>
                      <th style={{ textAlign: 'right' }}>Hit Rate</th>
                      <th style={{ textAlign: 'right' }}>Hit AUC</th>
                      <th style={{ textAlign: 'right' }}>Bust Rate</th>
                      <th style={{ textAlign: 'right' }}>Bust AUC</th>
                      <th style={{ textAlign: 'right' }}>PPG R²</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { pos: 'QB', n: 595, hr: '35%', hauc: '—', br: '28%', bauc: '—', r2: '0.599' },
                      { pos: 'RB', n: 1270, hr: '13%', hauc: '0.756', br: '26%', bauc: '0.755', r2: '0.532' },
                      { pos: 'WR', n: 1731, hr: '20%', hauc: '0.689', br: '28%', bauc: '0.849', r2: '0.597' },
                      { pos: 'TE', n: 732, hr: '24%', hauc: '0.837', br: '36%', bauc: '0.805', r2: '0.607' },
                    ].map(r => (
                      <tr key={r.pos} style={{ background: r.pos === selectedPos ? 'var(--bg-tertiary)' : undefined }}>
                        <td><strong style={{ color: POS_COLORS[r.pos] }}>{r.pos}</strong></td>
                        <td style={{ textAlign: 'right' }}>{r.n}</td>
                        <td style={{ textAlign: 'right', color: '#22c55e' }}>{r.hr}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#22c55e' }}>{r.hauc}</td>
                        <td style={{ textAlign: 'right', color: '#ef4444' }}>{r.br}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#ef4444' }}>{r.bauc}</td>
                        <td style={{ textAlign: 'right' }}>{r.r2}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                AUCs are within-tier controlled — not inflated by ADP position. Within ADP 1-50:
                WR bust AUC 0.912 (53% high-risk bust vs 1% safe), TE bust AUC 0.882 (67% vs 0%).
                Model edge over ADP-only: +0.16 to +0.34 within tier. Signal comes from prior
                production (priorPPG, priorTargets, priorSnapPct), not just draft position.
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Note: ADP model R² corrected after removing data-leaking features (current-season actual share data).
                Prior metrics were inflated by up to 0.22 R² (RB). Current metrics are honest LOSO on pre-season features.
              </p>

              <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>No-Production Bust Signal</h3>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                Players drafted ADP 1-100 with <strong>zero prior NFL production</strong> (priorSnap &lt; 10%, priorTargets &lt; 10)
                bust at <strong>50-70%</strong> rates. These are young players drafted on hype and dynasty capital without a track record.
                The draft simulator applies a heavy penalty to these players in early rounds.
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Recent examples: Jameson Williams (ADP 12, PPG 2.5), Treylon Burks (ADP 18, PPG 1.5),
                Jonathan Mingo (ADP 39, PPG 2.3), Michael Mayer (ADP 35, PPG 6.0),
                Zamir White (ADP 68, PPG 3.7). All had priorSnap=0%.
              </p>

              <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Late-Round Boom Classifier (Positional)</h3>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                Binary classifier keyed on <strong>positional ADP rank</strong> rather than raw ADP —
                matches how drafters think (tiered by position). Each position has its own late-pick and
                boom thresholds scaled to scarcity: QB12+ → top-5, RB24+ → top-12, WR36+ → top-18, TE10+ → top-5.
              </p>
              <div className="table-container">
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th style={{ textAlign: 'right' }}>Late / Boom</th>
                      <th style={{ textAlign: 'right' }}>N</th>
                      <th style={{ textAlign: 'right' }}>Base Rate</th>
                      <th style={{ textAlign: 'right' }}>AUC</th>
                      <th style={{ textAlign: 'right' }}>High Score Boom%</th>
                      <th style={{ textAlign: 'right' }}>Low Score Boom%</th>
                      <th style={{ textAlign: 'right' }}>Separation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { pos: 'QB', thr: 'QB12+ → top-5',  n: 426,  base: '8%', auc: '0.678', high: '11%', low: '1%', sep: '11.2x' },
                      { pos: 'RB', thr: 'RB24+ → top-12', n: 916,  base: '4%', auc: '0.633', high: '8%',  low: '2%', sep: '3.8x' },
                      { pos: 'WR', thr: 'WR36+ → top-18', n: 1204, base: '5%', auc: '0.819', high: '16%', low: '1%', sep: '15.9x' },
                      { pos: 'TE', thr: 'TE10+ → top-5',  n: 607,  base: '6%', auc: '0.770', high: '14%', low: '1%', sep: '13.8x' },
                    ].map(r => (
                      <tr key={r.pos} style={{ background: r.pos === selectedPos ? 'var(--bg-tertiary)' : undefined }}>
                        <td><strong style={{ color: POS_COLORS[r.pos] }}>{r.pos}</strong></td>
                        <td style={{ textAlign: 'right', fontSize: 11 }}>{r.thr}</td>
                        <td style={{ textAlign: 'right' }}>{r.n}</td>
                        <td style={{ textAlign: 'right' }}>{r.base}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#22c55e' }}>{r.auc}</td>
                        <td style={{ textAlign: 'right', color: '#22c55e' }}>{r.high}</td>
                        <td style={{ textAlign: 'right', color: '#ef4444' }}>{r.low}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{r.sep}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                Positional ranking sharpens the signal significantly: WR AUC jumped from 0.734 → 0.819,
                separation from 5.0x → 15.9x. QB is new (was excluded when using raw ADP 100+).
                TE's base rate normalized from an inflated 40% → a realistic 6% with cleaner separation (13.8x).
                Top drivers: WR depthChartRank + adp/adpPosRank, TE priorPPG + priorGames, QB team context
                (vegasWinPct, teamPace, teamElitePassCatchers), RB adpPosRank + depthChartRank.
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

              {/* Per-Threshold Classifier Metrics */}
              {m.thresholdMetrics && m.thresholdMetrics.length > 0 && (
                <>
                  <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>Threshold Classifier Performance</h3>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                    Separate binary classifiers trained per threshold. AUC &gt; 50% = better than random.
                    Brier score closer to 0 = better calibrated probabilities.
                  </p>
                  <div className="table-container" style={{ marginBottom: 20 }}>
                    <table style={{ fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th>Threshold</th>
                          <th style={{ textAlign: 'right' }}>Base Rate</th>
                          <th style={{ textAlign: 'right' }}>AUC</th>
                          <th style={{ textAlign: 'right' }}>Accuracy</th>
                          <th style={{ textAlign: 'right' }}>Precision</th>
                          <th style={{ textAlign: 'right' }}>Recall</th>
                          <th style={{ textAlign: 'right' }}>Brier</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.thresholdMetrics.map(tm => (
                          <tr key={tm.threshold}>
                            <td style={{ fontWeight: 700 }}>&gt;{tm.threshold} PPG</td>
                            <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{tm.baseRate}%</td>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: tm.auc > 60 ? '#22c55e' : tm.auc > 50 ? '#facc15' : '#ef4444' }}>{tm.auc}%</td>
                            <td style={{ textAlign: 'right' }}>{tm.accuracy}%</td>
                            <td style={{ textAlign: 'right' }}>{tm.precision}%</td>
                            <td style={{ textAlign: 'right' }}>{tm.recall}%</td>
                            <td style={{ textAlign: 'right', color: tm.brierScore < 0.2 ? '#22c55e' : tm.brierScore < 0.3 ? '#facc15' : '#ef4444' }}>{tm.brierScore.toFixed(3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* AUC per threshold */}
                  <div style={{ marginBottom: 20 }}>
                    {(() => {
                      const aucColor = (v: number) => v > 65 ? '#22c55e' : v > 55 ? '#facc15' : v > 50 ? '#fb923c' : '#ef4444';
                      return (
                        <MobileBarList
                          items={m.thresholdMetrics!.map(tm => ({
                            label: `>${tm.threshold} PPG`,
                            value: tm.auc,
                            color: aucColor(tm.auc),
                          }))}
                          format={(v) => `${v.toFixed(0)}% AUC`}
                        />
                      );
                    })()}
                  </div>
                </>
              )}

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

              {/* Feature importance */}
              {m.featureImportance && m.featureImportance.length > 0 && (() => {
                const fiData = m.featureImportance.map(f => {
                  const def = FEATURES.find(fd => fd.key === f.key);
                  const dirLabel = f.direction === 'positive' ? ' ↑' : f.direction === 'negative' ? ' ↓' : '';
                  return { name: (def?.label || f.key) + dirLabel, importance: f.importance, key: f.key };
                });
                return (
                  <>
                    <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Feature Contributions ({selectedPos})</h3>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                      Normalized ridge coefficient magnitudes — larger bars indicate features with more influence on predicted PPG.
                    </p>
                    <div style={{ marginBottom: 20 }}>
                      <MobileBarList
                        items={fiData.map((d, idx) => ({
                          label: d.name,
                          value: d.importance,
                          color: idx === 0 ? '#a78bfa' : idx < 3 ? '#818cf8' : '#6366f1',
                        }))}
                        format={(v) => `${(v * 100).toFixed(1)}%`}
                      />
                    </div>
                  </>
                );
              })()}

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

              {/* ── Simulated Dynasty Rookie Draft ── */}
              {(() => {
                const allRows: Array<{ name: string; position: string; draftSeason: number; actualPPG: number; predictedPPG: number; features?: Record<string, number> }> = [];
                for (const pos of Object.keys(cm)) {
                  const rows = cm[pos]?.backtestRows;
                  if (rows) allRows.push(...rows);
                }
                if (allRows.length === 0) return null;
                const seasons = Array.from(new Set(allRows.map((r) => r.draftSeason))).sort((a, b) => b - a);
                const season = seasons[0];
                const sim = simulateRookieDynastyDraft(allRows, rookieSimFormat, season);
                if (!sim) return null;
                const delta = Math.round((sim.modelTeam.starterPPG - sim.adpTeam.starterPPG) * 10) / 10;
                const renderTeam = (team: typeof sim.adpTeam, label: string) => (
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <h4 style={{ fontSize: 13, margin: '0 0 6px', color: 'var(--text-secondary)' }}>{label}</h4>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                      Avg actual PPG: <strong style={{ color: 'var(--text-primary)' }}>{team.starterPPG}</strong>
                    </div>
                    <div className="table-container">
                      <table style={{ fontSize: 11, width: '100%' }}>
                        <thead>
                          <tr>
                            <th>Rd</th>
                            <th>Player</th>
                            <th>Pos</th>
                            <th style={{ textAlign: 'right' }}>NFL Pk</th>
                            <th style={{ textAlign: 'right' }}>Pred</th>
                            <th style={{ textAlign: 'right' }}>Actual</th>
                          </tr>
                        </thead>
                        <tbody>
                          {team.picks.map((p, i) => (
                            <tr key={i}>
                              <td>{p.round}</td>
                              <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</td>
                              <td style={{ color: POS_COLORS[p.position] || 'var(--text-secondary)' }}>{p.position}</td>
                              <td style={{ textAlign: 'right' }}>{p.nflPick >= 300 ? 'UDFA' : p.nflPick}</td>
                              <td style={{ textAlign: 'right' }}>{p.predictedPPG.toFixed(1)}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600 }}>{p.actualPPG.toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
                return (
                  <>
                    <h3 style={{ fontSize: 15, margin: '24px 0 8px' }}>Simulated Dynasty Rookie Draft ({season})</h3>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                      {sim.numTeams}-team, {sim.rounds}-round snake rookie draft using LOSO out-of-sample predictions
                      from the {season} class. The ADP drafter picks by NFL draft order; the model drafter picks by
                      predicted best 2-of-3 PPG. Superflex bumps QBs in both rankings (NFL pick &minus;40, model +6 PPG).
                    </p>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Format:</span>
                      {(['1qb', 'superflex'] as const).map((f) => (
                        <button
                          key={f}
                          onClick={() => setRookieSimFormat(f)}
                          style={{
                            padding: '5px 14px', borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: 'pointer',
                            border: `2px solid ${rookieSimFormat === f ? '#a78bfa' : 'var(--border)'}`,
                            background: rookieSimFormat === f ? 'rgba(167,139,250,0.12)' : 'transparent',
                            color: rookieSimFormat === f ? '#a78bfa' : 'var(--text-secondary)',
                          }}
                        >
                          {f === '1qb' ? '1QB' : 'Superflex'}
                        </button>
                      ))}
                    </div>
                    <div style={{
                      padding: '10px 14px', marginBottom: 12,
                      borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                      fontSize: 13,
                    }}>
                      <span style={{ color: 'var(--text-muted)' }}>Model vs ADP starter PPG: </span>
                      <strong style={{ color: delta > 0 ? '#22c55e' : delta < 0 ? '#ef4444' : 'var(--text-primary)' }}>
                        {delta > 0 ? '+' : ''}{delta} PPG
                      </strong>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                        ({sim.modelTeam.starterPPG} vs {sim.adpTeam.starterPPG})
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      {renderTeam(sim.adpTeam, 'ADP Drafter')}
                      {renderTeam(sim.modelTeam, 'Model Drafter')}
                    </div>
                  </>
                );
              })()}
            </>
          );
        })()}

        {/* ── Rookie Boom/Bust Overlay ── */}
        {modelCategory === 'rookie-boombust' && (() => {
          const cm = data.rookieCareerModels;
          if (!cm || Object.keys(cm).length === 0) return (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, textAlign: 'center' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--text-primary)' }}>No Boom/Bust Data</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                Boom/bust data is generated during the build pipeline.
              </p>
            </div>
          );
          const m = cm[selectedPos] as any;
          if (!m) return (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>No data for <strong>{selectedPos}</strong>.</p>
            </div>
          );
          const cond = m.conditionalResiduals;
          return (
            <>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                Two separate pre-draft models for boom and bust prediction:
              </p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                <strong style={{ color: '#22c55e' }}>Boom Model</strong>: Talent-vs-draft outperformance predictor. Uses athleticism gaps
                (speed/RAS vs draft position), college production peaks, and age to identify players whose physical profile
                exceeds what their draft capital implies. Trained on percentile rank outperformance (actual rank - predicted rank).
              </p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                <strong style={{ color: '#ef4444' }}>Bust Model</strong>: Binary classifier for picks 1-24 bust avoidance.
                Predicts P(actual &lt; position median) using speed deficits, missing athletic data, age risk, and production gaps.
                LOSO AUC: RB 0.651, WR 0.672, TE 0.701 on top-25% predicted players.
                High-risk group busts at 25-31% vs safe group at 0-7%.
              </p>

              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'Overall Boom Rate', value: `${m.boomRate ?? '—'}%`, color: '#22c55e' },
                  { label: 'Overall Bust Rate', value: `${m.bustRate ?? '—'}%`, color: '#ef4444' },
                  { label: 'Residual Std (overall)', value: m.residualStd?.toFixed(2) ?? '—', color: 'var(--text-primary)' },
                  { label: 'MAE', value: m.cvMAE?.toFixed(1) ?? '—', color: 'var(--text-primary)' },
                ].map(c => (
                  <div key={c.label} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', minWidth: 100 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{c.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
                  </div>
                ))}
              </div>

              {cond && cond.bins && cond.bins.length > 0 && (
                <>
                  <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>Variance by Prediction Tier ({selectedPos})</h3>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                    Players binned by predicted PPG. Higher-predicted players typically have wider residual distributions.
                  </p>
                  <div className="table-container">
                    <table style={{ fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th>Tier</th>
                          <th style={{ textAlign: 'right' }}>Pred Range</th>
                          <th style={{ textAlign: 'right' }}>N</th>
                          <th style={{ textAlign: 'right' }}>Std Dev</th>
                          <th style={{ textAlign: 'right' }}>Boom %</th>
                          <th style={{ textAlign: 'right' }}>Bust %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cond.bins.map((bin: any) => {
                          const tierLabel = bin.label === 'high' ? 'Top 20%' : bin.label === 'mid' ? 'Mid 60%' : 'Bot 20%';
                          return (
                            <tr key={bin.label}>
                              <td><strong>{tierLabel}</strong></td>
                              <td style={{ textAlign: 'right' }}>{bin.predMin.toFixed(1)}-{bin.predMax.toFixed(1)}</td>
                              <td style={{ textAlign: 'right' }}>{bin.residuals.length}</td>
                              <td style={{ textAlign: 'right', fontWeight: 700, color: bin.std > m.residualStd ? '#f59e0b' : '#10b981' }}>
                                {bin.std.toFixed(2)}
                              </td>
                              <td style={{ textAlign: 'right', color: '#22c55e' }}>{bin.boomRate.toFixed(1)}%</td>
                              <td style={{ textAlign: 'right', color: '#ef4444' }}>{bin.bustRate.toFixed(1)}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* Bust Classifier Validation */}
              <h3 style={{ fontSize: 15, margin: '20px 0 8px' }}>Bust Classifier Validation (Picks 1-24)</h3>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                Among top-25% predicted players, the bust classifier separates high-risk from safe picks.
                High-risk players bust at 4-5x the rate of safe players.
              </p>
              <div className="table-container">
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th style={{ textAlign: 'right' }}>AUC</th>
                      <th style={{ textAlign: 'right' }}>High Risk Bust%</th>
                      <th style={{ textAlign: 'right' }}>Safe Bust%</th>
                      <th style={{ textAlign: 'right' }}>Separation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { pos: 'RB', auc: '0.651', highRisk: '25%', safe: '5%', sep: '5.0x' },
                      { pos: 'WR', auc: '0.672', highRisk: '31%', safe: '7%', sep: '4.4x' },
                      { pos: 'TE', auc: '0.701', highRisk: '23%', safe: '0%', sep: 'Perfect' },
                    ].map(r => (
                      <tr key={r.pos} style={{ background: r.pos === selectedPos ? 'var(--bg-tertiary)' : undefined }}>
                        <td><strong style={{ color: POS_COLORS[r.pos] }}>{r.pos}</strong></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#22c55e' }}>{r.auc}</td>
                        <td style={{ textAlign: 'right', color: '#ef4444' }}>{r.highRisk}</td>
                        <td style={{ textAlign: 'right', color: '#22c55e' }}>{r.safe}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{r.sep}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                Top bust drivers: draft pick position (34-58%), missing athletic data (9%), RAS deficit (4-5%), age (2-3%).
                All pre-draft features — available before the NFL draft.
              </p>

              {/* Cross-position comparison */}
              <h3 style={{ fontSize: 15, margin: '20px 0 8px' }}>Cross-Position Boom/Bust Rates</h3>
              <div className="table-container">
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th style={{ textAlign: 'right' }}>N</th>
                      <th style={{ textAlign: 'right' }}>Boom Rate</th>
                      <th style={{ textAlign: 'right' }}>Bust Rate</th>
                      <th style={{ textAlign: 'right' }}>Residual Std</th>
                    </tr>
                  </thead>
                  <tbody>
                    {['QB', 'RB', 'WR', 'TE'].map(pos => {
                      const pm = cm[pos] as any;
                      if (!pm) return (
                        <tr key={pos}>
                          <td><strong style={{ color: POS_COLORS[pos] }}>{pos}</strong></td>
                          <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>insufficient data</td>
                        </tr>
                      );
                      return (
                        <tr key={pos} style={{ background: pos === selectedPos ? 'var(--bg-tertiary)' : undefined, cursor: 'pointer' }} onClick={() => setSelectedPos(pos)}>
                          <td><strong style={{ color: POS_COLORS[pos] }}>{pos}</strong></td>
                          <td style={{ textAlign: 'right' }}>{pm.n}</td>
                          <td style={{ textAlign: 'right', color: '#22c55e' }}>{pm.boomRate ?? '—'}%</td>
                          <td style={{ textAlign: 'right', color: '#ef4444' }}>{pm.bustRate ?? '—'}%</td>
                          <td style={{ textAlign: 'right' }}>{pm.residualStd?.toFixed(2) ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}

        {model && section === 'projection' && (
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
