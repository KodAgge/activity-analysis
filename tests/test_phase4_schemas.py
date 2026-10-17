"""The three derived tables phase 4 adds, declared before anything fills them."""

from __future__ import annotations

import pyarrow as pa

from activity_analysis.models import (
    ACTIVITY_EFFICIENCY_SCHEMA,
    ATHLETE_FIT_SCHEMA,
    FITNESS_SERIES_SCHEMA,
    empty_frame,
)


def test_every_phase_4_schema_carries_an_analysis_version() -> None:
    """A derived table without one cannot be told from a stale rebuild."""
    for schema in (ACTIVITY_EFFICIENCY_SCHEMA, ATHLETE_FIT_SCHEMA, FITNESS_SERIES_SCHEMA):
        assert schema.field("analysis_version").type == pa.int32()


def test_the_per_activity_tables_key_on_activity_id() -> None:
    for schema in (ACTIVITY_EFFICIENCY_SCHEMA, FITNESS_SERIES_SCHEMA):
        assert schema.field("activity_id").type == pa.string()


def test_athlete_fit_has_no_activity_id() -> None:
    """It is a whole-history row, not a per-activity one. An activity_id here
    would invite a join that cannot mean anything."""
    assert "activity_id" not in ATHLETE_FIT_SCHEMA.names


def test_efficiency_reports_three_reference_paces_for_both_channels() -> None:
    """Three rather than one, because a single shared slope would make the
    extra two exact vertical translations of the first."""
    for name in (
        "hr_at_slow_bpm",
        "hr_at_median_bpm",
        "hr_at_fast_bpm",
        "cadence_at_slow_spm",
        "cadence_at_median_spm",
        "cadence_at_fast_spm",
    ):
        assert name in ACTIVITY_EFFICIENCY_SCHEMA.names


def test_every_schema_makes_an_empty_frame() -> None:
    for schema in (ACTIVITY_EFFICIENCY_SCHEMA, ATHLETE_FIT_SCHEMA, FITNESS_SERIES_SCHEMA):
        assert empty_frame(schema).empty
