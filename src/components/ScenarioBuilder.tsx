import { useState, useMemo, useEffect } from 'react';
import type {
  SDIOProjection,
  ScenarioConfig,
  TeamTendency,
  TeamVolume,
  TeamStatAdjustment,
  TeamStatKey,
  VolumeOverride,
  PlayerMovement,
  CustomPlayer,
  FreeAgentPlayer,
  FreeAgentSigning,
} from '../types';
import {
  saveScenario,
  loadAllScenarios,
  deleteScenario,
  isScenarioEmpty,
} from '../lib/scenarioEngine';

interface Props {
  open: boolean;
  onClose: () => void;
  projections: SDIOProjection[];
  freeAgents?: FreeAgentPlayer[];
  scenario: ScenarioConfig;
  onChange: (s: ScenarioConfig) => void;
}

function usePlayerSearch(projections: SDIOProjection[], query: string) {
  return useMemo(() => {
    if (!query.trim() || query.length < 2) return [];
    const q = query.toLowerCase();
    return projections
      .filter(
        (p) =>
          p.Name.toLowerCase().includes(q) ||
          (p.Team && p.Team.toLowerCase().includes(q))
      )
      .slice(0, 10);
  }, [projections, query]);
}

function useFASearch(freeAgents: FreeAgentPlayer[], query: string) {
  return useMemo(() => {
    if (!query.trim() || query.length < 2) return [];
    const q = query.toLowerCase();
    return freeAgents
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 10);
  }, [freeAgents, query]);
}

export function ScenarioBuilder({ open, onClose, projections, freeAgents = [], scenario, onChange }: Props) {
  const [savedList, setSavedList] = useState<ScenarioConfig[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  // Team tendency add form
  const [addingTeam, setAddingTeam] = useState(false);
  const [newTeam, setNewTeam] = useState('');
  const [newTeamDelta, setNewTeamDelta] = useState(0);

  // Team volume add form
  const [addingTeamVol, setAddingTeamVol] = useState(false);
  const [newTeamVolTeam, setNewTeamVolTeam] = useState('');
  const [newTeamVolDelta, setNewTeamVolDelta] = useState(0);

  // Volume override add form
  const [volSearch, setVolSearch] = useState('');
  const [volPlayer, setVolPlayer] = useState<SDIOProjection | null>(null);
  const [volDelta, setVolDelta] = useState(0);
  const volResults = usePlayerSearch(projections, volSearch);

  // Player movement add form
  const [moveSearch, setMoveSearch] = useState('');
  const [movePlayer, setMovePlayer] = useState<SDIOProjection | null>(null);
  const [moveToTeam, setMoveToTeam] = useState('');
  const moveResults = usePlayerSearch(projections, moveSearch);

  // Team stat adjustment add form
  const [addingTeamStat, setAddingTeamStat] = useState(false);
  const [newStatTeam, setNewStatTeam] = useState('');
  const [newStatKey, setNewStatKey] = useState<TeamStatKey>('PassingYards');
  const [newStatDelta, setNewStatDelta] = useState(0);

  // Custom player add form
  const [addingCustom, setAddingCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customPos, setCustomPos] = useState('WR');
  const [customTeam, setCustomTeam] = useState('');
  const [customPPR, setCustomPPR] = useState(0);

  const STAT_LABELS: Record<TeamStatKey, string> = {
    PassingAttempts: 'Pass Attempts',
    PassingCompletions: 'Completions',
    PassingYards: 'Pass Yards',
    PassingTouchdowns: 'Pass TDs',
    PassingInterceptions: 'Interceptions',
    RushingAttempts: 'Rush Attempts',
    RushingYards: 'Rush Yards',
    RushingTouchdowns: 'Rush TDs',
    Receptions: 'Receptions',
    ReceivingYards: 'Rec Yards',
    ReceivingTouchdowns: 'Rec TDs',
  };

  const STAT_GROUPS: { label: string; stats: TeamStatKey[] }[] = [
    { label: 'Passing', stats: ['PassingAttempts', 'PassingCompletions', 'PassingYards', 'PassingTouchdowns', 'PassingInterceptions'] },
    { label: 'Rushing', stats: ['RushingAttempts', 'RushingYards', 'RushingTouchdowns'] },
    { label: 'Receiving', stats: ['Receptions', 'ReceivingYards', 'ReceivingTouchdowns'] },
  ];

  // Free agent signing form
  const [faSearch, setFaSearch] = useState('');
  const [faPlayer, setFaPlayer] = useState<FreeAgentPlayer | null>(null);
  const [faToTeam, setFaToTeam] = useState('');
  const faResults = useFASearch(freeAgents, faSearch);

  const teams = useMemo(() => {
    const set = new Set(projections.map((p) => p.Team).filter(Boolean));
    return Array.from(set).sort();
  }, [projections]);

  useEffect(() => {
    if (open) setSavedList(loadAllScenarios());
  }, [open]);

  if (!open) return null;

  const update = (patch: Partial<ScenarioConfig>) => onChange({ ...scenario, ...patch });

  // --- Team tendency actions ---
  const addTeamTendency = () => {
    if (!newTeam || newTeamDelta === 0) return;
    if (scenario.teamTendencies.find((t) => t.team === newTeam)) return;
    const tendency: TeamTendency = { team: newTeam, passRatioDelta: newTeamDelta };
    update({ teamTendencies: [...scenario.teamTendencies, tendency] });
    setNewTeam('');
    setNewTeamDelta(0);
    setAddingTeam(false);
  };
  const removeTeamTendency = (team: string) =>
    update({ teamTendencies: scenario.teamTendencies.filter((t) => t.team !== team) });
  const updateTeamDelta = (team: string, delta: number) =>
    update({
      teamTendencies: scenario.teamTendencies.map((t) =>
        t.team === team ? { ...t, passRatioDelta: delta } : t
      ),
    });

  // --- Team volume actions ---
  const addTeamVolume = () => {
    if (!newTeamVolTeam || newTeamVolDelta === 0) return;
    if ((scenario.teamVolumes ?? []).find((t) => t.team === newTeamVolTeam)) return;
    const tv: TeamVolume = { team: newTeamVolTeam, volumeDelta: newTeamVolDelta };
    update({ teamVolumes: [...(scenario.teamVolumes ?? []), tv] });
    setNewTeamVolTeam('');
    setNewTeamVolDelta(0);
    setAddingTeamVol(false);
  };
  const removeTeamVolume = (team: string) =>
    update({ teamVolumes: (scenario.teamVolumes ?? []).filter((t) => t.team !== team) });
  const updateTeamVolumeDelta = (team: string, delta: number) =>
    update({
      teamVolumes: (scenario.teamVolumes ?? []).map((t) =>
        t.team === team ? { ...t, volumeDelta: delta } : t
      ),
    });

  // --- Team stat adjustment actions ---
  const addTeamStat = () => {
    if (!newStatTeam || newStatDelta === 0) return;
    if ((scenario.teamStatAdjustments ?? []).find((a) => a.team === newStatTeam && a.stat === newStatKey)) return;
    const adj: TeamStatAdjustment = { team: newStatTeam, stat: newStatKey, delta: newStatDelta };
    update({ teamStatAdjustments: [...(scenario.teamStatAdjustments ?? []), adj] });
    setNewStatTeam('');
    setNewStatDelta(0);
    setAddingTeamStat(false);
  };
  const removeTeamStat = (team: string, stat: TeamStatKey) =>
    update({ teamStatAdjustments: (scenario.teamStatAdjustments ?? []).filter((a) => !(a.team === team && a.stat === stat)) });
  const updateTeamStatDelta = (team: string, stat: TeamStatKey, delta: number) =>
    update({
      teamStatAdjustments: (scenario.teamStatAdjustments ?? []).map((a) =>
        a.team === team && a.stat === stat ? { ...a, delta } : a
      ),
    });

  // --- Volume override actions ---
  const addVolumeOverride = () => {
    if (!volPlayer || volDelta === 0) return;
    if (scenario.volumeOverrides.find((v) => v.playerId === volPlayer.PlayerID)) return;
    const override: VolumeOverride = {
      playerId: volPlayer.PlayerID,
      playerName: volPlayer.Name,
      team: volPlayer.Team,
      position: volPlayer.Position,
      volumeDelta: volDelta,
    };
    update({ volumeOverrides: [...scenario.volumeOverrides, override] });
    setVolSearch('');
    setVolPlayer(null);
    setVolDelta(0);
  };
  const removeVolumeOverride = (id: number) =>
    update({ volumeOverrides: scenario.volumeOverrides.filter((v) => v.playerId !== id) });
  const updateVolumeDelta = (id: number, delta: number) =>
    update({
      volumeOverrides: scenario.volumeOverrides.map((v) =>
        v.playerId === id ? { ...v, volumeDelta: delta } : v
      ),
    });

  // --- Player movement actions ---
  const addMovement = () => {
    if (!movePlayer || !moveToTeam) return;
    const movement: PlayerMovement = {
      playerId: movePlayer.PlayerID,
      playerName: movePlayer.Name,
      fromTeam: movePlayer.Team,
      toTeam: moveToTeam,
    };
    update({
      movements: [
        ...scenario.movements.filter((m) => m.playerId !== movePlayer.PlayerID),
        movement,
      ],
    });
    setMoveSearch('');
    setMovePlayer(null);
    setMoveToTeam('');
  };
  const removeMovement = (id: number) =>
    update({ movements: scenario.movements.filter((m) => m.playerId !== id) });

  // --- Custom player actions ---
  const addCustomPlayer = () => {
    if (!customName) return;
    const cp: CustomPlayer = {
      id: `cp-${Date.now()}`,
      name: customName,
      position: customPos,
      team: customTeam || 'FA',
      fantasyPointsPPR: customPPR,
      fantasyPoints: Math.max(0, customPPR - 5),
    };
    update({ customPlayers: [...scenario.customPlayers, cp] });
    setCustomName('');
    setCustomTeam('');
    setCustomPPR(0);
    setAddingCustom(false);
  };
  const removeCustomPlayer = (id: string) =>
    update({ customPlayers: scenario.customPlayers.filter((c) => c.id !== id) });

  // --- Free agent signing actions ---
  const addFASigning = () => {
    if (!faPlayer || !faToTeam) return;
    const signing: FreeAgentSigning = {
      id: `fa-${Date.now()}`,
      name: faPlayer.name,
      position: faPlayer.position,
      toTeam: faToTeam,
      priorGames: faPlayer.priorGames,
      priorPPR: faPlayer.priorPPR,
      passAtt: faPlayer.passAtt,
      passComp: faPlayer.passComp,
      passYds: faPlayer.passYds,
      passTD: faPlayer.passTD,
      int: faPlayer.int,
      rushAtt: faPlayer.rushAtt,
      rushYds: faPlayer.rushYds,
      rushTD: faPlayer.rushTD,
      tgt: faPlayer.tgt,
      rec: faPlayer.rec,
      recYds: faPlayer.recYds,
      recTD: faPlayer.recTD,
    };
    update({
      freeAgentSignings: [
        ...(scenario.freeAgentSignings ?? []).filter((s) => s.name !== faPlayer.name),
        signing,
      ],
    });
    setFaSearch('');
    setFaPlayer(null);
    setFaToTeam('');
  };
  const removeFASigning = (id: string) =>
    update({ freeAgentSignings: (scenario.freeAgentSignings ?? []).filter((s) => s.id !== id) });

  // --- Save/load ---
  const handleSave = () => {
    saveScenario(scenario);
    setSavedList(loadAllScenarios());
  };
  const handleLoad = (s: ScenarioConfig) => {
    onChange(s);
    setShowSaved(false);
  };
  const handleDelete = (id: string) => {
    deleteScenario(id);
    setSavedList(loadAllScenarios());
  };

  const activeCount =
    scenario.teamTendencies.length +
    (scenario.teamVolumes ?? []).length +
    (scenario.teamStatAdjustments ?? []).length +
    scenario.volumeOverrides.length +
    scenario.movements.length +
    scenario.customPlayers.length +
    (scenario.freeAgentSignings ?? []).length;

  const deltaLabel = (delta: number, type: 'pass' | 'volume') => {
    if (delta === 0) return '0';
    if (type === 'pass') {
      return delta > 0 ? `+${delta}% Pass` : `${delta}% Run`;
    }
    return delta > 0 ? `+${delta}%` : `${delta}%`;
  };

  return (
    <>
      <div className="scenario-overlay" onClick={onClose} />
      <div className="scenario-drawer">
        {/* Header */}
        <div className="scenario-header">
          <div>
            <div className="scenario-title">Scenario Builder</div>
            {activeCount > 0 && (
              <div className="scenario-count">
                {activeCount} adjustment{activeCount !== 1 ? 's' : ''} active
              </div>
            )}
          </div>
          <button className="chat-close" onClick={onClose}>✕</button>
        </div>

        <div className="scenario-body">

          {/* Scenario name + save/load */}
          <div className="scenario-section">
            <div className="scenario-name-row">
              <input
                className="scenario-name-input"
                value={scenario.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="Scenario name..."
              />
              <button className="scenario-action-btn" onClick={handleSave}>Save</button>
              <button
                className={`scenario-action-btn ${showSaved ? 'active' : ''}`}
                onClick={() => setShowSaved((v) => !v)}
              >
                Load
              </button>
            </div>
            {showSaved && (
              <div className="scenario-saved-list">
                {savedList.length === 0 ? (
                  <div className="scenario-empty-msg">No saved scenarios yet</div>
                ) : (
                  savedList.map((s) => (
                    <div key={s.id} className="scenario-saved-item">
                      <span className="scenario-saved-name">{s.name}</span>
                      <div className="scenario-saved-actions">
                        <button
                          className="scenario-link-btn"
                          onClick={() => handleLoad(s)}
                        >
                          Load
                        </button>
                        <button
                          className="scenario-link-btn danger"
                          onClick={() => handleDelete(s.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 1. Vegas Line Weighting */}
          <div className="scenario-section">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Vegas Line Weighting</span>
            </div>
            <p className="scenario-section-hint">
              Higher weighting regresses projections toward position averages, simulating
              Vegas market efficiency.
            </p>
            <div className="scenario-vegas-options">
              {[0, 10, 25, 50].map((v) => (
                <button
                  key={v}
                  className={`scenario-vegas-btn ${scenario.vegasWeighting === v ? 'active' : ''}`}
                  onClick={() => update({ vegasWeighting: v })}
                >
                  {v}%
                </button>
              ))}
            </div>
          </div>

          {/* 2. Team Tendencies */}
          <div className="scenario-section">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Team Tendencies</span>
              <button
                className="scenario-add-btn"
                onClick={() => setAddingTeam((v) => !v)}
              >
                {addingTeam ? '✕' : '+ Add'}
              </button>
            </div>
            <p className="scenario-section-hint">Adjust pass/run ratio per team.</p>

            {addingTeam && (
              <div className="scenario-add-form">
                <select
                  value={newTeam}
                  onChange={(e) => setNewTeam(e.target.value)}
                  className="scenario-select"
                >
                  <option value="">Select team...</option>
                  {teams
                    .filter((t) => !scenario.teamTendencies.find((x) => x.team === t))
                    .map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                </select>
                <div className="scenario-slider-row">
                  <span className="scenario-slider-label scenario-label-run">Run</span>
                  <input
                    type="range"
                    min={-30}
                    max={30}
                    value={newTeamDelta}
                    onChange={(e) => setNewTeamDelta(Number(e.target.value))}
                    className="scenario-slider"
                  />
                  <span className="scenario-slider-label scenario-label-pass">Pass</span>
                </div>
                <div className="scenario-slider-value-row">
                  <span
                    className={`scenario-slider-value ${
                      newTeamDelta > 0 ? 'positive' : newTeamDelta < 0 ? 'negative' : ''
                    }`}
                  >
                    {deltaLabel(newTeamDelta, 'pass')}
                  </span>
                </div>
                <button
                  className="scenario-confirm-btn"
                  onClick={addTeamTendency}
                  disabled={!newTeam || newTeamDelta === 0}
                >
                  Add Adjustment
                </button>
              </div>
            )}

            {scenario.teamTendencies.map((t) => (
              <div key={t.team} className="scenario-item">
                <div className="scenario-item-left">
                  <span className="scenario-item-name">{t.team}</span>
                  <span
                    className={`scenario-item-delta ${
                      t.passRatioDelta > 0 ? 'positive' : 'negative'
                    }`}
                  >
                    {deltaLabel(t.passRatioDelta, 'pass')}
                  </span>
                </div>
                <div className="scenario-item-controls">
                  <input
                    type="range"
                    min={-30}
                    max={30}
                    value={t.passRatioDelta}
                    onChange={(e) => updateTeamDelta(t.team, Number(e.target.value))}
                    className="scenario-slider-inline"
                  />
                  <button
                    className="scenario-remove-btn"
                    onClick={() => removeTeamTendency(t.team)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}

            {scenario.teamTendencies.length === 0 && !addingTeam && (
              <div className="scenario-section-empty">No team adjustments</div>
            )}
          </div>

          {/* 3. Team Volume */}
          <div className="scenario-section">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Team Volume</span>
              <button
                className="scenario-add-btn"
                onClick={() => setAddingTeamVol((v) => !v)}
              >
                {addingTeamVol ? '✕' : '+ Add'}
              </button>
            </div>
            <p className="scenario-section-hint">
              Scale total volume for all players on a team (total pie size, not the split).
            </p>

            {addingTeamVol && (
              <div className="scenario-add-form">
                <select
                  value={newTeamVolTeam}
                  onChange={(e) => setNewTeamVolTeam(e.target.value)}
                  className="scenario-select"
                >
                  <option value="">Select team...</option>
                  {teams
                    .filter((t) => !(scenario.teamVolumes ?? []).find((x) => x.team === t))
                    .map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                </select>
                <div className="scenario-slider-row">
                  <span className="scenario-slider-label scenario-label-run">−50%</span>
                  <input
                    type="range"
                    min={-50}
                    max={50}
                    value={newTeamVolDelta}
                    onChange={(e) => setNewTeamVolDelta(Number(e.target.value))}
                    className="scenario-slider"
                  />
                  <span className="scenario-slider-label scenario-label-pass">+50%</span>
                </div>
                <div className="scenario-slider-value-row">
                  <span
                    className={`scenario-slider-value ${
                      newTeamVolDelta > 0 ? 'positive' : newTeamVolDelta < 0 ? 'negative' : ''
                    }`}
                  >
                    {deltaLabel(newTeamVolDelta, 'volume')}
                  </span>
                </div>
                <button
                  className="scenario-confirm-btn"
                  onClick={addTeamVolume}
                  disabled={!newTeamVolTeam || newTeamVolDelta === 0}
                >
                  Add Adjustment
                </button>
              </div>
            )}

            {(scenario.teamVolumes ?? []).map((tv) => (
              <div key={tv.team} className="scenario-item">
                <div className="scenario-item-left">
                  <span className="scenario-item-name">{tv.team}</span>
                  <span
                    className={`scenario-item-delta ${
                      tv.volumeDelta > 0 ? 'positive' : 'negative'
                    }`}
                  >
                    {deltaLabel(tv.volumeDelta, 'volume')} volume
                  </span>
                </div>
                <div className="scenario-item-controls">
                  <input
                    type="range"
                    min={-50}
                    max={50}
                    value={tv.volumeDelta}
                    onChange={(e) => updateTeamVolumeDelta(tv.team, Number(e.target.value))}
                    className="scenario-slider-inline"
                  />
                  <button
                    className="scenario-remove-btn"
                    onClick={() => removeTeamVolume(tv.team)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}

            {(scenario.teamVolumes ?? []).length === 0 && !addingTeamVol && (
              <div className="scenario-section-empty">No team volume adjustments</div>
            )}
          </div>

          {/* 4. Team Stat Adjustments */}
          <div className="scenario-section">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Team Stat Adjustments</span>
              <button
                className="scenario-add-btn"
                onClick={() => setAddingTeamStat((v) => !v)}
              >
                {addingTeamStat ? '✕' : '+ Add'}
              </button>
            </div>
            <p className="scenario-section-hint">
              Tweak specific team-level stats. Changes flow proportionally to all relevant players.
            </p>

            {addingTeamStat && (
              <div className="scenario-add-form">
                <select
                  value={newStatTeam}
                  onChange={(e) => setNewStatTeam(e.target.value)}
                  className="scenario-select"
                >
                  <option value="">Select team...</option>
                  {teams.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <select
                  value={newStatKey}
                  onChange={(e) => setNewStatKey(e.target.value as TeamStatKey)}
                  className="scenario-select"
                >
                  {STAT_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.stats.map((s) => (
                        <option key={s} value={s}>{STAT_LABELS[s]}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <div className="scenario-slider-row">
                  <span className="scenario-slider-label scenario-label-run">−50%</span>
                  <input
                    type="range"
                    min={-50}
                    max={50}
                    value={newStatDelta}
                    onChange={(e) => setNewStatDelta(Number(e.target.value))}
                    className="scenario-slider"
                  />
                  <span className="scenario-slider-label scenario-label-pass">+50%</span>
                </div>
                <div className="scenario-slider-value-row">
                  <span
                    className={`scenario-slider-value ${
                      newStatDelta > 0 ? 'positive' : newStatDelta < 0 ? 'negative' : ''
                    }`}
                  >
                    {deltaLabel(newStatDelta, 'volume')}
                  </span>
                </div>
                <button
                  className="scenario-confirm-btn"
                  onClick={addTeamStat}
                  disabled={!newStatTeam || newStatDelta === 0}
                >
                  Add Adjustment
                </button>
              </div>
            )}

            {(scenario.teamStatAdjustments ?? []).map((a) => (
              <div key={`${a.team}-${a.stat}`} className="scenario-item">
                <div className="scenario-item-left">
                  <span className="scenario-item-name">{a.team}</span>
                  <span className="scenario-item-stat-label">{STAT_LABELS[a.stat]}</span>
                  <span
                    className={`scenario-item-delta ${
                      a.delta > 0 ? 'positive' : 'negative'
                    }`}
                  >
                    {deltaLabel(a.delta, 'volume')}
                  </span>
                </div>
                <div className="scenario-item-controls">
                  <input
                    type="range"
                    min={-50}
                    max={50}
                    value={a.delta}
                    onChange={(e) => updateTeamStatDelta(a.team, a.stat, Number(e.target.value))}
                    className="scenario-slider-inline"
                  />
                  <button
                    className="scenario-remove-btn"
                    onClick={() => removeTeamStat(a.team, a.stat)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}

            {(scenario.teamStatAdjustments ?? []).length === 0 && !addingTeamStat && (
              <div className="scenario-section-empty">No stat adjustments</div>
            )}
          </div>

          {/* 6. Player Volume */}
          <div className="scenario-section">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Player Volume</span>
            </div>
            <p className="scenario-section-hint">
              Override target/carry share for individual players.
            </p>

            <div className="scenario-add-form">
              <div className="scenario-search-wrap">
                <input
                  type="text"
                  placeholder="Search player..."
                  value={volPlayer ? volPlayer.Name : volSearch}
                  onChange={(e) => {
                    setVolSearch(e.target.value);
                    setVolPlayer(null);
                  }}
                  className="scenario-search"
                />
                {volResults.length > 0 && !volPlayer && (
                  <div className="scenario-dropdown">
                    {volResults.map((p) => (
                      <div
                        key={p.PlayerID}
                        className="scenario-dropdown-item"
                        onClick={() => {
                          setVolPlayer(p);
                          setVolSearch('');
                        }}
                      >
                        <span className={`pos-badge pos-${p.Position}`}>{p.Position}</span>
                        <span className="scenario-dropdown-name">{p.Name}</span>
                        <span className="scenario-dropdown-team">{p.Team}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {volPlayer && (
                <>
                  <div className="scenario-selected-player">
                    <span className={`pos-badge pos-${volPlayer.Position}`}>
                      {volPlayer.Position}
                    </span>
                    <span>{volPlayer.Name}</span>
                    <span className="scenario-dropdown-team">{volPlayer.Team}</span>
                    <button
                      className="scenario-clear-selection"
                      onClick={() => setVolPlayer(null)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="scenario-slider-row">
                    <span className="scenario-slider-label scenario-label-run">−50%</span>
                    <input
                      type="range"
                      min={-50}
                      max={100}
                      value={volDelta}
                      onChange={(e) => setVolDelta(Number(e.target.value))}
                      className="scenario-slider"
                    />
                    <span className="scenario-slider-label scenario-label-pass">+100%</span>
                  </div>
                  <div className="scenario-slider-value-row">
                    <span
                      className={`scenario-slider-value ${
                        volDelta > 0 ? 'positive' : volDelta < 0 ? 'negative' : ''
                      }`}
                    >
                      Volume: {deltaLabel(volDelta, 'volume')}
                    </span>
                  </div>
                  <button
                    className="scenario-confirm-btn"
                    onClick={addVolumeOverride}
                    disabled={volDelta === 0}
                  >
                    Add Override
                  </button>
                </>
              )}
            </div>

            {scenario.volumeOverrides.map((v) => (
              <div key={v.playerId} className="scenario-item">
                <div className="scenario-item-left">
                  <span className={`pos-badge pos-${v.position}`}>{v.position}</span>
                  <span className="scenario-item-name">{v.playerName}</span>
                  <span
                    className={`scenario-item-delta ${
                      v.volumeDelta > 0 ? 'positive' : 'negative'
                    }`}
                  >
                    {deltaLabel(v.volumeDelta, 'volume')}
                  </span>
                </div>
                <div className="scenario-item-controls">
                  <input
                    type="range"
                    min={-50}
                    max={100}
                    value={v.volumeDelta}
                    onChange={(e) => updateVolumeDelta(v.playerId, Number(e.target.value))}
                    className="scenario-slider-inline"
                  />
                  <button
                    className="scenario-remove-btn"
                    onClick={() => removeVolumeOverride(v.playerId)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}

            {scenario.volumeOverrides.length === 0 && !volPlayer && !volSearch && (
              <div className="scenario-section-empty">No volume overrides</div>
            )}
          </div>

          {/* 5. Player Movement */}
          <div className="scenario-section">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Player Movement</span>
            </div>
            <p className="scenario-section-hint">
              Simulate trades or free agent signings by moving players to new teams.
            </p>

            <div className="scenario-add-form">
              <div className="scenario-search-wrap">
                <input
                  type="text"
                  placeholder="Search player to move..."
                  value={movePlayer ? movePlayer.Name : moveSearch}
                  onChange={(e) => {
                    setMoveSearch(e.target.value);
                    setMovePlayer(null);
                  }}
                  className="scenario-search"
                />
                {moveResults.length > 0 && !movePlayer && (
                  <div className="scenario-dropdown">
                    {moveResults.map((p) => (
                      <div
                        key={p.PlayerID}
                        className="scenario-dropdown-item"
                        onClick={() => {
                          setMovePlayer(p);
                          setMoveSearch('');
                        }}
                      >
                        <span className={`pos-badge pos-${p.Position}`}>{p.Position}</span>
                        <span className="scenario-dropdown-name">{p.Name}</span>
                        <span className="scenario-dropdown-team">{p.Team}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {movePlayer && (
                <>
                  <div className="scenario-selected-player">
                    <span className={`pos-badge pos-${movePlayer.Position}`}>
                      {movePlayer.Position}
                    </span>
                    <span>{movePlayer.Name}</span>
                    <button
                      className="scenario-clear-selection"
                      onClick={() => setMovePlayer(null)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="scenario-move-row">
                    <span className="scenario-move-from">{movePlayer.Team}</span>
                    <span className="scenario-move-arrow">→</span>
                    <select
                      value={moveToTeam}
                      onChange={(e) => setMoveToTeam(e.target.value)}
                      className="scenario-select"
                    >
                      <option value="">New team...</option>
                      {teams
                        .filter((t) => t !== movePlayer.Team)
                        .map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                    </select>
                  </div>
                  <button
                    className="scenario-confirm-btn"
                    onClick={addMovement}
                    disabled={!moveToTeam}
                  >
                    Move Player
                  </button>
                </>
              )}
            </div>

            {scenario.movements.map((m) => (
              <div key={m.playerId} className="scenario-item">
                <div className="scenario-item-left">
                  <span className="scenario-item-name">{m.playerName}</span>
                  <span className="scenario-item-delta">
                    {m.fromTeam} → {m.toTeam}
                  </span>
                </div>
                <button
                  className="scenario-remove-btn"
                  onClick={() => removeMovement(m.playerId)}
                >
                  ✕
                </button>
              </div>
            ))}

            {scenario.movements.length === 0 && !movePlayer && !moveSearch && (
              <div className="scenario-section-empty">No player movements</div>
            )}
          </div>

          {/* 6. Free Agent Signings */}
          {freeAgents.length > 0 && (
          <div className="scenario-section">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Free Agent Signings</span>
            </div>
            <p className="scenario-section-hint">
              Sign free agents to a team. Projections use their prior-season stats adjusted for the new team context.
            </p>

            <div className="scenario-add-form">
              <div className="scenario-search-wrap">
                <input
                  type="text"
                  placeholder="Search free agents..."
                  value={faPlayer ? faPlayer.name : faSearch}
                  onChange={(e) => {
                    setFaSearch(e.target.value);
                    setFaPlayer(null);
                  }}
                  className="scenario-search"
                />
                {faResults.length > 0 && !faPlayer && (
                  <div className="scenario-dropdown">
                    {faResults.map((p) => (
                      <div
                        key={p.name}
                        className="scenario-dropdown-item"
                        onClick={() => {
                          setFaPlayer(p);
                          setFaSearch('');
                        }}
                      >
                        <span className={`pos-badge pos-${p.position}`}>{p.position}</span>
                        <span className="scenario-dropdown-name">{p.name}</span>
                        <span className="scenario-dropdown-team">{p.priorPPR} PPR ({p.priorGames}g)</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {faPlayer && (
                <>
                  <div className="scenario-selected-player">
                    <span className={`pos-badge pos-${faPlayer.position}`}>
                      {faPlayer.position}
                    </span>
                    <span>{faPlayer.name}</span>
                    <span className="scenario-dropdown-team">
                      {faPlayer.priorPPR} PPR last season ({faPlayer.priorGames}g)
                    </span>
                    <button
                      className="scenario-clear-selection"
                      onClick={() => setFaPlayer(null)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="scenario-move-row">
                    <span className="scenario-move-from">FA</span>
                    <span className="scenario-move-arrow">→</span>
                    <select
                      value={faToTeam}
                      onChange={(e) => setFaToTeam(e.target.value)}
                      className="scenario-select"
                    >
                      <option value="">Sign to team...</option>
                      {teams.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    className="scenario-confirm-btn"
                    onClick={addFASigning}
                    disabled={!faToTeam}
                  >
                    Sign Player
                  </button>
                </>
              )}
            </div>

            {(scenario.freeAgentSignings ?? []).map((s) => (
              <div key={s.id} className="scenario-item">
                <div className="scenario-item-left">
                  <span className={`pos-badge pos-${s.position}`}>{s.position}</span>
                  <span className="scenario-item-name">{s.name}</span>
                  <span className="scenario-item-delta">
                    FA → {s.toTeam} · {s.priorPPR} PPR last szn
                  </span>
                </div>
                <button
                  className="scenario-remove-btn"
                  onClick={() => removeFASigning(s.id)}
                >
                  ✕
                </button>
              </div>
            ))}

            {(scenario.freeAgentSignings ?? []).length === 0 && !faPlayer && !faSearch && (
              <div className="scenario-section-empty">No free agent signings</div>
            )}
          </div>
          )}

          {/* 7. Add Custom Player */}
          <div className="scenario-section">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Add Custom Player</span>
              <button
                className="scenario-add-btn"
                onClick={() => setAddingCustom((v) => !v)}
              >
                {addingCustom ? '✕' : '+ Add'}
              </button>
            </div>
            <p className="scenario-section-hint">
              Add free agents or incoming rookies to projections.
            </p>

            {addingCustom && (
              <div className="scenario-add-form">
                <input
                  type="text"
                  placeholder="Player name..."
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="scenario-search"
                />
                <div className="scenario-custom-row">
                  <select
                    value={customPos}
                    onChange={(e) => setCustomPos(e.target.value)}
                    className="scenario-select-sm"
                  >
                    {['QB', 'RB', 'WR', 'TE', 'K'].map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Team"
                    value={customTeam}
                    onChange={(e) => setCustomTeam(e.target.value.toUpperCase())}
                    className="scenario-input-sm"
                    maxLength={3}
                  />
                  <input
                    type="number"
                    placeholder="PPR pts"
                    value={customPPR || ''}
                    onChange={(e) => setCustomPPR(Number(e.target.value))}
                    className="scenario-input-sm"
                    min={0}
                  />
                </div>
                <button
                  className="scenario-confirm-btn"
                  onClick={addCustomPlayer}
                  disabled={!customName}
                >
                  Add Player
                </button>
              </div>
            )}

            {scenario.customPlayers.map((cp) => (
              <div key={cp.id} className="scenario-item">
                <div className="scenario-item-left">
                  <span className={`pos-badge pos-${cp.position}`}>{cp.position}</span>
                  <span className="scenario-item-name">{cp.name}</span>
                  <span className="scenario-item-delta">
                    {cp.team} · {cp.fantasyPointsPPR} PPR
                  </span>
                </div>
                <button
                  className="scenario-remove-btn"
                  onClick={() => removeCustomPlayer(cp.id)}
                >
                  ✕
                </button>
              </div>
            ))}

            {scenario.customPlayers.length === 0 && !addingCustom && (
              <div className="scenario-section-empty">No custom players</div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="scenario-footer">
          <button
            className="scenario-clear-btn"
            onClick={() =>
              onChange({
                ...scenario,
                vegasWeighting: 0,
                teamTendencies: [],
                teamVolumes: [],
                teamStatAdjustments: [],
                volumeOverrides: [],
                movements: [],
                customPlayers: [],
                freeAgentSignings: [],
              })
            }
            disabled={isScenarioEmpty(scenario)}
          >
            Clear All
          </button>
          <span className="scenario-status">
            {isScenarioEmpty(scenario)
              ? 'No adjustments active'
              : `Projections adjusted`}
          </span>
        </div>
      </div>
    </>
  );
}
