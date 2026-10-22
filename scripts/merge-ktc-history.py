#!/usr/bin/env python3
"""Keep a long KTC value history by merging each day's rolling snapshot.

KTC's history endpoint returns about 180 days per player, so
public/data/ktc_history.json (what scripts/fetch-ktc.cjs writes) is a rolling
window that forgets a day for every day it gains. The dynasty forecast models
(scripts/train_ktc_timeseries.py) learn from how values moved over the
following 7-120 days, so a 180-day window leaves them nothing in-season to
learn from once the season is more than a few months old. This script keeps
every day ever seen.

    public/data/ktc_history_long.json   same schema as ktc_history.json
                                        (playerID, oneQB / superflex
                                        valueHistory of {d, v}), all dates

Each run merges one or more snapshots into the long file: a date already there
is overwritten by the newest snapshot that has it, a date not there is added,
and nothing is ever dropped. Run daily after fetch-ktc.cjs
(.github/workflows/fetch-ktc-snapshot.yml); the first file was backfilled from
the snapshots committed to git since April 2026 with --from-git.

Usage:
    python3 scripts/merge-ktc-history.py [--long=public/data/ktc_history_long.json]
                                         [snapshot.json ...]
        default snapshot: public/data/ktc_history.json
    python3 scripts/merge-ktc-history.py --from-git [--long=...]
        merge every committed version of public/data/ktc_history.json, oldest
        first, then the working copy

This is third-party input data (docs/third-party-data-policy.md): it feeds
StatHead's models and is never shown raw.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import date
from pathlib import Path

DEFAULT_LONG = Path('public/data/ktc_history_long.json')
DEFAULT_SNAPSHOT = Path('public/data/ktc_history.json')
FORMATS = ('oneQB', 'superflex')


def load_long(path: Path) -> dict[int, dict[str, dict[str, int]]]:
    """playerID -> format -> {date: value}."""
    out: dict[int, dict[str, dict[str, int]]] = {}
    if not path.exists():
        return out
    with open(path) as f:
        for entry in json.load(f):
            merge_entry(out, entry)
    return out


def merge_entry(store, entry) -> int:
    pid = entry.get('playerID')
    if not isinstance(pid, int) or pid <= 0:
        return 0
    added = 0
    per_pid = store.setdefault(pid, {})
    for fmt in FORMATS:
        hist = (entry.get(fmt) or {}).get('valueHistory') or []
        per_fmt = per_pid.setdefault(fmt, {})
        for point in hist:
            d, v = point.get('d'), point.get('v')
            if not isinstance(d, str) or len(d) != 10 or v is None:
                continue
            try:
                date.fromisoformat(d)
                v = int(round(float(v)))
            except (TypeError, ValueError):
                continue
            if d not in per_fmt:
                added += 1
            per_fmt[d] = v
    return added


def merge_snapshot(store, raw) -> int:
    data = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
    if not isinstance(data, list):
        raise ValueError('snapshot is not a list of player histories')
    return sum(merge_entry(store, e) for e in data)


def to_json(store) -> list[dict]:
    out = []
    for pid in sorted(store):
        entry = {'playerID': pid}
        for fmt in FORMATS:
            points = store[pid].get(fmt, {})
            entry[fmt] = {'valueHistory': [{'d': d, 'v': points[d]}
                                           for d in sorted(points)]}
        out.append(entry)
    return out


def span(store) -> tuple[str | None, str | None, int]:
    dates = [d for p in store.values() for fmt in p.values() for d in fmt]
    return (min(dates), max(dates), len(dates)) if dates else (None, None, 0)


def git_versions(path: Path) -> list[str]:
    """Commits that touched `path`, oldest first."""
    out = subprocess.run(
        ['git', 'log', '--format=%H', '--reverse', '--', str(path)],
        check=True, capture_output=True, text=True)
    return [c for c in out.stdout.split() if c]


def main(argv: list[str]) -> int:
    long_path = DEFAULT_LONG
    from_git = False
    snapshots: list[Path] = []
    for a in argv:
        if a.startswith('--long='):
            long_path = Path(a.split('=', 1)[1])
        elif a == '--from-git':
            from_git = True
        elif a.startswith('--'):
            print(f'unknown option {a}', file=sys.stderr)
            return 2
        else:
            snapshots.append(Path(a))
    if not snapshots:
        snapshots = [DEFAULT_SNAPSHOT]

    store = load_long(long_path)
    lo, hi, n = span(store)
    print(f'{long_path}: {len(store)} players, {n} points'
          + (f', {lo} -> {hi}' if lo else ' (new)'))

    if from_git:
        commits = git_versions(DEFAULT_SNAPSHOT)
        print(f'merging {len(commits)} committed versions of {DEFAULT_SNAPSHOT}')
        for c in commits:
            raw = subprocess.run(
                ['git', 'show', f'{c}:{DEFAULT_SNAPSHOT}'],
                check=True, capture_output=True).stdout
            try:
                added = merge_snapshot(store, raw)
            except ValueError as e:
                print(f'  {c[:8]}: skipped ({e})')
                continue
            if added:
                print(f'  {c[:8]}: +{added} points')

    for snap in snapshots:
        if not snap.exists():
            print(f'  {snap}: missing, skipped')
            continue
        with open(snap) as f:
            added = merge_snapshot(store, f.read())
        print(f'  {snap}: +{added} points')

    lo, hi, n = span(store)
    long_path.parent.mkdir(parents=True, exist_ok=True)
    with open(long_path, 'w') as f:
        json.dump(to_json(store), f, separators=(',', ':'))
    print(f'wrote {long_path}: {len(store)} players, {n} points, {lo} -> {hi}, '
          f'{long_path.stat().st_size / 1e6:.1f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
