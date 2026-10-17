"""Bundled reference data.

A package rather than a bare directory so `importlib.resources` can address
it, which is what lets the place table resolve identically from a source
checkout, an installed wheel or a zip import.

`places.parquet` is a trimmed GeoNames extract - `cities1000` plus country
names - built by `scripts/build_places.py`, which records its provenance,
its licence and the measurements behind the choice of extract.
"""
