#!/usr/bin/env python3
"""Publish a trade crawl's aggregate metrics for the daily report.

Run by the crawl workflows after each run. Reads <dir>/run-metrics.json (the
crawler's counts) and <dir>/build-summary.json (the database builder's counts
for this run's shards), appends one record to metrics.json on the crawl's
release and re-uploads it. Unlike the crawl data, metrics.json is not
encrypted: it holds only counts (no league, manager or transaction ids, no
names). scripts/daily-report.py reads it.

Usage: python3 scripts/publish-crawl-metrics.py <dir> <release tag>
Env: GH_TOKEN (contents: write), GITHUB_RUN_ID, GITHUB_SERVER_URL, GITHUB_REPOSITORY.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

KEEP = 400   # records: ~100 days of four runs a day


def load(p: Path):
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def main() -> None:
    d, tag = Path(sys.argv[1]), sys.argv[2]
    run = load(d / 'run-metrics.json')
    build = load(d / 'build-summary.json')
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{run_id}"
    record = {
        'runId': run_id, 'url': url,
        'publishedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        # No run-metrics means the crawler never finished (cancelled, crashed).
        'completed': run is not None,
        **(run or {}),
        'build': build,
    }
    with tempfile.TemporaryDirectory() as tmp:
        got = subprocess.run(['gh', 'release', 'download', tag, '-p', 'metrics.json', '-D', tmp],
                             capture_output=True, text=True)
        doc = load(Path(tmp) / 'metrics.json') if got.returncode == 0 else None
        doc = doc if isinstance(doc, dict) else {'tag': tag, 'runs': []}
        doc['runs'] = [r for r in doc.get('runs', []) if r.get('runId') != run_id] + [record]
        doc['runs'] = doc['runs'][-KEEP:]
        doc['updatedAt'] = record['publishedAt']
        out = Path(tmp) / 'metrics.json'
        out.write_text(json.dumps(doc, indent=1) + '\n')
        subprocess.run(['gh', 'release', 'upload', tag, str(out), '--clobber'], check=True)
    print(f'metrics: {len(doc["runs"])} runs on {tag}; this run {json.dumps(record.get("run"))}')


if __name__ == '__main__':
    main()
