"""Command line entry point."""

from __future__ import annotations

import ipaddress
import socket
import threading
import time
import webbrowser
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Annotated

import typer

from activity_analysis.analysis.pipeline import RecomputeResult, derived_is_behind
from activity_analysis.analysis.pipeline import recompute as run_recompute
from activity_analysis.analysis.places import place_count
from activity_analysis.basemap.fetch import (
    BasemapError,
    load_run_traces,
    run_tiles,
    urllib_fetch,
)
from activity_analysis.config import DEFAULT_ATHLETE_ID, Paths, default_paths
from activity_analysis.ingest.archive import (
    GARMIN,
    STRAVA,
    UNPACK_ERRORS,
    detect_archive_kind,
    extract_export,
    unpack_garmin_uploads,
)
from activity_analysis.ingest.pipeline import ingest as run_ingest
from activity_analysis.progress import Progress
from activity_analysis.store.db import connect

app = typer.Typer(help="Advanced training analysis for runners.", no_args_is_help=True)

#: An activity's start as a local wall clock, from the UTC instant and the
#: offset it was recorded under.
#:
#: ``AT TIME ZONE 'UTC'`` is what makes this independent of the reader: DuckDB
#: renders a TIMESTAMPTZ in the session timezone otherwise, so without it the
#: expression happens to be right only on a machine set to UTC. Formatted in
#: SQL because handing a TIMESTAMPTZ back to Python makes DuckDB import pytz,
#: which nothing else here needs.
LOCAL_START_SQL = (
    "strftime(start_time_utc AT TIME ZONE 'UTC' "
    "+ to_seconds(coalesce(utc_offset_s, 0)), '%Y-%m-%d %H:%M')"
)

RootOption = Annotated[
    Path | None,
    typer.Option(
        "--root",
        help=(
            "Directory holding the data directory. Defaults to $ACTIVITY_ANALYSIS_HOME, "
            "then the platform's user data directory."
        ),
        show_default=False,
    ),
]


def _paths(root: Path | None) -> Paths:
    return Paths(root=root) if root is not None else default_paths()


class _TerminalProgress(Progress):
    """A bar for each counted loop, and a line for each step that has no count.

    A full export takes minutes to ingest, and a command that prints nothing
    for that long looks hung. Off a terminal, ``click`` prints each bar's label
    once instead of redrawing it.
    """

    def track[T](self, items: Sequence[T], label: str) -> Iterator[T]:
        with typer.progressbar(items, label=label, show_pos=True) as bar:
            yield from bar

    def stage(self, label: str) -> None:
        typer.echo(label)


PROGRESS = _TerminalProgress()


@app.command()
def ingest(
    source: Annotated[
        Path, typer.Argument(help="The export's .zip, or the directory it was unpacked into.")
    ],
    root: RootOption = None,
    athlete: Annotated[str, typer.Option(help="Athlete identifier.")] = DEFAULT_ATHLETE_ID,
    archive_kind: Annotated[
        str,
        typer.Option(
            "--archive-kind",
            help="'strava', 'garmin', or 'auto' to tell from the export's layout.",
        ),
    ] = "auto",
    force: Annotated[bool, typer.Option(help="Reprocess files already in the ledger.")] = False,
    recompute: Annotated[
        bool,
        typer.Option(help="Rebuild the derived layer afterwards, if anything was ingested."),
    ] = True,
) -> None:
    """Ingest an export's FIT and GPX files into the canonical store."""
    if archive_kind not in ("auto", STRAVA, GARMIN):
        typer.echo(f"--archive-kind must be 'auto', 'strava' or 'garmin', not {archive_kind!r}")
        raise typer.Exit(code=1)
    paths = _paths(root)

    if source.is_file() and source.suffix.lower() == ".zip":
        # Unpacked into the store's raw/ rather than beside the zip, which is
        # usually a Downloads folder: raw/ is where the store keeps its exports.
        into = paths.raw / source.stem
        typer.echo(f"unpacking {source} into {into}")
        try:
            source = extract_export(source, into, PROGRESS)
        except UNPACK_ERRORS as exc:
            typer.echo(f"Cannot unpack {source}: {exc}")
            raise typer.Exit(code=1) from exc
    elif not source.exists():
        typer.echo(f"Source does not exist: {source}")
        raise typer.Exit(code=1)
    elif not source.is_dir():
        typer.echo(f"Expected an export as a .zip or an unpacked directory, not {source}")
        raise typer.Exit(code=1)

    if archive_kind == "auto":
        detected = detect_archive_kind(source)
        if detected is None:
            typer.echo(
                f"Cannot tell what kind of export {source} is: it has neither Strava's "
                "activities.csv nor Garmin's DI_CONNECT directory at the top. "
                "Pass --archive-kind strava or --archive-kind garmin."
            )
            raise typer.Exit(code=1)
        archive_kind = detected
        typer.echo(f"reading {source} as a {archive_kind} export")

    unpack_errors: list[tuple[Path, str]] = []
    if archive_kind == GARMIN:
        unpacked, unpack_errors = unpack_garmin_uploads(source, PROGRESS)
        if unpacked:
            typer.echo(f"unpacked {len(unpacked)} Garmin upload zip(s)")

    result = run_ingest(
        paths, source, athlete_id=athlete, archive_kind=archive_kind, force=force, progress=PROGRESS
    )
    typer.echo(
        f"ingested {result.ingested}, replaced {result.replaced}, "
        f"already processed {result.skipped_already_processed}, "
        f"lower priority {result.skipped_lower_priority}"
    )
    if result.skipped_not_an_activity:
        typer.echo(
            f"  {result.skipped_not_an_activity} file(s) held no recording: saved routes, "
            "or a Garmin export's monitoring and sleep files"
        )
    if result.skipped_unsupported:
        typer.echo(
            f"  {result.skipped_unsupported} activity file(s) in an unsupported format "
            "were left out: no reader handles that format yet"
        )
    if result.vo2max_files:
        typer.echo(f"  {result.vo2max_files} Garmin VO2max file(s) read")
    for zipped, message in unpack_errors:
        typer.echo(f"  error: {zipped}: cannot unpack, so its activities were not read: {message}")
    for path, message in result.errors:
        typer.echo(f"  error: {path}: {message}")

    # Every view reads the derived layer, so an ingest that changed the store
    # leaves the application showing the old one until this has run. A store
    # whose last recompute never finished counts too: re-running the same
    # ingest after an interrupted one ingests nothing, and must still finish it.
    rebuilt = True
    if recompute and (result.ingested or result.replaced or derived_is_behind(paths)):
        typer.echo("recomputing the derived layer")
        rebuilt = _report_recompute(run_recompute(paths, PROGRESS))
    if result.errors or unpack_errors or not rebuilt:
        raise typer.Exit(code=1)


def _report_recompute(result: RecomputeResult) -> bool:
    """Print what a recompute built, and whether every activity was rebuilt."""
    typer.echo(
        f"{result.activities} activities, {result.best_efforts} best efforts, "
        f"{result.zone_rows} zone rows, {result.tag_rows} tags, "
        f"{result.profile_intervals} profile intervals, "
        f"{result.efficiency_rows} efficiency rows, {result.fitness_rows} fitness rows"
        f", {result.reclassified} run(s) counted as walks"
        f", {result.routes} routes"
        f", {result.territory_claims} territory claims"
        f" ({result.territory_area_m2 / 1e6:.2f} km2)"
    )
    if result.skipped_no_streams:
        typer.echo(f"  {result.skipped_no_streams} activity/activities had no stream data")
    for activity_id, message in result.errors:
        typer.echo(f"  error: {activity_id}: {message}")
    return not result.errors


@app.command("recompute")
def recompute_command(root: RootOption = None) -> None:
    """Rebuild the derived layer from the canonical store."""
    # A partial rebuild is a failure, not a warning: a scripted
    # `recompute && <next step>` must not proceed against a derived layer
    # that is missing activities.
    if not _report_recompute(run_recompute(_paths(root), PROGRESS)):
        raise typer.Exit(code=1)


@app.command()
def tiles(
    root: RootOption = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Print the areas to fetch and send nothing.")
    ] = False,
    pmtiles: Annotated[
        str, typer.Option("--pmtiles", help="The pmtiles CLI, if it is not on PATH.")
    ] = "pmtiles",
) -> None:
    """Fetch the basemap areas the stored runs need, and the map's fonts and sprites.

    Each area fetched sends its box, at least 10 x 10 km, to the Protomaps
    build host. Areas already fetched are never requested again.
    """
    paths = _paths(root)
    try:
        result = run_tiles(
            paths,
            load_run_traces(paths),
            binary=pmtiles,
            fetch=urllib_fetch,
            dry_run=dry_run,
            echo=typer.echo,
        )
    except BasemapError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(code=1) from exc
    if not dry_run:
        typer.echo(
            f"fetched {len(result.fetched)}, kept {len(result.kept)}, "
            f"replaced {len(result.removed)}"
        )
    for area, message in result.errors:
        typer.echo(f"  error: {area}: {message}")
    if result.errors:
        raise typer.Exit(code=1)


@app.command()
def activities(root: RootOption = None, limit: int = 20) -> None:
    """List stored activities, newest first."""
    with connect(_paths(root)) as con:
        rows = con.execute(
            # Rendered at the offset the run was recorded under, not at the
            # reader's. The session timezone would be a guess that happens to
            # be right only while the athlete runs in the reader's own
            # timezone. Storage stays UTC; local time is a presentation
            # concern.
            f"""
            SELECT {LOCAL_START_SQL} AS start,
                   utc_offset_s IS NULL AS offset_unknown,
                   sport, round(distance_m) AS distance_m,
                   round(elapsed_time_s) AS elapsed_s, source
            FROM activities ORDER BY start_time_utc DESC LIMIT ?
            """,
            [limit],
        ).fetchall()

    if not rows:
        typer.echo("No activities. Run 'ingest' first.")
        return
    for start, offset_unknown, sport, distance, elapsed, source in rows:
        # A GPX file records no offset, so the instant is all there is to show.
        stamp = f"{start} UTC" if offset_unknown else start
        typer.echo(
            f"{stamp:<20} {str(sport or '-'):<9} {distance:>8.0f} m  {elapsed:>6.0f} s  {source}"
        )


@app.command()
def info(root: RootOption = None) -> None:
    """Show store location, row counts, and the bundled reference data."""
    paths = _paths(root)
    typer.echo(f"root:      {paths.root}")
    typer.echo(f"canonical: {paths.canonical}")
    typer.echo(f"derived:   {paths.derived}")
    # Two labelled sections rather than one flat list, because the two halves
    # answer to different things: the store rows are what this installation
    # ingested and must agree table for table with `/api/health`, while the
    # bundled table ships with the package and never appears there.
    # `tests/test_api_health.py` reads the store section alone to compare the
    # two surfaces, so the indentation is a contract, not decoration - a
    # reference line added flat would be mistaken for one more store table.
    typer.echo("")
    typer.echo("store rows:")
    with connect(paths) as con:
        for table in (
            "activities",
            "laps",
            "streams",
            "streams_1hz",
            "best_efforts",
            "zone_time",
            "activity_metrics",
            "athlete_profile",
            "activity_tags",
            "activity_efficiency",
            "athlete_fit",
            "fitness_series",
            "sport_reclassifications",
        ):
            row = con.execute(f"SELECT count(*) FROM {table}").fetchone()
            typer.echo(f"  {table}: {row[0] if row else 0}")
    typer.echo("")
    typer.echo("bundled reference data:")
    typer.echo(f"  places: {place_count()}")


@app.command()
def openapi(root: RootOption = None) -> None:
    """Print the OpenAPI schema the frontend generates its TypeScript from.

    Built from the application object, not fetched from a running server, so
    `npm run generate:api` needs no `serve` and the result can be diffed in a
    check. Takes no store: the schema describes shapes, not data.
    """
    import json

    from activity_analysis.api.main import create_app

    typer.echo(json.dumps(create_app(_paths(root)).openapi(), indent=2))


def _reaches_beyond_this_machine(host: str) -> bool:
    """Whether binding ``host`` exposes the server past the loopback interface.

    Resolved through ``ipaddress`` rather than compared against a literal, so
    that ``::1`` and ``127.0.0.2`` are recognised as loopback and ``0.0.0.0``
    and ``::`` are not. A name is resolved first, which is what makes
    ``localhost`` come out right. A name that does not resolve is treated as
    exposed: the safe answer when the question cannot be settled is the one
    that warns.
    """
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            resolved = socket.getaddrinfo(host, None)
        except OSError:
            return True
        addresses = [ipaddress.ip_address(str(info[4][0]).split("%")[0]) for info in resolved]
    return not addresses or not all(address.is_loopback for address in addresses)


def _open_once_listening(host: str, port: int, *, timeout_s: float = 30.0) -> threading.Thread:
    """Open the app in the browser from a daemon thread, once ``port`` accepts a connection.

    Opened any earlier, the browser shows a connection error before the
    server is up, and someone who has just run the install script has no
    reason to think a reload would fix it. A wildcard bind is reached through
    loopback. Gives up quietly after ``timeout_s``: the URL is printed anyway.
    """
    reach = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
    url = f"http://[{reach}]:{port}" if ":" in reach else f"http://{reach}:{port}"

    def wait_then_open() -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                with socket.create_connection((reach, port), timeout=1.0):
                    pass
            except OSError:
                time.sleep(0.2)
                continue
            webbrowser.open(url)
            return

    thread = threading.Thread(target=wait_then_open, daemon=True)
    thread.start()
    return thread


@app.command()
def serve(
    root: RootOption = None,
    host: Annotated[str, typer.Option(help="Interface to bind.")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port to bind.")] = 8000,
    open_browser: Annotated[
        bool, typer.Option("--open", help="Open the app in the web browser once it is up.")
    ] = False,
) -> None:
    """Serve the store over HTTP, with the web frontend when it is built."""
    # Imported here so that 'activities' and 'info' do not pay FastAPI's
    # import cost for a command that never starts a server.
    import uvicorn

    from activity_analysis.api import frontend
    from activity_analysis.api.main import create_app

    paths = _paths(root)
    build = frontend.find_build()
    typer.echo(f"serving {paths.root} on http://{host}:{port}")
    if build is not None:
        typer.echo(f"frontend: {build}")
    else:
        # Only a checkout gets here: the wheel carries the build.
        typer.echo(
            "no built frontend found, so only the API is served. Build it with "
            "'cd web && npm ci && npm run build', or run 'npm run dev' in web/ beside this server."
        )
    typer.echo(f"docs: http://{host}:{port}/docs")
    # Not decoration. The connection is opened once, at startup, so a
    # recompute while the server runs is not picked up, and the symptom is a
    # number that does not move, which reads exactly like a bug in the metric
    # that was just changed.
    typer.echo("the store is read once, at startup: restart after an ingest or a recompute")
    if _reaches_beyond_this_machine(host):
        typer.echo(
            f"WARNING: {host} is not a loopback address, so the store is being served "
            "to every network this machine is on, with no authentication of any kind. "
            "Anyone who can reach this port can read the whole history, including the "
            "GPS traces of where the runs started from."
        )
    if open_browser:
        _open_once_listening(host, port)
    uvicorn.run(create_app(paths, frontend=build), host=host, port=port)
