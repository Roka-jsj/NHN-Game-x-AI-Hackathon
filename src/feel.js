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
//
// ─── 그리고 이번 판: 세기 말고 **모양** ──────────────────────────
// 24.41% 로 내려온 뒤에도 남은 문제가 있었다. 실측(5판×150초):
//   스킬 3종이 전부 addShake 한 채널만 썼다 — 등방 난수 진동이라 **방향이 없고**,
//   해일 16px · 화살비 5px · 증원 4.2px 로 **크기만 달랐다.** 크기가 다른 같은
//   진동은 손으로 구분이 안 된다. 그래서 채널을 셋으로 쪼갰다.
//
//   축(axis)   가로만 / 세로만 / 등방. 해일은 가로로 쓸리고 화살비는 세로로 튄다.
//   결(grain)  방향을 새로 뽑는 주기. 1 = 지지직(화살비), 4~5 = 묵직(해일·재무장).
//   밀림(push) 진동이 아니라 **이동**이다. 용수철로 밀렸다가 되돌아온다.
//              증원은 진동이 0 이고 화면이 위로 솟았다 내려앉는 것만 있다.
//
// 그리고 시간축. 지금까지 모든 연출이 **한 프레임에 다 쏟아졌다.** 화살비는
// 하늘에서 쏟아지는 것인데 한 순간에 터지면 그냥 폭발이다. 그래서 pour 타이머로
// 26프레임에 걸쳐 내리꽂고, 진화의 재무장 1.25초에는 아무것도 없던 자리에
// 굳음(저주파 웅웅거림) → 해방(섬광·솟구침)의 활을 얹었다.
//
// 늘린 만큼 뺐다 — 자주 오는 것에서 정확히 회수했다:
//   내 기지가 맞을 때의 히트스톱 제거 (손해에 구두점을 찍지 않는다)
//   적의 상성 타격 셰이크 축소 + 세로 전용
//   화살비 히트스톱 4 → 2 (쏟아짐은 정지가 아니라 지속이다)

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
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

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
// config 에 이미 있던 이름인데(HITSTOP_HIT) 이 파일에서 여태 아무도 안 썼다 —
// BOSS_HIT 의 freeze() 거버너 문턱으로 그대로 가져다 쓴다.
const HITSTOP_HIT     = num(C.HITSTOP_HIT, 2);
const SHAKE_COUNTER   = num(C.SHAKE_COUNTER, 2.6);
const STREAK_HOLD     = num(C.STREAK_HOLD, 45);       // 연쇄가 끊기는 시간
const FOE_HIT_GAP     = num(C.FOE_HIT_GAP, 20);       // 적에게 당한 상성 타격의 최소 간격
const SELF_HIT_GAP    = num(C.SELF_HIT_GAP, 26);      // 내 성이 맞은 충격의 최소 간격

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

// 스킬 번호. config 이 아직 이름을 안 줬으면 계약의 번호를 쓴다 —
// 이 파일의 다른 상수들과 같은 방어 규칙이다. 스킬이 늘어도 마지막 가지(총진군)로
// 흐를 뿐 깨지지 않는다.
const SK_TIDE   = num(C.SK_TIDE, 0);
const SK_VOLLEY = num(C.SK_VOLLEY, 1);
const SK_RALLY  = num(C.SK_RALLY, 2);

// ── 셰이크의 모양 ────────────────────────────────────────────
// 축. 등방은 예전 그대로다 — 인자를 안 주면 아무것도 안 달라진다.
const AX_ISO = 0, AX_X = 1, AX_Y = 2;
// 억눌리는 쪽의 잔량. 0 으로 죽이면 축이 너무 기계적이라 오히려 어색하다.
const AX_MINOR = num(C.SHAKE_AXIS_MINOR, 0.16);

// ── 밀림 ─────────────────────────────────────────────────────
// 용수철. 임펄스를 주면 밀렸다가 되돌아온다. 실측으로 잡은 값이다 —
// K 0.20 · D 0.72 에서 임펄스 3 이 약 3.8px 까지 밀렸다가 28프레임에 잦아든다.
// 더 무르게(K 0.075) 두면 13px 까지 밀려서 화면이 미끄러지는 것처럼 보인다.
const PUSH_K     = num(C.PUSH_K, 0.20);
const PUSH_D     = num(C.PUSH_DAMP, 0.72);
// 셰이크 바닥(0.25px)과 같은 이유로 자른다. |x|+|y|+|vx|+|vy| 합이라
// 0.45 는 실제 변위 0.2px 언저리다 — DPR 2 에서도 안 보인다.
const PUSH_FLOOR = num(C.PUSH_FLOOR, 0.45);
// 임펄스 상한. 겹쳐 쏴도 화면이 날아가지 않는다. 6 이었는데 3등급 해일(범람)이
// 정확히 6.0 으로 계산되어 상한에 눌렸다 — 그러면 2등급과 지문이 안 갈린다.
const PUSH_MAX   = num(C.PUSH_MAX, 8);

// ── 시간에 걸쳐 쏟아지는 것 ──────────────────────────────────
const POUR_FRAMES  = num(C.POUR_FRAMES, 26);  // 화살비가 내리꽂히는 시간 (0.43초)
const POUR_EVERY   = num(C.POUR_EVERY, 2);
const POUR_SHAKE   = num(C.POUR_SHAKE, 2.1);  // 매번 다시 채워져 지속 진동이 된다
const RISE_FRAMES  = num(C.RISE_FRAMES, 20);  // 증원이 솟는 시간
const SWEEP_FRAMES = num(C.SWEEP_FRAMES, 22); // 총진군이 훑는 시간

// ── 진화의 1.25초 ────────────────────────────────────────────
// game.rearmMs 가 도는 동안이다. 여기서 세지 않고 **그 시계를 읽는다** —
// 사자자리처럼 경직이 없는 판에서는 이 구간이 저절로 사라진다.
const REARM_HUM   = num(C.REARM_HUM, 1.7);    // 굳어 있는 동안의 망치질 한 번
const REARM_BEAT  = num(C.REARM_BEAT, 24);    // 망치질 간격(프레임). 1.25초에 세 번
const REARM_EVERY = num(C.REARM_EVERY, 4);    // 몇 프레임마다 빛이 하나 오르는가

// ── 긴장도 ── 위기가 사건이 아니라 상태로 지속될 때 쓰는 채널.
// 다른 상수들과 이유가 같다: config 가 아직 안 주면 여기 기본값으로 돈다.
const TENSION_BASE_LOW    = num(C.TENSION_BASE_LOW, 0.35);
const TENSION_EMA         = num(C.TENSION_EMA, 0.035);
const TENSION_ON          = num(C.TENSION_ON, 0.12);
const TENSION_VIB_MAX     = num(C.TENSION_VIB_MAX, 0.55);
const TENSION_PULSE_HZ    = num(C.TENSION_PULSE_HZ, 0.045);

// 접근성 — 흔들림과 번쩍임을 줄인다. DOM 이 없는 헤드리스에서는 항상 false 다.
// **끄는 것이 아니라 줄이는 것이다.** 셰이크가 0 이 되면 큰 사건이 아예 안 읽힌다.
const REDUCED = (() => {
  try {
    return !!(globalThis.matchMedia
      && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { return false; }
})();
const RM_SHAKE = num(C.REDUCED_SHAKE, 0.28);

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
const E_SKILL_UP     = num(EV.SKILL_UP, 24);
// EV.ZODIAC(25) 는 **일부러 비워 둔다.** 그 전투의 하늘이 정해진 것은 충격이
// 아니다 — 배경이 바뀌는 것이고 render 의 몫이다. 여기서 화면을 흔들면
// 전투 시작마다 이유 없는 진동이 하나 늘 뿐이다.

// v4 보스 — 다섯 번째 전투(거울)에만, 조건부로 한 번. 보스는 항상 SIDE_R 소유라
// 진영 분기가 필요 없다(TOWER_UP 의 "적 진영에서는 안 온다"류 가드와 달리,
// BOSS_HIT·BOSS_KILL 은 "내가 적에게 좋은 일을 하는 사건"으로 항상 고정이다).
const E_BOSS_WARN      = num(EV.BOSS_WARN, 27);
const E_BOSS_SPAWN     = num(EV.BOSS_SPAWN, 28);
const E_BOSS_SLAM_CAST = num(EV.BOSS_SLAM_CAST, 29);
const E_BOSS_SLAM      = num(EV.BOSS_SLAM, 30);
const E_BOSS_HIT       = num(EV.BOSS_HIT, 31);
const E_BOSS_KILL      = num(EV.BOSS_KILL, 32);

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
    // 모양 — 축과 결. render 는 이 값을 안 봐도 된다(shakeX/Y 에 이미 섞여 나간다).
    this.shakeAxis = AX_ISO;
    this.shakeGrain = 1;
    this.grainCd = 0;
    this.grainX = 0; this.grainY = 0; this.grainA = 0;
    this.vibX = 0; this.vibY = 0;
    // 밀림 — 진동과 별개의 채널. 이것만 있고 진동이 0 인 연출이 증원이다.
    this.pushX = 0; this.pushY = 0; this.pushVX = 0; this.pushVY = 0;
    this.reduceMotion = REDUCED;

    // ── 긴장도 ── 물이 가깝거나 기지가 낮을 때 "지속되는" 위기 신호.
    // 0~1 로 스무딩된 상태값이다. render 는 이 값만 읽고 vignette·펄스를 그린다.
    // tensionVibX/Y 는 shakeX/Y 에 더해지는 상시 진동(임펄스 채널과 별개),
    // tensionPulse 는 vignette 알파가 숨쉬는 리듬이다. 셋 다 decayShake 에서
    // 매 프레임(얼어 있어도) 갱신된다 — render.js 의 fx* 필드처럼 지속 상태다.
    this.tension = 0;
    this.tensionVibX = 0; this.tensionVibY = 0;
    this.tensionPulse = 0;

    // 시간에 걸쳐 쏟아지는 연출. 스칼라뿐이라 프레임마다 할당이 없다.
    // 0 화살비 1 증원 2 총진군 — 셋이 동시에 겹치는 판은 없다(쿨다운이 26초 이상).
    this.pourMode = -1;
    this.pourFrames = 0;
    this.pourX = 0;
    this.pourSpan = 0;
    this.pourDir = 1;
    this.pourKind = 1;
    this.pourMag = 0;
    // 화살비의 낙하 구역. 등급이 오르면 전선 → +적 후방 → +중간 셋이 된다.
    // game.js doVolley 와 **같은 값을 같은 식으로** 읽으므로 비가 실제 피해
    // 구역 위에 내린다 — 반경만 넓히는 것과 다르다는 계약이 화면에도 지켜진다.
    this.pourZones = 1;
    this.pourXB = 0; this.pourXC = 0;
    this.pourSpanB = 0;
    this.pourSeq = 0;

    // 진화의 재무장 — game 의 시계를 따라간다.
    this.rearmPrevL = 0; this.rearmPrevR = 0;
    this.rearmArmL = 0; this.rearmArmR = 0;

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
    this.selfHitCd = 0;      // 내 성이 맞은 충격 최소 간격
    this.tideAt = -1e6;      // 해일 중복 방지 (SKILL(0) 과 NUKE 가 같이 온다)
  }

  // 탭 전환 복귀 시 호출. 히트스톱·셰이크가 누적되어 터지는 걸 막는다.
  clearTransient() {
    this.freezeFrames = 0;
    this.slowFrames = 0; this.slowPhase = 0;
    this.freezeLoad = 0; this.sinceFreeze = 1e6;
    this.shakeMag = 0; this.shakeRotMag = 0;
    this.shakeX = 0; this.shakeY = 0; this.shakeA = 0;
    this.shakeAxis = AX_ISO; this.shakeGrain = 1; this.grainCd = 0;
    this.vibX = 0; this.vibY = 0;
    this.pushX = 0; this.pushY = 0; this.pushVX = 0; this.pushVY = 0;
    this.pourMode = -1; this.pourFrames = 0; this.pourZones = 1; this.pourSeq = 0;
    // 재무장은 **비운다.** 탭에서 돌아왔을 때 게임의 rearmMs 는 그대로 돌고 있지만
    // 그 사이 경과를 못 봤으므로 여기서 해방 연출을 터뜨리면 이유 없는 폭발이 된다.
    this.rearmPrevL = 0; this.rearmPrevR = 0;
    this.rearmArmL = 0; this.rearmArmR = 0;
    this.flashFrames = 0;
    this.bannerFrames = 0;
    this.streak = 0; this.streakGap = 0;
    this.denyCd = 0; this.baseRingCd = 0; this.foeHitCd = 0; this.selfHitCd = 0;
    this.tideAt = -1e6;
    // 탭에서 돌아온 순간 옛 위기 값이 그대로 튀어나오면 안 된다 —
    // 다음 프레임에 updateTension() 이 실제 게임 상태에서 다시 채운다.
    this.tension = 0; this.tensionVibX = 0; this.tensionVibY = 0; this.tensionPulse = 0;
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

  // 시간에 걸쳐 쏟아지는 연출. **얼어 있어도 흐른다** — 화살비의 히트스톱
  // 두 프레임 동안 화살이 멈춰 있으면 그건 쏟아짐이 아니라 정지 화면이다.
  //
  // 지금까지 스킬 셋은 전부 "한 프레임에 다 터진다"였다. 그래서 크기만 달랐고
  // 성격이 없었다. 여기서 성격이 갈린다 —
  //   화살비 위에서 아래로, 26프레임 동안, 세로로 지지직거리며
  //   증원   아래에서 위로, 20프레임 동안, 진동 없이
  //   총진군 뒤에서 앞으로, 22프레임 동안, 전열을 훑으며
  stepPour() {
    if (this.pourFrames <= 0) return;
    this.pourFrames--;
    const f = this.pourFrames;
    const mode = this.pourMode;

    if (mode === 0) {
      // 화살비 — 하늘에서 내리꽂힌다. 착탄점이 매번 다른 x 라 선이 아니라 비가 된다.
      if ((f % POUR_EVERY) === 0) {
        // 등급이 준 자리를 **번갈아** 때린다. 한 구역을 다 채우고 다음으로 가면
        // 세 번의 화살비로 보이고, 번갈아 내리면 한 번의 융단폭격으로 보인다.
        this.pourSeq++;
        const z = this.pourZones > 1 ? (this.pourSeq % this.pourZones) : 0;
        const cx = z === 0 ? this.pourX : (z === 1 ? this.pourXB : this.pourXC);
        const sp = z === 0 ? this.pourSpan : this.pourSpanB;
        const x = cx + (Math.random() * 2 - 1) * sp;
        const g = gy(x);
        this.push1(x, g - 190 - Math.random() * 90, (Math.random() * 2 - 1) * 0.5,
                   6.2 + Math.random() * 2.4, 2.4 + Math.random() * 1.4, 14, this.pourKind);
      }
      // 6프레임마다 다시 채운다. 매 프레임 채우면 그냥 지속 진동(=예산 낭비)이고,
      // 이만큼 띄우면 사이에서 한 번 꺼졌다가 다시 튄다 — **빗방울**이 된다.
      // 세기는 작은데 여러 번 온다. 해일의 한 방과 정반대의 감촉이다.
      if ((f % 6) === 0) this.addShake(this.pourMag, 0, AX_Y, 1);
      return;
    }

    if (mode === 1) {
      // 증원 — 발밑에서 솟는다. 진동을 한 톨도 안 쓴다. 화면이 들렸다 내려앉는
      // 그 한 번(kick)과 이 기둥뿐이다. 흔들리지 않는 것이 이 스킬의 성격이다.
      if ((f & 1) === 0) {
        const x = this.pourX + (Math.random() * 2 - 1) * this.pourSpan;
        this.push1(x, gy(x) - 4, (Math.random() * 2 - 1) * 0.6,
                   -2.6 - Math.random() * 1.6, 2.6 + Math.random() * 1.6, 22, this.pourKind);
      }
      return;
    }

    if (mode === 2) {
      // 총진군 — 전열을 뒤에서 앞으로 훑는다. 시간이 위치를 만든다.
      const t = 1 - f / Math.max(1, SWEEP_FRAMES);
      const x = this.pourX + this.pourDir * this.pourSpan * t;
      if ((f & 1) === 0) {
        this.push1(x, gy(x) - 10 - Math.random() * 22, this.pourDir * (1.6 + Math.random()),
                   -0.8 - Math.random(), 2.4 + Math.random() * 1.4, 18, this.pourKind);
      }
    }
  }

  // 파티클·링·숫자 — 시뮬레이션과 무관한 순수 연출. 얼어 있어도 흐른다.
  stepFx() {
    this.stepPour();

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
    if (this.selfHitCd > 0) this.selfHitCd--;
    if (this.streakGap > 0) { this.streakGap--; if (this.streakGap === 0) this.streak = 0; }
  }

  // ── 긴장도 갱신 — 사건이 아니라 상태를 잰다 ─────────────────────
  // game.js 가 이미 계약해 둔 두 조회를 그대로 쓴다: waterNear()(물이 지면에
  // 얼마나 가까운가, EV.WATER_WARN 과 같은 기준선)와 baseK(내 기지 체력비).
  // 새 계산식을 만들지 않는다 — 메인이 이미 "위기"를 이 두 숫자로 정의해
  // 뒀으므로 여기서 또 다른 기준을 만들면 화면과 판정이 서로 다른 위기를
  // 말하게 된다. 더 급한 쪽(max)이 이긴다 — 물이 안전해도 기지가 위태로우면
  // 여전히 위기다.
  //
  // EMA 로 스무딩하는 이유: waterNear() 는 해일 한 방으로 프레임 안에 훅
  // 뛰기도 한다. 순간값을 그대로 쓰면 긴장도가 다른 셰이크 채널처럼
  // 사건마다 깜빡였다가 꺼진다 — 그러면 "지속되는 압력"이라는 이 채널의
  // 존재 이유가 없어진다. 드래프트·결과 화면에서는 0으로 가라앉는다
  // (state !== PLAY) — 위기는 전투 중에만 뜻이 있다.
  updateTension(game) {
    if (!game) return;
    const live = game.state === S.PLAY;
    const waterSig = live && typeof game.waterNear === 'function' ? game.waterNear() : 0;
    const baseK = live && typeof game.baseK === 'function' ? game.baseK(SIDE_L) : 1;
    const baseSig = live ? clamp((TENSION_BASE_LOW - baseK) / TENSION_BASE_LOW, 0, 1) : 0;
    const raw = waterSig > baseSig ? waterSig : baseSig;
    this.tension += (raw - this.tension) * TENSION_EMA;
  }

  decayShake() {
    // ── 밀림 ── 용수철이라 밀렸다가 되돌아온다. 진동과 더해져 나간다.
    if (this.pushX !== 0 || this.pushY !== 0 || this.pushVX !== 0 || this.pushVY !== 0) {
      this.pushVX = (this.pushVX - this.pushX * PUSH_K) * PUSH_D;
      this.pushVY = (this.pushVY - this.pushY * PUSH_K) * PUSH_D;
      this.pushX += this.pushVX;
      this.pushY += this.pushVY;
      const e = Math.abs(this.pushX) + Math.abs(this.pushY)
              + Math.abs(this.pushVX) + Math.abs(this.pushVY);
      if (e < PUSH_FLOOR) { this.pushX = 0; this.pushY = 0; this.pushVX = 0; this.pushVY = 0; }
    }

    if (this.shakeMag > SHAKE_FLOOR) {
      // ── 결 ── grain 프레임마다 한 번만 방향을 새로 뽑는다.
      // 매 프레임 뽑으면 세기와 무관하게 전부 "지지직"이 된다 — 그게 지금까지
      // 해일과 화살비가 구분이 안 되던 이유다. 방향을 붙들고 있으면 같은 세기라도
      // **쓸린다**. 크기가 아니라 여기서 무게가 나온다.
      if (this.grainCd <= 0) {
        this.grainCd = this.shakeGrain;
        this.grainX = Math.random() * 2 - 1;
        this.grainY = Math.random() * 2 - 1;
        this.grainA = Math.random() * 2 - 1;
      }
      this.grainCd--;
      const ax = this.shakeAxis;
      this.vibX = this.grainX * this.shakeMag * (ax === AX_Y ? AX_MINOR : 1);
      this.vibY = this.grainY * this.shakeMag * (ax === AX_X ? AX_MINOR : 1);
      this.shakeA = this.grainA * this.shakeRotMag;
      this.shakeMag *= C.SHAKE_DECAY;
      this.shakeRotMag *= C.SHAKE_DECAY;
    } else {
      this.shakeMag = 0; this.shakeRotMag = 0;
      this.vibX = 0; this.vibY = 0; this.shakeA = 0;
    }

    // ── 긴장도 진동 ── 임펄스(vibX/Y)·밀림(pushX/Y)과 별개의 세 번째 채널.
    // 감쇠하지 않는다 — tension 이 유지되는 한 계속 산다. 그래서 addShake 의
    // 상한 로직(더 센 쪽이 가져간다)을 안 거친다. sin 조합을 쓰는 이유는
    // Math.random 매 프레임 재추첨은 SHAKE_FLOOR 를 만든 이유(눈에 안 보이는
    // 소수점 진동이 매 프레임 캔버스를 다시 래스터한다)를 그대로 재현하기
    // 때문이다 — 결정론적 sin 은 같은 문제를 안 만들면서도 "잔물결"로 읽힌다.
    // TENSION_ON 문턱 아래에서는 아예 0 — 안 보이는 떨림은 렉일 뿐이다.
    if (this.tension > TENSION_ON) {
      const tv = (this.tension - TENSION_ON) / (1 - TENSION_ON) * TENSION_VIB_MAX;
      const vx = Math.sin(this.t * 0.19) * tv;
      const vy = Math.sin(this.t * 0.13 + 1.7) * tv * 0.55;
      this.tensionVibX = Math.abs(vx) > SHAKE_FLOOR ? vx : 0;
      this.tensionVibY = Math.abs(vy) > SHAKE_FLOOR ? vy : 0;
    } else {
      this.tensionVibX = 0; this.tensionVibY = 0;
    }
    // 비네트가 숨쉬는 리듬. 0.65~1.00 사이에서 진동해 트로프에서도 완전히
    // 안 꺼진다 — 위기가 깜빡이는 것이 아니라 "계속 있다"고 읽혀야 한다.
    this.tensionPulse = this.tension * (0.65 + 0.35 * Math.sin(this.t * TENSION_PULSE_HZ));

    this.shakeX = this.vibX + this.pushX + this.tensionVibX;
    this.shakeY = this.vibY + this.pushY + this.tensionVibY;
    if (this.reduceMotion) {
      // 줄이되 없애지는 않는다. 회전만 완전히 뺀다 — 기울어지는 화면이 가장 나쁘다.
      this.shakeX *= RM_SHAKE; this.shakeY *= RM_SHAKE; this.shakeA = 0;
    }
  }

  step(game) {
    this.updateTension(game);
    this.tickTimers();
    this.decayShake();
    if (this.flashFrames > 0) this.flashFrames--;
    if (this.bannerFrames > 0) this.bannerFrames--;

    this.stepFx();
    this.stepRearm(game);

    if (game && game.state === S.OVER) {
      if (this.resultStep < this.resultSteps) this.resultStep++;
    } else this.resultStep = -1;
  }

  // ── 진화의 1.25초 ───────────────────────────────────────────
  // 사용자가 진화에 대해 "큰 변화가 없다"고 세 번 말했다. 코드를 읽어 보니
  // 이유가 명확했다: **진화의 실체는 순간이 아니라 1.25초짜리 구간인데**
  // (promoteArmy 가 살아 있는 병력을 통째로 승격시키고 그 대가로 굳힌다),
  // 지금까지 이 구간에는 그림도 소리도 감촉도 하나도 없었다.
  // render 는 rearmMs 를 아예 안 읽고, feel 은 시작 프레임에 한 번 치고 끝났다.
  // 그래서 진화는 "잠깐 반짝하고 숫자가 바뀌는 것"이었다.
  //
  // 여기서 그 구간에 활을 얹는다. 충격 → **굳음** → 해방.
  // 굳음이 있어야 해방이 있다. 이 파일의 원칙 그대로다 — 더한 만큼 뺀다.
  //
  // **시계를 여기서 세지 않는다.** game.rearmMs 를 읽는다. 그래야 사자자리처럼
  // 경직이 없는 판에서 이 구간이 저절로 사라지고, 드래프트로 시계가 멈춰 있는
  // 동안(진화 직후 특성 선택) 연출도 같이 기다린다.
  stepRearm(game) {
    if (!game) return;
    const playing = game.state === S.PLAY;
    this.rearmSide(+game.rearmMs || 0, 0, playing);
    this.rearmSide(+game.aiRearmMs || 0, 1, playing);
  }

  rearmSide(ms, side, playing) {
    const mine = side === 0;
    const prev = mine ? this.rearmPrevL : this.rearmPrevR;
    if (mine) this.rearmPrevL = ms; else this.rearmPrevR = ms;
    // ERA_UP 을 직접 본 재무장만 연출한다. 탭 복귀나 다른 경로로 rearmMs 가
    // 이미 돌고 있던 것을 주워서 터뜨리면 이유 없는 폭발이 된다.
    if (mine ? !this.rearmArmL : !this.rearmArmR) return;

    if (ms > 0) {
      if (!playing) return;         // 드래프트 화면 위에서 화면을 흔들지 않는다
      if (mine) {
        // 굳어 있다. **저주파 웅웅거림** — 세기 1px 이하인데 결이 5프레임이라
        // 진동이 아니라 눌린 것처럼 느껴진다. 그리고 병력에서 빛이 하나씩 오른다.
        // **상시 진동으로 두면 안 된다.** 처음엔 3프레임마다 채워 넣었는데
        // 실측에서 진화 한 번이 흔들린 프레임을 75개씩 만들어 냈다(41회 → 3075).
        // 그리고 감촉도 틀렸다 — 굳어 있는 것은 떠는 것이 아니다.
        // 0.4초 간격의 **망치질 세 번**으로 바꿨다. 사이가 조용해야 두들김이 산다.
        // 밀림도 안 쓴다 — 밀림의 꼬리(28프레임)가 망치질 사이의 침묵을
        // 그대로 메워 버린다. 사이가 조용해야 두들김이 두들김으로 들린다.
        if ((this.t % REARM_BEAT) === 0) this.addShake(REARM_HUM, 0, AX_Y, 6);
        if ((this.t % REARM_EVERY) === 0) {
          const x = C.SPAWN_L_X + Math.random() * (C.VIEW_W * 0.5 - C.SPAWN_L_X);
          this.push1(x, gy(x) - 6, 0, -1.8 - Math.random(), 2.2 + Math.random(), 26, 1);
        }
      } else {
        // **적이 굳어 있는 것은 내 기회다** (game.js 의 계약 주석 그대로).
        // 그러니 내 화면을 흔들지 않는다 — 흔들리는 것은 위협의 언어다.
        // 저쪽 전열 위로 붉은 것이 내려앉는 것만 보인다.
        if ((this.t % REARM_EVERY) === 0) {
          const x = C.VIEW_W * 0.5 + Math.random() * (C.SPAWN_R_X - C.VIEW_W * 0.5);
          this.push1(x, gy(x) - 70 - Math.random() * 30, 0, 1.6 + Math.random(),
                     2.2 + Math.random(), 24, 2);
        }
      }
      return;
    }

    // ── 해방 ── 굳었던 것이 풀린다. 진화의 진짜 순간은 여기다.
    if (mine) this.rearmArmL = 0; else this.rearmArmR = 0;
    // 경직이 아예 없던 판(사자자리·ERA_PROMOTE 꺼짐)에는 풀릴 것도 없다.
    if (prev <= 0) return;
    if (mine) {
      // 위로 솟는다. 진화는 커지는 것이니 화면도 커지는 쪽으로 움직여야 한다.
      this.freeze(Math.max(2, (C.HITSTOP_ERA * 0.6) | 0), PR_ALWAYS);
      this.addShake(C.SHAKE_ERA * 0.85, 0, AX_Y, 2);
      this.kick(0, -3.6);
      this.flash(C.FLASH_FRAMES);
      const fx = C.VIEW_W * 0.34;
      this.ring(fx, gy(fx) - 46);
      // 전열 전체에서 오른다. 한 점에서 터지면 "기지가 폭발했다"로 읽힌다 —
      // 승격된 것은 기지가 아니라 **나가 있는 병력**이다.
      const n = (C.PART_ERA * 0.8) | 0;
      for (let k = 0; k < n; k++) {
        const x = C.SPAWN_L_X + (k / n) * (C.VIEW_W * 0.52 - C.SPAWN_L_X)
                + (Math.random() * 2 - 1) * 12;
        this.push1(x, gy(x) - 8, (Math.random() * 2 - 1) * 0.9,
                   -3.4 - Math.random() * 1.8, 3.2 + Math.random() * 1.6, C.PART_LIFE, 1);
      }
    } else {
      // 적이 풀렸다. 멈추지 않는다 — 손해에 구두점을 찍지 않는다.
      // 대신 화면이 **내 쪽으로 밀린다.** 저쪽이 한 발 앞으로 나온 감촉이다.
      this.addShake(C.SHAKE_ERA * 0.4, 0, AX_X, 4);
      this.kick(-2.4, 0);
      const n = (C.PART_ERA * 0.4) | 0;
      for (let k = 0; k < n; k++) {
        const x = C.VIEW_W * 0.52 + (k / n) * (C.SPAWN_R_X - C.VIEW_W * 0.52)
                + (Math.random() * 2 - 1) * 12;
        this.push1(x, gy(x) - 8, (Math.random() * 2 - 1) * 0.9,
                   -2.2 - Math.random(), 2.8 + Math.random(), C.PART_LIFE, 2);
      }
    }
  }

  // 셰이크 요청. **모양은 더 센 쪽이 가져간다** — 작은 진동이 큰 사건의 결을
  // 덮어쓰면 히트스톱 거버너를 둔 이유가 그대로 사라진다.
  // axis·grain 을 안 주면 예전과 완전히 같은 등방 진동이다.
  addShake(mag, rot, axis, grain) {
    if (mag > this.shakeMag) {
      this.shakeMag = mag;
      this.shakeAxis = axis === undefined ? AX_ISO : (axis | 0);
      this.shakeGrain = grain > 1 ? (grain | 0) : 1;
      this.grainCd = 0;                    // 새 결은 다음 프레임에 바로 시작한다
    }
    if (rot > this.shakeRotMag) this.shakeRotMag = rot;
  }

  // 밀림 임펄스. 화면이 그쪽으로 밀렸다가 되돌아온다.
  // 진동이 아니므로 **얼마나 자주 오는가**보다 **어느 쪽인가**가 읽힌다.
  kick(dx, dy) {
    let vx = this.pushVX + dx, vy = this.pushVY + dy;
    if (vx > PUSH_MAX) vx = PUSH_MAX; else if (vx < -PUSH_MAX) vx = -PUSH_MAX;
    if (vy > PUSH_MAX) vy = PUSH_MAX; else if (vy < -PUSH_MAX) vy = -PUSH_MAX;
    this.pushVX = vx; this.pushVY = vy;
  }

  // 화면 섬광. reduced-motion 이면 절반만 — 번쩍임은 움직임보다 더 직접적이다.
  flash(n) {
    const v = this.reduceMotion ? (n * 0.5) | 0 : n | 0;
    if (v > this.flashFrames) this.flashFrames = v;
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
        // 문턱을 0.3 → 0.45 로 올렸다: 처치는 초당 여러 번 나는 사건이고
        // (실측 774회/750초, 그중 208회가 흔들었다) 중간 무게까지 흔들면
        // 그 진동이 스킬·진화의 자리를 먼저 먹는다.
        // 그리고 **축을 가른다** — 내가 잡은 것은 가로로 치고(때린 방향이 있다),
        // 내 것이 죽은 것은 세로로 눌린다(맞은 것에는 방향이 없다).
        if (w >= 0.45) {
          this.addShake(C.SHAKE_KILL * (mine ? 0.45 + 0.55 * w : 0.3 + 0.4 * w), 0,
                        mine ? AX_X : AX_Y, mine ? 2 : 3);
        }
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
        // ── 여기가 셰이크 예산의 진짜 구멍이었다 ──
        // 실측(5판×150초): BASE_HIT 612회 중 541회가 적 성 타격이고, 전선이
        // 성에 붙으면 **초당 여러 번** 난다. 매번 4.75px 를 넣으면 감쇠 꼬리가
        // 18프레임이라 서로 이어 붙어 사실상 상시 진동이 된다 —
        // 66.9% 사고 때 EV.ATTACK 이 한 짓과 정확히 같은 구조다.
        // 링에는 이미 간격(BASE_RING_GAP)이 있었는데 셰이크에는 없었다.
        //
        // 그래서 COUNTER_HIT 과 같은 처방을 쓴다: **매번 파편, 가끔 충격.**
        // 숫자와 파편은 매번 나가므로 "얼마나 때렸는가"는 그대로 읽힌다.
        const punct = mine ? (this.selfHitCd <= 0) : (this.baseRingCd <= 0);
        if (mine) {
          // **내 성이 맞은 것에는 히트스톱을 걸지 않는다.** 히트스톱은
          // "제대로 먹혔다"의 문장부호다 — 손해에 찍으면 얻어맞는 순간이
          // 성취처럼 읽힌다. 대신 **위아래로 눌린다**: 세로 전용에 결이 굵어서
          // 때리는 쪽의 가로 충격과 축이 다르다.
          if (punct) {
            this.selfHitCd = SELF_HIT_GAP;
            this.addShake(C.SHAKE_BASE * 0.85, 0, AX_Y, 3);
          }
        } else if (punct) {
          this.freeze(C.HITSTOP_BASE, PR_HI);
          this.addShake(C.SHAKE_BASE * 0.7, 0, AX_X, 2);
        }
        // **여기에 kick 을 쓰지 않는다.** 밀림은 이 파일에서 가장 드문 채널로
        // 남겨 둔다 — 스킬·진화·승패에만 있다. 기지 타격처럼 초당 여러 번 오는
        // 것에 붙이면 밀림이 상시가 되고, 그러면 해일이 밀어내는 것도 안 읽힌다.
        // (실측: 붙였을 때 카메라 오프셋 프레임이 28.84% → 32.25% 로 올랐다)
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
        // **진화는 순간이 아니라 구간이다.** 여기는 그 구간의 시작일 뿐이고,
        // 굳음과 해방은 stepRearm 이 game.rearmMs 를 따라가며 그린다.
        // 그래서 여기서 다 쏟지 않는다 — 다 쏟으면 뒤의 1.25초가 다시 빈다.
        if (b === SIDE_L) {
          this.rearmArmL = 1;
          this.freeze(C.HITSTOP_ERA, PR_ALWAYS);
          // 아래로 꽂힌다. 해방에서 위로 솟을 것이므로 시작은 반대여야
          // 1.25초가 하나의 활로 읽힌다.
          this.addShake(C.SHAKE_ERA * 0.9, 0, AX_Y, 3);
          this.kick(0, 2.6);
          this.flash(C.FLASH_FRAMES);
          this.ring(C.BASE_L_X, gy(C.BASE_L_X) - C.BASE_H * 0.5);
          this.spray(C.BASE_L_X, gy(C.BASE_L_X) - C.BASE_H * 0.5,
                     (C.PART_ERA * 0.6) | 0, 1, 3.2, 2.2, C.PART_LIFE, 4);
          this.banner(C.BAN_ERA);
        } else {
          // **적이 진화한 것도 판이 바뀐 것이다.** 지금까지 이건 아무 감촉도
          // 없었다 — 갑자기 안 죽는 적을 만나는데 이유가 손에 안 왔다.
          // 밝게 축하하지 않고 서늘하게 알린다. 그리고 히트스톱을 뺐다:
          // 적이 세지는 순간에 내 화면이 멈추면 그건 내 성과의 문법이다.
          this.rearmArmR = 1;
          this.addShake(C.SHAKE_ERA * 0.45, 0, AX_X, 5);
          this.ring(C.BASE_R_X, gy(C.BASE_R_X) - C.BASE_H * 0.5);
          this.spray(C.BASE_R_X, gy(C.BASE_R_X) - C.BASE_H * 0.5,
                     (C.PART_ERA * 0.4) | 0, 2, 2.6, 1.6, C.PART_LIFE, 3.4);
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
        // 포탑은 **올라가는** 것이다. 세로에 밀림도 위로 — 진화의 해방과 같은
        // 언어를 쓴다(둘 다 "내 것이 커졌다"이므로 그래야 맞다).
        this.addShake(C.SHAKE_ERA * (mine ? 1 : 0.5), 0, AX_Y, 3);
        if (mine) this.kick(0, -2.6);
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
            // 예산 회수 지점. 0.7 배 등방 진동이었다 — 세기는 내 것의 70%인데
            // 결이 같아서 **내가 때린 것과 손에서 구분이 안 됐다.**
            // 세로 전용으로 낮게 깔면 세기를 더 줄여도 "맞았다"는 남는다.
            this.addShake(SHAKE_COUNTER * 0.42, 0, AX_Y, 2);
            this.spray(x, y, 4, 2, 3.0, 1.4, 24, 3.4);
          }
          break;
        }
        this.streak++;
        this.streakGap = STREAK_HOLD;
        this.spray(x, y, 2, 1, 2.2, 1.2, 20, 3);
        if (this.freeze(HITSTOP_COUNTER, PR_LOW)) {
          const s = this.streak > 8 ? 8 : this.streak;
          // 내 것은 가로로 친다. 때리는 방향이 있는 충격이다.
          this.addShake(SHAKE_COUNTER * (1 + s * 0.07), 0, AX_X, 2);
          this.spray(x, y, 5, 1, 3.4, 2.0, 26, 3.6);
        }
        break;
      }

      case EV.SKILL: {
        // ── 스킬 셋이 손에서 갈리는 곳 ──
        // 고치기 전 실측: 셋이 전부 addShake 한 채널만 썼고 등방 난수였다.
        // 해일 16px · 화살비 5~7px · 증원 4.2px — **크기만 다른 같은 진동**이라
        // 눈을 감으면 어느 것을 썼는지 알 수 없었다. 그래서 채널을 나눈다.
        //
        //   해일   가로 · 굵은 결 · 한 번에 크게 · 밀어냄       → 무게
        //   화살비 세로 · 잔 결 · 0.43초 동안 계속 · 안 밀림     → 쏟아짐
        //   증원   진동 0 · 위로 밀림 한 번 · 아래서 위로 기둥   → 솟아오름
        //   총진군 진동 0 · 앞으로 밀림 · 전열을 훑는 띠          → 휩쓸림
        //
        // 그리고 **내가 쓴 것과 적이 쓴 것이 같으면 안 된다** — 같은 해일도
        // 내 것이면 성과이고 적 것이면 재난이다. 방향이 그걸 가른다:
        // 내 것은 적 쪽으로, 적 것은 나에게로 밀린다.
        // 그리고 **같은 스킬도 등급이 오르면 다른 것이 되어야 한다.** 해일과
        // 범람은 게임 안에서 다른 일을 한다(0px 미는 것 vs 68px 밀고 넘어뜨리는 것).
        // 등급은 게임에게 묻는다 — 이벤트 인자를 늘리지 않는다(tierOf 주석 참조).
        const mine = b === SIDE_L;
        const dir = mine ? 1 : -1;
        if (a === SK_TIDE) {
          // 해일. 플레이어 경로는 EV.SKILL 과 EV.NUKE 를 **둘 다** 낸다.
          // 예전에는 그래서 링 2개·파티클 80개가 겹쳐 풀을 통째로 갈아엎었다.
          this.tide(mine, this.tierOf(game, SK_TIDE, mine));
        } else if (a === SK_VOLLEY) {
          // 화살비 — 하늘에서 쏟아지는 것을 한 프레임에 터뜨리면 그냥 폭발이다.
          // 히트스톱을 4 → 2 로 줄이고(정지가 아니라 지속이다) 대신 26프레임
          // 동안 세로로 지지직거리며 화살이 계속 떨어진다.
          //
          // **낙하 지점을 game 과 같은 식으로 뽑는다**(doVolley, game.js:829).
          // 등급이 오르면 반경이 아니라 **자리가 는다** — 전선 → +적 후방 → +중간.
          // 후방 낙하는 아직 도착 안 한 증원을 때리는 것이므로, 비가 거기 안 내리면
          // 화면과 판정이 어긋난다.
          const tier = this.tierOf(game, SK_VOLLEY, mine);
          const zones = num(C.VOLLEY_TIER_ZONES && C.VOLLEY_TIER_ZONES[tier], 1);
          const r = num(C.VOLLEY_TIER_R && C.VOLLEY_TIER_R[tier], num(C.VOLLEY_RADIUS, 190));
          const c0 = this.frontline(game);
          const c1 = mine ? C.SPAWN_R_X : C.SPAWN_L_X;    // 적 후방
          const c2 = (c0 + c1) * 0.5;
          this.freeze(2 + tier, mine ? PR_HI : PR_LOW);
          this.pourMode = 0;
          // 자리가 늘면 더 오래 내린다. 융단폭격이 화살비와 같은 길이면 안 된다.
          this.pourFrames = POUR_FRAMES + tier * 9;
          this.pourZones = zones;
          this.pourX = c0; this.pourXB = c1; this.pourXC = c2;
          this.pourSpan = r;              // 첫 구역은 r
          this.pourSpanB = r * 0.75;      // 나머지 둘은 0.75r — game 과 같은 비율
          this.pourSeq = 0;
          this.pourKind = mine ? 1 : 2;
          this.pourMag = POUR_SHAKE * (0.78 + tier * 0.3) * (mine ? 1 : 0.75);
          this.addShake(this.pourMag * 1.5, 0, AX_Y, 1);
          this.spray(c0, gy(c0) - 50, C.PART_KILL, mine ? 1 : 2, 2.6, 3.4, 22, 3.4);
        } else if (a === SK_RALLY) {
          // 증원 — **진동을 한 톨도 안 쓴다.** 셋 중 유일하게 안 흔들리는 것이
          // 이 스킬의 성격이다. 화면이 위로 들렸다 내려앉고, 소환지점에서
          // 기둥이 솟는다. 적 것은 반대로 **내려앉는다** — 저쪽 땅이 무거워진 것.
          //
          // 등급이 오르면 **수가 아니라 구성**이 바뀐다(검사3 → 검사2창2 →
          // 다섯 종). 그러니 세기가 아니라 **폭**을 키운다 — 정예군은
          // 한 기가 아니라 한 줄의 전열이고, 그 줄만큼 넓게 솟아야 한다.
          const tier = this.tierOf(game, SK_RALLY, mine);
          const row = C.RALLY_TIER_MIX && C.RALLY_TIER_MIX[tier];
          let n = 0;
          if (row) for (let k = 0; k < row.length; k++) n += row[k] | 0;
          if (!(n > 0)) n = num(C.RALLY_COUNT, 3);
          const gap = num(C.UNIT_GAP, 21);
          const sx = mine ? C.SPAWN_L_X : C.SPAWN_R_X;
          // game 은 소환지점에서 **뒤로** 벌려 세운다(spawn 의 xoff 부호).
          const back = mine ? -1 : 1;
          this.kick(0, mine ? -(3.4 + tier * 0.9) : (1.8 + tier * 0.5));
          this.pourMode = 1;
          this.pourFrames = RISE_FRAMES + tier * 6;
          this.pourX = sx + back * n * gap * 0.5;
          this.pourSpan = n * gap * 0.5 + 10;
          this.pourKind = mine ? 1 : 2;
          this.ring(sx, gy(sx) - 24);
          this.spray(sx, gy(sx) - 16, (C.PART_ERA * 0.5) | 0, mine ? 0 : 2,
                     2.2, 2.6, C.PART_LIFE, 3.2);
        } else {
          // 총진군 — **여기가 비어 있었다.** a === 3(SK_SURGE) 이 증원 가지로
          // 흘러 들어가서, 최대 시대의 마지막 스킬이 증원과 똑같이 느껴졌다.
          // (실측 5판에서 11회 발동, 전부 증원의 감촉으로 나갔다)
          // 병력 전체가 빨라지는 것이므로 한 점에서 터지지 않는다. 전열을 훑는다.
          const sx = mine ? C.SPAWN_L_X : C.SPAWN_R_X;
          this.kick(dir * 3.4, 0);
          this.pourMode = 2;
          this.pourFrames = SWEEP_FRAMES;
          this.pourX = sx;
          this.pourSpan = Math.abs(this.frontline(game) - sx);
          this.pourDir = dir;
          this.pourKind = mine ? 1 : 2;
        }
        break;
      }

      case EV.NUKE:
        // 해일의 예전 이름. 같은 프레임에 EV.SKILL(0) 이 이미 지나갔으면 중복이다.
        // **플레이어 전용 경로**다(game.js:822 는 side === SIDE_L 안에서만 쏜다).
        this.tide(true, this.tierOf(game, SK_TIDE, true));
        break;

      case EV.WATER_WARN:
        this.banner(C.BAN_WATER);
        this.addShake(C.SHAKE_KILL, 0);
        break;

      case EV.WATER_HIT:
        // 0.5초마다 온다. 예전 값(2.4)은 후반 내내 화면을 떨게 했다.
        // 물은 압박이지 타격이 아니다 — 낮게 깔리는 진동으로 남긴다.
        // 세로에 결이 굵어서 **차오르는 것**으로 읽힌다. 타격의 가로 충격과 다르다.
        this.addShake(C.SHAKE_HIT * 0.9, 0, AX_Y, 4);
        break;

      case EV.NO_GOLD:
        // 금이 없다. 붉게 튕긴다.
        this.deny(a, 2);
        break;

      case EV.COOLDOWN:
        // 아직 못 쓴다. 흰색으로 튕긴다 — 실패의 이유가 다르면 색도 다르다.
        this.deny(a, 0);
        break;

      case E_SKILL_UP: {
        // 진화로 스킬이 한 단계 올라갔다 (a = 스킬, b = 새 등급).
        // ERA_UP 이 같은 프레임에 큰 것을 이미 쳤으므로 여기서 또 멈추지 않는다.
        // 대신 **그 버튼 자리에서** 금빛이 솟는다 — 실패한 입력이 붉게 튕기는
        // 바로 그 자리다. 버튼 줄이 두 가지 말을 하게 된다: 안 된다 / 세졌다.
        const i = a | 0;
        const bi = i === 2 ? -1 : (i === 1 ? num(C.B_VOLLEY, 9) : num(C.B_TIDE, 8));
        const bx = bi < 0 ? num(C.RALLY_CX, this.btnCXOther)
                          : num(this.btnCX[bi], this.btnCXOther);
        this.spray(bx, DENY_Y, 6, 1, 1.9, 2.8, 26, 3.6);
        break;
      }

      case EV.WIN:
      case EV.LOSE: {
        // 이긴 것과 진 것이 같은 감촉이면 판의 결말이 손에 안 남는다.
        // (원정이 붙어 있으면 뒤이어 STAGE_CLEAR·CAMPAIGN_END 가 색을 더한다.
        //  그 이벤트가 없는 예전 game.js 에서도 여기서 이미 갈린다.)
        const won = type === EV.WIN;
        this.freeze(C.HITSTOP_END, PR_ALWAYS);
        // 이긴 것은 위로 솟고 진 것은 아래로 꺼진다. 회전 세기는 같아도
        // **밀리는 방향**이 반대라 결과가 손에서 먼저 온다.
        this.addShake(C.SHAKE_END, C.SHAKE_ROT_END, AX_Y, won ? 2 : 4);
        this.kick(0, won ? -4.4 : 3.2);
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
        // 배너는 render 의 BAN_TXT 가 3칸뿐이라 못 쓰고 있었다. 이제 5칸이다.
        if (C.BAN_STAGE !== undefined) this.banner(C.BAN_STAGE);
        const bx = C.BASE_R_X;
        const top = gy(bx) - C.BASE_H;
        this.freeze(C.HITSTOP_ERA, PR_ALWAYS);
        this.addShake(C.SHAKE_ERA, 0);
        this.flash(C.FLASH_FRAMES);
        this.ring(bx, top + C.BASE_H * 0.5);
        this.spray(bx, top + C.BASE_H * 0.5, C.PART_ERA, 1, 3.4, 3.0, C.PART_LIFE, 4);
        break;
      }

      case E_CAMPAIGN_END: {
        // **"끝"이다.** 전투 클리어와 절대 헷갈리면 안 된다.
        // 길게 멈추고, 화면이 기울고(회전은 여기와 승패에만 있다),
        // 고리가 셋이다. 하나는 다음이고 셋은 마지막이다.
        this.freeze(C.HITSTOP_NUKE, PR_ALWAYS);
        if (C.BAN_CAMPAIGN !== undefined) this.banner(C.BAN_CAMPAIGN);
        const lx = C.BASE_L_X, rx = C.BASE_R_X, mx = C.VIEW_W * 0.5;
        if (b === 1) {
          // 완주. 이 게임에서 가장 밝은 순간이다.
          this.addShake(C.SHAKE_END, C.SHAKE_ROT_END * 1.5);
          this.flash(C.FLASH_FRAMES * 2);
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

      // ── v4 보스 「심연」 ──────────────────────────────────────
      case E_BOSS_WARN: {
        // 예고 2.6초. render 가 화면 전체를 옅게 물들이고 카운트다운을 그린다
        // (drawBossWarn) — 여기서 그걸 다시 흔들면 중복이다. **아직 아무 일도
        // 일어나지 않았다**(적 사건이다) — 히트스톱도 셰이크도 안 쓴다.
        // 물 밑에서 거품만 뜬다. "떠오른다"의 낌새를 미리 눈에 남기는 정도다.
        const bx = C.VIEW_W * 0.5;
        this.ring(bx, gy(bx) - 4);
        this.spray(bx, gy(bx) - 2, 5, 2, 0.8, 1.6, 42, 2.4);
        break;
      }

      case E_BOSS_SPAWN: {
        // 등장의 순간. **ERA_UP(내 진화)급의 축제는 과하다** — 이건 위협이지
        // 성과가 아니다. 그래서 히트스톱도 flash 도 안 쓴다(적이 세지는 순간에
        // 내 화면이 멈추거나 번쩍이면 그건 내 성과의 문법이다 — ERA_UP 의 계약
        // 그대로). 대신 세기가 아니라 **결로** 무게를 낸다: 굵은 결(5)로 짧게
        // 짓누르고, 화면이 적 쪽에서 내 쪽으로 밀린다 — "이제부터 저게 온다".
        const bx = num(game && game.bossX, C.VIEW_W * 0.5);
        const top = gy(bx) - C.BOSS_H;
        this.addShake(C.SHAKE_NUKE * 0.55, 0, AX_Y, 5);
        this.kick(-3.0, 1.6);
        this.ring(bx, gy(bx) - 6);
        this.spray(bx, top + C.BOSS_H * 0.3, (C.PART_NUKE * 0.5) | 0, 2, 3.2, 2.0, C.PART_LIFE, 4);
        break;
      }

      case E_BOSS_SLAM_CAST:
        // **비워 둔다.** render 는 이미 발밑에 조여드는 균열 고리를 그리고 있고
        // (drawBoss, bossSlamCasting) 오디오가 그 1.4초를 리저로 채운다.
        // 이 게임의 다른 모든 예고(EV.AI_CAST)도 feel 은 손대지 않는다 —
        // 예고에서 흔들면 진짜 슬램(BOSS_SLAM)이 왔을 때 대비가 안 산다.
        break;

      case E_BOSS_SLAM: {
        // 내가 맞았다 — 손해. **히트스톱 없음**(손해에 구두점을 찍지 않는다,
        // BASE_HIT·SLAM 공통 규칙). 세로 축(맞은 것에는 방향이 없다 — 적의
        // COUNTER_HIT 과 같은 언어). a = 맞은 내 유닛 수, 많이 맞을수록 커지되
        // 문턱을 둔다(화면이 안 날아가야 한다). 반경 안에서 터지는 것이므로
        // 방사형 burst 를 쓴다 — 방향 있는 spray 가 아니라 사방으로 밀린 것이다.
        const bx = num(game && game.bossX, C.VIEW_W * 0.5);
        const n = Math.max(0, a | 0);
        const s = Math.min(4, n);
        this.addShake(C.SHAKE_BASE * (0.55 + 0.25 * s), 0, AX_Y, 4);
        this.ring(bx, gy(bx) - 2);
        this.burst(bx, gy(bx) - 30, 6 + s * 2, 2);
        break;
      }

      case E_BOSS_HIT: {
        // 내가 때렸다 — 성과. a = 이 타격으로 깎인 체력. 자주 나는 사건이라
        // (자동공격이라 여러 유닛이 겹칠 수 있다) COUNTER_HIT 과 같은 처방을
        // 쓴다: **매번 숫자+파편, 예산이 허락할 때만 진짜 충격.** 가로 축
        // (때리는 방향이 있다). 노출(EXPOSE) 여부는 이벤트에 안 실려 오므로
        // 여기서 구분하지 않는다 — 있는 정보로만 푼다.
        const bx = num(game && game.bossX, C.VIEW_W * 0.5);
        const top = gy(bx) - C.BOSS_H;
        const dmg = Math.max(0, a | 0);
        this.float(bx, top - 10 - Math.random() * 16, dmg, 0);
        this.spray(bx + (Math.random() * 2 - 1) * 18, top + C.BOSS_H * 0.42,
                   2, 1, 2.0, 0.8, 18, 2.8);
        // freeze() 의 간격·부하 거버너를 그대로 빌린다 — 새 쿨다운을 만들지 않는다.
        if (this.freeze(HITSTOP_HIT, PR_LOW)) {
          this.addShake(C.SHAKE_HIT * 0.7, 0, AX_X, 2);
          this.spray(bx, top + C.BOSS_H * 0.42, 4, 1, 2.6, 1.2, 22, 3.2);
        }
        break;
      }

      case E_BOSS_KILL: {
        // 이 판의 가장 큰 처치다(한 판에 한 번뿐 — evaluate.mjs 로 확인).
        // WIN/LOSE 급 무게를 받을 자격이 있다. **다만 판은 안 끝났다** — 그래서
        // resultStep 을 세우지 않고 banner()(BAN_* 5칸은 결말·진화 전용)도
        // 건드리지 않는다. 위로 솟는다(승리의 방향), 가로 축(내가 잡은 것 —
        // 때린 방향이 있다, EV.KILL 의 mine 계와 같은 언어). 보스가 서 있던
        // 자리(중앙, 물 위)가 곧 어두운 배경이라 금빛 파편이 거기서 읽힌다.
        const bx = num(game && game.bossX, C.VIEW_W * 0.5);
        const top = gy(bx) - C.BOSS_H;
        this.freeze(9, PR_ALWAYS);
        this.addShake(C.SHAKE_NUKE * 0.75, 0, AX_X, 2);
        this.kick(0, -4.0);
        this.flash((C.FLASH_FRAMES * 1.5) | 0);
        this.ring(bx, top + C.BOSS_H * 0.5);
        this.spray(bx, top + C.BOSS_H * 0.4, (C.PART_NUKE * 0.9) | 0, 1, 3.6, 3.2, C.PART_LIFE, 4.2);
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
  //
  // **무게**가 이 스킬의 성격이다. 무게는 크기가 아니라 느림과 방향에서 온다.
  // 결을 4프레임으로 묶어(다른 어떤 연출보다 굵다) 가로로만 쓸리게 하고,
  // 밀림 임펄스를 물이 가는 쪽으로 준다 — 화면이 파도에 떠밀렸다 돌아온다.
  // 화살비의 잔 세로 지지직과 정확히 반대 축·반대 결이라 손에서 안 헷갈린다.
  //
  // 등급(해일 → 격류 → 범람)은 **게임이 실제로 미는 픽셀에서 나온다.**
  // C.TIDE_PUSH_PX = [0, 34, 68] 이라 1등급은 아무도 안 밀린다 — 그러면 화면도
  // 안 밀어야 맞다. 상수를 새로 만들지 않고 같은 배열을 같은 tier 로 읽으므로
  // 밸런스가 저 숫자를 고치면 감촉이 저절로 따라간다.
  tide(mine, tier) {
    if (this.t - this.tideAt < 8) return;
    this.tideAt = this.t;
    const t = tier > 0 ? (tier | 0) : 0;
    const dir = mine ? 1 : -1;
    const x = mine ? C.VIEW_W * 0.62 : C.VIEW_W * 0.38;
    const y = gy(x) - 40;
    const pushPx = num(C.TIDE_PUSH_PX && C.TIDE_PUSH_PX[t], 0);
    const stunMs = num(C.TIDE_STUN_MS && C.TIDE_STUN_MS[t], 0);
    const s = mine ? 1 : 0.72;
    // 적의 해일도 무겁다 — 재난이니까. 다만 예산은 따로 쓴다.
    // 1등급을 예전(14)보다 짧게 잡아, 등급이 올라야 예전 무게가 나오게 했다.
    // 그래야 총량이 안 늘면서 "세졌다"가 손에 온다.
    const fz = 11 + t * 3;
    this.freeze(mine ? fz : ((fz * 0.65) | 0), PR_ALWAYS);
    this.addShake(C.SHAKE_NUKE * (0.78 + t * 0.11) * s, 0.01, AX_X, 4);
    // 밀린 픽셀에 비례한다: 0px → 2.2 · 34px → 4.1 · 68px → 6.0
    this.kick(dir * (2.2 + pushPx * 0.056) * s, 0);
    if (stunMs > 0) {
      // 범람 — 휩쓸어 **넘어뜨린다.** 여기서만 밀림에 세로 성분이 생긴다.
      // 회전은 안 쓴다: 회전은 승패·원정 종료·도발의 언어이고, 스킬이
      // 그 셋의 어휘를 빌려 쓰기 시작하면 판의 결말이 값을 잃는다.
      this.kick(0, 2.4 * s);
      const nf = 10;
      for (let k = 0; k < nf; k++) {
        const fx2 = x + (Math.random() * 2 - 1) * 110;
        this.push1(fx2, gy(fx2) - 60 - Math.random() * 40,
                   dir * (0.8 + Math.random()), 2.6 + Math.random() * 1.8,
                   3.0 + Math.random() * 1.6, 20, mine ? 1 : 2);
      }
    }
    this.ring(x, y);
    // 절반은 터지고 절반은 **간다.** 물은 한자리에서 터지지 않는다 —
    // 지면을 따라 낮게 밀려가는 띠가 있어야 파도로 읽힌다.
    const nb = (C.PART_NUKE * 0.35) | 0;
    const nr = C.PART_NUKE - nb;
    this.spray(x, y, nr, mine ? 1 : 2, 3.6, 3.0, C.PART_LIFE, 4);
    const x0 = mine ? C.SPAWN_L_X : C.SPAWN_R_X;
    for (let k = 0; k < nb; k++) {
      const bx = x0 + (x - x0) * (k / nb) + (Math.random() * 2 - 1) * 10;
      this.push1(bx, gy(bx) - 4 - Math.random() * 10,
                 dir * (3.4 + Math.random() * 2.2), -0.6 - Math.random() * 0.8,
                 3.4 + Math.random() * 1.8, C.PART_LIFE, mine ? 1 : 2);
    }
    if (mine) {
      // 내가 쓴 것만 이름을 얻는다. 적의 해일은 어둡게 지나간다.
      this.flash(C.FLASH_FRAMES);
      this.banner(C.BAN_NUKE);
    }
  }

  // ── 등급 ────────────────────────────────────────────────────
  // **이벤트에 실려 오지 않는다. 실을 이유도 없다.**
  // emit() 은 큐가 아니라 동기 팬아웃이라(game.js:454 → main.js:28) onEvent 의
  // 넷째 인자 game 은 **발동 그 순간의 게임**이다. 시대가 그 사이에 바뀔 틈이
  // 없으므로 여기서 물어보는 것이 정본이고, EV.SKILL 의 인자를 늘리면
  // director·audio 까지 같은 시그니처를 물고 있어 3파일 동시 수정이 된다.
  tierOf(game, i, mine) {
    if (!game) return 0;
    const f = mine ? game.skillTier : game.aiSkillTier;
    if (typeof f !== 'function') return 0;
    const t = f.call(game, i);
    return (t === t && t > 0) ? (t | 0) : 0;      // NaN·undefined 방어
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
