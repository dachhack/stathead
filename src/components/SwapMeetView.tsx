/**
 * Swap Meet by StatHead — the shared negotiation page (`#/swap/<id>?k=…`).
 *
 * Two seats at one table. The PROPOSER sees the full finisher read: both
 * rosters' needs, and every version with fairness, both lineups' deltas and
 * every tag. The PARTNER (and anyone with a bare link) sees a pitch: the
 * packages, the values, and only what each version does for the partner —
 * never the proposer's gains or holes. Both seats vote, note, counter,
 * revise, withdraw and mark a version final; the page tells each seat whose
 * move it is, which version is closest to a deal, whether the other side has
 * opened their link, and what they did since you last looked (from the read
 * receipt the worker kept before this visit; anything that arrives while the
 * page polls is marked the same way). The link's key decides who you are; a
 * bare link is read-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchMeet, sendAction, meetUrl, copyText, rememberMeet, listMeets } from '../lib/swapMeet';
import {
  generalNotes, optionNotes, optionStatus, whoseMove, bestCandidate, chatSummary, newSince, describeNewSince, isManualMeet,
  type Meet, type MeetAction, type MeetOption, type Role,
} from '../lib/swapMeetCore';
import {
  computeNeeds, evaluateOffer, suggestFinishes, nameTags, partnerPositives, valueOnlyEval, isFullEval, boardAssets, LATER_DAYS,
  type AnyEval, type EvalContext, type FinisherAsset, type Offer, type OfferEval, type Variant,
} from '../lib/tradeFinisher';
import { fetchDynastyRankingsForDisplay } from '../data';
import { lookupByNamePos } from '../lib/playerLookup';
import type { TepLevel } from '../lib/dynastyForecast';
import { useCrosswalk } from '../hooks/useCrosswalk';
import { AssetColumn, NeedsCard, OfferVerdict, VariantCard } from './swap/OfferParts';
import { BoardPicker } from './swap/BoardPicker';
import { OfferSheet, TradeFront } from './swap/OfferSheet';
import { GIVE_COLOR, GET_COLOR, MUTED, shortName } from './swap/offerStyle';

interface Props {
  id: string;
  keyParam: string | null;
  onBack: () => void;
}

const btn = { padding: '4px 10px', fontSize: 12 } as const;
const POLL_MS = 30_000;

const when = (iso: string) => {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

interface Editor {
  baseOptionId: string | null;   // revising this option (author only) …
  fromOptionId: string | null;   // … or countering from it (new option)
  giveIds: string[];
  getIds: string[];
  rationale: string;
  final: boolean;
}

export function SwapMeetView({ id, keyParam, onBack }: Props) {
  const [meet, setMeet] = useState<Meet | null>(null);
  const [role, setRole] = useState<Role>('viewer');
  const [partnerKey, setPartnerKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [optionNote, setOptionNote] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<Editor | null>(null);
  const [giveFilter, setGiveFilter] = useState('ALL');
  const [getFilter, setGetFilter] = useState('ALL');
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const [needsOpen, setNeedsOpen] = useState(false);
  const lastUpdated = useRef<string | null>(null);
  // "New since you last looked": the read receipt from before this visit, set
  // once by the first load and advanced only when the reader dismisses the
  // strip — so a counter that lands while the page polls stays marked.
  const [since, setSince] = useState<string | null | undefined>(undefined);
  const { index: crosswalk } = useCrosswalk();
  // A manual meet has no rosters: counters pick from the dynasty board, and
  // every evaluation is value-only.
  const manual = meet ? isManualMeet(meet) : false;
  const [board, setBoard] = useState<FinisherAsset[]>([]);
  useEffect(() => {
    if (!manual || !meet) return;
    let alive = true;
    fetchDynastyRankingsForDisplay(meet.league.format)
      .then((rows) => { if (alive) setBoard(boardAssets(rows, meet.league.format === 'superflex', meet.league.tep as TepLevel, (n, p) => (crosswalk ? lookupByNamePos(crosswalk, n, p)?.sleeper_id : null))); })
      .catch(() => { /* the editor says the board is unavailable */ });
    return () => { alive = false; };
  }, [manual, meet, crosswalk]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetchMeet(id, keyParam);
      // Skip re-renders (and editor resets) when nothing moved.
      if (lastUpdated.current !== res.meet.updatedAt) {
        lastUpdated.current = res.meet.updatedAt;
        setMeet(res.meet);
      }
      setRole(res.role);
      if (res.partnerKey) setPartnerKey(res.partnerKey);
      // A first visit (or an older worker) has no lastSeen: fall back to the
      // stamp the worker just wrote, so nothing reads as new on load but
      // anything that lands while the page is open still does.
      setSince((s) => (s !== undefined ? s : (res.lastSeen ?? (res.role === 'viewer' ? null : res.meet.seen?.[res.role] ?? null))));
      setError(null);
      if (keyParam && (res.role === 'proposer' || res.role === 'partner')) {
        const known = listMeets().find((h) => h.id === id);
        rememberMeet({ id, key: keyParam, role: res.role, title: res.meet.title, at: res.meet.createdAt, partnerKey: res.partnerKey ?? known?.partnerKey });
      }
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [id, keyParam]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') load(true); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const act = async (label: string, action: MeetAction) => {
    if (!keyParam) return;
    setBusy(label);
    try {
      const res = await sendAction(id, keyParam, action);
      lastUpdated.current = res.meet.updatedAt;
      setMeet(res.meet);
      setRole(res.role);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
      window.setTimeout(() => setToast(null), 5000);
    } finally {
      setBusy(null);
    }
  };
  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 3500); };

  // ── Derived: teams, needs, evaluation in the proposer's frame ─────────
  const proposerTeam = useMemo(() => meet?.teams.find((t) => t.rosterId === meet.proposer.rosterId) ?? null, [meet]);
  const partnerTeam = useMemo(() => meet?.teams.find((t) => t.rosterId === meet.partner.rosterId) ?? null, [meet]);
  const proposerNeeds = useMemo(() => (meet && proposerTeam ? computeNeeds(proposerTeam, meet.teams, meet.league.rosterPositions) : null), [meet, proposerTeam]);
  const partnerNeeds = useMemo(() => (meet && partnerTeam ? computeNeeds(partnerTeam, meet.teams, meet.league.rosterPositions) : null), [meet, partnerTeam]);
  const ctx = useMemo<EvalContext | null>(() => (meet && proposerNeeds && partnerNeeds
    ? { rosterPositions: meet.league.rosterPositions, myGoal: meet.proposer.goal, partnerGoal: meet.partner.goal, myNeeds: proposerNeeds, partnerNeeds }
    : null), [meet, proposerNeeds, partnerNeeds]);

  const evalOption = useCallback((o: Offer): AnyEval | null => {
    if (!o.give.length || !o.get.length) return null;
    if (manual) return valueOnlyEval(o);
    return ctx && proposerTeam && partnerTeam ? evaluateOffer(o, proposerTeam, partnerTeam, ctx) : null;
  }, [ctx, proposerTeam, partnerTeam, manual]);

  // Pieces a manual meet can trade: what is already on the table (frozen
  // values) first, then the board.
  const manualPool = useMemo(() => {
    const m = new Map<string, FinisherAsset>();
    if (meet) for (const o of meet.options) for (const a of [...o.give, ...o.get]) m.set(a.id, a);
    for (const a of board) if (!m.has(a.id)) m.set(a.id, a);
    return m;
  }, [meet, board]);
  const manualBoard = useMemo(() => [...manualPool.values()], [manualPool]);

  const fresh = useMemo(() => (meet ? newSince(meet, role, since) : null), [meet, role, since]);
  const freshCount = fresh?.count ?? 0;
  useEffect(() => {
    const base = 'Swap Meet by StatHead';
    document.title = freshCount ? `(${freshCount}) ${base}` : base;
    return () => { document.title = 'StatHead - NFL Fantasy Workbench'; };
  }, [freshCount]);

  const P = meet?.proposer.teamName ?? 'Proposer';
  const Q = meet?.partner.teamName ?? 'Partner';
  const Ps = shortName(P), Qs = shortName(Q);
  const names = { P, Q, Ps, Qs };
  const myName = role === 'proposer' ? P : role === 'partner' ? Q : null;
  const theirShort = role === 'partner' ? Ps : Qs;
  // Only the proposer gets the full read; the partner's page is a pitch.
  const full = role === 'proposer';
  const sheetTags = useCallback((ev: OfferEval, o: Offer): string[] => {
    if (!partnerNeeds) return [];
    if (full) return nameTags(ev.tags.filter((t) => !t.startsWith('Illegal')), Ps, Qs);
    const tags = partnerPositives(ev, partnerNeeds, o);
    return role === 'partner' ? tags : nameTags(tags, Qs, Ps);
  }, [partnerNeeds, role, full, Ps, Qs]);

  // ── Editor (counter / revise / new) ───────────────────────────────────
  const editorOffer = useMemo<Offer>(() => ({
    give: (editor?.giveIds ?? []).map((x) => (manual ? manualPool.get(x) : proposerTeam?.assets.find((a) => a.id === x))).filter((a): a is FinisherAsset => !!a),
    get: (editor?.getIds ?? []).map((x) => (manual ? manualPool.get(x) : partnerTeam?.assets.find((a) => a.id === x))).filter((a): a is FinisherAsset => !!a),
  }), [editor, proposerTeam, partnerTeam, manual, manualPool]);
  const editorEval = useMemo(() => (editor ? evalOption(editorOffer) : null), [editor, editorOffer, evalOption]);

  // Finishes from the editing side's point of view: the partner's counters
  // are ranked on the partner's goal, then mapped back into the proposer frame.
  const editorVariants = useMemo<Variant[]>(() => {
    if (!editor || !ctx || !proposerTeam || !partnerTeam || manual) return [];
    if (role === 'partner') {
      const flipped: EvalContext = { ...ctx, myGoal: ctx.partnerGoal, partnerGoal: ctx.myGoal, myNeeds: ctx.partnerNeeds, partnerNeeds: ctx.myNeeds };
      const vs = suggestFinishes({ give: editorOffer.get, get: editorOffer.give }, partnerTeam, proposerTeam, flipped, { max: 6 });
      return vs.map((v) => {
        const offer = { give: v.offer.get, get: v.offer.give };
        const ev = evalOption(offer);
        return { offer, edits: v.edits.map((e) => ({ ...e, side: e.side === 'give' ? 'get' : 'give' } as typeof e)), eval: isFullEval(ev) ? ev : v.eval };
      });
    }
    return suggestFinishes(editorOffer, proposerTeam, partnerTeam, ctx, { max: 6 });
  }, [editor, ctx, proposerTeam, partnerTeam, role, editorOffer, evalOption, manual]);

  const openEditor = (from: MeetOption | null, revise: boolean) => {
    setEditor({
      baseOptionId: revise && from ? from.id : null,
      fromOptionId: !revise && from ? from.id : null,
      giveIds: from ? from.give.map((a) => a.id) : [],
      getIds: from ? from.get.map((a) => a.id) : [],
      rationale: revise && from ? from.rationale : '',
      final: revise && from ? from.final === true : false,
    });
    window.setTimeout(() => document.getElementById('sm-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  const toggleEditor = (side: 'give' | 'get', assetId: string) => setEditor((e) => {
    if (!e) return e;
    const ids = side === 'give' ? e.giveIds : e.getIds;
    const next = ids.includes(assetId) ? ids.filter((x) => x !== assetId) : [...ids, assetId];
    return side === 'give' ? { ...e, giveIds: next } : { ...e, getIds: next };
  });
  const submitEditor = async () => {
    if (!editor || !editorOffer.give.length || !editorOffer.get.length) return;
    if (editor.baseOptionId) {
      await act('revise', { type: 'revise', optionId: editor.baseOptionId, give: editorOffer.give, get: editorOffer.get, rationale: editor.rationale, final: editor.final });
    } else {
      await act('option', { type: 'option', give: editorOffer.give, get: editorOffer.get, rationale: editor.rationale, counterOf: editor.fromOptionId, final: editor.final });
    }
    setEditor(null);
  };

  const copy = async (label: string, text: string) => {
    const ok = await copyText(text);
    flash(ok ? `${label} copied.` : `Copy failed — ${text.slice(0, 80)}…`);
  };

  // ── Render ────────────────────────────────────────────────────────────
  if (loading) return <div className="loading"><div className="spinner" /><div className="loading-text">Opening the Swap Meet…</div></div>;
  if (error || !meet || !proposerTeam || !partnerTeam || !proposerNeeds || !partnerNeeds) {
    return (
      <div style={{ padding: 24 }}>
        <button onClick={onBack} className="format-tab" style={btn}>← Back to StatHead</button>
        <div className="empty-state" style={{ marginTop: 16 }}>
          <h3>Swap Meet not found</h3>
          <p>{error ?? 'This meet could not be loaded.'} Meets expire after 120 days of quiet.</p>
        </div>
      </div>
    );
  }

  const canAct = role === 'proposer' || role === 'partner';
  const open = meet.status !== 'closed';
  const move = whoseMove(meet);
  const best = bestCandidate(meet);
  const agreed = meet.status === 'agreed' ? best : null;
  const withdrawnCount = meet.options.filter((o) => o.withdrawn).length;
  const notes = generalNotes(meet);
  const myVote = (o: MeetOption) => (role === 'proposer' ? o.proposerVote : role === 'partner' ? o.partnerVote : null);
  const theirSeen = role === 'proposer' ? meet.seen?.partner : role === 'partner' ? meet.seen?.proposer : null;
  const link = keyParam ? meetUrl(id, keyParam) : meetUrl(id);

  // The table: the deal (or the closest thing to one) first, then newest first.
  const ordered = [...meet.options]
    .map((o, i) => ({ o, i: i + 1 }))
    .filter(({ o }) => showWithdrawn || !o.withdrawn)
    .sort((a, b) => (Number(b.o.id === best?.id) - Number(a.o.id === best?.id)) || b.o.at.localeCompare(a.o.at));

  const voteBtn = (o: MeetOption, v: 'yes' | 'no') => {
    const mine = myVote(o);
    const on = mine === v;
    return (
      <button className={`format-tab ${on ? 'active' : ''}`} disabled={busy != null}
        onClick={() => act('vote', { type: 'vote', optionId: o.id, vote: on ? null : v, text: optionNote[o.id] || undefined }).then(() => setOptionNote({ ...optionNote, [o.id]: '' }))}
        style={btn}>
        {v === 'yes' ? (on ? '✓ I\'d accept' : 'I\'d accept') : (on ? '✗ Passed' : 'Pass')}
      </button>
    );
  };

  return (
    <div className="sm-page" style={{ padding: '0 16px 32px', maxWidth: 1180, margin: '0 auto' }}>
      <div className="sm-brand">
        <button onClick={onBack} className="format-tab" style={btn}>← StatHead</button>
        <h2>Swap Meet <span>by StatHead</span></h2>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>
          <span style={{ color: GIVE_COLOR }}>{P}</span> <span style={{ color: MUTED }}>⇄</span> <span style={{ color: GET_COLOR }}>{Q}</span>
        </h3>
        <span style={{ fontSize: 12, color: MUTED }}>{meet.league.name} · {meet.league.format === 'superflex' ? 'Superflex' : '1QB'}{meet.league.tep ? ` TE+${'+'.repeat(meet.league.tep - 1)}` : ''}{meet.league.isDynasty ? ' · dynasty' : ''}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {myName ? <>You are <strong style={{ color: role === 'proposer' ? GIVE_COLOR : GET_COLOR }}>{myName}</strong>.</> : <>Read-only view. Ask either manager for their link to take part.</>}
        {keyParam && canAct && <button className="format-tab" onClick={() => copy('Your link', meetUrl(id, keyParam))} style={{ padding: '2px 8px', fontSize: 11 }}>Copy my link</button>}
        {role === 'proposer' && partnerKey && <button className="format-tab" onClick={() => copy(`${Qs}'s link`, meetUrl(id, partnerKey))} style={{ padding: '2px 8px', fontSize: 11 }}>Copy {Qs}'s link</button>}
        <button className="format-tab" onClick={() => copy('Summary', chatSummary(meet, role === 'proposer' && partnerKey ? meetUrl(id, partnerKey) : link))} style={{ padding: '2px 8px', fontSize: 11 }}>Copy summary for chat</button>
        <button className="format-tab" onClick={() => load(true)} style={{ padding: '2px 8px', fontSize: 11 }}>Refresh</button>
        <span style={{ color: MUTED, fontSize: 11 }}>updated {when(meet.updatedAt)}</span>
        {toast && <span style={{ color: '#22c55e', fontSize: 11 }}>{toast}</span>}
      </div>

      {/* Move banner: tailored to the seat */}
      <div className={`sm-move sm-move-${meet.status === 'agreed' ? 'deal' : meet.status === 'closed' ? 'closed' : move === role ? 'yours' : 'theirs'}`}>
        {meet.status === 'agreed' && agreed ? (
          <>
            <strong>Deal.</strong> Both sides would take v{meet.options.indexOf(agreed) + 1}: {Ps} sends {agreed.give.map((a) => a.name).join(', ')} for {agreed.get.map((a) => a.name).join(', ')}. Send it in Sleeper.
          </>
        ) : meet.status === 'closed' ? (
          <>This meet is closed.</>
        ) : canAct && move === role ? (
          <>
            <strong>Your move.</strong> {theirShort}'s waiting on you — accept a version, pass with a note, or counter.
            {theirSeen ? <span style={{ color: MUTED }}> {theirShort} opened this {when(theirSeen)}.</span> : null}
          </>
        ) : canAct ? (
          <>
            <strong>Waiting on {theirShort}.</strong>
            {theirSeen ? <span style={{ color: MUTED }}> They opened this {when(theirSeen)}.</span> : <span style={{ color: MUTED }}> They haven't opened their link yet — resend it if it's been a while.</span>}
          </>
        ) : (
          <>Waiting on {move === 'proposer' ? Ps : Qs}.</>
        )}
      </div>

      {fresh && fresh.count > 0 && (
        <div className="sm-new">
          <span className="sm-new-dot" aria-hidden />
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>Since you last looked{since ? ` (${when(since)})` : ''}:</strong> {theirShort} {describeNewSince(meet, fresh) || 'made a move'}.
          </span>
          <button className="format-tab" onClick={() => setSince(meet.updatedAt)} style={{ padding: '2px 8px', fontSize: 11 }}>Got it</button>
        </div>
      )}

      {notes.length > 0 && (
        <div className="sm-thread" style={{ marginBottom: 12 }}>
          {notes.map((n) => (
            <div key={n.id} className={`sm-note${fresh?.events.some((e) => e.id === n.id) ? ' sm-note-new' : ''}`}>
              <span style={{ color: n.by === 'proposer' ? GIVE_COLOR : GET_COLOR, fontWeight: 700 }}>{n.by === 'proposer' ? Ps : Qs}</span>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap' }}>{n.text}</span>
              <span style={{ color: MUTED, fontSize: 10 }}>{when(n.at)}</span>
            </div>
          ))}
        </div>
      )}

      {full && !manual && (
        <details open={needsOpen} onToggle={(e) => setNeedsOpen((e.currentTarget as HTMLDetailsElement).open)} style={{ marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }}>Both rosters' needs (only you see this)</summary>
          <div className="tf-needs" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 8 }}>
            <NeedsCard team={proposerTeam} needs={proposerNeeds} goal={meet.proposer.goal} color={GIVE_COLOR} label="You" />
            <NeedsCard team={partnerTeam} needs={partnerNeeds} goal={meet.partner.goal} color={GET_COLOR} label="Partner" />
          </div>
        </details>
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', margin: '6px 0 8px' }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>On the table</h4>
        <span style={{ fontSize: 11, color: MUTED }}>
          {ordered.length} version{ordered.length === 1 ? '' : 's'}
          {manual ? ' · no league behind this meet: board values and the fairness verdict' : full ? ` · your full read; ${Qs} sees the packages, the values and what each version does for them` : ` · values and what each version does for ${role === 'partner' ? 'you' : Qs}`}
        </span>
        {withdrawnCount > 0 && <button className="format-tab" onClick={() => setShowWithdrawn(!showWithdrawn)} style={{ padding: '2px 8px', fontSize: 11 }}>{showWithdrawn ? 'Hide' : 'Show'} {withdrawnCount} withdrawn</button>}
        {canAct && open && !editor && <button className="format-tab active" onClick={() => openEditor(null, false)} style={{ padding: '2px 10px', fontSize: 11, marginLeft: 'auto' }}>+ New version</button>}
      </div>

      <div className="sm-options">
        {ordered.map(({ o, i }) => {
          const ev = evalOption({ give: o.give, get: o.get });
          const status = optionStatus(meet, o, role);
          const isAuthor = role === o.by;
          const actionable = canAct && open && !o.withdrawn && status !== 'agreed';
          return (
            <OfferSheet key={o.id} meet={meet} option={o} index={i} viewer={role} names={names} ev={ev} full={full}
              tags={isFullEval(ev) ? sheetTags(ev, { give: o.give, get: o.get }) : []} crosswalk={crosswalk}
              thread={optionNotes(meet, o.id).filter((e) => e.kind !== 'option')}
              spotlight={o.id === agreed?.id ? 'deal' : o.id === best?.id && meet.options.filter((x) => !x.withdrawn).length > 1 ? 'closest' : null}
              fresh={fresh?.optionIds.has(o.id) ? fresh.events : null}
              when={when}
              primary={actionable ? (
                <>
                  {!isAuthor && voteBtn(o, 'yes')}
                  {!isAuthor && voteBtn(o, 'no')}
                  {isAuthor && myVote(o) !== 'yes' && voteBtn(o, 'yes')}
                  <button className="format-tab" onClick={() => openEditor(o, false)} style={btn}>↩ Counter</button>
                </>
              ) : canAct && open && status === 'agreed' ? (
                <>
                  <button className="format-tab active" onClick={() => copy('Deal summary', chatSummary(meet, link))} style={btn}>Copy deal for chat</button>
                  {voteBtn(o, 'yes')}
                </>
              ) : null}>
              {actionable && (
                <>
                  {isAuthor && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button className="format-tab" onClick={() => openEditor(o, true)} style={btn}>Revise</button>
                      <button className={`format-tab ${o.final ? 'active' : ''}`} disabled={busy != null}
                        onClick={() => act('final', { type: 'revise', optionId: o.id, final: !o.final })} style={btn}>
                        {o.final ? '★ Final' : 'Mark final'}
                      </button>
                      <button className="format-tab" disabled={busy != null} onClick={() => act('withdraw', { type: 'withdraw', optionId: o.id })} style={btn}>Withdraw</button>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type="text" value={optionNote[o.id] ?? ''} onChange={(e) => setOptionNote({ ...optionNote, [o.id]: e.target.value })}
                      placeholder={isAuthor ? 'Add a note on this version' : 'Tell them what would work (sent with your vote, or on its own)'}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (optionNote[o.id] ?? '').trim()) { act('note', { type: 'note', optionId: o.id, text: optionNote[o.id] }).then(() => setOptionNote({ ...optionNote, [o.id]: '' })); } }}
                      style={{ flex: 1, minWidth: 0, fontSize: 12 }} />
                    <button className="format-tab" disabled={busy != null || !(optionNote[o.id] ?? '').trim()}
                      onClick={() => act('note', { type: 'note', optionId: o.id, text: optionNote[o.id] }).then(() => setOptionNote({ ...optionNote, [o.id]: '' }))} style={btn}>Note</button>
                  </div>
                </>
              )}
            </OfferSheet>
          );
        })}
      </div>

      {canAct && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
          {open && !editor && <button className="format-tab active" onClick={() => openEditor(null, false)} style={btn}>Propose a new version</button>}
          {open && role === 'proposer' && <button className="format-tab" disabled={busy != null} onClick={() => act('status', { type: 'status', status: 'closed' })} style={btn}>Close this meet</button>}
          {!open && role === 'proposer' && <button className="format-tab" disabled={busy != null} onClick={() => act('status', { type: 'status', status: 'open' })} style={btn}>Reopen</button>}
        </div>
      )}

      {editor && (
        <div id="sm-editor" className="sm-editor">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <h4 style={{ margin: 0, fontSize: 14 }}>
              {editor.baseOptionId ? `Revise v${meet.options.findIndex((o) => o.id === editor.baseOptionId) + 1}` : editor.fromOptionId ? `Counter to v${meet.options.findIndex((o) => o.id === editor.fromOptionId) + 1}` : 'New version'}
            </h4>
            <span style={{ fontSize: 11, color: MUTED }}>
              {manual ? 'Pick pieces off the dynasty board for either side (board values as of today; pieces already on the table keep the values they were opened with).' : `Tap assets on either roster. Suggested finishes below are ranked from ${myName}'s side of the table.`}
            </span>
          </div>
          {manual ? (
            <>
              {!board.length && <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Loading the dynasty board…</div>}
              <div className="tf-offer" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12, alignItems: 'start' }}>
                <BoardPicker title={`${Ps} sends`} color={GIVE_COLOR} board={manualBoard} selected={editor.giveIds} onToggle={(x) => toggleEditor('give', x)} />
                <BoardPicker title={`${Qs} sends`} color={GET_COLOR} board={manualBoard} selected={editor.getIds} onToggle={(x) => toggleEditor('get', x)} />
              </div>
              {(editorOffer.give.length > 0 || editorOffer.get.length > 0) && (
                <div className="sm-sheet" style={{ ['--author' as string]: role === 'partner' ? GET_COLOR : GIVE_COLOR, maxWidth: 640, marginTop: 10 }}>
                  <div className="sm-sheet-head"><div className="sm-sheet-v">?</div><div className="sm-file-line" style={{ flex: 1 }}>This version</div></div>
                  <TradeFront give={editorOffer.give} get={editorOffer.get} names={names} ev={editorEval} crosswalk={crosswalk} />
                </div>
              )}
            </>
          ) : (
            <div className="tf-offer" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', gap: 12, alignItems: 'start' }}>
              <AssetColumn title={`${Ps} sends`} color={GIVE_COLOR} assets={proposerTeam.assets} selected={editor.giveIds} filter={giveFilter} setFilter={setGiveFilter} onToggle={(x) => toggleEditor('give', x)} />
              <OfferVerdict evaluation={isFullEval(editorEval) ? editorEval : null} offer={editorOffer} youName={Ps} themName={Qs} heading="This version"
                showLineups={full} tags={!full && isFullEval(editorEval) ? sheetTags(editorEval, editorOffer) : undefined} />
              <AssetColumn title={`${Qs} sends`} color={GET_COLOR} assets={partnerTeam.assets} selected={editor.getIds} filter={getFilter} setFilter={setGetFilter} onToggle={(x) => toggleEditor('get', x)} />
            </div>
          )}
          <textarea value={editor.rationale} onChange={(e) => setEditor({ ...editor, rationale: e.target.value })} rows={2}
            placeholder={`Your pitch — why this works for ${role === 'proposer' ? Qs : Ps} too`}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, fontFamily: 'inherit', resize: 'vertical', marginTop: 8 }} />
          <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="format-tab active" disabled={busy != null || !editorOffer.give.length || !editorOffer.get.length} onClick={submitEditor} style={btn}>
              {editor.baseOptionId ? 'Save revision' : 'Put it on the table'}
            </button>
            <button className="format-tab" onClick={() => setEditor(null)} style={btn}>Cancel</button>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={editor.final} onChange={(e) => setEditor({ ...editor, final: e.target.checked })} />
              Final offer — this is as far as I go
            </label>
          </div>
          {editorVariants.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Suggested finishes</div>
              <div className="tf-variants" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
                {editorVariants.map((v, i) => (
                  <VariantCard key={i} rank={i + 1} variant={v} youName={Ps} themName={Qs} giveHead={`${Ps} sends`} getHead={`${Qs} sends`}
                    tags={sheetTags(v.eval, v.offer)}
                    useLabel="Use this" onUse={() => setEditor({ ...editor, giveIds: v.offer.give.map((a) => a.id), getIds: v.offer.get.map((a) => a.id) })} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {canAct && open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Note to {theirShort}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="text" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Anything not tied to one version"
              onKeyDown={(e) => { if (e.key === 'Enter' && noteText.trim()) act('note', { type: 'note', text: noteText }).then(() => setNoteText('')); }}
              style={{ flex: 1, minWidth: 0, fontSize: 12 }} />
            <button className="format-tab" disabled={busy != null || !noteText.trim()} onClick={() => act('note', { type: 'note', text: noteText }).then(() => setNoteText(''))} style={btn}>Send</button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 20, fontSize: 11, color: MUTED }}>
        Values are dynasty market values in the {manual ? 'chosen' : 'league\'s'} format{meet.league.tep ? ' with TE premium' : ''}{full && !manual ? '; lineup points are projected season points in the league\'s scoring' : ''}, from the snapshot taken when this meet was opened ({new Date(meet.createdAt).toLocaleDateString()}). Picks are priced on the board's Early / Mid / Late rows{manual ? '' : ' by projected draft slot'}.
        {manual ? ' No league is behind this meet, so the sheets show values and the fairness verdict only.' : ''}
        {!manual && ' '}{!manual && 'Each side\'s read weighs now'} (the change to the best weekly lineup, and whether a piece starts or sits) against later (dynasty value, where the {LATER_DAYS}-day forecast says it is heading, and age) by that team's goal: win-now leans on now, a rebuild on later.
      </div>
    </div>
  );
}
