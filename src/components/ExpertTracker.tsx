import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  fetchSleeperUser, fetchUserLeagues, fetchUserRostersAcrossLeagues, leagueTypeName,
  type UserLeagueRoster, type SleeperLeagueSummary,
} from '../lib/sleeper';
import { fetchSleeperPlayers } from '../data';
import type { SleeperPlayer, Tab } from '../types';
import { PlayerName } from './PlayerName';
import { teamLogoUrl } from '../lib/teamLogo';

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
        🔒 Your list is stored only in this browser (localStorage). It is never uploaded, committed
        to the repo, or included in the deployed site. Use Export to back it up.
      </p>

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
    </div>
  );
}
