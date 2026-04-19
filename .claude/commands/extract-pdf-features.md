---
description: Extract per-player prospect features from cached PDF text (uses your Claude subscription, not the API)
allowed-tools: Read, Write, Glob, Bash
---

You are running the prospect-guide feature extraction pipeline. This command processes PDF text caches written by `scripts/extract_pdf_features.py` and turns each guide into structured per-player JSON.

## Step 1: make sure text caches exist

Run `python3 scripts/extract_pdf_features.py` via Bash. It decrypts every PDF in `pdfs/` and writes `pdfs/.cache/*.text.txt`. If it errors (missing deps, no PDFs, bad password), surface the error to the user and stop.

## Step 2: process each text cache

Use Glob to list `pdfs/.cache/*.text.txt`. For each text file:

- Compute the corresponding features path: `pdfs/.cache/<stem>.features.json` where `<stem>` is the filename without `.text.txt`.
- If that features file already exists, skip this PDF (it's already been processed). Tell the user "skip <stem>: cached".
- Otherwise:
  1. Read the text file in full (it may be large; chunk via the Read tool's offset/limit if needed).
  2. Extract every distinct NFL draft prospect that gets a real write-up, ranking, or tier — see schema below.
  3. Write the result as a JSON array (NOT wrapped in `{"players": ...}`) to `pdfs/.cache/<stem>.features.json` using the Write tool.

## Step 3: merge into public outputs

Once every PDF has a `.features.json` file, run `python3 scripts/merge_pdf_features.py` via Bash. It produces:

- `public/data/pdf-prospect-features.json` — one row per (player, source)
- `public/data/pdf-prospect-features-merged.json` — one row per player, aggregated across all guides

Report the row counts to the user.

## Extraction schema

Every prospect is one JSON object:

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
  "confidence": "high"
}
```

Field rules:
- `position`: one of `QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|ATH`. Map "Running Back" → `RB`, "Edge"/"EDGE" → `DL`, "Defensive Back" → `CB` or `S` if specified.
- `rank_overall`: integer overall rank in this guide if explicitly given; otherwise `null`.
- `rank_position`: integer positional rank if explicitly given.
- `tier`: free-form string ("Tier 1", "Round 2 grade", "Day 3 flier"); `null` if absent.
- `projected_round`: integer 1-7 if a round projection is given.
- `comps`: NFL player comparisons mentioned in the write-up.
- `strengths`/`weaknesses`/`red_flags`: short phrases (2-6 words), not full sentences. `red_flags` is for injury, character, scheme-fit concerns.
- `athletic_notes`: short prose about testing/measurables.
- `summary`: 1-2 sentence analyst take. May be a tight paraphrase but should preserve the verdict.
- `confidence`: `"high"` if the player has a full profile, `"medium"` if just a tier+blurb, `"low"` if just a ranking with one sentence.

Hard rules:
- Use `null` (not `""`) for missing scalars. Use `[]` for missing lists.
- Never invent data. If a field isn't in the text, it's `null`.
- Skip name-only mentions. Only include players with a dedicated write-up, tier, or ranking.
- Preserve diacritics in names (don't Americanize).
- If a player appears multiple times in the same guide (table + profile), emit ONE row that combines both.
- Output the JSON array only — no markdown fences, no commentary in the file.

## Pitfalls and notes

- The Beast / similar guides can have 300-500 player profiles. Be exhaustive, but don't pad with speculation.
- If a text file is empty or visibly garbled (random characters, no recognizable names), skip it and tell the user — that PDF was likely scanned image-only and needs OCR (not yet wired up).
- Do not modify files outside `pdfs/.cache/` and `public/data/` (the script handles the rest).
- After every batch of PDFs you process, briefly summarize: "Processed N PDFs, M players extracted."
