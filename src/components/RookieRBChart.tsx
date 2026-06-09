import { useState, useEffect, useMemo } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  Label,
} from 'recharts';
import { fetchDraftPicks, fetchPlayerStats, aggregateToSeasonTotals, fetchEspnADP, fetchFfcADP } from '../data';
import { normalizeNameSimple as normalizeName } from '../lib/nameMatch';


interface RookieRBData {
  name: string;
  season: number;
  team: string;
  draftPick: number;
  draftRound: number;
  espnAdp: number | null;
  ffcAdp: number | null;
  games: number;
  fantasyPointsPPR: number;
  pprRank: number;
  posRank: number;
  ppg: number;
}

const SEASON_COLORS: Record<number, string> = {
  2020: '#ff6464',
  2021: '#64c8ff',
  2022: '#64ff96',
  2023: '#ffc864',
  2024: '#c896ff',
};

const SEASONS = [2020, 2021, 2022, 2023, 2024];

export function RookieRBChart() {
  const [data, setData] = useState<RookieRBData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minGames, setMinGames] = useState(5);
  const [metric, setMetric] = useState<'pprRank' | 'fantasyPointsPPR' | 'ppg'>('pprRank');
  const [xAxis, setXAxis] = useState<'draftPick' | 'espnAdp' | 'ffcAdp'>('draftPick');

  useEffect(() => {
    async function loadData() {
      try {
        // Fetch draft picks
        const allDraftPicks = await fetchDraftPicks();
        const rookieRBs: RookieRBData[] = [];

        for (const season of SEASONS) {
          // Get RBs drafted this season
          const draftedRBs = allDraftPicks.filter(
            (d) => d.season === season && d.position === 'RB' && d.pfr_player_name
          );

          // Get player stats for this season
          const weeklyStats = await fetchPlayerStats(season);
          const seasonTotals = aggregateToSeasonTotals(
            weeklyStats.filter((s) => s.season_type === 'REG')
          );

          // Try to get ESPN ADP for this season (may fail due to CORS)
          let espnAdpMap: Map<string, number> | null = null;
          try {
            const espnData = await fetchEspnADP(season);
            espnAdpMap = new Map<string, number>();
            for (const p of espnData) {
              if (p.position === 'RB' && p.draftRankPpr > 0) {
                espnAdpMap.set(normalizeName(p.name), p.adp > 0 ? p.adp : p.draftRankPpr);
              }
            }
          } catch {
            // ESPN API may not be available; continue with draft pick only
          }

          // Try to get FFC ADP for this season
          let ffcAdpMap: Map<string, number> | null = null;
          try {
            const ffcData = await fetchFfcADP(season, 'ppr');
            ffcAdpMap = new Map<string, number>();
            for (const p of ffcData) {
              if (p.position === 'RB' && p.adp > 0) {
                ffcAdpMap.set(normalizeName(p.name), p.adp);
              }
            }
          } catch {
            // FFC API may not be available; continue without it
          }

          // Rank all RBs by PPR points
          const allRBs = seasonTotals
            .filter((p) => p.position === 'RB')
            .sort((a, b) => b.fantasy_points_ppr - a.fantasy_points_ppr);

          // Also rank overall
          const allPlayers = [...seasonTotals].sort(
            (a, b) => b.fantasy_points_ppr - a.fantasy_points_ppr
          );

          // Match draft picks to season stats
          for (const draft of draftedRBs) {
            const draftName = normalizeName(draft.pfr_player_name);
            const match = seasonTotals.find(
              (p) =>
                p.position === 'RB' &&
                normalizeName(p.player_display_name) === draftName
            );

            if (match) {
              const posRank =
                allRBs.findIndex((p) => p.player_id === match.player_id) + 1;
              const pprRank =
                allPlayers.findIndex((p) => p.player_id === match.player_id) +
                1;

              const matchName = normalizeName(match.player_display_name);
              const espnAdp = espnAdpMap?.get(matchName) ?? null;
              const ffcAdp = ffcAdpMap?.get(matchName) ?? null;

              rookieRBs.push({
                name: match.player_display_name,
                season,
                team: match.recent_team,
                draftPick: draft.pick,
                draftRound: draft.round,
                espnAdp,
                ffcAdp,
                games: match.games,
                fantasyPointsPPR: Math.round(match.fantasy_points_ppr * 10) / 10,
                pprRank,
                posRank,
                ppg:
                  match.games > 0
                    ? Math.round((match.fantasy_points_ppr / match.games) * 10) / 10
                    : 0,
              });
            }
          }
        }

        setData(rookieRBs);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, []);

  const hasEspnAdp = data.some((d) => d.espnAdp != null);
  const hasFfcAdp = data.some((d) => d.ffcAdp != null);

  const filtered = useMemo(
    () => data.filter((d) => {
      if (d.games < minGames) return false;
      if (xAxis === 'espnAdp' && d.espnAdp == null) return false;
      if (xAxis === 'ffcAdp' && d.ffcAdp == null) return false;
      return true;
    }),
    [data, minGames, xAxis]
  );

  const xLabel = xAxis === 'draftPick' ? 'NFL Draft Pick'
    : xAxis === 'ffcAdp' ? 'Community ADP (PPR)'
    : 'ESPN Fantasy ADP';
  const xDataKey = xAxis;

  const yLabel = metric === 'pprRank'
    ? 'End-of-Season PPR Rank (Overall)'
    : metric === 'fantasyPointsPPR'
      ? 'Total PPR Fantasy Points'
      : 'PPR Points Per Game';

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          Loading 5 seasons of rookie RB data... (this fetches multiple seasons)
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Failed to load data</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ marginBottom: 4 }}>Rookie RB Draft Capital vs Fantasy Production (2020-2024)</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
        NFL Draft pick vs end-of-season fantasy finish for all drafted rookie running backs.
        {metric === 'pprRank' && ' Lower rank = better finish.'}
      </p>

      <div className="controls" style={{ marginBottom: 16 }}>
        <div className="control-group">
          <label className="control-label">X-Axis</label>
          <select
            value={xAxis}
            onChange={(e) => setXAxis(e.target.value as typeof xAxis)}
          >
            <option value="draftPick">NFL Draft Pick</option>
            <option value="ffcAdp" disabled={!hasFfcAdp}>
              Community ADP{!hasFfcAdp ? ' (unavailable)' : ''}
            </option>
            <option value="espnAdp" disabled={!hasEspnAdp}>
              ESPN ADP{!hasEspnAdp ? ' (unavailable)' : ''}
            </option>
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Y-Axis</label>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as typeof metric)}
          >
            <option value="pprRank">Overall PPR Rank</option>
            <option value="fantasyPointsPPR">Total PPR Points</option>
            <option value="ppg">PPR Points Per Game</option>
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Min Games</label>
          <select
            value={minGames}
            onChange={(e) => setMinGames(Number(e.target.value))}
          >
            <option value={1}>1+</option>
            <option value={5}>5+</option>
            <option value={8}>8+</option>
            <option value={10}>10+</option>
            <option value={14}>14+</option>
          </select>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {filtered.length} rookie RBs shown
        </span>
      </div>

      <div
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          padding: '20px 12px 12px 0',
        }}
      >
        <ResponsiveContainer width="100%" height={520}>
          <ScatterChart margin={{ top: 10, right: 20, bottom: 40, left: 20 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border)"
              opacity={0.5}
            />
            <XAxis
              type="number"
              dataKey={xDataKey}
              name={xLabel}
              domain={[0, xAxis === 'draftPick' ? 270 : 'dataMax']}
              tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
              stroke="var(--border)"
            >
              <Label
                value={xLabel}
                position="bottom"
                offset={20}
                style={{ fill: 'var(--text-secondary)', fontSize: 13 }}
              />
            </XAxis>
            <YAxis
              type="number"
              dataKey={metric}
              name={yLabel}
              reversed={metric === 'pprRank'}
              tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
              stroke="var(--border)"
            >
              <Label
                value={yLabel}
                angle={-90}
                position="insideLeft"
                offset={10}
                style={{ fill: 'var(--text-secondary)', fontSize: 13 }}
              />
            </YAxis>
            <Tooltip
              content={({ payload }) => {
                if (!payload || payload.length === 0) return null;
                const d = payload[0].payload as RookieRBData;
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
                    <strong style={{ color: SEASON_COLORS[d.season] }}>
                      {d.name}
                    </strong>
                    <br />
                    {d.season} | {d.team} | Rd {d.draftRound}, Pick #{d.draftPick}
                    {d.ffcAdp != null && (
                      <> | Community ADP: {d.ffcAdp.toFixed(1)}</>
                    )}
                    {d.espnAdp != null && (
                      <> | ESPN ADP: {d.espnAdp.toFixed(1)}</>
                    )}
                    <br />
                    {d.games}G | {d.fantasyPointsPPR} PPR pts | {d.ppg} ppg
                    <br />
                    Overall Rank: #{d.pprRank} | RB Rank: #{d.posRank}
                  </div>
                );
              }}
            />
            <Legend
              verticalAlign="top"
              wrapperStyle={{ paddingBottom: 8, fontSize: 13 }}
            />

            {/* Reference lines for draft rounds */}
            <ReferenceLine
              x={32}
              stroke="var(--text-muted)"
              strokeDasharray="3 3"
              opacity={0.4}
              label={{ value: 'Rd 1', fill: 'var(--text-muted)', fontSize: 11, position: 'top' }}
            />
            <ReferenceLine
              x={64}
              stroke="var(--text-muted)"
              strokeDasharray="3 3"
              opacity={0.3}
              label={{ value: 'Rd 2', fill: 'var(--text-muted)', fontSize: 11, position: 'top' }}
            />

            {SEASONS.map((season) => (
              <Scatter
                key={season}
                name={String(season)}
                data={filtered.filter((d) => d.season === season)}
                fill={SEASON_COLORS[season]}
                fillOpacity={0.8}
                r={6}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {/* Data table below */}
      <div className="table-container" style={{ marginTop: 20 }}>
        <table>
          <thead>
            <tr>
              <th>Season</th>
              <th>Player</th>
              <th>Team</th>
              <th>Draft</th>
              <th>Community ADP</th>
              <th>ESPN ADP</th>
              <th>G</th>
              <th>PPR Pts</th>
              <th>PPG</th>
              <th>Overall Rank</th>
              <th>RB Rank</th>
            </tr>
          </thead>
          <tbody>
            {[...filtered]
              .sort((a, b) => a.pprRank - b.pprRank)
              .map((d) => (
                <tr key={`${d.season}-${d.name}`}>
                  <td>
                    <span style={{ color: SEASON_COLORS[d.season], fontWeight: 600 }}>
                      {d.season}
                    </span>
                  </td>
                  <td>
                    <strong>{d.name}</strong>
                  </td>
                  <td>{d.team}</td>
                  <td>
                    Rd {d.draftRound}, #{d.draftPick}
                  </td>
                  <td>{d.ffcAdp != null ? d.ffcAdp.toFixed(1) : '-'}</td>
                  <td>{d.espnAdp != null ? d.espnAdp.toFixed(1) : '-'}</td>
                  <td>{d.games}</td>
                  <td className="stat-positive">{d.fantasyPointsPPR}</td>
                  <td>{d.ppg}</td>
                  <td>#{d.pprRank}</td>
                  <td>RB{d.posRank}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

