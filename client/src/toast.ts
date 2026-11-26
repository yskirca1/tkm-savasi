import { h } from './dom';
import { icons } from './icons';

let region: HTMLElement | null = null;
function getRegion(): HTMLElement {
  if (!region) {
    region = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(region);
  }
  return region;
}

export type ToastKind = 'info' | 'error' | 'success';

/** Show a toast. Returns a dismiss function. duration 0 = sticky. */
export function toast(message: string, kind: ToastKind = 'info', duration = 3500): () => void {
  const icon = kind === 'error' ? icons.x : kind === 'success' ? icons.check : icons.bolt;
  const el = h('div', { class: `toast toast-${kind}` }, h('span', { class: 'toast-icon', html: icon }), h('span', null, message));
  getRegion().appendChild(el);
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  };
  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}
