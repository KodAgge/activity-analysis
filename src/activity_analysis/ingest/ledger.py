"""Record of source files already processed, so ingestion is idempotent."""

from __future__ import annotations

from typing import Any

import pandas as pd

from activity_analysis.config import Paths
from activity_analysis.models import LEDGER_SCHEMA, empty_frame


def load_ledger(paths: Paths) -> pd.DataFrame:
    """Every recorded ingestion, or an empty frame if none exist."""
    if not paths.ledger_parquet.exists():
        return empty_frame(LEDGER_SCHEMA)
    return pd.read_parquet(paths.ledger_parquet)


def processed_hashes(paths: Paths) -> set[str]:
    """Content hashes of source files that have already been processed.

    A file that failed is not processed. Its ``error`` row stays as the record
    of the attempt, but the next ingest tries it again, so the fix for what
    made it fail reaches it without ``--force``.
    """
    ledger = load_ledger(paths)
    return set(ledger.loc[ledger["status"] != "error", "source_file_sha256"].tolist())


def append_ledger(paths: Paths, rows: list[dict[str, Any]]) -> None:
    """Add rows to the ledger, creating it if necessary."""
    if not rows:
        return
    paths.ensure()
    incoming = pd.DataFrame(rows, columns=LEDGER_SCHEMA.names)
    incoming["ingested_at"] = pd.to_datetime(incoming["ingested_at"], utc=True)
    combined = pd.concat([load_ledger(paths), incoming], ignore_index=True)
    combined.to_parquet(paths.ledger_parquet, index=False, schema=LEDGER_SCHEMA)
