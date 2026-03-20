import { getSportsDataIOKey } from './apiKeys';
import type {
  SDIOProjection,
  SDIODfsSalary,
  SDIOOdds,
  SDIONews,
  SDIOBoxScore,
} from '../types';

const BASE = 'https://api.sportsdata.io/v3/nfl';

function getKey(): string {
  const key = getSportsDataIOKey();
  if (!key) throw new Error('SportsDataIO API key not configured. Add it in Settings.');
  return key;
}

async function sdioFetch<T>(path: string): Promise<T> {
  const key = getKey();
  const url = `${BASE}/${path}`;
  const response = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': key },
  });
  if (response.status === 401) {
    throw new Error('Invalid SportsDataIO API key. Check your key in Settings.');
  }
  if (!response.ok) {
    throw new Error(`SportsDataIO API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// --- Projections ---

export async function fetchSDIOSeasonProjections(
  season: number
): Promise<SDIOProjection[]> {
  return sdioFetch<SDIOProjection[]>(
    `projections/json/PlayerSeasonProjectionStats/${season}`
  );
}

export async function fetchSDIOWeeklyProjections(
  season: number,
  week: number
): Promise<SDIOProjection[]> {
  return sdioFetch<SDIOProjection[]>(
    `projections/json/PlayerGameProjectionStatsByWeek/${season}/${week}`
  );
}

// --- DFS Salaries ---

export async function fetchSDIODfsSalaries(
  season: number,
  week: number
): Promise<SDIODfsSalary[]> {
  return sdioFetch<SDIODfsSalary[]>(
    `projections/json/DfsSlatesByWeek/${season}/${week}`
  );
}

// --- Odds ---

export async function fetchSDIOOdds(
  season: number,
  week: number
): Promise<SDIOOdds[]> {
  return sdioFetch<SDIOOdds[]>(
    `odds/json/GameOddsByWeek/${season}/${week}`
  );
}

// --- News ---

export async function fetchSDIONews(): Promise<SDIONews[]> {
  return sdioFetch<SDIONews[]>('scores/json/News');
}

export async function fetchSDIONewsByPlayer(
  playerID: number
): Promise<SDIONews[]> {
  return sdioFetch<SDIONews[]>(`scores/json/NewsByPlayerID/${playerID}`);
}

export async function fetchSDIONewsByTeam(
  team: string
): Promise<SDIONews[]> {
  return sdioFetch<SDIONews[]>(`scores/json/NewsByTeam/${team}`);
}

// --- Box Scores ---

export async function fetchSDIOBoxScores(
  season: number,
  week: number
): Promise<SDIOBoxScore[]> {
  return sdioFetch<SDIOBoxScore[]>(
    `stats/json/BoxScoresByWeek/${season}/${week}`
  );
}

// --- Convenience: check if key is set ---

export function hasSDIOKey(): boolean {
  return !!getSportsDataIOKey();
}
