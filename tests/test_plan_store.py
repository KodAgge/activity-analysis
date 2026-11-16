"""The plan store: versions on disk, statuses in the index, nothing rewritten."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from activity_analysis.config import Paths
from activity_analysis.plan.models import (
    GoalIndex,
    PlanDraft,
    SnapshotPrediction,
    VersionEntry,
)
from activity_analysis.plan.store import PlanStore, PlanStoreError
from tests.test_plan_models import five_week_draft

NOW = datetime(2027, 2, 6, 12, 0, tzinfo=UTC)


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    return Paths(tmp_path)


@pytest.fixture
def store(paths: Paths) -> PlanStore:
    return PlanStore(paths)


@pytest.fixture
def context() -> dict[str, Any]:
    return {
        "freshness": {"newest_run_local_date": "2027-02-05"},
        "predictions": {
            "items": [
                {
                    "distance_key": "5k",
                    "distance_m": 5000.0,
                    "models": [
                        {
                            "model": "best_efforts",
                            "predicted_time_s": 1400.0,
                            "low_s": None,
                            "high_s": None,
                            "source": "best_efforts",
                        }
                    ],
                }
            ]
        },
    }


def _goal_draft(goal_id: str) -> Any:
    base = five_week_draft()
    return five_week_draft(goal=base.goal.model_dump() | {"goal_id": goal_id})


def _statuses(store: PlanStore, goal_id: str) -> list[str]:
    return [v.status for v in store.index(goal_id).versions]


def _snapshot(paths: Paths, goal_id: str) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in paths.plan_dir(goal_id).glob("v*.json")}


def test_a_store_with_no_plans_directory_lists_no_goals(store: PlanStore) -> None:
    assert store.goals() == []
    assert store.active_goal() is None


def test_proposing_a_new_goal_creates_it_with_v1_proposed(
    store: PlanStore, context: dict[str, Any]
) -> None:
    version = store.propose(five_week_draft(), context, now=NOW)
    assert store.index("five-k") == GoalIndex(
        goal_id="five-k",
        status="proposed",
        versions=[VersionEntry(number=1, status="proposed")],
    )
    assert version.provenance.number == 1
    assert version.provenance.revises is None
    assert version.provenance.created_at == NOW
    stored = store.version("five-k", 1)
    assert stored.provenance.data_through == date(2027, 2, 5)
    assert stored.provenance.snapshot == [
        SnapshotPrediction(
            distance_key="5k",
            distance_m=5000.0,
            model="best_efforts",
            predicted_time_s=1400.0,
            low_s=None,
            high_s=None,
        )
    ]
    assert store.context("five-k", 1) == context
    assert store.pending("five-k") == stored
    assert store.accepted("five-k") is None


def test_accepting_v1_makes_the_goal_active(store: PlanStore, context: dict[str, Any]) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    accepted = store.accept("five-k")
    assert accepted.provenance.number == 1
    assert store.index("five-k").status == "active"
    assert _statuses(store, "five-k") == ["accepted"]
    active = store.active_goal()
    assert active is not None and active.goal_id == "five-k"
    assert store.pending("five-k") is None
    assert store.accepted("five-k") == store.version("five-k", 1)


def test_proposing_again_withdraws_the_pending_version_and_takes_the_next_number(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    store.propose(five_week_draft(), context, now=NOW + timedelta(hours=1))
    before = _snapshot(paths, "five-k")["v002.json"]
    third = store.propose(five_week_draft(), context, now=NOW + timedelta(hours=2))
    assert _statuses(store, "five-k") == ["accepted", "withdrawn", "proposed"]
    assert third.provenance.number == 3
    assert third.provenance.revises == 1
    assert _snapshot(paths, "five-k")["v002.json"] == before


def test_accepting_a_revision_supersedes_the_previous_version(
    store: PlanStore, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    assert _statuses(store, "five-k") == ["superseded", "accepted"]
    assert store.index("five-k").status == "active"
    accepted = store.accepted("five-k")
    assert accepted is not None and accepted.provenance.number == 2


def test_rejecting_keeps_the_accepted_version_current(
    store: PlanStore, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    store.propose(five_week_draft(), context, now=NOW)
    rejected = store.reject("five-k")
    assert rejected.provenance.number == 2
    assert _statuses(store, "five-k") == ["accepted", "rejected"]
    assert store.index("five-k").status == "active"
    accepted = store.accepted("five-k")
    assert accepted is not None and accepted.provenance.number == 1
    assert store.pending("five-k") is None


def test_rejecting_the_only_version_keeps_the_goal_proposed(
    store: PlanStore, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.reject("five-k")
    assert store.index("five-k").status == "proposed"
    assert _statuses(store, "five-k") == ["rejected"]


def test_accepting_a_new_goal_archives_the_active_goal(
    store: PlanStore, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    store.propose(_goal_draft("other"), context, now=NOW + timedelta(days=1))
    store.accept("other")
    assert store.index("five-k").status == "archived"
    assert store.index("other").status == "active"
    active = store.active_goal()
    assert active is not None and active.goal_id == "other"
    assert [g.goal_id for g in store.goals()] == ["other", "five-k"]


def test_a_crash_while_archiving_leaves_the_accepted_goal_active(
    paths: Paths, store: PlanStore, context: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    store.propose(_goal_draft("other"), context, now=NOW + timedelta(days=1))
    write_index = store._write_index

    def crash_on_archive(index: GoalIndex) -> None:
        if index.goal_id == "five-k":
            raise OSError("disk full")
        write_index(index)

    monkeypatch.setattr(store, "_write_index", crash_on_archive)
    with pytest.raises(OSError):
        store.accept("other")
    # Never no active goal: the accepted one is on disk, and the old one is not archived.
    fresh = PlanStore(paths)
    assert fresh.index("other").status == "active"
    assert fresh.index("five-k").status == "active"


def test_rejecting_a_new_goal_keeps_the_old_goal_active(
    store: PlanStore, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    store.propose(_goal_draft("other"), context, now=NOW + timedelta(days=1))
    store.reject("other")
    assert store.index("five-k").status == "active"
    assert store.index("other").status == "proposed"
    active = store.active_goal()
    assert active is not None and active.goal_id == "five-k"


def test_a_version_with_a_result_closes_the_goal_on_accept(
    store: PlanStore, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    # A result needs the race in the data.
    context["freshness"]["newest_run_local_date"] = "2027-03-13"
    store.propose(five_week_draft(result={"time_s": 1490.0, "achieved": True}), context, now=NOW)
    store.accept("five-k")
    assert store.index("five-k").status == "closed"
    assert store.active_goal() is None
    with pytest.raises(PlanStoreError, match="closed"):
        store.propose(five_week_draft(), context, now=NOW)


def test_an_invalid_draft_is_refused_and_nothing_is_written(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    data = five_week_draft().model_dump()
    first = data["weeks"][0]
    extra = dict(first["sessions"][0]) | {
        "id": "w1-extra",
        "date": first["start_date"] + timedelta(days=6),
    }
    first["sessions"].append(extra)
    draft = PlanDraft.model_validate(data)
    with pytest.raises(
        PlanStoreError,
        match="week of 2027-02-08 has 4 runs, more than the 3 a week the athlete set",
    ):
        store.propose(draft, context, now=NOW)
    assert not paths.plans_dir.exists()


def test_an_index_with_no_versions_raises_plan_store_error_naming_it(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    index = paths.plan_dir("five-k") / "index.json"
    index.write_text('{"goal_id": "five-k", "status": "proposed", "versions": []}')
    with pytest.raises(PlanStoreError, match=str(index)):
        store.goals()


def test_accept_and_reject_refuse_when_nothing_is_pending(
    store: PlanStore, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    with pytest.raises(PlanStoreError, match="nothing pending"):
        store.accept("five-k")
    with pytest.raises(PlanStoreError, match="nothing pending"):
        store.reject("five-k")


def test_a_corrupt_index_raises_plan_store_error_naming_it(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    index = paths.plan_dir("five-k") / "index.json"
    index.write_text('{"goal_id":')
    with pytest.raises(PlanStoreError, match=str(index)):
        store.goals()


def test_an_empty_store_has_no_data_through(store: PlanStore, context: dict[str, Any]) -> None:
    context["freshness"]["newest_run_local_date"] = None
    version = store.propose(five_week_draft(outcomes=[]), context, now=NOW)
    assert version.provenance.data_through is None


def test_version_files_are_never_rewritten(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    seen: dict[str, bytes] = {}

    def check() -> None:
        for name, data in _snapshot(paths, "five-k").items():
            assert seen.setdefault(name, data) == data

    store.propose(five_week_draft(), context, now=NOW)
    check()
    store.accept("five-k")
    check()
    store.propose(five_week_draft(), context, now=NOW)
    check()
    store.reject("five-k")
    check()
    assert sorted(seen) == [
        "v001.context.json",
        "v001.json",
        "v002.context.json",
        "v002.json",
    ]


def test_a_non_utf8_version_file_raises_plan_store_error_naming_it(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    path = paths.plan_dir("five-k") / "v001.json"
    path.write_bytes(b"\xff\xfe\x00not utf-8")
    with pytest.raises(PlanStoreError, match=str(path)):
        store.goals()


def test_a_truncated_version_file_raises_plan_store_error_naming_it(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    path = paths.plan_dir("five-k") / "v001.json"
    path.write_text(path.read_text()[:100])
    with pytest.raises(PlanStoreError, match=str(path)):
        store.version("five-k", 1)


def test_a_corrupt_context_file_raises_plan_store_error_naming_it(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    path = paths.plan_dir("five-k") / "v001.context.json"
    for content in (b'{"freshness":', b"\xff\xfe\x00", b"[1]"):
        path.write_bytes(content)
        with pytest.raises(PlanStoreError, match=str(path)):
            store.context("five-k", 1)
    path.unlink()
    path.mkdir()
    with pytest.raises(PlanStoreError, match=str(path)):
        store.context("five-k", 1)


def test_a_plans_subdirectory_without_an_index_is_skipped(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    (paths.plans_dir / "stray").mkdir()
    store.accept("five-k")
    assert [g.goal_id for g in store.goals()] == ["five-k"]


def _directory(paths: Paths, goal_id: str) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in paths.plan_dir(goal_id).iterdir()}


def test_archiving_a_goal_withdraws_its_pending_revision(
    store: PlanStore, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    store.propose(five_week_draft(), context, now=NOW + timedelta(days=1))
    store.propose(_goal_draft("other"), context, now=NOW + timedelta(days=2))
    store.accept("other")
    assert store.index("five-k").status == "archived"
    assert _statuses(store, "five-k") == ["accepted", "withdrawn"]
    assert store.pending("five-k") is None


@pytest.mark.parametrize("finished", ["archived", "closed"])
def test_accept_and_reject_refuse_a_finished_goal(
    store: PlanStore, paths: Paths, context: dict[str, Any], finished: str
) -> None:
    # A hand-made index: a finished goal with a version still proposed.
    store.propose(five_week_draft(), context, now=NOW)
    index = store.index("five-k")
    index.status = finished  # type: ignore[assignment]
    (paths.plan_dir("five-k") / "index.json").write_text(index.model_dump_json())
    for action in (store.accept, store.reject):
        with pytest.raises(PlanStoreError, match=f"goal five-k is {finished}"):
            action("five-k")
    assert _statuses(store, "five-k") == ["proposed"]


def test_proposing_to_an_archived_goal_is_refused(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    store.propose(_goal_draft("other"), context, now=NOW + timedelta(days=1))
    store.accept("other")
    before = _directory(paths, "five-k")
    with pytest.raises(PlanStoreError, match="goal five-k is archived"):
        store.propose(five_week_draft(), context, now=NOW + timedelta(days=2))
    assert _directory(paths, "five-k") == before


def test_a_refused_revision_leaves_the_goal_byte_identical(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    store.accept("five-k")
    store.propose(five_week_draft(), context, now=NOW + timedelta(days=1))
    before = _directory(paths, "five-k")
    context["freshness"]["newest_run_local_date"] = "2027-02-10"
    data = five_week_draft().model_dump()
    data["weeks"][0]["sessions"][0]["title"] = "Rewritten"  # 9 February, in the past
    with pytest.raises(PlanStoreError, match="past sessions are frozen"):
        store.propose(PlanDraft.model_validate(data), context, now=NOW + timedelta(days=2))
    assert _directory(paths, "five-k") == before


def test_an_index_naming_another_goal_raises_plan_store_error_naming_it(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    index = paths.plan_dir("five-k") / "index.json"
    index.write_text(index.read_text().replace('"five-k"', '"other"'))
    with pytest.raises(PlanStoreError, match=f"{index} names goal other"):
        store.index("five-k")


def test_an_index_with_a_malformed_goal_id_raises_plan_store_error_naming_it(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    store.propose(five_week_draft(), context, now=NOW)
    index = paths.plan_dir("five-k") / "index.json"
    index.write_text(index.read_text().replace('"five-k"', '"../five-k"'))
    with pytest.raises(PlanStoreError, match=f"{index} does not validate"):
        store.index("five-k")


def test_propose_stamps_the_zones_the_context_carries(
    store: PlanStore, context: dict[str, Any]
) -> None:
    zones = {"lthr_bpm": 180.0, "boundaries_bpm": [153.0, 162.0, 171.0, 180.0]}
    version = store.propose(five_week_draft(), {**context, "zones": zones}, now=NOW)
    assert version.provenance.lthr_bpm == 180.0
    assert version.provenance.zone_boundaries_bpm == [153.0, 162.0, 171.0, 180.0]


def test_propose_stamps_trimp_per_minute_from_the_context(
    store: PlanStore, context: dict[str, Any]
) -> None:
    from tests.test_plan_models import five_week_draft

    per_minute = [0.5, 1.0, 1.5, 2.0, 2.5]
    zones = {"lthr_bpm": 180.0, "trimp_per_minute": per_minute}
    version = store.propose(five_week_draft(), {**context, "zones": zones}, now=NOW)
    assert version.provenance.trimp_per_minute == per_minute
    plain = store.propose(five_week_draft(), {**context, "zones": {"lthr_bpm": 180.0}}, now=NOW)
    assert plain.provenance.trimp_per_minute is None


def test_propose_stamps_null_zones_when_the_context_has_none(
    store: PlanStore, context: dict[str, Any]
) -> None:
    version = store.propose(five_week_draft(), context, now=NOW)
    assert version.provenance.lthr_bpm is None
    assert version.provenance.zone_boundaries_bpm is None


def _with_load(context: dict[str, Any]) -> dict[str, Any]:
    load = [{"local_date": "2027-02-07", "trimp": 0.0, "ctl": 40.0, "atl": 50.0, "form": -10.0}]
    zones = {"lthr_bpm": 180.0, "trimp_per_minute": [1.0, 1.0, 1.0, 1.0, 1.0]}
    return {**context, "load": load, "zones": zones}


def test_propose_stamps_the_expected_load_from_the_last_measured_day(
    store: PlanStore, context: dict[str, Any]
) -> None:
    version = store.propose(five_week_draft(), _with_load(context), now=NOW)
    expected = version.provenance.expected_load
    assert expected is not None
    assert expected.start.local_date == date(2027, 2, 7)
    assert expected.race_morning.local_date == date(2027, 3, 12)
    assert [w.week_start for w in expected.weeks][0] == date(2027, 2, 8)
    stored = store.version("five-k", 1)
    assert stored.provenance.expected_load == expected


def test_propose_stamps_no_expected_load_without_trimp_per_minute(
    store: PlanStore, context: dict[str, Any]
) -> None:
    version = store.propose(five_week_draft(), context, now=NOW)
    assert version.provenance.expected_load is None


def test_prepare_checks_and_stamps_without_writing(
    store: PlanStore, paths: Paths, context: dict[str, Any]
) -> None:
    prepared = store.prepare(five_week_draft(), {**context, "zones": {"lthr_bpm": 180.0}}, now=NOW)
    assert prepared.version.provenance.number == 1
    assert prepared.projection_note is not None and "TRIMP per minute" in prepared.projection_note
    assert not paths.plans_dir.exists()


def test_a_queued_goal_projects_through_the_goal_before_it(
    store: PlanStore, context: dict[str, Any]
) -> None:
    first = five_week_draft()
    store.propose(first, _with_load(context), now=NOW)
    store.accept("five-k")
    later = first.model_dump()
    later["goal"] |= {"goal_id": "later", "race_date": first.goal.race_date + timedelta(weeks=5)}
    for week in later["weeks"]:
        week["start_date"] += timedelta(weeks=5)
        for session in week["sessions"]:
            session["date"] += timedelta(weeks=5)
            session["id"] = "later-" + session["id"]
    version = store.propose(PlanDraft.model_validate(later), _with_load(context), now=NOW)
    expected = version.provenance.expected_load
    assert expected is not None
    assert expected.bridged_from == ["five-k"]
    by_week = {w.week_start: w.trimp for w in expected.weeks}
    assert by_week[date(2027, 2, 8)] == pytest.approx(90.0)
