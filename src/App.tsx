declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

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
import { StatProjections } from './components/StatProjections';
import { ExternalRankings2026 } from './components/ExternalRankings2026';
import { RookieRBChart } from './components/RookieRBChart';
import { SleeperView } from './components/SleeperView';
import { KTCView } from './components/KTCView';
import { SportsDataIOView } from './components/SportsDataIOView';
import { SettingsModal } from './components/SettingsModal';
import { ChatDrawer } from './components/ChatDrawer';
import { buildDataContext } from './context';
import type { Tab } from './types';

const SEASONS = Array.from({ length: 10 }, (_, i) => 2026 - i);

// Primary navigation tabs
const PRIMARY_TABS: { id: Tab; label: string }[] = [
  { id: 'projections', label: 'Projections' },
  { id: 'stats', label: 'Rankings' },
  { id: 'adp', label: 'ADP Research' },
  { id: 'ktc', label: 'Dynasty Values' },
  { id: 'charts', label: 'Chart Builder' },
  { id: 'sportsdata', label: 'Odds & Lines' },
];

// "Other" dropdown tabs
const OTHER_TABS: { id: Tab; label: string }[] = [
  { id: 'compare', label: 'Compare' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'games', label: 'Games' },
  { id: 'snaps', label: 'Snaps' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'pbp', label: 'Play-by-Play' },
  { id: 'injuries', label: 'Injuries' },
  { id: 'combine', label: 'Combine' },
  { id: 'draft', label: 'Draft' },
  { id: 'sleeper', label: 'Sleeper' },
];

function App() {
  const [tab, setTab] = useState<Tab>('projections');
  const [season, setSeason] = useState(2025);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, setApiKeysVersion] = useState(0);
  const [extraData, setExtraData] = useState<unknown[]>([]);
  const [otherOpen, setOtherOpen] = useState(false);
  const { seasonTotals, loading, error } = usePlayerData(season);

  const onDataLoaded = useCallback((data: unknown[]) => {
    setExtraData(data);
  }, []);

  const dataContext = buildDataContext(tab, season, seasonTotals, extraData);

  const isOtherTab = OTHER_TABS.some((t) => t.id === tab);
  const otherLabel = isOtherTab ? OTHER_TABS.find((t) => t.id === tab)?.label : 'Other';

  return (
    <>
      <header className="header">
        <div className="header-logo">
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="StatHead" style={{ height: 36 }} />
          <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400, marginTop: -2, letterSpacing: '0.5px' }}>
            v{__APP_VERSION__} · {__BUILD_HASH__}
          </div>
        </div>
        <nav className="nav-tabs">
          {PRIMARY_TABS.map((t) => (
            <button
              key={t.id}
              className={`nav-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => {
                setTab(t.id);
                setExtraData([]);
                setOtherOpen(false);
              }}
            >
              {t.label}
            </button>
          ))}
          <div style={{ position: 'relative' }}>
            <button
              className={`nav-tab ${isOtherTab ? 'active' : ''}`}
              onClick={() => setOtherOpen(!otherOpen)}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              {otherLabel} <span style={{ fontSize: 8, opacity: 0.6 }}>{otherOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
            {otherOpen && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                  onClick={() => setOtherOpen(false)}
                />
                <div style={{
                  position: 'absolute', top: '100%', left: 0, zIndex: 100,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '4px 0', minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                }}>
                  {OTHER_TABS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => { setTab(t.id); setExtraData([]); setOtherOpen(false); }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '8px 16px', border: 'none', background: tab === t.id ? 'var(--bg-tertiary)' : 'transparent',
                        color: tab === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontWeight: tab === t.id ? 700 : 400, fontSize: 13, cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                      onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--bg-tertiary)'; }}
                      onMouseLeave={(e) => { (e.target as HTMLElement).style.background = tab === t.id ? 'var(--bg-tertiary)' : 'transparent'; }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
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
        {tab === 'projections' && <StatProjections season={season} />}
        {tab === 'stats' && season >= 2026
          ? <ExternalRankings2026 />
          : tab === 'stats' && (
            <PlayerStatsTable
              players={seasonTotals}
              loading={loading}
              error={error}
              season={season}
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
