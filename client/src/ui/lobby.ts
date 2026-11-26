import { ROUND_OPTIONS, type RoomState, type SeatInfo } from '@tkm/shared';
import { avatar, h } from '../dom';
import { icons } from '../icons';
import { send, type NetState } from '../net';
import { settingsButton } from '../settings';
import { toast } from '../toast';
import { btn } from './common';
import type { RoomCtx, SubView } from './room';
import { seatName } from './room';

async function copyText(text: string, fallbackInput: HTMLInputElement): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  fallbackInput.focus();
  fallbackInput.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

export function lobbyView(ctx: RoomCtx): SubView {
  const link = `${location.origin}/r/${ctx.code}`;
  const linkInput = h('input', { class: 'link-input', readOnly: true, value: link, 'aria-label': 'Invite link', onfocus: (e: Event) => (e.target as HTMLInputElement).select() });
  const copyBtn = btn('Copy', { icon: icons.copy, variant: 'secondary' });
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(link, linkInput);
    toast(ok ? 'Invite link copied!' : 'Couldn\'t copy — select the link and copy it manually.', ok ? 'success' : 'error');
  });
  const canShare = typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches;
  const shareBtn = canShare
    ? btn('Share', {
        icon: icons.share,
        variant: 'accent',
        onclick: () => {
          navigator.share({ title: 'RPS Battle', text: `Join my RPS Battle room! Code: ${ctx.code}`, url: link }).catch(() => {});
        },
      })
    : null;

  const codeTiles = h('div', { class: 'code-tiles', 'aria-label': `Room code ${ctx.code.split('').join(' ')}`, role: 'img' }, ...ctx.code.split('').map((c) => h('span', { class: 'code-tile', 'aria-hidden': 'true' }, c)));

  const seatsEl = h('ul', { class: 'seats', 'aria-label': 'Players' });
  const roundsEl = h('div', { class: 'rounds' });
  const actions = h('div', { class: 'lobby-actions' });

  const el = h(
    'div',
    { class: 'app-shell lobby' },
    h(
      'header',
      { class: 'topbar' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Leave room', title: 'Leave room', html: icons.back, onclick: () => ctx.leave() }),
      h('span', { class: 'topbar-title' }, 'Lobby'),
      h('div', { class: 'topbar-actions' }, settingsButton()),
    ),
    h(
      'main',
      { class: 'page lobby-main' },
      h('h1', { class: 'visually-hidden' }, `Lobby — room ${ctx.code}`),
      h(
        'section',
        { class: 'card invite' },
        h('p', { class: 'eyebrow' }, 'Room code'),
        codeTiles,
        h('div', { class: 'invite-row' }, linkInput, copyBtn, shareBtn),
        h('p', { class: 'hint' }, 'Send the link to your friends or tell them the code.'),
      ),
      seatsEl,
      h('section', { class: 'card lobby-settings' }, roundsEl, actions),
    ),
  );

  const seatCard = (s: SeatInfo, room: RoomState): HTMLElement => {
    if (s.kind === 'empty')
      return h('li', { class: 'seat seat-empty' }, h('span', { class: 'seat-avatar empty', 'aria-hidden': 'true', html: icons.plus }), h('span', { class: 'seat-name' }, 'Empty seat'), h('span', { class: 'seat-sub' }, 'Waiting for a player…'));
    const isBot = s.kind === 'bot';
    const isMe = s.userId === ctx.userId;
    return h(
      'li',
      { class: `seat${isMe ? ' seat-me' : ''}${isBot ? ' seat-bot' : ''}${!s.connected ? ' seat-off' : ''}` },
      isBot ? h('span', { class: 'seat-avatar bot', 'aria-hidden': 'true', html: icons.bot }) : avatar(s.username, s.avatarUrl, 56),
      h('span', { class: 'seat-name' }, h('span', { class: 'seat-name-text' }, seatName(s)), isMe ? h('span', { class: 'tag tag-me' }, 'You') : null),
      h(
        'span',
        { class: 'seat-sub' },
        s.isHost || s.userId === room.hostUserId ? h('span', { class: 'host-badge' }, h('span', { html: icons.crown }), 'Host') : isBot ? 'Computer' : s.connected ? 'Ready' : 'Disconnected',
      ),
    );
  };

  return {
    el,
    update(s: NetState) {
      const room = s.room!;
      const isHost = room.hostUserId === ctx.userId;
      seatsEl.replaceChildren(...room.seats.map((seat) => seatCard(seat, room)));

      // Round selector
      const name = 'rounds-' + ctx.code;
      const group = h(
        'fieldset',
        { class: 'segmented', disabled: !isHost },
        h('legend', null, 'Rounds'),
        ...ROUND_OPTIONS.map((n) => {
          const id = `${name}-${n}`;
          return h(
            'span',
            { class: 'seg' },
            h('input', {
              type: 'radio',
              name,
              id,
              value: String(n),
              checked: room.totalRounds === n,
              onchange: () => send.setRounds(n),
            }),
            h('label', { for: id }, String(n)),
          );
        }),
      );
      const focused = document.activeElement as HTMLInputElement | null;
      const refocus = focused && roundsEl.contains(focused) ? focused.value : null;
      roundsEl.replaceChildren(group);
      if (!isHost) roundsEl.appendChild(h('p', { class: 'hint' }, 'The host chooses the number of rounds.'));
      if (refocus) (roundsEl.querySelector(`input[value="${refocus}"]`) as HTMLInputElement | null)?.focus();

      const humans = room.seats.filter((x) => x.kind === 'human').length;
      actions.replaceChildren();
      if (isHost) {
        const start = btn('Start with computer', { icon: icons.bot, variant: 'primary', block: true, onclick: () => send.startWithBot() });
        start.disabled = humans !== 2;
        start.setAttribute('aria-describedby', 'bot-hint');
        actions.append(
          start,
          h('p', { class: 'hint', id: 'bot-hint' }, humans < 2 ? 'At least one more friend needs to join before you can start with the computer.' : 'The computer takes the 3rd seat and the game starts.'),
        );
      } else {
        actions.append(h('p', { class: 'waiting' }, h('span', { class: 'spinner sm', 'aria-hidden': 'true' }), 'Waiting for the game to start…'));
      }
      actions.append(h('p', { class: 'auto-hint' }, h('span', { html: icons.users }), 'The game starts automatically when 3 players have joined.'));
    },
    destroy() {},
  };
}
