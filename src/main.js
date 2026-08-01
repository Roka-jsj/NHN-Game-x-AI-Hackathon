// 루프 · 고정 타임스텝 누산기 · 입력 큐 · 캔버스 스케일링.
//
// 여기서 절대 하지 않는 것:
//  - setInterval / setTimeout 으로 게임을 돌리는 것
//  - 이벤트 핸들러 안에서 게임 상태를 바꾸는 것
//  - 매 프레임 devicePixelRatio 를 계산하는 것

import * as C from './config.js';
import { Game, S } from './game.js';

const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

const game = new Game();

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
let viewScale = 1;

function resize() {
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
  viewScale = canvas.width / C.VIEW_W;
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
    render(0);
    return;
  }
  if (paused) { lastWall = nowWall; return; }

  let delta = nowWall - lastWall;
  lastWall = nowWall;
  if (delta < 0) delta = 0;
  if (delta > C.MAX_FRAME_DELTA) delta = C.MAX_FRAME_DELTA;   // 죽음의 나선 차단
  accumulator += delta;

  frameWall = nowWall;
  frameSimBase = game.simTime;

  drainInput();
  game.checkOvercharge(nowWall);

  let steps = 0;
  while (accumulator >= C.SIM_DT) {
    game.step();
    accumulator -= C.SIM_DT;
    if (++steps >= C.MAX_STEPS_PER_FRAME) { accumulator = 0; break; }
  }

  render(accumulator / C.SIM_DT);
}

// ─────────────────────────────────────────────────────────────
// 렌더 — 패스 1은 최소한만 그린다. 색·레이아웃 다듬기는 패스 5의 영역.
// ─────────────────────────────────────────────────────────────
const ANCHOR_Y = C.CAM_ANCHOR * C.VIEW_H;

function render(alpha) {
  const camY = game.prevCamY + (game.camY - game.prevCamY) * alpha;
  const px = game.prevPlayerX + (game.playerX - game.prevPlayerX) * alpha;
  const py = game.prevPlayerY + (game.playerY - game.prevPlayerY) * alpha;
  const wy = game.prevWaterY + (game.waterY - game.prevWaterY) * alpha;

  ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
  ctx.fillStyle = C.COL_BG;
  ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

  // 벽
  ctx.fillStyle = C.COL_GRID;
  ctx.fillRect(0, 0, C.WALL_INSET, C.VIEW_H);
  ctx.fillRect(C.VIEW_W - C.WALL_INSET, 0, C.WALL_INSET, C.VIEW_H);

  // 발판
  ctx.fillStyle = C.COL_STRUCT;
  for (let i = 0; i <= game.platMade; i++) {
    const sy = ANCHOR_Y + camY - game.platYAt(i);
    if (sy < -40 || sy > C.VIEW_H + 40) continue;
    const th = C.PLATFORM_THICKNESS * game.platThickAt(i);
    const x = game.platSideAt(i) === 0
      ? C.WALL_INSET
      : C.VIEW_W - C.WALL_INSET - C.PLATFORM_REACH;
    ctx.fillRect(x, sy - th * 0.5, C.PLATFORM_REACH, th);
  }

  // 물
  const waterSy = ANCHOR_Y + camY - wy;
  if (waterSy < C.VIEW_H) {
    ctx.fillStyle = C.COL_DANGER;
    ctx.fillRect(0, waterSy, C.VIEW_W, C.VIEW_H - waterSy + 4);
  }

  // 조준선 — 선형이다. 이징 금지.
  const playerSy = ANCHOR_Y + camY - py;
  if (game.state === S.CHARGING) {
    const nowSim = game.simTime + alpha * C.SIM_DT;
    const dist = game.aimPreview(nowSim);
    const wob = game.wobbleOffset(dist, nowSim);
    ctx.strokeStyle = C.COL_PLAYER;
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    ctx.moveTo(px, playerSy);
    ctx.lineTo(px, playerSy - dist);
    ctx.stroke();
    for (let d = C.LEAP_DIST_MIN; d <= dist; d += 90) {
      const ty = playerSy - d;
      ctx.beginPath();
      ctx.moveTo(px - 6, ty);
      ctx.lineTo(px + 6, ty);
      ctx.stroke();
    }
    const cy = playerSy - dist - wob;
    ctx.beginPath();
    ctx.moveTo(px - 10, cy); ctx.lineTo(px + 10, cy);
    ctx.moveTo(px, cy - 10); ctx.lineTo(px, cy + 10);
    ctx.stroke();
  }

  // 플레이어
  ctx.fillStyle = C.COL_PLAYER;
  ctx.beginPath();
  ctx.arc(px, playerSy, C.PLAYER_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  // 점수
  ctx.fillStyle = C.COL_PLAYER;
  ctx.font = '28px ' + C.FONT_STACK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(Math.floor(game.heightMeters()) + 'm', C.VIEW_W * 0.5, C.UNIT * 4);

  if (game.state === S.DEAD) {
    ctx.font = '20px ' + C.FONT_STACK;
    ctx.fillText('탭하면 다시', C.VIEW_W * 0.5, C.VIEW_H * 0.5);
  }
}

game.onEvent = null;   // 패스 2에서 게임필이, 패스 6에서 오디오가 붙는다

requestAnimationFrame(frame);

// 헤드리스 검증 하네스가 들여다보는 지점. 게임 로직은 여기에 의존하지 않는다.
// inject()는 실제 포인터 핸들러와 똑같이 큐에 넣기만 한다 — 상태를 직접 바꾸지 않는다.
// 합성 클록 위에서 60Hz/120Hz 동일성을 재려면 이벤트 timeStamp를 우리가 정해야 하고,
// 브라우저가 만든 PointerEvent의 timeStamp는 가짜 클록과 다른 시간축을 쓴다. 그래서 필요하다.
window.__rising = {
  game, C,
  inject(type, wallTs) { enqueue(type === 'down' ? IN_DOWN : IN_UP, wallTs); },
  get accumulator() { return accumulator; },
};
