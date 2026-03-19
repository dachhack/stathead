import { useState, useEffect, useMemo } from 'react';
import type { SeasonTotals, FantasyRanking, FantasySeasonResult, EspnADPPlayer, SortDirection } from '../types';
import { fetchFantasyRankings, buildSeasonResults, fetchEspnADP } from '../data';

type SortField = keyof FantasySeasonResult;
type ViewMode = 'results' | 'adp' | 'espn';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

interface Props {
  seasonTotals: SeasonTotals[];
  loading: boolean;
  onDataLoaded?: (data: unknown[]) => void;
}

export function FantasyADPView({ seasonTotals, loading: parentLoading, onDataLoaded }: Props) {
  const [rankings, setRankings] = useState<FantasyRanking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('results');
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('overall_rank_ppr');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  const [adpSearch, setAdpSearch] = useState('');
  const [adpPageType, setAdpPageType] = useState('redraft-overall');
  const [espnPlayers, setEspnPlayers] = useState<EspnADPPlayer[]>([]);
  const [espnLoading, setEspnLoading] = useState(false);
  const [espnError, setEspnError] = useState<string | null>(null);
  const [espnSearch, setEspnSearch] = useState('');
  const [espnPosFilter, setEspnPosFilter] = useState('ALL');

  useEffect(() => {
    fetchFantasyRankings()
      .then((data) => {
        setRankings(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [onDataLoaded]);

  // Fetch ESPN ADP when that tab is selected
  useEffect(() => {
    if (viewMode !== 'espn' || espnPlayers.length > 0) return;
    setEspnLoading(true);
    setEspnError(null);
    fetchEspnADP(2025)
      .then(setEspnPlayers)
      .catch((e) => setEspnError(e instanceof Error ? e.message : 'Failed to load ESPN ADP'))
      .finally(() => setEspnLoading(false));
  }, [viewMode, espnPlayers.length]);

  const results = useMemo(
    () => buildSeasonResults(seasonTotals, rankings),
    [seasonTotals, rankings]
  );

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

  // ADP page types available
  const adpPageTypes = useMemo(
    () => [...new Set(rankings.map((r) => r.page_type).filter(Boolean))].sort(),
    [rankings]
  );

  // Filtered ADP rankings
  const filteredADP = useMemo(() => {
    let data = rankings.filter((r) => r.page_type === adpPageType);
    if (adpSearch) {
      const q = adpSearch.toLowerCase();
      data = data.filter(
        (r) =>
          r.player?.toLowerCase().includes(q) ||
          r.team?.toLowerCase().includes(q)
      );
    }
    return data.sort((a, b) => (a.ecr || 999) - (b.ecr || 999)).slice(0, 300);
  }, [rankings, adpPageType, adpSearch]);

  // Filtered ESPN ADP
  const filteredEspn = useMemo(() => {
    let data = [...espnPlayers];
    if (espnPosFilter !== 'ALL') data = data.filter((p) => p.position === espnPosFilter);
    if (espnSearch) {
      const q = espnSearch.toLowerCase();
      data = data.filter(
        (p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)
      );
    }
    return data;
  }, [espnPlayers, espnPosFilter, espnSearch]);

  const isLoading = loading || parentLoading;

  if (isLoading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading fantasy rankings data...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load rankings</h3>
        <p>{error}</p>
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
          Pre-Season ADP / ECR
        </button>
        <button
          className={`format-tab ${viewMode === 'espn' ? 'active' : ''}`}
          onClick={() => setViewMode('espn')}
        >
          ESPN ADP
        </button>
      </div>

      {viewMode === 'espn' ? (
        <>
          {espnLoading ? (
            <div className="loading">
              <div className="spinner" />
              <div className="loading-text">Loading ESPN ADP data...</div>
            </div>
          ) : espnError ? (
            <div className="empty-state">
              <h3>Failed to load ESPN ADP</h3>
              <p>{espnError}</p>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
                ESPN&apos;s API may be blocked by CORS in some environments.
                This works best when deployed to GitHub Pages.
              </p>
            </div>
          ) : (
            <>
              <div className="controls">
                <input
                  type="text"
                  placeholder="Search players..."
                  value={espnSearch}
                  onChange={(e) => setEspnSearch(e.target.value)}
                />
                <div className="position-filters">
                  {POSITIONS.map((pos) => (
                    <button
                      key={pos}
                      className={`pos-filter ${espnPosFilter === pos ? 'active' : ''}`}
                      onClick={() => setEspnPosFilter(pos)}
                    >
                      {pos}
                    </button>
                  ))}
                </div>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {filteredEspn.length} players
                </span>
              </div>

              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>PPR Rank</th>
                      <th>Player</th>
                      <th>Pos</th>
                      <th>Team</th>
                      <th>Std Rank</th>
                      <th>ADP</th>
                      <th>Owned %</th>
                      <th>Auction (Std)</th>
                      <th>Auction (PPR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEspn.map((p) => (
                      <tr key={p.espnId}>
                        <td className="rank-cell">{p.draftRankPpr || '-'}</td>
                        <td><strong>{p.name}</strong></td>
                        <td>
                          <span className={`pos-badge pos-${p.position}`}>
                            {p.position}
                          </span>
                        </td>
                        <td>{p.team}</td>
                        <td>{p.draftRankStd || '-'}</td>
                        <td>{p.adp > 0 ? p.adp.toFixed(1) : '-'}</td>
                        <td>{p.percentOwned > 0 ? `${p.percentOwned.toFixed(1)}%` : '-'}</td>
                        <td>{p.auctionValueStd > 0 ? `$${p.auctionValueStd}` : '-'}</td>
                        <td>{p.auctionValuePpr > 0 ? `$${p.auctionValuePpr}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : viewMode === 'results' ? (
        <>
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
                    onClick={() => handleSort('adp_ecr')}
                    className={sortField === 'adp_ecr' ? 'sorted' : ''}
                  >
                    Pre-Season ADP{sortArrow('adp_ecr')}
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
                      {p.adp_ecr != null ? Math.round(p.adp_ecr) : '-'}
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
      ) : (
        <>
          <div className="controls">
            <input
              type="text"
              placeholder="Search players..."
              value={adpSearch}
              onChange={(e) => setAdpSearch(e.target.value)}
            />
            <div className="control-group">
              <label className="control-label">Ranking Type</label>
              <select
                value={adpPageType}
                onChange={(e) => setAdpPageType(e.target.value)}
              >
                {adpPageTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>ECR</th>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Team</th>
                  <th>Best</th>
                  <th>Worst</th>
                  <th>Std Dev</th>
                  <th>Bye</th>
                  <th>Owned %</th>
                  <th>ESPN Own</th>
                  <th>Yahoo Own</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {filteredADP.map((r, i) => (
                  <tr key={`${r.id}-${r.page_type}-${i}`}>
                    <td className="rank-cell">
                      {r.ecr != null ? Math.round(r.ecr) : '-'}
                    </td>
                    <td>
                      <strong>{r.player}</strong>
                    </td>
                    <td>
                      <span className={`pos-badge pos-${r.pos}`}>
                        {r.pos}
                      </span>
                    </td>
                    <td>{r.team}</td>
                    <td>{r.best || '-'}</td>
                    <td>{r.worst || '-'}</td>
                    <td>{r.sd != null ? r.sd.toFixed(1) : '-'}</td>
                    <td>{r.bye || '-'}</td>
                    <td>
                      {r.player_owned_avg != null
                        ? `${r.player_owned_avg}%`
                        : '-'}
                    </td>
                    <td>
                      {r.player_owned_espn != null
                        ? `${r.player_owned_espn}%`
                        : '-'}
                    </td>
                    <td>
                      {r.player_owned_yahoo != null
                        ? `${r.player_owned_yahoo}%`
                        : '-'}
                    </td>
                    <td>{r.scrape_date || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
