# FantasyCalc API

How StatHead consumes [FantasyCalc](https://fantasycalc.com) trade values, the
request contract, and the full response schema.

FantasyCalc derives player values from a large corpus of **real fantasy-league
trades** (it reports a per-player `maybeTradeFrequency`), which makes it a
trade-derived, first-party-ish alternative/complement to KTC. We ingest it for
dynasty + redraft trade values and ADP context.

> ⚠️ FantasyCalc does not publish a formal API spec. This document is derived
> from (a) our own call sites, (b) the `fc-proxy` worker contract, and (c) a
> live committed response snapshot (`public/data/fantasycalc_dynasty_1qb.json`).
> Fields/params we don't use are marked **unverified**.

---

## Base URL & the 403 gotcha

```
https://api.fantasycalc.com
```

`api.fantasycalc.com` returns **`403 host_not_allowed`** to most direct
browser/server requests (it allowlists callers server-side). So:

- **In production** the app reads committed daily snapshots
  (`public/data/fantasycalc_*.json`) — see `src/data.ts` `tryPreFetched`.
- **As a fallback / for CI refresh**, requests route through our Cloudflare
  Worker **`fc-proxy`** (`https://fc-proxy.dachhack.workers.dev`), which is
  allowlisted upstream and edge-caches responses for 1h.
  Source: [`workers/fc-proxy/src/index.ts`](../workers/fc-proxy/src/index.ts).
  - The worker only proxies `GET /values/current…` and restricts **CORS** to
    StatHead origins (`dachhack.github.io`, `stathead.app`, `*.pages.dev`,
    `localhost`). It forwards a `fantasycalc.com` Origin/Referer + browser UA
    upstream.
  - The proxy egress IP can itself be rate-limited/blocked by FantasyCalc
    (you may see `Host not in allowlist` passed through) — hence we prefer the
    committed snapshots and only hit the proxy on a miss.

---

## Endpoint: current values

```
GET /values/current
```

### Query parameters

| Param       | Type    | Values we send | Notes |
|-------------|---------|----------------|-------|
| `isDynasty` | boolean | `true` / `false` | `true` → dynasty values, `false` → redraft. **Required.** |
| `numQbs`    | int     | `1` / `2`        | `1` = 1QB, `2` = SuperFlex. **Required.** |
| `numTeams`  | int     | `12`             | League size. FantasyCalc supports other sizes (e.g. 8/10/14); we standardize on 12. |
| `ppr`       | number  | `1`              | Reception points. FantasyCalc supports `0` / `0.5` / `1`; we standardize on full PPR. |

Source: [`scripts/fetch-fantasycalc.cjs`](../scripts/fetch-fantasycalc.cjs),
[`scripts/download-api-data.sh`](../scripts/download-api-data.sh).

### Variants we snapshot

| File (`public/data/`)          | `isDynasty` | `numQbs` |
|--------------------------------|-------------|----------|
| `fantasycalc_dynasty_1qb.json` | `true`      | `1`      |
| `fantasycalc_dynasty_sf.json`  | `true`      | `2`      |
| `fantasycalc_redraft_1qb.json` | `false`     | `1`      |
| `fantasycalc_redraft_sf.json`  | `false`     | `2`      |

Returns a **JSON array** of player-value objects, sorted by `overallRank`
(≈ 460 players for dynasty 1QB).

---

## Response schema

Each array element (verified against a live snapshot — Bijan Robinson, dynasty
1QB):

```jsonc
{
  "player": {
    "id": 9833,                 // FantasyCalc player id
    "name": "Bijan Robinson",
    "mflId": "16161",           // MyFantasyLeague id
    "sleeperId": "9509",        // ← Sleeper id (clean join to our crosswalk)
    "position": "RB",
    "maybeBirthday": "2002-01-30",
    "maybeHeight": "71",        // inches (string)
    "maybeWeight": 215,
    "maybeCollege": "Texas",
    "maybeTeam": "ATL",
    "maybeAge": 24.4,
    "maybeYoe": 3,              // years of experience
    "espnId": "4430807",
    "fleaflickerId": "17603",
    "ffpcId": "28755"
  },
  "value": 10830,               // trade value on FantasyCalc's scale (this variant)
  "overallRank": 1,
  "positionRank": 1,
  "trend30Day": -337,           // value change over trailing 30 days
  "redraftValue": 10416,        // same player's redraft value
  "combinedValue": 21246,       // dynasty + redraft
  "redraftDynastyValueDifference": -414,
  "redraftDynastyValuePercDifference": 3,
  "maybeMovingStandardDeviation": 0,
  "maybeMovingStandardDeviationPerc": 0,
  "maybeMovingStandardDeviationAdjusted": 2,
  "displayTrend": true,
  "maybeOwner": null,           // populated only in league-context calls
  "starter": false,
  "maybeTier": 1,
  "maybeAdp": null,             // ADP when populated, else null
  "maybeTradeFrequency": 0.007, // how often this player appears in trades (market-activity signal)
  "maybeRosterPercent": null
}
```

### Field notes

- **`player.sleeperId`** — present on every player, so FantasyCalc → our
  `player-crosswalk.json` is a direct id join (`lookupBySleeperId`), no
  name-matching. We normalize the array into our `DynastyPlayer` shape in
  [`src/data.ts`](../src/data.ts) (`fetchFantasyCalcValues`). The TS interface
  is `FantasyCalcPlayer` in [`src/types.ts`](../src/types.ts) (note: the
  interface is a subset — the live response carries more fields, listed above).
- **`value`** is on FantasyCalc's own scale **for the requested variant**
  (1QB vs SF differ); not directly comparable to KTC's scale without rescaling
  (see [`src/lib/valueRescale.ts`](../src/lib/valueRescale.ts) /
  `dynasty-fc-rescale.json`).
- **`maybeTradeFrequency`** is the closest thing to a market-volume signal — it
  reflects how often a player shows up in real trades, which is what underpins
  FantasyCalc's values.
- **`maybe*` fields** are nullable; `maybeOwner` / `maybeRosterPercent` only
  populate in league-scoped calls (not the public `/values/current`).

---

## Identity join (FantasyCalc → StatHead)

```
fc.player.sleeperId  →  crosswalk.sleeper_id  →  player_key
                                              →  ktc_id, gsis_id, espn_id, …
```

See [`scripts/build-player-crosswalk.py`](../scripts/build-player-crosswalk.py)
and [`src/lib/playerLookup.ts`](../src/lib/playerLookup.ts). FantasyCalc also
ships `espnId` / `mflId` / `ffpcId` / `fleaflickerId` as secondary join keys.

---

## Caching, refresh & etiquette

- Daily snapshots are refreshed by CI:
  [`.github/workflows/fetch-fantasycalc-snapshot.yml`](../.github/workflows/fetch-fantasycalc-snapshot.yml)
  → runs `scripts/fetch-fantasycalc.cjs` → commits `public/data/fantasycalc_*.json`.
- The `fc-proxy` worker edge-caches each `/values/current` query for 1h, so the
  app almost never hits FantasyCalc directly.
- Prefer the committed snapshot; only fall back to the live proxy on a miss.
  Don't poll the upstream tightly — it allowlists callers and rate-limits.

---

## In-repo references

| Concern | File |
|---|---|
| Fetch + variant list | `scripts/fetch-fantasycalc.cjs`, `scripts/snapshot-fantasycalc.cjs` |
| Raw endpoint (`curl`) | `scripts/download-api-data.sh` |
| CORS/allowlist proxy | `workers/fc-proxy/src/index.ts` |
| Client fetch + normalize | `src/data.ts` (`fetchFantasyCalcValues`, `FC_BASE`/`FC_PROXY`) |
| Response type | `src/types.ts` (`FantasyCalcPlayer`) |
| ADP usage | `src/lib/adpSources.ts` |
| Value rescaling (vs KTC) | `src/lib/valueRescale.ts`, `public/data/dynasty-fc-rescale.json` |
| Attribution | `DATA_SOURCES.md` |
| Local env (proxy override) | `.env.example` (`VITE_FC_PROXY`) |

---

## Not used / unverified

The following are **not** confirmed from our usage and are **not** documented
here to avoid guessing — verify against FantasyCalc before relying on them:

- A **historical / time-series** values endpoint (we build our own dynasty
  value history from KTC, not FantasyCalc).
- **League-scoped** calls that populate `maybeOwner` / `maybeRosterPercent`.
- Additional `numTeams` / `ppr` permutations beyond the four variants above.
