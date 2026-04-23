import { useMemo } from 'react';
import { useCrosswalk } from '../hooks/useCrosswalk';
import { lookupByNamePos, lookupByKey } from '../lib/playerLookup';
import { setPlayerHash } from '../lib/hashRoute';

interface Props {
  playerKey?: string | null;
  name?: string | null;
  position?: string | null;
  title?: string;
}

/** Renders a tiny "↗" link next to a player name that navigates to the
 *  shareable player detail page. Existing click behaviors on the name
 *  itself are preserved — this is a sibling icon, not a wrapper. */
export function PlayerLink({ playerKey, name, position, title }: Props) {
  const { index } = useCrosswalk();
  const resolvedKey = useMemo(() => {
    if (!index) return null;
    if (playerKey) {
      const rec = lookupByKey(index, playerKey);
      return rec?.player_key || null;
    }
    if (name) {
      const rec = lookupByNamePos(index, name, position ?? null);
      return rec?.player_key || null;
    }
    return null;
  }, [index, playerKey, name, position]);

  if (!resolvedKey) return null;
  const href = `#/player/${resolvedKey}`;
  return (
    <a
      href={href}
      title={title || 'View player detail'}
      onClick={(e) => {
        // Preserve cmd/ctrl-click opening in new tab; plain click stays in-app.
        if (e.metaKey || e.ctrlKey || e.button === 1) return;
        e.preventDefault();
        e.stopPropagation();
        setPlayerHash(resolvedKey);
      }}
      style={{
        marginLeft: 6,
        fontSize: 11,
        color: 'var(--text-muted)',
        textDecoration: 'none',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      ↗
    </a>
  );
}
