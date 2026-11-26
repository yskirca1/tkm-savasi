import { QUICK_MATCH_ROUNDS, SPECIES_EMOJI } from '@tkm/shared';
import { loadMe } from '../auth';
import { h } from '../dom';
import { icons } from '../icons';
import { netEvents, send, state } from '../net';
import { navigate, type View } from '../router';
import { toast } from '../toast';
import { btn, busy, nextId, topbar } from './common';

const CODE_CHARS = /[^A-Z]/g;

/** Accepts a raw code or a pasted invite link. */
function extractCode(v: string): string {
  const m = /\/r\/([A-Za-z]{5})/.exec(v);
  const raw = m ? m[1] : v;
  return raw.toLocaleUpperCase('en-US').replace(CODE_CHARS, '').slice(0, 5);
}

export const homeView: View = async (root) => {
  const me = await loadMe().catch(() => null);
  const name = me?.profile?.username ?? '';

  const quickHintId = nextId('quick');
  const quick = btn('Quick match', { icon: icons.bolt, block: true, variant: 'accent btn-lg btn-quick' });
  quick.setAttribute('aria-describedby', quickHintId);
  quick.addEventListener('click', () =>
    busy(quick, async () => {
      const res = await send.quickMatch();
      if (!res.ok) return void toast(res.error, 'error');
      navigate(`/r/${res.code}`);
    }),
  );
  const quickBlock = h(
    'div',
    { class: 'quick-block' },
    quick,
    h('p', { class: 'hint', id: quickHintId }, `Play with whoever is online · ${QUICK_MATCH_ROUNDS} rounds. If nobody else shows up, the computer fills the last seat.`),
  );

  const create = btn('Create room', { icon: icons.plus, block: true, variant: 'primary btn-lg' });
  create.addEventListener('click', () =>
    busy(create, async () => {
      const res = await send.createRoom();
      if (!res.ok) return void toast(res.error, 'error');
      navigate(`/r/${res.code}`);
    }),
  );

  const practiceHintId = nextId('practice');
  const practice = btn('Practice vs computer', { icon: icons.bot, block: true, variant: 'ghost' });
  practice.setAttribute('aria-describedby', practiceHintId);
  practice.addEventListener('click', () =>
    busy(practice, async () => {
      const res = await send.practice();
      if (!res.ok) return void toast(res.error, 'error');
      navigate(`/r/${res.code}`);
    }),
  );
  const practiceBlock = h(
    'div',
    { class: 'practice-block' },
    practice,
    h('p', { class: 'hint', id: practiceHintId }, "Doesn't count toward your stats"),
  );

  const codeId = nextId('code');
  const codeInput = h('input', {
    id: codeId,
    class: 'code-input',
    name: 'code',
    maxLength: 32,
    autocomplete: 'off',
    autocapitalize: 'characters',
    placeholder: 'ABCDE',
    'aria-describedby': `${codeId}-hint`,
    enterKeyHint: 'go',
  });
  const joinBtn = btn('Join', { type: 'submit', icon: icons.enter, variant: 'secondary' });
  const sync = () => {
    const c = extractCode(codeInput.value);
    if (codeInput.value !== c) codeInput.value = c;
    joinBtn.disabled = c.length !== 5;
  };
  codeInput.addEventListener('input', sync);
  sync();
  const joinForm = h(
    'form',
    { class: 'join-form', novalidate: true },
    h('label', { for: codeId }, 'Room code'),
    h('div', { class: 'join-row' }, codeInput, joinBtn),
    h('p', { class: 'hint', id: `${codeId}-hint` }, 'Paste the 5-letter code or an invite link.'),
  );
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = extractCode(codeInput.value);
    if (c.length === 5) navigate(`/r/${c}`);
  });

  // "Return to game" card if the server re-attached us to a running room.
  const resume = h('div');
  const renderResume = () => {
    resume.innerHTML = '';
    const r = state.room;
    if (r && r.phase !== 'lobby' && r.phase !== 'matchEnd') {
      resume.appendChild(
        h(
          'div',
          { class: 'card resume-card' },
          h('p', null, h('strong', null, 'You have a game in progress! '), `Room ${r.code}`),
          btn('Back to game', { icon: icons.play, variant: 'accent', onclick: () => navigate(`/r/${r.code}`) }),
        ),
      );
    }
  };
  renderResume();
  const off = netEvents.on('room', renderResume);

  root.appendChild(
    h(
      'div',
      { class: 'app-shell' },
      topbar({ profile: true }),
      h(
        'main',
        { class: 'page home' },
        h(
          'section',
          { class: 'hero' },
          h('div', { class: 'hero-emoji', 'aria-hidden': 'true' }, h('span', { class: 'sp sp-rock' }, SPECIES_EMOJI.rock), h('span', { class: 'sp sp-paper' }, SPECIES_EMOJI.paper), h('span', { class: 'sp sp-scissors' }, SPECIES_EMOJI.scissors)),
          h('h1', null, name ? `Hi, ${name}!` : 'Hi there!'),
          h('p', { class: 'muted' }, 'Jump into a quick match or invite your friends, then pick your species. The last one standing wins the round!'),
        ),
        resume,
        h(
          'section',
          { class: 'card home-card stack' },
          quickBlock,
          h('div', { class: 'divider' }, h('span', null, 'or play with friends')),
          create,
          h('div', { class: 'divider' }, h('span', null, 'or')),
          joinForm,
          h('div', { class: 'divider' }, h('span', null, 'or warm up solo')),
          practiceBlock,
        ),
        h(
          'section',
          { class: 'card rules' },
          h('h2', null, 'How to play'),
          h(
            'ol',
            { class: 'rules-list' },
            h('li', null, '2–3 players take turns picking a species: Rock, Paper, or Scissors.'),
            h('li', null, 'Units roam the map; when they collide, the winning species converts the loser.'),
            h('li', null, 'Speed ramps up over time (2x, 3x, 5x). The round ends when only one species is left.'),
            h('li', null, 'After 90 seconds, the survivors can vote to end the round.'),
          ),
        ),
      ),
    ),
  );
  return off;
};
