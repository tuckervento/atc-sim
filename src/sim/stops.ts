// Where an aircraft must stop on its track (PRD §7, §4.5; docs/terse-syntax.md, "How the sim
// applies commands"):
// - At every `runway` hold line its path passes, unless it holds a crossing clearance for
//   every runway the line protects. One clearance covers one crossing: the next one on the
//   route for that runway (at its `at` taxiway, if it names one). It's used up there.
// - At each of its clearance's taxiway hold-shorts, until `continue` releases it or a new
//   clearance replaces it. A clearance hold-short of a runway needs nothing extra: it's at a
//   runway hold line the path passes, or at the path's end (the departure runway's own hold).
// - At the end of its track: its destination, or with no clearance, the node it's on or
//   heading for.
// ILS, LAHSO and intermediate hold lines never stop it by themselves (the command format has
// no "hold short of the ILS critical area"); only a clearance hold-short that resolves to one
// does.
//
// The nose stops exactly on the hold node, with no margin: route.ts's "stop at nodes[index],
// before entering edges[index]". Entering the edge toward the runway is entering the runway.

import type { AirportIndex } from '../airport/graph.ts';
import type { HoldShortId, RunwayId } from '../airport/types.ts';
import type { HoldShortTarget } from './commands.ts';
import type { Track } from './track.ts';
import type { Aircraft, CrossingClearance } from './world.ts';

export type Stop =
  | { kind: 'end'; at: number }
  | { kind: 'runway-hold'; at: number; trackIndex: number; holdShort: HoldShortId; runways: RunwayId[] }
  | {
      kind: 'clearance-hold';
      at: number;
      trackIndex: number;
      /** The point's path index, as `Clearance.released` records it. */
      pathIndex: number;
      /** The hold line at the point, if the airport has one there. */
      holdShort: HoldShortId | null;
      target: HoldShortTarget;
    };

/** The nearest point at or ahead of the nose where the aircraft must stop. */
export function nextStop(index: AirportIndex, ac: Aircraft): Stop {
  return stopsAhead(index, ac)[0] ?? { kind: 'end', at: ac.track.lengthM };
}

/**
 * Every stop from the nearest one up to, at most, the next point beyond it, nearest first: all
 * the stops at the nearest point (a runway hold line before a clearance hold-short there).
 */
export function stopsAhead(index: AirportIndex, ac: Aircraft): Stop[] {
  const end: Stop = { kind: 'end', at: ac.track.lengthM };
  const clearance = ac.clearance;
  if (!clearance) return [end];
  const { path, pathOffset } = clearance;
  // In path order; at the same node, a runway hold line comes first.
  const points: { pathIndex: number; make: (at: number, trackIndex: number) => Stop | null }[] = [];
  // Crossing clearances are used up in path order, so plan on a copy.
  const crossings = copyCrossings(ac.crossings);
  for (const hold of path.holdShorts) {
    if (hold.kind !== 'runway') continue;
    points.push({
      pathIndex: hold.index,
      make: (at, trackIndex) =>
        useCrossing(crossings, hold.runways, crossingTaxiway(index, ac.track, trackIndex))
          ? null
          : { kind: 'runway-hold', at, trackIndex, holdShort: hold.id, runways: hold.runways },
    });
  }
  for (const { target, at: holdPoints } of path.clearanceHolds) {
    if (target.kind !== 'taxiway') continue;
    for (const point of holdPoints) {
      if (clearance.released.includes(point.index)) continue;
      points.push({
        pathIndex: point.index,
        make: (at, trackIndex) => ({ kind: 'clearance-hold', at, trackIndex, pathIndex: point.index, holdShort: point.holdShort, target }),
      });
    }
  }
  points.sort((a, b) => a.pathIndex - b.pathIndex);
  const stops: Stop[] = [];
  for (const { pathIndex, make } of points) {
    const trackIndex = pathIndex + pathOffset;
    const at = nodeAt(ac.track, trackIndex);
    if (at < ac.s) continue;
    const first = stops[0];
    if (first && at > first.at) break;
    const stop = make(at, trackIndex);
    if (stop) stops.push(stop);
  }
  const first = stops[0];
  if (!first || end.at <= first.at) stops.push(end);
  return stops;
}

/**
 * Uses the crossing clearances for `runways` at a hold line on `taxiway`: for each runway, the
 * first clearance that names it and either names no taxiway or this one. All or nothing:
 * returns false, changing nothing, unless every runway is covered.
 */
export function useCrossing(crossings: CrossingClearance[], runways: RunwayId[], taxiway: string | null): boolean {
  const covering = runways.map((r) => crossings.find((c) => c.runways.includes(r) && (c.at === null || c.at === taxiway)));
  if (covering.some((c) => c === undefined)) return false;
  runways.forEach((r, i) => {
    const c = covering[i];
    if (c) c.runways = c.runways.filter((x) => x !== r);
  });
  const left = crossings.filter((c) => c.runways.length > 0);
  crossings.splice(0, crossings.length, ...left);
  return true;
}

/** The taxiway a hold line at track node `i` is on: the edge toward the runway, else the one before. */
export function crossingTaxiway(index: AirportIndex, track: Track, i: number): string | null {
  for (const id of [track.edges[i], track.edges[i - 1]]) {
    const name = id === undefined ? undefined : index.edges.get(id)?.name;
    if (name !== undefined) return name;
  }
  return null;
}

export function copyCrossings(crossings: CrossingClearance[]): CrossingClearance[] {
  return crossings.map((c) => ({ ...c, runways: [...c.runways] }));
}

export function nodeAt(track: Track, i: number): number {
  const at = track.nodeAt[i];
  if (at === undefined) throw new Error(`track node ${i} is out of range`);
  return at;
}
