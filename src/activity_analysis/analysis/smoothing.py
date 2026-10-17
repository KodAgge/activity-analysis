"""Trailing calendar-window means, shared by every smoothed series.

Lives on its own rather than inside one metric module because two of them
need it at two different windows: the VO2max series and the reference-pace
series at 42 days, aerobic decoupling at 90. Putting it in either would make
the other import a module it has nothing else to do with.

Why a calendar window rather than a count of activities: a two-week break
should show as a gap rather than be invisibly bridged by whatever six
activities happened to come last.
"""

from __future__ import annotations

import pandas as pd


def trailing_mean(when: pd.Series, value: pd.Series, *, window_days: int) -> pd.Series:
    """Mean of ``value`` over the ``window_days`` ending at each point.

    Raises rather than sorting, because sorting silently would hide a caller
    that had lost its ordering, and every window here is trailing: a series in
    the wrong order would average over the future.

    A null value contributes nothing to the windows it falls in, so a run that
    did not qualify neither drags the mean down nor breaks the series.

    The answer carries ``value``'s own index, so a caller can assign it
    straight back onto the frame it came from.
    """
    instants = pd.to_datetime(when)
    if not instants.is_monotonic_increasing:
        raise ValueError("trailing_mean needs its input sorted by time")
    frame = pd.Series(value.to_numpy(dtype=float), index=pd.DatetimeIndex(instants))
    rolled = frame.rolling(f"{window_days}D").mean()
    return pd.Series(rolled.to_numpy(), index=value.index)
