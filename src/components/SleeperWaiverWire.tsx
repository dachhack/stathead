import { Fragment, useEffect, useMemo, useState } from 'react';
import { fetchSleeperUser, fetchUserLeagues, fetchLeagueRosteredIds, isDynastyLeague, type SleeperLeagueSummary } from '../lib/sleeper';
import { fetchSleeperTrending, fetchKTCRankingsForDisplay, fetchFantasyCalcRankings } from '../data';
import { loadClayProjections, computePpr, type ClayPlayer } from '../lib/waiverUtils';
import type { SleeperTrendingRow, KTCPlayer } from '../types';
import { teamLogoUrl } from '../lib/teamLogo';

const LS_KEY = 'sleeper_waiver_user';

const norm = (n: string) => n.toLowerCase().replace(/[^a-z]/g, '');

interface LeagueAvailability {
  league: SleeperLeagueSummary;
  rosteredIds: Set<string>;
}

// One row per player, merging projection + trending + dynasty-value signals.
interface Candidate {
  sleeperId: string;
  name: string;
  position: string;
  team: string;
  projPpr: number;   // 0 when not projected
  posRk: number;
  adds: number;      // 0 when not trending
  ktcValue: number;  // dynasty market value (1QB); 0 when unmatched
  ktcTrend: number | null; // 30-day KTC value change; null when unknown
  availableIn: string[];
}

type SortMode = 'proj' | 'value' | 'valueTrend' | 'adds';
type TypeFilter = 'all' | 'dynasty' | 'redraft';

export function SleeperWaiverWire() {
  const [username, setUsername] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [leagues, setLeagues] = useState<LeagueAvailability[]>([]);
  const [trending, setTrending] = useState<SleeperTrendingRow[]>([]);
  const [clayPlayers, setClayPlayers] = useState<ClayPlayer[]>([]);
  const [blended, setBlended] = useState<KTCPlayer[]>([]); // KTC rescaled to FC scale (the app's canonical value)
  const [fc, setFc] = useState<KTCPlayer[]>([]);           // FantasyCalc — used for the 30-day trend
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<string>('ALL');
  const [sortMode, setSortMode] = useState<SortMode>('proj');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sf, setSf] = useState(false); // superflex dynasty values
  const [includedIds, setIncludedIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadClayProjections().then(setClayPlayers);
    fetchSleeperTrending('add', 24, 100).then(setTrending).catch(() => {});
    fetchKTCRankingsForDisplay('1qb').then(setBlended).catch(() => {});
    fetchFantasyCalcRankings('1qb').then(setFc).catch(() => {});
  }, []);

  const valueByName = useMemo(() => {
    const m = new Map<string, KTCPlayer>();
    for (const k of blended) m.set(norm(k.playerName), k);
    return m;
  }, [blended]);

  const trendByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of fc) if (p.trend30Day != null) m.set(norm(p.playerName), p.trend30Day);
    return m;
  }, [fc]);

  const loadLeagues = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Enter a Sleeper username.'); return; }
    setLoading(true);
    setError(null);
    fetchSleeperUser(trimmed)
      .then((u) => fetchUserLeagues(u.user_id))
      .then(async (lgs) => {
        const avails = await Promise.all(
          lgs.map(async (lg) => {
            try {
              const rosteredIds = await fetchLeagueRosteredIds(lg.league_id);
              return { league: lg, rosteredIds };
            } catch { return null; }
          })
        );
        const valid = avails.filter((a): a is LeagueAvailability => a !== null);
        setLeagues(valid);
        // Default to leagues that have actually drafted (non-empty rosters) — an
        // undrafted startup has zero rostered players, so everyone looks "open".
        setIncludedIds(new Set(valid.filter((la) => la.rosteredIds.size > 0).map((la) => la.league.league_id)));
        localStorage.setItem(LS_KEY, trimmed);
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLeagues([]); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (username) loadLeagues(username);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leagues actually in scope: selected, and matching the dynasty/redraft filter.
  const effectiveLeagues = useMemo(() => leagues.filter((la) => {
    if (!includedIds.has(la.league.league_id)) return false;
    if (typeFilter === 'dynasty') return isDynastyLeague(la.league);
    if (typeFilter === 'redraft') return !isDynastyLeague(la.league);
    return true;
  }), [leagues, includedIds, typeFilter]);

  // Merge projections + trending into one candidate per player, then keep only
  // those open in at least one of your in-scope leagues.
  const candidates = useMemo(() => {
    if (!effectiveLeagues.length) return [];
    const byId = new Map<string, Candidate>();
    for (const p of clayPlayers) {
      if (!p.sleeperId) continue;
      const ppr = computePpr(p);
      if (ppr <= 0) continue;
      byId.set(p.sleeperId, {
        sleeperId: p.sleeperId, name: p.name, position: p.position, team: p.team,
        projPpr: ppr, posRk: p.pos_rk, adds: 0, ktcValue: 0, ktcTrend: null, availableIn: [],
      });
    }
    for (const t of trending) {
      const ex = byId.get(t.player_id);
      if (ex) ex.adds = t.count;
      else byId.set(t.player_id, {
        sleeperId: t.player_id, name: t.full_name, position: t.position, team: t.team,
        projPpr: 0, posRk: 0, adds: t.count, ktcValue: 0, ktcTrend: null, availableIn: [],
      });
    }
    const out: Candidate[] = [];
    for (const c of byId.values()) {
      const v = valueByName.get(norm(c.name));
      if (v) c.ktcValue = sf ? v.superflexValue : v.value;
      const tr = trendByName.get(norm(c.name));
      c.ktcTrend = tr ?? null;
      c.availableIn = effectiveLeagues.filter((la) => !la.rosteredIds.has(c.sleeperId)).map((la) => la.league.name);
      if (c.availableIn.length > 0) out.push(c);
    }
    return out;
  }, [effectiveLeagues, clayPlayers, trending, valueByName, trendByName, sf]);

  const rows = useMemo(() => {
    let list = posFilter === 'ALL' ? candidates : candidates.filter((c) => c.position === posFilter);
    const keyer: Record<SortMode, (c: Candidate) => number> = {
      proj: (c) => c.projPpr,
      value: (c) => c.ktcValue,
      valueTrend: (c) => c.ktcTrend ?? -1e9,
      adds: (c) => c.adds,
    };
    const k = keyer[sortMode];
    list = [...list].sort((a, b) => (k(b) - k(a)) || (b.projPpr - a.projPpr));
    return list.slice(0, 80);
  }, [candidates, posFilter, sortMode]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleLeague = (id: string) => {
    setIncludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const availCell = (c: Candidate) => {
    const all = c.availableIn.length === effectiveLeagues.length;
    return (
      <button
        onClick={() => toggleExpand(c.sleeperId)}
        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer', textAlign: 'left', color: all ? '#22c55e' : 'var(--text-secondary)' }}
        title="Click to list leagues"
      >
        {all ? 'All leagues' : `${c.availableIn.length}/${effectiveLeagues.length}`}
        <span style={{ color: 'var(--text-muted)', marginLeft: 4, fontSize: 9 }}>{expanded.has(c.sleeperId) ? '▲' : '▼'}</span>
      </button>
    );
  };

  return (
    <div className="sl-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>Sleeper Waiver Wire</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          Valuable players on waivers across all your leagues — ranked by projected points or add trend — and which of your leagues each is open in.
        </p>
      </div>

      <div className="controls" style={{ gap: 8 }}>
        <input
          type="text"
          placeholder="Sleeper username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') loadLeagues(username); }}
          style={{ minWidth: 200, flex: 1 }}
        />
        <button className="format-tab active" onClick={() => loadLeagues(username)} disabled={loading}>
          {loading ? 'Loading…' : 'Load Waivers'}
        </button>
      </div>

      {loading && <div className="loading"><div className="spinner" /><div className="loading-text">Fetching rosters from your leagues…</div></div>}
      {error && !loading && <div className="empty-state"><h3>Lookup failed</h3><p>{error}</p></div>}

      {!loading && leagues.length > 0 && (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '8px 0' }}>
            Scanning waivers across <b>{effectiveLeagues.length}</b> of {leagues.length} leagues · <b>{candidates.length}</b> players open in ≥1 league
          </p>

          {/* League type + per-league filters */}
          <div className="controls" style={{ gap: 6, margin: '8px 0', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Type:</span>
            {([['all', 'All'], ['dynasty', 'Dynasty'], ['redraft', 'Redraft']] as const).map(([v, label]) => (
              <button key={v} className={`format-tab ${typeFilter === v ? 'active' : ''}`} onClick={() => setTypeFilter(v)} style={{ padding: '3px 10px', fontSize: 11 }}>{label}</button>
            ))}
            <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--text-muted)' }}>Value:</span>
            <button className={`format-tab ${!sf ? 'active' : ''}`} onClick={() => setSf(false)} style={{ padding: '3px 10px', fontSize: 11 }}>1QB</button>
            <button className={`format-tab ${sf ? 'active' : ''}`} onClick={() => setSf(true)} style={{ padding: '3px 10px', fontSize: 11 }}>Superflex</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0 0 8px' }}>
            {leagues.map((la) => {
              const id = la.league.league_id;
              const on = includedIds.has(id);
              const undrafted = la.rosteredIds.size === 0;
              const dyn = isDynastyLeague(la.league);
              return (
                <button
                  key={id}
                  onClick={() => toggleLeague(id)}
                  title={undrafted ? 'Not drafted yet — no waivers' : undefined}
                  style={{
                    padding: '3px 9px', fontSize: 11, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                    background: on ? 'rgba(34,197,94,0.12)' : 'var(--bg-tertiary)',
                    color: on ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                >
                  {on ? '✓ ' : ''}{la.league.name}
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 4 }}>{dyn ? 'Dyn' : 'Rd'}</span>
                  {undrafted && <span style={{ fontSize: 9, color: '#f59e0b', marginLeft: 4 }}>undrafted</span>}
                </button>
              );
            })}
          </div>

          <div className="controls" style={{ gap: 6, margin: '8px 0', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Rank by:</span>
            {([['proj', 'Projected Pts'], ['value', 'Dynasty Value'], ['valueTrend', 'Value Trend'], ['adds', 'Add Trend']] as const).map(([v, label]) => (
              <button key={v} className={`format-tab ${sortMode === v ? 'active' : ''}`} onClick={() => setSortMode(v)} style={{ padding: '3px 10px', fontSize: 11 }}>{label}</button>
            ))}
            <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--text-muted)' }}>Pos:</span>
            {['ALL', 'QB', 'RB', 'WR', 'TE'].map((pos) => (
              <button
                key={pos}
                className={`format-tab ${posFilter === pos ? 'active' : ''}`}
                onClick={() => setPosFilter(pos)}
                style={{ padding: '3px 10px', fontSize: 11 }}
              >
                {pos}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No players available on your waivers.</p>
          ) : (
            <div className="table-container" style={{ maxHeight: 560 }}>
              <table className="sched-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>#</th><th>Player</th><th>Pos</th><th>Team</th>
                    <th title="Consensus PPR projection (full season)">Proj PPR</th>
                    <th title={`Blended dynasty value — KTC rescaled to FantasyCalc scale (${sf ? 'Superflex' : '1QB'})`}>Dyn Value{sf ? ' (SF)' : ''}</th>
                    <th title="30-day change in dynasty value (FantasyCalc)">Val Trend</th>
                    <th title="Sleeper adds, last 24h">Adds</th>
                    <th title="Leagues where this player is unrostered">Available In</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c, i) => (
                    <Fragment key={c.sleeperId}>
                      <tr>
                        <td className="rank-cell">{i + 1}</td>
                        <td><strong>{c.name}</strong></td>
                        <td><span className={`pos-badge pos-${c.position}`}>{c.position}</span></td>
                        <td>
                          {c.team && c.team !== 'FA' && <img src={teamLogoUrl(c.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                          {' '}{c.team}
                        </td>
                        <td style={{ fontWeight: 600 }}>{c.projPpr > 0 ? c.projPpr.toFixed(1) : '—'}{c.projPpr > 0 && c.posRk ? <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 10 }}> {c.position}{c.posRk}</span> : null}</td>
                        <td>{c.ktcValue > 0 ? c.ktcValue.toLocaleString() : '—'}</td>
                        <td style={{ color: c.ktcTrend == null ? 'var(--text-muted)' : c.ktcTrend > 0 ? '#22c55e' : c.ktcTrend < 0 ? '#ef4444' : 'var(--text-muted)' }}>
                          {c.ktcTrend == null ? '—' : `${c.ktcTrend > 0 ? '+' : ''}${c.ktcTrend.toLocaleString()}`}
                        </td>
                        <td style={{ color: c.adds > 0 ? 'var(--accent)' : 'var(--text-muted)', fontWeight: c.adds > 0 ? 600 : 400 }}>{c.adds > 0 ? `+${c.adds}` : '—'}</td>
                        <td style={{ fontSize: 11 }}>{availCell(c)}</td>
                      </tr>
                      {expanded.has(c.sleeperId) && (
                        <tr>
                          <td />
                          <td colSpan={8} style={{ fontSize: 10, color: 'var(--text-muted)', padding: '2px 0 8px' }}>
                            Open in: {c.availableIn.join(' · ')}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {trending.length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 6 }}>
              Sleeper trending data is unavailable right now (common in the offseason) — ranking on projections only.
            </p>
          )}
        </>
      )}
    </div>
  );
}
