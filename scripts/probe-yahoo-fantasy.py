#!/usr/bin/env python3
"""Probe what the Yahoo Fantasy API exposes for a trade database.

The question: with StatHead's Yahoo developer app, how many NFL leagues can
we read trades from? Only our own (user OAuth), or any public league? Yahoo's
docs and the community libraries disagree, so this measures it.

Two ways in, tried in turn:
  app       two-legged OAuth 1.0a: the app's client id + secret, no user.
            Said to reach public data (games, players, public leagues); said
            elsewhere to be retired. YAHOO_CLIENT_ID + YAHOO_CLIENT_SECRET.
  user      OAuth 2.0 with a refresh token from a one-time consent (see
            `auth` below). Reaches the consenting user's leagues for sure;
            the probe checks whether it reaches strangers' public leagues.
            + YAHOO_REFRESH_TOKEN.

For each way in it: lists the NFL game keys (one per season), then samples
league ids per season (Yahoo league ids are integers within a season's game,
so a uniform sample estimates the readable share) and, for readable leagues,
reads settings and the trade log. Prints and writes counts only: no league,
team or manager names.

Usage:
  python3 scripts/probe-yahoo-fantasy.py [--samples 60] [--seasons 2026,2025,2024]
                                          [--max-id 1500000] [--out yahoo-probe.json]
  python3 scripts/probe-yahoo-fantasy.py auth            # print the consent URL
  python3 scripts/probe-yahoo-fantasy.py auth CODE       # exchange it; prints the
                                                         # refresh token locally --
                                                         # store it as the
                                                         # YAHOO_REFRESH_TOKEN secret
App-only access to public leagues needs no API permission. The `user` route
and `auth` need the Fantasy Sports (Read) permission; `auth` uses the app's
registered redirect URI (YAHOO_REDIRECT_URI, default `oob`): after approving,
copy the `code` parameter from the address bar.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import random
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

API = 'https://fantasysports.yahooapis.com/fantasy/v2'
TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token'
AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth'
REDIRECT = os.environ.get('YAHOO_REDIRECT_URI', 'oob')
UA = 'stathead-yahoo-probe/1.0 (+https://github.com/dachhack/stathead)'


# ── OAuth 1.0a signing (RFC 5849), stdlib only ──

def pct(s: str) -> str:
    return urllib.parse.quote(str(s), safe='~-._')


def oauth1_header(method: str, url: str, params: dict, key: str, secret: str,
                  token: str = '', token_secret: str = '',
                  nonce: str | None = None, ts: str | None = None) -> str:
    """Authorization header for an OAuth 1.0a HMAC-SHA1 request. `params` are
    the query parameters; with no token this is two-legged (app only)."""
    o = {
        'oauth_consumer_key': key,
        'oauth_nonce': nonce or secrets.token_hex(16),
        'oauth_signature_method': 'HMAC-SHA1',
        'oauth_timestamp': ts or str(int(time.time())),
        'oauth_version': '1.0',
    }
    if token:
        o['oauth_token'] = token
    allp = sorted((pct(k), pct(v)) for k, v in list(params.items()) + list(o.items()))
    norm = '&'.join(f'{k}={v}' for k, v in allp)
    base = '&'.join([method.upper(), pct(url), pct(norm)])
    sig = base64.b64encode(hmac.new(f'{pct(secret)}&{pct(token_secret)}'.encode(), base.encode(), hashlib.sha1).digest()).decode()
    o['oauth_signature'] = sig
    return 'OAuth ' + ', '.join(f'{pct(k)}="{pct(v)}"' for k, v in sorted(o.items()))


def selftest() -> None:
    # The worked example from the OAuth 1.0 spec (photos.example.net).
    h = oauth1_header('GET', 'http://photos.example.net/photos', {'file': 'vacation.jpg', 'size': 'original'},
                      'dpf43f3p2l4k3l03', 'kd94hf93k423kf44', 'nnch734d00sl2jdk', 'pfkkdhi9sl3r4s00',
                      nonce='kllo9940pd9333jh', ts='1191242096')
    assert 'oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"' in h, h


# ── HTTP ──

class Client:
    def __init__(self, mode: str, cid: str, csec: str, refresh: str = ''):
        self.mode, self.cid, self.csec, self.refresh = mode, cid, csec, refresh
        self.access = ''
        self.requests = 0
        self.pause = 0.4   # seconds between requests (~150/min); Yahoo's limits are unpublished
        self.retries = 3   # attempts on a throttle or server error before returning it

    def _token(self) -> None:
        data = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': self.refresh,
                                       'redirect_uri': REDIRECT}).encode()
        req = urllib.request.Request(TOKEN_URL, data=data, headers={
            'Authorization': 'Basic ' + base64.b64encode(f'{self.cid}:{self.csec}'.encode()).decode(),
            'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            self.access = json.loads(r.read())['access_token']

    def get(self, path: str) -> tuple[int, dict | str]:
        """(status, parsed JSON or error text). Never raises on HTTP errors."""
        url = f'{API}{path}'
        params = {'format': 'json'}
        headers = {'User-Agent': UA, 'Accept': 'application/json'}
        if self.mode == 'app':
            headers['Authorization'] = oauth1_header('GET', url, params, self.cid, self.csec)
        else:
            if not self.access:
                self._token()
            headers['Authorization'] = f'Bearer {self.access}'
        full = f'{url}?{urllib.parse.urlencode(params)}'
        for attempt in range(self.retries):
            self.requests += 1
            try:
                with urllib.request.urlopen(urllib.request.Request(full, headers=headers), timeout=30) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                body = e.read().decode('utf-8', 'replace')
                if e.code == 401 and self.mode == 'user' and attempt == 0 and 'token_expired' in body:
                    self._token()
                    headers['Authorization'] = f'Bearer {self.access}'
                    continue
                if (e.code in (429, 999) or e.code >= 500) and attempt < self.retries - 1:
                    time.sleep(2 ** attempt * 5)
                    continue
                return e.code, error_text(body)
            except urllib.error.URLError as e:
                return 0, str(e.reason)
            finally:
                time.sleep(self.pause)
        return 429, 'rate limited'


def error_text(body: str) -> str:
    try:
        return json.loads(body)['error']['description']
    except Exception:
        import re
        m = re.search(r'<yahoo:description>(.*?)</yahoo:description>', body, re.S)
        return (m.group(1) if m else body[:160]).strip()


# Yahoo's JSON nests resources as {"0": {...}, "1": {...}, "count": n} and
# lists of single-key dicts; walk it rather than parse it.
def find(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            yield obj[key]
        for v in obj.values():
            yield from find(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from find(v, key)


def first(obj, key, default=None):
    return next(iter(find(obj, key)), default)


# ── the probe ──

def probe(client: Client, seasons: list[str], samples: int, max_id: int, rng: random.Random) -> dict:
    out: dict = {'mode': client.mode, 'seasons': {}}
    st, games = client.get(f'/games;game_codes=nfl;seasons={",".join(seasons)}')
    out['games_status'] = st
    if st != 200:
        out['games_error'] = games
        print(f'  [{client.mode}] /games → {st}: {games}')
        return out
    keys = {}
    for g in find(games, 'game'):
        season = first(g, 'season')
        key = first(g, 'game_key')
        if season and key:
            keys[str(season)] = str(key)
    out['game_keys'] = keys
    print(f'  [{client.mode}] NFL game keys: {keys}')

    # The user's own leagues, when there is a user: proves the trade read works.
    if client.mode == 'user':
        st, mine = client.get(f'/users;use_login=1/games;game_keys={",".join(keys.values())}/leagues')
        own = [str(k) for k in find(mine, 'league_key')] if st == 200 else []
        out['own_leagues'] = len(own)
        print(f'  [user] own leagues: {len(own)}')
        if own:
            out['own_sample'] = league_detail(client, own[0])

    for season, gk in keys.items():
        statuses: Counter = Counter()
        errors: Counter = Counter()
        readable = []
        for lid in rng.sample(range(1, max_id), samples):
            st, body = client.get(f'/league/{gk}.l.{lid}')
            if st == 200:
                statuses['readable'] += 1
                readable.append(f'{gk}.l.{lid}')
            else:
                statuses[st] += 1
                errors[str(body)[:100]] += 1
        detail = [league_detail(client, k) for k in readable[:5]]
        out['seasons'][season] = {
            'sampled': samples, 'statuses': dict(statuses), 'errors': dict(errors.most_common(5)),
            'readable_share': round(statuses['readable'] / samples, 3), 'readable_detail': detail,
        }
        print(f'  [{client.mode}] {season}: {dict(statuses)}  errors: {dict(errors.most_common(3))}')
    out['requests'] = client.requests
    return out


def league_detail(client: Client, key: str) -> dict:
    """Format and trade counts for one readable league — no names."""
    d: dict = {}
    st, s = client.get(f'/league/{key}/settings')
    if st == 200:
        d['num_teams'] = first(s, 'num_teams')
        d['draft_type'] = first(s, 'draft_type')
        d['scoring_type'] = first(s, 'scoring_type')
        d['uses_faab'] = first(s, 'uses_faab')
        d['trade_draft_picks'] = first(s, 'can_trade_draft_picks')
        d['is_keeper'] = first(s, 'uses_keeper') or first(s, 'is_keeper')
        d['league_type'] = first(s, 'league_type')   # public / private
        d['positions'] = sorted({str(p) for p in find(s, 'position')})[:20]
    else:
        d['settings_error'] = [st, str(s)[:100]]
    st, t = client.get(f'/league/{key}/transactions;types=trade')
    if st == 200:
        txns = list(find(t, 'transaction_id'))
        d['trades'] = len(txns)
        d['trade_has_picks'] = any(True for _ in find(t, 'picks'))
        d['trade_has_faab'] = any(True for _ in find(t, 'faab_bid'))
    else:
        d['trades_error'] = [st, str(t)[:100]]
    return d


def auth(code: str | None) -> None:
    cid, csec = os.environ.get('YAHOO_CLIENT_ID', ''), os.environ.get('YAHOO_CLIENT_SECRET', '')
    if not cid or not csec:
        sys.exit('Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET first.')
    if not code:
        print(f'{AUTH_URL}?' + urllib.parse.urlencode({'client_id': cid, 'redirect_uri': REDIRECT, 'response_type': 'code'}))
        print('\nOpen it, approve, then run:  python3 scripts/probe-yahoo-fantasy.py auth <code>')
        return
    data = urllib.parse.urlencode({'grant_type': 'authorization_code', 'code': code, 'redirect_uri': REDIRECT}).encode()
    req = urllib.request.Request(TOKEN_URL, data=data, headers={
        'Authorization': 'Basic ' + base64.b64encode(f'{cid}:{csec}'.encode()).decode(),
        'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        tok = json.loads(r.read())
    print('Save this as the YAHOO_REFRESH_TOKEN repo secret (do not paste it anywhere else):\n')
    print(tok['refresh_token'])


def main() -> None:
    selftest()
    args = sys.argv[1:]
    if args and args[0] == 'auth':
        auth(args[1] if len(args) > 1 else None)
        return
    opt = {a.split('=')[0].lstrip('-'): (a.split('=', 1)[1] if '=' in a else '') for a in args}
    if 'selftest' in opt:
        print('OAuth 1.0a signature matches the RFC 5849 example')
        return
    cid, csec = os.environ.get('YAHOO_CLIENT_ID', ''), os.environ.get('YAHOO_CLIENT_SECRET', '')
    if not cid or not csec:
        sys.exit('Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET.')
    refresh = os.environ.get('YAHOO_REFRESH_TOKEN', '')
    seasons = (opt.get('seasons') or '2026,2025,2024').split(',')
    samples = int(opt.get('samples') or 60)
    max_id = int(opt.get('max-id') or 1_500_000)
    rng = random.Random(int(opt.get('seed') or 2026))

    report = {'probedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'samples': samples, 'maxId': max_id, 'results': []}
    print('Yahoo Fantasy probe')
    report['results'].append(probe(Client('app', cid, csec), seasons, samples, max_id, rng))
    if refresh:
        report['results'].append(probe(Client('user', cid, csec, refresh), seasons, samples, max_id, rng))
    else:
        print('  [user] skipped: no YAHOO_REFRESH_TOKEN (run `auth` once to get one)')
    out = opt.get('out') or 'yahoo-probe.json'
    with open(out, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'  → {out}')


if __name__ == '__main__':
    main()
