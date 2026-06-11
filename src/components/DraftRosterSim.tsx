import { useMemo, useState } from 'react';
import { PlayerName } from './PlayerName';
import { PlayerAvatar, TeamLogo } from './PlayerAvatar';
import { DocsLink } from './DocsLink';
import { kitKey } from '../lib/draftKit';
import type { DraftPrepSettings, Position } from '../lib/draftPrepSettings';
import { startersPerTeam } from '../lib/draftPrepSettings';
import type { KitPlayer, ValuedPlayer } from '../lib/draftKit';
import { KIT_POSITIONS, SEASON_GAMES, valuePool, openSlots, assignSlot, starterSlotOpen } from '../lib/draftKit';
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
  /** Optional custom board (My Rankings): kitKey -> 1-based rank. Shown
   *  as a "my #N" chip on picks so you can see where the sim's choices
   *  sit on YOUR board — the sim itself optimizes VBD. */
  myRankByKey?: Map<string, number>;
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

type SimStrategy = 'value' | 'chalk' | 'board';

function simulate(
  players: ValuedPlayer[],
  settings: DraftPrepSettings,
  rounds: number,
  strategy: SimStrategy,
  myRankByKey?: Map<string, number>,
): SimResult {
  const taken = new Set<string>();
  const slots = openSlots(settings);
  const roster: ValuedPlayer[] = [];
  const picks: SimPick[] = [];

  for (let round = 1; round <= rounds; round++) {
    const pickN = pickNumber(round, settings.pickSlot, settings.numTeams, settings.draftType);
    const nextPickN = round < rounds
      ? pickNumber(round + 1, settings.pickSlot, settings.numTeams, settings.draftType)
      : null;
    const candidates = players
      .map((p) => ({ p, surv: p.adp >= 999 ? 1 : survivalAtPick(p.adp, p.stdev || undefined, pickN) }))
      .filter((c) => !taken.has(`${c.p.name}:${c.p.position}`) && c.surv >= SURVIVAL_FLOOR);
    if (candidates.length === 0) break;

    const starterOpen = (pos: Position) => starterSlotOpen(slots, pos);

    const score = (p: ValuedPlayer): number => {
      if (strategy === 'chalk') {
        // Chalk drafts strictly by market price (lowest ADP first), with a
        // soft preference for filling starters before stacking a position
        // five deep — mirrors a default autodraft queue.
        return -(p.adp + (starterOpen(p.position) ? 0 : settings.numTeams * 1.5));
      }
      if (strategy === 'board') {
        // Draft by MY board: highest-ranked available player on the
        // user's saved order, with the same soft starters-first nudge
        // (≈1.5 rounds of rank) chalk uses. Players the board doesn't
        // rank come after every ranked player, ordered by VBD.
        const rank = myRankByKey?.get(kitKey(p.name, p.position));
        if (rank !== undefined) {
          return -(rank + (starterOpen(p.position) ? 0 : settings.numTeams * 1.5));
        }
        return -(100_000 - Math.max(p.vbd, -999));
      }
      // Urgency-weighted VBD: discount a candidate by his chance of still
      // being on the board at YOUR NEXT pick. A market discount who will
      // certainly survive another round scores near zero now — wait and
      // take him then — so the sim stops burning early picks on
      // late-round edges (an ADP-159 player at pick 45) while still
      // grabbing genuine edges in their last realistic window. A small
      // pure-value floor (10%) breaks ties toward better players once
      // nothing on the board is urgent (late bench rounds).
      const survNext = nextPickN === null
        ? 0
        : p.adp >= 999 ? 1 : survivalAtPick(p.adp, p.stdev || undefined, nextPickN);
      return p.vbd * (1 - 0.9 * survNext) * (starterOpen(p.position) ? 1 : BENCH_WEIGHT);
    };

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

export function DraftRosterSim({ pool, settings, myRankByKey }: Props) {
  const [open, setOpen] = useState(true);
  const [strategy, setStrategy] = useState<'value' | 'board'>('value');

  const rounds = Math.min(MAX_ROUNDS, startersPerTeam(settings) + BENCH_SPOTS);
  const hasBoard = !!myRankByKey && myRankByKey.size > 0;

  const { mine, chalk, board } = useMemo(() => {
    if (pool.length === 0) return { mine: null, chalk: null, board: null };
    const { players } = valuePool(pool, settings, 'BEER');
    return {
      mine: simulate(players, settings, rounds, 'value'),
      chalk: simulate(players, settings, rounds, 'chalk'),
      board: myRankByKey?.size ? simulate(players, settings, rounds, 'board', myRankByKey) : null,
    };
  }, [pool, settings, rounds, myRankByKey]);

  if (!mine || !chalk) return null;
  const shown = strategy === 'board' && board ? board : mine;
  const edge = mine.lineupPts - chalk.lineupPts;
  const boardDelta = board ? board.lineupPts - mine.lineupPts : NaN;

  return (
    <section style={{ marginTop: 32 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Optimal Team Builder</h2>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          From pick {settings.pickSlot} of {settings.numTeams} · {rounds} rounds · BEER baseline
        </span>
        <DocsLink section="draft-kit" title="Sim methodology + validation — Model Docs" />
        {hasBoard && (
          <span style={{ display: 'flex', gap: 4 }}>
            {(['value', 'board'] as const).map((s) => (
              <button
                key={s}
                className={`pos-filter ${strategy === s ? 'active' : ''}`}
                onClick={() => setStrategy(s)}
                title={s === 'value'
                  ? 'Greedy weighted-VBD picks (the value-optimal roster)'
                  : 'Draft strictly by your saved board order (starters-first nudge; unranked players fall back to VBD)'}
              >
                {s === 'value' ? 'Optimal (VBD)' : 'My board'}
              </button>
            ))}
          </span>
        )}
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
        {board && (
          <Stat
            label="My-board lineup"
            value={`${Math.round(board.lineupPts)} pts (${boardDelta >= 0 ? '+' : ''}${Math.round(boardDelta)} vs optimal)`}
            color={boardDelta >= -10 ? '#22c55e' : boardDelta >= -40 ? '#facc15' : '#ef4444'}
          />
        )}
        <Stat label="ADP-chalk lineup" value={`${Math.round(chalk.lineupPts)} pts`} muted />
        <Stat
          label="Your edge vs the room"
          value={`${edge >= 0 ? '+' : ''}${Math.round(edge)} pts (${(edge / SEASON_GAMES).toFixed(1)} PPG)`}
          color={edge > 0 ? '#22c55e' : '#ef4444'}
        />
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexBasis: '100%' }}>
          All rosters drafted from your seat under identical availability
          (≥{Math.round(SURVIVAL_FLOOR * 100)}% survival at each pick). Optimal picks by urgency-weighted
          VBD with roster awareness; chalk picks best available by market ADP
          {board ? '; My board drafts strictly in your saved order (starters first, unranked → VBD). The "vs optimal" delta is what your rankings cost or gain in projected lineup points' : ''}.
        </span>
      </div>

      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 10 }}>
          {shown.picks.map((pk) => <PickCard key={pk.round} pick={pk} myRankByKey={myRankByKey} />)}
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

function PickCard({ pick, myRankByKey }: { pick: SimPick; myRankByKey?: Map<string, number> }) {
  const p = pick.player;
  const steal = p.adp < 999 ? pick.pickN - p.adp : NaN;
  const myRank = myRankByKey?.get(kitKey(p.name, p.position));
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 800 }}>R{pick.round}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>pick #{pick.pickN}</span>
        <PlayerAvatar name={p.name} position={p.position} size={22} />
        <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 10 }}>{p.position}</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          <PlayerName name={p.name} position={p.position} />
          {p.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
        </span>
        {p.team && <TeamLogo team={p.team} size={14} />}
        {myRank !== undefined && (
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)' }} title="This player's rank on your selected My Rankings board">
            my #{myRank}
          </span>
        )}
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
