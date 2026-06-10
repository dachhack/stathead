import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlayerName } from './PlayerName';
import type { DraftPrepSettings, Position, Scoring } from '../lib/draftPrepSettings';
import { saveSettings } from '../lib/draftPrepSettings';
import type { KitPlayer, OpenSlots, ValuedPlayer } from '../lib/draftKit';
import {
  KIT_POSITIONS, assignSlot, kitKey, openSlots, roundPick, starterSlotOpen, valuePool,
} from '../lib/draftKit';
import { survivalAtPick, userPickNumbers } from '../lib/snakeDraft';
import type { SleeperDraftPick, SleeperDraftSummary } from '../lib/sleeper';
import {
  fetchDraft, fetchDraftPicks, fetchSleeperUser, fetchUserDrafts, parseDraftIdInput,
} from '../lib/sleeper';

// Live Draft Assistant — guidance while a draft is actually running.
//
// Two ways to track picks:
//   Sleeper  — connect by username (lists your drafts for the season) or
//              paste a draft URL/id. League size, your slot, snake/linear,
//              roster slots, and scoring auto-sync from the draft settings;
//              picks poll every few seconds while the draft is live.
//   Manual   — drafting on ESPN/Yahoo/anywhere else: search players and
//              mark them Gone (someone took them) or Mine as picks happen.
//
// Recommendations are need-aware best-available: candidates are scored by
// VBD, full weight while they'd fill one of YOUR open starting slots and
// discounted on the bench, with a "lasts to your next pick" survival
// probability so you know whether to take a player now or wait a round.

const POLL_MS = 7000;
const BENCH_WEIGHT = 0.45;
const LS_USERNAME = 'sleeper-username';
const LS_DRAFTED = 'draft-live-manual';

interface Props {
  pool: KitPlayer[];
  settings: DraftPrepSettings;
  onSettingsChange: (next: DraftPrepSettings) => void;
}

interface TrackedPick {
  key: string;          // kitKey — '' when the player can't be matched to the pool
  label: string;        // display name
  position: string;
  pickNo: number;
  mine: boolean;
}

function scoringFromSleeper(t: string | undefined): Scoring | null {
  if (!t) return null;
  if (t.includes('half')) return 'HALF';
  if (t.includes('ppr')) return 'PPR';
  if (t === 'std' || t.includes('standard')) return 'STD';
  return null;
}

export function DraftLiveAssistant({ pool, settings, onSettingsChange }: Props) {
  // — Sleeper connection state —
  const [username, setUsername] = useState<string>(() => {
    try { return localStorage.getItem(LS_USERNAME) ?? ''; } catch { return ''; }
  });
  const [draftInput, setDraftInput] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<SleeperDraftSummary[]>([]);
  const [draft, setDraft] = useState<SleeperDraftSummary | null>(null);
  const [sleeperPicks, setSleeperPicks] = useState<SleeperDraftPick[]>([]);
  const [mySlot, setMySlot] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [synced, setSynced] = useState(false);

  // — Manual tracking state (ESPN/Yahoo or no connection) —
  const [manualPicks, setManualPicks] = useState<TrackedPick[]>(() => {
    try {
      const raw = localStorage.getItem(LS_DRAFTED);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [search, setSearch] = useState('');

  const draftRef = useRef<string | null>(null);

  const loadDrafts = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const u = await fetchSleeperUser(username);
      try { localStorage.setItem(LS_USERNAME, username); } catch { /* quota */ }
      setUserId(u.user_id);
      const season = String(new Date().getFullYear());
      const ds = await fetchUserDrafts(u.user_id, season);
      ds.sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0));
      setDrafts(ds);
      if (ds.length === 0) setError(`No ${season} drafts found for ${username}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reach Sleeper.');
    } finally {
      setBusy(false);
    }
  }, [username]);

  const connectDraft = useCallback(async (draftId: string) => {
    setBusy(true); setError(null);
    try {
      const d = await fetchDraft(draftId);
      const picks = await fetchDraftPicks(draftId);
      setDraft(d);
      setSleeperPicks(picks);
      setLastSync(new Date());
      draftRef.current = d.draft_id;

      // Auto-sync league settings from the draft. Sleeper's draft settings
      // carry everything the prep math needs — one less setup step.
      const s = d.settings ?? {};
      const slot = userId && d.draft_order ? d.draft_order[userId] ?? null : null;
      setMySlot(slot);
      const next: DraftPrepSettings = {
        ...settings,
        numTeams: s.teams ?? settings.numTeams,
        pickSlot: slot ?? settings.pickSlot,
        draftType: d.type === 'linear' ? 'linear' : 'snake',
        roster: {
          QB: s.slots_qb ?? settings.roster.QB,
          RB: s.slots_rb ?? settings.roster.RB,
          WR: s.slots_wr ?? settings.roster.WR,
          TE: s.slots_te ?? settings.roster.TE,
          FLEX: s.slots_flex ?? settings.roster.FLEX,
          SF: s.slots_super_flex ?? settings.roster.SF,
        },
        scoring: scoringFromSleeper(d.metadata?.scoring_type) ?? settings.scoring,
      };
      saveSettings(next);
      onSettingsChange(next);
      setSynced(true);
      if (d.type === 'auction') setError('Auction drafts are not supported — pick tracking still works, but pick-number guidance assumes snake.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load draft.');
    } finally {
      setBusy(false);
    }
     
  }, [userId, settings, onSettingsChange]);

  // Poll picks while the draft is live.
  useEffect(() => {
    if (!draft || (draft.status !== 'drafting' && draft.status !== 'paused')) return;
    const id = setInterval(async () => {
      const current = draftRef.current;
      if (!current) return;
      try {
        const [d, picks] = await Promise.all([fetchDraft(current), fetchDraftPicks(current)]);
        if (draftRef.current !== current) return;
        setDraft(d);
        setSleeperPicks(picks);
        setLastSync(new Date());
      } catch { /* transient — keep last state */ }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [draft]);

  useEffect(() => {
    try { localStorage.setItem(LS_DRAFTED, JSON.stringify(manualPicks)); } catch { /* quota */ }
  }, [manualPicks]);

  // — Unified pick list (Sleeper when connected, else manual) —
  const tracked = useMemo<TrackedPick[]>(() => {
    if (draft) {
      return sleeperPicks.map((p) => {
        const name = `${p.metadata?.first_name ?? ''} ${p.metadata?.last_name ?? ''}`.trim();
        const pos = p.metadata?.position ?? '';
        return {
          key: name && pos ? kitKey(name, pos) : '',
          label: name || p.player_id,
          position: pos,
          pickNo: p.pick_no,
          mine: mySlot !== null && p.draft_slot === mySlot,
        };
      });
    }
    return manualPicks;
  }, [draft, sleeperPicks, manualPicks, mySlot]);

  const takenKeys = useMemo(() => new Set(tracked.filter((t) => t.key).map((t) => t.key)), [tracked]);
  const myPicks = useMemo(() => tracked.filter((t) => t.mine), [tracked]);
  const currentPickNo = tracked.length + 1;

  // My open roster slots after my picks so far.
  const mySlots = useMemo<OpenSlots>(() => {
    const slots = openSlots(settings);
    for (const p of myPicks) {
      if (KIT_POSITIONS.includes(p.position as Position)) assignSlot(slots, p.position as Position);
    }
    return slots;
  }, [settings, myPicks]);

  // My next pick number from the current pick onward.
  const rounds = draft?.settings?.rounds ?? 16;
  const myNextPick = useMemo(() => {
    const slot = mySlot ?? settings.pickSlot;
    const picks = userPickNumbers(rounds, slot, settings.numTeams, settings.draftType);
    return picks.find((n) => n >= currentPickNo) ?? null;
  }, [mySlot, settings, currentPickNo, rounds]);

  // — Valued availability + recommendations —
  const { recommendations, byPosition, available } = useMemo(() => {
    if (pool.length === 0) return { recommendations: [], byPosition: new Map<string, ValuedPlayer[]>(), available: [] as ValuedPlayer[] };
    const { players } = valuePool(pool, settings, 'BEER');
    const avail = players.filter((p) => !takenKeys.has(kitKey(p.name, p.position)));

    const score = (p: ValuedPlayer) =>
      p.vbd * (starterSlotOpen(mySlots, p.position) ? 1 : BENCH_WEIGHT);
    const recs = [...avail]
      .sort((a, b) => score(b) - score(a))
      .slice(0, 8)
      .map((p) => ({
        p,
        weighted: score(p),
        fillsStarter: starterSlotOpen(mySlots, p.position),
        survNext: myNextPick !== null && p.adp < 999
          ? survivalAtPick(Math.max(p.adp, currentPickNo), p.stdev || undefined, myNextPick)
          : NaN,
      }));

    const byPos = new Map<string, ValuedPlayer[]>();
    for (const pos of KIT_POSITIONS) {
      byPos.set(pos, avail.filter((p) => p.position === pos).slice(0, 4));
    }
    return { recommendations: recs, byPosition: byPos, available: avail };
  }, [pool, settings, takenKeys, mySlots, myNextPick, currentPickNo]);

  // Manual search candidates.
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return available.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [search, available]);

  const markManual = (p: ValuedPlayer, mine: boolean) => {
    setManualPicks((prev) => [...prev, {
      key: kitKey(p.name, p.position), label: p.name, position: p.position,
      pickNo: prev.length + 1, mine,
    }]);
    setSearch('');
  };

  const statusChip = (status: string) => {
    const map: Record<string, { bg: string; fg: string }> = {
      drafting: { bg: '#0c4a2c', fg: '#86efac' },
      paused: { bg: '#3a3000', fg: '#facc15' },
      pre_draft: { bg: 'var(--bg-tertiary)', fg: 'var(--text-muted)' },
      complete: { bg: '#1e3a5f', fg: '#93c5fd' },
    };
    const s = map[status] ?? map.pre_draft;
    return (
      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: s.bg, color: s.fg }}>
        {status.replace('_', ' ')}
      </span>
    );
  };

  const pill: React.CSSProperties = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)', fontFamily: 'inherit',
  };
  const btn: React.CSSProperties = {
    ...pill, cursor: 'pointer', fontWeight: 700, background: 'var(--bg-tertiary)',
  };

  return (
    <section>
      {/* — Connect — */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '10px 14px', marginBottom: 12,
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Connect a draft</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={{ ...pill, width: 160 }}
            placeholder="Sleeper username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && username.trim()) loadDrafts(); }}
          />
          <button style={btn} disabled={busy || !username.trim()} onClick={loadDrafts}>
            {busy ? '…' : 'Find my drafts'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>or</span>
          <input
            style={{ ...pill, width: 260 }}
            placeholder="Paste draft URL or id"
            value={draftInput}
            onChange={(e) => setDraftInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && draftInput.trim()) connectDraft(parseDraftIdInput(draftInput)); }}
          />
          <button style={btn} disabled={busy || !draftInput.trim()} onClick={() => connectDraft(parseDraftIdInput(draftInput))}>
            Connect
          </button>
          {draft && (
            <button style={{ ...btn, marginLeft: 'auto' }} onClick={() => {
              setDraft(null); setSleeperPicks([]); setSynced(false); draftRef.current = null;
            }}>
              Disconnect
            </button>
          )}
        </div>
        {drafts.length > 0 && !draft && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {drafts.slice(0, 8).map((d) => (
              <button
                key={d.draft_id}
                onClick={() => connectDraft(d.draft_id)}
                style={{
                  display: 'flex', gap: 10, alignItems: 'baseline', textAlign: 'left',
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '6px 10px', cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'inherit',
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 700 }}>{d.metadata?.name || d.draft_id}</span>
                {statusChip(d.status)}
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {d.settings?.teams ?? '?'} teams · {d.type} · {d.metadata?.scoring_type ?? ''}
                </span>
              </button>
            ))}
          </div>
        )}
        {error && <div style={{ fontSize: 11, color: '#fb923c', marginTop: 6 }}>{error}</div>}
        {!draft && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            Drafting on ESPN / Yahoo / elsewhere? Use the manual tracker below —
            search a player and mark them <strong>Gone</strong> (someone else took them)
            or <strong>Mine</strong> as picks happen. Everything else works the same.
          </div>
        )}
      </div>

      {/* — Status strip — */}
      {(draft || manualPicks.length > 0) && (
        <div style={{
          display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap',
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '8px 14px', marginBottom: 12,
        }}>
          {draft && (
            <>
              <span style={{ fontSize: 13, fontWeight: 800 }}>{draft.metadata?.name || 'Sleeper draft'}</span>
              {statusChip(draft.status)}
              {synced && (
                <span style={{ fontSize: 10, color: 'var(--accent, #00d4aa)', fontWeight: 700 }}
                  title="League size, your slot, roster slots, snake/linear, and scoring were set from the draft's settings.">
                  ✓ settings synced
                </span>
              )}
            </>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Pick <strong>{currentPickNo}</strong> ({roundPick(currentPickNo, settings.numTeams)})
          </span>
          {myNextPick !== null && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              your next: <strong>#{myNextPick}</strong>
              {myNextPick > currentPickNo && ` (${myNextPick - currentPickNo} away)`}
              {myNextPick === currentPickNo && ' — YOU ARE ON THE CLOCK'}
            </span>
          )}
          {mySlot === null && draft && (
            <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              your slot:{' '}
              <input
                type="number" min={1} max={settings.numTeams}
                value={settings.pickSlot}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(settings.numTeams, Number(e.target.value) || 1));
                  const next = { ...settings, pickSlot: v };
                  saveSettings(next); onSettingsChange(next);
                }}
                style={{ ...pill, width: 44, padding: '2px 4px', textAlign: 'center' }}
                title="Couldn't find your seat in the draft order (mock drafts don't publish one) — set it so next-pick math works."
              />
            </label>
          )}
          {lastSync && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              synced {lastSync.toLocaleTimeString()}
              {draft?.status === 'drafting' && ' · auto-refreshing'}
            </span>
          )}
          {!draft && manualPicks.length > 0 && (
            <button style={{ ...btn, marginLeft: 'auto', fontSize: 10 }} onClick={() => setManualPicks([])}>
              Reset manual draft
            </button>
          )}
        </div>
      )}

      {/* — Manual tracker — */}
      {!draft && (
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <input
            style={{ ...pill, width: 280 }}
            placeholder="Search player to mark drafted..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {searchResults.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 50, marginTop: 2,
              background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6,
              minWidth: 360, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            }}>
              {searchResults.map((p) => (
                <div key={`${p.name}:${p.position}`} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 10px', borderBottom: '1px solid var(--border)' }}>
                  <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 9 }}>{p.position}</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>VBD {Math.round(p.vbd)}</span>
                  <button style={{ ...btn, marginLeft: 'auto', fontSize: 10, padding: '2px 8px' }} onClick={() => markManual(p, false)}>Gone</button>
                  <button style={{ ...btn, fontSize: 10, padding: '2px 8px', color: 'var(--accent, #00d4aa)' }} onClick={() => markManual(p, true)}>Mine</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* — Best available — */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(380px, 3fr) minmax(280px, 2fr)', gap: 12, alignItems: 'start' }}>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
            Best available {myPicks.length > 0 ? '(need-aware)' : ''}
          </div>
          {recommendations.map(({ p, fillsStarter, survNext }, i) => (
            <div
              key={`${p.name}:${p.position}`}
              style={{
                display: 'grid', gridTemplateColumns: '18px auto 1fr auto auto auto', columnGap: 8,
                alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--border)',
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'right' }}>{i + 1}</span>
              <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 9 }}>{p.position}</span>
              <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <PlayerName name={p.name} position={p.position} />
                {p.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
                {!fillsStarter && <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 6 }}>bench</span>}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right' }} title={`${p.ppg.toFixed(1)} projected PPG`}>
                VBD {Math.round(p.vbd)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
                {p.adp < 999 ? `ADP ${p.adp.toFixed(0)}` : 'free'}
              </span>
              <span
                style={{
                  fontSize: 11, fontWeight: 700, textAlign: 'right', minWidth: 70,
                  color: !Number.isFinite(survNext) ? 'var(--text-muted)' : survNext >= 0.6 ? '#22c55e' : survNext >= 0.3 ? '#facc15' : '#ef4444',
                }}
                title={Number.isFinite(survNext)
                  ? `${Math.round(survNext * 100)}% chance he's still available at your next pick (#${myNextPick})`
                  : 'No next-pick survival estimate.'}
              >
                {Number.isFinite(survNext)
                  ? survNext >= 0.6 ? `wait ${Math.round(survNext * 100)}%` : survNext >= 0.3 ? `risky ${Math.round(survNext * 100)}%` : 'take now'
                  : '—'}
              </span>
            </div>
          ))}
          {recommendations.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Pool not loaded yet.</div>
          )}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
            Ranked by VBD, full weight while the player fills one of your open
            starting slots, ×{BENCH_WEIGHT} once he'd be bench depth.
            “wait” = likely there at your next pick; “take now” = won't be.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Best by position */}
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Best at each position</div>
            {KIT_POSITIONS.map((pos) => {
              const list = byPosition.get(pos) ?? [];
              return (
                <div key={pos} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className={`pos-badge pos-${pos}`} style={{ fontSize: 9 }}>{pos}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 26 }}>
                    {mySlots[pos] > 0 ? `${mySlots[pos]} open` : starterSlotOpen(mySlots, pos) ? 'flex' : 'bench'}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {list.map((p, i) => (
                      <span key={`${p.name}:${p.position}`}>
                        {i > 0 && <span style={{ color: 'var(--text-muted)' }}> · </span>}
                        <PlayerName name={p.name} position={p.position} />
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}> {Math.round(p.vbd)}</span>
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>

          {/* My roster */}
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
              My picks ({myPicks.length})
            </div>
            {myPicks.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                {draft
                  ? mySlot === null
                    ? 'Set your slot above to track your roster (mocks don’t publish seat assignments).'
                    : 'No picks yet.'
                  : 'Mark players "Mine" to build your roster here.'}
              </div>
            ) : (
              myPicks.map((p) => (
                <div key={p.pickNo} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 36 }}>{roundPick(p.pickNo, settings.numTeams)}</span>
                  <span className={`pos-badge pos-${p.position}`} style={{ fontSize: 9 }}>{p.position}</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>
                    <PlayerName name={p.label} position={p.position} />
                  </span>
                </div>
              ))
            )}
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
              Open: {(Object.entries(mySlots) as Array<[string, number]>).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(' ') || 'starters full — bench mode'}
            </div>
          </div>
        </div>
      </div>

      {/* Recent picks ticker */}
      {tracked.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-secondary)' }}>Recent picks:</strong>{' '}
          {[...tracked].slice(-10).reverse().map((t, i) => (
            <span key={t.pickNo}>
              {i > 0 && ' · '}
              #{t.pickNo} {t.label} ({t.position}){t.mine ? ' ✓you' : ''}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
