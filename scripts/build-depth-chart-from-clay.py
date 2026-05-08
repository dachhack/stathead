"""
Build a 2026 depth chart from Mike Clay's projection PDF — just the
ordering of players within each (team, position), not Clay's specific
numbers. Output ships in public/data/depth-chart-2026.json so
StatProjections can sort players by Clay's depth assignment instead
of relying on community ADP (which doesn't price rookies and lags
preseason role changes).

Schema:
  {
    "<TEAM>": {
      "QB": ["Player 1 (starter)", "Player 2 (backup)", ...],
      "RB": [...],
      "WR": [...],
      "TE": [...]
    }
  }

Run after parsing the Clay PDF into /tmp/clay_2026.csv.
"""
import csv
import json
from collections import defaultdict
from pathlib import Path

CLAY = Path('/tmp/clay_2026.csv')
OUT = Path('/home/user/stathead/public/data/depth-chart-2026.json')

# Clay uses team codes that don't always match nflverse:
#   BLT → BAL (Baltimore), HST → HOU (Houston), CLV → CLE (Cleveland),
#   ARZ → ARI (Arizona). Translate to the codes the rest of our app uses.
TEAM_FIX = {
    'BLT': 'BAL', 'HST': 'HOU', 'CLV': 'CLE', 'ARZ': 'ARI',
}


def main():
    by_team_pos = defaultdict(lambda: defaultdict(list))
    with CLAY.open() as f:
        for r in csv.DictReader(f):
            pos = r['position']
            if pos not in ('QB', 'RB', 'WR', 'TE'):
                continue
            team = TEAM_FIX.get(r['team'], r['team'])
            try:
                ff = float(r['ffPts']) if r['ffPts'] else 0
            except Exception:
                ff = 0
            by_team_pos[team][pos].append((r['name'], ff))

    out = {}
    for team, positions in by_team_pos.items():
        out[team] = {}
        for pos, players in positions.items():
            # Sort by ffPts desc — Clay's projection ordering implicitly
            # encodes who he sees as starter vs backup (volume × efficiency)
            players.sort(key=lambda x: -x[1])
            out[team][pos] = [name for name, _ in players]

    OUT.write_text(json.dumps(out, indent=2, sort_keys=True))
    print(f'Wrote depth chart for {len(out)} teams')
    teams = sum(1 for t in out)
    qbs = sum(len(out[t].get('QB', [])) for t in out)
    rbs = sum(len(out[t].get('RB', [])) for t in out)
    wrs = sum(len(out[t].get('WR', [])) for t in out)
    tes = sum(len(out[t].get('TE', [])) for t in out)
    print(f'  Teams: {teams}, QBs: {qbs}, RBs: {rbs}, WRs: {wrs}, TEs: {tes}')


if __name__ == '__main__':
    main()
