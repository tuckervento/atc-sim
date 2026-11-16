// The hard braking limit, on its own so movement.ts and traffic.ts (which movement.ts imports)
// can both read it without an import cycle.
//
// Value [Builder] (PRD §8.2): 1.5, about 0.15 g: firm, but not an emergency stop. 20 kt to a
// stop in about 35 m. movement.ts uses it for hold position and traffic that appears suddenly;
// traffic.ts for whether a pilot can still stop short of a junction.

export const MAX_DECEL_MPS2 = 1.5;
