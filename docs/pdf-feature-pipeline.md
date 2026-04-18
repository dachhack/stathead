# PDF Prospect-Guide Feature Pipeline

Turns password-protected draft/rookie PDFs into structured per-player features
(ranks, tiers, comps, strengths/weaknesses, red flags, analyst summary) and
ships the result as JSON in `public/data/`.

Raw PDFs never enter the public repo. They live in a private companion repo,
and a GitHub Action in this repo pulls them, runs extraction, and commits only
the derived features.

## Architecture

```
dachhack/stathead-pdfs     (PRIVATE)      dachhack/stathead         (PUBLIC)
----------------------                    ----------------------
pdfs/                                     .github/workflows/
  2024_beast.pdf                            extract-pdf-features.yml
  2025_beast.pdf                          scripts/
  ...                                       extract_pdf_features.py
                                          public/data/
      drop PDF --->  [dispatch event] ---> pdf-prospect-features.json
                                           pdf-prospect-features-merged.json
```

## One-time setup

### 1. Create the private companion repo

On GitHub: **New repository** -> name `stathead-pdfs`, visibility **Private**.
Clone it, add a `pdfs/` folder at the root, put your PDFs there, commit, push.

### 2. Secrets on THIS repo (`dachhack/stathead`)

Settings -> Secrets and variables -> Actions -> New repository secret:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `PDFS_REPO_PAT` | fine-grained PAT with `contents: read` on `dachhack/stathead-pdfs` only |
| `PDF_PASSWORDS_FILE` | multi-line secret, one entry per line, in `<hint>:<password>` form, e.g. `2024:*TH3*B3A$T*2024*` |

`PDF_PASSWORDS_FILE` is written verbatim into `pdfs/.passwords.txt` at runtime.
The `<hint>` part is a case-insensitive substring the extractor looks for in
each filename to decide which password to try first (e.g. a year). Any line
without a colon is tried against every PDF.

### 3. Auto-trigger from the private repo (optional but handy)

In `dachhack/stathead-pdfs`, create `.github/workflows/notify-public.yml`:

```yaml
name: Notify public repo on PDF change
on:
  push:
    paths: ['pdfs/**']
  workflow_dispatch:

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Fire repository_dispatch
        env:
          TOKEN: ${{ secrets.PUBLIC_DISPATCH_PAT }}
        run: |
          curl -sSf -X POST \
            -H "Authorization: token $TOKEN" \
            -H "Accept: application/vnd.github+json" \
            https://api.github.com/repos/dachhack/stathead/dispatches \
            -d '{"event_type":"pdfs-updated"}'
```

Add secret `PUBLIC_DISPATCH_PAT` to the private repo: fine-grained PAT with
`contents: write` on `dachhack/stathead` (write is required to fire
`repository_dispatch`).

## Normal operation

1. Drop a new PDF into the private repo's `pdfs/` folder (GitHub web UI works).
2. The private repo's notify workflow fires `repository_dispatch: pdfs-updated`.
3. This repo's `Extract PDF Prospect Features` workflow runs, pulls PDFs, runs
   `scripts/extract_pdf_features.py`, and commits updated
   `public/data/pdf-prospect-features{,-merged}.json`.
4. Unchanged PDFs hit the Actions cache and skip the LLM pass, so incremental
   runs typically cost one Claude call per *new* guide.

To run on demand: Actions -> Extract PDF Prospect Features -> Run workflow.

## Running locally (no GitHub)

Put PDFs in `./pdfs/`, write `./pdfs/.passwords.txt`, then:

```bash
pip install -r scripts/requirements-pdf.txt
export ANTHROPIC_API_KEY=sk-ant-...
python3 scripts/extract_pdf_features.py --dry-run   # text only
python3 scripts/extract_pdf_features.py             # full pipeline
python3 scripts/extract_pdf_features.py --force     # ignore caches
```

## Output schema

`public/data/pdf-prospect-features.json` -- one row per (player, source PDF):

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

`public/data/pdf-prospect-features-merged.json` -- one row per player,
aggregated across every PDF that profiles them (min/mean/max overall rank,
deduped comps/strengths/weaknesses, all summaries preserved).
