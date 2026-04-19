#!/usr/bin/env python3
"""Extract NFL draft prospect features from The Beast 2024 cached text.

Parses pdfs/.cache/the_beast_2022.text.txt into a JSON array of per-player
feature records (QB/RB/WR/TE only, per task spec) and writes
pdfs/.cache/the_beast_2022.d52f0eac.features.json.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter

INPUT_PATH = "/Users/matthewporritt/stathead/pdfs/.cache/the_beast_2022.text.txt"
OUTPUT_PATH = "/Users/matthewporritt/stathead/pdfs/.cache/the_beast_2022.d52f0eac.features.json"

POSITION_HEADERS = {
    "QUARTERBACKS": "QB",
    "RUNNING BACKS": "RB",
    "WIDE RECEIVERS": "WR",
    "TIGHT ENDS": "TE",
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


def titlecase_name(raw: str) -> str:
    raw = raw.strip()
    tokens = raw.split()
    out = []
    for tok in tokens:
        if not tok:
            continue
        if tok in ROMAN_SUFFIXES:
            out.append(tok)
            continue
        if tok.rstrip(".") in ("JR", "SR"):
            out.append("Jr." if tok.startswith("JR") else "Sr.")
            continue
        if re.fullmatch(r"(?:[A-Z]\.){2,}", tok):
            out.append(tok)
            continue
        out.append(_title_word(tok))
    return " ".join(out)


def _title_word(word: str) -> str:
    if "-" in word:
        return "-".join(_title_word(p) for p in word.split("-"))
    if "'" in word or "\u2019" in word:
        parts = re.split(r"(['\u2019])", word)
        result = []
        for i, p in enumerate(parts):
            if p in ("'", "\u2019"):
                result.append(p)
            else:
                if i == 0:
                    result.append(p.capitalize())
                else:
                    prev_letter_piece = None
                    for j in range(i - 1, -1, -1):
                        if parts[j] not in ("'", "\u2019"):
                            prev_letter_piece = parts[j]
                            break
                    if prev_letter_piece is not None and len(prev_letter_piece) == 1:
                        result.append(p.capitalize())
                    else:
                        result.append(p.lower())
        return "".join(result)
    if word.upper().startswith("MC") and len(word) > 2 and word.isalpha():
        return "Mc" + word[2:].capitalize()
    return word.capitalize()


HEIGHT_RE = re.compile(r"^(\d)(\d{2})(\d)$")


def decode_height(hhwws):
    m = HEIGHT_RE.match(hhwws)
    if not m:
        return None
    feet = int(m.group(1))
    inches = int(m.group(2))
    return f"{feet}-{inches}"


def athletic_notes(hhwws, weight):
    pieces = []
    if hhwws:
        ht = decode_height(hhwws)
        if ht:
            pieces.append(ht)
    if weight:
        pieces.append(str(weight))
    return ", ".join(pieces) if pieces else None


PROFILE_HEADER_RE = re.compile(
    r"^(\d+)\.\s+([A-Z][A-Z0-9 .'\-\u2019]+?)\s*\|\s*"
    r"(.+?)\s+(\d{4})\s*\|\s*(\d{2,3})\s*lbs\.?",
)

ROUND_RE = re.compile(r"(\d+)(?:st|nd|rd|th)", re.IGNORECASE)

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
    raw_parts = re.split(r"[\u2026]|\.{3}", paragraph)
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
        r"stylistically,?\s+(?:he\s+is\s+like\s+|reminds\s+me\s+of\s+)(?:a\s+really\s+\w+\s+)?(" + name_pat + r")",
        r"is\s+a\s+(" + name_pat + r")-type",
        r"\bformer\s+\w+(?:\s+\w+){0,3}\s+RB\s+(" + name_pat + r")",
        r"\bformer\s+\w+(?:\s+\w+){0,3}\s+WR\s+(" + name_pat + r")",
        r"\bformer\s+\w+(?:\s+\w+){0,3}\s+TE\s+(" + name_pat + r")",
        r"his\s+game\s+reminds\s+me\s+of\s+(" + name_pat + r")",
    ]
    blocklist = {
        "NFL", "No", "Overall", "Though", "Although", "Despite", "Mode",
        "Plan", "Senior Bowl", "Big Ten", "Big 12", "Pac-12", "SEC",
        "MVP", "Air Raid", "AC", "Holy Cross", "East Coast", "West Coast",
        "Academic Heisman", "Rose Bowl", "Hula Bowl", "Shrine Bowl",
    }
    for pat in patterns:
        for m in re.finditer(pat, full_text):
            name = m.group(1).strip().rstrip(".,;")
            if name in blocklist:
                continue
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
    m = re.search(r"(Overall,[^.]*(?:\.[^.]*){0,1}\.)", summary_text)
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
    matches = ROUND_RE.findall(grade_text)
    if not matches:
        return None
    try:
        return int(matches[0])
    except ValueError:
        return None


SECTION_RE = re.compile(
    r"^(STRENGTHS|WEAKNESSES|SUMMARY|GRADE|BACKGROUND):\s*(.*)$",
    re.MULTILINE,
)


def clean_body(raw):
    raw = re.sub(r"===\s*PAGE\s*\d+\s*===", " ", raw)
    raw = re.sub(r"BACK TO TABLE OF CONTENTS\s+\d+", " ", raw)
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


# QB stats: "2023: (12/12) 266-388 68.6 3,633 30 5 97 136 1.4 11 USC; notes"
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

# RB stats: "2023: (11/8) 187 1,139 6.1 10 25 286 11.4 1 notes"
# Columns: CAR YDS AVG TD REC YDS AVG TD
RB_STATS_RE = re.compile(
    r"^(\d{4}):\s*\((\d+)\s*/\s*(\d+)\)\s+"
    r"([\d,]+)\s+([\d,\-]+)\s+([\d.\-]+)\s+(\d+)\s+"
    r"([\d,]+)\s+([\d,\-]+)\s+([\d.\-]+)\s+(\d+)"
    r"(?:\s+(.*))?$",
    re.MULTILINE,
)

# WR/TE stats: "2023: (12/12) 67 1,211 18.1 14 6 ..."
# Columns: REC YDS AVG TD DROP NOTES
WR_STATS_RE = re.compile(
    r"^(\d{4}):\s*\((\d+)\s*/\s*(\d+)\)\s+"
    r"([\d,]+)\s+([\d,]+)\s+([\d.\-]+)\s+(\d+)\s+([\d,\-]+)"
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


SCHOOL_TOKENS = (
    "USC", "UCLA", "LSU", "SMU", "BYU", "TCU", "FAU", "UAB", "UTEP", "UCF",
    "UTSA", "UNLV", "UConn", "NC State", "North Carolina", "South Carolina",
    "Florida State", "Michigan State", "Ohio State", "Oklahoma State",
    "Iowa State", "Mississippi State", "Washington State", "Oregon State",
    "Kansas State", "Penn State", "Arizona State", "Boise State",
    "Georgia Tech", "Virginia Tech", "Texas Tech", "Texas A&M", "Miami",
    "Eastern Michigan", "Western Michigan", "Central Michigan", "Ole Miss",
    "Texas", "Oklahoma", "Auburn", "Alabama", "Georgia", "Florida",
    "Tennessee", "Kentucky", "Michigan", "Oregon", "Washington", "Utah",
    "Stanford", "California", "Pittsburgh", "Louisville", "Purdue",
    "Cincinnati", "Memphis", "Tulane", "Duke", "Clemson", "Notre Dame",
    "Wisconsin", "Minnesota", "Iowa", "Illinois", "Indiana", "Maryland",
    "Rutgers", "Nebraska", "Missouri", "Arkansas", "Kansas", "Syracuse",
    "Boston College", "Colorado", "Arizona", "Navy", "Army", "Troy",
    "Liberty", "Marshall", "Northwestern", "Vanderbilt", "West Virginia",
    "Virginia", "Hawaii", "Tulsa", "Temple", "Toledo", "Akron",
    "Louisiana", "Louisiana-Monroe", "Louisiana Tech", "Houston", "Rice",
    "South Alabama", "Samford", "Monmouth", "Yale",
    "Fresno State", "Wake Forest", "Old Dominion", "South Dakota State",
    "New Hampshire", "Northern Illinois", "Western Kentucky", "Dayton",
    "Princeton", "Middle Tennessee", "App State", "Appalachian State",
    "Wyoming", "Air Force", "North Texas", "Colorado State", "Utah State",
    "Tennessee Tech", "North Dakota State", "Weber State",
    "West Florida", "Truman State", "Ball State", "Kent State",
    "Bowling Green", "East Carolina", "James Madison", "Coastal Carolina",
    "Ohio", "WKU", "FAU", "SE Missouri State",
)


def _extract_school_per_year(body_text):
    mapping = {}
    for line in body_text.splitlines():
        m = re.match(r"^(\d{4}):", line.strip())
        if not m:
            continue
        year = int(m.group(1))
        parts = line.split(";", 1)
        head = parts[0]
        found = None
        for school in sorted(SCHOOL_TOKENS, key=len, reverse=True):
            if re.search(r"\b" + re.escape(school) + r"\b", head):
                found = school
                break
        mapping[year] = found
    return mapping


def parse_college_stats(body_text, pos_code):
    body_text = clean_body(body_text)
    rows = []
    school_notes = _extract_school_per_year(body_text)

    if pos_code == "QB":
        for m in QB_STATS_RE.finditer(body_text):
            season = _num(m.group(1))
            if season is None or season < 2000 or season > 2030:
                continue
            rows.append({
                "season": season,
                "school": school_notes.get(season),
                "games": _num(m.group(2)),
                "games_started": _num(m.group(3)),
                "pass_comp": _num(m.group(4)),
                "pass_att": _num(m.group(5)),
                "pass_yds": _num(m.group(7)),
                "pass_td": _num(m.group(8)),
                "pass_int": _num(m.group(9)),
                "rush_att": _num(m.group(10)),
                "rush_yds": _num(m.group(11)),
                "rush_td": _num(m.group(13)),
            })
    elif pos_code == "RB":
        for m in RB_STATS_RE.finditer(body_text):
            season = _num(m.group(1))
            if season is None or season < 2000 or season > 2030:
                continue
            rows.append({
                "season": season,
                "school": school_notes.get(season),
                "games": _num(m.group(2)),
                "games_started": _num(m.group(3)),
                "rush_att": _num(m.group(4)),
                "rush_yds": _num(m.group(5)),
                "rush_td": _num(m.group(7)),
                "rec": _num(m.group(8)),
                "rec_yds": _num(m.group(9)),
                "rec_td": _num(m.group(11)),
            })
    else:  # WR or TE
        for m in WR_STATS_RE.finditer(body_text):
            season = _num(m.group(1))
            if season is None or season < 2000 or season > 2030:
                continue
            rows.append({
                "season": season,
                "school": school_notes.get(season),
                "games": _num(m.group(2)),
                "games_started": _num(m.group(3)),
                "rec": _num(m.group(4)),
                "rec_yds": _num(m.group(5)),
                "rec_td": _num(m.group(7)),
            })
    return rows


def parse(lines):
    position_by_line = []
    for i, line in enumerate(lines):
        stripped = line.rstrip("\n").strip()
        if stripped in POSITION_HEADERS:
            position_by_line.append((i, POSITION_HEADERS[stripped]))

    profiles = []
    for i, line in enumerate(lines):
        s = line.rstrip("\n").strip()
        m = PROFILE_HEADER_RE.match(s)
        if not m:
            continue
        pos_code = None
        for (ph_line, ph_code) in position_by_line:
            if ph_line < i:
                pos_code = ph_code
            else:
                break
        if pos_code is None:
            continue
        if pos_code not in INCLUDE_POSITIONS:
            continue
        profiles.append((i, m, pos_code))

    records = []
    for idx, (start_line, m, pos_code) in enumerate(profiles):
        end_line = profiles[idx + 1][0] if idx + 1 < len(profiles) else len(lines)
        body_text = "".join(lines[start_line:end_line])

        rank_position = int(m.group(1))
        raw_name = m.group(2).strip()
        college = m.group(3).strip()
        height_hhww = m.group(4)
        weight = m.group(5)

        player_name = titlecase_name(raw_name)

        strengths_text, weaknesses_text, summary_text, grade_text = extract_sections(body_text)
        strengths = extract_phrases(strengths_text) if strengths_text else []
        weaknesses = extract_phrases(weaknesses_text) if weaknesses_text else []
        red_flags = find_red_flags(weaknesses_text or "", weaknesses) if weaknesses_text else []

        summary = summary_line(summary_text) if summary_text else ""

        has_str = bool(strengths_text)
        has_wk = bool(weaknesses_text)
        has_sum = bool(summary_text)
        if has_str and has_wk and has_sum:
            confidence = "high"
        elif has_sum and not has_str and not has_wk:
            confidence = "low"
        else:
            confidence = "medium"

        tier = None
        rank_overall = None
        projected_round = None
        if grade_text:
            overall_m = re.search(
                r"\(No\.\s*(\d+)\s*overall[^)]*\)", grade_text, re.IGNORECASE
            )
            if overall_m:
                rank_overall = int(overall_m.group(1))
                tier_candidate = grade_text[: overall_m.start()].strip().rstrip(" /(")
            else:
                tier_candidate = grade_text.strip()
            tier = tier_candidate if tier_candidate else grade_text.strip()
            low = (tier or "").lower()
            if "priority free agent" in low or "pfa" in low or "undrafted" in low:
                projected_round = None
            elif tier:
                projected_round = lower_bound_round(tier)

        comps = extract_comps(body_text)

        college_stats = parse_college_stats(body_text, pos_code)

        route_profile = None
        if pos_code in ("WR", "TE"):
            route_profile = {}
            combined = " ".join(strengths + weaknesses + [summary]).lower()
            if re.search(r"\bslot\b", combined):
                route_profile["alignment"] = "slot"
            elif re.search(r"\boutside\b|\bperimeter\b|\bboundary\b|\b[xX][- ]receiver\b", combined):
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
            "athletic_notes": athletic_notes(height_hhww, weight),
            "summary": summary,
            "confidence": confidence,
            "college_stats": college_stats,
            "route_profile": route_profile,
        })

    return records


def main():
    with open(INPUT_PATH, "r", encoding="utf-8") as f:
        lines = f.readlines()

    records = parse(lines)

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    pos_counts = Counter(r["position"] for r in records)
    conf_counts = Counter(r["confidence"] for r in records)
    rounds = Counter(r["projected_round"] for r in records)
    print(f"Total profiles: {len(records)}")
    print(f"Position breakdown: {dict(sorted(pos_counts.items()))}")
    print(f"Confidence breakdown: {dict(sorted(conf_counts.items(), key=lambda kv: kv[0] or ''))}")
    print(f"Round breakdown: {dict(sorted(rounds.items(), key=lambda kv: (kv[0] is None, kv[0])))}")

    stats_counts = Counter()
    for r in records:
        stats_counts[r["position"], bool(r["college_stats"])] += 1
    print(f"college_stats presence by position: {dict(stats_counts)}")

    tier_counts = Counter(r["tier"] for r in records)
    print("--- tiers (top 15) ---")
    for t, c in list(tier_counts.most_common(15)):
        print(f"  {c}x  {t!r}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
