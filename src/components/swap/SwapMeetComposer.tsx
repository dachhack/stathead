/**
 * "Send to your partner" — turns the Trade Finisher's offer and finishes into
 * a Swap Meet: pick which versions to put on the table, change the pieces in
 * any of them (the finisher's throw-ins are suggestions, not the deal), add a
 * version by hand, write the pitch for each and an opening note, create the
 * meet, and hand out the two links.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FinisherAsset, FinisherTeam, Offer, OfferEval, TradeGoal } from '../../lib/tradeFinisher';
import type { MeetLeague, NewMeetInput } from '../../lib/swapMeetCore';
import { createMeet, listMeets, rememberMeet, meetUrl, copyText, type MeetHandle } from '../../lib/swapMeet';
import { setSwapHash } from '../../lib/hashRoute';
import { useCrosswalk } from '../../hooks/useCrosswalk';
import { FitStrip, TradeFront } from './OfferSheet';
import { GET_INK, GIVE_INK, MUTED, fmt, shortName } from './offerStyle';

export interface Candidate {
  key: string;
  label: string;
  offer: Offer;
  eval: OfferEval | null;
  /** Suggested pitch, from the finisher's edits and tags. */
  pitch: string;
}

interface Props {
  league: MeetLeague;
  me: FinisherTeam;
  partner: FinisherTeam;
  teams: FinisherTeam[];
  myGoal: TradeGoal;
  partnerGoal: TradeGoal;
  candidates: Candidate[];
  /** Re-price a package the user changed: its read and a fresh suggested pitch. */
  revise: (offer: Offer) => { eval: OfferEval | null; pitch: string };
}

const btn = { padding: '4px 10px', fontSize: 12 } as const;

const offerSig = (o: Offer) => `${o.give.map((a) => a.id).join(',')}>${o.get.map((a) => a.id).join(',')}`;
const MAX_HITS = 8;

/**
 * One side of a package while it is being edited: the pieces on it, each
 * removable, and a search over that team's roster to add another.
 */
function SideEdit({ head, color, xs, pool, onChange }: {
  head: string; color: string; xs: FinisherAsset[]; pool: FinisherAsset[]; onChange: (xs: FinisherAsset[]) => void;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const onIt = new Set(xs.map((a) => a.id));
  const hits = needle
    ? pool.filter((a) => !onIt.has(a.id) && a.name.toLowerCase().includes(needle)).slice(0, MAX_HITS)
    : [];
  const add = (a: FinisherAsset) => { onChange([...xs, a]); setQ(''); };
  return (
    <div className="sm-edit-side" style={{ ['--side' as string]: color }}>
      <div className="sm-edit-head" style={{ color }}>{head} <span>{xs.length ? fmt(xs.reduce((s, a) => s + a.value, 0)) : '—'}</span></div>
      {xs.length === 0 && <div className="sm-edit-empty">Nothing yet — add a piece below.</div>}
      {xs.map((a) => (
        <div key={a.id} className="sm-edit-row">
          <span className="sm-edit-pos">{a.position}</span>
          <span className="sm-edit-name">{a.name}</span>
          <span className="sm-edit-val">{fmt(a.value)}</span>
          <button type="button" className="sm-edit-x" onClick={() => onChange(xs.filter((x) => x.id !== a.id))} title={`Take ${a.name} off this version`} aria-label={`Remove ${a.name}`}>×</button>
        </div>
      ))}
      <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a piece: type a name or a pick…"
        onKeyDown={(e) => { if (e.key === 'Enter' && hits.length === 1) add(hits[0]); }} />
      {needle && (
        <div className="sm-edit-hits">
          {hits.length === 0 && <div className="sm-edit-empty">No one on the roster matches.</div>}
          {hits.map((a) => (
            <button type="button" key={a.id} className="sm-edit-hit" onClick={() => add(a)}>
              <span className="sm-edit-pos">{a.position}</span>
              <span className="sm-edit-name">{a.name}{a.team ? ` · ${a.team}` : ''}{a.age ? ` · ${a.age}` : ''}</span>
              <span className="sm-edit-val">{fmt(a.value)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SwapMeetComposer({ league, me, partner, teams, myGoal, partnerGoal, candidates, revise }: Props) {
  const [open, setOpen] = useState(false);
  const [included, setIncluded] = useState<Set<string>>(() => new Set());
  const [pitches, setPitches] = useState<Record<string, string>>({});
  // Packages the user changed, by candidate key; versions added by hand; the
  // version whose pieces are open for editing.
  const [edits, setEdits] = useState<Record<string, Offer>>({});
  const [custom, setCustom] = useState<{ key: string; offer: Offer }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; proposerKey: string; partnerKey: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [mine, setMine] = useState<MeetHandle[]>(() => listMeets());
  const { index: crosswalk } = useCrosswalk();
  const names = useMemo(() => ({ P: me.teamName, Q: partner.teamName, Ps: shortName(me.teamName), Qs: shortName(partner.teamName) }), [me.teamName, partner.teamName]);

  // Default selection: the offer on the table plus the top three finishes.
  // A new set of candidates (the offer above changed) drops the edits too:
  // they were changes to packages that no longer exist.
  const candidateSig = useMemo(() => candidates.map((c) => `${c.key}:${offerSig(c.offer)}`).join('|'), [candidates]);
  useEffect(() => {
    setIncluded(new Set(candidates.slice(0, 4).filter((c) => c.eval?.legal !== false).map((c) => c.key)));
    setEdits({});
    setCustom([]);
    setEditing(null);
    setCreated(null);
  }, [candidateSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // What is on the table: the finisher's versions with the user's changes
  // applied (re-priced), then the hand-built ones.
  const versions = useMemo<(Candidate & { edited: boolean; custom: boolean })[]>(() => {
    const priced = (key: string, label: string, offer: Offer, isCustom: boolean): Candidate & { edited: boolean; custom: boolean } => {
      const r = offer.give.length && offer.get.length ? revise(offer) : { eval: null, pitch: '' };
      return { key, label, offer, eval: r.eval, pitch: r.pitch, edited: true, custom: isCustom };
    };
    return [
      ...candidates.map((c) => (edits[c.key] ? priced(c.key, `${c.label} · changed`, edits[c.key], false) : { ...c, edited: false, custom: false })),
      ...custom.map((c, i) => priced(c.key, `Your version #${i + 1}`, c.offer, true)),
    ];
  }, [candidates, edits, custom, revise]);

  const toggle = (k: string) => setIncluded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const pitchFor = (c: Candidate) => pitches[c.key] ?? c.pitch;
  const setOffer = (v: { key: string; custom: boolean }, offer: Offer) => {
    if (v.custom) setCustom((cs) => cs.map((c) => (c.key === v.key ? { ...c, offer } : c)));
    else setEdits((e) => ({ ...e, [v.key]: offer }));
  };
  const resetVersion = (key: string) => { setEdits((e) => { const n = { ...e }; delete n[key]; return n; }); if (editing === key) setEditing(null); };
  const removeVersion = (key: string) => {
    setCustom((cs) => cs.filter((c) => c.key !== key));
    setIncluded((s) => { const n = new Set(s); n.delete(key); return n; });
    if (editing === key) setEditing(null);
  };
  // A version by hand starts from the offer as built (or empty) and opens for editing.
  const addVersion = () => {
    const key = `c${Date.now().toString(36)}`;
    const base = candidates.find((c) => c.key === 'offer')?.offer ?? { give: [], get: [] };
    setCustom((cs) => [...cs, { key, offer: { give: [...base.give], get: [...base.get] } }]);
    setIncluded((s) => new Set(s).add(key));
    setEditing(key);
  };
  const incomplete = versions.filter((v) => included.has(v.key) && !(v.offer.give.length && v.offer.get.length));

  const create = async () => {
    const chosen = versions.filter((c) => included.has(c.key) && c.offer.give.length && c.offer.get.length);
    if (!chosen.length) { setError('Pick at least one version to put on the table.'); return; }
    if (incomplete.length) { setError(`${incomplete.length === 1 ? 'One version has' : `${incomplete.length} versions have`} an empty side — add a piece or untick it.`); return; }
    setBusy(true);
    setError(null);
    try {
      const input: NewMeetInput = {
        league,
        proposer: { rosterId: me.rosterId, teamName: me.teamName, owner: me.owner, goal: myGoal },
        partner: { rosterId: partner.rosterId, teamName: partner.teamName, owner: partner.owner, goal: partnerGoal },
        teams,
        options: chosen.map((c) => ({ give: c.offer.give, get: c.offer.get, rationale: pitchFor(c) })),
        note,
      };
      const res = await createMeet(input);
      const handle: MeetHandle = { id: res.id, key: res.proposerKey, role: 'proposer', title: res.meet.title, at: res.meet.createdAt, partnerKey: res.partnerKey };
      rememberMeet(handle);
      setMine(listMeets());
      setCreated({ id: res.id, proposerKey: res.proposerKey, partnerKey: res.partnerKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label: string, text: string) => {
    const ok = await copyText(text);
    setCopied(ok ? label : `${label}: copy failed — select the link and copy it`);
    window.setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="sm-composer" style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-tertiary)' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 14px', cursor: 'pointer', userSelect: 'none', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, width: 12, color: MUTED }}>{open ? '▼' : '▶'}</span>
        <h4 style={{ margin: 0, fontSize: 13 }}>Send to {partner.teamName} · <span style={{ color: 'var(--accent)' }}>Swap Meet</span></h4>
        <span style={{ fontSize: 11, color: MUTED }}>
          Put the versions you'd do on a shared page. They see the packages, the values and what each version does for them (nothing about your side), mark the ones they'd accept, counter, and leave notes. You keep the full read.
        </span>
      </div>
      {open && (
        <div style={{ padding: '0 14px 14px' }}>
          {!created ? (
            <>
              {/* Each candidate is drawn as the sheet the partner will see, so
                  what you pick from here is what lands on their table. */}
              <div className="sm-options sm-composer-cards">
                {versions.map((c, i) => {
                  const on = included.has(c.key);
                  const isEditing = editing === c.key;
                  return (
                    <div key={c.key} className={`sm-sheet${on ? ' sm-sheet-picked' : ' sm-sheet-unpicked'}`} style={{ ['--author' as string]: GIVE_INK }}>
                      <label className="sm-sheet-head" style={{ cursor: 'pointer', alignItems: 'center' }}>
                        <input type="checkbox" checked={on} onChange={() => toggle(c.key)} style={{ margin: 0 }} />
                        <div className="sm-sheet-v" style={{ paddingTop: 0 }}>v{i + 1}</div>
                        <div className="sm-file-line" style={{ minWidth: 0, flex: 1 }}>
                          <strong>{c.label}</strong>
                          <span> · {on ? 'on the table' : 'not sent'}</span>
                        </div>
                      </label>
                      <div className="sm-edit-bar">
                        <button type="button" className="format-tab" onClick={() => setEditing(isEditing ? null : c.key)} style={{ padding: '2px 8px', fontSize: 10 }}>
                          {isEditing ? 'Done' : 'Change the pieces'}
                        </button>
                        {c.edited && !c.custom && <button type="button" className="format-tab" onClick={() => resetVersion(c.key)} style={{ padding: '2px 8px', fontSize: 10 }}>Back to the finisher's</button>}
                        {c.custom && <button type="button" className="format-tab" onClick={() => removeVersion(c.key)} style={{ padding: '2px 8px', fontSize: 10 }}>Remove this version</button>}
                        {c.eval && c.eval.legal === false && <span className="sm-edit-warn">{c.eval.illegalReason ?? 'Leaves a lineup short'}</span>}
                      </div>
                      {isEditing ? (
                        <div className="sm-edit">
                          <SideEdit head="You send" color={GIVE_INK} xs={c.offer.give} pool={me.assets} onChange={(give) => setOffer(c, { ...c.offer, give })} />
                          <SideEdit head={`${names.Qs} sends`} color={GET_INK} xs={c.offer.get} pool={partner.assets} onChange={(get) => setOffer(c, { ...c.offer, get })} />
                        </div>
                      ) : (
                        <TradeFront give={c.offer.give} get={c.offer.get} names={names} ev={c.eval} crosswalk={crosswalk} giveHead="You send" getHead={`${names.Qs} sends`} />
                      )}
                      {c.eval && <FitStrip ev={c.eval} names={names} />}
                      {on && (
                        <div className="sm-pitch sm-pitch-edit">
                          <span className="sm-pitch-who" style={{ color: GIVE_INK }}>{names.Ps}</span>
                          <textarea value={pitchFor(c)} onChange={(e) => setPitches({ ...pitches, [c.key]: e.target.value })}
                            rows={2} placeholder="Your pitch for this version — they read this" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                <button type="button" className="format-tab" onClick={addVersion} style={btn}>+ A version by hand</button>
                <span style={{ fontSize: 11, color: MUTED }}>
                  Any version can be changed piece by piece — the finisher's throw-ins are suggestions. Each change is re-priced and re-read for both sides.
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <label className="control-label" style={{ display: 'block', marginBottom: 4 }}>Opening note to {partner.teamName}</label>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                  placeholder={`Hey — a few ways we could do this. Mark any you'd take, or counter.`}
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }} />
              </div>
              {error && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{error}</div>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                <button className="format-tab active" onClick={create} disabled={busy} style={btn}>
                  {busy ? 'Creating…' : `Create Swap Meet (${[...included].filter((k) => versions.some((c) => c.key === k)).length} version${included.size === 1 ? '' : 's'})`}
                </button>
                <span style={{ fontSize: 11, color: MUTED }}>Creates two links: one for you, one to send them. No accounts; anyone with a link can read, the two links can act. Meets expire after 120 days of quiet.</span>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#22c55e' }}>Swap Meet created.</div>
              <LinkRow label={`Send this to ${partner.teamName}`} url={meetUrl(created.id, created.partnerKey)} onCopy={() => copy('Partner link', meetUrl(created.id, created.partnerKey))} />
              <LinkRow label="Your link (keep this one — it lets you act as you)" url={meetUrl(created.id, created.proposerKey)} onCopy={() => copy('Your link', meetUrl(created.id, created.proposerKey))} />
              {copied && <div style={{ fontSize: 11, color: '#22c55e' }}>{copied.includes('failed') ? copied : `${copied} copied.`}</div>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="format-tab active" onClick={() => setSwapHash(created.id, created.proposerKey)} style={btn}>Open the Swap Meet</button>
                <button className="format-tab" onClick={() => setCreated(null)} style={btn}>Start another</button>
              </div>
            </div>
          )}

          {mine.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 11, color: MUTED }}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>Your Swap Meets on this device</div>
              {mine.slice(0, 8).map((h) => (
                <div key={h.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <a href={meetUrl(h.id, h.key)} onClick={(e) => { e.preventDefault(); setSwapHash(h.id, h.key); }} style={{ color: 'var(--accent)' }}>{h.title}</a>
                  <span>{h.role === 'proposer' ? 'you proposed' : 'you were invited'} · {new Date(h.at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LinkRow({ label, url, onCopy }: { label: string; url: string; onCopy: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 11, color: MUTED }}>{label}</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="text" readOnly value={url} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 0, fontSize: 11, fontFamily: 'monospace' }} />
        <button className="format-tab" onClick={onCopy} style={btn}>Copy</button>
      </div>
    </div>
  );
}
