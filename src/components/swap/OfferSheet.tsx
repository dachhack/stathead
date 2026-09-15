/**
 * OfferSheet — one version of a trade drawn as a ticket. The front of the
 * sheet is the trade itself: the two packages with big headshots, the value
 * balance, the author's pitch (clamped), the stamp for where it stands from
 * the reader's seat (DEAL, YOUR CALL, PASSED, COUNTERED, FINAL…) and the
 * primary actions. Everything else — lineup read, tags, votes, the note
 * thread and secondary actions — folds behind a Details toggle so a manager
 * who just wants to size up the pieces is not reading a form.
 *
 * `primary` renders on the front (accept / pass / counter); `children` render
 * inside Details (revise, final, withdraw, per-version notes).
 */

import { useState, type ReactNode } from 'react';
import { PlayerName } from '../PlayerName';
import { teamLogoUrl } from '../../lib/teamLogo';
import { lookupBySleeperId, type CrosswalkIndex } from '../../lib/playerLookup';
import { optionStatus, type Meet, type MeetEvent, type MeetOption, type Role, type Vote } from '../../lib/swapMeetCore';
import type { FinisherAsset, OfferEval } from '../../lib/tradeFinisher';
import { GIVE_COLOR, GET_COLOR, MUTED, VERDICT_COLOR, VERDICT_LABEL, fmt, signed, sumValue } from './offerStyle';

export interface SheetNames { P: string; Q: string; Ps: string; Qs: string }

interface Props {
  meet: Meet;
  option: MeetOption;
  /** 1-based version number as shown to both sides. */
  index: number;
  viewer: Role;
  names: SheetNames;
  ev: OfferEval | null;
  /** The proposer's full read (lineup deltas); the partner's page is a pitch. */
  full: boolean;
  tags: string[];
  crosswalk: CrosswalkIndex | null;
  thread: MeetEvent[];
  spotlight?: 'deal' | 'closest' | null;
  /** The other side's events since the reader last looked, when any touch
   *  this version: a New badge on the sheet and a mark on each new note. */
  fresh?: MeetEvent[] | null;
  when: (iso: string) => string;
  /** Front-of-sheet actions: the decision buttons. */
  primary?: ReactNode;
  /** Secondary actions, shown inside Details. */
  children?: ReactNode;
}

const STAMP: Record<string, { text: string; color: string }> = {
  agreed: { text: 'Deal', color: '#22c55e' },
  withdrawn: { text: 'Withdrawn', color: '#64748b' },
  countered: { text: 'Countered', color: '#f59e0b' },
  declined: { text: 'Passed', color: '#ef4444' },
  passed: { text: 'You passed', color: '#ef4444' },
  accepted: { text: 'Your call', color: '#00d4aa' },
  awaiting: { text: 'Waiting', color: '#94a3b8' },
};

export function OfferSheet({ meet, option: o, index, viewer, names, ev, full, tags, crosswalk, thread, spotlight, fresh, when, primary, children }: Props) {
  const { Ps, Qs } = names;
  const [open, setOpen] = useState(false);
  const status = optionStatus(meet, o, viewer);
  const authorColor = o.by === 'proposer' ? GIVE_COLOR : GET_COLOR;
  const author = o.by === 'proposer' ? Ps : Qs;
  const counterIdx = o.counterOf ? meet.options.findIndex((x) => x.id === o.counterOf) + 1 : 0;
  const stamp = STAMP[status];
  const stampText = status === 'declined' ? `${viewer === 'proposer' ? Qs : Ps} passed` : stamp?.text;
  const isAgreed = status === 'agreed';
  const voted = [o.proposerVote, o.partnerVote].filter(Boolean).length;
  const isNew = (e: MeetEvent) => !!fresh?.some((f) => f.id === e.id);
  const newNotes = thread.filter(isNew).length;
  const summary = [
    thread.length ? `${thread.length} note${thread.length === 1 ? '' : 's'}${newNotes ? ` (${newNotes} new)` : ''}` : null,
    voted ? `${voted} vote${voted === 1 ? '' : 's'}` : 'no votes yet',
    full && ev ? 'lineup read' : null,
    tags.length ? `${tags.length} tag${tags.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`sm-sheet${isAgreed ? ' sm-sheet-deal' : ''}${o.withdrawn ? ' sm-sheet-withdrawn' : ''}${spotlight === 'closest' ? ' sm-sheet-closest' : ''}${fresh?.length ? ' sm-sheet-fresh' : ''}`}
      style={{ ['--author' as string]: authorColor }}>
      {/* Header strip */}
      <div className="sm-sheet-head">
        <div className="sm-sheet-v">v{index}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
            <span style={{ color: authorColor, fontWeight: 700 }}>{author}</span>
            <span style={{ color: MUTED }}>{counterIdx ? `↩ counter to v${counterIdx} · ` : ''}{when(o.at)}{o.rev > 1 ? ` · revised ×${o.rev - 1}` : ''}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
            {fresh && fresh.length > 0 && <span className="sm-badge sm-badge-new">New</span>}
            {spotlight === 'deal' && <span className="sm-badge" style={{ color: '#22c55e', borderColor: '#22c55e' }}>Agreed by both sides</span>}
            {spotlight === 'closest' && !isAgreed && <span className="sm-badge" style={{ color: '#00d4aa', borderColor: '#00d4aa' }}>Closest to a deal</span>}
            {o.final && <span className="sm-badge" style={{ color: '#fbbf24', borderColor: '#fbbf24' }}>Final offer</span>}
          </div>
        </div>
        {stamp && <div className="sm-stamp" style={{ color: stamp.color, borderColor: stamp.color }}>{stampText}</div>}
      </div>

      {/* The pieces — the point of the sheet */}
      <TradeFront give={o.give} get={o.get} names={names} ev={ev} crosswalk={crosswalk} />

      {o.rationale && (
        <div className={`sm-pitch${open ? '' : ' sm-pitch-clamp'}`}>
          <span className="sm-pitch-who" style={{ color: authorColor }}>{author}</span>
          <span>“{o.rationale}”</span>
        </div>
      )}

      {primary && <div className="sm-primary">{primary}</div>}

      <button type="button" className="sm-details-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sm-details-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        {open ? 'Hide details' : 'Details'}
        {!open && <span style={{ color: MUTED, fontWeight: 500 }}> · {summary}</span>}
      </button>

      {open && (
        <div className="sm-details">
          {ev && full && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {Ps} lineup <strong style={{ color: ev.myLineupDelta >= 0 ? '#22c55e' : '#ef4444' }}>{signed(ev.myLineupDelta)}</strong>
              {' · '}{Qs} lineup <strong style={{ color: ev.partnerLineupDelta >= 0 ? '#22c55e' : '#ef4444' }}>{signed(ev.partnerLineupDelta)}</strong>
            </div>
          )}
          {tags.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {tags.map((t) => <span key={t} className="sm-tag">{t}</span>)}
            </div>
          )}

          <div className="sm-votes">
            <VoteChip name={Ps} v={o.proposerVote} />
            <VoteChip name={Qs} v={o.partnerVote} />
          </div>

          {thread.length > 0 && (
            <div className="sm-thread">
              {thread.map((e) => (
                <div key={e.id} className={`sm-note${isNew(e) ? ' sm-note-new' : ''}`}>
                  <span style={{ color: e.by === 'proposer' ? GIVE_COLOR : GET_COLOR, fontWeight: 700 }}>{e.by === 'proposer' ? Ps : Qs}</span>
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap' }}>
                    {e.kind === 'vote' ? (e.vote === 'yes' ? '✓ would accept — ' : e.vote === 'no' ? '✗ pass — ' : '') : e.kind === 'revise' ? '✎ revised — ' : e.kind === 'final' ? '★ ' : ''}{e.text ?? ''}
                  </span>
                  <span style={{ color: MUTED, fontSize: 10 }}>{when(e.at)}</span>
                </div>
              ))}
            </div>
          )}

          {children && <div className="sm-actions">{children}</div>}
        </div>
      )}
    </div>
  );
}

/** The front of a sheet without the sheet: the two packages with headshots
 *  and the value balance bar with the verdict. The meet page draws every
 *  version with it; the composer draws each candidate with it so the cards a
 *  proposer picks from look like the sheets their partner will see. */
export function TradeFront({ give: giveXs, get: getXs, names, ev, crosswalk, giveHead, getHead }: {
  give: FinisherAsset[]; get: FinisherAsset[]; names: SheetNames; ev: OfferEval | null; crosswalk: CrosswalkIndex | null;
  giveHead?: string; getHead?: string;
}) {
  const { P, Q, Ps, Qs } = names;
  const give = sumValue(giveXs), get = sumValue(getXs);
  const share = give + get > 0 ? give / (give + get) : 0.5;
  return (
    <>
      <div className="sm-sheet-body">
        <Package head={giveHead ?? `${Ps} sends`} color={GIVE_COLOR} xs={giveXs} crosswalk={crosswalk} />
        <div className="sm-swap-glyph" aria-hidden>⇄</div>
        <Package head={getHead ?? `${Qs} sends`} color={GET_COLOR} xs={getXs} crosswalk={crosswalk} />
      </div>

      <div className="sm-balance" title={`${P} sends ${fmt(give)} of value, ${Q} sends ${fmt(get)}`}>
        <div className="sm-balance-bar">
          <div style={{ width: `${share * 100}%`, background: GIVE_COLOR }} />
          <div style={{ flex: 1, background: GET_COLOR }} />
          <div className="sm-balance-mid" />
        </div>
        <div className="sm-balance-legend">
          <span style={{ color: GIVE_COLOR }}>{fmt(give)}</span>
          {ev ? (
            <span style={{ color: VERDICT_COLOR[ev.verdict], fontWeight: 800 }}>
              {VERDICT_LABEL[ev.verdict]}
              <span style={{ color: MUTED, fontWeight: 500 }}> · {ev.diff === 0 ? 'even' : `${ev.diff > 0 ? Ps : Qs} +${fmt(Math.abs(ev.diff))} (${ev.fairnessPct.toFixed(0)}%)`}</span>
              {!ev.legal && <span style={{ color: '#ef4444', fontWeight: 600 }}> · {ev.illegalReason}</span>}
            </span>
          ) : <span style={{ color: MUTED }}>value</span>}
          <span style={{ color: GET_COLOR }}>{fmt(get)}</span>
        </div>
      </div>
    </>
  );
}

function VoteChip({ name, v }: { name: string; v: Vote | null }) {
  const color = v === 'yes' ? '#22c55e' : v === 'no' ? '#ef4444' : MUTED;
  return (
    <span className="sm-vote" style={{ color, borderColor: v ? color : 'var(--border)' }}>
      <span style={{ fontWeight: 800 }}>{v === 'yes' ? '✓' : v === 'no' ? '✗' : '·'}</span> {name}: {v === 'yes' ? 'would accept' : v === 'no' ? 'pass' : 'undecided'}
    </span>
  );
}

function Package({ head, color, xs, crosswalk }: { head: string; color: string; xs: FinisherAsset[]; crosswalk: CrosswalkIndex | null }) {
  return (
    <div className="sm-pkg" style={{ ['--side' as string]: color }}>
      <div className="sm-pkg-head">
        <span>{head}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(sumValue(xs))}</span>
      </div>
      {xs.map((a) => <AssetRow key={a.id} a={a} crosswalk={crosswalk} />)}
    </div>
  );
}

function AssetRow({ a, crosswalk }: { a: FinisherAsset; crosswalk: CrosswalkIndex | null }) {
  const espn = a.type === 'player' && a.sleeperId && crosswalk ? lookupBySleeperId(crosswalk, a.sleeperId)?.espn_id : undefined;
  const headshot = espn ? `https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${espn}.png&w=160&h=116` : null;
  const initials = a.type === 'pick' ? `R${a.pick?.round ?? ''}` : a.name.split(' ').map((w) => w[0]).join('').slice(0, 2);
  return (
    <div className="sm-asset">
      <div className={`sm-avatar ${a.type === 'player' ? `pos-${a.position}` : 'sm-avatar-pick'}`}>
        {headshot ? <img src={headshot} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} /> : null}
        <span>{initials}</span>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="sm-asset-name">
          {a.type === 'player' ? <PlayerName name={a.name} position={a.position} sleeperId={a.sleeperId} /> : a.name}
        </div>
        <div className="sm-asset-meta">
          {a.type === 'player' ? (
            <>
              <span className={`pos-badge pos-${a.position}`}>{a.position}</span>
              {a.team && <img className="sm-team" src={teamLogoUrl(a.team)} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />}
              {a.team && <span>{a.team}</span>}
              {a.age ? <span>· {a.age.toFixed(0)} yrs</span> : null}
            </>
          ) : <span>Rookie pick · {a.pick?.season ?? ''}</span>}
        </div>
      </div>
      <div className="sm-asset-value">{fmt(a.value)}</div>
    </div>
  );
}
