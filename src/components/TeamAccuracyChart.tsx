import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Cell, LabelList,
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

// Seasons to fetch player data for (2026 has no actuals yet, only projection)
const FETCH_SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
// Display: 2020–2025 historical + 2026 forecast
const DISPLAY_SEASONS = [...FETCH_SEASONS.slice(1), 2026];
const PREDICT_SEASON = 2026;

function fmtLabel(v: number | null | undefined): string {
  if (v == null || v === 0) return '';
  if (v >= 1000 || v <= -1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

// ── Helpers ──

function aggregateActualsByTeam(players: SeasonTotals[]): Map<string, TeamTotals> {
  const map = new Map<string, TeamTotals>();
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
  return map;
}

// ── Tooltip ──

interface TooltipEntry { name: string; value: number | null; color: string }

function ChartTooltip({ active, payload, label }: {
  active?: boolean; payload?: TooltipEntry[]; label?: number;
}) {
  if (!active || !payload?.length) return null;
  const actualEntry = payload.find((p) => p.name === 'Actual');
  const projEntry   = payload.find((p) => p.name === 'Model Projection');
  const actual  = actualEntry?.value ?? null;
  const proj    = projEntry?.value ?? 0;
  const isFuture = actual === null;
  const delta   = isFuture ? null : (actual as number) - proj;
  const pct     = delta != null && proj > 0 ? ((delta / proj) * 100).toFixed(1) : null;

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 14px', fontSize: 12,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--text-primary)' }}>
        {label}{isFuture && <span style={{ color: '#f59e0b', marginLeft: 6, fontSize: 10 }}>FORECAST</span>}
      </div>
      {projEntry && (
        <div style={{ color: projEntry.color, marginBottom: 2 }}>
          Model Projection: <strong>{proj.toLocaleString()}</strong>
        </div>
      )}
      {actualEntry && actual != null && (
        <div style={{ color: actualEntry.color, marginBottom: 2 }}>
          Actual: <strong>{(actual as number).toLocaleString()}</strong>
        </div>
      )}
      {delta != null && pct != null && (
        <div style={{
          marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)',
          color: delta >= 0 ? '#10b981' : '#ef4444', fontWeight: 700,
        }}>
          {delta >= 0 ? '+' : ''}{delta.toLocaleString()} ({pct}%)
        </div>
      )}
    </div>
  );
}

// ── Main component ──

interface ChartPoint {
  season: number;
  actual: number | null;   // null for 2026 (no actuals yet)
  projected: number;
  delta: number | null;    // null for 2026
}

export function TeamAccuracyChart() {
  const [loading, setLoading] = useState(true);
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
      const teams = [...new Set(results.flatMap((r) => r.totals.map((p) => p.recent_team).filter(Boolean)))].sort();
      if (teams.length && !teams.includes('LA')) setSelectedTeam(teams[0]);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const actualsBySeason = useMemo(() => {
    const out = new Map<number, Map<string, TeamTotals>>();
    for (const [s, totals] of rawBySeason) out.set(s, aggregateActualsByTeam(totals));
    return out;
  }, [rawBySeason]);

  // Projections for 2020–2026; 2026 uses 2025 as prior
  const projectionsBySeason = useMemo(() => {
    const out = new Map<number, Map<string, TeamTotals>>();
    for (const displaySeason of DISPLAY_SEASONS) {
      const priorTotals = rawBySeason.get(displaySeason - 1);
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
      const projected = Math.round(projectionsBySeason.get(s)?.get(selectedTeam)?.[selectedMetric] ?? 0);
      const isFuture  = s >= PREDICT_SEASON;
      const actual    = isFuture ? null : Math.round(actualsBySeason.get(s)?.get(selectedTeam)?.[selectedMetric] ?? 0);
      const delta     = actual === null ? null : actual - projected;
      return { season: s, actual, projected, delta };
    });
  }, [actualsBySeason, projectionsBySeason, selectedTeam, selectedMetric]);

  const metricLabel = METRICS.find((m) => m.key === selectedMetric)?.label ?? selectedMetric;

  const historicalDeltas = chartData.filter((d) => d.delta != null).map((d) => d.delta as number);
  const deltaMin = Math.min(0, ...historicalDeltas);
  const deltaMax = Math.max(0, ...historicalDeltas);

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
            ? 'Actual vs model projection — 2020–2025 historical + 2026 forecast'
            : 'Actual minus model projection — green = outperformed, red = underperformed'}
        </span>
      </h4>

      {chartType === 'grouped' ? (
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={chartData} margin={{ top: 28, right: 20, left: 10, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="season"
              tick={({ x, y, payload }) => (
                <g transform={`translate(${x},${y})`}>
                  <text x={0} y={0} dy={14} textAnchor="middle" fill="var(--text-muted)" fontSize={12}>
                    {payload.value}
                  </text>
                  {payload.value >= PREDICT_SEASON && (
                    <text x={0} y={0} dy={26} textAnchor="middle" fill="#f59e0b" fontSize={9}>
                      forecast
                    </text>
                  )}
                </g>
              )}
              height={36}
              axisLine={false} tickLine={false}
            />
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
            <Bar dataKey="actual" name="Actual" fill="#6366f1" radius={[4,4,0,0]} maxBarSize={48}>
              <LabelList
                dataKey="actual"
                position="top"
                style={{ fontSize: 10, fill: '#a5b4fc' }}
                formatter={fmtLabel}
              />
            </Bar>
            <Bar dataKey="projected" name="Model Projection" fill="#475569" radius={[4,4,0,0]} maxBarSize={48}>
              {chartData.map((d) => (
                <Cell
                  key={d.season}
                  fill={d.season >= PREDICT_SEASON ? '#f59e0b' : '#475569'}
                  fillOpacity={d.season >= PREDICT_SEASON ? 0.85 : 1}
                />
              ))}
              <LabelList
                dataKey="projected"
                position="top"
                style={{ fontSize: 10, fill: '#94a3b8' }}
                formatter={fmtLabel}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={chartData} margin={{ top: 28, right: 20, left: 10, bottom: 0 }} barCategoryGap="40%">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="season"
              tick={({ x, y, payload }) => (
                <g transform={`translate(${x},${y})`}>
                  <text x={0} y={0} dy={14} textAnchor="middle" fill="var(--text-muted)" fontSize={12}>
                    {payload.value}
                  </text>
                  {payload.value >= PREDICT_SEASON && (
                    <text x={0} y={0} dy={26} textAnchor="middle" fill="#f59e0b" fontSize={9}>
                      forecast
                    </text>
                  )}
                </g>
              )}
              height={36}
              axisLine={false} tickLine={false}
            />
            <YAxis
              domain={[deltaMin * 1.2 || -100, deltaMax * 1.2 || 100]}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              axisLine={false} tickLine={false} width={52}
              tickFormatter={(v: number) => v >= 1000 || v <= -1000 ? `${(v / 1000).toFixed(1)}k` : String(v)}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const delta = payload[0]?.value as number | null;
                const pt = chartData.find((d) => d.season === Number(label));
                const pct = delta != null && pt && pt.projected > 0
                  ? ((delta / pt.projected) * 100).toFixed(1) : null;
                return (
                  <div style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '10px 14px', fontSize: 12,
                  }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
                    {delta != null
                      ? <div style={{ color: delta >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                          {delta >= 0 ? '+' : ''}{delta.toLocaleString()}{pct ? ` (${pct}%)` : ''}
                        </div>
                      : <div style={{ color: 'var(--text-muted)' }}>No actuals yet</div>
                    }
                  </div>
                );
              }}
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            />
            <ReferenceLine y={0} stroke="var(--text-muted)" strokeWidth={1.5} />
            <Bar dataKey="delta" name="vs Model Projection" radius={[4,4,0,0]} maxBarSize={56}>
              {chartData.map((d) => (
                <Cell
                  key={d.season}
                  fill={d.delta == null ? 'transparent' : d.delta >= 0 ? '#10b981' : '#ef4444'}
                />
              ))}
              <LabelList
                dataKey="delta"
                position="top"
                style={{ fontSize: 10, fill: '#94a3b8' }}
                formatter={fmtLabel}
              />
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
              const pct = d.delta != null && d.projected > 0 ? (d.delta / d.projected) * 100 : null;
              return (
                <tr key={d.season} style={d.season >= PREDICT_SEASON ? { color: '#f59e0b' } : undefined}>
                  <td><strong>{d.season}{d.season >= PREDICT_SEASON ? ' ⟶' : ''}</strong></td>
                  <td style={{ textAlign: 'right', color: d.season >= PREDICT_SEASON ? 'var(--text-muted)' : undefined }}>
                    {d.actual != null ? d.actual.toLocaleString() : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: d.season >= PREDICT_SEASON ? '#f59e0b' : 'var(--text-muted)' }}>
                    {d.projected.toLocaleString()}
                  </td>
                  <td style={{
                    textAlign: 'right', fontWeight: 700,
                    color: d.delta == null ? 'var(--text-muted)'
                      : d.delta > 0 ? '#10b981' : d.delta < 0 ? '#ef4444' : 'var(--text-muted)',
                  }}>
                    {d.delta == null ? '—' : `${d.delta >= 0 ? '+' : ''}${d.delta.toLocaleString()}`}
                  </td>
                  <td style={{ textAlign: 'right', color: pct == null ? 'var(--text-muted)' : pct > 0 ? '#10b981' : pct < 0 ? '#ef4444' : 'var(--text-muted)' }}>
                    {pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
        Model projection: prior year team stats blended {Math.round(projectionConfig.winner.teamWeight * 100)}/{Math.round((1 - projectionConfig.winner.teamWeight) * 100)} team/league
        (same methodology as 2026 live projections). 2026 bar shows forecast only — no actuals yet.
        Does not include Vegas lines or coaching change adjustments.
        Source: nflverse player_stats, 2019–2025.
      </p>
    </div>
  );
}
