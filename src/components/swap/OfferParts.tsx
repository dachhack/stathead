/**
 * Shared building blocks for the Trade Finisher and Swap Meet: the two
 * teams' needs cards, the tap-to-select roster columns, the live verdict on
 * an offer, the tag chips, and the card for one suggested (or proposed)
 * version of a trade. Every label that says "you" is a prop, because the
 * meet page is read by both managers.
 */

import type { ReactNode } from 'react';
import { PlayerName } from '../PlayerName';
import {
  describeEdit, GOAL_LABEL, SKILL_POSITIONS,
  type FinisherAsset, type FinisherTeam, type Offer, type OfferEval, type TeamNeeds, type TradeGoal, type Variant,
} from '../../lib/tradeFinisher';

import { GIVE_COLOR, GET_COLOR, MUTED, VERDICT_LABEL, VERDICT_COLOR, GOAL_COLOR, fmt, signed, sumValue } from './offerStyle';

const btn = { padding: '3px 9px', fontSize: 11 } as const;

// ── Needs card ──────────────────────────────────────────────────────────

export function NeedsCard({ team, needs, goal, color, label }: { team: FinisherTeam; needs: TeamNeeds; goal: TradeGoal; color: string; label: string }) {
  const picks = team.assets.filter((a) => a.type === 'pick');
  const maxRatio = 1.6;
  return (
    <div style={{ background: 'var(--bg-tertiary)', borderRadius: 8, padding: '10px 12px', borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <span style={{ fontSize: 10, color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 6 }}>{label}</span>
          <strong style={{ fontSize: 13 }}>{team.teamName}</strong>
          <span style={{ fontSize: 11, color: MUTED, marginLeft: 6 }}>{team.wins}-{team.losses}</span>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color: GOAL_COLOR[goal] }}>{GOAL_LABEL[goal]}</span>
      </div>
      <div style={{ fontSize: 11, color: MUTED, margin: '2px 0 8px' }}>
        Best lineup <strong style={{ color: 'var(--text-primary)' }}>{fmt(needs.lineup.total)}</strong> proj pts
        {needs.starterAvgAge > 0 && <> · starters avg <strong style={{ color: 'var(--text-primary)' }}>{needs.starterAvgAge.toFixed(1)}</strong> yrs</>}
        {' '}· {needs.goalReason}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: '4px 8px', alignItems: 'center', fontSize: 11 }}>
        {needs.positions.map((p) => {
          const w = Math.min(p.ratio, maxRatio) / maxRatio;
          const medianX = 1 / maxRatio;
          const barColor = p.status === 'weak' ? '#ef4444' : p.status === 'strong' ? '#22c55e' : color;
          return (
            <div key={p.pos} style={{ display: 'contents' }}>
              <span className={`pos-badge pos-${p.pos}`} style={{ fontSize: 10, padding: '1px 6px' }}>{p.pos}</span>
              <div title={`${p.pos}: ${fmt(p.pts)} proj pts from the best lineup · league median ${fmt(p.median)} · ${p.depth} bench with a projection`}
                style={{ position: 'relative', height: 10, background: 'var(--bg-secondary)', borderRadius: '0 3px 3px 0' }}>
                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${w * 100}%`, background: barColor, borderRadius: '0 3px 3px 0', opacity: 0.85 }} />
                <div style={{ position: 'absolute', left: `${medianX * 100}%`, top: -2, bottom: -2, width: 2, background: 'var(--text-muted)' }} />
              </div>
              <span style={{ color: 'var(--text-secondary)', textAlign: 'right', minWidth: 60 }}>{fmt(p.pts)} <span style={{ color: MUTED }}>/ {fmt(p.median)}</span></span>
              <span style={{ fontWeight: 600, minWidth: 44, color: p.status === 'weak' ? '#ef4444' : p.status === 'strong' ? '#22c55e' : MUTED }}>
                {p.status === 'weak' ? 'weak' : p.status === 'strong' ? `+${p.depth} deep` : 'ok'}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: MUTED, marginTop: 4 }}>Bar = position's projected points in the best lineup · tick = league median</div>
      {picks.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
          <span style={{ color: MUTED }}>Picks ({fmt(needs.pickValue)}):</span>{' '}
          {picks.map((p) => p.name).join(' · ')}
        </div>
      )}
    </div>
  );
}

// ── Asset column (roster + picks, tap to add to the offer) ──────────────

export function AssetColumn({ title, color, assets, selected, filter, setFilter, onToggle }: {
  title: string; color: string; assets: FinisherAsset[]; selected: string[];
  filter: string; setFilter: (f: string) => void; onToggle: (id: string) => void;
}) {
  const sel = new Set(selected);
  const total = assets.filter((a) => sel.has(a.id)).reduce((s, a) => s + a.value, 0);
  const hasPicks = assets.some((a) => a.type === 'pick');
  const shown = assets.filter((a) => filter === 'ALL' || (filter === 'PICK' ? a.type === 'pick' : a.position === filter));
  return (
    <div className="tf-col" style={{ minWidth: 0, borderLeft: `3px solid ${color}`, paddingLeft: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6, padding: '4px 8px', background: `${color}1f`, borderRadius: 6, marginBottom: 6 }}>
        <strong style={{ fontSize: 12, color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</strong>
        <span style={{ fontSize: 12, fontWeight: 700, color, flexShrink: 0 }}>{selected.length ? fmt(total) : ''}</span>
      </div>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 6 }}>
        {['ALL', ...SKILL_POSITIONS, ...(hasPicks ? ['PICK'] : [])].map((f) => (
          <button key={f} className={`format-tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)} style={{ padding: '1px 7px', fontSize: 10 }}>
            {f === 'ALL' ? 'All' : f === 'PICK' ? 'Picks' : f}
          </button>
        ))}
      </div>
      <div className="tf-list" style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {shown.map((a) => {
          const on = sel.has(a.id);
          return (
            <div key={a.id} className="tf-asset" onClick={() => onToggle(a.id)} role="button" aria-pressed={on}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                background: on ? `${color}2e` : 'var(--bg-tertiary)', border: `1px solid ${on ? color : 'transparent'}`,
              }}>
              <span style={{ width: 14, textAlign: 'center', color: on ? color : MUTED, fontWeight: 700 }}>{on ? '✓' : '+'}</span>
              <AssetBadge a={a} />
              {/* Plain text: the whole row toggles, and a name link would
                  navigate away mid-build. Suggestion cards link names. */}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name}
                {a.type === 'player' && <span style={{ color: MUTED, fontSize: 10, marginLeft: 4 }}>{a.team}{a.age ? ` · ${a.age.toFixed(0)}` : ''}</span>}
              </span>
              {a.projPts > 0 && <span style={{ fontSize: 10, color: '#60a5fa', flexShrink: 0 }}>{fmt(a.projPts)}</span>}
              <span style={{ fontWeight: 600, flexShrink: 0, color: a.value > 0 ? 'var(--text-primary)' : MUTED, minWidth: 40, textAlign: 'right' }}>{a.value > 0 ? fmt(a.value) : '—'}</span>
            </div>
          );
        })}
        {!shown.length && <div style={{ fontSize: 11, color: MUTED, padding: 8 }}>Nothing here.</div>}
      </div>
    </div>
  );
}

export function AssetBadge({ a }: { a: FinisherAsset }) {
  return a.type === 'player'
    ? <span className={`pos-badge pos-${a.position}`} style={{ fontSize: 9, padding: '0 5px' }}>{a.position}</span>
    : <span className="pos-badge" style={{ fontSize: 9, padding: '0 5px', background: 'rgba(148,163,184,0.2)', color: '#94a3b8' }}>PICK</span>;
}

// ── Verdict on an offer ─────────────────────────────────────────────────

export function OfferVerdict({ evaluation, offer, youName = 'you', themName, heading = 'Current offer', children }: {
  evaluation: OfferEval | null; offer: Offer; youName?: string; themName: string; heading?: string; children?: ReactNode;
}) {
  const any = offer.give.length + offer.get.length > 0;
  const yourLineup = youName === 'you' ? 'Your lineup' : `${youName} lineup`;
  const theirLineup = youName === 'you' ? 'theirs' : themName;
  return (
    <div className="tf-verdict" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 130, padding: '16px 4px', textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5 }}>{heading}</div>
      {!evaluation ? (
        <div style={{ fontSize: 12, color: MUTED }}>{any ? 'Add a piece to each side' : 'Tap assets on both sides'}</div>
      ) : (
        <>
          <div style={{ fontSize: 22, fontWeight: 800, color: VERDICT_COLOR[evaluation.verdict], lineHeight: 1.1 }}>{VERDICT_LABEL[evaluation.verdict]}</div>
          <div style={{ fontSize: 11, color: MUTED }}>
            {evaluation.fairnessPct.toFixed(0)}% · {evaluation.diff === 0 ? 'even' : <><strong style={{ color: evaluation.diff > 0 ? GIVE_COLOR : GET_COLOR }}>{evaluation.diff > 0 ? youName : themName}</strong> by {fmt(Math.abs(evaluation.diff))}</>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {yourLineup} <strong style={{ color: evaluation.myLineupDelta >= 0 ? '#22c55e' : '#ef4444' }}>{signed(evaluation.myLineupDelta)}</strong>
            {' · '}{theirLineup} <strong style={{ color: evaluation.partnerLineupDelta >= 0 ? '#22c55e' : '#ef4444' }}>{signed(evaluation.partnerLineupDelta)}</strong>
          </div>
          {!evaluation.legal && <div style={{ fontSize: 11, color: '#ef4444' }}>{evaluation.illegalReason}</div>}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
            {evaluation.tags.filter((t) => !t.startsWith('Illegal')).map((t) => <Tag key={t} text={t} />)}
          </div>
        </>
      )}
      {children}
    </div>
  );
}

export function Tag({ text }: { text: string }) {
  const good = /^Fills your|^Your lineup \+|younger|^Frees|^Serves|lineup \+|frees|gets younger/.test(text);
  const bad = /^Thins|^Your lineup −|^Your lineup -|older|^Needs|^Against|lineup −|lineup -|needs \d/.test(text);
  return (
    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-tertiary)', color: good ? '#22c55e' : bad ? '#fb923c' : 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
      {text}
    </span>
  );
}

// ── Package lists (one side of a trade) ─────────────────────────────────

export function PackageList({ xs, color, head, linkNames = true }: { xs: FinisherAsset[]; color: string; head: string; linkNames?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{head} · {fmt(sumValue(xs))}</div>
      {xs.map((a) => (
        <div key={a.id} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.type === 'player' && linkNames ? <PlayerName name={a.name} position={a.position} sleeperId={a.sleeperId} /> : a.name}
            {a.type === 'player' && <span style={{ color: MUTED, fontSize: 10, marginLeft: 4 }}>{a.position}{a.age ? ` ${a.age.toFixed(0)}` : ''}</span>}
          </span>
          <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{fmt(a.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── One suggested version of the trade ──────────────────────────────────

export function VariantCard({ rank, variant, youName = 'you', themName, giveHead, getHead, onUse, useLabel = 'Make this the offer', onLoad, extra }: {
  rank: number; variant: Variant; youName?: string; themName: string; giveHead?: string; getHead?: string;
  onUse: () => void; useLabel?: string; onLoad?: () => void; extra?: ReactNode;
}) {
  const ev = variant.eval;
  return (
    <div style={{ background: 'var(--bg-tertiary)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11, color: MUTED }}>#{rank}</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: VERDICT_COLOR[ev.verdict] }}>
          {VERDICT_LABEL[ev.verdict]} <span style={{ fontWeight: 500, fontSize: 11, color: MUTED }}>· {ev.diff === 0 ? 'even' : `${ev.diff > 0 ? youName : themName} +${fmt(Math.abs(ev.diff))}`}</span>
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        {variant.edits.map((e, i) => <div key={i}>{describeEdit(e, themName, youName)}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <PackageList xs={variant.offer.give} color={GIVE_COLOR} head={giveHead ?? (youName === 'you' ? 'You give' : `${youName} sends`)} />
        <PackageList xs={variant.offer.get} color={GET_COLOR} head={getHead ?? (youName === 'you' ? 'You get' : `${themName} sends`)} />
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {ev.tags.map((t) => <Tag key={t} text={t} />)}
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="format-tab" onClick={onUse} style={btn}>{useLabel}</button>
        {onLoad && <button className="format-tab" onClick={onLoad} style={btn}>Open in calculator</button>}
        {extra}
      </div>
    </div>
  );
}
