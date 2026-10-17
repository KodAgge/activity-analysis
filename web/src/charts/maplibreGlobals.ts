import { addProtocol, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Protocol } from 'pmtiles'

let globalsSet = false

/**
 * MapLibre's worker URL and protocol table are global, so both are set once
 * per page, before the first map - whichever of `RouteMap` and
 * `TerritoryMap` builds it.
 *
 * MapLibre finds its worker as `maplibre-gl-worker.mjs` beside its own
 * module, from `import.meta.url`. Under Vite neither holds: the dev
 * server's dependency pre-bundling moves the module into its deps cache,
 * where no worker file exists, and a production build emits no worker at
 * all. Either way the map fails before `load` with "Worker failed to
 * load". Importing the worker with `?worker&url` makes Vite serve it in
 * dev and emit it in a build, and hands back the URL it lives at.
 *
 * Its own module so the two map components share one flag: a copy per
 * component would register the `pmtiles` protocol twice and set the worker
 * URL again after the first map had already started its workers.
 */
export function ensureMapGlobals(): void {
  if (globalsSet) return
  setWorkerUrl(workerUrl)
  addProtocol('pmtiles', new Protocol().tile)
  globalsSet = true
}
