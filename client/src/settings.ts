// Local, per-device settings (localStorage) + reduced-motion resolution.
import { Emitter, h } from './dom';
import { icons } from './icons';

const KEY = 'tkm.reducedMotion';
const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
const bus = new Emitter<{ change: boolean }>();

function readSetting(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let appSetting = readSetting();

/** True if the in-app toggle is on OR the OS prefers reduced motion. */
export function reducedMotion(): boolean {
  return appSetting || mq.matches;
}
export function appReducedSetting(): boolean {
  return appSetting;
}
export function setAppReduced(v: boolean): void {
  appSetting = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
  apply();
}
export function onReducedMotionChange(fn: (v: boolean) => void): () => void {
  return bus.on('change', fn);
}
function apply(): void {
  document.documentElement.toggleAttribute('data-reduced-motion', reducedMotion());
  bus.emit('change', reducedMotion());
}
mq.addEventListener?.('change', apply);
apply();

/** Gear button that opens a small settings popover. */
export function settingsButton(): HTMLElement {
  const id = `settings-${Math.random().toString(36).slice(2, 8)}`;
  const toggle = h('input', {
    type: 'checkbox',
    id: `${id}-rm`,
    class: 'switch-input',
    checked: appSetting,
    onchange: (e: Event) => setAppReduced((e.target as HTMLInputElement).checked),
  });
  const pop = h(
    'div',
    { class: 'popover card', id, role: 'dialog', 'aria-label': 'Settings', hidden: true },
    h('h3', { class: 'popover-title' }, 'Settings'),
    h(
      'label',
      { class: 'switch', for: `${id}-rm` },
      toggle,
      h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      h('span', { class: 'switch-label' }, 'Reduced motion'),
    ),
    h('p', { class: 'hint' }, 'Uses simpler visuals instead of shaking and fire effects.'),
  );
  const btn = h('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': 'Settings',
    'aria-expanded': 'false',
    'aria-controls': id,
    html: icons.gear,
  });
  const close = () => {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) toggle.checked = appSetting;
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', close);
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      btn.focus();
    }
  });
  return h('div', { class: 'settings' }, btn, pop);
}
