import { useState } from 'react';
import { usePlayerData } from './hooks/usePlayerData';
import { PlayerStatsTable } from './components/PlayerStatsTable';
import { PlayerCompare } from './components/PlayerCompare';
import { FantasyScoring } from './components/FantasyScoring';
import type { Tab } from './types';

const SEASONS = Array.from({ length: 10 }, (_, i) => 2024 - i);

function App() {
  const [tab, setTab] = useState<Tab>('stats');
  const [season, setSeason] = useState(2024);
  const { seasonTotals, loading, error } = usePlayerData(season);

  return (
    <>
      <header className="header">
        <div className="header-logo">
          Stat<span>Head</span>
        </div>
        <nav className="nav-tabs">
          <button
            className={`nav-tab ${tab === 'stats' ? 'active' : ''}`}
            onClick={() => setTab('stats')}
          >
            Rankings
          </button>
          <button
            className={`nav-tab ${tab === 'compare' ? 'active' : ''}`}
            onClick={() => setTab('compare')}
          >
            Compare
          </button>
          <button
            className={`nav-tab ${tab === 'scoring' ? 'active' : ''}`}
            onClick={() => setTab('scoring')}
          >
            Scoring
          </button>
        </nav>
        <div className="control-group" style={{ marginLeft: 'auto' }}>
          <label className="control-label">Season</label>
          <select
            value={season}
            onChange={(e) => setSeason(Number(e.target.value))}
          >
            {SEASONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </header>
      <main className="main">
        {tab === 'stats' && (
          <PlayerStatsTable
            players={seasonTotals}
            loading={loading}
            error={error}
          />
        )}
        {tab === 'compare' && (
          <PlayerCompare players={seasonTotals} loading={loading} />
        )}
        {tab === 'scoring' && (
          <FantasyScoring players={seasonTotals} loading={loading} />
        )}
      </main>
    </>
  );
}

export default App;
