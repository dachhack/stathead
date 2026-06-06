# Depth-order model (RB1/RB2, TE1/TE2)

Predicts each team's within-position pecking order — who finishes as the RB1 /
TE1 — from **public data only**, so the projection engine can seed the
"primary" back / tight end instead of trusting community ADP order alone.

## Why
The team-volume projection was mis-ordering receivers (depth pieces over
studs). Identifying the team's #1 at each position is the root signal. A
benchmark against a 2026 consensus projection set (used **offline only**, never
committed) showed the top-1 hit rate to beat:

| Pos | Prior-year only (old basis) | This model | Consensus benchmark |
|-----|----------------------------|------------|---------------------|
| RB  | 55.8% | **68.7%** | 74.7% |
| TE  | 65.9% | **68.1%** | 72.5% |

(LOSO by season, 2019–2025, "did we name the actual #1".) WR is intentionally
excluded — public signals stall there (~50%); it keeps the existing approach
until richer features (ADP / target competition) are added.

## How
`scripts/train_depth_order_model.py` trains a logistic classifier
("is this player his team's #1?") on:

- prior-season PPR + targets (nflverse `player_stats`)
- modal preseason depth-chart rank (nflverse `depth_charts`; mode across
  snapshots, not min — min collapses everyone to rank 1)
- rookie draft capital (nflverse `draft_picks`)

A **logistic** (monotonic) learner is used on purpose: the feature set is tiny
and elite returnees (a 400+ PPR back) fall far outside the training range,
where a tree ensemble extrapolated pathologically (it ranked McCaffrey SF RB3).

Output: `public/data/depth-order-2026.json` — per RB/TE, a depth score
(modeled P(team #1)) and the implied within-team rank.

```bash
python3 scripts/train_depth_order_model.py --season 2026
# optional offline benchmark column (local, uncommitted Clay export):
python3 scripts/scrape_clay_projections.py --dir <pdf_dir> /tmp/clay_all.json
python3 scripts/train_depth_order_model.py --season 2026 --clay /tmp/clay_all.json
```

## Data-use note
The consensus PDFs used to *validate* this model are proprietary and supplied
locally by the maintainer. Neither the PDFs nor any parsed copy is committed;
`scripts/scrape_clay_projections.py` is a local dev tool. Everything shipped
here (model + `depth-order-2026.json`) is trained on public nflverse data only.
