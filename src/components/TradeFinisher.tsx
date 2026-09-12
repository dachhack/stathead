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
import { LeagueFormatBadges } from './LeagueFormatBadges';
import {
  fetchSleeperUser, fetchUserLeagues, importLeague, fetchTradedPicks, leagueFormatInfo, isDynastyLeague, qbFormatLabel,
  type LeagueImport, type SleeperLeagueSummary, type SleeperTradedPick,
} from '../lib/sleeper';
import { loadBlendedProjections, computeCustomScore, computePpr, type ConsensusPlayer } from '../lib/waiverUtils';
import { normalizeForMatch } from '../lib/nameMatch';
import type { TepLevel } from '../lib/dynastyForecast';
import {
  buildFinisherTeams, computeNeeds, evaluateOffer, suggestFinishes, nameTags, partnerPositives, isSuperflexLeague, tepLevelFromScoring,
  GOAL_LABEL, DEFAULT_TOLERANCE_PCT,
  type FinisherAsset, type FinisherTeam, type Offer, type OfferEval, type TradeGoal, type Variant,
} from '../lib/tradeFinisher';

import { AssetColumn, NeedsCard, OfferVerdict, VariantCard } from './swap/OfferParts';
import { GIVE_COLOR, GET_COLOR, MUTED, shortName } from './swap/offerStyle';
import { SwapMeetComposer, type Candidate } from './swap/SwapMeetComposer';

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

  // What the Swap Meet composer can put on the table: the offer as built,
  // then the finishes, each with a pitch drafted from its edits and tags.
  const candidates = useMemo<Candidate[]>(() => {
    if (!me || !partner || !partnerNeeds) return [];
    // The pitch is read by the partner: what the version does for THEM, in
    // their name, and nothing about this side of the table.
    const meS = shortName(me.teamName), themS = shortName(partner.teamName);
    const pitch = (ev: OfferEval, o: Offer) => nameTags(partnerPositives(ev, partnerNeeds, o), themS, meS).join(' · ');
    const out: Candidate[] = [];
    if (evaluation && offer.give.length && offer.get.length) {
      out.push({ key: 'offer', label: 'The offer as built', offer, eval: evaluation, pitch: pitch(evaluation, offer) });
    }
    variants.forEach((v, i) => {
      out.push({ key: `v${i}`, label: `Finish #${i + 1}`, offer: v.offer, eval: v.eval, pitch: pitch(v.eval, v.offer) });
    });
    return out;
  }, [me, partner, partnerNeeds, offer, evaluation, variants]);

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
                <OfferVerdict evaluation={evaluation} offer={offer} themName={partner.teamName}>
                  {(offer.give.length + offer.get.length > 0) && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
                      <button className="format-tab active" onClick={() => loadIntoCalculator(offer)} style={{ padding: '3px 9px', fontSize: 11 }}>Open in calculator</button>
                      <button className="format-tab" onClick={() => { setGiveIds([]); setGetIds([]); }} style={{ padding: '3px 9px', fontSize: 11 }}>Clear</button>
                    </div>
                  )}
                </OfferVerdict>
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
                      <VariantCard key={i} rank={i + 1} variant={v} themName={partner.teamName}
                        onUse={() => applyOffer(v.offer)} onLoad={() => loadIntoCalculator(v.offer)} />
                    ))}
                  </div>
                )}
              </div>

              {isDynasty && league && (
                <SwapMeetComposer
                  league={{ id: league.league_id, name: league.name, format: leagueFormat, tep: tepLevel, rosterPositions, isDynasty }}
                  me={me} partner={partner} teams={teams} myGoal={myGoalEff} partnerGoal={partnerGoalEff}
                  candidates={candidates}
                />
              )}
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
