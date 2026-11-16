"""Training plans on disk.

A version file is written once and never touched again; every status change
lives in the goal's ``index.json``. Every write goes to a temporary file in the
same directory and is renamed into place, so a crash leaves either the old
file or the new one, never half of one.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from activity_analysis.analysis.fitness import vdot
from activity_analysis.config import Paths
from activity_analysis.plan.models import (
    GoalIndex,
    PlanDraft,
    PlanVersion,
    Provenance,
    SnapshotPrediction,
    VersionEntry,
)
from activity_analysis.plan.projection import Projection, project_load
from activity_analysis.plan.validate import check_draft


class PlanStoreError(ValueError):
    """A refusal or an unreadable file; the message names which."""


@dataclass(frozen=True)
class Prepared:
    """A checked and stamped version, not yet written."""

    version: PlanVersion
    index: GoalIndex
    #: Why the version carries no expected load, or None when it carries one.
    projection_note: str | None
    #: One sentence per check the draft fails; ``write`` refuses unless empty.
    problems: list[str]

    def refusal(self) -> str:
        return "the draft was refused:\n" + "\n".join(f"- {p}" for p in self.problems)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _read_model[M: BaseModel](path: Path, model: type[M]) -> M:
    try:
        return model.model_validate_json(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise PlanStoreError(f"{path} does not exist") from None
    except (OSError, UnicodeDecodeError) as error:
        raise PlanStoreError(f"{path} cannot be read: {error}") from error
    except ValidationError as error:
        raise PlanStoreError(f"{path} does not validate: {error}") from error


def _snapshot(context: dict[str, Any]) -> list[SnapshotPrediction]:
    return [
        SnapshotPrediction(
            distance_key=item["distance_key"],
            distance_m=item["distance_m"],
            model=m["model"],
            predicted_time_s=m["predicted_time_s"],
            low_s=m.get("low_s"),
            high_s=m.get("high_s"),
        )
        for item in context.get("predictions", {}).get("items", [])
        for m in item.get("models", [])
    ]


def _refuse_finished(index: GoalIndex, what: str) -> None:
    if index.status in ("archived", "closed"):
        raise PlanStoreError(f"goal {index.goal_id} is {index.status}; a finished goal {what}")


class PlanStore:
    """Reads the files on every call; nothing is cached."""

    def __init__(self, paths: Paths) -> None:
        self._paths = paths

    def _index_path(self, goal_id: str) -> Path:
        return self._paths.plan_dir(goal_id) / "index.json"

    def _version_path(self, goal_id: str, number: int) -> Path:
        return self._paths.plan_dir(goal_id) / f"v{number:03d}.json"

    def _context_path(self, goal_id: str, number: int) -> Path:
        return self._paths.plan_dir(goal_id) / f"v{number:03d}.context.json"

    def _write_index(self, index: GoalIndex) -> None:
        _write(self._index_path(index.goal_id), index.model_dump_json(indent=2) + "\n")

    def goals(self) -> list[GoalIndex]:
        """Every goal, newest first by when its first version was written."""
        root = self._paths.plans_dir
        if not root.is_dir():
            return []
        found: list[tuple[datetime, GoalIndex]] = []
        for directory in sorted(p for p in root.iterdir() if p.is_dir()):
            if not (directory / "index.json").exists():
                continue
            index = self.index(directory.name)
            first = self.version(index.goal_id, index.versions[0].number)
            found.append((first.provenance.created_at, index))
        found.sort(key=lambda pair: pair[0], reverse=True)
        return [index for _, index in found]

    def index(self, goal_id: str) -> GoalIndex:
        path = self._index_path(goal_id)
        index = _read_model(path, GoalIndex)
        if index.goal_id != goal_id:
            raise PlanStoreError(
                f"{path} names goal {index.goal_id}, not its directory's {goal_id}"
            )
        if not index.versions:
            raise PlanStoreError(f"{path} lists no versions")
        return index

    def version(self, goal_id: str, number: int) -> PlanVersion:
        return _read_model(self._version_path(goal_id, number), PlanVersion)

    def context(self, goal_id: str, number: int) -> dict[str, Any]:
        path = self._context_path(goal_id, number)
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise PlanStoreError(f"{path} does not exist") from None
        except (OSError, UnicodeDecodeError) as error:
            raise PlanStoreError(f"{path} cannot be read: {error}") from error
        except json.JSONDecodeError as error:
            raise PlanStoreError(f"{path} is not valid JSON: {error}") from error
        if not isinstance(loaded, dict):
            raise PlanStoreError(f"{path} does not hold a JSON object")
        return loaded

    def _with_status(self, goal_id: str, status: str) -> PlanVersion | None:
        for entry in reversed(self.index(goal_id).versions):
            if entry.status == status:
                return self.version(goal_id, entry.number)
        return None

    def current(self, index: GoalIndex) -> PlanVersion:
        """The version that speaks for the goal: pending, else accepted, else the newest."""
        entry = (
            next((e for e in index.versions if e.status == "proposed"), None)
            or next((e for e in reversed(index.versions) if e.status == "accepted"), None)
            or index.versions[-1]
        )
        return self.version(index.goal_id, entry.number)

    def accepted(self, goal_id: str) -> PlanVersion | None:
        return self._with_status(goal_id, "accepted")

    def pending(self, goal_id: str) -> PlanVersion | None:
        return self._with_status(goal_id, "proposed")

    def active_goal(self) -> GoalIndex | None:
        return next((g for g in self.goals() if g.status == "active"), None)

    def _to_be_run(self, goal_id: str) -> list[PlanDraft]:
        """Every other goal's plan still to be run: its pending version, else its accepted one."""
        plans: list[PlanDraft] = []
        for goal in self.goals():
            if goal.goal_id == goal_id or goal.status not in ("active", "proposed"):
                continue
            version = self.pending(goal.goal_id) or self.accepted(goal.goal_id)
            if version is not None:
                plans.append(version)
        return plans

    def prepare(self, draft: PlanDraft, context: dict[str, Any], *, now: datetime) -> Prepared:
        """Check a draft and stamp it as its goal's next version, writing nothing.

        The problems the checks find are returned, not raised, so ``plan check``
        can print the stamped version beside them; ``write`` refuses it.
        """
        goal_id = draft.goal.goal_id
        exists = self._index_path(goal_id).exists()
        index = (
            self.index(goal_id)
            if exists
            else GoalIndex(goal_id=goal_id, status="proposed", versions=[])
        )
        _refuse_finished(index, "does not take new versions")
        previous = self.accepted(goal_id) if exists else None
        newest = (context.get("freshness") or {}).get("newest_run_local_date")
        data_through = date.fromisoformat(newest) if newest else None
        problems = check_draft(draft, previous=previous, context=context, data_through=data_through)
        number = max((e.number for e in index.versions), default=0) + 1
        zones = context.get("zones") or {}
        per_minute = zones.get("trimp_per_minute")
        projection = (
            Projection(None, "a closing version plans nothing")
            if draft.result is not None
            else project_load(
                draft,
                load=context.get("load") or [],
                per_minute=per_minute,
                others=self._to_be_run(goal_id),
            )
        )
        estimate = draft.assessment.estimate_s
        goal = draft.goal
        provenance = Provenance(
            number=number,
            revises=previous.provenance.number if previous else None,
            created_at=now,
            data_through=data_through,
            snapshot=_snapshot(context),
            lthr_bpm=zones.get("lthr_bpm"),
            zone_boundaries_bpm=zones.get("boundaries_bpm"),
            trimp_per_minute=per_minute,
            target_vdot=vdot(goal.distance_m, goal.target_time_s),
            estimate_vdot=None if estimate is None else vdot(goal.distance_m, estimate),
            expected_load=projection.expected,
        )
        version = PlanVersion.model_validate({**draft.model_dump(), "provenance": provenance})
        return Prepared(
            version=version, index=index, projection_note=projection.reason, problems=problems
        )

    def propose(self, draft: PlanDraft, context: dict[str, Any], *, now: datetime) -> PlanVersion:
        """Check a draft and store it as its goal's next proposed version."""
        return self.write(self.prepare(draft, context, now=now), context)

    def write(self, prepared: Prepared, context: dict[str, Any]) -> PlanVersion:
        """Store what ``prepare`` returned, with the context it was prepared from."""
        if prepared.problems:
            raise PlanStoreError(prepared.refusal())
        version, index = prepared.version, prepared.index
        goal_id = version.goal.goal_id
        number = version.provenance.number
        for entry in index.versions:
            if entry.status == "proposed":
                entry.status = "withdrawn"
        _write(self._version_path(goal_id, number), version.model_dump_json(indent=2) + "\n")
        _write(self._context_path(goal_id, number), json.dumps(context, indent=2) + "\n")
        index.versions.append(VersionEntry(number=number, status="proposed"))
        self._write_index(index)
        return version

    def _pending_entry(self, index: GoalIndex) -> VersionEntry:
        for entry in index.versions:
            if entry.status == "proposed":
                return entry
        raise PlanStoreError(f"goal {index.goal_id} has nothing pending")

    def accept(self, goal_id: str) -> PlanVersion:
        index = self.index(goal_id)
        _refuse_finished(index, "takes no verdict")
        entry = self._pending_entry(index)
        version = self.version(goal_id, entry.number)
        first_acceptance = not any(e.status in ("accepted", "superseded") for e in index.versions)
        for other in index.versions:
            if other.status == "accepted":
                other.status = "superseded"
        entry.status = "accepted"
        if version.result is not None:
            index.status = "closed"
        elif first_acceptance:
            index.status = "active"
        self._write_index(index)
        if first_acceptance and version.result is None:
            for goal in self.goals():
                if goal.goal_id != goal_id and goal.status == "active":
                    goal.status = "archived"
                    # An archived goal takes no verdict, so its pending revision is withdrawn.
                    for pending in goal.versions:
                        if pending.status == "proposed":
                            pending.status = "withdrawn"
                    self._write_index(goal)
        return version

    def reject(self, goal_id: str) -> PlanVersion:
        index = self.index(goal_id)
        _refuse_finished(index, "takes no verdict")
        entry = self._pending_entry(index)
        entry.status = "rejected"
        self._write_index(index)
        return self.version(goal_id, entry.number)
