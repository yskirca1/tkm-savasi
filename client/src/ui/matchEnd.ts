import type { MatchEnd, RoomState, SeatIndex, Standing } from '@tkm/shared';
import { avatar, h } from '../dom';
import { icons } from '../icons';
import { send, type NetState } from '../net';
import { settingsButton } from '../settings';
import { btn } from './common';
import type { RoomCtx, SubView } from './room';
import { mySeat, seatName } from './room';

/** Fallback when match:end was missed (e.g. reconnect): rank by room scores. */
function fromRoom(room: RoomState): MatchEnd {
  const seats = room.seats.filter((s) => s.kind !== 'empty');
  const sorted = [...seats].sort((a, b) => room.scores[b.index] - room.scores[a.index]);
  const standings: Standing[] = sorted.map((s) => ({
    seat: s.index,
    username: seatName(s),
    kind: s.kind,
    roundsWon: room.scores[s.index],
    rank: 1 + sorted.filter((o) => room.scores[o.index] > room.scores[s.index]).length,
  }));
  return { standings, winners: standings.filter((s) => s.rank === 1).map((s) => s.seat as SeatIndex), scores: room.scores };
}

export function matchEndView(ctx: RoomCtx): SubView {
  const main = h('main', { class: 'page matchend-main' });
  const el = h(
    'div',
    { class: 'app-shell matchend' },
    h('header', { class: 'topbar' }, h('span', { class: 'topbar-title' }, 'Match over'), h('div', { class: 'topbar-actions' }, settingsButton())),
    main,
  );
  let key = '';
  return {
    el,
    update(s: NetState) {
      const room = s.room!;
      const me = mySeat(room, ctx.userId);
      const m = s.matchEnd ?? fromRoom(room);
      const k = JSON.stringify([m.standings, room.seats.map((x) => [x.kind, x.username, x.connected])]);
      if (k === key) return;
      key = k;
      const iWon = me !== null && m.winners.includes(me);
      const title = iWon ? (m.winners.length > 1 ? 'You shared the win!' : 'Congratulations, you won!') : m.winners.length > 1 ? 'It\'s a tie!' : `${m.standings.find((x) => x.rank === 1)?.username ?? ''} wins!`;

      const byRank = [...m.standings].sort((a, b) => a.rank - b.rank || a.seat - b.seat);
      // Podium order: 2nd, 1st, 3rd (visual); DOM order stays by rank for screen readers via aria.
      const podiumOrder = byRank.slice(0, 3);
      const podium = h(
        'ol',
        { class: 'podium', 'aria-label': 'Standings' },
        ...podiumOrder.map((st) => {
          const seat = room.seats[st.seat];
          const isWinner = m.winners.includes(st.seat);
          return h(
            'li',
            { class: `podium-col rank-${Math.min(st.rank, 3)}${st.seat === me ? ' is-me' : ''}`, style: `order:${[2, 1, 3].indexOf(byRank.indexOf(st) + 1)}`, 'aria-label': `${st.rank}. ${st.username}, ${st.roundsWon} ${st.roundsWon === 1 ? 'round' : 'rounds'}` },
            h(
              'div',
              { class: 'podium-player' },
              isWinner ? h('span', { class: 'podium-crown', html: icons.crown }) : null,
              st.kind === 'bot' ? h('span', { class: 'seat-avatar bot', html: icons.bot }) : avatar(st.username, seat?.avatarUrl ?? null, 56),
              h('span', { class: 'podium-name' }, st.seat === me ? `${st.username} (you)` : st.username),
            ),
            h('div', { class: 'podium-block' }, h('span', { class: 'podium-rank' }, `${st.rank}.`), h('span', { class: 'podium-score' }, h('span', { html: icons.star }), `${st.roundsWon} ${st.roundsWon === 1 ? 'round' : 'rounds'}`)),
          );
        }),
      );

      const canRematch = me !== null;
      const rematch = btn('Play again', { icon: icons.refresh, variant: 'primary btn-lg', onclick: () => send.rematch() });
      const home = btn('Home', { icon: icons.home, variant: 'ghost', onclick: () => ctx.leave() });
      main.replaceChildren(
        h('section', { class: 'matchend-head' }, h('span', { class: 'trophy', html: icons.trophy }), h('h1', null, title), h('p', { class: 'muted' }, `The ${room.totalRounds}-round match is over.`)),
        podium,
        h(
          'section',
          { class: 'matchend-actions' },
          canRematch ? rematch : null,
          home,
          h('p', { class: 'hint center-text' }, 'Play again: the room returns to the lobby so you can start a new match with the same friends.'),
        ),
      );
    },
    destroy() {},
  };
}
