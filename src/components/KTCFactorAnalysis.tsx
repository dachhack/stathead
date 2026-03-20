import { useState, useEffect, useMemo } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Label,
} from 'recharts';
import type { KTCPlayer, KTCPlayerHistory, PlayerStats } from '../types';
import { fetchKTCRankings, fetchKTCHistory, fetchPlayerStats } from '../data';

interface RBFactorRow {
  name: string;
  team: string;
  // KTC values
  septValue: number;
  decValue: number;
  valueDelta: number;
  valueDeltaPct: number;
  // Early-season stats (weeks 1-4)
  earlyGames: number;
  earlyCarries: number;
  earlyRushYards: number;
  earlyRushTDs: number;
  earlyTargets: number;
  earlyReceptions: number;
  earlyRecYards: number;
  earlyRecTDs: number;
  earlyFantasyPPR: number;
  earlyRushEPA: number;
  earlyRecEPA: number;
  earlyYPC: number;
  earlyPPG: number;
  earlyTargetsPerGame: number;
  earlyTotalTouches: number;
  earlyTotalYards: number;
  // Full season context
  fullSeasonGames: number;
  fullSeasonRushYards: number;
  fullSeasonFantasyPPR: number;
}

interface CorrelationResult {
  factor: string;
  key: keyof RBFactorRow;
  r: number;
  desc: string;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

// Extract value closest to a target month from KTC history
function getValueNearMonth(
  history: { d: string; v: number }[],
  year: number,
  month: number // 1-12
): number | null {
  // Look for values in the target month
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const inMonth = history.filter((h) => h.d.startsWith(prefix));
  if (inMonth.length > 0) {
    // Return the last value in that month
    return inMonth[inMonth.length - 1].v;
  }
  // Fallback: find closest date
  const target = new Date(year, month - 1, 15).getTime();
  let closest = history[0];
  let minDiff = Infinity;
  for (const h of history) {
    const diff = Math.abs(new Date(h.d).getTime() - target);
    if (diff < minDiff) {
      minDiff = diff;
      closest = h;
    }
  }
  // Only return if within 45 days
  if (minDiff < 45 * 24 * 60 * 60 * 1000) return closest.v;
  return null;
}

const FACTORS: { key: keyof RBFactorRow; label: string; desc: string }[] = [
  { key: 'earlyCarries', label: 'Early Carries', desc: 'Total carries weeks 1-4' },
  { key: 'earlyRushYards', label: 'Early Rush Yards', desc: 'Rushing yards weeks 1-4' },
  { key: 'earlyRushTDs', label: 'Early Rush TDs', desc: 'Rushing TDs weeks 1-4' },
  { key: 'earlyYPC', label: 'Early YPC', desc: 'Yards per carry weeks 1-4' },
  { key: 'earlyTargets', label: 'Early Targets', desc: 'Total targets weeks 1-4' },
  { key: 'earlyReceptions', label: 'Early Receptions', desc: 'Total receptions weeks 1-4' },
  { key: 'earlyRecYards', label: 'Early Rec Yards', desc: 'Receiving yards weeks 1-4' },
  { key: 'earlyRecTDs', label: 'Early Rec TDs', desc: 'Receiving TDs weeks 1-4' },
  { key: 'earlyTotalTouches', label: 'Early Total Touches', desc: 'Carries + receptions weeks 1-4' },
  { key: 'earlyTotalYards', label: 'Early Total Yards', desc: 'Rush + rec yards weeks 1-4' },
  { key: 'earlyFantasyPPR', label: 'Early Fantasy PPR', desc: 'PPR fantasy points weeks 1-4' },
  { key: 'earlyPPG', label: 'Early PPG', desc: 'PPR points per game weeks 1-4' },
  { key: 'earlyTargetsPerGame', label: 'Early Targets/Game', desc: 'Targets per game weeks 1-4' },
  { key: 'earlyRushEPA', label: 'Early Rush EPA', desc: 'Rushing EPA weeks 1-4' },
  { key: 'earlyRecEPA', label: 'Early Rec EPA', desc: 'Receiving EPA weeks 1-4' },
  { key: 'earlyGames', label: 'Early Games', desc: 'Games played weeks 1-4' },
  { key: 'septValue', label: 'Sept KTC Value', desc: 'Starting dynasty value in September' },
];

// Season to analyze — current KTC history likely covers 2023-2025
const ANALYSIS_SEASONS = [2023, 2024];

export function KTCFactorAnalysis() {
  const [data, setData] = useState<RBFactorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scatterFactor, setScatterFactor] = useState<keyof RBFactorRow>('earlyFantasyPPR');
  const [minSeptValue, setMinSeptValue] = useState(1000);


  useEffect(() => {
    async function analyze() {
      try {
        // 1. Get KTC rankings to get RB player IDs
        const ktcPlayers = await fetchKTCRankings('1qb');
        const rbs = ktcPlayers.filter((p) => p.position === 'RB' && p.playerID > 0);

        // 2. Fetch history for all RBs (batch)
        const histories = await fetchKTCHistory(rbs.map((r) => r.playerID));
        const historyMap = new Map<number, KTCPlayerHistory>();
        for (const h of histories) historyMap.set(h.playerID, h);

        // Build a name → KTC player map for matching
        const ktcByName = new Map<string, KTCPlayer>();
        for (const p of rbs) ktcByName.set(normalizeName(p.playerName), p);

        const rows: RBFactorRow[] = [];

        for (const season of ANALYSIS_SEASONS) {
          // 3. Get weekly stats
          const weeklyStats = await fetchPlayerStats(season);
          const rbStats = weeklyStats.filter(
            (s) => s.position === 'RB' && s.season_type === 'REG'
          );

          // Group by player
          const byPlayer = new Map<string, PlayerStats[]>();
          for (const s of rbStats) {
            const key = normalizeName(s.player_display_name);
            if (!byPlayer.has(key)) byPlayer.set(key, []);
            byPlayer.get(key)!.push(s);
          }

          // 4. For each RB, match KTC history + stats
          for (const [normalName, weeks] of byPlayer) {
            const ktcPlayer = ktcByName.get(normalName);
            if (!ktcPlayer) continue;

            const history = historyMap.get(ktcPlayer.playerID);
            if (!history) continue;

            const valueHistory = history.oneQB?.valueHistory;
            if (!valueHistory || valueHistory.length === 0) continue;

            // Get Sept and Dec values for this season
            const septVal = getValueNearMonth(valueHistory, season, 9);
            const decVal = getValueNearMonth(valueHistory, season, 12);
            if (septVal == null || decVal == null) continue;

            // Early-season stats: weeks 1-4
            const earlyWeeks = weeks.filter((w) => w.week >= 1 && w.week <= 4);
            const fullSeason = weeks;

            if (earlyWeeks.length === 0) continue;

            const earlyCarries = earlyWeeks.reduce((s, w) => s + (w.carries || 0), 0);
            const earlyRushYards = earlyWeeks.reduce((s, w) => s + (w.rushing_yards || 0), 0);
            const earlyRushTDs = earlyWeeks.reduce((s, w) => s + (w.rushing_tds || 0), 0);
            const earlyTargets = earlyWeeks.reduce((s, w) => s + (w.targets || 0), 0);
            const earlyReceptions = earlyWeeks.reduce((s, w) => s + (w.receptions || 0), 0);
            const earlyRecYards = earlyWeeks.reduce((s, w) => s + (w.receiving_yards || 0), 0);
            const earlyRecTDs = earlyWeeks.reduce((s, w) => s + (w.receiving_tds || 0), 0);
            const earlyFantasyPPR = earlyWeeks.reduce((s, w) => s + (w.fantasy_points_ppr || 0), 0);
            const earlyRushEPA = earlyWeeks.reduce((s, w) => s + (w.rushing_epa || 0), 0);
            const earlyRecEPA = earlyWeeks.reduce((s, w) => s + (w.receiving_epa || 0), 0);

            rows.push({
              name: weeks[0].player_display_name,
              team: weeks[0].recent_team,
              septValue: septVal,
              decValue: decVal,
              valueDelta: decVal - septVal,
              valueDeltaPct: septVal > 0 ? ((decVal - septVal) / septVal) * 100 : 0,
              earlyGames: earlyWeeks.length,
              earlyCarries,
              earlyRushYards,
              earlyRushTDs,
              earlyTargets,
              earlyReceptions,
              earlyRecYards,
              earlyRecTDs,
              earlyFantasyPPR: Math.round(earlyFantasyPPR * 10) / 10,
              earlyRushEPA: Math.round(earlyRushEPA * 10) / 10,
              earlyRecEPA: Math.round(earlyRecEPA * 10) / 10,
              earlyYPC: earlyCarries > 0 ? Math.round((earlyRushYards / earlyCarries) * 10) / 10 : 0,
              earlyPPG: earlyWeeks.length > 0 ? Math.round((earlyFantasyPPR / earlyWeeks.length) * 10) / 10 : 0,
              earlyTargetsPerGame: earlyWeeks.length > 0 ? Math.round((earlyTargets / earlyWeeks.length) * 10) / 10 : 0,
              earlyTotalTouches: earlyCarries + earlyReceptions,
              earlyTotalYards: earlyRushYards + earlyRecYards,
              fullSeasonGames: fullSeason.length,
              fullSeasonRushYards: fullSeason.reduce((s, w) => s + (w.rushing_yards || 0), 0),
              fullSeasonFantasyPPR: Math.round(fullSeason.reduce((s, w) => s + (w.fantasy_points_ppr || 0), 0) * 10) / 10,
            });
          }
        }

        setData(rows);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to analyze');
      } finally {
        setLoading(false);
      }
    }

    analyze();
  }, []);

  // Filter data based on controls
  const filteredData = useMemo(() => {
    return data.filter((d) => d.septValue >= minSeptValue);
  }, [data, minSeptValue]);

  // Compute correlations
  const correlations = useMemo((): CorrelationResult[] => {
    if (filteredData.length < 5) return [];
    const deltas = filteredData.map((d) => d.valueDelta);

    return FACTORS.map((f) => ({
      factor: f.label,
      key: f.key,
      r: pearson(
        filteredData.map((d) => Number(d[f.key]) || 0),
        deltas
      ),
      desc: f.desc,
    })).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  }, [filteredData]);

  // Scatter data
  const scatterData = useMemo(() => {
    return filteredData.map((d) => ({
      ...d,
      x: Number(d[scatterFactor]) || 0,
      y: d.valueDelta,
    }));
  }, [filteredData, scatterFactor]);

  const selectedFactorLabel = FACTORS.find((f) => f.key === scatterFactor)?.label || scatterFactor;

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          Analyzing KTC value changes vs early-season stats for RBs...
          <br />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Fetching KTC history + player stats for {ANALYSIS_SEASONS.join(', ')}
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Analysis failed</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
        Correlates early-season RB performance (weeks 1-4) with dynasty value changes
        from September to December. Data from {ANALYSIS_SEASONS.join(' & ')} seasons.
        Higher |r| = stronger predictor. Positive r = factor predicts value increase.
      </p>

      <div className="controls" style={{ marginBottom: 12 }}>
        <div className="control-group">
          <label className="control-label">Min Sept Value</label>
          <select
            value={minSeptValue}
            onChange={(e) => setMinSeptValue(Number(e.target.value))}
          >
            <option value={0}>All RBs</option>
            <option value={500}>500+</option>
            <option value={1000}>1000+</option>
            <option value={2000}>2000+</option>
            <option value={4000}>4000+</option>
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Scatter Factor</label>
          <select
            value={scatterFactor}
            onChange={(e) => setScatterFactor(e.target.value as keyof RBFactorRow)}
          >
            {FACTORS.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {filteredData.length} RBs analyzed
        </span>
      </div>

      {/* Correlation table */}
      <div className="table-container" style={{ marginBottom: 20 }}>
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Factor</th>
              <th>Description</th>
              <th>Correlation (r)</th>
              <th>Strength</th>
            </tr>
          </thead>
          <tbody>
            {correlations.map((c, i) => {
              const absR = Math.abs(c.r);
              const strength =
                absR >= 0.7 ? 'Strong' :
                absR >= 0.4 ? 'Moderate' :
                absR >= 0.2 ? 'Weak' : 'Negligible';
              const strengthColor =
                absR >= 0.7 ? '#10b981' :
                absR >= 0.4 ? '#f59e0b' :
                absR >= 0.2 ? '#6366f1' : 'var(--text-muted)';

              return (
                <tr
                  key={c.key}
                  onClick={() => setScatterFactor(c.key)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="rank-cell">{i + 1}</td>
                  <td><strong>{c.factor}</strong></td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{c.desc}</td>
                  <td>
                    <span
                      style={{
                        color: c.r >= 0 ? '#10b981' : '#ef4444',
                        fontWeight: 700,
                        fontFamily: 'monospace',
                      }}
                    >
                      {c.r >= 0 ? '+' : ''}{c.r.toFixed(3)}
                    </span>
                  </td>
                  <td>
                    <span style={{ color: strengthColor, fontWeight: 600, fontSize: 12 }}>
                      {strength}
                    </span>
                    <div
                      style={{
                        marginTop: 2,
                        height: 4,
                        borderRadius: 2,
                        width: `${absR * 100}%`,
                        background: strengthColor,
                        opacity: 0.6,
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Scatter plot */}
      {scatterData.length > 0 && (
        <div
          style={{
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            padding: '20px 12px 12px 0',
            marginBottom: 20,
          }}
        >
          <ResponsiveContainer width="100%" height={400}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 40, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
              <XAxis
                type="number"
                dataKey="x"
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                stroke="var(--border)"
              >
                <Label
                  value={selectedFactorLabel}
                  position="bottom"
                  offset={20}
                  style={{ fill: 'var(--text-secondary)', fontSize: 13 }}
                />
              </XAxis>
              <YAxis
                type="number"
                dataKey="y"
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                stroke="var(--border)"
              >
                <Label
                  value="KTC Value Change (Sep → Dec)"
                  angle={-90}
                  position="insideLeft"
                  offset={10}
                  style={{ fill: 'var(--text-secondary)', fontSize: 13 }}
                />
              </YAxis>
              <Tooltip
                content={({ payload }) => {
                  if (!payload || payload.length === 0) return null;
                  const d = payload[0].payload as RBFactorRow & { x: number; y: number };
                  return (
                    <div
                      style={{
                        background: 'var(--bg-tertiary)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)',
                        padding: '10px 14px',
                        fontSize: 13,
                        lineHeight: 1.6,
                      }}
                    >
                      <strong>{d.name}</strong> ({d.team})
                      <br />
                      Sept Value: {d.septValue.toLocaleString()} → Dec: {d.decValue.toLocaleString()}
                      <br />
                      <span style={{ color: d.valueDelta >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                        {d.valueDelta >= 0 ? '+' : ''}{d.valueDelta.toLocaleString()} ({d.valueDeltaPct >= 0 ? '+' : ''}{d.valueDeltaPct.toFixed(1)}%)
                      </span>
                      <br />
                      {selectedFactorLabel}: {d.x}
                      <br />
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        Wk1-4: {d.earlyCarries} car, {d.earlyRushYards} rush, {d.earlyTargets} tgt, {d.earlyFantasyPPR} PPR
                      </span>
                    </div>
                  );
                }}
              />
              <Scatter data={scatterData} fill="#6366f1" fillOpacity={0.7} r={5} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Top risers and fallers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        <div>
          <h4 style={{ marginBottom: 8, color: '#10b981' }}>Top Value Risers</h4>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Sept</th>
                  <th>Dec</th>
                  <th>Delta</th>
                </tr>
              </thead>
              <tbody>
                {[...filteredData]
                  .sort((a, b) => b.valueDelta - a.valueDelta)
                  .slice(0, 10)
                  .map((d) => (
                    <tr key={d.name}>
                      <td><strong>{d.name}</strong></td>
                      <td>{d.septValue.toLocaleString()}</td>
                      <td>{d.decValue.toLocaleString()}</td>
                      <td className="stat-positive">+{d.valueDelta.toLocaleString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h4 style={{ marginBottom: 8, color: '#ef4444' }}>Top Value Fallers</h4>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Sept</th>
                  <th>Dec</th>
                  <th>Delta</th>
                </tr>
              </thead>
              <tbody>
                {[...filteredData]
                  .sort((a, b) => a.valueDelta - b.valueDelta)
                  .slice(0, 10)
                  .map((d) => (
                    <tr key={d.name}>
                      <td><strong>{d.name}</strong></td>
                      <td>{d.septValue.toLocaleString()}</td>
                      <td>{d.decValue.toLocaleString()}</td>
                      <td className="stat-negative">{d.valueDelta.toLocaleString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Full data table */}
      <details>
        <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13, marginBottom: 8 }}>
          Full dataset ({filteredData.length} RBs)
        </summary>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Team</th>
                <th>Sept Val</th>
                <th>Dec Val</th>
                <th>Delta</th>
                <th>Delta %</th>
                <th>Wk1-4 G</th>
                <th>Wk1-4 Car</th>
                <th>Wk1-4 Rush</th>
                <th>Wk1-4 YPC</th>
                <th>Wk1-4 Tgt</th>
                <th>Wk1-4 Rec</th>
                <th>Wk1-4 PPR</th>
                <th>Wk1-4 PPG</th>
              </tr>
            </thead>
            <tbody>
              {[...filteredData]
                .sort((a, b) => b.valueDelta - a.valueDelta)
                .map((d) => (
                  <tr key={d.name}>
                    <td><strong>{d.name}</strong></td>
                    <td>{d.team}</td>
                    <td>{d.septValue.toLocaleString()}</td>
                    <td>{d.decValue.toLocaleString()}</td>
                    <td style={{ color: d.valueDelta >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                      {d.valueDelta >= 0 ? '+' : ''}{d.valueDelta.toLocaleString()}
                    </td>
                    <td style={{ color: d.valueDeltaPct >= 0 ? '#10b981' : '#ef4444' }}>
                      {d.valueDeltaPct >= 0 ? '+' : ''}{d.valueDeltaPct.toFixed(1)}%
                    </td>
                    <td>{d.earlyGames}</td>
                    <td>{d.earlyCarries}</td>
                    <td>{d.earlyRushYards}</td>
                    <td>{d.earlyYPC}</td>
                    <td>{d.earlyTargets}</td>
                    <td>{d.earlyReceptions}</td>
                    <td>{d.earlyFantasyPPR}</td>
                    <td>{d.earlyPPG}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
