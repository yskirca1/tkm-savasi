import { USERNAME_MAX, USERNAME_MIN, USERNAME_RE } from '@tkm/shared';
import { api } from '../api';
import { currentMe, logout } from '../auth';
import { avatar, debounce, h } from '../dom';
import { icons, logoMark } from '../icons';
import { navigate } from '../router';
import { settingsButton } from '../settings';

let uid = 0;
export const nextId = (p: string) => `${p}-${++uid}`;

/** App top bar: brand (home link), settings, optional profile + logout. */
export function topbar(opts: { profile?: boolean; back?: string } = {}): HTMLElement {
  const me = currentMe();
  const right = h('div', { class: 'topbar-actions' }, settingsButton());
  if (opts.profile && me?.profile) {
    right.appendChild(
      h(
        'a',
        { class: 'chip-link', href: '/profile', 'data-link': true, 'aria-label': `Profile: ${me.profile.username}` },
        avatar(me.profile.username, me.profile.avatarUrl, 32),
        h('span', { class: 'chip-name' }, me.profile.username),
        me.guest ? h('span', { class: 'tag tag-guest' }, 'Guest') : null,
      ),
    );
    right.appendChild(
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Log out',
        title: 'Log out',
        html: icons.logout,
        onclick: async () => {
          await logout();
          navigate('/login');
        },
      }),
    );
  }
  const left = opts.back
    ? h('a', { class: 'icon-btn', href: opts.back, 'data-link': true, 'aria-label': 'Back', html: icons.back })
    : h('a', { class: 'brand-link', href: '/', 'data-link': true, 'aria-label': 'Home' }, h('span', { html: logoMark }), h('span', { class: 'brand-name' }, 'RPS Battle'));
  return h('header', { class: 'topbar' }, left, right);
}

export function brandHeader(title: string, subtitle?: string): HTMLElement {
  return h(
    'div',
    { class: 'brand' },
    h('span', { html: logoMark }),
    h('h1', null, title),
    subtitle ? h('p', { class: 'muted' }, subtitle) : null,
  );
}

/** Labeled text field with optional hint and inline error. */
export function field(opts: {
  label: string;
  type?: string;
  name: string;
  autocomplete?: string;
  value?: string;
  hint?: string;
  required?: boolean;
  minlength?: number;
  maxlength?: number;
  inputmode?: string;
}): { wrap: HTMLElement; input: HTMLInputElement; setError: (m: string | null) => void; status: HTMLElement } {
  const id = nextId(opts.name);
  const input = h('input', {
    id,
    name: opts.name,
    type: opts.type ?? 'text',
    autocomplete: opts.autocomplete,
    required: opts.required ?? true,
    minLength: opts.minlength,
    maxLength: opts.maxlength,
    inputMode: opts.inputmode,
    value: opts.value ?? '',
    'aria-describedby': `${id}-hint ${id}-status`,
    autocapitalize: 'off',
    spellcheck: false,
  });
  const status = h('p', { class: 'field-status', id: `${id}-status`, 'aria-live': 'polite' });
  const hint = h('p', { class: 'hint', id: `${id}-hint` }, opts.hint ?? '');
  let control: HTMLElement = input;
  if (opts.type === 'password') {
    const toggle = h('button', {
      type: 'button',
      class: 'pw-toggle',
      'aria-label': 'Show password',
      'aria-pressed': 'false',
      html: icons.eye,
    });
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.innerHTML = show ? icons.eyeOff : icons.eye;
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    control = h('div', { class: 'pw-wrap' }, input, toggle);
  }
  const wrap = h('div', { class: 'field' }, h('label', { for: id }, opts.label), control, opts.hint ? hint : null, status);
  const setError = (m: string | null) => {
    status.textContent = m ?? '';
    status.className = 'field-status' + (m ? ' error' : '');
    input.setAttribute('aria-invalid', m ? 'true' : 'false');
  };
  return { wrap, input, setError, status };
}

/** Client-side username validation message, or null if OK. */
export function usernameProblem(u: string): string | null {
  if (u.length < USERNAME_MIN) return `Must be at least ${USERNAME_MIN} characters.`;
  if (u.length > USERNAME_MAX) return `Must be at most ${USERNAME_MAX} characters.`;
  if (!USERNAME_RE.test(u)) return 'Use only letters, numbers, underscores (_) and dots (.).';
  if (/^guest/i.test(u)) return "Usernames can't start with 'guest'.";
  return null;
}

/**
 * Username field with debounced live availability check.
 * `current` (case-insensitive) is treated as available (own name).
 */
export function usernameField(opts: { value?: string; current?: string; label?: string }) {
  const f = field({
    label: opts.label ?? 'Username',
    name: 'username',
    autocomplete: 'username',
    value: opts.value,
    maxlength: USERNAME_MAX,
    hint: `${USERNAME_MIN}–${USERNAME_MAX} characters: letters, numbers, _ and .`,
  });
  let ok = false;
  let seq = 0;
  const setOk = (m: string) => {
    f.status.textContent = m;
    f.status.className = 'field-status ok';
    f.input.setAttribute('aria-invalid', 'false');
  };
  const check = debounce(async (u: string) => {
    const my = ++seq;
    try {
      const r = await api.usernameAvailable(u);
      if (my !== seq) return;
      ok = r.available;
      if (r.available) setOk('This username is available.');
      else f.setError(r.reason || 'This username is taken.');
    } catch (e) {
      if (my !== seq) return;
      ok = true; // let the server decide on submit
      f.setError(null);
      f.status.textContent = e instanceof Error ? e.message : '';
    }
  }, 350);
  const run = () => {
    const u = f.input.value.trim();
    ok = false;
    seq++;
    check.cancel();
    const p = usernameProblem(u);
    if (!u) return f.setError(null);
    if (p) return f.setError(p);
    if (opts.current && u.toLowerCase() === opts.current.toLowerCase()) {
      ok = true;
      return setOk('This is your current username.');
    }
    f.status.textContent = 'Checking…';
    f.status.className = 'field-status';
    check(u);
  };
  f.input.addEventListener('input', run);
  if (opts.value) queueMicrotask(run);
  return { ...f, isOk: () => ok, recheck: run };
}

/** Put a button into a busy state while an async action runs. */
export async function busy<T>(btn: HTMLButtonElement, fn: () => Promise<T>): Promise<T> {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('is-busy');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('is-busy');
  }
}

export function formAlert(): { el: HTMLElement; set: (m: string | null, kind?: 'error' | 'success') => void } {
  const el = h('div', { class: 'form-alert', role: 'alert', hidden: true });
  return {
    el,
    set: (m, kind = 'error') => {
      el.hidden = !m;
      el.textContent = m ?? '';
      el.className = `form-alert ${kind}`;
    },
  };
}

/** Small "Practice" badge (practice rooms: HUD, picking, match end). */
export function practiceBadge(): HTMLElement {
  return h('span', { class: 'tag tag-practice', hidden: true }, h('span', { html: icons.bot }), 'Practice');
}

export function btn(label: string, opts: { icon?: string; variant?: string; type?: 'button' | 'submit'; onclick?: (e: Event) => void; block?: boolean } = {}): HTMLButtonElement {
  const b = h('button', {
    type: opts.type ?? 'button',
    class: `btn btn-${opts.variant ?? 'primary'}${opts.block ? ' btn-block' : ''}`,
    onclick: opts.onclick,
  });
  b.innerHTML = `${opts.icon ?? ''}<span>${label}</span>`;
  return b;
}
