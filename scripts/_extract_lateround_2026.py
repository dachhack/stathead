#!/usr/bin/env python3
"""Extract NFL prospect features from the Late-Round 2026 Prospect Guide cache.

Each profile starts with "Written By: ..." and has structure:

    Written By: JJ Zachariason
    92.2
    Jordyn Tyson • WR
    ZAP Score
    ARIZONA STATE LEGENDARY PERFORMER Low Risk Neutral High Risk
    Draft Capital Δ
    Height: 6'2 Weight: 203 NFL Team: TBD
    Statistical Comps: CeeDee Lamb • Marvin Harrison Jr. • Corey Davis
    <prose body>
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter

CONTEXT_HASH = "d52f0eac"
INPUT_PATH = "/Users/matthewporritt/stathead/pdfs/.cache/LateRoundProspectGuide26_PreDraft.text.txt"
OUTPUT_PATH = f"/Users/matthewporritt/stathead/pdfs/.cache/LateRoundProspectGuide26_PreDraft.{CONTEXT_HASH}.features.json"

INCLUDE_POSITIONS = {"QB", "RB", "WR", "TE"}

TIER_LABELS = [
    "LEGENDARY PERFORMER",
    "ELITE PRODUCER",
    "WEEKLY STARTER",
    "FLEX PLAY",
    "BENCHWARMER",
    "WAIVER WIRE ADD",
    "DART THROW",
    "FUTURE LATE-ROUND TARGET",
    "FUTURE STARTER",
    "FUTURE STUD",
]

ROUND_KEYWORDS = {
    1: ["round 1", "first round", "round-1", "top-10", "top 10", "top-15", "top-20", "top-32"],
    2: ["round 2", "second round", "day 2", "round-2"],
    3: ["round 3"],
    4: ["round 4", "day 3"],
    5: ["round 5"],
    6: ["round 6"],
    7: ["round 7"],
}


def find_profiles(lines):
    starts = []
    for i, line in enumerate(lines):
        if line.strip().startswith("Written By:"):
            starts.append(i)
    starts.append(len(lines))
    return starts


def parse_profile(profile_lines):
    text = "\n".join(profile_lines)

    # ZAP Score: a numeric line like "92.2" right after "Written By"
    zap_score = None
    for line in profile_lines[:5]:
        m = re.fullmatch(r"\s*(\d+\.\d+)\s*", line)
        if m:
            zap_score = float(m.group(1))
            break

    # Player name + position: "Jordyn Tyson • WR"
    player_name = None
    position = None
    for line in profile_lines[:8]:
        m = re.match(r"^([A-Za-z][A-Za-z .'\u2019\-]+?)\s*[•·]\s*(QB|RB|WR|TE|K|P|ATH)\s*$", line.strip())
        if m:
            player_name = m.group(1).strip()
            position = m.group(2).strip()
            break

    if player_name is None or position is None:
        return None

    # SCHOOL TIER label: line of all caps
    school = None
    tier = None
    for line in profile_lines[:12]:
        s = line.strip()
        # Match TIER label by checking for known tier text within an all-caps line
        for tlabel in TIER_LABELS:
            if tlabel in s.upper():
                idx = s.upper().find(tlabel)
                school_part = s[:idx].strip()
                tier = tlabel.title()
                # School might be all-caps still
                if school_part:
                    school = school_part.title()
                break
        if tier:
            break

    # Height/Weight
    height_weight = None
    hw_m = re.search(r"Height:\s*([\d'\"\u2019 ]+)\s*Weight:\s*(\d+)", text)
    if hw_m:
        height_weight = f"{hw_m.group(1).strip()} / {hw_m.group(2)}"

    athletic_pieces = []
    if height_weight:
        athletic_pieces.append(height_weight)
    if zap_score is not None:
        athletic_pieces.append(f"ZAP {zap_score}")
    # Breakout Score
    bs_m = re.search(r"Breakout\s+Score\s+of\s+([\d.]+)", text)
    if bs_m:
        athletic_pieces.append(f"Breakout {bs_m.group(1)}")
    athletic_notes = "; ".join(athletic_pieces) if athletic_pieces else None

    # Statistical Comps
    comps = []
    sc_m = re.search(r"Statistical\s+Comps:\s*([^\n]+)", text)
    if sc_m:
        raw = sc_m.group(1).strip()
        comps_raw = re.split(r"\s*[•·]\s*", raw)
        for c in comps_raw:
            c = c.strip().rstrip(".,;")
            if c and len(c.split()) >= 2:
                comps.append(c)

    # Prose body — everything after the first 12 lines
    prose_start = 0
    for j, line in enumerate(profile_lines):
        if line.strip().startswith("Statistical Comps:"):
            prose_start = j + 1
            break
    prose = "\n".join(profile_lines[prose_start:])
    prose = re.sub(r"Late-Round Fantasy Football:.*$", "", prose, flags=re.MULTILINE)
    prose = re.sub(r"Jump To:.*$", "", prose, flags=re.MULTILINE)
    prose = re.sub(r"=== PAGE \d+ ===", "", prose)
    prose = re.sub(r"\s+", " ", prose).strip()

    # Pull out projected_round from prose mentions
    projected_round = None
    prose_lower = prose.lower()
    for r, kws in ROUND_KEYWORDS.items():
        for kw in kws:
            if kw in prose_lower:
                projected_round = r
                break
        if projected_round:
            break

    # Strengths / Weaknesses — heuristic extraction from prose sentences
    sentences = re.split(r"(?<=[.!?])\s+", prose)
    strengths = []
    weaknesses = []
    red_flags = []
    pos_signals = ["impressive", "elite", "best", "rare", "outstanding", "strong", "quick", "dominant", "premier", "explosive", "high-end"]
    neg_signals = ["concern", "issue", "downside", "shortcoming", "risk", "lack", "limited", "struggle", "underperform", "questionable", "worry", "flaw"]
    inj_signals = ["injur", "durability", "missed games", "missed multiple", "soft-tissue", "knee", "shoulder", "hamstring", "ankle", "concuss", "surgery", "torn", "hip", "back issue"]

    for sent in sentences:
        s = sent.strip()
        if len(s.split()) < 4 or len(s.split()) > 30:
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

    # Summary: last sentence (often the verdict)
    summary = ""
    if sentences:
        # Skip jump-to junk
        clean_sents = [s.strip() for s in sentences if s.strip() and "Jump To" not in s]
        if clean_sents:
            summary = clean_sents[-1]
            if len(summary) > 350:
                summary = summary[:350].rstrip() + "..."

    confidence = "high" if (strengths or weaknesses) and summary else "medium"

    return {
        "player_name": player_name,
        "position": position,
        "college": school,
        "rank_overall": None,
        "rank_position": None,
        "tier": tier,
        "projected_round": projected_round,
        "comps": comps,
        "strengths": strengths,
        "weaknesses": weaknesses,
        "red_flags": red_flags,
        "athletic_notes": athletic_notes,
        "summary": summary,
        "confidence": confidence,
        "college_stats": [],
        "route_profile": None,
    }


def main():
    with open(INPUT_PATH, "r", encoding="utf-8") as f:
        lines = f.readlines()

    starts = find_profiles(lines)
    records = []
    for k in range(len(starts) - 1):
        prof_lines = lines[starts[k]:starts[k + 1]]
        rec = parse_profile(prof_lines)
        if rec is None:
            continue
        if rec["position"] not in INCLUDE_POSITIONS:
            continue
        records.append(rec)

    # Assign rank_position by order within each position
    pos_counters = Counter()
    for r in records:
        pos_counters[r["position"]] += 1
        r["rank_position"] = pos_counters[r["position"]]

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    pos_counts = Counter(r["position"] for r in records)
    print(f"Total profiles: {len(records)}")
    print(f"Position breakdown: {dict(sorted(pos_counts.items()))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
