from __future__ import annotations

import pandas as pd

from activity_analysis.analysis.rest_days import days_since_previous_run


def _runs(*rows: tuple[str, str, int | None]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "activity_id": [r[0] for r in rows],
            "start_time_utc": pd.to_datetime([r[1] for r in rows], utc=True),
            "utc_offset_s": pd.array([r[2] for r in rows], dtype="Int32"),
        }
    )


def test_first_run_is_null_and_next_day_is_one() -> None:
    out = days_since_previous_run(
        _runs(("a", "2026-01-01T08:00Z", 3600), ("b", "2026-01-02T08:00Z", 3600))
    )
    assert out.isna()["a"]
    assert out["b"] == 1


def test_same_local_day_is_zero() -> None:
    out = days_since_previous_run(
        _runs(("a", "2026-01-01T06:00Z", 3600), ("b", "2026-01-01T17:00Z", 3600))
    )
    assert out["b"] == 0


def test_evening_then_morning_is_one_day_by_local_calendar() -> None:
    # 21:00 and 07:00 local, 10 hours apart: one calendar day, not 0.4.
    out = days_since_previous_run(
        _runs(("a", "2026-01-01T20:00Z", 3600), ("b", "2026-01-02T06:00Z", 3600))
    )
    assert out["b"] == 1


def test_local_date_not_utc_date_decides() -> None:
    # 23:30 UTC on the 1st is 01:30 on the 2nd at UTC+2; the next run at
    # 10:00 local on the 2nd is day 0.
    out = days_since_previous_run(
        _runs(("a", "2026-06-01T23:30Z", 7200), ("b", "2026-06-02T08:00Z", 7200))
    )
    assert out["b"] == 0


def test_offset_change_between_runs() -> None:
    # 22:00 local at UTC-5 on the 1st, then 09:00 local at UTC+2 on the 3rd: two calendar days.
    out = days_since_previous_run(
        _runs(("a", "2026-03-02T03:00Z", -18000), ("b", "2026-03-03T07:00Z", 7200))
    )
    assert out["b"] == 2


def test_null_offset_is_treated_as_utc() -> None:
    out = days_since_previous_run(
        _runs(("a", "2026-01-01T23:00Z", None), ("b", "2026-01-02T01:00Z", None))
    )
    assert out["b"] == 1


def test_order_is_by_instant_not_input_order() -> None:
    out = days_since_previous_run(
        _runs(("b", "2026-01-05T08:00Z", 0), ("a", "2026-01-01T08:00Z", 0))
    )
    assert out.isna()["a"]
    assert out["b"] == 4


def test_empty_input() -> None:
    assert days_since_previous_run(_runs()).empty


def test_travel_west_is_clamped_to_zero_not_negative() -> None:
    # 01:00 local on the 3rd at UTC+2, then three hours later, 21:00 local
    # on the 2nd at UTC-5: the later run's local date is a day earlier. A
    # negative gap would fall out of every category the view buckets into,
    # so it reads as a second run the same day, 0.
    out = days_since_previous_run(
        _runs(("a", "2026-03-02T23:00Z", 7200), ("b", "2026-03-03T02:00Z", -18000))
    )
    assert out["b"] == 0
