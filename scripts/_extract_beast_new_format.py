#!/usr/bin/env python3
"""Extract NFL prospect features from The Beast 2025/2026 cached text.

The 2025 and 2026 editions use a different layout than 2022-2024. Profile
headers look like:

    QB1 Cam Ward
    Miami, 5SR
    HOMETOWN HIGH SCHOOL BIRTHDAY AGE HT WT NUM
    West Columbia, TX  Columbia  May 25, 2002  22.92  6015  219  #1
    BACKGROUND
    ...

Or for 2026:

    QB1 Fernando Mendoza
    Indiana
    GRADE OVR. RANK YEAR BIRTHDAY AGE HT WT JERSEY
    1st round 3 4JR Oct 01, 2003 22.56 6'5" 236 lbs. No. 15
    BACKGROUND
    ...

Usage: python3 _extract_beast_new_format.py <year>
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter

CONTEXT_HASH = "d52f0eac"

POSITION_HEADERS = {
    "QUARTERBACKS": "QB",
    "RUNNING BACKS": "RB",
    "WIDE RECEIVERS": "WR",
    "TIGHT ENDS": "TE",
    "TIGHT ENDS/FULLBACKS": "TE",
    "OFFENSIVE TACKLES": "OT",
    "OFFENSIVE GUARDS": "OG",
    "GUARDS": "OG",
    "CENTERS": "C",
    "EDGE RUSHERS": "EDGE",
    "EDGERUSHERS": "EDGE",
    "DEFENSIVE TACKLES": "DT",
    "LINEBACKERS": "LB",
    "CORNERBACKS": "CB",
    "SAFETIES": "S",
    "SPECIALISTS": "SPEC",
}

INCLUDE_POSITIONS = {"QB", "RB", "WR", "TE"}
ROMAN_SUFFIXES = {"II", "III", "IV", "V", "VI"}

# Profile header: "QB1 Fernando Mendoza" / "RB12 Some Player" / "WR5 Foo Bar"
PROFILE_HEADER_RE = re.compile(
    r"^(QB|RB|WR|TE)(\d+)\s+([A-Z][A-Za-z .'\-\u2019]+(?:\s+(?:Jr\.?|Sr\.?|II|III|IV|V))?)\s*$"
)

ROUND_RE = re.compile(r"(\d+)(?:st|nd|rd|th)\s*round", re.IGNORECASE)

RED_FLAG_KEYWORDS = [
    "injur", "knee", "shoulder", "back ", "acl", "mcl", "hamstring", "ankle",
    "concuss", "character", "arrest", "off-field", "off the field", "medical",
    "suspend", "surgery", "torn", "fractur", "broken",
    "legal", "charge", "felony", "dui", "marijuana", "failed drug", "substance",
    "ruled ineligible", "code of conduct",
    "durability", "blood clot", "thyroid",
]


def extract_phrases(paragraph):
    if not paragraph:
        return []
    # Split on bullet points (●), then also on horizontal-ellipsis
    raw_parts = re.split(r"[\u2026\u25CF]|\.{3}", paragraph)
    phrases = []
    for part in raw_parts:
        p = part.strip()
        if not p:
            continue
        p = re.sub(r"\([^)]*\)", "", p)
        p = re.sub(r'"[^"]*"', "", p)
        p = re.sub(r"\s+", " ", p).strip(" .,:")
        if not p:
            continue
        words = p.split()
        if len(words) > 15:
            truncated_words = words[:15]
            truncated = " ".join(truncated_words)
            comma_idx = truncated.rfind(",")
            if comma_idx > len(truncated) * 0.5:
                truncated = truncated[:comma_idx]
            p = truncated.strip().rstrip(",")
        if len(p.split()) < 3:
            continue
        # Drop trailing function words
        last = p.split()[-1].lower().rstrip(",.:;")
        if last in {"his", "the", "to", "with", "of", "and", "a", "an", "by"}:
            tokens = p.split()
            while tokens and tokens[-1].lower().rstrip(",.:;") in {"his", "the", "to", "with", "of", "and", "a", "an", "by"}:
                tokens.pop()
            p = " ".join(tokens)
            if len(p.split()) < 3:
                continue
        phrases.append(p)
    return phrases


def find_red_flags(weakness_text, weakness_phrases):
    if not weakness_text:
        return []
    flags = []
    for phrase in weakness_phrases:
        pl = phrase.lower()
        for kw in RED_FLAG_KEYWORDS:
            if kw in pl:
                flags.append(phrase)
                break
    seen = set()
    uniq = []
    for f in flags:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    return uniq


def extract_comps(full_text):
    comps = []
    name_pat = r"[A-Z][A-Za-z.'\u2019\-]+(?:\s+[A-Z][A-Za-z.'\u2019\-]+){1,3}"
    patterns = [
        r"reminds?\s+me\s+of\s+(?:a\s+\w+\s+version\s+of\s+)?(" + name_pat + r")",
        r"reminiscent\s+of\s+(?:former\s+[A-Z][A-Za-z.'\- ]+\s+)?(" + name_pat + r")",
        r"similar\s+to\s+(?:a\s+\w+\s+version\s+of\s+)?(" + name_pat + r")",
        r"similar\s+ceiling\s+as\s+(?:an\s+)?(?:NFL\s+player\s+)?(" + name_pat + r")",
        r"compares?\s+to\s+(" + name_pat + r")",
        r"comparable\s+to\s+(" + name_pat + r")",
        r"NFL\s+comparison[:]?\s*(" + name_pat + r")",
        r"shades\s+of\s+(" + name_pat + r")",
        r"cut\s+in\s+the\s+(" + name_pat + r")\s+mold",
        r"cut\s+from\s+the\s+same\s+cloth\s+as\s+(" + name_pat + r")",
        r"in\s+the\s+(" + name_pat + r")\s+mold",
        r"defend\s+him\s+like\s+(" + name_pat + r")",
        r"karaoke-style\s+version\s+of\s+(" + name_pat + r")",
        r"gives?\s+me\s+flashbacks?\s+of\s+(?:a\s+\w+\s+version\s+of\s+)?(" + name_pat + r")",
        r"version\s+of\s+(" + name_pat + r")",
        r"is\s+a\s+(" + name_pat + r")-type",
        r"his\s+game\s+reminds\s+me\s+of\s+(" + name_pat + r")",
    ]
    blocklist = {
        "NFL", "No", "Overall", "Though", "Although", "Despite", "Mode",
        "Plan", "Senior Bowl", "Big Ten", "Big 12", "Pac-12", "SEC",
        "MVP", "Air Raid", "AC", "Holy Cross", "East Coast", "West Coast",
        "Academic Heisman", "Rose Bowl", "Hula Bowl", "Shrine Bowl",
        "Bernie Kosar", "Pro Bowler", "Hall Of Famer",
    }
    for pat in patterns:
        for m in re.finditer(pat, full_text):
            name = m.group(1).strip().rstrip(".,;")
            if len(name.split()) < 2:
                continue
            lower_parts = {"the", "and", "of", "a", "an"}
            if any(w.lower() in lower_parts for w in name.split()):
                continue
            if name and name not in comps:
                comps.append(name)
    return comps


def summary_line(summary_text):
    if not summary_text:
        return ""
    # Beast SUMMARY usually ends with "He projects as..." or "Overall, ..."
    m = re.search(r"(Overall,[^.]*(?:\.[^.]*){0,2}\.)", summary_text)
    if m:
        out = m.group(1).strip()
    else:
        sentences = re.split(r"(?<=[.!?])\s+", summary_text.strip())
        sentences = [s.strip() for s in sentences if s.strip()]
        if len(sentences) >= 2:
            out = " ".join(sentences[-2:])
        elif sentences:
            out = sentences[-1]
        else:
            out = summary_text.strip()
    out = re.sub(r"\s+", " ", out).strip()
    out = re.sub(r"\s*GRADE:.*$", "", out).strip()
    if len(out) > 350:
        out = out[:350].rstrip() + "..."
    return out


def lower_bound_round(grade_text):
    if not grade_text:
        return None
    m = ROUND_RE.search(grade_text)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    return None


SECTION_RE = re.compile(
    r"^(STRENGTHS|WEAKNESSES|SUMMARY|GRADE|BACKGROUND)[:]?\s*(.*)$",
    re.MULTILINE,
)


def clean_body(raw):
    raw = re.sub(r"===\s*PAGE\s*\d+\s*===", " ", raw)
    raw = re.sub(r"BACK TO TABLE OF CONTENTS\s+\d+", " ", raw)
    raw = re.sub(r"THE BEAST\s*\|\s*BACK TO TABLE OF CONTENTS\s+\d+", " ", raw)
    raw = re.sub(r"Back to table of contents\s+\d+", " ", raw)
    return raw


def extract_sections(body_text):
    body_text = clean_body(body_text)
    matches = list(SECTION_RE.finditer(body_text))
    sections = {}
    for i, m in enumerate(matches):
        label = m.group(1)
        if label == "GRADE":
            raw = m.group(2) or ""
        else:
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(body_text)
            raw = body_text[start:end]
            raw = re.sub(r"\s*\n\s*", " ", raw)
        raw = re.sub(r"\s+", " ", raw).strip()
        sections[label] = raw
    return (
        sections.get("STRENGTHS"),
        sections.get("WEAKNESSES"),
        sections.get("SUMMARY"),
        sections.get("GRADE"),
    )


# Stat row regex: starts with year then (gp/gs)
QB_STATS_RE = re.compile(
    r"^(\d{4}):\s*\((\d+)\s*/\s*(\d+)\)\s+"
    r"([\d,]+)\s*-\s*([\d,]+)\s+"
    r"([\d.]+)\s+"
    r"([\d,]+)\s+"
    r"(\d+)\s+(\d+)\s+"
    r"(\d+)\s+([\d,\-]+)\s+([\d.\-]+)\s+(\d+)"
    r"(?:\s+(.*))?$",
    re.MULTILINE,
)

RB_STATS_RE = re.compile(
    r"^(\d{4}):\s*\((\d+)\s*/\s*(\d+)\)\s+"
    r"([\d,]+)\s+([\d,\-]+)\s+([\d.\-]+)\s+(\d+)\s+"
    r"([\d,]+)\s+([\d,\-]+)\s+([\d.\-]+)\s+(\d+)"
    r"(?:\s+(.*))?$",
    re.MULTILINE,
)

WR_STATS_RE = re.compile(
    r"^(\d{4}):\s*\((\d+)\s*/\s*(\d+)\)\s+"
    r"([\d,]+)\s+([\d,]+)\s+([\d.\-]+)\s+(\d+)(?:\s+([\d,\-]+))?"
    r"(?:\s+(.*))?$",
    re.MULTILINE,
)


def _num(s):
    if s is None:
        return None
    s = str(s).replace(",", "").strip()
    if not s or s == "-":
        return None
    try:
        if "." in s:
            return float(s)
        return int(s)
    except ValueError:
        return None


def parse_college_stats(body_text, pos_code):
    body_text = clean_body(body_text)
    rows = []
    if pos_code == "QB":
        for m in QB_STATS_RE.finditer(body_text):
            season = _num(m.group(1))
            if season is None or season < 2000 or season > 2030:
                continue
            notes = (m.group(14) or "").strip()
            school = notes.split(";")[0].strip() if notes else None
            rows.append({
                "season": season, "school": school or None,
                "games": _num(m.group(2)), "games_started": _num(m.group(3)),
                "pass_comp": _num(m.group(4)), "pass_att": _num(m.group(5)),
                "pass_yds": _num(m.group(7)), "pass_td": _num(m.group(8)),
                "pass_int": _num(m.group(9)), "rush_att": _num(m.group(10)),
                "rush_yds": _num(m.group(11)), "rush_td": _num(m.group(13)),
            })
    elif pos_code == "RB":
        for m in RB_STATS_RE.finditer(body_text):
            season = _num(m.group(1))
            if season is None or season < 2000 or season > 2030:
                continue
            notes = (m.group(12) or "").strip()
            school = notes.split(";")[0].strip() if notes else None
            rows.append({
                "season": season, "school": school or None,
                "games": _num(m.group(2)), "games_started": _num(m.group(3)),
                "rush_att": _num(m.group(4)), "rush_yds": _num(m.group(5)),
                "rush_td": _num(m.group(7)), "rec": _num(m.group(8)),
                "rec_yds": _num(m.group(9)), "rec_td": _num(m.group(11)),
            })
    else:  # WR / TE
        for m in WR_STATS_RE.finditer(body_text):
            season = _num(m.group(1))
            if season is None or season < 2000 or season > 2030:
                continue
            notes = (m.group(9) or "").strip()
            school = notes.split(";")[0].strip() if notes else None
            rows.append({
                "season": season, "school": school or None,
                "games": _num(m.group(2)), "games_started": _num(m.group(3)),
                "rec": _num(m.group(4)), "rec_yds": _num(m.group(5)),
                "rec_td": _num(m.group(7)),
            })
    return rows


def parse(lines):
    profiles = []  # (start_line, position_code, rank_position, name, college)
    for i, line in enumerate(lines):
        s = line.rstrip("\n").strip()
        m = PROFILE_HEADER_RE.match(s)
        if not m:
            continue
        pos_code = m.group(1)
        rank_position = int(m.group(2))
        # Skip if rank is too high (Best-of-the-rest sections often have unprofiled entries)
        # We accept all ranks because every rank ≥1 matching POS+# pattern is a profile header
        raw_name = m.group(3).strip()

        # Next non-empty line should be the school (or "School, class")
        college = None
        for j in range(i + 1, min(i + 4, len(lines))):
            cand = lines[j].rstrip("\n").strip()
            if not cand:
                continue
            # College line: "Miami, 5SR" or just "Indiana"
            if cand and not cand.startswith(("HOMETOWN", "GRADE", "BACKGROUND")):
                college = cand.split(",")[0].strip()
                break
            else:
                break
        profiles.append((i, pos_code, rank_position, raw_name, college))

    records = []
    for idx, (start_line, pos_code, rank_position, raw_name, college) in enumerate(profiles):
        end_line = profiles[idx + 1][0] if idx + 1 < len(profiles) else len(lines)
        body_text = "".join(lines[start_line:end_line])

        if pos_code not in INCLUDE_POSITIONS:
            continue

        player_name = raw_name  # already title case in new format

        strengths_text, weaknesses_text, summary_text, grade_text = extract_sections(body_text)
        strengths = extract_phrases(strengths_text) if strengths_text else []
        weaknesses = extract_phrases(weaknesses_text) if weaknesses_text else []
        red_flags = find_red_flags(weaknesses_text or "", weaknesses) if weaknesses_text else []
        summary = summary_line(summary_text) if summary_text else ""

        # Tier / projected_round - look at "GRADE" data line
        # In new format, the grade is on the line below "GRADE OVR. RANK ..." header
        tier = None
        rank_overall = None
        projected_round = None

        # Find "GRADE OVR. RANK" header within first ~12 lines of profile
        for k in range(start_line, min(start_line + 12, end_line)):
            line = lines[k].strip()
            if line.startswith("GRADE OVR.") or line.startswith("GRADE OVR ") or "GRADE OVR" in line:
                # Next line has the data
                if k + 1 < end_line:
                    data = lines[k + 1].strip()
                    # e.g. "1st round 3 4JR Oct 01, 2003 22.56 6'5" 236 lbs. No. 15"
                    tier_m = re.match(r"^([A-Za-z0-9\- ]+round[A-Za-z0-9\- ]*?)\s+(\d+)\s+", data)
                    if tier_m:
                        tier = tier_m.group(1).strip()
                        try:
                            rank_overall = int(tier_m.group(2))
                        except ValueError:
                            rank_overall = None
                        projected_round = lower_bound_round(tier)
                    elif data.lower().startswith(("priority free agent", "pfa", "undrafted")):
                        tier = data.split()[0:3]
                        tier = " ".join(tier) if isinstance(tier, list) else tier
                        projected_round = None
                break
            if line.startswith("HOMETOWN HIGH SCHOOL") or "HOMETOWN" in line and "BIRTHDAY" in line:
                # 2025 format: doesn't have GRADE/OVR/RANK in header table
                # Need to look elsewhere for grade — skip
                break

        # Athletic notes from header data
        athletic_notes = None
        for k in range(start_line, min(start_line + 12, end_line)):
            line = lines[k].strip()
            # Look for combine measurables row
            if "lbs." in line:
                # 2026 format: "1st round 3 4JR Oct 01, 2003 22.56 6'5" 236 lbs. No. 15"
                ht_wt_m = re.search(r"(\d+'[\d ]+\")\s+(\d+)\s+lbs\.", line)
                if ht_wt_m:
                    athletic_notes = f"{ht_wt_m.group(1)} {ht_wt_m.group(2)}"
                    break
            # 2025 format: data line has HHWW WWW after birthday/age
            # "West Columbia, TX Columbia May 25, 2002 22.92 6015 219 #1"
            m_ht = re.search(r"\b(\d{4})\s+(\d{2,3})\s+#", line)
            if m_ht:
                hhww = m_ht.group(1)
                wt = m_ht.group(2)
                ft = hhww[0]
                inches = int(hhww[1:3])
                athletic_notes = f"{ft}'{inches} {wt}"
                break

        # Combine row notes
        combine_m = re.search(
            r"COMBINE\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+(\S+)",
            body_text,
        )
        if combine_m:
            forty = combine_m.group(3)
            if forty != "DNP":
                athletic_notes = (athletic_notes or "") + f", {forty} forty"

        has_str = bool(strengths_text)
        has_wk = bool(weaknesses_text)
        has_sum = bool(summary_text)
        if has_str and has_wk and has_sum:
            confidence = "high"
        elif has_sum:
            confidence = "medium"
        else:
            confidence = "low"

        comps = extract_comps(body_text)
        college_stats = parse_college_stats(body_text, pos_code)

        route_profile = None
        if pos_code in ("WR", "TE"):
            route_profile = {}
            combined = " ".join(strengths + weaknesses + [summary]).lower()
            if re.search(r"\bslot\b", combined):
                route_profile["alignment"] = "slot"
            elif re.search(r"\boutside\b|\bperimeter\b|\bboundary\b", combined):
                route_profile["alignment"] = "outside"

        records.append({
            "player_name": player_name,
            "position": pos_code,
            "college": college,
            "rank_overall": rank_overall,
            "rank_position": rank_position,
            "tier": tier,
            "projected_round": projected_round,
            "comps": comps,
            "strengths": strengths,
            "weaknesses": weaknesses,
            "red_flags": red_flags,
            "athletic_notes": athletic_notes,
            "summary": summary,
            "confidence": confidence,
            "college_stats": college_stats,
            "route_profile": route_profile,
        })

    return records


def main():
    if len(sys.argv) != 2:
        print("Usage: _extract_beast_new_format.py <year>")
        return 1
    year = sys.argv[1]
    in_path = f"/Users/matthewporritt/stathead/pdfs/.cache/the_beast_{year}.text.txt"
    out_path = f"/Users/matthewporritt/stathead/pdfs/.cache/the_beast_{year}.{CONTEXT_HASH}.features.json"

    with open(in_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    records = parse(lines)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    pos_counts = Counter(r["position"] for r in records)
    conf_counts = Counter(r["confidence"] for r in records)
    print(f"Total profiles: {len(records)}")
    print(f"Position breakdown: {dict(sorted(pos_counts.items()))}")
    print(f"Confidence breakdown: {dict(sorted(conf_counts.items(), key=lambda kv: kv[0] or ''))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
