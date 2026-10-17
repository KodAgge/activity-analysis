/** One zone's bpm edges, in the shape `ZoneBar`'s `buckets` prop expects. */
export interface ZoneEdge {
  zone_index: number
  low_bpm: number | null
  high_bpm: number | null
}

/**
 * Pairs a flat list of configured zone boundaries into the per-zone
 * `{low, high}` edges `ZoneBar` renders.
 *
 * `Overview.zones` (`ZoneTotal`) carries no boundaries of its own - see
 * docs/reference/api.md, "GET /api/overview": a sum across a period during
 * which the athlete's maximum heart rate changed has no single pair.
 * `Overview.zone_boundaries_bpm` carries the *currently configured*
 * boundaries separately, as a flat `number[]`, leaving the pairing for a
 * consumer to do. Rather than have every caller re-derive it, it is done
 * once here: `n` boundaries define `n + 1` zones (see
 * docs/reference/derived-layer.md), zone 0 is everything below the first
 * boundary, zone `n` is everything at or above the last, and a sample
 * sitting exactly on a boundary belongs to the zone that boundary opens -
 * so boundary `i` is zone `i`'s high edge and zone `i + 1`'s low edge.
 *
 * A single activity's own `derived.zones` (`ZoneBucket`) needs none of
 * this: it already carries its own `low_bpm`/`high_bpm` per row, because
 * one profile was in force for that one activity.
 */
export function zoneEdgesFromBoundaries(boundariesBpm: number[]): ZoneEdge[] {
  const edges: ZoneEdge[] = []
  for (let zoneIndex = 0; zoneIndex <= boundariesBpm.length; zoneIndex++) {
    const low = zoneIndex === 0 ? null : (boundariesBpm[zoneIndex - 1] ?? null)
    const high = zoneIndex === boundariesBpm.length ? null : (boundariesBpm[zoneIndex] ?? null)
    edges.push({ zone_index: zoneIndex, low_bpm: low, high_bpm: high })
  }
  return edges
}
