import { BEATS, PICK_TIME_MS, SPECIES, SPECIES_EMOJI, SPECIES_LABEL, type Species } from '@tkm/shared';
import { avatar, h } from '../dom';
import { icons } from '../icons';
import { send, state, type NetState } from '../net';
import { settingsButton } from '../settings';
import type { RoomCtx, SubView } from './room';
import { mySeat, seatName } from './room';

const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

export function pickingView(ctx: RoomCtx): SubView {
  const roundLabel = h('span', { class: 'topbar-title' });
  const chips = h('ol', { class: 'order-chips', 'aria-label': 'Pick order for this round' });
  const turnText = h('h1', { class: 'turn-text' });
  const turnSub = h('p', { class: 'turn-sub', 'aria-live': 'polite' });
  const ringFg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  const ringNum = h('span', { class: 'ring-num' });
  const ring = h('div', { class: 'ring', role: 'timer', 'aria-label': 'Time left' }, ringNum);
  ring.insertAdjacentHTML(
    'afterbegin',
    `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${RING_R}" class="ring-bg"/></svg>`,
  );
  ringFg.setAttribute('cx', '32');
  ringFg.setAttribute('cy', '32');
  ringFg.setAttribute('r', String(RING_R));
  ringFg.setAttribute('class', 'ring-fg');
  ringFg.setAttribute('stroke-dasharray', String(RING_C));
  ring.querySelector('svg')!.appendChild(ringFg);

  const cards = new Map<Species, HTMLButtonElement>();
  const cardsEl = h('div', { class: 'species-cards', role: 'group', 'aria-label': 'Species' });
  for (const sp of SPECIES) {
    const b = h('button', { type: 'button', class: `species-card sp-${sp}`, onclick: () => send.pick(sp) });
    cards.set(sp, b);
    cardsEl.appendChild(b);
  }
  const scores = h('ul', { class: 'mini-scores', 'aria-label': 'Scores' });

  const el = h(
    'div',
    { class: 'app-shell picking' },
    h(
      'header',
      { class: 'topbar' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Leave match', title: 'Leave match', html: icons.back, onclick: () => ctx.leave() }),
      roundLabel,
      h('div', { class: 'topbar-actions' }, settingsButton()),
    ),
    h('main', { class: 'page picking-main' }, chips, h('section', { class: 'turn card' }, ring, h('div', { class: 'turn-texts' }, turnText, turnSub)), cardsEl, scores),
  );

  let raf = 0;
  let frozenMs: number | null = null;
  const tick = () => {
    const p = state.pick;
    let rem = 0;
    if (p && p.currentSeat !== null) {
      if (state.room?.paused) {
        frozenMs ??= Math.max(0, p.remainingMs - (performance.now() - state.pickAt));
        rem = frozenMs;
      } else {
        frozenMs = null;
        rem = Math.max(0, p.remainingMs - (performance.now() - state.pickAt));
      }
    }
    const frac = Math.min(1, rem / PICK_TIME_MS);
    ringFg.setAttribute('stroke-dashoffset', String(RING_C * (1 - frac)));
    const secs = String(Math.ceil(rem / 1000));
    if (ringNum.textContent !== secs) {
      ringNum.textContent = secs;
      ring.setAttribute('aria-label', `${secs} seconds left`);
    }
    ring.classList.toggle('urgent', rem > 0 && rem < 5000);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    el,
    update(s: NetState) {
      const room = s.room!;
      const p = s.pick && s.pick.round === room.round ? s.pick : null;
      roundLabel.textContent = `Round ${room.round}/${room.totalRounds}`;
      const me = mySeat(room, ctx.userId);
      const picks = p?.picks ?? room.picks;
      const current = p?.currentSeat ?? null;
      const myTurn = current !== null && current === me;

      // Order chips
      chips.replaceChildren(
        ...(p?.order ?? [0, 1, 2]).map((seatIdx, i) => {
          const seat = room.seats[seatIdx];
          const pick = picks[seatIdx];
          const isCur = seatIdx === current;
          return h(
            'li',
            { class: `chip${isCur ? ' chip-current' : ''}${pick ? ` chip-done sp-${pick}` : ''}`, 'aria-current': isCur ? 'step' : undefined },
            h('span', { class: 'chip-n' }, String(i + 1)),
            seat.kind === 'bot' ? h('span', { class: 'chip-ico', html: icons.bot }) : avatar(seat.username, seat.avatarUrl, 24),
            h('span', { class: 'chip-name' }, seatIdx === me ? 'You' : seatName(seat)),
            pick ? h('span', { class: 'chip-pick', 'aria-label': SPECIES_LABEL[pick] }, SPECIES_EMOJI[pick]) : null,
          );
        }),
      );

      // Turn banner
      el.classList.toggle('my-turn', myTurn);
      if (!p || current === null) {
        turnText.textContent = 'All picks are in!';
        turnSub.textContent = 'The battle is starting…';
      } else if (myTurn) {
        turnText.textContent = 'Your turn!';
        turnSub.textContent = 'Pick a species. If time runs out, one is picked at random.';
      } else if (p.botThinking || room.seats[current].kind === 'bot') {
        turnText.textContent = 'Computer is thinking…';
        turnSub.textContent = '';
      } else {
        turnText.textContent = `${seatName(room.seats[current])} is picking…`;
        turnSub.textContent = me !== null && picks[me] ? `Your pick: ${SPECIES_LABEL[picks[me]!]}` : 'Wait for your turn.';
      }

      // Species cards
      const locked = new Set<Species>(p?.locked ?? (picks.filter(Boolean) as Species[]));
      for (const sp of SPECIES) {
        const b = cards.get(sp)!;
        const ownerIdx = picks.findIndex((x) => x === sp);
        const owner = ownerIdx >= 0 ? room.seats[ownerIdx] : null;
        const isLocked = locked.has(sp);
        b.disabled = !myTurn || isLocked;
        b.classList.toggle('locked', isLocked);
        b.classList.toggle('mine', ownerIdx >= 0 && ownerIdx === me);
        b.setAttribute(
          'aria-label',
          `${SPECIES_LABEL[sp]}${isLocked ? `, ${owner ? (ownerIdx === me ? 'your pick' : `taken by ${seatName(owner)}`) : 'taken'}` : ''}`,
        );
        b.replaceChildren(
          h('span', { class: 'sc-emoji', 'aria-hidden': 'true' }, SPECIES_EMOJI[sp]),
          h('span', { class: 'sc-label' }, SPECIES_LABEL[sp]),
          h('span', { class: 'sc-beats' }, `Beats ${SPECIES_LABEL[BEATS[sp]]}`),
          ...(isLocked
            ? [
                h(
                  'span',
                  { class: 'sc-owner' },
                  h('span', { html: icons.check }),
                  owner ? (ownerIdx === me ? 'Yours' : seatName(owner)) : 'Taken',
                ),
              ]
            : []),
        );
      }

      scores.replaceChildren(
        ...room.seats.map((seat, i) =>
          h('li', null, h('span', { class: 'ms-name' }, i === me ? 'You' : seatName(seat)), h('span', { class: 'ms-score' }, h('span', { html: icons.star }), String(room.scores[i]))),
        ),
      );
    },
    destroy() {
      cancelAnimationFrame(raf);
    },
  };
}
