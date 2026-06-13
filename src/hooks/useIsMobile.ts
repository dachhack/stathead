import { useEffect, useState } from 'react';

/**
 * True when the viewport is at or below `maxWidth` (default 640px).
 * SSR/Node-safe (returns false when matchMedia is unavailable) and
 * updates live on resize/orientation change.
 */
export function useIsMobile(maxWidth = 640): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return isMobile;
}
