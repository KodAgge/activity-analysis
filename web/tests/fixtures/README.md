# End-to-end fixtures

`basemap-z0.pmtiles` (68132 bytes) is the one zoom 0 tile of a Protomaps basemap archive.
`routeMap.spec.ts` serves it in place of a fetched area, and `scripts/e2e-api-server.mjs` installs it as the end-to-end store's one basemap area for `basemap.spec.ts`.
It was extracted from Protomaps build `20261016.pmtiles` on basemap schema 4.15.2 with pmtiles 1.31.2, over a box around the committed fixture runs:

```bash
pmtiles extract https://build.protomaps.com/20261016.pmtiles web/tests/fixtures/basemap-z0.pmtiles --bbox=14.05,57.70,14.30,57.85 --maxzoom=0
```

Its header carries that box as its bounds, and its one tile covers the whole world.
Its SHA-256 is `94fb3863a7f420b6e763a6b0fb6baf40d49cf95aee3978984d10a464621b4f62`.
Its map data is © OpenStreetMap contributors, available under the Open Database License (https://www.openstreetmap.org/copyright), as built by Protomaps.
