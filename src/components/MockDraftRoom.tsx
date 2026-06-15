import { useEffect, useMemo, useRef, useState } from 'react';
import { PlayerName } from './PlayerName';
import { PlayerAvatar, TeamLogo } from './PlayerAvatar';
import { DocsLink } from './DocsLink';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import { startersPerTeam } from '../lib/draftPrepSettings';
import type { KitPlayer, ValuedPlayer } from '../lib/draftKit';
import { kitKey, roundPick, starterSlotOpen, valuePool } from '../lib/draftKit';
import { userPickNumbers, survivalAtPick } from '../lib/snakeDraft';
import type { Grade, MockTeam, OpponentProfile, PickContext, PickReview, TeamGrade } from '../lib/mockDraft';
import {
  GOAL_INFO, GOAL_OPTIONS, STYLE_INFO, STYLE_OPTIONS,
  applyPick, chooseCpuPick, choosePlanPick, gradeTeams, lineupPoints, makeTeams,
  randomOpponents, rankPlanCandidates, reviewUserPicks, sampleCpuDelayMs, slotForOverall,
} from '../lib/mockDraft';
import type { Position } from '../lib/draftPrepSettings';

// Mock Draft room — practice a full draft against a configurable room
// of CPU opponents.
//
// League shape (size, your slot, snake/linear, roster, scoring) comes
// from the LEAGUE bar like every other Draft Kit section. Here you
// configure the ROOM: each opponent's draft style + positional goal,
// how many rounds, the mode, and your pick timer.
//
// Two modes:
//   Simulate — every pick is automatic; your seat drafts by your plan
//              (your selected My Rankings board when one is active,
//              else urgency-weighted VBD).
//   I pick   — the draft pauses on your turn; pick from the plan-ranked
//              best-available list (or search anyone). Your optional
//              timer autopicks from your plan when it hits zero.
//
// Only YOUR turn is timed. CPU picks take 1–7 seconds each, normally
// distributed around 4s (sampleCpuDelayMs) — or compressed by the speed
// setting when you don't want to sit through a real-time room.

type Phase = 'setup' | 'live' | 'done';
type Mode = 'sim' | 'manual';
type Speed = 'real' | 'fast' | 'instant';

const POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE'];
const TIMER_OPTIONS = [0, 15, 30, 60, 90, 120] as const;
const SPEED_INFO: Record<Speed, { label: string; blurb: string }> = {
  real: { label: 'Real time', blurb: 'CPU picks take 1–7s each (normal around 4s) — draft-room pacing.' },
  fast: { label: 'Fast', blurb: 'Same 1–7s distribution compressed ÷8.' },
  instant: { label: 'Instant', blurb: 'CPU picks land immediately.' },
};
const CONFIG_KEY = 'mock-draft-config';
// In-progress (or finished) draft, persisted so it survives the component
// unmounting — e.g. when opening a player card, which swaps the whole tab
// content for the PlayerDetail page. Restored on remount.
const DRAFT_KEY = 'mock-draft-state';

interface MockPick {
  overall: number;
  round: number;
  teamSlot: number;
  player: ValuedPlayer;
  rosterSlot: string;
}

interface RoomConfig {
  mode: Mode;
  timerSec: number;
  rounds: number;
  speed: Speed;
}

// Everything needed to reconstruct a live/done draft. The engine refs
// (teams, taken set, player pool) aren't stored — they're rebuilt by
// replaying picks against a fresh value pool on restore.
interface SavedDraft {
  phase: 'live' | 'done';
  picks: MockPick[];
  opponents: OpponentProfile[];
  config: RoomConfig;
  settings: DraftPrepSettings;
  userTurn: boolean;
  paused: boolean;
  secondsLeft: number | null;
  onClockSlot: number | null;
}

function loadDraft(): SavedDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SavedDraft>;
    if ((p.phase !== 'live' && p.phase !== 'done') || !Array.isArray(p.picks)
      || !Array.isArray(p.opponents) || !p.config || !p.settings) return null;
    return p as SavedDraft;
  } catch { return null; }
}

function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* quota */ }
}

function loadConfig(defaultRounds: number): RoomConfig {
  const dflt: RoomConfig = { mode: 'manual', timerSec: 60, rounds: defaultRounds, speed: 'real' };
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return dflt;
    const p = JSON.parse(raw) as Partial<RoomConfig>;
    return {
      mode: p.mode === 'sim' ? 'sim' : 'manual',
      timerSec: TIMER_OPTIONS.includes(p.timerSec as typeof TIMER_OPTIONS[number]) ? (p.timerSec as number) : 60,
      rounds: Number.isFinite(p.rounds) ? Math.max(8, Math.min(16, p.rounds as number)) : defaultRounds,
      speed: p.speed === 'fast' || p.speed === 'instant' ? p.speed : 'real',
    };
  } catch { return dflt; }
}

function shortName(name: string): string {
  const parts = name.split(' ');
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

interface Props {
  pool: KitPlayer[];
  settings: DraftPrepSettings;
  /** Selected My Rankings board: kitKey -> 1-based rank. When present it
   *  IS the plan — autopicks and the best-available order follow it. */
  myRankByKey?: Map<string, number>;
  myBoardName?: string;
}

export function MockDraftRoom({ pool, settings, myRankByKey, myBoardName }: Props) {
  const defaultRounds = Math.max(8, Math.min(16, startersPerTeam(settings) + 6));
  const [config, setConfig] = useState<RoomConfig>(() => loadConfig(defaultRounds));
  const [opponents, setOpponents] = useState<OpponentProfile[]>(() => randomOpponents(settings.numTeams - 1));
  const [phase, setPhase] = useState<Phase>('setup');
  const [picks, setPicks] = useState<MockPick[]>([]);
  const [userTurn, setUserTurn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [onClockSlot, setOnClockSlot] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [availFilter, setAvailFilter] = useState<'ALL' | Position>('ALL');

  // Engine state lives in refs — timeout callbacks always read current
  // data, never a stale render's.
  const cfgRef = useRef<{ config: RoomConfig; settings: DraftPrepSettings; myRankByKey?: Map<string, number> } | null>(null);
  const teamsRef = useRef<MockTeam[]>([]);
  const playersRef = useRef<ValuedPlayer[]>([]);
  const takenRef = useRef<Set<string>>(new Set());
  const picksRef = useRef<MockPick[]>([]);
  const pausedRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  const restoredRef = useRef(false);

  const updateConfig = (next: Partial<RoomConfig>) => {
    setConfig((prev) => {
      const merged = { ...prev, ...next };
      try { localStorage.setItem(CONFIG_KEY, JSON.stringify(merged)); } catch { /* quota */ }
      return merged;
    });
  };

  // Keep the opponent list sized to the league while configuring.
  useEffect(() => {
    if (phase !== 'setup') return;
    setOpponents((prev) => {
      const want = settings.numTeams - 1;
      if (prev.length === want) return prev;
      if (prev.length > want) return prev.slice(0, want);
      return [...prev, ...randomOpponents(want - prev.length)];
    });
  }, [settings.numTeams, phase]);

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

  // Restore an in-progress (or finished) draft after a remount — e.g.
  // returning from a player card. Waits for the player pool to load, then
  // rebuilds the engine by replaying the saved picks against a fresh value
  // pool, and resumes the clock (CPU timer or the user's turn).
  useEffect(() => {
    if (restoredRef.current || pool.length === 0) return;
    restoredRef.current = true;
    const saved = loadDraft();
    if (!saved) return;

    const { players } = valuePool(pool, saved.settings, 'BEER');
    const byKey = new Map(players.map((p) => [kitKey(p.name, p.position), p]));
    const teams = makeTeams(saved.settings, saved.opponents);
    const taken = new Set<string>();
    const restoredPicks: MockPick[] = saved.picks.map((pk) => {
      const key = kitKey(pk.player.name, pk.player.position);
      const player = byKey.get(key) ?? pk.player;
      applyPick(teams[pk.teamSlot - 1], player);
      taken.add(key);
      return { ...pk, player };
    });

    playersRef.current = players;
    teamsRef.current = teams;
    takenRef.current = taken;
    picksRef.current = restoredPicks;
    pausedRef.current = saved.paused;
    cfgRef.current = {
      config: saved.config,
      settings: saved.settings,
      myRankByKey: myRankByKey?.size ? myRankByKey : undefined,
    };

    setOpponents(saved.opponents);
    setConfig(saved.config);
    setPicks(restoredPicks);
    setPaused(saved.paused);
    setPhase(saved.phase);

    if (saved.phase === 'live') {
      const overall = restoredPicks.length + 1;
      const slot = slotForOverall(overall, saved.settings.numTeams, saved.settings.draftType);
      const onClockTeam = teams[slot - 1];
      if (onClockTeam.isUser && saved.config.mode === 'manual') {
        setOnClockSlot(slot);
        setUserTurn(true);
        setSecondsLeft(saved.config.timerSec > 0 ? saved.secondsLeft ?? saved.config.timerSec : null);
      } else if (saved.paused) {
        setOnClockSlot(slot);
      } else {
        advance(overall);
      }
    }
    // Run once the pool is ready; advance/refs are stable via closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool]);

  const clearPending = () => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  const ctxFor = (overall: number): PickContext => {
    const cfg = cfgRef.current!;
    return {
      round: Math.ceil(overall / cfg.settings.numTeams),
      overall,
      totalRounds: cfg.config.rounds,
      settings: cfg.settings,
    };
  };

  const finish = () => {
    clearPending();
    setUserTurn(false);
    setSecondsLeft(null);
    setOnClockSlot(null);
    setPhase('done');
  };

  const commit = (team: MockTeam, player: ValuedPlayer, overall: number) => {
    takenRef.current.add(kitKey(player.name, player.position));
    const cfg = cfgRef.current!;
    const rosterSlot = applyPick(team, player);
    const pick: MockPick = {
      overall,
      round: Math.ceil(overall / cfg.settings.numTeams),
      teamSlot: team.slot,
      player,
      rosterSlot,
    };
    picksRef.current = [...picksRef.current, pick];
    setPicks(picksRef.current);
    setUserTurn(false);
    setSecondsLeft(null);
    advance(overall + 1);
  };

  const autoPick = (overall: number) => {
    const cfg = cfgRef.current;
    if (!cfg || pausedRef.current) return;
    const slot = slotForOverall(overall, cfg.settings.numTeams, cfg.settings.draftType);
    const team = teamsRef.current[slot - 1];
    const available = playersRef.current.filter((p) => !takenRef.current.has(kitKey(p.name, p.position)));
    const ctx = ctxFor(overall);
    const player = team.isUser
      ? choosePlanPick(available, team, ctx, cfg.myRankByKey)
      : chooseCpuPick(available, team, ctx);
    if (!player) { finish(); return; }
    commit(team, player, overall);
  };

  const advance = (overall: number) => {
    const cfg = cfgRef.current;
    if (!cfg) return;
    if (overall > cfg.config.rounds * cfg.settings.numTeams) { finish(); return; }
    const slot = slotForOverall(overall, cfg.settings.numTeams, cfg.settings.draftType);
    setOnClockSlot(slot);
    const team = teamsRef.current[slot - 1];
    if (team.isUser && cfg.config.mode === 'manual') {
      // Only the user's turn is timed — everyone else is on the sampler.
      setUserTurn(true);
      setSecondsLeft(cfg.config.timerSec > 0 ? cfg.config.timerSec : null);
      return;
    }
    const delay = cfg.config.speed === 'instant'
      ? 30
      : Math.round(sampleCpuDelayMs() / (cfg.config.speed === 'fast' ? 8 : 1));
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      autoPick(overall);
    }, delay);
  };

  const start = () => {
    if (pool.length === 0) return;
    const { players } = valuePool(pool, settings, 'BEER');
    playersRef.current = players;
    teamsRef.current = makeTeams(settings, opponents);
    takenRef.current = new Set();
    picksRef.current = [];
    pausedRef.current = false;
    cfgRef.current = { config, settings, myRankByKey: myRankByKey?.size ? myRankByKey : undefined };
    setPicks([]);
    setPaused(false);
    setUserTurn(false);
    setSearch('');
    setPhase('live');
    advance(1);
  };

  const abort = () => {
    clearPending();
    clearDraft();
    pausedRef.current = false;
    setPaused(false);
    setUserTurn(false);
    setSecondsLeft(null);
    setOnClockSlot(null);
    setPhase('setup');
  };

  const pause = () => {
    pausedRef.current = true;
    setPaused(true);
    clearPending();
  };

  const resume = () => {
    pausedRef.current = false;
    setPaused(false);
    if (!userTurn) advance(picksRef.current.length + 1);
    // On the user's turn the countdown effect resumes by itself.
  };

  // User-turn countdown — autopicks from the plan at zero.
  useEffect(() => {
    if (phase !== 'live' || !userTurn || paused || secondsLeft === null) return;
    if (secondsLeft <= 0) { autoPick(picksRef.current.length + 1); return; }
    const id = window.setTimeout(() => setSecondsLeft((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, userTurn, paused, secondsLeft]);

  // Persist the live/done draft on every meaningful change so it survives
  // a remount. Setup is never persisted; abort clears it explicitly.
  useEffect(() => {
    if (phase === 'setup' || !cfgRef.current) return;
    const saved: SavedDraft = {
      phase,
      picks,
      opponents,
      config: cfgRef.current.config,
      settings: cfgRef.current.settings,
      userTurn,
      paused,
      secondsLeft,
      onClockSlot,
    };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(saved)); } catch { /* quota */ }
  }, [phase, picks, opponents, userTurn, paused, secondsLeft, onClockSlot]);

  const draftPlayer = (p: ValuedPlayer) => {
    if (phase !== 'live' || !userTurn || paused) return;
    const cfg = cfgRef.current!;
    const overall = picksRef.current.length + 1;
    const slot = slotForOverall(overall, cfg.settings.numTeams, cfg.settings.draftType);
    const team = teamsRef.current[slot - 1];
    if (!team.isUser) return;
    setSearch('');
    commit(team, p, overall);
  };

  // ── Derived view state ──
  const liveSettings = phase === 'setup' ? settings : cfgRef.current?.settings ?? settings;
  const N = liveSettings.numTeams;
  const totalPicks = (phase === 'setup' ? config.rounds : cfgRef.current?.config.rounds ?? config.rounds) * N;
  const currentOverall = picks.length + 1;
  const onClockTeam = onClockSlot !== null ? teamsRef.current[onClockSlot - 1] : null;
  const userTeam = teamsRef.current.find((t) => t.isUser) ?? null;
  const roundsTotal = cfgRef.current?.config.rounds ?? config.rounds;
  const mode = cfgRef.current?.config.mode ?? config.mode;
  const timerSec = cfgRef.current?.config.timerSec ?? config.timerSec;
  const planByKey = cfgRef.current?.myRankByKey;

  const available = useMemo(() => {
    if (phase === 'setup') return [];
    return playersRef.current.filter((p) => !takenRef.current.has(kitKey(p.name, p.position)));
    // takenRef mutates with picks — picks is the render trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, picks]);

  const planRanked = useMemo(() => {
    if (phase !== 'live' || !userTeam || available.length === 0) return [];
    return rankPlanCandidates(available, userTeam, ctxFor(currentOverall), cfgRef.current?.myRankByKey);
  }, [phase, available, currentOverall, userTeam]);

  const myNextPickN = useMemo(() => {
    if (phase === 'setup') return null;
    const cfg = cfgRef.current;
    if (!cfg) return null;
    const nums = userPickNumbers(cfg.config.rounds, cfg.settings.pickSlot, cfg.settings.numTeams, cfg.settings.draftType);
    return nums.find((n) => n >= currentOverall) ?? null;
  }, [phase, currentOverall]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return available.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [search, available]);

  // Position rank within the still-available pool (RB5 = 5th-best RB left)
  // and per-position counts for the filter chips.
  const { posRankByKey, availCounts } = useMemo(() => {
    const rank = new Map<string, number>();
    const counts: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const pos of POSITIONS) {
      const list = available.filter((p) => p.position === pos).sort((a, b) => b.vbd - a.vbd);
      counts[pos] = list.length;
      list.forEach((p, i) => rank.set(kitKey(p.name, p.position), i + 1));
    }
    return { posRankByKey: rank, availCounts: counts };
  }, [available]);

  // P(player is still on the board when the user picks AGAIN) — the
  // "wait vs take now" signal. Always measured against the user's next
  // pick strictly after the current one.
  const pickAfterCurrent = useMemo(() => {
    if (phase === 'setup') return null;
    return userPickNumbers(roundsTotal, liveSettings.pickSlot, N, liveSettings.draftType)
      .find((n) => n > currentOverall) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, currentOverall]);
  const survivalToNext = (p: ValuedPlayer): number => {
    if (pickAfterCurrent === null) return NaN;
    if (p.adp >= 999) return 1;
    return survivalAtPick(Math.max(p.adp, currentOverall), p.stdev || undefined, pickAfterCurrent);
  };

  // Live roster-build summary for the user's seat: how many of each
  // starting slot are filled, what's still needed, bench depth, and the
  // projected points of the best lineup drafted so far.
  const rosterBuild = useMemo(() => {
    if (!userTeam) return null;
    const req = liveSettings.roster;
    const open = userTeam.open;
    const filledDed: Record<Position, number> = {
      QB: req.QB - open.QB, RB: req.RB - open.RB, WR: req.WR - open.WR, TE: req.TE - open.TE,
    };
    const benchCount = picks.filter((p) => p.teamSlot === userTeam.slot && p.rosterSlot === 'BN').length;
    const startersReq = startersPerTeam(liveSettings);
    const startersOpen = open.QB + open.RB + open.WR + open.TE + open.FLEX + open.SF;
    const needs: string[] = [];
    for (const pos of POSITIONS) if (open[pos] > 0) needs.push(`${pos}×${open[pos]}`);
    if (open.FLEX > 0) needs.push(`FLEX×${open.FLEX}`);
    if (open.SF > 0) needs.push(`SF×${open.SF}`);
    return {
      filledDed, req, open, benchCount, startersReq, startersOpen, needs,
      startingPts: lineupPoints(userTeam.players, liveSettings),
    };
  }, [userTeam, picks, liveSettings]);

  const filteredPlan = availFilter === 'ALL'
    ? planRanked
    : planRanked.filter((p) => p.position === availFilter);

  const pill: React.CSSProperties = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)', fontFamily: 'inherit',
  };
  const btn: React.CSSProperties = { ...pill, cursor: 'pointer', fontWeight: 700, background: 'var(--bg-tertiary)' };
  const card: React.CSSProperties = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
  };

  // ── Setup ──
  if (phase === 'setup') {
    return (
      <section>
        <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Mock Draft</h2>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {N}-team {liveSettings.draftType} · you pick {liveSettings.pickSlot} · {liveSettings.scoring}
            {' '}— league shape comes from the LEAGUE bar above
          </span>
          <DocsLink section="draft-kit" title="Plan + VBD methodology — Model Docs" />
        </header>

        <div style={{ ...card, marginBottom: 12, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }} title="Simulate runs every pick automatically (your seat drafts by your plan); I pick pauses on your turn.">
            Mode
            <select style={pill} value={config.mode} onChange={(e) => updateConfig({ mode: e.target.value as Mode })}>
              <option value="manual">I make my picks</option>
              <option value="sim">Simulate everything</option>
            </select>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: config.mode === 'sim' ? 0.5 : 1 }}
            title="Your pick clock — only YOUR turn is timed. At zero, the plan autopicks for you. CPU teams always take 1–7s.">
            Your timer
            <select style={pill} value={config.timerSec} disabled={config.mode === 'sim'}
              onChange={(e) => updateConfig({ timerSec: Number(e.target.value) })}>
              {TIMER_OPTIONS.map((t) => <option key={t} value={t}>{t === 0 ? 'Off' : `${t}s`}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }} title="Total draft rounds (starters + bench).">
            Rounds
            <select style={pill} value={config.rounds} onChange={(e) => updateConfig({ rounds: Number(e.target.value) })}>
              {Array.from({ length: 9 }, (_, i) => i + 8).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }} title={SPEED_INFO[config.speed].blurb}>
            CPU speed
            <select style={pill} value={config.speed} onChange={(e) => updateConfig({ speed: e.target.value as Speed })}>
              {(Object.keys(SPEED_INFO) as Speed[]).map((s) => <option key={s} value={s} title={SPEED_INFO[s].blurb}>{SPEED_INFO[s].label}</option>)}
            </select>
          </label>
          <button
            style={{ ...btn, marginLeft: 'auto', fontSize: 13, padding: '6px 18px', color: 'var(--accent, #00d4aa)' }}
            disabled={pool.length === 0}
            onClick={start}
            title={pool.length === 0 ? 'Player pool still loading…' : 'Start the mock draft'}
          >
            ▶ Start draft
          </button>
        </div>

        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 800 }}>The room</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Each opponent drafts with a style (how it orders the board) and a goal (its positional plan).
              All of them fill starters first and respect position caps.
            </span>
            <button style={{ ...btn, fontSize: 10, marginLeft: 'auto' }} onClick={() => setOpponents(randomOpponents(N - 1))}>
              🎲 Randomize room
            </button>
            <button style={{ ...btn, fontSize: 10 }}
              onClick={() => setOpponents(Array.from({ length: N - 1 }, () => ({ style: 'chalk' as const, goal: 'balanced' as const })))}
              title="Everyone drafts ADP/balanced — the most predictable room">
              All chalk
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 6 }}>
            {Array.from({ length: N }, (_, i) => i + 1).map((slot) => {
              if (slot === liveSettings.pickSlot) {
                return (
                  <div key={slot} style={{
                    display: 'flex', gap: 8, alignItems: 'center', padding: '5px 8px',
                    border: '1px solid var(--accent, #00d4aa)', borderRadius: 6, background: 'var(--bg-tertiary)',
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 800, minWidth: 44 }}>#{slot}</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent, #00d4aa)' }}>YOU</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {myRankByKey?.size ? `plan: ${myBoardName ?? 'my board'}` : 'plan: urgency-weighted VBD'}
                    </span>
                  </div>
                );
              }
              const oppIdx = slot < liveSettings.pickSlot ? slot - 1 : slot - 2;
              const opp = opponents[oppIdx] ?? { style: 'chalk' as const, goal: 'balanced' as const };
              const setOpp = (next: Partial<OpponentProfile>) => {
                setOpponents((prev) => prev.map((o, i) => (i === oppIdx ? { ...o, ...next } : o)));
              };
              return (
                <div key={slot} style={{
                  display: 'flex', gap: 6, alignItems: 'center', padding: '5px 8px',
                  border: '1px solid var(--border)', borderRadius: 6,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 800, minWidth: 44 }}>#{slot}</span>
                  <select style={{ ...pill, fontSize: 11, padding: '2px 4px' }} value={opp.style}
                    title={STYLE_INFO[opp.style].blurb}
                    onChange={(e) => setOpp({ style: e.target.value as OpponentProfile['style'] })}>
                    {STYLE_OPTIONS.map((s) => <option key={s} value={s} title={STYLE_INFO[s].blurb}>{STYLE_INFO[s].label}</option>)}
                  </select>
                  <select style={{ ...pill, fontSize: 11, padding: '2px 4px', flex: 1 }} value={opp.goal}
                    title={GOAL_INFO[opp.goal].blurb}
                    onChange={(e) => setOpp({ goal: e.target.value as OpponentProfile['goal'] })}>
                    {GOAL_OPTIONS.map((g) => <option key={g} value={g} title={GOAL_INFO[g].blurb}>{GOAL_INFO[g].label}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          Your seat drafts by your plan: the selected My Rankings board when one is active
          (set it in the board picker above), otherwise the plan sim's urgency-weighted VBD.
          In "I make my picks" mode that plan ranks the best-available list and takes over if your timer expires.
        </div>
      </section>
    );
  }

  // ── Live + done share the board/roster rendering ──
  const pickBySlotRound = new Map<string, MockPick>();
  for (const p of picks) pickBySlotRound.set(`${p.round}:${p.teamSlot}`, p);

  const gradesBySlot = phase === 'done'
    ? new Map(gradeTeams(teamsRef.current, liveSettings).map((g) => [g.slot, g]))
    : new Map<number, TeamGrade>();

  const standings = phase === 'done'
    ? teamsRef.current
      .map((t) => ({ team: t, pts: lineupPoints(t.players, liveSettings), vbd: t.players.reduce((s, p) => s + p.vbd, 0), grade: gradesBySlot.get(t.slot) }))
      .sort((a, b) => b.pts - a.pts)
    : [];

  const userGrade = userTeam ? gradesBySlot.get(userTeam.slot) : undefined;
  const userReview: PickReview[] = phase === 'done' && userTeam
    ? reviewUserPicks(picks, playersRef.current, liveSettings, userTeam.slot, roundsTotal)
    : [];
  const upgrades = userReview.filter((r) => r.isUpgrade).sort((a, b) => b.gain - a.gain);

  return (
    <section>
      {/* Status strip */}
      <div style={{
        display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
        ...card, marginBottom: 12,
      }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>Mock Draft</span>
        {phase === 'live' ? (
          <>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Pick <strong>{currentOverall}</strong> of {totalPicks} ({roundPick(currentOverall, N)})
            </span>
            {onClockTeam && (
              <span style={{ fontSize: 12, fontWeight: 700, color: onClockTeam.isUser ? 'var(--accent, #00d4aa)' : 'var(--text-primary)' }}>
                {onClockTeam.isUser ? '⏰ YOU ARE ON THE CLOCK' : `${onClockTeam.name} is on the clock…`}
              </span>
            )}
            {!userTurn && onClockTeam && !onClockTeam.isUser && !paused && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>thinking</span>
            )}
            {myNextPickN !== null && !userTurn && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                your next: #{myNextPickN} ({myNextPickN - currentOverall} away)
              </span>
            )}
            {userTurn && secondsLeft !== null && (
              <span style={{
                fontSize: 14, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                color: secondsLeft <= 10 ? '#ef4444' : secondsLeft <= 20 ? '#facc15' : 'var(--accent, #00d4aa)',
              }}>
                {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
              </span>
            )}
            {userTurn && secondsLeft === null && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>no clock — take your time</span>
            )}
            <button style={{ ...btn, marginLeft: 'auto', fontSize: 11 }} onClick={paused ? resume : pause}>
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button style={{ ...btn, fontSize: 11 }} onClick={abort} title="Abandon this mock and go back to setup">
              ✕ Abort
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Draft complete — {picks.length} picks</span>
            <button style={{ ...btn, marginLeft: 'auto', fontSize: 11, color: 'var(--accent, #00d4aa)' }} onClick={start}>
              ↺ Draft again (same room)
            </button>
            <button style={{ ...btn, fontSize: 11 }} onClick={abort}>⚙ New setup</button>
          </>
        )}
      </div>

      {/* Timer bar */}
      {phase === 'live' && userTurn && secondsLeft !== null && timerSec > 0 && (
        <div style={{ height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, marginBottom: 12, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${(secondsLeft / timerSec) * 100}%`,
            background: secondsLeft <= 10 ? '#ef4444' : 'var(--accent, #00d4aa)',
            transition: 'width 1s linear',
          }} />
        </div>
      )}

      {/* Standings (done) */}
      {phase === 'done' && (
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Projected standings</div>
          {standings.map((s, i) => (
            <div key={s.team.slot} style={{
              display: 'flex', gap: 10, alignItems: 'baseline', padding: '3px 6px',
              borderRadius: 4, background: s.team.isUser ? 'var(--bg-tertiary)' : 'transparent',
              border: s.team.isUser ? '1px solid var(--accent, #00d4aa)' : '1px solid transparent',
            }}>
              <span style={{ fontSize: 11, fontWeight: 800, minWidth: 22 }}>{i + 1}.</span>
              <span style={{ fontSize: 12, fontWeight: s.team.isUser ? 800 : 600, minWidth: 64, color: s.team.isUser ? 'var(--accent, #00d4aa)' : 'var(--text-primary)' }}>
                {s.team.name}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 140 }}>
                {s.team.profile ? `${STYLE_INFO[s.team.profile.style].label} · ${GOAL_INFO[s.team.profile.goal].label}` : (planByKey ? `your board: ${myBoardName ?? ''}` : 'your plan')}
              </span>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{Math.round(s.pts)} pts</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>lineup · VBD {Math.round(s.vbd)}</span>
              {s.grade && <GradeChip grade={s.grade.overallGrade} size={11} title={`Overall: stronger starting lineup than ${Math.round(s.grade.overallPct)}% of the room`} />}
            </div>
          ))}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
            Projected season points of each roster's best legal starting lineup. Bench depth shows in the VBD total.
            Grade = starting-lineup strength percentile within this room.
          </div>
        </div>
      )}

      {/* Your draft report card (done) */}
      {phase === 'done' && userGrade && (
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>Your draft report card</span>
            <GradeChip grade={userGrade.overallGrade} size={20} title="" />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {Math.round(userGrade.total)} starting pts · stronger than {Math.round(userGrade.overallPct)}% of the room · VBD depth {Math.round(userGrade.vbdTotal)}
            </span>
          </div>
          {/* Position strength bars */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 4 }}>
            {(['QB', 'RB', 'WR', 'TE'] as Position[]).map((pos) => {
              const pg = userGrade.byPos[pos];
              return (
                <div key={pos} style={{ background: 'var(--bg-tertiary)', borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                    <span className={`pos-badge pos-${pos}`} style={{ fontSize: 10 }}>{pos}</span>
                    <GradeChip grade={pg.grade} size={12} title="" />
                    <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)' }}>{Math.round(pg.pct)}</span>
                  </div>
                  <div style={{ height: 5, background: 'var(--bg-secondary)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.max(3, pg.pct)}%`, background: gradeColor(pg.grade) }} />
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>
                    {Math.round(pg.value)} starting pts
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
            Each position scores 0–100 by how its starters (flex players counted at their own position)
            rank against the other {liveSettings.numTeams - 1} teams. The bar is that percentile.
          </div>
        </div>
      )}

      {/* Board review — better moves than you made (done) */}
      {phase === 'done' && userTeam && (
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            Board review
            <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>
              the value pick on the board at each of your picks vs what you took
            </span>
          </div>
          {upgrades.length === 0 ? (
            <div style={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>
              ✓ Clean draft — every pick was the best value on the board (or within a rounding error of it).
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                {upgrades.length} pick{upgrades.length > 1 ? 's' : ''} where a stronger value move was available:
              </div>
              {upgrades.slice(0, 8).map((r) => (
                <div key={r.overall} style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0',
                  borderTop: '1px solid var(--border)',
                }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', minWidth: 56, paddingTop: 2 }}>
                    {roundPick(r.overall, N)}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ color: 'var(--text-muted)' }}>You took</span>
                      <span className={`pos-badge pos-${r.actual.position}`} style={{ fontSize: 9 }}>{r.actual.position}</span>
                      <PlayerName name={r.actual.name} position={r.actual.position} />
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(VBD {Math.round(r.actual.vbd)})</span>
                      <span style={{ color: 'var(--text-muted)' }}>→ better:</span>
                      <span className={`pos-badge pos-${r.best.position}`} style={{ fontSize: 9 }}>{r.best.position}</span>
                      <span style={{ fontWeight: 700, color: 'var(--accent, #00d4aa)' }}>
                        <PlayerName name={r.best.name} position={r.best.position} />
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(VBD {Math.round(r.best.vbd)})</span>
                      {r.vbdDelta > 0 && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#22c55e' }}>+{Math.round(r.vbdDelta)} value</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      {reviewReason(r)}
                    </div>
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>
                “Better” = higher urgency-weighted VBD on the board at that exact pick — value over your
                roster's replacement level, discounted by each player's chance of lasting to your next pick.
                It never flags a player who'd already be gone, or one you could simply have waited a round for.
              </div>
            </>
          )}
        </div>
      )}

      {/* Live panels */}
      {phase === 'live' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(380px, 3fr) minmax(260px, 2fr)', gap: 12, alignItems: 'start', marginBottom: 12 }}>
          {/* Best available (plan-ranked) */}
          <div style={card}>
            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6, display: 'flex', gap: 8, alignItems: 'baseline' }}>
              Best available — your plan
              <span style={{ fontSize: 9, fontWeight: 400, color: 'var(--text-muted)' }}>
                {planByKey ? `board: ${myBoardName ?? 'My Rankings'}` : 'urgency-weighted VBD'}
              </span>
            </div>
            {mode === 'manual' && (
              <div style={{ position: 'relative', marginBottom: 6 }}>
                <input
                  style={{ ...pill, width: 240 }}
                  placeholder="Search any player…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {searchResults.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, zIndex: 50, marginTop: 2,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6,
                    minWidth: 320, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                  }}>
                    {searchResults.map((p) => (
                      <div key={`${p.name}:${p.position}`} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 10px', borderBottom: '1px solid var(--border)' }}>
                        <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 9 }}>{p.position}</span>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>VBD {Math.round(p.vbd)} · ADP {p.adp < 999 ? p.adp.toFixed(0) : '—'}</span>
                        <button
                          style={{ ...btn, marginLeft: 'auto', fontSize: 10, padding: '2px 8px', color: 'var(--accent, #00d4aa)', opacity: userTurn && !paused ? 1 : 0.4 }}
                          disabled={!userTurn || paused}
                          onClick={() => draftPlayer(p)}
                        >
                          Draft
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Position filter chips */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
              {(['ALL', ...POSITIONS] as const).map((f) => {
                const count = f === 'ALL'
                  ? availCounts.QB + availCounts.RB + availCounts.WR + availCounts.TE
                  : availCounts[f];
                const need = f !== 'ALL' && userTeam ? starterSlotOpen(userTeam.open, f) : false;
                return (
                  <button
                    key={f}
                    onClick={() => setAvailFilter(f)}
                    className={`pos-filter ${availFilter === f ? 'active' : ''}`}
                    style={{
                      fontSize: 10, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                      fontWeight: 700, whiteSpace: 'nowrap',
                      background: availFilter === f ? 'var(--accent, #00d4aa)' : 'var(--bg-tertiary)',
                      color: availFilter === f ? '#06251f' : 'var(--text-secondary)',
                      border: `1px solid ${need ? 'var(--accent, #00d4aa)' : 'var(--border)'}`,
                    }}
                    title={need ? `${f} — open starting slot` : f === 'ALL' ? 'All positions' : f}
                  >
                    {f}{f !== 'ALL' && <span style={{ opacity: 0.7 }}> {count}</span>}
                    {need && availFilter !== f && <span style={{ color: 'var(--accent, #00d4aa)' }}> •</span>}
                  </button>
                );
              })}
            </div>
            {filteredPlan.slice(0, 12).map((p, i) => {
              const boardRank = planByKey?.get(kitKey(p.name, p.position));
              const posRank = posRankByKey.get(kitKey(p.name, p.position));
              const fillsStarter = userTeam ? starterSlotOpen(userTeam.open, p.position) : false;
              const surv = survivalToNext(p);
              return (
                <div key={`${p.name}:${p.position}`} style={{
                  display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: i === 0 && availFilter === 'ALL' ? 'var(--accent, #00d4aa)' : 'var(--text-muted)', minWidth: 18, textAlign: 'right' }}>
                    {i === 0 && availFilter === 'ALL' ? '★' : i + 1}
                  </span>
                  <PlayerAvatar name={p.name} position={p.position} size={20} />
                  <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 9 }}>
                    {p.position}{posRank ? posRank : ''}
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <PlayerName name={p.name} position={p.position} />
                      {p.team && <TeamLogo team={p.team} size={13} />}
                      {p.isRookie && <span style={{ fontSize: 9, color: '#6366f1' }}>R</span>}
                      {fillsStarter && <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--accent, #00d4aa)', border: '1px solid var(--accent, #00d4aa)', borderRadius: 6, padding: '0 4px' }}>NEED</span>}
                      {boardRank !== undefined && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#93c5fd' }}>you #{boardRank}</span>
                      )}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {p.ppg.toFixed(1)} PPG · T{p.tier}
                      {Number.isFinite(p.adpDeltaRounds) && Math.abs(p.adpDeltaRounds) >= 0.75 && (
                        <span style={{ color: p.adpDeltaRounds > 0 ? '#22c55e' : '#fb923c' }}>
                          {' '}· {p.adpDeltaRounds > 0 ? 'value' : 'reach'} {Math.abs(p.adpDeltaRounds).toFixed(1)}r
                        </span>
                      )}
                    </span>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 56 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>VBD {Math.round(p.vbd)}</span>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{p.adp < 999 ? `ADP ${p.adp.toFixed(0)}` : 'free'}</span>
                  </span>
                  {Number.isFinite(surv) && pickAfterCurrent !== null && (
                    <span
                      style={{
                        fontSize: 9, fontWeight: 700, minWidth: 54, textAlign: 'right',
                        color: surv >= 0.6 ? '#22c55e' : surv >= 0.3 ? '#facc15' : '#ef4444',
                      }}
                      title={`${Math.round(surv * 100)}% chance he's still there at your next pick (#${pickAfterCurrent})`}
                    >
                      {surv >= 0.6 ? `wait ${Math.round(surv * 100)}%` : surv >= 0.3 ? `${Math.round(surv * 100)}%` : 'take now'}
                    </span>
                  )}
                  {mode === 'manual' && (
                    <button
                      style={{ ...btn, fontSize: 10, padding: '2px 10px', color: 'var(--accent, #00d4aa)', opacity: userTurn && !paused ? 1 : 0.35 }}
                      disabled={!userTurn || paused}
                      onClick={() => draftPlayer(p)}
                      title={userTurn ? `Draft ${p.name}` : 'Wait for your turn'}
                    >
                      Draft
                    </button>
                  )}
                </div>
              );
            })}
            {filteredPlan.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: '6px 0' }}>
                No {availFilter} left on the board.
              </div>
            )}
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
              {mode === 'sim'
                ? 'Simulation mode — your seat autopicks the ★ row when your turn comes up. '
                : ''}
              NEED = fills one of your open starting slots · “wait %” = chance he lasts to your next pick.
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Roster build — needs + construction as the draft moves */}
          {rosterBuild && (
            <div style={card}>
              <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8, display: 'flex', gap: 8, alignItems: 'baseline' }}>
                Roster build
                <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>
                  {rosterBuild.startersReq - rosterBuild.startersOpen}/{rosterBuild.startersReq} starters · {rosterBuild.benchCount} bench
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: 'var(--accent, #00d4aa)' }}>
                  ~{Math.round(rosterBuild.startingPts)} pts
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                {POSITIONS.map((pos) => {
                  const filled = rosterBuild.filledDed[pos];
                  const req = rosterBuild.req[pos];
                  const met = filled >= req;
                  const open = rosterBuild.open[pos] > 0;
                  return (
                    <span key={pos} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700,
                      padding: '2px 8px', borderRadius: 10,
                      background: 'var(--bg-tertiary)',
                      border: `1px solid ${open ? 'var(--accent, #00d4aa)' : 'var(--border)'}`,
                      color: met ? '#22c55e' : open ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}>
                      <span className={`pos-badge pos-${pos}`} style={{ fontSize: 8 }}>{pos}</span>
                      {filled}/{req}
                      {met && req > 0 && ' ✓'}
                    </span>
                  );
                })}
                {(rosterBuild.req.FLEX > 0) && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'var(--bg-tertiary)',
                    border: `1px solid ${rosterBuild.open.FLEX > 0 ? 'var(--accent, #00d4aa)' : 'var(--border)'}`,
                    color: rosterBuild.open.FLEX > 0 ? 'var(--text-primary)' : '#22c55e',
                  }}>
                    FLEX {rosterBuild.req.FLEX - rosterBuild.open.FLEX}/{rosterBuild.req.FLEX}
                  </span>
                )}
                {(rosterBuild.req.SF > 0) && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'var(--bg-tertiary)',
                    border: `1px solid ${rosterBuild.open.SF > 0 ? 'var(--accent, #00d4aa)' : 'var(--border)'}`,
                    color: rosterBuild.open.SF > 0 ? 'var(--text-primary)' : '#22c55e',
                  }}>
                    SF {rosterBuild.req.SF - rosterBuild.open.SF}/{rosterBuild.req.SF}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {rosterBuild.needs.length > 0
                  ? <>Still need: <strong style={{ color: 'var(--text-secondary)' }}>{rosterBuild.needs.join(' · ')}</strong></>
                  : <span style={{ color: '#22c55e' }}>Starting lineup complete — drafting bench depth.</span>}
              </div>
            </div>
          )}

          {/* My roster */}
          <div style={card}>
            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
              My roster ({userTeam?.players.length ?? 0})
            </div>
            {userTeam && userTeam.players.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No picks yet.</div>
            )}
            {picks.filter((p) => p.teamSlot === userTeam?.slot).map((p) => (
              <div key={p.overall} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 36 }}>{roundPick(p.overall, N)}</span>
                <PlayerAvatar name={p.player.name} position={p.player.position} size={18} />
                <span className={`pos-badge pos-${p.player.position}`} style={{ fontSize: 9 }}>{p.player.position}</span>
                <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>
                  <PlayerName name={p.player.name} position={p.player.position} />
                </span>
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                  background: p.rosterSlot === 'BN' ? 'var(--bg-tertiary)' : '#13343b',
                  color: p.rosterSlot === 'BN' ? 'var(--text-muted)' : 'var(--accent, #00d4aa)',
                }}>
                  {p.rosterSlot}
                </span>
              </div>
            ))}
          </div>
          </div>
        </div>
      )}

      {/* Draft board */}
      <div style={{ ...card, overflowX: 'auto', marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Draft board</div>
        <table style={{ borderCollapse: 'collapse', fontSize: 10, minWidth: N * 104 }}>
          <thead>
            <tr>
              <th style={{ padding: '2px 6px', color: 'var(--text-muted)', fontWeight: 700, textAlign: 'left' }}>Rd</th>
              {teamsRef.current.map((t) => (
                <th key={t.slot} style={{
                  padding: '2px 6px', fontWeight: 800, textAlign: 'left', whiteSpace: 'nowrap',
                  color: t.isUser ? 'var(--accent, #00d4aa)' : 'var(--text-secondary)',
                }}
                  title={t.profile ? `${STYLE_INFO[t.profile.style].label} · ${GOAL_INFO[t.profile.goal].label}` : 'You'}
                >
                  {t.isUser ? 'YOU' : `T${t.slot}`}
                  {t.profile && (
                    <div style={{ fontSize: 8, fontWeight: 400, color: 'var(--text-muted)' }}>
                      {STYLE_INFO[t.profile.style].label}·{GOAL_INFO[t.profile.goal].label}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: roundsTotal }, (_, r) => r + 1).map((round) => (
              <tr key={round}>
                <td style={{ padding: '2px 6px', color: 'var(--text-muted)', fontWeight: 700 }}>{round}</td>
                {teamsRef.current.map((t) => {
                  const pk = pickBySlotRound.get(`${round}:${t.slot}`);
                  const isOnClock = phase === 'live' && onClockSlot === t.slot && Math.ceil(currentOverall / N) === round && !pk;
                  return (
                    <td key={t.slot} style={{
                      padding: '2px 6px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap',
                      background: isOnClock ? 'var(--bg-tertiary)' : t.isUser ? 'rgba(0,212,170,0.05)' : 'transparent',
                      outline: isOnClock ? '1px solid var(--accent, #00d4aa)' : 'none',
                    }}>
                      {pk ? (
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          title={`#${pk.overall} ${pk.player.name} (${pk.player.position}) — VBD ${Math.round(pk.player.vbd)}, ADP ${pk.player.adp < 999 ? pk.player.adp.toFixed(0) : '—'}`}
                        >
                          <PlayerAvatar name={pk.player.name} position={pk.player.position} size={16} />
                          <span style={{ color: 'var(--text-muted)' }}>{pk.overall}</span>
                          <span className={`pos-badge pos-${pk.player.position}`} style={{ fontSize: 8, padding: '0 3px' }}>{pk.player.position}</span>
                          <span style={{ fontWeight: 600 }}>{shortName(pk.player.name)}</span>
                        </span>
                      ) : isOnClock ? (
                        <span style={{ color: 'var(--accent, #00d4aa)', fontWeight: 700 }}>⏱</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* All rosters (done) */}
      {phase === 'done' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          {standings.map(({ team, pts }) => (
            <div key={team.slot} style={{ ...card, border: team.isUser ? '1px solid var(--accent, #00d4aa)' : '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 4, display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span style={{ color: team.isUser ? 'var(--accent, #00d4aa)' : 'var(--text-primary)' }}>{team.name}</span>
                <span style={{ fontSize: 9, fontWeight: 400, color: 'var(--text-muted)' }}>
                  {team.profile ? `${STYLE_INFO[team.profile.style].label} · ${GOAL_INFO[team.profile.goal].label}` : 'your plan'} · {Math.round(pts)} pts
                </span>
              </div>
              {picks.filter((p) => p.teamSlot === team.slot).map((p) => (
                <div key={p.overall} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '1px 0', fontSize: 11 }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 32 }}>{roundPick(p.overall, N)}</span>
                  <PlayerAvatar name={p.player.name} position={p.player.position} size={16} />
                  <span className={`pos-badge pos-${p.player.position}`} style={{ fontSize: 8 }}>{p.player.position}</span>
                  <span style={{ fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <PlayerName name={p.player.name} position={p.player.position} />
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{p.rosterSlot}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Recent picks ticker */}
      {phase === 'live' && picks.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-secondary)' }}>Recent:</strong>{' '}
          {[...picks].slice(-8).reverse().map((p, i) => {
            const t = teamsRef.current[p.teamSlot - 1];
            return (
              <span key={p.overall}>
                {i > 0 && ' · '}
                #{p.overall} {shortName(p.player.name)} ({p.player.position})
                {t?.isUser ? ' ✓you' : ''}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Grade rendering helpers ──

function gradeColor(grade: Grade): string {
  const c = grade.charAt(0);
  if (c === 'A') return '#22c55e';
  if (c === 'B') return '#a3e635';
  if (c === 'C') return '#facc15';
  if (c === 'D') return '#fb923c';
  return '#ef4444';
}

function GradeChip({ grade, size, title }: { grade: Grade; size: number; title: string }) {
  const color = gradeColor(grade);
  return (
    <span
      title={title || undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size, fontWeight: 800, lineHeight: 1,
        padding: size >= 18 ? '5px 9px' : '2px 6px', borderRadius: 6,
        color, background: `${color}1f`, border: `1px solid ${color}55`,
        fontVariantNumeric: 'tabular-nums', minWidth: size >= 18 ? 34 : undefined,
      }}
    >
      {grade}
    </span>
  );
}

/** Human reasoning for why the review flagged a better move. */
function reviewReason(r: PickReview): string {
  const firstName = (n: string) => n.split(' ')[0];
  const parts: string[] = [];
  if (r.fillsStarterGap) {
    parts.push(`${firstName(r.best.name)} filled an open starting spot while ${firstName(r.actual.name)} was bench depth`);
  } else if (r.posShift) {
    parts.push(`${r.best.position} was the stronger value than ${r.actual.position} here`);
  } else {
    parts.push(`${firstName(r.best.name)} carried more value at the same spot`);
  }
  if (r.actualWouldSurvive && r.nextPick !== null) {
    parts.push(`${firstName(r.actual.name)} likely would've made it back to your next pick (#${r.nextPick})`);
  }
  return parts.join('; ') + '.';
}
