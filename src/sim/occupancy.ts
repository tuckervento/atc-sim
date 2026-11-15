// What an aircraft's body covers: the stretch of its track from its tail to its nose, and the
// runway areas that stretch is in.
//
// A runway's area is its own edges plus every edge with an end on it: the stretch between a
// hold line and the runway. A hold line marks where the runway's protected area begins, so a
// body past it is on the runway (an aircraft whose nose is exactly on the hold node isn't).

import { edgesAt, type AirportIndex } from '../airport/graph.ts';
import type { EdgeId, RunwayId } from '../airport/types.ts';
import type { Aircraft } from './world.ts';

/** Part of a body on one track edge: track edge `i`, from distance `a` to `b` along the track (a < b). */
export interface BodySpan {
  i: number;
  a: number;
  b: number;
}

/** The track edges the body overlaps by more than a point, tail first. */
export function bodySpans(ac: Aircraft): BodySpan[] {
  const tail = Math.max(0, ac.s - ac.lengthM);
  const spans: BodySpan[] = [];
  const { nodeAt } = ac.track;
  for (let i = 0; i < ac.track.edges.length; i++) {
    const [start, end] = [nodeAt[i], nodeAt[i + 1]];
    if (start === undefined || end === undefined) throw new Error(`${ac.callsign}: track edge ${i} has no extent`);
    const a = Math.max(start, tail);
    const b = Math.min(end, ac.s);
    if (b > a) spans.push({ i, a, b });
  }
  return spans;
}

/** For each edge in a runway's area, the runways (sorted). Edges in none are absent. */
export function runwayAreas(index: AirportIndex): Map<EdgeId, RunwayId[]> {
  const runwaysAt = (node: string) => edgesAt(index, node).flatMap((e) => (e.kind === 'runway' && e.runway !== undefined ? [e.runway] : []));
  const areas = new Map<EdgeId, RunwayId[]>();
  for (const edge of index.airport.edges) {
    const runways = new Set([...(edge.runway === undefined ? [] : [edge.runway]), ...runwaysAt(edge.from), ...runwaysAt(edge.to)]);
    if (runways.size > 0) areas.set(edge.id, [...runways].sort());
  }
  return areas;
}

/** The runways whose area the body is in, sorted. */
export function runwaysOccupied(areas: ReadonlyMap<EdgeId, RunwayId[]>, ac: Aircraft): RunwayId[] {
  const runways = new Set<RunwayId>();
  for (const { i } of bodySpans(ac)) {
    const id = ac.track.edges[i];
    for (const r of (id === undefined ? undefined : areas.get(id)) ?? []) runways.add(r);
  }
  return [...runways].sort();
}
