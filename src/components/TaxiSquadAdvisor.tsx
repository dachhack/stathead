import { useEffect, useMemo, useState } from 'react';
import { PlayerName } from './PlayerName';
import { MethodNote } from './MethodNote';
import { DocsLink } from './DocsLink';
import { normName } from '../lib/nameUtils';

// Taxi Squad Advisor — for dynasty rosters: which rookies and year-2
// players belong on a taxi spot for the year, and which have a real
// chance of being startable and should be promoted to the active roster.
//
// Signals per player:
//
//   Now PPG    — current-season base projection (redraft-projections.json,
//                the same source the Projections tab uses). The "is he a
//                lineup option THIS year" number.
//   Start %    — career model's probability of reaching low-end LOCKED
//                STARTER PPG (QB 16 / RB 12 / WR 12 / TE 9 — the model's
//                lowest threshold band). A stricter bar than streamable;
//                treat it as the future-horizon signal.
//   Boom/Bust  — career model tail probabilities.
//   Yr-1 PPG   — for year-2 players, their actual rookie-season PPG.
//   DC1        — listed #1 at his position on his NFL team's current
//                depth chart (nflverse snapshot). Automatic Roster call,
//                with a caveat when the projection doesn't back it up.
//   Market     — FantasyCalc dynasty value (1QB/SF toggle), as a sanity
//                check on what the community already believes.
//
// Verdict is a time-horizon call on startability (see verdictFor):
// ROSTER — probably startable THIS season: too valuable to hide on
// taxi, you want him active and available. TAXI — probably no starting
// value this year, but a real chance to be a starter NEXT year: exactly
// what the taxi spot is for. DROP — probably never startable: the spot
// is worth more than the lottery ticket. It's advice about where the
// player belongs on YOUR roster, not about trade value.

const BASE = import.meta.env.BASE_URL;
const CURRENT_SEASON = 2026;

interface CareerEntry {
  name: string;
  position: string;
  draftSeason: number;
  predictedPPG: number;
  actualPPG?: number;
  percentile: number;
  tier: number;
  tierLabel: string;
  boomProb: number;
  bustProb: number;
  thresholdProbs: Record<string, number>;
  features?: { nflDraftRound?: number };
}

interface FcDynastyEntry {
  player: { name: string; position: string; maybeTeam?: string | null; maybeAge?: number | null };
  value: number;
  overallRank: number;
}

interface RedraftProjEntry { name: string; position: string; ppg: number }

interface DepthStarter { name: string; team: string; pos: string }

/** Ramp-model scores (score-store/taxi.json, scripts/train_taxi_model.py):
 *  P(streamable this season / next season / ever within 4yr) for the
 *  current year-2 class. Rookies are never scored (no NFL data yet). */
interface TaxiModelScore { name: string; position: string; p1: number; p2: number; pEver: number }

/** Model verdict thresholds — chosen in LOSO validation so the Taxi
 *  bucket is forward-loaded (20% → 23% streamable by season) at 12%
 *  drop regret. Keep in sync with scripts/train_taxi_model.py. */
const MODEL_ROSTER_P1 = 0.5;
const MODEL_DROP_PEVER = 0.12;

type Verdict = 'Roster' | 'Taxi' | 'Drop';

const VERDICT_STYLE: Record<Verdict, { bg: string; fg: string; desc: string }> = {
  Roster: { bg: '#0c4a2c', fg: '#86efac', desc: 'Probably startable this season — keep him active and available, not hidden on taxi.' },
  Taxi:   { bg: '#1e3a5f', fg: '#93c5fd', desc: 'No starting value this year, but a real chance to be a starter next year — the taxi spot exists for exactly this.' },
  Drop:   { bg: '#3a1a1a', fg: '#fb923c', desc: 'Probably never startable — the spot is worth more than the lottery ticket.' },
};

/** Model threshold band used for Start % — the career model's lowest
 *  band ≈ low-end locked starter (stricter than streamable). */
const START_KEY: Record<string, string> = { QB: '16', RB: '12', WR: '12', TE: '9' };
/** "Streamable" PPG — the bar for confidently starting a player for a
 *  couple of weeks: what the position's rank-N season PPG actually is
 *  (QB32 / RB60 / WR72 / TE36). Computed from 2015–2025 weekly data
 *  (≥6-game seasons); remarkably stable year to year. */
const STREAM_CUTOFF: Record<string, number> = { QB: 11.5, RB: 6, WR: 7.5, TE: 5.5 };
const STREAM_RANK: Record<string, number> = { QB: 32, RB: 60, WR: 72, TE: 36 };

interface TaxiRow {
  name: string;
  position: string;
  team: string;
  classOf: number;          // draftSeason
  isYear2: boolean;
  tierLabel: string;
  percentile: number;
  careerPpg: number;        // model long-run PPG
  nowPpg: number;           // current-season projection; NaN if none
  rookieYearPpg: number;    // actual PPG in rookie season (year-2 only); NaN otherwise
  startProb: number;        // NaN if missing
  boomProb: number;
  bustProb: number;
  draftRound: number;       // NFL draft round; 8 when unknown/UDFA
  dynValue: number;         // FantasyCalc value under active format; 0 if unranked
  dynRank: number;          // 9999 if unranked
  isDC1: boolean;           // listed #1 at his position on his NFL team's depth chart
  /** Ramp-model probabilities (year-2 players only; NaN when unscored). */
  p1: number;
  p2: number;
  pEver: number;
  verdict: Verdict;
  why: string;
}

// The decision is a time-horizon split on STREAMABLE production — the
// bar an owner needs to put a player in a lineup for a couple of weeks
// (QB32 / RB60 / WR72 / TE36 PPG), not locked-starter numbers:
//
//   DC1          — listed #1 at his position on his NFL depth chart →
//                  immediate ROSTER pass, caveated when the projection
//                  doesn't back the listing up.
//   This season  — projection within ~1 PPG of streamable (or ~2 with
//                  model conviction), or rookie-year production within
//                  ~2.5. → ROSTER. The yr-1 margin is deliberately wide:
//                  near-streamable producers deliver their value
//                  IMMEDIATELY (35% streamable next season vs 32% the
//                  one after) — they belong active, not stashed.
//   Next season  — quiet so far but a RAMP profile. → TAXI. The bucket
//                  is built to be forward-loaded: high-capital players
//                  with quiet rookie years are the classic delayed
//                  breakout (R1-2 + quiet yr1 hit streamable 24% the
//                  next season but 31% the season after; R1-2 WRs
//                  21% → 38%).
//   Never        — falling-hazard profiles: the model's bottom tail
//                  with a weak profile and no production signal, plus
//                  two fade patterns whose hazard only declines — late
//                  capital (R5+) with a quiet rookie year and <6% model
//                  starter odds (9% → 7%), and R3+ QBs with quiet
//                  rookie years (6% → 0%). → DROP.
//
// Validated by backtest on the 2010–2022 classes (full weekly-stats
// ground truth at the streamable bar): Roster = 63% streamable that
// season / 76% within 4yr; the Taxi bucket is forward-loaded (19%
// streamable next season → 20% the season after, 36% within 4yr);
// Drop regret 14% with the misses being journeyman streamers. 116 of
// 126 true year-2 breakouts retained.
function verdictFor(r: Omit<TaxiRow, 'verdict' | 'why'>): { verdict: Verdict; why: string } {
  const cutoff = STREAM_CUTOFF[r.position] ?? 6;

  // — Projected #1 on his own NFL depth chart → automatic Roster, with
  // a caveat when the projection doesn't agree (thin-room #1). —
  if (r.isDC1) {
    const projBacks = Number.isFinite(r.nowPpg) && r.nowPpg >= cutoff - 1;
    return {
      verdict: 'Roster',
      why: projBacks
        ? `Listed #1 ${r.position}${r.team ? ` on ${r.team}` : ''} with the projection at the streamable line (${r.nowPpg.toFixed(1)} PPG, bar ≈ ${cutoff}) — automatic roster call.`
        : `Listed #1 ${r.position}${r.team ? ` on ${r.team}` : ''} — automatic roster call, BUT the projection (${Number.isFinite(r.nowPpg) ? r.nowPpg.toFixed(1) : '—'} PPG vs streamable ≈ ${cutoff}) doesn't back it up yet: a thin-room #1, keep him active with eyes open.`,
    };
  }

  // — Streamable THIS season? Near-streamable rookie-year production is
  // an IMMEDIATE-value signal (it predicts this season better than
  // next), so the yr-1 margin is wide. —
  const nowClose = Number.isFinite(r.nowPpg) && r.nowPpg >= cutoff - 1;
  const provenYr1 = r.isYear2 && Number.isFinite(r.rookieYearPpg) && r.rookieYearPpg >= cutoff - 2.5;
  const nearWithConviction = Number.isFinite(r.nowPpg) && r.nowPpg >= cutoff - 2
    && Number.isFinite(r.startProb) && r.startProb >= 30;
  if (nowClose || provenYr1 || nearWithConviction) {
    const why = provenYr1 && !nowClose
      ? `Produced ${r.rookieYearPpg.toFixed(1)} PPG as a rookie — within streaming range (≈ ${cutoff}), and that kind of role pays off NOW, not later. Keep him active.`
      : nowClose
        ? `Projected ${r.nowPpg.toFixed(1)} PPG this season vs streamable ≈ ${cutoff} — an owner can already start him for stretches; you want him available, not on taxi.`
        : `Projected ${r.nowPpg.toFixed(1)} PPG with ${r.startProb.toFixed(0)}% starter odds — close enough this season that hiding him on taxi risks missing the window.`;
    return { verdict: 'Roster', why };
  }

  // — Ramp models. Year-2 players (s1 AUC .85 / s2 .82 / ever .83) get
  // full model verdicts. Rookies (landing-spot model: .77 / .75 / .79)
  // get model Roster/Taxi only — model-driven rookie DROPS ran 17%
  // regret in validation, so rookie drops stay on the strict rule tree
  // below. Unscored players fall through to the rules entirely.
  if (Number.isFinite(r.p1) && r.p1 >= MODEL_ROSTER_P1) {
    return {
      verdict: 'Roster',
      why: `${r.isYear2 ? 'Ramp' : 'Rookie landing-spot'} model: ${(100 * r.p1).toFixed(0)}% to be streamable THIS season (${(100 * r.p2).toFixed(0)}% next) — his value is now; keep him active.`,
    };
  }
  if (r.isYear2 && Number.isFinite(r.p1)) {
    if (r.pEver <= MODEL_DROP_PEVER) {
      return {
        verdict: 'Drop',
        why: `Ramp model: ${(100 * r.pEver).toFixed(0)}% to EVER reach a streamable season (${(100 * r.p1).toFixed(0)}% this year, ${(100 * r.p2).toFixed(0)}% next) — the spot is worth more than the wait.`,
      };
    }
    return {
      verdict: 'Taxi',
      why: r.p2 > r.p1
        ? `Ramp model: ${(100 * r.p1).toFixed(0)}% streamable this season but ${(100 * r.p2).toFixed(0)}% next — a forward-loaded profile, exactly what the taxi spot is for (${(100 * r.pEver).toFixed(0)}% within 4 years).`
        : `Ramp model: ${(100 * r.p1).toFixed(0)}% this season / ${(100 * r.p2).toFixed(0)}% next / ${(100 * r.pEver).toFixed(0)}% ever — not rosterable yet, too live to drop. Stash.`,
    };
  }

  // — Probably NEVER startable? Three falling-hazard patterns. —
  const quietRookieYr = r.isYear2 && (!Number.isFinite(r.rookieYearPpg) || r.rookieYearPpg < cutoff - 3);
  const noNowSignal = !Number.isFinite(r.nowPpg) || r.nowPpg < cutoff - 3;
  // (a) Model bottom tail + weak profile + silence everywhere.
  const neverOdds = Number.isFinite(r.startProb) ? r.startProb <= 5 : r.percentile <= 20;
  const quietYr1Strict = !r.isYear2 || !Number.isFinite(r.rookieYearPpg) || r.rookieYearPpg < cutoff - 4;
  const bottomTail = neverOdds && r.percentile <= 35 && noNowSignal && quietYr1Strict;
  // (b) Late capital, quiet rookie year, model out — hazard only falls
  // (9% next season → 7% after; the spot beats the fade).
  const lateFade = quietRookieYr && noNowSignal
    && r.draftRound >= 5 && Number.isFinite(r.startProb) && r.startProb < 6 && r.percentile <= 40;
  // (c) Day-2+ QBs who didn't play as rookies almost never emerge
  // (6% → 0% historically) — high-capital QBs sitting a year do.
  const qbFade = quietRookieYr && noNowSignal && r.position === 'QB' && r.draftRound >= 3;
  if (bottomTail || lateFade || qbFade) {
    const why = qbFade && !bottomTail
      ? `Day-${r.draftRound >= 4 ? '3' : '2'} QB with a silent rookie year — historically this profile almost never becomes startable (6% → 0% by year). The spot beats the wait.`
      : lateFade && !bottomTail
        ? `Round-${r.draftRound >= 8 ? 'UDFA' : r.draftRound} capital, quiet rookie year, ${Number.isFinite(r.startProb) ? r.startProb.toFixed(0) : '—'}% starter odds — this profile's odds only fall from here (9% → 7% by season). The spot is worth more.`
        : `${Number.isFinite(r.startProb) ? `${r.startProb.toFixed(0)}% odds of ever reaching starter PPG` : `p${r.percentile} profile`}${r.isYear2 ? ', quiet rookie year' : ''}, no current-season role — the spot is worth more than the lottery ticket.`;
    return { verdict: 'Drop', why };
  }

  // — Otherwise: the taxi case — ramp profiles without this-year value.
  if (Number.isFinite(r.p1)) {
    // Scored rookie who didn't clear the Roster bar and survived the
    // rule-tree drop checks: quote the model's horizon view.
    return {
      verdict: 'Taxi',
      why: r.p2 > r.p1
        ? `Rookie landing-spot model: ${(100 * r.p1).toFixed(0)}% streamable this season but ${(100 * r.p2).toFixed(0)}% next — forward-loaded; let him cook (${(100 * r.pEver).toFixed(0)}% within 4 years).`
        : `Rookie landing-spot model: ${(100 * r.p1).toFixed(0)}% this season / ${(100 * r.p2).toFixed(0)}% next / ${(100 * r.pEver).toFixed(0)}% ever — developmental stash.`,
    };
  }
  const rampCapital = r.draftRound <= 2 && (!r.isYear2 || quietRookieYr);
  const prime = Number.isFinite(r.startProb) && r.startProb >= 20;
  return {
    verdict: 'Taxi',
    why: rampCapital && r.isYear2
      ? `Round-${r.draftRound} capital buried as a rookie — the classic delayed-breakout profile (historically these hit streamable MORE in the season after next than next season; R1-2 WRs 21% → 38%). Prime stash.`
      : prime
        ? `${r.startProb.toFixed(0)}% odds of reaching starter PPG (${r.tierLabel}, p${r.percentile}) but only ${Number.isFinite(r.nowPpg) ? r.nowPpg.toFixed(1) : '—'} projected PPG this season — prime taxi stash: next-year starter odds with no this-year value to lose.`
        : `Not streamable this season (proj ${Number.isFinite(r.nowPpg) ? r.nowPpg.toFixed(1) : '—'} vs ≈ ${cutoff})${Number.isFinite(r.startProb) ? ` and ${r.startProb.toFixed(0)}% starter odds` : ''} — speculative stash; hold while the taxi spot is free.`,
  };
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
const CLASSES = ['ALL', 'Rookies', 'Year 2'] as const;
const VERDICTS: Array<'ALL' | Verdict> = ['ALL', 'Roster', 'Taxi', 'Drop'];

type SortKey = 'verdict' | 'nowPpg' | 'startProb' | 'boomProb' | 'bustProb' | 'dynRank' | 'careerPpg' | 'percentile' | 'rookieYearPpg' | 'p2';

const VERDICT_ORDER: Record<Verdict, number> = { Roster: 0, Taxi: 1, Drop: 2 };

export function TaxiSquadAdvisor() {
  const [career, setCareer] = useState<CareerEntry[]>([]);
  const [redraft, setRedraft] = useState<RedraftProjEntry[]>([]);
  const [dyn1qb, setDyn1qb] = useState<FcDynastyEntry[]>([]);
  const [dynSf, setDynSf] = useState<FcDynastyEntry[]>([]);
  const [dc1, setDc1] = useState<DepthStarter[]>([]);
  const [modelScores, setModelScores] = useState<TaxiModelScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [format, setFormat] = useState<'1qb' | 'sf'>('1qb');
  const [posFilter, setPosFilter] = useState<(typeof POSITIONS)[number]>('ALL');
  const [classFilter, setClassFilter] = useState<(typeof CLASSES)[number]>('ALL');
  const [verdictFilter, setVerdictFilter] = useState<'ALL' | Verdict>('ALL');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('verdict');
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${BASE}data/score-store/career.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${BASE}data/redraft-projections.json`)
        .then((r) => (r.ok ? r.json() : { players: [] }))
        .then((d) => (Array.isArray(d) ? d : (d?.players ?? [])))
        .catch(() => []),
      fetch(`${BASE}data/fantasycalc_dynasty_1qb.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${BASE}data/fantasycalc_dynasty_sf.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      // Depth-chart #1s (built by scripts/build-depth-starters.mjs from
      // the nflverse depth chart snapshot).
      fetch(`${BASE}data/depth-starters-${CURRENT_SEASON}.json`)
        .then((r) => (r.ok ? r.json() : { starters: [] }))
        .catch(() => ({ starters: [] })),
      // Ramp-model scores (scripts/train_taxi_model.py).
      fetch(`${BASE}data/score-store/taxi.json`)
        .then((r) => (r.ok ? r.json() : { players: [] }))
        .catch(() => ({ players: [] })),
    ]).then(([careerData, redraftData, d1, dsf, dcData, taxiData]) => {
      if (cancelled) return;
      const entries = (Array.isArray(careerData) ? careerData : []) as CareerEntry[];
      if (!entries.length) {
        setError('Career model data not available yet — the build deploys every 2 hours.');
        setLoading(false);
        return;
      }
      setCareer(entries);
      setRedraft(redraftData as RedraftProjEntry[]);
      setDyn1qb((Array.isArray(d1) ? d1 : []) as FcDynastyEntry[]);
      setDynSf((Array.isArray(dsf) ? dsf : []) as FcDynastyEntry[]);
      setDc1((dcData?.starters ?? []) as DepthStarter[]);
      // Year-2 ramp scores + rookie landing-spot scores live in the same
      // file; the verdict logic distinguishes them via isYear2.
      setModelScores([
        ...((taxiData?.players ?? []) as TaxiModelScore[]),
        ...((taxiData?.rookies ?? []) as TaxiModelScore[]),
      ]);
      setLoading(false);
    }).catch((e) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : 'Failed to load taxi data');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo<TaxiRow[]>(() => {
    if (career.length === 0) return [];
    const projByName = new Map<string, number>();
    for (const p of redraft) {
      if (p?.name) projByName.set(`${normName(p.name)}::${p.position}`, Number(p.ppg) || NaN);
    }
    const dyn = format === 'sf' ? dynSf : dyn1qb;
    const dynByName = new Map<string, { value: number; rank: number; team: string }>();
    for (const d of dyn) {
      if (d?.player?.name) {
        dynByName.set(`${normName(d.player.name)}::${d.player.position}`, {
          value: d.value, rank: d.overallRank, team: d.player.maybeTeam ?? '',
        });
      }
    }
    // Depth-chart #1 lookup — keyed name::pos; carries the listing team.
    const dc1ByName = new Map<string, string>();
    for (const s of dc1) {
      if (s?.name) dc1ByName.set(`${normName(s.name)}::${s.pos}`, s.team);
    }
    const modelByName = new Map<string, TaxiModelScore>();
    for (const m of modelScores) {
      if (m?.name) modelByName.set(`${normName(m.name)}::${m.position}`, m);
    }

    return career
      .filter((c) => c.draftSeason === CURRENT_SEASON || c.draftSeason === CURRENT_SEASON - 1)
      .map((c) => {
        const key = `${normName(c.name)}::${c.position}`;
        const market = dynByName.get(key);
        const dcTeam = dc1ByName.get(key);
        const isYear2 = c.draftSeason === CURRENT_SEASON - 1;
        const base: Omit<TaxiRow, 'verdict' | 'why'> = {
          name: c.name,
          position: c.position,
          team: dcTeam || market?.team || '',
          classOf: c.draftSeason,
          isYear2,
          tierLabel: c.tierLabel,
          percentile: c.percentile,
          careerPpg: c.predictedPPG,
          nowPpg: projByName.get(key) ?? NaN,
          rookieYearPpg: isYear2 && Number.isFinite(c.actualPPG) ? (c.actualPPG as number) : NaN,
          startProb: c.thresholdProbs?.[START_KEY[c.position]] ?? NaN,
          boomProb: c.boomProb,
          bustProb: c.bustProb,
          draftRound: c.features?.nflDraftRound ?? 8,
          dynValue: market?.value ?? 0,
          dynRank: market?.rank ?? 9999,
          isDC1: dcTeam !== undefined,
          p1: modelByName.get(key)?.p1 ?? NaN,
          p2: modelByName.get(key)?.p2 ?? NaN,
          pEver: modelByName.get(key)?.pEver ?? NaN,
        };
        return { ...base, ...verdictFor(base) };
      });
  }, [career, redraft, dyn1qb, dynSf, format, dc1, modelScores]);

  const displayRows = useMemo(() => {
    let out = rows;
    if (posFilter !== 'ALL') out = out.filter((r) => r.position === posFilter);
    if (classFilter !== 'ALL') out = out.filter((r) => (classFilter === 'Rookies' ? !r.isYear2 : r.isYear2));
    if (verdictFilter !== 'ALL') out = out.filter((r) => r.verdict === verdictFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((r) => r.name.toLowerCase().includes(q) || r.team.toLowerCase().includes(q));
    }
    out = [...out].sort((a, b) => {
      let av: number; let bv: number;
      if (sortKey === 'verdict') {
        av = VERDICT_ORDER[a.verdict]; bv = VERDICT_ORDER[b.verdict];
        if (av === bv) {
          // Within a verdict, most actionable first: Roster by this-
          // season projection, Taxi/Drop by next-season odds (ramp
          // model p2 where scored, career-model starter odds otherwise).
          if (a.verdict === 'Roster') {
            const an = Number.isFinite(a.nowPpg) ? a.nowPpg : -1;
            const bn = Number.isFinite(b.nowPpg) ? b.nowPpg : -1;
            return bn - an;
          }
          const as = Number.isFinite(a.p2) ? 100 * a.p2 : Number.isFinite(a.startProb) ? a.startProb : -1;
          const bs = Number.isFinite(b.p2) ? 100 * b.p2 : Number.isFinite(b.startProb) ? b.startProb : -1;
          return bs - as;
        }
      } else {
        av = a[sortKey]; bv = b[sortKey];
      }
      const aNaN = !Number.isFinite(av); const bNaN = !Number.isFinite(bv);
      if (aNaN && bNaN) return 0;
      if (aNaN) return 1;
      if (bNaN) return -1;
      return sortAsc ? av - bv : bv - av;
    });
    return out;
  }, [rows, posFilter, classFilter, verdictFilter, search, sortKey, sortAsc]);

  const counts = useMemo(() => {
    const c: Record<Verdict, number> = { Roster: 0, Taxi: 0, Drop: 0 };
    for (const r of rows) c[r.verdict]++;
    return c;
  }, [rows]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === 'verdict' || key === 'dynRank');
    }
  };
  const sortArrow = (key: SortKey) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading taxi squad data...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="empty-state">
        <h3>Taxi Squad Advisor</h3>
        <p>{error}</p>
      </div>
    );
  }

  const th: React.CSSProperties = {
    padding: '6px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    cursor: 'pointer', userSelect: 'none',
  };
  const td: React.CSSProperties = { padding: '5px 8px', fontSize: 12 };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Taxi Squad Advisor</h1>
        <span style={{
          fontSize: 11, background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', fontWeight: 600,
        }}>
          {CURRENT_SEASON} rookies + {CURRENT_SEASON - 1} class
        </span>
        <DocsLink section="draft-kit" title="Verdict tree, streamable cutoffs, and backtest — Model Docs" />
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {displayRows.length} players
        </span>
      </div>

      <MethodNote id="taxi-advisor">
        The taxi call is a question about <em>when</em> a player will be
        startable — where "startable" means <em>streamable</em>: enough
        PPG that an owner can confidently start him for a couple of
        weeks, i.e. roughly the QB{STREAM_RANK.QB} / RB{STREAM_RANK.RB} /
        WR{STREAM_RANK.WR} / TE{STREAM_RANK.TE} line
        (≈ {STREAM_CUTOFF.QB} / {STREAM_CUTOFF.RB} / {STREAM_CUTOFF.WR} / {STREAM_CUTOFF.TE} PPR
        PPG over the last decade). <strong>Roster</strong> — probably
        streamable <em>this</em> season, or listed{' '}
        <span style={{ color: '#facc15', fontWeight: 700 }}>DC1</span>{' '}
        (#1 at his position on his NFL depth chart — an automatic pass,
        caveated when the projection doesn't back it up).{' '}
        <strong>Taxi</strong> — no streaming value this year but a live
        chance to be a starter <em>next</em> year: exactly what the spot
        is for. <strong>Drop</strong> — probably <em>never</em>{' '}
        startable. Signals: <strong>Now PPG</strong> = current-season
        base projection (same source as the Projections tab);{' '}
        <strong>Start %</strong> = career model's odds of ever reaching
        low-end <em>locked-starter</em> PPG (QB 16 / RB 12 / WR 12 /
        TE 9 — a stricter bar; the future-horizon signal);{' '}
        <strong>Yr-1 PPG</strong> = actual rookie-season production
        (year-2 players); <strong>Value</strong> = FantasyCalc dynasty
        market. <strong>Strm % →</strong> = the ramp model (year-2
        players): P(streamable this season) → P(next season), trained
        on the 2010–2023 classes from the feature store (rookie-year
        production, year-2 market ADP, depth-chart situation, draft
        capital, combine) with leave-one-class-out validation — it
        drives year-2 verdicts where scored; rookies use the career
        model + rules. Hover any verdict for the player-specific
        reasoning. Names link to the full player page.
      </MethodNote>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {POSITIONS.map((p) => (
          <button key={p} className={`pos-filter ${posFilter === p ? 'active' : ''}`} onClick={() => setPosFilter(p)}>
            {p}
          </button>
        ))}
        <span style={{ width: 8 }} />
        {CLASSES.map((c) => (
          <button key={c} className={`pos-filter ${classFilter === c ? 'active' : ''}`} onClick={() => setClassFilter(c)}>
            {c}
          </button>
        ))}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '3px 10px',
        }}>
          Values{' '}
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as '1qb' | 'sf')}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}
          >
            <option value="1qb">1QB</option>
            <option value="sf">Superflex</option>
          </select>
        </label>
        <input
          type="text"
          placeholder="Search player or team..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)',
            width: 200, fontFamily: 'inherit', marginLeft: 'auto',
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5 }}>
          VERDICT
        </span>
        {VERDICTS.map((v) => (
          <button
            key={v}
            className={`pos-filter ${verdictFilter === v ? 'active' : ''}`}
            onClick={() => setVerdictFilter(v)}
            title={v !== 'ALL' ? VERDICT_STYLE[v].desc : undefined}
          >
            {v}{v !== 'ALL' && ` (${counts[v]})`}
          </button>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ ...th, textAlign: 'left', cursor: 'default' }}>Player</th>
              <th style={{ ...th, textAlign: 'center', width: 40, cursor: 'default' }}>Pos</th>
              <th style={{ ...th, textAlign: 'center', width: 52, cursor: 'default' }}>Class</th>
              <th style={{ ...th, textAlign: 'center', width: 86, cursor: 'default' }}>
                <span title="Career-model prospect tier (Alpha / Blue Chip / Starter / Contributor / Depth / Longshot)">Tier</span>
              </th>
              <th style={{ ...th, textAlign: 'right', width: 48 }} onClick={() => handleSort('percentile')}>
                <span title="Career-model percentile within the historical prospect pool">Pctl</span>{sortArrow('percentile')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('nowPpg')}>
                <span title="Current-season base projection (redraft-projections.json)">Now PPG</span>{sortArrow('nowPpg')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('rookieYearPpg')}>
                <span title="Actual rookie-season PPG (year-2 players only)">Yr-1 PPG</span>{sortArrow('rookieYearPpg')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 72 }} onClick={() => handleSort('p2')}>
                <span title="Ramp models: P(streamable THIS season) → P(streamable NEXT season). Year-2 players use the production+market model (LOSO AUC .85/.82); rookies use the landing-spot model (.77/.75 — incumbent quality, room size, QB quality, team offense). Green arrow = forward-loaded profile.">Strm % →</span>{sortArrow('p2')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('startProb')}>
                <span title="Career-model probability of reaching low-end-starter PPG at the position">Start %</span>{sortArrow('startProb')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 52 }} onClick={() => handleSort('boomProb')}>
                <span title="Career-model probability of a top-tier outcome">Boom</span>{sortArrow('boomProb')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 52 }} onClick={() => handleSort('bustProb')}>
                <span title="Career-model probability of a bust outcome">Bust</span>{sortArrow('bustProb')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 70 }} onClick={() => handleSort('dynRank')}>
                <span title={`FantasyCalc dynasty value (${format === 'sf' ? 'superflex' : '1QB'}) and overall rank`}>Value</span>{sortArrow('dynRank')}
              </th>
              <th style={{ ...th, textAlign: 'center', width: 90 }} onClick={() => handleSort('verdict')}>
                Verdict{sortArrow('verdict')}
              </th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r) => (
              <tr key={`${r.name}:${r.position}:${r.classOf}`} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ ...td, fontWeight: 600 }}>
                  <PlayerName name={r.name} position={r.position} />
                  {r.team && <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 5 }}>{r.team}</span>}
                  {r.isDC1 && (
                    <span
                      style={{
                        fontSize: 8, fontWeight: 800, marginLeft: 5, padding: '1px 4px',
                        borderRadius: 6, background: '#3a3000', color: '#facc15', verticalAlign: 'middle',
                      }}
                      title={`Listed #1 ${r.position} on ${r.team || 'his team'}'s current depth chart (nflverse snapshot)`}
                    >
                      DC1
                    </span>
                  )}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span className={`pos-badge pos-${r.position}`} style={{ fontSize: 10 }}>{r.position}</span>
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                    background: r.isYear2 ? '#1e3a5f' : '#312e81',
                    color: r.isYear2 ? '#93c5fd' : '#a5b4fc',
                  }}>
                    {r.isYear2 ? 'Y2' : 'R'}
                  </span>
                </td>
                <td style={{ ...td, textAlign: 'center', fontSize: 11, color: 'var(--text-secondary)' }}>{r.tierLabel}</td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)' }}>{r.percentile}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>
                  {Number.isFinite(r.nowPpg) ? r.nowPpg.toFixed(1) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-secondary)' }}>
                  {Number.isFinite(r.rookieYearPpg) ? r.rookieYearPpg.toFixed(1) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {Number.isFinite(r.p1) ? (
                    <span title={`Ramp model: ${(100 * r.p1).toFixed(0)}% streamable this season, ${(100 * r.p2).toFixed(0)}% next, ${(100 * r.pEver).toFixed(0)}% ever within 4 years.`}>
                      {(100 * r.p1).toFixed(0)}
                      <span style={{ color: r.p2 > r.p1 ? '#22c55e' : 'var(--text-muted)', fontWeight: 800 }}>→</span>
                      {(100 * r.p2).toFixed(0)}
                    </span>
                  ) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: startProbColor(r.startProb) }}>
                  {Number.isFinite(r.startProb) ? `${Math.round(r.startProb)}%` : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', color: r.boomProb >= 20 ? '#22c55e' : 'var(--text-muted)' }}>
                  {r.boomProb.toFixed(0)}%
                </td>
                <td style={{ ...td, textAlign: 'right', color: r.bustProb >= 50 ? '#ef4444' : 'var(--text-muted)' }}>
                  {r.bustProb.toFixed(0)}%
                </td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-secondary)' }}>
                  {r.dynValue > 0 ? (
                    <span title={`Overall dynasty rank #${r.dynRank}`}>{r.dynValue.toLocaleString()}</span>
                  ) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span
                    style={{
                      display: 'inline-block', fontSize: 10, fontWeight: 700,
                      padding: '2px 8px', borderRadius: 10,
                      background: VERDICT_STYLE[r.verdict].bg,
                      color: VERDICT_STYLE[r.verdict].fg,
                      border: 'none',
                      whiteSpace: 'nowrap', cursor: 'help',
                    }}
                    title={r.why}
                  >
                    {r.verdict}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {displayRows.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
          No players match your filters.
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.5 }}>
        Most leagues restrict taxi squads to first- and second-year
        players — this list is exactly that population (the{' '}
        {CURRENT_SEASON} and {CURRENT_SEASON - 1} draft classes scored by
        the career model). Year-2 verdicts lean on actual rookie-season
        production where it exists; rookie verdicts are model +
        current-season projection only. Drop is deliberately strict
        (model's bottom tail AND weak profile AND zero production
        signal) — a Taxi verdict on a marginal profile just means the
        stash is free, not that he's untouchable.{' '}
        <strong>Validated on the 2010–2023 classes</strong>: year-2
        verdicts come from a gradient-boosted ramp model trained
        directly on the streamable targets (leave-one-class-out AUC:
        this-season .85, next-season .82, ever .83; thresholds p1 ≥ .50
        → Roster, pEver ≤ .12 → Drop). At those thresholds the Roster
        bucket hit streamable 76% of the time (86% within 4 years), the
        Taxi bucket is genuinely <em>forward-loaded</em> — 20%
        streamable next season rising to 23% the season after — and
        only 12% of Drops ever had a streamable season, with just 3 of
        68 delayed-ramp players mislabeled. Rookies and unscored players
        use the hand-tuned rule tree (details in Model Docs).
      </p>
    </div>
  );
}

function startProbColor(p: number): string {
  if (!Number.isFinite(p)) return 'var(--text-muted)';
  if (p >= 50) return '#22c55e';
  if (p >= 30) return '#86efac';
  if (p >= 15) return 'var(--text-primary)';
  return 'var(--text-muted)';
}
