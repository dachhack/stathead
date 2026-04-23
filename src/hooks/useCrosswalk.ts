import { useEffect, useState } from 'react';
import { loadCrosswalk, type CrosswalkIndex } from '../lib/playerLookup';

export function useCrosswalk(): { index: CrosswalkIndex | null; loading: boolean } {
  const [index, setIndex] = useState<CrosswalkIndex | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    loadCrosswalk()
      .then((i) => { if (!cancelled) { setIndex(i); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  return { index, loading };
}
