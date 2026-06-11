import { useMemo, useState } from 'react';
import { PlayerName } from './PlayerName';
import { MethodNote } from './MethodNote';
import { DocsLink } from './DocsLink';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import type { BaselineMode, KitPlayer, ValuedPlayer } from '../lib/draftKit';
import {
  BASELINE_LABEL, KIT_POSITIONS, kitKey, positionalScarcity, roundPick, valuePool,
} from '../lib/draftKit';

// Value Board — a BeerSheets-style VBD cheat sheet built from the base
// projections (scoring-adjusted), the user's league settings, and the
// blended market ADP.
//
// Per position: players sorted by VBD (season points over replacement),
// colored into tiers by gap clustering, with the round.pick their value
// says they should go, the round.pick the market actually takes them,
// and the delta encoded BeerSheets-style:
//
//   ▼ green  — market drafts them ≥1 round later than their value: a
//              discount you can wait on.
//   ▲ red    — market drafts them ≥1 round earlier: you must reach to
//              get them (or let the room pay the hype tax).
//
// Scarcity bars show each position's share of the total positive VBD in
// the pool — "which position is the value actually at" given YOUR
// roster settings (2-RB leagues pump RB; superflex pumps QB).

interface Props {
  pool: KitPlayer[];
  settings: DraftPrepSettings;
  /** Optional custom board: kitKey -> 1-based rank from My Rankings. */
  myRankByKey?: Map<string, number>;
  myBoardName?: string;
}

const TIER_COLORS = [
  '#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6', '#fb923c',
  '#facc15', '#a3e635', '#94a3b8', '#64748b',
];

const DELTA_NOISE_ROUNDS = 0.5; // BeerSheets/TapThatDraft convention: blank deltas under half a round

export function DraftValueBoard({ pool, settings, myRankByKey, myBoardName }: Props) {
  const [mode, setMode] = useState<BaselineMode>('BEER');
  const [showDepth, setShowDepth] = useState(false);

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
      // Show starters + ~2 rounds of depth by default; full pool on toggle.
      const cut = showDepth ? list.length : Math.min(list.length, levels.startersAtPos[pos] + settings.numTeams * 2);
      m.set(pos, list.slice(0, cut));
    }
    return m;
  }, [players, levels, settings.numTeams, showDepth]);

  if (pool.length === 0) return null;

  return (
    <section style={{ marginTop: 32 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Value Board</h2>
        <DocsLink section="draft-kit" title="VBD engine methodology — Model Docs" />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          VBD cheat sheet · {settings.scoring} · {settings.numTeams} teams
        </span>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto',
          fontSize: 11, fontWeight: 600,
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '3px 10px',
        }}>
          Baseline{' '}
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as BaselineMode)}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}
          >
            {(Object.keys(BASELINE_LABEL) as BaselineMode[]).map((m) => (
              <option key={m} value={m}>{BASELINE_LABEL[m]}</option>
            ))}
          </select>
        </label>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 11, fontWeight: 600,
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '3px 10px', cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={showDepth}
            onChange={(e) => setShowDepth(e.target.checked)}
            style={{ margin: 0 }}
          />
          Show full depth
        </label>
      </header>

      <MethodNote id="value-board">
        <strong>VBD</strong> = season points over a replacement-level
        alternative at the position, computed from your roster slots
        (flex allocated greedily by projected PPG) and scoring.{' '}
        <strong>Val</strong> = where that value says the player should go
        (round.pick in your league); <strong>ADP</strong> = where the
        market takes him. <span style={{ color: '#22c55e' }}>▼ +N rd</span>{' '}
        = market discount (can wait N rounds);{' '}
        <span style={{ color: '#ef4444' }}>▲ −N rd</span> = market reaches
        N rounds early (hype tax). Deltas under half a round are noise and
        left blank. Colors group players into value tiers — when a tier is
        about to run out, that position is the pick.
        {myBoardName && (
          <>
            {' '}<strong>My</strong> = your rank from the saved board
            “{myBoardName}”.
          </>
        )}
      </MethodNote>

      {/* Scarcity bars */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px 10px',
        alignItems: 'center', marginBottom: 14, maxWidth: 560,
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '10px 14px',
      }}>
        <div style={{ gridColumn: '1 / -1', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5 }}>
          WHERE THE VALUE IS — share of total startable VBD by position
        </div>
        {KIT_POSITIONS.map((pos) => {
          const share = scarcity[pos] / scarcityTotal;
          return (
            <PosBar key={pos} pos={pos} share={share} starters={levels.startersAtPos[pos]} baseline={levels.baselinePpg[pos]} />
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        {KIT_POSITIONS.map((pos) => (
          <PositionSheet
            key={pos}
            pos={pos}
            players={byPos.get(pos) ?? []}
            settings={settings}
            myRankByKey={myRankByKey}
          />
        ))}
      </div>
    </section>
  );
}

function PosBar({ pos, share, starters, baseline }: { pos: string; share: number; starters: number; baseline: number }) {
  return (
    <>
      <span className={`pos-badge pos-${pos}`} style={{ fontSize: 10 }}>{pos}</span>
      <div style={{ background: 'var(--bg-tertiary)', borderRadius: 4, height: 10, overflow: 'hidden' }}>
        <div style={{
          width: `${Math.round(share * 100)}%`, height: '100%',
          background: 'var(--accent, #00d4aa)', opacity: 0.85, borderRadius: 4,
        }} />
      </div>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {Math.round(share * 100)}% · {starters} start · repl {baseline.toFixed(1)} PPG
      </span>
    </>
  );
}

function PositionSheet({ pos, players, settings, myRankByKey }: {
  pos: string;
  players: ValuedPlayer[];
  settings: DraftPrepSettings;
  myRankByKey?: Map<string, number>;
}) {
  const hasMy = !!myRankByKey && myRankByKey.size > 0;
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className={`pos-badge pos-${pos}`} style={{ fontSize: 11 }}>{pos}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{players.length} shown</span>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: hasMy ? '4px 1fr auto auto auto auto auto' : '4px 1fr auto auto auto auto',
        columnGap: 8, rowGap: 0, alignItems: 'baseline', fontSize: 11,
      }}>
        <span />
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)' }}>PLAYER</span>
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'right' }}>VBD</span>
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'right' }} title="Where his value says he should be drafted (round.pick in your league)">VAL</span>
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'right' }} title="Market ADP as round.pick (FFC; FantasyCalc rank fallback for rookies)">ADP</span>
        {hasMy && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'right' }} title="Your rank from the selected My Rankings board">MY</span>}
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'right' }} title="ADP minus value rank, in rounds. ▼ = discount, ▲ = market reach">Δ RD</span>
        {players.map((p) => (
          <SheetRow key={`${p.name}:${p.position}`} p={p} settings={settings} hasMy={hasMy} myRank={myRankByKey?.get(kitKey(p.name, p.position))} />
        ))}
      </div>
    </div>
  );
}

function SheetRow({ p, settings, hasMy, myRank }: {
  p: ValuedPlayer; settings: DraftPrepSettings; hasMy: boolean; myRank?: number;
}) {
  const tierColor = TIER_COLORS[(p.tier - 1) % TIER_COLORS.length];
  const delta = p.adpDeltaRounds;
  const showDelta = Number.isFinite(delta) && Math.abs(delta) >= DELTA_NOISE_ROUNDS;
  const deltaColor = !showDelta ? 'var(--text-muted)' : delta > 0 ? '#22c55e' : '#ef4444';
  return (
    <>
      <span style={{ alignSelf: 'stretch', width: 4, borderRadius: 2, background: tierColor, opacity: 0.75, margin: '1px 0' }} title={`Tier ${p.tier}`} />
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '2px 0' }}>
        <PlayerName name={p.name} position={p.position} />
        {p.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
        {p.team && <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 4 }}>{p.team}</span>}
      </span>
      <span style={{ textAlign: 'right', fontWeight: 700, color: p.vbd > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        {Math.round(p.vbd)}
      </span>
      <span style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{roundPick(p.valueRank, settings.numTeams)}</span>
      <span style={{ textAlign: 'right', color: 'var(--text-muted)' }} title={p.adpSource === 'fc-rank' ? 'No market ADP yet (FFC/Sleeper) — FantasyCalc consensus rank used as pick proxy' : undefined}>
        {p.adp < 999 ? roundPick(Math.round(p.adp), settings.numTeams) : '—'}
        {p.adpSource === 'fc-rank' && <span style={{ fontSize: 8, verticalAlign: 'super' }}>*</span>}
      </span>
      {hasMy && (
        <span style={{ textAlign: 'right', color: myRank ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
          {myRank ?? '—'}
        </span>
      )}
      <span style={{ textAlign: 'right', fontWeight: 700, color: deltaColor, whiteSpace: 'nowrap' }}
        title={showDelta
          ? delta > 0
            ? `Market drafts him ${delta.toFixed(1)} rounds after his value rank — you can likely wait.`
            : `Market drafts him ${Math.abs(delta).toFixed(1)} rounds before his value rank — you must reach.`
          : Number.isFinite(delta) ? 'Market price ≈ value (within half a round).' : 'No market ADP.'}
      >
        {showDelta ? (delta > 0 ? `▼+${delta.toFixed(1)}` : `▲−${Math.abs(delta).toFixed(1)}`) : ''}
      </span>
    </>
  );
}
