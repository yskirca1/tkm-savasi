import { PASSWORD_MIN } from '@tkm/shared';

/** All user-facing strings (English). */
export const MSG = {
  usernameInvalid: 'Username must be 3-20 characters and can contain letters, numbers, _ and .',
  usernameTaken: 'That username is taken',
  emailInvalid: 'Enter a valid email address',
  emailUnavailable: "Can't sign up with this email address",
  passwordShort: `Password must be at least ${PASSWORD_MIN} characters`,
  loginFailed: 'Incorrect username or password',
  unauthorized: 'Invalid session, please sign in again',
  refreshInvalid: 'Session expired, please sign in again',
  resetInvalid: 'The reset link is invalid or has expired',
  notSupported: "This action isn't supported in this mode",
  profileExists: 'Profile already created',
  profileMissing: 'Choose a username first',
  rateLimited: 'Too many attempts. Please try again later.',
  badRequest: 'Invalid request',
  server: 'Server error, please try again',
  notFound: 'Not found',
  // rooms
  roomNotFound: 'Room not found',
  roomFull: 'Room is full',
  gameStarted: 'The game has already started',
  hostOnly: 'Only the host can do that',
  needTwoForBot: 'The room needs exactly 2 players to start against the computer',
  notYourTurn: "It's not your turn",
  speciesTaken: 'That species is already taken',
  paused: 'The game is paused',
  notInRoom: "You're not in a room",
  invalidRounds: 'Invalid number of rounds',
  voteClosed: "Voting isn't open right now",
} as const;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
