"""Plain-text rendering of a plan version for a terminal.

Paces are derived here from the stored speeds and never stored, the same rule
as everywhere else in the project.
"""

from __future__ import annotations

from datetime import date

from activity_analysis.plan.models import (
    ExpectedLoad,
    ExpectedLoadWeek,
    PlanVersion,
    Session,
    Step,
    VersionStatus,
    planned_trimp,
)


def format_duration(seconds: float) -> str:
    """``m:ss`` under an hour, ``h:mm:ss`` from an hour up."""
    total = round(seconds)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def format_km(metres: float) -> str:
    """Kilometres with up to two decimals and no trailing zeros."""
    return f"{round(metres / 1000, 2):g} km"


def format_pace(speed_mps: float) -> str:
    return format_duration(1000 / speed_mps)


def _zone(bpm: float, boundaries: list[float] | None) -> str:
    """The zone a heart rate falls in, as `` (Z2)``, or nothing without boundaries."""
    if boundaries is None:
        return ""
    # Both sides are rounded, as printed. A top on a boundary takes the zone the boundary
    # closes, since a ceiling is a limit; analysis/zones.py's side="right" does the opposite.
    return f" (Z{1 + sum(1 for b in boundaries if round(b) < round(bpm))})"


def _target(step: Step, boundaries: list[float] | None) -> str | None:
    if step.speed is not None:
        # The faster pace is the higher speed, and reads first.
        return f"{format_pace(step.speed.high_mps)}-{format_pace(step.speed.low_mps)}/km"
    if step.heart_rate is not None:
        heart_rate = step.heart_rate
        high = round(heart_rate.high_bpm)
        zone = _zone(heart_rate.high_bpm, boundaries)
        if heart_rate.low_bpm is None:
            return f"up to {high} bpm{zone}"
        return f"{round(heart_rate.low_bpm)}-{high} bpm{zone}"
    return None


def _step_line(step: Step, boundaries: list[float] | None) -> str:
    extent = (
        format_km(step.distance_m)
        if step.distance_m is not None
        else format_duration(step.duration_s or 0.0)
    )
    line = f"{step.role}: {step.repeat} x {extent}"
    target = _target(step, boundaries)
    if target:
        line += f" @ {target}"
    if step.note:
        line += f" ({step.note})"
    return line


def _session_lines(session: Session, boundaries: list[float] | None) -> list[str]:
    extent = ""
    if session.planned_distance_m is not None:
        extent = f", {format_km(session.planned_distance_m)}"
    elif session.planned_duration_s is not None:
        extent = f", {format_duration(session.planned_duration_s)}"
    lines = [f"  {session.date:%a} {session.date}  {session.kind}  {session.title}{extent}"]
    lines.extend(f"      {_step_line(step, boundaries)}" for step in session.steps)
    return lines


def goal_line(version: PlanVersion) -> str:
    goal = version.goal
    pace = format_duration(goal.target_time_s / (goal.distance_m / 1000))
    return (
        f"Goal {goal.goal_id}: {format_km(goal.distance_m)} in "
        f"{format_duration(goal.target_time_s)} ({pace}/km), "
        f"{goal.surface}, race {goal.race_date}"
    )


def expected_load_lines(expected: ExpectedLoad) -> list[str]:
    """The projection's start and race morning, and the plans it ran before this one."""
    start, morning = expected.start, expected.race_morning
    lines = [
        f"Expected from {start.local_date} to race morning: "
        f"fitness {start.ctl:.1f} -> {morning.ctl:.1f}, "
        f"fatigue {start.atl:.1f} -> {morning.atl:.1f}, "
        f"form {start.form:+.1f} -> {morning.form:+.1f}"
    ]
    if expected.bridged_from:
        lines.append(
            "  Before this plan's first week it runs the plan of "
            + ", ".join(expected.bridged_from)
        )
    return lines


def _expected_week(week: ExpectedLoadWeek) -> str:
    return (
        f"week means fitness {week.ctl_mean:.0f}, fatigue {week.atl_mean:.0f}, "
        f"form {week.form_mean:+.0f}"
    )


def _week_span(week: ExpectedLoadWeek) -> str | None:
    if week.start is None or week.end is None:
        return None
    a, b = week.start, week.end
    return (
        f"  Fitness {a.ctl:.1f} -> {b.ctl:.1f}, fatigue {a.atl:.1f} -> {b.atl:.1f}, "
        f"form {a.form:+.1f} -> {b.form:+.1f} over the week"
    )


def render_version(version: PlanVersion, status: VersionStatus) -> str:
    provenance = version.provenance
    lines = [
        goal_line(version),
        f"Version {provenance.number} ({status}), data through "
        f"{provenance.data_through or 'unknown'}",
    ]
    expected = provenance.expected_load
    if expected is not None:
        lines.extend(expected_load_lines(expected))
    expected_weeks = {} if expected is None else {w.week_start: w for w in expected.weeks}
    boundaries = provenance.zone_boundaries_bpm
    before: float | None = None
    for week in version.weeks:
        end = date.fromordinal(week.start_date.toordinal() + 6)
        lines.append("")
        lines.append(
            f"Week {week.start_date} to {end}: {week.phase}, {week.focus}, "
            f"{format_km(week.planned_distance_m)}"
        )
        load = None
        if week.planned_zone_minutes is not None and provenance.trimp_per_minute is not None:
            load = planned_trimp(week.planned_zone_minutes, provenance.trimp_per_minute)
        projected = expected_weeks.get(week.start_date)
        if load is not None:
            line = f"  TRIMP {load:.0f}"
            if before:
                line += f" ({(load - before) / before:+.0%})"
            if projected is not None:
                line += f"; {_expected_week(projected)}"
            lines.append(line)
        elif projected is not None:
            lines.append(f"  {_expected_week(projected)}")
        span = None if projected is None else _week_span(projected)
        if span is not None:
            lines.append(span)
        if week.load_note:
            lines.append(f"  Load: {week.load_note}")
        before = load
        for session in week.sessions:
            lines.extend(_session_lines(session, boundaries))
    return "\n".join(lines)
