#!/usr/bin/env bash
# Regenerates web/src/api/schema.d.ts from the Python app's own OpenAPI dump.
#
# NOT a pure-Node script: it shells out to `uv run activity-analysis openapi`,
# so it needs the Python environment (uv, the project's venv) on PATH. That
# also holds for `npm run check:api` and `npm run check`, which call this.
#
# Nothing invokes `npm run check` automatically - it is a convenience for a
# human working in web/, not a gate. The thing that actually stands between
# a renamed backend field and a stale committed client is
# tests/test_cli_openapi.py::test_generated_typescript_matches_the_live_schema,
# which runs under `uv run pytest`, the command this project's gate already
# runs on every change.
set -euo pipefail

cd "$(dirname "$0")/.."  # web/

mkdir -p src/api
tmp="src/api/schema.d.ts.json"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

(cd .. && uv run activity-analysis openapi) > "$tmp"
npx openapi-typescript "$tmp" -o src/api/schema.d.ts
