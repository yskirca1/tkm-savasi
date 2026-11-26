// Headless end-to-end check: plays full matches against a running server (dev mode).
// Usage: node scripts/e2e.mjs [baseUrl]   (default http://localhost:3001)
import { io } from 'socket.io-client';
const BASE = process.argv[2] || 'http://localhost:3001';
const tag = Math.random().toString(36).slice(2, 7);
const problems = [];
const fail = (m) => { problems.push(m); console.log('  !! ' + m); };

async function api(path, opts = {}, token) {
  const r = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
async function mkUser(i) {
  const username = `e2e_${tag}_${i}`;
  const r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email: `${username}@example.com`, password: 'sifre12345' }) });
  if (r.status !== 200) throw new Error('register failed ' + JSON.stringify(r));
  const me = await api('/api/me', {}, r.body.access_token);
  return { username, token: r.body.access_token, userId: me.body.userId };
}
function connect(u) {
  return new Promise((res, rej) => {
    const s = io(BASE, { auth: { token: u.token }, transports: ['websocket'] });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
  });
}
const emitAck = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));

async function playMatch(label, users, withBot) {
  const log = (m) => console.log(`[${label}] ${m}`);
  const socks = [];
  for (const u of users) socks.push(await connect(u));
  const st = { room: null, rounds: [], speedsSeen: new Set(), speedChanges: [], voteOpenedAt: null, voteRounds: 0, firstPickers: [], matchEnd: null, snapCount: 0, curRound: 0, lastSpeed: 1 };
  const done = new Promise((resolve) => {
    socks.forEach((s, i) => {
      const u = users[i];
      const mySeat = () => st.room?.seats.findIndex((x) => x.userId === u.userId);
      s.on('error:msg', (e) => log(`error:msg to ${u.username}: ${e.message}`));
      s.on('room:state', (r) => { if (i === 0) st.room = r; });
      s.on('pick:state', (p) => {
        if (i === 0 && p.turn === 0 && st.firstPickers[p.round - 1] === undefined) st.firstPickers[p.round - 1] = p.order[0];
        if (i === 0 && p.turn === 3) {
          const set = new Set(p.picks);
          if (set.size !== 3 || p.picks.includes(null)) fail(`${label} r${p.round}: bad picks ${p.picks}`);
        }
        if (p.currentSeat === mySeat() && !p.botThinking) {
          const free = ['rock', 'paper', 'scissors'].filter((x) => !p.locked.includes(x));
          // Occasionally try an illegal (locked) pick first: must be rejected.
          if (p.locked.length && Math.random() < 0.3) s.emit('pick:choose', { species: p.locked[0] });
          setTimeout(() => s.emit('pick:choose', { species: free[Math.floor(Math.random() * free.length)] }), 300);
        }
      });
      s.on('round:start', (r) => { if (i === 0) { st.curRound = r.round; st.lastSpeed = 1; st.approved = false; } });
      s.on('game:snapshot', (g) => {
        if (i === 0) {
          st.snapCount++;
          st.speedsSeen.add(g.speed);
          if (g.speed !== st.lastSpeed) { st.speedChanges.push({ round: st.curRound, to: g.speed, atSec: +(g.elapsedMs / 1000).toFixed(2) }); st.lastSpeed = g.speed; }
          if (g.vote.open && g.elapsedMs < 90000) fail(`${label}: vote open before 90s (${g.elapsedMs})`);
          if (!g.vote.open && g.vote.approvedSeats.length) fail(`${label}: approvals before open`);
          if (g.vote.open && st.voteOpenedAt === null) { st.voteOpenedAt = g.elapsedMs; log(`vote opened r${st.curRound} at ${g.elapsedMs}ms eligible=${g.vote.eligibleSeats}`); }
        }
        // First human approves immediately; others hold out for 3 s to prove one holdout blocks the end.
        if (g.vote.open && g.vote.eligibleSeats.includes(mySeat()) && !g.vote.approvedSeats.includes(mySeat())) {
          const wait = i === 0 ? 90000 : 93000;
          if (g.elapsedMs >= wait) s.emit('vote:set', { approve: true });
        }
      });
      s.on('round:end', (r) => { if (i === 0) { st.rounds.push(r); log(`round ${r.round} end: winner=${r.winnerSpecies} seat=${r.winnerSeat} byVote=${r.byVote} counts=${r.counts} scores=${r.scores}`); if (r.byVote) st.voteRounds++; } });
      s.on('match:end', (m) => { if (i === 0) { st.matchEnd = m; resolve(); } });
    });
  });
  const c = await emitAck(socks[0], 'room:create', {});
  if (!c.ok) throw new Error('create failed');
  log(`room ${c.code}`);
  for (let i = 1; i < socks.length; i++) { const j = await emitAck(socks[i], 'room:join', { code: c.code }); if (!j.ok) fail(`${label}: join failed ${j.error}`); }
  if (withBot) { await new Promise((r) => setTimeout(r, 300)); socks[1].emit('room:startWithBot'); await new Promise((r) => setTimeout(r, 300)); if (st.room.phase !== 'lobby') fail(`${label}: non-host could start`); socks[0].emit('room:startWithBot'); }
  await done;
  await new Promise((r) => setTimeout(r, 1500));
  // ---- checks ----
  const total = st.room.totalRounds;
  if (st.rounds.length !== total) fail(`${label}: ${st.rounds.length} rounds, expected ${total}`);
  for (let b = 0; b < total / 3; b++) {
    const firsts = st.firstPickers.slice(b * 3, b * 3 + 3);
    if (new Set(firsts).size !== 3) fail(`${label}: block ${b} first pickers ${firsts}`);
  }
  const expect = { 2: 30, 3: 45, 5: 60 };
  for (const ch of st.speedChanges) if (Math.abs(ch.atSec - expect[ch.to]) > 0.2) fail(`${label}: speed ${ch.to} at ${ch.atSec}s`);
  const sumScores = st.matchEnd.scores.reduce((a, b) => a + b, 0);
  const ties = st.rounds.filter((r) => r.winnerSeat === null).length;
  if (sumScores + ties !== total) fail(`${label}: scores ${st.matchEnd.scores} + ties ${ties} != ${total}`);
  for (let i = 0; i < users.length; i++) {
    const me = await api('/api/me', {}, users[i].token);
    const seat = st.room.seats.findIndex((x) => x.userId === users[i].userId);
    const s = me.body.stats;
    const won = st.matchEnd.winners.includes(seat) ? 1 : 0;
    if (s.gamesPlayed !== 1 || s.gamesWon !== won || s.roundsWon !== st.matchEnd.scores[seat]) fail(`${label}: stats for seat ${seat} = ${JSON.stringify(s)}, expected played 1 won ${won} rounds ${st.matchEnd.scores[seat]}`);
    else log(`stats ok seat ${seat}: ${JSON.stringify(s)}`);
  }
  log(`firstPickers=${st.firstPickers} speeds=${[...st.speedsSeen]} changes=${JSON.stringify(st.speedChanges)} voteRounds=${st.voteRounds} winners=${st.matchEnd.winners} scores=${st.matchEnd.scores} snaps=${st.snapCount}`);
  socks.forEach((s) => s.close());
}

const us = []; for (let i = 0; i < 5; i++) us.push(await mkUser(i));
const dup = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: us[0].username.toUpperCase(), email: 'x' + tag + '@example.com', password: 'sifre12345' }) });
if (dup.status !== 409) fail('duplicate username (case-insensitive) was accepted: ' + dup.status);
const t0 = Date.now();
await Promise.all([playMatch('3 insan', us.slice(0, 3), false), playMatch('2 insan + bot', us.slice(3, 5), true)]);
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Problems: ${problems.length}`);
problems.forEach((p) => console.log(' - ' + p));
process.exit(problems.length ? 1 : 0);
