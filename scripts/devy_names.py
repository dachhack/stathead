"""Name key shared by the devy scripts (stdlib only, so the daily rankings
build needs no pandas)."""
import re
import unicodedata


def norm_name(s: str) -> str:
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    s = re.sub(r"[.'’`-]", '', s)
    s = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', s)
    return re.sub(r'\s+', ' ', s).strip()
