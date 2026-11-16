"""The ``plan`` commands a Claude Code skill drives.

``context`` and ``schema`` feed Claude, ``propose`` stores its draft, and
``accept`` and ``reject`` record the athlete's decision. Every expected
failure leaves as one message on stderr and exit code 1, never a traceback.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Annotated, Any, NoReturn

import typer
from pydantic import ValidationError

from activity_analysis.cli_options import RootOption, paths_from
from activity_analysis.plan.context import build_context
from activity_analysis.plan.models import GoalIndex, PlanDraft, PlanVersion, VersionStatus
from activity_analysis.plan.render import render_version
from activity_analysis.plan.store import PlanStore, PlanStoreError, Prepared
from activity_analysis.store.db import connect

plan_app = typer.Typer(help="AI-written training plans.", no_args_is_help=True)

TodayOption = Annotated[
    str | None,
    typer.Option("--today", help="The date the plan is made on, YYYY-MM-DD. Defaults to today."),
]


def _fail(message: str) -> NoReturn:
    typer.echo(message, err=True)
    raise typer.Exit(1)


@contextmanager
def _errors() -> Iterator[None]:
    try:
        yield
    except (PlanStoreError, ValidationError) as error:
        _fail(str(error))


def _today(value: str | None) -> date:
    if value is None:
        return date.today()
    try:
        return date.fromisoformat(value)
    except ValueError:
        _fail(f"--today must be YYYY-MM-DD, got {value!r}")


def _pending_goal(store: PlanStore) -> str:
    goals = store.goals()
    pending = [g.goal_id for g in goals if store.pending(g.goal_id) is not None]
    if len(pending) == 1:
        return pending[0]
    if not pending:
        known = ", ".join(g.goal_id for g in goals) or "none"
        _fail(f"no goal has a pending version; goals: {known}")
    _fail(f"several goals have a pending version, name one: {', '.join(pending)}")


def _default_goal(store: PlanStore) -> str:
    goals = store.goals()
    if not goals:
        _fail("there are no goals; propose one first")
    pending = [g for g in goals if store.pending(g.goal_id) is not None]
    if len(pending) == 1:
        return pending[0].goal_id
    active = next((g for g in goals if g.status == "active"), None)
    return (active or goals[0]).goal_id


def _version_numbers(index: GoalIndex, status: VersionStatus) -> list[int]:
    return [e.number for e in index.versions if e.status == status]


@plan_app.command()
def context(root: RootOption = None, today: TodayOption = None) -> None:
    """Print the facts a plan is written from, as JSON."""
    paths = paths_from(root)
    with _errors(), connect(paths) as con:
        built = build_context(con, today=_today(today), store=PlanStore(paths))
    typer.echo(json.dumps(built, indent=2))


@plan_app.command()
def schema(root: RootOption = None) -> None:
    """Print the JSON schema a draft must follow. ``--root`` is accepted and unused."""
    typer.echo(json.dumps(PlanDraft.model_json_schema(), indent=2))


def _read_draft(file: Path) -> PlanDraft:
    try:
        text = file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        _fail(f"{file} cannot be read: {error}")
    return PlanDraft.model_validate_json(text)


def _prepare(
    file: Path, root: Path | None, today: str | None
) -> tuple[PlanStore, Prepared, dict[str, Any]]:
    paths = paths_from(root)
    day = _today(today)
    draft = _read_draft(file)
    store = PlanStore(paths)
    with connect(paths) as con:
        built = build_context(con, today=day, store=store)
    return store, store.prepare(draft, built, now=datetime.now(UTC)), built


def _projection_note(prepared: Prepared) -> None:
    if prepared.projection_note is not None:
        typer.echo(f"No expected fitness and fatigue: {prepared.projection_note}.")


@plan_app.command()
def check(
    file: Annotated[Path, typer.Argument(help="The draft, as JSON.")],
    root: RootOption = None,
    today: TodayOption = None,
) -> None:
    """Print the plan as propose would, then every problem propose would refuse; store nothing."""
    with _errors():
        _, prepared, _ = _prepare(file, root, today)
    typer.echo(render_version(prepared.version, "proposed"))
    _projection_note(prepared)
    typer.echo("")
    if prepared.problems:
        _fail(prepared.refusal())
    typer.echo(
        "The draft passes and nothing was stored. Propose it with: "
        f"uv run activity-analysis plan propose {file}"
    )


@plan_app.command()
def propose(
    file: Annotated[Path, typer.Argument(help="The draft, as JSON.")],
    root: RootOption = None,
    today: TodayOption = None,
) -> None:
    """Store a draft as the goal's next proposed version."""
    with _errors():
        store, prepared, built = _prepare(file, root, today)
        version = store.write(prepared, built)
    goal_id = version.goal.goal_id
    typer.echo(render_version(version, "proposed"))
    _projection_note(prepared)
    typer.echo("")
    typer.echo(
        f"Proposed v{version.provenance.number} of {goal_id}. "
        f"Accept with: uv run activity-analysis plan accept {goal_id}"
    )


@plan_app.command()
def accept(
    goal_id: Annotated[str | None, typer.Argument()] = None, root: RootOption = None
) -> None:
    """Accept the pending version of a goal."""
    store = PlanStore(paths_from(root))
    with _errors():
        chosen = goal_id or _pending_goal(store)
        version = store.accept(chosen)
    typer.echo(f"Accepted v{version.provenance.number} of {chosen}.")


@plan_app.command()
def reject(
    goal_id: Annotated[str | None, typer.Argument()] = None, root: RootOption = None
) -> None:
    """Reject the pending version of a goal."""
    store = PlanStore(paths_from(root))
    with _errors():
        chosen = goal_id or _pending_goal(store)
        version = store.reject(chosen)
    typer.echo(f"Rejected v{version.provenance.number} of {chosen}.")


@plan_app.command("list")
def list_goals(root: RootOption = None) -> None:
    """One line per goal."""
    store = PlanStore(paths_from(root))
    with _errors():
        for goal in store.goals():
            race = store.current(goal).goal.race_date
            parts = [goal.goal_id, goal.status]
            parts += [f"accepted v{n}" for n in _version_numbers(goal, "accepted")]
            parts += [f"pending v{n}" for n in _version_numbers(goal, "proposed")]
            parts.append(f"race {race}")
            typer.echo("  ".join(parts))


@plan_app.command()
def show(
    goal_id: Annotated[str | None, typer.Argument()] = None,
    root: RootOption = None,
    version: Annotated[int | None, typer.Option("--version", help="A version number.")] = None,
) -> None:
    """Show a goal's plan: the pending version, else the accepted, else the newest."""
    store = PlanStore(paths_from(root))
    with _errors():
        chosen = goal_id or _default_goal(store)
        index = store.index(chosen)
        shown: PlanVersion
        if version is not None:
            entry = next((e for e in index.versions if e.number == version), None)
            if entry is None:
                _fail(f"goal {chosen} has no version {version}")
        else:
            entry = next((e for e in index.versions if e.status == "proposed"), None) or next(
                (e for e in reversed(index.versions) if e.status == "accepted"), index.versions[-1]
            )
        shown = store.version(chosen, entry.number)
    typer.echo(render_version(shown, entry.status))
