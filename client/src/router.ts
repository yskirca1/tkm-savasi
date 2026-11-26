// Minimal History API router.

export type Cleanup = (() => void) | void;
export type View = (root: HTMLElement, params: Record<string, string>) => Cleanup | Promise<Cleanup>;

interface Route {
  pattern: RegExp;
  keys: string[];
  view: View;
}

const routes: Route[] = [];
let root: HTMLElement;
let cleanup: Cleanup;
let guard: (path: string) => Promise<string | null> = async () => null;
let navToken = 0;

export function route(path: string, view: View): void {
  const keys: string[] = [];
  const src = path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  routes.push({ pattern: new RegExp(`^${src}/?$`), keys, view });
}

/** Guard returns a redirect path, or null to proceed. */
export function setGuard(g: (path: string) => Promise<string | null>): void {
  guard = g;
}

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else if (path !== location.pathname + location.search + location.hash) history.pushState(null, '', path);
  void render();
}

export function startRouter(el: HTMLElement): void {
  root = el;
  window.addEventListener('popstate', () => void render());
  document.addEventListener('click', (e) => {
    const a = (e.target as Element).closest?.('a[data-link]') as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.getAttribute('href')!);
  });
  void render();
}

async function render(): Promise<void> {
  const my = ++navToken;
  const path = location.pathname;
  const redirect = await guard(path);
  if (my !== navToken) return;
  if (redirect && redirect !== path) {
    history.replaceState(null, '', redirect);
    return render();
  }
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  root.innerHTML = '';
  window.scrollTo(0, 0);
  for (const r of routes) {
    const m = r.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const c = await r.view(root, params);
    if (my !== navToken) {
      if (typeof c === 'function') c();
      return;
    }
    cleanup = c;
    // Move focus to the main heading for screen readers.
    const h1 = root.querySelector('h1');
    if (h1) {
      h1.setAttribute('tabindex', '-1');
      h1.focus({ preventScroll: true });
    }
    return;
  }
  history.replaceState(null, '', '/');
  return render();
}
