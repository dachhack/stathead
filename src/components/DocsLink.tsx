import type { DocsSection } from '../lib/navigate';
import { DOCS_SECTION_KEY, navigateToTab } from '../lib/navigate';

// Subtle "model docs" link for surfaces that consume a model or
// optimizer. Navigates to the Model Docs tab and deep-links the right
// section via a one-shot localStorage handoff (ModelDocumentation reads
// + clears it on mount).

export function DocsLink({ section, title }: { section: DocsSection; title?: string }) {
  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        try { localStorage.setItem(DOCS_SECTION_KEY, section); } catch { /* quota */ }
        navigateToTab('model-docs');
      }}
      title={title ?? 'How this model works, with validation — Model Docs'}
      style={{
        fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
        textDecoration: 'none', border: '1px solid var(--border)',
        borderRadius: 6, padding: '1px 6px', whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
    >
      ⓘ docs
    </a>
  );
}
