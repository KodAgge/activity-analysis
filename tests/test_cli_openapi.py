"""The OpenAPI dump the frontend generates its types from.

Dumped from the application object rather than fetched over HTTP, so type
generation needs no running server and can run in a check.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from activity_analysis.cli import app

runner = CliRunner()


def test_openapi_command_emits_a_valid_schema() -> None:
    result = runner.invoke(app, ["openapi"])
    assert result.exit_code == 0
    schema = json.loads(result.stdout)
    assert schema["openapi"].startswith("3.1")
    assert set(schema["paths"]) >= {
        "/api/health",
        "/api/sports",
        "/api/activities",
        "/api/activities/{activity_id}",
        "/api/activities/{activity_id}/streams",
        "/api/overview",
    }


def test_openapi_command_needs_no_store(tmp_path: Path) -> None:
    """The schema describes the shape, so it must not depend on ingested data."""
    result = runner.invoke(app, ["openapi", "--root", str(tmp_path)])
    assert result.exit_code == 0
    assert json.loads(result.stdout)["components"]["schemas"]["Streams"]


def _declared_properties(generated: str) -> dict[str, set[str]]:
    """The property names each component schema declares in the generated
    TypeScript, keyed by schema name.

    ``schema.d.ts`` is generated output with a fixed shape - one
    ``Name: {`` block per component schema inside ``components.schemas``,
    one ``prop: type;`` line per property - so it is parsed here as the
    text contract it is, by brace depth, rather than searched for loose
    substrings. Comment content is skipped entirely: FastAPI copies every
    Pydantic docstring into the file as JSDoc, so prose there routinely
    contains words that look exactly like property names.
    """
    properties: dict[str, set[str]] = {}
    lines = generated.splitlines()

    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == "schemas: {")
    except StopIteration:  # pragma: no cover - only if openapi-typescript changes its output shape
        return properties

    depth = 0
    in_comment = False
    current: str | None = None

    for line in lines[start + 1 :]:
        code = line
        if in_comment:
            end = code.find("*/")
            if end == -1:
                continue
            code = code[end + 2 :]
            in_comment = False
        while True:
            begin = code.find("/*")
            if begin == -1:
                break
            end = code.find("*/", begin + 2)
            if end == -1:
                code = code[:begin]
                in_comment = True
                break
            code = code[:begin] + code[end + 2 :]
        code = code.split("//", 1)[0]

        stripped = code.strip()
        if depth == 0 and stripped.startswith("}"):
            break

        name = stripped.split(":", 1)[0].strip().strip('"?')
        if name.isidentifier():
            if depth == 0:
                current = name
                properties.setdefault(current, set())
            elif depth == 1 and current is not None:
                properties[current].add(name)

        depth += code.count("{") - code.count("}")

    return properties


def test_generated_typescript_matches_the_live_schema(tmp_path: Path) -> None:
    """The committed ``web/src/api/schema.d.ts`` must not drift from the
    schema the application actually serves.

    This is a structural check over generated output, not a real diff: it
    walks every component schema in the *live* OpenAPI document (built
    fresh from the application object, the same way ``npm run
    generate:api`` does) and asserts the *committed* TypeScript declares a
    block of the same name, declaring each of that schema's own property
    names. Crediting a name only to the interface that declares it is the
    point: an earlier version searched the whole file for each name, and
    FastAPI copies Pydantic docstrings into the generated file as JSDoc, so
    a name occurring in another interface or in a comment was enough to
    pass. That was not hypothetical - when ``moving_time_s`` was added to
    ``ActivitySummary`` the string was already in the file under
    ``ActivityMetrics``, so skipping ``npm run generate:api`` would have
    left a stale client type and still passed.

    It is a live-to-committed containment check, one direction only, which
    is enough to catch a renamed field or a new field on a Pydantic model
    in ``src/activity_analysis/api/`` - the drift that actually happens in
    practice. It does NOT catch a field being removed from the live
    schema: the committed file is never scanned for a name the live schema
    no longer has, so a stale, now-nonexistent entry sits in
    ``schema.d.ts`` undetected. Closing that gap needs the other direction
    too, which is what ``npm run check:api`` (a real regeneration and
    diff) does instead.

    It is also deliberately NOT a type checker: it reads names, never
    types, so it cannot see a narrower drift such as a type widening or
    narrowing (``number`` becoming ``number | null`` and nobody noticing).
    A field that changes type but keeps its name passes this test.
    Catching that needs a real generation diff too, i.e. ``npm run
    check:api``, not this test.

    Skipped rather than failed when the generated file is absent, so the
    backend suite still passes in a checkout where ``web/`` has not had
    ``npm install`` / ``npm run generate:api`` run in it yet.
    """
    schema_ts_path = Path(__file__).resolve().parents[1] / "web" / "src" / "api" / "schema.d.ts"
    if not schema_ts_path.exists():
        pytest.skip(f"{schema_ts_path} does not exist; frontend not set up in this checkout")

    result = runner.invoke(app, ["openapi", "--root", str(tmp_path)])
    assert result.exit_code == 0
    live_schemas = json.loads(result.stdout)["components"]["schemas"]
    declared = _declared_properties(schema_ts_path.read_text())

    assert declared, (
        "no component schema blocks were parsed out of web/src/api/schema.d.ts; "
        "openapi-typescript's output shape has changed and _declared_properties "
        "needs updating - it is not safe to read an empty parse as 'no drift'."
    )

    missing = []
    for name, schema in live_schemas.items():
        if name not in declared:
            missing.append(name)
            continue
        for prop in schema.get("properties", {}):
            if prop not in declared[name]:
                missing.append(f"{name}.{prop}")

    assert not missing, (
        f"web/src/api/schema.d.ts is stale: {missing} from the live OpenAPI schema "
        "are not declared by the matching interface in the generated TypeScript. "
        "Run `npm run generate:api` in web/ and commit the regenerated "
        "schema.d.ts together with this change."
    )


def test_the_drift_check_credits_a_property_only_to_its_own_interface() -> None:
    """The false negative that made the check above worth rewriting.

    ``moving_time_s`` appears on three schemas and inside JSDoc prose. A
    check that searched the whole file for the bare name passed while
    ``ActivitySummary`` was missing it entirely; parsing per interface is
    what makes that a failure.
    """
    generated = """export interface components {
    schemas: {
        /**
         * ActivityMetrics
         * @description Not to be confused with the summary's own moving_time_s.
         */
        ActivityMetrics: {
            /** Moving Time S */
            moving_time_s: number | null;
            /** Nested */
            nested: {
                inner_only: number;
            };
        };
        /** ActivitySummary */
        ActivitySummary: {
            /** Activity Id */
            activity_id: string;
        };
    };
    responses: never;
}
"""
    declared = _declared_properties(generated)

    assert declared["ActivityMetrics"] == {"moving_time_s", "nested"}
    # Present in the file three times over - another interface, a JSDoc
    # sentence, a comment - and still absent from the interface that
    # matters.
    assert "moving_time_s" not in declared["ActivitySummary"]
    # A nested object literal's own keys belong to no top-level schema.
    assert "inner_only" not in declared["ActivityMetrics"]
    # Sections after `schemas` are not schemas.
    assert "responses" not in declared
