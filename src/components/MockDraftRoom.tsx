import { useEffect, useMemo, useRef, useState } from 'react';
import { PlayerName } from './PlayerName';
import { PlayerAvatar, TeamLogo } from './PlayerAvatar';
import { DocsLink } from './DocsLink';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import { startersPerTeam } from '../lib/draftPrepSettings';
import type { KitPlayer, ValuedPlayer } from '../lib/draftKit';
import { kitKey, roundPick, valuePool } from '../lib/draftKit';
import { userPickNumbers } from '../lib/snakeDraft';
import type { MockTeam, OpponentProfile, PickContext } from '../lib/mockDraft';
import {
  GOAL_INFO, GOAL_OPTIONS, STYLE_INFO, STYLE_OPTIONS,
  applyPick, chooseCpuPick, choosePlanPick, lineupPoints, makeTeams,
  randomOpponents, rankPlanCandidates, sampleCpuDelayMs, slotForOverall,
} from '../lib/mockDraft';

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

const TIMER_OPTIONS = [0, 15, 30, 60, 90, 120] as const;
const SPEED_INFO: Record<Speed, { label: string; blurb: string }> = {
  real: { label: 'Real time', blurb: 'CPU picks take 1–7s each (normal around 4s) — draft-room pacing.' },
  fast: { label: 'Fast', blurb: 'Same 1–7s distribution compressed ÷8.' },
  instant: { label: 'Instant', blurb: 'CPU picks land immediately.' },
};
const CONFIG_KEY = 'mock-draft-config';

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

  // Engine state lives in refs — timeout callbacks always read current
  // data, never a stale render's.
  const cfgRef = useRef<{ config: RoomConfig; settings: DraftPrepSettings; myRankByKey?: Map<string, number> } | null>(null);
  const teamsRef = useRef<MockTeam[]>([]);
  const playersRef = useRef<ValuedPlayer[]>([]);
  const takenRef = useRef<Set<string>>(new Set());
  const picksRef = useRef<MockPick[]>([]);
  const pausedRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);

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
  const roundsTotal = cfgRef.current?.config.rounds ?? config.rounds;
  const mode = cfgRef.current?.config.mode ?? config.mode;
  const timerSec = cfgRef.current?.config.timerSec ?? config.timerSec;
  const planByKey = cfgRef.current?.myRankByKey;

  const standings = phase === 'done'
    ? teamsRef.current
      .map((t) => ({ team: t, pts: lineupPoints(t.players, liveSettings), vbd: t.players.reduce((s, p) => s + p.vbd, 0) }))
      .sort((a, b) => b.pts - a.pts)
    : [];

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
            </div>
          ))}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
            Projected season points of each roster's best legal starting lineup. Bench depth shows in the VBD total.
          </div>
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
            {planRanked.slice(0, 10).map((p, i) => {
              const boardRank = planByKey?.get(kitKey(p.name, p.position));
              return (
                <div key={`${p.name}:${p.position}`} style={{
                  display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: i === 0 ? 'var(--accent, #00d4aa)' : 'var(--text-muted)', minWidth: 18, textAlign: 'right' }}>
                    {i === 0 ? '★' : i + 1}
                  </span>
                  <PlayerAvatar name={p.name} position={p.position} size={20} />
                  <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 9 }}>{p.position}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5, flex: 1 }}>
                    <PlayerName name={p.name} position={p.position} />
                    {p.team && <TeamLogo team={p.team} size={13} />}
                    {p.isRookie && <span style={{ fontSize: 9, color: '#6366f1' }}>R</span>}
                    {boardRank !== undefined && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: '#93c5fd' }}>you #{boardRank}</span>
                    )}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>VBD {Math.round(p.vbd)}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 52, textAlign: 'right' }}>
                    {p.adp < 999 ? `ADP ${p.adp.toFixed(0)}` : 'free'}
                  </span>
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
            {mode === 'sim' && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                Simulation mode — your seat autopicks the ★ row when your turn comes up.
              </div>
            )}
          </div>

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
            {userTeam && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                Open: {(Object.entries(userTeam.open) as Array<[string, number]>)
                  .filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(' ') || 'starters full — bench mode'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Draft board */}
      <div style={{ ...card, overflowX: 'auto', marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Draft board</div>
        <table style={{ borderCollapse: 'collapse', fontSize: 10, minWidth: N * 86 }}>
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
                        <span title={`#${pk.overall} ${pk.player.name} (${pk.player.position}) — VBD ${Math.round(pk.player.vbd)}, ADP ${pk.player.adp < 999 ? pk.player.adp.toFixed(0) : '—'}`}>
                          <span style={{ color: 'var(--text-muted)' }}>{pk.overall}</span>{' '}
                          <span className={`pos-badge pos-${pk.player.position}`} style={{ fontSize: 8, padding: '0 3px' }}>{pk.player.position}</span>{' '}
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
