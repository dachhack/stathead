#!/usr/bin/env python3
"""Recruiting classes for the devy models and the high-school board
(CollegeFootballData.com /recruiting/players: the 247 composite).

Refreshes public/data/cfbd/recruiting-<Y>.json for the class that enrolled
most recently and every class still in high school after it (three more):
those rankings move all year. Older classes are final and left alone.
Written with snake_case keys, like every older recruiting file (the CFBD v5
client's to_dict() is camelCase; scripts/devy_features.py reads both).

The 247 composite (stars, rating, ranking) is a model INPUT: the career model
scores high-school players from it (scripts/train_devy_model.py ->
devy-hs-rankings.json), and no StatHead surface shows it raw.

~4 calls. Usage: python3 scripts/fetch_cfbd_recruits.py [--classes 2027 2028]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv('.env.local')
except ImportError:
    pass

sys.path.insert(0, str(Path(__file__).parent))
from devy_features import snake_keys  # noqa: E402
from fetch_cfbd_inseason import to_dict  # noqa: E402

RAW = Path('public/data/cfbd')
HS_CLASSES_AHEAD = 3


def enrolled_class(now: datetime) -> int:
    """The latest class already in college: a class of Y enrolls by July of Y."""
    return now.year if now.month >= 7 else now.year - 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--classes', type=int, nargs='*')
    args = ap.parse_args()
    key = os.environ.get('CFBD_API_KEY')
    if not key:
        sys.exit('ERROR: CFBD_API_KEY not set')
    import cfbd
    api = cfbd.RecruitingApi(cfbd.ApiClient(cfbd.Configuration(access_token=key)))
    e = enrolled_class(datetime.now(timezone.utc))
    for y in args.classes or range(e, e + HS_CLASSES_AHEAD + 1):
        try:
            rows = [snake_keys(to_dict(x)) for x in api.get_recruits(year=y)]
        except Exception as ex:  # noqa: BLE001 -- a class CFBD has not opened yet must not stop the rest
            print(f'::warning::recruiting {y}: {ex}')
            continue
        if not rows:
            print(f'  recruiting {y}: no recruits yet')
            continue
        (RAW / f'recruiting-{y}.json').write_text(json.dumps(rows, default=str))
        print(f'  recruiting {y}: {len(rows)} recruits')


if __name__ == '__main__':
    main()
