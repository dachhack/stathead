/**
 * Swap Meet by StatHead — the shared negotiation page (`#/swap/<id>?k=…`).
 *
 * Both managers see the same thing: the two rosters' needs, every version of
 * the trade on the table with the finisher's fairness and lineup read, each
 * side's vote, the notes, and an editor to counter with a version of their
 * own (with suggested finishes from their side of the table). The link's key
 * decides who you are; a bare link is read-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchMeet, sendAction, meetUrl, copyText, rememberMeet, listMeets } from '../lib/swapMeet';
import { generalNotes, optionNotes, type Meet, type MeetAction, type MeetOption, type Role, type Vote } from '../lib/swapMeetCore';
import {
  computeNeeds, evaluateOffer, suggestFinishes, nameTags,
  type EvalContext, type FinisherAsset, type Offer, type OfferEval, type Variant,
} from '../lib/tradeFinisher';
import { AssetColumn, NeedsCard, OfferVerdict, PackageList, Tag, VariantCard } from './swap/OfferParts';
import { GIVE_COLOR, GET_COLOR, MUTED, VERDICT_COLOR, VERDICT_LABEL, fmt, signed, shortName } from './swap/offerStyle';

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
  const lastUpdated = useRef<string | null>(null);

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

  // ── Derived: teams, needs, evaluation in the proposer's frame ─────────
  const proposerTeam = useMemo(() => meet?.teams.find((t) => t.rosterId === meet.proposer.rosterId) ?? null, [meet]);
  const partnerTeam = useMemo(() => meet?.teams.find((t) => t.rosterId === meet.partner.rosterId) ?? null, [meet]);
  const proposerNeeds = useMemo(() => (meet && proposerTeam ? computeNeeds(proposerTeam, meet.teams, meet.league.rosterPositions) : null), [meet, proposerTeam]);
  const partnerNeeds = useMemo(() => (meet && partnerTeam ? computeNeeds(partnerTeam, meet.teams, meet.league.rosterPositions) : null), [meet, partnerTeam]);
  const ctx = useMemo<EvalContext | null>(() => (meet && proposerNeeds && partnerNeeds
    ? { rosterPositions: meet.league.rosterPositions, myGoal: meet.proposer.goal, partnerGoal: meet.partner.goal, myNeeds: proposerNeeds, partnerNeeds }
    : null), [meet, proposerNeeds, partnerNeeds]);

  const evalOption = useCallback((o: Offer): OfferEval | null => (
    ctx && proposerTeam && partnerTeam && o.give.length && o.get.length ? evaluateOffer(o, proposerTeam, partnerTeam, ctx) : null
  ), [ctx, proposerTeam, partnerTeam]);

  const P = meet?.proposer.teamName ?? 'Proposer';
  const Q = meet?.partner.teamName ?? 'Partner';
  const Ps = shortName(P), Qs = shortName(Q);
  const myName = role === 'proposer' ? P : role === 'partner' ? Q : null;

  // ── Editor (counter / revise) ─────────────────────────────────────────
  const editorOffer = useMemo<Offer>(() => ({
    give: (editor?.giveIds ?? []).map((x) => proposerTeam?.assets.find((a) => a.id === x)).filter((a): a is FinisherAsset => !!a),
    get: (editor?.getIds ?? []).map((x) => partnerTeam?.assets.find((a) => a.id === x)).filter((a): a is FinisherAsset => !!a),
  }), [editor, proposerTeam, partnerTeam]);
  const editorEval = useMemo(() => (editor ? evalOption(editorOffer) : null), [editor, editorOffer, evalOption]);

  // Finishes from the editing side's point of view: the partner's counters
  // are ranked on the partner's goal, then mapped back into the proposer frame.
  const editorVariants = useMemo<Variant[]>(() => {
    if (!editor || !ctx || !proposerTeam || !partnerTeam) return [];
    if (role === 'partner') {
      const flipped: EvalContext = { ...ctx, myGoal: ctx.partnerGoal, partnerGoal: ctx.myGoal, myNeeds: ctx.partnerNeeds, partnerNeeds: ctx.myNeeds };
      const vs = suggestFinishes({ give: editorOffer.get, get: editorOffer.give }, partnerTeam, proposerTeam, flipped, { max: 6 });
      return vs.map((v) => {
        const offer = { give: v.offer.get, get: v.offer.give };
        const ev = evalOption(offer);
        return { offer, edits: v.edits.map((e) => ({ ...e, side: e.side === 'give' ? 'get' : 'give' } as typeof e)), eval: ev ?? v.eval };
      });
    }
    return suggestFinishes(editorOffer, proposerTeam, partnerTeam, ctx, { max: 6 });
  }, [editor, ctx, proposerTeam, partnerTeam, role, editorOffer, evalOption]);

  const openEditor = (from: MeetOption | null, revise: boolean) => {
    setEditor({
      baseOptionId: revise && from ? from.id : null,
      fromOptionId: !revise && from ? from.id : null,
      giveIds: from ? from.give.map((a) => a.id) : [],
      getIds: from ? from.get.map((a) => a.id) : [],
      rationale: revise && from ? from.rationale : '',
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
      await act('revise', { type: 'revise', optionId: editor.baseOptionId, give: editorOffer.give, get: editorOffer.get, rationale: editor.rationale });
    } else {
      await act('option', { type: 'option', give: editorOffer.give, get: editorOffer.get, rationale: editor.rationale });
    }
    setEditor(null);
  };

  const copyLink = async (label: string, url: string) => {
    const ok = await copyText(url);
    setToast(ok ? `${label} copied.` : `Copy failed — the link is ${url}`);
    window.setTimeout(() => setToast(null), 3500);
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
  const options = meet.options.filter((o) => showWithdrawn || !o.withdrawn);
  const withdrawnCount = meet.options.filter((o) => o.withdrawn).length;
  const agreed = meet.agreedOptionId ? meet.options.find((o) => o.id === meet.agreedOptionId) : null;
  const notes = generalNotes(meet);
  const myVote = (o: MeetOption): Vote | null => (role === 'proposer' ? o.proposerVote : role === 'partner' ? o.partnerVote : null);

  const voteChip = (name: string, v: Vote | null) => (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'var(--bg-secondary)', color: v === 'yes' ? '#22c55e' : v === 'no' ? '#ef4444' : MUTED, fontWeight: 600 }}>
      {v === 'yes' ? '✓' : v === 'no' ? '✗' : '·'} {name}: {v === 'yes' ? 'would accept' : v === 'no' ? 'pass' : 'undecided'}
    </span>
  );

  return (
    <div className="sm-page" style={{ padding: '0 16px 32px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', padding: '12px 0 4px' }}>
        <button onClick={onBack} className="format-tab" style={btn}>← StatHead</button>
        <h2 style={{ margin: 0, fontSize: 20 }}>Swap Meet <span style={{ fontSize: 12, fontWeight: 500, color: MUTED }}>by StatHead</span></h2>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 17 }}>{meet.title}</h3>
        <span style={{ fontSize: 12, color: MUTED }}>{meet.league.name} · {meet.league.format === 'superflex' ? 'Superflex' : '1QB'}{meet.league.tep ? ` TE+${'+'.repeat(meet.league.tep - 1)}` : ''}{meet.league.isDynasty ? ' · dynasty' : ''}</span>
        <StatusPill status={meet.status} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {myName ? <>You are <strong style={{ color: role === 'proposer' ? GIVE_COLOR : GET_COLOR }}>{myName}</strong>.</> : <>Read-only view. Ask either manager for their link to take part.</>}
        {keyParam && canAct && <button className="format-tab" onClick={() => copyLink('Your link', meetUrl(id, keyParam))} style={{ padding: '2px 8px', fontSize: 11 }}>Copy my link</button>}
        {role === 'proposer' && partnerKey && <button className="format-tab" onClick={() => copyLink(`${Q}'s link`, meetUrl(id, partnerKey))} style={{ padding: '2px 8px', fontSize: 11 }}>Copy {Q}'s link</button>}
        <button className="format-tab" onClick={() => load(true)} style={{ padding: '2px 8px', fontSize: 11 }}>Refresh</button>
        <span style={{ color: MUTED, fontSize: 11 }}>updated {when(meet.updatedAt)}</span>
        {toast && <span style={{ color: '#22c55e', fontSize: 11 }}>{toast}</span>}
      </div>

      {agreed && (
        <div style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid #22c55e', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
          <strong style={{ color: '#22c55e' }}>Deal.</strong> Both sides would accept version #{meet.options.indexOf(agreed) + 1}
          {' '}— {P} sends {agreed.give.map((a) => a.name).join(', ')} for {agreed.get.map((a) => a.name).join(', ')}. Send it in Sleeper.
        </div>
      )}

      <div className="tf-needs" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginBottom: 14 }}>
        <NeedsCard team={proposerTeam} needs={proposerNeeds} goal={meet.proposer.goal} color={GIVE_COLOR} label={role === 'proposer' ? 'You' : 'Proposer'} />
        <NeedsCard team={partnerTeam} needs={partnerNeeds} goal={meet.partner.goal} color={GET_COLOR} label={role === 'partner' ? 'You' : 'Partner'} />
      </div>

      {notes.length > 0 && (
        <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {notes.map((n) => <NoteLine key={n.id} by={n.by === 'proposer' ? Ps : Qs} color={n.by === 'proposer' ? GIVE_COLOR : GET_COLOR} at={n.at} text={n.text ?? ''} />)}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', margin: '6px 0' }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>Versions on the table</h4>
        <span style={{ fontSize: 11, color: MUTED }}>{Ps} sends · {Qs} sends. Fairness and lineup reads are the finisher's, on the same league snapshot for both of you.</span>
        {withdrawnCount > 0 && <button className="format-tab" onClick={() => setShowWithdrawn(!showWithdrawn)} style={{ padding: '2px 8px', fontSize: 11 }}>{showWithdrawn ? 'Hide' : 'Show'} {withdrawnCount} withdrawn</button>}
      </div>

      <div className="sm-options" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 10 }}>
        {options.map((o) => {
          const n = meet.options.indexOf(o) + 1;
          const ev = evalOption({ give: o.give, get: o.get });
          const mine = myVote(o);
          const author = o.by === 'proposer' ? P : Q;
          const isAuthor = role === o.by;
          const thread = optionNotes(meet, o.id).filter((e) => !(e.kind === 'option'));
          const isAgreed = meet.agreedOptionId === o.id;
          return (
            <div key={o.id} style={{
              background: 'var(--bg-tertiary)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
              border: `1px solid ${isAgreed ? '#22c55e' : 'transparent'}`, opacity: o.withdrawn ? 0.55 : 1,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12 }}>
                  <strong>#{n}</strong> <span style={{ color: MUTED }}>by <span style={{ color: o.by === 'proposer' ? GIVE_COLOR : GET_COLOR }}>{author}</span> · {when(o.at)}{o.rev > 1 ? ` · revised ×${o.rev - 1}` : ''}{o.withdrawn ? ' · withdrawn' : ''}</span>
                </span>
                {ev && (
                  <span style={{ fontSize: 13, fontWeight: 800, color: VERDICT_COLOR[ev.verdict] }}>
                    {VERDICT_LABEL[ev.verdict]} <span style={{ fontWeight: 500, fontSize: 11, color: MUTED }}>· {ev.diff === 0 ? 'even' : `${ev.diff > 0 ? Ps : Qs} +${fmt(Math.abs(ev.diff))}`}</span>
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <PackageList xs={o.give} color={GIVE_COLOR} head={`${Ps} sends`} />
                <PackageList xs={o.get} color={GET_COLOR} head={`${Qs} sends`} />
              </div>
              {ev && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {Ps} lineup <strong style={{ color: ev.myLineupDelta >= 0 ? '#22c55e' : '#ef4444' }}>{signed(ev.myLineupDelta)}</strong>
                  {' · '}{Qs} lineup <strong style={{ color: ev.partnerLineupDelta >= 0 ? '#22c55e' : '#ef4444' }}>{signed(ev.partnerLineupDelta)}</strong>
                  {!ev.legal && <span style={{ color: '#ef4444' }}> · {ev.illegalReason}</span>}
                </div>
              )}
              {ev && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{nameTags(ev.tags.filter((t) => !t.startsWith('Illegal')), Ps, Qs).map((t) => <Tag key={t} text={t} />)}</div>}
              {o.rationale && (
                <div style={{ fontSize: 12, padding: '6px 8px', background: 'var(--bg-secondary)', borderRadius: 6, borderLeft: `3px solid ${o.by === 'proposer' ? GIVE_COLOR : GET_COLOR}` }}>
                  <span style={{ color: MUTED }}>{shortName(author)}: </span>{o.rationale}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {voteChip(Ps, o.proposerVote)}
                {voteChip(Qs, o.partnerVote)}
              </div>
              {thread.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {thread.map((e) => (
                    <NoteLine key={e.id} by={e.by === 'proposer' ? Ps : Qs} color={e.by === 'proposer' ? GIVE_COLOR : GET_COLOR} at={e.at}
                      text={`${e.kind === 'vote' ? (e.vote === 'yes' ? '✓ would accept — ' : e.vote === 'no' ? '✗ pass — ' : '') : e.kind === 'revise' ? '✎ revised — ' : ''}${e.text ?? ''}`} />
                  ))}
                </div>
              )}
              {canAct && !o.withdrawn && meet.status !== 'closed' && (
                <>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className={`format-tab ${mine === 'yes' ? 'active' : ''}`} disabled={busy != null}
                      onClick={() => act('vote', { type: 'vote', optionId: o.id, vote: mine === 'yes' ? null : 'yes', text: optionNote[o.id] || undefined }).then(() => setOptionNote({ ...optionNote, [o.id]: '' }))}
                      style={btn}>{mine === 'yes' ? '✓ I\'d accept' : 'I\'d accept'}</button>
                    <button className={`format-tab ${mine === 'no' ? 'active' : ''}`} disabled={busy != null}
                      onClick={() => act('vote', { type: 'vote', optionId: o.id, vote: mine === 'no' ? null : 'no', text: optionNote[o.id] || undefined }).then(() => setOptionNote({ ...optionNote, [o.id]: '' }))}
                      style={btn}>{mine === 'no' ? '✗ Pass' : 'Pass'}</button>
                    <button className="format-tab" onClick={() => openEditor(o, false)} style={btn}>Counter from this</button>
                    {isAuthor && <button className="format-tab" onClick={() => openEditor(o, true)} style={btn}>Revise</button>}
                    {isAuthor && <button className="format-tab" disabled={busy != null} onClick={() => act('withdraw', { type: 'withdraw', optionId: o.id })} style={btn}>Withdraw</button>}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type="text" value={optionNote[o.id] ?? ''} onChange={(e) => setOptionNote({ ...optionNote, [o.id]: e.target.value })}
                      placeholder="Note on this version (sent with your vote, or on its own)"
                      onKeyDown={(e) => { if (e.key === 'Enter' && (optionNote[o.id] ?? '').trim()) { act('note', { type: 'note', optionId: o.id, text: optionNote[o.id] }).then(() => setOptionNote({ ...optionNote, [o.id]: '' })); } }}
                      style={{ flex: 1, minWidth: 0, fontSize: 12 }} />
                    <button className="format-tab" disabled={busy != null || !(optionNote[o.id] ?? '').trim()}
                      onClick={() => act('note', { type: 'note', optionId: o.id, text: optionNote[o.id] }).then(() => setOptionNote({ ...optionNote, [o.id]: '' }))} style={btn}>Note</button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {canAct && meet.status !== 'closed' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
          {!editor && <button className="format-tab active" onClick={() => openEditor(null, false)} style={btn}>Propose a new version</button>}
          {role === 'proposer' && <button className="format-tab" disabled={busy != null} onClick={() => act('status', { type: 'status', status: 'closed' })} style={btn}>Close this meet</button>}
        </div>
      )}
      {canAct && meet.status === 'closed' && role === 'proposer' && (
        <div style={{ margin: '12px 0' }}><button className="format-tab" disabled={busy != null} onClick={() => act('status', { type: 'status', status: 'open' })} style={btn}>Reopen</button></div>
      )}

      {editor && (
        <div id="sm-editor" style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: '10px 14px', margin: '8px 0 16px', background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <h4 style={{ margin: 0, fontSize: 14 }}>{editor.baseOptionId ? `Revise version #${meet.options.findIndex((o) => o.id === editor.baseOptionId) + 1}` : editor.fromOptionId ? `Counter from #${meet.options.findIndex((o) => o.id === editor.fromOptionId) + 1}` : 'New version'}</h4>
            <span style={{ fontSize: 11, color: MUTED }}>Tap assets on either roster. Suggested finishes below are ranked from {myName}'s side.</span>
          </div>
          <div className="tf-offer" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', gap: 12, alignItems: 'start' }}>
            <AssetColumn title={`${Ps} sends`} color={GIVE_COLOR} assets={proposerTeam.assets} selected={editor.giveIds} filter={giveFilter} setFilter={setGiveFilter} onToggle={(x) => toggleEditor('give', x)} />
            <OfferVerdict evaluation={editorEval} offer={editorOffer} youName={Ps} themName={Qs} heading="This version" />
            <AssetColumn title={`${Qs} sends`} color={GET_COLOR} assets={partnerTeam.assets} selected={editor.getIds} filter={getFilter} setFilter={setGetFilter} onToggle={(x) => toggleEditor('get', x)} />
          </div>
          <textarea value={editor.rationale} onChange={(e) => setEditor({ ...editor, rationale: e.target.value })} rows={2}
            placeholder={`Your pitch — why this works for ${role === 'proposer' ? Q : P} too`}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, fontFamily: 'inherit', resize: 'vertical', marginTop: 8 }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="format-tab active" disabled={busy != null || !editorOffer.give.length || !editorOffer.get.length} onClick={submitEditor} style={btn}>
              {editor.baseOptionId ? 'Save revision' : 'Put it on the table'}
            </button>
            <button className="format-tab" onClick={() => setEditor(null)} style={btn}>Cancel</button>
          </div>
          {editorVariants.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Suggested finishes</div>
              <div className="tf-variants" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
                {editorVariants.map((v, i) => (
                  <VariantCard key={i} rank={i + 1} variant={v} youName={Ps} themName={Qs} giveHead={`${Ps} sends`} getHead={`${Qs} sends`}
                    useLabel="Use this" onUse={() => setEditor({ ...editor, giveIds: v.offer.give.map((a) => a.id), getIds: v.offer.get.map((a) => a.id) })} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {canAct && meet.status !== 'closed' && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Note to {role === 'proposer' ? Q : P}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="text" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Anything not tied to one version"
              onKeyDown={(e) => { if (e.key === 'Enter' && noteText.trim()) act('note', { type: 'note', text: noteText }).then(() => setNoteText('')); }}
              style={{ flex: 1, minWidth: 0, fontSize: 12 }} />
            <button className="format-tab" disabled={busy != null || !noteText.trim()} onClick={() => act('note', { type: 'note', text: noteText }).then(() => setNoteText(''))} style={btn}>Send</button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 20, fontSize: 11, color: MUTED }}>
        Values are dynasty market values in the league's format{meet.league.tep ? ' with TE premium' : ''}; lineup points are projected season points in the league's scoring, from the snapshot taken when this meet was opened ({new Date(meet.createdAt).toLocaleDateString()}). Picks are priced on the board's Early / Mid / Late rows by projected draft slot.
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Meet['status'] }) {
  const color = status === 'agreed' ? '#22c55e' : status === 'closed' ? MUTED : '#60a5fa';
  const label = status === 'agreed' ? 'Deal reached' : status === 'closed' ? 'Closed' : 'Open';
  return <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color, border: `1px solid ${color}`, borderRadius: 10, padding: '1px 8px' }}>{label}</span>;
}

function NoteLine({ by, color, at, text }: { by: string; color: string; at: string; text: string }) {
  return (
    <div style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'baseline' }}>
      <span style={{ color, fontWeight: 700, flexShrink: 0 }}>{by}</span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap' }}>{text}</span>
      <span style={{ color: MUTED, fontSize: 10, flexShrink: 0 }}>{when(at)}</span>
    </div>
  );
}
