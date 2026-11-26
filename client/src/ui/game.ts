// Game screen (phases intro / playing / roundEnd): canvas arena, HUD, scoreboard, vote bar, effects.
import { SPECIES_EMOJI, SPECIES_INDEX, SPECIES_LABEL, type GameSnapshot, type RoomState, type SeatIndex, type Species } from '@tkm/shared';
import { avatar, fmtTime, h } from '../dom';
import { ConversionFx, FireFx } from '../game/effects';
import { SnapshotBuffer } from '../game/interp';
import { GameRenderer } from '../game/renderer';
import { icons } from '../icons';
import { netEvents, send, state, type NetState } from '../net';
import { onReducedMotionChange, reducedMotion, settingsButton } from '../settings';
import { practiceBadge } from './common';
import type { RoomCtx, SubView } from './room';
import { mySeat, seatName } from './room';

export function gameView(ctx: RoomCtx): SubView {
  // ---------- DOM ----------
  const roundEl = h('span', { class: 'hud-round' });
  const practiceTag = practiceBadge();
  const timeEl = h('span', { class: 'hud-time', 'aria-label': 'Elapsed time' }, '00:00');
  const speedEl = h('span', { class: 'speed-chip', 'aria-live': 'polite' }, '1x');
  const scoreboard = h('ol', { class: 'scoreboard', 'aria-label': 'Scoreboard' });
  const canvas = h('canvas', { class: 'arena', role: 'img', 'aria-label': 'Game arena' });
  const fxCanvas = h('canvas', { class: 'fx-layer', 'aria-hidden': 'true' });
  const fever = h('div', { class: 'fever-overlay', 'aria-hidden': 'true' });
  const banner = h('div', { class: 'speed-banner', 'aria-hidden': 'true' });
  const intro = h('div', { class: 'intro-overlay', hidden: true, 'aria-live': 'assertive' });
  const stageInner = h('div', { class: 'stage-inner' }, canvas, banner, intro);
  const stage = h('div', { class: 'stage' }, stageInner);
  const voteBar = h('div', { class: 'vote-bar', hidden: true });
  const roundEndLayer = h('div', { class: 'roundend-overlay', hidden: true });

  const el = h(
    'div',
    { class: 'game' },
    h(
      'header',
      { class: 'hud' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Leave match', title: 'Leave match', html: icons.back, onclick: () => ctx.leave() }),
      h('h1', { class: 'visually-hidden' }, 'Game'),
      h('div', { class: 'hud-center' }, practiceTag, roundEl, h('span', { class: 'hud-clock' }, h('span', { html: icons.clock }), timeEl), speedEl),
      settingsButton(),
    ),
    scoreboard,
    stage,
    voteBar,
    fever,
    fxCanvas,
    roundEndLayer,
  );

  // ---------- rendering ----------
  const renderer = new GameRenderer(canvas);
  const buffer = new SnapshotBuffer();
  const conv = new ConversionFx();
  const fire = new FireFx(fxCanvas);
  let mapRound = -1;
  let lastSpeed = 1;
  let raf = 0;
  let room: RoomState | null = null;

  const layout = () => {
    const cs = getComputedStyle(stage);
    const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 8;
    const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 8;
    const { w, h: hh } = renderer.fit(availW, availH);
    stageInner.style.width = `${w}px`;
    stageInner.style.height = `${hh}px`;
    fire.resize(el.clientWidth, el.clientHeight);
  };
  const ro = new ResizeObserver(() => layout());
  ro.observe(stage);
  ro.observe(el);

  const applyRoundStart = () => {
    const rs = state.roundStart;
    if (!rs || rs.round === mapRound) return;
    mapRound = rs.round;
    renderer.setMap(rs.map);
    buffer.reset();
    conv.clear();
    lastSpeed = 1;
    setSpeed(1, false);
  };

  const frame = (now: number) => {
    const sample = buffer.sampleAt(now);
    const converted = buffer.drainConversions();
    if (converted.length) conv.add(converted, now);
    renderer.draw(sample, conv, now);
    if (sample) {
      const t = fmtTime(sample.elapsedMs);
      if (timeEl.textContent !== t) timeEl.textContent = t;
    }
    updateIntro(now);
    raf = requestAnimationFrame(frame);
  };

  // ---------- intro 3-2-1 ----------
  let introShown = '';
  let goUntil = 0;
  const updateIntro = (now: number) => {
    const rs = state.roundStart;
    let text = '';
    if (rs && room?.phase === 'intro') {
      const rem = state.roundStartAt + rs.introMs - now;
      text = String(Math.max(1, Math.min(3, Math.ceil((rem / Math.max(1, rs.introMs)) * 3))));
    } else if (now < goUntil) text = 'Go!';
    if (text !== introShown) {
      introShown = text;
      intro.hidden = !text;
      if (text) intro.replaceChildren(h('span', { class: `intro-num${text.length > 1 ? ' go' : ''}` }, text));
    }
  };

  // ---------- speed / fever ----------
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  const setSpeed = (speed: number, announce: boolean) => {
    speedEl.textContent = `${speed}x`;
    speedEl.dataset.speed = String(speed);
    speedEl.setAttribute('aria-label', `Speed ${speed}x`);
    if (announce) {
      banner.textContent = `SPEED ${speed}x!`;
      banner.classList.remove('show');
      void banner.offsetWidth; // restart animation
      banner.classList.add('show');
      speedEl.classList.remove('bump');
      void speedEl.offsetWidth;
      speedEl.classList.add('bump');
      if (bannerTimer) clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => {
        banner.classList.remove('show');
        speedEl.classList.remove('bump');
      }, 1500);
    }
    applyFever(speed);
  };
  const applyFever = (speed: number) => {
    const on = speed >= 5 && room?.phase === 'playing';
    const reduced = reducedMotion();
    el.classList.toggle('fever', on);
    el.classList.toggle('fever-static', on && reduced);
    if (on && !reduced) fire.start();
    else fire.stop();
  };

  // ---------- scoreboard ----------
  const speciesOf = (seat: number): Species | null => state.roundStart?.seatSpecies[seat] ?? room?.picks[seat] ?? null;
  const rows: { li: HTMLElement; count: HTMLElement; score: HTMLElement }[] = [];
  const buildScoreboard = () => {
    if (!room) return;
    const me = mySeat(room, ctx.userId);
    rows.length = 0;
    scoreboard.replaceChildren(
      ...room.seats.map((seat, i) => {
        const sp = speciesOf(i);
        const count = h('span', { class: 'sb-count', title: 'Units on the map' });
        const score = h('span', { class: 'sb-score', title: 'Rounds won' });
        const li = h(
          'li',
          { class: `sb-row${sp ? ` sp-${sp}` : ''}${i === me ? ' sb-me' : ''}` },
          h('span', { class: 'sb-emoji', 'aria-label': sp ? SPECIES_LABEL[sp] : '' }, sp ? SPECIES_EMOJI[sp] : '?'),
          h('span', { class: 'sb-name' }, seatName(seat), i === me ? h('span', { class: 'visually-hidden' }, ' (you)') : null),
          h('span', { class: 'sb-stats' }, h('span', { class: 'sb-stat' }, h('span', { html: icons.star }), score), h('span', { class: 'sb-stat sb-units' }, h('span', { class: 'sb-dot', 'aria-hidden': 'true' }), count)),
        );
        rows.push({ li, count, score });
        return li;
      }),
    );
    updateScoreboard(state.snapshot);
  };
  const updateScoreboard = (snap: GameSnapshot | null) => {
    if (!room) return;
    rows.forEach((r, i) => {
      const sp = speciesOf(i);
      const sc = String(room!.scores[i]);
      if (r.score.textContent !== sc) r.score.textContent = sc;
      const n = sp && snap ? snap.counts[SPECIES_INDEX[sp]] : sp ? (state.roundStart?.unitCount ?? 0) : 0;
      const ns = String(n);
      if (r.count.textContent !== ns) {
        r.count.textContent = ns;
        r.count.setAttribute('aria-label', `${ns} ${ns === '1' ? 'unit' : 'units'}`);
      }
      r.li.classList.toggle('sb-out', !!snap && n === 0);
    });
  };

  // ---------- vote ----------
  let pendingVote: { approve: boolean; at: number } | null = null;
  const voteBtn = h('button', { type: 'button', class: 'btn btn-vote', 'aria-pressed': 'false' });
  voteBtn.innerHTML = `${icons.flag}<span>End round</span>`;
  voteBtn.addEventListener('click', () => {
    const approved = voteBtn.getAttribute('aria-pressed') === 'true';
    pendingVote = { approve: !approved, at: performance.now() };
    send.vote(!approved);
    renderVote(state.snapshot);
  });
  const voteStatus = h('div', { class: 'vote-status', 'aria-live': 'polite' });
  const renderVote = (snap: GameSnapshot | null) => {
    const v = snap?.vote;
    if (!v || !v.open || !room || room.phase !== 'playing') {
      voteBar.hidden = true;
      return;
    }
    voteBar.hidden = false;
    const me = mySeat(room, ctx.userId);
    const eligible = me !== null && v.eligibleSeats.includes(me);
    let approved = me !== null && v.approvedSeats.includes(me);
    if (pendingVote && performance.now() - pendingVote.at < 600) approved = pendingVote.approve;
    else pendingVote = null;
    const names = v.eligibleSeats.map((s: SeatIndex) => {
      const ok = v.approvedSeats.includes(s) || (s === me && approved);
      return h('span', { class: `voter${ok ? ' ok' : ''}` }, ok ? h('span', { html: icons.check }) : null, s === me ? 'You' : seatName(room!.seats[s]));
    });
    const count = new Set([...v.approvedSeats.filter((s) => v.eligibleSeats.includes(s)), ...(approved && me !== null ? [me] : [])]).size;
    voteStatus.replaceChildren(h('span', { class: 'vote-count' }, `Approved: ${count}/${v.eligibleSeats.length}`), h('span', { class: 'voters' }, ...names));
    const kids: HTMLElement[] = [];
    if (eligible) {
      voteBtn.setAttribute('aria-pressed', String(approved));
      voteBtn.innerHTML = `${approved ? icons.check : icons.flag}<span>End round</span>`;
      voteBtn.title = approved ? 'Press again to withdraw your approval' : 'Approve ending the round';
      kids.push(voteBtn);
    } else {
      kids.push(h('span', { class: 'vote-readonly' }, 'Vote: survivors can end the round'));
    }
    kids.push(voteStatus);
    if (voteBar.firstChild !== kids[0] || voteBar.childNodes.length !== kids.length) voteBar.replaceChildren(...kids);
  };

  // ---------- round end ----------
  let roundEndKey = '';
  let roundEndTimer: ReturnType<typeof setInterval> | undefined;
  const renderRoundEnd = () => {
    const re = state.roundEnd;
    const show = room?.phase === 'roundEnd' && !!re;
    roundEndLayer.hidden = !show;
    if (!show || !re || !room) {
      if (roundEndTimer) clearInterval(roundEndTimer);
      roundEndTimer = undefined;
      roundEndKey = '';
      return;
    }
    const key = `${re.round}`;
    if (key === roundEndKey) return;
    roundEndKey = key;
    const me = mySeat(room, ctx.userId);
    const winSp = re.winnerSpecies;
    const winner = re.winnerSeat !== null ? room.seats[re.winnerSeat] : null;
    const bar = h('div', { class: 'next-bar' }, h('span', { class: 'next-fill' }));
    const fill = bar.firstChild as HTMLElement;
    const start = state.roundEndAt;
    const tickBar = () => {
      const k = Math.min(1, (performance.now() - start) / Math.max(1, re.nextInMs));
      fill.style.width = `${(1 - k) * 100}%`;
    };
    tickBar();
    if (roundEndTimer) clearInterval(roundEndTimer);
    roundEndTimer = setInterval(tickBar, 100);
    const isLast = re.round >= room.totalRounds;
    roundEndLayer.replaceChildren(
      h(
        'div',
        { class: `card roundend-card${winSp ? ` sp-${winSp}` : ' tie'}`, role: 'dialog', 'aria-labelledby': 'roundend-title' },
        h('p', { class: 'eyebrow' }, `Round ${re.round}/${room.totalRounds} over`),
        winSp
          ? h('div', { class: 'win-emoji', 'aria-hidden': 'true' }, SPECIES_EMOJI[winSp])
          : h('div', { class: 'win-emoji tie', 'aria-hidden': 'true', html: icons.users }),
        h(
          'h2',
          { id: 'roundend-title' },
          winSp && winner ? (re.winnerSeat === me ? `${SPECIES_LABEL[winSp]} wins — the round is yours!` : `${SPECIES_LABEL[winSp]} wins — ${seatName(winner)}`) : 'Tie — no point',
        ),
        re.byVote ? h('span', { class: 'tag tag-vote' }, h('span', { html: icons.flag }), 'Ended by vote') : null,
        h(
          'ul',
          { class: 'roundend-scores' },
          ...room.seats.map((seat, i) => {
            const sp = speciesOf(i);
            return h(
              'li',
              { class: `${i === re.winnerSeat ? 'won' : ''}${sp ? ` sp-${sp}` : ''}` },
              seat.kind === 'bot' ? h('span', { class: 'seat-avatar bot sm', html: icons.bot }) : avatar(seat.username, seat.avatarUrl, 28),
              h('span', { class: 'rs-name' }, i === me ? 'You' : seatName(seat)),
              sp ? h('span', { class: 'rs-sp', 'aria-label': SPECIES_LABEL[sp] }, SPECIES_EMOJI[sp]) : null,
              h('span', { class: 'rs-score' }, h('span', { html: icons.star }), String(re.scores[i]), i === re.winnerSeat ? h('span', { class: 'plus1' }, '+1') : null),
            );
          }),
        ),
        h('p', { class: 'muted small' }, isLast ? 'Results are coming…' : 'Next round is starting…'),
        bar,
      ),
    );
  };

  // ---------- events ----------
  const onSnapshot = (snap: GameSnapshot) => {
    applyRoundStart();
    buffer.push(snap, performance.now());
    if (snap.speed !== lastSpeed) {
      setSpeed(snap.speed, snap.speed > lastSpeed);
      lastSpeed = snap.speed;
    }
    updateScoreboard(snap);
    renderVote(snap);
  };
  const offs = [
    netEvents.on('snapshot', onSnapshot),
    onReducedMotionChange(() => applyFever(lastSpeed)),
  ];
  if (state.snapshot) onSnapshot(state.snapshot);
  raf = requestAnimationFrame(frame);
  requestAnimationFrame(layout);

  return {
    el,
    update(s: NetState) {
      const prevPhase = room?.phase;
      room = s.room!;
      if (prevPhase === 'intro' && room.phase === 'playing') goUntil = performance.now() + 700;
      applyRoundStart();
      roundEl.textContent = `Round ${room.round}/${room.totalRounds}`;
      practiceTag.hidden = !room.practice;
      buildScoreboard();
      renderVote(s.snapshot);
      applyFever(lastSpeed);
      renderRoundEnd();
      el.classList.toggle('is-roundend', room.phase === 'roundEnd');
    },
    destroy() {
      cancelAnimationFrame(raf);
      fire.stop();
      ro.disconnect();
      offs.forEach((f) => f());
      if (bannerTimer) clearTimeout(bannerTimer);
      if (roundEndTimer) clearInterval(roundEndTimer);
    },
  };
}
