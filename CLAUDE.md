# StatHead

## Rule: third-party data is an input, never an output

Third-party rankings, values and projections (KTC, FantasyCalc, FantasyPros,
FFC, Sleeper, ESPN, PFF, Tankathon and the like) may feed StatHead's own
numbers, but must never be shown raw: not in the site, not in MCP tool output,
not in exports. Show StatHead blends, StatHead model outputs, or ranks computed
on StatHead values. Blends need at least two sources, and values fitted to a
market's scale must use a smooth curve, not the market's own numbers. See
`docs/third-party-data-policy.md` for what counts and where the helpers live.
One exception, by owner decision: the token-gated partner feed in
`workers/stathead-sports` may serve a single-market ADP to Drip; it is never
linked from the site, the MCP server or the Python package. A second, by
owner decision 2026-11-01: the site's Research > Sleeper Picks page shows the
Sleeper Picks lines StatHead leaned on, never Sleeper's payouts or pick
shares (`scripts/build-pick-board.py` allowlists the fields).

## Notes

- The MCP server's source of truth is `mcp/dist/server.mjs` (edited directly;
  `npm run build:mcp` only syntax-checks it). Bump `SERVER_VERSION` there and
  `mcp/package.json` together.
