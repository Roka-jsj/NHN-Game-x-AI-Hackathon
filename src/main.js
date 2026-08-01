// 루프 · 고정 타임스텝 누산기 · 입력 큐 · 캔버스 스케일링.
//
// 여기서 절대 하지 않는 것:
//  - setInterval / setTimeout 으로 게임을 돌리는 것
//  - 이벤트 핸들러 안에서 게임 상태를 바꾸는 것
//  - 매 프레임 devicePixelRatio 를 계산하는 것

import * as C from './config.js';
import { Game, S } from './game.js';
import { Feel, easeOutBack, easeOutCubic } from './feel.js';

const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

const game = new Game();
const feel = new Feel();
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
    render(0);
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
  // 그 잔여분은 주사율마다 다르다. 조준 진동 위상이 그만큼 흔들려서
  // 완벽 착지(±2.4px) 판정이 60Hz와 120Hz에서 갈린다. 실측으로 잡았다.
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

  render(accumulator / C.SIM_DT);
}

// ─────────────────────────────────────────────────────────────
// 렌더 — 패스 5에서 다듬는다. 지금은 게임필이 보이는 데까지만.
// ─────────────────────────────────────────────────────────────
const ANCHOR_Y = C.CAM_ANCHOR * C.VIEW_H;
const HALF_W = C.VIEW_W * 0.5;
const HALF_H = C.VIEW_H * 0.5;

// 물 근접 경고 그라디언트. 화면 좌표 고정이라 한 번만 만든다 (루프 안 할당 금지).
let waterGrad = null;
function ensureGradients() {
  if (waterGrad) return;
  waterGrad = ctx.createLinearGradient(0, C.VIEW_H - 260, 0, C.VIEW_H);
  waterGrad.addColorStop(0, C.RAMP_DANGER[0]);
  waterGrad.addColorStop(1, C.RAMP_DANGER[C.rampIndex(0.45)]);
}

function render(alpha) {
  ensureGradients();

  const camY = game.prevCamY + (game.camY - game.prevCamY) * alpha;
  const px = game.prevPlayerX + (game.playerX - game.prevPlayerX) * alpha;
  const py = game.prevPlayerY + (game.playerY - game.prevPlayerY) * alpha;
  const wy = game.prevWaterY + (game.waterY - game.prevWaterY) * alpha;

  // 카메라 리드 — 상승 방향으로 살짝 앞을 본다. 렌더 전용이다.
  const vy = game.playerY - game.prevPlayerY;
  const lead = vy * C.CAM_LEAD;
  const camEff = camY + lead;

  ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
  ctx.fillStyle = C.COL_BG;
  ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

  // 스크린 셰이크 — 이동 + 미세 회전
  ctx.translate(HALF_W + feel.shakeX, HALF_H + feel.shakeY);
  if (feel.shakeA !== 0) ctx.rotate(feel.shakeA);
  ctx.translate(-HALF_W, -HALF_H);

  // 벽
  ctx.fillStyle = C.COL_GRID;
  ctx.fillRect(0, 0, C.WALL_INSET, C.VIEW_H);
  ctx.fillRect(C.VIEW_W - C.WALL_INSET, 0, C.WALL_INSET, C.VIEW_H);

  // 발판
  ctx.fillStyle = C.COL_STRUCT;
  for (let i = 0; i <= game.platMade; i++) {
    const sy = ANCHOR_Y + camEff - game.platYAt(i);
    if (sy < -40 || sy > C.VIEW_H + 40) continue;
    const th = C.PLATFORM_THICKNESS * game.platThickAt(i);
    const x = game.platSideAt(i) === 0
      ? C.WALL_INSET
      : C.VIEW_W - C.WALL_INSET - C.PLATFORM_REACH;
    ctx.fillRect(x, sy - th * 0.5, C.PLATFORM_REACH, th);
  }

  // 물
  const waterSy = ANCHOR_Y + camEff - wy;
  if (waterSy < C.VIEW_H) {
    ctx.fillStyle = C.COL_DANGER;
    ctx.fillRect(0, waterSy, C.VIEW_W, C.VIEW_H - waterSy + 8);
  }

  // 물 근접 경고 — 시각보다 청각이 먼저 오지만, 눈으로도 보인다
  const margin = game.waterMargin();
  if (margin < C.WATER_NEAR_PX) {
    const near = margin <= 0 ? 1 : 1 - margin / C.WATER_NEAR_PX;
    ctx.globalAlpha = near * near;
    ctx.fillStyle = waterGrad;
    ctx.fillRect(0, C.VIEW_H - 260, C.VIEW_W, 260);
    ctx.globalAlpha = 1;
  }

  const playerSy = ANCHOR_Y + camEff - py;

  // 트레일 — 도약 잔상
  for (let i = 0; i < C.TRAIL_MAX; i++) {
    const age = feel.tAge[i];
    if (age < 0) continue;
    const a = (1 - age / C.TRAIL_FRAMES) * 0.30;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(a)];
    ctx.beginPath();
    ctx.arc(feel.tX[i], ANCHOR_Y + camEff - feel.tY[i], C.PLAYER_RADIUS * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  // 조준선 — 선형이다. 이징 금지.
  if (game.state === S.CHARGING) {
    const nowSim = game.simTime + alpha * C.SIM_DT;
    const dist = game.aimPreview(nowSim);
    const wob = game.wobbleOffset(dist, nowSim);
    // 오버차지 경고: 6프레임 주기 점멸
    const blink = feel.overcharge && (((game.tick / 6) | 0) & 1) === 0;
    ctx.strokeStyle = blink ? C.COL_DANGER : C.COL_PLAYER;
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    ctx.moveTo(px, playerSy);
    ctx.lineTo(px, playerSy - dist);
    ctx.stroke();
    // 제도 눈금 — 90px마다
    ctx.beginPath();
    for (let d = C.LEAP_DIST_MIN; d <= dist; d += 90) {
      const ty = playerSy - d;
      ctx.moveTo(px - 6, ty);
      ctx.lineTo(px + 6, ty);
    }
    ctx.stroke();
    // 십자 조준점 — 사인파로 진동한다
    const cy = playerSy - dist - wob;
    ctx.beginPath();
    ctx.moveTo(px - 10, cy); ctx.lineTo(px + 10, cy);
    ctx.moveTo(px, cy - 10); ctx.lineTo(px, cy + 10);
    ctx.stroke();
  }

  // 링 — 완벽 착지 확산
  ctx.lineWidth = C.STROKE;
  for (let i = 0; i < C.RING_MAX; i++) {
    const st = feel.ringStep[i];
    if (st < 0) continue;
    const t = st / feel.ringSteps;
    const e = easeOutCubic(t);
    const r = C.RING_R0 + (C.RING_R1 - C.RING_R0) * e;
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(1 - t)];
    ctx.beginPath();
    ctx.arc(feel.ringX[i], ANCHOR_Y + camEff - feel.ringY[i], r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 파티클
  for (let i = 0; i < C.PARTICLE_MAX; i++) {
    const life = feel.pLife[i];
    if (life <= 0) continue;
    const a = life / feel.pMax[i];
    const kind = feel.pKind[i];
    const ramp = kind === 2 ? C.RAMP_DANGER : (kind === 1 ? C.RAMP_PLAYER : C.RAMP_STRUCT);
    ctx.fillStyle = ramp[C.rampIndex(a)];
    const s = feel.pSize[i];
    ctx.fillRect(feel.pX[i] - s, ANCHOR_Y + camEff - feel.pY[i] - s, s * 2, s * 2);
  }

  // 플레이어 — 스쿼시 & 스트레치
  ctx.save();
  ctx.translate(px, playerSy);
  ctx.scale(feel.sx, feel.sy);
  ctx.fillStyle = C.COL_PLAYER;
  ctx.beginPath();
  ctx.arc(0, 0, C.PLAYER_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 셰이크 변환 해제
  ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);

  // 신기록 섬광
  if (feel.flashFrames > 0) {
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(feel.flashFrames / 3 * 0.35)];
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
  }

  // 점수
  ctx.fillStyle = C.COL_PLAYER;
  ctx.font = '28px ' + C.FONT_STACK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(Math.floor(game.heightMeters()) + 'm', HALF_W, C.UNIT * 4);

  // 결과 UI — easeOutBack 260ms
  if (game.state === S.DEAD && feel.resultStep >= 0) {
    const t = feel.resultStep / feel.resultSteps;
    const e = t >= 1 ? 1 : easeOutBack(t);
    ctx.save();
    ctx.translate(HALF_W, HALF_H);
    ctx.scale(e, e);
    ctx.fillStyle = C.COL_PLAYER;
    ctx.font = '44px ' + C.FONT_STACK;
    ctx.fillText(Math.floor(game.heightMeters()) + 'm', 0, -C.UNIT * 9);
    ctx.font = '20px ' + C.FONT_STACK;
    ctx.fillText('완벽 착지 ' + game.perfectCount, 0, C.UNIT * 2);
    ctx.fillText('탭하면 다시', 0, C.UNIT * 7);
    ctx.restore();
  }
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
