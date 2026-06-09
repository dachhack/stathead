import { useState, useEffect, useMemo } from 'react';
import { PlayerName } from './PlayerName';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Label, ReferenceLine,
  BarChart, Bar, LineChart, Line, Legend,
} from 'recharts';
import { fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals } from '../data';
import type { FfcADPPlayer, SeasonTotals } from '../types';

// ── Config ──

const SEASONS = [2020, 2021, 2022, 2023, 2024, 2025];
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const POS_COLORS: Record<string, string> = {
  QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444', ALL: '#8b5cf6',
};

// ADP buckets for aggregation
const ADP_BUCKETS = [
  { label: 'Rd 1 (1-12)', min: 1, max: 12 },
  { label: 'Rd 2 (13-24)', min: 13, max: 24 },
  { label: 'Rd 3 (25-36)', min: 25, max: 36 },
  { label: 'Rd 4 (37-48)', min: 37, max: 48 },
  { label: 'Rd 5 (49-60)', min: 49, max: 60 },
  { label: 'Rd 6 (61-72)', min: 61, max: 72 },
  { label: 'Rd 7 (73-84)', min: 73, max: 84 },
  { label: 'Rd 8 (85-96)', min: 85, max: 96 },
  { label: 'Rd 9 (97-108)', min: 97, max: 108 },
  { label: 'Rd 10 (109-120)', min: 109, max: 120 },
  { label: 'Rd 11-12 (121-144)', min: 121, max: 144 },
  { label: 'Rd 13+ (145+)', min: 145, max: 999 },
];

// ── Types ──

interface ADPOutcome {
  name: string;
  position: string;
  team: string;
  season: number;
  adp: number;
  adpRound: number;
  games: number;
  fantasyPPR: number;
  ppg: number;
  actualRank: number; // position rank by PPR points
  overallRank: number;
  adpDelta: number; // positive = outperformed ADP
}

type ViewTab = 'scatter' | 'buckets' | 'table';

// ── Name normalization for joining ──

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function adpToRound(adp: number, teamsInLeague: number = 12): number {
  return Math.ceil(adp / teamsInLeague);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Component ──

export function ADPOutcomes() {
  const [outcomes, setOutcomes] = useState<ADPOutcome[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState('ALL');
  const [seasonFilter, setSeasonFilter] = useState<number | 'all'>('all');
  const [viewTab, setViewTab] = useState<ViewTab>('scatter');
  const [maxADP, setMaxADP] = useState(150);

  useEffect(() => {
    let cancelled = false;

    async function loadAll() {
      try {
        const allOutcomes: ADPOutcome[] = [];

        for (const season of SEASONS) {
          setLoadingStatus(`Loading ${season} ADP + stats...`);

          // Fetch ADP and stats in parallel
          const [adpData, statsData] = await Promise.all([
            fetchFfcADP(season, 'ppr', 12).catch(() => [] as FfcADPPlayer[]),
            fetchPlayerStats(season).catch(() => []),
          ]);

          if (cancelled) return;

          if (adpData.length === 0 || statsData.length === 0) continue;

          // Aggregate stats to season totals
          const totals = aggregateToSeasonTotals(
            statsData.filter((s) => s.season_type === 'REG')
          );

          // Build position ranks
          const byPos = new Map<string, SeasonTotals[]>();
          for (const p of totals) {
            if (!['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
            const arr = byPos.get(p.position) || [];
            arr.push(p);
            byPos.set(p.position, arr);
          }
          for (const arr of byPos.values()) {
            arr.sort((a, b) => b.fantasy_points_ppr - a.fantasy_points_ppr);
          }

          // Overall rank
          const allPlayers = totals
            .filter((p) => ['QB', 'RB', 'WR', 'TE'].includes(p.position))
            .sort((a, b) => b.fantasy_points_ppr - a.fantasy_points_ppr);

          const overallRankMap = new Map<string, number>();
          allPlayers.forEach((p, i) => {
            overallRankMap.set(normalizeName(p.player_display_name), i + 1);
          });

          const posRankMap = new Map<string, number>();
          for (const [pos, arr] of byPos) {
            arr.forEach((p, i) => {
              posRankMap.set(`${pos}-${normalizeName(p.player_display_name)}`, i + 1);
            });
          }

          // Build stats lookup by normalized name
          const statsMap = new Map<string, SeasonTotals>();
          for (const p of totals) {
            if (!['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
            statsMap.set(normalizeName(p.player_display_name), p);
          }

          // Join ADP with stats
          for (const adpPlayer of adpData) {
            if (!['QB', 'RB', 'WR', 'TE'].includes(adpPlayer.position)) continue;

            const normalName = normalizeName(adpPlayer.name);
            const stats = statsMap.get(normalName);

            if (!stats) continue; // no match

            // Verify position matches (avoid false joins)
            if (stats.position !== adpPlayer.position) continue;

            const posRank = posRankMap.get(`${stats.position}-${normalName}`) || 999;
            const overallRank = overallRankMap.get(normalName) || 999;

            allOutcomes.push({
              name: adpPlayer.name,
              position: adpPlayer.position,
              team: stats.recent_team,
              season,
              adp: adpPlayer.adp,
              adpRound: adpToRound(adpPlayer.adp),
              games: stats.games,
              fantasyPPR: Math.round(stats.fantasy_points_ppr * 10) / 10,
              ppg: stats.games > 0
                ? Math.round((stats.fantasy_points_ppr / stats.games) * 10) / 10
                : 0,
              actualRank: posRank,
              overallRank,
              adpDelta: Math.round(adpPlayer.adp - overallRank), // positive = beat ADP
            });
          }
        }

        if (cancelled) return;

        if (allOutcomes.length === 0) {
          setError('No ADP outcome data could be loaded');
        }

        setOutcomes(allOutcomes);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }

    loadAll();
    return () => { cancelled = true; };
  }, []);

  // ── Filtered data ──

  const filtered = useMemo(() => {
    let data = outcomes;
    if (posFilter !== 'ALL') data = data.filter((d) => d.position === posFilter);
    if (seasonFilter !== 'all') data = data.filter((d) => d.season === seasonFilter);
    data = data.filter((d) => d.adp <= maxADP);
    return data;
  }, [outcomes, posFilter, seasonFilter, maxADP]);

  // ── Bucket summaries ──

  const bucketData = useMemo(() => {
    return ADP_BUCKETS.map((bucket) => {
      const inBucket = filtered.filter((d) => d.adp >= bucket.min && d.adp <= bucket.max);
      if (inBucket.length === 0) {
        return { ...bucket, count: 0, avgPPR: 0, medianPPR: 0, avgPPG: 0, hitRate: 0, bustRate: 0, avgDelta: 0 };
      }

      const pprValues = inBucket.map((d) => d.fantasyPPR);
      const hits = inBucket.filter((d) => d.adpDelta >= -12).length;
      const busts = inBucket.filter((d) => d.adpDelta < -24).length;

      return {
        ...bucket,
        count: inBucket.length,
        avgPPR: Math.round(pprValues.reduce((a, b) => a + b, 0) / pprValues.length * 10) / 10,
        medianPPR: Math.round(median(pprValues) * 10) / 10,
        avgPPG: Math.round(inBucket.reduce((a, d) => a + d.ppg, 0) / inBucket.length * 10) / 10,
        hitRate: Math.round((hits / inBucket.length) * 100),
        bustRate: Math.round((busts / inBucket.length) * 100),
        avgDelta: Math.round(inBucket.reduce((a, d) => a + d.adpDelta, 0) / inBucket.length),
      };
    }).filter((b) => b.count > 0);
  }, [filtered]);

  // ── Per-position bucket breakdown for line chart ──

  const positionBucketLines = useMemo(() => {
    if (posFilter !== 'ALL') return null;

    const positions = ['QB', 'RB', 'WR', 'TE'];
    const buckets = ADP_BUCKETS.filter((b) => b.max <= maxADP || b.min <= maxADP);

    return buckets.map((bucket) => {
      const row: Record<string, unknown> = { label: bucket.label };
      for (const pos of positions) {
        const inBucket = outcomes
          .filter((d) => d.position === pos && d.adp >= bucket.min && d.adp <= bucket.max
            && (seasonFilter === 'all' || d.season === seasonFilter));
        row[pos] = inBucket.length > 0
          ? Math.round(inBucket.reduce((a, d) => a + d.fantasyPPR, 0) / inBucket.length * 10) / 10
          : null;
      }
      return row;
    });
  }, [outcomes, seasonFilter, maxADP, posFilter]);

  // ── Scatter data ──

  const scatterData = useMemo(() => {
    return filtered.map((d) => ({
      name: d.name,
      season: d.season,
      position: d.position,
      adp: d.adp,
      ppr: d.fantasyPPR,
      ppg: d.ppg,
      games: d.games,
      overallRank: d.overallRank,
      delta: d.adpDelta,
      fill: POS_COLORS[d.position] || '#8b5cf6',
    }));
  }, [filtered]);

  // ── Table: sorted ──

  const tableData = useMemo(() => {
    return [...filtered].sort((a, b) => a.adp - b.adp);
  }, [filtered]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          {loadingStatus}
          <br />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Fetching community ADP + actual stats for {SEASONS.length} seasons
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Error</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
        {outcomes.length.toLocaleString()} player-seasons joined from community PPR ADP + actual NFL stats
        ({SEASONS[0]}-{SEASONS[SEASONS.length - 1]}).
        ADP Delta = ADP pick - actual overall finish (positive = outperformed).
      </p>

      {/* Controls */}
      <div className="controls" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="control-group">
          <label className="control-label">Position</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {POSITIONS.map((pos) => (
              <button
                key={pos}
                className={`pos-filter ${posFilter === pos ? 'active' : ''}`}
                onClick={() => setPosFilter(pos)}
                style={{ borderColor: pos !== 'ALL' ? POS_COLORS[pos] : undefined }}
              >
                {pos}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <label className="control-label">Season</label>
          <select
            value={seasonFilter}
            onChange={(e) => setSeasonFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          >
            <option value="all">All Seasons (Avg)</option>
            {SEASONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label className="control-label">Max ADP</label>
          <select value={maxADP} onChange={(e) => setMaxADP(Number(e.target.value))}>
            <option value={60}>Top 60</option>
            <option value={96}>Top 96</option>
            <option value={120}>Top 120</option>
            <option value={150}>Top 150</option>
            <option value={200}>Top 200</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          {(['scatter', 'buckets', 'table'] as ViewTab[]).map((tab) => (
            <button
              key={tab}
              className={`pos-filter ${viewTab === tab ? 'active' : ''}`}
              onClick={() => setViewTab(tab)}
            >
              {tab === 'scatter' ? 'Scatter' : tab === 'buckets' ? 'By Round' : 'Table'}
            </button>
          ))}
        </div>

        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {filtered.length} players
        </span>
      </div>

      {/* Scatter: ADP vs Actual PPR Points */}
      {viewTab === 'scatter' && (
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '20px 12px 12px 0',
          marginBottom: 20,
        }}>
          <ResponsiveContainer width="100%" height={440}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 40, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
              <XAxis
                type="number"
                dataKey="adp"
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                domain={[0, maxADP]}
              >
                <Label value="ADP (Community PPR, 12-team)" position="bottom" offset={20}
                  style={{ fill: 'var(--text-secondary)', fontSize: 13 }} />
              </XAxis>
              <YAxis
                type="number"
                dataKey="ppr"
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
              >
                <Label value="Actual PPR Points" angle={-90} position="insideLeft" offset={10}
                  style={{ fill: 'var(--text-secondary)', fontSize: 13 }} />
              </YAxis>
              <Tooltip
                content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div style={{
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      padding: '8px 12px',
                      fontSize: 12,
                    }}>
                      <strong>{d.name}</strong> ({d.position}, {d.season})
                      <br />ADP: {d.adp.toFixed(1)} (Rd {adpToRound(d.adp)})
                      <br />PPR: {d.ppr} pts ({d.games}G, {d.ppg} PPG)
                      <br />Overall Finish: #{d.overallRank}
                      <br />Delta: <span style={{ color: d.delta >= 0 ? '#10b981' : '#ef4444' }}>
                        {d.delta >= 0 ? '+' : ''}{d.delta}
                      </span>
                    </div>
                  );
                }}
              />
              {/* Reference lines for round boundaries */}
              {[12, 24, 36, 48, 60, 72, 84, 96].filter((v) => v <= maxADP).map((v) => (
                <ReferenceLine key={v} x={v} stroke="var(--border)" strokeDasharray="3 3" opacity={0.5} />
              ))}
              <Scatter data={scatterData} fillOpacity={0.6} r={4} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Bucket view: expected PPR by draft round */}
      {viewTab === 'buckets' && (
        <>
          {/* Bar chart: avg PPR by round */}
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '20px 12px 12px 0',
            marginBottom: 20,
          }}>
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={bucketData} margin={{ top: 10, right: 20, bottom: 40, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  angle={-30}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}>
                  <Label value="Avg PPR Points" angle={-90} position="insideLeft" offset={10}
                    style={{ fill: 'var(--text-secondary)', fontSize: 13 }} />
                </YAxis>
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-card, #1e1e2e)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(value) => [String(Number(value).toFixed(1)), 'PPR Pts']}
                />
                <Bar dataKey="avgPPR" fill={POS_COLORS[posFilter] || '#8b5cf6'} radius={[4, 4, 0, 0]} maxBarSize={40} name="avgPPR" />
                <Bar dataKey="medianPPR" fill="#3b82f6" opacity={0.5} radius={[4, 4, 0, 0]} maxBarSize={40} name="medianPPR" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Position comparison line chart */}
          {positionBucketLines && (
            <div style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '20px 12px 12px 0',
              marginBottom: 20,
            }}>
              <h4 style={{ paddingLeft: 20, marginBottom: 8, fontSize: 14 }}>Avg PPR by Position & Round</h4>
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={positionBucketLines} margin={{ top: 10, right: 20, bottom: 40, left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                    angle={-30}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}>
                    <Label value="Avg PPR Points" angle={-90} position="insideLeft" offset={10}
                      style={{ fill: 'var(--text-secondary)', fontSize: 13 }} />
                  </YAxis>
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-card, #1e1e2e)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="QB" stroke={POS_COLORS.QB} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="RB" stroke={POS_COLORS.RB} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="WR" stroke={POS_COLORS.WR} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="TE" stroke={POS_COLORS.TE} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Bucket summary table */}
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Players</th>
                  <th>Avg PPR</th>
                  <th>Median PPR</th>
                  <th>Avg PPG</th>
                  <th>Hit Rate</th>
                  <th>Bust Rate</th>
                  <th>Avg Delta</th>
                </tr>
              </thead>
              <tbody>
                {bucketData.map((b) => (
                  <tr key={b.label}>
                    <td><strong>{b.label}</strong></td>
                    <td>{b.count}</td>
                    <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{b.avgPPR}</td>
                    <td style={{ fontFamily: 'monospace' }}>{b.medianPPR}</td>
                    <td style={{ fontFamily: 'monospace' }}>{b.avgPPG}</td>
                    <td style={{
                      fontFamily: 'monospace',
                      color: b.hitRate >= 50 ? '#10b981' : b.hitRate >= 30 ? '#f59e0b' : '#ef4444',
                    }}>
                      {b.hitRate}%
                    </td>
                    <td style={{
                      fontFamily: 'monospace',
                      color: b.bustRate <= 20 ? '#10b981' : b.bustRate <= 40 ? '#f59e0b' : '#ef4444',
                    }}>
                      {b.bustRate}%
                    </td>
                    <td style={{
                      fontFamily: 'monospace',
                      color: b.avgDelta >= 0 ? '#10b981' : '#ef4444',
                    }}>
                      {b.avgDelta >= 0 ? '+' : ''}{b.avgDelta}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Full player table */}
      {viewTab === 'table' && (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Pos</th>
                <th>Team</th>
                <th>Season</th>
                <th>ADP</th>
                <th>Rd</th>
                <th>G</th>
                <th>PPR Pts</th>
                <th>PPG</th>
                <th>Pos Rank</th>
                <th>Overall</th>
                <th>Delta</th>
              </tr>
            </thead>
            <tbody>
              {tableData.slice(0, 300).map((d, i) => (
                <tr key={`${d.name}-${d.season}-${i}`}>
                  <td><strong><PlayerName name={d.name} position={d.position} /></strong></td>
                  <td style={{ color: POS_COLORS[d.position] }}>{d.position}</td>
                  <td>{d.team}</td>
                  <td>{d.season}</td>
                  <td style={{ fontFamily: 'monospace' }}>{d.adp.toFixed(1)}</td>
                  <td>{d.adpRound}</td>
                  <td>{d.games}</td>
                  <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{d.fantasyPPR}</td>
                  <td style={{ fontFamily: 'monospace' }}>{d.ppg}</td>
                  <td>{d.position}{d.actualRank}</td>
                  <td>#{d.overallRank}</td>
                  <td style={{
                    fontFamily: 'monospace',
                    fontWeight: 700,
                    color: d.adpDelta >= 0 ? '#10b981' : '#ef4444',
                  }}>
                    {d.adpDelta >= 0 ? '+' : ''}{d.adpDelta}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
