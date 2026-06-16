import { useMemo, useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { usePlayerDetail } from '../hooks/usePlayerDetail';
import {
  fetchSleeperPlayers, fetchPlayerOverview,
  type PlayerNewsItem, type PlayerOverview, type PlayerFantasy,
  type PlayerRotowire, type PlayerStatistics,
} from '../data';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerName } from './PlayerName';
import { loadBlendedProjections, computePpr, type ConsensusPlayer } from '../lib/waiverUtils';
import { listProjectionScenarios, buildScenarioPprByName, buildPresetMeta } from '../lib/projectionScenario';
import { normalizeForMatch } from '../lib/nameMatch';
import { toSleeperTeam } from '../lib/teamCodes';
import type { PresetMeta } from '../lib/scenarioPresets';
import type { PlayerModel, PlayerModelDrivers } from '../lib/playerDetail';
import type { DynastyPlayer, PlayerStats, SleeperPlayer } from '../types';

interface Props {
  playerKey: string;
  onBack: () => void;
}

export function PlayerDetail({ playerKey, onBack }: Props) {
  const { data, loading, error } = usePlayerDetail(playerKey);
  const espnId = data?.crosswalk.espn_id;
  const [overview, setOverview] = useState<PlayerOverview | null>(null);
  useEffect(() => {
    setOverview(null);
    if (!espnId) return;
    let alive = true;
    fetchPlayerOverview(espnId)
      .then((o) => { if (alive) setOverview(o); })
      .catch(() => {});
    return () => { alive = false; };
  }, [espnId]);

  // Rookies/incoming players have no Dynasty team or NFL game log yet, but Sleeper
  // assigns them an NFL team once drafted — use it for the team line + depth chart.
  const sleeperId = data?.crosswalk.sleeper_id;
  const [sleeperTeam, setSleeperTeam] = useState<string | null>(null);
  useEffect(() => {
    setSleeperTeam(null);
    if (!sleeperId) return;
    let alive = true;
    fetchSleeperPlayers().then((m) => {
      const sp = m.get(sleeperId);
      if (alive && sp?.team) setSleeperTeam(sp.team);
    }).catch(() => {});
    return () => { alive = false; };
  }, [sleeperId]);

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <BackLink onBack={onBack} />
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div style={{ padding: 24 }}>
        <BackLink onBack={onBack} />
        <p style={{ color: 'var(--text-muted)' }}>
          {error || 'Player not found.'}
        </p>
      </div>
    );
  }

  const { crosswalk: cw, career, dynastyCurrent, dynastyHistory, adpHistory, modelDrivers, gameLog, gameLogSeason } = data;

  // Best available current NFL team: Dynasty → most recent game → Sleeper (rookies).
  // Normalized to Sleeper codes — Dynasty says GBP/KCC/… and nflverse says LA for
  // the Rams, and TeamRoster matches against Sleeper's team field.
  const nflTeam = toSleeperTeam(dynastyCurrent?.team || gameLog[0]?.recent_team || sleeperTeam);

  const headshotUrl = gameLog[0]?.headshot_url
    || (cw.espn_id ? `https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${cw.espn_id}.png&w=200&h=145` : null);

  return (
    <div style={{ padding: '16px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <BackLink onBack={onBack} />

      {/* Identity header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 12 }}>
        <Headshot url={headshotUrl} name={cw.display_name} position={cw.position} />
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 28 }}>{cw.display_name}</h1>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: 13, color: 'var(--text-muted)' }}>
            <span className={`pos-badge pos-${cw.position}`}>{cw.position}</span>
            {nflTeam && <span>{nflTeam}</span>}
            {cw.college && <span>{cw.college}</span>}
            {cw.birth_date && <span>DOB {cw.birth_date}</span>}
            {cw.earliest_season && cw.latest_season && (
              <span>{cw.earliest_season}–{cw.latest_season}</span>
            )}
            {cw.is_college_only && !nflTeam && <span style={{ color: 'var(--accent)' }}>Pre-NFL</span>}
            {overview?.awards.map((a) => (
              <span
                key={a.name}
                title={a.seasons?.length ? a.seasons.join(', ') : undefined}
                style={{ color: 'var(--accent)', fontWeight: 600 }}
              >
                {a.displayCount ? `${a.displayCount} ` : ''}{a.name}
              </span>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
            player_key <code>{cw.player_key}</code>
            {cw.alias_keys?.length ? (
              <> · alias_keys <code>{cw.alias_keys.join(', ')}</code></>
            ) : null}
          </div>
        </div>
      </div>

      <Cards>
        {career && <CareerCard career={career} />}
        {dynastyCurrent && <DynastyCard current={dynastyCurrent} history={dynastyHistory} />}
        {adpHistory.length > 0 && <AdpCard rows={adpHistory} />}
        {overview?.fantasy && <FantasyCard fantasy={overview.fantasy} />}
        <IdsCard cw={cw} />
      </Cards>

      {modelDrivers && (
        <ModelDriversSection drivers={modelDrivers} dynastyCurrent={dynastyCurrent} position={cw.position} />
      )}

      {gameLog.length > 0 && gameLogSeason && (
        <GameLogSection season={gameLogSeason} rows={gameLog} position={cw.position} />
      )}

      {overview?.statistics && <StatSplitsSection stats={overview.statistics} />}
      {overview?.rotowire && <RotowireSection ro={overview.rotowire} />}
      {espnId && <NewsList items={overview?.news ?? []} loading={overview === null} />}

      {nflTeam && (
        <TeamRoster team={nflTeam} selfName={cw.display_name} />
      )}
    </div>
  );
}

function newsDate(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function NewsList({ items, loading }: { items: PlayerNewsItem[]; loading: boolean }) {
  if (!loading && !items.length) return null; // hide when there's no news (or worker not deployed)

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Recent News</h2>
      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading news…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((n, i) => (
            <div key={i} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                {n.link
                  ? <a href={n.link} target="_blank" rel="noreferrer" style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', textDecoration: 'none' }}>{n.headline}</a>
                  : <span style={{ fontWeight: 700, fontSize: 14 }}>{n.headline}</span>}
                {n.published && <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{newsDate(n.published)}</span>}
              </div>
              {n.description && <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{n.description}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RotowireSection({ ro }: { ro: PlayerRotowire }) {
  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Latest Status</h2>
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{ro.headline}</span>
          {ro.published && <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{newsDate(ro.published)}</span>}
        </div>
        {ro.story && ro.story !== ro.headline && (
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{ro.story}</p>
        )}
      </div>
    </div>
  );
}

const NORM = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

// Fallback match key for Consensus↔Sleeper: last name + team + position. Catches
// nickname mismatches (Consensus "Cameron Ward" vs Sleeper "Cam Ward") and rookies
// that Consensus hasn't stamped with a sleeper_id yet.
const NAME_SUFFIX = /\s+(jr|sr|ii|iii|iv|v)$/i;
const altKey = (name: string, team: string, pos: string) => {
  const last = name.replace(NAME_SUFFIX, '').trim().split(/\s+/).pop() || name;
  return `${NORM(last)}|${team}|${pos}`;
};

function TeamRoster({ team, selfName }: { team: string; selfName: string }) {
  const [players, setPlayers] = useState<SleeperPlayer[]>([]);
  const [consensus, setConsensus] = useState<ConsensusPlayer[]>([]);
  const [presetMeta, setPresetMeta] = useState<PresetMeta>(new Map());
  const [sortMode, setSortMode] = useState<'depth' | 'proj'>('depth');
  const [projScenarioId, setProjScenarioId] = useState<string>('');
  const projScenarios = useMemo(() => listProjectionScenarios(), []);

  useEffect(() => {
    let alive = true;
    fetchSleeperPlayers().then((m) => {
      if (!alive) return;
      const out: SleeperPlayer[] = [];
      for (const p of m.values()) {
        if (p.team === team && ['QB', 'RB', 'WR', 'TE'].includes(p.position)) out.push(p);
      }
      setPlayers(out);
      setPresetMeta(buildPresetMeta(m));
    }).catch(() => {});
    return () => { alive = false; };
  }, [team]);

  useEffect(() => {
    let alive = true;
    loadBlendedProjections().then((all) => { if (alive) setConsensus(all); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Consensus projection lookups: by sleeper id, exact normalized name, and a
  // last-name+team+position fallback (rookies/nicknames Consensus hasn't crosswalked).
  const consensusIndex = useMemo(() => {
    const byId = new Map<string, ConsensusPlayer>();
    const byName = new Map<string, ConsensusPlayer>();
    const byAlt = new Map<string, ConsensusPlayer>();
    for (const c of consensus) {
      if (c.sleeperId) byId.set(c.sleeperId, c);
      const nn = NORM(c.name);
      if (!byName.has(nn)) byName.set(nn, c);
      const ak = altKey(c.name, c.team, c.position);
      const prev = byAlt.get(ak);
      if (!prev || computePpr(c) > computePpr(prev)) byAlt.set(ak, c); // starter wins ties
    }
    return { byId, byName, byAlt };
  }, [consensus]);
  const matchConsensus = (p: SleeperPlayer): ConsensusPlayer | undefined =>
    consensusIndex.byId.get(p.player_id)
    ?? consensusIndex.byName.get(NORM(p.full_name))
    ?? consensusIndex.byAlt.get(altKey(p.full_name, p.team, p.position));

  // Scenario-adjusted PPR by normalized name (null = no scenario selected).
  const adjByName = useMemo(
    () => buildScenarioPprByName(consensus, projScenarioId, presetMeta),
    [consensus, projScenarioId, presetMeta],
  );

  if (!players.length) return null;
  const self = NORM(selfName);
  const projFor = (p: SleeperPlayer): number => {
    const c = matchConsensus(p);
    if (!c) return 0;
    const base = computePpr(c);
    return adjByName?.get(normalizeForMatch(c.name)) ?? base;
  };

  const groups = (['QB', 'RB', 'WR', 'TE'] as const)
    .map((pos) => {
      const ps = players.filter((p) => p.position === pos).slice();
      ps.sort((a, b) => {
        if (sortMode === 'proj') return projFor(b) - projFor(a);
        // Depth chart order (1 = starter); unranked players sort last, then name.
        const da = a.depth_chart_order ?? 999;
        const db = b.depth_chart_order ?? 999;
        return da !== db ? da - db : a.full_name.localeCompare(b.full_name);
      });
      return [pos, ps] as const;
    })
    .filter(([, ps]) => ps.length);

  const tabStyle = (active: boolean) => ({
    padding: '3px 10px', fontSize: 11, cursor: 'pointer', borderRadius: 6,
    border: '1px solid var(--border)',
    background: active ? 'var(--accent)' : 'var(--bg-secondary)',
    color: active ? '#fff' : 'var(--text-muted)',
  });

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <img src={teamLogoUrl(team)} alt="" width={20} height={20} style={{ objectFit: 'contain' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        {team} Roster
      </h2>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 10px' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Sort:</span>
        <button style={tabStyle(sortMode === 'depth')} onClick={() => setSortMode('depth')}>Depth Chart</button>
        <button style={tabStyle(sortMode === 'proj')} onClick={() => setSortMode('proj')}>Proj Pts</button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>Scenario:</span>
        <select
          value={projScenarioId}
          onChange={(e) => setProjScenarioId(e.target.value)}
          style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6 }}
        >
          <option value="">None (Consensus)</option>
          {projScenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {groups.map(([pos, ps]) => (
          <div key={pos} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: 0.5 }}>{pos}</div>
            {ps.map((p) => {
              const isSelf = NORM(p.full_name) === self;
              const proj = projFor(p);
              return (
                <div key={p.player_id} style={{ fontSize: 13, padding: '2px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {isSelf
                      ? <span style={{ fontWeight: 700, color: 'var(--accent)' }}>{p.full_name}</span>
                      : <PlayerName sleeperId={p.player_id} name={p.full_name} position={p.position} />}
                  </span>
                  {proj > 0 && (
                    <span title="Projected PPR points (Consensus)" style={{ flexShrink: 0, color: '#6366f1', fontWeight: 600, fontSize: 12 }}>
                      {proj.toFixed(0)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); onBack(); }}
      style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: 13 }}
    >
      ← Back
    </a>
  );
}

function Headshot({ url, name, position }: { url: string | null; name: string; position: string }) {
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2);
  const size = 72;
  if (!url) {
    return (
      <div
        className={`pos-${position}`}
        style={{
          width: size, height: size, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
          fontSize: 22, fontWeight: 700, letterSpacing: 1,
        }}
      >
        {initials}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={name}
      style={{
        width: size, height: size, borderRadius: '50%', objectFit: 'cover',
        flexShrink: 0, background: 'var(--bg-tertiary)',
      }}
      onError={(e) => {
        const el = e.currentTarget;
        el.style.display = 'none';
      }}
    />
  );
}

function Cards({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 20 }}>
      {children}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function CareerCard({ career }: { career: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['career'] }) {
  if (!career) return null;
  // percentile / boom / bust are stored on a 0–100 scale already.
  const pct = career.percentile != null ? `${Math.round(career.percentile)}` : '—';
  return (
    <Card title="Career Prediction">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
        <Stat label="Predicted Career PPG" value={career.predictedCareerPPG?.toFixed(2)} />
        <Stat label="Model Tier" value={career.modelTier || '—'} />
        <Stat label="Percentile" value={pct} />
        <Stat label="Combined Score" value={career.combinedScore?.toFixed(2) ?? '—'} />
        {career.boomProb != null && <Stat label="Boom Prob" value={`${Math.round(career.boomProb)}%`} />}
        {career.bustProb != null && <Stat label="Bust Prob" value={`${Math.round(career.bustProb)}%`} />}
        {career.actualPPG != null && <Stat label="Actual PPG" value={career.actualPPG.toFixed(2)} />}
        {career.draftSeason != null && <Stat label="Draft Class" value={String(career.draftSeason)} />}
        {career.projRound != null && <Stat label="Proj Round" value={String(career.projRound)} />}
        {career.projPick != null && <Stat label="Proj Pick" value={String(career.projPick)} />}
      </div>
    </Card>
  );
}

function DynastyCard({
  current,
  history,
}: {
  current: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['dynastyCurrent'];
  history: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['dynastyHistory'];
}) {
  if (!current) return null;
  const points = history?.oneQB?.valueHistory || [];
  // Show last 12 months
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const recent = points.filter((p) => new Date(p.d) >= cutoff);
  return (
    <Card title="Dynasty Value">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
        <Stat label="1QB Value" value={String(current.value)} />
        <Stat label="SF Value" value={String(current.superflexValue)} />
        <Stat label="Pos Rank" value={`${current.position}${current.positionRank}`} />
        <Stat label="Age" value={current.age ? String(current.age) : '—'} />
      </div>
      {recent.length > 1 && (
        <div style={{ height: 120, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={recent} margin={{ top: 5, right: 6, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="d"
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={(d: string) => {
                  const date = new Date(d);
                  return `${date.getMonth() + 1}/${String(date.getFullYear()).slice(2)}`;
                }}
                minTickGap={30}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                domain={['auto', 'auto']}
                width={40}
              />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                labelFormatter={(d) => new Date(String(d)).toLocaleDateString()}
              />
              <Line type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function AdpCard({ rows }: { rows: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['adpHistory'] }) {
  return (
    <Card title="ADP History">
      <div style={{ height: 140 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 5, right: 6, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="season"
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              type="number"
              domain={['dataMin', 'dataMax']}
              allowDecimals={false}
            />
            {/* ADP lower number = better → invert y-axis for intuition. */}
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              reversed
              width={40}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
            />
            <Line type="monotone" dataKey="adp" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        {rows.length} season{rows.length === 1 ? '' : 's'} of historical redraft ADP (lower = earlier pick).
      </div>
    </Card>
  );
}

function FantasyCard({ fantasy }: { fantasy: PlayerFantasy }) {
  return (
    <Card title="ESPN Fantasy (Redraft)">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
        <Stat label="Position Rank" value={fantasy.positionRank ? `#${fantasy.positionRank}` : undefined} />
        <Stat label="% Rostered" value={fantasy.percentOwned ? `${fantasy.percentOwned}%` : undefined} />
        <Stat label="Draft Rank" value={fantasy.draftRank ? `#${fantasy.draftRank}` : undefined} />
      </div>
      {fantasy.projection && (
        <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {fantasy.projection}
        </p>
      )}
    </Card>
  );
}

function IdsCard({ cw }: { cw: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['crosswalk'] }) {
  const ids: Array<[string, string | number | undefined]> = [
    ['gsis', cw.gsis_id],
    ['pfr', cw.pfr_id],
    ['sleeper', cw.sleeper_id],
    ['espn', cw.espn_id],
    ['pff', cw.pff_id],
    ['yahoo', cw.yahoo_id],
    ['sportradar', cw.sportradar_id],
    ['rotowire', cw.rotowire_id],
    ['fantasy_data', cw.fantasy_data_id],
    ['ktc', cw.ktc_id],
  ];
  const present = ids.filter(([, v]) => v);
  if (!present.length) return null;
  return (
    <Card title="External IDs">
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12, fontFamily: 'monospace' }}>
        {present.map(([label, val]) => (
          <div key={label} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--text-muted)' }}>{label}</span>
            <span>{String(val)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{value ?? '—'}</div>
    </div>
  );
}

// ── Model feature drivers ─────────────────────────────────────────────────
// One panel per model that scores the player, listing the top features that
// pushed its prediction and where the player lands vs the positional cohort.
// Data: public/data/model-eval-2026.json (built by scripts/build-model-eval.mjs).

function pctlColor(p: number): string {
  if (p >= 90) return '#22c55e';
  if (p >= 75) return '#4ade80';
  if (p >= 60) return '#a3e635';
  if (p >= 40) return '#facc15';
  if (p >= 20) return '#fb923c';
  return '#ef4444';
}

// Translate a feature's percentile into "how good is this for the player",
// honoring the model's learned direction. Returns null for weak/mixed signals
// so the bar reads as neutral rather than implying a good/bad lean.
function goodness(relationship: string, pctile: number): number | null {
  if (relationship.includes('weaker')) return 100 - pctile;
  if (relationship.includes('stronger')) return pctile;
  return null;
}

function fmtNum(v: number | string | undefined, digits = 1): string {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function predictionLine(m: PlayerModel, position: string): { main: string; sub?: string } {
  const p = m.prediction || {};
  switch (m.id) {
    case 'hitBust': {
      const ci = (typeof p.ciLower === 'number' && typeof p.ciUpper === 'number')
        ? `80% CI ${fmtNum(p.ciLower)}–${fmtNum(p.ciUpper)}` : undefined;
      return { main: `VOR ${fmtNum(p.vor)} · ${p.hitProb ?? ''}`, sub: ci };
    }
    case 'projection':
      return { main: `${fmtNum(p.ppg)} PPG`, sub: 'projected fantasy points / game' };
    case 'rookieCareer': {
      const bits: string[] = [];
      if (p.tier != null) bits.push(`Tier ${p.tier}`);
      if (p.percentile != null) bits.push(`${fmtNum(p.percentile, 0)}th pctl`);
      if (typeof p.boomProb === 'number') bits.push(`boom ${fmtNum(p.boomProb, 0)}%`);
      return { main: `${fmtNum(p.careerPPG)} career PPG`, sub: bits.join(' · ') || undefined };
    }
    case 'share': {
      const t = typeof p.targetShare === 'number' ? `${fmtNum(p.targetShare * 100)}% of team targets` : '';
      const sub = (position === 'RB' && typeof p.rushShare === 'number' && p.rushShare > 0)
        ? `${fmtNum(p.rushShare * 100, 0)}% of team carries` : undefined;
      return { main: t || 'usage share', sub };
    }
    default:
      return { main: '' };
  }
}

function DriverRow({ d }: { d: NonNullable<PlayerModel['drivers']>[number] }) {
  const good = goodness(d.relationship, d.pctile);
  const barPct = good ?? d.pctile;
  const color = good != null ? pctlColor(good) : 'var(--text-muted)';
  const arrow = good == null ? '~' : d.relationship.includes('weaker') ? '↓' : '↑';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '118px 1fr 16px 40px', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span title={`${d.category}${d.category ? ' · ' : ''}${d.relationship}`}
        style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {d.feature}
      </span>
      <div title={`${d.band} (pctl ${d.pctile})`} style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${barPct}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span title={d.relationship} style={{ fontSize: 11, color, textAlign: 'center' }}>{arrow}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {d.value != null ? fmtNum(d.value, Math.abs(d.value) < 1 && d.value !== 0 ? 2 : 1) : '—'}
      </span>
    </div>
  );
}

function ModelPanel({ m, position, dynastyCurrent }: {
  m: PlayerModel;
  position: string;
  dynastyCurrent: DynastyPlayer | null;
}) {
  const { main, sub } = predictionLine(m, position);
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{m.label}</h3>
        {m.noteOnly
          ? (dynastyCurrent && <span style={{ fontSize: 14, fontWeight: 700 }}>{dynastyCurrent.value} <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>1QB · {dynastyCurrent.position}{dynastyCurrent.positionRank}</span></span>)
          : main && <span style={{ fontSize: 14, fontWeight: 700 }}>{main}</span>}
      </div>
      {!m.noteOnly && sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
      {m.blurb && <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{m.blurb}</p>}
      {!m.noteOnly && m.drivers && m.drivers.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 6 }}>
            Top drivers · bar = percentile vs position (greener = helps this player) · ↑/↓ = feature's pull on the score · value
          </div>
          {m.drivers.map((d, i) => <DriverRow key={i} d={d} />)}
        </div>
      )}
    </div>
  );
}

function ModelDriversSection({ drivers, dynastyCurrent, position }: {
  drivers: PlayerModelDrivers;
  dynastyCurrent: DynastyPlayer | null;
  position: string;
}) {
  const models = drivers.models.filter((m) => m.noteOnly || (m.drivers && m.drivers.length > 0));
  if (!models.length) return null;
  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>What's Behind Each Score</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        The top features feeding each StatHead model's 2026 prediction for this player.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        {models.map((m) => <ModelPanel key={m.id} m={m} position={position} dynastyCurrent={dynastyCurrent} />)}
      </div>
      {drivers.dataGaps && drivers.dataGaps.length > 0 && (
        <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Data not available (excluded from drivers rather than scored as 0): {drivers.dataGaps.join(', ')}.
        </p>
      )}
    </div>
  );
}

function GameLogSection({ season, rows, position }: { season: number; rows: PlayerStats[]; position: string }) {
  const totals = useMemo(() => {
    const t = rows.reduce(
      (acc, r) => ({
        games: acc.games + 1,
        ppr: acc.ppr + (r.fantasy_points_ppr || 0),
        pass: acc.pass + (r.passing_yards || 0),
        passTd: acc.passTd + (r.passing_tds || 0),
        rush: acc.rush + (r.rushing_yards || 0),
        rushTd: acc.rushTd + (r.rushing_tds || 0),
        rec: acc.rec + (r.receptions || 0),
        recYd: acc.recYd + (r.receiving_yards || 0),
        recTd: acc.recTd + (r.receiving_tds || 0),
      }),
      { games: 0, ppr: 0, pass: 0, passTd: 0, rush: 0, rushTd: 0, rec: 0, recYd: 0, recTd: 0 },
    );
    return t;
  }, [rows]);

  const isSkill = position === 'WR' || position === 'RB' || position === 'TE' || position === 'FB';
  const isQb = position === 'QB';

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Game Log — {season}</h2>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        {totals.games} games · {totals.ppr.toFixed(1)} PPR
        {isQb && <> · {totals.pass} pass yd · {totals.passTd} TD</>}
        {isSkill && (
          <>
            {' · '}{totals.rec} rec / {totals.recYd} yd / {totals.recTd} TD
            {(totals.rush > 0 || totals.rushTd > 0) && <> · {totals.rush} rush yd / {totals.rushTd} TD</>}
          </>
        )}
      </div>
      <div style={{ overflowX: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--bg-tertiary)' }}>
              <Th>Wk</Th>
              <Th>Team</Th>
              <Th>Opp</Th>
              <Th right>PPR</Th>
              {isQb && <><Th right>Pass Yd</Th><Th right>TD</Th><Th right>INT</Th></>}
              {isSkill && <><Th right>Rec</Th><Th right>Tgt</Th><Th right>Rec Yd</Th><Th right>Rec TD</Th></>}
              {(isSkill || isQb) && <><Th right>Rush Yd</Th><Th right>Rush TD</Th></>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.season}-${r.week}`} style={{ borderTop: '1px solid var(--border)' }}>
                <Td>{r.week}</Td>
                <Td>{r.recent_team}</Td>
                <Td>{r.opponent_team}</Td>
                <Td right>{(r.fantasy_points_ppr || 0).toFixed(1)}</Td>
                {isQb && <><Td right>{r.passing_yards || 0}</Td><Td right>{r.passing_tds || 0}</Td><Td right>{r.interceptions || 0}</Td></>}
                {isSkill && <><Td right>{r.receptions || 0}</Td><Td right>{r.targets || 0}</Td><Td right>{r.receiving_yards || 0}</Td><Td right>{r.receiving_tds || 0}</Td></>}
                {(isSkill || isQb) && <><Td right>{r.rushing_yards || 0}</Td><Td right>{r.rushing_tds || 0}</Td></>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, right, title }: { children: React.ReactNode; right?: boolean; title?: string }) {
  return (
    <th title={title} style={{
      padding: '6px 10px',
      textAlign: right ? 'right' : 'left',
      fontWeight: 600,
      color: 'var(--text-muted)',
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    }}>{children}</th>
  );
}

function StatSplitsSection({ stats }: { stats: PlayerStatistics }) {
  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>{stats.displayName || 'Statistics'}</h2>
      <div style={{ overflowX: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--bg-tertiary)' }}>
              <Th>Split</Th>
              {stats.labels.map((l, i) => (
                <Th key={i} right title={stats.displayNames?.[i]}>{l}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.splits.map((s, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <Td>{s.displayName}</Td>
                {stats.labels.map((_, j) => (
                  <Td key={j} right>{s.stats[j] ?? ''}</Td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td style={{ padding: '6px 10px', textAlign: right ? 'right' : 'left' }}>{children}</td>
  );
}
