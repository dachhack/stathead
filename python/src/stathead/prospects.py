"""2026 draft prospect scouting grades (NFL.com / PFN composite)."""
from __future__ import annotations

import pandas as pd

from ._fetch import fetch_json


def load_prospect_grades(year: int = 2026) -> pd.DataFrame:
    """NFL draft prospect scouting grades for the given class.

    Currently only ``year=2026`` is distributed with the repo.

    Columns: ``name``, ``pos``, ``school``, ``grade``, ``projRound``,
    ``projPick``, ``tier``.
    """
    data = fetch_json(f"src/data/prospect-grades-{year}.json")
    return pd.DataFrame(data)
