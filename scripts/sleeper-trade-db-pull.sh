#!/usr/bin/env bash
# Download the encrypted Sleeper trade crawl from the `sleeper-trade-db` release,
# decrypt it and build the SQLite database (docs/sleeper-trade-db.md).
#
#   SLEEPER_TRADES_KEY=... bash scripts/sleeper-trade-db-pull.sh [dir]
#
# Needs gh (authenticated) and openssl. Already-downloaded shards are skipped,
# so re-running only fetches new runs. To continue crawling locally from the
# same state, also export the same SLEEPER_CRAWL_SALT the workflow uses.
set -euo pipefail
DIR="${1:-${DIR:-data-private/sleeper-trades}}"
TAG="${TAG:-sleeper-trade-db}"   # yahoo-trade-db for the Yahoo crawl
: "${SLEEPER_TRADES_KEY:?set SLEEPER_TRADES_KEY}"
mkdir -p "$DIR/.enc"
dec() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:SLEEPER_TRADES_KEY -in "$1" | tar -xz -C "$DIR"; }

gh release download "$TAG" -p 'state.tar.gz.enc' -D "$DIR/.enc" --clobber
dec "$DIR/.enc/state.tar.gz.enc"
for name in $(gh release view "$TAG" --json assets -q '.assets[].name' | grep '^shards-'); do
  if [ ! -f "$DIR/.enc/$name" ]; then
    gh release download "$TAG" -p "$name" -D "$DIR/.enc"
    dec "$DIR/.enc/$name"
  fi
done
python3 scripts/build-sleeper-trade-db.py "$DIR"
