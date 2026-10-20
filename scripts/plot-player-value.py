#!/usr/bin/env python3
"""Chart one player's StatHead trade value over time.

Reads public/data/player-trade-values-history.json (scripts/fit-player-values.py)
and writes a self-contained HTML page: weekly value per format (superflex and
1QB, one line each, same unit: 100 = a mid 1st in the next rookie draft that
week), hover readout, a table view, light and dark mode. Prints a monthly
summary too.

Usage: python3 scripts/plot-player-value.py "<player name>" [--out=chart.html]
       [--history=public/data/player-trade-values-history.json]
"""
from __future__ import annotations

import html
import json
import sys
from datetime import date, timedelta
from pathlib import Path

DATA = Path('public/data')
SERIES = {'superflex': ('Superflex', '#2a78d6', '#3987e5'), '1qb': ('1QB', '#eb6834', '#d95926')}


def find_player(name: str):
    """sleeper_id, display name and position for a name (case-insensitive,
    exact match first, then the most-traded partial match)."""
    cur = json.loads((DATA / 'player-trade-values.json').read_text())
    rows = [p for f in cur['formats'].values() for p in f['players'] if p.get('name')]
    q = name.lower()
    exact = [p for p in rows if p['name'].lower() == q]
    part = sorted((p for p in rows if q in p['name'].lower()), key=lambda p: -p['tradesAll'])
    hit = (exact or part or [None])[0]
    return (hit['sleeper_id'], hit['name'], hit.get('pos')) if hit else (None, None, None)


def main() -> None:
    args = dict(a.lstrip('-').split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    name = ' '.join(a for a in sys.argv[1:] if not a.startswith('--'))
    hist = json.loads(Path(args.get('history', DATA / 'player-trade-values-history.json')).read_text())
    pid, display, pos = find_player(name)
    if not pid:
        sys.exit(f'no player matching "{name}" in player-trade-values.json')
    series = {}
    for key in SERIES:
        h = hist['formats'].get(key, {}).get(pid)
        if h:
            d0 = date.fromisoformat(h['from'])
            series[key] = [((d0 + timedelta(weeks=i)).isoformat(), v) for i, v in enumerate(h['v'])]
    if not series:
        sys.exit(f'{display}: no weekly history (the history file keeps players in 100+ trades, last three seasons)')

    # Monthly summary to stdout (last week of each month).
    print(f'{display} ({pos}) - StatHead trade value, 100 = a mid 1st in the next rookie draft')
    for key, pts in series.items():
        months = {}
        for d, v in pts:
            months[d[:7]] = v
        print(f'  {SERIES[key][0]}: ' + ', '.join(f'{m} {v:.0f}' for m, v in months.items()))

    out = Path(args.get('out', f'{display.lower().replace(" ", "-").replace(".", "").replace(chr(39), "")}-value.html'))
    out.write_text(page(display, pos, series, hist.get('generatedAt', '')[:10]))
    print(f'-> {out}')


def page(name, pos, series, generated):
    payload = json.dumps({k: {'label': SERIES[k][0], 'light': SERIES[k][1], 'dark': SERIES[k][2], 'pts': v}
                          for k, v in series.items()})
    title = html.escape(f'{name} trade value')
    sub = html.escape(f'{pos or ""} · weekly StatHead value fitted to real dynasty trades · 100 = a mid 1st in the '
                      f'next rookie draft that week · fit {generated}')
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root{{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--page:#f4f3ef}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--page:#121211}}}}
:root[data-theme="dark"]{{--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--page:#121211}}
body{{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}}
main{{max-width:880px;margin:0 auto;padding:20px 16px}}
h1{{font-size:20px;margin:0 0 2px}} .sub{{color:var(--ink2);font-size:13px;margin:0 0 14px}}
.card{{background:var(--surface);border-radius:10px;padding:14px 14px 8px;position:relative}}
.legend{{display:flex;gap:16px;font-size:13px;color:var(--ink2);margin:0 0 6px}}
.legend i{{display:inline-block;width:14px;height:2px;vertical-align:middle;margin-right:6px;border-radius:2px}}
svg{{width:100%;height:auto;display:block;touch-action:none}}
.tip{{position:absolute;pointer-events:none;background:var(--surface);border:1px solid var(--grid);border-radius:8px;
 padding:6px 8px;font-size:12px;color:var(--ink);box-shadow:0 2px 8px rgba(0,0,0,.12);display:none;white-space:nowrap}}
.tip b{{display:block;color:var(--ink2);font-weight:600;margin-bottom:2px}}
details{{margin-top:14px}} table{{border-collapse:collapse;font-size:12px}} td,th{{padding:2px 10px 2px 0;text-align:right}}
th:first-child,td:first-child{{text-align:left}}
</style></head><body><main>
<h1>{title}</h1><p class="sub">{sub}</p>
<div class="card"><div class="legend" id="legend"></div><svg id="chart" viewBox="0 0 840 360" role="img" aria-label="{title}"></svg><div class="tip" id="tip"></div></div>
<details><summary>Table (monthly)</summary><table id="table"></table></details>
</main>
<script>
const S={payload};
const dark=()=>document.documentElement.dataset.theme==='dark'||(document.documentElement.dataset.theme!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);
const W=840,H=360,M={{l:44,r:16,t:12,b:28}};
const keys=Object.keys(S);const all=keys.flatMap(k=>S[k].pts);
const t=d=>Date.parse(d);const x0=Math.min(...all.map(p=>t(p[0]))),x1=Math.max(...all.map(p=>t(p[0])));
const yMax=Math.max(110,...all.map(p=>p[1]))*1.08;
const X=d=>M.l+(t(d)-x0)/(x1-x0||1)*(W-M.l-M.r),Y=v=>H-M.b-v/yMax*(H-M.t-M.b);
const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function draw(){{
 const svg=document.getElementById('chart');let g='';
 const step=yMax>300?100:yMax>150?50:25;
 for(let v=0;v<=yMax;v+=step){{g+=`<line x1="${{M.l}}" x2="${{W-M.r}}" y1="${{Y(v)}}" y2="${{Y(v)}}" stroke="${{css('--grid')}}" stroke-width="1"/><text x="${{M.l-6}}" y="${{Y(v)+4}}" text-anchor="end" font-size="11" fill="${{css('--muted')}}">${{v}}</text>`;}}
 g+=`<line x1="${{M.l}}" x2="${{W-M.r}}" y1="${{Y(100)}}" y2="${{Y(100)}}" stroke="${{css('--muted')}}" stroke-dasharray="4 4" stroke-width="1"/><text x="${{W-M.r}}" y="${{Y(100)-5}}" text-anchor="end" font-size="11" fill="${{css('--ink2')}}">mid 1st = 100</text>`;
 const y0=new Date(x0).getUTCFullYear(),y1=new Date(x1).getUTCFullYear();
 for(let y=y0;y<=y1+1;y++)for(const m of [0,6]){{const d=Date.UTC(y,m,1);if(d<x0||d>x1)continue;const xx=M.l+(d-x0)/(x1-x0)*(W-M.l-M.r);
  g+=`<text x="${{xx}}" y="${{H-8}}" text-anchor="middle" font-size="11" fill="${{css('--muted')}}">${{m?'Jul':'Jan'}} ${{String(y).slice(2)}}</text>`;}}
 for(const k of keys){{const c=dark()?S[k].dark:S[k].light;const p=S[k].pts;
  g+=`<path d="${{p.map((q,i)=>(i?'L':'M')+X(q[0]).toFixed(1)+','+Y(q[1]).toFixed(1)).join('')}}" fill="none" stroke="${{c}}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const l=p[p.length-1];g+=`<circle cx="${{X(l[0])}}" cy="${{Y(l[1])}}" r="4" fill="${{c}}" stroke="${{css('--surface')}}" stroke-width="2"/>`;}}
 g+=`<line id="cross" y1="${{M.t}}" y2="${{H-M.b}}" stroke="${{css('--muted')}}" stroke-width="1" visibility="hidden"/><g id="dots"></g><rect x="${{M.l}}" y="0" width="${{W-M.l-M.r}}" height="${{H}}" fill="transparent" id="hit"/>`;
 svg.innerHTML=g;
 document.getElementById('legend').innerHTML=keys.map(k=>`<span><i style="background:${{dark()?S[k].dark:S[k].light}}"></i>${{S[k].label}} <b style="color:var(--ink)">${{S[k].pts.at(-1)[1].toFixed(0)}}</b></span>`).join('');
 const hit=document.getElementById('hit'),tip=document.getElementById('tip'),cross=document.getElementById('cross'),dots=document.getElementById('dots');
 const move=e=>{{const r=svg.getBoundingClientRect();const px=(e.clientX-r.left)/r.width*W;const tm=x0+(px-M.l)/(W-M.l-M.r)*(x1-x0);
  let rows=[],dx=null;dots.innerHTML='';
  for(const k of keys){{const p=S[k].pts;let b=p[0];for(const q of p)if(Math.abs(t(q[0])-tm)<Math.abs(t(b[0])-tm))b=q;dx=dx||b[0];
   dots.innerHTML+=`<circle cx="${{X(b[0])}}" cy="${{Y(b[1])}}" r="4" fill="${{dark()?S[k].dark:S[k].light}}" stroke="${{css('--surface')}}" stroke-width="2"/>`;
   rows.push(`${{S[k].label}}: <span style="font-variant-numeric:tabular-nums">${{b[1].toFixed(1)}}</span>`);}}
  cross.setAttribute('x1',X(dx));cross.setAttribute('x2',X(dx));cross.setAttribute('visibility','visible');
  tip.innerHTML=`<b>week of ${{dx}}</b>`+rows.join('<br>');tip.style.display='block';
  const left=(X(dx)/W)*r.width;tip.style.left=Math.min(left+12,r.width-tip.offsetWidth-4)+'px';tip.style.top='40px';}};
 hit.addEventListener('pointermove',move);hit.addEventListener('pointerleave',()=>{{tip.style.display='none';cross.setAttribute('visibility','hidden');dots.innerHTML='';}});
}}
draw();matchMedia('(prefers-color-scheme: dark)').addEventListener('change',draw);
const months={{}};for(const k of keys)for(const [d,v] of S[k].pts)(months[d.slice(0,7)]??={{}})[k]=v;
document.getElementById('table').innerHTML='<tr><th>Month</th>'+keys.map(k=>`<th>${{S[k].label}}</th>`).join('')+'</tr>'+
 Object.entries(months).map(([m,o])=>`<tr><td>${{m}}</td>`+keys.map(k=>`<td>${{o[k]!=null?o[k].toFixed(0):'—'}}</td>`).join('')+'</tr>').join('');
</script></body></html>
'''


if __name__ == '__main__':
    main()
