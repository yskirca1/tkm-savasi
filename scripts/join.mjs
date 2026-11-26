// Dev helper: adds N auto-playing guests to a room. Usage: node scripts/join.mjs CODE [count=1] [baseUrl]
import { io } from 'socket.io-client';
const [code, count = '1', BASE = 'http://localhost:3001'] = process.argv.slice(2);
const tag = Math.random().toString(36).slice(2, 6);
for (let i = 0; i < +count; i++) {
  const username = `misafir_${tag}${i}`;
  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email: `${username}@example.com`, password: 'sifre12345' }) }).then((x) => x.json());
  const me = await fetch(BASE + '/api/me', { headers: { authorization: 'Bearer ' + r.access_token } }).then((x) => x.json());
  const s = io(BASE, { auth: { token: r.access_token }, transports: ['websocket'] });
  let room = null;
  s.on('room:state', (x) => (room = x));
  s.on('pick:state', (p) => {
    const seat = room?.seats.findIndex((x) => x.userId === me.userId);
    if (p.currentSeat === seat) { const free = ['rock', 'paper', 'scissors'].filter((x) => !p.locked.includes(x)); setTimeout(() => s.emit('pick:choose', { species: free[0] }), 1200); }
  });
  s.on('game:snapshot', (g) => { const seat = room?.seats.findIndex((x) => x.userId === me.userId); if (g.vote.open && g.vote.eligibleSeats.includes(seat) && !g.vote.approvedSeats.includes(seat) && g.elapsedMs > 95000) s.emit('vote:set', { approve: true }); });
  s.on('connect', () => s.emit('room:join', { code }, (a) => console.log(username, a)));
}
