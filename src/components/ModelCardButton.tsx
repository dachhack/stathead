import type { CSSProperties } from 'react';

interface Props {
  onClick: () => void;
  title?: string;
}

/** A tiny "📊" button rendered next to a player name that opens the
 *  model-detail PlayerCard (model features, boom/bust inputs, threshold
 *  probabilities, combine + stat tables). Sibling to PlayerLink's "↗", which
 *  navigates to the shared player-detail page — together they let the name
 *  itself link to the shared page while the model breakdown stays one click
 *  away. */
export function ModelCardButton({ onClick, title }: Props) {
  return (
    <button
      type="button"
      title={title || 'Model card'}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={style}
    >
      📊
    </button>
  );
}

const style: CSSProperties = {
  marginLeft: 6,
  fontSize: 11,
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--text-muted)',
  cursor: 'pointer',
  userSelect: 'none',
  lineHeight: 1,
  verticalAlign: 'baseline',
};
