// =====================================================================
// Simulation core API — pure, deterministic, no I/O, no timers, no Date.
// Implemented in server/src/sim/*.ts and re-exported from ./index.ts.
// The game server (server/src/game) depends ONLY on these signatures.
// =====================================================================
import type { MapData, Species, SeatIndex, SpeedMultiplier } from '@tkm/shared';

export interface Unit {
  x: number;
  y: number;
  vx: number; // world units per second at 1x; |v| === UNIT_SPEED always
  vy: number;
  species: Species;
}

export interface SimState {
  seed: number;
  map: MapData;
  units: Unit[]; // index = stable unit id for the round
  /** Number of completed ticks (each tick = TICK_MS of real time). */
  tick: number;
  /** Indices of units that converted since the last call to drainConverted(). */
  convertedSinceDrain: number[];
}

export interface TickResult {
  /** Species index counts [rock, paper, scissors] after the tick. */
  counts: [number, number, number];
  /** Non-null if only one species remains. */
  soleSurvivor: Species | null;
}

export interface SimApi {
  /** Seeded PRNG (e.g. mulberry32). Returns floats in [0,1). */
  createRng(seed: number): () => number;

  /**
   * Random map: implicit outer walls + random cell-aligned obstacles (blocks & wall segments)
   * on the GRID_CELL grid. MUST guarantee all free cells form one 4-connected region
   * (no sealed pockets) and leave enough free cells to place units. Deterministic per seed.
   */
  generateMap(seed: number): MapData;

  /** True if every free grid cell is reachable from every other (4-connectivity). */
  isMapConnected(map: MapData): boolean;

  /**
   * New round: generateMap(seed) then place unitsPerType of each species at random free
   * positions (not inside/touching obstacles or walls, no overlap with other units),
   * random direction, speed UNIT_SPEED. tick = 0.
   */
  createRound(seed: number, unitsPerType: number): SimState;

  /** Speed multiplier for a given elapsed round time (seconds), per SPEED_STEPS. */
  speedAt(elapsedSec: number): SpeedMultiplier;

  /**
   * Advance one tick of real time: runs `multiplier` sub-steps, each sub-step moving units
   * by velocity * (TICK_MS/1000) and resolving: wall/obstacle reflection (no tunnelling,
   * never ending inside an obstacle), unit-unit collisions (same species: elastic bounce;
   * different species: loser converts to winner's species per BEATS, then they separate/bounce).
   * Speed magnitude stays UNIT_SPEED. Increments state.tick by 1. Mutates state.
   */
  tickSim(state: SimState, multiplier: SpeedMultiplier): TickResult;

  speciesCounts(state: SimState): [number, number, number];

  /** Returns and clears convertedSinceDrain. */
  drainConverted(state: SimState): number[];

  /** Flat [x,y,s,...] with x,y rounded to 0.1 and s = SPECIES_INDEX. */
  packUnits(state: SimState): number[];

  // ---------- Pure match rules (also unit-tested) ----------

  /**
   * Pick order for a round. blockPerm is a random permutation of seats chosen at the start
   * of each 3-round block; roundInBlock is 0,1,2. Rotation: k -> [p[k], p[k+1], p[k+2]] (mod 3).
   * Across a block each seat picks first exactly once.
   */
  pickOrder(blockPerm: [SeatIndex, SeatIndex, SeatIndex], roundInBlock: number): [SeatIndex, SeatIndex, SeatIndex];

  /** Random permutation of [0,1,2] using the given rng. */
  randomSeatPerm(rng: () => number): [SeatIndex, SeatIndex, SeatIndex];

  /**
   * Vote evaluation. seatSpecies = species per seat this round; counts = species counts.
   * eligible = seats whose species count > 0. approved = approvals ∩ eligible.
   * allApproved = open && eligible.length > 0 && every eligible seat approved.
   */
  evaluateVote(args: {
    elapsedSec: number;
    seatSpecies: [Species, Species, Species];
    counts: [number, number, number];
    approvals: ReadonlySet<SeatIndex>;
  }): { open: boolean; eligibleSeats: SeatIndex[]; approvedSeats: SeatIndex[]; allApproved: boolean };

  /** Winner when a round is ended by vote: species with strictly most units, else null (tie). */
  voteWinner(counts: [number, number, number]): Species | null;

  /**
   * Final ranking from scores. Dense ranking where tied scores share a rank.
   * winners = seats with the max score.
   */
  rankSeats(scores: [number, number, number]): { rank: [number, number, number]; winners: SeatIndex[] };
}
