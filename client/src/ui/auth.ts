// Login, register, forgot-password and reset-password screens.
import { PASSWORD_MIN } from '@tkm/shared';
import { api } from '../api';
import { consumeNext, getConfig, hasRecoverySession, loadMe, loginAsGuest, loginWithGoogle, loginWithPassword, register, startupHash, updatePasswordWithRecovery } from '../auth';
import { h } from '../dom';
import { googleLogo, icons } from '../icons';
import { navigate, type View } from '../router';
import { settingsButton } from '../settings';
import { toast } from '../toast';
import { brandHeader, btn, busy, field, formAlert, usernameField } from './common';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function shell(...content: (HTMLElement | null)[]): HTMLElement {
  return h(
    'main',
    { class: 'page center auth-page' },
    h('div', { class: 'floating-settings' }, settingsButton()),
    h('section', { class: 'card auth-card' }, ...content),
  );
}

async function afterLogin(): Promise<void> {
  const me = await loadMe(true);
  if (!me.profile) navigate('/welcome', true);
  else navigate(consumeNext() ?? '/', true);
}

export const loginView: View = (root) => {
  const cfg = getConfig();
  const alert = formAlert();
  const id = field({ label: 'Username or email', name: 'identifier', autocomplete: 'username' });
  const pw = field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password' });
  const submit = btn('Log in', { type: 'submit', block: true, icon: icons.enter });

  const google = h('button', { type: 'button', class: 'btn btn-google btn-block', disabled: !cfg.googleEnabled, 'aria-describedby': 'google-hint' });
  google.innerHTML = `${googleLogo}<span>Continue with Google</span>`;
  google.addEventListener('click', () =>
    busy(google, async () => {
      try {
        await loginWithGoogle();
      } catch (e) {
        alert.set(e instanceof Error ? e.message : 'Google login failed.');
      }
    }),
  );

  const guestBtn = btn('Play as guest', { icon: icons.user, block: true, variant: 'ghost', type: 'button' });
  guestBtn.setAttribute('aria-describedby', 'guest-hint');
  guestBtn.addEventListener('click', () =>
    busy(guestBtn, async () => {
      alert.set(null);
      try {
        await loginAsGuest();
        await afterLogin(); // returns to a pending invite link (/r/CODE) if there is one
      } catch (err) {
        alert.set(err instanceof Error ? err.message : "Couldn't start a guest session.");
      }
    }),
  );
  const guestBlock = h(
    'div',
    { class: 'guest-block' },
    guestBtn,
    h('p', { class: 'hint center-text', id: 'guest-hint' }, "No account needed. Guest scores aren't saved."),
  );

  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    alert.el,
    id.wrap,
    pw.wrap,
    h('div', { class: 'row-end' }, h('a', { href: '/forgot', 'data-link': true, class: 'link' }, 'Forgot password?')),
    submit,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.set(null);
    const identifier = id.input.value.trim();
    const password = pw.input.value;
    id.setError(identifier ? null : 'Enter your username or email.');
    pw.setError(password ? null : 'Enter your password.');
    if (!identifier) return id.input.focus();
    if (!password) return pw.input.focus();
    void busy(submit, async () => {
      try {
        await loginWithPassword(identifier, password);
        await afterLogin();
      } catch (err) {
        alert.set(err instanceof Error ? err.message : 'Login failed.');
      }
    });
  });

  root.appendChild(
    shell(
      brandHeader('RPS Battle', 'Rock, paper, scissors — a real-time battle with your friends!'),
      google,
      !cfg.googleEnabled ? h('p', { class: 'hint center-text', id: 'google-hint' }, 'Google login is turned off on this server. Continue with your username and password.') : null,
      h('div', { class: 'divider' }, h('span', null, 'or')),
      form,
      h('div', { class: 'divider' }, h('span', null, 'or')),
      guestBlock,
      h('p', { class: 'center-text muted' }, 'Don\'t have an account? ', h('a', { href: '/register', 'data-link': true, class: 'link' }, 'Sign up')),
    ),
  );
};

export const registerView: View = (root) => {
  const alert = formAlert();
  const user = usernameField({});
  const email = field({
    label: 'Email',
    name: 'email',
    type: 'email',
    autocomplete: 'email',
    inputmode: 'email',
    hint: 'Your email is only used to send a reset link if you forget your password.',
  });
  const pw = field({
    label: 'Password',
    name: 'password',
    type: 'password',
    autocomplete: 'new-password',
    minlength: PASSWORD_MIN,
    hint: `At least ${PASSWORD_MIN} characters.`,
  });
  pw.input.addEventListener('input', () => {
    const n = pw.input.value.length;
    if (n === 0) pw.setError(null);
    else if (n < PASSWORD_MIN) pw.setError(`${PASSWORD_MIN - n} more character${PASSWORD_MIN - n === 1 ? '' : 's'} needed.`);
    else {
      pw.setError(null);
      pw.status.textContent = 'Password looks good.';
      pw.status.className = 'field-status ok';
    }
  });
  const submit = btn('Sign up', { type: 'submit', block: true, icon: icons.plus });
  const form = h('form', { class: 'stack', novalidate: true }, alert.el, user.wrap, email.wrap, pw.wrap, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.set(null);
    const u = user.input.value.trim();
    const em = email.input.value.trim();
    const p = pw.input.value;
    let bad: HTMLInputElement | null = null;
    if (!u || !user.isOk()) {
      if (!u) user.setError('Pick a username.');
      bad = user.input;
    }
    if (!EMAIL_RE.test(em)) {
      email.setError('Enter a valid email address.');
      bad ??= email.input;
    } else email.setError(null);
    if (p.length < PASSWORD_MIN) {
      pw.setError(`Password must be at least ${PASSWORD_MIN} characters.`);
      bad ??= pw.input;
    }
    if (bad) {
      alert.set('Please fix the highlighted fields.');
      bad.focus();
      return;
    }
    void busy(submit, async () => {
      try {
        await register(u, em, p);
        toast('Welcome! Your account is ready.', 'success');
        await afterLogin();
      } catch (err) {
        alert.set(err instanceof Error ? err.message : 'Sign-up failed.');
      }
    });
  });
  root.appendChild(
    shell(
      brandHeader('Sign up', 'Pick a username and join the battle.'),
      form,
      h('p', { class: 'center-text muted' }, 'Already have an account? ', h('a', { href: '/login', 'data-link': true, class: 'link' }, 'Log in')),
    ),
  );
};

export const forgotView: View = (root) => {
  const alert = formAlert();
  const id = field({ label: 'Username or email', name: 'identifier', autocomplete: 'username' });
  const submit = btn('Send reset link', { type: 'submit', block: true, icon: icons.mail });
  const form = h('form', { class: 'stack', novalidate: true }, alert.el, id.wrap, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = id.input.value.trim();
    if (!v) {
      id.setError('Enter your username or email.');
      return id.input.focus();
    }
    id.setError(null);
    void busy(submit, async () => {
      try {
        await api.forgot(v);
        form.replaceWith(
          h(
            'div',
            { class: 'success-box', role: 'status' },
            h('span', { class: 'success-icon', html: icons.mail }),
            h('p', null, 'If an account matches, we\'ve sent a password reset link to its email address. Check your inbox (and your spam folder).'),
          ),
        );
      } catch (err) {
        alert.set(err instanceof Error ? err.message : 'Couldn\'t send the request.');
      }
    });
  });
  root.appendChild(
    shell(
      brandHeader('Forgot password?', 'Enter your username or email and we\'ll send you a reset link.'),
      form,
      h('p', { class: 'center-text muted' }, h('a', { href: '/login', 'data-link': true, class: 'link' }, 'Back to log in')),
    ),
  );
};

export const resetView: View = async (root) => {
  const cfg = getConfig();
  const devToken = startupHash.get('dev_token') ?? new URLSearchParams(location.hash.slice(1)).get('dev_token');
  const hashError = startupHash.get('error_description') || startupHash.get('error');

  const alert = formAlert();
  const pw = field({ label: 'New password', name: 'password', type: 'password', autocomplete: 'new-password', minlength: PASSWORD_MIN, hint: `At least ${PASSWORD_MIN} characters.` });
  const pw2 = field({ label: 'Confirm new password', name: 'password2', type: 'password', autocomplete: 'new-password' });
  const submit = btn('Update password', { type: 'submit', block: true, icon: icons.key });
  const form = h('form', { class: 'stack', novalidate: true }, alert.el, pw.wrap, pw2.wrap, submit);

  let valid: boolean;
  if (cfg.mode === 'dev') valid = !!devToken;
  else valid = !hashError && (await hasRecoverySession());

  if (!valid) {
    root.appendChild(
      shell(
        brandHeader('Invalid link', 'This reset link is invalid or has expired.'),
        h('a', { href: '/forgot', 'data-link': true, class: 'btn btn-primary btn-block' }, 'Request a new link'),
        h('p', { class: 'center-text muted' }, h('a', { href: '/login', 'data-link': true, class: 'link' }, 'Back to log in')),
      ),
    );
    return;
  }
  // Remove the token from the address bar.
  if (location.hash) history.replaceState(null, '', '/reset');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.set(null);
    const p = pw.input.value;
    if (p.length < PASSWORD_MIN) {
      pw.setError(`Password must be at least ${PASSWORD_MIN} characters.`);
      return pw.input.focus();
    }
    pw.setError(null);
    if (p !== pw2.input.value) {
      pw2.setError('Passwords don\'t match.');
      return pw2.input.focus();
    }
    pw2.setError(null);
    void busy(submit, async () => {
      try {
        if (cfg.mode === 'dev') {
          await api.devReset(devToken!, p);
          toast('Your password has been updated. You can now log in with it.', 'success', 5000);
          navigate('/login', true);
        } else {
          await updatePasswordWithRecovery(p);
          toast('Your password has been updated!', 'success', 5000);
          await afterLogin();
        }
      } catch (err) {
        alert.set(err instanceof Error ? err.message : 'Couldn\'t update your password.');
      }
    });
  });
  root.appendChild(shell(brandHeader('Set a new password', 'Choose a new password for your account.'), form));
};
