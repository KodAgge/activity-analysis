"""Collapse per-activity profile observations into versioned intervals.

Maximum heart rate, resting heart rate and body mass drift over years, and
applying today's values to a run from three years ago would silently corrupt
every zone distribution in the application.

The versioning captures configuration changes, not physiology. These are
settings the athlete typed into Garmin Connect, so a new interval appears only
when they edited one. An interval that has stood for a year means nobody
touched the setting, and nothing downstream should read anything into it.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

PROFILE_COLUMNS = [
    "athlete_id",
    "effective_from",
    "effective_to",
    "weight_kg",
    "height_m",
    "resting_hr_bpm",
    "max_hr_bpm",
    "hr_zone_boundaries",
    "hr_calc_type",
]

_VALUE_COLUMNS = [
    "weight_kg",
    "height_m",
    "resting_hr_bpm",
    "max_hr_bpm",
    "hr_zone_boundaries",
    "hr_calc_type",
]


def _key(row: pd.Series) -> tuple[Any, ...]:
    """A hashable identity for the settings, so consecutive equals collapse."""
    values: list[Any] = []
    for column in _VALUE_COLUMNS:
        value = row[column]
        if value is None:
            values.append(None)
        elif isinstance(value, (list, tuple)) or hasattr(value, "tolist"):
            values.append(tuple(float(v) for v in value))
        elif pd.isna(value):
            values.append(None)
        else:
            values.append(value)
    return tuple(values)


def observations_for_sport(
    observations: pd.DataFrame, activities: pd.DataFrame, sport: str
) -> pd.DataFrame:
    """Observations recorded during activities of one sport.

    Heart rate zone settings are per sport in FIT. The real export configures a
    maximum heart rate of 207 for running and 205 for walking, so versioning
    every sport into one athlete timeline produces hundreds of alternating
    intervals that record which sport happened next rather than anything the
    athlete ever edited.

    Weight, height and resting heart rate come from `user_profile` and are not
    sport-specific, but they travel with the zone settings in the same message
    set, so the whole observation is scoped rather than half of it.
    """
    if observations.empty or activities.empty:
        return observations.iloc[0:0]
    wanted = set(activities.loc[activities["sport"] == sport, "activity_id"])
    filtered: pd.DataFrame = observations[observations["activity_id"].isin(wanted)]
    return filtered


def version_profile(observations: pd.DataFrame) -> pd.DataFrame:
    """One row per change in the recorded settings, per athlete."""
    if observations.empty:
        return pd.DataFrame(columns=PROFILE_COLUMNS)

    frame = observations.sort_values(["athlete_id", "observed_at"]).reset_index(drop=True)
    rows: list[dict[str, Any]] = []

    for athlete_id, group in frame.groupby("athlete_id", sort=True):
        previous: tuple[Any, ...] | None = None
        for _, observation in group.iterrows():
            key = _key(observation)
            if key == previous:
                continue
            previous = key
            if rows and rows[-1]["athlete_id"] == athlete_id:
                rows[-1]["effective_to"] = observation["observed_at"]
            row: dict[str, Any] = {
                "athlete_id": athlete_id,
                "effective_from": observation["observed_at"],
                "effective_to": pd.NaT,
            }
            row.update({column: observation[column] for column in _VALUE_COLUMNS})
            rows.append(row)

    result = pd.DataFrame(rows, columns=PROFILE_COLUMNS)
    result["effective_from"] = pd.to_datetime(result["effective_from"], utc=True)
    result["effective_to"] = pd.to_datetime(result["effective_to"], utc=True)
    return result


def profile_at(profile: pd.DataFrame, athlete_id: str, moment: pd.Timestamp) -> pd.Series | None:
    """The settings in force at ``moment``, or None if they predate the record.

    Nothing is extrapolated backwards. A run older than the first observation
    has no attributable profile, and saying so is better than guessing.
    """
    if profile.empty:
        return None
    mine = profile[profile["athlete_id"] == athlete_id]
    in_force = mine[
        (mine["effective_from"] <= moment)
        & (mine["effective_to"].isna() | (mine["effective_to"] > moment))
    ]
    if in_force.empty:
        return None
    row: pd.Series = in_force.iloc[-1]
    return row
