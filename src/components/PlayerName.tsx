import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useCrosswalk } from '../hooks/useCrosswalk';
import { lookupByNamePos, lookupByKey, lookupBySleeperId } from '../lib/playerLookup';
import { setPlayerHash } from '../lib/hashRoute';

interface Props {
  playerKey?: string | null;
  sleeperId?: string | null;
  name: string;
  position?: string | null;
  className?: string;
  style?: CSSProperties;
}

/** A player's name rendered as an in-app link to the shareable player-detail
 *  page. Resolves the player via the crosswalk (by key, Sleeper id, or
 *  name+position) and falls back to plain text when it can't be resolved.
 *  Inherits color; underlines on hover. */
export function PlayerName({ playerKey, sleeperId, name, position, className, style }: Props) {
  const { index } = useCrosswalk();
  const resolvedKey = useMemo(() => {
    if (!index) return null;
    if (playerKey) { const r = lookupByKey(index, playerKey); if (r) return r.player_key; }
    if (sleeperId) { const r = lookupBySleeperId(index, sleeperId); if (r) return r.player_key; }
    if (name) { const r = lookupByNamePos(index, name, position ?? null); return r?.player_key || null; }
    return null;
  }, [index, playerKey, sleeperId, name, position]);

  if (!resolvedKey) return <span className={className} style={style}>{name}</span>;

  return (
    <a
      href={`#/player/${resolvedKey}`}
      className={className}
      title="View player detail"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.button === 1) return; // allow open-in-new-tab
        e.preventDefault();
        e.stopPropagation();
        setPlayerHash(resolvedKey);
      }}
      onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
      onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
      style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer', ...style }}
    >
      {name}
    </a>
  );
}
