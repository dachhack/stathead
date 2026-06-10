import { useMemo, useState } from 'react';
import { useCrosswalk } from '../hooks/useCrosswalk';
import { lookupByNamePos } from '../lib/playerLookup';
import { teamLogoUrl } from '../lib/teamLogo';

// Compact player headshot for dense draft-kit rows. Resolution order:
// explicit `headshotUrl` prop (score-store rows carry nfl.com art), else
// the crosswalk's espn_id → ESPN CDN headshot (covers ~half the league
// including current rookies), else a tiny initials disc. Always
// fixed-size and lazy so long lists stay cheap.

interface Props {
  name: string;
  position?: string | null;
  headshotUrl?: string | null;
  size?: number;
}

export function PlayerAvatar({ name, position, headshotUrl, size = 20 }: Props) {
  const { index } = useCrosswalk();
  const [failed, setFailed] = useState(false);

  const url = useMemo(() => {
    if (headshotUrl) return headshotUrl;
    if (!index || !name) return null;
    const rec = lookupByNamePos(index, name, position ?? null);
    const espnId = rec?.espn_id;
    return espnId ? `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png` : null;
  }, [headshotUrl, index, name, position]);

  const common: React.CSSProperties = {
    width: size, height: size, borderRadius: '50%', flex: 'none',
    verticalAlign: 'middle',
  };

  if (!url || failed) {
    return (
      <span
        style={{
          ...common, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
          fontSize: Math.max(8, size * 0.42), fontWeight: 700,
        }}
        aria-hidden
      >
        {name ? name.charAt(0).toUpperCase() : '?'}
      </span>
    );
  }

  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ ...common, objectFit: 'cover', background: 'var(--bg-tertiary)' }}
    />
  );
}

/** Tiny team logo (ESPN CDN via lib/teamLogo), sized for 11-12px text rows. */
export function TeamLogo({ team, size = 14 }: { team: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!team || failed) return null;
  return (
    <img
      src={teamLogoUrl(team)}
      alt={team}
      title={team}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: size, height: size, flex: 'none', verticalAlign: 'middle', objectFit: 'contain' }}
    />
  );
}
