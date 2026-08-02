// 루프 · 고정 타임스텝 누산기 · 입력 큐 · 캔버스 스케일링.
//
// 여기서 절대 하지 않는 것:
//  - setInterval / setTimeout 으로 게임을 돌리는 것
//  - 이벤트 핸들러 안에서 게임 상태를 바꾸는 것
//  - 매 프레임 devicePixelRatio 를 계산하는 것
//  - 루프 안에서 객체·배열·문자열을 만드는 것

import * as C from './config.js';
import { Game, ACT, S, EV } from './game.js';
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

// "입력이 있었다"만 알리는 빈 행동. ACT 는 0~14 라 255 는 어떤 분기에도 안 걸린다.
// 설명 화면(S.BRIEF)은 act 를 보지 않고 아무 입력이나 소비하므로 이걸 보낸다 —
// 큐에 들어간 뒤 상태가 바뀌어도 유닛이 튀어나오지 않는다.
const ACT_NONE = 255;

function enqueue(act, wallTs) {
  if (qCount === QCAP) { qHead = (qHead + 1) % QCAP; qCount--; }
  qAct[qTail] = act;
  qWall[qTail] = wallTs;
  qTail = (qTail + 1) % QCAP;
  qCount++;
}

function clearQueue() { qHead = 0; qTail = 0; qCount = 0; }

// ─────────────────────────────────────────────────────────────
// 포인터 — 화면 아래 버튼 다섯 개가 조작의 전부다.
// 플래시게임의 문법: 반사가 아니라 **누르는 것**이다. 그래서 릴리스가 아니라
// 누른 순간에 반응한다. 스와이프도 드래그도 없다.
// ─────────────────────────────────────────────────────────────
// 화면 좌표 → 논리 좌표. **화면과 입력이 어긋나면 게임이 통째로 고장난다.**
// 그래서 회전 여부를 아는 곳은 여기 하나뿐이다 — 나머지 코드는 논리 좌표만 본다.
// 눕힌 캔버스에서 getBoundingClientRect() 는 변환된 **시각** 사각형을 준다.
// 정확히 90도라 축정렬 경계상자가 곧 그 사각형이므로 보정이 따로 필요 없다.
function toLocal(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (rotated) {
    // 시계방향 90도: 캔버스 로컬 +x 가 화면 +y 로, 로컬 +y 가 화면 −x 로 간다.
    // 중심 기준 오프셋을 역회전한다. (r.width = 캔버스 CSS 높이, r.height = CSS 폭)
    const dx = clientX - (r.left + r.width * 0.5);
    const dy = clientY - (r.top + r.height * 0.5);
    ptrLX = (0.5 + dy / r.height) * C.VIEW_W;
    ptrLY = (0.5 - dx / r.width) * C.VIEW_H;
  } else {
    ptrLX = (clientX - r.left) / r.width * C.VIEW_W;
    ptrLY = (clientY - r.top) / r.height * C.VIEW_H;
  }
  return true;
}
function localXY(e) { return toLocal(e.clientX, e.clientY); }
let ptrLX = 0, ptrLY = 0;

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  // iOS 는 첫 사용자 제스처 안에서 resume() 해야 소리가 난다.
  // 핸들러 밖(프레임 루프)에서 부르면 제스처 문맥이 아니라 무음이 된다.
  audio.unlock();
  // 마우스 오른쪽·가운데 버튼은 조작이 아니다. 터치·펜은 언제나 통과시킨다
  // (멀티터치는 손가락마다 pointerdown 이 따로 오므로 여기서 전부 큐에 들어간다).
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (!localXY(e)) return;

  // 설명 화면은 **아무 데나 눌러도** 즉시 열린다 (계약 §4: 붙잡아 두는 화면 금지).
  // 토글보다 먼저 본다 — 설명 중의 탭은 전부 "닫아라"라는 뜻이다.
  if (game.state === S.BRIEF) { enqueue(ACT_NONE, e.timeStamp); return; }

  // 토글은 게임 입력이 아니다. 큐에 넣지 않고 여기서 걸러낸다.
  if (Renderer.hitToggle(ptrLX, ptrLY)) { directorView = !directorView; return; }
  if (Renderer.hitMute(ptrLX, ptrLY)) { muted = !muted; audio.setMuted(muted); return; }

  if (game.state === S.OVER) { enqueue(ACT.RESTART, e.timeStamp); return; }

  if (game.state === S.DRAFT) {
    const card = Renderer.hitCard(ptrLX, ptrLY);
    if (card >= 0) enqueue(ACT.PICK0 + card, e.timeStamp);
    return;
  }

  // 증원은 우하단 원형 버튼. 줄에 넣으면 11개가 되어 버튼이 더 좁아진다.
  if (Renderer.hitRally && Renderer.hitRally(ptrLX, ptrLY)) {
    enqueue(ACT.RALLY, e.timeStamp);
    return;
  }
  const b = Renderer.hitButton(ptrLX, ptrLY);
  if (b >= 0) enqueue(b, e.timeStamp);
}, { passive: false });

window.addEventListener('pointercancel', () => {});

// ─────────────────────────────────────────────────────────────
// 키보드 — 심사자가 PC로 열 가능성이 높다. 1~5 가 버튼 다섯 개다.
// ─────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  let act = -1;
  // 유닛 여섯은 1~6, 진화 7, 포탑 8, 해일 9, 화살비 0, 증원 R.
  // 손가락 하나로 끝나야 한다 — 플래시게임의 조작은 반사가 아니라 누르기다.
  switch (e.key) {
    case '1': act = ACT.SWORD; break;
    case '2': act = ACT.SPEAR; break;
    case '3': act = ACT.ARCHER; break;
    case '4': act = ACT.CAV; break;
    case '5': act = ACT.GIANT; break;
    case '6': act = ACT.CATA; break;
    case '7': act = ACT.ERA; break;
    case '8': act = ACT.TOWER; break;
    case '9': case ' ': act = ACT.TIDE; break;
    case '0': act = ACT.VOLLEY; break;
    case 'r': case 'R': act = ACT.RALLY; break;
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
//
// 폰 세로가 이 게임의 최대 문제였다. 390×844 에서 min(390/960, 844/540) = 0.406
// 이라 게임이 **390×219 짜리 띠**가 되고 위아래 620px 이 빈다 — 화면의 26%.
// 버튼 한 칸이 34×27 CSS px 이라 글씨도 안 읽히고 손가락도 안 맞는다.
// 세로에서는 캔버스를 90도 눕혀 긴 변을 전장에 준다: 0.406 → 0.722 (화면의 82%).
// 눕히면 폰을 돌리는 순간 그림이 바로 선다 — **자동회전을 꺼 둔 사람**에게도
// 통한다는 게 핵심이다. 회전 잠금이 켜져 있으면 브라우저는 영원히 세로다.
// 입력 좌표는 toLocal() 하나가 같은 회전을 되돌린다.
// ─────────────────────────────────────────────────────────────
// 세로 맞춤이 이보다 나쁠 때만 눕힌다. 0.55 면 버튼 한 칸이 46 CSS px —
// 이 아래로는 손가락이 안 맞는다. 태블릿 세로(768×1024, 0.80)는 그냥 둔다.
const ROT_MIN_FIT = 0.55;
const ROT_MIN_GAIN = 1.25;      // 눕혀서 이만큼 이상 커지지 않으면 눕힐 값어치가 없다
let rotated = false;
let viewFit = 1;
let resizeQueued = false;

// 세로 힌트 문구는 index.html 소유다. 회전 상태에 맞는 말로만 바꿔 준다.
function syncRotateHint() {
  const el = document.getElementById('rotate');
  if (!el || !el.lastChild || el.lastChild.nodeType !== 3) return;
  const t = rotated ? '폰을 옆으로 돌리면 화면이 바로 섭니다'
                    : '가로로 돌리면 전장이 넓게 보입니다';
  if (el.lastChild.nodeValue !== t) el.lastChild.nodeValue = t;
}

function resize() {
  resizeQueued = false;
  // DPR 상한 2. 3배 기기에서 픽셀이 4배가 되면 채우기 비용이 그대로 4배다.
  const dpr = Math.min(window.devicePixelRatio || 1, C.DPR_CAP);
  // clientWidth 는 **padding 을 포함한다.** stage 는 안전영역만큼 padding 을 먹으므로
  // 그대로 쓰면 노치·홈바 아래로 캔버스가 밀려 들어간다. 내용상자로 잰다.
  let availW = stage.clientWidth || window.innerWidth || 1;
  let availH = stage.clientHeight || window.innerHeight || 1;
  const cs = getComputedStyle(stage);
  availW -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  availH -= (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  if (availW < 1) availW = 1;
  if (availH < 1) availH = 1;

  const fitUp = Math.min(availW / C.VIEW_W, availH / C.VIEW_H);
  const fitRot = Math.min(availH / C.VIEW_W, availW / C.VIEW_H);
  rotated = availH > availW && fitUp < ROT_MIN_FIT && fitRot >= fitUp * ROT_MIN_GAIN;
  const fit = rotated ? fitRot : fitUp;
  viewFit = fit;

  const cssW = Math.max(1, Math.floor(C.VIEW_W * fit));
  const cssH = Math.max(1, Math.floor(C.VIEW_H * fit));
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  // 변환은 레이아웃 상자를 바꾸지 않는다. 눕히면 상자가 가로로 넘치지만
  // 시각 중심은 그대로고 body 가 overflow:hidden 이라 스크롤이 생기지 않는다.
  canvas.style.transform = rotated ? 'rotate(90deg)' : '';
  syncRotateHint();

  // 버퍼 크기를 대입하면 캔버스가 **지워진다.** 값이 바뀔 때만 건드린다 —
  // 모바일 주소창이 오르내릴 때마다 resize 가 오는데 그때마다 화면이 깜빡인다.
  const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  renderer.resize(canvas.width / C.VIEW_W);
}

// 회전 중에는 resize 가 연달아 온다. 한 프레임에 한 번으로 접는다.
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(resize);
}

window.addEventListener('resize', queueResize);
window.addEventListener('orientationchange', () => {
  queueResize();
  // iOS 는 orientationchange 시점에 아직 옛 치수를 준다. 한 박자 뒤 한 번 더 잰다.
  // 게임을 굴리는 타이머가 아니라 회전 1회당 1회짜리 보정이다.
  setTimeout(queueResize, 260);
});
// 주소창이 접히거나 키보드가 뜨면 window.resize 가 안 오는 브라우저가 있다.
if (window.visualViewport) window.visualViewport.addEventListener('resize', queueResize);
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
let lastSteps = 0;      // 검증용. 복귀 첫 프레임이 몇 스텝을 돌았는지 밖에서 잰다
let frameCount = 0;

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
    feel.clearTransient();    // 히트스톱·셰이크가 누적되어 터지지 않게
    audio.hush();
  } else {
    paused = false;
    needsTimeReset = true;    // 누산기 리셋은 다음 프레임에서
  }
});

function frame(nowWall) {
  requestAnimationFrame(frame);
  frameCount++;

  if (firstFrame || needsTimeReset) {
    lastWall = nowWall;
    accumulator = 0;
    lastSteps = 0;
    firstFrame = false;
    needsTimeReset = false;
    renderer.draw(game, feel, 0, director, directorView, muted);
    return;
  }
  if (paused) { lastWall = nowWall; lastSteps = 0; return; }

  let delta = nowWall - lastWall;
  lastWall = nowWall;
  if (delta < 0) delta = 0;
  // 250ms 넘게 벌어졌으면 그건 느린 프레임이 아니라 **정지**다 (앱 전환·통화·절전).
  // 예전에는 250 으로 자르고 따라잡았는데, 그러면 복귀 첫 프레임에 스텝이 8개
  // 한꺼번에 돌아 화면이 순간이동한다. visibilitychange 를 못 받는 브라우저에서
  // 실제로 그렇게 된다. 따라잡지 않고 그 시간을 버린다 — 죽음의 나선도 같이 막힌다.
  if (delta > C.MAX_FRAME_DELTA) { delta = 0; accumulator = 0; }
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
  lastSteps = steps;

  audio.update(game);   // 연속 파라미터만 만진다. 노드를 만들지 않는다
  renderer.draw(game, feel, accumulator / C.SIM_DT, director, directorView, muted);
}

requestAnimationFrame(frame);

// 헤드리스 검증 하네스가 들여다보는 지점. 게임 로직은 여기에 의존하지 않는다.
// inject()는 실제 핸들러와 똑같이 큐에 넣기만 한다 — 상태를 직접 바꾸지 않는다.
// 합성 클록 위에서 60Hz/120Hz 동일성을 재려면 이벤트 timeStamp를 우리가 정해야 하고,
// 브라우저가 만든 이벤트의 timeStamp는 가짜 클록과 다른 시간축을 쓴다. 그래서 필요하다.
window.__rising = {
  // EV 를 반드시 함께 노출한다. 없으면 검증 하네스가 이벤트 코드를 하드코딩하게 되고,
  // 나중에 코드가 바뀌면 **경고 없이 틀린 숫자를 세게 된다.** 실제로 QA가 그 상태였다.
  game, feel, director, audio, renderer, C, ACT, EV,
  inject(act, wallTs) { enqueue(act, wallTs); },
  setDirectorView(on) { directorView = !!on; },
  setMuted(on) { muted = !!on; audio.setMuted(muted); },
  get accumulator() { return accumulator; },

  // ── 여기부터는 v3 에서 **추가**한 것들. 위의 계약은 하나도 바뀌지 않았다 ──
  S,                                         // 상태 상수(BRIEF 포함). 하네스가 숫자를 하드코딩하지 않게
  get rotated() { return rotated; },         // 세로에서 캔버스를 눕혔는가
  get viewFit() { return viewFit; },         // 논리 1px 이 CSS 몇 px 인가
  get lastSteps() { return lastSteps; },     // 마지막 프레임의 시뮬 스텝 수
  get frameCount() { return frameCount; },
  get pointer() { return [ptrLX, ptrLY]; },  // 마지막으로 해석된 논리 좌표
  // 화면 좌표 → 논리 좌표. 실제 탭 좌표가 어디에 떨어지는지 밖에서 검산할 수 있게.
  toLocal(clientX, clientY) { return toLocal(clientX, clientY) ? [ptrLX, ptrLY] : null; },
};
