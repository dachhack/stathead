import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import type {
  SDIOProjection,
  ScenarioConfig,
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
import { teamLogoUrl } from '../lib/teamLogo';
import { useCrosswalk } from '../hooks/useCrosswalk';
import { lookupByNamePos } from '../lib/playerLookup';
import { setPlayerHash } from '../lib/hashRoute';

interface Props {
  open: boolean;
  onClose?: () => void;
  embedded?: boolean;
  projections: SDIOProjection[];
  freeAgents?: FreeAgentPlayer[];
  playerMeta?: PresetMeta;
  clayPpr?: Map<string, number>;
  clayStats?: Map<string, import('../lib/scenarioPresets').ClayStats>;
  normalizeName?: (s: string) => string;
  scenario: ScenarioConfig;
  onChange: (s: ScenarioConfig) => void;
  rankings?: RankedPlayer[];
  adjusted?: Record<string, Record<string, number>>;
  teamRosters?: Record<string, RosterEntry[]>;
}

interface RankedPlayer { pos: string; name: string; team: string; ppr: number; }
interface RosterEntry { name: string; position: string; jersey: number; yearsExp: number; status: string; }

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

export function ScenarioBuilder({ open, onClose, embedded = false, projections, freeAgents = [], playerMeta, clayPpr, clayStats, normalizeName, scenario, onChange, rankings = [], adjusted = {}, teamRosters = {} }: Props) {
  const [savedList, setSavedList] = useState<ScenarioConfig[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  // Undo/redo stacks — snapshots of the scenario taken around each change.
  // Local to the builder session (cleared on unmount); see commit/undo/redo.
  const historyRef = useRef<ScenarioConfig[]>([]);
  const redoRef = useRef<ScenarioConfig[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Save signals: `autoStatus` mirrors App's debounced draft auto-save;
  // `savedFlash` confirms an explicit Save into the named library.
  const [autoStatus, setAutoStatus] = useState<'idle' | 'pending' | 'saved'>('idle');
  const [savedFlash, setSavedFlash] = useState(false);
  const firstChange = useRef(true);
  useEffect(() => {
    // Skip the initial mount so opening the builder doesn't flash "Saving…".
    if (firstChange.current) { firstChange.current = false; return; }
    setAutoStatus('pending');
    const t = setTimeout(() => setAutoStatus('saved'), 500);
    return () => clearTimeout(t);
  }, [scenario]);

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

  // Crosswalk → clickable player names that open the shareable player detail.
  const { index: cwIndex } = useCrosswalk();
  const playerKeyFor = (name: string, position?: string) =>
    (cwIndex ? lookupByNamePos(cwIndex, name, position ?? null)?.player_key ?? null : null);
  const nameEl = (name: string, position?: string) => {
    const k = playerKeyFor(name, position);
    if (!k) return <>{name}</>;
    return <span className="se-player-link" title="View player detail" onClick={() => setPlayerHash(k)}>{name}</span>;
  };

  // Overall rankings grouped by position (scenario-adjusted, passed from parent).
  const rankedByPos = useMemo(() => {
    const m: Record<string, RankedPlayer[]> = { QB: [], RB: [], WR: [], TE: [] };
    for (const r of rankings) (m[r.pos] ??= []).push(r);
    for (const k of Object.keys(m)) m[k].sort((a, b) => b.ppr - a.ppr);
    return m;
  }, [rankings]);

  // Current team's total PPR change vs. baseline (captures all scenario levers,
  // since `rankings` are the fully scenario-adjusted projections).
  const teamDelta = useMemo(() => {
    if (!editTeam) return 0;
    let adj = 0, base = 0;
    for (const r of rankings) if (r.team === editTeam) adj += r.ppr;
    for (const p of projections) if (p.Team === editTeam) base += p.FantasyPointsPPR || 0;
    return Math.round(adj - base);
  }, [rankings, projections, editTeam]);
  // Only show the delta when the team is actually targeted (avoids tiny model
  // drift on untouched teams from league-wide recompute).
  const teamHasEdits = useMemo(() => {
    if (!editTeam) return false;
    const has = (arr?: { team: string }[]) => (arr ?? []).some((x) => x.team === editTeam);
    return has(scenario.teamTendencies) || has(scenario.teamVolumes) || has(scenario.teamStatAdjustments) ||
      has(scenario.volumeOverrides) || has(scenario.statOverrides) || has(scenario.playerAvailability) || has(scenario.pointsOverrides);
  }, [scenario, editTeam]);

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

  useEffect(() => {
    if (open) setSavedList(loadAllScenarios());
  }, [open]);

  if (!open) return null;

  // Every scenario mutation funnels through `commit`: it snapshots the
  // current scenario onto the undo stack, then applies the change. `undo`
  // restores the last snapshot directly (without re-recording it).
  const commit = (next: ScenarioConfig) => {
    historyRef.current.push(scenario);
    if (historyRef.current.length > 50) historyRef.current.shift();
    redoRef.current = []; // a fresh change invalidates the redo stack
    setCanUndo(true);
    setCanRedo(false);
    onChange(next);
  };
  const undo = () => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    redoRef.current.push(scenario);
    setCanUndo(historyRef.current.length > 0);
    setCanRedo(true);
    onChange(prev);
  };
  const redo = () => {
    const next = redoRef.current.pop();
    if (!next) return;
    historyRef.current.push(scenario);
    setCanUndo(true);
    setCanRedo(redoRef.current.length > 0);
    onChange(next);
  };
  const update = (patch: Partial<ScenarioConfig>) => commit({ ...scenario, ...patch });

  // --- Team tendency / volume actions (upsert; 0 clears) for the current team ---
  const setTeamTendencyFor = (team: string, delta: number) => {
    const rest = scenario.teamTendencies.filter((t) => t.team !== team);
    update({ teamTendencies: delta === 0 ? rest : [...rest, { team, passRatioDelta: delta }] });
  };
  const setTeamVolumeFor = (team: string, delta: number) => {
    const rest = (scenario.teamVolumes ?? []).filter((t) => t.team !== team);
    update({ teamVolumes: delta === 0 ? rest : [...rest, { team, volumeDelta: delta }] });
  };

  // --- Team stat adjustment action (upsert; 0 clears) for the current team ---
  const setTeamStatFor = (team: string, stat: TeamStatKey, delta: number) => {
    const rest = (scenario.teamStatAdjustments ?? []).filter((a) => !(a.team === team && a.stat === stat));
    update({ teamStatAdjustments: delta === 0 ? rest : [...rest, { team, stat, delta }] });
  };

  // --- Roster editor: per-player upsert setters (volume / availability / projection) ---
  // Each looks up the player's current value and writes (or clears) the matching
  // override array entry. Override entries can carry the PlayerID of another
  // surface or an older data load (ids are assigned sequentially per build), so
  // resolve by id OR normalized name + position — matching how the engines
  // apply these overrides. Id-only matching left "phantom" entries that still
  // applied by name but couldn't be seen, edited, or cleared here.
  const norm = normalizeName ?? defaultNormalize;
  const isSame = (e: { playerId: number; playerName?: string; position?: string }, p: SDIOProjection) =>
    e.playerId === p.PlayerID ||
    (!!e.playerName && norm(e.playerName) === norm(p.Name) && (!e.position || e.position === p.Position));
  const gamesOf = (p: SDIOProjection) =>
    (scenario.playerAvailability ?? []).find((a) => isSame(a, p))?.games ?? 17;
  const pprOf = (p: SDIOProjection) =>
    (scenario.pointsOverrides ?? []).find((o) => isSame(o, p))?.ppr;

  const setPlayerGames = (p: SDIOProjection, games: number) => {
    const rest = (scenario.playerAvailability ?? []).filter((a) => !isSame(a, p));
    update({
      playerAvailability: games >= 17 ? rest : [
        ...rest,
        { playerId: p.PlayerID, playerName: p.Name, team: p.Team, position: p.Position, games },
      ],
    });
  };
  const setPlayerPpr = (p: SDIOProjection, ppr: number | undefined) => {
    const rest = (scenario.pointsOverrides ?? []).filter((o) => !isSame(o, p));
    update({
      pointsOverrides: (ppr === undefined || ppr <= 0) ? rest : [
        ...rest,
        { playerId: p.PlayerID, playerName: p.Name, team: p.Team, position: p.Position, ppr: Math.round(ppr) },
      ],
      // Manual stat lines beat PPR pins in the engine, so setting a pin while
      // holding a stat line would be a no-op. Stepping PTS takes PPR control:
      // release the stat line and let the pin scale the base shape.
      statOverrides: (ppr === undefined || ppr <= 0)
        ? scenario.statOverrides
        : (scenario.statOverrides ?? []).filter((s) => !isSame(s, p)),
    });
  };

  // Stat overrides (absolute counting stats). `statOf` returns the current
  // override; `statVal` falls back to the player's base projection; `setStats`
  // merges a patch (undefined clears a field) and drops the entry when empty.
  const STAT_FIELDS = [
    'PassingAttempts', 'PassingCompletions', 'PassingYards', 'PassingTouchdowns', 'PassingInterceptions',
    'RushingAttempts', 'RushingYards', 'RushingTouchdowns', 'Targets', 'Receptions', 'ReceivingYards', 'ReceivingTouchdowns',
  ] as const;
  type StatField = typeof STAT_FIELDS[number];
  const statOf = (p: SDIOProjection) => (scenario.statOverrides ?? []).find((s) => isSame(s, p));
  const statVal = (p: SDIOProjection, field: StatField): number => {
    const o = statOf(p) as Record<string, number | undefined> | undefined;
    const ov = o?.[field];
    return ov !== undefined ? ov : ((p as unknown as Record<string, number>)[field] || 0);
  };
  const setStats = (p: SDIOProjection, patch: Partial<Record<StatField, number | undefined>>) => {
    const rest = (scenario.statOverrides ?? []).filter((s) => !isSame(s, p));
    // A preset (e.g. Consensus / ML Optimized) pins this player to an absolute
    // PPR via a pointsOverride, which re-scales the whole line back to the
    // target and swallows manual nudges. Whenever the user edits a stat under
    // such a pin — including pins from an older draft that coexist with a stat
    // override — bake the current adjusted line into absolute stat overrides
    // and drop the pin, so the line stays put visually but is now directly
    // editable.
    const pinned = pprOf(p) !== undefined;
    const existing: Record<string, number | string | undefined> = pinned
      ? {
          playerId: p.PlayerID, playerName: p.Name, team: p.Team, position: p.Position,
          ...Object.fromEntries(([...STAT_COLS, 'Targets'] as StatField[]).map((f) => [f, Math.round(adjStat(p, f))])),
        }
      : (statOf(p) ?? {
          playerId: p.PlayerID, playerName: p.Name, team: p.Team, position: p.Position,
        }) as unknown as Record<string, number | string | undefined>;
    const merged: Record<string, number | string | undefined> = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    const hasAny = STAT_FIELDS.some((f) => merged[f] !== undefined);
    const next: Partial<ScenarioConfig> = {
      statOverrides: hasAny ? [...rest, merged as unknown as PlayerStatOverride] : rest,
    };
    if (pinned) {
      next.pointsOverrides = (scenario.pointsOverrides ?? []).filter((o) => !isSame(o, p));
    }
    update(next);
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
    (statOf(p) as Record<string, number | undefined> | undefined)?.[field] !== undefined;
  // Clear every override for one player in a single update.
  const clearPlayer = (p: SDIOProjection) =>
    update({
      statOverrides: (scenario.statOverrides ?? []).filter((s) => !isSame(s, p)),
      playerAvailability: (scenario.playerAvailability ?? []).filter((a) => !isSame(a, p)),
      pointsOverrides: (scenario.pointsOverrides ?? []).filter((o) => !isSame(o, p)),
      volumeOverrides: scenario.volumeOverrides.filter((v) => !isSame(v, p)),
    });
  const playerEdited = (p: SDIOProjection) =>
    !!statOf(p) || gamesOf(p) < 17 || pprOf(p) !== undefined ||
    scenario.volumeOverrides.some((v) => isSame(v, p));

  // Fully scenario-adjusted value for display (reflects team tendency/volume/
  // stat reshapes, availability, vegas). Falls back to the raw line if missing.
  const adjLineFor = (p: SDIOProjection) => adjusted[(normalizeName ?? defaultNormalize)(p.Name)];
  const adjStat = (p: SDIOProjection, field: StatField): number => {
    const a = adjLineFor(p);
    return a && a[field] !== undefined ? a[field] : statVal(p, field);
  };
  const adjPts = (p: SDIOProjection): number => {
    const a = adjLineFor(p);
    return a && a.pprPts !== undefined ? a.pprPts : computedPPR(p);
  };

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
  const hasClay = !!clayPpr && clayPpr.size > 0;
  const availablePresets = SCENARIO_PRESETS.filter((p) => !p.requiresClay || hasClay);
  const applyPreset = (id: string) => {
    const preset = SCENARIO_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const next = preset.build(projections, playerMeta ?? new Map(), norm, { clayPpr, clayStats });
    commit({ ...next, id: scenario.id, name: preset.name });
  };
  const resetToBase = () => commit({ ...createEmptyScenario(), id: scenario.id, name: 'New Scenario' });

  // --- Save/load ---
  const handleSave = () => {
    saveScenario(scenario);
    setSavedList(loadAllScenarios());
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  };
  const handleLoad = (s: ScenarioConfig) => {
    commit(s);
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
      // Lean direction, phrased positively as "more of what you leaned toward":
      // right = pass-heavier (≈0.8% pass volume per point), left = run-heavier
      // (1% rush volume per point). "−20% Run" used to mean MORE rushing.
      return delta > 0 ? `+${Math.round(delta * 0.8)}% Pass` : `+${Math.abs(delta)}% Run`;
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
          <div className="se-header-actions">
            {!isScenarioEmpty(scenario) && (
              <span className={`se-autosave se-autosave--${autoStatus === 'pending' ? 'pending' : 'saved'}`}
                title="Your working scenario is auto-saved to this browser and restored on reload">
                {autoStatus === 'pending' ? 'Saving…' : 'Auto-saved ✓'}
              </span>
            )}
            {!embedded && <button className="chat-close" onClick={onClose}>✕</button>}
          </div>
        </div>

        <div className="scenario-body">

          {/* Scenario selector — name/save/load + quick presets in one
              collapsible panel. order:-2 (see CSS) floats it above the
              Team Workspace / Rankings (which use order:-1), so it's the
              very top of the builder. Collapsed by default. */}
          <details className="scenario-section scenario-selector">
            <summary className="scenario-selector-summary">
              <span className="scenario-selector-label">Scenario</span>
              <span className="scenario-selector-current">{scenario.name || 'New Scenario'}</span>
              {activeCount > 0 && (
                <span className="scenario-selector-count">{activeCount} adj</span>
              )}
            </summary>

            <div className="scenario-selector-body">
              {/* Scenario name + save/load */}
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
                {savedFlash && <span className="se-save-flash">Saved ✓</span>}
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

              {/* Quick presets — one-click opinionated tilts */}
              <div className="scenario-section-header" style={{ marginTop: 14 }}>
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
          </details>

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

          {/* Team Workspace — primary interactive by-team editor */}
          <div className="scenario-section scenario-section--primary">
            <div className="scenario-section-header">
              <span className="scenario-section-title">Team Workspace</span>
              <span className="se-header-right">
                {teamDivision[editTeam] && <span className="se-div-label">{teamDivision[editTeam]}</span>}
                {teamHasEdits && teamDelta !== 0 && (
                  <span className={`se-delta ${teamDelta > 0 ? 'pos' : 'neg'}`} title="Team total PPR change vs. baseline (all scenario adjustments)">
                    {teamDelta > 0 ? '▲ +' : '▼ '}{teamDelta} PPR
                  </span>
                )}
              </span>
            </div>
            <p className="scenario-section-hint">
              Cycle teams by division, then <strong>click a number and nudge it with ▲/▼</strong> to
              adjust a player's stat, games, or PPR. Totals update live and flow to the projections.
            </p>

            <div className="scenario-roster-controls">
              {editTeam && <img className="se-team-logo" src={teamLogoUrl(editTeam)} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />}
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

            {/* Team adjustments — Pass/Run + Volume + per-stat sliders, all in one box */}
            {editTeam && (() => {
              const tendency = scenario.teamTendencies.find((t) => t.team === editTeam)?.passRatioDelta ?? 0;
              const teamVol = (scenario.teamVolumes ?? []).find((t) => t.team === editTeam)?.volumeDelta ?? 0;
              const lever = (label: string, value: number, min: number, max: number, onChange: (n: number) => void, kind: 'pass' | 'volume') => (
                <div
                  key={label}
                  className="se-lever"
                  title={kind === 'pass'
                    ? 'Lean the offense. Slide right toward PASS (boosts pass volume ≈0.8%/pt, trims rushing 1%/pt); slide left toward RUN (boosts rush volume 1%/pt, trims passing). Receivers and RB check-downs follow.'
                    : undefined}
                >
                  <span className="se-lever-label">{label}</span>
                  {kind === 'pass' ? (
                    // Endpoint markers so the drag direction is unambiguous:
                    // negative/left = run-lean, positive/right = pass-lean.
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)' }}>RUN</span>
                      <input
                        type="range" min={min} max={max} value={value} className="scenario-slider-inline"
                        onChange={(e) => onChange(Number(e.target.value))}
                      />
                      <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)' }}>PASS</span>
                    </div>
                  ) : (
                    <input
                      type="range" min={min} max={max} value={value} className="scenario-slider-inline"
                      onChange={(e) => onChange(Number(e.target.value))}
                    />
                  )}
                  <span className={`se-lever-val ${value > 0 ? 'positive' : value < 0 ? 'negative' : ''}`}>{deltaLabel(value, kind)}</span>
                </div>
              );
              return (
                <details className="se-statadj" open>
                  <summary>Team adjustments</summary>
                  <div className="se-statadj-group">
                    <div className="se-statadj-grouptitle">Team</div>
                    <div className="se-team-levers">
                      {lever('Run / Pass', tendency, -30, 30, (n) => setTeamTendencyFor(editTeam, n), 'pass')}
                      {lever('Team Volume', teamVol, -50, 50, (n) => setTeamVolumeFor(editTeam, n), 'volume')}
                    </div>
                  </div>
                  {STAT_GROUPS.map((group) => (
                    <div key={group.label} className="se-statadj-group">
                      <div className="se-statadj-grouptitle" style={{ color: group.label === 'Passing' ? POS_COLORS.QB : group.label === 'Rushing' ? POS_COLORS.RB : POS_COLORS.WR }}>{group.label}</div>
                      <div className="se-team-levers">
                        {group.stats.map((stat) => {
                          const d = (scenario.teamStatAdjustments ?? []).find((a) => a.team === editTeam && a.stat === stat)?.delta ?? 0;
                          return lever(STAT_LABELS[stat], d, -50, 50, (n) => setTeamStatFor(editTeam, stat, n), 'volume');
                        })}
                      </div>
                    </div>
                  ))}
                </details>
              );
            })()}

            {editTeam && (() => {
              const fmt = (v: number) => (v ? (v >= 1000 ? v.toLocaleString() : String(Math.round(v))) : '');
              const share = (v: number, ref: number) => (ref && v ? `${Math.round((v / ref) * 100)}%` : '');
              // Share denominators = adjusted team pools, so they stay consistent
              // when team-level reshapes scale everyone.
              const teamPlayers = editRoster.flatMap((g) => g.players);
              const pool = (f: StatField) => teamPlayers.reduce((s, p) => s + adjStat(p, f), 0);
              const poolPassYds = pool('PassingYards');
              const poolRushAtt = pool('RushingAttempts');
              const poolRec = pool('Receptions');
              const poolRecYds = pool('ReceivingYards');
              // Targets aren't scored but ARE an override field; read through
              // adjStat so totals reflect manual target edits on every surface.
              const tgtOf = (p: SDIOProjection) => adjStat(p, 'Targets');
              const poolTgt = teamPlayers.reduce((s, p) => s + tgtOf(p), 0);
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
                // Display the fully-adjusted value (team reshapes etc.); a stepper
                // "takes manual control" from there by writing an absolute override.
                const v = adjStat(p, field);
                const base = (p as unknown as Record<string, number>)[field] || 0;
                return stepCell({
                  active: editCell?.id === p.PlayerID && editCell.field === field,
                  display: fmt(v),
                  cls: `se-cell se-num ${isStatEdited(p, field) ? 'se-edited' : ''}`,
                  shareTxt: ref ? share(v, ref) : undefined,
                  onActivate: () => setEditCell({ id: p.PlayerID, field }),
                  onStep: (dir) => {
                    const next = Math.max(0, Math.round(v + dir));
                    const patch: Partial<Record<StatField, number | undefined>> = { [field]: next === base ? undefined : next };
                    // Volume drivers cascade to their dependents using the player's
                    // ORIGINAL projection rates (catch rate, yds/rec, yds/att), so
                    // repeated steps re-base off the same rate and never drift.
                    const b = (f: StatField) => (p as unknown as Record<string, number>)[f] || 0;
                    if (field === 'Targets') {
                      const baseTgt = b('Targets'), baseRec = b('Receptions'), baseRecYds = b('ReceivingYards');
                      const newRec = baseTgt > 0 ? Math.round(next * (baseRec / baseTgt)) : 0;
                      patch.Receptions = newRec;
                      patch.ReceivingYards = baseRec > 0 ? Math.round(newRec * (baseRecYds / baseRec)) : 0;
                    } else if (field === 'Receptions') {
                      const baseRec = b('Receptions'), baseRecYds = b('ReceivingYards');
                      patch.ReceivingYards = baseRec > 0 ? Math.round(next * (baseRecYds / baseRec)) : 0;
                    } else if (field === 'RushingAttempts') {
                      const baseAtt = b('RushingAttempts'), baseRushYds = b('RushingYards');
                      patch.RushingYards = baseAtt > 0 ? Math.round(next * (baseRushYds / baseAtt)) : 0;
                    }
                    setStats(p, patch);
                  },
                });
              };
              const gamesTd = (p: SDIOProjection) => {
                const g = gamesOf(p);
                return stepCell({
                  active: editCell?.id === p.PlayerID && editCell.field === 'games',
                  display: String(g),
                  cls: `se-cell se-num ${g < 17 ? 'se-edited-neg' : ''}`,
                  onActivate: () => setEditCell({ id: p.PlayerID, field: 'games' }),
                  onStep: (dir) => setPlayerGames(p, Math.max(1, Math.min(17, g + dir))),
                });
              };
              const ptsTd = (p: SDIOProjection) => {
                // A manual stat line beats a PPR pin in the engine, so a pin
                // coexisting with one (older drafts) is inert — show the live line.
                const ov = statOf(p) ? undefined : pprOf(p);
                const v = ov ?? adjPts(p);
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
                      {nameEl(p.Name, p.Position)}
                    </td>
                    {gamesTd(p)}
                    {isQB ? statTd(p, 'PassingAttempts') : blank('pa')}
                    {isQB ? statTd(p, 'PassingCompletions') : blank('pc')}
                    {isQB ? statTd(p, 'PassingYards', poolPassYds) : blank('py')}
                    {isQB ? statTd(p, 'PassingTouchdowns') : blank('pt')}
                    {isQB ? statTd(p, 'PassingInterceptions') : blank('pi')}
                    {hasRush ? statTd(p, 'RushingAttempts', poolRushAtt) : blank('ra')}
                    {hasRush ? statTd(p, 'RushingYards') : blank('ry')}
                    {hasRush ? statTd(p, 'RushingTouchdowns') : blank('rt')}
                    {isQB ? blank('tg') : statTd(p, 'Targets', poolTgt)}
                    {isQB ? blank('rc') : statTd(p, 'Receptions', poolRec)}
                    {isQB ? blank('rcy') : statTd(p, 'ReceivingYards', poolRecYds)}
                    {isQB ? blank('rct') : statTd(p, 'ReceivingTouchdowns')}
                    {ptsTd(p)}
                  </tr>
                );
              };
              // Read-only subtotal / total rows that sum the fully-adjusted line.
              const sumCol = (rows: SDIOProjection[], f: StatField) => rows.reduce((s, p) => s + adjStat(p, f), 0);
              const sumPts = (rows: SDIOProjection[]) => rows.reduce((s, p) => s + ((statOf(p) ? undefined : pprOf(p)) ?? adjPts(p)), 0);
              const sumTgt = (rows: SDIOProjection[]) => rows.reduce((s, p) => s + tgtOf(p), 0);
              const totalRow = (label: string, rows: SDIOProjection[], cls: string) => (
                <tr className={cls}>
                  <td className="se-cell se-name" colSpan={2}>{label}</td>
                  <td className="se-cell" />
                  {STAT_COLS.slice(0, 8).map((f) => <td key={f} className="se-cell">{fmt(sumCol(rows, f))}</td>)}
                  <td className="se-cell">{fmt(sumTgt(rows))}</td>
                  {STAT_COLS.slice(8).map((f) => <td key={f} className="se-cell">{fmt(sumCol(rows, f))}</td>)}
                  <td className="se-cell se-pts">{Math.round(sumPts(rows))}</td>
                </tr>
              );
              // "Δ vs Base" row: how far each team total has moved from the
              // original projection. Sum per-player ROUNDED values on both sides
              // so untouched stats read exactly 0 (no float-summation noise).
              const sumR = (rows: SDIOProjection[], get: (p: SDIOProjection) => number) => rows.reduce((s, p) => s + Math.round(get(p)), 0);
              const baseGet = (f: string) => (p: SDIOProjection) => (p as unknown as Record<string, number>)[f] || 0;
              const dFmt = (d: number) => (d ? (d > 0 ? '+' : '−') + (Math.abs(d) >= 1000 ? Math.abs(d).toLocaleString() : Math.abs(d)) : '');
              const dCell = (cur: number, b: number, key: string, pts = false) => {
                const d = cur - b;
                return <td key={key} className={`se-cell ${pts ? 'se-pts' : ''} ${d > 0 ? 'se-up' : d < 0 ? 'se-down' : ''}`}>{dFmt(d)}</td>;
              };
              const deltaRow = (rows: SDIOProjection[]) => (
                <tr className="se-base-delta">
                  <td className="se-cell se-name" colSpan={2}>Δ vs Base</td>
                  <td className="se-cell" />
                  {STAT_COLS.slice(0, 8).map((f) => dCell(sumR(rows, (p) => adjStat(p, f)), sumR(rows, baseGet(f)), f))}
                  {dCell(sumR(rows, tgtOf), sumR(rows, baseGet('Targets')), 'tgt')}
                  {STAT_COLS.slice(8).map((f) => dCell(sumR(rows, (p) => adjStat(p, f)), sumR(rows, baseGet(f)), f))}
                  {dCell(sumR(rows, (p) => (statOf(p) ? undefined : pprOf(p)) ?? adjPts(p)), sumR(rows, baseGet('FantasyPointsPPR')), 'pts', true)}
                </tr>
              );
              const allPlayers = teamPlayers;
              // ── QB passing ⇄ team receiving consistency ──
              // A team's completions should land in its receivers' hands, but
              // player movements and pinned/edited lines can leave the two
              // sides far apart (e.g. 457 completions vs 242 catches). Flag
              // material gaps and offer one-click rebalances that scale one
              // side proportionally, preserving every player's share.
              const qbRows = allPlayers.filter((p) => p.Position === 'QB');
              const recRows = allPlayers.filter((p) => p.Position !== 'QB');
              const passT = {
                cmp: sumR(qbRows, (p) => adjStat(p, 'PassingCompletions')),
                yds: sumR(qbRows, (p) => adjStat(p, 'PassingYards')),
                td: sumR(qbRows, (p) => adjStat(p, 'PassingTouchdowns')),
              };
              const recT = {
                rec: sumR(recRows, (p) => adjStat(p, 'Receptions')),
                yds: sumR(recRows, (p) => adjStat(p, 'ReceivingYards')),
                td: sumR(recRows, (p) => adjStat(p, 'ReceivingTouchdowns')),
              };
              const gapRec = recT.rec - passT.cmp;
              const gapYds = recT.yds - passT.yds;
              const gapTd = recT.td - passT.td;
              // The table only carries fantasy-relevant players, so a real
              // team naturally shows a small receiving deficit (depth catches
              // aren't listed). Only flag gaps well beyond that.
              const gapMaterial = qbRows.length > 0 && recRows.length > 0 && passT.cmp > 0 && recT.rec > 0 && (
                Math.abs(gapRec) > Math.max(8, passT.cmp * 0.12) ||
                Math.abs(gapYds) > Math.max(80, passT.yds * 0.12) ||
                Math.abs(gapTd) >= 3
              );
              // Bake a player's full adjusted line into an absolute override
              // entry (the same shape setStats writes), then let the caller
              // scale one side of it. Writing the whole line (and dropping any
              // PPR pin) keeps everything else exactly where the user sees it.
              const rebalance = (
                rows: SDIOProjection[],
                adjustLine: (p: SDIOProjection, line: Record<string, number | string>) => void,
              ) => {
                const overrides = (scenario.statOverrides ?? []).filter((s) => !rows.some((p) => isSame(s, p)));
                for (const p of rows) {
                  const line: Record<string, number | string> = {
                    playerId: p.PlayerID, playerName: p.Name, team: p.Team, position: p.Position,
                    ...Object.fromEntries(([...STAT_COLS, 'Targets'] as StatField[]).map((f) => [f, Math.round(adjStat(p, f))])),
                  };
                  adjustLine(p, line);
                  overrides.push(line as unknown as PlayerStatOverride);
                }
                update({
                  statOverrides: overrides,
                  pointsOverrides: (scenario.pointsOverrides ?? []).filter((o) => !rows.some((p) => isSame(o, p))),
                });
              };
              const matchReceivingToPassing = () => {
                const fRec = passT.cmp / recT.rec;
                const fYds = recT.yds > 0 ? passT.yds / recT.yds : fRec;
                const fTd = recT.td > 0 && passT.td > 0 ? passT.td / recT.td : 0;
                const rows = recRows.filter((p) => tgtOf(p) > 0 || adjStat(p, 'Receptions') > 0 || adjStat(p, 'ReceivingYards') > 0);
                rebalance(rows, (p, line) => {
                  line.Targets = Math.round(tgtOf(p) * fRec);
                  line.Receptions = Math.round(adjStat(p, 'Receptions') * fRec);
                  line.ReceivingYards = Math.round(adjStat(p, 'ReceivingYards') * fYds);
                  if (fTd > 0) line.ReceivingTouchdowns = Math.round(adjStat(p, 'ReceivingTouchdowns') * fTd);
                });
              };
              const matchPassingToReceiving = () => {
                const fCmp = recT.rec / passT.cmp;
                const fYds = passT.yds > 0 ? recT.yds / passT.yds : fCmp;
                const fTd = passT.td > 0 && recT.td > 0 ? recT.td / passT.td : 0;
                const rows = qbRows.filter((p) => adjStat(p, 'PassingAttempts') > 0);
                rebalance(rows, (p, line) => {
                  line.PassingAttempts = Math.round(adjStat(p, 'PassingAttempts') * fCmp);
                  line.PassingCompletions = Math.round(adjStat(p, 'PassingCompletions') * fCmp);
                  line.PassingInterceptions = Math.round(adjStat(p, 'PassingInterceptions') * fCmp);
                  line.PassingYards = Math.round(adjStat(p, 'PassingYards') * fYds);
                  if (fTd > 0) line.PassingTouchdowns = Math.round(adjStat(p, 'PassingTouchdowns') * fTd);
                });
              };
              return (
                <div className="se-table-wrap">
                  <table className="se-table">
                    <thead>
                      <tr className="se-grp-row">
                        <th /><th /><th />
                        <th colSpan={5} style={{ color: POS_COLORS.QB }}>PASSING</th>
                        <th colSpan={3} style={{ color: POS_COLORS.RB }}>RUSHING</th>
                        <th colSpan={4} style={{ color: POS_COLORS.WR }}>RECEIVING</th>
                        <th />
                      </tr>
                      <tr className="se-head-row">
                        <th>Pos</th><th className="se-name">Player</th><th>Gm</th>
                        <th>Att</th><th>Cmp</th><th>Yds</th><th>TD</th><th>Int</th>
                        <th>Att</th><th>Yds</th><th>TD</th>
                        <th>Tgt</th><th>Rec</th><th>Yds</th><th>TD</th>
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
                      {allPlayers.length > 0 && deltaRow(allPlayers)}
                    </tbody>
                  </table>
                  {gapMaterial && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      margin: '6px 2px 2px', padding: '6px 10px', fontSize: 11,
                      background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
                      borderRadius: 6, color: 'var(--text-secondary)',
                    }}>
                      <span title="A team's completions should land in its receivers' hands. Player movements and pinned/edited lines can leave QB passing and team receiving out of sync.">
                        <b style={{ color: '#f59e0b' }}>QB passing ≠ team receiving:</b>{' '}
                        {recT.rec.toLocaleString()} rec vs {passT.cmp.toLocaleString()} cmp ({dFmt(gapRec) || '0'}) ·{' '}
                        {recT.yds.toLocaleString()} vs {passT.yds.toLocaleString()} yds ({dFmt(gapYds) || '0'}) ·{' '}
                        {recT.td} vs {passT.td} TD ({dFmt(gapTd) || '0'})
                      </span>
                      <button
                        className="scenario-action-btn" style={{ fontSize: 11 }}
                        onClick={matchReceivingToPassing}
                        title="Scale every receiver's targets / catches / yards / TDs proportionally so team receiving matches QB passing"
                      >
                        Scale receiving to match
                      </button>
                      <button
                        className="scenario-action-btn" style={{ fontSize: 11 }}
                        onClick={matchPassingToReceiving}
                        title="Scale QB attempts / completions / yards / TDs proportionally so QB passing matches team receiving"
                      >
                        Scale passing to match
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {!editTeam && (
              <div className="scenario-section-empty">Select a team to edit its players</div>
            )}

            {/* Collapsible full current roster for the selected team (reference) */}
            {editTeam && (teamRosters[editTeam]?.length ?? 0) > 0 && (() => {
              const ORDER = ['QB', 'RB', 'FB', 'WR', 'TE', 'K', 'P', 'LS'];
              const ord = (pos: string) => { const i = ORDER.indexOf(pos); return i < 0 ? 50 : i; };
              const roster = [...teamRosters[editTeam]].sort((a, b) => ord(a.position) - ord(b.position) || a.name.localeCompare(b.name));
              return (
                <details className="se-roster">
                  <summary>Current roster — {editTeam} ({roster.length})</summary>
                  <div className="se-roster-list">
                    {roster.map((r, i) => (
                      <div key={`${r.name}-${i}`} className="se-roster-row">
                        <span className="se-roster-pos" style={{ color: POS_COLORS[r.position] || 'var(--text-muted)' }}>{r.position || '—'}</span>
                        <span className="se-roster-name">{nameEl(r.name, r.position)}</span>
                        <span className="se-roster-meta">
                          {r.jersey ? `#${r.jersey}` : ''}{r.yearsExp === 0 ? ' · R' : r.yearsExp > 0 ? ` · ${r.yearsExp}y` : ''}
                          {r.status && !/^act/i.test(r.status) ? ` · ${r.status}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              );
            })()}
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
                            <span className="se-rank-name">{nameEl(r.name, r.pos)}</span>
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
            onClick={undo}
            disabled={!canUndo}
            title="Undo the last change"
          >
            ↶ Undo
          </button>
          <button
            className="scenario-clear-btn"
            onClick={redo}
            disabled={!canRedo}
            title="Redo the last undone change"
          >
            ↷ Redo
          </button>
          <button
            className="scenario-clear-btn"
            onClick={() =>
              commit({
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
