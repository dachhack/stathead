"""Fetch + on-disk cache for files hosted in the stathead repo.

All loaders go through :func:`fetch_json` / :func:`fetch_csv_gz`, which
resolve the URL against the currently-pinned git ref and cache the raw
bytes under ``~/.cache/stathead/<ref>/<path>``.

Override the ref via :func:`pin_version` (per-session) or the
``STATHEAD_REF`` env var (per-shell).
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

_BASE_URL = "https://raw.githubusercontent.com/dachhack/stathead"
# The repo's data + models live on its default branch (there is no `main`),
# and the every-2h refresh workflow commits there, so this is the ref that
# always has fresh feature-matrix / score-store / crosswalk files. Override
# per-session with pin_version() or per-shell with STATHEAD_REF.
_DEFAULT_REF = "claude/nfl-fantasy-workbench-6D1yd"
_ref: str = os.environ.get("STATHEAD_REF", _DEFAULT_REF)


def pin_version(ref: str) -> None:
    """Pin all future loaders to a specific git ref (commit SHA, tag, or
    branch name). Passing ``"main"`` resets to latest."""
    set_ref(ref)


def set_ref(ref: str) -> None:
    """Alias of :func:`pin_version` with a clearer name."""
    global _ref
    _ref = ref


def current_ref() -> str:
    """Return the git ref currently used for fetches."""
    return _ref


def _cache_root() -> Path:
    try:
        from platformdirs import user_cache_dir  # type: ignore

        return Path(user_cache_dir("stathead"))
    except ImportError:
        root = os.environ.get("XDG_CACHE_HOME")
        if root:
            return Path(root) / "stathead"
        return Path.home() / ".cache" / "stathead"


def _cache_path(path: str) -> Path:
    return _cache_root() / _ref / path


def clear_cache(ref: str | None = None) -> None:
    """Remove cached files for the given ref (default: current ref).
    Pass ``"*"`` to nuke the entire cache."""
    if ref == "*":
        root = _cache_root()
    else:
        root = _cache_root() / (ref or _ref)
    if root.exists():
        shutil.rmtree(root)


def _fetch(path: str) -> bytes:
    cache = _cache_path(path)
    if cache.exists():
        return cache.read_bytes()
    url = f"{_BASE_URL}/{_ref}/{path}"
    req = Request(url, headers={"User-Agent": "stathead-py"})
    with urlopen(req, timeout=60) as resp:  # noqa: S310 — trusted domain
        data = resp.read()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(data)
    return data


def fetch_json(path: str) -> Any:
    """Fetch a JSON file from the repo and parse it."""
    return json.loads(_fetch(path).decode("utf-8"))


def fetch_csv_gz(path: str) -> bytes:
    """Fetch a .csv.gz file and return the decompressed CSV bytes."""
    return gzip.decompress(_fetch(path))
