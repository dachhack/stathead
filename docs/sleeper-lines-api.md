# Sleeper Picks lines endpoint

What we know about the endpoint `scripts/price-lines.py` reads Sleeper Picks'
player over/unders from, and how we guard against it changing.

**It is undocumented.** Sleeper's public API docs
([docs.sleeper.com](https://docs.sleeper.com/)) cover users, leagues, drafts,
players and trending players only. Nothing there covers Picks lines, and no
community API wrapper covers this endpoint. It appears to be what the Sleeper
app itself calls. Everything below comes from reading responses, last checked
2026-11-02. Example values are illustrative, not real lines. It has no version, no changelog and no guarantee, so treat every
field as subject to change.

## Endpoints

| | URL | Used for |
|---|---|---|
| Lines | `https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.0` | the slate: every open over/under across sports |
| Schedule | `https://api.sleeper.app/schedule/nfl/regular/<season>` | `game_id` → week, and the slate check's upcoming games |

- **No auth.** Both endpoints answer an anonymous GET. We send a
  `User-Agent: stathead-price-lines/1.0` header.
- **Query parameters:** we send them because the app does, but we don't know
  exactly what they do. `include_preseason` presumably adds preseason
  markets. `dynamic` and `eg` are unknown. Don't drop them without checking
  the response is unchanged.
- **Neither endpoint is under `/v1/`**, unlike the documented API.
- **Rate:** the docs ask for under 1,000 calls a minute across the API, or
  risk an IP block. We make one lines call and one schedule call per pricing
  or tracking run (hourly at most).

## Lines response

A JSON **array of markets**, about 1,100 on a Monday in season, across
sports. One market is one player's one stat, with one option per side.

### Market fields

| field | example | notes |
|---|---|---|
| `sport` | `"nfl"` | also `nba`, `cfb`, `nhl`, `tennis`, `cs`, `clubsoccer:<league>` … |
| `subject_type` | `"player"` | |
| `subject_id` | `"1234"` | **the Sleeper player id**. We join it to `sleeper` in the weekly projections |
| `wager_type` | `"rushing_yards"` | the stat (see below) |
| `outcome_type` | `"over_under"` | |
| `line_type` | `"normal"` | other values presumably for promos or alternates; we keep `normal` only |
| `status` | `"active"` | |
| `game_status` | `"pre_game"` | we skip markets whose game has started |
| `game_id` | `"202610830"` | Sleeper's game id. `<season><week 2 digits><nn>` so far, but we read the week from the schedule, not the id |
| `season`, `season_type` | `"2026"`, `"regular"` | |
| `market_type` | `"rushing_yards_over_under_player_1234"` | `<wager>_<outcome>_<subject_type>_<id>` |
| `updated_at` | `1793500000000` | epoch ms |
| `pick_stats` | `{"counts": {"over": 40, "under": 10, "total": 50}, "popularity": 0.5, …}` | how many Sleeper users picked each side |
| `recent_performance` | `{"values": [{"date", "opponent", "value"}, …]}` | the player's recent results for the stat. **Unused** |
| `options` | `[…]` | one per side, below |

### Option fields (one per side)

| field | example | notes |
|---|---|---|
| `outcome` | `"over"` / `"under"` | |
| `outcome_value` | `52.5` | **the line**, the same on both sides |
| `payout_multiplier` | `"1.78"` | **a string**. The per-leg multiplier for that side |
| `status` | `"active"` | a side can be suspended while the other stays open |
| `line_id` | `"1234…"` | |
| `subject_team`, `subject_position`, `subject_pos_rank` | `"CHI"`, `"RB"`, `"RB1"` | |
| `metadata` | `{}` | |

The option also repeats most market fields: `sport`, `subject_id`,
`wager_type`, `game_id` and so on.

### Wager types

NFL wager types seen on 2026-11-02, and the ones we price
(`SLEEPER_WAGERS` in `scripts/price-lines.py`):

| wager_type | our stat |
|---|---|
| `receptions` | `rec` |
| `receiving_yards` | `recYds` |
| `rushing_yards` | `rushYds` |
| `rushing_attempts` | `rushAtt` |
| `rushing_and_receiving_yards` | `rushRecYds` |
| `passing_yards` | `passYds` |
| `passing_touchdowns` | `passTD` |
| `passing_and_rushing_yards` | `passRushYds` |
| `anytime_touchdowns` | `anyTD` |

**Seen but not priced:** `fantasy_points`, `longest_reception`,
`longest_rush`, `longest_passing_completion`, `pass_completions`,
`passing_attempts`, `interceptions`, `tackles`, `assists`,
`tackles_and_assists`, `sacks`, `extra_point_made`, `field_goal_made`,
`kicking_points`. To price one, map it in `SLEEPER_WAGERS` and make sure the
simulation draws its components (`PICK_STATS` in
`scripts/score-weekly-projections.py`).

## Schedule response

A JSON array of games:
`{"game_id", "week", "date": "YYYY-MM-DD", "status", "home", "away"}`.
`status` is `"complete"` once the game is played.

## What we read

`sleeper_slate()` in `scripts/price-lines.py` keeps a market when all of
these hold:
- `sport == "nfl"`, `subject_type == "player"`, `outcome_type == "over_under"`
- `status == "active"`, `line_type == "normal"`, and `game_status` is
  `pre_game` or missing
- the wager is in `SLEEPER_WAGERS`
- both sides are active

Each kept market becomes one line spec:

| spec field | from |
|---|---|
| `sleeper` | `subject_id` |
| `stat` | `wager_type` via `SLEEPER_WAGERS` |
| `line` | the over option's `outcome_value` |
| `multOver`, `multUnder` | each side's `payout_multiplier` |
| `game_id`, `week` | `game_id`, and its week from the schedule |
| `publicOver`, `picks` | `pick_stats.counts` (over ÷ total, total) |
| `team` | the over option's `subject_team` |
| `updatedAt` | `updated_at` |

`scripts/track-lines.py` reads the same slate hourly from Thursday to Monday
to track how our recorded picks' lines move.

## The slate check

`check_slate()` in `scripts/price-lines.py` runs after every fetch, so a
change on Sleeper's side fails a run instead of quietly pricing nothing. It
raises `SlateError` when:

- **the response is not a list:** the shape changed.
- **no NFL player over/unders are up while an NFL game is scheduled in the
  next `SLATE_LOOKAHEAD_DAYS` (4) days:** the endpoint, its filters or the
  sport tag changed. Off weeks, the gap after Monday night and the offseason
  pass, because no game is that close. If the schedule itself fails to load,
  this check is skipped and a warning is printed.
- **fewer than `SLATE_MIN_PARSED` (half) of the active, pre-game NFL markets
  for stats we price parse into lines:** a market or option field was
  renamed or moved. A few suspended sides don't trip it.

**What happens when it trips:**
- **`price-lines.py`** prints a GitHub `::error` annotation and exits 2, so
  the Pick lines run (`.github/workflows/pick-lines.yml`) fails.
- **The daily report's Pick lines card** shows 🚨 with the run link when the
  workflow's newest run in the last 3 days failed, and the email subject
  counts it.
- **`track-lines.py`** logs that the slate wasn't read and tracks nothing,
  which keeps the hourly runs from going red on the same fault.

Tests: `python3 scripts/test-sleeper-slate.py`.

**When it trips:** fetch the endpoint by hand and compare it with the tables
above. Then fix `sleeper_slate()` (and this doc) for what changed. If the
endpoint is gone or now needs a login, typed lines still work
(`price-lines.py "Player stat 54.5 @1.78"`, or the MCP `price_lines` tool).

## Data policy

The slate is third-party input (`docs/third-party-data-policy.md`):
- **Cache:** it's cached under `.cache/sleeper-lines/` (gitignored) and in
  the Actions cache for the week, never committed.
- **Pick log:** only the lines StatHead leaned on are written to
  `data/pick-log.json`, which is committed and not deployed.
- **Site:** the Research > Sleeper Picks page shows those leaned-on lines
  (owner decision 2026-11-01), never the payouts or pick shares.
  `scripts/build-pick-board.py` allowlists the fields.
- **Terms:** Sleeper's API docs make the documented API free for
  non-commercial use and ask commercial users to license it. This endpoint
  isn't covered by those docs at all. Check Sleeper's terms of service
  before any commercial use of the slate.
