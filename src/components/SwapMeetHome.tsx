/**
 * Swap Meet by StatHead — the feature's own page (Dynasty → Swap Meet).
 *
 * Three things: the meets this device has opened or joined, a box to open a
 * meet from a pasted link, and "Build the trade" — the Trade Finisher in
 * swap mode (your Sleeper league, a partner, the offer, fair finishes) with
 * the composer at the end that puts versions on a shared page. The meet
 * page itself (`#/swap/<id>?k=…`) is SwapMeetView, reached by link.
 */

import { useEffect, useMemo, useState } from 'react';
import { fetchDynastyRankingsForDisplay } from '../data';
import type { DynastyPlayer } from '../types';
import type { TepLevel } from '../lib/dynastyForecast';
import { parseSwapLocation, setSwapHash } from '../lib/hashRoute';
import { listMeets, forgetMeet, meetUrl, copyText, type MeetHandle } from '../lib/swapMeet';
import { TradeFinisher } from './TradeFinisher';
import { ManualMeetBuilder } from './swap/ManualMeetBuilder';
import { useCrosswalk } from '../hooks/useCrosswalk';
import { GIVE_COLOR, GET_COLOR, MUTED } from './swap/offerStyle';

const btn = { padding: '4px 10px', fontSize: 12 } as const;

/** A pasted share link, hash link or bare id → the route, or null. */
function parsePasted(text: string): { id: string; key: string | null } | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    return parseSwapLocation(u.search, u.hash);
  } catch { /* not a URL */ }
  if (/^[a-z0-9]{6,24}$/i.test(t)) return { id: t.toLowerCase(), key: null };
  return parseSwapLocation(t.startsWith('?') ? t : '', t.startsWith('#') ? t : '');
}

export function SwapMeetHome() {
  const [meets, setMeets] = useState<MeetHandle[]>(() => listMeets());
  const [pasted, setPasted] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [leagueFormat, setLeagueFormat] = useState<'1qb' | 'superflex'>('superflex');
  const [tepLevel, setTepLevel] = useState<TepLevel>(0);
  const [dynasty, setDynasty] = useState<DynastyPlayer[]>([]);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [how, setHow] = useState<'league' | 'manual'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem('stathead:swap-meet-how') === 'manual' ? 'manual' : 'league'));
  const { index: crosswalk } = useCrosswalk();
  const pickHow = (h: 'league' | 'manual') => { setHow(h); try { localStorage.setItem('stathead:swap-meet-how', h); } catch { /* ignore */ } };

  // The dynasty board prices every asset; the finisher switches the format
  // and TE premium to the league's once one is chosen.
  useEffect(() => {
    let alive = true;
    fetchDynastyRankingsForDisplay(leagueFormat)
      .then((rows) => { if (alive) { setDynasty(rows); setBoardError(null); } })
      .catch((e) => { if (alive) setBoardError(e instanceof Error ? e.message : 'Could not load the dynasty board'); });
    return () => { alive = false; };
  }, [leagueFormat]);

  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 3000); };
  const openPasted = () => {
    const r = parsePasted(pasted);
    if (!r) { flash('That does not look like a Swap Meet link.'); return; }
    setSwapHash(r.id, r.key);
  };
  const parsedOk = useMemo(() => !!parsePasted(pasted), [pasted]);

  return (
    <div className="sm-page" style={{ padding: '0 16px 32px', maxWidth: 1180, margin: '0 auto' }}>
      <div className="sm-brand">
        <h2>Swap Meet <span>by StatHead</span></h2>
      </div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)', maxWidth: 820 }}>
        A trade negotiation two managers share by link, no accounts. Build the trade from your Sleeper league below, put one or
        more versions on the table with a pitch, and send your partner their link. Each side marks the versions they would
        accept, counters with their own, marks a final offer and leaves notes; two accepts on one version is a deal. Your partner
        sees the packages, the values and what each version does for them — never your side of the ledger.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)', padding: '10px 14px' }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Your Swap Meets on this device</h4>
          {meets.length === 0 ? (
            <div style={{ fontSize: 12, color: MUTED }}>None yet. Meets you open or are invited to show up here.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {meets.map((h) => (
                <div key={h.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12 }}>
                  <a href={meetUrl(h.id, h.key)} onClick={(e) => { e.preventDefault(); setSwapHash(h.id, h.key); }}
                    style={{ color: 'var(--accent)', fontWeight: 600 }}>{h.title}</a>
                  <span style={{ color: h.role === 'proposer' ? GIVE_COLOR : GET_COLOR }}>{h.role === 'proposer' ? 'you proposed' : 'you were invited'}</span>
                  <span style={{ color: MUTED }}>{new Date(h.at).toLocaleDateString()}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    <button className="format-tab" onClick={() => copyText(meetUrl(h.id, h.key)).then((ok) => flash(ok ? 'Your link copied.' : 'Copy failed.'))} style={{ padding: '2px 8px', fontSize: 11 }}>Copy my link</button>
                    {h.partnerKey && <button className="format-tab" onClick={() => copyText(meetUrl(h.id, h.partnerKey)).then((ok) => flash(ok ? 'Partner link copied.' : 'Copy failed.'))} style={{ padding: '2px 8px', fontSize: 11 }}>Copy partner link</button>}
                    <button className="format-tab" onClick={() => { forgetMeet(h.id); setMeets(listMeets()); }} title="Remove from this list (the meet itself stays reachable by link)" style={{ padding: '2px 8px', fontSize: 11 }}>Forget</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)', padding: '10px 14px' }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Open a meet from a link</h4>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="text" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste a Swap Meet link (or its id)"
              onKeyDown={(e) => { if (e.key === 'Enter') openPasted(); }} style={{ flex: 1, minWidth: 0, fontSize: 12 }} />
            <button className={`format-tab ${parsedOk ? 'active' : ''}`} onClick={openPasted} disabled={!pasted.trim()} style={btn}>Open</button>
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>A link with a key lets you act as that side; a bare link is read-only.</div>
        </div>
      </div>
      {toast && <div style={{ fontSize: 12, color: '#22c55e', marginBottom: 8 }}>{toast}</div>}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>Start a meet</h4>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className={`format-tab ${how === 'league' ? 'active' : ''}`} onClick={() => pickHow('league')} style={{ padding: '2px 10px', fontSize: 11 }}>From a league (Sleeper or ESPN)</button>
          <button className={`format-tab ${how === 'manual' ? 'active' : ''}`} onClick={() => pickHow('manual')} style={{ padding: '2px 10px', fontSize: 11 }}>By hand, no league</button>
        </div>
        <span style={{ fontSize: 11, color: MUTED }}>
          {how === 'league'
            ? 'Rosters, needs and fair finishes from the league; the partner sees what each version does for them.'
            : 'Pick the pieces off the dynasty board. Values and the fairness verdict only — no lineup or roster read.'}
        </span>
      </div>
      {boardError && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>{boardError}</div>}
      {how === 'league' ? (
        <TradeFinisher
          mode="swap"
          dynasty={dynasty}
          leagueFormat={leagueFormat}
          tepLevel={tepLevel}
          onLeagueDetected={(f, tep) => { setLeagueFormat(f); setTepLevel(tep); }}
        />
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)', padding: '12px 14px' }}>
          <ManualMeetBuilder dynasty={dynasty} format={leagueFormat} tepLevel={tepLevel} onFormatChange={setLeagueFormat} onTepChange={setTepLevel} crosswalk={crosswalk} />
        </div>
      )}
    </div>
  );
}
