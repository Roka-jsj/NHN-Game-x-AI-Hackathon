// 게임필 — 손끝의 감촉. 시뮬레이션 결과에 붙기만 하고 결과를 바꾸지 않는다.
//
// 이 파일은 게임 규칙을 모른다. "무슨 일이 일어났는가"만 이벤트로 받고
// "그게 어떻게 느껴지는가"를 만든다. 시뮬레이션 상태는 **읽기만** 한다.
//
// 히트스톱은 시뮬레이션 프레임 단위다. 렌더 프레임이 아니다.
// 시뮬은 주사율과 무관하게 60Hz 고정이므로, 프레임 수로 세면
// 60Hz와 120Hz에서 지속 시간이 저절로 같아진다.
//
// ─── 이 파일의 설계 원칙: 더한 만큼 뺀다 ────────────────────────
// 게임필은 총량이 아니라 **대비**다. 화면이 계속 흔들리면 큰 타격도 안 느껴지고,
// 화면이 계속 굳으면 그냥 렉으로 보인다. 그래서 두 가지를 예산으로 관리한다.
//
// 1) 히트스톱 예산 — 실측으로 뽑았다.
//    고치기 전 150초 실측: 얼어 있던 프레임이 **10.77%**(968/8988)였고
//    그중 648프레임이 EV.COUNTER_HIT 하나였다(239회 × 3프레임).
//    상성 우위 타격은 난전에서 초당 수십 번 나온다. 매번 히트스톱을 걸면
//    **얼어 있는 동안에는 시뮬이 안 돌아 다음 타격도 안 난다** — 즉 구조적으로
//    최대 75%까지 얼 수 있다. 그래서 자주 오는 이벤트의 히트스톱은
//    최소 간격 + 최근 부하 상한을 통과할 때만 걸린다(freeze 의 prio 0).
//    자주 나오는 것과 강하게 느껴지는 것은 이렇게 양립한다 —
//    **매번 걸지 않고, 걸릴 때 확실히 건다.**
//
// 2) 셰이크 예산 — 고치기 전 실측: 화면이 흔들린 프레임이 **66.9%**였다.
//    범인은 EV.ATTACK 이었다(공격마다 1.2px, 감쇠 0.85 → 25프레임 지속 ×
//    초당 2.8회 = 사실상 상시 진동). 평범한 공격은 이미 render 가 피격 플래시와
//    공격 모션으로, audio 가 타격음으로 말하고 있다. 여기서 화면까지 흔들면
//    **정작 큰 타격이 왔을 때 구분이 안 된다.** 그래서 평타 셰이크는 뺐다.

import * as C from './config.js';
import { EV, S, SIDE_L, groundAt } from './game.js';

export function easeOutBack(t) {
  const s = 1.70158;
  const u = t - 1;
  return u * u * ((s + 1) * u + s) + 1;
}
export function easeOutCubic(t) {
  const u = t - 1;
  return u * u * u + 1;
}

// config 에 아직 없는 수치는 여기 기본값으로 돈다. 메인이 상수를 넣어 주면
// **코드를 안 고쳐도** 그쪽이 정본이 된다 (보고서의 "메인에게 요청" 목록).
function num(v, d) { return (typeof v === 'number' && Number.isFinite(v)) ? v : d; }

// 히트스톱 예산
const FREEZE_GAP      = num(C.FREEZE_GAP, 12);        // 흔한 이벤트의 최소 간격(시뮬 프레임)
const FREEZE_GAP_HI   = num(C.FREEZE_GAP_HI, 9);      // 중요한 이벤트의 최소 간격
const FREEZE_LOAD     = num(C.FREEZE_LOAD_MAX, 0.10); // 최근 얼어 있던 비율 상한
// 5·0.18 이었다. 초당 360회 폭주 시험에서 **20.4%** 가 나왔다 — 간격이 짧아
// 히트스톱이 서로 이어 붙고, 부하 추정(창 1.5초)이 따라잡기 전에 이미 굳는다.
// 9·0.14 면 같은 폭주에서 14% 대로 내려가고, 실제 판(초당 1회 미만)에서는
// 아무것도 달라지지 않는다.
const FREEZE_LOAD_HI  = num(C.FREEZE_LOAD_MAX_HI, 0.14);
const LOAD_K = 1 / 90;                                // 부하 추정 창 ≈ 1.5초

const HITSTOP_COUNTER = num(C.HITSTOP_COUNTER, 3);
const SHAKE_COUNTER   = num(C.SHAKE_COUNTER, 2.6);
const STREAK_HOLD     = num(C.STREAK_HOLD, 45);       // 연쇄가 끊기는 시간
const FOE_HIT_GAP     = num(C.FOE_HIT_GAP, 20);       // 적에게 당한 상성 타격의 최소 간격

// 도발 — 멈추지 않고 느려진다
const SLOW_TAUNT      = num(C.SLOW_TAUNT, 16);
const SHAKE_TAUNT     = num(C.SHAKE_TAUNT, 1.6);
const ROT_TAUNT       = num(C.ROT_TAUNT, 0.0075);

// 실패한 입력
const DENY_GAP        = num(C.DENY_GAP, 13);
const PART_DENY       = num(C.PART_DENY, 5);
const DENY_LIFE       = num(C.DENY_LIFE, 18);
// 튕겨 나오는 높이. **버튼 줄 위에 떠 있어야 한다** — 파티클은 월드 층이고
// 버튼 줄은 그 위에 덮이므로, 줄 안쪽에서 터뜨리면 그대로 가려진다.
// 폰 세로에서는 버튼 줄이 더 높이 올라온다(render 가 92px 로 키운다). 그래서
// 가로 기준 BTN_Y 가 아니라 **둘 중 더 높은 쪽 위**를 잡는다. 실측으로 잡은 값이다 —
// 처음엔 BTN_Y − 7 에 뒀는데 캡처해 보니 아무것도 안 보였다.
const DENY_Y          = num(C.DENY_Y, C.VIEW_H - 110);

const PART_SPAWN      = num(C.PART_SPAWN, 3);
const BASE_RING_GAP   = num(C.BASE_RING_GAP, 34);

// 셰이크의 바닥. 예전 값은 0.02px 이었다 — **보이지도 않는 진동**이 지수 감쇠의
// 꼬리를 30프레임 넘게 끌면서, 흔들린 프레임 비율만 부풀리고 매 프레임 캔버스를
// 소수점 좌표로 다시 래스터했다. 0.25px 이하는 DPR 2 에서도 반 픽셀이라 안 보인다.
// 여기서 끊으면 같은 세기의 타격이 **더 짧고 더 또렷하게** 끝난다.
const SHAKE_FLOOR     = num(C.SHAKE_FLOOR, 0.25);

// 우선순위 — 예산을 누가 먼저 쓰는가
const PR_LOW = 0;      // 초당 여러 번 올 수 있는 것 (상성 타격 · 잡졸 처치)
const PR_HI = 1;       // 판을 읽는 신호 (기지 타격 · 큰 유닛 처치 · 적 진화)
const PR_ALWAYS = 2;   // 판이 바뀌는 순간 (진화 · 해일 · 승패 · 원정)

// v3 이벤트 — game.js 가 아직 안 올렸으면 계약(spec-v3)의 번호를 쓴다.
// 그래도 그 이벤트가 안 오면 이 가지는 그냥 한 번도 안 밟힌다.
const E_STAGE_START  = num(EV.STAGE_START, 20);
const E_STAGE_CLEAR  = num(EV.STAGE_CLEAR, 21);
const E_TAUNT        = num(EV.TAUNT, 22);
const E_CAMPAIGN_END = num(EV.CAMPAIGN_END, 23);

// 지면 높이 — 협곡은 V자라 가운데가 78px 낮다.
// 고치기 전에는 타격 파편이 전부 C.GROUND_Y 기준이라 **전선 위 100px 허공**에서
// 터졌다. 파편이 싸움 위에 안 얹히면 아무리 늘려도 손맛이 안 난다.
function gy(x) {
  const y = groundAt(x);
  return (y === y) ? y : C.GROUND_Y;      // NaN 방어. 지형이 깨져도 게임은 돈다
}

export class Feel {
  constructor() {
    this.freezeFrames = 0;
    // 슬로모션 — 한 프레임 걸러 한 프레임씩 쉰다. 굳는 게 아니라 느려진다.
    this.slowFrames = 0;
    this.slowPhase = 0;
    // 히트스톱 예산. 배열 없이 지수 이동 평균으로 최근 부하를 추정한다.
    this.freezeLoad = 0;
    this.sinceFreeze = 1e6;
    this.t = 0;                 // 시뮬 프레임 카운터 (연출 타이밍 전용)

    // 셰이크는 렌더 전용이다. 판정에 관여하지 않으므로 난수를 써도 된다.
    this.shakeMag = 0;
    this.shakeRotMag = 0;
    this.shakeX = 0; this.shakeY = 0; this.shakeA = 0;

    const P = C.PARTICLE_MAX;
    this.pX = new Float32Array(P);
    this.pY = new Float32Array(P);
    this.pVX = new Float32Array(P);
    this.pVY = new Float32Array(P);
    this.pLife = new Int16Array(P);
    this.pMax = new Int16Array(P);
    this.pSize = new Float32Array(P);
    this.pKind = new Uint8Array(P);   // 0=흰 파편 1=금 2=피
    this.pNext = 0;

    this.ringX = new Float32Array(C.RING_MAX);
    this.ringY = new Float32Array(C.RING_MAX);
    this.ringStep = new Int16Array(C.RING_MAX);
    this.ringSteps = Math.max(1, Math.round(C.RING_MS / C.SIM_DT));
    this.ringNext = 0;
    for (let i = 0; i < C.RING_MAX; i++) this.ringStep[i] = -1;

    // 떠오르는 숫자 — 피해와 수입이 어디서 났는지 눈으로 따라갈 수 있어야 한다
    this.fX = new Float32Array(C.FLOAT_MAX);
    this.fY = new Float32Array(C.FLOAT_MAX);
    this.fVal = new Int32Array(C.FLOAT_MAX);
    this.fKind = new Uint8Array(C.FLOAT_MAX);   // 0=피해 1=금
    this.fStep = new Int16Array(C.FLOAT_MAX);
    this.fSteps = Math.max(1, Math.round(C.FLOAT_MS / C.SIM_DT));
    this.fNext = 0;
    for (let i = 0; i < C.FLOAT_MAX; i++) this.fStep[i] = -1;

    this.resultStep = -1;
    this.resultSteps = Math.max(1, Math.round(C.RESULT_UI_MS / C.SIM_DT));
    this.flashFrames = 0;

    this.bannerCode = 0;
    this.bannerFrames = 0;
    this.bannerTotal = Math.max(1, Math.round(C.BANNER_MS / C.SIM_DT));

    // ── 처치의 무게 ──
    // 검사가 죽을 때와 거인이 죽을 때가 같으면 처치는 의미를 잃는다.
    // 새 상수를 만들지 않고 **비용**에서 뽑는다 (가장 싼 것 0 · 가장 비싼 것 1).
    // 그래서 config 이 유닛을 더 넣거나 값을 바꿔도 저절로 따라간다.
    const K = Math.max(1, C.UNIT_KINDS | 0);
    this.killW = new Float32Array(K);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < K; k++) {
      const c = num(C.U_COST && C.U_COST[k], 1);
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    for (let k = 0; k < K; k++) {
      const c = num(C.U_COST && C.U_COST[k], lo);
      this.killW[k] = hi > lo ? (c - lo) / (hi - lo) : 0.5;
    }

    // 버튼 중심 x — 실패한 입력이 **누른 자리에서** 튕겨나야 한다
    const B = Math.max(1, C.BTN_COUNT | 0);
    this.btnCX = new Float32Array(B);
    for (let i = 0; i < B; i++) {
      this.btnCX[i] = C.BTN_X0 + i * (C.BTN_W + C.BTN_GAP) + C.BTN_W * 0.5;
    }
    // 어느 버튼인지 모를 때(a<0: 진화·포탑·스킬) 쓰는 자리.
    // 그 넷은 전부 줄 오른쪽(6~9)에 모여 있으므로 그 한가운데를 잡는다.
    const uk = Math.min(B - 1, Math.max(0, C.UNIT_KINDS | 0));
    this.btnCXOther = (this.btnCX[uk] + this.btnCX[B - 1]) * 0.5;

    this.streak = 0;         // 상성 우위 연쇄
    this.streakGap = 0;
    this.denyCd = 0;         // 실패한 입력의 최소 간격
    this.baseRingCd = 0;     // 기지 타격 링의 최소 간격
    this.foeHitCd = 0;       // 적의 상성 타격 충격 최소 간격
    this.tideAt = -1e6;      // 해일 중복 방지 (SKILL(0) 과 NUKE 가 같이 온다)
  }

  // 탭 전환 복귀 시 호출. 히트스톱·셰이크가 누적되어 터지는 걸 막는다.
  clearTransient() {
    this.freezeFrames = 0;
    this.slowFrames = 0; this.slowPhase = 0;
    this.freezeLoad = 0; this.sinceFreeze = 1e6;
    this.shakeMag = 0; this.shakeRotMag = 0;
    this.shakeX = 0; this.shakeY = 0; this.shakeA = 0;
    this.flashFrames = 0;
    this.bannerFrames = 0;
    this.streak = 0; this.streakGap = 0;
    this.denyCd = 0; this.baseRingCd = 0; this.foeHitCd = 0;
    this.tideAt = -1e6;
  }

  reset() {
    this.clearTransient();
    this.pLife.fill(0);
    for (let i = 0; i < C.RING_MAX; i++) this.ringStep[i] = -1;
    for (let i = 0; i < C.FLOAT_MAX; i++) this.fStep[i] = -1;
    this.resultStep = -1;
  }

  // 히트스톱 — 이 스텝의 시뮬레이션만 건너뛴다. 렌더는 계속 돈다.
  // **시뮬 스텝마다 정확히 한 번** 불린다. 예산 추정을 여기서 한다.
  consumeFreeze() {
    if (this.sinceFreeze < 1e6) this.sinceFreeze++;
    let stop = false;
    if (this.freezeFrames > 0) {
      this.freezeFrames--;
      stop = true;
    } else if (this.slowFrames > 0) {
      // 반 속도. 한 프레임 걸러 한 번만 멈춘다 — 굳지 않고 늘어진다.
      this.slowFrames--;
      this.slowPhase ^= 1;
      stop = this.slowPhase === 1;
    }
    this.freezeLoad += ((stop ? 1 : 0) - this.freezeLoad) * LOAD_K;
    return stop;
  }

  // 히트스톱 요청. **이미 걸린 것을 줄이지 않는다** — 큰 순간이 작은 순간에
  // 잘리면 안 된다. 흔한 이벤트는 간격과 최근 부하를 통과해야만 받아들여진다.
  freeze(n, prio) {
    if (!(n > 0)) return false;
    if (prio !== PR_ALWAYS) {
      const gap = prio === PR_HI ? FREEZE_GAP_HI : FREEZE_GAP;
      const load = prio === PR_HI ? FREEZE_LOAD_HI : FREEZE_LOAD;
      if (this.sinceFreeze < gap) return false;
      if (this.freezeLoad > load) return false;
    }
    if (n > this.freezeFrames) this.freezeFrames = n;
    this.sinceFreeze = 0;
    return true;
  }

  // 슬로모션 — 도발 전용. 히트스톱과 달리 화면이 굳지 않는다.
  slow(n) {
    if (n > this.slowFrames) this.slowFrames = n;
  }

  // 히트스톱 중에도 **연출은 계속 흐른다.** 멈추는 것은 세계이지 불꽃이 아니다.
  // 이걸 안 하면 큰 순간일수록 나빠진다: 진화·해일은 히트스톱이 10~14프레임인데
  // 그동안 파편이 전부 발화점 한 점에 겹쳐 있어서 **폭발이 점 하나로 보였다.**
  // (캡처로 잡았다. 원정 종료 컷에서 붉은 파편 22개가 붉은 점 하나였다)
  stepFrozen() {
    this.tickTimers();
    this.decayShake();
    this.stepFx();
    if (this.flashFrames > 0) this.flashFrames--;
  }

  // 파티클·링·숫자 — 시뮬레이션과 무관한 순수 연출. 얼어 있어도 흐른다.
  stepFx() {
    for (let i = 0; i < C.PARTICLE_MAX; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pX[i] += this.pVX[i];
      this.pY[i] += this.pVY[i];
      this.pVY[i] += C.PART_GRAVITY;      // 화면 좌표라 아래가 +
      this.pLife[i]--;
    }

    for (let i = 0; i < C.RING_MAX; i++) {
      if (this.ringStep[i] < 0) continue;
      this.ringStep[i]++;
      if (this.ringStep[i] > this.ringSteps) this.ringStep[i] = -1;
    }

    for (let i = 0; i < C.FLOAT_MAX; i++) {
      if (this.fStep[i] < 0) continue;
      this.fStep[i]++;
      if (this.fStep[i] > this.fSteps) this.fStep[i] = -1;
    }
  }

  tickTimers() {
    this.t++;
    if (this.denyCd > 0) this.denyCd--;
    if (this.baseRingCd > 0) this.baseRingCd--;
    if (this.foeHitCd > 0) this.foeHitCd--;
    if (this.streakGap > 0) { this.streakGap--; if (this.streakGap === 0) this.streak = 0; }
  }

  decayShake() {
    if (this.shakeMag > SHAKE_FLOOR) {
      this.shakeX = (Math.random() * 2 - 1) * this.shakeMag;
      this.shakeY = (Math.random() * 2 - 1) * this.shakeMag;
      this.shakeA = (Math.random() * 2 - 1) * this.shakeRotMag;
      this.shakeMag *= C.SHAKE_DECAY;
      this.shakeRotMag *= C.SHAKE_DECAY;
    } else {
      this.shakeMag = 0; this.shakeRotMag = 0;
      this.shakeX = 0; this.shakeY = 0; this.shakeA = 0;
    }
  }

  step(game) {
    this.tickTimers();
    this.decayShake();
    if (this.flashFrames > 0) this.flashFrames--;
    if (this.bannerFrames > 0) this.bannerFrames--;

    this.stepFx();

    if (game && game.state === S.OVER) {
      if (this.resultStep < this.resultSteps) this.resultStep++;
    } else this.resultStep = -1;
  }

  addShake(mag, rot) {
    if (mag > this.shakeMag) this.shakeMag = mag;
    if (rot > this.shakeRotMag) this.shakeRotMag = rot;
  }

  // 파티클 하나. **모든 연출이 이 한 곳을 지난다** — 링버퍼라 넘치면 조용히
  // 덮어쓴다. 여기서 객체·배열·문자열을 만들지 않는다.
  push1(x, y, vx, vy, size, life, kind) {
    const i = this.pNext;
    this.pNext = (this.pNext + 1) % C.PARTICLE_MAX;
    this.pX[i] = x;
    this.pY[i] = y;
    this.pVX[i] = vx;
    this.pVY[i] = vy;
    this.pLife[i] = life;
    this.pMax[i] = life;
    this.pSize[i] = size;
    this.pKind[i] = kind;
  }

  burst(x, y, n, kind) {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const sp = 1.4 + Math.random() * 2.6;
      this.push1(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 1.4,
                 3 + Math.random() * 3, C.PART_LIFE, kind);
    }
  }

  // 튜닝 가능한 분출 — 속도·수명·크기를 부르는 쪽이 정한다.
  // 잦은 연출은 작고 짧게, 드문 연출은 크고 길게. 그게 대비를 만든다.
  //
  // **한 점에서 시작하지 않는다.** 파편을 전부 같은 좌표에 두면 히트스톱이
  // 걸린 첫 프레임에 점 하나로 겹쳐 보인다. 처음부터 작은 고리로 벌려 둔다.
  spray(x, y, n, kind, spd, up, life, size) {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.7;
      const s = spd * (0.55 + Math.random() * 0.9);
      const r = s * 1.6;
      this.push1(x + Math.cos(a) * r, y + Math.sin(a) * r,
                 Math.cos(a) * s, Math.sin(a) * s - up,
                 size * (0.7 + Math.random() * 0.6), life, kind);
    }
  }

  ring(x, y) {
    const i = this.ringNext;
    this.ringNext = (this.ringNext + 1) % C.RING_MAX;
    this.ringX[i] = x;
    this.ringY[i] = y;
    this.ringStep[i] = 0;
  }

  float(x, y, val, kind) {
    const i = this.fNext;
    this.fNext = (this.fNext + 1) % C.FLOAT_MAX;
    this.fX[i] = x;
    this.fY[i] = y;
    this.fVal[i] = val | 0;
    this.fKind[i] = kind;
    this.fStep[i] = 0;
  }

  banner(code) {
    this.bannerCode = code;
    this.bannerFrames = this.bannerTotal;
  }

  // 실패한 입력 — **눌렀는데 아무 일도 안 일어나는 것이 가장 나쁘다.**
  // 화면은 흔들지 않고 멈추지도 않는다. 실패는 힘이 아니다.
  // 누른 버튼 위에서 작게 튕겨 나가고 곧바로 사라진다.
  deny(btn, kind) {
    if (this.denyCd > 0) return;
    this.denyCd = DENY_GAP;
    // 어느 버튼인지 확실할 때만 그 자리를 쓴다. 아니면 진화·포탑·스킬 쪽.
    const i = btn | 0;
    const x = (Number.isInteger(btn) && i >= 0 && i < this.btnCX.length)
      ? this.btnCX[i] : this.btnCXOther;
    // 위로 벌어지는 부채꼴. 작은 점 넷을 겹쳐 뿌리면 눈에 안 들어온다 —
    // 실측(캡처)으로 확인하고 각도를 벌리고 크기를 키웠다.
    for (let k = 0; k < PART_DENY; k++) {
      const t = PART_DENY > 1 ? k / (PART_DENY - 1) : 0.5;
      const ang = -Math.PI * (0.80 - 0.60 * t);
      const s = 2.0 + Math.random() * 1.5;
      this.push1(x, DENY_Y, Math.cos(ang) * s, Math.sin(ang) * s,
                 5.2 + Math.random() * 2, DENY_LIFE, kind);
    }
  }

  // ── 이벤트 → 감촉 ───────────────────────────────────────────
  onEvent(type, a, b, game) {
    switch (type) {
      case EV.SPAWN: {
        // 성공한 입력. **내 것이 적 것보다 잘 보여야 한다** — 이게 내 손의 결과다.
        // 파티클은 흰·금·붉음 셋뿐이라 적을 적색으로 칠하면 위협 신호와 섞인다.
        // 그래서 색이 아니라 **높이와 수명**으로 가른다: 내 것은 튀어오르고,
        // 적 것은 발밑에서 낮게 쓸린다.
        const mine = b === SIDE_L;
        const x = mine ? C.SPAWN_L_X : C.SPAWN_R_X;
        if (mine) this.spray(x, gy(x) - 8, PART_SPAWN, 0, 1.6, 2.0, 24, 3.2);
        else this.spray(x, gy(x) - 5, PART_SPAWN - 1, 0, 1.3, 0.6, 17, 2.4);
        break;
      }

      case EV.ATTACK:
        // **비워 둔다.** 평타는 render 의 피격 플래시·공격 모션과 audio 의
        // 타격음이 이미 말한다. 여기서 화면까지 흔들면 상시 진동이 되어
        // (실측: 흔들린 프레임 66.9%) 정작 큰 타격의 대비가 사라진다.
        break;

      case EV.KILL: {
        // 큰 것이 죽는 것과 검사가 죽는 것이 같으면 처치는 의미가 없다.
        // 그리고 **내가 잡은 것과 내 것이 죽은 것이 같아도 안 된다** (b = 잡은 진영).
        const mine = b === SIDE_L;
        // a 가 null·NaN·범위 밖으로 와도 무게는 항상 유효한 수여야 한다.
        // (null >= 0 은 true 라 범위 검사만으로는 안 걸러진다 — 실측으로 잡았다)
        const w = num(this.killW[a | 0], 0.4);
        const fx = this.frontline(game);
        const x = fx + (Math.random() * 2 - 1) * 20;     // 한 점에 쌓이지 않게
        const n = 3 + ((w * 9) | 0);
        this.spray(x, gy(x) - 16, n, mine ? 1 : 2,
                   1.8 + w * 1.6, 1.5, C.PART_LIFE, 3 + w * 2);
        // 잡졸은 화면을 흔들지 않는다. 무게가 있는 것만 손에 온다.
        if (w >= 0.3) this.addShake(C.SHAKE_KILL * (0.45 + 0.55 * w), 0);
        // 히트스톱은 **내가 만든 충격**에만 건다.
        // 내 유닛이 죽은 것에 히트스톱을 걸면 손해가 성취처럼 찍힌다.
        //
        // 실측이 설계를 바꿨다: 상성 우위 타격 167회 중 **151회가 적의 것**이었다
        // (150초 · 전형적 판). 즉 "제대로 먹혔다"의 구두점을 상성 타격에만 맡기면
        // 잘 싸우는 판에서도 거의 안 울린다. 그래서 **내 처치도 리듬을 나눠 진다.**
        // 매번이 아니라 예산이 허락할 때만 — 난전이면 governor 가 알아서 솎는다.
        if (mine) this.freeze(2 + ((C.HITSTOP_KILL * w) | 0), w >= 0.6 ? PR_HI : PR_LOW);
        break;
      }

      case EV.BASE_HIT: {
        // **이기고 있다는 가장 큰 신호.** 내가 맞는 것과 내가 때리는 것이
        // 같은 느낌이면 판이 어느 쪽으로 가는지 손으로 알 수 없다.
        const mine = b === SIDE_L;
        const bx = mine ? C.BASE_L_X : C.BASE_R_X;
        const top = gy(bx) - C.BASE_H;
        this.freeze(C.HITSTOP_BASE, PR_HI);
        this.addShake(C.SHAKE_BASE * (mine ? 1.2 : 0.95), 0);
        this.float(bx, top - 24, a, 0);
        // 벽에서 파편이 튄다. 내 성이면 붉게(피해), 적 성이면 금빛(성과).
        this.spray(bx + (mine ? 44 : -44), top + C.BASE_H * 0.45,
                   mine ? 6 : 5, mine ? 2 : 1, 2.4, 0.8, 26, 3.4);
        // 적 성이 깎이는 링은 이 게임에서 가장 반가운 그림이다.
        // 다만 전선이 성에 붙으면 초당 여러 번 나므로 간격을 둔다.
        if (!mine && this.baseRingCd <= 0) {
          this.baseRingCd = BASE_RING_GAP;
          this.ring(bx, top + C.BASE_H * 0.5);
        }
        break;
      }

      case EV.ERA_UP:
        if (b === SIDE_L) {
          // 판을 바꾸는 순간. 예산을 무시하고 확실히 건다.
          this.freeze(C.HITSTOP_ERA, PR_ALWAYS);
          this.addShake(C.SHAKE_ERA, 0);
          this.flashFrames = C.FLASH_FRAMES;
          this.ring(C.BASE_L_X, gy(C.BASE_L_X) - C.BASE_H * 0.5);
          this.spray(C.BASE_L_X, gy(C.BASE_L_X) - C.BASE_H * 0.5,
                     C.PART_ERA, 1, 3.2, 2.2, C.PART_LIFE, 4);
          this.banner(C.BAN_ERA);
        } else {
          // **적이 진화한 것도 판이 바뀐 것이다.** 지금까지 이건 아무 감촉도
          // 없었다 — 갑자기 안 죽는 적을 만나는데 이유가 손에 안 왔다.
          // 밝게 축하하지 않고 서늘하게 알린다: 붉은 파편과 낮은 흔들림.
          this.freeze(C.HITSTOP_BASE, PR_HI);
          this.addShake(C.SHAKE_ERA * 0.5, 0);
          this.ring(C.BASE_R_X, gy(C.BASE_R_X) - C.BASE_H * 0.5);
          this.spray(C.BASE_R_X, gy(C.BASE_R_X) - C.BASE_H * 0.5,
                     (C.PART_ERA * 0.5) | 0, 2, 2.6, 1.6, C.PART_LIFE, 3.4);
        }
        break;

      case EV.TOWER_FIRE:
        // **비워 둔다.** 포탑은 자주 쏘고, render 가 이미 포신 섬광과 탄도를
        // 그린다. 여기 셰이크를 두면 수비형 플레이가 상시 진동이 된다.
        break;

      case EV.TOWER_UP: {
        // **적 진영에서는 이 이벤트가 오지 않는다** — game.js 가 일부러 안 쏜다
        // (디렉터가 진영 구분 없이 "기지에 쓴 금"으로 세기 때문). 그래도 자리는
        // 진영으로 잡는다. 언젠가 오더라도 내 성에서 터지지는 않게.
        const mine = b !== 1;
        const bx = mine ? C.BASE_L_X : C.BASE_R_X;
        this.freeze(C.HITSTOP_ERA, mine ? PR_ALWAYS : PR_HI);
        this.addShake(C.SHAKE_ERA * (mine ? 1 : 0.5), 0);
        this.ring(bx, gy(bx) - C.BASE_H);
        this.spray(bx, gy(bx) - C.BASE_H,
                   (C.PART_ERA * 0.7) | 0, mine ? 1 : 2, 2.8, 2.4, C.PART_LIFE, 3.6);
        break;
      }

      case EV.COUNTER_HIT: {
        // ── 이 게임의 핵심 보상 ──
        // 상성이 맞아떨어진 타격이다. "제대로 먹혔다"가 손에 와야 한다.
        // 그런데 난전에서는 초당 수십 번 난다. 매번 히트스톱을 걸면
        // 화면이 계속 굳는다(실측 근거는 파일 머리에 있다).
        //
        // 그래서 **둘로 나눈다.**
        //   매번  : 전선에 금빛 불꽃이 튄다. 국소적이라 눈이 그리로 가고
        //           아무리 잦아도 화면은 조용하다
        //   구두점: 예산이 허락하는 순간에만 진짜 히트스톱 + 셰이크가 걸린다.
        //           연쇄가 길수록 그 한 방이 커진다 — 난전이 리듬을 얻는다
        //
        // **b 는 때린 진영이다.** 적이 나를 상성으로 때린 것에 같은 감촉을 주면
        // 정반대 신호가 된다 — 얻어맞는 순간이 보상처럼 찍힌다.
        // 디렉터는 플레이어 구성을 읽고 카운터를 뽑는다(계약 §5.5). 그건
        // **아파야** 한다: 붉은 파편과 짧은 충격, 히트스톱은 없다.
        const mine = b === SIDE_L;
        const fx = this.frontline(game);
        const x = fx + (Math.random() * 2 - 1) * 16;
        const y = gy(x) - 22;
        if (!mine) {
          this.spray(x, y, 2, 2, 2.2, 1.0, 20, 3);
          if (this.foeHitCd <= 0) {
            this.foeHitCd = FOE_HIT_GAP;
            this.addShake(SHAKE_COUNTER * 0.7, 0);
            this.spray(x, y, 4, 2, 3.0, 1.4, 24, 3.4);
          }
          break;
        }
        this.streak++;
        this.streakGap = STREAK_HOLD;
        this.spray(x, y, 2, 1, 2.2, 1.2, 20, 3);
        if (this.freeze(HITSTOP_COUNTER, PR_LOW)) {
          const s = this.streak > 8 ? 8 : this.streak;
          this.addShake(SHAKE_COUNTER * (1 + s * 0.07), 0);
          this.spray(x, y, 5, 1, 3.4, 2.0, 26, 3.6);
        }
        break;
      }

      case EV.SKILL: {
        // 셋이 서로 다르게 느껴져야 한다. 해일이 가장 무겁다.
        // 그리고 **내가 쓴 것과 적이 쓴 것이 같으면 안 된다** — 같은 해일도
        // 내 것이면 성과이고 적 것이면 재난이다.
        const mine = b === SIDE_L;
        if (a === 0) {
          // 해일. 플레이어 경로는 EV.SKILL 과 EV.NUKE 를 **둘 다** 낸다.
          // 예전에는 그래서 링 2개·파티클 80개가 겹쳐 풀을 통째로 갈아엎었다.
          this.tide(mine);
        } else if (a === 1) {
          this.freeze(C.HITSTOP_BASE, PR_ALWAYS);
          this.addShake(C.SHAKE_BASE * 1.4, 0);
          const fx = this.frontline(game);
          this.spray(fx, gy(fx) - 50, C.PART_KILL * 2, mine ? 1 : 2,
                     2.6, 3.4, C.PART_LIFE, 3.4);
        } else {
          const sx = mine ? C.SPAWN_L_X : C.SPAWN_R_X;
          this.addShake(C.SHAKE_ERA * 0.6, 0);
          this.spray(sx, gy(sx) - 16, C.PART_ERA, mine ? 0 : 2,
                     2.2, 2.6, C.PART_LIFE, 3.2);
        }
        break;
      }

      case EV.NUKE:
        // 해일의 예전 이름. 같은 프레임에 EV.SKILL(0) 이 이미 지나갔으면 중복이다.
        this.tide(true);
        break;

      case EV.WATER_WARN:
        this.banner(C.BAN_WATER);
        this.addShake(C.SHAKE_KILL, 0);
        break;

      case EV.WATER_HIT:
        // 0.5초마다 온다. 예전 값(2.4)은 후반 내내 화면을 떨게 했다.
        // 물은 압박이지 타격이 아니다 — 낮게 깔리는 진동으로 남긴다.
        this.addShake(C.SHAKE_HIT * 0.9, 0);
        break;

      case EV.NO_GOLD:
        // 금이 없다. 붉게 튕긴다.
        this.deny(a, 2);
        break;

      case EV.COOLDOWN:
        // 아직 못 쓴다. 흰색으로 튕긴다 — 실패의 이유가 다르면 색도 다르다.
        this.deny(a, 0);
        break;

      case EV.WIN:
      case EV.LOSE: {
        // 이긴 것과 진 것이 같은 감촉이면 판의 결말이 손에 안 남는다.
        // (원정이 붙어 있으면 뒤이어 STAGE_CLEAR·CAMPAIGN_END 가 색을 더한다.
        //  그 이벤트가 없는 예전 game.js 에서도 여기서 이미 갈린다.)
        const won = type === EV.WIN;
        this.freeze(C.HITSTOP_END, PR_ALWAYS);
        this.addShake(C.SHAKE_END, C.SHAKE_ROT_END);
        // **성벽 위 하늘에서 터뜨린다.** 성벽 안쪽에 뿌리면 흰 성 위의 붉은 파편이
        // 흰 벽에 묻혀 안 보인다 (캡처로 확인했다). 어두운 배경 위여야 읽힌다.
        const bx = won ? C.BASE_R_X : C.BASE_L_X;
        this.spray(bx, gy(bx) - C.BASE_H - 14, 14, won ? 1 : 2,
                   2.8, won ? 3.0 : -0.8, C.PART_LIFE, 3.8);
        this.resultStep = 0;
        break;
      }

      case EV.RESET:
        this.reset();
        break;

      // ── v3 원정 ────────────────────────────────────────────
      case E_STAGE_START: {
        // 새 사령관이 자리에 앉는다. **멈추지도 흔들지도 않는다** —
        // 전투 시작에 히트스톱을 걸면 첫인상이 렉이 된다.
        // 적 성에서 고리 하나가 퍼지는 것으로 족하다. 말은 render 가 한다.
        const bx = C.BASE_R_X;
        this.ring(bx, gy(bx) - C.BASE_H * 0.5);
        break;
      }

      case E_STAGE_CLEAR: {
        // **"다음"이다.** 밝고 짧게 끝난다 — 앞으로 나아가는 느낌.
        const bx = C.BASE_R_X;
        const top = gy(bx) - C.BASE_H;
        this.freeze(C.HITSTOP_ERA, PR_ALWAYS);
        this.addShake(C.SHAKE_ERA, 0);
        this.flashFrames = C.FLASH_FRAMES;
        this.ring(bx, top + C.BASE_H * 0.5);
        this.spray(bx, top + C.BASE_H * 0.5, C.PART_ERA, 1, 3.4, 3.0, C.PART_LIFE, 4);
        break;
      }

      case E_CAMPAIGN_END: {
        // **"끝"이다.** 전투 클리어와 절대 헷갈리면 안 된다.
        // 길게 멈추고, 화면이 기울고(회전은 여기와 승패에만 있다),
        // 고리가 셋이다. 하나는 다음이고 셋은 마지막이다.
        this.freeze(C.HITSTOP_NUKE, PR_ALWAYS);
        const lx = C.BASE_L_X, rx = C.BASE_R_X, mx = C.VIEW_W * 0.5;
        if (b === 1) {
          // 완주. 이 게임에서 가장 밝은 순간이다.
          this.addShake(C.SHAKE_END, C.SHAKE_ROT_END * 1.5);
          this.flashFrames = C.FLASH_FRAMES * 2;
          this.ring(lx, gy(lx) - C.BASE_H * 0.5);
          this.ring(mx, gy(mx) - 60);
          this.ring(rx, gy(rx) - C.BASE_H * 0.5);
          this.spray(lx, gy(lx) - C.BASE_H - 16, C.PART_NUKE, 1, 3.0, 4.4, C.PART_LIFE, 4.2);
        } else {
          // 원정이 여기서 끝났다. **빛이 없다** — 고리도 섬광도 없고
          // 무거운 회전과 붉은 파편이 성벽에서 흘러내린다.
          this.addShake(C.SHAKE_END * 1.15, C.SHAKE_ROT_END * 2);
          this.spray(lx, gy(lx) - C.BASE_H - 18, (C.PART_NUKE * 0.6) | 0, 2,
                     3.0, -1.4, C.PART_LIFE, 4.2);
        }
        break;
      }

      case E_TAUNT:
        // ── AI 가 나를 읽은 순간 ──
        // 이 프로젝트는 AI 활용을 심사받는다. 그 순간이 **손에 느껴져야** 한다.
        // 그런데 전투 중에 나오고 최소 간격이 11초다 — 무겁게 만들면 방해가 된다.
        //
        // 그래서 **멈추지 않고 느려진다.** 0.27초 동안 반 속도로 늘어지고,
        // 화면이 아주 조금 기운다. 회전은 이 게임에서 승패·원정 종료와
        // 여기에만 있다 — 그래서 낯설고, 낯선 것이 서늘하다.
        // 히트스톱 비용은 걸리는 프레임의 절반뿐이다 (16프레임 중 8).
        this.slow(SLOW_TAUNT);
        this.addShake(SHAKE_TAUNT, ROT_TAUNT);
        break;

      default:
        break;
    }
  }

  // 해일 — SKILL(0) 과 NUKE 로 두 번 오는 것을 한 번으로 접는다.
  tide(mine) {
    if (this.t - this.tideAt < 8) return;
    this.tideAt = this.t;
    const x = mine ? C.VIEW_W * 0.62 : C.VIEW_W * 0.38;
    const y = gy(x) - 40;
    this.freeze(C.HITSTOP_NUKE, PR_ALWAYS);
    this.addShake(C.SHAKE_NUKE, 0.01);
    this.ring(x, y);
    this.spray(x, y, C.PART_NUKE, mine ? 1 : 2, 3.6, 3.0, C.PART_LIFE, 4);
    if (mine) {
      // 내가 쓴 것만 이름을 얻는다. 적의 해일은 어둡게 지나간다.
      this.flashFrames = C.FLASH_FRAMES;
      this.banner(C.BAN_NUKE);
    }
  }

  // 전선 — 싸움이 실제로 일어나는 x. 없으면 화면 한가운데로 떨어진다.
  frontline(game) {
    if (game && game.frontlineX) {
      const x = game.frontlineX();
      if (x === x) return x;
    }
    return C.VIEW_W * 0.5;
  }
}
