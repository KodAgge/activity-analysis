"""Build the bundled place-name table from GeoNames.

Committed for provenance, not because it runs often: the output
(`src/activity_analysis/data/places.parquet`) is committed too, and this
script exists so a reader can see exactly what that file is, where it came
from and how to rebuild it.

    uv run python scripts/build_places.py

**Source.** GeoNames `cities1000` (every populated place with a population
over 1000) plus `countryInfo` for the country names, from
https://download.geonames.org/export/dump/. Licensed CC BY 4.0; the
attribution is in `docs/reference/derived-layer.md` under "Where an activity
happened", which is where a reader meets the data.

**Why `cities1000` and not a coarser extract.** Measured against the real
store's 21 distinct start-location clusters, on 2026-09-03:

| extract      | rows    | parquet | median error | worst  |
| ------------ | ------- | ------- | ------------ | ------ |
| cities15000  |  34 129 | 0.81 MB | 6.5 km       | 82.4 km |
| cities5000   |  69 685 | 1.57 MB | 2.8 km       | 52.0 km |
| cities1000   | 170 911 | 3.53 MB | 2.2 km       | 27.9 km |

The worst case is what decides it. At `cities15000` a run in a desert
resolves to a town 82 km away, which is not where it happened. At
`cities1000` the worst remaining answer is 27.9 km, and it is a different
start. Each is a genuinely remote start where the nearest place in the table
really is that far. 2.7 MB of
repository for that is the right trade.

Only the five columns the lookup needs are kept. The country name is
denormalised onto every row deliberately: Parquet dictionary-encodes it, so
250 distinct strings across 170 911 rows cost almost nothing, and it saves a
second file and a join at read time.
"""

from __future__ import annotations

import io
import urllib.request
import zipfile
from pathlib import Path

import pandas as pd

GEONAMES_DUMP = "https://download.geonames.org/export/dump"
CITIES_EXTRACT = "cities1000"

#: The GeoNames dump's own column order, from its `readme.txt`.
GEONAMES_COLUMNS = [
    "geonameid",
    "name",
    "asciiname",
    "alternatenames",
    "latitude",
    "longitude",
    "feature_class",
    "feature_code",
    "country_code",
    "cc2",
    "admin1",
    "admin2",
    "admin3",
    "admin4",
    "population",
    "elevation",
    "dem",
    "timezone",
    "modification_date",
]

OUTPUT = (
    Path(__file__).resolve().parent.parent / "src" / "activity_analysis" / "data" / "places.parquet"
)


def _fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 - fixed https host
        body: bytes = response.read()
    return body


def _country_names() -> pd.DataFrame:
    """Country code to country name, from `countryInfo.txt`.

    That file carries a comment block before the data and no header row for
    it, so the columns are named positionally here the same way the cities
    dump is.
    """
    raw = _fetch(f"{GEONAMES_DUMP}/countryInfo.txt")
    text = raw.decode("utf-8")
    data = "\n".join(line for line in text.splitlines() if not line.startswith("#"))
    frame = pd.read_csv(
        io.StringIO(data),
        sep="\t",
        header=None,
        dtype=str,
        keep_default_na=False,
        usecols=[0, 4],
        names=["country_code", "country"],
    )
    return frame


def main() -> None:
    countries = _country_names()

    archive = _fetch(f"{GEONAMES_DUMP}/{CITIES_EXTRACT}.zip")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        cities_raw = bundle.read(f"{CITIES_EXTRACT}.txt")

    cities = pd.read_csv(
        io.BytesIO(cities_raw),
        sep="\t",
        names=GEONAMES_COLUMNS,
        dtype=str,
        keep_default_na=False,
    )

    places = pd.DataFrame(
        {
            "name": cities["name"].astype("string"),
            "country_code": cities["country_code"].astype("string"),
            "lat": pd.to_numeric(cities["latitude"], errors="coerce").astype("float32"),
            "lon": pd.to_numeric(cities["longitude"], errors="coerce").astype("float32"),
            "population": pd.to_numeric(cities["population"], errors="coerce")
            .fillna(0)
            .astype("int32"),
        }
    ).dropna(subset=["lat", "lon"])

    places = places.merge(countries, on="country_code", how="left")
    places["country"] = places["country"].astype("string")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    places.to_parquet(OUTPUT, compression="zstd", index=False)
    print(f"wrote {OUTPUT} - {len(places)} places, {OUTPUT.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
