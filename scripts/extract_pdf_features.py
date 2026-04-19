#!/usr/bin/env python3
"""Decrypt password-protected prospect PDFs and dump plain text to a cache dir.

This is the first stage of the PDF feature pipeline. It does NOT call any
LLM API; the normalization/feature-extraction step runs via a Claude Code
slash command (see .claude/commands/extract-pdf-features.md) which uses
your Claude subscription instead of paid API tokens.

Walks every *.pdf in ./pdfs/ (gitignored), tries each password in
./pdfs/.passwords.txt until one works, and writes:

    pdfs/.cache/<stem>.text.txt     plain text, page-delimited
    pdfs/.cache/<stem>.password     which password unlocked the file

Reruns are cheap: files already cached are skipped unless --force.

Usage:
  pip3 install -r scripts/requirements-pdf.txt
  python3 scripts/extract_pdf_features.py
  python3 scripts/extract_pdf_features.py --force

Password file format (./pdfs/.passwords.txt):
  Each line is either "<password>" or "<hint>:<password>" where <hint> is
  a case-insensitive substring of the filename that signals which password
  to try first (e.g. "2024:mypw"). You can also pass a comma-separated
  list via the PDF_PASSWORDS env var.

Optional extraction context (./pdfs/.extraction-context.md):
  If present, the slash command appends its contents to the LLM prompt
  as additional guidance (e.g. position-code conventions, tier meanings
  specific to your guides). This script doesn't use the file directly,
  but reports its presence and content-hash so you can confirm the
  slash command will pick it up. Editing the file changes the hash and
  causes /extract-pdf-features to invalidate per-PDF feature caches.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PDF_DIR = ROOT / "pdfs"
CACHE_DIR = PDF_DIR / ".cache"
CONTEXT_FILE = PDF_DIR / ".extraction-context.md"


def load_passwords() -> list[tuple[str | None, str]]:
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


def context_hash() -> str | None:
    """Short SHA-256 of pdfs/.extraction-context.md, or None if absent/empty."""
    if not CONTEXT_FILE.exists():
        return None
    raw = CONTEXT_FILE.read_text(encoding="utf-8").strip()
    if not raw:
        return None
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]


def open_pdf(pdf_path: Path, passwords: list[tuple[str | None, str]]):
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


def extract_text(pdf_path: Path, force: bool, passwords: list[tuple[str | None, str]]) -> int:
    cache_file = CACHE_DIR / f"{pdf_path.stem}.text.txt"
    if cache_file.exists() and not force:
        return len(cache_file.read_text(encoding="utf-8"))

    pdf, pw_used = open_pdf(pdf_path, passwords)
    if pw_used:
        print(f"  unlocked with password of length {len(pw_used)}", flush=True)
    pages: list[str] = []
    try:
        for i, page in enumerate(pdf.pages):
            try:
                text = page.extract_text() or ""
            except Exception as e:
                print(f"  page {i+1}: extract_text failed ({e})", file=sys.stderr, flush=True)
                text = ""
            pages.append(f"\n=== PAGE {i+1} ===\n{text}")
    finally:
        pdf.close()

    full = "\n".join(pages).strip()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(full, encoding="utf-8")
    return len(full)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--force", action="store_true", help="Ignore caches and re-extract text")
    args = ap.parse_args()

    if not PDF_DIR.exists():
        print(f"error: {PDF_DIR} does not exist. Create it and drop PDFs there.", file=sys.stderr)
        return 1

    pdfs = sorted(PDF_DIR.glob("*.pdf"))
    if not pdfs:
        print(f"error: no .pdf files in {PDF_DIR}", file=sys.stderr)
        return 1

    print(f"Found {len(pdfs)} PDF(s) in {PDF_DIR}", flush=True)
    passwords = load_passwords()
    if passwords:
        print(f"Loaded {len(passwords)} password candidate(s)", flush=True)

    ch = context_hash()
    if ch:
        print(
            f"Found extraction context ({CONTEXT_FILE.name}, hash {ch}) — "
            "/extract-pdf-features will append it to the LLM prompt and use "
            "this hash to invalidate stale per-PDF feature caches.",
            flush=True,
        )

    missing = 0
    for pdf_path in pdfs:
        print(f"extracting: {pdf_path.name}", flush=True)
        try:
            n = extract_text(pdf_path, args.force, passwords)
        except Exception as e:
            print(f"  FAILED: {e}", file=sys.stderr, flush=True)
            missing += 1
            continue
        if n == 0:
            print(f"  warning: 0 chars extracted (scanned PDF? OCR not wired up)", flush=True)

    print(flush=True)
    print(f"Text caches written to {CACHE_DIR.relative_to(ROOT)}/", flush=True)
    print("Next: in this repo, run `claude` and invoke /extract-pdf-features", flush=True)
    print("      (uses your Claude subscription, not the paid API).", flush=True)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
