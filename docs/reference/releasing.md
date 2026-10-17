# Releasing

The app is distributed as a GitHub release of this repository, not through a package index.
Each release carries the wheel, with the built frontend inside it, and the source archive.
Users install the wheel with `uv tool install`, so they need neither Node nor a checkout.

## What reads a release

- `install.sh` and `install.ps1` ask GitHub's API for the latest release and install the first `.whl` attached to it.
  A release must therefore carry exactly one wheel, and a release meant for nobody yet must be a draft or a pre-release, which `releases/latest` skips.
- The README's "Step by step" names one release's wheel URL, with its version twice: in the tag, `v0.1.0`, and in the file name, `activity_analysis-0.1.0-py3-none-any.whl`.
- A newer wheel URL passed to `uv tool install` replaces the installed app, and the same URL again is a no-op.
  `uv tool upgrade` does nothing for an app installed from a URL, so the README does not offer it.

## Steps

1. Bump `version` in `pyproject.toml`, and the version in the README's wheel URL, in the same pull request.
2. After it merges, build from a clean tree: `uv build`.
   The hatch build hook runs `npm ci` and `npm run build` in `web/`, so this needs Node.
3. Scan what is about to be published: `uv run python scripts/privacy_scan.py dist/*`.
4. Create the release on the public repository, tagged `v<version>`, with both files:

   ```bash
   gh release create v0.1.0 dist/activity_analysis-0.1.0-py3-none-any.whl dist/activity_analysis-0.1.0.tar.gz \
       --repo KodAgge/activity-analysis --title "0.1.0" --notes "..."
   ```

5. Check it as a user would: run the setup script in a fresh home directory, or the README's install command, and confirm `activity-analysis info` and `serve` work.
