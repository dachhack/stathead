// Hash-based route escape hatch for shareable player detail URLs.
// Chose hash over a real router because the app is hosted on GitHub
// Pages and the existing shell is tab-state-driven — a hash-only
// deep-link avoids both a SPA fallback redirect shim and an extra
// router dependency. URL shape: #/player/sh_<10hex>

const PLAYER_HASH_RE = /^#\/player\/(sh_[0-9a-f]{10})(?:[/?].*)?$/i;

export function parsePlayerHash(hash: string): string | null {
  const m = PLAYER_HASH_RE.exec(hash);
  return m ? m[1] : null;
}

export function setPlayerHash(key: string | null): void {
  if (typeof window === 'undefined') return;
  if (key) {
    window.location.hash = `#/player/${key}`;
  } else if (window.location.hash) {
    // Clear by replacing state so we don't leave a lingering "#" in the bar.
    const url = window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
    // Fire hashchange manually since replaceState doesn't.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

// Swap Meet by StatHead: `#/swap/<id>` (read-only) or `#/swap/<id>?k=<key>`
// (the proposer's or the partner's capability link). The key rides in the
// hash on purpose — it never reaches the server hosting the page.
const SWAP_HASH_RE = /^#\/swap\/([a-z0-9]{6,24})(?:\?(.*))?$/i;

export interface SwapRoute { id: string; key: string | null }

export function parseSwapHash(hash: string): SwapRoute | null {
  const m = SWAP_HASH_RE.exec(hash);
  if (!m) return null;
  const key = m[2] ? new URLSearchParams(m[2]).get('k') : null;
  return { id: m[1].toLowerCase(), key: key || null };
}

export function swapHash(id: string, key?: string | null): string {
  return `#/swap/${id}${key ? `?k=${encodeURIComponent(key)}` : ''}`;
}

// Share links use a QUERY form, `?swap=<id>&k=<key>`, because chat apps and
// in-app browsers are not reliable about keeping a `#fragment` on a tapped
// link, and a lost fragment lands the partner on the home page. On load the
// query form is read here and then rewritten to the hash form in place.
export function parseSwapQuery(search: string): SwapRoute | null {
  const params = new URLSearchParams(search);
  const id = params.get('swap')?.trim().toLowerCase();
  if (!id || !/^[a-z0-9]{6,24}$/.test(id)) return null;
  const key = params.get('k')?.trim();
  return { id, key: key || null };
}

/** The meet route from either form of the URL. */
export function parseSwapLocation(search: string, hash: string): SwapRoute | null {
  return parseSwapHash(hash) ?? parseSwapQuery(search);
}

/** Swap the query form for the hash form without a navigation, so the
 *  address bar, back button and "copy my link" all agree. */
export function normalizeSwapUrl(): void {
  if (typeof window === 'undefined') return;
  const q = parseSwapQuery(window.location.search);
  if (!q || parseSwapHash(window.location.hash)) return;
  const params = new URLSearchParams(window.location.search);
  params.delete('swap');
  params.delete('k');
  const qs = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${swapHash(q.id, q.key)}`);
}

export function swapQuery(id: string, key?: string | null): string {
  return `?swap=${id}${key ? `&k=${encodeURIComponent(key)}` : ''}`;
}

export function setSwapHash(id: string | null, key?: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) window.location.hash = swapHash(id, key);
  else setPlayerHash(null); // same clearing dance: strip the hash, fire hashchange
}
