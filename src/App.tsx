import { useState } from 'react';
import { usePlayerData } from './hooks/usePlayerData';
import { PlayerStatsTable } from './components/PlayerStatsTable';
import { PlayerCompare } from './components/PlayerCompare';
import { FantasyScoring } from './components/FantasyScoring';
import { GamesView } from './components/GamesView';
import { SnapCountsView } from './components/SnapCountsView';
import { CombineView } from './components/CombineView';
import { DraftView } from './components/DraftView';
import { InjuriesView } from './components/InjuriesView';
import { AdvancedStatsView } from './components/AdvancedStatsView';
import { PlayByPlayView } from './components/PlayByPlayView';
import type { Tab } from './types';

const SEASONS = Array.from({ length: 10 }, (_, i) => 2024 - i);

const TABS: { id: Tab; label: string; needsSeason?: boolean }[] = [
  { id: 'stats', label: 'Rankings', needsSeason: true },
  { id: 'compare', label: 'Compare', needsSeason: true },
  { id: 'scoring', label: 'Scoring', needsSeason: true },
  { id: 'games', label: 'Games' },
  { id: 'snaps', label: 'Snaps', needsSeason: true },
  { id: 'advanced', label: 'Advanced', needsSeason: true },
  { id: 'pbp', label: 'PBP', needsSeason: true },
  { id: 'injuries', label: 'Injuries', needsSeason: true },
  { id: 'combine', label: 'Combine' },
  { id: 'draft', label: 'Draft' },
];

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
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`nav-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
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
        {tab === 'games' && <GamesView />}
        {tab === 'snaps' && <SnapCountsView season={season} />}
        {tab === 'combine' && <CombineView />}
        {tab === 'draft' && <DraftView />}
        {tab === 'injuries' && <InjuriesView season={season} />}
        {tab === 'advanced' && <AdvancedStatsView season={season} />}
        {tab === 'pbp' && <PlayByPlayView season={season} />}
      </main>
    </>
  );
}

export default App;
