import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { fetchPlayerStats, aggregateToSeasonTotals } from '../data';
import type { SeasonTotals, PlayerStats } from '../types';

// ── Types ──

interface TeamSeasonStats {
  passYds: number;
  passAtt: number;
  passTD: number;
  rushYds: number;
  rushAtt: number;
  rushTD: number;
  totalTD: number;
  recYds: number;
  pprPts: number;
}

type MetricKey = keyof TeamSeasonStats;

const METRICS: { key: MetricKey; label: string; decimals?: number }[] = [
  { key: 'passYds',  label: 'Pass Yards' },
  { key: 'rushYds',  label: 'Rush Yards' },
  { key: 'recYds',   label: 'Receiving Yards' },
  { key: 'passTD',   label: 'Pass TDs' },
  { key: 'rushTD',   label: 'Rush TDs' },
  { key: 'totalTD',  label: 'Total TDs' },
  { key: 'passAtt',  label: 'Pass Attempts' },
  { key: 'rushAtt',  label: 'Rush Attempts' },
  { key: 'pprPts',   label: 'PPR Points', decimals: 0 },
];

const FETCH_SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const DISPLAY_SEASONS = FETCH_SEASONS.slice(1); // 2020-2025; prior year available for each

// ── Data helpers ──

function emptyStats(): TeamSeasonStats {
  return { passYds: 0, passAtt: 0, passTD: 0, rushYds: 0, rushAtt: 0, rushTD: 0, totalTD: 0, recYds: 0, pprPts: 0 };
}

function aggregateByTeam(players: SeasonTotals[]): Map<string, TeamSeasonStats> {
  const map = new Map<string, TeamSeasonStats>();
  for (const p of players) {
    const team = p.recent_team;
    if (!team) continue;
    if (!map.has(team)) map.set(team, emptyStats());
    const row = map.get(team)!;
    row.passYds  += p.passing_yards   || 0;
    row.passAtt  += p.attempts        || 0;
    row.passTD   += p.passing_tds     || 0;
    row.rushYds  += p.rushing_yards   || 0;
    row.rushAtt  += p.carries         || 0;
    row.rushTD   += p.rushing_tds     || 0;
    row.recYds   += p.receiving_yards || 0;
    row.pprPts   += p.fantasy_points_ppr || 0;
  }
  for (const row of map.values()) {
    row.totalTD = row.passTD + row.rushTD;
    row.pprPts  = Math.round(row.pprPts);
  }
  return map;
}

// ── Custom tooltip ──

interface TooltipPayload {
  name: string;
  value: number;
  color: string;
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const actual    = payload.find((p) => p.name === 'Actual')?.value ?? 0;
  const projected = payload.find((p) => p.name === 'Prior Year')?.value ?? 0;
  const delta = actual - projected;
  const pct   = projected > 0 ? ((delta / projected) * 100).toFixed(1) : '—';
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

interface ChartPoint {
  season: number;
  actual: number;
  projected: number;
  delta: number;
}

export function TeamAccuracyChart() {
  const [loading, setLoading] = useState(true);
  // Map of season → team → stats
  const [allData, setAllData] = useState<Map<number, Map<string, TeamSeasonStats>>>(new Map());
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
        return { season: s, byTeam: aggregateByTeam(totals) };
      })
    ).then((results) => {
      if (cancelled) return;
      const map = new Map<number, Map<string, TeamSeasonStats>>();
      for (const { season, byTeam } of results) map.set(season, byTeam);
      setAllData(map);

      // Default to first available team alphabetically
      const teams = [...new Set(results.flatMap((r) => [...r.byTeam.keys()]))].sort();
      if (teams.length && !teams.includes('LA')) setSelectedTeam(teams[0]);

      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const byTeam of allData.values()) for (const t of byTeam.keys()) set.add(t);
    return [...set].sort();
  }, [allData]);

  const chartData = useMemo((): ChartPoint[] => {
    return DISPLAY_SEASONS.map((s) => {
      const actual    = Math.round(allData.get(s)?.get(selectedTeam)?.[selectedMetric]    ?? 0);
      const projected = Math.round(allData.get(s - 1)?.get(selectedTeam)?.[selectedMetric] ?? 0);
      return { season: s, actual, projected, delta: actual - projected };
    });
  }, [allData, selectedTeam, selectedMetric]);

  const metricLabel = METRICS.find((m) => m.key === selectedMetric)?.label ?? selectedMetric;

  // Determine domain padding for delta chart
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
              Actual vs Prior Year
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

      {/* Title */}
      <h4 style={{ marginBottom: 16, color: 'var(--text-primary)' }}>
        {selectedTeam} — {metricLabel}
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 10 }}>
          {chartType === 'grouped'
            ? 'Actual results vs prior year baseline (2020–2025)'
            : 'Actual minus prior year baseline — positive = outperformed'}
        </span>
      </h4>

      {/* Chart */}
      {chartType === 'grouped' ? (
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="season" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)}
              width={52}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
            <Legend
              wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
              formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>}
            />
            <Bar dataKey="actual" name="Actual" fill="#6366f1" radius={[4, 4, 0, 0]} maxBarSize={48} />
            <Bar dataKey="projected" name="Prior Year" fill="#475569" radius={[4, 4, 0, 0]} maxBarSize={48} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }} barCategoryGap="40%">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="season" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis
              domain={[deltaMin * 1.15, deltaMax * 1.15]}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => v >= 1000 || v <= -1000 ? `${(v / 1000).toFixed(1)}k` : String(v)}
              width={52}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const delta = payload[0]?.value as number;
                const pct = (() => {
                  const pt = chartData.find((d) => d.season === Number(label));
                  return pt && pt.projected > 0 ? ((delta / pt.projected) * 100).toFixed(1) : '—';
                })();
                return (
                  <div style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '10px 14px', fontSize: 12,
                  }}>
                    <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>{label}</div>
                    <div style={{ color: delta >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                      {delta >= 0 ? '+' : ''}{delta.toLocaleString()} ({pct}%)
                    </div>
                  </div>
                );
              }}
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            />
            <ReferenceLine y={0} stroke="var(--text-muted)" strokeWidth={1.5} />
            <Bar dataKey="delta" name="vs Prior Year" radius={[4, 4, 0, 0]} maxBarSize={56}>
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
              <th style={{ textAlign: 'right' }}>Prior Year</th>
              <th style={{ textAlign: 'right' }}>Delta</th>
              <th style={{ textAlign: 'right' }}>% Change</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((d) => {
              const pct = d.projected > 0 ? ((d.delta / d.projected) * 100) : 0;
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
                  <td style={{
                    textAlign: 'right',
                    color: pct > 0 ? '#10b981' : pct < 0 ? '#ef4444' : 'var(--text-muted)',
                  }}>
                    {d.projected > 0 ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
        "Prior Year" is the same team's actual stat from the previous season — used as a naive baseline projection.
        Positive delta = team outperformed prior year; negative = underperformed.
        Source: nflverse player_stats, 2019–2025.
      </p>
    </div>
  );
}
