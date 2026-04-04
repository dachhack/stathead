/**
 * College analytics builder — shared by both buildFeatureMatrix and feature store.
 *
 * Extracts college advanced analytics (dominator, breakout age, ZAP features,
 * teammate scores, per-game stats, best seasons, position averages) from
 * raw college stats data + draft data + NCAA team data.
 */

import { normalizeName, parseHeight, POSITIONS } from './featureTypes';
import ncaaTeamData from '../data/ncaa-team-data.json';

export interface CollegeAdvanced {
  dominatorRating: number;
  breakoutAge: number;
  marketShare: number;
}

export interface CollegeBestSeason {
  bestRecYds: number; bestRecTDs: number; bestReceptions: number;
  bestRushYds: number; bestRushTDs: number;
  numSeasons: number;
}

export interface CollegeZap {
  recYdsPerTeamPassAtt: number;
  receptionShare: number;
  ydsPerTeamPlay: number;
  breakoutScore: number;
  bestSeasonRecYdsPerTPA: number;
  rushProductionWR: number;
  earlyDeclare: number;
}

export interface CollegePerGame {
  games: number;
  recPerGame: number;
  ydsPerGame: number;
  tdsPerGame: number;
  rushYPC: number;
  ydsPerRec: number;
}

export interface CollegeAnalyticsResult {
  collegePerGameByName: Map<string, CollegePerGame>;
  collegeAdvancedByName: Map<string, CollegeAdvanced>;
  collegeBestSeasonByName: Map<string, CollegeBestSeason>;
  collegeZapByName: Map<string, CollegeZap>;
  teammateScoreByName: Map<string, number>;
  collegeSOS: Map<string, number>;
  collegeAvgByPos: Map<string, Record<string, number>>;
}

// School name normalization for NCAA data matching
const schoolNameMap: Record<string, string> = {
  'central michigan': 'c michigan', 'eastern michigan': 'e michigan',
  'eastern carolina': 'e carolina', 'east carolina': 'e carolina',
  'western michigan': 'w michigan', 'western kentucky': 'w kentucky',
  'northern illinois': 'n illinois', 'middle tennessee': 'mid tennessee',
  'florida atlantic': 'fla atlantic', 'florida international': 'fla international',
  'florida state': 'florida st', 'ohio state': 'ohio st', 'michigan state': 'michigan st',
  'penn state': 'penn st', 'oklahoma state': 'oklahoma st', 'oregon state': 'oregon st',
  'washington state': 'washington st', 'iowa state': 'iowa st', 'kansas state': 'kansas st',
  'mississippi state': 'mississippi st', 'arizona state': 'arizona st',
  'colorado state': 'colorado st', 'fresno state': 'fresno st', 'boise state': 'boise st',
  'san diego state': 'san diego st', 'san jose state': 'san jose st',
  'arkansas state': 'arkansas st', 'ball state': 'ball st', 'kent state': 'kent st',
  'appalachian state': 'app state', 'coastal carolina': 'coastal car',
  'georgia state': 'georgia st', 'georgia southern': 'ga southern',
  'north carolina state': 'nc state', 'north carolina': 'n carolina',
  'south carolina': 's carolina', 'south florida': 's florida',
  'north texas': 'n texas', 'louisiana tech': 'la tech',
  'louisiana-lafayette': 'louisiana', 'louisiana-monroe': 'la monroe',
  'southern mississippi': 's mississippi', 'southern methodist': 'smu',
  'brigham young': 'byu', 'texas christian': 'tcu',
  'texas a&m': 'texas a&m', 'texas tech': 'texas tech',
  'virginia tech': 'virginia tech', 'georgia tech': 'georgia tech',
  'miami (fl)': 'miami', 'miami (oh)': 'miami oh',
  'uab': 'uab', 'ucf': 'ucf', 'utep': 'utep', 'utsa': 'utsa', 'unlv': 'unlv',
  'connecticut': 'uconn', 'massachusetts': 'umass',
  'southern california': 'usc',
};

function normalizeSchool(school: string): string {
  const s = school.toLowerCase().trim()
    .replace(/\buniversity\b/g, '').replace(/\bstate\b/g, 'st')
    .replace(/\bnorthern\b/g, 'n').replace(/\bsouthern\b/g, 's')
    .replace(/\beastern\b/g, 'e').replace(/\bwestern\b/g, 'w')
    .replace(/\bcentral\b/g, 'c').replace(/\bmiddle\b/g, 'mid')
    .replace(/\s+/g, ' ').trim();
  return schoolNameMap[s] || schoolNameMap[school.toLowerCase().trim()] || s;
}

type PlayerSeasonStats = {
  recYds: number; recTDs: number; rushYds: number; rushTDs: number;
  receptions: number; rushAtt: number; passAtt: number; completions: number;
  games: number; school: string; pos: string;
};

/**
 * Build all college analytics from raw data.
 */
export function buildCollegeAnalytics(
  collegeStatsData: any[],
  draftByName: Map<string, any>,
  collegeByName: Map<string, Map<string, number>>,
  prospectByName: Map<string, any>,
  collegeQBRByName?: Map<string, number>,
): CollegeAnalyticsResult {
  const ncaaSOS = ncaaTeamData.sos as Record<string, number>;
  const ncaaPassAttPerGame = ncaaTeamData.teamPassAttPerGame as Record<string, number>;
  const ncaaRushAttPerGame = ncaaTeamData.teamRushAttPerGame as Record<string, number>;

  // NCAA team data lookups
  const collegeSOS = new Map<string, number>();
  for (const [key, rating] of Object.entries(ncaaSOS)) {
    collegeSOS.set(key, 1.0 + (rating / 20));
  }
  const ncaaTeamPassAtt = new Map<string, number>();
  const ncaaTeamRushAtt = new Map<string, number>();
  const ncaaTeamTotalPlays = new Map<string, number>();
  for (const [key, avgPerGame] of Object.entries(ncaaPassAttPerGame)) {
    ncaaTeamPassAtt.set(key, Math.round(avgPerGame * 13));
  }
  for (const [key, avgPerGame] of Object.entries(ncaaRushAttPerGame)) {
    ncaaTeamRushAtt.set(key, Math.round(avgPerGame * 13));
  }
  for (const key of ncaaTeamPassAtt.keys()) {
    const pa = ncaaTeamPassAtt.get(key) || 0;
    const ra = ncaaTeamRushAtt.get(key) || 0;
    if (pa + ra > 0) ncaaTeamTotalPlays.set(key, pa + ra);
  }

  // ── Per-game stats ──
  const collegePerGameByName = new Map<string, CollegePerGame>();
  {
    const collegeTotals = new Map<string, { gamesBySeason: Map<number, number>; receptions: number; recYds: number; rushYds: number; rushAtt: number; tds: number; passYds: number }>();
    for (const cs of collegeStatsData) {
      const name = normalizeName(cs.player_name);
      if (!collegeTotals.has(name)) collegeTotals.set(name, { gamesBySeason: new Map(), receptions: 0, recYds: 0, rushYds: 0, rushAtt: 0, tds: 0, passYds: 0 });
      const t = collegeTotals.get(name)!;
      const stat = (cs.statistic || '').toLowerCase();
      if (stat.includes('game')) {
        const cur = t.gamesBySeason.get(cs.season) || 0;
        t.gamesBySeason.set(cs.season, Math.max(cur, cs.value || 0));
      }
      else if (stat.includes('reception') && !stat.includes('yard') && !stat.includes('td')) t.receptions += cs.value || 0;
      else if (stat.includes('receiving yard')) t.recYds += cs.value || 0;
      else if (stat.includes('rushing yard')) t.rushYds += cs.value || 0;
      else if (stat.includes('rushing attempt') || stat.includes('carries')) t.rushAtt += cs.value || 0;
      else if (stat.includes('touchdown')) t.tds += cs.value || 0;
      else if (stat.includes('passing yard')) t.passYds += cs.value || 0;
    }
    for (const [name, t] of collegeTotals) {
      let totalGames = 0;
      for (const g of t.gamesBySeason.values()) totalGames += g;
      const games = totalGames || 1;
      const totalYds = t.recYds + t.rushYds + t.passYds;
      collegePerGameByName.set(name, {
        games: totalGames,
        recPerGame: Math.round((t.receptions / games) * 10) / 10,
        ydsPerGame: Math.round((totalYds / games) * 10) / 10,
        tdsPerGame: Math.round((t.tds / games) * 10) / 10,
        rushYPC: t.rushAtt > 0 ? Math.round((t.rushYds / t.rushAtt) * 10) / 10 : 0,
        ydsPerRec: t.receptions > 0 ? Math.round((t.recYds / t.receptions) * 10) / 10 : 0,
      });
    }
  }

  // ── Player per-season + school per-season aggregation ──
  const playerSeasonStats = new Map<string, Map<number, PlayerSeasonStats>>();
  const schoolSeasonTotals = new Map<string, { recYds: number; recTDs: number; rushYds: number; rushTDs: number; receptions: number; rushAtt: number; passAtt: number; completions: number; totalPlays: number }>();

  for (const cs of collegeStatsData) {
    const name = normalizeName(cs.player_name);
    const season = cs.season;
    const school = (cs.school || cs.school_abbr || '').toLowerCase();
    const stat = (cs.statistic || '').toLowerCase();

    if (!playerSeasonStats.has(name)) playerSeasonStats.set(name, new Map());
    const seasons = playerSeasonStats.get(name)!;
    if (!seasons.has(season)) seasons.set(season, { recYds: 0, recTDs: 0, rushYds: 0, rushTDs: 0, receptions: 0, rushAtt: 0, passAtt: 0, completions: 0, games: 0, school, pos: cs.pos_abbr || '' });
    const ps = seasons.get(season)!;
    if (stat.includes('receiving yard')) ps.recYds += cs.value || 0;
    else if (stat.includes('receiving touchdown')) ps.recTDs += cs.value || 0;
    else if (stat.includes('rushing yard')) ps.rushYds += cs.value || 0;
    else if (stat.includes('rushing touchdown')) ps.rushTDs += cs.value || 0;
    else if (stat.includes('reception') && !stat.includes('yard') && !stat.includes('td')) ps.receptions += cs.value || 0;
    else if (stat.includes('rushing attempt') || stat.includes('carries')) ps.rushAtt += cs.value || 0;
    else if (stat.includes('passing attempt') || stat === 'pass attempts') ps.passAtt += cs.value || 0;
    else if (stat.includes('completion') && !stat.includes('pct')) ps.completions += cs.value || 0;
    else if (stat.includes('games played') || stat === 'games') ps.games = Math.max(ps.games, cs.value || 0);

    const schoolKey = `${school}:${season}`;
    if (!schoolSeasonTotals.has(schoolKey)) schoolSeasonTotals.set(schoolKey, { recYds: 0, recTDs: 0, rushYds: 0, rushTDs: 0, receptions: 0, rushAtt: 0, passAtt: 0, completions: 0, totalPlays: 0 });
    const st = schoolSeasonTotals.get(schoolKey)!;
    if (stat.includes('receiving yard')) st.recYds += cs.value || 0;
    else if (stat.includes('receiving touchdown')) st.recTDs += cs.value || 0;
    else if (stat.includes('rushing yard')) st.rushYds += cs.value || 0;
    else if (stat.includes('rushing touchdown')) st.rushTDs += cs.value || 0;
    else if (stat.includes('reception') && !stat.includes('yard') && !stat.includes('td')) st.receptions += cs.value || 0;
    else if (stat.includes('rushing attempt') || stat.includes('carries')) { st.rushAtt += cs.value || 0; st.totalPlays += cs.value || 0; }
    else if (stat.includes('passing attempt') || stat === 'pass attempts') { st.passAtt += cs.value || 0; st.totalPlays += cs.value || 0; }
    else if (stat.includes('completion') && !stat.includes('pct')) st.completions += cs.value || 0;
  }

  // ── Advanced: dominator, breakout age, market share ──
  const collegeAdvancedByName = new Map<string, CollegeAdvanced>();
  for (const [name, seasons] of playerSeasonStats) {
    let bestDominator = 0, bestMarketShare = 0, breakoutAge = 0;
    const draft = draftByName.get(name);
    const draftAge = draft?.age || 0;
    const draftYear = draft?.season || 0;

    for (const [seasonYear, ps] of seasons) {
      const schoolKey = `${ps.school}:${seasonYear}`;
      const team = schoolSeasonTotals.get(schoolKey);
      if (!team) continue;
      const pos = (ps.pos || '').toUpperCase();
      let dominator = 0;
      if (pos === 'RB') {
        const ydsShare = team.rushYds > 0 ? ps.rushYds / team.rushYds : 0;
        const tdShare = team.rushTDs > 0 ? ps.rushTDs / team.rushTDs : 0;
        dominator = ((ydsShare + tdShare) / 2) * 100;
      } else {
        const ydsShare = team.recYds > 0 ? ps.recYds / team.recYds : 0;
        const tdShare = team.recTDs > 0 ? ps.recTDs / team.recTDs : 0;
        dominator = ((ydsShare + tdShare) / 2) * 100;
      }
      bestDominator = Math.max(bestDominator, dominator);
      const mktShare = pos === 'RB'
        ? (team.rushAtt > 0 ? (ps.rushAtt / team.rushAtt) * 100 : 0)
        : (team.receptions > 0 ? (ps.receptions / team.receptions) * 100 : 0);
      bestMarketShare = Math.max(bestMarketShare, mktShare);
      if (breakoutAge === 0 && dominator > 20 && draftAge > 0 && draftYear > 0) {
        const ageInSeason = draftAge - (draftYear - seasonYear);
        if (ageInSeason > 17 && ageInSeason < 25) breakoutAge = ageInSeason;
      }
    }
    if (breakoutAge === 0 && draftAge > 0) breakoutAge = draftAge;
    collegeAdvancedByName.set(name, {
      dominatorRating: Math.round(bestDominator * 10) / 10,
      breakoutAge, marketShare: Math.round(bestMarketShare * 10) / 10,
    });
  }

  // ── Best season stats ──
  const collegeBestSeasonByName = new Map<string, CollegeBestSeason>();
  for (const [name, seasons] of playerSeasonStats) {
    let bestRecYds = 0, bestRecTDs = 0, bestReceptions = 0, bestRushYds = 0, bestRushTDs = 0;
    for (const [, ps] of seasons) {
      bestRecYds = Math.max(bestRecYds, ps.recYds);
      bestRecTDs = Math.max(bestRecTDs, ps.recTDs);
      bestReceptions = Math.max(bestReceptions, ps.receptions);
      bestRushYds = Math.max(bestRushYds, ps.rushYds);
      bestRushTDs = Math.max(bestRushTDs, ps.rushTDs);
    }
    collegeBestSeasonByName.set(name, { bestRecYds, bestRecTDs, bestReceptions, bestRushYds, bestRushTDs, numSeasons: seasons.size });
  }

  // ── ZAP features ──
  const collegeZapByName = new Map<string, CollegeZap>();
  for (const [name, seasons] of playerSeasonStats) {
    const draft = draftByName.get(name);
    const draftAge = draft?.age || 0;
    const draftYear = draft?.season || 0;
    const pos = (draft?.position || '').toUpperCase();
    let bestRecYdsPerTPA = 0, bestReceptionShare = 0, bestYdsPerTeamPlay = 0, breakoutScore = 0, bestRushYdsSeason = 0;

    for (const [seasonYear, ps] of [...seasons.entries()].sort((a, b) => a[0] - b[0])) {
      const gamesPlayed = ps.games > 0 ? ps.games : (ps.recYds > 0 || ps.rushYds > 0 || ps.passAtt > 0 ? 13 : 0);
      if (gamesPlayed < 6) continue;
      const schoolKey = `${ps.school}:${seasonYear}`;
      const team = schoolSeasonTotals.get(schoolKey);
      if (!team) continue;

      const ncaaKey = `${normalizeSchool(ps.school)}:${seasonYear}`;
      const sosMult = collegeSOS.get(ncaaKey) || 1.0;
      const realTeamPA = ncaaTeamPassAtt.get(ncaaKey) || (team.passAtt > 0 ? team.passAtt : 0);
      const realTeamPlays = ncaaTeamTotalPlays.get(ncaaKey) || (realTeamPA + (ncaaTeamRushAtt.get(ncaaKey) || team.rushAtt || 0));
      const estTeamComp = realTeamPA > 0 ? Math.round(realTeamPA * 0.63) : (team.completions > 0 ? team.completions : 0);

      const recYdsPerTPA = realTeamPA > 0 ? (ps.recYds / realTeamPA) * sosMult : 0;
      bestRecYdsPerTPA = Math.max(bestRecYdsPerTPA, recYdsPerTPA);
      bestReceptionShare = Math.max(bestReceptionShare, estTeamComp > 0 ? ps.receptions / estTeamComp : 0);
      const totalYds = ps.recYds + ps.rushYds;
      bestYdsPerTeamPlay = Math.max(bestYdsPerTeamPlay, realTeamPlays > 0 ? (totalYds / realTeamPlays) * sosMult : 0);

      if (draftAge > 0 && draftYear > 0) {
        const ageInSeason = draftAge - (draftYear - seasonYear);
        if (ageInSeason > 17 && ageInSeason < 25) {
          breakoutScore = Math.max(breakoutScore, recYdsPerTPA * (1.0 + (21 - ageInSeason) * 0.075));
        }
      } else {
        breakoutScore = Math.max(breakoutScore, recYdsPerTPA);
      }
      if (pos === 'WR') bestRushYdsSeason = Math.max(bestRushYdsSeason, Math.min(ps.rushYds, 500));
    }
    collegeZapByName.set(name, {
      recYdsPerTeamPassAtt: Math.round(bestRecYdsPerTPA * 1000) / 1000,
      receptionShare: Math.round(bestReceptionShare * 1000) / 1000,
      ydsPerTeamPlay: Math.round(bestYdsPerTeamPlay * 1000) / 1000,
      breakoutScore: Math.round(breakoutScore * 1000) / 1000,
      bestSeasonRecYdsPerTPA: Math.round(bestRecYdsPerTPA * 1000) / 1000,
      rushProductionWR: Math.round(bestRushYdsSeason),
      earlyDeclare: seasons.size <= 3 ? 1 : 0,
    });
  }

  // ── Teammate score ──
  const teammateScoreByName = new Map<string, number>();
  {
    const schoolDraftees = new Map<string, Array<{ name: string; season: number; pick: number }>>();
    for (const [name, draft] of draftByName) {
      const playerSeasons = playerSeasonStats.get(name);
      if (!playerSeasons) continue;
      let school = '';
      for (const [, ps] of playerSeasons) { school = ps.school; }
      if (!school || !draft.pick) continue;
      if (!schoolDraftees.has(school)) schoolDraftees.set(school, []);
      schoolDraftees.get(school)!.push({ name, season: draft.season || 0, pick: draft.pick });
    }
    for (const [name, draft] of draftByName) {
      const playerSeasons = playerSeasonStats.get(name);
      if (!playerSeasons) continue;
      let school = '';
      for (const [, ps] of playerSeasons) { school = ps.school; }
      if (!school) continue;
      const mates = schoolDraftees.get(school) || [];
      let score = 0;
      for (const m of mates) {
        if (m.name === name) continue;
        if (Math.abs(m.season - (draft.season || 0)) <= 2 && m.pick > 0) score += 1 / m.pick;
      }
      teammateScoreByName.set(name, Math.round(score * 1000) / 1000);
    }
  }

  // ── Position-average college stats for imputation ──
  const collegeAvgByPos = new Map<string, Record<string, number>>();
  {
    const fields = [
      'collegePassYds', 'collegePassTDs', 'collegeRushYds', 'collegeRecYds',
      'collegeRecTDs', 'collegeTotalTDs', 'collegeRecPerGame', 'collegeYdsPerGame',
      'collegeTDsPerGame', 'collegeRushYPC', 'collegeDominatorRating', 'collegeBreakoutAge',
      'collegeMarketShare', 'collegeYdsPerRec', 'collegeBestRecYds', 'collegeBestRecTDs',
      'collegeBestReceptions', 'collegeBestRushYds',
    ];
    const sums = new Map<string, Record<string, { sum: number; count: number }>>();
    for (const [name, cs] of collegeByName) {
      const draft = draftByName.get(name);
      const prospect = prospectByName.get(name);
      const pos = (draft?.position || prospect?.position || '').toUpperCase();
      if (!POSITIONS.includes(pos)) continue;
      if (!sums.has(pos)) sums.set(pos, {});
      const s = sums.get(pos)!;
      const pg = collegePerGameByName.get(name);
      const adv = collegeAdvancedByName.get(name);
      const best = collegeBestSeasonByName.get(name);
      const vals: Record<string, number> = {
        collegePassYds: cs.get('Passing Yards') || 0,
        collegePassTDs: cs.get('Passing Touchdowns') || 0,
        collegeRushYds: cs.get('Rushing Yards') || 0,
        collegeRecYds: cs.get('Receiving Yards') || 0,
        collegeRecTDs: cs.get('Receiving Touchdowns') || 0,
        collegeTotalTDs: (cs.get('Passing Touchdowns') || 0) + (cs.get('Rushing Touchdowns') || 0) + (cs.get('Receiving Touchdowns') || 0),
        collegeRecPerGame: pg?.recPerGame || 0, collegeYdsPerGame: pg?.ydsPerGame || 0,
        collegeTDsPerGame: pg?.tdsPerGame || 0, collegeRushYPC: pg?.rushYPC || 0,
        collegeYdsPerRec: pg?.ydsPerRec || 0,
        collegeDominatorRating: adv?.dominatorRating || 0, collegeBreakoutAge: adv?.breakoutAge || 0,
        collegeMarketShare: adv?.marketShare || 0,
        collegeBestRecYds: best?.bestRecYds || 0, collegeBestRecTDs: best?.bestRecTDs || 0,
        collegeBestReceptions: best?.bestReceptions || 0, collegeBestRushYds: best?.bestRushYds || 0,
      };
      for (const f of fields) {
        if (vals[f] > 0) {
          if (!s[f]) s[f] = { sum: 0, count: 0 };
          s[f].sum += vals[f]; s[f].count++;
        }
      }
    }
    for (const [pos, s] of sums) {
      const avgs: Record<string, number> = {};
      for (const [f, { sum, count }] of Object.entries(s)) {
        avgs[f] = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
      }
      collegeAvgByPos.set(pos, avgs);
    }
  }

  return {
    collegePerGameByName, collegeAdvancedByName, collegeBestSeasonByName,
    collegeZapByName, teammateScoreByName, collegeSOS, collegeAvgByPos,
  };
}
