import { describe, expect, it } from 'vitest'
import { buildAreasStyle, buildStyle } from './basemapStyle'

describe('buildStyle', () => {
  const style = buildStyle('abc123', 'grayscale', 'http://localhost:5173', 'attr')

  it('reads the area archive through the pmtiles protocol on the app origin', () => {
    const source = style.sources.protomaps
    expect(source).toMatchObject({
      type: 'vector',
      url: 'pmtiles://http://localhost:5173/api/basemap/areas/abc123.pmtiles',
      attribution: 'attr',
    })
  })

  it('takes glyphs and the flavour sprite from the API', () => {
    expect(style.glyphs).toBe('http://localhost:5173/api/basemap/assets/fonts/{fontstack}/{range}.pbf')
    expect(style.sprite).toBe('http://localhost:5173/api/basemap/assets/sprites/v4/grayscale')
  })

  it('carries layers for the one source, with English labels', () => {
    expect(style.layers.length).toBeGreaterThan(10)
    const labelled = style.layers.filter((l) => l.type === 'symbol' && JSON.stringify(l.layout).includes('name:en'))
    expect(labelled.length).toBeGreaterThan(0)
  })
})

describe('buildAreasStyle', () => {
  const origin = 'http://localhost:5173'

  it('makes one pmtiles source per area', () => {
    const style = buildAreasStyle(['aaa', 'bbb'], 'light', origin, 'attr', '#fff')
    expect(Object.keys(style.sources)).toEqual(['protomaps-aaa', 'protomaps-bbb'])
    expect(style.sources['protomaps-bbb']).toMatchObject({
      type: 'vector',
      url: 'pmtiles://http://localhost:5173/api/basemap/areas/bbb.pmtiles',
      attribution: 'attr',
    })
  })

  it('interleaves the layers so every area draws one kind of layer before any area draws the next', () => {
    const single = buildStyle('aaa', 'light', origin, 'attr')
    const style = buildAreasStyle(['aaa', 'bbb'], 'light', origin, 'attr', '#fff')
    // One background, then every other layer twice.
    expect(style.layers).toHaveLength(2 * single.layers.length - 1)
    const backgrounds = style.layers.filter((l) => l.type === 'background')
    expect(backgrounds).toHaveLength(1)
    // The page's own quiet surface past the fetched areas, not Protomaps' grey.
    expect(backgrounds[0]).toMatchObject({ paint: { 'background-color': '#fff' } })
    const ids = style.layers.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.slice(1, 5)).toEqual(['earth--aaa', 'earth--bbb', 'landcover--aaa', 'landcover--bbb'])
    const earthB = style.layers.find((l) => l.id === 'earth--bbb')
    expect(earthB).toMatchObject({ source: 'protomaps-bbb' })
  })

  it('is the background alone, in the colour given, when no area is fetched', () => {
    const style = buildAreasStyle([], 'light', origin, 'attr', '#f2f5f7')
    expect(style.sources).toEqual({})
    expect(style.layers).toEqual([{ id: 'background', type: 'background', paint: { 'background-color': '#f2f5f7' } }])
  })
})
