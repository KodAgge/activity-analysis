# activity-analysis

Training analysis for runners, from your own Strava or Garmin Connect export, on your own machine.

![The Trends view: heart rate at three reference paces falling over three years of runs](https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/docs/images/trends.png)

*Every screenshot here shows the demo store, synthetic runs built from the five committed sample activities; see [Contributing](#contributing).*

## Why this exists

Strava and Garmin both show you what you did.
Neither tells you clearly whether you are getting fitter.

Raw metrics plotted over time mostly measure circumstance rather than fitness.
Average heart rate went up because the run was faster.
Cadence went down because the run was slower.
The fitness signal is underneath, but it is buried.

This project normalises for those circumstances and plots what is left:

- **Heart rate at a fixed reference pace**, the direct aerobic fitness signal. Falling means fitter.
- **Cadence at a fixed reference pace**, so a change in form is separated from a change in pace.
- **Aerobic decoupling**, first-half against second-half efficiency, as a measure of endurance durability.
- **Race predictions** at the classic distances from a kilometre up, from your real best efforts, as a range from two models, beside a third that predicts from ordinary running and needs no maximal effort.

Pace is not adjusted for terrain: on the history this was developed against, grade adjustment removed no bias from heart rate at the reference pace and made the cadence fit worse, so it is shelved.

## What it shows

**Overview**: this week, the last four weeks, streaks, twelve weekly bars, time in heart rate zones and the whole weekly history.

![The Overview](https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/docs/images/overview.png)

**An activity**: the route coloured by pace on a basemap, a replay, pace, heart rate, cadence and elevation streams that follow one hovered moment, splits, laps, zones, best efforts and aerobic decoupling.

![An activity page](https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/docs/images/activity.jpg)

**Trends**: heart rate and cadence at three reference paces, decoupling and VO2max from two methods, with Garmin's own beside them when the export carries it, and the race predictions.
Every finding the page states is computed from your own runs.

**Progression**: every effort at a distance over time, with the record staircase and which efforts the watch's speed confirms.

![Progression at 5 km](https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/docs/images/progression.png)

**Records**: the best effort at each distance, and recurring routes, each with its runs ranked.

![A recurring route](https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/docs/images/route.jpg)

**Distributions**: any of fifteen per-run variables as a histogram, comparing two periods, weekdays and weekends, outdoor and treadmill, or each year.

![Average pace by year in the Distributions view](https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/docs/images/distributions.png)

**Territory**: all the ground your outdoor loops have ever enclosed, and how it grew.

![The Territory view](https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/docs/images/territory.jpg)

## Getting started

The app runs in your web browser.
You install and start it by pasting a few commands into a terminal, the window where the computer takes typed commands, and no programming is involved.

### What you need

- **A computer running macOS, Windows or Linux**, 64-bit, with an Intel, AMD or ARM processor such as Apple's M chips.
  Windows on ARM, such as laptops with a Snapdragon chip, is not supported yet, because pyarrow, a library the app needs, publishes no build for it.
  It has been run on Windows 11 and Linux, and not yet on a Mac.
- **An export of your Strava or Garmin Connect account**: step 1 below.
- **An internet connection while setting up**, to download uv, the app, Python and, if you want it, the map.
  After that the app runs without one.
- **About 500 MB of disk for the app**: 370 MB for the app and its libraries and 110 MB for Python.
- **Room for your export, unpacked, and a little more**, since the app keeps a copy of it.
  A Garmin export whose zip is 109 MB unpacks to 464 MB, and the app's folder came to 588 MB.
- **A current web browser.**

Everything else is installed for you, by the setup script or by the steps by hand:

- **[uv](https://docs.astral.sh/uv/)**, which installs and runs the app.
- **Python 3.12**, which uv downloads if the computer does not already have that version.
  No Python already on the computer is changed, whatever its version.
- **[pmtiles](https://github.com/protomaps/go-pmtiles) 1.31.2**, only for the map; see [Maps](#maps).

None of it needs administrator rights: uv installs into your own user folders.
Node, Git and a copy of this repository are needed only to work on the app itself; see [Contributing](#contributing).

### 1. Request your export

Strava takes up to a few hours to prepare an export and Garmin usually up to two days, so ask for it first: [Getting your data](#getting-your-data) says where.
Both email you a link to a `.zip` file; download it.

### 2. Open a terminal

- **macOS**: open **Terminal**, in Applications > Utilities, or search for it with Spotlight (⌘ Space).
- **Windows**: open **PowerShell** from the Start menu.
- **Linux**: open your terminal.

Paste each command below into that window and press Enter to run it.

### 3. Set up and start the app

Either run the setup script, which does all of [the steps below](#step-by-step) in one go, or do them yourself.

#### With the setup script

On macOS or Linux:

```bash
curl -LsSf https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/install.sh | sh
```

On Windows:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/install.ps1 | iex"
```

It installs uv and the app, asks you to drag your export onto the terminal window, asks before downloading the map, since that sends the map boxes [Privacy](#privacy) describes, and then starts the app and opens it in your web browser.
Run it again after a newer export: it skips whatever is already done and updates the app to the latest release on GitHub.
The scripts are [`install.sh`](https://github.com/KodAgge/activity-analysis/blob/HEAD/install.sh) and [`install.ps1`](https://github.com/KodAgge/activity-analysis/blob/HEAD/install.ps1), short enough to read before running them.

#### Step by step

**Install uv and the app, once.**
[uv](https://docs.astral.sh/uv/) installs the app, and the Python version it needs, so you do not install Python yourself.
On macOS or Linux:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

On Windows:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

With Homebrew, `brew install uv` installs it too, and on Windows `winget install --id=astral-sh.uv -e`.
Close the terminal and open a new one, so that it finds the `uv` command, then install the app:

```bash
uv tool install --python 3.12 https://github.com/KodAgge/activity-analysis/releases/download/v0.1.0/activity_analysis-0.1.0-py3-none-any.whl
```

That is release 0.1.0, the file attached to it on GitHub.
The [releases page](https://github.com/KodAgge/activity-analysis/releases/latest) has the newest, and the link to its `.whl` file goes in the same command.

`--python 3.12` makes uv download Python 3.12 when the computer lacks it; without it, uv installs onto whatever Python it finds first, and on a computer whose own Python is older than 3.12, as some Linux and macOS versions ship, the install fails.
If the terminal then says it cannot find `activity-analysis`, run `uv tool update-shell` and open a new terminal.

**Load your export.**
Type `activity-analysis ingest` followed by a space, drag the downloaded zip from your Downloads folder onto the terminal window, which types its path for you, and press Enter.
The command then looks like this on macOS and Linux:

```bash
activity-analysis ingest ~/Downloads/export_12345678.zip
```

and like this on Windows:

```powershell
activity-analysis ingest "$HOME\Downloads\export_12345678.zip"
```

If your browser unpacked the zip into a folder, as Safari does by default, drag the folder instead: `ingest` takes either.
`ingest` copies the export into the app's own folder, reads every activity in it and computes everything the views show, with a progress bar for each step, then prints what it read and what it left out.
A Garmin export of about 2900 activities, which unpacks to 34650 files, took 7 minutes on Linux and 21 minutes on Windows on the same computer.

**Download the map**, if you want routes drawn on one rather than on a blank background: see [Maps](#maps).

**Start the app.**

```bash
activity-analysis serve --open
```

It opens [http://127.0.0.1:8000](http://127.0.0.1:8000) in your web browser once it is up; without `--open`, open that address yourself.
The app runs as long as that terminal window is open; press Ctrl+C in it, or close it, to stop the app.

### After that

- **To use the app again**, open a terminal and run `activity-analysis serve --open`.
- **After a newer export**, stop the app, then run the setup script again, or load the new zip and start the app as above. Only activities not already stored are read.
- **To update the app**, run the setup script again, or the install command above with the newest release's `.whl` link.

### Where your data is

The app keeps its copy of your export and everything it computes in one folder:

- macOS: `~/Library/Application Support/activity-analysis`
- Windows: `%LOCALAPPDATA%\activity-analysis`
- Linux: `~/.local/share/activity-analysis`, or `$XDG_DATA_HOME/activity-analysis` when that is set

`activity-analysis info` prints the folder and what it holds.
The setup script keeps the `pmtiles` program there too, under `tools`.
Deleting the folder removes all of it, and `uv tool uninstall activity-analysis` removes the app.
`ACTIVITY_ANALYSIS_HOME`, or `--root` on any command, puts the store in another folder.

## Getting your data

There is no live integration: the Strava API endpoints that carry stream data need a paid subscription.
Both providers give you a bulk export for free instead.
Their pages as of 2026-10-16; both rename them from time to time.

### Strava

On the Strava website (the app has no export), open Settings from the menu under your name, then **My Account**, and under **Download your account** choose **Get Started**, then **Request download**.
Strava emails a download link, which [its help article](https://support.strava.com/en-us/articles/15401919-exporting-your-data-and-bulk-export) says may take a few hours.

The zip holds `activities.csv` and an `activities/` folder with each activity's file as it was uploaded, gzipped: `.fit.gz` from a watch, sometimes `.gpx.gz` or `.tcx.gz`.
It can also hold your photos and videos under `media/`, which `ingest` does not need; deleting that folder from the zip first makes it smaller.

### Garmin Connect

Sign in at [Garmin Account Data Management](https://www.garmin.com/account/datamanagement/), choose **Export Your Data**, then **Request Data Export**.
Garmin emails a download link; [its FAQ](https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8) says links typically arrive within 48 hours but can take up to 30 days.

The zip holds `DI_CONNECT/`, with the original FIT files from the watch in further zips under `DI-Connect-Uploaded-Files` or `DI-Connect-Fitness-Uploaded-Files`.
`ingest` unpacks those itself.
It also reads Garmin's own VO2max from `DI-Connect-Metrics`, which the Trends view draws beside its two estimates.

### Which to use

If your runs come from a Garmin watch, use the Garmin export: it carries the device's original FIT files, and a Garmin file wins over Strava's copy of the same run.
Ingesting both is safe, since a run present in both is stored once, and adds whatever only one of them holds: load each zip in turn.
Ingesting is idempotent, so a newer export of the same account processes only what is new.

**FIT is what the analysis needs.**
A GPX file has no laps, no heart rate zones and no athlete profile, and its speed has to be derived from positions: on the committed sample run the GPX copy carries 10.2 times the second-to-second speed noise of the FIT file.
GPX activities are read and flagged, and the trend analyses leave them out.
TCX files are listed as not read.

## Privacy

Everything stays on your machine: the store is files in the folder under [Where your data is](#where-your-data-is), and `serve` binds to `127.0.0.1` unless `--host` names another interface, which it warns about, since the API has no authentication.
The one exception is optional: `tiles`, below, sends the box around each area you have run in to the Protomaps build host to download that part of the map.
`--dry-run` shows what it would send.

## Maps

Without a basemap each route is drawn as a bare trace.
To draw it on a map, `tiles` downloads the parts of the map your runs need, using a separate program, the [`pmtiles` CLI](https://github.com/protomaps/go-pmtiles/releases/tag/v1.31.2), version 1.31.2.
The setup script does this for you; by hand, these commands download that program into the folder the terminal is in and run `tiles` with it.
[Privacy](#privacy) says what `tiles` sends.

On a Mac with an Apple chip (M1 and later; the Apple menu > About This Mac says which):

```bash
curl -LO https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles-1.31.2_Darwin_arm64.zip
unzip go-pmtiles-1.31.2_Darwin_arm64.zip pmtiles
activity-analysis tiles --pmtiles ./pmtiles
```

On a Mac with an Intel chip, the same with `Darwin_x86_64` in place of `Darwin_arm64`.

On Windows:

```powershell
curl.exe -LO https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Windows_x86_64.zip
Expand-Archive go-pmtiles_1.31.2_Windows_x86_64.zip pmtiles
activity-analysis tiles --pmtiles .\pmtiles\pmtiles.exe
```

On Linux:

```bash
curl -L https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_x86_64.tar.gz | tar xz pmtiles
activity-analysis tiles --pmtiles ./pmtiles
```

On a Linux computer with an ARM processor, the same with `Linux_arm64` in place of `Linux_x86_64`.

Reload the app's page afterwards.
`tiles` fetches boxes of map that between them hold every stored run, at least 10 x 10 km each, plus the map's fonts and sprites, and never fetches an area it already has.
Run the last command again after ingesting runs somewhere new; with `pmtiles` on `PATH`, `--pmtiles` can be left out.

## Commands

```bash
activity-analysis ingest <export.zip or unpacked directory>   # Strava or Garmin, told apart by layout
activity-analysis recompute    # rebuild everything derived; ingest already runs it
activity-analysis serve        # the app on http://127.0.0.1:8000 (--open opens it), the API's documentation at /docs
activity-analysis tiles        # optional basemap, see Maps
activity-analysis activities   # list what is stored, newest first
activity-analysis info         # where the store is and what it holds
```

`ingest` tells a Strava export from a Garmin one by layout, `activities.csv` or `DI_CONNECT` at the top; `--archive-kind strava` or `--archive-kind garmin` names it for a directory that is neither.
It reports what it left out rather than skipping quietly: files in a format no reader handles, and files with no recording, such as saved routes or Garmin's monitoring and sleep files.
A file that failed is tried again on the next run.
`--force` re-reads files already ingested, which only matters after an upgrade changes what the store records.

`serve` reads the store at startup, so restart it after an `ingest` or a `recompute`.
Both `ingest` and `recompute` exit non-zero if anything failed, after doing the rest of the work.

## How the numbers are computed

Every metric is derived from first principles in [`docs/reference/math/`](https://github.com/KodAgge/activity-analysis/blob/HEAD/docs/reference/math/README.md), with the alternatives that were rejected, the error that survives, and worked numbers from the committed sample activities.

Turning a stream of coordinates into a statement about fitness involves more geometry, numerical analysis and physiology than it first appears, so those documents are written to be read for their own sake.
Some samples: why the spherical law of cosines produces a 2.6% error on a 0.52 m segment while the algebraically identical haversine formula does not, why hashing a measured distance cannot identify an activity at any bucket width, and why a mean pace is always slower than the pace of a mean speed.

The references under [`docs/reference/`](https://github.com/KodAgge/activity-analysis/tree/HEAD/docs/reference) record why each layer is shaped the way it is.

## Contributing

Python 3.12 with [`uv`](https://docs.astral.sh/uv/) and Node 22.19 or later (`web/.nvmrc`).
Development runs on 3.12; the whole suite also passed on 3.13 on 2026-10-16, and there is no CI to keep checking it.

```bash
uv sync
(cd web && npm ci)
uv run pytest && uv run ruff check . && uv run mypy   # Python
(cd web && npm run check)                             # lint, types, API schema drift, unit tests
(cd web && npm run test:e2e)                          # Playwright, on a store built from the sample activities
```

For the frontend with hot reload, run `uv run activity-analysis serve` and `cd web && npm run dev`, and open `http://localhost:5173`.

`data/examples/` holds five real Garmin Venu 2 Plus runs, relocated and with their profile replaced, which the tests and the documentation's worked examples use; see [`docs/reference/test-fixtures.md`](https://github.com/KodAgge/activity-analysis/blob/HEAD/docs/reference/test-fixtures.md).
`uv run python scripts/build_demo_store.py <dir>` builds the demo store the screenshots show from them, and [`docs/reference/demo-store.md`](https://github.com/KodAgge/activity-analysis/blob/HEAD/docs/reference/demo-store.md) explains how and how to retake the screenshots.

Documents quote figures from those sample activities freely.
From anyone's real export they quote only sample sizes, proportions and relative errors, never absolute performances, body metrics, places, positions or activity ids.

`CLAUDE.md` is the orientation file for working on this with an agent, and the reference files under `docs/reference/` are where each layer's contracts and traps live.

## Scope

Running, for one athlete on their own machine.
The data model carries `sport` throughout, so other activity types are an additive change.
Other users are not: the store, the derived tables and the API all assume one athlete, so a hosted multi-user version would be a different data model, not a configuration change.

## Licence

MIT, see [`LICENSE`](https://github.com/KodAgge/activity-analysis/blob/HEAD/LICENSE).
The bundled place names are from [GeoNames](https://www.geonames.org/), CC BY 4.0, as `scripts/build_places.py` records.
Map data is © OpenStreetMap contributors, under the Open Database License, as built by Protomaps.
