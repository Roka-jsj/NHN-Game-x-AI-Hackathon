// 루프 · 고정 타임스텝 누산기 · 입력 큐 · 캔버스 스케일링.
//
// 여기서 절대 하지 않는 것:
//  - setInterval / setTimeout 으로 게임을 돌리는 것
//  - 이벤트 핸들러 안에서 게임 상태를 바꾸는 것
//  - 매 프레임 devicePixelRatio 를 계산하는 것
//  - 루프 안에서 객체·배열·문자열을 만드는 것

import * as C from './config.js';
import { Game } from './game.js';
import { Feel } from './feel.js';
import { Renderer } from './render.js';

const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

const game = new Game();
const feel = new Feel();
const renderer = new Renderer(canvas, ctx);
game.onEvent = (type, a, b) => feel.onEvent(type, a, b, game);

// ─────────────────────────────────────────────────────────────
// 입력 큐 — 핸들러는 여기에 기록만 한다. 상태는 프레임 시작에서만 바뀐다.
// 타입배열이라 입력 하나당 객체가 생기지 않는다.
// ─────────────────────────────────────────────────────────────
const QCAP = 32;
const IN_DOWN = 1, IN_UP = 2;
const qType = new Uint8Array(QCAP);
const qWall = new Float64Array(QCAP);
let qHead = 0, qTail = 0, qCount = 0;

function enqueue(type, wallTs) {
  if (qCount === QCAP) { qHead = (qHead + 1) % QCAP; qCount--; }  // 가장 오래된 것을 버린다
  qType[qTail] = type;
  qWall[qTail] = wallTs;
  qTail = (qTail + 1) % QCAP;
  qCount++;
}

function clearQueue() { qHead = 0; qTail = 0; qCount = 0; }

// click 은 쓰지 않는다. 지연이 있다.
stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  enqueue(IN_DOWN, e.timeStamp);
}, { passive: false });

window.addEventListener('pointerup', (e) => {
  enqueue(IN_UP, e.timeStamp);
}, { passive: false });

window.addEventListener('pointercancel', (e) => {
  enqueue(IN_UP, e.timeStamp);
}, { passive: false });

// 모바일 제스처 차단 — 확대·스크롤·더블탭줌 0
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('dblclick', (e) => e.preventDefault());
window.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });

// ─────────────────────────────────────────────────────────────
// 캔버스 스케일링 — resize 에서만 계산한다
// ─────────────────────────────────────────────────────────────
function resize() {
  // DPR 상한 2. 3배 기기에서 픽셀이 4배가 되면 채우기 비용이 그대로 4배다.
  const dpr = Math.min(window.devicePixelRatio || 1, C.DPR_CAP);
  const availW = stage.clientWidth || window.innerWidth;
  const availH = stage.clientHeight || window.innerHeight;
  const fit = Math.min(availW / C.VIEW_W, availH / C.VIEW_H);
  const cssW = Math.max(1, Math.floor(C.VIEW_W * fit));
  const cssH = Math.max(1, Math.floor(C.VIEW_H * fit));
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  renderer.resize(canvas.width / C.VIEW_W);
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
resize();

// ─────────────────────────────────────────────────────────────
// 루프
// ─────────────────────────────────────────────────────────────
let lastWall = 0;
let accumulator = 0;
let firstFrame = true;
let paused = false;
let needsTimeReset = false;

// 이벤트 timeStamp → 시뮬레이션 시각. 조준 진동 위상 계산에 쓴다.
let frameWall = 0;
let frameSimBase = 0;

function toSimTime(wallTs) {
  let age = frameWall - wallTs;
  if (age < 0) age = 0;
  if (age > C.MAX_FRAME_DELTA) age = C.MAX_FRAME_DELTA;
  return frameSimBase - age;
}

function drainInput() {
  while (qCount > 0) {
    const t = qType[qHead];
    const w = qWall[qHead];
    qHead = (qHead + 1) % QCAP;
    qCount--;
    if (t === IN_DOWN) game.press(toSimTime(w), w);
    else game.release(w);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    paused = true;
    clearQueue();
    game.cancelCharge();      // 복귀 시 30분짜리 차지가 되지 않게
    feel.clearTransient();    // 히트스톱·셰이크가 누적되어 터지지 않게
  } else {
    paused = false;
    needsTimeReset = true;    // 누산기 리셋은 다음 프레임에서
  }
});

function frame(nowWall) {
  requestAnimationFrame(frame);

  if (firstFrame || needsTimeReset) {
    lastWall = nowWall;
    accumulator = 0;
    firstFrame = false;
    needsTimeReset = false;
    renderer.draw(game, feel, 0, null);
    return;
  }
  if (paused) { lastWall = nowWall; return; }

  let delta = nowWall - lastWall;
  lastWall = nowWall;
  if (delta < 0) delta = 0;
  if (delta > C.MAX_FRAME_DELTA) delta = C.MAX_FRAME_DELTA;   // 죽음의 나선 차단
  accumulator += delta;

  // 이 프레임 시작 시각(nowWall)에 대응하는 시뮬레이션 시각.
  // game.simTime 은 "마지막으로 시뮬레이션된 순간"이고, 누산기에는 아직 시뮬레이션되지
  // 않은 시간이 담겨 있다. 그래서 둘을 더해야 지금 이 순간의 시뮬 시각이 된다.
  //
  // 이 한 줄이 빠지면 기준점이 누산기 잔여분(0~16.7ms)만큼 뒤처지고,
  // 그 잔여분은 주사율마다 다르다. 조준 진동 위상이 그만큼 흔들린다.
  frameWall = nowWall;
  frameSimBase = game.simTime + accumulator;
  game.frameWall = nowWall;
  game.frameSimBase = frameSimBase;

  drainInput();
  game.checkOvercharge(nowWall);

  let steps = 0;
  while (accumulator >= C.SIM_DT) {
    accumulator -= C.SIM_DT;
    // 히트스톱은 누산기를 건드리지 않는다. 이 스텝의 시뮬레이션만 건너뛴다.
    // 렌더는 계속 돈다 — 화면이 굳으면 버그처럼 보인다.
    if (feel.consumeFreeze()) {
      feel.stepFrozen();
    } else {
      game.step();
      feel.step(game);
    }
    if (++steps >= C.MAX_STEPS_PER_FRAME) { accumulator = 0; break; }
  }

  renderer.draw(game, feel, accumulator / C.SIM_DT, null);
}

requestAnimationFrame(frame);

// 헤드리스 검증 하네스가 들여다보는 지점. 게임 로직은 여기에 의존하지 않는다.
// inject()는 실제 포인터 핸들러와 똑같이 큐에 넣기만 한다 — 상태를 직접 바꾸지 않는다.
// 합성 클록 위에서 60Hz/120Hz 동일성을 재려면 이벤트 timeStamp를 우리가 정해야 하고,
// 브라우저가 만든 PointerEvent의 timeStamp는 가짜 클록과 다른 시간축을 쓴다. 그래서 필요하다.
window.__rising = {
  game, feel, C,
  inject(type, wallTs) { enqueue(type === 'down' ? IN_DOWN : IN_UP, wallTs); },
  get accumulator() { return accumulator; },
};
