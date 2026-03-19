import { useState, useMemo } from 'react';
import type { SeasonTotals } from '../types';

interface Props {
  players: SeasonTotals[];
  loading: boolean;
}

interface StatDef {
  label: string;
  key: keyof SeasonTotals;
  format?: (v: number) => string;
}

const COMPARE_STATS: StatDef[] = [
  { label: 'Games', key: 'games' },
  { label: 'Pass Yards', key: 'passing_yards' },
  { label: 'Pass TDs', key: 'passing_tds' },
  { label: 'INTs', key: 'interceptions' },
  { label: 'Rush Yards', key: 'rushing_yards' },
  { label: 'Rush TDs', key: 'rushing_tds' },
  { label: 'Receptions', key: 'receptions' },
  { label: 'Targets', key: 'targets' },
  { label: 'Rec Yards', key: 'receiving_yards' },
  { label: 'Rec TDs', key: 'receiving_tds' },
  {
    label: 'Fantasy (Std)',
    key: 'fantasy_points',
    format: (v) => v.toFixed(1),
  },
  {
    label: 'Fantasy (Half PPR)',
    key: 'fantasy_points_half_ppr',
    format: (v) => v.toFixed(1),
  },
  {
    label: 'Fantasy (PPR)',
    key: 'fantasy_points_ppr',
    format: (v) => v.toFixed(1),
  },
];

export function PlayerCompare({ players, loading }: Props) {
  const [selected, setSelected] = useState<SeasonTotals[]>([]);
  const [search, setSearch] = useState('');
  const [showResults, setShowResults] = useState(false);

  const searchResults = useMemo(() => {
    if (!search || search.length < 2) return [];
    const q = search.toLowerCase();
    return players
      .filter(
        (p) =>
          p.player_display_name.toLowerCase().includes(q) ||
          p.recent_team.toLowerCase().includes(q)
      )
      .filter((p) => !selected.find((s) => s.player_id === p.player_id))
      .slice(0, 10);
  }, [search, players, selected]);

  const addPlayer = (player: SeasonTotals) => {
    if (selected.length < 6) {
      setSelected([...selected, player]);
    }
    setSearch('');
    setShowResults(false);
  };

  const removePlayer = (id: string) => {
    setSelected(selected.filter((p) => p.player_id !== id));
  };

  const getBestValue = (key: keyof SeasonTotals): number => {
    if (selected.length === 0) return 0;
    // For interceptions, lower is better
    if (key === 'interceptions') {
      return Math.min(...selected.map((p) => (p[key] as number) || 0));
    }
    return Math.max(...selected.map((p) => (p[key] as number) || 0));
  };

  const isBest = (player: SeasonTotals, key: keyof SeasonTotals): boolean => {
    if (selected.length < 2) return false;
    const val = (player[key] as number) || 0;
    const best = getBestValue(key);
    if (key === 'interceptions') return val === best && val !== 0;
    return val === best && val !== 0;
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading player data...</div>
      </div>
    );
  }

  return (
    <>
      <div className="controls">
        <div className="compare-search">
          <input
            type="text"
            placeholder="Search players to compare (up to 6)..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setShowResults(true);
            }}
            onFocus={() => setShowResults(true)}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
          />
          {showResults && searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((p) => (
                <div
                  key={p.player_id}
                  className="search-result-item"
                  onMouseDown={() => addPlayer(p)}
                >
                  {p.headshot_url && (
                    <img
                      className="player-headshot"
                      src={p.headshot_url}
                      alt=""
                    />
                  )}
                  <div className="player-info">
                    <span className="player-name">
                      {p.player_display_name}
                    </span>
                    <span className="player-meta">
                      {p.position} - {p.recent_team}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected.length === 0 ? (
        <div className="empty-state">
          <h3>Compare Players</h3>
          <p>Search and add up to 6 players to compare their stats side by side.</p>
        </div>
      ) : (
        <div className="compare-grid">
          {selected.map((player) => (
            <div key={player.player_id} className="compare-card">
              <div className="compare-card-header">
                {player.headshot_url && (
                  <img src={player.headshot_url} alt="" />
                )}
                <div className="compare-card-info">
                  <h3>{player.player_display_name}</h3>
                  <span>
                    <span className={`pos-badge pos-${player.position}`}>
                      {player.position}
                    </span>{' '}
                    {player.recent_team}
                  </span>
                </div>
                <button
                  className="compare-card-remove"
                  onClick={() => removePlayer(player.player_id)}
                  title="Remove"
                >
                  x
                </button>
              </div>
              {COMPARE_STATS.map((stat) => {
                const val = (player[stat.key] as number) || 0;
                const formatted = stat.format
                  ? stat.format(val)
                  : Math.round(val).toLocaleString();
                return (
                  <div key={stat.key} className="compare-stat-row">
                    <span className="compare-stat-label">{stat.label}</span>
                    <span
                      className={`compare-stat-value ${isBest(player, stat.key) ? 'best' : ''}`}
                    >
                      {formatted}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
