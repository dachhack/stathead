# PDF Prospect-Guide Feature Pipeline

Turns password-protected draft/rookie PDFs (e.g. The Beast) into structured
per-player features (ranks, tiers, comps, strengths/weaknesses, red flags,
analyst summary) and ships the result as JSON in `public/data/`.

Runs **entirely locally** using your Claude Code subscription — no
Anthropic API spend, no GitHub Actions runtime, no PDFs ever leave your
machine. Raw PDFs and the intermediate text/feature caches all live under
`pdfs/`, which is gitignored.

## One-time setup

```bash
git clone https://github.com/dachhack/stathead.git ~/stathead
cd ~/stathead
npm install -g @anthropic-ai/claude-code   # if not already installed
pip3 install -r scripts/requirements-pdf.txt
mkdir -p pdfs
```

Drop your PDFs into `~/stathead/pdfs/`. Filenames should contain a year
hint (e.g. `2024_beast.pdf`) so the password matcher knows which password
to try first.

Create `~/stathead/pdfs/.passwords.txt` (also gitignored — never committed):

```
2022:Bea$t2022!
2023:Bea$stguide2023!
2024:*TH3*B3A$T*2024*
2025:Th3!Be@$T!#2025
2026:thebeast2026!
```

Each line is `<hint>:<password>` where `<hint>` is a substring of the
filename. Lines without a colon are tried against every PDF.

## Running the pipeline

```bash
cd ~/stathead
claude
```

In the Claude Code session:

```
/extract-pdf-features
```

That single command:
1. Decrypts each PDF and dumps text to `pdfs/.cache/<stem>.text.txt`
   (calls `scripts/extract_pdf_features.py`).
2. For every uncached text file, extracts per-player features into
   `pdfs/.cache/<stem>.features.json` using your subscription.
3. Merges all per-PDF features into the two committed outputs
   (calls `scripts/merge_pdf_features.py`):
   - `public/data/pdf-prospect-features.json` — one row per (player, source)
   - `public/data/pdf-prospect-features-merged.json` — one row per player

Subsequent runs are cheap: any PDF whose `.features.json` already exists
in the cache is skipped. To force a reprocess, delete the relevant
`pdfs/.cache/<stem>.features.json` (or the whole cache dir) and rerun.

## Just text extraction (no Claude)

If you only want to inspect the decrypted text without running the LLM
pass, the underlying Python script works standalone:

```bash
python3 scripts/extract_pdf_features.py          # decrypt + cache text
python3 scripts/extract_pdf_features.py --force  # ignore cache
```

Then read `pdfs/.cache/*.text.txt` directly.

## Output schema

`public/data/pdf-prospect-features.json` — one row per (player, source PDF):

```json
{
  "player_name": "Travis Hunter",
  "position": "WR",
  "college": "Colorado",
  "rank_overall": 2,
  "rank_position": 1,
  "tier": "Elite",
  "projected_round": 1,
  "comps": ["Sauce Gardner", "Tyreek Hill"],
  "strengths": ["ball skills", "two-way usage"],
  "weaknesses": ["slight frame"],
  "red_flags": [],
  "athletic_notes": "4.38 forty, 35\" vert",
  "summary": "Rare two-way talent; WR upside is the tiebreaker.",
  "confidence": "high",
  "source_file": "2025_beast.pdf"
}
```

`public/data/pdf-prospect-features-merged.json` — one row per player,
aggregated across every PDF that profiles them (min/mean/max overall rank,
deduped comps/strengths/weaknesses, all summaries preserved).

## Files in this pipeline

| Path | Role |
|---|---|
| `scripts/extract_pdf_features.py` | Decrypts PDFs, dumps text to cache. No LLM. |
| `scripts/merge_pdf_features.py` | Combines per-PDF features into public JSON outputs. No LLM. |
| `.claude/commands/extract-pdf-features.md` | Slash command that orchestrates the full pipeline using your Claude Code subscription. |
| `scripts/requirements-pdf.txt` | Python deps (pdfplumber + pypdf). No `anthropic` SDK — by design. |
| `pdfs/` | Your raw PDFs. Gitignored. |
| `pdfs/.passwords.txt` | Your passwords. Gitignored. |
| `pdfs/.cache/` | Decrypted text + per-PDF feature JSONs. Gitignored. |
