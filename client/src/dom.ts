// Tiny DOM helpers (no framework).

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
};

/** Create an element: h('button', { class: 'btn', onclick: fn }, 'Text'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Element from an SVG/HTML string (single root). */
export function fromHTML(html: string): Element {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild!;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => t && clearTimeout(t);
  return d;
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Simple typed event emitter. */
export class Emitter<E extends Record<string, unknown>> {
  private map = new Map<keyof E, Set<(v: never) => void>>();
  on<K extends keyof E>(k: K, fn: (v: E[K]) => void): () => void {
    let s = this.map.get(k);
    if (!s) this.map.set(k, (s = new Set()));
    s.add(fn as (v: never) => void);
    return () => s!.delete(fn as (v: never) => void);
  }
  emit<K extends keyof E>(k: K, v: E[K]): void {
    this.map.get(k)?.forEach((fn) => (fn as (v: E[K]) => void)(v));
  }
}

/** Avatar: image if available, otherwise initial in a colored bubble. */
export function avatar(name: string | null, url: string | null, size = 40): HTMLElement {
  const wrap = h('span', { class: 'avatar', style: `--size:${size}px`, 'aria-hidden': 'true' });
  if (url) {
    const img = h('img', { src: url, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
    img.onerror = () => {
      img.remove();
      wrap.textContent = initial(name);
    };
    wrap.appendChild(img);
  } else {
    wrap.textContent = initial(name);
    wrap.style.setProperty('--hue', String(hash(name ?? '?') % 360));
  }
  return wrap;
}

function initial(name: string | null): string {
  return (name ?? '?').trim().charAt(0).toUpperCase() || '?';
}
function hash(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(x);
}
