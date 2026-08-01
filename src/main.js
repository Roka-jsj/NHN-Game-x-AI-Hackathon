// 루프 · 고정 타임스텝 누산기 · 입력 큐 · 캔버스 스케일링.
//
// 여기서 절대 하지 않는 것:
//  - setInterval / setTimeout 으로 게임을 돌리는 것
//  - 이벤트 핸들러 안에서 게임 상태를 바꾸는 것
//  - 매 프레임 devicePixelRatio 를 계산하는 것
//  - 루프 안에서 객체·배열·문자열을 만드는 것

import * as C from './config.js';
import { Game, ACT } from './game.js';
import { Feel } from './feel.js';
import { Renderer } from './render.js';
import { Director } from './director.js';
import { Audio } from './audio.js';

const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

const game = new Game();
const feel = new Feel();
const renderer = new Renderer(canvas, ctx);
const director = new Director(game);
const audio = new Audio();
let directorView = false;
let muted = false;

game.onEvent = (type, a, b) => {
  feel.onEvent(type, a, b, game);
  director.onEvent(type, a, b, game);
  audio.onEvent(type, a, b, game);
};

// Game 은 생성자에서 이미 한 판을 차렸다. 그때는 디렉터가 없었으므로 다시 차린다.
game.reset();

// 계층2 산출물은 있으면 쓰고 없으면 안 쓴다. 실패해도 게임은 이미 돌고 있다.
director.load();

// ─────────────────────────────────────────────────────────────
// 입력 큐 — 핸들러는 여기에 기록만 한다. 상태는 프레임 시작에서만 바뀐다.
// 타입배열이라 입력 하나당 객체가 생기지 않는다.
// ─────────────────────────────────────────────────────────────
const QCAP = 32;
const qAct = new Uint8Array(QCAP);
const qWall = new Float64Array(QCAP);
let qHead = 0, qTail = 0, qCount = 0;

function enqueue(act, wallTs) {
  if (qCount === QCAP) { qHead = (qHead + 1) % QCAP; qCount--; }
  qAct[qTail] = act;
  qWall[qTail] = wallTs;
  qTail = (qTail + 1) % QCAP;
  qCount++;
}

function clearQueue() { qHead = 0; qTail = 0; qCount = 0; }

// ─────────────────────────────────────────────────────────────
// 포인터 — 스와이프는 릴리스가 아니라 **이동 임계값을 넘는 순간** 확정한다.
// 릴리스까지 기다리면 반사 게임에서 치명적이다.
//
// 동사는 좌/우 하나뿐이다. 탭으로도 스와이프로도 낼 수 있고,
// 러너에서는 레인 이동, 계단에서는 한 칸 오르기가 된다.
// ─────────────────────────────────────────────────────────────
let ptrId = -1, ptrX = 0, ptrY = 0, ptrSwiped = false;

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  // iOS 는 첫 사용자 제스처 안에서 resume() 해야 소리가 난다.
  // 핸들러 밖(프레임 루프)에서 부르면 제스처 문맥이 아니라 무음이 된다.
  audio.unlock();

  const r = canvas.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) {
    const lx = (e.clientX - r.left) / r.width * C.VIEW_W;
    const ly = (e.clientY - r.top) / r.height * C.VIEW_H;
    // 토글은 게임 입력이 아니다. 큐에 넣지 않고 여기서 걸러낸다.
    if (Renderer.hitToggle(lx, ly)) { directorView = !directorView; return; }
    if (Renderer.hitMute(lx, ly)) { muted = !muted; audio.setMuted(muted); return; }
  }
  ptrId = e.pointerId;
  ptrX = e.clientX;
  ptrY = e.clientY;
  ptrSwiped = false;
}, { passive: false });

window.addEventListener('pointermove', (e) => {
  if (e.pointerId !== ptrId || ptrSwiped) return;
  const dx = e.clientX - ptrX;
  const dy = e.clientY - ptrY;
  if (Math.abs(dx) < C.SWIPE_PX && Math.abs(dy) < C.SWIPE_PX) return;
  ptrSwiped = true;
  if (Math.abs(dx) > Math.abs(dy)) enqueue(dx > 0 ? ACT.RIGHT : ACT.LEFT, e.timeStamp);
  else enqueue(dy > 0 ? ACT.SLIDE : ACT.JUMP, e.timeStamp);
}, { passive: false });

window.addEventListener('pointerup', (e) => {
  if (e.pointerId !== ptrId) return;
  if (!ptrSwiped) {
    // 움직이지 않은 탭 — 누른 쪽이 곧 방향이다
    const r = canvas.getBoundingClientRect();
    const lx = r.width > 0 ? (e.clientX - r.left) / r.width * C.VIEW_W : C.VIEW_W * 0.5;
    enqueue(lx < C.VIEW_W * 0.5 ? ACT.LEFT : ACT.RIGHT, e.timeStamp);
  }
  ptrId = -1;
}, { passive: false });

window.addEventListener('pointercancel', () => { ptrId = -1; });

// ─────────────────────────────────────────────────────────────
// 키보드 — 심사자가 PC로 열 가능성이 높다
// ─────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  let act = -1;
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': act = ACT.LEFT; break;
    case 'ArrowRight': case 'd': case 'D': act = ACT.RIGHT; break;
    case 'ArrowUp': case 'w': case 'W': case ' ': act = ACT.JUMP; break;
    case 'ArrowDown': case 's': case 'S': act = ACT.SLIDE; break;
    case '1': act = ACT.PICK0; break;
    case '2': act = ACT.PICK1; break;
    case '3': act = ACT.PICK2; break;
    default: return;
  }
  e.preventDefault();
  audio.unlock();
  enqueue(act, e.timeStamp);
});

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
    const a = qAct[qHead];
    const w = qWall[qHead];
    qHead = (qHead + 1) % QCAP;
    qCount--;
    game.input(a, toSimTime(w), w);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    paused = true;
    clearQueue();
    ptrId = -1;
    feel.clearTransient();    // 히트스톱·셰이크가 누적되어 터지지 않게
    audio.hush();
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
    renderer.draw(game, feel, 0, director, directorView, muted);
    return;
  }
  if (paused) { lastWall = nowWall; return; }

  let delta = nowWall - lastWall;
  lastWall = nowWall;
  if (delta < 0) delta = 0;
  if (delta > C.MAX_FRAME_DELTA) delta = C.MAX_FRAME_DELTA;   // 죽음의 나선 차단
  accumulator += delta;

  // 이 프레임 시작 시각에 대응하는 시뮬레이션 시각.
  // simTime 은 "마지막으로 시뮬레이션된 순간"이고 누산기에는 아직 시뮬레이션되지 않은
  // 시간이 담겨 있다. 둘을 더해야 지금 이 순간의 시뮬 시각이 된다.
  frameWall = nowWall;
  frameSimBase = game.simTime + accumulator;
  game.frameWall = nowWall;
  game.frameSimBase = frameSimBase;

  drainInput();

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
      director.step(game);   // 구간 경계에서만 실제로 뭔가 한다
    }
    if (++steps >= C.MAX_STEPS_PER_FRAME) { accumulator = 0; break; }
  }

  audio.update(game);   // 연속 파라미터만 만진다. 노드를 만들지 않는다
  renderer.draw(game, feel, accumulator / C.SIM_DT, director, directorView, muted);
}

requestAnimationFrame(frame);

// 헤드리스 검증 하네스가 들여다보는 지점. 게임 로직은 여기에 의존하지 않는다.
// inject()는 실제 핸들러와 똑같이 큐에 넣기만 한다 — 상태를 직접 바꾸지 않는다.
// 합성 클록 위에서 60Hz/120Hz 동일성을 재려면 이벤트 timeStamp를 우리가 정해야 하고,
// 브라우저가 만든 이벤트의 timeStamp는 가짜 클록과 다른 시간축을 쓴다. 그래서 필요하다.
window.__rising = {
  game, feel, director, audio, C, ACT,
  inject(act, wallTs) { enqueue(act, wallTs); },
  setDirectorView(on) { directorView = !!on; },
  setMuted(on) { muted = !!on; audio.setMuted(muted); },
  get accumulator() { return accumulator; },
};
