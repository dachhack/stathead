import { useState, useCallback } from 'react';

/**
 * Collapsible-section state persisted per section id, so the Draft Kit
 * remembers which sections a user keeps closed across visits.
 */
export function useCollapse(id: string, defaultOpen = true): [boolean, () => void] {
  const storageKey = `section-open:${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === null ? defaultOpen : raw === '1';
    } catch {
      return defaultOpen;
    }
  });
  const toggle = useCallback(() => {
    setOpen((v) => {
      try { localStorage.setItem(storageKey, v ? '0' : '1'); } catch { /* quota */ }
      return !v;
    });
  }, [storageKey]);
  return [open, toggle];
}

/** Shared chevron style for section-header collapse buttons. */
export const collapseBtnStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, cursor: 'pointer',
  background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 6, padding: '3px 10px',
};
