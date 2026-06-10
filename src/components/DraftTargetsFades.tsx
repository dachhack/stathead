import { useMemo, useState } from 'react';
import type { EdgeBoardRow } from '../lib/edgeBoardRow';
import { VERDICT_STYLE, pickEdgeColor, pBeatColor, fmtEdge, fmtPct } from '../lib/edgeBoardRow';
import { PlayerName } from './PlayerName';
import { DocsLink } from './DocsLink';

// Targets & Fades section. For each position, two compact lists:
//
//   Targets — top N by `pickEdge × Beat%`. Strong edge AND likely to
//             realize it.
//   Fades   — bottom N by `pickEdge × (1 − Beat%)`. Strongly negative
//             edge AND likely to underperform.
//
// When Beat % is missing we fall back to pickEdge alone (multiplier 0.5),
// so a player with a degenerate CI doesn't get inflated above one with
// real probability data.
//
// ADP cap (default 200) keeps the lists in actionable territory.
// "Strong Target at ADP 280" already shows up on the Edge Board with
// the Strong Target badge — it's a sleeper, not a list-worthy pick to
// build a draft strategy around. The toggle expands to all ADPs for
// users who want sleepers in this view.

const TOP_N = 8;
const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
type Pos = typeof POSITIONS[number];

interface Props {
  rows: EdgeBoardRow[];
}

interface Lists {
  pos: Pos;
  targets: EdgeBoardRow[];
  fades: EdgeBoardRow[];
}

function targetScore(r: EdgeBoardRow): number {
  if (!Number.isFinite(r.pickEdge)) return -Infinity;
  const w = Number.isFinite(r.pBeat) ? r.pBeat : 0.5;
  return r.pickEdge * w;
}

function fadeScore(r: EdgeBoardRow): number {
  if (!Number.isFinite(r.pickEdge)) return Infinity;
  const w = Number.isFinite(r.pBeat) ? (1 - r.pBeat) : 0.5;
  // Multiplied by w so a confidently-bad fade ranks more negative than
  // a marginally-bad fade with similar PickEdge.
  return r.pickEdge * w;
}

export function DraftTargetsFades({ rows }: Props) {
  const [adpCap, setAdpCap] = useState(200);

  const lists = useMemo<Lists[]>(() => {
    return POSITIONS.map((pos) => {
      const pool = rows.filter((r) =>
        r.position === pos
        && r.adp > 0 && r.adp <= adpCap
        && Number.isFinite(r.pickEdge),
      );
      const targets = [...pool].sort((a, b) => targetScore(b) - targetScore(a)).slice(0, TOP_N);
      const fades = [...pool].sort((a, b) => fadeScore(a) - fadeScore(b)).slice(0, TOP_N);
      return { pos, targets, fades };
    });
  }, [rows, adpCap]);

  if (rows.length === 0) return null;

  return (
    <section style={{ marginTop: 32 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Targets &amp; Fades</h2>
        <DocsLink section="projection" title="Edge / Beat % methodology — Model Docs" />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Top {TOP_N} per position. Targets ranked by{' '}
          <code>edge × beat</code>; fades ranked by{' '}
          <code>edge × (1 − beat)</code>.
        </span>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto',
          fontSize: 11, fontWeight: 600,
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '3px 10px', cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={adpCap === 200}
            onChange={(e) => setAdpCap(e.target.checked ? 200 : 999)}
            style={{ margin: 0 }}
          />
          Draftable only (ADP ≤ 200)
        </label>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(540px, 1fr))', gap: 16 }}>
        {lists.map((l) => (
          <PositionPanel key={l.pos} lists={l} />
        ))}
      </div>
    </section>
  );
}

function PositionPanel({ lists }: { lists: Lists }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className={`pos-badge pos-${lists.pos}`} style={{ fontSize: 11 }}>{lists.pos}</span>
        <span style={{ fontSize: 12, fontWeight: 700, marginLeft: 'auto' }}>Targets</span>
        <span style={{ fontSize: 12, fontWeight: 700, marginLeft: 'auto', marginRight: '50%' }}>Fades</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <PlayerList rows={lists.targets} kind="target" />
        <PlayerList rows={lists.fades} kind="fade" />
      </div>
    </div>
  );
}

function PlayerList({ rows, kind }: { rows: EdgeBoardRow[]; kind: 'target' | 'fade' }) {
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: 6 }}>
        Not enough data.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map((r, i) => (
        <PlayerRow key={`${r.name}:${r.position}`} row={r} rank={i + 1} kind={kind} />
      ))}
    </div>
  );
}

function PlayerRow({ row, rank, kind }: { row: EdgeBoardRow; rank: number; kind: 'target' | 'fade' }) {
  // Generic "why" copy — describes what the model believes, not why it
  // believes it. Feature-driven explanations are a follow-up if the
  // axis is right.
  const why = kind === 'target'
    ? Number.isFinite(row.pBeat)
      ? `${fmtEdge(row.pickEdge)} PPG over baseline · ${fmtPct(row.pBeat)} chance to beat ADP`
      : `${fmtEdge(row.pickEdge)} PPG over baseline (no CI for beat-prob)`
    : Number.isFinite(row.pBeat)
      ? `${fmtEdge(row.pickEdge)} PPG below baseline · ${fmtPct(row.pBeat)} chance to beat ADP`
      : `${fmtEdge(row.pickEdge)} PPG below baseline (no CI for beat-prob)`;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '20px 1fr auto auto',
      columnGap: 8, alignItems: 'baseline',
      padding: '4px 0', borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textAlign: 'right' }}>
        {rank}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <PlayerName name={row.name} position={row.position} />
          {row.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {why}
        </div>
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>ADP {row.adp.toFixed(0)}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: pickEdgeColor(row.pickEdge), minWidth: 36, textAlign: 'right' }}>
          {fmtEdge(row.pickEdge)}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: pBeatColor(row.pBeat), minWidth: 32, textAlign: 'right' }}>
          {fmtPct(row.pBeat)}
        </span>
        <span style={{
          display: 'inline-block', fontSize: 9, fontWeight: 700,
          padding: '1px 6px', borderRadius: 8,
          background: VERDICT_STYLE[row.verdict].bg,
          color: VERDICT_STYLE[row.verdict].fg,
          border: row.verdict === 'Fair' || row.verdict === 'Unknown' ? '1px solid var(--border)' : 'none',
          whiteSpace: 'nowrap',
        }}>
          {VERDICT_STYLE[row.verdict].label}
        </span>
      </div>
    </div>
  );
}
