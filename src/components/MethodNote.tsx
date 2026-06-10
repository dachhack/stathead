import type { ReactNode } from 'react';
import { useCollapse } from '../hooks/useCollapse';

/** Collapsible methodology blurb — keeps the Draft Kit sections compact
 *  by hiding the "how these numbers work" prose behind a toggle
 *  (collapsed by default, state remembered per section). */
export function MethodNote({ id, children }: { id: string; children: ReactNode }) {
  const [open, toggle] = useCollapse(`method:${id}`, false);
  return (
    <div style={{ marginBottom: 12 }}>
      <button
        onClick={toggle}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'inherit',
        }}
      >
        {open ? '▾' : '▸'} How this works
      </button>
      {open && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 0', lineHeight: 1.55 }}>
          {children}
        </p>
      )}
    </div>
  );
}
