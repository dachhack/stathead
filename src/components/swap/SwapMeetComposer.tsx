/**
 * "Send to your partner" — turns the Trade Finisher's offer and finishes into
 * a Swap Meet: pick which versions to put on the table, write the pitch for
 * each and an opening note, create the meet, and hand out the two links.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FinisherTeam, Offer, OfferEval, TradeGoal } from '../../lib/tradeFinisher';
import type { MeetLeague, NewMeetInput } from '../../lib/swapMeetCore';
import { createMeet, listMeets, rememberMeet, meetUrl, copyText, type MeetHandle } from '../../lib/swapMeet';
import { setSwapHash } from '../../lib/hashRoute';
import { PackageList } from './OfferParts';
import { GIVE_COLOR, GET_COLOR, MUTED, VERDICT_COLOR, VERDICT_LABEL, fmt } from './offerStyle';

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
}

const btn = { padding: '4px 10px', fontSize: 12 } as const;

export function SwapMeetComposer({ league, me, partner, teams, myGoal, partnerGoal, candidates }: Props) {
  const [open, setOpen] = useState(false);
  const [included, setIncluded] = useState<Set<string>>(() => new Set());
  const [pitches, setPitches] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; proposerKey: string; partnerKey: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [mine, setMine] = useState<MeetHandle[]>(() => listMeets());

  // Default selection: the offer on the table plus the top three finishes.
  const candidateKeys = useMemo(() => candidates.map((c) => c.key).join('|'), [candidates]);
  useEffect(() => {
    setIncluded(new Set(candidates.slice(0, 4).filter((c) => c.eval?.legal !== false).map((c) => c.key)));
    setCreated(null);
  }, [candidateKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k: string) => setIncluded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const pitchFor = (c: Candidate) => pitches[c.key] ?? c.pitch;

  const create = async () => {
    const chosen = candidates.filter((c) => included.has(c.key) && c.offer.give.length && c.offer.get.length);
    if (!chosen.length) { setError('Pick at least one version to put on the table.'); return; }
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
          Put the versions you'd do on a shared page. They mark the ones they'd accept, counter, and leave notes; you both see the same needs and fairness read.
        </span>
      </div>
      {open && (
        <div style={{ padding: '0 14px 14px' }}>
          {!created ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
                {candidates.map((c) => {
                  const on = included.has(c.key);
                  const ev = c.eval;
                  return (
                    <div key={c.key} style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '8px 10px', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer', fontSize: 12 }}>
                        <input type="checkbox" checked={on} onChange={() => toggle(c.key)} />
                        <strong style={{ flex: 1 }}>{c.label}</strong>
                        {ev && (
                          <span style={{ fontSize: 11, fontWeight: 700, color: VERDICT_COLOR[ev.verdict] }}>
                            {VERDICT_LABEL[ev.verdict]} <span style={{ fontWeight: 500, color: MUTED }}>· {ev.diff === 0 ? 'even' : `${ev.diff > 0 ? 'you' : partner.teamName} +${fmt(Math.abs(ev.diff))}`}</span>
                          </span>
                        )}
                      </label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <PackageList xs={c.offer.give} color={GIVE_COLOR} head="You give" linkNames={false} />
                        <PackageList xs={c.offer.get} color={GET_COLOR} head="You get" linkNames={false} />
                      </div>
                      {on && (
                        <textarea value={pitchFor(c)} onChange={(e) => setPitches({ ...pitches, [c.key]: e.target.value })}
                          rows={2} placeholder="Your pitch for this version"
                          style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }} />
                      )}
                    </div>
                  );
                })}
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
                  {busy ? 'Creating…' : `Create Swap Meet (${[...included].filter((k) => candidates.some((c) => c.key === k)).length} version${included.size === 1 ? '' : 's'})`}
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

function LinkRow({ label, url, onCopy }: { label: string; url: string; onCopy: () => void }) {
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
