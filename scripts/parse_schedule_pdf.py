#!/usr/bin/env python3
"""Parse the NFL "team schedules by division" PDF into TV networks per game.

LOCAL/OFFLINE tool. The PDF is public NFL info; we only commit the derived
networks JSON. nflverse gives us opponents/dates/venues but no broadcast
network — this fills that gap so the Schedule page shows network without
depending on a live ESPN call.

Layout: each page is one division as a 2x2 team grid (two columns split near
x=360; top/bottom blocks delimited by team-name headers). Each game line holds
the left-column team's game and the right-column team's game.

Usage: python3 scripts/parse_schedule_pdf.py <pdf> [out.json]
Requires: pymupdf
"""
import sys, re, json
import fitz  # pymupdf

TEAMS = {
    'Arizona Cardinals':'ARI','Atlanta Falcons':'ATL','Baltimore Ravens':'BAL','Buffalo Bills':'BUF',
    'Carolina Panthers':'CAR','Chicago Bears':'CHI','Cincinnati Bengals':'CIN','Cleveland Browns':'CLE',
    'Dallas Cowboys':'DAL','Denver Broncos':'DEN','Detroit Lions':'DET','Green Bay Packers':'GB',
    'Houston Texans':'HOU','Indianapolis Colts':'IND','Jacksonville Jaguars':'JAX','Kansas City Chiefs':'KC',
    'Los Angeles Rams':'LA','Los Angeles Chargers':'LAC','Las Vegas Raiders':'LV','Miami Dolphins':'MIA',
    'Minnesota Vikings':'MIN','New England Patriots':'NE','New Orleans Saints':'NO','New York Giants':'NYG',
    'New York Jets':'NYJ','Philadelphia Eagles':'PHI','Pittsburgh Steelers':'PIT','Seattle Seahawks':'SEA',
    'San Francisco 49ers':'SF','Tampa Bay Buccaneers':'TB','Tennessee Titans':'TEN','Washington Commanders':'WAS',
}
X_SPLIT = 360
pdf = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else 'public/data/schedule-networks-2026.json'

def clean_opp(s):
    s = re.sub(r'^(at|vs)\.?\s+', '', s.strip())   # drop "at"/"vs"/"vs."
    s = re.sub(r'\s*\([^)]*\)', '', s).strip()      # drop (Thu)/(Munich)/etc.
    return s

def parse_side(week, rest):
    rest = rest.strip()
    if rest.upper().startswith('BYE'):
        return None
    toks = rest.split()
    if len(toks) < 2:
        return None
    network = toks[-1].rstrip('*')
    body = toks[:-1]
    # locate the kickoff time token ("H:MM") — opponent is everything before it.
    ti = next((i for i, t in enumerate(body) if re.match(r'^\d{1,2}:\d{2}$', t)), None)
    if ti is not None:
        opp_toks = body[:ti]
    elif network == 'TBD' or (body and body[-1] == 'TBD'):
        network = 'TBD'; opp_toks = [t for t in body if t != 'TBD']
    else:
        opp_toks = body
    # drop a leading date ("Mon. DD" or "TBD")
    if opp_toks and opp_toks[0] == 'TBD':
        opp_toks = opp_toks[1:]
    elif len(opp_toks) >= 2 and re.match(r'^[A-Z][a-z]{2}\.$', opp_toks[0]):
        opp_toks = opp_toks[2:]
    opp = clean_opp(' '.join(opp_toks))
    code = TEAMS.get(opp)
    NET_MAP = {'AMZ': 'Prime', 'NFLN': 'NFL Net', 'Netflix': 'NETFLIX'}
    VALID = {'CBS', 'FOX', 'NBC', 'ESPN', 'ABC', 'ESPN/ABC', 'Prime', 'NFL Net', 'NETFLIX'}
    net = NET_MAP.get(network, network)
    if net not in VALID:
        net = None
    return (code, net, opp)

doc = fitz.open(pdf)
networks = {}   # "week|A|B" (A<B) -> network
unmatched = set()
games = 0
for page in doc:
    words = page.get_text('words')  # x0,y0,x1,y1,word,...
    lines = {}
    for x0, y0, x1, y1, wd, *_ in words:
        lines.setdefault(round(y0), []).append((x0, wd))
    headers = []  # (y, side, code)
    rows = []     # (y, side, week, rest)
    for y in sorted(lines):
        for side, lo, hi in (('L', -1, X_SPLIT), ('R', X_SPLIT, 1e9)):
            text = ' '.join(wd for x, wd in sorted(lines[y]) if lo <= x < hi).strip()
            if not text:
                continue
            if text in TEAMS:
                headers.append((y, side, TEAMS[text])); continue
            m = re.match(r'^(\d{1,2})\s+(.*)$', text)
            if m and text.split()[0] not in ('Week',):
                rows.append((y, side, int(m.group(1)), m.group(2)))
    for y, side, week, rest in rows:
        cand = [h for h in headers if h[1] == side and h[0] <= y]
        if not cand:
            continue
        team = max(cand, key=lambda h: h[0])[2]
        parsed = parse_side(week, rest)
        if not parsed:
            continue
        opp_code, network, opp_name = parsed
        if not opp_code:
            unmatched.add(opp_name); continue
        if not network:
            continue
        a, b = sorted([team, opp_code])
        networks[f'{week}|{a}|{b}'] = network
        games += 1

with open(out, 'w') as f:
    json.dump(networks, f)
print(f'Wrote {out}: {len(networks)} games with networks (parsed {games} rows)')
if unmatched:
    print('Unmatched opponent strings:', sorted(unmatched))
from collections import Counter
print('Network tallies:', dict(Counter(networks.values())))
