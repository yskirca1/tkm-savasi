import { api } from '../api';
import { loadMe, setMe } from '../auth';
import { avatar, h } from '../dom';
import { icons } from '../icons';
import type { View } from '../router';
import { toast } from '../toast';
import { btn, busy, formAlert, topbar, usernameField } from './common';

export const profileView: View = async (root) => {
  const main = h('main', { class: 'page profile' });
  root.appendChild(h('div', { class: 'app-shell' }, topbar({ back: '/' }), main));
  main.appendChild(h('p', { class: 'muted', role: 'status' }, 'Loading…'));
  let me;
  try {
    me = await loadMe(true);
  } catch (e) {
    main.innerHTML = '';
    main.appendChild(h('p', { class: 'form-alert error', role: 'alert' }, e instanceof Error ? e.message : 'Couldn\'t load your profile.'));
    return;
  }
  const username = me.profile?.username ?? '';
  const title = h('h1', null, username);
  const avatarSlot = h('div', { class: 'profile-avatar' }, avatar(username, me.profile?.avatarUrl ?? null, 88));

  const alert = formAlert();
  const user = usernameField({ value: username, current: username, label: 'Change your username' });
  const save = btn('Save', { type: 'submit', icon: icons.check });
  const form = h('form', { class: 'stack', novalidate: true }, alert.el, user.wrap, save);
  let current = username;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.set(null);
    const u = user.input.value.trim();
    if (u === current) return;
    if (!user.isOk()) return user.input.focus();
    void busy(save, async () => {
      try {
        const m = await api.renameProfile(u);
        setMe(m);
        current = m.profile?.username ?? u;
        title.textContent = current;
        avatarSlot.replaceChildren(avatar(current, m.profile?.avatarUrl ?? null, 88));
        toast('Username updated.', 'success');
      } catch (err) {
        alert.set(err instanceof Error ? err.message : 'Couldn\'t update.');
      }
    });
  });

  const stat = (icon: string, label: string, value: number, cls: string) =>
    h('div', { class: `stat ${cls}` }, h('span', { class: 'stat-icon', html: icon }), h('span', { class: 'stat-value' }, String(value)), h('span', { class: 'stat-label' }, label));

  main.innerHTML = '';
  main.append(
    h('section', { class: 'profile-head' }, avatarSlot, title),
    h(
      'section',
      { class: 'stats', 'aria-label': 'Statistics' },
      stat(icons.users, 'Games played', me.stats.gamesPlayed, 'stat-violet'),
      stat(icons.trophy, 'Games won', me.stats.gamesWon, 'stat-amber'),
      stat(icons.star, 'Total rounds won', me.stats.roundsWon, 'stat-pink'),
    ),
    h('section', { class: 'card' }, form),
  );
};
