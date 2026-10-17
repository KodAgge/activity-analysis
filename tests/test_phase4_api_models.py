"""The phase 4 response models, declared before the queries that fill them."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from activity_analysis.api.models import (
    Fitness,
    Predictions,
    Progression,
    RaceModel,
    Trends,
)


def test_an_empty_trends_payload_validates() -> None:
    """The shape a fresh store returns, and the one the frontend renders its
    absence state from."""
    assert (
        Trends(
            references={"slow_mps": None, "median_mps": None, "fast_mps": None},
            hr_slope_shared_bpm_per_mps=None,
            cadence_slope_shared_spm_per_mps=None,
            items=[],
        ).items
        == []
    )


def test_an_empty_fitness_payload_validates() -> None:
    payload = Fitness(items=[], device=[])
    assert payload.items == []
    assert payload.device == []


def test_a_fitness_payload_always_carries_the_device_list() -> None:
    # Required rather than defaulted, so the generated client types it as
    # always present: the endpoint sends an empty list, never omits it.
    with pytest.raises(ValidationError):
        Fitness(items=[])


def test_predictions_can_say_insufficient_data_with_a_reason() -> None:
    """The state the design requires instead of extrapolating from a single
    effort and presenting the result as a prediction."""
    payload = Predictions(
        items=[], insufficient_data=True, reason="fewer than two eligible efforts"
    )
    assert payload.insufficient_data
    assert payload.reason is not None


def test_an_ordinary_run_model_requires_its_band() -> None:
    """A prediction from ordinary running is about 5% wide on a 5 km and is
    misleading without its band, so the band is not optional for that
    source."""
    with pytest.raises(ValidationError):
        RaceModel(
            model="ordinary_runs",
            predicted_time_s=1500.0,
            low_s=None,
            high_s=None,
            source="ordinary_runs",
        )


def test_a_best_effort_model_may_omit_the_band() -> None:
    assert (
        RaceModel(
            model="riegel", predicted_time_s=1500.0, low_s=None, high_s=None, source="best_efforts"
        ).low_s
        is None
    )


def test_a_progression_point_states_why_an_effort_is_ineligible() -> None:
    point = {
        "activity_id": "a1",
        "start_time_utc": "2026-01-01T10:00:00Z",
        "utc_offset_s": 3600,
        "name": "Run",
        "elapsed_time_s": 1500.0,
        "avg_hr_bpm": 150.0,
        "locality": "Jönköping",
        "is_eligible": False,
        "is_record": False,
        "ineligible_reason": "treadmill",
        "contains_jump": False,
    }
    payload = Progression(
        distance_key="5k",
        distance_m=5000.0,
        effort_count=1,
        eligible_count=0,
        record_count=0,
        items=[point],
    )
    assert payload.items[0].ineligible_reason == "treadmill"
