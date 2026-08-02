// 시뮬레이션 — 유닛 · 전투 · 상성 · 경제 · 시대 진화 · 물 · 포탑 · 스킬 · 특성.
// 이 파일은 시각·청각·입력장치를 모른다. 순수하게 상태만 굴린다.
//
// 규칙 1: 고정 스텝이다. 이 파일 어디에도 deltaTime을 곱하는 코드가 없다.
// 규칙 2: 상태 전이는 setState() 한 곳에서만 일어난다.
// 규칙 3: 판정에 Math.random()을 쓰지 않는다. 재현 가능해야 한다.
// 규칙 4: 루프 안에서 객체·배열을 만들지 않는다. 유닛은 전부 타입배열 풀이다.
// 규칙 5: 종류 개수를 하드코딩하지 않는다. 전부 C.UNIT_KINDS 를 돈다.

import * as C from './config.js';

// 상태. **0·1·2 는 계약이다** — render·audio·feel·평가기가 전부 이 번호를 쓴다.
// BRIEF(3)는 뒤에 붙인다. 원정 첫 전투 직전의 설명 화면이고 시뮬레이션이 멈춘다.
export const S = { PLAY: 0, DRAFT: 1, OVER: 2, BRIEF: 3 };
export const STATE_NAME = ['PLAY', 'DRAFT', 'OVER', 'BRIEF'];

// 진영. 0 = 나, 1 = 적.
export const SIDE_L = 0, SIDE_R = 1;

// 입력 행동 — 메인이 못 박은 배치다. 버튼 인덱스가 곧 행동 번호이고,
// **유닛 행동 번호(0~5)는 곧 유닛 종류 인덱스**다. 그래서 변환표가 필요 없다.
//   버튼줄  0 검사 1 창병 2 궁수 3 기병 4 거인 5 투석기 6 진화 7 포탑 8 해일 9 화살비
//   증원만 버튼줄 밖(우하단 원형 버튼 · 키 R)이라 10 이다.
export const ACT = {
  SWORD: 0, SPEAR: 1, ARCHER: 2, CAV: 3, GIANT: 4, CATA: 5,
  ERA: 6, TOWER: 7, TIDE: 8, VOLLEY: 9, RALLY: 10,
  PICK0: 11, PICK1: 12, PICK2: 13, RESTART: 14,
  // 예전 이름 호환 — 해일이 필살기를 흡수했다. 값이 TIDE 와 같다.
  NUKE: 8,
};

// 화면 버튼 인덱스 → 행동. 지금은 항등이지만 계약이 여기 적혀 있어야
// 버튼 줄이 바뀔 때 고칠 곳이 한 군데로 남는다.
export const BTN_ACT = new Uint8Array([
  ACT.SWORD, ACT.SPEAR, ACT.ARCHER, ACT.CAV, ACT.GIANT, ACT.CATA,
  ACT.ERA, ACT.TOWER, ACT.TIDE, ACT.VOLLEY,
]);

export const EV = {
  SPAWN: 0,         // a = 종류, b = 진영
  ATTACK: 1,        // a = 종류, b = 진영
  KILL: 2,          // a = 죽은 유닛 종류, b = 죽인 진영
  BASE_HIT: 3,      // a = 피해, b = 맞은 진영
  GOLD: 4,          // a = 금액
  ERA_UP: 5,        // a = 새 시대, b = 진영
  NUKE: 6,
  NO_GOLD: 7,       // 살 돈이 없다 — 눌렀는데 안 나가는 것을 소리로 알린다
  COOLDOWN: 8,      // 쿨다운 중이다
  WATER_WARN: 9,
  WATER_HIT: 10,    // 물이 지면에 닿아 기지가 깎인다
  DRAFT_OPEN: 11,
  DRAFT_PICK: 12,   // a = 특성 인덱스, b = 계열
  WIN: 13,
  LOSE: 14,
  RESET: 15,
  // ── v2 확장. 기존 번호는 건드리지 않는다 ──
  TOWER_FIRE: 16,   // a = 포탑 단계, b = 진영
  SKILL: 17,        // a = 스킬 번호(0 해일 1 화살비 2 증원), b = 진영
  TOWER_UP: 18,     // a = 새 단계, b = 진영
  COUNTER_HIT: 19,  // a = 공격자 종류, b = 진영 — 상성 우위로 때렸다
  // ── v3 원정. 0~19 는 건드리지 않는다 ──
  STAGE_START: 20,  // a = 전투 번호(0-based), b = 사령관 인덱스
  STAGE_CLEAR: 21,  // a = 전투 번호
  TAUNT: 22,        // a = 사령관 인덱스, b = 디렉터가 판정한 플레이어 프로파일
  CAMPAIGN_END: 23, // a = 클리어한 전투 수, b = 1이면 완주
};

// 디렉터가 없을 때 적이 쓰는 고정 웨이브. 랜덤 0.
// [지연ms, 유닛종류] 가 반복된다. 이것만으로도 게임은 100% 돌아간다.
// v2: 여섯 종류가 전부 나온다 — 폴백만 봐도 상성이 도는 것이 보여야 한다.
export const FALLBACK_WAVE = new Int16Array([
  1200, C.U_SWORD,   1600, C.U_SPEAR,   2400, C.U_ARCHER,  1800, C.U_SWORD,
  3000, C.U_CAV,     1600, C.U_SPEAR,   1400, C.U_SWORD,   2600, C.U_ARCHER,
  3400, C.U_GIANT,   1500, C.U_SWORD,   2000, C.U_CAV,     2800, C.U_SPEAR,
  3600, C.U_CATA,    1500, C.U_SWORD,   2200, C.U_ARCHER,  2000, C.U_GIANT,
]);

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// 최소 사거리 — 이보다 가까운 적에게는 공격이 성립하지 않는다.
// **상성 배수로는 "닿기 전에 죽는 것"을 못 뒤집는다.** 기병이 궁수·투석기를
// 잡는다는 계약이 4/6 에서 깨져 있었고, 실패한 두 변이 전부 방어자 사거리가
// 더 긴 조합이었다. 배수를 올리는 것은 대증요법이고 사거리 300 앞에서는
// 어차피 안 된다. 그래서 배수가 아니라 **구조**로 돌린다 —
// 활을 당길 공간이 없고 투석기는 코앞에 못 쏜다.
// config 이 아직 이 상수를 안 줬으면 전부 0 이다 = 예전 그대로 동작한다.
const U_MIN_RANGE = (C.U_MIN_RANGE && C.U_MIN_RANGE.length >= C.UNIT_KINDS)
  ? C.U_MIN_RANGE : new Float32Array(C.UNIT_KINDS);

// ── 원정 상수 — 방어적으로 읽는다 ─────────────────────────────
// config 이 아직 v3 상수를 안 줬으면 **원정이 없는 예전 게임**으로 조용히 돈다.
// 게임이 죽는 것보다 기능 하나가 없는 편이 낫다.
const CAMPAIGN_LEN = (Number.isInteger(C.CAMPAIGN_LEN) && C.CAMPAIGN_LEN > 0) ? C.CAMPAIGN_LEN : 1;
// 배열 상수를 스테이지로 꺼낸다. 길이가 모자라면 마지막 값으로 이어 쓴다.
function stageOf(arr, i, dflt) {
  if (!arr || arr.length === 0) return dflt;
  const k = i < 0 ? 0 : (i >= arr.length ? arr.length - 1 : i);
  const v = +arr[k];
  return (v > 0 && Number.isFinite(v)) ? v : dflt;
}
function idxOf(arr, i, dflt) {
  if (!arr || arr.length === 0) return dflt;
  const k = i < 0 ? 0 : (i >= arr.length ? arr.length - 1 : i);
  const v = +arr[k];
  return Number.isFinite(v) ? v : dflt;
}

// 협곡 바닥. 가운데가 이만큼 낮다 — 전투마다 다르다 (C.STAGE_DIP).
// **groundAt(x) 의 서명은 계약이다** (render 도 같이 쓴다). 그래서 스테이지 값은
// 인자가 아니라 모듈 지역 변수로 들어온다. 전투가 바뀔 때 한 번만 갱신된다.
let floorDip = C.FLOOR_DIP;

// 이 한 줄이 이 게임의 교착을 푼다 — 전선이 기지보다 먼저 잠긴다.
export function groundAt(x) {
  const mid = C.VIEW_W * 0.5;
  const half = C.VIEW_W * 0.5;
  const t = (x - mid) / half;               // -1 .. 1
  return C.GROUND_Y + floorDip * (1 - t * t);
}
// 지형이 바뀐 것을 렌더가 알아야 한다. game.floorDip · game.terrainSeq 를 본다.
export function currentDip() { return floorDip; }

export class Game {
  constructor() {
    // ─ 유닛 풀. 루프 안에서 객체를 만들지 않기 위해 타입배열로 둔다 ─
    const N = C.UNIT_MAX;
    this.uAlive = new Uint8Array(N);
    this.uSide = new Uint8Array(N);
    this.uKind = new Uint8Array(N);
    this.uEra = new Uint8Array(N);
    this.uX = new Float32Array(N);
    this.uPrevX = new Float32Array(N);
    this.uHp = new Float32Array(N);
    this.uHpMax = new Float32Array(N);
    this.uCd = new Float32Array(N);       // 남은 공격 쿨다운 ms
    this.uHitFlash = new Uint8Array(N);   // 맞은 직후 프레임 수 (렌더용)
    this.uAttack = new Uint8Array(N);     // 공격 모션 프레임 (렌더용)

    // 화살 풀 — 연출 전용. 판정은 쏘는 순간 끝나 있다.
    const A = C.ARROW_MAX;
    this.aLife = new Int16Array(A);
    this.aTotal = new Int16Array(A);
    this.aX0 = new Float32Array(A); this.aY0 = new Float32Array(A);
    this.aX1 = new Float32Array(A); this.aY1 = new Float32Array(A);
    this.aSide = new Uint8Array(A);
    this.aNext = 0;

    this.supplier = null;     // 디렉터가 붙는다. 없으면 고정 웨이브
    this.onEvent = null;

    // 세션 기록. 전부 메모리에만 둔다 (localStorage 금지)
    this.wins = 0;
    this.losses = 0;
    this.bestTime = 0;
    this.runs = 0;

    // main 이 프레임 시작에서 심어주는 시각 기준점
    this.frameWall = 0;
    this.frameSimBase = 0;

    this.traits = new Uint8Array(C.TRAITS.length);
    this.draftIdx = new Int8Array(C.TRAIT_OFFER);
    this.spawnCd = new Float32Array(C.UNIT_KINDS);
    this.skillCd = new Float32Array(C.SKILL_COUNT);
    this.skillUsed = new Uint16Array(C.SKILL_COUNT);
    this.spawnedKind = new Uint16Array(C.UNIT_KINDS);
    // 적 AI 가 매 판단마다 쓰는 가중치 버퍼. 여기서 한 번만 만든다.
    this.aiMix = new Float32Array(C.UNIT_KINDS);
    // 사령관의 기본 구성. 루프 안에서 배열을 만들지 않기 위해 여기서 한 번만.
    this.cmdMix = new Float32Array(C.UNIT_KINDS);
    // 적 사령관도 스킬을 쓴다. 쿨다운은 플레이어와 같은 표(C.SKILL_CD)를 쓴다.
    this.aiSkillCd = new Float32Array(C.SKILL_COUNT);
    this.aiSkillUsed = new Uint16Array(C.SKILL_COUNT);

    // ─ 원정. 여기 값만 전투를 넘어 살아남는다 ─
    // **localStorage 금지이므로 새로고침하면 사라진다. 제약이지 버그가 아니다.**
    this.stage = 0;
    this.stageMax = CAMPAIGN_LEN;
    this.commander = 0;
    this.campaignOver = false;
    this.stagesCleared = 0;
    this.campaignMs = 0;          // 앞선 전투들의 합. 이번 전투 시간은 포함하지 않는다
    this.terrainSeq = 0;          // 지형이 바뀐 횟수. 렌더가 캐시를 다시 구울 신호
    this.floorDip = floorDip;
    // 설명 화면은 **세션에 한 번만** 나온다. 져서 원정을 다시 시작할 때마다
    // 같은 설명을 다시 읽히는 것은 벌이다.
    this.briefSeen = false;

    this.reset();
  }

  // 예전 이름 호환 — render.js·evaluate.mjs 가 game.nukeCd 를 읽는다.
  // 해일이 필살기를 흡수했으므로 실체는 skillCd[SK_TIDE] 하나뿐이다.
  get nukeCd() { return this.skillCd[C.SK_TIDE]; }
  set nukeCd(v) { this.skillCd[C.SK_TIDE] = v; }

  // ── 원정 ────────────────────────────────────────────────────
  // 판 하나가 아니라 여정이다. 이기면 다음 사령관, 지면 원정이 끝난다.
  //
  // **원정은 리셋이 아니다.** 다음 전투로 넘어갈 때
  //   유지: 특성(traits) · 포탑 단계 · 세션 기록
  //   초기화: 금 · 시대 · 경험치 · 병력 · 물 · 스킬 쿨다운
  // 그래야 앞 전투의 선택이 뒤에 살아 있으면서 매 전투는 처음부터 시작한다.

  // 스테이지 곡선 — 세 축이 따로 논다. 한 축만 올리면 나쁜 난이도가 된다.
  stageHpMul() { return stageOf(C.STAGE_HP_MUL, this.stage, 1); }   // 판 길이
  stageDiff() { return stageOf(C.STAGE_DIFF, this.stage, 1); }      // 적 수입·공격성
  stageWaterMul() { return stageOf(C.STAGE_WATER_MUL, this.stage, 1); } // 마감 시계
  stageDip() { return stageOf(C.STAGE_DIP, this.stage, C.FLOOR_DIP); }

  // 사령관 — 디렉터의 다섯 프로파일에 얼굴을 준 것. 순서는 가르치는 순서다.
  commanderFor(stage) {
    const n = (C.COMMANDER_PROFILE && C.COMMANDER_PROFILE.length) ? C.COMMANDER_PROFILE.length : 1;
    return stage < 0 ? 0 : (stage % n);
  }
  get commanderProfile() {
    return (C.COMMANDER_PROFILE && C.COMMANDER_PROFILE[this.commander]) || 'BALANCED';
  }
  // 사령관 성격 — **디렉터를 대체하지 않는다.** 사령관은 그 전투의 기본 성격이고
  // 디렉터는 그 위에서 플레이어를 읽는다. 여기 값은 전자만 만진다.
  cmdTempoMul() { return stageOf(C.CMD_TEMPO_MUL, this.commander, 1); }
  cmdGoldMul() { return stageOf(C.CMD_GOLD_MUL, this.commander, 1); }
  cmdSkillMul() { return stageOf(C.CMD_SKILL_MUL, this.commander, 1); }
  cmdTowerWant() { return idxOf(C.CMD_TOWER, this.commander, 0); }
  cmdHoard() { return idxOf(C.CMD_HOARD, this.commander, 0); }

  // 다음 전투로. **이긴 직후에만 호출된다.**
  nextStage() {
    if (this.campaignOver) return false;
    if (this.stage + 1 >= this.stageMax) { this.campaignOver = true; return false; }
    // 원정 누적 시간은 여기서만 자란다. 이번 전투 시간을 넘기고 시계를 0으로 되돌린다.
    this.campaignMs += this.endTime >= 0 ? this.endTime : this.simTime;
    this.stage++;
    this.resetBattle();
    return true;
  }

  // ── 리셋 — 원정 전체를 처음부터 ──────────────────────────────
  reset() {
    this.stage = 0;
    this.stageMax = CAMPAIGN_LEN;
    this.campaignOver = false;
    this.stagesCleared = 0;
    this.campaignMs = 0;
    this.traits.fill(0);
    this.towerLv = 0;
    this.resetBattle();
  }

  // 전투 하나를 차린다. 특성과 포탑 단계는 **여기서 지우지 않는다.**
  resetBattle() {
    this.commander = this.commanderFor(this.stage);
    const dip = this.stageDip();
    if (dip !== floorDip) { floorDip = dip; this.terrainSeq++; }
    this.floorDip = floorDip;

    this.tick = 0;
    this.simTime = 0;
    // 판이 끝난 순간의 시계. -1 = 아직 안 끝났다.
    // **simTime 은 계속 흐른다** — 히트스톱·도발 간격·feel 이 그 시계를 쓴다.
    // 얼리는 것은 보고되는 값(elapsed)뿐이다.
    this.endTime = -1;
    // 설명 화면 — 원정 첫 전투 앞에 한 번. 시뮬레이션이 멈춘다.
    // **조작을 막지 않는다**: 아무 입력이나 즉시 해제하고, 아무 입력이 없어도
    // C.BRIEF_MS 뒤에 저절로 열린다. 붙잡아 두는 화면은 금지다 (계약 §4).
    this.state = (this.stage === 0 && !this.briefSeen) ? S.BRIEF : S.PLAY;
    this.stateTick = 0;

    this.uAlive.fill(0);
    this.aLife.fill(0);
    this.uNext = 0;
    this.aliveL = 0;
    this.aliveR = 0;

    // 기지 체력은 **판 길이만** 정한다. 첫 전투가 0.45 인 이유는 그것뿐이다 —
    // 짧게 끝나야 가르치는 전투가 된다. 어려움은 여기가 아니라 STAGE_DIFF 가 만든다.
    const hp0 = C.BASE_HP * this.stageHpMul();
    this.baseHp = [hp0, hp0];
    this.baseMax = [hp0, hp0];
    this.baseFlash = [0, 0];
    // 무엇이 기지를 무너뜨렸는가. 0=아직 1=병력 2=물.
    // 물과 병력이 같은 프레임에 기지를 0으로 만들면 무승부로 끝나 버린다.
    // **병력이 무너뜨린 것이 물보다 먼저다** — 그게 이 게임에서 이겼다는 뜻이다.
    this.baseDownBy = [0, 0];

    this.gold = C.GOLD_START;
    // 첫 전투만 경험치를 안고 시작한다. **온보딩이다** —
    // 시대 진화와 드래프트가 21초에 처음 나오면 심사자는 이미 판단을 끝냈다.
    this.xp = idxOf(C.STAGE_XP_HEAD, this.stage, 0);
    this.era = 0;
    this.spawnCd.fill(0);

    // 스킬 셋. 첫 판에도 한 번은 쓸 수 있게 절반만 채워 시작한다.
    for (let i = 0; i < C.SKILL_COUNT; i++) this.skillCd[i] = C.SKILL_CD[i] * 0.45;
    this.skillUsed.fill(0);

    // 기지 포탑 — **원정에서 유지된다.** 여기서 0으로 만들지 않는다.
    // (원정을 처음부터 다시 하는 reset() 만 0으로 되돌린다)
    if (!(this.towerLv > 0)) this.towerLv = 0;
    this.towerCd = 0;

    this.aiGold = C.AI_GOLD_START * stageOf(C.STAGE_AI_GOLD, this.stage, 1);
    this.aiXp = 0;
    this.aiEra = 0;
    this.aiThink = 0;
    this.aiHold = 0;
    this.aiWait = 0;
    this.aiPick = -1;      // 붙들고 있는 구매 예정 종류. -1 = 아직 안 정했다
    this.aiWaveIdx = 0;
    this.aiWaveTimer = FALLBACK_WAVE[0];
    // 적 사령관의 포탑과 스킬. 첫 전투(가르치는 전투)에서는 둘 다 안 쓴다.
    this.aiTowerLv = 0;
    this.aiTowerCd = 0;
    this.aiIntro = 0;
    for (let i = 0; i < C.SKILL_COUNT; i++) this.aiSkillCd[i] = this.aiSkillCooldown(i);
    this.aiSkillUsed.fill(0);

    this.water = C.WATER_Y0;
    this.prevWater = this.water;
    this.waterWarned = false;

    // 통계 — 디렉터의 지표이자 결과 화면의 재료
    this.spawned = 0;
    this.spawnedKind.fill(0);
    this.goldSpentUnits = 0;
    this.goldSpentEra = 0;
    this.goldSpentTower = 0;
    this.kills = 0;
    this.lost = 0;
    this.nukes = 0;
    this.counterHits = 0;
    this.towerShots = 0;
    this.goldPeak = 0;
    this.goldSum = 0;
    this.goldSamples = 0;

    // **특성은 지우지 않는다.** 원정에서 유지되는 것이 traits 와 towerLv 다.
    // 다만 기지 체력을 늘리는 특성은 새 기지에 다시 얹어야 한다 —
    // baseMax 를 방금 새로 계산했기 때문이다.
    if (this.has('wall')) {
      const add = 400 * this.stageHpMul();
      this.baseMax[SIDE_L] += add;
      this.baseHp[SIDE_L] += add;
    }
    this.draftOpen = false;
    this.draftFrames = 0;
    this.pendingDraft = 0;

    this.outcome = C.WIN_NONE;
    this.endTick = -1;

    // 도발 — 디렉터가 플레이어를 새로 판정한 순간에만 나온다.
    this.tauntProfile = -1;
    this.tauntAt = -1e9;
    this.taunts = 0;

    if (this.supplier && this.supplier.onRunStart) this.supplier.onRunStart();
    // 사령관을 디렉터에게 알린다. 밸런스 감독이 이 훅을 아직 안 만들었을 수 있다 —
    // 없으면 조용히 지나간다. 게임은 그래도 돈다.
    if (this.supplier && typeof this.supplier.setCommander === 'function') {
      this.supplier.setCommander(this.commander, this.stage, this.commanderProfile);
    }
    this.runs++;
    this.emit(EV.RESET, 0, 0);
    this.emit(EV.STAGE_START, this.stage, this.commander);
  }

  emit(type, a, b) { if (this.onEvent) this.onEvent(type, a, b); }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.stateTick = 0;
  }

  nowWall() { return this.frameWall + (this.simTime - this.frameSimBase); }

  // ── 특성 ────────────────────────────────────────────────────
  has(id) {
    for (let i = 0; i < C.TRAITS.length; i++) {
      if (C.TRAITS[i].id === id) return this.traits[i] === 1;
    }
    return false;
  }

  applyTrait(idx) {
    this.traits[idx] = 1;
    if (C.TRAITS[idx].id === 'wall') {
      // 기지 체력 특성은 **그 전투의 기지 크기에 비례한다.** 상수 400 을 그대로
      // 얹으면 기지가 작은 첫 전투(0.45배)에서만 특성 하나가 판을 결정한다.
      const add = 400 * this.stageHpMul();
      this.baseMax[SIDE_L] += add;
      this.baseHp[SIDE_L] += add;
    }
  }

  // ── 파생 스탯 ───────────────────────────────────────────────
  // 시대 배수와 특성을 여기 한 곳에서만 적용한다. 흩뿌리면 반드시 어긋난다.
  statHp(kind, era, side) {
    let v = C.U_HP[kind] * C.ERA_HP_MUL[era];
    if (side === SIDE_L && this.has('thick')) v *= 1.25;
    return v;
  }
  statDmg(kind, era, side) {
    let v = C.U_DMG[kind] * C.ERA_DMG_MUL[era];
    if (side === SIDE_L && this.has('sharp')) v *= 1.2;
    return v;
  }
  statSpeed(kind, side) {
    let v = C.U_SPEED[kind];
    if (side === SIDE_L && this.has('swift')) v *= 1.25;
    return v;
  }
  statCooldown(kind, side) {
    let v = C.U_COOLDOWN[kind];
    if (side === SIDE_L && kind === C.U_ARCHER && this.has('volley')) v *= 0.7;
    return v;
  }
  cost(kind) { return Math.round(C.U_COST[kind] * C.ERA_COST_MUL[this.era]); }
  aiCost(kind) { return Math.round(C.U_COST[kind] * C.ERA_COST_MUL[this.aiEra]); }
  spawnCooldown(kind) {
    return C.U_SPAWN_CD[kind] * (this.has('rush') ? 0.7 : 1);
  }
  goldRate() { return C.GOLD_RATE * (this.has('mine') ? 1.3 : 1); }
  eraNeed() {
    return this.era + 1 < C.ERA_COUNT ? C.ERA_XP[this.era + 1] : -1;
  }
  eraReady() {
    const need = this.eraNeed();
    return need > 0 && this.xp >= need;
  }

  // 다음 포탑 단계의 값. 최대면 -1.
  towerCost() { return this.towerLv >= C.TOWER_MAX ? -1 : C.TOWER_COST[this.towerLv]; }
  skillReady(i) {
    return i >= 0 && i < C.SKILL_COUNT && this.skillCd[i] <= 0;
  }

  // 설명 화면을 닫는다. 입력이든 시간이든 여기로 들어온다.
  dismissBrief() {
    if (this.state !== S.BRIEF) return;
    this.briefSeen = true;
    this.setState(S.PLAY);
  }

  // ── 입력 진입점 — main 의 입력 큐만 이걸 부른다 ──────────────
  input(act, simTs, wallTs) {
    // 설명 화면에서는 **아무 입력이나** 즉시 해제다. 그 입력은 소비된다 —
    // 설명을 닫으려고 누른 것이 유닛 소환이 되면 그것도 조작을 뺏은 것이다.
    if (this.state === S.BRIEF) { this.dismissBrief(); return; }

    if (this.state === S.OVER) {
      // 결과 화면에서는 아무 입력이나 "계속"이다. 무엇으로 이어지는지만 다르다.
      //   이겼고 원정이 남았다 → 다음 사령관
      //   그 밖 (졌거나 완주했거나) → 원정을 처음부터
      if (this.outcome === C.WIN_PLAYER && !this.campaignOver && this.nextStage()) return;
      this.reset();
      return;
    }
    if (this.state === S.DRAFT) {
      if (act >= ACT.PICK0 && act <= ACT.PICK2) this.pickTrait(act - ACT.PICK0);
      // 앞의 유닛 버튼 세 개도 그대로 선택에 매핑한다 — 손이 이미 거기 있다
      else if (act < C.TRAIT_OFFER) this.pickTrait(act);
      return;
    }

    // 행동 0~5 가 곧 유닛 종류 0~5 다. 변환도 분기도 없다.
    if (act >= 0 && act < C.UNIT_KINDS) { this.buy(act); return; }

    switch (act) {
      case ACT.ERA: this.buyEra(); break;
      case ACT.TOWER: this.buyTower(); break;
      case ACT.TIDE: this.useSkill(C.SK_TIDE); break;
      case ACT.VOLLEY: this.useSkill(C.SK_VOLLEY); break;
      case ACT.RALLY: this.useSkill(C.SK_RALLY); break;
      default: break;
    }
  }

  // ── 구매 ────────────────────────────────────────────────────
  buy(kind) {
    if (this.spawnCd[kind] > 0) { this.emit(EV.COOLDOWN, kind, 0); return; }
    const c = this.cost(kind);
    if (this.gold < c) { this.emit(EV.NO_GOLD, kind, 0); return; }
    this.gold -= c;
    this.goldSpentUnits += c;
    this.spawnCd[kind] = this.spawnCooldown(kind);
    this.spawn(SIDE_L, kind, this.era, 0);
  }

  // 시대가 오르면 기지도 같이 튼튼해진다. **비율을 유지하며** 곱하므로
  // 체력바가 튀지 않는다. 이게 없으면 후반 시대 유닛이 기지를 즉사시킨다.
  eraScaleBase(side, from, to) {
    const r = C.ERA_BASE_HP_MUL[to] / C.ERA_BASE_HP_MUL[from];
    this.baseMax[side] *= r;
    this.baseHp[side] *= r;
  }

  buyEra() {
    if (!this.eraReady()) { this.emit(EV.NO_GOLD, -1, 0); return; }
    const need = this.eraNeed();      // era++ 전에 잡아 둔다. 뒤에 읽으면 다음 시대 값이다
    this.xp -= need;
    this.era++;
    this.goldSpentEra += need;
    this.eraScaleBase(SIDE_L, this.era - 1, this.era);
    this.gold += C.ERA_UP_GOLD;
    // 진화는 판을 되돌리는 순간이다. 물이 크게 밀린다.
    this.water += C.WATER_ERA_PUSH;
    this.emit(EV.ERA_UP, this.era, SIDE_L);
    this.openDraft();
  }

  // 기지 포탑. 웅크리는 선택지에 실체를 준다 — 지금까지 수비는 그냥 지는 길이었다.
  buyTower() {
    const c = this.towerCost();
    if (c < 0) { this.emit(EV.COOLDOWN, -1, 0); return; }
    if (this.gold < c) { this.emit(EV.NO_GOLD, -1, 0); return; }
    this.gold -= c;
    // 포탑은 병력 지출로 센다. 디렉터가 "진화에 쓴 비중"을 볼 때
    // 포탑 값이 분모에서 빠지면 수비형이 경제형으로 오독된다.
    this.goldSpentUnits += c;
    this.goldSpentTower += c;
    this.towerLv++;
    this.towerCd = C.TOWER_CD;      // 사자마자 쏘지는 않는다
    this.emit(EV.TOWER_UP, this.towerLv, SIDE_L);
  }

  // ── 스킬 ────────────────────────────────────────────────────
  // 해일 · 화살비 · 증원. 셋 다 쿨다운이 독립이고 전부 결정론적이다.
  useSkill(i) {
    if (i < 0 || i >= C.SKILL_COUNT) return;
    if (this.state !== S.PLAY) return;
    if (this.skillCd[i] > 0) { this.emit(EV.COOLDOWN, -1, 0); return; }
    this.skillCd[i] = C.SKILL_CD[i];
    this.skillUsed[i]++;
    this.emit(EV.SKILL, i, SIDE_L);
    if (i === C.SK_TIDE) this.doTide();
    else if (i === C.SK_VOLLEY) this.doVolley();
    else this.doRally();
  }

  // 예전 이름 호환. 필살기는 해일이 되었다.
  fireNuke() { this.useSkill(C.SK_TIDE); }

  // 해일 — 적 전체에 피해를 주고 물을 크게 민다.
  // 기지는 건드리지 않는다. 그러면 이건 그냥 승리 버튼이 된다.
  doTide() {
    const dmg = C.SKILL_DMG[C.SK_TIDE];
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i] || this.uSide[i] !== SIDE_R) continue;
      this.damage(i, dmg, SIDE_L, -1);
    }
    this.water += C.NUKE_WATER_PUSH;
    this.nukes++;
    this.emit(EV.NUKE, 0, 0);     // feel·audio 의 기존 연출을 그대로 쓴다
  }

  // 화살비 — **전선 부근에만** 떨어진다. 아군은 한 대도 맞지 않는다.
  // 해일과 다른 점은 "언제 쓰는가"다. 전선이 뭉쳐 있을 때만 값이 나온다.
  doVolley() {
    const cx = this.frontlineX();
    const r = C.VOLLEY_RADIUS;
    const dmg = C.SKILL_DMG[C.SK_VOLLEY];
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i] || this.uSide[i] !== SIDE_R) continue;
      const x = this.uX[i];
      const d = x - cx;
      if (d < -r || d > r) continue;
      const gy = groundAt(x);
      this.pushArrow(x, gy - 320, x, gy - C.U_H[this.uKind[i]] * 0.5, SIDE_L);
      this.damage(i, dmg, SIDE_L, -1);
    }
  }

  // 증원 — 현재 시대 검사를 공짜로 즉시 세운다. 한 점에 겹치지 않게 뒤로 벌린다.
  doRally() {
    for (let k = 0; k < C.RALLY_COUNT; k++) {
      this.spawn(SIDE_L, C.U_SWORD, this.era, k * C.UNIT_GAP);
    }
  }

  // ── 유닛 소환 ───────────────────────────────────────────────
  spawn(side, kind, era, xoff) {
    // 풀에서 빈 자리를 찾는다. 없으면 소환하지 않는다 — 조용히 실패해야
    // 프레임이 튀지 않는다.
    let idx = -1;
    for (let k = 0; k < C.UNIT_MAX; k++) {
      const i = (this.uNext + k) % C.UNIT_MAX;
      if (!this.uAlive[i]) { idx = i; break; }
    }
    if (idx < 0) return;
    this.uNext = (idx + 1) % C.UNIT_MAX;

    const off = xoff > 0 ? xoff : 0;
    const hp = this.statHp(kind, era, side);
    this.uAlive[idx] = 1;
    this.uSide[idx] = side;
    this.uKind[idx] = kind;
    this.uEra[idx] = era;
    this.uX[idx] = side === SIDE_L ? C.SPAWN_L_X - off : C.SPAWN_R_X + off;
    this.uPrevX[idx] = this.uX[idx];
    this.uHp[idx] = hp;
    this.uHpMax[idx] = hp;
    this.uCd[idx] = 0;
    this.uHitFlash[idx] = 0;
    this.uAttack[idx] = 0;

    if (side === SIDE_L) { this.aliveL++; this.spawned++; this.spawnedKind[kind]++; }
    else this.aliveR++;
    this.emit(EV.SPAWN, kind, side);
  }

  // ── 한 스텝 ─────────────────────────────────────────────────
  step() {
    // 설명 화면 — **시뮬레이션도 시계도 멈춘다.** 설명을 읽은 시간이 기록에
    // 들어가면 안 된다. 다만 아무 입력이 없어도 저절로 열린다 —
    // 손이 없는 관전자(그리고 대조군 봇)를 영원히 붙잡아 두지 않는다.
    if (this.state === S.BRIEF) {
      this.stateTick++;
      if (this.stateTick * C.SIM_DT >= (C.BRIEF_MS > 0 ? C.BRIEF_MS : 9000)) this.dismissBrief();
      return;
    }

    this.prevWater = this.water;
    for (let i = 0; i < C.UNIT_MAX; i++) if (this.uAlive[i]) this.uPrevX[i] = this.uX[i];

    this.tick++;
    this.stateTick++;
    this.simTime += C.SIM_DT;

    if (this.state === S.DRAFT) { this.draftFrames++; return; }
    if (this.state === S.OVER) return;

    this.stepEconomy();
    this.stepAI();
    this.stepUnits();
    this.stepTower();
    this.stepAiTower();
    this.stepArrows();
    this.stepWater();
    this.stepTaunt();
    this.checkEnd();
  }

  // ── 도발 — AI 가 나를 읽은 순간이 문장이 된다 ─────────────────
  // 판정은 디렉터가 한다. 여기서는 **판정이 바뀐 것을 감지해서** 사령관에게
  // 말을 시킬 뿐이다. 디렉터가 아직 이 필드를 안 내놨으면 조용히 아무것도 안 한다.
  // (director.js 는 지금 다른 사람이 고치고 있다. 없어도 게임은 돈다)
  stepTaunt() {
    const d = this.supplier;
    if (!d) return;
    if (d.observing) return;                     // 관찰 중은 판정이 아니다
    const idx = d.profileIdx;
    if (!Number.isInteger(idx) || idx < 0) return;
    // 밸런스 감독이 justSwitched 를 내놓으면 **그쪽이 정본이다** —
    // 같은 프로파일로 "다시" 판정한 것까지 잡아 준다. 없으면 값 변화로 감지한다.
    const flagged = (d.justSwitched === true);
    if (!flagged && idx === this.tauntProfile) return;
    // 첫 판정이 '균형'이면 그건 아직 아무것도 못 읽은 것이다. 말없이 받아 둔다.
    if (!flagged && this.tauntProfile < 0 && idx === C.PROFILE_NEUTRAL) { this.tauntProfile = idx; return; }
    // 너무 잦으면 시끄럽다. 최소 간격을 둔다.
    if (this.simTime - this.tauntAt < C.TAUNT_MIN_MS) return;
    this.tauntProfile = idx;
    this.tauntAt = this.simTime;
    this.taunts++;
    this.emit(EV.TAUNT, this.commander, idx);
  }

  stepEconomy() {
    const dt = C.SIM_DT / 1000;
    this.gold += this.goldRate() * dt;
    if (this.gold > C.GOLD_CAP) this.gold = C.GOLD_CAP;
    if (this.gold > this.goldPeak) this.goldPeak = this.gold;
    this.goldSum += this.gold;
    this.goldSamples++;

    for (let k = 0; k < C.UNIT_KINDS; k++) {
      if (this.spawnCd[k] > 0) {
        this.spawnCd[k] -= C.SIM_DT;
        if (this.spawnCd[k] < 0) this.spawnCd[k] = 0;
      }
    }
    for (let k = 0; k < C.SKILL_COUNT; k++) {
      if (this.skillCd[k] > 0) {
        this.skillCd[k] -= C.SIM_DT;
        if (this.skillCd[k] < 0) this.skillCd[k] = 0;
      }
    }

    for (let k = 0; k < C.SKILL_COUNT; k++) {
      if (this.aiSkillCd[k] > 0) {
        this.aiSkillCd[k] -= C.SIM_DT;
        if (this.aiSkillCd[k] < 0) this.aiSkillCd[k] = 0;
      }
    }

    // 적도 같은 규칙으로 번다. 레버가 배수를 준다.
    // 레버 값이 깨져 있으면 배수를 무시한다. aiGold 가 한 번 NaN 이 되면
    // "살 돈이 있는가" 비교가 전부 false 가 되어 적이 무한히 쏟아진다 —
    // 판이 즉사로 끝나는데 원인이 여기라는 것을 아무도 못 찾는다.
    let rate = C.AI_GOLD_RATE;
    if (this.supplier && this.supplier.levers) {
      const m = +this.supplier.levers.goldMul;
      if (m > 0) rate *= m;
    }
    // 스테이지 곡선과 사령관 성격. 둘 다 1 근처의 작은 배수다 —
    // **적 수입을 크게 올리면 초반에 손 쓸 새 없이 밀려 학습이 안 된다** (계약 §5.5).
    // 수입 곡선은 STAGE_DIFF 가 아니라 STAGE_AI_GOLD 다. 이유는 config 주석에 있다.
    this.aiGold += rate * stageOf(C.STAGE_AI_GOLD, this.stage, 1) * this.cmdGoldMul() * dt;

    // 적의 시대 경험치는 지금까지 **플레이어를 죽여야만** 들어왔다.
    // 그래서 이기고 있는 판에서는 적이 영원히 돌 시대에 머물고, 플레이어만
    // 5시대를 열어 눈덩이가 굴렀다 — 실측 8판 중 5판이 적 기지 체력 0 으로 끝났다.
    // 시간으로 조금씩 흘려 넣으면 **후반이 어려워지되 초반은 그대로다.**
    // 이것이 "곡선이지 상수가 아니다"의 실제 구현이다.
    const xpRate = (C.AI_XP_RATE > 0) ? C.AI_XP_RATE : 0;
    this.aiXp += xpRate * stageOf(C.STAGE_AI_XP, this.stage, 1) * dt;
  }

  // 적 스킬의 쿨다운. 사령관 성격과 스테이지 난이도가 같이 줄인다.
  aiSkillCooldown(i) {
    const base = C.SKILL_CD[i] || 30000;
    const d = this.stageDiff();
    return base * this.cmdSkillMul() / (d > 0 ? d : 1);
  }

  // 적 사령관. **결정론적이다.** 디렉터의 레버가 성향을 정한다.
  stepAI() {
    this.aiThink -= C.SIM_DT;
    if (this.aiThink > 0) return;
    this.aiThink = C.AI_THINK_MS;

    const lv = this.supplier && this.supplier.levers ? this.supplier.levers : null;

    // 시대 진화 — 경험치가 차면 올린다. 레버가 문턱을 조절한다.
    // ── 시도했다가 실측으로 버린 것: 적 시대 상한(플레이어+1) ──
    // "적이 3시대 앞서서 진다"를 보고 상한을 걸었더니 **판이 더 길어졌다.**
    // 적이 앞서서 끝내던 판이 대등한 소모전이 되어 s1 204→217초, s2 111→270초,
    // 수비 봇은 300초 상한에 걸려 아예 안 끝났다. 승률은 그대로 0/4 였다.
    // 격차의 원인은 시대가 아니라 **적 포탑과 스킬**이었다 (아래 참조).
    if (this.aiEra + 1 < C.ERA_COUNT) {
      let th = lv ? +lv.eraThresh : 1;
      if (!(th > 0)) th = 1;
      const need = C.AI_ERA_XP[this.aiEra + 1] * th;
      if (this.aiXp >= need) {
        this.aiXp -= need;
        this.aiEra++;
        this.eraScaleBase(SIDE_R, this.aiEra - 1, this.aiEra);
        this.emit(EV.ERA_UP, this.aiEra, SIDE_R);
      }
    }

    // ── 사령관의 개전 한 수 ────────────────────────────────────
    // **온보딩이다.** 첫 전투의 첫 10초에 아무 일도 안 일어나면 심사자는 떠난다.
    // 기병(가장 빠르다)을 한 기 먼저 보낸다 — 소환지점에서 내 기지까지 8.8초라
    // 막든 못 막든 10초 안에 무언가가 부서지는 것을 보게 된다.
    // 공짜다. 적 경제를 건드리지 않으려고 금에서 빼지 않는다.
    if (this.aiIntro === 0 && this.simTime >= C.INTRO_POKE_MS) {
      this.aiIntro = 1;
      this.spawn(SIDE_R, C.U_CAV, this.aiEra, 0);
    }

    // ── 사령관도 짓고 쓴다 ─────────────────────────────────────
    // 지금까지 적은 유닛만 뽑았다. 포탑과 스킬이 플레이어 전용이면
    // 그건 게임의 절반을 적이 안 쓰는 것이고, 그만큼 판이 쉽다.
    this.stepAiTowerBuy();
    this.stepAiSkills();

    // 디렉터가 없으면 고정 웨이브를 돈다. 게임은 100% 돌아간다.
    if (!lv) {
      this.aiWaveTimer -= C.AI_THINK_MS;
      if (this.aiWaveTimer <= 0) {
        const kind = FALLBACK_WAVE[this.aiWaveIdx * 2 + 1];
        this.spawn(SIDE_R, kind, this.aiEra, 0);
        this.aiWaveIdx = (this.aiWaveIdx + 1) % (FALLBACK_WAVE.length / 2);
        this.aiWaveTimer = FALLBACK_WAVE[this.aiWaveIdx * 2];
      }
      return;
    }

    // 레버가 정한 구성비대로, 살 수 있으면 산다.
    // 무엇을 뽑을지는 mix 로, 얼마나 자주 뽑을지는 tempo 로 정해진다.
    this.aiHold -= C.AI_THINK_MS;
    if (this.aiHold > 0) return;

    const total = this.loadAiMix(lv);

    // **뽑을 것을 정했으면 살 때까지 붙든다.**
    // 판단마다 다시 뽑으면 비싼 유닛이 나올 때마다 "못 사니 다음 판단" 이 되고,
    // 다음 판단에서는 싼 유닛이 뽑혀 그냥 사 버린다 — 그래서 적이 영원히
    // 검사만 뽑는다. 구성비를 줬는데 구성이 안 갈리는 이유가 이거였다.
    if (this.aiPick < 0) this.aiPick = this.pickAiKind(total);
    let kind = this.aiPick;

    if (this.aiGold < this.aiCost(kind)) {
      // 모으는 것은 좋다. 다만 **영원히 모으면 안 된다** —
      // 적이 아무것도 안 내보내는 구간이 생기면 판이 그대로 늘어진다.
      this.aiWait++;
      if (this.aiWait < 8) return;
      const alt = this.cheapestAffordable();
      if (alt < 0) return;
      kind = alt;
    }
    // 축재형 사령관은 **모았다가 쏟는다.** 문턱 아래에서는 사지 않는다.
    // 다만 이미 사려던 것을 살 수 있으면 그냥 산다 — 안 그러면 영원히 안 나온다.
    const hoard = this.cmdHoard();
    if (hoard > 0 && this.aiGold < hoard && this.aiWait < 8) { this.aiWait++; return; }

    this.aiPick = -1;
    this.aiWait = 0;
    this.aiGold -= this.aiCost(kind);
    this.spawn(SIDE_R, kind, this.aiEra, 0);
    const tempo = +lv.tempo;
    // 사령관 성격과 스테이지가 템포를 당긴다. 하한은 디렉터와 같은 420ms.
    let hold = (tempo > 0 ? tempo : C.AI_THINK_MS) * this.cmdTempoMul();
    hold /= (1 + (this.stageDiff() - 1) * 0.6);
    this.aiHold = hold > 420 ? hold : 420;
  }

  // ── 적 포탑 ─────────────────────────────────────────────────
  // 사령관마다 지으려는 단계가 다르다 (C.CMD_TOWER). 농성형이 가장 많이 짓는다.
  // **첫 전투에서는 아무도 짓지 않는다** — 가르치는 전투이기 때문이다.
  stepAiTowerBuy() {
    const want = this.stage < 1 ? 0 : this.cmdTowerWant();
    if (this.aiTowerLv >= want || this.aiTowerLv >= C.TOWER_MAX) return;
    const c = C.TOWER_COST[this.aiTowerLv];
    // 병력을 살 여유까지 남을 때만 짓는다. 포탑 사느라 전선이 비면 그건 자살이다.
    if (this.aiGold < c * C.AI_TOWER_BUY_MUL) return;
    this.aiGold -= c;
    this.aiTowerLv++;
    this.aiTowerCd = C.TOWER_CD;
    // EV.TOWER_UP 은 **내보내지 않는다.** 디렉터가 그 이벤트를 진영 구분 없이
    // "플레이어가 기지에 쓴 금"으로 세고 있어 판정이 오염된다. 렌더는
    // game.aiTowerLv 를 직접 보고 있으므로 화면에는 그대로 보인다.
  }

  // 사거리 안에서 **가장 앞선 플레이어 유닛**을 쏜다. 내 포탑의 거울이다.
  stepAiTower() {
    if (this.aiTowerLv <= 0) return;
    if (this.aiTowerCd > 0) {
      this.aiTowerCd -= C.SIM_DT;
      if (this.aiTowerCd > 0) return;
      this.aiTowerCd = 0;
    }
    const bx = C.BASE_R_X;
    let best = -1, bestX = -1e9;
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i] || this.uSide[i] !== SIDE_L) continue;
      const x = this.uX[i];
      if (bx - x > C.TOWER_RANGE) continue;
      if (x > bestX) { bestX = x; best = i; }
    }
    if (best < 0) return;

    this.aiTowerCd = C.TOWER_CD;
    const dmg = C.TOWER_DMG[this.aiTowerLv - 1] * C.ERA_DMG_MUL[this.aiEra];
    this.pushArrow(bx, C.GROUND_Y - C.BASE_H, bestX,
                   groundAt(bestX) - C.U_H[this.uKind[best]] * 0.5, SIDE_R);
    this.damage(best, dmg, SIDE_R, -1);
    this.emit(EV.TOWER_FIRE, this.aiTowerLv, SIDE_R);
  }

  // ── 적 스킬 ─────────────────────────────────────────────────
  // 조건은 전부 **플레이어의 실수**다. 시간이 아니라 상황이 방아쇠라
  // 같은 실수를 반복하지 않으면 맞을 일이 없다 — 그게 배울 수 있는 난이도다.
  //   해일   병력을 한곳에 너무 많이 모았다
  //   화살비 전선에 뭉쳐 있다
  //   증원   적 전선이 비었는데 플레이어가 밀고 들어온다
  stepAiSkills() {
    if (this.stage < 1) return;        // 첫 전투는 가르치는 전투다
    if (this.aliveL <= 0) return;

    if (this.aiSkillCd[C.SK_TIDE] <= 0 && this.aliveL >= C.AI_TIDE_MIN) {
      this.aiSkillCd[C.SK_TIDE] = this.aiSkillCooldown(C.SK_TIDE);
      this.aiSkillUsed[C.SK_TIDE]++;
      this.emit(EV.SKILL, C.SK_TIDE, SIDE_R);
      const dmg = C.SKILL_DMG[C.SK_TIDE];
      for (let i = 0; i < C.UNIT_MAX; i++) {
        if (!this.uAlive[i] || this.uSide[i] !== SIDE_L) continue;
        this.damage(i, dmg, SIDE_R, -1);
      }
      return;
    }

    if (this.aiSkillCd[C.SK_VOLLEY] <= 0) {
      const cx = this.frontlineX();
      const r = C.VOLLEY_RADIUS;
      let n = 0;
      for (let i = 0; i < C.UNIT_MAX; i++) {
        if (!this.uAlive[i] || this.uSide[i] !== SIDE_L) continue;
        const d = this.uX[i] - cx;
        if (d >= -r && d <= r) n++;
      }
      if (n >= C.AI_VOLLEY_MIN) {
        this.aiSkillCd[C.SK_VOLLEY] = this.aiSkillCooldown(C.SK_VOLLEY);
        this.aiSkillUsed[C.SK_VOLLEY]++;
        this.emit(EV.SKILL, C.SK_VOLLEY, SIDE_R);
        const dmg = C.SKILL_DMG[C.SK_VOLLEY];
        for (let i = 0; i < C.UNIT_MAX; i++) {
          if (!this.uAlive[i] || this.uSide[i] !== SIDE_L) continue;
          const x = this.uX[i];
          const d = x - cx;
          if (d < -r || d > r) continue;
          const gy = groundAt(x);
          this.pushArrow(x, gy - 320, x, gy - C.U_H[this.uKind[i]] * 0.5, SIDE_R);
          this.damage(i, dmg, SIDE_R, -1);
        }
        return;
      }
    }

    if (this.aiSkillCd[C.SK_RALLY] <= 0
        && this.aliveR <= C.AI_RALLY_MAX && this.aliveL >= C.AI_RALLY_MAX + 2) {
      this.aiSkillCd[C.SK_RALLY] = this.aiSkillCooldown(C.SK_RALLY);
      this.aiSkillUsed[C.SK_RALLY]++;
      this.emit(EV.SKILL, C.SK_RALLY, SIDE_R);
      for (let k = 0; k < C.RALLY_COUNT; k++) {
        this.spawn(SIDE_R, C.U_SWORD, this.aiEra, k * C.UNIT_GAP);
      }
    }
  }

  // 레버의 mix 를 길이 6 가중치 버퍼로 옮긴다.
  // **길이가 6이 아니어도 게임은 돌아가야 한다.** 밸런스 감독이 아직 스키마를
  // 안 늘렸을 수 있고, 그때 게임이 죽으면 그건 이쪽 잘못이다.
  // 짧으면 앞에서부터 있는 만큼만 쓰고 나머지는 0으로 둔다.
  loadAiMix(lv) {
    const w = this.aiMix;
    const mix = lv && lv.mix ? lv.mix : null;
    const n = mix && mix.length > 0 ? (mix.length < C.UNIT_KINDS ? mix.length : C.UNIT_KINDS) : 0;
    let total = 0;
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      let v = 0;
      if (k < n) {
        v = +mix[k];
        if (!(v > 0)) v = 0;      // NaN·음수·undefined 전부 0으로 떨어진다
      }
      w[k] = v;
      total += v;
    }
    return this.blendCommanderMix(total);
  }

  // ── 사령관의 기본 구성을 디렉터의 구성 위에 섞는다 ────────────
  // 계약 §3: **사령관은 디렉터를 대체하지 않는다.** 사령관이 그 전투의 성격을
  // 정하고 디렉터는 그 위에서 플레이어를 읽는다. 그래서 덮어쓰지 않고 섞는다.
  //
  // 둘 다 합을 1로 맞춘 뒤 섞는다. 스케일이 다르면 한쪽이 통째로 묻힌다 —
  // 디렉터의 mix 합은 정책·상성 보정에 따라 9~30 사이를 오간다.
  //
  // 밸런스 감독이 setCommander() 훅을 만들어 **디렉터가 직접** 사령관을 반영하면
  // 여기서는 손을 뗀다. 안 그러면 같은 성격이 두 번 곱해진다.
  blendCommanderMix(total) {
    if (this.supplier && typeof this.supplier.setCommander === 'function') return total;
    const rows = C.CMD_MIX;
    const row = rows && rows[this.commander];
    if (!row || row.length < C.UNIT_KINDS) return total;
    const w = +C.CMD_MIX_W;
    if (!(w > 0)) return total;

    let ctot = 0;
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      const v = +row[k];
      this.cmdMix[k] = (v > 0) ? v : 0;
      ctot += this.cmdMix[k];
    }
    if (!(ctot > 0)) return total;

    let out = 0;
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      const a = total > 0 ? this.aiMix[k] / total : 0;
      const b = this.cmdMix[k] / ctot;
      const v = a * (1 - w) + b * w;
      this.aiMix[k] = v;
      out += v;
    }
    return out;
  }

  // 결정론적 선택. Math.random 없음 — 재현 불가능해지면 증거가 못 된다.
  // tick 을 정수 해시로 섞어 위상을 만든다. 같은 판이면 같은 순서가 나온다.
  // total 은 loadAiMix() 가 방금 채운 aiMix 의 합이다.
  pickAiKind(total) {
    if (!(total > 0)) return C.U_SWORD;
    let h = Math.imul(this.tick + 0x9E3779B9, 2654435761) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519) >>> 0;
    // `h ^ x` 의 결과는 **부호 있는** 32비트다. `>>> 0` 을 빼먹으면 h 가 절반의
    // 확률로 음수가 되고, 음수 phase 는 첫 칸(검사)에 무조건 걸린다 —
    // **aiMix[0] 이 0이어도.** 적 소환의 49.7%가 구성비를 무시하고 검사였다.
    // 디렉터가 벽 정책(거인 52%)을 지시해도 화면에는 검사가 나왔다.
    h = (h ^ (h >>> 13)) >>> 0;
    const phase = (h % 100003) / 100003 * total;
    let acc = 0;
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      acc += this.aiMix[k];
      if (phase < acc) return k;
    }
    return C.U_SWORD;
  }

  // 가중치가 있는 것 중 지금 살 수 있는 가장 싼 종류. 없으면 -1.
  cheapestAffordable() {
    let best = -1, bestC = 1e9;
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      if (this.aiMix[k] <= 0) continue;
      const c = this.aiCost(k);
      if (c > this.aiGold || c >= bestC) continue;
      bestC = c; best = k;
    }
    return best;
  }

  // ── 유닛 갱신 ───────────────────────────────────────────────
  stepUnits() {
    const dt = C.SIM_DT / 1000;
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i]) continue;
      if (this.uHitFlash[i] > 0) this.uHitFlash[i]--;
      if (this.uAttack[i] > 0) this.uAttack[i]--;
      if (this.uCd[i] > 0) this.uCd[i] -= C.SIM_DT;

      const side = this.uSide[i];
      const kind = this.uKind[i];
      const dir = side === SIDE_L ? 1 : -1;
      const range = C.U_RANGE[kind];

      // ── 1) 유닛 표적이 먼저다 ──────────────────────────────────────
      // 기지를 먼저 보게 하는 안을 재봤다. 기병이 궁수 대열의 꼬리에 닿는 순간
      // 남은 궁수를 버리고 기지를 때리기 시작해 등 뒤에서 사살당했고,
      // 계약의 "기병>궁수" 변이 8:8 에서 1:0 → 0:3 으로 뒤집혔다. 그래서 되돌렸다.
      // 기지에 닿는 문제는 표적 순서가 아니라 물과 시대 경제의 문제였다.
      if (C.U_SIEGE[kind] !== 1) {
        const target = this.findTarget(i, side, dir, range);
        if (target >= 0) {
          // 너무 가까우면 공격도 전진도 못 한다. 서서 얻어맞는다 —
          // 이게 "궁수는 근접에 약하다"의 실체다. 더 먼 적으로 표적을 바꾸지도
          // 않는다. 코앞에 붙은 적을 두고 뒤를 쏘는 것이 오히려 이상하다.
          const minR = U_MIN_RANGE[kind];
          if (minR > 0 && (this.uX[target] - this.uX[i]) * dir < minR) continue;
          if (this.uCd[i] <= 0) {
            this.uCd[i] = this.statCooldown(kind, side);
            this.uAttack[i] = 8;
            // 상성은 여기서 곱해진다. damage() 안 한 곳에서만.
            this.damage(target, this.statDmg(kind, this.uEra[i], side), side, kind);
            if (kind === C.U_ARCHER || kind === C.U_CATA) this.shoot(i, target, side);
            this.emit(EV.ATTACK, kind, side);
          }
          continue;   // 싸우는 동안에는 전진하지 않는다
        }
      }
      // 공성 병기(투석기)는 위 블록을 통째로 건너뛴다. 유닛을 표적으로 삼지 않고
      // 공성선까지 걸어가 기지만 친다 — 그 이유는 config 의 U_SIEGE 주석에 있다.

      // ── 2) 적 기지 ────────────────────────────────────────────────
      // 사거리에 하한("앞마당")을 주는 안을 재봤지만 상성 삼각형이 깨졌다.
      // 자세한 실측은 config 의 BASE_DMG_MUL 아래 주석에 있다.
      const baseX = side === SIDE_L ? C.BASE_R_X : C.BASE_L_X;
      if (Math.abs(this.uX[i] - baseX) <= C.BASE_W * 0.5 + range) {
        if (this.uCd[i] <= 0) {
          this.uCd[i] = this.statCooldown(kind, side);
          this.uAttack[i] = 8;
          // 투석기는 기지를 부수라고 있는 유닛이다. U_BASE_MUL 이 그걸 정한다.
          let dmg = this.statDmg(kind, this.uEra[i], side) * C.BASE_DMG_MUL * C.U_BASE_MUL[kind];
          if (side === SIDE_L && this.has('siege')) dmg *= 2;
          if (kind === C.U_ARCHER || kind === C.U_CATA) {
            const gy = groundAt(this.uX[i]);
            this.pushArrow(this.uX[i], gy - C.U_H[kind] * 0.6, baseX, C.GROUND_Y - C.BASE_H * 0.5, side);
          }
          this.hitBase(side === SIDE_L ? SIDE_R : SIDE_L, dmg);
        }
        continue;
      }

      // 앞에 아군이 막고 있으면 밀지 않는다. 이게 없으면 전부 한 점에 뭉친다.
      if (this.blockedAhead(i, side, dir)) continue;
      this.uX[i] += this.statSpeed(kind, side) * dir * dt;
    }

    // 물에 잠긴 유닛은 익사한다. **가운데가 가장 낮으므로 전선이 먼저 잠긴다** —
    // 밀지 못하고 물고 늘어지는 쪽이 먼저 병력을 잃는다.
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i]) continue;
      if (groundAt(this.uX[i]) <= this.water) continue;
      this.damage(i, C.DROWN_DPS * dt, this.uSide[i] === SIDE_L ? SIDE_R : SIDE_L, -1);
    }
  }

  // ── 기지 포탑 ───────────────────────────────────────────────
  // 사거리 안에서 **가장 앞선 적**(내 기지에 가장 가까운 적)을 자동으로 쏜다.
  // 뒤에 있는 적을 먼저 때리면 포탑이 방어를 못 한다.
  stepTower() {
    if (this.towerLv <= 0) return;
    if (this.towerCd > 0) {
      this.towerCd -= C.SIM_DT;
      if (this.towerCd > 0) return;
      this.towerCd = 0;
    }
    const bx = C.BASE_L_X;
    let best = -1, bestX = 1e9;
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i] || this.uSide[i] !== SIDE_R) continue;
      const x = this.uX[i];
      if (x - bx > C.TOWER_RANGE) continue;
      if (x < bestX) { bestX = x; best = i; }
    }
    if (best < 0) return;

    this.towerCd = C.TOWER_CD;
    this.towerShots++;
    // 시대가 오르면 포탑도 같이 큰다. 안 그러면 강철 시대부터 장식이 된다.
    const dmg = C.TOWER_DMG[this.towerLv - 1] * C.ERA_DMG_MUL[this.era];
    this.pushArrow(bx, C.GROUND_Y - C.BASE_H, bestX, groundAt(bestX) - C.U_H[this.uKind[best]] * 0.5, SIDE_L);
    this.damage(best, dmg, SIDE_L, -1);
    this.emit(EV.TOWER_FIRE, this.towerLv, SIDE_L);
  }

  // 화살 하나를 띄운다. 판정과 무관하다 — 이미 맞은 것을 눈에 보이게 할 뿐이다.
  pushArrow(x0, y0, x1, y1, side) {
    const a = this.aNext;
    this.aNext = (this.aNext + 1) % C.ARROW_MAX;
    const total = Math.max(1, Math.round(C.ARROW_MS / C.SIM_DT));
    this.aLife[a] = total;
    this.aTotal[a] = total;
    this.aX0[a] = x0; this.aY0[a] = y0;
    this.aX1[a] = x1; this.aY1[a] = y1;
    this.aSide[a] = side;
  }

  shoot(from, to, side) {
    const k = this.uKind[from];
    this.pushArrow(
      this.uX[from], groundAt(this.uX[from]) - C.U_H[k] * 0.6,
      this.uX[to], groundAt(this.uX[to]) - C.U_H[this.uKind[to]] * 0.5,
      side);
  }

  stepArrows() {
    for (let i = 0; i < C.ARROW_MAX; i++) if (this.aLife[i] > 0) this.aLife[i]--;
  }

  findTarget(i, side, dir, range) {
    const x = this.uX[i];
    let best = -1, bestD = 1e9;
    for (let j = 0; j < C.UNIT_MAX; j++) {
      if (!this.uAlive[j] || this.uSide[j] === side) continue;
      // 앞쪽만 본다. 뒤까지 대칭으로 열어 봤지만 결투 6변의 결과가 한 판도
      // 바뀌지 않았다(추월이 실제로는 일어나지 않는다). 그래서 되돌렸다.
      const d = (this.uX[j] - x) * dir;      // 앞쪽이 양수
      if (d < -6 || d > range) continue;
      if (d < bestD) { bestD = d; best = j; }
    }
    return best;
  }

  // 앞에 아군이 있으면 밀지 않는다 — 다만 **공성 병기는 줄에 서지 않는다.**
  // 실측: 투석기가 자기 진영 대열의 맨 뒤에 갇혀 공성선(x=514)에 평생 못 갔다
  // (최대 도달 344·366). 대열은 전선에서부터 21px 간격으로 10~15기가 늘어서고
  // 투석기는 가장 느려서 언제나 꼬리다. 표적 규칙을 고쳐도 이게 남아 있으면
  // 투석기는 여전히 없는 유닛이다. 그래서 공성 병기는 대열을 통과한다 —
  // 대신 아무도 자기를 막아주지 않으므로 전선보다 앞서면 그대로 죽는다.
  blockedAhead(i, side, dir) {
    if (C.U_SIEGE[this.uKind[i]] === 1) return false;
    const x = this.uX[i];
    for (let j = 0; j < C.UNIT_MAX; j++) {
      if (j === i || !this.uAlive[j] || this.uSide[j] !== side) continue;
      if (C.U_SIEGE[this.uKind[j]] === 1) continue;   // 공성 병기는 남을 막지도 않는다
      const d = (this.uX[j] - x) * dir;
      if (d > 0 && d < C.UNIT_GAP) return true;
    }
    return false;
  }

  // atkKind 를 넘기면 상성 배수가 여기서 곱해진다.
  // 익사·해일·화살비·포탑처럼 "종류가 없는" 피해는 -1 을 넘긴다.
  damage(idx, dmg, byWhom, atkKind) {
    if (atkKind !== undefined && atkKind >= 0) {
      const m = C.COUNTER[atkKind * C.UNIT_KINDS + this.uKind[idx]];
      if (m > 1) {
        dmg *= m;
        this.counterHits++;
        this.emit(EV.COUNTER_HIT, atkKind, byWhom);
      }
    }

    this.uHp[idx] -= dmg;
    this.uHitFlash[idx] = 4;
    if (this.uHp[idx] > 0) return;

    const kind = this.uKind[idx];
    const side = this.uSide[idx];
    this.uAlive[idx] = 0;
    if (side === SIDE_L) { this.aliveL--; } else { this.aliveR--; }

    // 늦은 시대의 유닛을 잡을수록 경험치가 크다. 시대가 오를수록 다음 시대가
    // 가까워진다 — 그래야 5시대가 판 안에 들어온다.
    const xpGain = C.U_XP[kind] * C.ERA_XP_MUL[this.uEra[idx]];
    if (byWhom === SIDE_L) {
      this.kills++;
      this.gold += C.U_BOUNTY[kind] * (this.has('loot') ? 2 : 1);
      this.xp += xpGain * (this.has('study') ? 1.4 : 1);
      // 적을 잡으면 물이 밀린다. **공격이 곧 생존이다** — 이게 교착을 푼다.
      // 다만 시간이 갈수록 덜 밀린다. 안 그러면 오래 싸울수록 물이 사라져
      // 마감 시계가 꺼진다 (config 의 WATER_PUSH_FADE_MS 주석 참조).
      this.water += C.WATER_KILL_PUSH * (this.has('revive') ? 1.8 : 1) * this.waterPushK();
    } else {
      this.lost++;
      this.aiXp += xpGain;
      // 적의 현상금은 깎아서 준다. 안 그러면 밀리기 시작한 판이 스스로 굳는다 —
      // 적이 잡을수록 더 벌고, 더 벌어서 더 잡는다. config 주석 참조.
      this.aiGold += C.U_BOUNTY[kind] * (C.AI_BOUNTY_MUL > 0 ? C.AI_BOUNTY_MUL : 1);
    }
    this.emit(EV.KILL, kind, byWhom);
  }

  // 물 밀어내기의 감쇠 계수. 1 에서 시작해 WATER_PUSH_FLOOR 까지 내려간다.
  waterPushK() {
    const f = C.WATER_PUSH_FADE_MS;
    if (!(f > 0)) return 1;
    const floor = C.WATER_PUSH_FLOOR > 0 ? C.WATER_PUSH_FLOOR : 0;
    const k = 1 - this.simTime / f;
    return k > floor ? k : floor;
  }

  hitBase(side, dmg) {
    this.baseHp[side] -= dmg;
    this.baseFlash[side] = 5;
    if (this.baseHp[side] <= 0) {
      this.baseHp[side] = 0;
      if (this.baseDownBy[side] === 0) this.baseDownBy[side] = 1;   // 병력
    }
    this.emit(EV.BASE_HIT, dmg, side);
  }

  // ── 물 ──────────────────────────────────────────────────────
  stepWater() {
    const dt = C.SIM_DT / 1000;
    const t = this.simTime / 1000;
    let rise = C.WATER_RISE;
    if (t > C.WATER_ACCEL_AT) rise *= C.WATER_ACCEL_MUL;
    if (this.has('drain')) rise *= 0.75;
    // 스테이지 곡선 — **후반의 시간 압박은 여기서 온다.** 익사 피해(DROWN_DPS)가
    // 아니다. 그건 병력이 전선에 닿기도 전에 죽여 교착을 굳혔던 값이다 (계약 §5.5).
    rise *= this.stageWaterMul();
    if (this.supplier && this.supplier.levers) {
      const m = +this.supplier.levers.waterMul;
      if (m > 0) rise *= m;      // 깨진 값이면 무시한다. water 가 NaN 이 되면 판이 굳는다
    }

    this.water -= rise * dt;                       // y가 작아질수록 높이 찬다
    if (this.water < C.WATER_MIN_Y) this.water = C.WATER_MIN_Y;
    if (this.water > C.WATER_Y0) this.water = C.WATER_Y0;

    if (!this.waterWarned && this.water < C.GROUND_Y + C.WATER_WARN) {
      this.waterWarned = true;
      this.emit(EV.WATER_WARN, 0, 0);
    }

    // 수면이 **기지 발밑**을 넘으면 양쪽 기지가 깎인다.
    // 기지는 협곡 가장자리(높은 곳)에 있어 전선보다 한참 늦게 잠긴다 —
    // 그때까지 승부가 안 났으면 둘 다 죽는 게 맞다.
    if (this.water <= C.WATER_BASE_AT) {
      // **물은 밀리는 쪽을 먼저 삼킨다.**
      // 양쪽을 똑같이 깎았더니 두 기지가 같은 프레임에 0이 되어 무승부가
      // 기본 결말이 됐다(네 전략 중 둘). 전선이 어디 있느냐로 갈라야
      // 밀어붙인 쪽이 보상을 받고, 그래야 전략 선택에 의미가 생긴다.
      //   전선 0.5 → 양쪽 같음.  0.8(내가 밀고 있음) → 적이 1.6배, 내가 0.4배
      // 시대가 오르면 기지 체력이 커진다. 물 피해가 상수면 후반에 물이 시계가
      // 아니게 되어 판이 다시 안 끝난다. **비율로 깎는다.**
      const front = this.frontline();
      const d = C.WATER_DPS * dt * 2;
      this.baseHp[SIDE_L] -= d * (1 - front) * (this.baseMax[SIDE_L] / C.BASE_HP);
      this.baseHp[SIDE_R] -= d * front * (this.baseMax[SIDE_R] / C.BASE_HP);
      for (let sd = 0; sd < 2; sd++) {
        if (this.baseHp[sd] <= 0) {
          this.baseHp[sd] = 0;
          if (this.baseDownBy[sd] === 0) this.baseDownBy[sd] = 2;   // 물
        }
      }
      if (this.tick % 30 === 0) this.emit(EV.WATER_HIT, 0, 0);
    }
  }

  checkEnd() {
    if (this.baseHp[SIDE_R] <= 0 && this.baseHp[SIDE_L] <= 0) {
      // 둘 다 0이면 **무엇이 무너뜨렸는지**로 가른다.
      // 병력으로 적진을 함락시켰다면 그건 이긴 것이다. 물이 뒤따라온 것뿐이다.
      if (this.baseDownBy[SIDE_R] === 1 && this.baseDownBy[SIDE_L] !== 1) return this.finish(C.WIN_PLAYER);
      if (this.baseDownBy[SIDE_L] === 1 && this.baseDownBy[SIDE_R] !== 1) return this.finish(C.WIN_ENEMY);
      return this.finish(C.WIN_DROWN);
    }
    if (this.baseHp[SIDE_R] <= 0) return this.finish(C.WIN_PLAYER);
    // 내 기지만 무너졌으면 그냥 패배다. 물이 높다고 무승부가 아니다 —
    // 적 기지는 멀쩡한데 "둘 다 잠겼다"고 하면 거짓말이다.
    if (this.baseHp[SIDE_L] <= 0) return this.finish(C.WIN_ENEMY);
  }

  finish(outcome) {
    this.outcome = outcome;
    this.endTick = this.tick;
    this.endTime = this.simTime;      // 여기서 시계가 선다
    if (outcome === C.WIN_PLAYER) {
      this.wins++;
      const t = this.simTime / 1000;
      if (this.bestTime === 0 || t < this.bestTime) this.bestTime = t;
    } else this.losses++;
    this.setState(S.OVER);
    this.emit(outcome === C.WIN_PLAYER ? EV.WIN : EV.LOSE, outcome, 0);

    // ── 원정의 마디 ────────────────────────────────────────────
    // 이겼으면 이 전투가 끝난 것이고, 그 밖에는 **원정 자체가 끝난 것이다.**
    // 무승부(둘 다 잠김)도 원정 종료다 — 다음 사령관을 만날 자격은 승리뿐이다.
    if (outcome === C.WIN_PLAYER) {
      this.stagesCleared++;
      this.emit(EV.STAGE_CLEAR, this.stage, 0);
      if (this.stage + 1 >= this.stageMax) {
        this.campaignOver = true;
        this.emit(EV.CAMPAIGN_END, this.stagesCleared, 1);
      }
    } else {
      this.campaignOver = true;
      this.emit(EV.CAMPAIGN_END, this.stagesCleared, 0);
    }
  }

  // ── 특성 드래프트 ───────────────────────────────────────────
  openDraft() {
    if (this.supplier && this.supplier.draftOffer) {
      this.supplier.draftOffer(this, this.draftIdx);
    } else {
      for (let i = 0; i < C.TRAIT_OFFER; i++) this.draftIdx[i] = i;
    }
    this.draftOpen = true;
    this.draftFrames = 0;
    this.setState(S.DRAFT);
    this.emit(EV.DRAFT_OPEN, 0, 0);
  }

  pickTrait(slot) {
    if (!this.draftOpen) return;
    const idx = this.draftIdx[clamp(slot, 0, C.TRAIT_OFFER - 1)];
    if (idx < 0) return;
    this.applyTrait(idx);
    this.draftOpen = false;
    this.emit(EV.DRAFT_PICK, idx, C.TRAITS[idx].kind);
    this.setState(S.PLAY);
  }

  // ── 조회 ────────────────────────────────────────────────────
  // **판이 끝나면 시계가 선다.** simTime 은 계속 흐르지만(히트스톱·도발 간격·
  // feel 이 그걸 쓴다) 화면에 나가는 값은 끝난 순간에 고정된다.
  // 사용자 보고: "게임이 끝났는데 걸린 시간이 계속 늘어나".
  stageTime() { return (this.endTime >= 0 ? this.endTime : this.simTime) / 1000; }
  // 원정 누적 — 앞선 전투들의 합 + 이번 전투.
  campaignTime() { return (this.campaignMs + (this.endTime >= 0 ? this.endTime : this.simTime)) / 1000; }
  // 예전 이름. render·평가기가 이걸 부른다 — 이번 전투 시간이다.
  elapsed() { return this.stageTime(); }
  waterK() {
    // 0 = 안 보임, 1 = 지면까지 찼다
    const span = C.WATER_Y0 - C.GROUND_Y;
    return clamp((C.WATER_Y0 - this.water) / span, 0, 1);
  }
  waterNear() {
    const d = this.water - C.GROUND_Y;
    return d < C.WATER_WARN ? clamp(1 - d / C.WATER_WARN, 0, 1) : 0;
  }
  baseK(side) { return clamp(this.baseHp[side] / this.baseMax[side], 0, 1); }
  goldAvg() { return this.goldSamples > 0 ? this.goldSum / this.goldSamples : 0; }

  // 전선의 화면 x. 게임필이 파편을 어디에 뿌릴지 정할 때 쓴다.
  frontlineX() {
    return C.BASE_L_X + (C.BASE_R_X - C.BASE_L_X) * this.frontline();
  }

  // 전선 — 양쪽 최전방 유닛의 중간. 밀고 있는지 밀리는지가 한 숫자로 나온다.
  frontline() {
    let fl = C.BASE_L_X, fr = C.BASE_R_X;
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i]) continue;
      if (this.uSide[i] === SIDE_L) { if (this.uX[i] > fl) fl = this.uX[i]; }
      else if (this.uX[i] < fr) fr = this.uX[i];
    }
    const mid = (fl + fr) * 0.5;
    return clamp((mid - C.BASE_L_X) / (C.BASE_R_X - C.BASE_L_X), 0, 1);
  }
}
