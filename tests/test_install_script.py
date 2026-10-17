"""install.sh driven with stub commands, so no test downloads uv or the app.

Run in a new session, which has no controlling terminal: the script reads its
questions from /dev/tty, and with none it must take its defaults rather than
wait for an answer. The map step is only reached with a yes, so its tests run
the script on a pseudo-terminal instead.
"""

import os
import pty
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="install.sh is the POSIX script")

SCRIPT = Path(__file__).resolve().parent.parent / "install.sh"

WHEEL = (
    "https://github.com/KodAgge/activity-analysis/releases/download/v0.1.0/"
    "activity_analysis-0.1.0-py3-none-any.whl"
)

#: The latest release as GitHub's API returns it, trimmed to the assets: one
#: field per line, the source archive listed before the wheel.
RELEASE_JSON = f"""{{
  "tag_name": "v0.1.0",
  "assets": [
    {{
      "name": "activity_analysis-0.1.0.tar.gz",
      "browser_download_url": "{WHEEL[: -len("-py3-none-any.whl")]}.tar.gz"
    }},
    {{
      "name": "activity_analysis-0.1.0-py3-none-any.whl",
      "browser_download_url": "{WHEEL}"
    }}
  ]
}}"""


def _stub(bin_dir: Path, name: str, log: Path, body: str = "") -> None:
    path = bin_dir / name
    path.write_text(f'#!/bin/sh\nprintf "%s\\n" "{name} $*" >> "{log}"\n{body}\n')
    path.chmod(0o755)


def _stubs(
    tmp_path: Path, curl: str = "", release: str = RELEASE_JSON
) -> tuple[Path, Path, dict[str, str]]:
    """Stub commands that log their arguments.

    ``curl`` answers the release lookup with ``release``, and runs ``curl``
    for every other download.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    log.touch()
    (tmp_path / "release.json").write_text(release)
    _stub(
        bin_dir,
        "curl",
        log,
        f'case "$*" in *api.github.com*) cat "{tmp_path / "release.json"}"; exit;; esac\n{curl}',
    )
    _stub(bin_dir, "uv", log, f'[ "$1 $2" = "tool dir" ] && echo "{bin_dir}"; true')
    _stub(
        bin_dir, "activity-analysis", log, f'[ "$1" = info ] && echo "root: {tmp_path}/root"; true'
    )
    home = tmp_path / "home"
    home.mkdir()
    return bin_dir, log, {"HOME": str(home), "PATH": f"{bin_dir}:/usr/bin:/bin"}


def _run(
    tmp_path: Path, *args: str, release: str = RELEASE_JSON
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    _, log, env = _stubs(tmp_path, release=release)
    result = subprocess.run(
        ["sh", str(SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
        start_new_session=True,
        timeout=30,
        check=False,
    )
    return result, log.read_text().splitlines()


def test_installs_the_latest_releases_wheel_on_a_named_python_then_ingests_and_serves(
    tmp_path: Path,
):
    export = tmp_path / "My Exports" / "export_1.zip"
    result, calls = _run(tmp_path, str(export))
    assert result.returncode == 0, result.stderr
    assert f"uv tool install --python 3.12 {WHEEL}" in calls
    assert f"activity-analysis ingest {export}" in calls
    assert calls[-1] == "activity-analysis serve --open"


def test_without_a_terminal_the_map_is_not_downloaded(tmp_path: Path):
    """Downloading the map sends each area's box away, so it needs a yes."""
    result, calls = _run(tmp_path, str(tmp_path / "export.zip"))
    assert result.returncode == 0, result.stderr
    assert not any(call.startswith("activity-analysis tiles") for call in calls)


def test_a_home_relative_export_path_is_expanded(tmp_path: Path):
    result, calls = _run(tmp_path, "~/Downloads/export.zip")
    assert result.returncode == 0, result.stderr
    assert f"activity-analysis ingest {tmp_path / 'home'}/Downloads/export.zip" in calls


def test_without_an_export_or_a_terminal_the_load_is_skipped(tmp_path: Path):
    result, calls = _run(tmp_path)
    assert result.returncode == 0, result.stderr
    assert not any(call.startswith("activity-analysis ingest") for call in calls)
    assert calls[-1] == "activity-analysis serve --open"


def test_an_installed_uv_is_not_installed_again(tmp_path: Path):
    result, calls = _run(tmp_path, str(tmp_path / "export.zip"))
    assert result.returncode == 0, result.stderr
    assert not any("astral.sh" in call for call in calls)


def test_a_release_without_a_wheel_stops_before_anything_is_installed(tmp_path: Path):
    result, calls = _run(tmp_path, str(tmp_path / "export.zip"), release='{"assets": []}')
    assert result.returncode == 1
    assert "no .whl file" in result.stderr
    assert not any(call.startswith("uv tool install") for call in calls)


def _run_answering_yes(tmp_path: Path, env: dict[str, str]) -> int:
    """Run on a pseudo-terminal, pressing Enter to say yes to the map."""
    pid, terminal = pty.fork()
    if pid == 0:
        os.execve("/bin/sh", ["sh", str(SCRIPT), str(tmp_path / "export.zip")], env)
    os.write(terminal, b"\n")
    while True:
        try:
            if not os.read(terminal, 4096):
                break
        except OSError:
            break
    os.close(terminal)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


# The forked child does nothing but exec the script, so the threads of the
# test process cannot leave it holding a lock.
@pytest.mark.filterwarnings("ignore:This process .* is multi-threaded:DeprecationWarning")
@pytest.mark.parametrize(
    "cause",
    ["the download fails", "the processor has no pmtiles build"],
)
def test_without_pmtiles_the_app_still_starts(tmp_path: Path, cause: str):
    """The export is stored by then, so losing the map must not lose the app."""
    bin_dir, log, env = _stubs(tmp_path, curl="exit 22")
    if cause == "the processor has no pmtiles build":
        _stub(bin_dir, "uname", log, '[ "$1" = -m ] && echo armv7l || echo Linux')
    returncode = _run_answering_yes(tmp_path, env)
    calls = log.read_text().splitlines()
    assert returncode == 0
    assert not any(call.startswith("activity-analysis tiles") for call in calls)
    assert calls[-1] == "activity-analysis serve --open"
