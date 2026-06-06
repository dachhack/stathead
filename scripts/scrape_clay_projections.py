#!/usr/bin/env python3
"""Parse Mike Clay's ESPN draft-kit projection PDFs into structured rows.

LOCAL / OFFLINE DEV TOOL. The PDFs are proprietary ESPN content supplied by
the user — neither the PDFs nor this script's output should be committed to
the repo. Used only to validate/calibrate our own models offline (the shipped
models contain only our own predictions trained on public data).

Two PDF layouts are handled:
  * 2021+  : one unified table, each row prefixed with the position and 16
             numeric columns (Gm, passing x5, Sk, rushing x3, receiving x4,
             Pts, Rk).
  * 2019-20: per-position sub-tables with no position prefix. QB tables carry
             a passing header; RB/WR/TE share a rush+receiving header, so the
             skill position is inferred from sub-table order (RB, WR, TE).

Usage:
  python3 scripts/scrape_clay_projections.py <clay.pdf> <season> [out.json]
  python3 scripts/scrape_clay_projections.py --dir <pdf_dir> [out.json]

Requires: pypdf  (pip install pypdf)
"""
from __future__ import annotations
import sys, re, json, glob, os

A_COLS = ['gm', 'passAtt', 'passCmp', 'passYds', 'passTD', 'int', 'sk',
          'rushAtt', 'rushYds', 'rushTD', 'tgt', 'rec', 'recYds', 'recTD', 'pts', 'rk']
A_RE = re.compile(r'^(QB|RB|WR|TE)\s+(.+?)\s+((?:-?\d+\s+){15}-?\d+)\b')
QB_HDR = re.compile(r'Att\s+Comp\s+Yds\s+TD\s+INT\s+Sk')
SK_HDR = re.compile(r'Att\s+Yds\s+TD\s+Tgt\s+Rec\s+Yds\s+TD\s+Pts')
STOP = {'Total', 'Player', 'Pos', 'DI', 'ED', 'LB', 'CB', 'S', 'DB', 'DL',
        'Int', 'Edge', 'NT', 'OLB', 'ILB', 'FS', 'SS', 'K', 'DST'}


def _lead_ints(tokens):
    out = []
    for t in tokens:
        if re.fullmatch(r'-?\d+', t):
            out.append(int(t))
        else:
            break
    return out


def parse_pdf(path, season):
    from pypdf import PdfReader
    r = PdfReader(path)
    players = {}
    for pi, pg in enumerate(r.pages):
        text = pg.extract_text() or ''
        is_modeA = any(A_RE.match(ln.strip()) for ln in text.split('\n'))
        if is_modeA:
            for line in text.split('\n'):
                m = A_RE.match(line.strip())
                if not m:
                    continue
                pos, name = m.group(1), m.group(2).strip()
                nums = [int(x) for x in m.group(3).split()]
                if name.lower().endswith('total'):
                    continue
                rec = dict(zip(A_COLS, nums))
                rec.update(name=name, pos=pos, season=season, page=pi)
                k = (name, pos, pi)
                if k not in players or rec['pts'] > players[k]['pts']:
                    players[k] = rec
        else:
            schema, skill_grp = None, -1
            for line in text.split('\n'):
                s = line.strip()
                if QB_HDR.search(s):
                    schema = 'qb'; continue
                if SK_HDR.search(s):
                    schema = 'skill'; skill_grp += 1; continue
                if not schema:
                    continue
                toks = s.split()
                if not toks or toks[0] in STOP:
                    continue
                i = 0
                while i < len(toks) and not re.fullmatch(r'-?\d+', toks[i]):
                    i += 1
                if i == 0 or i > 4:
                    continue
                name = ' '.join(toks[:i])
                if name in STOP:
                    continue
                nums = _lead_ints(toks[i:])
                if schema == 'qb':
                    if len(nums) < 12:
                        continue
                    g = nums[:12]
                    rec = dict(name=name, pos='QB', season=season, page=pi, gm=g[0],
                               passAtt=g[1], passCmp=g[2], passYds=g[3], passTD=g[4],
                               sk=g[6], rushAtt=g[7], rushYds=g[8], rushTD=g[9],
                               tgt=0, rec=0, recYds=0, recTD=0, pts=g[10], rk=g[11])
                    rec['int'] = g[5]
                else:
                    if len(nums) < 10:
                        continue
                    g = nums[:10]
                    pos = ['RB', 'WR', 'TE'][min(skill_grp, 2)] if skill_grp >= 0 else 'WR'
                    rec = dict(name=name, pos=pos, season=season, page=pi, gm=g[0],
                               rushAtt=g[1], rushYds=g[2], rushTD=g[3], tgt=g[4], rec=g[5],
                               recYds=g[6], recTD=g[7], passAtt=0, passCmp=0, passYds=0,
                               passTD=0, sk=0, pts=g[8], rk=g[9])
                    rec['int'] = 0
                k = (name, rec['pos'], pi)
                if k not in players or rec['pts'] > players[k]['pts']:
                    players[k] = rec
    return list(players.values())


def _season_from_name(path):
    m = re.search(r'(20\d\d)', os.path.basename(path))
    return int(m.group(1)) if m else None


def main(argv):
    if not argv:
        print(__doc__); return 1
    if argv[0] == '--dir':
        out = argv[2] if len(argv) > 2 else '/tmp/clay_all.json'
        allp = []
        for pdf in sorted(glob.glob(os.path.join(argv[1], '*.pdf'))):
            yr = _season_from_name(pdf)
            if not yr:
                print('skip (no year in name):', pdf); continue
            ps = parse_pdf(pdf, yr)
            allp += ps
            from collections import Counter
            print('%d: %d players %s' % (yr, len(ps), dict(Counter(p['pos'] for p in ps))))
        json.dump(allp, open(out, 'w'))
        print('wrote', len(allp), 'player-seasons ->', out)
    else:
        path, season = argv[0], int(argv[1])
        out = argv[2] if len(argv) > 2 else '/tmp/clay_%d.json' % season
        ps = parse_pdf(path, season)
        json.dump(ps, open(out, 'w'))
        from collections import Counter
        print('%d: %d players %s -> %s' % (season, len(ps), dict(Counter(p['pos'] for p in ps)), out))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
