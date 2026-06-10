import { useMemo, useState } from 'react';
import { PlayerName } from './PlayerName';
import type { DraftPrepSettings, Position } from '../lib/draftPrepSettings';
import { startersPerTeam } from '../lib/draftPrepSettings';
import type { KitPlayer, ValuedPlayer } from '../lib/draftKit';
import { KIT_POSITIONS, SEASON_GAMES, valuePool } from '../lib/draftKit';
import { pickNumber, survivalAtPick } from '../lib/snakeDraft';

// Optimal Team Builder — simulates the user's whole draft from their
// seat and shows the roster the value math says they can actually walk
// away with.
//
// At each of the user's picks, the candidate pool is every player with
// ≥50% probability of still being on the board (Gaussian survival on
// market ADP). The sim picks the candidate with the highest *weighted*
// VBD: full weight while he fills an open starting slot (dedicated →
// FLEX → SF), discounted weight (0.45) once he'd ride the bench. Greedy,
// roster-aware, and honest about availability — it will not hand you
// three round-1 RBs.
//
// The same engine then drafts a "chalk" roster — taking the best
// available player strictly by market ADP under the same roster rules —
// and the difference in projected starting-lineup points is your edge
// over the room from value drafting alone.

const BENCH_WEIGHT = 0.45;
const SURVIVAL_FLOOR = 0.5;
const BENCH_SPOTS = 6;
const MAX_ROUNDS = 15;

interface Props {
  pool: KitPlayer[];
  settings: DraftPrepSettings;
}

interface SimPick {
  round: number;
  pickN: number;
  player: ValuedPlayer;
  slot: string;        // QB / RB / WR / TE / FLEX / SF / BN
  survival: number;
  alternates: ValuedPlayer[];
}

interface SimResult {
  picks: SimPick[];
  lineupPts: number;   // projected season points of the optimal starting lineup
}

/** Open-slot bookkeeping for one simulated roster. */
function makeSlots(settings: DraftPrepSettings) {
  return {
    QB: settings.roster.QB, RB: settings.roster.RB, WR: settings.roster.WR, TE: settings.roster.TE,
    FLEX: settings.roster.FLEX, SF: settings.roster.SF,
  };
}

function assignSlot(slots: ReturnType<typeof makeSlots>, pos: Position): string {
  if (slots[pos] > 0) { slots[pos]--; return pos; }
  if (pos !== 'QB' && slots.FLEX > 0) { slots.FLEX--; return 'FLEX'; }
  if (slots.SF > 0) { slots.SF--; return 'SF'; }
  return 'BN';
}

/** Projected season points of the best legal starting lineup of a roster. */
function lineupPoints(roster: ValuedPlayer[], settings: DraftPrepSettings): number {
  const byPos: Record<Position, number[]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const p of roster) byPos[p.position].push(p.ppg);
  for (const pos of KIT_POSITIONS) byPos[pos].sort((a, b) => b - a);
  const idx: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  let pts = 0;
  for (const pos of KIT_POSITIONS) {
    for (let i = 0; i < settings.roster[pos]; i++) {
      const v = byPos[pos][idx[pos]];
      if (v !== undefined) { pts += v; idx[pos]++; }
    }
  }
  const flexFill = (eligible: Position[]) => {
    let bestPos: Position | null = null; let best = -Infinity;
    for (const pos of eligible) {
      const v = byPos[pos][idx[pos]];
      if (v !== undefined && v > best) { best = v; bestPos = pos; }
    }
    if (bestPos) { pts += best; idx[bestPos]++; }
  };
  for (let i = 0; i < settings.roster.FLEX; i++) flexFill(['RB', 'WR', 'TE']);
  for (let i = 0; i < settings.roster.SF; i++) flexFill(['QB', 'RB', 'WR', 'TE']);
  return pts * SEASON_GAMES;
}

function simulate(
  players: ValuedPlayer[],
  settings: DraftPrepSettings,
  rounds: number,
  strategy: 'value' | 'chalk',
): SimResult {
  const taken = new Set<string>();
  const slots = makeSlots(settings);
  const roster: ValuedPlayer[] = [];
  const picks: SimPick[] = [];

  for (let round = 1; round <= rounds; round++) {
    const pickN = pickNumber(round, settings.pickSlot, settings.numTeams, settings.draftType);
    const candidates = players
      .map((p) => ({ p, surv: p.adp >= 999 ? 1 : survivalAtPick(p.adp, p.stdev || undefined, pickN) }))
      .filter((c) => !taken.has(`${c.p.name}:${c.p.position}`) && c.surv >= SURVIVAL_FLOOR);
    if (candidates.length === 0) break;

    const starterOpen = (pos: Position) =>
      slots[pos] > 0 || (pos !== 'QB' && slots.FLEX > 0) || slots.SF > 0;

    const score = (p: ValuedPlayer): number => strategy === 'chalk'
      // Chalk drafts strictly by market price (lowest ADP first), with a
      // soft preference for filling starters before stacking a position
      // five deep — mirrors a default autodraft queue.
      ? -(p.adp + (starterOpen(p.position) ? 0 : settings.numTeams * 1.5))
      : p.vbd * (starterOpen(p.position) ? 1 : BENCH_WEIGHT);

    const ranked = [...candidates].sort((a, b) => score(b.p) - score(a.p));
    const chosen = ranked[0];
    taken.add(`${chosen.p.name}:${chosen.p.position}`);
    roster.push(chosen.p);
    picks.push({
      round,
      pickN,
      player: chosen.p,
      slot: assignSlot(slots, chosen.p.position),
      survival: chosen.surv,
      alternates: ranked.slice(1, 4).map((c) => c.p),
    });
  }
  return { picks, lineupPts: lineupPoints(roster, settings) };
}

export function DraftRosterSim({ pool, settings }: Props) {
  const [open, setOpen] = useState(true);

  const rounds = Math.min(MAX_ROUNDS, startersPerTeam(settings) + BENCH_SPOTS);

  const { mine, chalk } = useMemo(() => {
    if (pool.length === 0) return { mine: null, chalk: null };
    const { players } = valuePool(pool, settings, 'BEER');
    return {
      mine: simulate(players, settings, rounds, 'value'),
      chalk: simulate(players, settings, rounds, 'chalk'),
    };
  }, [pool, settings, rounds]);

  if (!mine || !chalk) return null;
  const edge = mine.lineupPts - chalk.lineupPts;

  return (
    <section style={{ marginTop: 32 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Optimal Team Builder</h2>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          From pick {settings.pickSlot} of {settings.numTeams} · {rounds} rounds · BEER baseline
        </span>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            marginLeft: 'auto', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '3px 10px',
          }}
        >
          {open ? '▾ Hide' : '▸ Show'}
        </button>
      </header>

      <div style={{
        display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12,
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '10px 14px', alignItems: 'baseline',
      }}>
        <Stat label="Optimal lineup" value={`${Math.round(mine.lineupPts)} pts`} />
        <Stat label="ADP-chalk lineup" value={`${Math.round(chalk.lineupPts)} pts`} muted />
        <Stat
          label="Your edge vs the room"
          value={`${edge >= 0 ? '+' : ''}${Math.round(edge)} pts (${(edge / SEASON_GAMES).toFixed(1)} PPG)`}
          color={edge > 0 ? '#22c55e' : '#ef4444'}
        />
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexBasis: '100%' }}>
          Both rosters drafted from your seat under identical availability
          (≥{Math.round(SURVIVAL_FLOOR * 100)}% survival at each pick). Optimal picks by weighted
          VBD with roster awareness; chalk picks best available by market ADP. The gap is what
          value drafting alone is worth from your slot.
        </span>
      </div>

      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 10 }}>
          {mine.picks.map((pk) => <PickCard key={pk.round} pick={pk} />)}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, muted, color }: { label: string; value: string; muted?: boolean; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.4 }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: color ?? (muted ? 'var(--text-muted)' : 'var(--text-primary)') }}>{value}</div>
    </div>
  );
}

function PickCard({ pick }: { pick: SimPick }) {
  const p = pick.player;
  const steal = p.adp < 999 ? pick.pickN - p.adp : NaN;
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 800 }}>R{pick.round}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>pick #{pick.pickN}</span>
        <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 10 }}>{p.position}</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          <PlayerName name={p.name} position={p.position} />
          {p.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
        </span>
        <span style={{
          marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
          background: pick.slot === 'BN' ? 'var(--bg-tertiary)' : '#13343b',
          color: pick.slot === 'BN' ? 'var(--text-muted)' : 'var(--accent, #00d4aa)',
        }}>
          {pick.slot}
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
        {p.ppg.toFixed(1)} PPG · VBD {Math.round(p.vbd)} · ADP {p.adp < 999 ? p.adp.toFixed(0) : '—'}
        {Number.isFinite(steal) && steal > 2 && (
          <span style={{ color: '#22c55e', fontWeight: 700 }}> · {Math.round(steal)} picks past ADP</span>
        )}
        {' '}· {Math.round(pick.survival * 100)}% available
      </div>
      {pick.alternates.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
          Else:{' '}
          {pick.alternates.map((a, i) => (
            <span key={`${a.name}:${a.position}`}>
              {i > 0 && ' · '}
              <PlayerName name={a.name} position={a.position} style={{ color: 'var(--text-secondary)' }} />
              <span> ({a.position}, {Math.round(a.vbd)})</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
