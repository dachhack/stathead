#!/usr/bin/env python3
"""Extract structured prospect features from local PDF rookie/draft guides.

Reads every PDF in ./pdfs/ (gitignored), extracts text with pdfplumber,
then asks Claude to normalize each guide into a list of per-player
feature rows. Raw text and parsed features are cached per-PDF under
./pdfs/.cache/ so reruns are cheap.

Final outputs (committed):
  public/data/pdf-prospect-features.json           -- per (player, source) rows
  public/data/pdf-prospect-features-merged.json    -- one row per player, aggregated

Usage:
  pip install -r scripts/requirements-pdf.txt
  export ANTHROPIC_API_KEY=sk-ant-...
  python3 scripts/extract_pdf_features.py
  python3 scripts/extract_pdf_features.py --dry-run   # text extraction only
  python3 scripts/extract_pdf_features.py --force     # ignore cache

Password-protected PDFs:
  Put passwords (one per line) in ./pdfs/.passwords.txt. Each line can be a
  plain password, or "<hint>:<password>" where <hint> is a substring of the
  filename that signals which password applies (e.g. "2024:my-pw"). The file
  lives inside pdfs/ and is therefore gitignored. You can also pass a
  comma-separated list via the PDF_PASSWORDS env var.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
PDF_DIR = ROOT / "pdfs"
CACHE_DIR = PDF_DIR / ".cache"
OUT_PER_SOURCE = ROOT / "public" / "data" / "pdf-prospect-features.json"
OUT_MERGED = ROOT / "public" / "data" / "pdf-prospect-features-merged.json"

MODEL = os.environ.get("PDF_EXTRACT_MODEL", "claude-sonnet-4-6")
MAX_CHUNK_CHARS = 180_000  # roughly ~45k tokens of input text per call

SYSTEM_PROMPT = """You extract structured prospect evaluations from NFL draft and dynasty rookie guides.

For every distinct NFL draft prospect mentioned in the text, emit one JSON object with this schema:

{
  "player_name": str,              // as written
  "position": str | null,          // QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|ATH
  "college": str | null,
  "rank_overall": int | null,      // overall rank in this guide, if present
  "rank_position": int | null,     // positional rank, if present
  "tier": str | null,              // e.g. "Tier 1", "Elite", "Round 2 grade"
  "projected_round": int | null,   // 1-7 if the guide gives a round projection
  "comps": [str],                  // NFL player comparisons mentioned
  "strengths": [str],              // short phrases, not sentences
  "weaknesses": [str],
  "red_flags": [str],              // injury, character, scheme fit concerns
  "athletic_notes": str | null,    // prose about testing/athleticism
  "summary": str | null,           // 1-2 sentence analyst take, verbatim or tight paraphrase
  "confidence": "high" | "medium" | "low"  // how clearly this player is profiled
}

Rules:
- Only include players who get at least a short dedicated write-up, tier, or ranking. Skip one-off name drops.
- Use null, not empty strings, for missing fields. Use [] for missing lists.
- Do not invent data. If a field isn't in the text, it's null.
- Normalize position to the codes above (e.g. "Running Back" -> "RB", "Edge" -> "DL").
- Preserve proper spellings of names; don't Americanize diacritics.

Return ONLY a JSON object of the form {"players": [...]}. No prose, no markdown fences."""


@dataclass
class Source:
    path: Path
    text: str

    @property
    def stem(self) -> str:
        return self.path.stem


def load_passwords() -> list[tuple[str | None, str]]:
    """Load password candidates as (hint, password) pairs.

    Sources, tried in order:
      1. ./pdfs/.passwords.txt -- one entry per line; either "<password>" or "<hint>:<password>"
      2. PDF_PASSWORDS env var -- comma-separated list of plain passwords
    The optional hint (substring) lets us prefer a password when it appears in the filename
    (e.g. year). Entries with no hint are tried last for every PDF.
    """
    out: list[tuple[str | None, str]] = []
    pw_file = PDF_DIR / ".passwords.txt"
    if pw_file.exists():
        for line in pw_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line and not line.startswith(":"):
                hint, pw = line.split(":", 1)
                out.append((hint.strip() or None, pw))
            else:
                out.append((None, line))
    env = os.environ.get("PDF_PASSWORDS", "")
    for pw in (p.strip() for p in env.split(",") if p.strip()):
        out.append((None, pw))
    return out


def open_pdf(pdf_path: Path, passwords: list[tuple[str | None, str]]):
    """Open a PDF, trying each password candidate. Returns (pdf, password_used)."""
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect

    cache_file = CACHE_DIR / f"{pdf_path.stem}.password"
    known = cache_file.read_text(encoding="utf-8").strip() if cache_file.exists() else None

    candidates: list[str] = []
    if known is not None:
        candidates.append(known)
    name_lower = pdf_path.name.lower()
    hinted = [pw for (hint, pw) in passwords if hint and hint.lower() in name_lower]
    rest = [pw for (hint, pw) in passwords if not hint or hint.lower() not in name_lower]
    for pw in hinted + rest:
        if pw not in candidates:
            candidates.append(pw)
    candidates.append("")  # last resort: try no password

    last_err: Exception | None = None
    for pw in candidates:
        try:
            pdf = pdfplumber.open(pdf_path, password=pw)
            # Force-parse at least one page to surface a password error early.
            _ = len(pdf.pages)
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(pw, encoding="utf-8")
            return pdf, pw
        except PDFPasswordIncorrect as e:
            last_err = e
            continue
        except Exception as e:
            msg = str(e).lower()
            if "password" in msg or "encrypt" in msg:
                last_err = e
                continue
            raise
    raise RuntimeError(f"could not unlock {pdf_path.name}; last error: {last_err}")


def extract_text(pdf_path: Path, force: bool, passwords: list[tuple[str | None, str]]) -> str:
    cache_file = CACHE_DIR / f"{pdf_path.stem}.text.txt"
    if cache_file.exists() and not force:
        return cache_file.read_text(encoding="utf-8")

    pdf, pw_used = open_pdf(pdf_path, passwords)
    if pw_used:
        print(f"  unlocked with password of length {len(pw_used)}")
    pages: list[str] = []
    try:
        for i, page in enumerate(pdf.pages):
            try:
                text = page.extract_text() or ""
            except Exception as e:
                print(f"  page {i+1}: extract_text failed ({e})", file=sys.stderr)
                text = ""
            pages.append(f"\n=== PAGE {i+1} ===\n{text}")
    finally:
        pdf.close()

    full = "\n".join(pages).strip()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(full, encoding="utf-8")
    return full


def chunk_text(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    pages = re.split(r"(?=\n=== PAGE \d+ ===)", text)
    buf = ""
    for p in pages:
        if len(buf) + len(p) > max_chars and buf:
            chunks.append(buf)
            buf = p
        else:
            buf += p
    if buf:
        chunks.append(buf)
    return chunks


def call_claude(client, chunk: str, source_name: str) -> list[dict[str, Any]]:
    msg = client.messages.create(
        model=MODEL,
        max_tokens=16_000,
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {
                "role": "user",
                "content": (
                    f"Source guide: {source_name}\n\n"
                    f"--- PDF TEXT ---\n{chunk}\n--- END PDF TEXT ---\n\n"
                    "Extract all profiled prospects as JSON per the schema."
                ),
            }
        ],
    )
    raw = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    raw = raw.strip()
    # Strip accidental code fences.
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S)
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"  JSON parse error: {e}; first 300 chars: {raw[:300]!r}", file=sys.stderr)
        return []
    players = obj.get("players", []) if isinstance(obj, dict) else []
    return [p for p in players if isinstance(p, dict) and p.get("player_name")]


def normalize_pdf(client, src: Source, force: bool) -> list[dict[str, Any]]:
    cache_file = CACHE_DIR / f"{src.stem}.features.json"
    if cache_file.exists() and not force:
        return json.loads(cache_file.read_text(encoding="utf-8"))

    all_players: list[dict[str, Any]] = []
    chunks = chunk_text(src.text, MAX_CHUNK_CHARS)
    for i, chunk in enumerate(chunks):
        print(f"  chunk {i+1}/{len(chunks)} ({len(chunk):,} chars) -> {MODEL}")
        all_players.extend(call_claude(client, chunk, src.path.name))

    for p in all_players:
        p["source_file"] = src.path.name

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(all_players, indent=2), encoding="utf-8")
    return all_players


NAME_PUNCT = re.compile(r"[^\w\s]")


def normalize_name(name: str) -> str:
    n = NAME_PUNCT.sub(" ", name.lower())
    n = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()


def merge_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        grouped[normalize_name(r["player_name"])].append(r)

    merged: list[dict[str, Any]] = []
    for key, items in grouped.items():
        positions = [i.get("position") for i in items if i.get("position")]
        colleges = [i.get("college") for i in items if i.get("college")]
        ranks = [i["rank_overall"] for i in items if isinstance(i.get("rank_overall"), int)]
        prounds = [i["projected_round"] for i in items if isinstance(i.get("projected_round"), int)]

        def flat(key: str) -> list[str]:
            seen: set[str] = set()
            out: list[str] = []
            for i in items:
                for v in i.get(key) or []:
                    v = str(v).strip()
                    if v and v.lower() not in seen:
                        seen.add(v.lower())
                        out.append(v)
            return out

        merged.append({
            "player_key": key,
            "player_name": items[0]["player_name"],
            "position": max(set(positions), key=positions.count) if positions else None,
            "college": max(set(colleges), key=colleges.count) if colleges else None,
            "sources": sorted({i["source_file"] for i in items}),
            "n_sources": len({i["source_file"] for i in items}),
            "rank_overall_min": min(ranks) if ranks else None,
            "rank_overall_mean": round(sum(ranks) / len(ranks), 1) if ranks else None,
            "rank_overall_max": max(ranks) if ranks else None,
            "projected_round_mean": round(sum(prounds) / len(prounds), 2) if prounds else None,
            "tiers": [i["tier"] for i in items if i.get("tier")],
            "comps": flat("comps"),
            "strengths": flat("strengths"),
            "weaknesses": flat("weaknesses"),
            "red_flags": flat("red_flags"),
            "summaries": [i["summary"] for i in items if i.get("summary")],
        })

    merged.sort(key=lambda r: (r["rank_overall_mean"] is None, r["rank_overall_mean"] or 9999))
    return merged


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Extract text only, skip LLM normalization")
    ap.add_argument("--force", action="store_true", help="Ignore caches and re-extract/re-normalize")
    args = ap.parse_args()

    if not PDF_DIR.exists():
        print(f"error: {PDF_DIR} does not exist. Create it and drop PDFs there.", file=sys.stderr)
        return 1

    pdfs = sorted(PDF_DIR.glob("*.pdf"))
    if not pdfs:
        print(f"error: no .pdf files in {PDF_DIR}", file=sys.stderr)
        return 1

    print(f"Found {len(pdfs)} PDF(s) in {PDF_DIR}")

    passwords = load_passwords()
    if passwords:
        print(f"Loaded {len(passwords)} password candidate(s)")

    sources: list[Source] = []
    for pdf_path in pdfs:
        print(f"extracting text: {pdf_path.name}")
        text = extract_text(pdf_path, args.force, passwords)
        if not text.strip():
            print(f"  warning: no text extracted (scanned PDF? OCR not wired up)")
            continue
        sources.append(Source(path=pdf_path, text=text))

    if args.dry_run:
        print("dry-run: skipping LLM normalization")
        return 0

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("error: ANTHROPIC_API_KEY not set", file=sys.stderr)
        return 1

    import anthropic
    client = anthropic.Anthropic()

    all_rows: list[dict[str, Any]] = []
    for src in sources:
        print(f"normalizing: {src.path.name}")
        rows = normalize_pdf(client, src, args.force)
        print(f"  -> {len(rows)} player rows")
        all_rows.extend(rows)

    OUT_PER_SOURCE.parent.mkdir(parents=True, exist_ok=True)
    OUT_PER_SOURCE.write_text(json.dumps(all_rows, indent=2), encoding="utf-8")
    print(f"wrote {len(all_rows)} rows -> {OUT_PER_SOURCE.relative_to(ROOT)}")

    merged = merge_rows(all_rows)
    OUT_MERGED.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    print(f"wrote {len(merged)} merged players -> {OUT_MERGED.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
