# Set up activity-analysis on Windows and start it, in four steps:
# install uv and the app, load an export, download the map, start the app.
#
#   powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/KodAgge/activity-analysis/HEAD/install.ps1 | iex"
#
# or, with the export named instead of asked for:
#
#   powershell -ExecutionPolicy ByPass -File install.ps1 "$HOME\Downloads\export_12345678.zip"
#
# Safe to run again, after a newer export for instance: uv is installed only
# when missing, the app is updated to the latest GitHub release, ingest reads
# only what is not stored yet, and tiles fetches only areas it does not have.
#
# Written for Windows PowerShell 5.1, the one every Windows 10 and 11 has.
# Everything is inside a function that returns rather than exits, because
# pasted as `irm ... | iex` an `exit` would close the reader's own window.

function Install-ActivityAnalysis([string] $ExportPath) {
    $ErrorActionPreference = "Stop"
    $PmtilesVersion = "1.31.2"
    $PythonVersion = "3.12"
    $ReleasesApi = "https://api.github.com/repos/KodAgge/activity-analysis/releases"
    # Windows PowerShell 5.1 can default to TLS 1.0, which GitHub refuses.
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    function Step([string] $Text) {
        Write-Host ""
        Write-Host "==> $Text" -ForegroundColor Cyan
    }

    # Windows PowerShell 5.1 decodes a native command's piped output in the
    # console's OEM code page, while uv writes UTF-8 and Python the ANSI code
    # page, so a path read back from either, such as a profile folder with a
    # non-ASCII name, would arrive mangled. Both ends are made UTF-8 for the
    # call.
    function Invoke-Utf8([scriptblock] $Command) {
        $previousEncoding = [Console]::OutputEncoding
        $previousPythonEncoding = $env:PYTHONIOENCODING
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $env:PYTHONIOENCODING = "utf-8"
        try {
            & $Command
        } finally {
            [Console]::OutputEncoding = $previousEncoding
            $env:PYTHONIOENCODING = $previousPythonEncoding
        }
    }

    Step "1/4 Installing uv and the app"
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        Write-Host "uv is already installed: $(uv --version)"
    } else {
        # In a child process, so that nothing the installer does to its own
        # session, an exit included, reaches this one.
        powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex"
        # The installer adds uv to PATH for windows opened from now on, not
        # this one. These are the directories it installs into, in its order.
        $candidates = @($env:UV_INSTALL_DIR, $env:XDG_BIN_HOME, "$env:USERPROFILE\.local\bin")
        foreach ($dir in $candidates) {
            if ($dir -and (Test-Path (Join-Path $dir "uv.exe"))) {
                $env:Path = "$dir;$env:Path"
                break
            }
        }
        if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
            Write-Host "uv is installed but this window cannot find it: open a new PowerShell window and run this again." -ForegroundColor Red
            return
        }
    }
    # The app is a wheel attached to the repository's latest GitHub release.
    # Its file name carries the version, so it is looked up rather than
    # guessed.
    try {
        $release = Invoke-RestMethod -UseBasicParsing -Uri "$ReleasesApi/latest"
    } catch {
        Write-Host "Could not ask GitHub for the latest release: $($_.Exception.Message)" -ForegroundColor Red
        return
    }
    $wheel = @($release.assets | Where-Object { $_.name -like "*.whl" })[0].browser_download_url
    if (-not $wheel) {
        Write-Host "The latest release on GitHub has no .whl file to install." -ForegroundColor Red
        return
    }
    # Python is named, because uv otherwise builds the app on the first
    # Python it finds, and a system Python older than 3.12 then fails the
    # install rather than making uv download one. A newer release's wheel
    # replaces the installed app; the same wheel again is a no-op.
    uv tool install --python $PythonVersion $wheel
    if ($LASTEXITCODE -ne 0) {
        Write-Host "The app could not be installed; the lines above say why." -ForegroundColor Red
        return
    }
    $env:Path = "$(Invoke-Utf8 { uv tool dir --bin });$env:Path"

    Step "2/4 Loading your export"
    if (-not $ExportPath) {
        Write-Host "Drag your Strava or Garmin Connect export (the .zip, or its unpacked folder)"
        Write-Host "onto this window, then press Enter. Press Enter alone to skip this step."
        $ExportPath = Read-Host ">"
    }
    # A dragged path arrives in double quotes when it holds a space.
    $ExportPath = $ExportPath.Trim().Trim('"').Trim("'")
    if ($ExportPath) {
        # Exits non-zero when some files failed, after storing the rest, so
        # the app is still worth starting.
        activity-analysis ingest $ExportPath
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Some of the export could not be read; the lines above say which."
        }
    } else {
        Write-Host "Skipped."
    }

    Step "3/4 Downloading the map"
    Write-Host "To draw your routes on a map, this downloads the map around each area you have"
    Write-Host "run in. Each area's box, at least 10 x 10 km, is sent to the Protomaps build"
    Write-Host "host to cut that part of the map; nothing else leaves this computer."
    $answer = Read-Host "Download the map? [Y/n]"
    if (-not $answer -or $answer -match "^[Yy]") {
        $info = Invoke-Utf8 { activity-analysis info } | Select-String -Pattern "^root:\s*(.+)$"
        if (-not $info) {
            Write-Host "activity-analysis info did not say where the app keeps its data." -ForegroundColor Red
            return
        }
        $tools = Join-Path $info.Matches[0].Groups[1].Value "tools"
        $pmtiles = Join-Path $tools "pmtiles.exe"
        $current = ""
        if (Test-Path $pmtiles) {
            # Windows PowerShell 5.1 turns a redirected stderr line into an
            # error, which Stop would throw.
            try { $current = & $pmtiles version 2>$null } catch { $current = "" }
        }
        $ready = "$current" -match "pmtiles $([regex]::Escape($PmtilesVersion))"
        if (-not $ready) {
            # A 32-bit PowerShell on a 64-bit Windows reports x86 here and the
            # real architecture in PROCESSOR_ARCHITEW6432.
            $machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
            $arch = if ($machine -eq "ARM64") { "arm64" } else { "x86_64" }
            $asset = "go-pmtiles_${PmtilesVersion}_Windows_$arch.zip"
            $download = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
            # A failure here only costs the map, so the app is still started.
            try {
                New-Item -ItemType Directory -Force -Path $download, $tools | Out-Null
                Invoke-WebRequest -UseBasicParsing -OutFile "$download\pmtiles.zip" `
                    -Uri "https://github.com/protomaps/go-pmtiles/releases/download/v$PmtilesVersion/$asset"
                Expand-Archive -Force -Path "$download\pmtiles.zip" -DestinationPath $download
                Copy-Item -Force "$download\pmtiles.exe" $pmtiles
                $ready = $true
            } catch {
                Write-Host "pmtiles could not be downloaded: $($_.Exception.Message)"
            } finally {
                Remove-Item -Recurse -Force $download -ErrorAction SilentlyContinue
            }
        }
        if ($ready) {
            activity-analysis tiles --pmtiles $pmtiles
            if ($LASTEXITCODE -ne 0) {
                Write-Host "Some of the map could not be downloaded; run this script again to retry."
            }
        } else {
            Write-Host "The map was not downloaded; the app starts without it."
        }
    } else {
        Write-Host "Skipped. Run this script again to download it later."
    }

    Step "4/4 Starting the app"
    Write-Host "It opens in your web browser at http://127.0.0.1:8000 and runs until you"
    Write-Host "close this window or press Ctrl+C. To start it again later:"
    Write-Host ""
    Write-Host "    activity-analysis serve --open"
    Write-Host ""
    activity-analysis serve --open
}

Install-ActivityAnalysis @args
