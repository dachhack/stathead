import { useMemo } from 'react';
import type { EdgeBoardRow } from '../lib/edgeBoardRow';
import {
  VERDICT_STYLE, pickEdgeColor, pBeatColor, fmtEdge, fmtPct,
} from '../lib/edgeBoardRow';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import { pickNumber, survivalAtPick } from '../lib/snakeDraft';

// Round-by-Round Plan section. For each of the user's picks across the
// first 12 rounds, show the pick number, recommended position(s), 3
// "likely available" targets ranked by PickEdge, and 2 "coin flip"
// sleepers.
//
// Recommendations are intentionally UNCONSTRAINED by roster sequence —
// this is a prep tool, not a live draft assistant. The user wants to
// see what's available at each slot, not what fits a forced sequence.
//
// Filtering at each pick combines survival and a *relevance window*:
//
//   Survival:    P(player still on the board at this pick), Gaussian on
//                FFC stdev. Likely ≥ 0.55, coin flip 0.20–0.55.
//
//   Relevance:   |ADP − pickN| ≤ numTeams (≈ ±1 round window around
//                the user's pick). Without this, deep-ADP sleepers
//                with 100% survival and inflated PickEdge values
//                dominate every round's recommendations — they're
//                technically "available" at pick #6 but they're not
//                a round-1 decision.

const ROUNDS = 12;
const LIKELY_THRESHOLD = 0.55;
const COIN_FLIP_THRESHOLD = 0.20;
const POSITIONS_FOR_REC = ['QB', 'RB', 'WR', 'TE'] as const;

interface Props {
  rows: EdgeBoardRow[];
  settings: DraftPrepSettings;
}

interface RoundCard {
  round: number;
  pickN: number;
  recommendation: string;
  recommendationDetail: string;
  likely: EdgeBoardRow[];
  coinFlip: EdgeBoardRow[];
}

export function DraftRoundPlan({ rows, settings }: Props) {
  const cards = useMemo<RoundCard[]>(() => {
    if (rows.length === 0) return [];
    // Pre-filter to players we can rank — must have a valid PickEdge.
    const candidates = rows.filter((r) => Number.isFinite(r.pickEdge) && r.adp > 0 && r.adp < 999);
    const out: RoundCard[] = [];

    const N = settings.numTeams;
    for (let round = 1; round <= ROUNDS; round++) {
      const pickN = pickNumber(round, settings.pickSlot, settings.numTeams, settings.draftType);

      // Relevance window around the user's pick — ±1 round.
      const windowMin = pickN - N;
      const windowMax = pickN + N;

      // Annotate each candidate with this-pick survival, filter to window.
      const withSurvival = candidates
        .filter((r) => r.adp >= windowMin && r.adp <= windowMax)
        .map((r) => ({
          row: r,
          surv: survivalAtPick(r.adp, r.stdev || undefined, pickN),
        }));

      const likelyRows = withSurvival
        .filter((x) => x.surv >= LIKELY_THRESHOLD)
        .sort((a, b) => b.row.pickEdge - a.row.pickEdge);

      const coinFlipRows = withSurvival
        .filter((x) => x.surv >= COIN_FLIP_THRESHOLD && x.surv < LIKELY_THRESHOLD)
        .sort((a, b) => b.row.pickEdge - a.row.pickEdge);

      // Recommended position(s): the position(s) whose top likely-available
      // PickEdge is highest. If two positions tie within 0.5 PPG, recommend
      // both — that's the actionable "either RB or WR works here" signal.
      const bestByPos: Record<string, { name: string; edge: number } | undefined> = {};
      for (const pos of POSITIONS_FOR_REC) {
        const top = likelyRows.find((x) => x.row.position === pos);
        bestByPos[pos] = top ? { name: top.row.name, edge: top.row.pickEdge } : undefined;
      }
      const ranked = POSITIONS_FOR_REC
        .map((pos) => ({ pos, ...bestByPos[pos] }))
        .filter((x): x is { pos: typeof POSITIONS_FOR_REC[number]; name: string; edge: number } =>
          x.name !== undefined && Number.isFinite(x.edge))
        .sort((a, b) => b.edge - a.edge);

      let recommendation = '—';
      let recommendationDetail = 'No likely-available players with valid edges at this pick.';
      if (ranked.length > 0) {
        const top = ranked[0];
        const close = ranked.slice(1).filter((r) => top.edge - r.edge <= 0.5);
        const positions = [top.pos, ...close.map((r) => r.pos)];
        recommendation = positions.join(' or ');
        recommendationDetail = ranked
          .slice(0, Math.max(2, positions.length + 1))
          .map((r) => `${r.pos} best ${fmtEdge(r.edge)}`)
          .join(' • ');
      }

      out.push({
        round,
        pickN,
        recommendation,
        recommendationDetail,
        likely: likelyRows.slice(0, 3).map((x) => x.row),
        coinFlip: coinFlipRows.slice(0, 2).map((x) => x.row),
      });
    }
    return out;
  }, [rows, settings.pickSlot, settings.numTeams, settings.draftType]);

  if (rows.length === 0) return null;

  return (
    <section style={{ marginTop: 32 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Round-by-Round Plan</h2>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          From your seat at pick {settings.pickSlot} of {settings.numTeams} ·{' '}
          {settings.draftType} · 12 rounds
        </span>
      </header>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.55 }}>
        For each of your picks, the top-PickEdge targets filtered to (a)
        players ≥55% likely to be available (likely) or 20–55% likely
        (coin flip), and (b) within ±1 round of the pick — without that
        relevance window deep-ADP sleepers dominate every round, since
        they're trivially "available" at any earlier pick.
        Recommendation is whichever position has the strongest edge in
        the likely bucket; ties within 0.5 PPG show both. Survival uses
        Gaussian on FFC ADP stdev (σ=8 fallback when stdev=0).
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
        {cards.map((c) => (
          <RoundCardView key={c.round} card={c} />
        ))}
      </div>
    </section>
  );
}

function RoundCardView({ card }: { card: RoundCard }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>Round {card.round}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pick #{card.pickN}</span>
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.4 }}>
          RECOMMENDED
        </div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{card.recommendation}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{card.recommendationDetail}</div>
      </div>

      <RoundList title="Likely available" rows={card.likely} />
      {card.coinFlip.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <RoundList title="Coin flip" rows={card.coinFlip} muted />
        </div>
      )}
    </div>
  );
}

function RoundList({ title, rows, muted }: { title: string; rows: EdgeBoardRow[]; muted?: boolean }) {
  return (
    <div>
      <div style={{
        fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.4, marginBottom: 2,
      }}>
        {title.toUpperCase()}
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: '4px 0' }}>
          None at this threshold.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto auto', columnGap: 8, rowGap: 3, alignItems: 'baseline', opacity: muted ? 0.85 : 1 }}>
          {rows.map((r) => (
            <PlayerLine key={`${r.name}:${r.position}`} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlayerLine({ row }: { row: EdgeBoardRow }) {
  return (
    <>
      <span className={`pos-badge pos-${row.position}`} style={{ fontSize: 9 }}>{row.position}</span>
      <span style={{ fontSize: 12, fontWeight: 600 }}>
        {row.name}
        {row.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>ADP {row.adp.toFixed(1)}</span>
      <span style={{ fontSize: 12, fontWeight: 700, textAlign: 'right', color: pickEdgeColor(row.pickEdge) }}>
        {fmtEdge(row.pickEdge)}
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, textAlign: 'right', color: pBeatColor(row.pBeat) }}>
        {fmtPct(row.pBeat)}
      </span>
      <span style={{ gridColumn: '2 / -1', marginTop: -2, marginBottom: 2 }}>
        <span style={{
          display: 'inline-block', fontSize: 9, fontWeight: 700,
          padding: '1px 6px', borderRadius: 8,
          background: VERDICT_STYLE[row.verdict].bg,
          color: VERDICT_STYLE[row.verdict].fg,
          border: row.verdict === 'Fair' || row.verdict === 'Unknown' ? '1px solid var(--border)' : 'none',
        }}>
          {VERDICT_STYLE[row.verdict].label}
        </span>
      </span>
    </>
  );
}
