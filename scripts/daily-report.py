#!/usr/bin/env python3
"""Daily StatHead health + data digest.

Emits a Markdown report covering: scheduled-pipeline activity over the last
day, data-surface freshness (with staleness flags), the current model/version
snapshot, and KTC dynasty movers. Written for the daily-report.yml workflow,
which mails it and also drops it into the Actions job summary, but it runs
standalone too:

    python3 scripts/daily-report.py            # prints report to stdout
    python3 scripts/daily-report.py report.md  # also writes to a file

Pure stdlib + git — no third-party deps so it runs anywhere.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA = Path("public/data")
NOW = datetime.now(timezone.utc)


def git_last_commit(path: str):
    """(datetime, subject) of the last commit touching path, or (None, None)."""
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%cI\t%s", "--", path],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        if not out:
            return None, None
        iso, _, subject = out.partition("\t")
        return datetime.fromisoformat(iso), subject
    except Exception:
        return None, None


def age_days(dt):
    return None if dt is None else (NOW - dt).total_seconds() / 86400.0


def flag(dt, warn_days):
    """OK / STALE / MISSING marker for a freshness row."""
    a = age_days(dt)
    if a is None:
        return "❓ missing"
    if a > warn_days:
        return f"⚠️ {a:.1f}d"
    return f"✅ {a:.1f}d"


def load_json(name):
    try:
        return json.loads((DATA / name).read_text())
    except Exception:
        return None


def count_commits_since(hours, pattern):
    """How many commits whose subject contains `pattern` in the last `hours`."""
    since = (NOW - timedelta(hours=hours)).isoformat()
    try:
        out = subprocess.run(
            ["git", "log", f"--since={since}", "--format=%s"],
            capture_output=True, text=True, check=True,
        ).stdout
        return sum(1 for line in out.splitlines() if pattern.lower() in line.lower())
    except Exception:
        return 0


def section_pipeline():
    lines = ["## Pipeline activity (last 26h)", ""]
    jobs = [
        ("KTC snapshot (daily)", "Fetch KTC snapshot", 1),
        ("FantasyCalc snapshot (daily)", "Fetch FantasyCalc", 1),
        ("Data refresh (every 2h)", "Auto-commit caches", 1),
    ]
    lines.append("| Job | Commits | Status |")
    lines.append("|---|---|---|")
    for label, pat, expect in jobs:
        n = count_commits_since(26, pat)
        status = "✅ ran" if n >= expect else "⚠️ no commit in 26h"
        lines.append(f"| {label} | {n} | {status} |")
    lines.append("")
    return "\n".join(lines)


def section_freshness():
    rows = [
        # (label, path, warn_days)
        ("KTC rankings", "ktc_rankings_superflex.json", 2),
        ("FantasyCalc dynasty", "fantasycalc_dynasty_sf.json", 2),
        ("Feature matrix", "feature-matrix.json", 1),
        ("Feature store", "feature-store", 1),
        ("Score store", "score-store", 2),
        ("Player crosswalk", "player-crosswalk.json", 2),
        ("Roster 2026", "roster_2026.csv.gz", 14),
        ("Depth charts 2026", "depth_charts_2026.csv.gz", 14),
        ("CFBD college stats", "cfbd-college-stats.json", 45),
    ]
    lines = ["## Data freshness", "", "| Surface | Age | Last commit |", "|---|---|---|"]
    stale = []
    for label, path, warn in rows:
        dt, subj = git_last_commit(str(DATA / path))
        mark = flag(dt, warn)
        if mark.startswith("⚠️") or mark.startswith("❓"):
            stale.append(label)
        subj = (subj or "—")[:48]
        lines.append(f"| {label} | {mark} | {subj} |")
    lines.append("")
    if stale:
        lines.append(f"> ⚠️ **Stale:** {', '.join(stale)}")
        lines.append("")
    return "\n".join(lines), stale


def section_model_snapshot():
    lines = ["## Model snapshot", ""]
    manifest = load_json("score-store/manifest.json") or {}
    models = manifest.get("models", {})
    if models:
        parts = [f"{k} {v.get('version', '?')}" for k, v in models.items()]
        lines.append(f"- **Versions:** {', '.join(parts)}")
        lines.append(f"- **Score store updated:** {manifest.get('updatedAt', '?')}")
    fm = load_json("feature-matrix.json") or {}
    cp = fm.get("careerPredictions2026") or []
    rcm = fm.get("rookieCareerModels") or {}
    bt = sum(len((rcm.get(p) or {}).get("backtestRows") or []) for p in ("QB", "RB", "WR", "TE"))
    cw = load_json("player-crosswalk.json")
    cw_n = len(cw) if isinstance(cw, list) else (len(cw.get("players", [])) if isinstance(cw, dict) else "?")
    lines.append(f"- **2026 prospects scored:** {len(cp)}")
    lines.append(f"- **Backtest rookies:** {bt}")
    lines.append(f"- **Crosswalk players:** {cw_n}")
    # Tier distribution of 2026 prospects (sanity check the override is live)
    if cp:
        labels = {1: "Alpha", 2: "BlueChip", 3: "Starter", 4: "Contrib", 5: "Depth", 6: "Longshot"}
        dist = {}
        for p in cp:
            t = p.get("modelTier") or 0
            dist[t] = dist.get(t, 0) + 1
        parts = [f"{labels.get(t, t)}:{dist[t]}" for t in sorted(dist) if t]
        lines.append(f"- **2026 tier mix:** {', '.join(parts)}")
    lines.append("")
    return "\n".join(lines)


def section_ktc_movers():
    """Top KTC superflex risers/fallers over the most recent dated step."""
    try:
        hist = load_json("ktc_history.json") or []
        ranks = load_json("ktc_rankings_superflex.json") or []
        name_by_id = {str(r.get("playerID")): r for r in ranks}
        moves = []
        for rec in hist:
            vh = ((rec.get("superflex") or {}).get("valueHistory")) or []
            # De-dupe same-day points; need at least two distinct days.
            seen, series = set(), []
            for pt in vh:
                key = (pt.get("d"), pt.get("v"))
                if key in seen:
                    continue
                seen.add(key)
                series.append(pt)
            if len(series) < 2:
                continue
            prev, last = series[-2], series[-1]
            delta = (last.get("v") or 0) - (prev.get("v") or 0)
            if delta == 0:
                continue
            meta = name_by_id.get(str(rec.get("playerID")), {})
            moves.append((delta, meta.get("playerName", rec.get("playerID")),
                          meta.get("position", "?"), last.get("v")))
        if not moves:
            return ""
        moves.sort(reverse=True)
        risers = moves[:5]
        fallers = sorted([m for m in moves if m[0] < 0])[:5]
        lines = ["## KTC dynasty movers (superflex, 1-day)", ""]
        lines.append("**Risers**  ")
        for d, n, pos, v in risers:
            lines.append(f"- {n} ({pos}) +{d} → {v}")
        if fallers:
            lines.append("")
            lines.append("**Fallers**  ")
            for d, n, pos, v in fallers:
                lines.append(f"- {n} ({pos}) {d} → {v}")
        lines.append("")
        return "\n".join(lines)
    except Exception as e:
        return f"## KTC dynasty movers\n\n_(unavailable: {e})_\n"


def main():
    fresh_md, stale = section_freshness()
    headline = "✅ all surfaces fresh" if not stale else f"⚠️ {len(stale)} stale surface(s)"
    report = "\n".join([
        f"# StatHead Daily Report — {NOW:%Y-%m-%d}",
        "",
        f"_{headline} · generated {NOW:%Y-%m-%d %H:%M UTC}_",
        "",
        section_pipeline(),
        fresh_md,
        section_model_snapshot(),
        section_ktc_movers(),
    ])
    print(report)
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
