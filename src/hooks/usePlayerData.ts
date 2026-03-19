import { useState, useEffect } from 'react';
import {
  fetchPlayerStats,
  aggregateToSeasonTotals,
  filterFantasyRelevant,
} from '../data';
import type { PlayerStats, SeasonTotals } from '../types';

interface UsePlayerDataReturn {
  weeklyStats: PlayerStats[];
  seasonTotals: SeasonTotals[];
  loading: boolean;
  error: string | null;
}

export function usePlayerData(season: number): UsePlayerDataReturn {
  const [weeklyStats, setWeeklyStats] = useState<PlayerStats[]>([]);
  const [seasonTotals, setSeasonTotals] = useState<SeasonTotals[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchPlayerStats(season)
      .then((data) => {
        if (cancelled) return;
        setWeeklyStats(data);
        const totals = aggregateToSeasonTotals(data);
        setSeasonTotals(filterFantasyRelevant(totals));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [season]);

  return { weeklyStats, seasonTotals, loading, error };
}
