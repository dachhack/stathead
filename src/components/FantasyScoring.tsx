import { useState, useMemo } from 'react';
import type {
  SeasonTotals,
  ScoringFormat,
  ScoringSettings,
  SortDirection,
} from '../types';
import { SCORING_PRESETS, calculateFantasyPoints } from '../scoring';

interface Props {
  players: SeasonTotals[];
  loading: boolean;
}

const FORMAT_LABELS: Record<ScoringFormat, string> = {
  standard: 'Standard',
  half_ppr: 'Half PPR',
  ppr: 'Full PPR',
  custom: 'Custom',
};

const SETTING_LABELS: Record<keyof ScoringSettings, string> = {
  passing_yard: 'Per Passing Yard',
  passing_td: 'Passing TD',
  interception: 'Interception',
  rushing_yard: 'Per Rushing Yard',
  rushing_td: 'Rushing TD',
  receiving_yard: 'Per Receiving Yard',
  receiving_td: 'Receiving TD',
  reception: 'Per Reception',
  fumble_lost: 'Fumble Lost',
  two_pt_conversion: '2-Pt Conversion',
  special_teams_td: 'Special Teams TD',
};

type ScoredPlayer = SeasonTotals & { customPoints: number };

export function FantasyScoring({ players, loading }: Props) {
  const [format, setFormat] = useState<ScoringFormat>('ppr');
  const [settings, setSettings] = useState<ScoringSettings>(
    SCORING_PRESETS.ppr
  );
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [search, setSearch] = useState('');

  const handleFormatChange = (f: ScoringFormat) => {
    setFormat(f);
    if (f !== 'custom') {
      setSettings(SCORING_PRESETS[f]);
    }
  };

  const handleSettingChange = (key: keyof ScoringSettings, value: number) => {
    setFormat('custom');
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const scored = useMemo(() => {
    let data: ScoredPlayer[] = players.map((p) => ({
      ...p,
      customPoints: calculateFantasyPoints(p, settings),
    }));

    if (posFilter !== 'ALL') {
      data = data.filter((p) => p.position === posFilter);
    }

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) =>
          p.player_display_name.toLowerCase().includes(q) ||
          p.recent_team.toLowerCase().includes(q)
      );
    }

    data.sort((a, b) =>
      sortDir === 'desc'
        ? b.customPoints - a.customPoints
        : a.customPoints - b.customPoints
    );
    return data;
  }, [players, settings, posFilter, search, sortDir]);

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
      <div className="scoring-format-tabs">
        {(Object.keys(FORMAT_LABELS) as ScoringFormat[]).map((f) => (
          <button
            key={f}
            className={`format-tab ${format === f ? 'active' : ''}`}
            onClick={() => handleFormatChange(f)}
          >
            {FORMAT_LABELS[f]}
          </button>
        ))}
      </div>

      <div className="scoring-grid">
        {(Object.keys(SETTING_LABELS) as (keyof ScoringSettings)[]).map(
          (key) => (
            <div key={key} className="scoring-item">
              <label>{SETTING_LABELS[key]}</label>
              <input
                type="number"
                step="0.25"
                value={settings[key]}
                onChange={(e) =>
                  handleSettingChange(key, parseFloat(e.target.value) || 0)
                }
              />
            </div>
          )
        )}
      </div>

      <div className="controls">
        <div className="control-group">
          <input
            type="text"
            placeholder="Search players..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="position-filters">
          {['ALL', 'QB', 'RB', 'WR', 'TE'].map((pos) => (
            <button
              key={pos}
              className={`pos-filter ${posFilter === pos ? 'active' : ''}`}
              onClick={() => setPosFilter(pos)}
            >
              {pos}
            </button>
          ))}
        </div>
        <button
          className="pos-filter"
          onClick={() =>
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
          }
        >
          Sort {sortDir === 'desc' ? '\u25BC' : '\u25B2'}
        </button>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th>G</th>
              <th>Pass Yds</th>
              <th>Pass TD</th>
              <th>INT</th>
              <th>Rush Yds</th>
              <th>Rush TD</th>
              <th>Rec</th>
              <th>Rec Yds</th>
              <th>Rec TD</th>
              <th>Pts/G</th>
              <th>Total Pts</th>
            </tr>
          </thead>
          <tbody>
            {scored.slice(0, 200).map((p, i) => (
              <tr key={p.player_id}>
                <td className="rank-cell">{i + 1}</td>
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
                <td>{p.recent_team}</td>
                <td>{p.games}</td>
                <td>{Math.round(p.passing_yards).toLocaleString()}</td>
                <td>{p.passing_tds}</td>
                <td>{p.interceptions}</td>
                <td>{Math.round(p.rushing_yards).toLocaleString()}</td>
                <td>{p.rushing_tds}</td>
                <td>{p.receptions}</td>
                <td>{Math.round(p.receiving_yards).toLocaleString()}</td>
                <td>{p.receiving_tds}</td>
                <td className="stat-positive">
                  {p.games > 0 ? (p.customPoints / p.games).toFixed(1) : '-'}
                </td>
                <td className="stat-positive">{p.customPoints.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
