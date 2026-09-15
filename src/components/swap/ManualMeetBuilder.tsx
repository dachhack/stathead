/**
 * ManualMeetBuilder — a Swap Meet with no league behind it. Name the two
 * sides, pick the format and TE premium, pull the pieces off the dynasty
 * board, write the pitch, and get the two links. The meet's "teams" hold
 * only the pieces on the table (source 'manual'), so the pages show board
 * values and the fairness verdict and skip the lineup / needs reads.
 */

import { useMemo, useState } from 'react';
import type { DynastyPlayer } from '../../types';
import type { TepLevel } from '../../lib/dynastyForecast';
import { boardAssets, defaultRosterPositions, valueOnlyEval, type FinisherAsset } from '../../lib/tradeFinisher';
import type { NewMeetInput } from '../../lib/swapMeetCore';
import { createMeet, rememberMeet, meetUrl, copyText } from '../../lib/swapMeet';
import { setSwapHash } from '../../lib/hashRoute';
import { lookupByNamePos, type CrosswalkIndex } from '../../lib/playerLookup';
import { TEP_LABELS } from '../../lib/dynastyForecast';
import { BoardPicker } from './BoardPicker';
import { TradeFront } from './OfferSheet';
import { LinkRow } from './SwapMeetComposer';
import { GIVE_COLOR, GET_COLOR, MUTED, shortName } from './offerStyle';

const btn = { padding: '4px 10px', fontSize: 12 } as const;

interface Props {
  dynasty: DynastyPlayer[];
  format: '1qb' | 'superflex';
  tepLevel: TepLevel;
  onFormatChange: (f: '1qb' | 'superflex') => void;
  onTepChange: (t: TepLevel) => void;
  crosswalk: CrosswalkIndex | null;
}

export function ManualMeetBuilder({ dynasty, format, tepLevel, onFormatChange, onTepChange, crosswalk }: Props) {
  const [myName, setMyName] = useState('');
  const [theirName, setTheirName] = useState('');
  const [giveIds, setGiveIds] = useState<string[]>([]);
  const [getIds, setGetIds] = useState<string[]>([]);
  const [pitch, setPitch] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; proposerKey: string; partnerKey: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const board = useMemo(() => boardAssets(dynasty, format === 'superflex', tepLevel,
    (name, pos) => (crosswalk ? lookupByNamePos(crosswalk, name, pos)?.sleeper_id : null)), [dynasty, format, tepLevel, crosswalk]);
  const byId = useMemo(() => new Map(board.map((a) => [a.id, a])), [board]);
  const give = giveIds.map((id) => byId.get(id)).filter((a): a is FinisherAsset => !!a);
  const get = getIds.map((id) => byId.get(id)).filter((a): a is FinisherAsset => !!a);
  const P = myName.trim() || 'You', Q = theirName.trim() || 'Partner';
  const names = { P, Q, Ps: shortName(P), Qs: shortName(Q) };
  const ev = give.length && get.length ? valueOnlyEval({ give, get }) : null;
  const toggle = (side: 'give' | 'get', id: string) => {
    const [ids, set] = side === 'give' ? [giveIds, setGiveIds] : [getIds, setGetIds];
    set(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  };

  const create = async () => {
    if (!give.length || !get.length) { setError('Pick at least one piece on each side.'); return; }
    if (!myName.trim() || !theirName.trim()) { setError('Name both teams.'); return; }
    setBusy(true); setError(null);
    try {
      const input: NewMeetInput = {
        league: { id: '', name: 'No league', format, tep: tepLevel, rosterPositions: defaultRosterPositions(format), isDynasty: true, source: 'manual' },
        proposer: { rosterId: 1, teamName: myName.trim(), owner: '', goal: 'balanced' },
        partner: { rosterId: 2, teamName: theirName.trim(), owner: '', goal: 'balanced' },
        teams: [
          { rosterId: 1, teamName: myName.trim(), owner: '', ownerId: null, wins: 0, losses: 0, assets: give },
          { rosterId: 2, teamName: theirName.trim(), owner: '', ownerId: null, wins: 0, losses: 0, assets: get },
        ],
        options: [{ give, get, rationale: pitch }],
        note,
      };
      const res = await createMeet(input);
      rememberMeet({ id: res.id, key: res.proposerKey, role: 'proposer', title: res.meet.title, at: res.meet.createdAt, partnerKey: res.partnerKey });
      setCreated({ id: res.id, proposerKey: res.proposerKey, partnerKey: res.partnerKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const copy = async (label: string, text: string) => {
    const ok = await copyText(text);
    setCopied(ok ? `${label} copied.` : `${label}: copy failed — select the link and copy it`);
    window.setTimeout(() => setCopied(null), 2500);
  };

  if (created) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#22c55e' }}>Swap Meet created.</div>
        <LinkRow label={`Send this to ${Q}`} url={meetUrl(created.id, created.partnerKey)} onCopy={() => copy('Partner link', meetUrl(created.id, created.partnerKey))} />
        <LinkRow label="Your link (keep this one — it lets you act as you)" url={meetUrl(created.id, created.proposerKey)} onCopy={() => copy('Your link', meetUrl(created.id, created.proposerKey))} />
        {copied && <div style={{ fontSize: 11, color: '#22c55e' }}>{copied}</div>}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="format-tab active" onClick={() => setSwapHash(created.id, created.proposerKey)} style={btn}>Open the Swap Meet</button>
          <button className="format-tab" onClick={() => { setCreated(null); setGiveIds([]); setGetIds([]); setPitch(''); }} style={btn}>Start another</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="controls" style={{ gap: 10, alignItems: 'flex-end' }}>
        <div className="control-group">
          <label className="control-label">Your team</label>
          <input type="text" value={myName} onChange={(e) => setMyName(e.target.value)} placeholder="Team name" style={{ width: 170 }} />
        </div>
        <div className="control-group">
          <label className="control-label">Their team</label>
          <input type="text" value={theirName} onChange={(e) => setTheirName(e.target.value)} placeholder="Team name" style={{ width: 170 }} />
        </div>
        <div className="control-group">
          <label className="control-label">Format</label>
          <select value={format} onChange={(e) => { onFormatChange(e.target.value as '1qb' | 'superflex'); setGiveIds([]); setGetIds([]); }}>
            <option value="1qb">1QB</option>
            <option value="superflex">Superflex</option>
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">TE premium</label>
          <select value={tepLevel} onChange={(e) => onTepChange(Number(e.target.value) as TepLevel)}>
            {([0, 1, 2, 3] as TepLevel[]).map((t) => <option key={t} value={t}>{TEP_LABELS[t]}</option>)}
          </select>
        </div>
      </div>
      {!dynasty.length && <div style={{ fontSize: 12, color: MUTED }}>Loading the dynasty board…</div>}
      <div className="tf-offer" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12, alignItems: 'start' }}>
        <BoardPicker title={`${names.Ps} sends`} color={GIVE_COLOR} board={board} selected={giveIds} onToggle={(id) => toggle('give', id)} />
        <BoardPicker title={`${names.Qs} sends`} color={GET_COLOR} board={board} selected={getIds} onToggle={(id) => toggle('get', id)} />
      </div>
      {(give.length > 0 || get.length > 0) && (
        <div className="sm-sheet sm-sheet-picked" style={{ ['--author' as string]: GIVE_COLOR, maxWidth: 640 }}>
          <div className="sm-sheet-head"><div className="sm-sheet-v">v1</div><div className="sm-file-line" style={{ flex: 1 }}>Offer sheet · the version you will put on the table</div></div>
          <TradeFront give={give} get={get} names={names} ev={ev} crosswalk={crosswalk} />
          <div className="sm-pitch sm-pitch-edit">
            <span className="sm-pitch-who" style={{ color: GIVE_COLOR }}>{names.Ps}</span>
            <textarea value={pitch} onChange={(e) => setPitch(e.target.value)} rows={2} placeholder="Your pitch — why this works for them too (they read this)" />
          </div>
        </div>
      )}
      <div>
        <label className="control-label" style={{ display: 'block', marginBottom: 4 }}>Opening note to {Q}</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Hey — here's a version I'd do. Mark it if you'd take it, or counter."
          style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }} />
      </div>
      {error && <div style={{ color: '#ef4444', fontSize: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="format-tab active" onClick={create} disabled={busy || !dynasty.length} style={btn}>{busy ? 'Creating…' : 'Create Swap Meet'}</button>
        <span style={{ fontSize: 11, color: MUTED }}>
          Board values in the chosen format, frozen when the meet is created. With no league behind it the sheets show values and the fairness verdict only — no lineup or roster read. Counters on the meet page pick from the same board.
        </span>
      </div>
    </div>
  );
}
