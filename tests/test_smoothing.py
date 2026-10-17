"""The shared trailing-window smoother, against series with known means."""

from __future__ import annotations

import pandas as pd
import pytest

from activity_analysis.analysis.smoothing import trailing_mean


def test_trailing_mean_averages_only_the_window_behind_each_point() -> None:
    # Four values a week apart: at 14 days each point sees itself and the one
    # before it, so the answer is a known two-point mean.
    when = pd.Series(
        pd.to_datetime(["2025-01-01", "2025-01-08", "2025-01-15", "2025-01-22"], utc=True)
    )
    value = pd.Series([10.0, 20.0, 30.0, 40.0])

    out = trailing_mean(when, value, window_days=14)

    assert list(out) == [10.0, 15.0, 25.0, 35.0]


def test_trailing_mean_never_averages_over_the_future() -> None:
    when = pd.Series(pd.to_datetime(["2025-01-01", "2025-06-01"], utc=True))
    value = pd.Series([10.0, 20.0])

    out = trailing_mean(when, value, window_days=42)

    # The first point cannot know about the second.
    assert out.iloc[0] == 10.0


def test_a_gap_longer_than_the_window_leaves_a_point_alone() -> None:
    # The window is a calendar window, so a break longer than it means the
    # next point averages only itself. That is the property a count-based
    # window would silently destroy by bridging the break.
    when = pd.Series(pd.to_datetime(["2025-01-01", "2025-01-02", "2025-09-01"], utc=True))
    value = pd.Series([10.0, 12.0, 40.0])

    out = trailing_mean(when, value, window_days=42)

    assert out.iloc[2] == 40.0


def test_a_null_contributes_nothing_rather_than_breaking_the_series() -> None:
    when = pd.Series(pd.to_datetime(["2025-01-01", "2025-01-02", "2025-01-03"], utc=True))
    value = pd.Series([10.0, float("nan"), 20.0])

    out = trailing_mean(when, value, window_days=42)

    assert out.iloc[0] == 10.0
    assert out.iloc[2] == 15.0


def test_the_result_keeps_the_callers_own_index() -> None:
    # The caller assigns the answer back onto its own frame, which may not be
    # indexed from zero, so a positional index would silently misalign it.
    when = pd.Series(pd.to_datetime(["2025-01-01", "2025-01-08"], utc=True), index=[7, 9])
    value = pd.Series([10.0, 20.0], index=[7, 9])

    out = trailing_mean(when, value, window_days=42)

    assert list(out.index) == [7, 9]
    assert out.loc[9] == 15.0


def test_unsorted_input_raises_rather_than_being_sorted() -> None:
    when = pd.Series(pd.to_datetime(["2025-02-01", "2025-01-01"], utc=True))
    value = pd.Series([10.0, 20.0])

    with pytest.raises(ValueError, match="sorted"):
        trailing_mean(when, value, window_days=42)
