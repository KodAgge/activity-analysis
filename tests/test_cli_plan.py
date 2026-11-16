"""The plan commands, run the way the skill runs them."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from activity_analysis.cli import app
from activity_analysis.config import Paths
from activity_analysis.plan.context import build_context
from activity_analysis.plan.models import PlanDraft
from tests.test_plan_models import five_week_draft

runner = CliRunner()
GOAL_ID = "5k-2027-03-13"
TODAY = "2027-02-06"


def _draft(**overrides: Any) -> PlanDraft:
    base = five_week_draft()
    return five_week_draft(goal=base.goal.model_dump() | {"goal_id": GOAL_ID}, **overrides)


def _write(tmp_path: Path, draft: PlanDraft) -> Path:
    path = tmp_path / "draft.json"
    path.write_text(draft.model_dump_json())
    return path


def _invoke(store: Paths, *args: str) -> Any:
    return runner.invoke(app, [*args, "--root", str(store.root)])


def _propose(store: Paths, tmp_path: Path, draft: PlanDraft | None = None) -> Any:
    path = _write(tmp_path, draft or _draft())
    return _invoke(store, "plan", "propose", str(path), "--today", TODAY)


def test_schema_prints_the_draft_json_schema() -> None:
    result = runner.invoke(app, ["plan", "schema"])
    assert result.exit_code == 0
    assert json.loads(result.stdout)["title"] == "PlanDraft"


def test_context_prints_json_with_every_section(ingested_store: Paths) -> None:
    result = _invoke(ingested_store, "plan", "context", "--today", TODAY)
    assert result.exit_code == 0, result.stderr
    assert set(json.loads(result.stdout)) == {
        "generated_for",
        "freshness",
        "profile",
        "zones",
        "load",
        "recent_runs",
        "weekly",
        "predictions",
        "records",
        "fitness_now",
        "trends",
        "plan",
    }


def test_propose_prints_paces_and_how_to_accept(ingested_store: Paths, tmp_path: Path) -> None:
    data = _draft().model_dump(mode="json")
    data["weeks"][0]["sessions"][1]["steps"] = [
        {
            "role": "work",
            "repeat": 4,
            "distance_m": 800.0,
            "speed": {"low_mps": 3.8462, "high_mps": 3.9216},
        }
    ]
    result = _propose(ingested_store, tmp_path, PlanDraft.model_validate(data))
    assert result.exit_code == 0, result.stderr
    assert "4 x 0.8 km @ 4:15-4:20/km" in result.stdout
    assert result.stdout.splitlines()[-1] == (
        f"Proposed v1 of {GOAL_ID}. Accept with: uv run activity-analysis plan accept {GOAL_ID}"
    )


def test_propose_lists_every_problem_and_exits_1(ingested_store: Paths, tmp_path: Path) -> None:
    data = _draft().model_dump(mode="json")
    first = data["weeks"][0]
    first["sessions"].append(
        dict(first["sessions"][0])
        | {"id": "w1-extra", "date": str(_draft().weeks[0].start_date + timedelta(days=6))}
    )
    data["weeks"][1]["sessions"][0]["date"] = str(_draft().weeks[3].start_date)
    result = _propose(ingested_store, tmp_path, PlanDraft.model_validate(data))
    assert result.exit_code == 1
    assert "has 4 runs, more than the 3 a week" in result.stderr
    assert "outside the week of" in result.stderr
    assert "Traceback" not in result.stderr


def test_a_malformed_draft_file_exits_1_naming_the_field(
    ingested_store: Paths, tmp_path: Path
) -> None:
    path = tmp_path / "draft.json"
    path.write_text('{"goal": {}}')
    result = _invoke(ingested_store, "plan", "propose", str(path), "--today", TODAY)
    assert result.exit_code == 1
    assert "goal_id" in result.stderr
    assert "Traceback" not in result.stderr


def test_accept_without_an_id_picks_the_one_pending_goal(
    ingested_store: Paths, tmp_path: Path
) -> None:
    assert _propose(ingested_store, tmp_path).exit_code == 0
    result = _invoke(ingested_store, "plan", "accept")
    assert result.exit_code == 0, result.stderr
    assert f"Accepted v1 of {GOAL_ID}" in result.stdout


def test_accept_with_nothing_pending_exits_1(ingested_store: Paths) -> None:
    result = _invoke(ingested_store, "plan", "accept")
    assert result.exit_code == 1
    assert "no goal has a pending version" in result.stderr


def test_list_and_show_after_accept(ingested_store: Paths, tmp_path: Path) -> None:
    assert _propose(ingested_store, tmp_path).exit_code == 0
    assert _invoke(ingested_store, "plan", "accept").exit_code == 0
    listed = _invoke(ingested_store, "plan", "list")
    assert f"{GOAL_ID}  active  accepted v1  race 2027-03-13" in listed.stdout
    shown = _invoke(ingested_store, "plan", "show")
    assert shown.exit_code == 0, shown.stderr
    assert f"Goal {GOAL_ID}: 5 km in 25:00 (5:00/km)" in shown.stdout


def test_show_with_no_goals_exits_1(ingested_store: Paths) -> None:
    result = _invoke(ingested_store, "plan", "show")
    assert result.exit_code == 1
    assert "no goals" in result.stderr


def test_a_corrupt_index_exits_1_naming_the_file(ingested_store: Paths, tmp_path: Path) -> None:
    assert _propose(ingested_store, tmp_path).exit_code == 0
    index = ingested_store.plan_dir(GOAL_ID) / "index.json"
    index.write_text("{")
    result = _invoke(ingested_store, "plan", "list")
    assert result.exit_code == 1
    assert str(index) in result.stderr
    assert "Traceback" not in result.stderr


def test_the_plan_commands_import_on_their_own() -> None:
    subprocess.run([sys.executable, "-c", "import activity_analysis.plan.cli"], check=True)


def test_schema_accepts_root(tmp_path: Path) -> None:
    result = runner.invoke(app, ["plan", "schema", "--root", str(tmp_path)])
    assert result.exit_code == 0


def test_propose_stamps_target_and_estimate_vdot(ingested_store: Paths, tmp_path: Path) -> None:
    from activity_analysis.analysis.fitness import vdot
    from activity_analysis.plan.store import PlanStore

    assert _propose(ingested_store, tmp_path).exit_code == 0
    stamped = PlanStore(ingested_store).pending(GOAL_ID)
    assert stamped is not None
    goal = _draft().goal
    estimate = _draft().assessment.estimate_s
    assert estimate is not None
    assert stamped.provenance.target_vdot == vdot(goal.distance_m, goal.target_time_s)
    assert stamped.provenance.estimate_vdot == vdot(goal.distance_m, estimate)


def test_check_prints_the_plan_and_stores_nothing(ingested_store: Paths, tmp_path: Path) -> None:
    path = _write(tmp_path, _draft())
    result = _invoke(ingested_store, "plan", "check", str(path), "--today", TODAY)
    assert result.exit_code == 0, result.stderr
    assert f"Goal {GOAL_ID}" in result.stdout
    assert "The draft passes and nothing was stored." in result.stdout
    assert not ingested_store.plans_dir.exists()


def test_check_refuses_what_propose_refuses(ingested_store: Paths, tmp_path: Path) -> None:
    data = _draft().model_dump(mode="json")
    data["weeks"][1]["sessions"][0]["date"] = str(_draft().weeks[3].start_date)
    path = _write(tmp_path, PlanDraft.model_validate(data))
    result = _invoke(ingested_store, "plan", "check", str(path), "--today", TODAY)
    assert result.exit_code == 1
    assert "outside the week of" in result.stderr


def test_propose_says_why_it_stamped_no_expected_load(
    ingested_store: Paths, tmp_path: Path
) -> None:
    # Two months after the fixtures' runs, so the context's load window is empty.
    result = _propose(ingested_store, tmp_path)
    assert result.exit_code == 0, result.stderr
    assert "No expected fitness and fatigue: " in result.stdout


def _with_load(monkeypatch: pytest.MonkeyPatch) -> None:
    """Measured load ending on the Sunday before the draft's first week, priced at 1 a minute."""

    def built(*args: Any, **kwargs: Any) -> dict[str, Any]:
        context = build_context(*args, **kwargs)
        load = [{"local_date": "2027-02-07", "trimp": 0.0, "ctl": 40.0, "atl": 50.0, "form": -10.0}]
        zones = (context["zones"] or {}) | {"trimp_per_minute": [1.0] * 5}
        return context | {"load": load, "zones": zones}

    monkeypatch.setattr("activity_analysis.plan.cli.build_context", built)


def test_check_prints_the_week_figures_beside_a_missing_load_note(
    ingested_store: Paths, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _with_load(monkeypatch)
    data = _draft().model_dump(mode="json")
    data["weeks"][0]["load_note"] = None
    path = _write(tmp_path, PlanDraft.model_validate(data))
    result = _invoke(ingested_store, "plan", "check", str(path), "--today", TODAY)
    assert result.exit_code == 1
    week = next(line for line in result.stdout.splitlines() if line.endswith(" over the week"))
    assert week.startswith("  Fitness 40.0 -> ")
    assert "fatigue 50.0 -> " in week and "form -10.0 -> " in week
    assert (
        "week of 2027-02-08 is detailed and has not ended, so it needs a load_note" in result.stderr
    )
    assert "The draft passes" not in result.stdout
    assert not ingested_store.plans_dir.exists()

    refused = _invoke(ingested_store, "plan", "propose", str(path), "--today", TODAY)
    assert refused.exit_code == 1
    assert "needs a load_note" in refused.stderr
    assert not ingested_store.plans_dir.exists()
