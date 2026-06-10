import { useMemo } from 'react';
import { PlayerName } from './PlayerName';
import { MethodNote } from './MethodNote';
import { DocsLink } from './DocsLink';
import { normName } from '../lib/nameUtils';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import type { KitPlayer, ValuedPlayer } from '../lib/draftKit';
import { roundPick, valuePool } from '../lib/draftKit';

// Rookie & Veteran Edges — where the community's priors are most likely
// to be wrong, in both directions.
//
// Rookies: the market prices rookies on draft capital and hype, our
// career model prices them on the full prospect profile. Players whose
// projection-value rank beats their ADP by a round-plus are discounts;
// the model's boom probability flags the subset with real blow-up paths.
// Historical structure worth knowing (2018–23 ADP studies): early-ADP
// rookie RBs mostly justify their price — the systematic value is LATE
// rookie WRs, while mid-round rookie WR hype is where drafts go to die.
//
// Veterans: boring vets get buried by recency and age bias. A vet with
// 4+ years in the league, a healthy projection, and an ADP a round or
// more past his value rank is the quiet pick that wins leagues.

interface CareerEntry {
  name: string;
  position: string;
  draftSeason: number;
  predictedPPG: number;
  percentile: number;
  tierLabel: string;
  boomProb: number;
  bustProb: number;
  thresholdProbs: Record<string, number>;
}

/** Startable-PPG threshold per position — matches the career model's
 *  lowest threshold band (≈ low-end starter at the position). */
const STARTABLE_KEY: Record<string, string> = { QB: '16', RB: '12', WR: '12', TE: '9' };

interface Props {
  pool: KitPlayer[];
  settings: DraftPrepSettings;
  career: CareerEntry[];
  currentSeason: number;
}

interface RookieRow {
  p: ValuedPlayer;
  career?: CareerEntry;
  startProb: number;   // P(rookie-year PPG ≥ startable threshold), NaN if no model
  blowUp: boolean;
}

const VET_MIN_YOE = 4;
const EDGE_ROUNDS = 0.75;   // min |Δ rounds| to call something an edge
const TOP_N = 10;

export function DraftRookieVetEdges({ pool, settings, career, currentSeason }: Props) {
  const { players } = useMemo(() => valuePool(pool, settings, 'BEER'), [pool, settings]);

  const careerByName = useMemo(() => {
    const m = new Map<string, CareerEntry>();
    for (const c of career) {
      if (c.draftSeason === currentSeason) m.set(normName(c.name), c);
    }
    return m;
  }, [career, currentSeason]);

  const rookies = useMemo<{ value: RookieRow[]; hype: RookieRow[] }>(() => {
    const all: RookieRow[] = players
      .filter((p) => p.isRookie)
      .map((p) => {
        const c = careerByName.get(normName(p.name));
        const startProb = c ? (c.thresholdProbs?.[STARTABLE_KEY[p.position]] ?? NaN) : NaN;
        const blowUp = !!c && (c.boomProb >= 18 || (Number.isFinite(startProb) && startProb >= 50));
        return { p, career: c, startProb, blowUp };
      });
    const drafted = all.filter((r) => r.p.adp < 999);
    const value = all
      .filter((r) =>
        (Number.isFinite(r.p.adpDeltaRounds) && r.p.adpDeltaRounds >= EDGE_ROUNDS)
        || (r.p.adp >= 999 && r.p.vbd > 0)  // projection-relevant but market-undrafted = free
        || (r.blowUp && (!Number.isFinite(r.p.adpDeltaRounds) || r.p.adpDeltaRounds > -EDGE_ROUNDS)))
      .sort((a, b) => score(b) - score(a))
      .slice(0, TOP_N);
    const hype = drafted
      .filter((r) => Number.isFinite(r.p.adpDeltaRounds) && r.p.adpDeltaRounds <= -EDGE_ROUNDS)
      .sort((a, b) => a.p.adpDeltaRounds - b.p.adpDeltaRounds)
      .slice(0, TOP_N);
    return { value, hype };
  }, [players, careerByName]);

  const vets = useMemo(() => {
    const eligible = players.filter((p) =>
      !p.isRookie
      && (p.yearsExp ?? 0) >= VET_MIN_YOE
      && p.adp < 999
      && Number.isFinite(p.adpDeltaRounds));
    const value = eligible
      .filter((p) => p.adpDeltaRounds >= EDGE_ROUNDS && p.vbd > 0)
      .sort((a, b) => b.adpDeltaRounds * Math.sqrt(Math.max(b.vbd, 1)) - a.adpDeltaRounds * Math.sqrt(Math.max(a.vbd, 1)))
      .slice(0, TOP_N);
    return value;
  }, [players]);

  if (pool.length === 0) return null;

  return (
    <section style={{ marginTop: 32 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Rookie &amp; Veteran Edges</h2>
        <DocsLink section="rookie" title="Rookie career model validation — Model Docs" />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Where the room's priors break · Δ = ADP vs value rank, in rounds
        </span>
      </header>
      <MethodNote id="rookie-vet">
        <strong>Rookie values</strong> pair the market discount (projection
        value rank vs ADP) with the career model's profile —{' '}
        <strong>Start %</strong> is the model's probability the rookie hits
        low-end-starter PPG this year, <strong>Boom %</strong> his
        probability of a top-tier outcome. <span style={{ color: '#f59e0b' }}>⚡</span>{' '}
        marks blow-up candidates the market hasn't priced. <strong>Hype tax</strong>{' '}
        lists rookies going a round-plus ahead of their projection value — history
        says early rookie <em>RB</em> hype is usually justified, while mid-round
        rookie <em>WR</em> hype is the classic trap (late rookie WRs are the
        systematic buy). <strong>Veteran values</strong> are 4+ year vets whose
        boring projection out-runs their ADP — the community fade you get paid
        to take.
      </MethodNote>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
        <Panel title="Rookie values" accent="#22c55e">
          {rookies.value.length === 0
            ? <Empty />
            : rookies.value.map((r) => <RookieLine key={`${r.p.name}:${r.p.position}`} r={r} settings={settings} />)}
        </Panel>
        <Panel title="Rookie hype tax" accent="#ef4444">
          {rookies.hype.length === 0
            ? <Empty />
            : rookies.hype.map((r) => <RookieLine key={`${r.p.name}:${r.p.position}`} r={r} settings={settings} />)}
        </Panel>
        <Panel title="Veteran values" accent="#60a5fa">
          {vets.length === 0
            ? <Empty />
            : vets.map((p) => <VetLine key={`${p.name}:${p.position}`} p={p} settings={settings} />)}
        </Panel>
      </div>
    </section>
  );
}

function score(r: RookieRow): number {
  const delta = Number.isFinite(r.p.adpDeltaRounds) ? r.p.adpDeltaRounds : 1.5;
  const boom = r.career ? r.career.boomProb / 25 : 0;
  return delta + boom + Math.max(r.p.vbd, 0) / 60;
}

function Panel({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 12px',
    }}>
      <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6, color: accent }}>{title.toUpperCase()}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </div>
  );
}

function Empty() {
  return <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: 6 }}>None found at current thresholds.</div>;
}

function DeltaChip({ delta }: { delta: number }) {
  if (!Number.isFinite(delta)) {
    return <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>free</span>;
  }
  const good = delta > 0;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: good ? '#22c55e' : '#ef4444', whiteSpace: 'nowrap' }}>
      {good ? `▼+${delta.toFixed(1)}rd` : `▲−${Math.abs(delta).toFixed(1)}rd`}
    </span>
  );
}

function RookieLine({ r, settings }: { r: RookieRow; settings: DraftPrepSettings }) {
  const { p } = r;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr auto auto auto', columnGap: 8,
      alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid var(--border)',
    }}>
      <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 9 }}>{p.position}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <PlayerName name={p.name} position={p.position} />
          {r.blowUp && <span style={{ marginLeft: 4 }} title={`Blow-up watch — boom ${r.career?.boomProb.toFixed(0)}%${Number.isFinite(r.startProb) ? `, ${r.startProb.toFixed(0)}% to hit startable PPG` : ''}`}>⚡</span>}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {p.ppg.toFixed(1)} PPG proj
          {r.career && <> · {r.career.tierLabel} (p{r.career.percentile})</>}
          {Number.isFinite(r.startProb) && <> · start {r.startProb.toFixed(0)}%</>}
          {r.career && <> · boom {r.career.boomProb.toFixed(0)}%</>}
        </div>
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {p.adp < 999 ? `ADP ${roundPick(Math.round(p.adp), settings.numTeams)}` : 'undrafted'}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }} title="Where his projection value says he should go">
        val {roundPick(p.valueRank, settings.numTeams)}
      </span>
      <DeltaChip delta={p.adpDeltaRounds} />
    </div>
  );
}

function VetLine({ p, settings }: { p: ValuedPlayer; settings: DraftPrepSettings }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr auto auto auto', columnGap: 8,
      alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid var(--border)',
    }}>
      <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 9 }}>{p.position}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <PlayerName name={p.name} position={p.position} />
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {p.ppg.toFixed(1)} PPG proj
          {Number.isFinite(p.modelPPG) && <> · model {p.modelPPG.toFixed(1)}</>}
          {p.yearsExp != null && <> · yr {p.yearsExp + 1}</>}
          {p.age != null && <> · age {p.age.toFixed(0)}</>}
        </div>
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>ADP {roundPick(Math.round(p.adp), settings.numTeams)}</span>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>val {roundPick(p.valueRank, settings.numTeams)}</span>
      <DeltaChip delta={p.adpDeltaRounds} />
    </div>
  );
}
