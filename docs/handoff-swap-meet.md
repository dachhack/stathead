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

| Piece | File |
|---|---|
| Model (pure, shared browser + worker) | `src/lib/swapMeetCore.ts` — `Meet`, `MeetOption`, `MeetEvent`, `createMeet`, `applyAction`, `markSeen`, `optionStatus`, `whoseMove`, `bestCandidate`, `chatSummary`, `generalNotes`, `optionNotes`, `LIMITS`, `MeetError` |
| Worker (Cloudflare, KV) | `workers/swap-meet/src/index.ts` — `POST /meets`, `GET /meets/:id?k=`, `POST /meets/:id/actions?k=`; live at `https://swap-meet.dachhack.workers.dev`; README in `workers/swap-meet/` |
| Client API + device list | `src/lib/swapMeet.ts` — `createMeet`, `fetchMeet`, `sendAction`, `meetUrl`, `listMeets/rememberMeet/forgetMeet` (localStorage `stathead:swap-meets`), env `VITE_SWAP_MEET_URL` |
| Routing | `src/lib/hashRoute.ts` — `parseSwapLocation`, `normalizeSwapUrl`, `swapQuery`, `setSwapHash`; `App.tsx` holds `swapRoute` and renders `SwapMeetView` |
| Meet page | `src/components/SwapMeetView.tsx` — loads the meet, move banner, ordered sheets, editor (counter / revise / new version, "final offer" box), general notes, close/reopen |
| Offer sheet | `src/components/swap/OfferSheet.tsx` — the ticket. Front: header + stamp + New badge, `TradeFront` (the two packages with 54px avatars and 15px names, balance bar + verdict; also exported for the composer), clamped pitch, `primary` actions. `Details` toggle: lineup read (proposer only), tags, votes, note thread (new notes dotted), `children` (revise / final / withdraw / per-version note) |
| Shared sheet parts | `src/components/swap/OfferParts.tsx` (needs cards, asset columns, verdicts), `src/components/swap/offerStyle.ts` (colors, `fmt`, `sumValue`, `shortName`) |
| Composer (in the finisher) | `src/components/swap/SwapMeetComposer.tsx` — pick candidates, per-candidate pitch drafted from `partnerPositives`, create → two links |
| Trade engine | `src/lib/tradeFinisher.ts` — `buildFinisherTeams`, `computeNeeds`, `evaluateOffer`, `suggestFinishes`, `partnerPositives`, `nameTags`, pick pricing from KTC rows |
| Styles | `src/index.css`, block "Swap Meet offer sheets" (`.sm-*`), mobile overrides in the 760px media query just above it. The sheet is a dossier page: `.sm-sheet` re-scopes `--bg-*`, `--text-*`, `--border`, `--accent` to a paper palette (`--paper`, `--ink`, `--rule`, `--manila`, `--ink-red/green/amber/blue`) and sets `--mono` / `--serif`, so anything rendered inside sets in ink. Inline colours inside a sheet come from `GIVE_INK` / `GET_INK` / `INK` / `PAPER_VERDICT_COLOR` in `offerStyle.ts`, never the bright page colours |
| Deploy | `.github/workflows/deploy-workers.yml` — matrix includes `swap-meet`; a step creates the `SWAP_MEET` KV namespace and fills the id into `wrangler.toml` |
| Tests | `npm run test:swap-meet` (72), `npm run test:trade-finisher` (50) |

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
