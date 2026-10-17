#!/bin/sh
# Set up activity-analysis on macOS or Linux and start it, in four steps:
# install uv and the app, load an export, download the map, start the app.
#
#   curl -LsSf https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/install.sh | sh
#
# or, with the export named instead of asked for:
#
#   sh install.sh ~/Downloads/export_12345678.zip
#
# Safe to run again, after a newer export for instance: uv is installed only
# when missing, the app is updated to the latest GitHub release, ingest reads
# only what is not stored yet, and tiles fetches only areas it does not have.

set -eu

PMTILES_VERSION=1.31.2
PYTHON_VERSION=3.12
RELEASES_API=https://api.github.com/repos/KodAgge/activity-analysis/releases

step() {
    printf '\n==> %s\n' "$1"
}

fail() {
    printf '\nerror: %s\n' "$1" >&2
    exit 1
}

# Under `curl | sh` the script itself is standard input, so questions are
# read from the terminal instead.
has_terminal() {
    (: </dev/tty) 2>/dev/null
}

ask() {
    printf '%s ' "$1"
    IFS= read -r REPLY </dev/tty || REPLY=
}

# A path dragged onto a terminal arrives quoted ('...' or "...") or with each
# space escaped, depending on the terminal, often with a trailing space.
unquote() {
    printf '%s' "$1" | sed \
        -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
        -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/' \
        -e 's/\\\(.\)/\1/g'
}

# Downloads the pmtiles binary into the directory $1. A failure here only
# costs the map, so it returns non-zero rather than stopping the script, and
# since set -e is off inside a condition every step is checked by hand.
get_pmtiles() {
    case $(uname -m) in
        x86_64 | amd64) arch=x86_64 ;;
        arm64 | aarch64) arch=arm64 ;;
        *)
            echo "There is no pmtiles build for this processor, $(uname -m)."
            return 1
            ;;
    esac
    base="https://github.com/protomaps/go-pmtiles/releases/download/v$PMTILES_VERSION"
    mkdir -p "$1" || return 1
    case $(uname -s) in
        Darwin)
            # Downloaded with curl, not a browser, so macOS does not
            # quarantine the binary and refuse to run it.
            download=$(mktemp -d) || return 1
            curl -LsSf -o "$download/pmtiles.zip" \
                "$base/go-pmtiles-${PMTILES_VERSION}_Darwin_$arch.zip" &&
                unzip -o -q "$download/pmtiles.zip" pmtiles -d "$1"
            status=$?
            rm -rf "$download"
            return $status
            ;;
        Linux)
            curl -LsSf "$base/go-pmtiles_${PMTILES_VERSION}_Linux_$arch.tar.gz" |
                tar -xz -C "$1" pmtiles
            ;;
        *)
            echo "There is no pmtiles build for $(uname -s)."
            return 1
            ;;
    esac
}

command -v curl >/dev/null 2>&1 || fail "this needs curl, which this computer does not have"

step "1/4 Installing uv and the app"
if command -v uv >/dev/null 2>&1; then
    echo "uv is already installed: $(uv --version)"
else
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # The installer adds uv to PATH for terminals opened from now on, not
    # this one. These are the directories it installs into, in its order.
    for dir in "${UV_INSTALL_DIR:-}" "${XDG_BIN_HOME:-}" \
        "${XDG_DATA_HOME:+$XDG_DATA_HOME/../bin}" "$HOME/.local/bin"; do
        if [ -n "$dir" ] && [ -x "$dir/uv" ]; then
            PATH="$dir:$PATH"
            break
        fi
    done
    command -v uv >/dev/null 2>&1 ||
        fail "uv is installed but this terminal cannot find it: open a new terminal and run this again"
fi
# The app is a wheel attached to the repository's latest GitHub release. Its
# file name carries the version, so it is looked up rather than guessed; the
# API's JSON puts each asset's download URL on a line of its own.
release=$(curl -LsSf "$RELEASES_API/latest") ||
    fail "could not ask GitHub for the latest release"
wheel=$(printf '%s\n' "$release" |
    sed -n 's/.*"browser_download_url": *"\([^"]*\.whl\)".*/\1/p' | head -n 1)
[ -n "$wheel" ] || fail "the latest release on GitHub has no .whl file to install"
# Python is named, because uv otherwise builds the app on the first Python it
# finds, and a system Python older than 3.12 then fails the install rather
# than making uv download one. A newer release's wheel replaces the installed
# app; the same wheel again is a no-op.
uv tool install --python "$PYTHON_VERSION" "$wheel"
PATH="$(uv tool dir --bin):$PATH"

step "2/4 Loading your export"
export_path=${1:-}
if [ -z "$export_path" ] && has_terminal; then
    echo "Drag your Strava or Garmin Connect export (the .zip, or its unpacked folder)"
    echo "onto this window, then press Enter. Press Enter alone to skip this step."
    ask ">"
    export_path=$(unquote "$REPLY")
fi
# A typed ~ arrives unexpanded from read; matching it literally is the point.
# shellcheck disable=SC2088
case $export_path in
    "~/"*) export_path="$HOME/${export_path#"~/"}" ;;
esac
if [ -n "$export_path" ]; then
    # Exits non-zero when some files failed, after storing the rest, so the
    # app is still worth starting.
    activity-analysis ingest "$export_path" ||
        echo "Some of the export could not be read; the lines above say which."
else
    echo "Skipped."
fi

step "3/4 Downloading the map"
echo "To draw your routes on a map, this downloads the map around each area you have"
echo "run in. Each area's box, at least 10 x 10 km, is sent to the Protomaps build"
echo "host to cut that part of the map; nothing else leaves this computer."
answer=n
if has_terminal; then
    ask "Download the map? [Y/n]"
    answer=${REPLY:-y}
fi
case $answer in
    [Yy]*)
        root=$(activity-analysis info | sed -n 's/^root: *//p')
        [ -n "$root" ] || fail "activity-analysis info did not say where the app keeps its data"
        tools="$root/tools"
        pmtiles="$tools/pmtiles"
        if "$pmtiles" version 2>/dev/null | grep -q "pmtiles $PMTILES_VERSION" ||
            get_pmtiles "$tools"; then
            activity-analysis tiles --pmtiles "$pmtiles" ||
                echo "Some of the map could not be downloaded; run this script again to retry."
        else
            echo "The map was not downloaded; the app starts without it."
        fi
        ;;
    *)
        echo "Skipped. Run this script again to download it later."
        ;;
esac

step "4/4 Starting the app"
echo "It opens in your web browser at http://127.0.0.1:8000 and runs until you"
echo "close this window or press Ctrl+C. To start it again later:"
echo
echo "    activity-analysis serve --open"
echo
exec activity-analysis serve --open
