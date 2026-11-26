import './styles.css';
import { api, ApiError } from './api';
import { authEvents, consumeNext, initAuth, isLoggedIn, loadMe, logout, setNext } from './auth';
import { h } from './dom';
import { icons, logoMark } from './icons';
import { connect, disconnect, netEvents } from './net';
import { navigate, route, setGuard, startRouter } from './router';
import './settings';
import { toast } from './toast';
import { forgotView, loginView, registerView, resetView } from './ui/auth';
import { homeView } from './ui/home';
import { profileView } from './ui/profile';
import { roomView } from './ui/room';
import { welcomeView } from './ui/welcome';

const PUBLIC = new Set(['/login', '/register', '/forgot', '/reset']);

async function guard(path: string): Promise<string | null> {
  if (path === '/reset') return null;
  const logged = await isLoggedIn();
  if (PUBLIC.has(path)) {
    if (!logged) return null;
    try {
      const me = await loadMe();
      if (!me.profile) return '/welcome';
      return consumeNext() ?? '/';
    } catch {
      return null;
    }
  }
  if (!logged) {
    if (path !== '/') setNext(path + location.search);
    return '/login';
  }
  try {
    const me = await loadMe();
    if (!me.profile) {
      if (path !== '/welcome') {
        if (path !== '/') setNext(path + location.search);
        return '/welcome';
      }
      return null;
    }
    if (path === '/welcome') return consumeNext() ?? '/';
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await logout();
      if (path !== '/') setNext(path);
      return '/login';
    }
    toast(e instanceof Error ? e.message : 'Couldn\'t load your profile.', 'error');
    return null;
  }
  connect();
  if (path === '/') {
    const next = consumeNext();
    if (next && next !== '/') return next;
  }
  return null;
}

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  let cfg;
  try {
    cfg = await api.config();
  } catch {
    app.innerHTML = '';
    app.appendChild(
      h(
        'main',
        { class: 'page center' },
        h(
          'section',
          { class: 'card auth-card' },
          h('div', { class: 'brand', html: logoMark }),
          h('h1', null, 'Can\'t reach the server'),
          h('p', { class: 'muted' }, 'Check your connection and try again.'),
          h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => location.reload(), html: `${icons.refresh}<span>Try again</span>` }),
        ),
      ),
    );
    return;
  }
  await initAuth(cfg);

  authEvents.on('change', (logged) => {
    if (!logged) disconnect();
  });
  authEvents.on('unauthorized', () => {
    void logout().then(() => navigate('/login'));
  });
  authEvents.on('recovery', () => navigate('/reset'));
  netEvents.on('profileRequired', () => navigate('/welcome'));
  netEvents.on('authFailed', () => {
    toast('Your session has expired. Please log in again.', 'error');
    void logout().then(() => navigate('/login'));
  });

  route('/login', loginView);
  route('/register', registerView);
  route('/forgot', forgotView);
  route('/reset', resetView);
  route('/welcome', welcomeView);
  route('/', homeView);
  route('/profile', profileView);
  route('/r/:code', roomView);
  setGuard(guard);
  startRouter(app);
}

void boot();
