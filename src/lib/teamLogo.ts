// Team logo URLs from ESPN's public CDN (loaded client-side; no bundled assets).
// Most data codes match ESPN's slug; a couple differ (Rams, Washington).
const ESPN_SLUG: Record<string, string> = { LA: 'lar', WAS: 'wsh' };

export function teamLogoUrl(team: string): string {
  if (!team) return '';
  const slug = ESPN_SLUG[team] ?? team.toLowerCase();
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${slug}.png`;
}
