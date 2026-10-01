import { useState, useEffect, useMemo } from 'react';
import { PlayerName } from './PlayerName';
import type { SeasonTotals, FantasySeasonResult, SortDirection, ScenarioConfig } from '../types';
import { buildSeasonResults } from '../data';
import { loadStatHeadAdp, type StatHeadAdpRow } from '../lib/statheadAdp';
import { normName } from '../lib/nameUtils';
import { ADPOutcomes } from './ADPOutcomes';
import { ADPFactorAnalysis } from './ADPFactorAnalysis';

/** A season result joined to StatHead ADP (never a single source's pick). */
interface ResultRow extends Omit<FantasySeasonResult, 'adp_ecr' | 'adp_pos' | 'adp_delta'> {
  adp: number | null;
  adp_delta: number | null;
}
type SortField = keyof ResultRow;
type ViewMode = 'results' | 'adp' | 'outcomes' | 'factors';
type AdpSortField = 'rank' | 'posRank' | 'adp' | 'spread' | 'sourceCount';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const CURRENT_SEASON = 2026;
const ADP_SEASONS = Array.from({ length: CURRENT_SEASON - 2020 + 1 }, (_, i) => CURRENT_SEASON - i);

interface Props {
  seasonTotals: SeasonTotals[];
  loading: boolean;
  onDataLoaded?: (data: unknown[]) => void;
  scenario?: ScenarioConfig;
}

function NoStatHeadAdp({ season }: { season: number }) {
  return (
    <div className="empty-state">
      <h3>StatHead ADP isn&apos;t available for {season}</h3>
      <p>
        StatHead ADP is a blend of at least two draft markets. The archived snapshots for
        {' '}{season} don&apos;t cover two sources, so there is no StatHead ADP for that season.
      </p>
    </div>
  );
}

export function FantasyADPView({ seasonTotals, loading: parentLoading, onDataLoaded, scenario }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('results');
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('overall_rank_ppr');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  // Season results: StatHead ADP for the season being viewed.
  const resultsSeason = seasonTotals[0]?.season ?? CURRENT_SEASON - 1;
  const [resultsAdp, setResultsAdp] = useState<StatHeadAdpRow[]>([]);
  const [resultsAdpLoading, setResultsAdpLoading] = useState(true);
  const [resultsAdpError, setResultsAdpError] = useState<string | null>(null);

  // ADP board tab.
  const [adpSeason, setAdpSeason] = useState(CURRENT_SEASON);
  const [adpFormat, setAdpFormat] = useState<'1qb' | 'sf'>('1qb');
  const [adpRows, setAdpRows] = useState<StatHeadAdpRow[]>([]);
  const [adpLoading, setAdpLoading] = useState(false);
  const [adpError, setAdpError] = useState<string | null>(null);
  const [adpSearch, setAdpSearch] = useState('');
  const [adpPosFilter, setAdpPosFilter] = useState('ALL');
  const [adpSortField, setAdpSortField] = useState<AdpSortField>('rank');
  const [adpSortDir, setAdpSortDir] = useState<SortDirection>('asc');

  useEffect(() => {
    let cancelled = false;
    setResultsAdpLoading(true);
    setResultsAdpError(null);
    loadStatHeadAdp(resultsSeason, CURRENT_SEASON, '1qb')
      .then((rows) => { if (!cancelled) setResultsAdp(rows); })
      .catch((e) => { if (!cancelled) setResultsAdpError(e instanceof Error ? e.message : 'Failed to load StatHead ADP'); })
      .finally(() => { if (!cancelled) setResultsAdpLoading(false); });
    return () => { cancelled = true; };
  }, [resultsSeason]);

  useEffect(() => {
    if (viewMode !== 'adp') return;
    let cancelled = false;
    setAdpLoading(true);
    setAdpError(null);
    loadStatHeadAdp(adpSeason, CURRENT_SEASON, adpFormat)
      .then((rows) => {
        if (cancelled) return;
        setAdpRows(rows);
        onDataLoaded?.(rows);
      })
      .catch((e) => { if (!cancelled) setAdpError(e instanceof Error ? e.message : 'Failed to load StatHead ADP'); })
      .finally(() => { if (!cancelled) setAdpLoading(false); });
    return () => { cancelled = true; };
  }, [viewMode, adpSeason, adpFormat, onDataLoaded]);

  const results = useMemo<ResultRow[]>(() => {
    const adpByName = new Map<string, StatHeadAdpRow>();
    for (const r of resultsAdp) {
      const k = normName(r.name);
      if (!adpByName.has(k)) adpByName.set(k, r);
    }
    // buildSeasonResults with no rankings → ranks only (its ADP fields null).
    return buildSeasonResults(seasonTotals, []).map((r) => {
      const a = adpByName.get(normName(r.player_display_name));
      const adp = a && a.position === r.position ? a.adp : null;
      return {
        player_display_name: r.player_display_name, player_id: r.player_id, position: r.position,
        team: r.team, headshot_url: r.headshot_url, games: r.games,
        fantasy_points: r.fantasy_points, fantasy_points_ppr: r.fantasy_points_ppr,
        fantasy_points_half_ppr: r.fantasy_points_half_ppr,
        overall_rank_std: r.overall_rank_std, overall_rank_ppr: r.overall_rank_ppr,
        pos_rank_std: r.pos_rank_std, pos_rank_ppr: r.pos_rank_ppr,
        adp, adp_delta: adp != null ? adp - r.overall_rank_ppr : null,
      };
    });
  }, [seasonTotals, resultsAdp]);

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir(
        field === 'fantasy_points_ppr' || field === 'fantasy_points' || field === 'adp_delta'
          ? 'desc'
          : 'asc'
      );
    }
  };

  const sortArrow = (field: SortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const handleAdpSort = (field: AdpSortField) => {
    if (field === adpSortField) setAdpSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setAdpSortField(field);
      setAdpSortDir(field === 'spread' || field === 'sourceCount' ? 'desc' : 'asc');
    }
  };

  const adpSortArrow = (field: AdpSortField) =>
    field === adpSortField ? (adpSortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  // Filtered season results
  const filteredResults = useMemo(() => {
    let data = [...results];
    if (posFilter !== 'ALL') data = data.filter((p) => p.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) =>
          p.player_display_name.toLowerCase().includes(q) ||
          p.team.toLowerCase().includes(q)
      );
    }
    data.sort((a, b) => {
      const aVal = a[sortField] ?? 9999;
      const bVal = b[sortField] ?? 9999;
      if (typeof aVal === 'string')
        return sortDir === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return data.slice(0, 300);
  }, [results, posFilter, search, sortField, sortDir]);

  // Filtered StatHead ADP board
  const filteredADP = useMemo(() => {
    let data = [...adpRows];
    if (adpPosFilter !== 'ALL') data = data.filter((r) => r.position === adpPosFilter);
    if (adpSearch) {
      const q = adpSearch.toLowerCase();
      data = data.filter(
        (r) => r.name.toLowerCase().includes(q) || r.team.toLowerCase().includes(q)
      );
    }
    const dir = adpSortDir === 'asc' ? 1 : -1;
    data.sort((a, b) => (a[adpSortField] - b[adpSortField]) * dir || a.rank - b.rank);
    return data.slice(0, 400);
  }, [adpRows, adpPosFilter, adpSearch, adpSortField, adpSortDir]);

  if (parentLoading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading fantasy data...</div>
      </div>
    );

  const deltaColor = (delta: number | null) => {
    if (delta == null) return '';
    return delta > 0 ? 'stat-positive' : delta < 0 ? 'stat-negative' : '';
  };

  const deltaLabel = (delta: number | null) => {
    if (delta == null) return '-';
    if (delta > 0) return `+${Math.round(delta)} (value)`;
    if (delta < 0) return `${Math.round(delta)} (bust)`;
    return '0';
  };

  return (
    <>
      <div className="scoring-format-tabs" style={{ marginBottom: 12 }}>
        <button
          className={`format-tab ${viewMode === 'results' ? 'active' : ''}`}
          onClick={() => setViewMode('results')}
        >
          Season Results vs ADP
        </button>
        <button
          className={`format-tab ${viewMode === 'adp' ? 'active' : ''}`}
          onClick={() => setViewMode('adp')}
        >
          StatHead ADP
        </button>
        <button
          className={`format-tab ${viewMode === 'outcomes' ? 'active' : ''}`}
          onClick={() => setViewMode('outcomes')}
        >
          ADP Outcomes (6yr)
        </button>
        <button
          className={`format-tab ${viewMode === 'factors' ? 'active' : ''}`}
          onClick={() => setViewMode('factors')}
        >
          Hit/Bust Factors
        </button>
      </div>

      {viewMode === 'factors' ? (
        <ADPFactorAnalysis scenario={scenario} />
      ) : viewMode === 'outcomes' ? (
        <ADPOutcomes />
      ) : viewMode === 'results' ? (
        resultsAdpLoading ? (
          <div className="loading">
            <div className="spinner" />
            <div className="loading-text">Loading StatHead ADP...</div>
          </div>
        ) : resultsAdpError ? (
          <div className="empty-state">
            <h3>Failed to load StatHead ADP</h3>
            <p>{resultsAdpError}</p>
          </div>
        ) : resultsAdp.length === 0 ? (
          <NoStatHeadAdp season={resultsSeason} />
        ) : (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            {resultsSeason} finishes vs pre-season StatHead ADP (a blend of the archived
            draft markets; players priced by at least two sources).
          </p>
          <div className="controls">
            <input
              type="text"
              placeholder="Search players..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="position-filters">
              {POSITIONS.map((pos) => (
                <button
                  key={pos}
                  className={`pos-filter ${posFilter === pos ? 'active' : ''}`}
                  onClick={() => setPosFilter(pos)}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th
                    onClick={() => handleSort('overall_rank_ppr')}
                    className={sortField === 'overall_rank_ppr' ? 'sorted' : ''}
                  >
                    Rank{sortArrow('overall_rank_ppr')}
                  </th>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Team</th>
                  <th
                    onClick={() => handleSort('pos_rank_ppr')}
                    className={sortField === 'pos_rank_ppr' ? 'sorted' : ''}
                  >
                    Pos Rank{sortArrow('pos_rank_ppr')}
                  </th>
                  <th
                    onClick={() => handleSort('games')}
                    className={sortField === 'games' ? 'sorted' : ''}
                  >
                    G{sortArrow('games')}
                  </th>
                  <th
                    onClick={() => handleSort('fantasy_points')}
                    className={sortField === 'fantasy_points' ? 'sorted' : ''}
                  >
                    Std Pts{sortArrow('fantasy_points')}
                  </th>
                  <th
                    onClick={() => handleSort('fantasy_points_half_ppr')}
                    className={sortField === 'fantasy_points_half_ppr' ? 'sorted' : ''}
                  >
                    Half PPR{sortArrow('fantasy_points_half_ppr')}
                  </th>
                  <th
                    onClick={() => handleSort('fantasy_points_ppr')}
                    className={sortField === 'fantasy_points_ppr' ? 'sorted' : ''}
                  >
                    PPR Pts{sortArrow('fantasy_points_ppr')}
                  </th>
                  <th>Pts/G</th>
                  <th
                    onClick={() => handleSort('adp')}
                    className={sortField === 'adp' ? 'sorted' : ''}
                  >
                    StatHead ADP{sortArrow('adp')}
                  </th>
                  <th
                    onClick={() => handleSort('adp_delta')}
                    className={sortField === 'adp_delta' ? 'sorted' : ''}
                  >
                    ADP vs Finish{sortArrow('adp_delta')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.map((p) => (
                  <tr key={p.player_id}>
                    <td className="rank-cell">{p.overall_rank_ppr}</td>
                    <td>
                      <div className="player-cell">
                        {p.headshot_url && (
                          <img
                            className="player-headshot"
                            src={p.headshot_url}
                            alt=""
                            loading="lazy"
                          />
                        )}
                        <span className="player-name">
                          {p.player_display_name}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className={`pos-badge pos-${p.position}`}>
                        {p.position}
                      </span>
                    </td>
                    <td>{p.team}</td>
                    <td>
                      {p.position}
                      {p.pos_rank_ppr}
                    </td>
                    <td>{p.games}</td>
                    <td>{p.fantasy_points.toFixed(1)}</td>
                    <td>{p.fantasy_points_half_ppr.toFixed(1)}</td>
                    <td className="stat-positive">
                      {p.fantasy_points_ppr.toFixed(1)}
                    </td>
                    <td>
                      {p.games > 0
                        ? (p.fantasy_points_ppr / p.games).toFixed(1)
                        : '-'}
                    </td>
                    <td>
                      {p.adp != null ? p.adp.toFixed(1) : '-'}
                    </td>
                    <td className={deltaColor(p.adp_delta)}>
                      <strong>{deltaLabel(p.adp_delta)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
        )
      ) : adpLoading ? (
        <div className="loading">
          <div className="spinner" />
          <div className="loading-text">Loading StatHead ADP...</div>
        </div>
      ) : adpError ? (
        <div className="empty-state">
          <h3>Failed to load StatHead ADP</h3>
          <p>{adpError}</p>
        </div>
      ) : (
        <>
          <div className="controls">
            <input
              type="text"
              placeholder="Search players..."
              value={adpSearch}
              onChange={(e) => setAdpSearch(e.target.value)}
            />
            <div className="position-filters">
              {POSITIONS.map((pos) => (
                <button
                  key={pos}
                  className={`pos-filter ${adpPosFilter === pos ? 'active' : ''}`}
                  onClick={() => setAdpPosFilter(pos)}
                >
                  {pos}
                </button>
              ))}
            </div>
            <div className="control-group">
              <label className="control-label">Season</label>
              <select value={adpSeason} onChange={(e) => setAdpSeason(Number(e.target.value))}>
                {ADP_SEASONS.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div className="control-group">
              <label className="control-label">Format</label>
              <select value={adpFormat} onChange={(e) => setAdpFormat(e.target.value as '1qb' | 'sf')}>
                <option value="1qb">1QB (PPR)</option>
                <option value="sf">Superflex</option>
              </select>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {filteredADP.length} players
            </span>
          </div>

          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            StatHead ADP blends the draft markets (FantasyPros, Sleeper, FFC, ESPN and FantasyCalc
            for the current season; the archived FFC and Sleeper snapshots for past seasons),
            weighted by sample size and recency. Only players priced by at least two sources are
            shown. Spread = how many picks the sources disagree by.
          </p>

          {adpRows.length === 0 ? (
            <NoStatHeadAdp season={adpSeason} />
          ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th onClick={() => handleAdpSort('rank')} className={adpSortField === 'rank' ? 'sorted' : ''}>
                    Rank{adpSortArrow('rank')}
                  </th>
                  <th>Player</th>
                  <th>Pos</th>
                  <th onClick={() => handleAdpSort('posRank')} className={adpSortField === 'posRank' ? 'sorted' : ''}>
                    Pos Rank{adpSortArrow('posRank')}
                  </th>
                  <th>Team</th>
                  <th onClick={() => handleAdpSort('adp')} className={adpSortField === 'adp' ? 'sorted' : ''}>
                    StatHead ADP{adpSortArrow('adp')}
                  </th>
                  <th
                    onClick={() => handleAdpSort('spread')}
                    className={adpSortField === 'spread' ? 'sorted' : ''}
                    title="How many picks the sources disagree by (latest minus earliest)"
                  >
                    Spread{adpSortArrow('spread')}
                  </th>
                  <th onClick={() => handleAdpSort('sourceCount')} className={adpSortField === 'sourceCount' ? 'sorted' : ''}>
                    Sources{adpSortArrow('sourceCount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredADP.map((r) => (
                  <tr key={`${r.name}-${r.position}`}>
                    <td className="rank-cell">{r.rank}</td>
                    <td>
                      <strong><PlayerName name={r.name} position={r.position} /></strong>
                    </td>
                    <td>
                      <span className={`pos-badge pos-${r.position}`}>
                        {r.position}
                      </span>
                    </td>
                    <td>{r.position}{r.posRank}</td>
                    <td>{r.team || '-'}</td>
                    <td>{r.adp.toFixed(1)}</td>
                    <td>{r.spread.toFixed(1)}</td>
                    <td>{r.sourceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
    </>
  );
}
