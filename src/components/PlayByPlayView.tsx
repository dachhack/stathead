import { useState, useEffect, useMemo } from 'react';
import type { PlayByPlay } from '../types';
import { fetchPlayByPlay } from '../data';

const PLAY_TYPES = [
  'ALL',
  'pass',
  'run',
  'punt',
  'kickoff',
  'field_goal',
  'extra_point',
];

export function PlayByPlayView({ season, onDataLoaded }: { season: number; onDataLoaded?: (data: unknown[]) => void }) {
  const [data, setData] = useState<PlayByPlay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [weekFilter, setWeekFilter] = useState(1);
  const [playType, setPlayType] = useState('ALL');
  const [teamFilter, setTeamFilter] = useState('ALL');
  const [minEpa, setMinEpa] = useState('');

  const loadData = () => {
    setLoading(true);
    setError(null);
    fetchPlayByPlay(season)
      .then((d) => {
        setData(d);
        setLoaded(true);
        onDataLoaded?.(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  // Reset when season changes
  useEffect(() => {
    setLoaded(false);
    setData([]);
  }, [season]);

  const teams = useMemo(
    () =>
      [
        'ALL',
        ...[...new Set(data.map((d) => d.posteam).filter(Boolean))].sort(),
      ],
    [data]
  );

  const weeks = useMemo(
    () => [...new Set(data.map((d) => d.week))].sort((a, b) => a - b),
    [data]
  );

  const filtered = useMemo(() => {
    let d = data.filter((r) => r.week === weekFilter);
    if (playType !== 'ALL') d = d.filter((r) => r.play_type === playType);
    if (teamFilter !== 'ALL') d = d.filter((r) => r.posteam === teamFilter);
    if (minEpa) {
      const threshold = parseFloat(minEpa);
      if (!isNaN(threshold))
        d = d.filter((r) => r.epa != null && r.epa >= threshold);
    }
    if (search) {
      const q = search.toLowerCase();
      d = d.filter((r) => r.desc?.toLowerCase().includes(q));
    }
    return d.slice(0, 500);
  }, [data, weekFilter, playType, teamFilter, minEpa, search]);

  const epaColor = (epa: number | null | undefined) => {
    if (epa == null) return '';
    return epa > 0 ? 'stat-positive' : epa < 0 ? 'stat-negative' : '';
  };

  if (!loaded && !loading) {
    return (
      <div className="empty-state">
        <h3>Play-by-Play Explorer</h3>
        <p>
          PBP data is large (~50MB per season). Click below to load {season}{' '}
          play-by-play data.
        </p>
        <button
          className="format-tab active"
          style={{ marginTop: 16, fontSize: 16, padding: '12px 32px' }}
          onClick={loadData}
        >
          Load {season} Play-by-Play
        </button>
      </div>
    );
  }

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          Loading {season} play-by-play data (this may take a moment)...
        </div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load play-by-play</h3>
        <p>{error}</p>
      </div>
    );

  return (
    <>
      <div className="controls">
        <div className="control-group">
          <label className="control-label">Week</label>
          <select
            value={weekFilter}
            onChange={(e) => setWeekFilter(Number(e.target.value))}
          >
            {weeks.map((w) => (
              <option key={w} value={w}>
                Week {w}
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Team</label>
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Min EPA</label>
          <input
            type="number"
            step="0.5"
            placeholder="e.g. 2.0"
            value={minEpa}
            onChange={(e) => setMinEpa(e.target.value)}
          />
        </div>
        <div className="position-filters">
          {PLAY_TYPES.map((pt) => (
            <button
              key={pt}
              className={`pos-filter ${playType === pt ? 'active' : ''}`}
              onClick={() => setPlayType(pt)}
            >
              {pt === 'ALL' ? 'ALL' : pt.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>
      <div className="controls">
        <input
          type="text"
          placeholder="Search play descriptions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%', maxWidth: 600 }}
        />
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 50 }}>Qtr</th>
              <th style={{ width: 60 }}>Down</th>
              <th style={{ width: 60 }}>Dist</th>
              <th style={{ width: 60 }}>YdLn</th>
              <th style={{ width: 60 }}>Type</th>
              <th>Off</th>
              <th>Def</th>
              <th style={{ width: 60 }}>Yards</th>
              <th style={{ width: 70 }}>EPA</th>
              <th style={{ width: 70 }}>WPA</th>
              <th style={{ width: 60 }}>WP</th>
              <th style={{ minWidth: 300 }}>Description</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p, i) => (
              <tr key={`${p.game_id}-${p.play_id}-${i}`}>
                <td>{p.qtr}</td>
                <td>{p.down || '-'}</td>
                <td>{p.ydstogo || '-'}</td>
                <td>{p.yardline_100 || '-'}</td>
                <td>
                  <span
                    className={`pos-badge ${p.play_type === 'pass' ? 'pos-QB' : p.play_type === 'run' ? 'pos-RB' : 'pos-TE'}`}
                  >
                    {p.play_type}
                  </span>
                </td>
                <td>{p.posteam}</td>
                <td>{p.defteam}</td>
                <td
                  className={
                    p.yards_gained > 0
                      ? 'stat-positive'
                      : p.yards_gained < 0
                        ? 'stat-negative'
                        : ''
                  }
                >
                  {p.yards_gained ?? '-'}
                </td>
                <td className={epaColor(p.epa)}>
                  {p.epa != null ? p.epa.toFixed(2) : '-'}
                </td>
                <td className={epaColor(p.wpa)}>
                  {p.wpa != null ? (p.wpa * 100).toFixed(1) + '%' : '-'}
                </td>
                <td>
                  {p.wp != null ? (p.wp * 100).toFixed(0) + '%' : '-'}
                </td>
                <td
                  style={{
                    whiteSpace: 'normal',
                    maxWidth: 400,
                    fontSize: 13,
                    lineHeight: 1.4,
                  }}
                >
                  {p.desc}
                  {p.touchdown ? (
                    <span
                      style={{
                        marginLeft: 6,
                        color: 'var(--accent)',
                        fontWeight: 700,
                      }}
                    >
                      TD
                    </span>
                  ) : null}
                  {p.interception ? (
                    <span
                      style={{
                        marginLeft: 6,
                        color: 'var(--danger)',
                        fontWeight: 700,
                      }}
                    >
                      INT
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
