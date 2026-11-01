import { useEffect, useMemo, useState, type ReactNode } from 'react';
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

function Pill({ children, color }: { children: ReactNode; color: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, border: `1px solid ${color}`, color, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
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

/** One pick's priced lean, with its research behind a toggle. */
function PickRow({ p, statLabel, open, onToggle, graded, live }: {
  p: BoardPick; statLabel: string; open: boolean; onToggle: () => void; graded?: boolean; live?: boolean;
}) {
  const flags = p.flags ?? [];
  const leanColor = p.lean === 'over' ? GREEN : '#6366f1';
  const result = !graded ? null
    : p.void || p.hit == null ? <Pill color="var(--text-muted)">{p.void ? 'void' : p.note || 'no result'}</Pill>
    : p.push ? <Pill color={AMBER}>push</Pill>
    : <Pill color={p.hit ? GREEN : RED}>{p.hit ? 'hit' : 'miss'} · {num(p.actual)}</Pill>;
  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: '8px 10px' }}
      >
        <span style={{ minWidth: 0, flex: '1 1 200px' }}>
          <span style={{ fontWeight: 600 }}>
            <PlayerName name={p.player} position={p.pos} />
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> {p.pos} · {p.team}{p.opp ? ` ${p.home ? 'vs' : '@'} ${p.opp}` : ''}</span>
          {!graded && p.kickoff && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> · {kickoffLabel(p.kickoff)}</span>}
          {graded && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> · week {p.week}</span>}
        </span>
        <span style={{ flex: '1 1 160px', fontSize: 13 }}>
          {statLabel} <b style={{ color: leanColor }}>{p.lean}</b> <b>{num(p.line)}</b>
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: '0 1 auto' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{pct(p.pLean)}</span>
          <span style={{ fontSize: 12, color: p.edge >= 0.02 ? GREEN : 'var(--text-muted)' }}>{signedPct(p.edge)}</span>
          {p.tag === 'call' && <Pill color="var(--accent)">our call</Pill>}
          {flags.length > 0 && <Pill color={AMBER}>{flags.length} flag{flags.length > 1 ? 's' : ''}</Pill>}
          {!graded && p.void && <Pill color="var(--text-muted)">void: {p.void}</Pill>}
          {!graded && !p.void && live && <Pill color="var(--text-muted)">kicked off</Pill>}
          {result}
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && (
        <div style={{ padding: '4px 12px 12px 12px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
            <div>StatHead projection: <b style={{ color: 'var(--text-primary)' }}>{num(p.proj)}</b></div>
            <div>Median game: <b style={{ color: 'var(--text-primary)' }}>{num(p.median)}</b></div>
            <div>Line priced: <b style={{ color: 'var(--text-primary)' }}>{num(p.line)}</b>{p.lineNow != null && p.lineNow !== p.line ? ` (now ${num(p.lineNow)})` : ''}</div>
            {p.pRaw != null && <div>Simulated share: <b style={{ color: 'var(--text-primary)' }}>{pct(p.pRaw)}</b></div>}
            <div>Calibrated probability: <b style={{ color: 'var(--text-primary)' }}>{pct(p.pLean)}</b></div>
            <div>Edge: <b style={{ color: 'var(--text-primary)' }}>{signedPct(p.edge)}</b></div>
            {p.matchup != null && <div>Matchup factor: <b style={{ color: 'var(--text-primary)' }}>×{p.matchup.toFixed(2)}</b></div>}
            {p.recordedAt && <div>Priced: {new Date(p.recordedAt).toLocaleString()}</div>}
          </div>
          {p.lineMove != null && p.lineMove !== 0 && (
            <div style={{ marginTop: 6 }}>
              Line moved {Math.abs(p.lineMove)} {p.lineMove > 0 ? 'toward' : 'against'} our lean since we priced it.
            </div>
          )}
          {flags.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {flags.map((f) => <li key={f} style={{ color: AMBER }}>{explainFlag(f)}</li>)}
            </ul>
          )}
          {graded && p.actual != null && (
            <div style={{ marginTop: 6 }}>Actual: <b style={{ color: 'var(--text-primary)' }}>{num(p.actual)}</b> against {num(p.line)} ({p.lean}).</div>
          )}
        </div>
      )}
    </div>
  );
}

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
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            {board.graded.map((p, i) => {
              const k = `g${i}`;
              return <PickRow key={k} p={p} graded statLabel={statLabel(p.stat)} open={open === k} onToggle={() => setOpen(open === k ? null : k)} />;
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

  // Games still to come first; ones already under way (or done, awaiting
  // grading) after them.
  const [now] = useState(() => Date.now());
  const picks = useMemo(() => {
    if (!board) return [];
    const shown = showFlagged ? board.picks : board.picks.filter((p) => !(p.flags ?? []).length);
    return [...shown.filter((p) => !started(p, now)), ...shown.filter((p) => started(p, now))];
  }, [board, showFlagged, now]);

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
          {picks.length ? (
            <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              {picks.map((p, i) => {
                const k = `p${i}`;
                return <PickRow key={k} p={p} live={started(p, now)} statLabel={statLabel(p.stat)} open={open === k} onToggle={() => setOpen(open === k ? null : k)} />;
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
