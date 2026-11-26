// =====================================================================
// @tkm/shared — the contract between server and client.
// Changing anything here is an architecture change: update both sides.
// =====================================================================

// ---------- Species & rules ----------
export type Species = 'rock' | 'paper' | 'scissors';
export const SPECIES: readonly Species[] = ['rock', 'paper', 'scissors'] as const;
/** Index used in compact snapshots: 0 rock, 1 paper, 2 scissors. */
export const SPECIES_INDEX: Record<Species, 0 | 1 | 2> = { rock: 0, paper: 1, scissors: 2 };
/** BEATS[a] = the species that a beats. rock>scissors, scissors>paper, paper>rock */
export const BEATS: Record<Species, Species> = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
export const SPECIES_EMOJI: Record<Species, string> = { rock: '🪨', paper: '📄', scissors: '✂️' };
export const SPECIES_LABEL: Record<Species, string> = { rock: 'Rock', paper: 'Paper', scissors: 'Scissors' };

// ---------- Match settings ----------
export const ROUND_OPTIONS = [3, 6, 9, 12] as const;
export type RoundOption = (typeof ROUND_OPTIONS)[number];
export const DEFAULT_ROUNDS: RoundOption = 9;
export const SEAT_COUNT = 3;
export type SeatIndex = 0 | 1 | 2;

// ---------- World / simulation ----------
/** Logical world size in world units. The client scales it to the screen keeping aspect ratio. */
export const WORLD_WIDTH = 900;
export const WORLD_HEIGHT = 600;
/** Map generation grid cell (world units). WORLD is 30 x 20 cells. Obstacles are cell-aligned. */
export const GRID_CELL = 30;
export const UNIT_RADIUS = 11;
/** Base speed in world units per second at 1x. */
export const UNIT_SPEED = 90;
export const DEFAULT_UNITS_PER_TYPE = 12;
export const MIN_UNITS_PER_TYPE = 4;
export const MAX_UNITS_PER_TYPE = 20;

/** Server simulation ticks per second. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
/** Snapshot is broadcast every N ticks (30/2 = 15 Hz). */
export const SNAPSHOT_EVERY_TICKS = 2;

/** Speed tiers by elapsed round seconds. At multiplier m the sim runs m sub-steps per tick. */
export type SpeedMultiplier = 1 | 2 | 3 | 5;
export const SPEED_STEPS: readonly { atSec: number; mult: SpeedMultiplier }[] = [
  { atSec: 0, mult: 1 },
  { atSec: 30, mult: 2 },
  { atSec: 45, mult: 3 },
  { atSec: 60, mult: 5 },
];
/** From this elapsed second, surviving players may vote to end the round. */
export const VOTE_OPEN_SEC = 90;

// ---------- Timings ----------
export const PICK_TIME_MS = 15_000;
export const BOT_THINK_MS = 1_000;
/** Round result screen duration before next pick phase. */
export const ROUND_END_DELAY_MS = 4_000;
/** Short countdown shown after picks before units start moving. */
export const ROUND_INTRO_MS = 1_500;
export const RECONNECT_GRACE_MS = 30_000;
/** Quick match: rounds per match, and wait for a 3rd player once 2 humans are in the lobby. */
export const QUICK_MATCH_ROUNDS: RoundOption = 6;
export const QUICK_MATCH_BOT_WAIT_MS = 20_000;
/** Solo practice vs computers: rounds per match. */
export const PRACTICE_ROUNDS: RoundOption = 3;

// ---------- Account rules ----------
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
/** Letters (incl. Turkish), digits, underscore, dot. Case-insensitive uniqueness. */
export const USERNAME_RE = /^[A-Za-z0-9_.çğıöşüÇĞİÖŞÜ]{3,20}$/;
export const PASSWORD_MIN = 8;

// ---------- Shapes ----------
export interface Rect { x: number; y: number; w: number; h: number }
/** Outer walls are implicit: the world boundary [0,WORLD_WIDTH]x[0,WORLD_HEIGHT]. */
export interface MapData { width: number; height: number; obstacles: Rect[] }

export type SeatKind = 'empty' | 'human' | 'bot';
export interface SeatInfo {
  index: SeatIndex;
  kind: SeatKind;
  userId: string | null;      // null for empty/bot
  username: string | null;    // bot: BOT_NAME
  avatarUrl: string | null;
  connected: boolean;         // humans only; bots always true
  isHost: boolean;
  /** True if a bot took over this seat after the human left / timed out. */
  replacedHuman: boolean;
}

export type RoomPhase = 'lobby' | 'picking' | 'intro' | 'playing' | 'roundEnd' | 'matchEnd';

export interface RoomState {
  code: string;               // 5 chars, A-Z (no ambiguous letters)
  phase: RoomPhase;
  hostUserId: string;
  totalRounds: RoundOption;
  unitsPerType: number;
  /** 1-based current round; 0 while in lobby. */
  round: number;
  seats: [SeatInfo, SeatInfo, SeatInfo];
  /** Round wins per seat. */
  scores: [number, number, number];
  /** Species of each seat in the current round (null until picked). */
  picks: [Species | null, Species | null, Species | null];
  /**
   * Non-null for matchmaking ("Quick match") rooms. Such rooms are open to any player using quick match
   * while in lobby. autoStartInMs: ms (at send time) until the room auto-starts with a computer in the
   * third seat; non-null only while the lobby holds exactly 2 humans. Client counts down locally.
   */
  quick: { autoStartInMs: number | null } | null;
  /** True for solo practice rooms (1 human vs 2 computers). Practice matches never write stats. */
  practice: boolean;
  /** Non-null while paused waiting for disconnected humans. */
  paused: { waitingFor: string[]; resumeDeadline: number } | null;
}

export interface PickState {
  round: number;
  /** Seat order for this round (rotation inside a 3-round block). */
  order: [SeatIndex, SeatIndex, SeatIndex];
  /** Index into order of the seat whose turn it is; 3 when all picked. */
  turn: number;
  currentSeat: SeatIndex | null;
  /** ms remaining for the current pick at the moment of sending (client counts down locally). */
  remainingMs: number;
  botThinking: boolean;
  picks: [Species | null, Species | null, Species | null];
  /** Species already taken (locked) this round. */
  locked: Species[];
}

export interface RoundStart {
  round: number;
  seed: number;
  map: MapData;
  /** Species per seat for this round. */
  seatSpecies: [Species, Species, Species];
  unitCount: number;
  /** ms until units start moving (intro countdown). */
  introMs: number;
}

export interface VoteInfo {
  /** True once elapsed >= VOTE_OPEN_SEC. */
  open: boolean;
  /** Seats whose species is still on the map (alive). Only these may vote. */
  eligibleSeats: SeatIndex[];
  approvedSeats: SeatIndex[];
}

/**
 * Compact state broadcast at ~15 Hz.
 * units: flat array [x0, y0, s0, x1, y1, s1, ...]; x,y rounded to 0.1; s = SPECIES_INDEX.
 * Unit identity = position in the array (stable for the whole round).
 */
export interface GameSnapshot {
  tick: number;
  elapsedMs: number;
  speed: SpeedMultiplier;
  units: number[];
  /** Alive count per species index [rock, paper, scissors]. */
  counts: [number, number, number];
  /** Unit indices that converted since previous snapshot (for the client conversion animation). */
  converted: number[];
  vote: VoteInfo;
  paused: boolean;
}

export interface RoundEnd {
  round: number;
  winnerSpecies: Species | null;
  winnerSeat: SeatIndex | null;
  byVote: boolean;
  counts: [number, number, number];
  scores: [number, number, number];
  /** ms until the next phase begins. */
  nextInMs: number;
}

export interface Standing {
  seat: SeatIndex;
  username: string;
  kind: SeatKind;
  roundsWon: number;
  /** 1 = first. Ties share the rank. */
  rank: number;
}
export interface MatchEnd {
  standings: Standing[];
  /** Seats sharing first place. */
  winners: SeatIndex[];
  scores: [number, number, number];
}

// ---------- Socket.IO events ----------
export type Ack<T = {}> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  'room:create': (p: { totalRounds?: RoundOption }, ack: Ack<{ code: string }>) => void;
  'room:join': (p: { code: string }, ack: Ack<{ code: string }>) => void;
  /** Solo practice vs two computers: creates a private practice room and starts immediately. No stats. */
  'room:practice': (p: {}, ack: Ack<{ code: string }>) => void;
  /** Matchmaking: join an open quick-match lobby or create one. Client then navigates to /r/<code>. */
  'room:quick': (p: {}, ack: Ack<{ code: string }>) => void;
  'room:leave': () => void;
  'room:setRounds': (p: { totalRounds: RoundOption }) => void;
  'room:startWithBot': () => void;
  'pick:choose': (p: { species: Species }) => void;
  'vote:set': (p: { approve: boolean }) => void;
  'match:rematch': () => void;
}

export interface ServerToClientEvents {
  'room:state': (s: RoomState) => void;
  'pick:state': (s: PickState) => void;
  'round:start': (s: RoundStart) => void;
  'game:snapshot': (s: GameSnapshot) => void;
  'round:end': (s: RoundEnd) => void;
  'match:end': (s: MatchEnd) => void;
  'error:msg': (p: { message: string }) => void;
}

/** socket.io handshake: io(url, { auth: { token } }) */
export interface SocketAuth { token: string }

// ---------- REST API (all JSON, prefix /api) ----------
// GET  /api/config                        -> PublicConfig
// GET  /api/username-available?u=name     -> { available: boolean; reason?: string }
// POST /api/auth/register  {username,email,password}  -> AuthSession          (rate limited)
// POST /api/auth/login     {identifier,password}      -> AuthSession          (rate limited; identifier = username or email)
// POST /api/auth/forgot    {identifier}               -> { ok: true }         (rate limited; always ok)
// POST /api/auth/reset     {token,password}           -> { ok: true }         (dev mode only; supabase mode uses supabase-js updateUser)
// POST /api/auth/refresh   {refresh_token}            -> AuthSession          (dev mode only)
// GET  /api/me             (Bearer)                   -> MeResponse
// POST /api/profile        (Bearer) {username}        -> MeResponse           (create profile on first login, e.g. Google)
// PATCH /api/profile       (Bearer) {username}        -> MeResponse           (rename)
// Errors: HTTP 4xx/5xx with { error: string } (English, user-facing).

export interface PublicConfig {
  mode: 'supabase' | 'dev';
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  googleEnabled: boolean;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  /** epoch seconds */
  expires_at: number;
}

export interface ProfileStats { gamesPlayed: number; gamesWon: number; roundsWon: number }

export interface MeResponse {
  userId: string;
  /** null if the user has no profile yet (first Google login) — client must show username picker. */
  profile: { username: string; avatarUrl: string | null } | null;
  /** Present when profile is null: a free username derived from the provider name. */
  suggestedUsername?: string;
  stats: ProfileStats;
}

export const BOT_NAME = 'Computer';
