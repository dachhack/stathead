import { useState, useEffect, useMemo } from 'react';
import type {
  SDIOProjection,
  SDIOOdds,
  SDIONews,
} from '../types';
import {
  fetchSDIOSeasonProjections,
  fetchSDIOWeeklyProjections,
  fetchSDIOOdds,
  fetchSDIONews,
  hasSDIOKey,
} from '../lib/sportsDataIO';

type ViewMode = 'projections' | 'odds' | 'news';
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K'];
const WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);

interface Props {
  season: number;
  onDataLoaded?: (data: unknown[]) => void;
  onOpenSettings?: () => void;
}

export function SportsDataIOView({ season, onDataLoaded, onOpenSettings }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('projections');
  const [projections, setProjections] = useState<SDIOProjection[]>([]);
  const [odds, setOdds] = useState<SDIOOdds[]>([]);
  const [news, setNews] = useState<SDIONews[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [week, setWeek] = useState<number | undefined>(undefined);
  const [sortCol, setSortCol] = useState<string>('FantasyPointsPPR');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const keyConfigured = hasSDIOKey();

  // Fetch projections
  useEffect(() => {
    if (!keyConfigured || viewMode !== 'projections') return;
    setLoading(true);
    setError(null);
    const fetcher = week
      ? fetchSDIOWeeklyProjections(season, week)
      : fetchSDIOSeasonProjections(season);
    fetcher
      .then((data) => {
        setProjections(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [keyConfigured, viewMode, season, week, onDataLoaded]);

  // Fetch odds
  useEffect(() => {
    if (!keyConfigured || viewMode !== 'odds') return;
    const w = week || 1;
    setLoading(true);
    setError(null);
    fetchSDIOOdds(season, w)
      .then((data) => {
        setOdds(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [keyConfigured, viewMode, season, week, onDataLoaded]);

  // Fetch news
  useEffect(() => {
    if (!keyConfigured || viewMode !== 'news') return;
    setLoading(true);
    setError(null);
    fetchSDIONews()
      .then((data) => {
        setNews(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [keyConfigured, viewMode, onDataLoaded]);

  const filteredProjections = useMemo(() => {
    let data = [...projections];
    if (posFilter !== 'ALL') data = data.filter((p) => p.Position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) =>
          p.Name.toLowerCase().includes(q) ||
          p.Team?.toLowerCase().includes(q)
      );
    }
    data.sort((a, b) => {
      const aVal = (a as unknown as Record<string, number>)[sortCol] || 0;
      const bVal = (b as unknown as Record<string, number>)[sortCol] || 0;
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
    });
    return data;
  }, [projections, posFilter, search, sortCol, sortDir]);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
  };

  const sortArrow = (col: string) =>
    sortCol === col ? (sortDir === 'desc' ? ' \u25BC' : ' \u25B2') : '';

  if (!keyConfigured) {
    return (
      <div className="empty-state">
        <h3>SportsDataIO API Key Required</h3>
        <p>
          Add your SportsDataIO API key in Settings to unlock projections, odds,
          and news data.
        </p>
        <p style={{ marginTop: 12 }}>
          <button
            className="format-tab"
            onClick={onOpenSettings}
            style={{ cursor: 'pointer' }}
          >
            Open Settings
          </button>
        </p>
        <p style={{ marginTop: 16, fontSize: 13 }}>
          Get a free trial key at{' '}
          <a
            href="https://sportsdata.io/free-trial"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            sportsdata.io/free-trial
          </a>
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="controls">
        <div className="scoring-format-tabs">
          {(['projections', 'odds', 'news'] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={`format-tab ${viewMode === m ? 'active' : ''}`}
              onClick={() => setViewMode(m)}
            >
              {m === 'projections' ? 'Projections' : m === 'odds' ? 'Odds' : 'News'}
            </button>
          ))}
        </div>

        {(viewMode === 'projections' || viewMode === 'odds') && (
          <div className="control-group">
            <label className="control-label">Week</label>
            <select
              value={week ?? ''}
              onChange={(e) =>
                setWeek(e.target.value ? Number(e.target.value) : undefined)
              }
            >
              {viewMode === 'projections' && <option value="">Season</option>}
              {WEEKS.map((w) => (
                <option key={w} value={w}>
                  Week {w}
                </option>
              ))}
            </select>
          </div>
        )}

        {viewMode === 'projections' && (
          <>
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
            <input
              type="text"
              placeholder="Search players..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </>
        )}
      </div>

      {loading && (
        <div className="loading">
          <div className="spinner" />
          <span className="loading-text">Loading from SportsDataIO...</span>
        </div>
      )}

      {error && (
        <div className="empty-state">
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      )}

      {!loading && !error && viewMode === 'projections' && (
        <ProjectionsTable
          data={filteredProjections}
          onSort={handleSort}
          sortArrow={sortArrow}
          isWeekly={!!week}
        />
      )}

      {!loading && !error && viewMode === 'odds' && <OddsTable data={odds} />}

      {!loading && !error && viewMode === 'news' && <NewsFeed data={news} />}
    </>
  );
}

function ProjectionsTable({
  data,
  onSort,
  sortArrow,
  isWeekly,
}: {
  data: SDIOProjection[];
  onSort: (col: string) => void;
  sortArrow: (col: string) => string;
  isWeekly: boolean;
}) {
  if (data.length === 0) {
    return (
      <div className="empty-state">
        <p>No projection data available for this selection.</p>
      </div>
    );
  }

  return (
    <div className="table-container">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Pos</th>
            <th>Team</th>
            <th className={sortArrow('FantasyPointsPPR') ? 'sorted' : ''} onClick={() => onSort('FantasyPointsPPR')}>
              PPR{sortArrow('FantasyPointsPPR')}
            </th>
            <th className={sortArrow('FantasyPoints') ? 'sorted' : ''} onClick={() => onSort('FantasyPoints')}>
              Std{sortArrow('FantasyPoints')}
            </th>
            <th onClick={() => onSort('PassingYards')}>
              Pass Yd{sortArrow('PassingYards')}
            </th>
            <th onClick={() => onSort('PassingTouchdowns')}>
              Pass TD{sortArrow('PassingTouchdowns')}
            </th>
            <th onClick={() => onSort('PassingInterceptions')}>
              INT{sortArrow('PassingInterceptions')}
            </th>
            <th onClick={() => onSort('RushingYards')}>
              Rush Yd{sortArrow('RushingYards')}
            </th>
            <th onClick={() => onSort('RushingTouchdowns')}>
              Rush TD{sortArrow('RushingTouchdowns')}
            </th>
            <th onClick={() => onSort('Receptions')}>
              Rec{sortArrow('Receptions')}
            </th>
            <th onClick={() => onSort('ReceivingYards')}>
              Rec Yd{sortArrow('ReceivingYards')}
            </th>
            <th onClick={() => onSort('ReceivingTouchdowns')}>
              Rec TD{sortArrow('ReceivingTouchdowns')}
            </th>
            {!isWeekly && (
              <th onClick={() => onSort('FumblesLost')}>
                FL{sortArrow('FumblesLost')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.map((p, i) => (
            <tr key={p.PlayerID}>
              <td className="rank-cell">{i + 1}</td>
              <td className="player-name">{p.Name}</td>
              <td>
                <span className={`pos-badge pos-${p.Position}`}>{p.Position}</span>
              </td>
              <td>{p.Team}</td>
              <td style={{ fontWeight: 600 }}>
                {(p.FantasyPointsPPR || 0).toFixed(1)}
              </td>
              <td>{(p.FantasyPoints || 0).toFixed(1)}</td>
              <td>{Math.round(p.PassingYards || 0)}</td>
              <td>{(p.PassingTouchdowns || 0).toFixed(1)}</td>
              <td>{(p.PassingInterceptions || 0).toFixed(1)}</td>
              <td>{Math.round(p.RushingYards || 0)}</td>
              <td>{(p.RushingTouchdowns || 0).toFixed(1)}</td>
              <td>{(p.Receptions || 0).toFixed(1)}</td>
              <td>{Math.round(p.ReceivingYards || 0)}</td>
              <td>{(p.ReceivingTouchdowns || 0).toFixed(1)}</td>
              {!isWeekly && <td>{p.FumblesLost || 0}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OddsTable({ data }: { data: SDIOOdds[] }) {
  if (data.length === 0) {
    return (
      <div className="empty-state">
        <p>No odds data available for this selection.</p>
      </div>
    );
  }

  return (
    <div className="table-container">
      <table>
        <thead>
          <tr>
            <th>Game</th>
            <th>Date/Time</th>
            <th>Spread</th>
            <th>Over/Under</th>
            <th>Home ML</th>
            <th>Away ML</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.map((g) => (
            <tr key={g.GameId}>
              <td style={{ fontWeight: 600 }}>
                {g.AwayTeam} @ {g.HomeTeam}
              </td>
              <td>{g.DateTime ? new Date(g.DateTime).toLocaleString() : '-'}</td>
              <td>
                {g.PointSpread > 0 ? '+' : ''}
                {g.PointSpread}
              </td>
              <td>{g.OverUnder}</td>
              <td>{g.HomeMoneyLine > 0 ? `+${g.HomeMoneyLine}` : g.HomeMoneyLine}</td>
              <td>{g.AwayMoneyLine > 0 ? `+${g.AwayMoneyLine}` : g.AwayMoneyLine}</td>
              <td>{g.Status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewsFeed({ data }: { data: SDIONews[] }) {
  if (data.length === 0) {
    return (
      <div className="empty-state">
        <p>No news available.</p>
      </div>
    );
  }

  return (
    <div className="sdio-news-list">
      {data.slice(0, 50).map((item) => (
        <div key={item.NewsID} className="sdio-news-item">
          <div className="sdio-news-header">
            <span className="sdio-news-team">{item.Team}</span>
            <span className="sdio-news-time">{item.TimeAgo}</span>
          </div>
          <h4 className="sdio-news-title">{item.Title}</h4>
          <p className="sdio-news-content">
            {item.Content?.slice(0, 300)}
            {item.Content?.length > 300 ? '...' : ''}
          </p>
          <span className="sdio-news-source">{item.OriginalSource}</span>
        </div>
      ))}
    </div>
  );
}
