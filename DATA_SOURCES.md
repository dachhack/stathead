# Data sources, licensing & redistribution

StatHead's **code** is MIT-licensed (see [`LICENSE`](LICENSE)). The **data** it
fetches, caches, and serves is a different matter: it comes from many
upstreams, and several are proprietary or paid. **An MIT license on the code
grants you no rights to the third-party data.**

This document inventories every source, what it's used for, and — most
importantly — **whether you can redistribute it**. Read it before you publish a
dataset, ship a public API, stand up your own deployment, or build a commercial
product on top of this repo.

> ⚠️ **Nothing here is legal advice.** Upstream terms change; verify each
> source's current Terms of Service / license before relying on it. When in
> doubt, fetch from the original source under your own access rather than
> redistributing a cached copy.

---

## TL;DR — the redistribution traffic light

| Tier | Can you redistribute the data? | Sources |
| --- | --- | --- |
| 🟢 **Open** | Yes, with attribution | nflverse, DynastyProcess, cfbfastR / sportsdataverse, JackLich10 draft data, mrcaseb nfl-data |
| 🟡 **Public API** | Query it yourself under your own keys/terms; **don't** rebundle bulk dumps | Sleeper, FantasyFootballCalculator, ESPN public endpoints, CollegeFootballData (CFBD), The Odds API |
| 🟠 **Proprietary values (scraped)** | No — attribute and link, don't republish | KeepTradeCut, FantasyCalc |
| 🔴 **Paid products** | No — derived/anonymized features only; never the source | Mike Clay (ESPN+), RSP (Waldman), The Beast (Brugler/The Athletic), PFF, Pro-Football-Reference / Sports Reference, expert rankings |
| 🔵 **Yours** | Yes — it's StatHead's own output | trained models, prospect grades, ZAP scores, projections (⚠️ but see the caveat on training rows) |

---

## 🟢 Open data — redistribute with attribution

These ship under permissive/open licenses. Keep the attribution and you're fine.

- **[nflverse](https://github.com/nflverse/nflverse-data)** — the backbone:
  player stats, weekly stats, snap counts, rosters, depth charts, injuries,
  Next Gen Stats, play-by-play, participation, contracts. Data is generally
  CC-BY-4.0; code is MIT. Attribute "nflverse."
- **[DynastyProcess](https://github.com/dynastyprocess/data)** — FantasyPros
  ECR values / crosswalk (`db_fpecr_latest.csv`).
- **[cfbfastR / sportsdataverse](https://github.com/sportsdataverse/cfbfastR-data)**
  — college football schedules.
- **[JackLich10/nfl-draft-data](https://github.com/JackLich10/nfl-draft-data)**
  — historical NFL draft data.
- **[mrcaseb/nfl-data](https://github.com/mrcaseb/nfl-data)** — supplemental
  feeds (e.g. lateral yards).

## 🟡 Public APIs — fetch yourself, don't rebundle

Free to query, but their Terms govern reuse. Querying under your own access is
fine; **redistributing bulk snapshots as a dataset generally is not.** Use your
own proxies/keys (`workers/`, `.env.example`) so you aren't leaning on — or
rate-limited by — anyone else's.

- **[Sleeper API](https://docs.sleeper.com/)** — player master list, ADP,
  trending adds/drops, projections.
- **[FantasyFootballCalculator](https://fantasyfootballcalculator.com)** — ADP
  by format.
- **ESPN public endpoints** (`site.api.espn.com`, `lm-api-reads.fantasy.espn.com`,
  `*.espncdn.com`) — scoreboard, fantasy ADP, player news/overview, headshots,
  logos. **Undocumented/unofficial**; subject to ESPN's ToS. Treated as
  abuse-controlled, per-user live calls — not bulk-cached.
- **[CollegeFootballData (CFBD)](https://collegefootballdata.com)** — college
  stats, SP+ ratings, recruiting. Requires a (free) `CFBD_API_KEY`; attribution
  requested, reselling raw data restricted.
- **[The Odds API](https://the-odds-api.com)** — live betting odds. Requires
  `VITE_ODDS_API_KEY`; **redistribution of odds is prohibited** by their terms.
  Key-gated and hidden by default.

## 🟠 Proprietary community values — scraped, do not republish

Fetched through the Cloudflare Worker CORS proxies in [`workers/`](workers/) and
cached as daily snapshots in `public/data/`. These are the providers' own
proprietary valuations. **Attribute and link to them; do not repackage their
values as a dataset or resell them.** If you redeploy, expect to be rate-limited
and consider whether your usage fits their terms.

- **[KeepTradeCut](https://keeptradecut.com)** — community dynasty rankings &
  value histories (`public/data/ktc_*`).
- **[FantasyCalc](https://fantasycalc.com)** — dynasty/redraft trade values
  (`public/data/fantasycalc_*`).

> **MCP exposure (important):** the `stathead-mcp` package does **not** serve
> these raw feeds. `get_dynasty_values` returns StatHead's **blended** value
> (KTC rescaled to FantasyCalc's scale via `dynasty-fc-rescale.json`), labeled as
> StatHead's own — the same value the website shows. The raw KTC/FantasyCalc
> snapshots are inputs used to *compute* that blend, not redistributed verbatim
> through the tools. A standalone raw-FantasyCalc tool was removed for this
> reason. (The blend is still *derived* from these sources, so the providers'
> terms still inform what you should do with it.)

## 🔴 Paid products — never redistribute the source

These are **paid** products. StatHead already handles them carefully and you
**must** keep doing so:

- **Mike Clay's NFL Projection Guide** (ESPN+) — the PDF is **not committed**,
  and the extracted `clay-*.json` numbers are now **gitignored / local-only**
  (regenerate with `scripts/extract_clay_*.py` from a PDF you own). They are
  surfaced only as an **anonymized "Consensus"** blend, never attributed to
  Clay. Only that derived blend ships; the raw per-player extracts must never be
  committed. (They were briefly committed via `!clay-*` un-ignore rules — that
  is fixed: the rules are removed and the files untracked.)
- **Rookie Scouting Portfolio (RSP)** — Matt Waldman's paid guide. The cached
  text is **gitignored**; only derived numeric features are kept
  (`scripts/_extract_rsp_2026.py`).
- **"The Beast"** — Dane Brugler's draft guide (The Athletic), paid. Cached PDF
  **gitignored**; only derived features kept (`scripts/_extract_beast_*.py`).
- **Expert rankings** (the Social Graph) — the analyst username map is
  **encrypted** (`expert-names.enc.json`, raw gitignored;
  `scripts/encrypt-expert-names.mjs`).
- **[PFF](https://www.pff.com)** — paid; referenced only, not redistributed.
- **[Pro-Football-Reference / Sports Reference](https://www.pro-football-reference.com/)**
  — restrictive ToS, no bulk redistribution. (Also relevant to the project name
  — see below.)

**The rule:** keep the source paywalled material out of the repo; only ship
derived numeric features, and anonymize provider-attributed projections.
Bundling these into a widely shared repo invites takedowns and exposes
downstream users to infringement too.

## 🔵 StatHead's own output — free to share

This is your IP, generated by your pipeline:

- **Trained models** — `public/data/model-cache-*`, `trained-models-cache-*`,
  `feature-store/`.
- **Prospect grades** — `prospect-grades-*.json`, `build-prospect-grades-*`.
- **ZAP scores** — `zap-scores-*.json`.
- **Projections** — `redraft-projections`, team/unit projections you compute.
- **Props & rest-of-game splits** — `player-props-*.json`,
  `quarter-splits-*.json`. Derived entirely from nflverse open data (🟢
  play-by-play, weekly stats, injuries, schedule) plus StatHead's own season
  projection, so they carry no proprietary columns.

> ⚠️ **Caveat — training rows & feature matrix.** Files like
> `training-rows-cache-*.json` and `feature-matrix.json` are derived, but they
> **embed upstream proprietary values as feature columns** (KTC, FantasyCalc,
> Clay "Consensus", RSP/Beast-derived numbers). Publishing them wholesale would
> leak 🟠/🔴 data. Share **model weights** freely; treat **raw training rows**
> as if they were the upstream data they contain.

> ❓ **Verify origin** — the bundled `src/data/NCAA_*.xlsx` /
> `ncaa_*.csv` college files predate this audit; confirm their source and terms
> before redistributing.

---

## A note on the project name

**"Stathead" is a registered product of Sports Reference LLC**
([stathead.com](https://stathead.com)). Using the name privately is one thing;
promoting `stathead.app` widely as a brand that others build on raises a real
trademark-collision risk. Consider clearing or changing the name **before** you
put marketing weight behind it — renaming is cheap now and painful after
adoption.

---

## If you want to redistribute a dataset

The clean path that keeps you (and your users) safe:

1. **Ship only 🟢 + 🔵 data** (open sources + your own model outputs/grades).
2. For 🟡/🟠/🔴, ship **scripts that fetch from the original source** under the
   user's own keys/access — not committed copies.
3. Publish your model outputs as a **[Hugging Face](https://huggingface.co/datasets)**
   or **[Kaggle](https://www.kaggle.com/datasets)** dataset with this file's
   attributions.
4. Keep this document current as sources change.
