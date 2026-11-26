# TKM Savaşı — Architecture & module contracts

Real-time 2–3 player Rock-Paper-Scissors "battle" web game. UI language: **English**.

## Layout (npm workspaces)
```
shared/src/index.ts        Contract: types, constants, socket events, REST shapes. (OWNED BY MAIN LOOP — do not edit)
server/src/sim/api.ts      Simulation API contract (OWNED BY MAIN LOOP — do not edit)
server/src/sim/*           Pure simulation + rules implementation + vitest tests      [module: SIM]
server/src/**  (not sim)   Express REST, auth, DB, Socket.IO rooms & game loop       [module: SERVER]
client/**                  Vite + vanilla TS + Canvas UI                              [module: CLIENT]
supabase/migrations/001_init.sql   DB schema (profiles, matches, match_results, view profile_stats, RLS)
```
Imports: `import { ... } from '@tkm/shared'` works in server and client (TS source, workspace package).
Server imports sim via `import { sim } from './sim/index.js'` where `sim: SimApi` (see api.ts). Server code runs with `tsx` (dev and prod) — no build step for server.

## Two runtime modes
- **supabase mode**: when `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are set.
- **dev mode**: otherwise. Users/profiles/results kept in memory and persisted to `server/.dev-data/db.json`; server signs its own JWT (HS256, `DEV_JWT_SECRET` or a constant). Lets `npm run dev` work with zero accounts, and enables local multi-tab testing. Google button disabled in dev mode (`googleEnabled:false`). "Forgot password" in dev mode logs the reset link to the server console: `${APP_URL}/reset#dev_token=<token>`.

Server code defines two interfaces with both implementations, chosen at startup:
- `AuthProvider`: register(username,email,password)→AuthSession, login(identifier,password)→AuthSession, forgot(identifier), devReset(token,pw), devRefresh(rt), verifyToken(jwt)→{userId, email?, name?, avatarUrl?} | null.
- `Store`: getProfile(id), getProfileByUsername(name, ci), isUsernameTaken(name, exceptId?), createProfile(id,username,avatar), renameProfile(id,username), getStats(id)→ProfileStats, saveMatch({roomCode,totalRounds,startedAt, results:[{userId,roundsWon,isWinner,finishedInSeat}]}), getEmailForUser(id) (server-only).

### Supabase-mode specifics
- register: check username free (case-insensitive) → `admin.createUser({email,password,email_confirm:true})` → insert profile (service role) → if insert fails (race) delete the auth user and return 409 → sign in with password (anon client) → return session.
- login: identifier contains '@' → email; else look up profile by username (ci) → `admin.getUserById` → email. Then `signInWithPassword` on a fresh anon client (persistSession:false). Never return the email. Wrong user or password → same generic 401 message.
- forgot: resolve email the same way; `resetPasswordForEmail(email, { redirectTo: APP_URL + '/reset' })` using an anon client with `flowType: 'implicit'`. Always respond `{ok:true}`.
- verifyToken: `admin.auth.getUser(jwt)` (cache results ~60 s by token). Google users: name from `user_metadata.full_name|name`, avatar from `user_metadata.avatar_url|picture`.
- stats: query `profile_stats` view (service role).
- Rate limits (express-rate-limit): register/login/forgot: 10 requests / 15 min / IP each; username-available: 60/min.
- Validation: USERNAME_RE, PASSWORD_MIN from shared; basic email regex. All user-facing error strings in English.

### Username suggestion (first Google login)
From provider name: lowercase, Turkish chars → ascii (ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u), strip invalid chars, trim to 16, min 3 (pad with "oyuncu"); if taken append 2–4 random digits until free.

## Room & match rules (server, authoritative)
- Rooms in memory: `Map<code, Room>`; `Map<userId, code>` (a user is in at most one room; joining another leaves the old one). Codes: 5 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ`.
- Lobby: 3 seats. Creator = host, seat 0. Joiners take the first empty seat. Host may change totalRounds (ROUND_OPTIONS) in lobby only. When 3 humans are seated → auto-start. With exactly 2 humans, host may `room:startWithBot` → seat bot in the empty seat and start. If host leaves in lobby, host passes to next human; empty room is deleted.
- Joining a room whose match is in progress is only allowed for a user who already holds a seat (reconnect). Otherwise error "Oyun başladı".
- Match: for round r (1-based), block = floor((r-1)/3), roundInBlock = (r-1)%3. At each block start choose `blockPerm = sim.randomSeatPerm(rng)`. order = `sim.pickOrder(blockPerm, roundInBlock)`.
- Picking phase: seat order[turn] picks from untaken species. 15 s per pick (PICK_TIME_MS) — on timeout assign random untaken species. Bot: `botThinking=true` for BOT_THINK_MS, then random untaken species. Broadcast `pick:state` on every change. A pick from the wrong seat / taken species is ignored with `error:msg`.
- After 3 picks: seed = random 32-bit int (log it with room code + round: `[room ABCDE] round 4 seed 123456`), `state = sim.createRound(seed, unitsPerType)`, phase `intro`, broadcast `round:start` (introMs=ROUND_INTRO_MS), then phase `playing`.
- Game loop: setInterval TICK_MS per room while playing. elapsedMs += TICK_MS per tick (paused ticks do not count). mult = sim.speedAt(elapsedMs/1000); `sim.tickSim(state, mult)`. Every SNAPSHOT_EVERY_TICKS ticks broadcast `game:snapshot` (units = packUnits, converted = drainConverted, vote = evaluateVote(...)). Bots that are alive are always in approvals. If soleSurvivor → round ends, winner = seat with that species. If vote allApproved → round ends byVote with `sim.voteWinner(counts)` (null = tie → no point, round still counts).
- `vote:set {approve}`: accepted only if seat's species is alive and vote is open; otherwise ignored. Re-evaluated every tick, so seats that get eliminated drop out of eligible automatically; approvals of eliminated seats are discarded.
- Round end: scores[winnerSeat]++, broadcast `round:end` (nextInMs=ROUND_END_DELAY_MS) then next pick phase, or match end after totalRounds.
- Match end: `sim.rankSeats(scores)`. A human seat gets is_winner if it is among winners (ties share the win). Bot winning alone → no human win. A seat occupied by a bot that replaced a human wins nothing for anyone. Results saved for every human who held a seat at match start (including those replaced by bots: finishedInSeat=false, roundsWon = rounds won while they held the seat, is_winner=false). Broadcast `match:end` + `room:state` phase matchEnd. Save via Store.saveMatch (errors logged, not fatal).
- `match:rematch` (any seated human, phase matchEnd): room returns to lobby: bots removed, disconnected humans removed, scores/picks reset, host stays if present. Auto-start rule applies again.
- Disconnect during a match (phase != lobby/matchEnd): mark seat `connected=false`; room `paused = {waitingFor:[usernames], resumeDeadline}`; freeze sim ticking AND pick timers (remember remaining ms). On reconnect within RECONNECT_GRACE_MS (same userId connects and emits room:join, or simply connects — server auto re-attaches the socket to its room and sends room:state + latest pick:state/round:start + snapshot): restore and resume when nobody is waited for. On timeout: seat becomes bot (`kind:'bot'`, `replacedHuman:true`, username `Bilgisayar`), resume. Disconnect in lobby: remove from seat immediately (after 5 s grace for page reloads). If all humans gone → delete room.
- `room:leave` during a match = immediate bot replacement (no grace).
- Username changes: Room seats show username fetched at join time; on PATCH /api/profile, server updates the username in any room seat of that user and rebroadcasts room:state.

## Client screens (routes, history API)
`/login`, `/register`, `/forgot`, `/reset`, `/` (home), `/profile`, `/r/:code` (lobby → picking → game → round end → match end, all driven by room phase), `/welcome` (pick username on first login).
Client auth module abstracts the modes: supabase mode uses supabase-js (`flowType:'implicit'`, `detectSessionInUrl:true`) for Google OAuth (`signInWithOAuth({provider:'google', options:{redirectTo: origin}})`), session storage/refresh (`setSession` with tokens returned by our REST login/register), and password recovery (`PASSWORD_RECOVERY` event → `updateUser({password})`). Dev mode stores AuthSession in localStorage and uses /api/auth/refresh, /api/auth/reset.
Socket: `io({ auth: { token } })` same origin (Vite proxies in dev). Reconnect with fresh token.
