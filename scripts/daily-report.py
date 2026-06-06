#!/usr/bin/env python3
"""Daily StatHead health + data digest.

Covers scheduled-pipeline activity over the last day, data-surface freshness
(with staleness flags), the current model/version snapshot, roster changes vs
~24h ago, and KTC dynasty movers. Emits both Markdown (for the Actions job
summary) and styled HTML (for the email body).

    python3 scripts/daily-report.py                       # print Markdown
    python3 scripts/daily-report.py report.md report.html # also write files

Pure stdlib + git — no third-party deps so it runs anywhere.
"""

import csv
import gzip
import html as html_lib
import io
import json
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA = Path("public/data")
SEASON = 2026
NOW = datetime.now(timezone.utc)
POS_ORDER = {"QB": 0, "RB": 1, "WR": 2, "TE": 3}

# ── palette (inline styles — email clients strip <style> blocks) ──────
C_BG = "#f5f6f8"; C_CARD = "#ffffff"; C_BORDER = "#e5e7eb"
C_TEXT = "#111827"; C_MUTED = "#6b7280"; C_HEAD = "#374151"
C_GREEN = "#16a34a"; C_AMBER = "#d97706"; C_RED = "#dc2626"; C_BLUE = "#2563eb"


def esc(s):
    return html_lib.escape(str(s))


# ── git / data helpers ────────────────────────────────────────────────
def sh(args, binary=False):
    r = subprocess.run(args, capture_output=True, text=not binary)
    return r.stdout if r.returncode == 0 else None


def git_last_commit(path):
    out = sh(["git", "log", "-1", "--format=%cI\t%s", "--", path])
    if not out or not out.strip():
        return None, None
    iso, _, subject = out.strip().partition("\t")
    try:
        return datetime.fromisoformat(iso), subject
    except ValueError:
        return None, None


def age_days(dt):
    return None if dt is None else (NOW - dt).total_seconds() / 86400.0


def flag(dt, warn_days):
    a = age_days(dt)
    if a is None:
        return "missing", C_AMBER, "❓"
    if a > warn_days:
        return f"{a:.1f}d", C_AMBER, "⚠️"
    return f"{a:.1f}d", C_GREEN, "✅"


def load_json(name):
    try:
        return json.loads((DATA / name).read_text())
    except Exception:
        return None


def count_commits_since(hours, pattern):
    since = (NOW - timedelta(hours=hours)).isoformat()
    out = sh(["git", "log", f"--since={since}", "--format=%s"]) or ""
    return sum(1 for ln in out.splitlines() if pattern.lower() in ln.lower())


# ── roster diff ───────────────────────────────────────────────────────
def _parse_roster(raw_bytes):
    """gz bytes -> {key: (name, team, pos)} for fantasy positions only."""
    try:
        text = gzip.decompress(raw_bytes).decode("utf-8", "replace")
    except Exception:
        return {}
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        pos = (row.get("position") or "").upper()
        if pos not in POS_ORDER:
            continue
        name = row.get("full_name") or f"{row.get('first_name','')} {row.get('last_name','')}".strip()
        team = (row.get("team") or "").upper()
        key = row.get("gsis_id") or name.lower()
        if not key:
            continue
        out[key] = (name, team, pos)
    return out


def roster_changes(hours=24):
    """(added, removed, moved) lists of fantasy-position roster changes vs ~hours ago."""
    path = f"public/data/roster_{SEASON}.csv.gz"
    new_raw = (DATA / f"roster_{SEASON}.csv.gz").read_bytes() if (DATA / f"roster_{SEASON}.csv.gz").exists() else None
    rev = sh(["git", "log", f"--until={hours} hours ago", "-1", "--format=%H", "--", path])
    rev = rev.strip() if rev else None
    old_raw = sh(["git", "show", f"{rev}:{path}"], binary=True) if rev else None
    if new_raw is None or old_raw is None:
        return None
    new, old = _parse_roster(new_raw), _parse_roster(old_raw)
    if not new or not old:
        return None
    added, removed, moved = [], [], []
    for k, (n, t, p) in new.items():
        if k not in old:
            added.append((p, n, t))
        elif old[k][1] != t:
            moved.append((p, n, old[k][1], t))
    for k, (n, t, p) in old.items():
        if k not in new:
            removed.append((p, n, t))
    skey = lambda x: (POS_ORDER.get(x[0], 9), x[1])
    return sorted(added, key=skey), sorted(removed, key=skey), sorted(moved, key=skey)


# ── section builders → (markdown, html) ───────────────────────────────
def _card(title, inner_html):
    return (
        f'<div style="background:{C_CARD};border:1px solid {C_BORDER};border-radius:8px;'
        f'padding:16px 18px;margin:0 0 14px;">'
        f'<h2 style="margin:0 0 10px;font-size:15px;color:{C_TEXT};">{esc(title)}</h2>'
        f'{inner_html}</div>'
    )


def _html_table(headers, rows):
    th = "".join(
        f'<th style="text-align:left;padding:6px 10px;font-size:12px;color:{C_MUTED};'
        f'border-bottom:1px solid {C_BORDER};font-weight:600;">{esc(h)}</th>' for h in headers
    )
    trs = []
    for row in rows:
        tds = []
        for cell in row:
            text, color = (cell if isinstance(cell, tuple) else (cell, C_TEXT))
            tds.append(
                f'<td style="padding:6px 10px;font-size:13px;color:{color};'
                f'border-bottom:1px solid #f1f2f4;">{esc(text)}</td>'
            )
        trs.append(f"<tr>{''.join(tds)}</tr>")
    return (
        f'<table style="width:100%;border-collapse:collapse;">'
        f"<thead><tr>{th}</tr></thead><tbody>{''.join(trs)}</tbody></table>"
    )


def section_pipeline():
    jobs = [
        ("KTC snapshot (daily)", "Fetch KTC snapshot"),
        ("FantasyCalc snapshot (daily)", "Fetch FantasyCalc"),
        ("Data refresh (every 2h)", "Auto-commit caches"),
    ]
    md = ["## Pipeline activity (last 26h)", "", "| Job | Commits | Status |", "|---|---|---|"]
    rows = []
    for label, pat in jobs:
        n = count_commits_since(26, pat)
        ok = n >= 1
        md.append(f"| {label} | {n} | {'✅ ran' if ok else '⚠️ no commit in 26h'} |")
        rows.append([label, str(n), (("ran" if ok else "no commit in 26h"), C_GREEN if ok else C_AMBER)])
    return "\n".join(md), _card("Pipeline activity (last 26h)", _html_table(["Job", "Commits", "Status"], rows))


def section_freshness():
    surfaces = [
        ("KTC rankings", "ktc_rankings_superflex.json", 2),
        ("FantasyCalc dynasty", "fantasycalc_dynasty_sf.json", 2),
        ("Feature matrix", "feature-matrix.json", 1),
        ("Feature store", "feature-store", 1),
        ("Score store", "score-store", 2),
        ("Player crosswalk", "player-crosswalk.json", 2),
        (f"Roster {SEASON}", f"roster_{SEASON}.csv.gz", 14),
        (f"Depth charts {SEASON}", f"depth_charts_{SEASON}.csv.gz", 14),
        ("CFBD college stats", "cfbd-college-stats.json", 45),
    ]
    md = ["## Data freshness", "", "| Surface | Age | Last commit |", "|---|---|---|"]
    rows, stale = [], []
    for label, path, warn in surfaces:
        dt, subj = git_last_commit(str(DATA / path))
        age, color, icon = flag(dt, warn)
        if icon != "✅":
            stale.append(label)
        subj = (subj or "—")[:46]
        md.append(f"| {label} | {icon} {age} | {subj} |")
        rows.append([label, (f"{icon} {age}", color), (subj, C_MUTED)])
    return "\n".join(md), _card("Data freshness", _html_table(["Surface", "Age", "Last commit"], rows)), stale


def section_roster():
    changes = roster_changes(24)
    if changes is None:
        return "## Roster changes\n\n_(no baseline to compare)_\n", _card("Roster changes (last 24h)", f'<p style="color:{C_MUTED};font-size:13px;margin:0;">No baseline to compare.</p>')
    added, removed, moved = changes
    if not (added or removed or moved):
        return "## Roster changes (last 24h)\n\n_No fantasy-position roster changes._\n", _card("Roster changes (last 24h)", f'<p style="color:{C_MUTED};font-size:13px;margin:0;">No fantasy-position roster changes.</p>')

    CAP = 25
    md = [f"## Roster changes (last 24h) — +{len(added)} / −{len(removed)} / ⇄{len(moved)}", ""]
    html_parts = [
        f'<p style="margin:0 0 10px;font-size:13px;color:{C_MUTED};">'
        f'<b style="color:{C_GREEN};">+{len(added)} added</b> · '
        f'<b style="color:{C_RED};">−{len(removed)} removed</b> · '
        f'<b style="color:{C_BLUE};">⇄{len(moved)} team change</b> '
        f'(QB/RB/WR/TE)</p>'
    ]

    def block(title, items, fmt_md, fmt_html, color):
        if not items:
            return
        md.append(f"**{title} ({len(items)})**  ")
        for it in items[:CAP]:
            md.append(f"- {fmt_md(it)}")
        if len(items) > CAP:
            md.append(f"- …and {len(items) - CAP} more")
        md.append("")
        lis = "".join(f'<li style="margin:2px 0;">{fmt_html(it)}</li>' for it in items[:CAP])
        if len(items) > CAP:
            lis += f'<li style="margin:2px 0;color:{C_MUTED};">…and {len(items) - CAP} more</li>'
        html_parts.append(
            f'<div style="margin:8px 0 4px;font-size:13px;color:{color};font-weight:600;">{esc(title)} ({len(items)})</div>'
            f'<ul style="margin:0 0 6px;padding-left:18px;font-size:13px;color:{C_TEXT};">{lis}</ul>'
        )

    block("Added", added, lambda x: f"{x[1]} ({x[0]}) → {x[2]}", lambda x: f"{esc(x[1])} <span style='color:{C_MUTED};'>({esc(x[0])})</span> → <b>{esc(x[2])}</b>", C_GREEN)
    block("Removed", removed, lambda x: f"{x[1]} ({x[0]}) — was {x[2]}", lambda x: f"{esc(x[1])} <span style='color:{C_MUTED};'>({esc(x[0])})</span> — was {esc(x[2])}", C_RED)
    block("Team changes", moved, lambda x: f"{x[1]} ({x[0]}) {x[2]} → {x[3]}", lambda x: f"{esc(x[1])} <span style='color:{C_MUTED};'>({esc(x[0])})</span> {esc(x[2])} → <b>{esc(x[3])}</b>", C_BLUE)

    return "\n".join(md), _card("Roster changes (last 24h)", "".join(html_parts))


def section_model_snapshot():
    manifest = load_json("score-store/manifest.json") or {}
    models = manifest.get("models", {})
    fm = load_json("feature-matrix.json") or {}
    cp = fm.get("careerPredictions2026") or []
    rcm = fm.get("rookieCareerModels") or {}
    bt = sum(len((rcm.get(p) or {}).get("backtestRows") or []) for p in ("QB", "RB", "WR", "TE"))
    cw = load_json("player-crosswalk.json")
    cw_n = len(cw) if isinstance(cw, list) else (len(cw.get("players", [])) if isinstance(cw, dict) else "?")

    versions = ", ".join(f"{k} {v.get('version', '?')}" for k, v in models.items()) or "—"
    labels = {1: "Alpha", 2: "BlueChip", 3: "Starter", 4: "Contrib", 5: "Depth", 6: "Longshot"}
    dist = {}
    for p in cp:
        t = p.get("modelTier") or 0
        if t:
            dist[t] = dist.get(t, 0) + 1
    mix = ", ".join(f"{labels.get(t, t)}:{dist[t]}" for t in sorted(dist)) or "—"

    md = ["## Model snapshot", "",
          f"- **Versions:** {versions}",
          f"- **Score store updated:** {manifest.get('updatedAt', '?')}",
          f"- **2026 prospects scored:** {len(cp)}",
          f"- **Backtest rookies:** {bt}",
          f"- **Crosswalk players:** {cw_n}",
          f"- **2026 tier mix:** {mix}", ""]
    rows = [
        ["Model versions", (versions, C_TEXT)],
        ["Score store updated", (manifest.get("updatedAt", "?"), C_MUTED)],
        ["2026 prospects scored", str(len(cp))],
        ["Backtest rookies", str(bt)],
        ["Crosswalk players", str(cw_n)],
        ["2026 tier mix", (mix, C_TEXT)],
    ]
    return "\n".join(md), _card("Model snapshot", _html_table(["Metric", "Value"], rows))


def section_ktc_movers():
    try:
        hist = load_json("ktc_history.json") or []
        ranks = load_json("ktc_rankings_superflex.json") or []
        name_by_id = {str(r.get("playerID")): r for r in ranks}
        moves = []
        for rec in hist:
            vh = ((rec.get("superflex") or {}).get("valueHistory")) or []
            seen, series = set(), []
            for pt in vh:
                k = (pt.get("d"), pt.get("v"))
                if k in seen:
                    continue
                seen.add(k)
                series.append(pt)
            if len(series) < 2:
                continue
            delta = (series[-1].get("v") or 0) - (series[-2].get("v") or 0)
            if delta == 0:
                continue
            meta = name_by_id.get(str(rec.get("playerID")), {})
            moves.append((delta, meta.get("playerName", rec.get("playerID")), meta.get("position", "?"), series[-1].get("v")))
        if not moves:
            return "", ""
        moves.sort(reverse=True)
        risers = moves[:5]
        fallers = sorted([m for m in moves if m[0] < 0])[:5]

        md = ["## KTC dynasty movers (superflex, 1-day)", "", "**Risers**  "]
        for d, n, p, v in risers:
            md.append(f"- {n} ({p}) +{d} → {v}")
        if fallers:
            md += ["", "**Fallers**  "]
            for d, n, p, v in fallers:
                md.append(f"- {n} ({p}) {d} → {v}")
        md.append("")

        def ul(items, color, sign):
            lis = "".join(
                f'<li style="margin:2px 0;">{esc(n)} <span style="color:{C_MUTED};">({esc(p)})</span> '
                f'<b style="color:{color};">{sign}{d}</b> → {esc(v)}</li>' for d, n, p, v in items
            )
            return f'<ul style="margin:0 0 6px;padding-left:18px;font-size:13px;color:{C_TEXT};">{lis}</ul>'

        inner = f'<div style="font-size:13px;color:{C_GREEN};font-weight:600;margin:0 0 2px;">Risers</div>' + ul(risers, C_GREEN, "+")
        if fallers:
            inner += f'<div style="font-size:13px;color:{C_RED};font-weight:600;margin:8px 0 2px;">Fallers</div>' + ul(fallers, C_RED, "")
        return "\n".join(md), _card("KTC dynasty movers (superflex, 1-day)", inner)
    except Exception as e:
        return f"## KTC dynasty movers\n\n_(unavailable: {e})_\n", ""


# ── assemble ──────────────────────────────────────────────────────────
def main():
    pl_md, pl_html = section_pipeline()
    fr_md, fr_html, stale = section_freshness()
    ro_md, ro_html = section_roster()
    ms_md, ms_html = section_model_snapshot()
    kt_md, kt_html = section_ktc_movers()

    headline = "✅ all surfaces fresh" if not stale else f"⚠️ {len(stale)} stale surface(s): {', '.join(stale)}"
    badge_color = C_GREEN if not stale else C_AMBER

    md = "\n".join([
        f"# StatHead Daily Report — {NOW:%Y-%m-%d}", "",
        f"_{headline} · generated {NOW:%Y-%m-%d %H:%M UTC}_", "",
        pl_md, fr_md, ro_md, ms_md, kt_md,
    ])
    print(md)

    html_doc = (
        f'<body style="margin:0;padding:18px;background:{C_BG};">'
        f'<div style="max-width:660px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'
        f'\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">'
        f'<h1 style="margin:0 0 2px;font-size:20px;color:{C_TEXT};">StatHead Daily Report</h1>'
        f'<div style="font-size:13px;color:{C_MUTED};margin:0 0 4px;">{NOW:%A, %B %d, %Y} · {NOW:%H:%M UTC}</div>'
        f'<div style="display:inline-block;font-size:12px;font-weight:600;color:#fff;background:{badge_color};'
        f'border-radius:12px;padding:3px 10px;margin:0 0 14px;">{esc(headline)}</div>'
        f'{pl_html}{fr_html}{ro_html}{ms_html}{kt_html}'
        f'<div style="font-size:11px;color:{C_MUTED};margin-top:6px;">Generated by scripts/daily-report.py</div>'
        f'</div></body>'
    )

    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(md)
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(html_doc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
