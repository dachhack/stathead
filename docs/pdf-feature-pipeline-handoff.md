# Handoff: set up the PDF feature extraction pipeline

**Goal:** get the GitHub Action on `dachhack/stathead` running so that PDFs dropped into a new private repo automatically turn into structured prospect features committed back to the public repo.

**Estimated time:** 20 minutes (most of it waiting for GitHub to do things).

## What you're setting up

```
dachhack/stathead-pdfs (PRIVATE)           dachhack/stathead (PUBLIC)
----------------------------               --------------------------
pdfs/  <-- drop PDFs here                  public/data/
  2024_beast.pdf                             pdf-prospect-features.json
  2025_beast.pdf    --dispatch event-->      pdf-prospect-features-merged.json
  ...                                      .github/workflows/extract-pdf-features.yml  (already exists)
.github/workflows/notify-public.yml
  (you will create this)
```

The workflow and the extraction script are already in `dachhack/stathead` on branch `claude/extract-pdf-features-cld2A`. You don't need to write code; you're wiring up repos, secrets, and tokens.

## Prerequisites

You need:
- Write access to `dachhack/stathead` and ability to create repos in `dachhack`
- Ability to add repository secrets on both repos
- An Anthropic API key (ask Matt for `ANTHROPIC_API_KEY`)
- The five PDF passwords (ask Matt)

## Steps

### 1. Create the private companion repo

1. Go to https://github.com/new
2. Owner: `dachhack` · Name: `stathead-pdfs` · Visibility: **Private** · Initialize with a README
3. In the new repo, create a folder named `pdfs` (via **Add file -> Create new file**, enter `pdfs/.gitkeep` as the path, commit)
4. Upload the 5 password-protected PDFs into `pdfs/` (**Add file -> Upload files**, drag them in, commit). File names should contain the year (e.g. `2024_beast.pdf`) so the workflow knows which password to try.

### 2. Create two fine-grained personal access tokens

GitHub -> click your avatar -> **Settings** -> **Developer Settings** -> **Personal access tokens** -> **Fine-grained tokens** -> **Generate new token**.

**Token A: lets the public repo read the private repo**
- Name: `stathead-pdfs-read`
- Expiration: 1 year
- Resource owner: `dachhack`
- Repository access: **Only select repositories** -> pick `stathead-pdfs`
- Repository permissions: **Contents -> Read-only**
- Generate and copy the token value (starts with `github_pat_`)

**Token B: lets the private repo trigger the public repo**
- Name: `stathead-dispatch`
- Expiration: 1 year
- Resource owner: `dachhack`
- Repository access: **Only select repositories** -> pick `stathead`
- Repository permissions: **Contents -> Read and write**
- Generate and copy the token value

### 3. Add secrets on `dachhack/stathead` (public repo)

Go to `dachhack/stathead` -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**. Add three secrets:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the Claude API key Matt gave you |
| `PDFS_REPO_PAT` | Token A (`github_pat_...`) |
| `PDF_PASSWORDS_FILE` | the multi-line block below, pasted verbatim |

Paste this exactly as the value of `PDF_PASSWORDS_FILE` (newlines matter):
```
2022:Bea$t2022!
2023:Bea$stguide2023!
2024:*TH3*B3A$T*2024*
2025:Th3!Be@$T!#2025
2026:thebeast2026!
```

### 4. Add a secret on `dachhack/stathead-pdfs` (private repo)

Same menu (Settings -> Secrets -> Actions -> New repository secret):

| Name | Value |
|---|---|
| `PUBLIC_DISPATCH_PAT` | Token B (`github_pat_...`) |

### 5. Add the notify workflow to the private repo

In `dachhack/stathead-pdfs`, create file `.github/workflows/notify-public.yml` with this exact content:

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

Commit to `main`.

### 6. Merge the feature branch on the public repo

The extraction workflow lives on branch `claude/extract-pdf-features-cld2A`. It has to be on `main` to respond to `repository_dispatch` events.

1. Go to https://github.com/dachhack/stathead/pull/new/claude/extract-pdf-features-cld2A
2. Title: `Add PDF prospect feature extraction pipeline`
3. Create PR, confirm with Matt, merge.

### 7. Kick off the first run

Option A (manual, fastest):
- `dachhack/stathead` -> **Actions** tab -> **Extract PDF Prospect Features** (left sidebar) -> **Run workflow** -> branch `main` -> **Run workflow**

Option B (end-to-end test):
- Make any trivial edit to a file under `pdfs/` in the private repo and commit. The notify workflow should fire, which triggers the public workflow.

### 8. Verify success

In the **Actions** tab of `dachhack/stathead`:
- The `Extract PDF Prospect Features` run should finish green (2–8 minutes depending on PDF count).
- Step `Commit feature JSON` should show either "No feature changes to commit" or a new commit hash.
- After a successful run, check `public/data/pdf-prospect-features.json` and `public/data/pdf-prospect-features-merged.json` exist at repo root on `main`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `could not unlock <file>.pdf` in logs | Filename doesn't contain the year, or password for that year is wrong | Rename the PDF to include `2024`/`2025`/etc., or double-check the password block in `PDF_PASSWORDS_FILE` |
| `.stathead-pdfs/pdfs directory not found` | Private repo doesn't have a `pdfs/` folder, or `PDFS_REPO_PAT` doesn't grant contents:read | Verify folder exists; regenerate token A with correct scope |
| Private repo push runs its notify workflow but public workflow never fires | `PUBLIC_DISPATCH_PAT` is wrong scope or expired | Regenerate token B with **Contents: Read and write** on `dachhack/stathead` |
| `ANTHROPIC_API_KEY` error in extract step | Secret missing or malformed | Re-add secret; key should start with `sk-ant-` |
| Run succeeds but feature JSON is empty | PDFs are scanned images rather than text | Tell Matt — we'll need to add an OCR fallback |

## Handing back

Once the pipeline is green and the JSON files are committed, Slack Matt:
- Screenshot of a successful run
- Link to the resulting commit on `main`

He'll take it from there.

## Reference

Full technical docs: `docs/pdf-feature-pipeline.md` on `main` (merged from `claude/extract-pdf-features-cld2A`).
