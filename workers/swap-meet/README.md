# swap-meet — Swap Meet by StatHead

A trade negotiation two fantasy managers share by link. The proposer opens a
meet from the Trade Calculator's Trade Finisher; the partner gets a link,
marks the versions they would accept, counters with their own, and both leave
notes. No accounts: each link carries a capability key.

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/meets` | `NewMeetInput` (see `src/lib/swapMeetCore.ts`) | `{ id, proposerKey, partnerKey, meet }` |
| `GET` | `/meets/:id?k=KEY` | — | `{ meet, role, partnerKey? }` (`partnerKey` only for the proposer) |
| `POST` | `/meets/:id/actions?k=KEY` | one `MeetAction` | `{ meet, role }` |

Actions: `option` (a new version), `revise` (author only; a reshaped package
voids the other side's vote), `vote` (`yes` / `no` / `null`, optional note —
two yeses on one version marks the meet agreed), `withdraw` (author only),
`note` (general or on one version), `status` (`open` / `closed`).

The state machine is the repo's shared pure module, bundled into the worker,
so the browser and the server apply identical rules. Records live in the
`SWAP_MEET` KV namespace with a 120-day TTL refreshed on every write.

## Deploy

`deploy-workers.yml` deploys it with the other workers and creates the KV
namespace on first run (writing its id into `wrangler.toml` for that run).
By hand:

```bash
cd workers/swap-meet
npx wrangler kv namespace create SWAP_MEET   # paste the id into wrangler.toml
npx wrangler deploy
```

The app reads `VITE_SWAP_MEET_URL` (default `https://swap-meet.dachhack.workers.dev`).
