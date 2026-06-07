declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

import { useState, useCallback, useMemo, useEffect } from 'react';
import { usePlayerData } from './hooks/usePlayerData';
import { PlayerDetail } from './components/PlayerDetail';
import { parsePlayerHash, setPlayerHash } from './lib/hashRoute';
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
import { ScheduleView } from './components/ScheduleView';
import { SleeperLeagueView } from './components/SleeperLeagueView';
import { ConsensusAdpView } from './components/ConsensusAdpView';
import { ExternalRankings2026 } from './components/ExternalRankings2026';
import { RookieRBChart } from './components/RookieRBChart';
import { SleeperView } from './components/SleeperView';
import { KTCView } from './components/KTCView';
import { SportsDataIOView } from './components/SportsDataIOView';
import { RookieProspectsView } from './components/RookieProspectsView';
import { Prospects2027View } from './components/Prospects2027View';
import { TradeCalculator } from './components/TradeCalculator';
import { DynastyForecast } from './components/DynastyForecast';
import { DraftOptimizerTable } from './components/DraftOptimizerTable';
import { ModelDocumentation } from './components/ModelDocumentation';
import { RookieCareerBacktest } from './components/RookieCareerBacktest';
import { ZapComparison } from './components/ZapComparison';
import { DocsRookie } from './components/DocsRookie';
import { DocsDynasty } from './components/DocsDynasty';
import { DocsSeasonPPG } from './components/DocsSeasonPPG';
import { MyRankings } from './components/MyRankings';
import { MyProspectRankings } from './components/MyProspectRankings';
import { DataQuery } from './components/DataQuery';
import { HomePage } from './components/HomePage';
import { SettingsModal } from './components/SettingsModal';
import { ChatDrawer } from './components/ChatDrawer';
import { buildDataContext } from './context';
import { createEmptyScenario } from './lib/scenarioEngine';
import type { Tab, ScenarioConfig } from './types';

const SEASONS = Array.from({ length: 10 }, (_, i) => 2026 - i);

// Tabs whose render path actually consumes the `season` prop or
// `seasonTotals` derived from `usePlayerData(season)`. The header season
// selector only shows for these — every other page is hardcoded to 2026
// (projections, dynasty, prospects) or season-agnostic (research, docs).
const SEASON_AWARE_TABS = new Set<Tab>([
  'projections', 'stats', 'compare', 'scoring', 'adp',
  'snaps', 'injuries', 'advanced', 'pbp', 'sleeper', 'sportsdata',
]);

// Tab groups for navigation
interface TabGroup {
  label: string;
  tabs: { id: Tab; label: string }[];
}

// Visible navigation groups. Retired pages (In-Season, Sleeper, Compare, ADP Research,
// Advanced Stats, PBP, Combine, Draft History, Chart Builder, ZAP Compare, per-model
// docs) remain wired in the render switch below so they keep working at their existing
// tab ids — they just no longer appear in the header menu.
const TAB_GROUPS: TabGroup[] = [
  {
    label: 'Projections',
    tabs: [
      { id: 'projections', label: 'Projections' },
      { id: 'scenario-builder', label: 'Scenario Builder' },
      { id: 'schedule', label: 'Schedule & SOS' },
      { id: 'sleeper-league', label: 'Sleeper League' },
      { id: 'consensus-adp', label: 'Consensus ADP' },
      { id: 'my-rankings', label: 'My Rankings' },
      { id: 'stats', label: 'Rankings' },
      { id: 'draft-optimizer', label: 'Draft Optimizer' },
    ],
  },
  {
    label: 'Dynasty',
    tabs: [
      { id: 'ktc', label: 'Dynasty Values' },
      { id: 'trade-calc', label: 'Trade Calculator' },
      { id: 'dynasty-forecast', label: 'Value Forecast' },
      { id: 'prospects', label: 'Prospects' },
      { id: 'prospects-2027', label: '2027 Prospects' },
      { id: 'my-prospects', label: 'My Prospect Rankings' },
      { id: 'career-backtest', label: 'Career Backtest' },
    ],
  },
  {
    label: 'Research',
    tabs: [
      { id: 'data-query', label: 'Data Query (SQL)' },
      { id: 'model-docs', label: 'Model Docs' },
    ],
  },
];


function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [season, setSeason] = useState(2026);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, setApiKeysVersion] = useState(0);
  const [extraData, setExtraData] = useState<unknown[]>([]);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [scenario, setScenario] = useState<ScenarioConfig>(createEmptyScenario);
  const { seasonTotals, loading, error } = usePlayerData(season);

  // Hash-based player detail route: `#/player/sh_<key>` renders the
  // PlayerDetail page in place of the normal tab layout. Subscribes to
  // `hashchange` so back/forward + in-app navigation both work.
  const [playerDetailKey, setPlayerDetailKey] = useState<string | null>(
    () => (typeof window !== 'undefined' ? parsePlayerHash(window.location.hash) : null),
  );
  useEffect(() => {
    const handler = () => setPlayerDetailKey(parsePlayerHash(window.location.hash));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const onDataLoaded = useCallback((data: unknown[]) => {
    setExtraData(data);
  }, []);

  const dataContext = useMemo(
    () => buildDataContext(tab, season, seasonTotals, extraData),
    [tab, season, seasonTotals, extraData],
  );


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
          <button
            className={`nav-tab ${tab === 'home' ? 'active' : ''}`}
            onClick={() => { setTab('home'); setExtraData([]); setOpenGroup(null); }}
          >
            Home
          </button>
          {TAB_GROUPS.map((group) => {
            const isOpen = openGroup === group.label;
            const activeTab = group.tabs.find((t) => t.id === tab);
            const hasActive = !!activeTab;
            const displayLabel = hasActive ? activeTab.label : group.label;
            return (
              <div key={group.label} style={{ position: 'relative' }}>
                <button
                  className={`nav-tab ${hasActive ? 'active' : ''}`}
                  onClick={() => setOpenGroup(isOpen ? null : group.label)}
                  style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  {displayLabel} <span style={{ fontSize: 8, opacity: 0.6 }}>{isOpen ? '\u25B2' : '\u25BC'}</span>
                </button>
                {isOpen && (
                  <>
                    <div
                      style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                      onClick={() => setOpenGroup(null)}
                    />
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, zIndex: 100,
                      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                      borderRadius: 6, padding: '4px 0', minWidth: 170, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                    }}>
                      <div style={{
                        padding: '4px 12px 6px', fontSize: 10, fontWeight: 700,
                        color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px',
                      }}>
                        {group.label}
                      </div>
                      {group.tabs.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => { setTab(t.id); setExtraData([]); setOpenGroup(null); }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left',
                            padding: '8px 16px', border: 'none',
                            background: tab === t.id ? 'var(--bg-tertiary)' : 'transparent',
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
            );
          })}
        </nav>
        <div className="control-group" style={{ marginLeft: 'auto' }}>
          {SEASON_AWARE_TABS.has(tab) && (
            <>
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
            </>
          )}
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
        {playerDetailKey ? (
          <PlayerDetail playerKey={playerDetailKey} onBack={() => setPlayerHash(null)} />
        ) : (
          <>
        {tab === 'home' && <HomePage onNavigate={(t) => { setTab(t); setExtraData([]); }} />}
        {tab === 'projections' && <StatProjections season={season} scenario={scenario} onScenarioChange={setScenario} />}
        {tab === 'scenario-builder' && <StatProjections season={season} scenario={scenario} onScenarioChange={setScenario} embedBuilder />}
        {tab === 'schedule' && <ScheduleView />}
        {tab === 'my-rankings' && <MyRankings scenario={scenario} />}
        {tab === 'stats' && season >= 2026
          ? <ExternalRankings2026 scenario={scenario} />
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
            scenario={scenario}
          />
        )}
        {tab === 'games' && <GamesView onDataLoaded={onDataLoaded} />}
        {tab === 'snaps' && (
          <SnapCountsView season={season} onDataLoaded={onDataLoaded} />
        )}
        {tab === 'combine' && <CombineView onDataLoaded={onDataLoaded} />}
        {tab === 'draft' && <DraftView onDataLoaded={onDataLoaded} />}
        {tab === 'prospects' && <RookieProspectsView onDataLoaded={onDataLoaded} />}
        {tab === 'prospects-2027' && <Prospects2027View onDataLoaded={onDataLoaded} />}
        {tab === 'my-prospects' && <MyProspectRankings scenario={scenario} />}
        {tab === 'data-query' && <DataQuery />}
        {tab === 'draft-optimizer' && <DraftOptimizerTable />}
        {tab === 'trade-calc' && <TradeCalculator onDataLoaded={onDataLoaded} />}
        {tab === 'dynasty-forecast' && <DynastyForecast onDataLoaded={onDataLoaded} />}
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
        {tab === 'career-backtest' && <RookieCareerBacktest />}
        {tab === 'zap-compare' && <ZapComparison />}
        {tab === 'model-docs' && <ModelDocumentation />}
        {tab === 'docs-rookie' && <DocsRookie />}
        {tab === 'docs-dynasty' && <DocsDynasty />}
        {tab === 'docs-season-ppg' && <DocsSeasonPPG />}
        {tab === 'sleeper' && (
          <SleeperView season={season} onDataLoaded={onDataLoaded} />
        )}
        {tab === 'sleeper-league' && <SleeperLeagueView />}
        {tab === 'consensus-adp' && <ConsensusAdpView />}
        {tab === 'ktc' && <KTCView onDataLoaded={onDataLoaded} />}
        {tab === 'sportsdata' && (
          <SportsDataIOView
            season={season}
            onDataLoaded={onDataLoaded}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
          </>
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
