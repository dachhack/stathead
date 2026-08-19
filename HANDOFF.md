# StatHead — session handoff

Last updated 2026-08-19 (season-prep data audit). **Resume section directly below;** older notes follow.

---

## ⚡ Session wrap (2026-08-19, season prep — `claude/adp-season-prep-h0vwwy`)

Asked to refresh ADP and prep for the season. ADP itself turned out to be
fine — every fetch workflow (KTC 06:00, FantasyCalc 06:30, Sleeper 06:45,
FFC 07:00, buzz every 8h, Refresh Data every 2h) has been green for days
and had already run. So the work became an audit of what the automation
would get *wrong* at kickoff. Four things, all now fixed.

**1. Next Gen Stats were wrong in both directions.** nflverse only shards
`nextgen_stats/ngs_<season>_<type>.csv.gz` for seasons that are closed
out — those exist through **2024** and 404 for 2025/2026. The file that
stays current is the un-suffixed `ngs_<type>.csv.gz`, which holds **every
season from 2016 on** (14,731 receiving rows today). `download-data.sh`
was piping that whole thing into `ngs_2025_<type>.csv`, so:

- `fetchNextGenStats(2025)` returned all 14,731 rows, 2016–2025;
- `fetchNextGenStats(2026)` 404'd on the year-suffixed URL, fell through
  to the same all-seasons file, and returned those 14,731 rows too;
- callers key NGS by player name (`buildFeatureMatrix`,
  `indexNGSByPlayer`), so a player who last played in 2021 silently
  carried 2021 separation/cushion into the 2026 projection;
- at Week 1 the release starts including 2026, which would have
  overwritten `ngs_2025_*` with 2026 rows.

`download-data.sh` now downloads each type once and splits it on the
`season` column into real per-season files (verified: 10 seasons × 3
types, row counts matching the source exactly). One download replaces
ten, and 2026 gets its file for free as soon as Week 1 is charted — no
yearly bump. `fetchNextGenStats` filters every path to the season asked
for as a belt-and-braces guard, since the non-prod fallback can still
resolve to the multi-season file. A harness against live nflverse
confirmed the before/after: baseline returned 2016–2025 for a 2025
request and all 14,731 rows for 2026; after, each season returns only its
own rows and 2026 correctly returns 0 until it's charted.
`pull-all-data-sources.sh` had the same bug plus a wrong path (it fetched
`ngs_<stat>.csv`, which doesn't exist — nflverse only publishes `.csv.gz`),
so it never got NGS at all; same split applied.

**2. 2025 was missing from every heavier source.** The season lists for
PFR advanced stats, FTN charting, play-by-play and participation all
stopped at **2024**, though 2025 is published upstream for all four. So
the deployed Play-by-Play view, `get_play_by_play(2025)`,
`get_advanced_stats(2025)` and `get_ftn_charting(2025)` were all fetching
`/data/..._2025.csv` files that the build never downloaded. Those lists
are now `DERIVED_SEASONS` / `FTN_SEASONS` variables (bump once a year)
plus a current-season fetch on top that tolerates a pre-Week-1 404, so
2026 populates itself in September. The static fetches also moved from
`curl -sL -o` to a `fetch_optional` helper (`-sfL` + temp file), because
the old form wrote GitHub's 404 HTML into the `.csv` and the `[ -f ]`
guard then skipped it forever. 2025 PBP is 93 MB vs 2024's 95 MB, so it
sits comfortably inside the Pages per-asset cap that 2024 already clears.

**3. In-season snapshots were never committed.** `refresh-data.yml`
re-gzipped only `roster_2026` and `depth_charts_2026`. From Week 1 the
MCP server (which reads committed files from GitHub raw), the Python
package and local dev would have seen **no 2026 player stats, snap counts
or injuries at all** — only the deployed site would have had them, since
it builds from the fresh CSVs. Those three are now gzipped and committed
alongside, skipped with a log line until they exist upstream (they 404
today, as expected pre-season).

While there: the cache-commit step's `git add a b c ...` **stages nothing
at all** if any single pathspec matches no file (verified: `fatal:
pathspec ... did not match any files`, exit 128, empty index). The `||
true` swallowed it, so one missing artifact would have silently killed
every cache commit — and adding the three in-season paths above would
have triggered exactly that until September. Now staged one path at a
time behind an `[ -e ]` test.

**4. ESPN was a dead ADP source.** `download-api-data.sh` snapshotted
ESPN with `view=players_wl`, which returns all 11,612 players but omits
`ownership` and `draftRanksByRankType` — so `parseEspnResponse` gave
every row `adp: 0`, and `adpSources.loadEspn`, which filters `adp > 0`,
contributed **zero entries** to the consensus board. It was also still
pinned to `season 2025`. The ADP fields only come back under
`view=kona_player_info`, which is ~39 MB (the endpoint ignores the
filter's `limit`) — too big to ship and over the 25 MiB Pages cap. New
`scripts/fetch-espn-adp.mjs` fetches that view, keeps only players with a
real ADP and only the fields the parser reads, and writes ~730 KB. Live
check: 2,616 players with ADP → 1,027 parsed → **937 skill players now
reach the blend**, board topped by Gibbs 1.52 / Bijan 2.59 / Chase 4.25,
which matches the market. `CURRENT_SEASON` is now one variable at the top
of that script driving both ESPN and FFC.

### Verified

`tsc -b` and `tsc -p tsconfig.app.json --noEmit` clean; `eslint` on the
touched files clean (the repo has ~400 pre-existing lint errors elsewhere,
unchanged); `pytest python/tests` 29 passed / 2 skipped (needs
`pip install duckdb` for 3 of them); `bash -n` on all four shell scripts;
a trimmed end-to-end run of `download-data.sh` against live nflverse
(NGS split correct, 2025 advstats + FTN landed, no stray `.tmp` or
404-HTML files, 2026 assets logged as unavailable); and the two live
harnesses described above.

### Follow-up in the same session: stale MCP projections

A downstream MCP consumer reported "projections not refreshed since
2026-04-12". Accurate, and worse than a stale label.

`get_projections` (no preset) served `redraft-projections.json` —
`generatedAt: "2026-04-12"`, a **hand-built static spine**, not a pipeline
output. It's actually an *input*: `scripts/build-projection-pool.ts` reads it
to gap-fill players the ML doesn't score, which is exactly why regenerating it
from the pool is not an option (it would close a feedback loop). Meanwhile the
real pool, `projection-base-2026.json`, is rebuilt by `build:pool` on every
refresh run (04:19 today) and is what `get_weekly_projections` and the site's
Projections tab already read. The two disagreed materially:

| player | get_projections (April) | live pool |
| --- | --- | --- |
| Jahmyr Gibbs | 21.1 | 25.9 |
| Ja'Marr Chase | 20.7 | 18.1 |
| Brock Bowers | 15.0 | 13.9 |

Three more surfaces read the same stale file: `export_excel kind=projections`
(shipping an April board into a workbook), `import_excel`'s "changed vs
StatHead" diff (diffing against April), and `get_sleeper_waiver_wire`'s
projected-PPG column.

Fixed in `mcp/dist/server.mjs` (which `src/mcp-server.ts` documents as the
hand-maintained source of truth since 1.0.16 — `src/tools.ts` is deliberately
frozen at the 1.0.15 toolset, so its 30 tools vs the bundle's 47 is expected,
not drift). Added `projectionBaseToRows()` + a single `statheadProjectionPool()`
accessor: season base first, static spine as fallback, returned in the shape the
old file had so all four call sites swap cleanly. `ppg = pprPts/games`,
`recPG = rec/games`, skipping rows with no team or no projected games/points —
copied from `scripts/build-weekly-projections.py` so the season and weekly tools
now agree *by construction*.

Verified against live data by importing the bundle with the Worker runtime
spoofed (`navigator.userAgent = 'Cloudflare-Workers'`, else the stdio server
starts and hangs): `get_projections` now reports `as_of 2026-08-19T04:19:40Z`
over 127 RBs — same pool size and same Gibbs 25.9 as `get_weekly_projections`;
`export_excel` writes the live board; the `consensus` preset path is untouched;
and serving a data base *without* `projection-base-2026.json` over a local HTTP
server still falls back to the April file exactly as before.

**MCP bumped 1.0.63 → 1.0.64** (bundle `SERVER_VERSION` + `mcp/package.json`).
1.0.63 *is* published on npm — STATUS.md's "not yet published" note was wrong —
so this needs a `publish-mcp.yml` dispatch or npx clients keep the old
behaviour. `mcp/server.json` is still pinned at 1.0.46; it looked
deliberately-lagging so I left it.

### Also found: the refresh cache never updates

The 04:14 run's log ends with `Cache hit occurred on the primary key
static-data-v4, not saving cache.` actions/cache only writes a new entry when
the **primary** key misses, so a constant key freezes the cache at whatever was
first saved — every file added to `download-data.sh` after that point is
re-downloaded on every run (every 2 hours) and never cached. Bumped to
`static-data-v5`; the `static-data-` restore-keys prefix still restores v4, so
only the genuinely-new files download once before the v5 cache is written.

The same run also showed `Build projection base + presets` completing in **2
seconds** — enough for `build:pool` alone, confirming `CLAY_PROJECTIONS_B64` is
unset and `build:presets` is being skipped. That's why the `consensus` preset
still reports `as_of 2026-06-16`. Setting the secret is the only fix; nothing in
the repo can regenerate it.

### Publish guard

The 1.0.64 publish first failed with `E403 ... cannot publish over the
previously published versions: 1.0.63` — because the workflow was dispatched
from `claude/nfl-fantasy-workbench-6D1yd`, which doesn't carry the bump, so npm
was correctly told to publish 1.0.63 again. The run got all the way through
install + bundle + smoke test before finding out.

Both publish workflows (`publish-mcp.yml`, `npm-publish-token.yml`) now run a
`Verify the version is releasable` step right after checkout that fails with a
plain-English error when either (a) the version in `mcp/package.json` is already
on npm — naming the ref it was dispatched from, since that's the usual cause —
or (b) `mcp/package.json` and the bundle's hand-maintained `SERVER_VERSION`
disagree, which would ship a server reporting a version npm never served. An
empty `npm view` (registry hiccup) falls through to npm's own check rather than
blocking a legitimate release. Verified both ways: the guard's logic fails on
the dev branch's 1.0.63 tree and passes on 1.0.64.

Worth knowing: `GITHUB_RAW_DATA_BASE` in the bundle is pinned to the dev branch,
so a published server reads dev-branch data no matter which branch it was
published from.

### get_metadata: projection-freshness caveats (1.0.65)

Downstream feedback framed the projections as "an April view" and pointed at a
hand-baked `proj2026.ts` on their side (neither that file nor their "auto-slot"
exists in this repo). Their read was fair before 1.0.64, but the diagnosis
conflated the stale *artifact* with the model. Checking what actually moves,
diffing the score-store shards across 2026-08-16 → 08-18:

| shard | changed predictions/day | driver |
| --- | --- | --- |
| `adp.json` (VOR / hit-bust) | 256–313 | FFC ADP, moves daily |
| `shares.json` (target/rush share) | 107–125 | depth-chart churn |
| `ppg.json` (ADP-free PPG) | **0** | — |

The PPG core really is static — but correctly so, not frozen: all 58 of its
features are prior-season production, combine, draft slot or age
(`priorPPG`, `priorPPG2yr`, `priorTargetShare`, `priorRecEPA`, `forty`, `age`
…), none of which change between two August days. It starts moving when
in-season stats land. So "unchanged overnight" is the expected preseason
signature of that model, and reads as a stalled feed only if you don't know it's
ADP-free by design.

Added two bullets to `get_metadata`'s "Analytic caveats" section saying exactly
that: read `as_of` rather than caching a board (the pool rebuilds ~2-hourly and
ADP/depth move daily), and don't infer a stalled pipeline from an unchanged PPG,
because the three models feeding the pool move on different clocks. Bumped to
**1.0.65 — needs publishing**; verified the rendered section, the new publish
guard against this tree, and the workflow's own smoke test (boots as 1.0.65,
50 tools).

### Small-denominator ppg: backups outranking starters (1.0.65)

The downstream team came back with a real bug, and it's one this session widened:
`ppg` is `pprPts / games`, and the pool projects backups for **one game**, so a
one-game line divided by one reads as an elite per-game rate. Confirmed straight
from `projection-base-2026.json`:

| player | team | games | pprPts | ppg |
| --- | --- | --- | --- | --- |
| Nick Mullens | JAX | **1** | 21 | 21.00 |
| Joe Milton III | DAL | **1** | 19 | 19.00 |
| Trey Lance | LAC | **1** | 19 | 19.00 |
| Trevor Lawrence | JAX | 16 | 310 | 19.38 |
| Lamar Jackson | BAL | 14 | 232 | 16.57 |

It inverts within a team, which is what makes it an artifact rather than a
claim. It predates this session in `get_weekly_projections` (the weekly builder
has always divided the same way), but pointing `get_projections` at the pool
in 1.0.64 propagated it to the season board too — the old April spine had
Milton at 2.6, a season-shaped number. Their scan understated it: the default
QB board is also topped by **Justin Fields (KC, 2 games, 22.0)**, plus Tyrod
Taylor and Spencer Rattler at 2 games each. Roughly **half the 64-QB pool is
projected for <8 games**.

Fixed by shipping the denominator rather than by changing the numbers — the
ranking signal was always in the pool, just not in the payload:

- `get_projections` rows now carry **`games`** and **`projPts`** (the season
  total) in the default columns, and a **`min_games`** filter param.
- `get_weekly_projections` week mode now carries **`gp`**. Strip mode already
  said "over a projected N games" in prose; the ranking table is where it
  actually misleads, and that's what they hit (Lance 19.90 vs Herbert 18.60).
- Both responses **dynamically flag** returned rows with games/gp <= 4, naming
  the first three, so the trap is visible without reading docs.
- Tool descriptions and a `get_metadata` caveat state that ppg is conditional on
  playing and that cross-player ranking should use `projPts` or `min_games`.

Deliberately NOT changed: the default `sort_by` is still `ppg`, and nothing is
filtered by default. Whether the season board should rank on totals is a product
call about what the board means, and it belongs to the model owner — but the
default QB board is wrong as it stands, and that decision is worth making before
the season.

**Separate, unresolved:** Justin Fields projected for 2 games on KC looks like a
depth-chart/starter-detection miss in the pool itself, not a presentation issue.
That's the QB analogue of the "deep TEs inflated" item already in STATUS's next
tasks.

**Also learned:** a *baking* consumer exists. Their engine can't reach the MCP at
runtime, so "drop the bake, it's daily now" was bad advice — they re-bake on a
schedule instead. Worth weighing before retiring the static spine: a published,
stable, season-shaped artifact has a consumer.

### player_stats validation: season-aware (no more standing false ERROR)

`download-data.sh`'s validation block treated `player_stats_<season>.csv` as
critical year-round, but nflverse only publishes it once the season's first
games are played — so every run from March to September printed
`ERROR: player_stats_2026.csv is missing or empty!`. A standing false ERROR is
how a real one gets ignored in week 1.

`roster_<season>` stays a hard error (published year-round). `player_stats` is
now judged against whether the season has actually started, read from the
freshly-downloaded `games.csv` — any completed regular-season game for
DYNAMIC_SEASON — rather than a kickoff date somebody has to bump each year. If
that can't be determined (no games.csv) it falls back to requiring the file, so
an indeterminate check can never mask a genuine outage. Verified all four
states against a harness: pre-season → `pending` and no error; in-season with
the file missing → ERROR still fires; no games.csv → ERROR; all present → OK.
A missing roster still errors in every state.

### How to refresh Clay (the Consensus preset)

**Now a one-click job: Actions → "Refresh Clay (Consensus preset)" → Run
workflow.** `refresh-clay.yml` fetches the guide, extracts it, rebuilds the
presets and commits only the derived file. No PDF handling, no base64, no
secret.

It exists because the guide lives on `g.espncdn.com`, which the sandbox's
egress proxy 403s on CONNECT — the same reason fetch-ffc-adp.yml and
fetch-ktc-snapshot.yml exist. Runners have unrestricted egress. Dispatch-only
on purpose: the guide is republished a handful of times a season, so polling it
would hammer ESPN for nothing. The URL is derived from the season
(`.../ffldraftkit/26/NFLDK2026_CS_ClayProjections2026.pdf`), with a `pdf_url`
input to override when ESPN renames it.

**Leave `CLAY_PROJECTIONS_B64` unset.** refresh-data.yml runs `build:presets`
only when that secret is set, so with it unset the 2-hourly refresh never
touches the presets file and this workflow is its sole writer. Set it, and
refresh-data will overwrite each Clay refresh with whatever the secret holds.

The old manual chain still works if you ever need it: extract with
`python3 scripts/extract_clay_projections.py <pdf> 2026` (needs `pip install
pymupdf`), then `gzip -9 -c public/data/clay-projections-2026.json | base64 |
tr -d '\n'` into the secret — that exact encoding is what refresh-data.yml
decodes.

**Why the workflow guards so hard.** `precompute-projection-presets.ts` writes
the whole presets object and silently omits `consensus` AND `consensus-ml` when
the extract is absent — verified: a Clay-less `npm run build:presets` turns the
committed file from 5 presets into 3, and would commit the loss. So the
workflow refuses to build unless the extract parsed 300+ players, and refuses to
commit unless both consensus presets survived. That trap also fires for anyone
running `build:presets` locally without the extract — worth fixing in the
script itself (write should merge into the existing file, not replace it).

**Caveat worth knowing before doing it:** refreshing Clay only fixes half of
the `consensus` preset. `precompute-projection-presets.ts` builds it as
`redraft-projections.json` (the April spine) blended toward Clay — the counts
confirm it: `consensus` carries 416 players / 109 RB, exactly the spine, while
`consensus-ml`, `rookie-optimistic`, `vet-optimistic` and `injury-skeptic` all
carry 448 / 128, the live pool. So a Clay refresh leaves the StatHead half of
that one preset anchored to April. Re-pointing `buildConsensus` at the pool is
the real fix, and it's the same spine-retirement decision noted above.

Three further Clay artifacts exist — `clay-unit-grades-*`, `clay-matchups-*`,
`clay-team-projections-*` (from `extract_clay_unit_grades.py` and
`extract_clay_team_pages.py`), read by the Schedule tab via `nflSchedule.ts`.
They are gitignored and have **no secret/delivery path**, so those surfaces are
absent in the deploy. That looks deliberate — they'd be republishing ESPN's
numbers directly, where the presets are a derived blend — but it's worth
confirming rather than assuming.

### Notes / not done

- **This sandbox can only reach Sleeper + GitHub.** FFC, KTC,
  FantasyCalc and the `*.workers.dev` proxies are all blocked by the
  egress proxy (403 on CONNECT), and this session had no permission to
  dispatch workflows (`403 Resource not accessible by integration`), so
  the only ADP refresh runnable here was Sleeper's. Everything else has
  to come from the scheduled workflows or a manual dispatch from the
  GitHub app.
- `espn_adp_<season>.json` is still build-time only (in `dist/`, not
  committed) — matching how it has always worked, even though
  `.gitignore` un-ignores it. Committing it would give the MCP an ESPN
  board too, at ~730 KB of churn per refresh; left as a judgement call.
- **Repo growth is worth a look.** `depth_charts_2026.csv.gz` is 8.5 MB
  and is committed by every 2-hourly refresh; the three files added here
  add ~1.8 MB more per changed run. Unchanged content produces no commit,
  but in-season this is a real growth rate.
- The `consensus` preset (`redraft-projections-presets.json`) is still
  stale at 2026-06-16 — blocked on the `CLAY_PROJECTIONS_B64` secret, see
  above. Left alone deliberately.
- `redraft-projections.json` is left exactly as-is on purpose: it is a
  builder input, and regenerating it from the pool would feed the pool
  its own output.
- Untouched: the `STATUS.md` "Next 3 tasks" (projection-pool depth-share
  artifacts, SFB16 big-play recalibration, post-draft SFB16 recap).

---

## ⚡ Session wrap (2026-07-28, visitor tracking — `claude/visitor-tracking-ltdowx`)

First-party, privacy-friendly web analytics for stathead.app — self-hosted
on the existing Cloudflare stack, no third-party trackers.

- **New worker `workers/visit-tracker`** writing to a Workers **Analytics
  Engine** dataset (`stathead_visits`, auto-created on deploy, free tier).
  `POST /hit` beacon: same origin-allowlist as the other workers, bot-UA
  filter, no cookies / no stored IPs — visitors are
  `SHA-256(UTC day | IP | UA)` truncated, so the id rotates daily. Blob
  layout documented in the worker header (page, site host, external
  referrer, country, visitor hash).
- **`GET /stats?days=1..90`** aggregates via the Analytics Engine SQL API
  (daily views + unique visitors, top pages/referrers/countries; 5-min
  edge cache; `count(DISTINCT …)` guarded so visitors degrade to null if
  the dialect rejects it). **`GET /`** serves a tiny self-contained HTML
  dashboard over /stats → https://visit-tracker.dachhack.workers.dev
- **App beacon** `src/lib/visitTracker.ts` + one effect in `App.tsx`: one
  hit per tab view (player cards log as `player-detail`), `sendBeacon` as
  text/plain (no preflight), skips localhost, honors DNT + GPC, dedupes
  StrictMode double-fires, never throws. Self-hosters override the URL
  via `VITE_VISIT_TRACKER` (.env.example + README updated).
- **`deploy-workers.yml`**: visit-tracker added to the matrix; its deploy
  step also pushes the `ANALYTICS_API_TOKEN` worker secret from repo
  secret `CLOUDFLARE_ANALYTICS_API_TOKEN` (falls back to
  `CLOUDFLARE_API_TOKEN`).
- **Requires the user (one-time):** `/stats` needs a Cloudflare API token
  with **Account Analytics: Read** — create one, add it as the
  `CLOUDFLARE_ANALYTICS_API_TOKEN` repo secret, and run deploy-workers
  (dispatch → visit-tracker) after this merges to the base branch. Beacon
  ingestion works without it; only /stats & the dashboard need it. The
  worker auto-discovers the account id (optional `CF_ACCOUNT_ID` secret
  overrides).
- **Daily email**: `scripts/daily-report.py` gained a "Site visitors"
  section (first card in the email/job summary): yesterday / 7d / 30d
  pageviews + unique visitors, a 30-day unicode sparkline, top pages,
  referrers, countries, and a link to the worker dashboard. Degrades to
  an "unavailable — …" note (including the 501 configure-token hint)
  when the worker isn't deployed/configured, so the report never breaks.
  Override the worker URL with `VISIT_TRACKER_URL` if self-hosting.
  Decision: **no in-app stats tab** — the email digest + worker
  dashboard are the reporting surfaces.
- Verified with a Node harness (25 checks: CORS matrix, blob layout, hash
  stability/rotation-by-ip, internal-referrer collapse, bot/origin/junk
  drops, stats assembly + clamps + caching, DISTINCT-failure degradation,
  dashboard) and a Python harness for the report section (12 checks:
  happy path, null visitors, 501 hint, network failure, empty dataset),
  plus a full daily-report.py run. `npm run build` + eslint clean.
  Possible follow-up: per-player detail pages (`player/<key>`) once
  there's a key→name map at read time.

---

## ⚡ Session wrap (2026-06-12, worker hardening — `claude/mock-draft-feature-kglrh4`)

Hardened the three CORS Worker proxies ahead of the public `stathead.app`
launch.

- **Origin allowlist** (was hardcoded to `https://dachhack.github.io` on
  ktc/fc, `*` on espn): now echoes the request `Origin` with
  `Vary: Origin` when it matches `dachhack.github.io`, `stathead.app`,
  `www.stathead.app`, `localhost`/`127.0.0.1`, or any `*.pages.dev`
  (CF preview); anything else gets a non-matching ACAO (browser-refused).
  Fixes the would-be CORS break on stathead.app and locks down the
  previously wide-open espn proxy.
- **Edge caching** via `caches.default` (GET only): KTC/FC 1h, ESPN 15m.
  The cached body carries **no** CORS header — it's re-added per request —
  so one cached object serves every allowed origin with its own correct
  ACAO. Collapses N user requests into ≤1 upstream fetch per TTL.
  POST (KTC histories) is proxied, not cached.
- `deploy-workers.yml` now **matrix-deploys all three** on any `workers/**`
  push (was espn-only), with an `all`/per-worker dispatch choice.
- Reminder: in prod these are the **fallback/abuse-control layer** — KTC
  and FantasyCalc render from committed daily snapshots
  (`public/data/ktc_*`, `fantasycalc_*`); ESPN news is the only per-user
  live call. Verified the new CORS-echo + cache logic with a Node harness
  (origin matrix, single-upstream-fetch-across-origins, no-ACAO-in-cache,
  POST-not-cached). Workers auto-deploy when this lands on the base branch.

---

## ⚡ Session wrap (2026-06-12, prod environment — `claude/mock-draft-feature-kglrh4`)

Stood up a **two-environment deploy** so GitHub Pages is QA and the new
`stathead.app` domain is production.

- **QA** — unchanged: GitHub Pages at `dachhack.github.io/stathead/`,
  base `/stathead/`, deploys on push to the dev branch (`deploy.yml`).
- **Production** — `stathead.app` on **Cloudflare Pages**, base `/`,
  deploys on push to a new **`production`** branch (`deploy-prod.yml`,
  reuses the existing `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`
  secrets). Promote by merging the QA'd dev branch into `production`.
- `vite.config.ts` base is now env-driven: `process.env.BASE_PATH ??
  '/stathead/'`. Verified both builds — default → `/stathead/assets/…`,
  `BASE_PATH=/` → `/assets/…`. App reads `import.meta.env.BASE_URL`
  everywhere, so nothing else needed changing.
- **Still requires the user (Cloudflare dashboard, one-time):** create a
  Direct-Upload Pages project named `stathead` with production branch
  `production`; add the `stathead.app` custom domain + DNS; ensure the
  API token has Pages-Edit permission; then `git push` a `production`
  branch. Steps are in the `deploy-prod.yml` header + README "Environments".

---

## ⚡ Session wrap (2026-06-12, branch `claude/mock-draft-feature-kglrh4`)

### Shipped
- **Mock Draft room** — Draft Kit step "5 · Mock Draft" (`src/lib/mockDraft.ts`
  engine + `src/components/MockDraftRoom.tsx` UI). Full practice draft vs a
  configurable CPU room. League shape (size/slot/snake/roster/scoring) comes
  from the LEAGUE bar; the mock setup configures the ROOM:
  - **Per-opponent profiles**: draft style (ADP / Value / Needs / Wildcard) ×
    positional goal (Balanced, Pure BPA, Zero RB, Hero RB, RB/WR heavy,
    Early/Late QB, TE premium), with 🎲 randomize + all-chalk presets.
  - **CPU pick logic** is rank-space scoring: style orders the board (ADP or
    VBD), then Gaussian noise (σ per style, depth-scaled so the top of the
    board stays chalky), goal tilts, and starters-first nudges in units of
    picks. Standard behavior for every profile: position caps
    (`positionCap`), bench-filler pushdown, and endgame forced fills so all
    starting slots always get filled.
  - **Two modes**: Simulate everything (your seat autopicks by your plan) or
    "I make my picks" (draft pauses on your turn; plan-ranked best-available
    list + search, click to draft).
  - **Plan** = selected My Rankings board when active (starters-first nudge,
    unranked → VBD), else the plan sim's urgency-weighted VBD vs your next pick.
  - **Timers**: only YOUR turn is timed (Off/15/30/60/90/120s, mm:ss display
    + progress bar; expiry autopicks from the plan). CPU picks take **1–7s,
    normally distributed** around 4s (`sampleCpuDelayMs`), with Fast (÷8) and
    Instant speed options. Pause/resume/abort supported.
  - **Results**: projected standings (best-legal-lineup season points via
    `lineupPoints` + total VBD), full draft board grid, and every team's
    roster — each with a letter grade.
  - **Draft report card** (`gradeTeams` / `lineupBreakdown`): per-position
    strength scored 0–100 as the percentile of the season points that
    position's starters contribute (flex players credited to their own
    position) vs the rest of the room, plus an overall letter grade.
    Shown as colored bars on the user's card and a grade chip on every
    standings row.
  - **Board review** (`reviewUserPicks` / shared `valueScore`): replays the
    user's seat and flags picks where a higher urgency-weighted-VBD player
    was on the board — value over the roster's replacement level, discounted
    by survival to the user's next pick, so it never suggests a player who'd
    be gone or one the user could've waited a round for. "Clean draft" when
    every pick was the best value available.
  - Config persists to localStorage `mock-draft-config`.
- Verified: tsc + eslint clean; headless engine smoke test (180-pick drafts ×
  20: completion/caps/starter fills/goal behavior/delay distribution) and
  puppeteer UI run (sim end-to-end, manual on-the-clock click-draft, timer
  autopick) against `vite preview` on 127.0.0.1.

### Notes
- CPU pick scoring is intentionally in rank space so style noise, goal tilts,
  and need nudges compose in "picks" units; tune `STYLE_INFO[].sigma` /
  `goalRankDelta` if rooms feel too chalky or too wild.
- Natural extensions: keeper support (pre-assigned players), draft-from-any
  -seat review grades per pick (vs ADP and vs plan), export the mock result
  to a My Rankings board.

---

## ⚡ Session wrap (2026-06-12, branch `claude/fervent-galileo-vgx7cg`)

Draft-day deliverables session. PRs #429–#433, all merged + deployed.

### Shipped
- **Draft Day print sheet** (`src/components/DraftPrintSheet.tsx`, PRs
  #429 + #431): one-page BeerSheets-style printable cheat sheet, opened
  from the Draft Kit header ("🖨 Print / PDF Sheet"). Light-on-white
  page portaled to `<body>`; tier-colored position columns (VBD, value
  round.pick vs market ADP, ▼/▲ round delta, MY board rank), snake-pick
  numbers, scarcity split. PDF = browser print-to-PDF (no library):
  `@page letter landscape` + `body.print-sheet-open #root{display:none}`.
  **Pagination learned from the first real PDF** (superflex league →
  3 ugly pages): `breakInside: avoid` on page-tall columns orphaned the
  header page (removed), and starters+2rds depth scales with roster
  math, not paper — default is now **"One page — auto-fit"** (row-budget
  caps `FIRST_PAGE_ROWS=56` / `CONT_PAGE_ROWS=62` at 8px/1.3 rows);
  deeper depths pre-chunk all four columns on shared boundaries into
  per-page grids with repeated headers ("cont. from N") + continuous
  numbering. Dashed rules show page breaks in the screen preview.
- **My Rankings ⇄ Excel** (`src/lib/rankingsXlsx.ts`, PR #429): one
  styled .xlsx template both directions (Rankings + Meta sheets;
  exceljs dynamic import). Import header-matches by name (columns can
  be reordered/dropped), recreates the board as a SavedRanking and
  loads it; **edited Proj PPG values become a pointsOverrides scenario**
  linked to the board (PPR files only; override ppr = basePpr ×
  imported/baseDisplay so the relative fallback path reproduces the
  exact PPG — approximate when the cached Projections-tab base path
  is active). Buttons: "Excel ⬇" / "Import ⬆" on My Rankings.
- **Favicon actually updates now** (PR #430). Root causes: browsers'
  dedicated favicon cache ignores query-string bumps (the `?v=4`
  treadmill), and **Safari/iOS never load SVG favicons** — SVG was the
  only icon. Now referenced through Vite's asset pipeline
  (content-hashed URL → every edit busts every cache), with PNG
  fallbacks (32px + 180px apple-touch-icon) rendered by
  `scripts/generate-favicons.mjs` (`npm i --no-save sharp`, not a
  devDependency). Also fixed invalid XML in the SVG (`--` inside a
  comment — browsers tolerate, librsvg rejects).
- **Buzz Tracker: Reddit removed** (PR #432). It never contributed
  data: reddit.com 403s unauthenticated JSON from datacenter IPs, so
  every Actions run silently got 0 posts from all three subs (the
  never-fail error handling hid it; run logs confirm). Snapshots were
  always ESPN + Rotowire only. Removed the fetch path + per-player
  name-pattern machinery, the UI subreddit chips / "and Reddit" copy,
  and the workflow's source claims.
- Home page blurbs updated for the print sheet + Excel round-trip
  (PR #433).

### Notes / follow-ups
- The separate `reddit_sentiment.json` model-feature pipeline
  (`fetch-reddit-sentiment.ts`, `redditMentions/Hype/Sentiment` feature
  keys, sentiment feature group) was left untouched — almost certainly
  all zeros for the same IP-block reason. Either rip it out of the
  feature store too, or fix properly with a Reddit script-app OAuth
  token (2 repo secrets + ~30 lines in the fetcher).
- Print-sheet row budgets are arithmetic, not browser-verified
  (headless-Chromium downloads are blocked in sandboxes; first attempt
  confirmed). If a real printer spills one row, tune
  `FIRST_PAGE_ROWS`/`CONT_PAGE_ROWS` in `DraftPrintSheet.tsx`.
- `@page { size: letter landscape }` is global — fine while the print
  sheet is the app's only print path; revisit if another view ever
  prints.
- Excel import creates scenarios named `<board> (imported projections)`
  — they accumulate in `stathead-scenarios` localStorage on repeated
  imports; no cleanup UI yet.

---

## ⚡ Session wrap (2026-06-12, branch `claude/intelligent-einstein-1kxwga`)

The big ADP session. PRs #419–#421, #423–#427, all merged + deployed.

### Shipped
- **ADP architecture** (`src/lib/adpSources.ts` + pure `adpBlend.ts`):
  explicit **historic vs current regimes** — historic = immutable
  committed snapshots, loaded snapshot-only (deterministic research
  input); current = daily-refreshed/live, **weighted blend** (FFC
  sample `times_drafted` × recency half-life on the file's draft
  window) consumed by My Rankings, the Draft Kit, and 2026 model
  scoring. **Superflex segmented** end to end (FFC `2qb` files,
  Sleeper `adp_2qb`, FC `redraft_sf`; never mixed with 1QB). No source
  has TEP ADP.
- **New Sleeper ADP source**: `sleeper-adp-<season>.json` 2020–2026,
  CI-refreshed daily via fetch-sleeper-players.yml
  (`scripts/fetch-sleeper-adp.py`; 999 = undrafted sentinel; historic
  files omit teams — Sleeper reports CURRENT rosters for old seasons).
- **Consensus ADP tab rebuilt**: multi-source compare, weighted Blend,
  disagreement Spread (click to sort), seasons to 2018, 1QB/SF toggle.
- **FFC 2025 recovered**: FFC relabeled its 2025 board as `year=2026`
  when its season rolled (meta: 870 drafts, Sept 3–10 2025).
  Reconstructed `ffc_adp_ppr_2025.json` with teams restamped from
  roster_2025. The committed "2026" file IS that stale window until
  FFC serves real 2026 mocks — recency weighting mutes it meanwhile,
  and the daily fetch self-corrects. Wayback-recovery fallback added
  to `scripts/fetch-ffc-adp.sh` for purged historic seasons.
- **Wrong-year fallback bug** (years old): fetchFfcADP's thin-season
  fallback served season-1 prices for HISTORIC seasons — **season
  2022 trained on 2021 ADP** (JT's 2022 row said 13.8, his 2021
  price). Fallback is now current-season-only; historic = snapshot-only
  in prod (no live calls — also un-stalled every Projections load).
- **Training pipeline integrity** + full retrain (rows v51, models
  v58/v74/v6/v3): draft-pick poisoning fixed (vets no longer carry
  NFL draft slots as "ADP"; UNDRAFTED_ADP=300 sentinel), 2025 rows
  deterministic, 2026 scoring blended (pool 171→276; score-store
  153→**258 ADP preds incl. 30 rookies** — Dart/Stafford now scored).
  LOSO improved: QB .498→.509, WR →.567, TE .579→**.608**. `adpTrend`
  filled end-to-end but **ablated out** (neutral; verdict + repro hook
  logged in `train_projection_models.py`).
- **My Rankings**: teams/ADP fallback chain (398/416 teams; real
  market ADP via blend), **exact Projections-tab scenario parity**
  (`projectionsTabEngine.ts` extracted + cached base pool), working
  rookie/vet presets, rookie badge from career-model class (was
  no-prior-stats heuristic — mislabeled 25), sortable column headers
  (3-state cycle, missing-last), scenario PPG ranked per-17
  (season-equivalent — a 2-game QB2 line topped the board at "63.5
  PPG" otherwise), **teamless players carry no projections** (also on
  Rankings tab + Draft Kit pools; a scenario signing restores them).
- **Scenario Builder**: `rosterPromotions`/`rosterRemovals` levers in
  both engines — promote any rostered player into the projection pool
  ("Project as…" position picker for two-way guys like Travis Hunter
  DB→WR), remove pool players (struck-through + Restore).
- **Draft Kit**: urgency-weighted optimal picks (vbd × P(gone by your
  next pick)) — no more ADP-159 players drafted at 45; QB caps (1 in
  1QB, 3 in SF) across all sim strategies; **hand-swappable plan
  picks** (click an alternate → later rounds re-sim; per-card undo +
  reset-all); league bar redesigned (`.league-pill` in index.css).
- Mobile: Home Python-library section fits phones (≤42-char quickstart
  + soft-wrap fallback, stacked loader rows).

### Notes / follow-ups
- FFC daily run keeps trying real 2026 mocks + `2qb` history backfill;
  FC workflow adds `redraft_sf` next run — SF columns light up then.
- `adpTrend` stays out of model feature lists (twice-neutral ablation;
  re-test as consecutive-season two-source history accrues).
- MFL is a candidate 5th ADP source (documented public API with
  history) — CI-only fetch, unverifiable from sandboxes; not shipped.
- The "My board" sim craters if a saved board is position-sorted
  (QB block at top → was −1163 vs optimal); QB caps now contain it,
  but stale boards saved under old scenarios should be re-saved.
- Sandbox verification recipe: `vite preview` on **127.0.0.1** (NOT
  localhost — IS_PROD is hostname-based and dev mode skips committed
  snapshots), gunzip player_stats_2025/draft_picks/roster_2026/games
  csv.gz into dist/data (vite build wipes them), abort external hosts
  in Playwright so fallbacks fail fast.

---

## ⚡ Session wrap (2026-06-10, branch `claude/modest-albattani-vt8rz2`)

Redraft-season centerpiece work. Open to-do #6 ("Draft Optimizer — test +
clean up for the upcoming season") is now substantially done.

### Shipped
- **Draft Optimizer → full redraft kit** (PR #387). New `src/lib/draftKit.ts`
  VBD engine: wide pool from `redraft-projections.json` (416 players, **all 96
  2026 rookies** — the score-store `adp.json` pool has ZERO rookies, so the
  pre-existing Edge Board was rookie-blind), market price = FFC ADP with
  FantasyCalc-redraft-rank fallback (covers 29 rookies), replacement levels
  from league settings w/ greedy FLEX/SF allocation, baselines VOLS/VORP/BEER.
  New sections on the tab: **Value Board** (BeerSheets-style: tier color
  bands, value vs ADP round.pick, ▼/▲ round-delta arbitrage encoding,
  scarcity bars, "My board" overlay from saved My Rankings boards),
  **Optimal Team Builder** (survival-aware greedy VBD sim from the user's
  seat vs an ADP-chalk roster → "edge vs the room" in lineup points),
  **Rookie & Veteran Edges** (market discount × career-model startable/boom
  probs; rookie hype tax; 4+ yoe vet values). Player names clickable
  (`PlayerName`) across Edge Board / Round Plan / Targets & Fades. Scenarios
  override PPG in all new sections; Half/Std re-scored from `recPG`.
- **Dynasty → Taxi Squad Advisor** (tab `taxi-squad`, this PR). 2026 rookies +
  2025 year-2 class scored on the taxi-vs-active call: Now PPG (base redraft
  projection), Start % (career-model P(low-end-starter PPG): thresholdProbs
  key QB 16 / RB 12 / WR 12 / TE 9), rookie-year actual PPG, boom/bust,
  FantasyCalc dynasty value (1QB/SF toggle). Verdict tree **calibrated to the
  live score-store distributions** (boomProb runs 23–36 for everyone — only
  ≥38 is signal; bustProb p90 ≈ 40): Promote (20) / Watch (23) / Taxi (117) /
  Move On (2, year-2 only by design). Hover a verdict for the reasoning.

### Notes / follow-ups
- FFC 2026 ADP (`ffc_adp_ppr_2026.json`) still has **no rookies** (171 vets).
  Once FFC publishes post-draft ADP, the daily fetch picks it up and the kit
  pool automatically prefers it over the FC-rank proxy (rows marked `*`).
- Roster sim is greedy + deterministic; a Monte Carlo "draft 1000 times"
  upgrade and a live-draft assistant (mark picks as they happen → VONA) are
  the natural next steps.
- Round Plan / Tier Map / Targets & Fades still run on the score-store pool
  (rookie-blind); consider migrating them to the kit pool.
- Dev env note: this container had full deps (`npm ci` works; tsc, eslint,
  vite, puppeteer headless verification all ran locally — unlike the older
  web container).

---

## ⚡ Session wrap (2026-06-09, branch `claude/sleeper-features-refinement-7bt52u`)

Continuation of the Sleeper/refinement work. All changes merged to base
`claude/nfl-fantasy-workbench-6D1yd`.

### Shipped this session
- **Rookie/ZAP tables → shared player detail.** `RookieProspectsView`,
  `RookieCareerBacktest`, `ZapComparison` now render names as `PlayerName`
  links to the shared detail page, with a `📊` `ModelCardButton` that still
  opens the rich prospect `PlayerCard` (model features / boom-bust / threshold
  probs). New `ModelCardButton.tsx`.
- **Sleeper power rankings → blended value + SF.** `scoreRoster` +
  `computePositionalStrength` now use the blended (FC-scale) values with the
  league's `isSuperflex` flag, matching the per-player/waiver path (SF leagues
  no longer under-rank QBs). Trade suggestions deliberately stay on raw KTC.
- **Snooper "Objective" column → window proxy.** Switched the Leagues-table
  column from current-KTC-on-past-rosters to `computeRosterWindowProxy`
  (age-at-season + position + projections), so it matches the by-year chart and
  is accurate on historical seasons. Shared `buildProjByPlayer`; dropped dead
  `computeRosterWindow`.
- **Per-position aging curves** in the window proxy (`POS_AGE_BUCKETS`:
  RB 23/26, WR 24/28, TE 25/29, QB 26/32) — QB-heavy vs RB-heavy rosters now
  classify correctly on the win-now↔rebuild axis.
- **gsis-less rookie sleeper_id backfill.** New `fetch-sleeper-players.py` +
  committed `sleeper-players.json`; `build-player-crosswalk.py` backfills from
  the full Sleeper list (after FantasyCalc) by unique (name, pos). Coverage
  4945→6101. Refreshed daily by `fetch-sleeper-players.yml` (also rebuilds the
  crosswalk).
- **Key-promotion persistence.** Carry `alias_keys` forward across rebuilds so
  COL→NFL promotion back-references accumulate permanently (they previously
  evaporated on the next daily rebuild).
- **Normalizer consolidation.** Nine byte-identical name normalizers → one
  `src/lib/nameMatch.ts` (`normalizeForMatch` / `normalizeNameSimple` /
  `normalizeNameUnicode`), behavior-preserving.
- **Identity-conflict tripwire.** `player-conflicts.json` flags any gsis_id
  with >1 distinct birth_date (42 today; college dropped as too noisy).
- **ESPN news worker** confirmed already deployed via `deploy-workers.yml`
  (#380, 2026-06-09) — `deploy` follow-up was stale.

### ✅ Verified already-done (handoff was stale)
Player detail page (`/player/sh_<key>`), CI crosswalk rebuild (`refresh-data.yml`
rebuilds every 2h), Scenario Builder in the Home menu — all already shipped.

---

## 📋 Consolidated open to-do list

**Needs the user / an unrestricted environment**
1. ~~**Verify ESPN news shape.**~~ — ✅ verified working on the live site
   (2026-06-09). The worker, `fetchPlayerOverview` parser, and crosswalk
   `espn_id` wiring all function; a blank Recent News section just means the
   network is blocking `*.workers.dev` (e.g. a VPN/firewall), not a bug.
   - **espn_id coverage fix (2026-06-09, commits `2cf26f1`, `5e77d9b`):** news +
     headshot are gated on `cw.espn_id`, but nflverse rosters only carry it for
     ~42% of players and **none for pre-draft rookies** (e.g. KC Concepcion
     showed no news). Two backfills added to `build-player-crosswalk.py`:
     (a) from **ESPN team rosters** — `scripts/fetch-espn-nfl-ids.mjs` scrapes
     all 32 rosters (only `site.api.espn.com` is reachable; search/core-api are
     firewalled) into deterministic `public/data/espn-nfl-ids.json`, the
     authoritative id source that covers current rookies; (b) from **Sleeper**'s
     `espn_id` field by resolved `sleeper_id`. Coverage 42%→49%, 94 pre-NFL
     rookies resolved, KC Concepcion → `4870653`. `download-api-data.sh`
     refreshes the ESPN file each build (non-fatal) and `refresh-data.yml`
     commits it, so the crosswalk auto-picks-up new rookie ids. Lands on the
     live crosswalk within the next 2h `refresh-data` run.
2. ~~**Refresh `adp_ffc` coverage** (2018-2024 + 2026)~~ — ✅ done (2026-06-09,
   commit `b2a9726`). Real FantasyFootballCalculator PPR ADP for **2018-2024 +
   2026** is now committed (≈157-211 players/season, fully populated
   `stdev`/`timesDrafted`). 2026 is no longer a stale clone of 2025.
   - Corrected diagnosis: FFC is **not** firewalled from GitHub runners (only
     from the dev sandbox, which 403s "Host not in allowlist"). The real gap was
     that nothing **committed** the per-season files — `refresh-data.yml`'s
     `git add` list omits `ffc_adp_ppr_*.json` (`.gitignore` already allowlists
     them), so historical years lived only in the runner cache + live deploy.
   - Mechanism: `scripts/fetch-ffc-adp.sh` (non-destructive — only overwrites on
     a non-empty response, never blanks good data on a 403) +
     `.github/workflows/fetch-ffc-adp.yml` (branch-aware fetch+commit, **daily
     07:00 UTC** + dispatch with a `force_all` backfill toggle; mirrors
     `fetch-ktc`/`fetch-fantasycalc`). Also hardened `download-api-data.sh`
     (curl `-f` + player-count check so a 403 body can't masquerade as cached;
     empty historical files self-heal).
   - ⚠️ **2025 caveat:** FFC's `?year=2025` endpoint now returns **0 players**
     (off-season; FFC rolled current ADP to 2026), so the committed
     `ffc_adp_ppr_2025.json` is **not** FFC data — it's a 448-player,
     zeroed-`stdev`/`timesDrafted` placeholder from some other source, force-added
     2026-06-07. The fetcher correctly leaves it untouched. If a real 2025 ADP is
     wanted, source it elsewhere (FFC won't serve it) or delete the placeholder.
3. **Clay blend-weight tuning** — needs more historic Clay PDFs (have ~5, esp.
   2025). Re-run `clay_blend_study.py`, then set per-position weights in
   `scenarioPresets.ts` (flat 0.8 today; pull QB down ~0.4). Plus unused PDF
   pages (IDP pp46-55, projected SOS p62, etc.).
4. **Reg-season TV network gaps** (~24, weeks 16-18) — TBD on ESPN; re-run
   `node scripts/enrich_schedule_espn.mjs 2026` once assigned.

**Needs scoping with the user (tell me what's wrong / desired)**
5. **My Rankings page** — clean up + test (bugs? layout?).
6. **Draft Optimizer** — test + clean up for the upcoming season.
7. **Richer player cards** — stats + images (career-chip scaling already fixed;
   define what "richer" means).

**Doable anytime (bigger / lower priority)**
8. ~~**Re-key `feature-store/*.json`** by `player_key::season`~~ — ✅ done the
   *additive* way (2026-06-09, commit `d0e8bb0`), not a full re-key. A full
   re-key touches ~25 files + the build pipeline and **can't be validated
   locally** (`npm run build:features` needs `tsx`, absent here), so instead
   `build-player-crosswalk.py` now emits `feature-store/key-index.json`
   (`byNameKey` + `byPlayerKey`, 4507 mappings, 100% coverage) from the exact
   resolution it already runs on the `players.json` source — so it can never
   drift from the crosswalk and auto-refreshes wherever the crosswalk rebuilds.
   `featureStoreClient.ts` gained `loadKeyIndex` / `playerKeyFor` /
   `getFeaturesByPlayerKey` so consumers can read features by canonical
   identity. Surfaced ~94 same-player name-variant fragments (e.g. josh vs
   joshua freeman) with zero false merges. The full key-swap remains optional
   if/when the build can run locally. *(Note: `tsc -b` not runnable here either;
   the small `featureStoreClient.ts` change was hand-reviewed — watch CI.)*
9. ~~**CI rebuild remainder (minor)**~~ — ✅ done (commit `775f8cf`). The KTC
   (`fetch-ktc-snapshot.yml`) and FantasyCalc (`fetch-fantasycalc-snapshot.yml`)
   daily workflows now run `build-player-crosswalk.py` right after fetching
   (the crosswalk resolves against exactly the `ktc_rankings_1qb.json` /
   `fantasycalc_dynasty_sf.json` they refresh) and commit the crosswalk +
   `key-index.json`. Non-fatal step, no-op-guarded, deterministic — verified
   locally. Keeps the committed crosswalk in sync with the committed snapshot
   instead of drifting until the next `refresh-data` run.

**Dropped by the user**
- Re-expose dormant `ChatDrawer` (Ask Claude) + `SettingsModal` (FAB/gear
  removed in #355).

---

## ⚡ Latest session wrap (2026-06-09, PRs #346–#376)

Working branch: **`claude/sleeper-features-refinement-QxT6M`** (PR base `claude/nfl-fantasy-workbench-6D1yd`). All PRs squash-merged into the base.


### Shipped
- **Dynasty vs redraft split**: rebuilding/contending framework (windows, age curves, dynasty value) is dynasty-only (`settings.type === 2`); redraft/keeper rank + trade on projected season points. (#346)
- **Draft picks**: shown on rosters; values scaled by league size + projected finish; **traded-pick ownership bug fixed** (Sleeper `roster_id`=original owner, `owner_id`=current owner — code had them swapped). (#348, #363)
- **User Snooper**: career history (multi-season record/finishes/champs), by-year **stacked charts**, **age+position+proj window proxy** for historical objective (no historical KTC), **trade list + hindsight grades**, avatar zoom, league filter, and a **Season selector** (in the Leagues section header). (#347, #351, #375, #376)
- **Waiver Wire** (Research): cross-league tool — blended dynasty value + FC trend, **1QB/SF toggle**, sort by every column, **excludes undrafted leagues**, per-league + type filters. (#354, #358–#362)
- **My Leagues**: per-player **proj pts / dynasty value / trend**; **Suggested Waiver Moves** (add/drop) per team; page now **leads with "League View"** (power rankings w/ team selection + owner). (#369, #372, #374)
- **Branding**: matching logo + favicon (rounded-tip football), cache-busted favicon. (#350, #356, #357)
- **Clickable player names** everywhere via `PlayerName` (Sleeper surfaces + ~12 non-Sleeper tables) + **Team Roster** + **Recent News** sections on player cards. (#370, #371, #373)
- IA/UX: Sleeper tools folded into **Research**, redundant Waiver/Trending tabs dropped, **mobile header alignment**, removed Claude chat FAB + settings gear (dormant, easy to restore). (#352, #353, #355)
- Data integrity: crosswalk **merge guard** (don't merge same-name players w/ incompatible position), **FantasyCalc Sleeper-id backfill** for gsis-less rookies, **position-aware clay→Sleeper resolution**, and **cache-busting** of committed data files. (#363, #364, #367, #368)

### ⏳ Follow-ups waiting on action
1. **ESPN news worker — DEPLOYED ✅ (verify shape in-browser).** The
   `deploy-workers.yml` CI workflow (PR #380) published `espn-news-proxy` to
   `https://espn-news-proxy.dachhack.workers.dev` on 2026-06-09 (run succeeded;
   `CLOUDFLARE_API_TOKEN` secret is configured). No local terminal needed —
   it auto-deploys on `workers/espn-news-proxy/**` changes to the base branch,
   or via the workflow's "Run workflow" button. **Still unverified:** ESPN's
   host is blocked from the sandbox *and so is `*.workers.dev`*, so the live
   response shape was never confirmed end-to-end. The chain is wired
   (`PlayerDetail` → `fetchPlayerOverview` → worker, keyed on crosswalk
   `espn_id`) and `fetchPlayerOverview` parses defensively (handles the
   worker-slimmed `{articles,rotowire,fantasy,awards,statistics}` shape *and* a
   raw-overview passthrough). **To verify:** open any player-detail page with an
   `espn_id` on the live site and check the Recent News section; if it's blank,
   fetch `https://espn-news-proxy.dachhack.workers.dev/news/3918298?limit=3`
   (Josh Allen) from a browser/unrestricted shell and tune `parseNews` /
   `parseFantasy` in `src/data.ts` to the real keys.
2. **Point the remaining in-page-card tables at the shared player detail** — ✅
   done. `RookieProspectsView`, `RookieCareerBacktest`, `ZapComparison` now use
   `PlayerName` links to the shared detail page, with a `📊` `ModelCardButton`
   that still opens the rich prospect `PlayerCard`.

### 🔭 Known / optional to-dos
- **Snooper per-season "Objective" column** (Win-Now/Rebuild in the Leagues table) still uses **current** KTC on past rosters → approximate for old years. The by-year *chart* already uses the better age+pos+proj proxy (`computeRosterWindowProxy`); could switch the table column to it too.
- ~~**gsis-less rookies**: Sleeper id backfilled only from the FantasyCalc set~~ — ✅ done. A second backfill pass now runs off the full Sleeper players list (`public/data/sleeper-players.json`, refreshed by `fetch-sleeper-players.yml`); `build-player-crosswalk.py` matches gsis-less records by unique (name, position). Lifted sleeper_id coverage 4945→6101.
- **Power-ranking value source**: league power rankings (`scoreRoster`) still use **raw 1QB KTC** (`fetchKTCRankings`), while waiver/roster stats use **blended** value + an SF toggle. Consider unifying power rankings to blended + SF for SF leagues.
- **Historical window proxy** uses one age curve; QBs age slower — per-position age curves would sharpen old-year objective classification.
- **Dormant features**: `ChatDrawer` (Ask Claude) + `SettingsModal` are mounted but have no triggers (FAB/gear removed in #355). SportsDataIO news/odds now need settings re-exposed. Re-add buttons to restore.

### 🛠 Dev gotchas (important)
- **Type-check with the app project**, not the root: `npx tsc --noEmit` **no-ops** (root `tsconfig.json` is a solution file). Use `npx tsc -p tsconfig.app.json --noEmit` (ignore the env-only `vite/client`/`node` lib errors). This is what CI's `tsc -b` actually checks — two CI breaks this session (`LabelList` formatter #349, stale `sortMode` #365) slipped past `--noEmit`.
- `vite`/`eslint`/`tsx` dev deps aren't installed in the web container, so `npm run build`/`eslint` can't run here — CI is the real gate.
- **Squash-merge rebase dance**: after each squash merge the branch diverges; reland new work with
  `git rebase --onto origin/claude/nfl-fantasy-workbench-6D1yd <lastShippedCommit> claude/sleeper-features-refinement-QxT6M`, force-push, PR, merge.

---

## ⚡ Latest session wrap (2026-06-07, PRs #322–#330)

Working branch: **`claude/scenario-builder-presets-resume-rYlS1`** (PR base `claude/nfl-fantasy-workbench-6D1yd`).

Shipped this session:
- **#322** ESPN schedule enrich (preseason venues/networks; reg-season gaps still TBD on ESPN).
- **#323** Sleeper **league import** (`sleeper.ts` + `SleeperLeagueView` + nav tab).
- **#324** `sleeper_id`→`player_key` PlayerDetail links (`lookupBySleeperId`).
- **#325** **Consensus ADP** tab (FantasyCalc redraft, daily-refreshed, Sleeper-inclusive).
- **#326** Clay 2026 player projections → committed `clay-projections-2026.json`.
- **#327** **Consensus 80/20 blend** preset wired live (+ fixed a `normalizeName` crash that broke the whole Scenario Builder).
- **#328** **SOS** now uses Consensus **defense grades** (`clay-unit-grades-2026.json`).
- **#329** **Team projections + matchup win-prob** on the Schedule view.
- **#330** Year-agnostic Clay extractor + `clay_blend_study.py`.

**Two things waiting on the user (next session):**
1. **More historic Clay PDFs** (esp. 2025) to finalize per-position blend weights — user hit the upload limit; has ~5 more. Extracted **2023 + 2024 + 2026 player projections are now committed** to `public/data/clay-projections-<year>.json` (PR #332), so the study runs across sessions WITHOUT re-uploading: `python3 scripts/clay_blend_study.py --years 2023,2024`. Add new years by extracting their PDF to the same path, then re-run + set per-position weights in `scenarioPresets.ts` (flat `0.8` today; QB ~0.4 is the exception). (PDFs themselves stay out of the repo.) Historic **unit grades** committed (`clay-unit-grades-{2023,2024,2026}.json`, page 61 in older guides — `extract_clay_unit_grades.py <pdf> <year> 61`). Historic **matchups + team-projections** also committed (`clay-matchups-{2023,2024}.json`, `clay-team-projections-{2023,2024}.json`) — needed building `schedule-{2023,2024}.json` from nflverse (`node scripts/build_schedule.mjs <year>`) for team fingerprinting (those are committed too). **Full Clay dataset (projections, unit grades, matchups, team proj) is now persisted for 2023/2024/2026** — ready for a SOS/unit-strength/win-prob predictive study (deferred per user). Weekly actuals join cleanly to unit grades by opponent code (32/32).
2. **Sleeper as its own main site section** — see the "NEXT ROUND — Sleeper" note in Task 2 (sleeper_wrapper, all-leagues-by-username, matchups, gsis→player_key).

---

## ⚡ Resume here (2026-06-07) — Scenario Builder / Schedule / Sleeper

Working branch: **`claude/scenario-builder-presets-resume-rYlS1`** (PR base `claude/nfl-fantasy-workbench-6D1yd`). Many PRs merged (#294–#322); Sleeper league import shipped in #323.

### Allowlist — RESOLVED (2026-06-07)
`site.api.espn.com` + `api.sleeper.app` are both reachable (`200`) now. Re-test if needed:
```
curl -s -o /dev/null -w '%{http_code}\n' "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=1&dates=2026"
curl -s -o /dev/null -w '%{http_code}\n' "https://api.sleeper.app/v1/state/nfl"
```
(If they ever 403 again: env likely saved as **Custom** without "include default package managers", or domains have a stray `https://`/path.)

### Task 1 — commit ESPN schedule data ✅ (PR #322)
- `scripts/enrich_schedule_espn.mjs` — reproducible server-side mirror of `overlayEspn`. Fills *missing* reg-season networks then re-runs `build_schedule.mjs`; fills preseason network + venue.
- Committed **49 preseason venues + 5 preseason networks**.
- ⚠️ The "~24 missing reg-season networks" (weeks 16–18) are still **TBD on ESPN itself** (flex scheduling) — ESPN has the same 248/272 we do, only cosmetic naming diffs (`Prime`→`Prime Video`, `NETFLIX`→`Netflix`) that the runtime overlay already applies live. Re-run `node scripts/enrich_schedule_espn.mjs 2026` once ESPN finalizes weeks 16–18 and they'll fill in.

### Task 2 — Sleeper features (`https://docs.sleeper.com/`)
- ✅ **League import** (PR #323): `src/lib/sleeper.ts` (`importLeague(id)`) + `src/components/SleeperLeagueView.tsx` + "Sleeper League" nav tab (Projections group). Enter a league id → standings + per-team rosters (starters w/ slot labels + bench), player names resolved via the existing `fetchSleeperPlayers()` map in `data.ts`. League id persists in localStorage. Verified against real league `1182033380414181376`.
- Pre-existing (retired `'sleeper'` tab, `SleeperView.tsx`): **trending adds/drops + Sleeper projections** already shipped via `fetchSleeperTrending`/`fetchSleeperProjections` in `data.ts`.
- Remaining Sleeper ideas: Sleeper **ADP** as a consensus source; sync `sleeper_id`→`player_key` so league rosters link to PlayerDetail/career model.

### ▶ NEXT ROUND — Sleeper as its own main site section (user request 2026-06-07)
Promote Sleeper from the single League-import tab to a **dedicated top-level site section** (its own nav group) covering: league import (have it), standings, per-team rosters, trending adds/drops + projections (exist in retired `SleeperView`), **a user's all-leagues view** (enter a Sleeper username → list every league), and per-league matchups/standings.

**`sleeper_wrapper` Python package** (`pip install sleeper_wrapper`) — use for any Python-side pulls. Wraps League / Players / User / Drafts.
```python
import json, pandas as pd
from sleeper_wrapper import League, Players, User

# League rosters + standings
league = League(1180266430665863168)
rosters = league.get_rosters()
users = league.get_users()
standings = league.get_standings(rosters, users)  # [(name, wins, losses, pts), ...]

# Per-team player lists
teams = [d["roster_id"] for d in rosters]
player_df_tot = pd.DataFrame()
for x in teams:
    team = x - 1
    listout = rosters[team]["players"]
    player_df = pd.DataFrame({'players': listout})
    player_df['players'] = player_df['players'].astype(str)
    player_df['Team'] = x
    player_df_tot = pd.concat([player_df_tot, player_df])

# All players (id → full_name, position, team, gsis_id)
players = Players()
plyrs = players.get_all_players()
df_p = pd.DataFrame.from_dict(plyrs, orient='index')
df_p['player_id'] = df_p['player_id'].astype(str)
df_p_cut = df_p[['player_id', 'full_name', 'position', 'team', 'gsis_id']]

# User's all leagues for a season
user = User("dachhack")
lgs = user.get_all_leagues('nfl', 2026)
lgs_nm = [d["name"] for d in lgs]
```
Key endpoints this implies for the TS side: `GET /v1/user/<name>` → user_id; `GET /v1/user/<user_id>/leagues/nfl/<season>` (all leagues); `GET /v1/league/<id>/matchups/<week>`. `get_all_players()` has `gsis_id` → join straight to our crosswalk by gsis for `player_key` (cleaner than the name match we use now).

### Conventions
One PR per feature; `tsc -b` + eslint + `vite build` green before shipping; verify UI with headless puppeteer (`npm i --no-save puppeteer`) against `npx vite preview` on a fresh port (don't `pkill`). Merge via GitHub MCP tools. Commit/PR footer = session URL; never commit the model id.

### Gotchas
- `public/data/*` is gitignored with `!` allowlist exceptions — new committed data files need a matching `!` line (`!public/data/schedule-*.json` already added).
- ESPN abbrevs → ours: `LAR→LA`, `WSH→WAS` (`ESPN_TO_OURS`). Our codes == nflverse.
- Committed-date ET offset heuristic: `-04:00` (Aug–Oct) else `-05:00`. Headless test browser is UTC so times display shifted there (fine in user's browser).
- Build sandbox egress = curated allowlist (GitHub reachable). App also fetches live in the browser (KTC, schedule ESPN overlay) — not subject to the sandbox allowlist.

### Shipped this stretch
- Scenario Builder = full-page tab (`embedBuilder` on `StatProjections`; scenario in `App`). Team Workspace primary: division selector+logos, click ▲/▼ steppers (step 1), targets/carries cascade to rec/yds re-based off original rates, all team levers in one "Team adjustments" box (Pass/Run, Team Volume, 11 team-stat sliders), Tgt column, subtotals + Team Total + "Δ vs Base", PPR-delta badge, collapsible current roster, clickable names → PlayerDetail, Overall Rankings panel.
- Excel export (`src/lib/exportTeamXlsx.ts`, exceljs, live formulas).
- Schedule & SOS tab (`src/components/ScheduleView.tsx`, `src/lib/nflSchedule.ts`): committed nflverse reg season + committed networks (`scripts/parse_schedule_pdf.py`) + committed preseason (`scripts/build_preseason.mjs`) + ESPN runtime overlay. SOS = opponent offensive strength, reg-season only (overall + thirds + per-game).
- Fixed player-card career chip 100× scaling; rookie-optimistic preset → +25%.

### To-do list (user's original 8, with status)
1. ✅ Collapsible current-team rosters in Scenario Builder (PR #316)
2. ✅ Team schedules + estimated SOS (PRs #318–#321; reg+preseason committed, SOS overall/thirds)
3. ⬜ Clean up + test the **My Rankings** page (scope it with the user — bugs? layout?)
4. 🟡 **Consensus Projections** = blend Clay + our base. Clay 2026 guide extracted: `scripts/extract_clay_projections.py <pdf>` → `public/data/clay-projections-2026.json` (448 offensive players QB/RB/WR/TE/K, 98% joined to player_key) (PR #326). ⚠️ PDF is a manual drop, NOT committed (ESPN's; surfaced only as "Consensus"); re-run the extractor on each new guide. The **80% Clay / 20% us blend now ships** as the "Consensus" preset in the Scenario Builder (PR #327): `StatProjections` loads the committed file → `clayPprMap`; the pre-existing `consensus` preset in `scenarioPresets.ts` blends per-player PPR via `pointsOverrides`. PR #327 also hardened `normalizeName` (was crashing the whole projections build on a missing-name data row). **Still open**: richer pipelines from the PDF — unit grades p63 → SOS opponent-quality, projected SOS p62, team projections pp2-33, IDP, win prob.
5. ✅ **Sleeper API** features — league import (#323), `sleeper_id`→`player_key` PlayerDetail links (#324), Consensus ADP (#325), **team projections + matchup win-prob on roster view**; trending/projections already existed. (Note: Sleeper has no public ADP API — Consensus ADP uses FantasyCalc's Sleeper-inclusive redraft snapshot, already refreshed daily by `fetch-fantasycalc-snapshot.yml`. `maybeAdp` is null in offseason; the view shows live consensus value/rank and auto-reveals the ADP column in-season.)
6. ⬜ Add **Scenario Builder to the Home/intro page menu** (quick win).
7. ⬜ Better **player cards** with stats + images (career-chip scaling already fixed; build a richer inline card).
8. ⬜ Test + clean up the **Draft Optimizer** for the upcoming season.

Extra (not on original list): ✅ SOS true opponent-quality — now uses Consensus DEFENSE grades (PR #328: `scripts/extract_clay_unit_grades.py` → `public/data/clay-unit-grades-2026.json`; `nflSchedule.ts` `teamStrength`/`computeSOS` take optional grades, fall back to offense proxy when absent). ✅ Team projections + matchup win-prob (PR #329: `scripts/extract_clay_team_pages.py` → `clay-matchups-2026.json` (272 games: proj score + win prob) + `clay-team-projections-2026.json` (32 teams: PF/PA, proj wins, Off/Def/Ovr rank); Schedule view shows a per-game Proj column + a "Consensus team outlook" strip; team pages identified by opponent-fingerprint match vs committed schedule). The ~24 reg-season network gaps remain TBD on ESPN (re-run `enrich_schedule_espn.mjs` once assigned).

**Clay PDF pipeline status**: extractors = `extract_clay_projections.py` (players; now year-agnostic — detects position by page title, takes optional out-path), `extract_clay_unit_grades.py` (p63 grades), `extract_clay_team_pages.py` (pp2-33 matchups + team proj). Re-run all three on each new PDF drop. Remaining unused: IDP defenders (pp46-55), category leaders (pp58-60), projected standings/draft order (p61), coaching staffs (p74), projected starters w/ ratings (pp75-82).

**Blend-weight study** (`scripts/clay_blend_study.py`): scores Clay + a prior-year-rates baseline vs actual season PPR (`player_stats_<Y>`) and sweeps the per-position blend weight. Historic player projections are committed under `public/data/clay-projections-<year>.json` (2023/2024/2026 present); just run:
```
python3 scripts/clay_blend_study.py --years 2023,2024          # add years as PDFs are processed
# new PDF: python3 scripts/extract_clay_projections.py <hist.pdf> <year> public/data/clay-projections-<year>.json
```
Findings so far (2023-2024, n=284, non-rookie): aggregate optimal ≈ **0.80 Clay** (validates the flat 80/20). By position: **QB ~0.40-0.45** (Clay no better than priors!), RB ~0.85-0.90, WR ~0.70-0.80, TE ~0.80-1.0. ⚠️ "baseline" is prior-year rates, not our real ensemble → these are UPPER BOUNDS on Clay weight; rookies excluded (a Clay strength — keep Clay high for them). **TODO when more historic PDFs arrive (user has 5, esp. 2025)**: re-run, then set per-position weights in `scenarioPresets.ts` (currently flat `CONSENSUS_CLAY_WEIGHT = 0.8`), mainly pulling QB down.

---

## Where things stand

**Default branch**: `claude/nfl-fantasy-workbench-6D1yd` (NOT `main`). Deploy workflow fires on push there.

**Last working branch**: `claude/fix-percentile-score-inconsistency-NGos1` — merged into default as of `d50cf9b`. Assume clean.

## What shipped recently (PRs in reverse chron order)

| PR | Topic |
|---|---|
| (merged 88a48b3) | `player_key` stamped onto `player_stats` via DuckDB LEFT JOIN. Python: `resolve_player`, `get_player`, `load_player_profile`. Ask-tab prompt tells Claude to prefer `player_key` joins. 14/14 smoke tests. |
| 211 | Unified `player_crosswalk` — 11669 players, `sh_<hex>` keys. 0 unresolved cases. Alias file at `public/data/player-aliases.json`. Builder: `scripts/build-player-crosswalk.py`. |
| 210 | Ask mode in Data Query tab — Claude tool-use over DuckDB, single `run_sql` tool, api key in localStorage. |
| 209 | "Dedupe rows" toggle on Data Query. |
| 207 | Reddit scrape gated behind `ENABLE_REDDIT_SCRAPE=1` (features never populated). |
| 206 | Publish workflow supports `workflow_dispatch` (mobile-friendly PyPI releases). |
| 205 | QB boomZ/bustZ now surface on Dynasty Prospects. |
| 204 | Big roll-up: WR-R1 cap authoritative in Python/TS, name-merge infrastructure, manual CFBD overrides for 10 players, team-talent forward-fill, Data Query (SQL) tab with DuckDB-WASM, `stathead` Python package + CI. |

## Data surfaces, one-liner each

| Surface | Where | Notes |
|---|---|---|
| Dynasty Prospects tab | `src/components/RookieProspectsView.tsx` | Has a Download CSV button. |
| My Prospect Rankings tab | `src/components/MyProspectRankings.tsx` | Shows **Pctl** column + model tier names (Alpha / Blue Chip / …). |
| Career Backtest tab | `src/components/RookieCareerBacktest.tsx` | WR-R1 cap is defense-in-depth here (canonical cap lives in Python). |
| ZAP Compare tab | `src/components/ZapComparison.tsx` | Methodology text is model tier names. Legacy-year rows read already-capped Python backtest. |
| Data Query tab | `src/components/DataQuery.tsx` + `src/lib/duckdb.ts` | DuckDB-WASM, 8 tables. "SQL" and "Ask" modes. |
| Model Docs | `src/components/ModelDocumentation.tsx` | Feature labels live in `src/lib/featureTypes.ts` FEATURES. |
| Player cards | `src/components/PlayerCard.tsx` | `ZERO_MEANS_MISSING` set at top; PDF/RSP features are NOT in it (have has-indicators instead). |

## DuckDB tables in the SQL tab (for Ask mode too)

All joinable on `player_key`:

- `player_crosswalk` — canonical identity; every known alt ID (gsis/pfr/sleeper/espn/pff/yahoo/sportradar/ktc).
- `career_2026` — 2026 rookies, flattened features, `player_key` stamped.
- `backtest` — historical 2010-2025 rookies with pred + actual, `player_key` stamped.
- `prospects` — 2026 draft scouting grades.
- `player_stats` — weekly NFL stats 2010-2026; `player_key` stamped via crosswalk join on gsis.
- `adp_historical` — 4507 rows, 2010-2025, training ADP, `player_key` stamped.
- `adp_ffc` — FFC API raw (currently 2025 only — **2024 and earlier still missing**).
- `ktc` — current dynasty values.
- `ktc_history` — daily KTC value history.

## Python package (`python/`)

`stathead 0.1.0` published via workflow_dispatch. Exports: `load_*` loaders + `resolve_player`, `get_player`, `load_player_profile`. Tests in `python/tests/test_smoke.py` (14/14). Cache under `~/.cache/stathead/<ref>/`.

To release `0.2.0` (includes the three new helpers):

1. Bump version in `python/pyproject.toml` + `python/src/stathead/__init__.py` to `0.2.0`.
2. Commit + push.
3. Actions → **Publish stathead to PyPI** → **Run workflow** → branch `claude/nfl-fantasy-workbench-6D1yd` → Run. PyPI trusted publisher (OIDC) handles auth.

## Open work items (ranked by leverage)

1. ~~**Post-draft rookie key-promotion**~~ — ✅ done. `build-player-crosswalk.py` diffs the previous build's COL records; when a synthetic-COL rookie gains an nflverse gsis it rebinds to the spine record and stamps the old COL key into `alias_keys` (runtime `lookupByKey` fans `alias_keys` into `byKey`, so stale/bookmarked old keys still resolve). Back-references now also **carry forward across rebuilds** so they persist permanently (they previously evaporated on the next daily rebuild). Ambiguous/vanished cases fail-closed into `player-promotions.json`.

2. ~~**CI-run `scripts/build-player-crosswalk.py`**~~ — ✅ (partial). `fetch-sleeper-players.yml` now rebuilds + commits the crosswalk daily (06:45 UTC). Remaining: the KTC snapshot + weekly roster fetch still don't trigger a rebuild — fold a rebuild step into `refresh-data.yml` for full coverage.

3. ~~**Player detail page** at `/player/sh_<key>`~~ — ✅ done (shipped pre-this-session; `PlayerDetail.tsx` merges crosswalk IDs + career pred + ADP + KTC trend + news + game logs). This session pointed the last in-page-card tables at it via `PlayerName`.

4. **Refresh `adp_ffc` coverage** — only 2025 committed (sandbox firewall blocked FFC API). Run `bash scripts/pull-all-data-sources.sh` from an unrestricted environment to pull 2018-2024 + 2026.

5. ~~**Consolidate the `normalizeName` copies**~~ — ✅ done. The nine byte-identical copies are now in `src/lib/nameMatch.ts` (three behavioral families: `normalizeForMatch`, `normalizeNameSimple`, `normalizeNameUnicode`). Behavior-preserving. Three genuinely-divergent one-offs (StatProjections, TradeCalculator, ADPOutcomes) + the smarter `featureTypes.normalizeName` left as-is. (The "accepts player_key with name fallback" idea — a crosswalk-aware resolver — was not built; lower value now that names route through the crosswalk anyway.)

6. **Re-key `feature-store/*.json` shards** by `player_key::season` instead of `name::season`. Big refactor but cleaner long-term. (Still open — confirm appetite first.)

7. ~~**Alias-conflict detection**~~ — ✅ done. `build-player-crosswalk.py` emits `player-conflicts.json` flagging any gsis_id with >1 distinct birth_date across roster rows (42 today, mostly minor nflverse date noise). College was dropped as a signal (~675 formatting/transfer false positives). Tripwire for future bad merges; committed by both refresh workflows.

## Known quirks / gotchas

- **Default branch is `claude/nfl-fantasy-workbench-6D1yd`**, not `main`. Deploy + auto-commit both target it.
- **Base keeps moving during long sessions** — the auto-commit workflow pushes data refreshes to the default branch every few hours. A feature branch open for >2 hours will often need a base merge with `public/data/feature-matrix.json` conflicts. Always take **ours** on regenerable data files (feature-matrix, model-cache-career-\*, prospect-boom-bust, score-store/\*) because our branch has code changes base doesn't.
- **This sandbox's git proxy blocks tag pushes** (HTTP 403). Use `workflow_dispatch` on `python-publish.yml` for PyPI releases; can't `git push --tags`.
- **GitHub MCP server is flaky** — connects and disconnects intermittently within a session. When MCP tools are available, use them to open + merge PRs. When they're gone, direct user to the GitHub mobile web UI. The pattern is: `git push` from sandbox → paste compare-page URL → user taps Create PR + Squash merge.
- **FFC API is not reachable from this sandbox** — host not on allowlist. Any 2024-FFC-ADP pull has to happen outside the sandbox.
- **Roster files start at 2010** — players retired before 2010 (or cup-of-coffee guys like Clyde Gates) aren't in the crosswalk spine; they get minted as synthetic COL keys.
- **Pre-commit hook** at `.githooks/pre-commit` catches conflict markers + malformed JSON in `public/data/**`. Never try to commit files with `<<<<<<<` in them — fix conflicts first.
- **`training-rows-cache-v49.json` is frozen** — rebuilding from scratch requires CSV downloads this sandbox can't fetch. The backfill script (`scripts/backfill_cfbd_variants.py`) patches the cache in place. If a code change requires retraining on fresh features, bump the cache version rather than trying to rebuild v49.
- **WR Alpha tier cap** — requires first-round draft capital. Non-R1 WRs max at BlueChip. Enforced in `train_career_models.py` and `precompute-features.ts`; UI has defensive cap in `RookieCareerBacktest.tsx`.

## Useful one-liners

```bash
# Rebuild crosswalk (fast — ~10 seconds)
python3 scripts/build-player-crosswalk.py

# Regenerate feature-matrix.json (stamps player_key on career_2026)
npm run build:features

# Retrain career models (pre + post-draft; ~60 seconds)
python3 scripts/train_career_models.py

# Run Python smoke tests
python3 -m pytest python/tests -q

# Patch CFBD features on the training cache
python3 scripts/backfill_cfbd_variants.py
```

## Key file paths

```
scripts/
  train_career_models.py          — career model training, Python
  precompute-features.ts          — feature matrix + 2026 prospect scoring, TS
  build-player-crosswalk.py       — unified crosswalk builder
  backfill_cfbd_variants.py       — patch CFBD features onto training cache
  pull-all-data-sources.sh        — refresh all nflverse + FFC + college data
src/
  lib/duckdb.ts                   — DuckDB-WASM loader, table docs, example queries
  lib/askData.ts                  — Ask mode tool + system prompt
  lib/featureTypes.ts             — FEATURES catalog + nameVariants + FIRST_NAME_ALIASES
  components/DataQuery.tsx        — SQL / Ask tab with table-detail modal
  components/AskData.tsx          — chat UI for Ask mode
python/
  src/stathead/                   — pandas loaders + crosswalk helpers
  tests/test_smoke.py             — 14 tests
public/data/
  player-crosswalk.json           — 11669 canonical player records
  player-aliases.json             — 18 manual overrides + unresolved cases
  manual-cfbd-overrides.json      — 10 players missing from CFBD player-usage
  model-cache-career-v72.json     — trained career model, backtest rows
  feature-matrix.json             — 2026 predictions + feature importance
  feature-store/profile.json      — historical ADP (4507 rows, 2010-2025)
  feature-store/players.json      — per-player position + display name
```

## Context to carry into the next session

- User is dachhack, on mobile, building a fantasy football research site (stathead.xyz-style).
- Heavy investment in the rookie career model; recent work focused on data-quality (name merges, manual overrides, crosswalk), not new model features.
- Data Query tab is the crown jewel for analysts; Ask mode is new and unproven — user hasn't reported live usage yet.
- Python package is shipped but user hasn't promoted `0.2.0` yet.
- 2026 NFL draft happened (or is happening) — rookie key-promotion is time-sensitive.
- Keep new surfaces consistent with the model tier system (Alpha / Blue Chip / Starter / Contributor / Depth / Longshot). The old ZAP tier names (Legendary / Elite / Weekly Starter / …) still live in `src/lib/tierScore.ts` for PPG-to-tier-score mapping but should not appear in new UI.

## Quick sanity check on session start

```bash
git status                            # clean?
git fetch origin                      # sync refs
git log --oneline origin/claude/nfl-fantasy-workbench-6D1yd -n 5
python3 -m pytest python/tests -q    # 14/14 should pass
```

Good hunting.
