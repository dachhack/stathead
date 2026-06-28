// Shareable query-param route for the Sleeper User Snooper.
// URL shape: ?snoop=<username>  (e.g. stathead.app/?snoop=dachhack)
//
// Chose a query param over the hash route used for player detail because the
// user-facing share link reads cleaner, and the snooper is a top-level tab
// rather than an in-place overlay — so the param just seeds the initial tab +
// username and is updated in place on each lookup.

export function parseSnoopQuery(search: string): string | null {
  const u = new URLSearchParams(search).get('snoop');
  const trimmed = u?.trim();
  return trimmed ? trimmed : null;
}

// Update (or remove) the `snoop` param in place, preserving any other query
// params and the hash. Uses replaceState so lookups don't pollute history.
export function setSnoopQuery(username: string | null): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const trimmed = username?.trim();
  if (trimmed) params.set('snoop', trimmed);
  else params.delete('snoop');
  const qs = params.toString();
  const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
  window.history.replaceState(null, '', url);
}

// Absolute link to a given user's snoop view, for the copy-to-clipboard button.
export function buildSnoopShareUrl(username: string): string {
  const params = new URLSearchParams(window.location.search);
  params.set('snoop', username.trim());
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}
