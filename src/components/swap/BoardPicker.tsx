/**
 * BoardPicker — pick trade pieces off the whole dynasty board (no league):
 * a search box over AssetColumn's position-filtered list. The board is a
 * few hundred priced players plus the generic pick rows, so the list shows
 * the selected pieces first, then the search hits, capped.
 */

import { useMemo, useState } from 'react';
import type { FinisherAsset } from '../../lib/tradeFinisher';
import { AssetColumn } from './OfferParts';

const MAX_SHOWN = 60;

export function BoardPicker({ title, color, board, selected, onToggle }: {
  title: string; color: string; board: FinisherAsset[]; selected: string[]; onToggle: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('ALL');
  const shown = useMemo(() => {
    const sel = new Set(selected);
    const needle = q.trim().toLowerCase();
    const chosen = board.filter((a) => sel.has(a.id));
    const rest = board.filter((a) => !sel.has(a.id) && (!needle || a.name.toLowerCase().includes(needle)));
    return [...chosen, ...rest.slice(0, MAX_SHOWN)];
  }, [board, selected, q]);
  return (
    <div style={{ minWidth: 0 }}>
      <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the board…"
        style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, marginBottom: 6 }} />
      <AssetColumn title={title} color={color} assets={shown} selected={selected} filter={filter} setFilter={setFilter} onToggle={onToggle} />
    </div>
  );
}
