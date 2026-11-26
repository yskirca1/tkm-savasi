import { api } from '../api';
import { consumeNext, loadMe, logout, setMe } from '../auth';
import { h } from '../dom';
import { icons } from '../icons';
import { connect } from '../net';
import { navigate, type View } from '../router';
import { settingsButton } from '../settings';
import { brandHeader, btn, busy, formAlert, usernameField } from './common';

export const welcomeView: View = async (root) => {
  const me = await loadMe().catch(() => null);
  const alert = formAlert();
  const user = usernameField({ value: me?.suggestedUsername ?? '', label: 'Your username' });
  const submit = btn('Continue', { type: 'submit', block: true, icon: icons.check });
  const form = h('form', { class: 'stack', novalidate: true }, alert.el, user.wrap, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.set(null);
    const u = user.input.value.trim();
    if (!u || !user.isOk()) {
      if (!u) user.setError('Pick a username.');
      return user.input.focus();
    }
    void busy(submit, async () => {
      try {
        setMe(await api.createProfile(u));
        connect();
        navigate(consumeNext() ?? '/', true);
      } catch (err) {
        alert.set(err instanceof Error ? err.message : 'Couldn\'t create your profile.');
      }
    });
  });
  root.appendChild(
    h(
      'main',
      { class: 'page center auth-page' },
      h('div', { class: 'floating-settings' }, settingsButton()),
      h(
        'section',
        { class: 'card auth-card' },
        brandHeader('Welcome!', 'Choose the username that will show in the game. You can change it later in your profile.'),
        form,
        h(
          'p',
          { class: 'center-text muted' },
          h('button', {
            type: 'button',
            class: 'link-btn',
            onclick: async () => {
              await logout();
              navigate('/login');
            },
          }, 'Log in with a different account'),
        ),
      ),
    ),
  );
};
