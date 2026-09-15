# Handoff — Swap Meet by StatHead (trade negotiation)

State as of 2026-09-15. Everything below is on the dev branch
(`claude/nfl-fantasy-workbench-6D1yd`) and the worker is deployed. Production
(`production` branch, promoted by the "Promote to Production" workflow) is
behind dev by several rounds — see **Before you do anything**.

## What it is

A trade negotiation two managers share by link, no accounts. The proposer
builds a trade in the **Trade Finisher** (Dynasty → Trade Calculator →
"Trade finisher"), picks one or more versions, writes a pitch, and gets two
links: their own and the partner's. Each side votes on versions, counters
with their own, marks versions final, leaves notes; two "I'd accept" votes on
one version is a deal. The partner's page is a *pitch* (trade, value, the
positives for their side); the proposer's page is the full read (lineup
deltas, needs, all tags).

Share links are query-form so chat apps keep them:
`https://stathead.app/?swap=<meetId>&k=<key>` (the app rewrites to a hash
route on load). A bare link with no key is view-only.

## Where everything lives

The feature's own page is **Dynasty → Swap Meet** (`SwapMeetHome`). The
Trade Calculator keeps the Trade Finisher for finishes and "open in
calculator", and hands off to the Swap Meet tab to put versions on the table.

| Piece | File |
|---|---|
| Model (pure, shared browser + worker) | `src/lib/swapMeetCore.ts` — `Meet`, `MeetOption`, `MeetEvent`, `createMeet`, `applyAction`, `markSeen`, `optionStatus`, `whoseMove`, `bestCandidate`, `chatSummary`, `generalNotes`, `optionNotes`, `LIMITS`, `MeetError` |
| Worker (Cloudflare, KV) | `workers/swap-meet/src/index.ts` — `POST /meets`, `GET /meets/:id?k=`, `POST /meets/:id/actions?k=`; live at `https://swap-meet.dachhack.workers.dev`; README in `workers/swap-meet/` |
| Client API + device list | `src/lib/swapMeet.ts` — `createMeet`, `fetchMeet`, `sendAction`, `meetUrl`, `listMeets/rememberMeet/forgetMeet` (localStorage `stathead:swap-meets`), env `VITE_SWAP_MEET_URL` |
| Routing | `src/lib/hashRoute.ts` — `parseSwapLocation`, `normalizeSwapUrl`, `swapQuery`, `setSwapHash`; `App.tsx` holds `swapRoute` and renders `SwapMeetView` |
| Meet page | `src/components/SwapMeetView.tsx` — loads the meet, move banner, ordered sheets, editor (counter / revise / new version, "final offer" box), general notes, close/reopen |
| Offer sheet | `src/components/swap/OfferSheet.tsx` — the ticket. Front: header + stamp + New badge, `TradeFront` (the two packages with 54px avatars and 15px names, balance bar + verdict; also exported for the composer), the assessment (`SideReadBlock` per side: the proposer sees both, the partner only theirs; `FitStrip` is the one-line form the composer uses), clamped pitch, `primary` actions. `Details` toggle: lineup read (proposer only), tags, votes, note thread (new notes dotted), `children` (revise / final / withdraw / per-version note) |
| Shared sheet parts | `src/components/swap/OfferParts.tsx` (needs cards, asset columns, verdicts), `src/components/swap/offerStyle.ts` (colors, `fmt`, `sumValue`, `shortName`) |
| Swap Meet page (Dynasty → Swap Meet, tab `swap-meet`) | `src/components/SwapMeetHome.tsx` — brand header, the meets this device opened or joined (`listMeets`, copy links, forget), "open a meet from a link" (paste a share link, hash link or id), and "Start a meet" two ways: **From a league** (`TradeFinisher` in `mode="swap"`: open by default, no calculator hand-off, the composer at the end; Sleeper or ESPN) or **By hand, no league** (`src/components/swap/ManualMeetBuilder.tsx`: name both sides, format + TE premium, pick pieces off the dynasty board with `BoardPicker`, a pitch, create → two links; the meet's `league.source` is `'manual'` and its two "teams" hold only the pieces on the table). Loads the dynasty board itself via `fetchDynastyRankingsForDisplay(format)`; the finisher's `onLeagueDetected` switches format / TE premium to the league's. The finisher's selections live in sessionStorage, so a league picked in the Trade Calculator carries over |
| Composer (end of the finisher in swap mode) | `src/components/swap/SwapMeetComposer.tsx` — pick candidates, per-candidate pitch drafted from `partnerPositives`, create → two links. The Trade Calculator's finisher (`mode="calculator"`) no longer embeds it: it shows a "Send to <partner> · Swap Meet →" hand-off (`onOpenSwapMeet`, wired in `App.tsx` to the tab) |
| ESPN leagues | `src/lib/espnLeague.ts` — `importEspnLeague(id, season, creds?, {dynasty?})` → the same `LeagueImport` the Sleeper import yields (league_id `espn:<id>`, Sleeper-style `roster_positions` from ESPN slot counts, `scoring_settings` from ESPN stat ids incl. `bonus_rec_te` from a TE-only reception override, `settings.type` 2 when keepers carry over); `parseEspnLeagueInput` (id or league URL). Players resolve through the crosswalk by ESPN id (`lookupByEspnId`) to Sleeper ids. Goes through `workers/espn-news-proxy` `GET /league/<season>/<id>` (public: edge-cached 5 min; private: the manager's `espn_s2` + `SWID` ride as `X-ESPN-S2` / `X-ESPN-SWID` headers, forwarded as the upstream Cookie, never stored or cached). Payload slimmed by `src/lib/espnLeagueSlim.ts` (shared with the test). ESPN publishes no future picks, so an ESPN league's picks are each team's own. Test: `npm run test:espn-league` (25) against `scripts/fixtures-espn-league.json` (public league 42654852) |
| Manual meets | `league.source === 'manual'` (`isManualMeet`). Pages use `valueOnlyEval` (`ValueEval`: values + verdict, `isFullEval` false) — `OfferSheet`/`TradeFront` take `AnyEval`, hide the reads, tags and lineup line; the meet page's editor uses two `BoardPicker`s over `boardAssets(board, isSuperflex, tep, sleeperIdFor)` (players + the board's Early/Mid/Late pick rows) plus the pieces already on the table (frozen values), no suggested finishes, needs hidden |
| Trade engine | `src/lib/tradeFinisher.ts` — `buildFinisherTeams` (takes `laterLogReturnByKtcId` from the 120-day dynasty forecast → `FinisherAsset.valueLater`), `computeNeeds`, `evaluateOffer` (returns `myRead` / `partnerRead`: a `SideRead` per team — `rosterRole` for every piece (starter with slot and pts/wk over the next man up / backup / surplus / pick), weekly lineup change, value now and at the forecast horizon, age, goal-weighted `fit` + `verdict`), `readLines` (the read in words), `suggestFinishes`, `partnerPositives`, `nameTags`, pick pricing from KTC rows |
| Styles | `src/index.css`, block "Swap Meet offer sheets" (`.sm-*`), mobile overrides in the 760px media query just above it. `.sm-sheet` is a size container: under 520px wide it stacks its packages (`@container` rule), wherever it sits; asset names wrap at spaces and hyphens only (no mid-word breaks). The sheet is a dossier page: `.sm-sheet` re-scopes `--bg-*`, `--text-*`, `--border`, `--accent` to a paper palette (`--paper`, `--ink`, `--rule`, `--manila`, `--ink-red/green/amber/blue`) and sets `--mono` / `--serif`, so anything rendered inside sets in ink. Inline colours inside a sheet come from `GIVE_INK` / `GET_INK` / `INK` / `PAPER_VERDICT_COLOR` in `offerStyle.ts`, never the bright page colours |
| Deploy | `.github/workflows/deploy-workers.yml` — matrix includes `swap-meet`; a step creates the `SWAP_MEET` KV namespace and fills the id into `wrangler.toml` |
| Tests | `npm run test:swap-meet` (77), `npm run test:trade-finisher` (79), `npm run test:espn-league` (25) |

## Roles and per-seat state (the bits that trip people up)

- Roles: `proposer`, `partner`, `viewer`. The worker resolves the role from
  `?k=`; keys are compared in constant time. Only the proposer's GET returns
  `partnerKey` (so they can re-copy the partner link).
- `MeetOption.give/get` are always in the **proposer frame** (give = proposer
  sends), whoever authored the version.
- `optionStatus(meet, option, viewer)` → `agreed | withdrawn | countered |
  declined | passed | accepted | awaiting | open` and drives the stamp
  ("Deal", "Your call", "You passed", "<name> passed", "Countered", "Waiting").
- `bestCandidate` scores `yes×10 + otherYes×5 − no×20`; sheets render best
  first, then newest. `whoseMove` feeds the banner.
- Reshaping a revise clears the other side's vote and bumps `rev`; flipping
  `final` logs a `final` event. Two `yes` votes → `status: 'agreed'` +
  `agreedOptionId`.
- Read receipts: a keyed GET calls `markSeen` (min gap 5 min) and saves, and
  returns `lastSeen` = the stamp from before that read. The page keeps the
  first load's `lastSeen` as `since`; `newSince(meet, role, since)` is the
  other side's events after it (a New badge per touched sheet, a strip
  under the move banner from `describeNewSince`, the count in the tab
  title). "Got it" advances `since` to `updatedAt`. A first visit falls
  back to the fresh stamp, so only arrivals during the visit are marked.
- KV is eventually consistent; every write returns the updated meet so the
  writer renders it at once. Records expire after 120 days.

## How to test end to end without the network

Playwright cannot reach external hosts here. The proven approach: run
`npx vite --port 5179 --strictPort`, stub the worker in-page with an
in-memory fake that calls the real `createMeet/applyAction/markSeen`, stub
Sleeper and KTC routes from fixtures, and drive proposer → partner → deal
in three browser contexts (desktop, partner, mobile). The note input and
secondary actions live inside `Details`, so click `.sm-details-toggle` on a
sheet first. Headshots won't load offline (initials fall back).

Live smoke test (works from here with curl):
```
W=https://swap-meet.dachhack.workers.dev
curl -X POST -H 'Content-Type: application/json' -H 'Origin: https://stathead.app' --data-binary @meet.json $W/meets
curl "$W/meets/<id>?k=<partnerKey>"        # role partner, meet.seen.partner set
curl -X POST ... -d '{"type":"option","give":[...],"get":[...],"counterOf":"<optId>","final":true}' "$W/meets/<id>/actions?k=<partnerKey>"
```

## Before you do anything

1. **Promote to Production** has not been run since any of this landed. Dev
   carries: prospect score charts, trade finisher, Swap Meet (partner pitch
   view, query links, offer sheets, collapsed details), combine provenance,
   feature directionality. Run the workflow, then check
   `https://stathead.app/?swap=u7sytud4y7&k=9rcnfy4fch7natnkzaduvz` opens the
   partner view of the user's real meet (its pitches predate the pitch
   rewrite; revise them from the proposer link before resending).
2. `git fetch origin claude/nfl-fantasy-workbench-6D1yd && git merge --no-edit`
   before starting; typecheck with `npx tsc --noEmit -p tsconfig.app.json`.
   Pre-existing lint noise to ignore: 3× `no-explicit-any` in
   `PlayerCard.tsx`, 2× `set-state-in-effect` in `PlayerDetail.tsx`, unused
   imports at line 6 of `scripts/precompute-features.ts`.
3. Worker changes deploy on push of `workers/**` to the dev branch
   (`deploy-workers.yml`). The model file is bundled into the worker, so a
   change to `swapMeetCore.ts` needs a `workers/` touch (or a manual run) to
   ship server-side.

## Ideas not yet done

- ESPN: future draft picks are not in ESPN's API, so an ESPN league's
  picks are shown as each team's own; a per-team pick editor on the
  finisher would let a manager mark traded picks. IDP slots come through by
  name (DL/LB/DB) but the finisher scores the skill lineup only, as with
  Sleeper. Private-league cookies live in sessionStorage for the tab.
- Manual meets price new pieces at today's board when a counter is built,
  while the pieces already on the table keep the values they were opened
  with; a "re-price everything at today's board" action would make that
  explicit.

- The read's "next man up" is whoever the optimal lineup promotes when a
  starter leaves; on a roster with no bench at that position it is an
  empty slot, so the marginal pts/wk equals the whole projection. Real
  rosters carry benches, but a waiver-level replacement floor (position
  median of free agents) would make the number honest everywhere.
- Meets created before this round carry no `valueLater`; their reads fall
  back to today's board for "later" (the line then omits the forecast).

- The dossier look uses system fonts (`Courier New` / Georgia stacks). A
  proper typewriter face (e.g. Courier Prime) and a handwriting face for
  the sticky note would need a font file shipped with the app; the
  `--mono` / `--serif` variables on `.sm-sheet` are the only place to change.

- Notifications beyond the page: the "since you last looked" strip (done)
  only helps once the proposer opens their link; email/Sleeper push is not
  cheap. The device list (`listMeets`) could show which meets have new
  activity, but a keyed GET stamps the read receipt — add a `?peek=1` that
  skips `markSeen` before building that.
- Multi-partner meets (one proposer, several partners) — the model is
  two-seat by design; would need a `partners[]` and per-partner keys.
- Expiry / archive on the device list (`listMeets`) and a "my meets" page.
- Value snapshot refresh: values are frozen at meet creation (by design so
  both sides see the same numbers); an opt-in "re-price at today's board"
  could live on the proposer page.
