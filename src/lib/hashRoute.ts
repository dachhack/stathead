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
