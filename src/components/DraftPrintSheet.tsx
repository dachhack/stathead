import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import { startersPerTeam } from '../lib/draftPrepSettings';
import type { BaselineMode, ValuedPlayer } from '../lib/draftKit';
import type { KitPlayer } from '../lib/draftKit';
import {
  BASELINE_LABEL, KIT_POSITIONS, kitKey, positionalScarcity, roundPick, valuePool,
} from '../lib/draftKit';
import { userPickNumbers } from '../lib/snakeDraft';

// Draft Day Sheet — a one-page, BeerSheets-style printable cheat sheet.
//
// Rendered as a light-on-white page (portaled over the dark app) so the
// browser's print dialog produces a clean letter-landscape PDF: tier-colored
// position columns with VBD, value pick vs market ADP and the round delta,
// the user's snake-pick numbers, and the positional scarcity split. The
// "Save as PDF" requirement is the browser's own print-to-PDF — no PDF
// library, and the output is a real selectable-text document.

interface Props {
  pool: KitPlayer[];
  settings: DraftPrepSettings;
  myRankByKey?: Map<string, number>;
  myBoardName?: string;
  scenarioName?: string | null;
  onClose: () => void;
}

const TIER_COLORS = [
  '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#ea580c',
  '#ca8a04', '#65a30d', '#64748b', '#475569',
];

const POS_COLORS: Record<string, string> = {
  QB: '#4f46e5', RB: '#059669', WR: '#d97706', TE: '#dc2626',
};

const DELTA_NOISE_ROUNDS = 0.5; // same convention as the on-screen Value Board

type Depth = 'page' | 'starters' | 'full';
const DEPTH_LABEL: Record<Depth, string> = {
  page: 'One page — auto-fit',
  starters: 'Starters + 2 rounds',
  full: 'Full pool',
};

// Per-page row budgets for letter landscape at the sheet's 8px/1.3 rows:
// usable height ≈ 758px (8.5in − 0.6in margins), minus the header strip
// (~70px) and column headers (~30px) on page one. Deliberately a touch
// conservative — one spilled row creates a near-empty extra page.
const FIRST_PAGE_ROWS = 56;
const CONT_PAGE_ROWS = 62;

export function DraftPrintSheet({ pool, settings, myRankByKey, myBoardName, scenarioName, onClose }: Props) {
  const [mode, setMode] = useState<BaselineMode>('BEER');
  const [depth, setDepth] = useState<Depth>('page');

  // Hide the app root while printing (the sheet portals to <body>, so it
  // survives) and close on Escape.
  useEffect(() => {
    document.body.classList.add('print-sheet-open');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('print-sheet-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const { players, levels } = useMemo(
    () => valuePool(pool, settings, mode),
    [pool, settings, mode],
  );

  const scarcity = useMemo(() => positionalScarcity(players), [players]);
  const scarcityTotal = KIT_POSITIONS.reduce((s, p) => s + scarcity[p], 0) || 1;

  const byPos = useMemo(() => {
    const m = new Map<string, ValuedPlayer[]>();
    for (const pos of KIT_POSITIONS) {
      const list = players.filter((p) => p.position === pos);
      let cut = list.length;
      if (depth !== 'full') {
        // Starters + 2 rounds of depth; "one page" additionally caps at
        // the page's row budget (superflex / deep-roster leagues can push
        // starters+2 well past 100 rows per column).
        cut = Math.min(cut, levels.startersAtPos[pos] + settings.numTeams * 2);
        if (depth === 'page') cut = Math.min(cut, FIRST_PAGE_ROWS);
      }
      m.set(pos, list.slice(0, cut));
    }
    return m;
  }, [players, levels, settings.numTeams, depth]);

  // Deeper depths span pages: pre-chunk all four columns on shared row
  // boundaries so every page is a clean grid with repeated headers and
  // continuous numbering, instead of one tall grid the printer shears
  // wherever it lands.
  const pageChunks = useMemo(() => {
    const maxLen = Math.max(0, ...KIT_POSITIONS.map((pos) => (byPos.get(pos) ?? []).length));
    const out: Array<{ start: number; end: number }> = [];
    let start = 0;
    do {
      const budget = start === 0 ? FIRST_PAGE_ROWS : CONT_PAGE_ROWS;
      out.push({ start, end: Math.min(maxLen, start + budget) });
      start += budget;
    } while (start < maxLen);
    return out;
  }, [byPos]);

  // Picks through enough rounds to fill starters plus a 7-man bench.
  const rounds = Math.min(18, startersPerTeam(settings) + 7);
  const myPicks = useMemo(
    () => userPickNumbers(rounds, settings.pickSlot, settings.numTeams, settings.draftType),
    [rounds, settings.pickSlot, settings.numTeams, settings.draftType],
  );

  const hasMy = !!myRankByKey && myRankByKey.size > 0;
  const r = settings.roster;
  const rosterStr = [
    `${r.QB} QB`, `${r.RB} RB`, `${r.WR} WR`, `${r.TE} TE`,
    r.FLEX ? `${r.FLEX} FLEX` : '', r.SF ? `${r.SF} SF` : '',
  ].filter(Boolean).join(' · ');

  const sheet = (
    <div className="print-sheet">
      {/* Screen-only toolbar */}
      <div className="no-print print-sheet-toolbar">
        <button className="print-sheet-btn primary" onClick={() => window.print()}>
          🖨 Print / Save as PDF
        </button>
        <label>
          Baseline{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as BaselineMode)}>
            {(Object.keys(BASELINE_LABEL) as BaselineMode[]).map((m) => (
              <option key={m} value={m}>{BASELINE_LABEL[m]}</option>
            ))}
          </select>
        </label>
        <label>
          Depth{' '}
          <select value={depth} onChange={(e) => setDepth(e.target.value as Depth)}>
            {(Object.keys(DEPTH_LABEL) as Depth[]).map((d) => (
              <option key={d} value={d}>{DEPTH_LABEL[d]}</option>
            ))}
          </select>
        </label>
        <span className="print-sheet-tip">
          “One page” fits a single sheet; deeper depths add cleanly broken pages.
          In the print dialog choose “Save as PDF”, landscape, and enable background graphics for the tier colors.
        </span>
        <button className="print-sheet-btn" onClick={onClose} style={{ marginLeft: 'auto' }}>✕ Close</button>
      </div>

      <div className="print-sheet-page">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, borderBottom: '2px solid #0f172a', paddingBottom: 4 }}>
          <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: 0.5 }}>STATHEAD · DRAFT DAY SHEET</span>
          <span style={{ fontSize: 9, color: '#475569' }}>
            {settings.numTeams} teams · {settings.scoring} · {rosterStr} · pick {settings.pickSlot} ({settings.draftType})
            {' '}· baseline {mode}
            {scenarioName ? ` · scenario: ${scenarioName}` : ''}
            {myBoardName ? ` · board: ${myBoardName}` : ''}
          </span>
          <span style={{ fontSize: 9, color: '#475569', marginLeft: 'auto' }}>
            {new Date().toLocaleDateString()}
          </span>
        </div>

        {/* My picks + scarcity */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', padding: '3px 0 4px', borderBottom: '1px solid #cbd5e1', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 9, whiteSpace: 'nowrap' }}>
            <b>MY PICKS</b>{' '}
            {myPicks.map((p, i) => (
              <span key={p} style={{ marginRight: 6 }}>
                <span style={{ color: '#94a3b8' }}>{i + 1}.</span><b>{p}</b>
              </span>
            ))}
          </span>
          <span style={{ fontSize: 9, whiteSpace: 'nowrap' }}>
            <b>VALUE SPLIT</b>{' '}
            {KIT_POSITIONS.map((pos) => (
              <span key={pos} style={{ marginRight: 8, color: POS_COLORS[pos], fontWeight: 700 }}>
                {pos} {Math.round((scarcity[pos] / scarcityTotal) * 100)}%
              </span>
            ))}
          </span>
          <span style={{ fontSize: 8, color: '#64748b' }}>
            VBD = season pts over replacement · VAL = round.pick his value says · ADP = market round.pick ·
            {' '}<span style={{ color: '#16a34a', fontWeight: 700 }}>▼ discount (can wait)</span> /
            {' '}<span style={{ color: '#dc2626', fontWeight: 700 }}>▲ market reach</span>
            {hasMy ? ' · MY = your board rank' : ''} · colors = value tiers
          </span>
        </div>

        {/* Position columns, pre-chunked per printed page */}
        {pageChunks.map((chunk, ci) => (
          <div
            key={chunk.start}
            className={ci > 0 ? 'print-sheet-cont' : undefined}
            style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, paddingTop: 6,
              ...(ci > 0 ? { breakBefore: 'page' as const } : {}),
            }}
          >
            {KIT_POSITIONS.map((pos) => {
              const list = byPos.get(pos) ?? [];
              const slice = list.slice(chunk.start, chunk.end);
              return (
                <PrintPositionColumn
                  key={pos}
                  pos={pos}
                  players={slice}
                  offset={chunk.start}
                  prevTier={chunk.start > 0 ? list[chunk.start - 1]?.tier : undefined}
                  settings={settings}
                  hasMy={hasMy}
                  myRankByKey={myRankByKey}
                  baselinePpg={levels.baselinePpg[pos]}
                  starters={levels.startersAtPos[pos]}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  return createPortal(sheet, document.body);
}

function PrintPositionColumn({ pos, players, offset, prevTier, settings, hasMy, myRankByKey, baselinePpg, starters }: {
  pos: string;
  players: ValuedPlayer[];
  /** Global index of the slice's first row — keeps numbering continuous
   *  and tier separators correct across page boundaries. */
  offset: number;
  prevTier?: number;
  settings: DraftPrepSettings;
  hasMy: boolean;
  myRankByKey?: Map<string, number>;
  baselinePpg: number;
  starters: number;
}) {
  const head: React.CSSProperties = {
    fontSize: 7, fontWeight: 800, color: '#64748b', textAlign: 'right',
    borderBottom: '1px solid #94a3b8', padding: '0 0 1px',
  };
  if (offset > 0 && players.length === 0) return <div />; // shorter list exhausted on an earlier page
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 6,
        background: POS_COLORS[pos], color: '#fff', borderRadius: 3, padding: '1px 6px', marginBottom: 2,
      }}>
        <span style={{ fontSize: 11, fontWeight: 900 }}>{pos}</span>
        <span style={{ fontSize: 7, opacity: 0.9 }}>
          {offset > 0 ? `cont. from ${offset}` : `${starters} start · repl ${baselinePpg.toFixed(1)} ppg`}
        </span>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: hasMy ? '3px 1fr auto auto auto auto auto' : '3px 1fr auto auto auto auto',
        columnGap: 4, alignItems: 'baseline', fontSize: 8, lineHeight: 1.3,
      }}>
        <span style={head} />
        <span style={{ ...head, textAlign: 'left' }}>PLAYER</span>
        <span style={head}>VBD</span>
        <span style={head}>VAL</span>
        <span style={head}>ADP</span>
        {hasMy && <span style={head}>MY</span>}
        <span style={head}>Δ</span>
        {players.map((p, i) => (
          <PrintRow
            key={`${p.name}:${p.position}`}
            p={p}
            idx={offset + i}
            tierBreak={(i > 0 ? players[i - 1].tier : prevTier ?? p.tier) !== p.tier}
            settings={settings}
            hasMy={hasMy}
            myRank={myRankByKey?.get(kitKey(p.name, p.position))}
          />
        ))}
      </div>
    </div>
  );
}

function PrintRow({ p, idx, tierBreak, settings, hasMy, myRank }: {
  p: ValuedPlayer; idx: number; tierBreak: boolean; settings: DraftPrepSettings; hasMy: boolean; myRank?: number;
}) {
  const tierColor = TIER_COLORS[(p.tier - 1) % TIER_COLORS.length];
  const delta = p.adpDeltaRounds;
  const showDelta = Number.isFinite(delta) && Math.abs(delta) >= DELTA_NOISE_ROUNDS;
  const sep = tierBreak ? { borderTop: '1px solid #cbd5e1' } : {};
  const cell: React.CSSProperties = { textAlign: 'right', whiteSpace: 'nowrap', ...sep };
  return (
    <>
      <span style={{ alignSelf: 'stretch', background: tierColor, borderRadius: 1, ...sep }} title={`Tier ${p.tier}`} />
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...sep }}>
        <span style={{ color: '#94a3b8', fontWeight: 400 }}>{idx + 1} </span>
        {p.name}
        {p.isRookie && <span style={{ color: '#4f46e5', fontSize: 7 }}> R</span>}
        <span style={{ color: '#94a3b8', fontSize: 7 }}> {p.team}</span>
      </span>
      <span style={{ ...cell, fontWeight: 700, color: p.vbd > 0 ? '#0f172a' : '#94a3b8' }}>{Math.round(p.vbd)}</span>
      <span style={{ ...cell, color: '#475569' }}>{roundPick(p.valueRank, settings.numTeams)}</span>
      <span style={{ ...cell, color: '#64748b' }}>{p.adp < 999 ? roundPick(Math.round(p.adp), settings.numTeams) : '—'}</span>
      {hasMy && <span style={{ ...cell, color: myRank ? '#475569' : '#cbd5e1' }}>{myRank ?? '—'}</span>}
      <span style={{ ...cell, fontWeight: 700, color: !showDelta ? '#cbd5e1' : delta > 0 ? '#16a34a' : '#dc2626' }}>
        {showDelta ? (delta > 0 ? `▼${delta.toFixed(1)}` : `▲${Math.abs(delta).toFixed(1)}`) : ''}
      </span>
    </>
  );
}
