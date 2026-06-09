// Cache-busting for committed data files. GitHub Pages + browsers cache static
// JSON by URL, so a corrected data file (e.g. player-crosswalk.json) can be
// served stale after a deploy. Appending the build hash makes the URL change
// each deploy, forcing a fresh fetch.
declare const __BUILD_HASH__: string;

export const BUILD_HASH: string = typeof __BUILD_HASH__ === 'string' ? __BUILD_HASH__ : 'dev';

/** Append the build hash as a `v` query param so the asset refetches per deploy. */
export function bust(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}v=${BUILD_HASH}`;
}
