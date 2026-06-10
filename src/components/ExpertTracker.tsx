import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  fetchSleeperUser, fetchUserLeagues, fetchUserRostersAcrossLeagues, leagueTypeName,
  type UserLeagueRoster, type SleeperLeagueSummary,
} from '../lib/sleeper';
import { fetchSleeperPlayers, fetchKTCRankings } from '../data';
import type { SleeperPlayer, Tab, KTCPlayer } from '../types';
import { PlayerName } from './PlayerName';
import { teamLogoUrl } from '../lib/teamLogo';
import { dynastyPickValue } from '../lib/tradeEngine';
import { normalizeForMatch } from '../lib/nameMatch';
import {
  fetchEncryptedNames, decryptExpertNames, loadCachedUnlockedNames, cacheUnlockedNames,
  type EncryptedNames,
} from '../lib/expertNames';

const SLEEPER = 'https://api.sleeper.app/v1';

// Trade grading: value the two sides with KTC dynasty values (+ rookie-pick
// value) and grade by the share of total value the manager received.
function letterGrade(ratio: number): string {
  if (ratio >= 0.62) return 'A';
  if (ratio >= 0.56) return 'B';
  if (ratio >= 0.45) return 'C';
  if (ratio >= 0.39) return 'D';
  return 'F';
}
function gradeColor(letter: string): string {
  return letter === 'A' ? '#22c55e' : letter === 'B' ? '#a3e635'
    : letter === 'C' ? '#f59e0b' : letter === 'D' ? '#fb923c' : '#ef4444';
}
const pickOverall = (round: number) => Math.max(1, (round - 0.5) * 12); // 12-team midpoint

interface GraphNode { i: number; leagues: number; dynasty: number; redraft: number }
interface GraphEdge { a: number; b: number; dynasty: number; redraft: number; total: number }
interface GenGraph { generated: string; expert_count: number; nodes: GraphNode[]; edges: GraphEdge[] }
interface RankRow { label: string; isUser: boolean; avg: number; grade: string; trades: number }

// The expert username list lives ONLY in the browser (localStorage). It is never
// uploaded, committed to the repo, or baked into the deployed build.
const LS_KEY = 'stathead_expert_usernames';

function loadExperts(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

interface ExpertResult {
  username: string;
  displayName: string;
  leagues: SleeperLeagueSummary[];
  rosters: UserLeagueRoster[];
  error?: string;
}

interface ExpertOwnership {
  id: string;
  name: string;
  position: string;
  team: string;
  experts: Set<string>; // distinct expert usernames rostering the player
  rosterCount: number;  // expert rosters with the player
  starterCount: number; // expert rosters starting the player
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
const LEAGUE_TYPES = ['all', 'Dynasty', 'Keeper', 'Redraft'] as const;

// ── Generated (pipeline) data: anonymized aggregates from build_expert_data.py ──
interface GenOwnershipPlayer {
  id: string; experts: number; rosters: number;
  dynasty: number; redraft: number; sf: number; '1qb': number; starters: number;
}
interface GenOwnership {
  generated: string; expert_count: number;
  roster_totals: Record<string, number>;
  players: GenOwnershipPlayer[];
}
interface GenAdds { generated: string; adds: { id: string; count: number; experts: number; last: number }[]; }
interface GenTrade { created: number; dynasty: boolean; sf: boolean; expert?: number; received: string[]; gave: string[]; picks: { season: string; round: number; to: boolean }[] }
interface GenTrades { generated: string; trades: GenTrade[]; }

const FMT_FILTERS = ['all', 'dynasty', 'redraft', 'sf', '1qb'] as const;
type FmtFilter = (typeof FMT_FILTERS)[number];
const FMT_LABEL: Record<FmtFilter, string> = { all: 'All', dynasty: 'Dynasty', redraft: 'Redraft', sf: 'Superflex', '1qb': '1QB' };

export function ExpertTracker({ onNavigate }: { onNavigate?: (tab: Tab) => void }) {
  const [experts, setExperts] = useState<string[]>(() => loadExperts());
  const [input, setInput] = useState('');
  const [players, setPlayers] = useState<Map<string, SleeperPlayer>>(new Map());
  const [results, setResults] = useState<ExpertResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [leagueType, setLeagueType] = useState<(typeof LEAGUE_TYPES)[number]>('all');
  const [pos, setPos] = useState<(typeof POSITIONS)[number]>('ALL');
  const fileRef = useRef<HTMLInputElement>(null);

  // Pipeline data (anonymized aggregates committed by the data update).
  const [gOwn, setGOwn] = useState<GenOwnership | null>(null);
  const [gAdds, setGAdds] = useState<GenAdds | null>(null);
  const [gTrades, setGTrades] = useState<GenTrades | null>(null);
  const [dataView, setDataView] = useState<'ownership' | 'adds' | 'trades' | 'rank' | 'graph'>('ownership');
  const [fmt, setFmt] = useState<FmtFilter>('all');
  const [graph, setGraph] = useState<GenGraph | null>(null);
  const [names, setNames] = useState<Record<string, string> | null>(null); // local dev file, or unlocked
  const [encNames, setEncNames] = useState<EncryptedNames | null>(null); // deployed encrypted blob
  const [ktcByName, setKtcByName] = useState<Map<string, KTCPlayer>>(new Map());
  const [graphFmt, setGraphFmt] = useState<'all' | 'dynasty' | 'redraft'>('all');
  // Compare-a-username state
  const [compareUser, setCompareUser] = useState('');
  const [userRow, setUserRow] = useState<RankRow | null>(null);
  const [userOverlap, setUserOverlap] = useState<number | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareErr, setCompareErr] = useState('');

  useEffect(() => {
    const B = import.meta.env.BASE_URL;
    const load = <T,>(f: string, set: (v: T | null) => void) =>
      fetch(`${B}data/${f}`).then((r) => (r.ok ? r.json() : null)).then(set).catch(() => set(null));
    load<GenOwnership>('expert-ownership.json', setGOwn);
    load<GenAdds>('expert-adds.json', setGAdds);
    load<GenTrades>('expert-trades.json', setGTrades);
    load<GenGraph>('expert-graph.json', setGraph);
    // Plaintext name map exists only in local dev; deployed sites fall back to
    // a previously unlocked copy (sessionStorage) or the encrypted blob.
    load<{ names: Record<string, string> }>('expert-names.json', (v) => setNames(v?.names ?? loadCachedUnlockedNames()));
    fetchEncryptedNames().then(setEncNames).catch(() => {});
    fetchKTCRankings('superflex').then((ks) => {
      const m = new Map<string, KTCPlayer>();
      for (const k of ks) m.set(normalizeForMatch(k.playerName), k);
      setKtcByName(m);
    }).catch(() => {});
  }, []);
  const hasPipeline = !!(gOwn?.players?.length || gAdds?.adds?.length || gTrades?.trades?.length);
  const expertLabel = (i: number) => names?.[String(i)] ?? `Expert #${i + 1}`;
  const unlockNames = useCallback(async (passphrase: string): Promise<boolean> => {
    if (!encNames) return false;
    const m = await decryptExpertNames(encNames, passphrase);
    if (!m) return false;
    setNames(m);
    cacheUnlockedNames(m);
    return true;
  }, [encNames]);

  // ── Trade grading (client-side, KTC dynasty values) ──
  const valuePlayer = useCallback((id: string, sf: boolean): number => {
    const k = ktcByName.get(normalizeForMatch(players.get(id)?.full_name ?? ''));
    if (!k) return 0;
    return sf ? k.superflexValue : k.value;
  }, [ktcByName, players]);
  const gradeTrade = useCallback((t: GenTrade): { got: number; gave: number; ratio: number; grade: string } => {
    let got = 0, gave = 0;
    for (const id of t.received) got += valuePlayer(id, t.sf);
    for (const id of t.gave) gave += valuePlayer(id, t.sf);
    for (const p of t.picks) { const v = dynastyPickValue(pickOverall(p.round)); if (p.to) got += v; else gave += v; }
    const total = got + gave;
    const ratio = total > 0 ? got / total : 0.5;
    return { got, gave, ratio, grade: letterGrade(ratio) };
  }, [valuePlayer]);

  // Per-expert average grade ratio + count, ranked (anonymized index → name if local).
  const expertRanking = useMemo((): RankRow[] => {
    if (!gTrades || ktcByName.size === 0) return [];
    const agg = new Map<number, { sum: number; n: number }>();
    for (const t of gTrades.trades) {
      if (t.expert == null) continue;
      const { got, gave } = gradeTrade(t);
      if (got + gave <= 0) continue; // skip ungradeable (missing values)
      const a = agg.get(t.expert) ?? { sum: 0, n: 0 };
      a.sum += got / (got + gave); a.n += 1; agg.set(t.expert, a);
    }
    const rows: RankRow[] = [];
    for (const [i, a] of agg) {
      if (a.n < 2) continue; // need a couple graded trades to rank
      rows.push({ label: expertLabel(i), isUser: false, avg: a.sum / a.n, grade: letterGrade(a.sum / a.n), trades: a.n });
    }
    return rows.sort((x, y) => y.avg - x.avg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gTrades, ktcByName, gradeTrade, names]);

  const rankedWithUser = useMemo(() => {
    const rows = [...expertRanking];
    if (userRow) rows.push(userRow);
    return rows.sort((x, y) => y.avg - x.avg);
  }, [expertRanking, userRow]);

  const runCompare = useCallback(async () => {
    const uname = compareUser.trim().replace(/^@/, '');
    if (!uname) return;
    setComparing(true); setCompareErr(''); setUserRow(null); setUserOverlap(null);
    const get = async (u: string) => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } };
    try {
      const user = await fetchSleeperUser(uname);
      const leagues = await fetchUserLeagues(user.user_id);
      const rosters = await fetchUserRostersAcrossLeagues(user.user_id, leagues);
      // Ownership overlap: share of the user's rostered players that experts also roster.
      const expertOwned = new Set((gOwn?.players ?? []).map((p) => p.id));
      const userPlayers = new Set<string>();
      for (const r of rosters) for (const pid of r.players) if (pid && pid !== '0') userPlayers.add(pid);
      let overlap = 0;
      for (const pid of userPlayers) if (expertOwned.has(pid)) overlap++;
      setUserOverlap(userPlayers.size ? overlap / userPlayers.size : 0);
      // Grade the user's trades (scan weeks 0-1 across their leagues, like the pipeline).
      let sum = 0, n = 0;
      for (const lg of leagues) {
        const ros = (await get(`${SLEEPER}/league/${lg.league_id}/rosters`)) as { owner_id?: string; roster_id?: number }[] | null;
        const mine = ros?.find((r) => r.owner_id === user.user_id);
        if (!mine || mine.roster_id == null) continue;
        const rid = mine.roster_id;
        const pos = lg.roster_positions || [];
        const sf = pos.includes('SUPER_FLEX') || pos.filter((p) => p === 'QB').length >= 2;
        const dyn = lg.settings?.type === 2;
        for (const wk of [0, 1]) {
          const txns = (await get(`${SLEEPER}/league/${lg.league_id}/transactions/${wk}`)) as Record<string, unknown>[] | null;
          if (!txns) continue;
          for (const t of txns) {
            if (t.status !== 'complete' || t.type !== 'trade' || !((t.roster_ids as number[]) || []).includes(rid)) continue;
            const adds = (t.adds as Record<string, number>) || {};
            const drops = (t.drops as Record<string, number>) || {};
            const received = Object.keys(adds).filter((pid) => adds[pid] === rid);
            const gave = Object.keys(drops).filter((pid) => drops[pid] === rid);
            const picks = ((t.draft_picks as { season: string; round: number; owner_id: number }[]) || [])
              .map((pk) => ({ season: pk.season, round: pk.round, to: pk.owner_id === rid }));
            const g = gradeTrade({ created: Number(t.created) || 0, dynasty: dyn, sf, received, gave, picks });
            if (g.got + g.gave > 0) { sum += g.ratio; n += 1; }
          }
        }
      }
      if (n > 0) setUserRow({ label: uname, isUser: true, avg: sum / n, grade: letterGrade(sum / n), trades: n });
      else setCompareErr('No gradeable trades found for that user (offseason weeks 0–1).');
    } catch (e) {
      setCompareErr(e instanceof Error ? e.message : String(e));
    } finally {
      setComparing(false);
    }
  }, [compareUser, gOwn, gradeTrade]);

  const pname = (id: string) => players.get(id)?.full_name ?? id;
  const ppos = (id: string) => players.get(id)?.position ?? '?';

  const ownRows = useMemo(() => {
    if (!gOwn) return [];
    const field: keyof GenOwnershipPlayer = fmt === 'all' ? 'rosters' : fmt;
    let rows = gOwn.players.map((p) => ({ p, metric: p[field] as number }));
    if (pos !== 'ALL') rows = rows.filter((r) => ppos(r.p.id) === pos);
    return rows.filter((r) => r.metric > 0).sort((a, b) => b.metric - a.metric);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gOwn, fmt, pos, players]);
  const ownDenom = gOwn ? (gOwn.roster_totals[fmt] || 0) : 0;

  useEffect(() => { fetchSleeperPlayers().then(setPlayers).catch(() => {}); }, []);
  useEffect(() => { localStorage.setItem(LS_KEY, JSON.stringify(experts)); }, [experts]);

  const addExpert = () => {
    const name = input.trim().replace(/^@/, '');
    if (name && !experts.some((e) => e.toLowerCase() === name.toLowerCase())) setExperts([...experts, name]);
    setInput('');
  };
  const removeExpert = (name: string) => setExperts(experts.filter((e) => e !== name));

  const exportList = () => {
    const blob = new Blob([JSON.stringify(experts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'expert-usernames.json'; a.click();
    URL.revokeObjectURL(url);
  };
  const importList = (file: File) => {
    file.text().then((t) => {
      try {
        const v = JSON.parse(t);
        if (Array.isArray(v)) {
          const incoming = v.filter((x): x is string => typeof x === 'string');
          const merged: string[] = [...experts];
          for (const name of incoming) {
            if (!merged.some((e) => e.toLowerCase() === name.toLowerCase())) merged.push(name);
          }
          setExperts(merged);
        }
      } catch { /* ignore bad file */ }
    });
  };

  const analyze = useCallback(async () => {
    if (!experts.length) return;
    setLoading(true); setResults([]);
    const out: ExpertResult[] = [];
    let i = 0;
    for (const username of experts) {
      i++; setProgress(`Loading ${username} (${i}/${experts.length})…`);
      try {
        const user = await fetchSleeperUser(username);
        const leagues = await fetchUserLeagues(user.user_id);
        const rosters = await fetchUserRostersAcrossLeagues(user.user_id, leagues);
        out.push({ username, displayName: user.display_name || username, leagues, rosters });
      } catch (e) {
        out.push({ username, displayName: username, leagues: [], rosters: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    setResults(out); setLoading(false); setProgress('');
  }, [experts]);

  const { list, totalRosters, expertsWithData } = useMemo(() => {
    const typeByLeague = new Map<string, string>();
    for (const r of results) for (const lg of r.leagues) typeByLeague.set(lg.league_id, leagueTypeName(lg));
    const map = new Map<string, ExpertOwnership>();
    let total = 0;
    const withData = new Set<string>();
    for (const r of results) {
      for (const ros of r.rosters) {
        if (leagueType !== 'all' && typeByLeague.get(ros.leagueId) !== leagueType) continue;
        total++;
        withData.add(r.username);
        const starterSet = new Set(ros.starters);
        const seen = new Set<string>();
        for (const pid of ros.players) {
          if (!pid || pid === '0' || seen.has(pid)) continue;
          seen.add(pid);
          let e = map.get(pid);
          if (!e) {
            const p = players.get(pid);
            e = { id: pid, name: p?.full_name ?? pid, position: p?.position ?? '?', team: p?.team ?? '', experts: new Set(), rosterCount: 0, starterCount: 0 };
            map.set(pid, e);
          }
          e.experts.add(r.username);
          e.rosterCount++;
          if (starterSet.has(pid)) e.starterCount++;
        }
      }
    }
    let arr = [...map.values()];
    if (pos !== 'ALL') arr = arr.filter((e) => e.position === pos);
    arr.sort((a, b) => b.experts.size - a.experts.size || b.rosterCount - a.rosterCount);
    return { list: arr, totalRosters: total, expertsWithData: withData.size };
  }, [results, players, leagueType, pos]);

  const openSnooper = (username: string) => {
    localStorage.setItem('sleeper_snoop_user', username);
    onNavigate?.('sleeper-snooper');
  };

  const btn = (active: boolean) => ({
    padding: '2px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 6,
    border: '1px solid var(--border)',
    background: active ? 'var(--accent)' : 'var(--bg-secondary)',
    color: active ? '#fff' : 'var(--text-muted)',
  });

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 20px 48px' }}>
      <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>Expert Tracker</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '0 0 4px' }}>
        Track a private list of expert Sleeper usernames to see which players they roster at the
        highest rates, and jump into any expert's trade history.
      </p>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '0 0 16px', fontStyle: 'italic' }}>
        🔒 Lists never leave your control: the data-update list lives in a gitignored file and only
        anonymized counts are published; the live-mode list below stays in this browser only.
      </p>

      {/* ── Pipeline data (from the data update) ── */}
      {hasPipeline ? (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            {(['ownership', 'adds', 'trades', 'rank', 'graph'] as const).map((v) => (
              <button key={v} onClick={() => setDataView(v)} style={{ ...btn(dataView === v), padding: '4px 12px', fontSize: 12 }}>
                {v === 'ownership' ? 'Ownership' : v === 'adds' ? 'Adds' : v === 'trades' ? 'Trades' : v === 'rank' ? 'Compare & Rank' : 'Social Graph'}
              </button>
            ))}
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {gOwn ? `${gOwn.expert_count} experts · ${gOwn.roster_totals.all} rosters` : ''}
              {gOwn ? ` · updated ${new Date(gOwn.generated).toLocaleDateString()}` : ''}
            </span>
          </div>

          {dataView === 'ownership' && gOwn && (
            <>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 8px' }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Format:</span>
                  {FMT_FILTERS.map((f) => <button key={f} onClick={() => setFmt(f)} style={btn(fmt === f)}>{FMT_LABEL[f]}</button>)}
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pos:</span>
                  {POSITIONS.map((p) => <button key={p} onClick={() => setPos(p)} style={btn(pos === p)}>{p === 'ALL' ? 'All' : p}</button>)}
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ownRows.length} players · {ownDenom} {FMT_LABEL[fmt]} rosters</span>
              </div>
              <div className="table-container" style={{ maxHeight: 600 }}>
                <table className="sched-table" style={{ fontSize: 12 }}>
                  <thead><tr><th>#</th><th>Player</th><th>Pos</th><th>Experts</th><th>Rosters</th><th>% of rosters</th><th>Start %</th></tr></thead>
                  <tbody>
                    {ownRows.slice(0, 150).map((r, i) => (
                      <tr key={r.p.id}>
                        <td className="rank-cell">{i + 1}</td>
                        <td><strong><PlayerName sleeperId={r.p.id} name={pname(r.p.id)} position={ppos(r.p.id)} /></strong></td>
                        <td><span className={`pos-badge pos-${ppos(r.p.id)}`}>{ppos(r.p.id)}</span></td>
                        <td title={`${r.p.experts} of ${gOwn.expert_count} experts`}><b>{r.p.experts}</b> / {gOwn.expert_count}</td>
                        <td>{r.metric}{ownDenom ? <span style={{ color: 'var(--text-muted)' }}> / {ownDenom}</span> : ''}</td>
                        <td>{ownDenom ? `${((r.metric / ownDenom) * 100).toFixed(0)}%` : '—'}</td>
                        <td>{r.p.rosters ? `${((r.p.starters / r.p.rosters) * 100).toFixed(0)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {dataView === 'adds' && (
            <div className="table-container" style={{ maxHeight: 600 }}>
              <table className="sched-table" style={{ fontSize: 12 }}>
                <thead><tr><th>#</th><th>Player</th><th>Pos</th><th>Experts adding</th><th>Adds</th><th>Last</th></tr></thead>
                <tbody>
                  {(gAdds?.adds ?? []).filter((a) => pos === 'ALL' || ppos(a.id) === pos).slice(0, 150).map((a, i) => (
                    <tr key={a.id}>
                      <td className="rank-cell">{i + 1}</td>
                      <td><strong><PlayerName sleeperId={a.id} name={pname(a.id)} position={ppos(a.id)} /></strong></td>
                      <td><span className={`pos-badge pos-${ppos(a.id)}`}>{ppos(a.id)}</span></td>
                      <td><b>{a.experts}</b></td>
                      <td>{a.count}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{a.last ? new Date(a.last).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {dataView === 'trades' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(gTrades?.trades ?? []).slice(0, 100).map((t, i) => {
                const g = gradeTrade(t);
                return (
                <div key={i} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                    {g.got + g.gave > 0 && (
                      <span title={`Got ${Math.round(g.got).toLocaleString()} vs gave ${Math.round(g.gave).toLocaleString()} (KTC value)`}
                        style={{ fontSize: 12, fontWeight: 800, color: gradeColor(g.grade), border: `1px solid ${gradeColor(g.grade)}`, borderRadius: 4, padding: '0 6px' }}>{g.grade}</span>
                    )}
                    {t.expert != null && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{expertLabel(t.expert)}</span>}
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>{t.dynasty ? 'Dynasty' : 'Redraft'}</span>
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>{t.sf ? 'SF' : '1QB'}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{t.created ? new Date(t.created).toLocaleDateString() : ''}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <div><span style={{ color: '#22c55e', fontWeight: 700 }}>Got:</span> {[...t.received.map(pname), ...t.picks.filter((p) => p.to).map((p) => `${p.season} R${p.round}`)].join(', ') || '—'}</div>
                    <div><span style={{ color: '#ef4444', fontWeight: 700 }}>Gave:</span> {[...t.gave.map(pname), ...t.picks.filter((p) => !p.to).map((p) => `${p.season} R${p.round}`)].join(', ') || '—'}</div>
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {dataView === 'rank' && (
            <div>
              <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
                Experts ranked by average trade grade (KTC dynasty value received ÷ total value moved). Enter a
                username to grade your trades + see your player overlap, and slot yourself into the list.
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                <input
                  type="text" placeholder="Your Sleeper username" value={compareUser}
                  onChange={(e) => setCompareUser(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void runCompare(); }}
                  style={{ padding: '5px 10px', fontSize: 13, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, minWidth: 180 }}
                />
                <button onClick={() => { void runCompare(); }} disabled={comparing || !ktcByName.size} style={{ ...btn(true), padding: '5px 12px', fontSize: 12 }}>
                  {comparing ? 'Grading…' : 'Compare me'}
                </button>
                {compareErr && <span style={{ fontSize: 11, color: '#ef4444' }}>{compareErr}</span>}
                {userOverlap != null && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Your roster ↔ expert overlap: <b>{(userOverlap * 100).toFixed(0)}%</b></span>}
              </div>
              <div className="table-container" style={{ maxHeight: 600 }}>
                <table className="sched-table" style={{ fontSize: 12 }}>
                  <thead><tr><th>#</th><th>Manager</th><th>Trade grade</th><th>Avg value share</th><th>Trades</th></tr></thead>
                  <tbody>
                    {rankedWithUser.map((r, i) => (
                      <tr key={r.label + i} style={r.isUser ? { background: '#6366f122', fontWeight: 700 } : undefined}>
                        <td className="rank-cell">{i + 1}</td>
                        <td>{r.label}{r.isUser ? ' (you)' : ''}</td>
                        <td style={{ color: gradeColor(r.grade), fontWeight: 800 }}>{r.grade}</td>
                        <td>{(r.avg * 100).toFixed(1)}%</td>
                        <td>{r.trades}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!ktcByName.size && <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading KTC values for grading…</p>}
            </div>
          )}

          {dataView === 'graph' && graph && (
            <SocialGraph
              graph={graph} fmt={graphFmt} setFmt={setGraphFmt} label={expertLabel} hasNames={!!names}
              onUnlock={encNames ? unlockNames : undefined}
            />
          )}
        </div>
      ) : (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 12, color: 'var(--text-muted)' }}>
          No published expert data yet. Add usernames to <code>private/expert-usernames.txt</code> and run{' '}
          <code>python3 scripts/build_expert_data.py</code> (or the regular data update) to generate anonymized
          Ownership / Adds / Trades aggregates. Or use live mode below.
        </div>
      )}

      <details style={{ marginBottom: 16 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13, marginBottom: 10 }}>
          Live mode — analyze a list in your browser (no data update needed)
        </summary>

      {/* Expert list manager */}
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <input
            type="text"
            placeholder="Sleeper username"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addExpert(); }}
            style={{ padding: '5px 10px', fontSize: 13, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, minWidth: 180 }}
          />
          <button onClick={addExpert} style={{ ...btn(true), padding: '5px 12px', fontSize: 12 }}>Add</button>
          <span style={{ flex: 1 }} />
          <button onClick={exportList} style={{ ...btn(false), padding: '5px 10px', fontSize: 12 }} disabled={!experts.length}>⬇ Export</button>
          <button onClick={() => fileRef.current?.click()} style={{ ...btn(false), padding: '5px 10px', fontSize: 12 }}>⬆ Import</button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) importList(f); e.target.value = ''; }} />
        </div>
        {experts.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>No experts yet — add Sleeper usernames above.</div>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {experts.map((name) => (
              <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 14, fontSize: 12 }}>
                {name}
                <button onClick={() => removeExpert(name)} title="Remove" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 }}>×</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <button onClick={() => { void analyze(); }} disabled={loading || !experts.length} style={{ ...btn(true), padding: '6px 16px', fontSize: 13 }}>
            {loading ? 'Analyzing…' : `Analyze ${experts.length} expert${experts.length === 1 ? '' : 's'}`}
          </button>
          {progress && <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text-muted)' }}>{progress}</span>}
        </div>
      </div>

      {results.length > 0 && (
        <>
          {/* Per-expert summary */}
          <div className="sched-section-title">Experts loaded</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0 16px' }}>
            {results.map((r) => (
              <div key={r.username} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12, minWidth: 160 }}>
                <div style={{ fontWeight: 700 }}>{r.displayName}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>@{r.username}</div>
                {r.error
                  ? <div style={{ color: '#ef4444', fontSize: 11, marginTop: 2 }}>{r.error}</div>
                  : <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>{r.rosters.length} rosters · {r.leagues.length} leagues</div>}
                <button onClick={() => openSnooper(r.username)} style={{ ...btn(false), marginTop: 6, padding: '2px 8px' }}>Trades →</button>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 8px' }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Format:</span>
              {LEAGUE_TYPES.map((t) => (
                <button key={t} onClick={() => setLeagueType(t)} style={btn(leagueType === t)}>{t === 'all' ? 'All' : t}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pos:</span>
              {POSITIONS.map((p) => (
                <button key={p} onClick={() => setPos(p)} style={btn(pos === p)}>{p === 'ALL' ? 'All' : p}</button>
              ))}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {list.length} players · {expertsWithData} experts · {totalRosters} rosters
            </span>
          </div>

          {/* Ownership table */}
          <div className="sched-section-title">Most-owned by experts</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            "Experts" = how many of your experts roster the player. "Rosters" = expert rosters with
            the player (a player can appear in several of one expert's leagues). "Start %" = of those, how often started.
          </p>
          <div className="table-container" style={{ maxHeight: 600 }}>
            <table className="sched-table" style={{ fontSize: 12 }}>
              <thead>
                <tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th>Experts</th><th>Rosters</th><th>% of rosters</th><th>Start %</th></tr>
              </thead>
              <tbody>
                {list.slice(0, 100).map((p, i) => (
                  <tr key={p.id}>
                    <td className="rank-cell">{i + 1}</td>
                    <td><strong><PlayerName sleeperId={p.id} name={p.name} position={p.position} /></strong></td>
                    <td><span className={`pos-badge pos-${p.position}`}>{p.position}</span></td>
                    <td>
                      {p.team && <img src={teamLogoUrl(p.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                      {' '}{p.team}
                    </td>
                    <td title={[...p.experts].join(', ')}><b>{p.experts.size}</b>{expertsWithData ? ` / ${expertsWithData}` : ''}</td>
                    <td>{p.rosterCount}{totalRosters ? <span style={{ color: 'var(--text-muted)' }}> / {totalRosters}</span> : ''}</td>
                    <td>{totalRosters ? `${((p.rosterCount / totalRosters) * 100).toFixed(0)}%` : '—'}</td>
                    <td>{p.rosterCount ? `${((p.starterCount / p.rosterCount) * 100).toFixed(0)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      </details>
    </div>
  );
}

const gbtn = (active: boolean) => ({
  padding: '2px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 6,
  border: '1px solid var(--border)',
  background: active ? 'var(--accent)' : 'var(--bg-secondary)',
  color: active ? '#fff' : 'var(--text-muted)',
});

// Passphrase field for the deployed encrypted name map. Wrong passphrase =
// failed GCM auth, surfaced inline; success flips the parent's `names` state.
function UnlockNames({ onUnlock }: { onUnlock: (passphrase: string) => Promise<boolean> }) {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async () => {
    if (!pass || busy) return;
    setBusy(true);
    setFailed(!(await onUnlock(pass)));
    setBusy(false);
  };
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 8 }}>
      <input
        type="password"
        value={pass}
        placeholder="passphrase"
        autoComplete="off"
        onChange={(e) => { setPass(e.target.value); setFailed(false); }}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        style={{ fontSize: 11, padding: '2px 6px', width: 110, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6 }}
      />
      <button onClick={() => void submit()} disabled={busy || !pass} style={gbtn(false)}>
        {busy ? 'Unlocking…' : 'Unlock names'}
      </button>
      {failed && <span style={{ fontSize: 11, color: '#ef4444' }}>wrong passphrase</span>}
    </span>
  );
}

// Circular-layout social graph: nodes = experts (size ∝ # leagues), edges =
// shared leagues. Anonymized indices; names render when the local-only name
// map is present (dev) or after unlocking the deployed encrypted map.
function SocialGraph({ graph, fmt, setFmt, label, hasNames, onUnlock }: {
  graph: GenGraph;
  fmt: 'all' | 'dynasty' | 'redraft';
  setFmt: (f: 'all' | 'dynasty' | 'redraft') => void;
  label: (i: number) => string;
  hasNames: boolean;
  onUnlock?: (passphrase: string) => Promise<boolean>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760, H = 600, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 70;
  const nodes = graph.nodes;
  const N = nodes.length || 1;
  const pos = new Map<number, { x: number; y: number }>();
  nodes.forEach((nd, i) => {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    pos.set(nd.i, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  });
  const weight = (e: GraphEdge) => (fmt === 'all' ? e.total : fmt === 'dynasty' ? e.dynasty : e.redraft);
  const edges = graph.edges.filter((e) => weight(e) > 0 && pos.has(e.a) && pos.has(e.b));
  const maxW = Math.max(1, ...edges.map(weight));
  const edgeColor = fmt === 'redraft' ? '#f59e0b' : fmt === 'dynasty' ? '#6366f1' : '#64748b';
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>League type:</span>
        {(['all', 'dynasty', 'redraft'] as const).map((f) => (
          <button key={f} onClick={() => setFmt(f)} style={gbtn(fmt === f)}>{f === 'all' ? 'All' : f === 'dynasty' ? 'Dynasty' : 'Redraft'}</button>
        ))}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
          {edges.length} shared-league links among {nodes.length} experts
          {hasNames ? '' : ' · anonymized'}
        </span>
        {!hasNames && onUnlock && <UnlockNames onUnlock={onUnlock} />}
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8 }}>
        {edges.map((e, i) => {
          const a = pos.get(e.a)!, b = pos.get(e.b)!;
          const active = hover == null || hover === e.a || hover === e.b;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={edgeColor}
            strokeWidth={0.5 + (weight(e) / maxW) * 3.5} strokeOpacity={active ? 0.5 : 0.07} />;
        })}
        {nodes.map((nd) => {
          const p = pos.get(nd.i)!;
          const active = hover == null || hover === nd.i;
          const r = 4 + Math.min(11, nd.leagues * 0.4);
          return (
            <g key={nd.i} onMouseEnter={() => setHover(nd.i)} onMouseLeave={() => setHover(null)}>
              <circle cx={p.x} cy={p.y} r={r} fill="#6366f1" fillOpacity={active ? 0.9 : 0.25} stroke="var(--bg-tertiary)" strokeWidth={1} />
              {(hover === nd.i || hasNames) && (
                <text x={p.x} y={p.y - r - 3} fontSize={9} fill="var(--text-secondary)" textAnchor="middle">{label(nd.i)}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
