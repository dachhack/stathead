import React, { useState, useEffect, useMemo } from 'react';
import { fetchPlayerStats, fetchGames, aggregateToSeasonTotals } from '../data';
import type { SeasonTotals, Game } from '../types';
import projectionConfig from '../generated/projection-config.json';

// ── Types ──

interface TeamSeasonTotals {
  team: string;
  passAtt: number;
  passComp: number;
  passYds: number;
  passTD: number;
  int: number;
  rushAtt: number;
  rushYds: number;
  rushTD: number;
  targets: number;
  receptions: number;
  recYds: number;
  recTD: number;
}

interface BacktestRow {
  team: string;
  actual: TeamSeasonTotals;
  projected: TeamSeasonTotals;
}

interface SeasonBacktest {
  season: number;
  rows: BacktestRow[];
  errors: Record<string, { mae: number; rmse: number; meanActual: number; pctError: number }>;
}

type StatKey = keyof Omit<TeamSeasonTotals, 'team'>;

const STAT_KEYS: StatKey[] = [
  'passAtt', 'passComp', 'passYds', 'passTD', 'int',
  'rushAtt', 'rushYds', 'rushTD',
  'targets', 'receptions', 'recYds', 'recTD',
];

const STAT_LABELS: Record<StatKey, string> = {
  passAtt: 'Pass Att', passComp: 'Pass Cmp', passYds: 'Pass Yds', passTD: 'Pass TD', int: 'INT',
  rushAtt: 'Rush Att', rushYds: 'Rush Yds', rushTD: 'Rush TD',
  targets: 'Targets', receptions: 'Receptions', recYds: 'Rec Yds', recTD: 'Rec TD',
};

// Static config from build-time sweep
const TEAM_WEIGHT = projectionConfig.winner.teamWeight;
const LEAGUE_WEIGHT = projectionConfig.winner.leagueWeight;
const USE_VEGAS = projectionConfig.winner.useVegas;
const VEGAS_BLEND = projectionConfig.winner.vegasBlend;
const VEGAS_CAP = projectionConfig.winner.vegasCap;

// ── Helpers ──

function aggregateTeamTotals(playerTotals: SeasonTotals[]): Map<string, TeamSeasonTotals> {
  const byTeam = new Map<string, TeamSeasonTotals>();
  for (const p of playerTotals) {
    if (!p.recent_team || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
    if (!byTeam.has(p.recent_team)) {
      byTeam.set(p.recent_team, {
        team: p.recent_team,
        passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
        rushAtt: 0, rushYds: 0, rushTD: 0,
        targets: 0, receptions: 0, recYds: 0, recTD: 0,
      });
    }
    const t = byTeam.get(p.recent_team)!;
    t.passAtt += p.attempts || 0;
    t.passComp += p.completions || 0;
    t.passYds += p.passing_yards || 0;
    t.passTD += p.passing_tds || 0;
    t.int += p.interceptions || 0;
    t.rushAtt += p.carries || 0;
    t.rushYds += p.rushing_yards || 0;
    t.rushTD += p.rushing_tds || 0;
    t.targets += p.targets || 0;
    t.receptions += p.receptions || 0;
    t.recYds += p.receiving_yards || 0;
    t.recTD += p.receiving_tds || 0;
  }
  return byTeam;
}

function computeLeagueAvg(teams: Map<string, TeamSeasonTotals>): TeamSeasonTotals {
  const avg: TeamSeasonTotals = {
    team: 'AVG', passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
    rushAtt: 0, rushYds: 0, rushTD: 0, targets: 0, receptions: 0, recYds: 0, recTD: 0,
  };
  const n = teams.size || 1;
  for (const t of teams.values()) {
    for (const k of STAT_KEYS) avg[k] += t[k];
  }
  for (const k of STAT_KEYS) avg[k] = Math.round(avg[k] / n);
  return avg;
}

function computeVegasMultiplier(
  team: string,
  games: Game[],
  season: number,
): number {
  if (!USE_VEGAS) return 1;
  const seasonGames = games.filter(
    (g) => g.season === season - 1 && g.game_type === 'REG' && g.total_line > 0
  );
  if (seasonGames.length === 0) return 1;

  const teamImplied: Record<string, { sum: number; count: number }> = {};
  for (const g of seasonGames) {
    const homeImpl = (g.total_line - g.spread_line) / 2;
    const awayImpl = (g.total_line + g.spread_line) / 2;
    if (!teamImplied[g.home_team]) teamImplied[g.home_team] = { sum: 0, count: 0 };
    if (!teamImplied[g.away_team]) teamImplied[g.away_team] = { sum: 0, count: 0 };
    teamImplied[g.home_team].sum += homeImpl;
    teamImplied[g.home_team].count += 1;
    teamImplied[g.away_team].sum += awayImpl;
    teamImplied[g.away_team].count += 1;
  }

  let leagueSum = 0; let leagueCount = 0;
  for (const v of Object.values(teamImplied)) {
    leagueSum += v.sum; leagueCount += v.count;
  }
  const leagueAvg = leagueCount > 0 ? leagueSum / leagueCount : 23;

  const t = teamImplied[team];
  if (!t || t.count === 0) return 1;
  const teamAvg = t.sum / t.count;
  const blended = teamAvg * VEGAS_BLEND + leagueAvg * (1 - VEGAS_BLEND);
  return Math.max(1 - VEGAS_CAP, Math.min(1 + VEGAS_CAP, blended / leagueAvg));
}

function projectTeamTotals(
  priorTeams: Map<string, TeamSeasonTotals>,
  leagueAvg: TeamSeasonTotals,
  games: Game[],
  targetSeason: number,
): Map<string, TeamSeasonTotals> {
  const projected = new Map<string, TeamSeasonTotals>();
  for (const [team, prior] of priorTeams) {
    const vm = computeVegasMultiplier(team, games, targetSeason);
    const proj: TeamSeasonTotals = { team } as TeamSeasonTotals;
    for (const k of STAT_KEYS) {
      proj[k] = Math.round((prior[k] * TEAM_WEIGHT + leagueAvg[k] * LEAGUE_WEIGHT) * vm);
    }
    projected.set(team, proj);
  }
  return projected;
}

function computeErrors(rows: BacktestRow[]): Record<string, { mae: number; rmse: number; meanActual: number; pctError: number }> {
  const errors: Record<string, { mae: number; rmse: number; meanActual: number; pctError: number }> = {};
  for (const k of STAT_KEYS) {
    let sumAE = 0; let sumSE = 0; let sumActual = 0;
    let n = 0;
    for (const r of rows) {
      const diff = r.projected[k] - r.actual[k];
      sumAE += Math.abs(diff);
      sumSE += diff * diff;
      sumActual += r.actual[k];
      n++;
    }
    const mae = n > 0 ? sumAE / n : 0;
    const rmse = n > 0 ? Math.sqrt(sumSE / n) : 0;
    const meanActual = n > 0 ? sumActual / n : 0;
    const pctError = meanActual > 0 ? (mae / meanActual) * 100 : 0;
    errors[k] = { mae: Math.round(mae), rmse: Math.round(rmse), meanActual: Math.round(meanActual), pctError: Math.round(pctError * 10) / 10 };
  }
  return errors;
}

// ── Component ──

const TEST_SEASONS = projectionConfig.testSeasons as number[];

export function TeamTotalsBacktest() {
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<SeasonBacktest[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<number | 'all'>(TEST_SEASONS[0]);
  const [sortCol, setSortCol] = useState<StatKey | 'team'>('passYds');
  const [sortAsc, setSortAsc] = useState(true);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setLoadingStatus('Loading game data...');
        const gamesData = await fetchGames().catch(() => [] as Game[]);
        if (cancelled) return;

        const backtests: SeasonBacktest[] = [];

        for (const season of TEST_SEASONS) {
          if (cancelled) return;
          setLoadingStatus(`Loading ${season - 1} & ${season} stats...`);

          const [priorStats, actualStats] = await Promise.all([
            fetchPlayerStats(season - 1).catch(() => []),
            fetchPlayerStats(season).catch(() => []),
          ]);
          if (cancelled) return;

          const priorTotals = aggregateToSeasonTotals(
            priorStats.filter((s) => s.season_type === 'REG')
          );
          const actualTotals = aggregateToSeasonTotals(
            actualStats.filter((s) => s.season_type === 'REG')
          );

          const priorTeams = aggregateTeamTotals(priorTotals);
          const actualTeams = aggregateTeamTotals(actualTotals);
          const leagueAvg = computeLeagueAvg(priorTeams);

          const projected = projectTeamTotals(priorTeams, leagueAvg, gamesData, season);

          const rows: BacktestRow[] = [];
          for (const [team, proj] of projected) {
            const actual = actualTeams.get(team);
            if (!actual) continue;
            rows.push({ team, actual, projected: proj });
          }

          rows.sort((a, b) => a.team.localeCompare(b.team));
          const errors = computeErrors(rows);
          backtests.push({ season, rows, errors });
        }

        if (!cancelled) {
          setResults(backtests);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to run backtest');
          setLoading(false);
        }
      }
    }

    run();
    return () => { cancelled = true; };
  }, []);

  // Aggregate errors across all seasons
  const allSeasonErrors = useMemo(() => {
    if (results.length === 0) return null;
    const allRows = results.flatMap((r) => r.rows);
    return computeErrors(allRows);
  }, [results]);

  const currentData = useMemo(() => {
    if (selectedSeason === 'all') return null;
    const bt = results.find((r) => r.season === selectedSeason);
    if (!bt) return null;

    const sorted = [...bt.rows].sort((a, b) => {
      if (sortCol === 'team') return sortAsc ? a.team.localeCompare(b.team) : b.team.localeCompare(a.team);
      const av = showDiff ? a.projected[sortCol] - a.actual[sortCol] : a.actual[sortCol];
      const bv = showDiff ? b.projected[sortCol] - b.actual[sortCol] : b.actual[sortCol];
      return sortAsc ? av - bv : bv - av;
    });
    return { ...bt, rows: sorted };
  }, [results, selectedSeason, sortCol, sortAsc, showDiff]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          {loadingStatus}
          <br />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Fetching multi-season data for backtesting
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

  const thS: React.CSSProperties = { fontSize: 10, padding: '4px 6px', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' };
  const tdS: React.CSSProperties = { fontSize: 11, padding: '4px 6px', textAlign: 'right' };

  function handleSort(col: StatKey | 'team') {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(col === 'team'); }
  }

  function diffColor(diff: number, scale: number): string {
    const pct = Math.abs(diff) / Math.max(scale, 1);
    if (pct < 0.05) return 'var(--text-secondary)';
    if (diff > 0) return pct > 0.15 ? '#ef4444' : '#f59e0b';
    return pct > 0.15 ? '#10b981' : '#6ee7b7';
  }

  const configLabel = `${Math.round(TEAM_WEIGHT * 100)}/${Math.round(LEAGUE_WEIGHT * 100)}` +
    (USE_VEGAS ? ` + Vegas (blend ${Math.round(VEGAS_BLEND * 100)}%, cap ±${Math.round(VEGAS_CAP * 100)}%)` : ' (no Vegas)');

  return (
    <div>
      <h3 style={{ marginBottom: 4 }}>Team Totals Backtest</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        Optimal config from build-time sweep of {projectionConfig.configsTested} configurations across {TEST_SEASONS.length} seasons:
        {' '}<strong style={{ color: '#10b981' }}>{configLabel}</strong>
        {' '}— {projectionConfig.avgPctError}% avg error
      </p>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
        Generated {new Date(projectionConfig.generatedAt).toLocaleDateString()}.
        Re-run <code style={{ fontSize: 10, background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>node scripts/sweep-projection-config.js</code> after adding new data.
      </p>

      {/* Top configs from sweep */}
      <details style={{ marginBottom: 16 }}>
        <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)' }}>
          Top 10 configurations from sweep
        </summary>
        <div className="table-container" style={{ marginTop: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...thS, textAlign: 'center', width: 30 }}>#</th>
                <th style={{ ...thS, textAlign: 'left' }}>Team%</th>
                <th style={{ ...thS, textAlign: 'left' }}>Vegas</th>
                <th style={{ ...thS, textAlign: 'center' }}>Avg Err%</th>
                {STAT_KEYS.map((k) => (
                  <th key={k} style={{ ...thS, textAlign: 'center', fontSize: 9 }}>{STAT_LABELS[k]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projectionConfig.top10.map((r) => (
                <tr key={r.rank} style={{
                  background: r.rank === 1 ? 'rgba(16,185,129,0.08)' : undefined,
                  fontWeight: r.rank === 1 ? 700 : 400,
                }}>
                  <td style={{ ...tdS, textAlign: 'center', color: r.rank === 1 ? '#10b981' : 'var(--text-muted)' }}>
                    {r.rank}{r.rank === 1 ? ' ★' : ''}
                  </td>
                  <td style={{ ...tdS, textAlign: 'left', fontSize: 10 }}>
                    {Math.round(r.teamWeight * 100)}/{Math.round((1 - r.teamWeight) * 100)}
                  </td>
                  <td style={{ ...tdS, textAlign: 'left', fontSize: 10 }}>
                    {r.useVegas ? `b${Math.round(r.vegasBlend * 100)} c±${Math.round(r.vegasCap * 100)}` : 'none'}
                  </td>
                  <td style={{ ...tdS, textAlign: 'center', fontWeight: 700,
                    color: r.avgPctError <= projectionConfig.top10[0].avgPctError + 0.5 ? '#10b981' : '#f59e0b' }}>
                    {r.avgPctError}%
                  </td>
                  {STAT_KEYS.map((k) => (
                    <td key={k} style={{ ...tdS, textAlign: 'center', fontSize: 10,
                      color: (r.statErrors as Record<string, number>)[k] <= 5 ? '#10b981' : (r.statErrors as Record<string, number>)[k] <= 10 ? '#f59e0b' : '#ef4444' }}>
                      {(r.statErrors as Record<string, number>)[k]}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* Season selector */}
      <div className="controls" style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="control-group">
          <label className="control-label">Season</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {TEST_SEASONS.map((s) => (
              <button
                key={s}
                className={`pos-filter ${selectedSeason === s ? 'active' : ''}`}
                onClick={() => setSelectedSeason(s)}
              >
                {s}
              </button>
            ))}
            <button
              className={`pos-filter ${selectedSeason === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedSeason('all')}
              style={{ borderColor: '#6366f1' }}
            >
              All (Avg)
            </button>
          </div>
        </div>

        {selectedSeason !== 'all' && (
          <div className="control-group">
            <label className="control-label">Show</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className={`pos-filter ${!showDiff ? 'active' : ''}`}
                onClick={() => setShowDiff(false)}
              >
                Actual vs Proj
              </button>
              <button
                className={`pos-filter ${showDiff ? 'active' : ''}`}
                onClick={() => setShowDiff(true)}
              >
                Difference
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Error summary table */}
      {(selectedSeason === 'all' || currentData) && (() => {
        const errors = selectedSeason === 'all' ? allSeasonErrors : currentData?.errors;
        if (!errors) return null;

        return (
          <div style={{ marginBottom: 24 }}>
            <h4 style={{ marginBottom: 8 }}>
              Accuracy Summary{selectedSeason === 'all' ? ` — All ${TEST_SEASONS.length} Seasons Combined` : ` — ${selectedSeason}`}
            </h4>
            <div className="table-container">
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ ...thS, textAlign: 'left' }}>Stat</th>
                    <th style={thS}>Avg Actual</th>
                    <th style={thS}>MAE</th>
                    <th style={thS}>RMSE</th>
                    <th style={thS}>Error %</th>
                    <th style={{ ...thS, textAlign: 'left', width: 200 }}>Accuracy</th>
                  </tr>
                </thead>
                <tbody>
                  {STAT_KEYS.map((k) => {
                    const e = errors[k];
                    const accuracy = 100 - e.pctError;
                    const barColor = accuracy >= 95 ? '#10b981' : accuracy >= 90 ? '#6ee7b7' : accuracy >= 85 ? '#f59e0b' : '#ef4444';
                    return (
                      <tr key={k}>
                        <td style={{ ...tdS, textAlign: 'left', fontWeight: 600 }}>{STAT_LABELS[k]}</td>
                        <td style={tdS}>{e.meanActual.toLocaleString()}</td>
                        <td style={tdS}>{e.mae.toLocaleString()}</td>
                        <td style={tdS}>{e.rmse.toLocaleString()}</td>
                        <td style={{ ...tdS, color: e.pctError <= 5 ? '#10b981' : e.pctError <= 10 ? '#f59e0b' : '#ef4444', fontWeight: 700 }}>
                          {e.pctError}%
                        </td>
                        <td style={{ ...tdS, textAlign: 'left' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 12, background: 'var(--bg-secondary)', borderRadius: 4, overflow: 'hidden' }}>
                              <div style={{ width: `${Math.min(accuracy, 100)}%`, height: '100%', background: barColor, borderRadius: 4 }} />
                            </div>
                            <span style={{ fontSize: 10, fontWeight: 700, color: barColor, minWidth: 36 }}>{accuracy.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Per-season comparison table */}
      {selectedSeason !== 'all' && currentData && (
        <div style={{ marginBottom: 24 }}>
          <h4 style={{ marginBottom: 8 }}>
            {selectedSeason} Team-by-Team — Projected (from {selectedSeason - 1} data, {configLabel}) vs Actual
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
              {currentData.rows.length} teams · click headers to sort
            </span>
          </h4>
          <div className="table-container" style={{ maxHeight: 700, overflowY: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th
                    style={{ ...thS, textAlign: 'left' }}
                    onClick={() => handleSort('team')}
                  >
                    Team{sortCol === 'team' ? (sortAsc ? ' ▲' : ' ▼') : ''}
                  </th>
                  {STAT_KEYS.map((k) => (
                    <th
                      key={k}
                      colSpan={showDiff ? 1 : 2}
                      style={{ ...thS, textAlign: 'center', borderBottom: sortCol === k ? '2px solid var(--text-primary)' : undefined }}
                      onClick={() => handleSort(k)}
                    >
                      {STAT_LABELS[k]}{sortCol === k ? (sortAsc ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
                {!showDiff && (
                  <tr>
                    <th style={thS}></th>
                    {STAT_KEYS.map((k) => (
                      <React.Fragment key={k}>
                        <th style={{ ...thS, fontSize: 9, color: 'var(--text-muted)' }}>Act</th>
                        <th style={{ ...thS, fontSize: 9, color: 'var(--text-muted)' }}>Proj</th>
                      </React.Fragment>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {currentData.rows.map((r) => (
                  <tr key={r.team}>
                    <td style={{ ...tdS, textAlign: 'left', fontWeight: 700 }}>{r.team}</td>
                    {STAT_KEYS.map((k) => {
                      const actual = r.actual[k];
                      const proj = r.projected[k];
                      const diff = proj - actual;
                      if (showDiff) {
                        return (
                          <td key={k} style={{ ...tdS, color: diffColor(diff, actual), fontWeight: Math.abs(diff / Math.max(actual, 1)) > 0.1 ? 700 : 400 }}>
                            {diff > 0 ? '+' : ''}{diff.toLocaleString()}
                          </td>
                        );
                      }
                      return (
                        <React.Fragment key={k}>
                          <td style={tdS}>{actual.toLocaleString()}</td>
                          <td style={{ ...tdS, color: diffColor(diff, actual) }}>{proj.toLocaleString()}</td>
                        </React.Fragment>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Cross-season trend */}
      {results.length > 1 && (
        <div style={{ marginBottom: 24 }}>
          <h4 style={{ marginBottom: 8 }}>Error % by Season</h4>
          <div className="table-container">
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...thS, textAlign: 'left' }}>Stat</th>
                  {results.map((r) => (
                    <th key={r.season} style={thS}>{r.season}</th>
                  ))}
                  <th style={{ ...thS, fontWeight: 700 }}>Avg</th>
                </tr>
              </thead>
              <tbody>
                {STAT_KEYS.map((k) => (
                  <tr key={k}>
                    <td style={{ ...tdS, textAlign: 'left', fontWeight: 600 }}>{STAT_LABELS[k]}</td>
                    {results.map((r) => {
                      const pct = r.errors[k].pctError;
                      return (
                        <td key={r.season} style={{ ...tdS, color: pct <= 5 ? '#10b981' : pct <= 10 ? '#f59e0b' : '#ef4444' }}>
                          {pct}%
                        </td>
                      );
                    })}
                    <td style={{ ...tdS, fontWeight: 700, color: allSeasonErrors && allSeasonErrors[k].pctError <= 5 ? '#10b981' : allSeasonErrors && allSeasonErrors[k].pctError <= 10 ? '#f59e0b' : '#ef4444' }}>
                      {allSeasonErrors ? allSeasonErrors[k].pctError : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
