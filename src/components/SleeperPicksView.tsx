import { useEffect, useMemo, useState } from 'react';
import { PlayerName } from './PlayerName';
import { useIsMobile } from '../hooks/useIsMobile';

/**
 * Research > Sleeper Picks: this week's pick lines StatHead leaned on, how each
 * was priced, and the graded record that validates the model.
 *
 * Reads public/data/pick-board-<season>.json (scripts/build-pick-board.py).
 * The lines are Sleeper Picks' (third-party input, shown by owner decision
 * 2026-11-01); Sleeper's payouts and pick shares are not in the file.
 */

interface BoardPick {
  week: number;
  player: string;
  gsis?: string;
  pos: string;
  team: string;
  stat: string;
  line: number;
  lean: 'over' | 'under';
  pLean: number;
  pRaw?: number;
  edge: number;
  proj?: number;
  median?: number;
  matchup?: number;
  flags?: string[];
  tag?: string;
  recordedAt?: string;
  lineNow?: number;
  lineMove?: number;
  void?: string;
  kickoff?: string;
  opp?: string;
  home?: boolean;
  actual?: number | null;
  hit?: boolean | null;
  push?: boolean;
  note?: string;
  /** This week's pick with a box score but not yet officially graded. */
  provisional?: boolean;
}

interface Summary {
  n: number;
  hits: number;
  hitRate: number;
  expectedHitRate?: number;
  rawExpectedHitRate?: number;
  return?: number;
  roi?: number;
}

interface Board {
  season: number;
  generatedAt: string;
  week: number;
  playedThrough: number;
  statLabels: Record<string, string>;
  method: { calShrink?: number; minEdge?: number; draws?: number };
  picks: BoardPick[];
  graded: BoardPick[];
  /** This week's unofficial record over the picks whose games are final. */
  thisWeek?: { n: number; hits: number; hitRate: number; expectedHitRate: number; calls: number; callHits: number } | null;
  validation: {
    overall: Summary | null;
    byConfidence: Record<string, Summary>;
    byWeek: Record<string, Summary>;
    byTag: Record<string, Summary>;
    byStat: Record<string, Summary>;
    byMove: Record<string, Summary>;
    flagged: Summary | null;
    unflagged: Summary | null;
    voided: number;
    pending: number;
  };
}

type Section = 'picks' | 'research' | 'validation';
type SortKey = 'kickoff' | 'chance' | 'edge' | 'result' | 'player';
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'kickoff', label: 'Kickoff' },
  { id: 'chance', label: 'Chance to hit' },
  { id: 'edge', label: 'Edge' },
  { id: 'result', label: 'Result' },
  { id: 'player', label: 'Player' },
];
// Result order: hits, pushes, misses, did-not-play / void, then not final.
const resultRank = (p: BoardPick) =>
  p.hit === true ? 0 : p.push ? 1 : p.hit === false ? 2 : p.void || p.actual === null ? 3 : 4;
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'picks', label: 'This week' },
  { id: 'research', label: 'Research' },
  { id: 'validation', label: 'Validation' },
];

const GREEN = '#10b981';
const RED = '#ef4444';
const AMBER = '#f59e0b';

const pct = (x?: number | null, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const signedPct = (x?: number | null) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const num = (x?: number | null) => (x == null ? '—' : Number.isInteger(x) ? String(x) : x.toFixed(1));

function kickoffLabel(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // NFL kickoffs read in Eastern time, wherever the viewer is.
  return `${d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`;
}

const started = (p: BoardPick, now: number) => !!p.kickoff && Date.parse(p.kickoff) <= now;

// What each guardrail flag means (scripts/price-lines.py).
function explainFlag(f: string): string {
  const [kind, rest] = [f.split(':')[0], f.slice(f.indexOf(':') + 1)];
  switch (kind) {
    case 'status': return `Listed ${rest}: the line assumes he plays, and the book knows more about the game-time call.`;
    case 'mate': return `Teammate news (${rest}): the projection may not have caught up with the role change.`;
    case 'role': return `His recent usage moved the projection ${rest}: the pool and his usage disagree.`;
    case 'form': return `Recent form far from the projection (${rest}).`;
    case 'games': return 'Fewer than 3 games played this season.';
    case 'thin': return `Low projected volume (${rest}): the probability is less reliable down here.`;
    case 'started': return 'His game had already kicked off when priced.';
    case 'moved': return 'The line moved a point or more against our lean after we first saw it.';
    default: return f;
  }
}

function SummaryCard({ label, s, hint }: { label: string; s: Summary | null | undefined; hint?: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', minWidth: 140, flex: '1 1 140px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      {s ? (
        <>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{pct(s.hitRate)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {s.hits}/{s.n} hit · expected {pct(s.expectedHitRate)}
          </div>
          {s.roi != null && (
            <div style={{ fontSize: 12, color: s.roi >= 0 ? GREEN : RED }}>
              {signedPct(s.roi)} per pick
            </div>
          )}
        </>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Nothing graded yet</div>
      )}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function SummaryTable({ title, rows, labelFor }: { title: string; rows: Record<string, Summary>; labelFor?: (k: string) => string }) {
  const keys = Object.keys(rows);
  if (!keys.length) return null;
  return (
    <div>
      <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>{title}</h3>
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px', width: '40%' }}>group</th>
              {['picks', 'hit rate', 'model expected', 'return / pick'].map((h) => (
                <th key={h} style={{ textAlign: 'right', padding: '6px 8px', width: '15%' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const s = rows[k];
              const off = s.expectedHitRate != null ? s.hitRate - s.expectedHitRate : null;
              return (
                <tr key={k} style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>
                  <td style={{ textAlign: 'left', padding: '6px 8px' }}>{labelFor ? labelFor(k) : k}</td>
                  <td style={{ padding: '6px 8px' }}>{s.n}</td>
                  <td style={{ padding: '6px 8px', color: off == null ? undefined : off >= 0 ? GREEN : RED }}>{pct(s.hitRate)}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{pct(s.expectedHitRate)}</td>
                  <td style={{ padding: '6px 8px', color: (s.roi ?? 0) >= 0 ? GREEN : RED }}>{signedPct(s.roi)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const UNDER = '#818cf8';

/** One pick as a card: the lean and line big, the chance it hits next to
 *  them, and its research behind a toggle. */
function PickCard({ p, statLabel, open, onToggle, graded, live }: {
  p: BoardPick; statLabel: string; open: boolean; onToggle: () => void; graded?: boolean; live?: boolean;
}) {
  const flags = p.flags ?? [];
  const over = p.lean === 'over';
  const leanColor = over ? GREEN : UNDER;
  const settled = graded || p.provisional;
  const dim = !settled && (live || !!p.void);
  const result = !settled ? null
    : p.void || p.hit == null ? { text: p.void ? 'VOID' : p.note === 'did not play' ? 'DNP' : 'NO RESULT', color: 'var(--text-muted)' }
    : p.push ? { text: 'PUSH', color: AMBER }
    : { text: p.hit ? 'HIT' : 'MISS', color: p.hit ? GREEN : RED };
  const meta = [p.pos, `${p.team}${p.opp ? ` ${p.home ? 'vs' : '@'} ${p.opp}` : ''}`,
    graded ? `Week ${p.week}` : kickoffLabel(p.kickoff)].filter(Boolean).join(' · ');
  const tag = (text: string, color: string, solid = false) => (
    <span style={{
      fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', padding: '3px 8px', borderRadius: 6,
      border: `1px solid ${color}`, color: solid ? '#fff' : color, background: solid ? color : 'transparent', whiteSpace: 'nowrap',
    }}>{text}</span>
  );
  return (
    <div style={{
      position: 'relative', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden',
      background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: `inset 4px 0 0 ${leanColor}`,
      opacity: dim ? 0.7 : 1,
    }}>
      <div style={{ padding: '14px 16px 12px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Who, and when */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.15, color: 'var(--text-primary)' }}>
              <PlayerName name={p.player} position={p.pos} />
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 3 }}>
              {meta}
            </div>
          </div>
          {result && (
            <div style={{ textAlign: 'center', flex: '0 0 auto' }}>
              <div style={{ fontSize: 15, fontWeight: 900, letterSpacing: 1, padding: '4px 10px', borderRadius: 8, color: '#fff', background: result.color }}>
                {result.text}
              </div>
              {p.actual != null && (
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', marginTop: 3 }}>{num(p.actual)}</div>
              )}
              {!graded && p.provisional && (
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-muted)' }}>unofficial</div>
              )}
            </div>
          )}
        </div>

        {/* The pick: lean and line big, the chance it hits beside it */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
              {statLabel}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontSize: 18, fontWeight: 900, color: leanColor, letterSpacing: 0.5 }}>
                {over ? '↑ OVER' : '↓ UNDER'}
              </span>
              <span style={{ fontSize: 32, fontWeight: 900, lineHeight: 1, color: 'var(--text-primary)' }}>{num(p.line)}</span>
            </div>
          </div>
          <div style={{ textAlign: 'right', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>
            <div style={{ fontSize: 30, fontWeight: 900, lineHeight: 1, color: 'var(--text-primary)' }}>{pct(p.pLean)}</div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 3 }}>
              to hit<br /><span style={{ color: p.edge >= 0.02 ? GREEN : 'var(--text-muted)' }}>{signedPct(p.edge)} edge</span>
            </div>
          </div>
        </div>

        {/* Chance to hit, as a bar */}
        <div aria-hidden style={{ height: 6, borderRadius: 3, background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
          <div style={{ width: `${Math.max(0, Math.min(1, p.pLean)) * 100}%`, height: '100%', borderRadius: 3, background: leanColor }} />
        </div>

        {(p.tag === 'call' || flags.length > 0 || (!settled && (p.void || live))) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {p.tag === 'call' && tag('★ Our call', 'var(--accent)', true)}
            {flags.length > 0 && tag(`⚠ ${flags.length} flag${flags.length > 1 ? 's' : ''}`, AMBER)}
            {!settled && p.void && tag(`Void · ${p.void}`, 'var(--text-muted)')}
            {!settled && !p.void && live && tag('Kicked off', 'var(--text-muted)')}
          </div>
        )}
      </div>

      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          all: 'unset', cursor: 'pointer', boxSizing: 'border-box', width: '100%', padding: '8px 16px 8px 20px',
          borderTop: '1px solid var(--border)', fontSize: 12, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
          color: 'var(--accent)', display: 'flex', justifyContent: 'space-between',
        }}
      >
        <span>Research</span><span>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 14px 20px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '6px 12px' }}>
            {([
              ['Projection', num(p.proj)],
              ['Median game', num(p.median)],
              ['Line', `${num(p.line)}${p.lineNow != null && p.lineNow !== p.line ? ` (now ${num(p.lineNow)})` : ''}`],
              ...(p.pRaw != null ? [['Simulated', pct(p.pRaw)]] : []),
              ['Calibrated', pct(p.pLean)],
              ['Edge', signedPct(p.edge)],
              ...(p.matchup != null ? [['Matchup', `×${p.matchup.toFixed(2)}`]] : []),
            ] as [string, string][]).map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{k}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>{v}</div>
              </div>
            ))}
          </div>
          {p.lineMove != null && p.lineMove !== 0 && (
            <div style={{ marginTop: 8 }}>
              Line moved {Math.abs(p.lineMove)} {p.lineMove > 0 ? 'toward' : 'against'} our lean since we priced it.
            </div>
          )}
          {flags.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {flags.map((f) => <li key={f} style={{ color: AMBER }}>{explainFlag(f)}</li>)}
            </ul>
          )}
          {p.recordedAt && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>Priced {new Date(p.recordedAt).toLocaleString()}</div>}
        </div>
      )}
    </div>
  );
}

const CARD_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: 12, alignItems: 'start' } as const;

function ResearchSection({ board }: { board: Board }) {
  const shrink = board.method.calShrink ?? 0.5;
  const minEdge = board.method.minEdge ?? 0.02;
  const p = { lineHeight: 1.65, fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px' } as const;
  return (
    <div style={{ maxWidth: 760 }}>
      <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>How a line is priced</h3>
      <p style={p}>
        Each line is priced from the player's StatHead weekly stat line, the same projection the Weekly Projections page shows,
        adjusted for this week's matchup. We simulate his game {(board.method.draws ?? 20000).toLocaleString()} times:
        volume (attempts, targets) from a gamma distribution, receptions as a binomial at his catch rate, yards as a sum of
        per-opportunity gamma draws, and touchdowns as Poisson at his rate. The share of simulated games over or under the line is the
        raw probability.
      </p>
      <h3 style={{ fontSize: 15, margin: '14px 0 8px' }}>Calibration</h3>
      <p style={p}>
        The raw simulation ranks outcomes well but is overconfident. On a back test of weeks 1–6 of 2026 (2,429 lines), the raw
        probability hit 50.6 / 52.8 / 56.9 / 57.6 / 62.4% in its 50–54 / 54–58 / 58–62 / 62–70 / 70%+ buckets, against the
        51.9 / 56.0 / 60.0 / 65.5 / 80.8% it claimed. So the published probability is pulled {Math.round(shrink * 100)}% of the
        way back toward a coin flip: P = 0.5 + {shrink} × (raw − 0.5). The Validation tab tracks whether that still holds on
        the picks we make.
      </p>
      <h3 style={{ fontSize: 15, margin: '14px 0 8px' }}>Edge and what gets picked</h3>
      <p style={p}>
        Edge is our calibrated probability minus the break-even probability for the payout (1 ÷ the multiplier: 56.2% at
        1.78x). A lean is recorded when its edge is at least {signedPct(minEdge)} and it carries no guardrail flag. Below that,
        the model's own error is larger than the edge.
      </p>
      <h3 style={{ fontSize: 15, margin: '14px 0 8px' }}>Guardrail flags</h3>
      <p style={p}>A flagged line is still priced, but we don't trust it until the flag clears:</p>
      <ul style={{ ...p, paddingLeft: 18 }}>
        <li><b>status</b>: the player is Questionable, Doubtful or Out.</li>
        <li><b>mate</b>: a teammate at his position is on the injury report, so his role may change.</li>
        <li><b>role</b>: his recent usage moved the projection 15% or more.</li>
        <li><b>form</b>: his last 3 games are 40%+ away from the projection.</li>
        <li><b>games</b>: fewer than 3 games played. <b>thin</b>: very low projected volume.</li>
        <li><b>moved</b>: the line moved a point or more against our lean after we first saw it.</li>
      </ul>
      <h3 style={{ fontSize: 15, margin: '14px 0 8px' }}>Limits</h3>
      <p style={p}>
        A pick is only as good as the projection behind it: a role change the projection hasn't caught (a starter returning,
        a teammate ruled out late) shows up as a large edge that isn't real. Each probability is for one leg; legs on the same
        player or game move together. Results are tracked on the Validation tab, and a few hundred graded picks are needed before the hit rate
        means much.
      </p>
    </div>
  );
}

function ValidationSection({ board, open, setOpen }: { board: Board; open: string | null; setOpen: (k: string | null) => void }) {
  const v = board.validation;
  const tagLabel = (k: string) => (k === 'call' ? 'Our calls (entries placed)' : k === 'auto' ? 'Model leans (recorded automatically)' : k);
  const moveLabel = (k: string) => ({ toward: 'Line moved toward us', unchanged: 'Line unchanged', away: 'Line moved against us' }[k] ?? k);
  const statLabel = (k: string) => board.statLabels[k] ?? k;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <SummaryCard label="All graded picks" s={v.overall} hint="hit rate vs what the model expected" />
        <SummaryCard label="Our calls" s={v.byTag?.call} />
        <SummaryCard label="Model leans" s={v.byTag?.auto} />
        <SummaryCard label="No flags" s={v.unflagged} />
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
        A pick is graded once every game in its week is final (graded through week {board.playedThrough || '—'};{' '}
        {v.pending} pending{v.voided ? `, ${v.voided} voided as inactive` : ''}). Hit rate above the model's expected rate means
        the probabilities are, if anything, conservative; below it means they're too high. Return is per 1 unit staked
        on each pick at the payout we recorded.
      </p>
      <SummaryTable title="Calibration by confidence" rows={v.byConfidence ?? {}} />
      <SummaryTable title="By week" rows={v.byWeek ?? {}} labelFor={(k) => `Week ${k}`} />
      <SummaryTable title="Calls vs model leans" rows={v.byTag ?? {}} labelFor={tagLabel} />
      <SummaryTable title="By stat" rows={v.byStat ?? {}} labelFor={statLabel} />
      <SummaryTable title="By line movement after we priced" rows={v.byMove ?? {}} labelFor={moveLabel} />
      <div>
        <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>Graded picks</h3>
        {board.graded.length ? (
          <div style={CARD_GRID}>
            {board.graded.map((p, i) => {
              const k = `g${i}`;
              return <PickCard key={k} p={p} graded statLabel={statLabel(p.stat)} open={open === k} onToggle={() => setOpen(open === k ? null : k)} />;
            })}
          </div>
        ) : <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nothing graded yet.</div>}
      </div>
    </div>
  );
}

export function SleeperPicksView() {
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>('loading');
  const [section, setSection] = useState<Section>('picks');
  const [open, setOpen] = useState<string | null>(null);
  const [showFlagged, setShowFlagged] = useState(true);
  const [sort, setSort] = useState<SortKey>('kickoff');
  const isMobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}data/pick-board-2026.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: Board | null) => {
        if (cancelled) return;
        if (!b) { setState('empty'); return; }
        setBoard(b);
        setState('ready');
      })
      .catch(() => { if (!cancelled) setState('empty'); });
    return () => { cancelled = true; };
  }, []);

  // By kickoff, games still to come lead and ones under way or final follow;
  // the other sorts ignore kickoff.
  const [now] = useState(() => Date.now());
  const picks = useMemo(() => {
    if (!board) return [];
    const shown = showFlagged ? board.picks : board.picks.filter((p) => !(p.flags ?? []).length);
    const by: Record<SortKey, (a: BoardPick, b: BoardPick) => number> = {
      kickoff: (a, b) => Number(started(a, now)) - Number(started(b, now)) || (a.kickoff ?? '').localeCompare(b.kickoff ?? '') || b.edge - a.edge,
      chance: (a, b) => b.pLean - a.pLean,
      edge: (a, b) => b.edge - a.edge,
      result: (a, b) => resultRank(a) - resultRank(b) || b.pLean - a.pLean,
      player: (a, b) => a.player.localeCompare(b.player) || a.stat.localeCompare(b.stat),
    };
    return [...shown].sort(by[sort]);
  }, [board, showFlagged, now, sort]);

  if (state === 'loading') return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading picks…</div>;
  if (state === 'empty' || !board) {
    return (
      <div style={{ padding: 24, maxWidth: 640 }}>
        <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Sleeper Picks</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
          No pick board yet. It's built by <code>scripts/build-pick-board.py</code> after each pricing run.
        </p>
      </div>
    );
  }

  const statLabel = (k: string) => board.statLabels[k] ?? k;
  const calls = board.picks.filter((p) => p.tag === 'call').length;
  return (
    <div style={{ padding: isMobile ? 10 : 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1100 }}>
      <div>
        <h2 style={{ fontSize: 18, margin: 0 }}>Sleeper Picks — week {board.week}</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0', lineHeight: 1.6 }}>
          Sleeper Picks lines StatHead leaned on this week, priced from StatHead's own projections. Probability is our
          calibrated chance the lean hits; edge is how far that beats the payout's break-even. Tap a pick for its research.
          Updated {new Date(board.generatedAt).toLocaleString()}.
        </p>
      </div>

      <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={section === s.id}
            onClick={() => { setSection(s.id); setOpen(null); }}
            style={{
              padding: '5px 12px', borderRadius: 14, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${section === s.id ? 'var(--accent)' : 'var(--border)'}`,
              background: section === s.id ? 'var(--accent)' : 'transparent',
              color: section === s.id ? '#fff' : 'var(--text-secondary)',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'picks' && (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
            <span>{board.picks.length} leans{calls ? ` · ${calls} our calls` : ''}</span>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              >
                {SORTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={showFlagged} onChange={(e) => setShowFlagged(e.target.checked)} />
              show flagged
            </label>
            <button
              onClick={() => setSection('validation')}
              style={{ all: 'unset', cursor: 'pointer', color: 'var(--accent)' }}
            >
              Record so far: {board.validation.overall ? `${board.validation.overall.hits}/${board.validation.overall.n} (${pct(board.validation.overall.hitRate)})` : 'none graded yet'} →
            </button>
          </div>
          {board.thisWeek && (() => {
            const w = board.thisWeek;
            const stat = (big: string, label: string, color = 'var(--text-primary)') => (
              <div>
                <div style={{ fontSize: 28, fontWeight: 900, lineHeight: 1, color, fontVariantNumeric: 'tabular-nums' }}>{big}</div>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 4 }}>{label}</div>
              </div>
            );
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 28px', alignItems: 'flex-end', padding: '14px 18px', borderRadius: 14, border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-secondary)', flexBasis: '100%' }}>
                  Week {board.week} so far <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>· unofficial until graded</span>
                </div>
                {stat(`${w.hits}–${w.n - w.hits}`, 'hits – misses')}
                {stat(pct(w.hitRate), `hit rate · expected ${pct(w.expectedHitRate)}`, w.hitRate >= w.expectedHitRate ? GREEN : RED)}
                {w.calls > 0 && stat(`${w.callHits}/${w.calls}`, 'our calls hit', 'var(--accent)')}
              </div>
            );
          })()}
          {picks.length ? (
            <div style={CARD_GRID}>
              {picks.map((p, i) => {
                const k = `p${i}`;
                return <PickCard key={k} p={p} live={started(p, now)} statLabel={statLabel(p.stat)} open={open === k} onToggle={() => setOpen(open === k ? null : k)} />;
              })}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No leans recorded for week {board.week} yet.</div>
          )}
        </>
      )}
      {section === 'research' && <ResearchSection board={board} />}
      {section === 'validation' && <ValidationSection board={board} open={open} setOpen={setOpen} />}
    </div>
  );
}
