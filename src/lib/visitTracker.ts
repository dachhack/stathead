/**
 * Anonymous pageview beacon → the visit-tracker Cloudflare Worker
 * (workers/visit-tracker), which writes to Workers Analytics Engine.
 * First-party and privacy-friendly: no cookies, no identifiers stored in
 * the browser, and the worker keeps only a daily-rotating hash — see the
 * worker header for the full data layout. Stats: the worker root serves a
 * small dashboard (visit-tracker.dachhack.workers.dev).
 */

const TRACKER_URL = import.meta.env?.VITE_VISIT_TRACKER ?? 'https://visit-tracker.dachhack.workers.dev';

let lastPage: string | null = null;

/** Fire-and-forget pageview. Never throws; no-ops on localhost, under
 *  Do Not Track / Global Privacy Control, and on same-page repeats. */
export function trackPageview(page: string): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  try {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return;
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (nav.doNotTrack === '1' || nav.globalPrivacyControl) return;
    if (page === lastPage) return; // dedupes StrictMode double-effects too
    lastPage = page;

    // A plain-string sendBeacon posts as text/plain → simple request, no
    // CORS preflight. The worker parses the body as JSON regardless.
    const payload = JSON.stringify({ page, ref: document.referrer || '' });
    if (!navigator.sendBeacon?.(`${TRACKER_URL}/hit`, payload)) {
      fetch(`${TRACKER_URL}/hit`, { method: 'POST', body: payload, keepalive: true }).catch(() => {});
    }
  } catch {
    // Analytics must never break the app.
  }
}
