import type { SimApi } from './api.js';
import { generateMap, isMapConnected } from './map.js';
import { speciesCounts, tickSim } from './physics.js';
import { createRng } from './rng.js';
import { createRound, drainConverted, packUnits } from './round.js';
import { evaluateVote, pickOrder, randomSeatPerm, rankSeats, speedAt, voteWinner } from './rules.js';

export type { SimApi, SimState, TickResult, Unit } from './api.js';

export const sim: SimApi = {
  createRng,
  generateMap,
  isMapConnected,
  createRound,
  speedAt,
  tickSim,
  speciesCounts,
  drainConverted,
  packUnits,
  pickOrder,
  randomSeatPerm,
  evaluateVote,
  voteWinner,
  rankSeats,
};
