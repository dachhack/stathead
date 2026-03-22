import { useState, useCallback } from 'react';
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
import { FantasyADPView } from './components/FantasyADPView';
import { RookieRBChart } from './components/RookieRBChart';
import { SleeperView } from './components/SleeperView';
import { KTCView } from './components/KTCView';
import { SportsDataIOView } from './components/SportsDataIOView';
import { SettingsModal } from './components/SettingsModal';
import { ChatDrawer } from './components/ChatDrawer';
import { buildDataContext } from './context';
import type { Tab } from './types';

const SEASONS = Array.from({ length: 10 }, (_, i) => 2025 - i);

const TABS: { id: Tab; label: string }[] = [
  { id: 'stats', label: 'Rankings' },
  { id: 'compare', label: 'Compare' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'adp', label: 'ADP' },
  { id: 'games', label: 'Games' },
  { id: 'snaps', label: 'Snaps' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'pbp', label: 'PBP' },
  { id: 'injuries', label: 'Injuries' },
  { id: 'combine', label: 'Combine' },
  { id: 'draft', label: 'Draft' },
  { id: 'charts', label: 'Charts' },
  { id: 'sleeper', label: 'Sleeper' },
  { id: 'ktc', label: 'KTC' },
  { id: 'sportsdata', label: 'SportsData' },
];

function App() {
  const [tab, setTab] = useState<Tab>('stats');
  const [season, setSeason] = useState(2025);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, setApiKeysVersion] = useState(0);
  const [extraData, setExtraData] = useState<unknown[]>([]);
  const { seasonTotals, loading, error } = usePlayerData(season);

  // Callback for child views to register their loaded data for chat context
  const onDataLoaded = useCallback((data: unknown[]) => {
    setExtraData(data);
  }, []);

  const dataContext = buildDataContext(tab, season, seasonTotals, extraData);

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
              onClick={() => {
                setTab(t.id);
                setExtraData([]);
              }}
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
          <button
            className="settings-gear"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            &#9881;
          </button>
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
        {tab === 'adp' && (
          <FantasyADPView
            seasonTotals={seasonTotals}
            loading={loading}
            onDataLoaded={onDataLoaded}
          />
        )}
        {tab === 'games' && <GamesView onDataLoaded={onDataLoaded} />}
        {tab === 'snaps' && (
          <SnapCountsView season={season} onDataLoaded={onDataLoaded} />
        )}
        {tab === 'combine' && <CombineView onDataLoaded={onDataLoaded} />}
        {tab === 'draft' && <DraftView onDataLoaded={onDataLoaded} />}
        {tab === 'injuries' && (
          <InjuriesView season={season} onDataLoaded={onDataLoaded} />
        )}
        {tab === 'advanced' && (
          <AdvancedStatsView season={season} onDataLoaded={onDataLoaded} />
        )}
        {tab === 'pbp' && (
          <PlayByPlayView season={season} onDataLoaded={onDataLoaded} />
        )}
        {tab === 'charts' && <RookieRBChart />}
        {tab === 'sleeper' && (
          <SleeperView season={season} onDataLoaded={onDataLoaded} />
        )}
        {tab === 'ktc' && <KTCView onDataLoaded={onDataLoaded} />}
        {tab === 'sportsdata' && (
          <SportsDataIOView
            season={season}
            onDataLoaded={onDataLoaded}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
      </main>

      <button
        className="chat-fab"
        onClick={() => setChatOpen(true)}
        title="Ask Claude"
      >
        C
      </button>

      <ChatDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        systemPrompt={dataContext}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onKeysChanged={() => setApiKeysVersion((v) => v + 1)}
      />
    </>
  );
}

export default App;
