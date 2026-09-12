/**
 * Trade Finisher — the Sleeper-aware half of the Trade Calculator. Sign in
 * with a Sleeper username, pick a league and a trade partner, mark the offer
 * on the table, and it reads both rosters' needs (against the league, in the
 * league's lineup and scoring) and searches the nearby offers, draft picks
 * included, for versions that are about fair and serve both teams' goals.
 *
 * All the arithmetic lives in src/lib/tradeFinisher.ts; this file is the
 * fetching, the selections and the rendering.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DynastyPlayer } from '../types';
import { PlayerName } from './PlayerName';
import { LeagueFormatBadges } from './LeagueFormatBadges';
import {
  fetchSleeperUser, fetchUserLeagues, importLeague, fetchTradedPicks, leagueFormatInfo, isDynastyLeague, qbFormatLabel,
  type LeagueImport, type SleeperLeagueSummary, type SleeperTradedPick,
} from '../lib/sleeper';
import { loadBlendedProjections, computeCustomScore, computePpr, type ConsensusPlayer } from '../lib/waiverUtils';
import { normalizeForMatch } from '../lib/nameMatch';
import type { TepLevel } from '../lib/dynastyForecast';
import {
  buildFinisherTeams, computeNeeds, evaluateOffer, suggestFinishes, describeEdit, isSuperflexLeague, tepLevelFromScoring,
  GOAL_LABEL, SKILL_POSITIONS, DEFAULT_TOLERANCE_PCT,
  type FinisherAsset, type FinisherTeam, type Offer, type OfferEval, type TeamNeeds, type TradeGoal, type Variant, type Verdict,
} from '../lib/tradeFinisher';

const GIVE_COLOR = '#6366f1';   // matches the calculator's Side A
const GET_COLOR = '#f59e0b';    // matches Side B
const MUTED = 'var(--text-muted)';

const VERDICT_LABEL: Record<Verdict, string> = { fair: 'Fair', slight: 'Slight edge', uneven: 'Uneven', lopsided: 'Lopsided' };
const VERDICT_COLOR: Record<Verdict, string> = { fair: '#22c55e', slight: '#a3e635', uneven: '#facc15', lopsided: '#ef4444' };
const GOAL_COLOR: Record<TradeGoal, string> = { 'win-now': '#ef4444', balanced: MUTED, rebuild: '#22c55e' };

type GoalChoice = TradeGoal | 'auto';

interface Saved {
  username?: string;
  leagueId?: string;
  myRosterId?: number | null;
  partnerRosterId?: number | null;
  myGoal?: GoalChoice;
  partnerGoal?: GoalChoice;
  give?: string[];
  get?: string[];
  open?: boolean;
}
const SAVED_KEY = 'stathead:trade-finisher';
const LS_USER_KEY = 'sleeper_username'; // shared with the Sleeper league views
function readSaved(): Saved {
  try { return JSON.parse(sessionStorage.getItem(SAVED_KEY) ?? '{}') as Saved; } catch { return {}; }
}
function writeSaved(s: Saved) {
  try { sessionStorage.setItem(SAVED_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

const fmt = (n: number) => Math.round(n).toLocaleString();
const signed = (n: number, digits = 0) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(digits);

interface Props {
  /** The dynasty board for the calculator's current format (prices come from here). */
  dynasty: DynastyPlayer[];
  leagueFormat: '1qb' | 'superflex';
  tepLevel: TepLevel;
  /** A league was chosen: switch the calculator to its format and TE premium. */
  onLeagueDetected: (format: '1qb' | 'superflex', tep: TepLevel) => void;
  /** Push an offer into the calculator's two sides (you give = Side A). */
  onLoadTrade: (give: DynastyPlayer[], get: DynastyPlayer[]) => void;
}

export function TradeFinisher({ dynasty, leagueFormat, tepLevel, onLeagueDetected, onLoadTrade }: Props) {
  const [saved] = useState<Saved>(() => readSaved());
  const [open, setOpen] = useState<boolean>(() => saved.open ?? Boolean(saved.leagueId));
  const [username, setUsername] = useState<string>(() => saved.username ?? (typeof localStorage !== 'undefined' ? localStorage.getItem(LS_USER_KEY) ?? '' : ''));
  const [userId, setUserId] = useState<string | null>(null);
  const [leagues, setLeagues] = useState<SleeperLeagueSummary[]>([]);
  const [userBusy, setUserBusy] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);

  const [leagueId, setLeagueId] = useState<string>(() => saved.leagueId ?? '');
  const [data, setData] = useState<LeagueImport | null>(null);
  const [tradedPicks, setTradedPicks] = useState<SleeperTradedPick[]>([]);
  const [leagueBusy, setLeagueBusy] = useState(false);
  const [leagueError, setLeagueError] = useState<string | null>(null);
  const [projections, setProjections] = useState<ConsensusPlayer[]>([]);

  const [myRosterId, setMyRosterId] = useState<number | null>(() => saved.myRosterId ?? null);
  const [partnerRosterId, setPartnerRosterId] = useState<number | null>(() => saved.partnerRosterId ?? null);
  const [myGoal, setMyGoal] = useState<GoalChoice>(() => saved.myGoal ?? 'auto');
  const [partnerGoal, setPartnerGoal] = useState<GoalChoice>(() => saved.partnerGoal ?? 'auto');
  const [giveIds, setGiveIds] = useState<string[]>(() => saved.give ?? []);
  const [getIds, setGetIds] = useState<string[]>(() => saved.get ?? []);
  const [giveFilter, setGiveFilter] = useState<string>('ALL');
  const [getFilter, setGetFilter] = useState<string>('ALL');
  const [loadedNote, setLoadedNote] = useState<string | null>(null);

  // Persist every selection (the player-detail page unmounts this component).
  useEffect(() => {
    writeSaved({ username, leagueId, myRosterId, partnerRosterId, myGoal, partnerGoal, give: giveIds, get: getIds, open });
  }, [username, leagueId, myRosterId, partnerRosterId, myGoal, partnerGoal, giveIds, getIds, open]);

  useEffect(() => {
    let alive = true;
    loadBlendedProjections().then((p) => { if (alive) setProjections(p); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const lookupUser = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { setUserError('Enter a Sleeper username.'); return; }
    setUserBusy(true);
    setUserError(null);
    fetchSleeperUser(trimmed)
      .then((u) => { setUserId(u.user_id); return fetchUserLeagues(u.user_id); })
      .then((ls) => {
        // Dynasty leagues first — that is where picks and windows matter.
        ls.sort((a, b) => Number(isDynastyLeague(b)) - Number(isDynastyLeague(a)) || a.name.localeCompare(b.name));
        setLeagues(ls);
        try { localStorage.setItem(LS_USER_KEY, trimmed); } catch { /* private mode */ }
      })
      .catch((e: unknown) => { setUserError(e instanceof Error ? e.message : String(e)); setLeagues([]); })
      .finally(() => setUserBusy(false));
  };

  const loadLeague = (id: string, keepSelections: boolean) => {
    const trimmed = id.trim();
    setLeagueId(trimmed);
    setData(null);
    setTradedPicks([]);
    setLeagueError(null);
    if (!keepSelections) { setMyRosterId(null); setPartnerRosterId(null); setGiveIds([]); setGetIds([]); }
    if (!trimmed) return;
    setLeagueBusy(true);
    Promise.all([importLeague(trimmed), fetchTradedPicks(trimmed)])
      .then(([res, picks]) => {
        setData(res);
        setTradedPicks(picks);
        const pos = res.league.roster_positions ?? [];
        onLeagueDetected(isSuperflexLeague(pos) ? 'superflex' : '1qb', tepLevelFromScoring(res.league.scoring_settings));
      })
      .catch((e: unknown) => setLeagueError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLeagueBusy(false));
  };

  // First mount: restore the saved user + league.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    if (username) lookupUser(username);
    if (saved.leagueId) loadLeague(saved.leagueId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the league and the user are both known, default "your team" to the
  // user's roster if nothing is chosen yet.
  useEffect(() => {
    if (!data || !userId || myRosterId != null) return;
    const mine = data.teams.find((t) => t.ownerId === userId);
    if (mine) setMyRosterId(mine.rosterId);
  }, [data, userId, myRosterId]);

  const league = data?.league ?? null;
  const rosterPositions = useMemo(() => league?.roster_positions ?? [], [league]);
  const scoring = useMemo(() => league?.scoring_settings ?? {}, [league]);
  const isDynasty = isDynastyLeague(league);

  // Projected season points in the league's scoring, by Sleeper id and by name.
  const { projBySleeperId, projByName } = useMemo(() => {
    const byId = new Map<string, number>();
    const byName = new Map<string, number>();
    const custom = Object.keys(scoring).length > 0;
    for (const p of projections) {
      const pts = custom ? computeCustomScore(p, scoring) : computePpr(p);
      if (p.sleeperId) byId.set(p.sleeperId, pts);
      byName.set(normalizeForMatch(p.name), pts);
    }
    return { projBySleeperId: byId, projByName: byName };
  }, [projections, scoring]);

  const teams = useMemo<FinisherTeam[]>(() => {
    if (!data) return [];
    return buildFinisherTeams(data.teams, {
      dynasty, isSuperflex: leagueFormat === 'superflex', tepLevel, rosterPositions,
      projBySleeperId, projByName, tradedPicks: isDynasty ? tradedPicks : [], seasons: isDynasty ? undefined : [],
    });
  }, [data, dynasty, leagueFormat, tepLevel, rosterPositions, projBySleeperId, projByName, tradedPicks, isDynasty]);

  const me = teams.find((t) => t.rosterId === myRosterId) ?? null;
  const partner = teams.find((t) => t.rosterId === partnerRosterId) ?? null;
  const myNeeds = useMemo(() => (me ? computeNeeds(me, teams, rosterPositions) : null), [me, teams, rosterPositions]);
  const partnerNeeds = useMemo(() => (partner ? computeNeeds(partner, teams, rosterPositions) : null), [partner, teams, rosterPositions]);
  const myGoalEff: TradeGoal = myGoal === 'auto' ? (myNeeds?.inferredGoal ?? 'balanced') : myGoal;
  const partnerGoalEff: TradeGoal = partnerGoal === 'auto' ? (partnerNeeds?.inferredGoal ?? 'balanced') : partnerGoal;

  const offer = useMemo<Offer>(() => ({
    give: giveIds.map((id) => me?.assets.find((a) => a.id === id)).filter((a): a is FinisherAsset => !!a),
    get: getIds.map((id) => partner?.assets.find((a) => a.id === id)).filter((a): a is FinisherAsset => !!a),
  }), [giveIds, getIds, me, partner]);

  const ctx = useMemo(() => (me && partner && myNeeds && partnerNeeds
    ? { rosterPositions, myGoal: myGoalEff, partnerGoal: partnerGoalEff, myNeeds, partnerNeeds }
    : null), [me, partner, myNeeds, partnerNeeds, rosterPositions, myGoalEff, partnerGoalEff]);

  const evaluation = useMemo<OfferEval | null>(() => (
    ctx && me && partner && offer.give.length && offer.get.length ? evaluateOffer(offer, me, partner, ctx) : null
  ), [ctx, me, partner, offer]);

  const variants = useMemo<Variant[]>(() => (
    ctx && me && partner ? suggestFinishes(offer, me, partner, ctx, { max: 8 }) : []
  ), [ctx, me, partner, offer]);

  const toggle = (side: 'give' | 'get', id: string) => {
    const [ids, set] = side === 'give' ? [giveIds, setGiveIds] : [getIds, setGetIds];
    set(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  };
  const applyOffer = (o: Offer) => { setGiveIds(o.give.map((a) => a.id)); setGetIds(o.get.map((a) => a.id)); };

  // Load an offer into the calculator: players by their board row, picks by
  // the board's Early/Mid/Late row. Anything unpriced is left out and named.
  const loadIntoCalculator = (o: Offer) => {
    const byId = new Map(dynasty.map((d) => [d.playerID, d]));
    const resolve = (xs: FinisherAsset[]) => xs.map((a) => (a.ktcId != null ? byId.get(a.ktcId) : undefined));
    const give = resolve(o.give), get = resolve(o.get);
    const resolved = [...give, ...get];
    const missing = [...o.give, ...o.get].filter((_, i) => !resolved[i]).map((a) => a.name);
    onLoadTrade(give.filter((d): d is DynastyPlayer => !!d), get.filter((d): d is DynastyPlayer => !!d));
    setLoadedNote(missing.length ? `Loaded into the calculator below (no board value for ${missing.join(', ')}).` : 'Loaded into the calculator below.');
    window.setTimeout(() => setLoadedNote(null), 4000);
  };

  const goalButtons = (value: GoalChoice, onChange: (g: GoalChoice) => void, inferred: TradeGoal | undefined) => (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {(['auto', 'win-now', 'balanced', 'rebuild'] as GoalChoice[]).map((g) => (
        <button key={g} className={`format-tab ${value === g ? 'active' : ''}`} onClick={() => onChange(g)}
          style={{ padding: '3px 9px', fontSize: 11 }}
          title={g === 'auto' && inferred ? `Read from the roster: ${GOAL_LABEL[inferred]}` : undefined}>
          {g === 'auto' ? `Auto${inferred ? ` (${GOAL_LABEL[inferred]})` : ''}` : GOAL_LABEL[g]}
        </button>
      ))}
    </div>
  );

  return (
    <div className="tf-panel" style={{ margin: '0 16px 16px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 14px', cursor: 'pointer', userSelect: 'none', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, width: 12, color: MUTED }}>{open ? '▼' : '▶'}</span>
        <h3 style={{ margin: 0, fontSize: 15 }}>Trade Finisher</h3>
        <span style={{ fontSize: 12, color: MUTED }}>
          Your Sleeper league, a partner, the offer on the table → versions that are about fair and fit both teams' goals, picks included.
        </span>
      </div>

      {open && (
        <div style={{ padding: '0 14px 14px' }}>
          <div className="controls" style={{ gap: 10, marginBottom: 8 }}>
            <div className="control-group">
              <label className="control-label">Sleeper user</label>
              <input type="text" value={username} placeholder="username" onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') lookupUser(username); }} style={{ width: 150 }} />
              <button className="format-tab" onClick={() => lookupUser(username)} disabled={userBusy} style={{ padding: '4px 10px', fontSize: 12 }}>
                {userBusy ? '…' : 'Load'}
              </button>
            </div>
            {leagues.length > 0 && (
              <div className="control-group">
                <label className="control-label">League</label>
                <select value={leagueId} onChange={(e) => loadLeague(e.target.value, false)} style={{ maxWidth: 260 }}>
                  <option value="">Choose…</option>
                  {leagues.map((l) => (
                    <option key={l.league_id} value={l.league_id}>
                      {l.name} · {qbFormatLabel(l.roster_positions)} {isDynastyLeague(l) ? 'dynasty' : 'redraft'}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {league && <LeagueFormatBadges info={leagueFormatInfo(league)} />}
            {leagueBusy && <span style={{ fontSize: 12, color: MUTED }}>Loading league…</span>}
          </div>
          {userError && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>{userError}</div>}
          {leagueError && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>{leagueError}</div>}
          {!leagues.length && !userBusy && !userError && (
            <div style={{ fontSize: 12, color: MUTED }}>Enter your Sleeper username to list your leagues.</div>
          )}

          {data && teams.length > 0 && (
            <div className="controls" style={{ gap: 14, marginBottom: 10, alignItems: 'flex-start' }}>
              <div className="control-group">
                <label className="control-label">Your team</label>
                <select value={myRosterId ?? ''} onChange={(e) => { setMyRosterId(Number(e.target.value) || null); setGiveIds([]); }}>
                  <option value="">Choose…</option>
                  {teams.map((t) => <option key={t.rosterId} value={t.rosterId}>{t.teamName} ({t.owner})</option>)}
                </select>
              </div>
              <div className="control-group">
                <label className="control-label">Trade partner</label>
                <select value={partnerRosterId ?? ''} onChange={(e) => { setPartnerRosterId(Number(e.target.value) || null); setGetIds([]); }}>
                  <option value="">Choose…</option>
                  {teams.filter((t) => t.rosterId !== myRosterId).map((t) => <option key={t.rosterId} value={t.rosterId}>{t.teamName} ({t.owner}) · {t.wins}-{t.losses}</option>)}
                </select>
              </div>
              {isDynasty && (
                <>
                  <div className="control-group" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 3 }}>
                    <label className="control-label">Your goal</label>
                    {goalButtons(myGoal, setMyGoal, myNeeds?.inferredGoal)}
                  </div>
                  <div className="control-group" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 3 }}>
                    <label className="control-label">Their goal</label>
                    {goalButtons(partnerGoal, setPartnerGoal, partnerNeeds?.inferredGoal)}
                  </div>
                </>
              )}
            </div>
          )}

          {me && partner && myNeeds && partnerNeeds && (
            <>
              <div className="tf-needs" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginBottom: 14 }}>
                <NeedsCard team={me} needs={myNeeds} goal={myGoalEff} color={GIVE_COLOR} label="You" />
                <NeedsCard team={partner} needs={partnerNeeds} goal={partnerGoalEff} color={GET_COLOR} label="Partner" />
              </div>

              <div className="tf-offer" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', gap: 12, alignItems: 'start' }}>
                <AssetColumn title={`You give · ${me.teamName}`} color={GIVE_COLOR} assets={me.assets} selected={giveIds}
                  filter={giveFilter} setFilter={setGiveFilter} onToggle={(id) => toggle('give', id)} />
                <OfferVerdict evaluation={evaluation} offer={offer} partnerName={partner.teamName}
                  onLoad={() => loadIntoCalculator(offer)} onClear={() => { setGiveIds([]); setGetIds([]); }} />
                <AssetColumn title={`You get · ${partner.teamName}`} color={GET_COLOR} assets={partner.assets} selected={getIds}
                  filter={getFilter} setFilter={setGetFilter} onToggle={(id) => toggle('get', id)} />
              </div>
              {loadedNote && <div style={{ fontSize: 12, color: '#22c55e', margin: '8px 0 0' }}>{loadedNote}</div>}

              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                  <h4 style={{ margin: 0, fontSize: 13 }}>
                    {offer.give.length || offer.get.length ? 'Ways to finish this trade' : `Trades to open with ${partner.teamName}`}
                  </h4>
                  <span style={{ fontSize: 11, color: MUTED }}>
                    One or two changes from the offer above, within {DEFAULT_TOLERANCE_PCT}% of even, legal for both lineups, ranked by
                    your {GOAL_LABEL[myGoalEff].toLowerCase()} goal, their {GOAL_LABEL[partnerGoalEff].toLowerCase()} goal, both rosters' needs and fairness.
                  </span>
                </div>
                {variants.length === 0 ? (
                  <div style={{ fontSize: 12, color: MUTED, padding: '10px 0' }}>
                    Nothing within {DEFAULT_TOLERANCE_PCT}% of even that helps both sides. Try a different partner, goal, or offer.
                  </div>
                ) : (
                  <div className="tf-variants" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
                    {variants.map((v, i) => (
                      <VariantCard key={i} rank={i + 1} variant={v} partnerName={partner.teamName}
                        onUse={() => applyOffer(v.offer)} onLoad={() => loadIntoCalculator(v.offer)} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {data && (!me || !partner) && (
            <div style={{ fontSize: 12, color: MUTED }}>Choose your team and a trade partner.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Needs card ──────────────────────────────────────────────────────────

function NeedsCard({ team, needs, goal, color, label }: { team: FinisherTeam; needs: TeamNeeds; goal: TradeGoal; color: string; label: string }) {
  const picks = team.assets.filter((a) => a.type === 'pick');
  const maxRatio = 1.6;
  return (
    <div style={{ background: 'var(--bg-tertiary)', borderRadius: 8, padding: '10px 12px', borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <span style={{ fontSize: 10, color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 6 }}>{label}</span>
          <strong style={{ fontSize: 13 }}>{team.teamName}</strong>
          <span style={{ fontSize: 11, color: MUTED, marginLeft: 6 }}>{team.wins}-{team.losses}</span>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color: GOAL_COLOR[goal] }}>{GOAL_LABEL[goal]}</span>
      </div>
      <div style={{ fontSize: 11, color: MUTED, margin: '2px 0 8px' }}>
        Best lineup <strong style={{ color: 'var(--text-primary)' }}>{fmt(needs.lineup.total)}</strong> proj pts
        {needs.starterAvgAge > 0 && <> · starters avg <strong style={{ color: 'var(--text-primary)' }}>{needs.starterAvgAge.toFixed(1)}</strong> yrs</>}
        {' '}· {needs.goalReason}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: '4px 8px', alignItems: 'center', fontSize: 11 }}>
        {needs.positions.map((p) => {
          const w = Math.min(p.ratio, maxRatio) / maxRatio;
          const medianX = 1 / maxRatio;
          const barColor = p.status === 'weak' ? '#ef4444' : p.status === 'strong' ? '#22c55e' : color;
          return (
            <div key={p.pos} style={{ display: 'contents' }}>
              <span className={`pos-badge pos-${p.pos}`} style={{ fontSize: 10, padding: '1px 6px' }}>{p.pos}</span>
              <div title={`${p.pos}: ${fmt(p.pts)} proj pts from the best lineup · league median ${fmt(p.median)} · ${p.depth} bench with a projection`}
                style={{ position: 'relative', height: 10, background: 'var(--bg-secondary)', borderRadius: '0 3px 3px 0' }}>
                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${w * 100}%`, background: barColor, borderRadius: '0 3px 3px 0', opacity: 0.85 }} />
                <div style={{ position: 'absolute', left: `${medianX * 100}%`, top: -2, bottom: -2, width: 2, background: 'var(--text-muted)' }} />
              </div>
              <span style={{ color: 'var(--text-secondary)', textAlign: 'right', minWidth: 60 }}>{fmt(p.pts)} <span style={{ color: MUTED }}>/ {fmt(p.median)}</span></span>
              <span style={{ fontWeight: 600, minWidth: 44, color: p.status === 'weak' ? '#ef4444' : p.status === 'strong' ? '#22c55e' : MUTED }}>
                {p.status === 'weak' ? 'weak' : p.status === 'strong' ? `+${p.depth} deep` : 'ok'}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: MUTED, marginTop: 4 }}>Bar = position's projected points in the best lineup · tick = league median</div>
      {picks.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
          <span style={{ color: MUTED }}>Picks ({fmt(needs.pickValue)}):</span>{' '}
          {picks.map((p) => p.name).join(' · ')}
        </div>
      )}
    </div>
  );
}

// ── Asset column (roster + picks, click to add to the offer) ────────────

function AssetColumn({ title, color, assets, selected, filter, setFilter, onToggle }: {
  title: string; color: string; assets: FinisherAsset[]; selected: string[];
  filter: string; setFilter: (f: string) => void; onToggle: (id: string) => void;
}) {
  const sel = new Set(selected);
  const total = assets.filter((a) => sel.has(a.id)).reduce((s, a) => s + a.value, 0);
  const hasPicks = assets.some((a) => a.type === 'pick');
  const shown = assets.filter((a) => filter === 'ALL' || (filter === 'PICK' ? a.type === 'pick' : a.position === filter));
  return (
    <div className="tf-col" style={{ minWidth: 0, borderLeft: `3px solid ${color}`, paddingLeft: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6, padding: '4px 8px', background: `${color}1f`, borderRadius: 6, marginBottom: 6 }}>
        <strong style={{ fontSize: 12, color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</strong>
        <span style={{ fontSize: 12, fontWeight: 700, color, flexShrink: 0 }}>{selected.length ? fmt(total) : ''}</span>
      </div>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 6 }}>
        {['ALL', ...SKILL_POSITIONS, ...(hasPicks ? ['PICK'] : [])].map((f) => (
          <button key={f} className={`format-tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)} style={{ padding: '1px 7px', fontSize: 10 }}>
            {f === 'ALL' ? 'All' : f === 'PICK' ? 'Picks' : f}
          </button>
        ))}
      </div>
      <div className="tf-list" style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {shown.map((a) => {
          const on = sel.has(a.id);
          return (
            <div key={a.id} className="tf-asset" onClick={() => onToggle(a.id)} role="button" aria-pressed={on}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                background: on ? `${color}2e` : 'var(--bg-tertiary)', border: `1px solid ${on ? color : 'transparent'}`,
              }}>
              <span style={{ width: 14, textAlign: 'center', color: on ? color : MUTED, fontWeight: 700 }}>{on ? '✓' : '+'}</span>
              {a.type === 'player'
                ? <span className={`pos-badge pos-${a.position}`} style={{ fontSize: 9, padding: '0 5px' }}>{a.position}</span>
                : <span className="pos-badge" style={{ fontSize: 9, padding: '0 5px', background: 'rgba(148,163,184,0.2)', color: '#94a3b8' }}>PICK</span>}
              {/* Plain text here: the whole row toggles the offer, and a name
                  link would navigate to the player page mid-build. The
                  suggestion cards below link names. */}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name}
                {a.type === 'player' && <span style={{ color: MUTED, fontSize: 10, marginLeft: 4 }}>{a.team}{a.age ? ` · ${a.age.toFixed(0)}` : ''}</span>}
              </span>
              {a.projPts > 0 && <span style={{ fontSize: 10, color: '#60a5fa', flexShrink: 0 }}>{fmt(a.projPts)}</span>}
              <span style={{ fontWeight: 600, flexShrink: 0, color: a.value > 0 ? 'var(--text-primary)' : MUTED, minWidth: 40, textAlign: 'right' }}>{a.value > 0 ? fmt(a.value) : '—'}</span>
            </div>
          );
        })}
        {!shown.length && <div style={{ fontSize: 11, color: MUTED, padding: 8 }}>Nothing here.</div>}
      </div>
    </div>
  );
}

// ── Offer verdict (between the two columns) ─────────────────────────────

function OfferVerdict({ evaluation, offer, partnerName, onLoad, onClear }: { evaluation: OfferEval | null; offer: Offer; partnerName: string; onLoad: () => void; onClear: () => void }) {
  const any = offer.give.length + offer.get.length > 0;
  return (
    <div className="tf-verdict" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 130, padding: '16px 4px', textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5 }}>Current offer</div>
      {!evaluation ? (
        <div style={{ fontSize: 12, color: MUTED }}>{any ? 'Add a piece to each side' : 'Tap assets on both sides'}</div>
      ) : (
        <>
          <div style={{ fontSize: 22, fontWeight: 800, color: VERDICT_COLOR[evaluation.verdict], lineHeight: 1.1 }}>{VERDICT_LABEL[evaluation.verdict]}</div>
          <div style={{ fontSize: 11, color: MUTED }}>
            {evaluation.fairnessPct.toFixed(0)}% · {evaluation.diff === 0 ? 'even' : <><strong style={{ color: evaluation.diff > 0 ? GIVE_COLOR : GET_COLOR }}>{evaluation.diff > 0 ? 'you' : partnerName}</strong> by {fmt(Math.abs(evaluation.diff))}</>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Your lineup <strong style={{ color: evaluation.myLineupDelta >= 0 ? '#22c55e' : '#ef4444' }}>{signed(evaluation.myLineupDelta)}</strong>
            {' · '}theirs <strong style={{ color: evaluation.partnerLineupDelta >= 0 ? '#22c55e' : '#ef4444' }}>{signed(evaluation.partnerLineupDelta)}</strong>
          </div>
          {!evaluation.legal && <div style={{ fontSize: 11, color: '#ef4444' }}>{evaluation.illegalReason}</div>}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
            {evaluation.tags.filter((t) => !t.startsWith('Illegal')).map((t) => <Tag key={t} text={t} />)}
          </div>
        </>
      )}
      {any && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
          <button className="format-tab active" onClick={onLoad} style={{ padding: '3px 9px', fontSize: 11 }}>Open in calculator</button>
          <button className="format-tab" onClick={onClear} style={{ padding: '3px 9px', fontSize: 11 }}>Clear</button>
        </div>
      )}
    </div>
  );
}

function Tag({ text }: { text: string }) {
  const good = /^Fills your|^Your lineup \+|younger|^Frees|^Serves/.test(text);
  const bad = /^Thins|^Your lineup −|^Your lineup -|older|^Needs|^Against/.test(text);
  return (
    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-tertiary)', color: good ? '#22c55e' : bad ? '#fb923c' : 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
      {text}
    </span>
  );
}

// ── Variant card ────────────────────────────────────────────────────────

function VariantCard({ rank, variant, partnerName, onUse, onLoad }: { rank: number; variant: Variant; partnerName: string; onUse: () => void; onLoad: () => void }) {
  const ev = variant.eval;
  const list = (xs: FinisherAsset[], color: string, head: string) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{head} · {fmt(xs.reduce((s, a) => s + a.value, 0))}</div>
      {xs.map((a) => (
        <div key={a.id} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.type === 'player' ? <PlayerName name={a.name} position={a.position} sleeperId={a.sleeperId} /> : a.name}
            {a.type === 'player' && <span style={{ color: MUTED, fontSize: 10, marginLeft: 4 }}>{a.position}{a.age ? ` ${a.age.toFixed(0)}` : ''}</span>}
          </span>
          <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{fmt(a.value)}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div style={{ background: 'var(--bg-tertiary)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11, color: MUTED }}>#{rank}</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: VERDICT_COLOR[ev.verdict] }}>
          {VERDICT_LABEL[ev.verdict]} <span style={{ fontWeight: 500, fontSize: 11, color: MUTED }}>· {ev.diff === 0 ? 'even' : `${ev.diff > 0 ? 'you' : partnerName} +${fmt(Math.abs(ev.diff))}`}</span>
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        {variant.edits.map((e, i) => <div key={i}>{describeEdit(e, partnerName)}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {list(variant.offer.give, GIVE_COLOR, 'You give')}
        {list(variant.offer.get, GET_COLOR, 'You get')}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {ev.tags.map((t) => <Tag key={t} text={t} />)}
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        <button className="format-tab" onClick={onUse} style={{ padding: '3px 9px', fontSize: 11 }}>Make this the offer</button>
        <button className="format-tab" onClick={onLoad} style={{ padding: '3px 9px', fontSize: 11 }}>Open in calculator</button>
      </div>
    </div>
  );
}
