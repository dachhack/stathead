import type { Tab } from '../types';

// Cross-tab navigation without prop-drilling: deeply nested components
// dispatch a window event that App listens for. DocsLink pairs this
// with a one-shot localStorage handoff so Model Docs can open on the
// right section.

export type DocsSection = 'projection' | 'rookie' | 'ktc-forecast' | 'draft-kit';

export const NAVIGATE_EVENT = 'stathead:navigate';
export const DOCS_SECTION_KEY = 'model-docs-section';

export function navigateToTab(tab: Tab) {
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: tab }));
}
