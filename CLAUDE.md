# StatHead

## Rule: third-party data is an input, never an output

Third-party rankings, values and projections (KTC, FantasyCalc, FantasyPros,
FFC, Sleeper, ESPN, PFF, Tankathon and the like) may feed StatHead's own
numbers, but must never be shown raw: not in the site, not in MCP tool output,
not in exports. Show StatHead blends, StatHead model outputs, or ranks computed
on StatHead values. Blends need at least two sources, and values fitted to a
market's scale must use a smooth curve, not the market's own numbers. See
`docs/third-party-data-policy.md` for what counts and where the helpers live.

## Notes

- The MCP server's source of truth is `mcp/dist/server.mjs` (edited directly;
  `npm run build:mcp` only syntax-checks it). Bump `SERVER_VERSION` there and
  `mcp/package.json` together.
