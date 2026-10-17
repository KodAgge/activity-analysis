"""The self-hosted basemap: area geometry, the manifest and fetching.

Nothing here computes a metric. The package decides which boxes of map to
fetch for the runs in the store and records what it fetched, so the API can
serve the files and the frontend can draw a map under a route.
``docs/reference/api.md`` covers serving them and ``docs/reference/frontend.md``
drawing them.
"""
