import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { fetchPlayerStats, aggregateToSeasonTotals } from '../data';
import type { SeasonTotals, PlayerStats } from '../types';
import { projectTeamTotals } from '../lib/teamProjection';
import type { TeamTotals } from '../lib/teamProjection';
import projectionConfig from '../generated/projection-config.json';

// ── Config ──

type MetricKey = keyof TeamTotals;

const METRICS: { key: MetricKey; label: string }[] = [
  { key: 'passYds',  label: 'Pass Yards' },
  { key: 'rushYds',  label: 'Rush Yards' },
  { key: 'recYds',   label: 'Receiving Yards' },
  { key: 'passTD',   label: 'Pass TDs' },
  { key: 'rushTD',   label: 'Rush TDs' },
  { key: 'totalTD',  label: 'Total TDs' },
  { key: 'passAtt',  label: 'Pass Attempts' },
  { key: 'rushAtt',  label: 'Rush Attempts' },
  { key: 'pprPts',   label: 'PPR Points (approx)' },
];

const FETCH_SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const DISPLAY_SEASONS = FETCH_SEASONS.slice(1); // 2020–2025; projection uses Y-1 as prior

// ── Helpers ──

function aggregateActualsByTeam(players: SeasonTotals[]): Map<string, TeamTotals> {
  const map = new Map<string, Omit<TeamTotals, 'totalTD' | 'pprPts'> & { totalTD: number; pprPts: number }>();
  for (const p of players) {
    const team = p.recent_team;
    if (!team) continue;
    if (!map.has(team)) map.set(team, {
      passAtt: 0, passYds: 0, passTD: 0,
      rushAtt: 0, rushYds: 0, rushTD: 0,
      recYds: 0, recTD: 0, targets: 0, receptions: 0,
      totalTD: 0, pprPts: 0,
    });
    const t = map.get(team)!;
    t.passAtt    += p.attempts          || 0;
    t.passYds    += p.passing_yards     || 0;
    t.passTD     += p.passing_tds       || 0;
    t.rushAtt    += p.carries           || 0;
    t.rushYds    += p.rushing_yards     || 0;
    t.rushTD     += p.rushing_tds       || 0;
    t.recYds     += p.receiving_yards   || 0;
    t.recTD      += p.receiving_tds     || 0;
    t.targets    += p.targets           || 0;
    t.receptions += p.receptions        || 0;
    t.pprPts     += p.fantasy_points_ppr || 0;
  }
  for (const t of map.values()) {
    t.totalTD = t.passTD + t.rushTD;
    t.pprPts  = Math.round(t.pprPts);
  }
  return map as Map<string, TeamTotals>;
}

// ── Tooltip ──

interface TooltipEntry { name: string; value: number; color: string }

function ChartTooltip({ active, payload, label }: {
  active?: boolean; payload?: TooltipEntry[]; label?: number;
}) {
  if (!active || !payload?.length) return null;
  const actual  = payload.find((p) => p.name === 'Actual')?.value ?? 0;
  const proj    = payload.find((p) => p.name === 'Model Projection')?.value ?? 0;
  const delta   = actual - proj;
  const pct     = proj > 0 ? ((delta / proj) * 100).toFixed(1) : '—';
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 14px', fontSize: 12,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--text-primary)' }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <strong>{p.value.toLocaleString()}</strong>
        </div>
      ))}
      <div style={{
        marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)',
        color: delta >= 0 ? '#10b981' : '#ef4444', fontWeight: 700,
      }}>
        {delta >= 0 ? '+' : ''}{delta.toLocaleString()} ({pct}%)
      </div>
    </div>
  );
}

// ── Main component ──

interface ChartPoint { season: number; actual: number; projected: number; delta: number }

export function TeamAccuracyChart() {
  const [loading, setLoading] = useState(true);
  // Raw aggregated player stats per season (for both actuals and as prior-year input to model)
  const [rawBySeason, setRawBySeason] = useState<Map<number, SeasonTotals[]>>(new Map());
  const [selectedTeam, setSelectedTeam] = useState('LA');
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('passYds');
  const [chartType, setChartType] = useState<'grouped' | 'delta'>('grouped');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(
      FETCH_SEASONS.map(async (s) => {
        const weekly = await fetchPlayerStats(s).catch(() => [] as PlayerStats[]);
        const totals = aggregateToSeasonTotals(weekly);
        return { season: s, totals };
      })
    ).then((results) => {
      if (cancelled) return;
      const map = new Map<number, SeasonTotals[]>();
      for (const { season, totals } of results) map.set(season, totals);
      setRawBySeason(map);
      // Default to LA if available, else first team
      const teams = [...new Set(results.flatMap((r) => r.totals.map((p) => p.recent_team).filter(Boolean)))].sort();
      if (teams.length && !teams.includes('LA')) setSelectedTeam(teams[0]);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Actual team stats per season
  const actualsBySeason = useMemo(() => {
    const out = new Map<number, Map<string, TeamTotals>>();
    for (const [s, totals] of rawBySeason) out.set(s, aggregateActualsByTeam(totals));
    return out;
  }, [rawBySeason]);

  // Model projections per season (uses prior year totals through the methodology)
  const projectionsBySeason = useMemo(() => {
    const out = new Map<number, Map<string, TeamTotals>>();
    for (let i = 1; i < FETCH_SEASONS.length; i++) {
      const displaySeason = FETCH_SEASONS[i];
      const priorTotals   = rawBySeason.get(FETCH_SEASONS[i - 1]);
      if (priorTotals) out.set(displaySeason, projectTeamTotals(priorTotals));
    }
    return out;
  }, [rawBySeason]);

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const byTeam of actualsBySeason.values()) for (const t of byTeam.keys()) set.add(t);
    return [...set].sort();
  }, [actualsBySeason]);

  const chartData = useMemo((): ChartPoint[] => {
    return DISPLAY_SEASONS.map((s) => {
      const actual    = Math.round(actualsBySeason.get(s)?.get(selectedTeam)?.[selectedMetric]    ?? 0);
      const projected = Math.round(projectionsBySeason.get(s)?.get(selectedTeam)?.[selectedMetric] ?? 0);
      return { season: s, actual, projected, delta: actual - projected };
    });
  }, [actualsBySeason, projectionsBySeason, selectedTeam, selectedMetric]);

  const metricLabel = METRICS.find((m) => m.key === selectedMetric)?.label ?? selectedMetric;

  const deltaMin = Math.min(0, ...chartData.map((d) => d.delta));
  const deltaMax = Math.max(0, ...chartData.map((d) => d.delta));

  if (loading) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading historical stats for 2019–2025…
      </div>
    );
  }

  return (
    <div>
      {/* Controls */}
      <div className="controls" style={{ marginBottom: 20, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="control-group">
          <label className="control-label">Team</label>
          <select value={selectedTeam} onChange={(e) => setSelectedTeam(e.target.value)}>
            {teams.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Metric</label>
          <select value={selectedMetric} onChange={(e) => setSelectedMetric(e.target.value as MetricKey)}>
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Chart</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className={`pos-filter ${chartType === 'grouped' ? 'active' : ''}`}
              onClick={() => setChartType('grouped')}
              style={{ borderColor: 'var(--text-muted)' }}
            >
              Actual vs Projected
            </button>
            <button
              className={`pos-filter ${chartType === 'delta' ? 'active' : ''}`}
              onClick={() => setChartType('delta')}
              style={{ borderColor: 'var(--text-muted)' }}
            >
              Over/Under
            </button>
          </div>
        </div>
      </div>

      <h4 style={{ marginBottom: 16 }}>
        {selectedTeam} — {metricLabel}
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 10 }}>
          {chartType === 'grouped'
            ? 'Actual vs model projection (2026 methodology, retroactively applied) — 2020–2025'
            : 'Actual minus model projection — green = outperformed, red = underperformed'}
        </span>
      </h4>

      {chartType === 'grouped' ? (
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="season" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              axisLine={false} tickLine={false} width={52}
              tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
            <Legend
              wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
              formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>}
            />
            <Bar dataKey="actual"    name="Actual"           fill="#6366f1" radius={[4,4,0,0]} maxBarSize={48} />
            <Bar dataKey="projected" name="Model Projection" fill="#475569" radius={[4,4,0,0]} maxBarSize={48} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }} barCategoryGap="40%">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="season" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis
              domain={[deltaMin * 1.2, deltaMax * 1.2]}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              axisLine={false} tickLine={false} width={52}
              tickFormatter={(v: number) => v >= 1000 || v <= -1000 ? `${(v / 1000).toFixed(1)}k` : String(v)}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const delta = payload[0]?.value as number;
                const pt = chartData.find((d) => d.season === Number(label));
                const pct = pt && pt.projected > 0 ? ((delta / pt.projected) * 100).toFixed(1) : '—';
                return (
                  <div style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '10px 14px', fontSize: 12,
                  }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
                    <div style={{ color: delta >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                      {delta >= 0 ? '+' : ''}{delta.toLocaleString()} ({pct}%)
                    </div>
                  </div>
                );
              }}
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            />
            <ReferenceLine y={0} stroke="var(--text-muted)" strokeWidth={1.5} />
            <Bar dataKey="delta" name="vs Model Projection" radius={[4,4,0,0]} maxBarSize={56}>
              {chartData.map((d) => (
                <Cell key={d.season} fill={d.delta >= 0 ? '#10b981' : '#ef4444'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}

      {/* Summary table */}
      <div className="table-container" style={{ marginTop: 24 }}>
        <table>
          <thead>
            <tr>
              <th>Season</th>
              <th style={{ textAlign: 'right' }}>Actual</th>
              <th style={{ textAlign: 'right' }}>Model Projection</th>
              <th style={{ textAlign: 'right' }}>Delta</th>
              <th style={{ textAlign: 'right' }}>% Miss</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((d) => {
              const pct = d.projected > 0 ? (d.delta / d.projected) * 100 : 0;
              return (
                <tr key={d.season}>
                  <td><strong>{d.season}</strong></td>
                  <td style={{ textAlign: 'right' }}>{d.actual.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{d.projected.toLocaleString()}</td>
                  <td style={{
                    textAlign: 'right', fontWeight: 700,
                    color: d.delta > 0 ? '#10b981' : d.delta < 0 ? '#ef4444' : 'var(--text-muted)',
                  }}>
                    {d.delta >= 0 ? '+' : ''}{d.delta.toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right', color: pct > 0 ? '#10b981' : pct < 0 ? '#ef4444' : 'var(--text-muted)' }}>
                    {d.projected > 0 ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
        Model projection uses the same team/league blend methodology as the 2026 projections
        (prior year team stats blended {Math.round(projectionConfig.winner.teamWeight * 100)}/{Math.round((1 - projectionConfig.winner.teamWeight) * 100)} team/league).
        Applied retroactively for each year using the prior year's actual stats as input.
        Does not include Vegas lines or coaching change adjustments.
        Source: nflverse player_stats, 2019–2025.
      </p>
    </div>
  );
}
