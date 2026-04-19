#!/usr/bin/env python3
"""Extract NFL prospect features from Matt Waldman's 2026 RSP cached text.

Each profile begins with a line like "QB Fernando Mendoza RSP Scouting Profile"
followed by:
    RSP Ranking: QB1
    Jersey No. 15
    Height/Weight: 6'5" / 236 School: Indiana / California
    Comparison Spectrum: Andrew Luck/X/Justin Herbert - Drake Maye - - Blaine Gabbert
    Depth of Talent Score: 85.575 = Starter: ...

then accuracy charting and prose evaluation.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter

CONTEXT_HASH = "d52f0eac"
INPUT_PATH = "/Users/matthewporritt/stathead/pdfs/.cache/2026_Rookie_Scouting_Portfolio.text.txt"
OUTPUT_PATH = f"/Users/matthewporritt/stathead/pdfs/.cache/2026_Rookie_Scouting_Portfolio.{CONTEXT_HASH}.features.json"

INCLUDE_POSITIONS = {"QB", "RB", "WR", "TE"}

PROFILE_HEADER_RE = re.compile(r"^(QB|RB|WR|TE)\s+(.+?)\s+RSP\s+Scouting\s+Profile\s*$")

TIER_FROM_DOT = {
    "Franchise": 1,
    "Starter": 1,
    "Rotational Starter": 2,
    "Contributor": 3,
    "Reserve": 5,
    "Developmental": 7,
    "Street": None,
}


def find_profiles(lines):
    starts = []
    headers = []
    for i, line in enumerate(lines):
        m = PROFILE_HEADER_RE.match(line.strip())
        if m:
            starts.append(i)
            headers.append((m.group(1), m.group(2).strip()))
    starts.append(len(lines))
    return starts, headers


def parse_comparison_spectrum(raw):
    """Parse "Andrew Luck/X/Justin Herbert - Drake Maye - - Blaine Gabbert"."""
    if not raw:
        return []
    # Replace various dashes with a uniform separator
    cleaned = re.sub(r"\s+[-\u2013\u2014]+\s+", " | ", raw)
    # Split on slashes (the X marks the prospect's place)
    pieces = re.split(r"[/|]", cleaned)
    comps = []
    for p in pieces:
        p = p.strip().strip("-").strip()
        if not p:
            continue
        if p.upper() == "X" or p.lower() in {"x", "the prospect"}:
            continue
        # Filter to plausible NFL names (2+ words, capitalized)
        if len(p.split()) < 2:
            continue
        if not re.match(r"^[A-Z]", p):
            continue
        comps.append(p)
    # Dedupe preserving order
    seen = set()
    result = []
    for c in comps:
        if c not in seen:
            seen.add(c)
            result.append(c)
    return result[:6]


def parse_profile(profile_lines):
    text = "\n".join(profile_lines)

    # Header line (already used to find this profile)
    pos = None
    name = None
    for line in profile_lines[:3]:
        m = PROFILE_HEADER_RE.match(line.strip())
        if m:
            pos = m.group(1)
            name = m.group(2).strip()
            break

    if pos is None or name is None:
        return None

    # RSP Ranking
    rank_position = None
    rm = re.search(r"RSP\s+Ranking:\s*(QB|RB|WR|TE)?\s*(\d+)", text)
    if rm:
        try:
            rank_position = int(rm.group(2))
        except ValueError:
            rank_position = None

    # Height/Weight + School
    athletic_pieces = []
    school = None
    hw_m = re.search(
        r"Height\s*/?\s*Weight\s*:?\s*([\d'\u2019\" ]+)\s*[/]\s*(\d+)\s*(?:School\s*:?\s*([^\n]+))?",
        text,
    )
    if hw_m:
        athletic_pieces.append(f"{hw_m.group(1).strip()} / {hw_m.group(2)}")
        if hw_m.group(3):
            school = hw_m.group(3).split("/")[0].strip()
    else:
        # Fall back: search for "School: X"
        sm = re.search(r"School:\s*([^\n]+)", text)
        if sm:
            school = sm.group(1).split("/")[0].strip()

    # Comparison Spectrum
    cs_m = re.search(r"Comparison\s+Spectrum:\s*([^\n]+)", text)
    comps_raw = cs_m.group(1).strip() if cs_m else ""
    comps = parse_comparison_spectrum(comps_raw)

    # Depth of Talent Score and tier
    tier = None
    projected_round = None
    dot_score = None
    dot_m = re.search(
        r"Depth\s+of\s+Talent\s+Score:\s*([\d.]+)\s*=\s*([A-Za-z][A-Za-z ]+?)\s*[:.]",
        text,
    )
    if dot_m:
        try:
            dot_score = float(dot_m.group(1))
        except ValueError:
            dot_score = None
        tier_label = dot_m.group(2).strip()
        tier = f"{tier_label} ({dot_score})" if dot_score else tier_label
        projected_round = TIER_FROM_DOT.get(tier_label)

    if dot_score is not None:
        athletic_pieces.append(f"DOT {dot_score}")

    # Strengths / Weaknesses heuristic from prose
    # Find prose body — text after "Depth of Talent Score" line
    prose_idx = text.find("Depth of Talent Score")
    prose = text[prose_idx:] if prose_idx >= 0 else text
    # Drop accuracy table noise — lines with %
    prose_lines = [l for l in prose.split("\n") if "%" not in l and not re.match(r"^[\d.\s]+$", l.strip())]
    prose = " ".join(prose_lines)
    prose = re.sub(r"=== PAGE \d+ ===", "", prose)
    prose = re.sub(r"\s+", " ", prose).strip()

    sentences = re.split(r"(?<=[.!?])\s+", prose)
    strengths = []
    weaknesses = []
    red_flags = []
    pos_signals = ["impressive", "elite", "best", "rare", "outstanding", "strong", "excellent", "premier", "explosive", "high-end", "good"]
    neg_signals = ["concern", "issue", "downside", "shortcoming", "risk", "lack", "limited", "struggle", "underperform", "questionable", "worry", "flaw", "needs to", "weakness", "inconsistent", "tight"]
    inj_signals = ["injur", "durability", "missed games", "missed multiple", "soft-tissue", "knee", "shoulder", "hamstring", "ankle", "concuss", "surgery", "torn", "hip"]

    for sent in sentences:
        s = sent.strip()
        wc = len(s.split())
        if wc < 4 or wc > 28:
            continue
        sl = s.lower()
        if any(k in sl for k in inj_signals):
            phrase = re.sub(r"\s+", " ", s).strip(" .,:;").strip()
            if 3 <= len(phrase.split()) <= 15:
                red_flags.append(phrase)
        elif any(k in sl for k in neg_signals):
            phrase = re.sub(r"\s+", " ", s).strip(" .,:;").strip()
            if 3 <= len(phrase.split()) <= 15:
                weaknesses.append(phrase)
        elif any(k in sl for k in pos_signals):
            phrase = re.sub(r"\s+", " ", s).strip(" .,:;").strip()
            if 3 <= len(phrase.split()) <= 15:
                strengths.append(phrase)

    strengths = strengths[:5]
    weaknesses = weaknesses[:5]
    red_flags = red_flags[:3]

    # Summary: first non-table sentence after the DOT line, or last sentence
    summary = ""
    if sentences:
        clean = [s.strip() for s in sentences if s.strip() and len(s.split()) > 5]
        if clean:
            summary = clean[0] if len(clean[0].split()) <= 50 else clean[0].split(".")[0]
            if len(summary) > 350:
                summary = summary[:350].rstrip() + "..."

    has_data = bool(strengths or weaknesses or summary)
    confidence = "high" if (strengths and weaknesses and summary) else ("medium" if has_data else "low")

    return {
        "player_name": name,
        "position": pos,
        "college": school,
        "rank_overall": None,
        "rank_position": rank_position,
        "tier": tier,
        "projected_round": projected_round,
        "comps": comps,
        "strengths": strengths,
        "weaknesses": weaknesses,
        "red_flags": red_flags,
        "athletic_notes": "; ".join(athletic_pieces) if athletic_pieces else None,
        "summary": summary,
        "confidence": confidence,
        "college_stats": [],
        "route_profile": None,
    }


def main():
    with open(INPUT_PATH, "r", encoding="utf-8") as f:
        lines = f.readlines()

    starts, headers = find_profiles(lines)
    records = []
    for k in range(len(starts) - 1):
        prof_lines = lines[starts[k]:starts[k + 1]]
        rec = parse_profile(prof_lines)
        if rec is None:
            continue
        if rec["position"] not in INCLUDE_POSITIONS:
            continue
        records.append(rec)

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    pos_counts = Counter(r["position"] for r in records)
    conf_counts = Counter(r["confidence"] for r in records)
    print(f"Total profiles: {len(records)}")
    print(f"Position breakdown: {dict(sorted(pos_counts.items()))}")
    print(f"Confidence breakdown: {dict(sorted(conf_counts.items(), key=lambda kv: kv[0] or ''))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
