"""Polars interop — convert loader output to polars DataFrames.

Loaders return pandas (that's the package's lingua franca); this is a thin
bridge for callers who prefer polars, especially on the big tables like
``load_player_stats`` (~400k rows) where polars is noticeably faster.

    import stathead as sh

    pl_df = sh.to_polars(sh.load_player_stats(2024))

    # Or convert a loader by reference, without calling it yourself:
    pl_df = sh.load_polars(sh.load_player_stats, 2024)

Requires the ``polars`` extra::

    pip install "stathead[polars]"
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    import pandas as pd
    import polars as pl


def _polars() -> Any:
    try:
        import polars  # noqa: PLC0415
    except ImportError as e:  # pragma: no cover - exercised via message
        raise ImportError(
            "stathead.to_polars() needs polars. Install it with:\n"
            '    pip install "stathead[polars]"'
        ) from e
    return polars


def to_polars(df: "pd.DataFrame") -> "pl.DataFrame":
    """Convert a pandas DataFrame (any loader's output) to a polars DataFrame.

    >>> import stathead as sh
    >>> sh.to_polars(sh.load_dynasty_values()).head()
    """
    pl = _polars()
    try:
        return pl.from_pandas(df)
    except ImportError:
        # from_pandas needs pyarrow for object / extension-dtype columns
        # (names, positions). Keep the polars extra light by falling back to a
        # column-dict construction. NaN -> None first, or polars chokes on a
        # str column with a float NaN mixed in.
        clean = df.astype(object).where(df.notna(), None)
        return pl.DataFrame({c: clean[c].to_list() for c in clean.columns})


def load_polars(loader: Callable[..., "pd.DataFrame"], *args: Any, **kwargs: Any) -> "pl.DataFrame":
    """Call a loader and return its result as a polars DataFrame.

    Sugar for ``to_polars(loader(*args, **kwargs))`` so you don't repeat the
    DataFrame:

    >>> import stathead as sh
    >>> sh.load_polars(sh.load_player_stats, 2024)
    """
    return to_polars(loader(*args, **kwargs))
