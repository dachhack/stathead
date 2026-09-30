"""CFBD (category, stat_type) -> devy stat column. Shared by scripts/devy_features.py
and scripts/fetch_cfbd_inseason.py (which runs without pandas)."""

STATS = {
    ('passing', 'YDS'): 'pass_yds', ('passing', 'TD'): 'pass_td', ('passing', 'INT'): 'pass_int',
    ('passing', 'ATT'): 'pass_att', ('passing', 'COMPLETIONS'): 'pass_cmp',
    ('rushing', 'CAR'): 'rush_car', ('rushing', 'YDS'): 'rush_yds', ('rushing', 'TD'): 'rush_td',
    ('receiving', 'REC'): 'rec', ('receiving', 'YDS'): 'rec_yds', ('receiving', 'TD'): 'rec_td',
    # Explosiveness, return work and ball security.
    ('rushing', 'LONG'): 'rush_long', ('receiving', 'LONG'): 'rec_long',
    ('kickReturns', 'YDS'): 'kr_yds', ('puntReturns', 'YDS'): 'pr_yds', ('fumbles', 'LOST'): 'fum_lost',
}
