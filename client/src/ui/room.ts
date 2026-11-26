// /r/:code — container that switches sub-views purely by room:state.phase.
import type { RoomPhase, RoomState, SeatIndex, SeatInfo } from '@tkm/shared';
import { BOT_NAME } from '@tkm/shared';
import { loadMe } from '../auth';
import { h } from '../dom';
import { connect, netEvents, send, state, type NetState } from '../net';
import { navigate, type View } from '../router';
import { toast } from '../toast';
import { gameView } from './game';
import { lobbyView } from './lobby';
import { matchEndView } from './matchEnd';
import { pickingView } from './picking';

export interface RoomCtx {
  code: string;
  userId: string;
  /** Leave the room and go home (with confirmation during a match). */
  leave: () => void;
}

export interface SubView {
  el: HTMLElement;
  update(s: NetState): void;
  destroy(): void;
}

type Group = 'lobby' | 'picking' | 'game' | 'matchEnd';
function groupOf(p: RoomPhase): Group {
  if (p === 'intro' || p === 'playing' || p === 'roundEnd') return 'game';
  return p;
}

export function mySeat(room: RoomState, userId: string): SeatIndex | null {
  const s = room.seats.find((x) => x.kind === 'human' && x.userId === userId);
  return s ? s.index : null;
}

export function seatName(seat: SeatInfo | undefined): string {
  if (!seat) return '—';
  if (seat.kind === 'bot') return seat.username || BOT_NAME;
  return seat.username ?? 'Empty';
}

export const roomView: View = async (root, params) => {
  const code = params.code.toUpperCase();
  if (!/^[A-Z]{5}$/.test(code)) {
    toast('Invalid room code.', 'error');
    navigate('/', true);
    return;
  }
  const me = await loadMe();
  connect();

  let left = false;
  const ctx: RoomCtx = {
    code,
    userId: me.userId,
    leave: () => {
      const r = state.room;
      const inMatch = r && r.phase !== 'lobby' && r.phase !== 'matchEnd';
      const question = r?.practice
        ? 'Leave this practice match? It will end.'
        : 'If you leave the match, the computer will play in your place. Do you want to leave?';
      if (inMatch && !confirm(question)) return;
      left = true;
      send.leaveRoom();
      navigate('/');
    },
  };

  const shell = h('div', { class: 'room-shell' });
  const loading = h('main', { class: 'page center' }, h('div', { class: 'loader', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('h1', { class: 'loader-text' }, 'Connecting to room…')));
  const pauseLayer = h('div', { class: 'pause-overlay', hidden: true, role: 'alertdialog', 'aria-modal': 'false', 'aria-live': 'assertive' });
  shell.append(loading, pauseLayer);
  root.appendChild(shell);

  let current: { group: Group; view: SubView } | null = null;

  const render = (s: NetState) => {
    const room = s.room;
    if (!room || room.code !== code) return;
    loading.remove();
    const g = groupOf(room.phase);
    if (!current || current.group !== g) {
      current?.view.destroy();
      current?.view.el.remove();
      const view =
        g === 'lobby' ? lobbyView(ctx) : g === 'picking' ? pickingView(ctx) : g === 'game' ? gameView(ctx) : matchEndView(ctx);
      current = { group: g, view };
      shell.insertBefore(view.el, pauseLayer);
    }
    current.view.update(s);
    renderPause(room);
  };

  // ---- pause overlay (disconnected players) ----
  let pauseTimer: ReturnType<typeof setInterval> | undefined;
  const renderPause = (room: RoomState) => {
    const p = room.paused;
    if (!p) {
      pauseLayer.hidden = true;
      if (pauseTimer) clearInterval(pauseTimer);
      pauseTimer = undefined;
      return;
    }
    const names = p.waitingFor.join(', ');
    const draw = () => {
      const secs = Math.max(0, Math.ceil((p.resumeDeadline - Date.now()) / 1000));
      pauseLayer.replaceChildren(
        h(
          'div',
          { class: 'card pause-card' },
          h('span', { class: 'spinner', 'aria-hidden': 'true' }),
          h('h2', null, `Waiting for ${names} to reconnect`),
          h('p', { class: 'pause-count' }, h('strong', null, String(secs)), ' s'),
          h('p', { class: 'muted' }, 'If time runs out, the computer will play in their place.'),
        ),
      );
    };
    draw();
    pauseLayer.hidden = false;
    if (pauseTimer) clearInterval(pauseTimer);
    pauseTimer = setInterval(draw, 500);
  };

  const join = async () => {
    const res = await send.joinRoom(code);
    if (!res.ok) {
      toast(res.error, 'error');
      left = true;
      navigate('/', true);
    }
  };

  const offs = [
    netEvents.on('change', render),
    netEvents.on('reconnected', () => void join()),
  ];
  if (state.room?.code === code) render(state);
  else void join();

  return () => {
    offs.forEach((f) => f());
    if (pauseTimer) clearInterval(pauseTimer);
    current?.view.destroy();
    if (!left && state.room?.code === code) send.leaveRoom();
  };
};
