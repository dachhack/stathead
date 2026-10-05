# Daily-sport data service: contract

Partner-only service for NHL, MLB, NBA, WNBA, MLS and Premier League data, built
for Drip Fantasy's request (`docs/daily-sport-data-response.md`). Served by the
`workers/stathead-sports` Cloudflare Worker behind bearer tokens. Not listed on
the site, in the MCP server or in the main README, and no data from it is
committed to this repository.

## Auth

Every `/v1` route needs `Authorization: Bearer <token>`. Tokens are issued per
client (`API_TOKENS` secret). A missing or unknown token is a 401 with no body
beyond `{"error":"unauthorized"}`. `GET /` is an unauthenticated health check.

## Seasons

`season` is the year a season **starts** for NHL, NBA and the Premier League
(2026 = 2026-27) and the calendar year for MLB, WNBA and MLS. Omit it to get the season the daily job
last built (`/v1/meta` says which).

## Routes

| Route | Returns | Freshness |
|---|---|---|
| `GET /v1/meta` | per sport: `as_of`, `current_season`, `seasons`, row counts, ADP providers, notes | daily |
| `GET /v1/{sport}/teams` | canonical tricodes with `aliases` other feeds use | static |
| `GET /v1/{sport}/games?date=YYYY-MM-DD` | the slate for a US Eastern date | from the feed, cached 60 s |
| `GET /v1/{sport}/games?season=YYYY` | the season calendar (regular season and playoffs), three seasons | daily |
| `GET /v1/{sport}/games/{game_id}/lines` | box score: one row per player who dressed | stored final, else from the feed cached 60 s |
| `GET /v1/{sport}/players?season=YYYY` | directory | daily, injury fields hourly (`injuries_as_of`) |
| `GET /v1/{sport}/season-lines?season=YYYY` | season totals: five seasons for NHL and MLB, three for the rest | daily |
| `GET /v1/{sport}/adp?season=YYYY` | StatHead ADP blend | daily |
| `GET /v1/{sport}/crosswalk` | ids per player | daily |

`?format=jsonl` returns the rows one per line; `?format=csv` flattens nested
fields (`stats.pts`, `ids.espn_id`). The default JSON is an envelope:

```json
{ "sport": "nhl", "season": 2026, "as_of": "2026-10-05T11:42:10Z", "source": "nhl", "count": 1072, "rows": [ ... ] }
```

Every row carries `source` (the feed it came from); every response carries
`as_of`. Historical dates work wherever the feed serves them: NHL and MLB for
any season, NBA and WNBA through ESPN for any season (the league CDNs serve no
past day, which is why NBA and WNBA keys are ESPN ids).

## Rows

**Game** (`games`): `game_id, game_date (ET), start_utc, home, away, status
(pre | live | final | postponed | cancelled), clock, period, home_score,
away_score, season, game_type (pre | regular | post | other), source,
updated_at`.

**Line** (`games/{id}/lines`): `player_id, name, team, pos (feed code), played,
stats {…}, source`. The response also carries `game`, `stored` (true when
served from the materialised finals) and `revised_at` (set when a stored
final's lines changed on a later read; finals are re-read for three days).
Finals are stored for three seasons of NBA, WNBA, MLS, Premier League and
NHL, and for the last 30 days of MLB (an MLB feed is 800 KB a game); anything
older or still in progress is read from the feed.

**Player** (`players`): `player_id, full_name, team ('' for a free agent), pos,
eligible[], jersey, headshot_url, active, injury_status, injury_note, exp (0 in
the first season; null when unknown), debut_season, birth_date, ids {…},
source`. The directory is every player the fantasy universe or league lists as
active or injured, plus anyone with a line this season or last (as an inactive
row).

**Season line** (`season-lines`): `player_id, name, team (last), pos, season,
gp, stats {…}` summed over regular-season games; MLB adds `pos_games {C: 121,
DH: 38}` for eligibility and carries `hgp` / `pgp` inside `stats`.

**ADP** (`adp`): `player_id, name, team, pos, adp, sources, spread`. The
blend of every market that priced the player. This partner feed serves a
player priced by a single market too (owner decision, 2026-10-05); `sources`
says how many, and `spread` is 0 for one. The site, MCP and Python package
keep their two-source rule and never carry these boards.

**Crosswalk** (`crosswalk`): `player_id, full_name` and one column per id
known for the sport (`nhl_id`, `mlb_id`, `espn_id`, `sleeper_id`,
`sportradar_id`, `rotowire_id`, `swish_id`, `fantasypros_slug`).

## Ids

`player_id` is `<sport>-<id>` and never changes: the NHL id for NHL, the MLB
id for MLB, the ESPN id for NBA and WNBA. The crosswalk carries Sleeper ids for
all four sports (matched by name and team against Sleeper's player files), so
Drip's NBA pools (Sleeper ids) and WNBA pools (ESPN ids) map directly, and
NHL and MLB pools already use the league id.

## Stat dictionaries

Exactly the consumer's field ids. Derived fields are not served.

| Sport | `stats` keys |
|---|---|
| NBA, WNBA | `min pts fgm fga ftm fta tpm tpa oreb dreb reb ast stl blk tov pf` |
| NHL skater | `toi g a pm pim sog hit blk ppg ppa shg sha gwg fow fol gva tka` |
| NHL goalie | `gapp gs gtoi w l otl ga sv sa so` |
| MLB hitter | `pa ab h 2b 3b hr r rbi bb ibb hbp k sb cs sf sh gidp` (season: `hgp`) |
| MLB pitcher | `gs outs w l sv svo bs hld p_k p_bb p_h p_hr p_hbp er p_r bf pitches cg sho` (season: `pgp`) |
| MLS, Premier League | `min g a sh sot fc fs yc rc og off sv ga shf start sub_in cs tga` |

Details that matter: innings come as `outs`; `toi` and `gtoi` are decimal
minutes; `ppa` and `sha` are separated from assists (box scores read the game
centre's scoring summary, season lines the stats REST reports); faceoffs come
from the play-by-play per game and the faceoff report per season; `gwg` is the
winner's clinching goal in a final. A pitcher's row carries both dictionaries
(a two-way player has one row). `played` is true for a plate appearance, a
batter faced, time on ice, or minutes on the floor.

Soccer (a StatHead dictionary, since the request had none): `min` comes from
the substitution and red-card clocks (starters 90, or 120 with extra time);
`sv`, `ga` and `shf` are the goalkeeper's and 0 for everyone else; `cs` is 1
for a player with 60+ minutes whose team conceded nothing; `tga` is the
team's goals against in the match; `start` and `sub_in` are 1/0 flags; `off`
is offsides. Tenure comes from ESPN's athlete bio, a per-player read the
daily job caches by player id so only new players cost a call. Position
codes are ESPN's (G, D, M, F and the detailed codes
such as AM-R or LF in box scores).

## Team codes

One canonical set per sport from `/v1/{sport}/teams`; feed aliases are mapped
on this side (NJD/NJ, SJS/SJ, TBL/TB, LAK/LA, WSH/WAS, UTA/UTAH, CWS/CHW,
AZ/ARI, ATH/OAK, GSW/GS, NOP/NO, NYK/NY, SAS/SA, PHX/PHO, LVA/LV, LAS/LA,
NYL/NY, GSV/GS, CON/CONN).

## Sources

| Sport | Schedule, box scores | Directory | Season lines | ADP inputs |
|---|---|---|---|---|
| NHL | NHL game centre (`api-web.nhle.com`) plus play-by-play for faceoffs | NHL rosters, stats REST bios, Sleeper | NHL stats REST (summary, realtime, faceoffs, goalies) | FantasyPros columns (Yahoo), ESPN fantasy |
| MLB | MLB Stats API live feed | MLB Stats API players, people, 40-man rosters, Sleeper | MLB Stats API season leaderboards (hitting, pitching, fielding) | FantasyPros columns (Yahoo, CBS, RTS, NFBC, Fantrax, ESPN), ESPN fantasy in season |
| NBA | ESPN scoreboard and summary | ESPN fantasy universe, Sleeper | sum of stored final box scores | FantasyPros columns (Yahoo), ESPN fantasy |
| WNBA | ESPN scoreboard and summary | ESPN fantasy universe, Sleeper | sum of stored final box scores | none (see below) |
| MLS | ESPN scoreboard and summary (`soccer/usa.1`) | ESPN team rosters and athlete bios (tenure), MLS Fantasy availability | sum of stored final box scores | none |
| Premier League | ESPN scoreboard and summary (`soccer/eng.1`) | ESPN team rosters and athlete bios (tenure), FPL status, news and ids | sum of stored final box scores | none |

All of these are public, unofficial endpoints with no contract; see
`DATA_SOURCES.md`.

## Known gaps

- **WNBA ADP** has one reachable market, ESPN, and only in its draft window
  (real boards in 2024 and 2025, a sentinel for 2026). Yahoo runs no WNBA
  game and FantasyPros has no WNBA page. The board is served when ESPN's is
  populated and is empty otherwise.
- **Soccer ADP**: the Premier League board is FPL Draft's published draft
  rank (one market, the order its draft rooms use). MLS Fantasy has no draft,
  so MLS has no board.
- **Soccer tenure counts every professional stint.** `debut_season` is the
  earliest club season in the ESPN bio (reserve and second teams included,
  youth national sides excluded), and `exp` the seasons since; a player
  who came up through a reserve side carries that season as his first.
- **MLS Fantasy lags between campaigns.** Its player feed covered the prior
  season at the time of writing, so about half the ESPN roster matched;
  Premier League matching through FPL covers 539 of 585.
- **Soccer team codes are ESPN's**, with FPL's MCI and MUN aliased to MNC and
  MAN. MLS codes agree between ESPN and MLS Fantasy.
- **MLB ADP out of season** has FantasyPros' six columns only; ESPN's board
  opens in the spring.
- **Stat corrections** are detected for stored finals only, which excludes
  MLB games older than 30 days. NHL and MLB box scores are read from the feed on request and carry
  no `revised_at`.
- **Commissioner's Cup final** (WNBA) is filed by ESPN as a regular-season
  game and is summed into season lines; the All-Star game is excluded.
- **Freshness**: directories, season lines, calendars and ADP are daily (the
  job runs at 07:40 ET). Injury status and notes refresh hourly from the
  Worker's cron (Sleeper for NHL, MLB, NBA and WNBA; FPL for the Premier
  League; MLS Fantasy for MLS), joined on the platform ids in the crosswalk;
  the directory bundle and `/v1/meta` carry `injuries_as_of`. An MLB IL code
  from the 40-man rosters is never overridden by the hourly pass.
- **Alerting**: the daily job refuses to write a bundle that shrank more than
  10% against the stored one (30% for ADP), keeps the old bundle, marks the
  sport `failed` in `/v1/meta` and exits non-zero, so the Actions run goes
  red and the repository owner is notified.
