import { useState, useMemo, useEffect, Fragment } from 'react';
import type {
  SDIOProjection,
  ScenarioConfig,
  TeamTendency,
  TeamVolume,
  TeamStatAdjustment,
  TeamStatKey,
  PlayerMovement,
  CustomPlayer,
  FreeAgentPlayer,
  FreeAgentSigning,
  PlayerStatOverride,
} from '../types';
import {
  saveScenario,
  loadAllScenarios,
  deleteScenario,
  isScenarioEmpty,
  createEmptyScenario,
} from '../lib/scenarioEngine';
import { SCENARIO_PRESETS, type PresetMeta } from '../lib/scenarioPresets';

interface Props {
  open: boolean;
  onClose?: () => void;
  embedded?: boolean;
  projections: SDIOProjection[];
  freeAgents?: FreeAgentPlayer[];
  playerMeta?: PresetMeta;
  clayPpr?: Map<string, number>;
  normalizeName?: (s: string) => string;
  scenario: ScenarioConfig;
  onChange: (s: ScenarioConfig) => void;
  rankings?: RankedPlayer[];
}

interface RankedPlayer { pos: string; name: string; team: string; ppr: number; }

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

const defaultNormalize = (s: string) =>
  s.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();

const POS_COLORS: Record<string, string> = { QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444' };

// NFL divisions (in conference/division order) for the team selector.
const NFL_DIVISIONS: [string, string[]][] = [
  ['AFC East', ['BUF', 'MIA', 'NE', 'NYJ']],
  ['AFC North', ['BAL', 'CIN', 'CLE', 'PIT']],
  ['AFC South', ['HOU', 'IND', 'JAX', 'TEN']],
  ['AFC West', ['DEN', 'KC', 'LV', 'LAC']],
  ['NFC East', ['DAL', 'NYG', 'PHI', 'WAS']],
  ['NFC North', ['CHI', 'DET', 'GB', 'MIN']],
  ['NFC South', ['ATL', 'CAR', 'NO', 'TB']],
  ['NFC West', ['ARI', 'LA', 'SF', 'SEA']],
];
const STAT_COLS: ('PassingAttempts' | 'PassingCompletions' | 'PassingYards' | 'PassingTouchdowns' | 'PassingInterceptions' | 'RushingAttempts' | 'RushingYards' | 'RushingTouchdowns' | 'Receptions' | 'ReceivingYards' | 'ReceivingTouchdowns')[] = [
  'PassingAttempts', 'PassingCompletions', 'PassingYards', 'PassingTouchdowns', 'PassingInterceptions',
  'RushingAttempts', 'RushingYards', 'RushingTouchdowns', 'Receptions', 'ReceivingYards', 'ReceivingTouchdowns',
];

export function ScenarioBuilder({ open, onClose, embedded = false, projections, freeAgents = [], playerMeta, clayPpr, normalizeName, scenario, onChange, rankings = [] }: Props) {
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

  // Roster editor (by-team interactive view for volume / availability / projection)
  const [editTeam, setEditTeam] = useState('');
  // Which roster-table cell is currently in edit mode (click-to-edit stepper).
  const [editCell, setEditCell] = useState<{ id: number; field: string } | null>(null);
  // Which positions in the Overall Rankings panel are expanded past the top 5.
  const [expandedPos, setExpandedPos] = useState<Record<string, boolean>>({});
  // Close the active stepper when clicking away from any editable cell.
  useEffect(() => {
    if (!editCell) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.se-stepper') && !t.closest('.se-num')) setEditCell(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editCell]);

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

  // Teams ordered by division (then any leftovers) for the cycle selector.
  const orderedTeams = useMemo(() => {
    const set = new Set(teams);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const [, codes] of NFL_DIVISIONS) for (const c of codes) if (set.has(c)) { out.push(c); seen.add(c); }
    for (const t of teams) if (!seen.has(t)) out.push(t);
    return out;
  }, [teams]);
  const teamDivision = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [div, codes] of NFL_DIVISIONS) for (const c of codes) m[c] = div;
    return m;
  }, []);
  // Default to the first team so the builder opens on a team workspace.
  useEffect(() => {
    if (!editTeam && orderedTeams.length) setEditTeam(orderedTeams[0]);
  }, [orderedTeams, editTeam]);
  const cycleTeam = (dir: number) => {
    if (!orderedTeams.length) return;
    const i = orderedTeams.indexOf(editTeam);
    setEditTeam(orderedTeams[(i + dir + orderedTeams.length) % orderedTeams.length]);
    setEditCell(null);
  };

  // Overall rankings grouped by position (scenario-adjusted, passed from parent).
  const rankedByPos = useMemo(() => {
    const m: Record<string, RankedPlayer[]> = { QB: [], RB: [], WR: [], TE: [] };
    for (const r of rankings) (m[r.pos] ??= []).push(r);
    for (const k of Object.keys(m)) m[k].sort((a, b) => b.ppr - a.ppr);
    return m;
  }, [rankings]);

  // Roster editor: selected team's players grouped by position, each group
  // sorted by projected PPR (so the depth order reads top-down).
  const editRoster = useMemo(() => {
    if (!editTeam) return [] as { pos: string; players: SDIOProjection[] }[];
    const byPos: Record<string, SDIOProjection[]> = {};
    for (const p of projections) {
      if (p.Team !== editTeam) continue;
      (byPos[p.Position] ??= []).push(p);
    }
    return ['QB', 'RB', 'WR', 'TE']
      .filter((pos) => byPos[pos]?.length)
      .map((pos) => ({
        pos,
        players: byPos[pos].sort((a, b) => (b.FantasyPointsPPR || 0) - (a.FantasyPointsPPR || 0)),
      }));
  }, [projections, editTeam]);

  // Base team pools for the "Stats" share % (carries / receptions). Kept on the
  // base projection so the share readout is a stable reference.
  const editPools = useMemo(() => {
    let rushAtt = 0, passYds = 0, rec = 0, recYds = 0;
    for (const p of projections) {
      if (p.Team !== editTeam) continue;
      rushAtt += p.RushingAttempts || 0;
      passYds += p.PassingYards || 0;
      rec += p.Receptions || 0;
      recYds += p.ReceivingYards || 0;
    }
    return { rushAtt, passYds, rec, recYds };
  }, [projections, editTeam]);

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

  // --- Roster editor: per-player upsert setters (volume / availability / projection) ---
  // Each looks up the player's current value and writes (or clears) the matching
  // override array entry, keyed by PlayerID.
  const gamesOf = (id: number) =>
    (scenario.playerAvailability ?? []).find((a) => a.playerId === id)?.games ?? 17;
  const pprOf = (id: number) =>
    (scenario.pointsOverrides ?? []).find((o) => o.playerId === id)?.ppr;

  const setPlayerGames = (p: SDIOProjection, games: number) => {
    const rest = (scenario.playerAvailability ?? []).filter((a) => a.playerId !== p.PlayerID);
    update({
      playerAvailability: games >= 17 ? rest : [
        ...rest,
        { playerId: p.PlayerID, playerName: p.Name, team: p.Team, position: p.Position, games },
      ],
    });
  };
  const setPlayerPpr = (p: SDIOProjection, ppr: number | undefined) => {
    const rest = (scenario.pointsOverrides ?? []).filter((o) => o.playerId !== p.PlayerID);
    update({
      pointsOverrides: (ppr === undefined || ppr <= 0) ? rest : [
        ...rest,
        { playerId: p.PlayerID, playerName: p.Name, team: p.Team, position: p.Position, ppr: Math.round(ppr) },
      ],
    });
  };

  // Stat overrides (absolute counting stats). `statOf` returns the current
  // override; `statVal` falls back to the player's base projection; `setStats`
  // merges a patch (undefined clears a field) and drops the entry when empty.
  const STAT_FIELDS = [
    'PassingAttempts', 'PassingCompletions', 'PassingYards', 'PassingTouchdowns', 'PassingInterceptions',
    'RushingAttempts', 'RushingYards', 'RushingTouchdowns', 'Receptions', 'ReceivingYards', 'ReceivingTouchdowns',
  ] as const;
  type StatField = typeof STAT_FIELDS[number];
  const statOf = (id: number) => (scenario.statOverrides ?? []).find((s) => s.playerId === id);
  const statVal = (p: SDIOProjection, field: StatField): number => {
    const o = statOf(p.PlayerID) as Record<string, number | undefined> | undefined;
    const ov = o?.[field];
    return ov !== undefined ? ov : ((p as unknown as Record<string, number>)[field] || 0);
  };
  const setStats = (p: SDIOProjection, patch: Partial<Record<StatField, number | undefined>>) => {
    const rest = (scenario.statOverrides ?? []).filter((s) => s.playerId !== p.PlayerID);
    const existing = (statOf(p.PlayerID) ?? {
      playerId: p.PlayerID, playerName: p.Name, team: p.Team, position: p.Position,
    }) as unknown as Record<string, number | string | undefined>;
    const merged: Record<string, number | string | undefined> = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    const hasAny = STAT_FIELDS.some((f) => merged[f] !== undefined);
    update({ statOverrides: hasAny ? [...rest, merged as unknown as PlayerStatOverride] : rest });
  };
  // Live PPR for a player from their current (override-or-base) stat line.
  const computedPPR = (p: SDIOProjection) =>
    Math.round(
      statVal(p, 'PassingYards') * 0.04 + statVal(p, 'PassingTouchdowns') * 4 + statVal(p, 'PassingInterceptions') * -2 +
      statVal(p, 'RushingYards') * 0.1 + statVal(p, 'RushingTouchdowns') * 6 +
      statVal(p, 'Receptions') * 1 + statVal(p, 'ReceivingYards') * 0.1 + statVal(p, 'ReceivingTouchdowns') * 6,
    );
  // True when a stat field has an active absolute override.
  const isStatEdited = (p: SDIOProjection, field: StatField) =>
    (statOf(p.PlayerID) as Record<string, number | undefined> | undefined)?.[field] !== undefined;
  // Clear every override for one player in a single update.
  const clearPlayer = (p: SDIOProjection) =>
    update({
      statOverrides: (scenario.statOverrides ?? []).filter((s) => s.playerId !== p.PlayerID),
      playerAvailability: (scenario.playerAvailability ?? []).filter((a) => a.playerId !== p.PlayerID),
      pointsOverrides: (scenario.pointsOverrides ?? []).filter((o) => o.playerId !== p.PlayerID),
      volumeOverrides: scenario.volumeOverrides.filter((v) => v.playerId !== p.PlayerID),
    });
  const playerEdited = (p: SDIOProjection) =>
    !!statOf(p.PlayerID) || gamesOf(p.PlayerID) < 17 || pprOf(p.PlayerID) !== undefined ||
    scenario.volumeOverrides.some((v) => v.playerId === p.PlayerID);

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

  // --- Presets ---
  const norm = normalizeName ?? defaultNormalize;
  const hasClay = !!clayPpr && clayPpr.size > 0;
  const availablePresets = SCENARIO_PRESETS.filter((p) => !p.requiresClay || hasClay);
  const applyPreset = (id: string) => {
    const preset = SCENARIO_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const next = preset.build(projections, playerMeta ?? new Map(), norm, { clayPpr });
    onChange({ ...next, id: scenario.id, name: preset.name });
  };
  const resetToBase = () => onChange({ ...createEmptyScenario(), id: scenario.id, name: 'New Scenario' });

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
    (scenario.playerAvailability ?? []).length +
    (scenario.pointsOverrides ?? []).length +
    (scenario.statOverrides ?? []).length +
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
      {!embedded && <div className="scenario-overlay" onClick={onClose} />}
      <div className={embedded ? 'scenario-page' : 'scenario-drawer'}>
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
          {!embedded && <button className="chat-close" onClick={onClose}>✕</button>}
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

          {/* Quick presets — one-click opinionated tilts */}
          <div className="scenario-section">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Quick Presets</span>
            </div>
            <p className="scenario-section-hint">
              One click fills the scenario with an opinionated tilt built from the levers below.
              Apply one, then fine-tune any section. Presets replace the current adjustments.
            </p>
            <div className="scenario-preset-grid">
              {availablePresets.map((preset) => (
                <button
                  key={preset.id}
                  className="scenario-preset-btn"
                  onClick={() => applyPreset(preset.id)}
                  title={preset.description}
                >
                  <span className="scenario-preset-name">{preset.name}</span>
                  <span className="scenario-preset-desc">{preset.description}</span>
                </button>
              ))}
            </div>
            <button
              className="scenario-add-btn"
              onClick={resetToBase}
              disabled={isScenarioEmpty(scenario)}
              style={{ marginTop: 8 }}
            >
              ↺ Reset to base
            </button>
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

          {/* Team Workspace — primary interactive by-team editor */}
          <div className="scenario-section scenario-section--primary">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Team Workspace</span>
              {teamDivision[editTeam] && <span className="se-div-label">{teamDivision[editTeam]}</span>}
            </div>
            <p className="scenario-section-hint">
              Cycle teams by division, then <strong>click a number and nudge it with ▲/▼</strong> to
              adjust a player's stat, games, or PPR. Totals update live and flow to the projections.
            </p>

            <div className="scenario-roster-controls">
              <button className="se-cycle" onClick={() => cycleTeam(-1)} aria-label="previous team" title="Previous team">◀</button>
              <select
                className="scenario-select"
                value={editTeam}
                onChange={(e) => { setEditTeam(e.target.value); setEditCell(null); }}
              >
                {NFL_DIVISIONS.map(([div, codes]) => {
                  const present = codes.filter((c) => teams.includes(c));
                  if (!present.length) return null;
                  return (
                    <optgroup key={div} label={div}>
                      {present.map((c) => <option key={c} value={c}>{c}</option>)}
                    </optgroup>
                  );
                })}
              </select>
              <button className="se-cycle" onClick={() => cycleTeam(1)} aria-label="next team" title="Next team">▶</button>
            </div>

            {editTeam && (() => {
              const fmt = (v: number) => (v ? (v >= 1000 ? v.toLocaleString() : String(Math.round(v))) : '');
              const share = (v: number, ref: number) => (ref && v ? `${Math.round((v / ref) * 100)}%` : '');
              // Renders a cell that shows a plain number until clicked, then a
              // value with ▲/▼ arrows to nudge it (no typing).
              const stepCell = (opts: {
                active: boolean; display: string; cls: string; shareTxt?: string;
                onActivate: () => void; onStep: (dir: number) => void;
              }) => {
                if (!opts.active) {
                  return (
                    <td className={opts.cls} onClick={opts.onActivate}>
                      {opts.display}{opts.shareTxt ? <span className="se-share">{opts.shareTxt}</span> : null}
                    </td>
                  );
                }
                return (
                  <td className={`${opts.cls} se-stepping`}>
                    <div className="se-stepper">
                      <span className="se-stepval" onClick={() => setEditCell(null)} title="Done">{opts.display || '0'}</span>
                      <span className="se-steparrows">
                        <button type="button" className="se-arrow" aria-label="increase" onClick={() => opts.onStep(1)}>▲</button>
                        <button type="button" className="se-arrow" aria-label="decrease" onClick={() => opts.onStep(-1)}>▼</button>
                      </span>
                    </div>
                  </td>
                );
              };
              const statTd = (p: SDIOProjection, field: StatField, ref?: number) => {
                const v = statVal(p, field);
                const base = (p as unknown as Record<string, number>)[field] || 0;
                return stepCell({
                  active: editCell?.id === p.PlayerID && editCell.field === field,
                  display: fmt(v),
                  cls: `se-cell se-num ${isStatEdited(p, field) ? 'se-edited' : ''}`,
                  shareTxt: ref ? share(v, ref) : undefined,
                  onActivate: () => setEditCell({ id: p.PlayerID, field }),
                  onStep: (dir) => {
                    const next = Math.max(0, Math.round(v + dir));
                    setStats(p, { [field]: next === base ? undefined : next });
                  },
                });
              };
              const gamesTd = (p: SDIOProjection) => {
                const g = gamesOf(p.PlayerID);
                return stepCell({
                  active: editCell?.id === p.PlayerID && editCell.field === 'games',
                  display: String(g),
                  cls: `se-cell se-num ${g < 17 ? 'se-edited-neg' : ''}`,
                  onActivate: () => setEditCell({ id: p.PlayerID, field: 'games' }),
                  onStep: (dir) => setPlayerGames(p, Math.max(1, Math.min(17, g + dir))),
                });
              };
              const ptsTd = (p: SDIOProjection) => {
                const ov = pprOf(p.PlayerID);
                const v = ov ?? computedPPR(p);
                return stepCell({
                  active: editCell?.id === p.PlayerID && editCell.field === 'ppr',
                  display: String(Math.round(v)),
                  cls: `se-cell se-num se-pts ${ov !== undefined ? 'se-edited' : ''}`,
                  onActivate: () => setEditCell({ id: p.PlayerID, field: 'ppr' }),
                  onStep: (dir) => setPlayerPpr(p, Math.max(0, Math.round(v + dir))),
                });
              };
              const blank = (k: string) => <td key={k} className="se-cell" />;
              const playerRow = (p: SDIOProjection) => {
                const isQB = p.Position === 'QB';
                const hasRush = p.Position !== 'TE';
                return (
                  <tr key={p.PlayerID}>
                    <td className="se-cell se-pos" style={{ color: POS_COLORS[p.Position] }}>{p.Position}</td>
                    <td className="se-cell se-name">
                      {playerEdited(p) && (
                        <button className="se-clear" title="Reset player" onClick={() => clearPlayer(p)}>×</button>
                      )}
                      {p.Name}
                    </td>
                    {gamesTd(p)}
                    {isQB ? statTd(p, 'PassingAttempts') : blank('pa')}
                    {isQB ? statTd(p, 'PassingCompletions') : blank('pc')}
                    {isQB ? statTd(p, 'PassingYards', editPools.passYds) : blank('py')}
                    {isQB ? statTd(p, 'PassingTouchdowns') : blank('pt')}
                    {isQB ? statTd(p, 'PassingInterceptions') : blank('pi')}
                    {hasRush ? statTd(p, 'RushingAttempts', editPools.rushAtt) : blank('ra')}
                    {hasRush ? statTd(p, 'RushingYards') : blank('ry')}
                    {hasRush ? statTd(p, 'RushingTouchdowns') : blank('rt')}
                    {isQB ? blank('rc') : statTd(p, 'Receptions', editPools.rec)}
                    {isQB ? blank('rcy') : statTd(p, 'ReceivingYards', editPools.recYds)}
                    {isQB ? blank('rct') : statTd(p, 'ReceivingTouchdowns')}
                    {ptsTd(p)}
                  </tr>
                );
              };
              // Read-only subtotal / total rows that sum the current (override-or-base) line.
              const sumCol = (rows: SDIOProjection[], f: StatField) => rows.reduce((s, p) => s + statVal(p, f), 0);
              const sumPts = (rows: SDIOProjection[]) => rows.reduce((s, p) => s + (pprOf(p.PlayerID) ?? computedPPR(p)), 0);
              const totalRow = (label: string, rows: SDIOProjection[], cls: string) => (
                <tr className={cls}>
                  <td className="se-cell se-name" colSpan={2}>{label}</td>
                  <td className="se-cell" />
                  {STAT_COLS.map((f) => <td key={f} className="se-cell">{fmt(sumCol(rows, f))}</td>)}
                  <td className="se-cell se-pts">{Math.round(sumPts(rows))}</td>
                </tr>
              );
              const allPlayers = editRoster.flatMap((g) => g.players);
              return (
                <div className="se-table-wrap">
                  <table className="se-table">
                    <thead>
                      <tr className="se-grp-row">
                        <th /><th /><th />
                        <th colSpan={5} style={{ color: POS_COLORS.QB }}>PASSING</th>
                        <th colSpan={3} style={{ color: POS_COLORS.RB }}>RUSHING</th>
                        <th colSpan={3} style={{ color: POS_COLORS.WR }}>RECEIVING</th>
                        <th />
                      </tr>
                      <tr className="se-head-row">
                        <th>Pos</th><th className="se-name">Player</th><th>Gm</th>
                        <th>Att</th><th>Cmp</th><th>Yds</th><th>TD</th><th>Int</th>
                        <th>Att</th><th>Yds</th><th>TD</th>
                        <th>Rec</th><th>Yds</th><th>TD</th>
                        <th>Pts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editRoster.map((g) => (
                        <Fragment key={g.pos}>
                          {g.players.map((p) => playerRow(p))}
                          {g.players.length > 0 && totalRow(`${g.pos} Total`, g.players, 'se-subtotal')}
                        </Fragment>
                      ))}
                      {allPlayers.length > 0 && totalRow('Team Total', allPlayers, 'se-total')}
                    </tbody>
                  </table>
                </div>
              );
            })()}

            {!editTeam && (
              <div className="scenario-section-empty">Select a team to edit its players</div>
            )}
          </div>

          {/* Overall Rankings — scenario-adjusted, top 5 per position (expandable) */}
          {rankings.length > 0 && (
            <div className="scenario-section scenario-section--rankings">
              <div className="scenario-section-header">
                <span className="scenario-section-title">Overall Rankings</span>
              </div>
              <p className="scenario-section-hint">
                Scenario-adjusted PPR — top 5 per position. Expand for the full list; your
                selected team is highlighted.
              </p>
              <div className="se-rank-grid">
                {['QB', 'RB', 'WR', 'TE'].map((pos) => {
                  const list = rankedByPos[pos] ?? [];
                  const expanded = !!expandedPos[pos];
                  const shown = expanded ? list.slice(0, 50) : list.slice(0, 5);
                  return (
                    <div key={pos} className="se-rank-card">
                      <div className="se-rank-head" style={{ color: POS_COLORS[pos] }}>{pos}</div>
                      <ol className="se-rank-list">
                        {shown.map((r, i) => (
                          <li key={`${r.name}-${r.team}`} className={`se-rank-row ${r.team === editTeam ? 'se-rank-mine' : ''}`}>
                            <span className="se-rank-num">{i + 1}</span>
                            <span className="se-rank-name">{r.name}</span>
                            <span className="se-rank-team">{r.team}</span>
                            <span className="se-rank-ppr">{r.ppr}</span>
                          </li>
                        ))}
                      </ol>
                      {list.length > 5 && (
                        <button
                          className="scenario-link-btn"
                          onClick={() => setExpandedPos((s) => ({ ...s, [pos]: !expanded }))}
                        >
                          {expanded ? 'Show top 5' : `Show all ${list.length}`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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
                playerAvailability: [],
                pointsOverrides: [],
                statOverrides: [],
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
