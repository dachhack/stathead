import { useEffect, useMemo, useState } from 'react';
import { useCrosswalk } from './useCrosswalk';
import { lookupByKey } from '../lib/playerLookup';
import { loadPlayerDetail, type PlayerDetailData } from '../lib/playerDetail';

export function usePlayerDetail(playerKey: string | null): {
  data: PlayerDetailData | null;
  loading: boolean;
  error: string | null;
} {
  const { index, loading: cwLoading } = useCrosswalk();
  const [data, setData] = useState<PlayerDetailData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  // Resolve the crosswalk record synchronously during render — that way
  // we can derive a "missing key" error without touching state inside
  // the effect.
  const rec = useMemo(
    () => (playerKey && index ? lookupByKey(index, playerKey) : null),
    [playerKey, index],
  );

  useEffect(() => {
    if (!rec) return;
    let cancelled = false;
    setFetching(true);
    setFetchError(null);
    loadPlayerDetail(rec)
      .then((d) => { if (!cancelled) { setData(d); setFetching(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : String(e));
          setFetching(false);
        }
      });
    return () => { cancelled = true; };
  }, [rec]);

  const missing = !!playerKey && !!index && !rec;
  const error = missing ? `Unknown player key: ${playerKey}` : playerKey ? fetchError : null;
  const effectiveData = playerKey && rec ? data : null;
  const loading = cwLoading || (!!playerKey && !!index && !!rec && fetching);

  return { data: effectiveData, loading, error };
}
