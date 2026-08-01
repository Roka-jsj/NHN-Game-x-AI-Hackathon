// 시뮬레이션 — 레인 이동 · 점프 · 슬라이드 · 충돌 · 물 추격 · 계단 · 특성.
// 이 파일은 시각·청각·입력장치를 모른다. 순수하게 상태만 굴린다.
//
// 규칙 1: 고정 스텝이다. 이 파일 어디에도 deltaTime을 곱하는 코드가 없다.
// 규칙 2: 상태 전이는 setState() 한 곳에서만 일어난다.
// 규칙 3: 판정에 Math.random()을 쓰지 않는다. 재현 가능해야 한다.

import * as C from './config.js';

export const S = { RUN: 0, STAIR: 1, DRAFT: 2, DEAD: 3 };
export const STATE_NAME = ['RUN', 'STAIR', 'DRAFT', 'DEAD'];

// 수직 자세
export const V = { GROUND: 0, JUMP: 1, SLIDE: 2 };

// 입력 행동. 좌/우는 두 모드가 공유하는 하나의 동사다.
export const ACT = { LEFT: 0, RIGHT: 1, JUMP: 2, SLIDE: 3, PICK0: 4, PICK1: 5, PICK2: 6 };

export const EV = {
  MOVE: 0,          // a = 새 레인
  JUMP: 1,
  SLIDE: 2,
  LAND: 3,
  COIN: 4,
  NEAR_MISS: 5,     // a = 스친 거리
  HIT: 6,           // a = 장애물 종류
  SHIELD: 7,
  COMBO: 8,         // a = 콤보, b = 티어
  COMBO_BREAK: 9,
  STAIR_ENTER: 10,
  STAIR_STEP: 11,   // a = 오른 칸 수
  STAIR_MISS: 12,
  STAIR_CLEAR: 13,  // a = 정확도 0~1
  DRAFT_OPEN: 14,
  DRAFT_PICK: 15,   // a = 특성 인덱스, b = 계열
  RECORD: 16,
  DEATH: 17,
  RESET: 18,
};

// 디렉터가 없을 때 쓰는 고정 트랙 패턴. 12행이 반복된다.
// 행마다 [장애물 3레인, 코인 3레인]. 0=없음 1=낮은벽 2=높은빔 3=기둥.
// **세 레인이 동시에 막힌 행은 없다.** 있으면 어떻게 해도 못 지나가고, 그건 플레이어 탓이 아니다.
export const FALLBACK_PATTERN = new Uint8Array([
  0, 0, 0,   0, 1, 0,
  1, 0, 0,   0, 1, 0,
  0, 0, 1,   0, 1, 0,
  0, 2, 0,   1, 0, 1,
  3, 0, 0,   0, 0, 1,
  0, 0, 3,   1, 0, 0,
  1, 1, 0,   0, 0, 1,
  0, 0, 0,   1, 1, 1,
  0, 3, 0,   1, 0, 1,
  2, 0, 2,   0, 1, 0,
  0, 1, 1,   1, 0, 0,
  3, 0, 3,   0, 1, 0,
]);

function easeOutQuad(t) { return t * (2 - t); }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

export class Game {
  constructor() {
    // ─ 트랙 행 링버퍼. 루프 안에서 객체를 만들지 않기 위해 타입배열로 둔다 ─
    this._rowZ = new Float64Array(C.ROW_POOL);
    this._rowOb = new Uint8Array(C.ROW_POOL * C.LANE_COUNT);
    this._rowCoin = new Uint8Array(C.ROW_POOL * C.LANE_COUNT);
    this._rowTaken = new Uint8Array(C.ROW_POOL * C.LANE_COUNT);  // 이미 먹은 코인
    this._rowDone = new Uint8Array(C.ROW_POOL);                  // 판정이 끝난 행

    this.supplier = null;     // 디렉터가 붙는다. 없으면 빈 트랙
    this.onEvent = null;

    // 세션 기록. 전부 메모리에만 둔다 (localStorage 금지)
    this.bestScore = 0;
    this.bestDist = 0;
    this.bestCombo = 0;
    this.runs = 0;

    // main 이 프레임 시작에서 심어주는 시각 기준점
    this.frameWall = 0;
    this.frameSimBase = 0;

    // 특성 (판마다 초기화)
    this.traits = new Uint8Array(C.TRAITS.length);

    this.reset();
  }

  // ── 행 접근 ─────────────────────────────────────────────────
  rowZ(i)          { return this._rowZ[i % C.ROW_POOL]; }
  rowOb(i, lane)   { return this._rowOb[(i % C.ROW_POOL) * C.LANE_COUNT + lane]; }
  rowCoin(i, lane) { return this._rowCoin[(i % C.ROW_POOL) * C.LANE_COUNT + lane]; }
  rowTaken(i, lane){ return this._rowTaken[(i % C.ROW_POOL) * C.LANE_COUNT + lane]; }

  ensureRow(i) {
    while (this.rowMade < i) {
      const n = this.rowMade + 1;
      const slot = n % C.ROW_POOL;
      const base = slot * C.LANE_COUNT;
      this._rowZ[slot] = n * C.ROW_SPACING;
      this._rowDone[slot] = 0;
      for (let l = 0; l < C.LANE_COUNT; l++) {
        this._rowOb[base + l] = 0;
        this._rowCoin[base + l] = 0;
        this._rowTaken[base + l] = 0;
      }
      // 계단 구간과 그 앞뒤로는 트랙을 비운다. 규칙이 바뀌는 구간을 장애물로 어지럽히지 않는다.
      const z = this._rowZ[slot];
      if (!this.nearStairZone(z) && n > 4) {
        if (this.supplier) this.supplier.fillRow(this, n, base);
        else this.fallbackRow(n, base);
        this.enforceActionSpacing(n, base);
      }
      this.rowMade = n;
    }
  }

  // 디렉터가 없을 때 쓰는 고정 패턴. 랜덤 0.
  // 세 레인이 동시에 막히는 행은 하나도 없다 — 있으면 즉사 확정이고 그건 플레이어 탓이 아니다.
  fallbackRow(n, base) {
    const p = (n % 12) * 6;
    for (let l = 0; l < C.LANE_COUNT; l++) {
      this._rowOb[base + l] = FALLBACK_PATTERN[p + l];
      this._rowCoin[base + l] = FALLBACK_PATTERN[p + 3 + l];
    }
  }

  // 같은 레인에서 자세를 요구하는 장애물이 너무 촘촘하면
  // 점프가 끝나기 전에 다음 것이 도착한다 — 어떻게 눌러도 못 넘는 배치다.
  // 청크 데이터가 뭘 주든, 레버가 뭘 하든 여기서 잘라낸다.
  // **데이터가 아니라 규칙으로 막는다.**
  enforceActionSpacing(n, base) {
    for (let l = 0; l < C.LANE_COUNT; l++) {
      const ob = this._rowOb[base + l];
      if (ob !== C.OB_LOW && ob !== C.OB_BEAM) continue;
      for (let k = 1; k <= C.MIN_ACTION_ROWS; k++) {
        const pn = n - k;
        if (pn < 0) break;
        const po = this._rowOb[(pn % C.ROW_POOL) * C.LANE_COUNT + l];
        if (po === C.OB_LOW || po === C.OB_BEAM) { this._rowOb[base + l] = 0; break; }
      }
    }
  }

  // 계단 구간 진입 직전·직후는 비운다
  nearStairZone(z) {
    const next = this.nextStairDist;
    return z > next - C.ROW_SPACING * 2 && z < next + C.ROW_SPACING * 2;
  }

  // ── 리셋 ────────────────────────────────────────────────────
  reset() {
    this.tick = 0;
    this.simTime = 0;
    this.state = S.RUN;
    this.stateTick = 0;

    this.rowMade = -1;
    if (this.supplier && this.supplier.onRunStart) this.supplier.onRunStart();

    this.travelled = 0;
    this.lane = 1;
    this.laneFrom = 1;
    this.laneShift = 0;          // 남은 프레임
    this.laneShiftTotal = 1;
    this.worldX = 0;
    this.prevWorldX = 0;
    this.lastShiftTick = -999;

    this.vstate = V.GROUND;
    this.vFrames = 0;
    this.vTotal = 1;
    this.footY = 0;              // 발밑 높이
    this.prevFootY = 0;
    this.height = C.PLAYER_H;

    this.stumble = 0;
    this.speed = C.SPEED_BASE;

    // 물 — 뒤에서 따라온다. gap 이 0이 되면 죽는다.
    this.gap = C.CHASE_GAP_START;
    this.prevGap = this.gap;
    this.chaseGap = C.CHASE_GAP_START;

    this.combo = 0;
    this.comboBest = 0;
    this.score = 0;
    this.coins = 0;
    this.hits = 0;
    this.nearMisses = 0;
    this.jumps = 0;
    this.slides = 0;

    // 계단
    this.nextStairDist = C.STAIR_FIRST_DIST;
    this.stairStep = 0;
    this.stairSide = 0;          // 다음에 눌러야 할 쪽 (0=좌 1=우)
    this.stairFrames = 0;
    this.stairStall = 0;
    this.stairHit = 0;
    this.stairTry = 0;

    // 드래프트
    this.draftIdx = new Int8Array(C.TRAIT_OFFER);
    this.draftOpen = false;
    this.draftFrames = 0;
    this.traits.fill(0);
    this.shieldCharges = 0;

    this.recordPassed = this.bestDist <= 0;
    this.deathTick = -1;

    this.ensureRow(Math.ceil(C.ZFAR / C.ROW_SPACING) + 2);
    this.runs++;
    this.emit(EV.RESET, 0, 0);
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
    if (C.TRAITS[idx].id === 'shield') this.shieldCharges++;
  }

  // ── 입력 진입점 — main 의 입력 큐만 이걸 부른다 ──────────────
  input(act, simTs, wallTs) {
    if (this.state === S.DEAD) {
      // 결과 화면에서는 아무 입력이나 재시작이다
      this.reset();
      return;
    }
    if (this.state === S.DRAFT) {
      if (act >= ACT.PICK0 && act <= ACT.PICK2) this.pickTrait(act - ACT.PICK0);
      // 계단·러너 동사도 그대로 선택에 매핑한다 — 좌/우로 고르고 위로 확정하지 않는다.
      else if (act === ACT.LEFT) this.pickTrait(0);
      else if (act === ACT.RIGHT) this.pickTrait(2);
      else if (act === ACT.JUMP) this.pickTrait(1);
      return;
    }
    if (this.state === S.STAIR) {
      if (act === ACT.LEFT) this.stairInput(0);
      else if (act === ACT.RIGHT) this.stairInput(1);
      return;
    }
    // RUN
    switch (act) {
      case ACT.LEFT:  this.shiftLane(-1); break;
      case ACT.RIGHT: this.shiftLane(1); break;
      case ACT.JUMP:  this.beginJump(); break;
      case ACT.SLIDE: this.beginSlide(); break;
      default: break;
    }
  }

  shiftLane(dir) {
    const next = this.lane + dir;
    if (next < 0 || next >= C.LANE_COUNT) return;
    this.laneFrom = this.lane;
    this.lane = next;
    // 관성 특성은 이동을 즉시 끝낸다
    this.laneShiftTotal = this.has('inertia')
      ? 1 : Math.max(1, Math.round(C.LANE_SHIFT_MS / C.SIM_DT));
    this.laneShift = this.laneShiftTotal;
    this.lastShiftTick = this.tick;
    this.emit(EV.MOVE, next, dir);
  }

  beginJump() {
    if (this.vstate === V.JUMP) return;
    this.vstate = V.JUMP;
    this.vTotal = Math.max(1, Math.round(
      C.JUMP_MS * (this.has('glide') ? 1.4 : 1) / C.SIM_DT));
    this.vFrames = 0;
    this.jumps++;
    this.emit(EV.JUMP, 0, 0);
  }

  beginSlide() {
    if (this.vstate === V.JUMP) return;   // 공중에서는 슬라이드하지 않는다
    this.vstate = V.SLIDE;
    this.vTotal = Math.max(1, Math.round(
      C.SLIDE_MS * (this.has('brake') ? 1.5 : 1) / C.SIM_DT));
    this.vFrames = 0;
    this.slides++;
    this.emit(EV.SLIDE, 0, 0);
  }

  // ── 계단 구간 ───────────────────────────────────────────────
  enterStair() {
    this.setState(S.STAIR);
    this.stairStep = 0;
    this.stairSide = 0;
    this.stairStall = 0;
    this.stairHit = 0;
    this.stairTry = 0;
    this.stairFrames = Math.round(C.STAIR_MS / C.SIM_DT);
    this.vstate = V.GROUND;
    this.footY = 0;
    this.emit(EV.STAIR_ENTER, 0, 0);
  }

  stairInput(side) {
    if (this.stairStall > 0) return;
    this.stairTry++;
    if (side !== this.stairSide) {
      // 순서를 틀렸다. 비틀거리며 멈춘다 — 그동안 물이 붙는다.
      this.stairStall = C.STAIR_MISS_STALL;
      this.combo = 0;
      this.emit(EV.STAIR_MISS, 0, 0);
      return;
    }
    this.stairHit++;
    this.stairStep++;
    this.stairSide = 1 - this.stairSide;
    this.laneFrom = this.lane;
    this.lane = side === 0 ? 0 : 2;
    this.laneShiftTotal = 5;    // 짧게. 계단은 리듬이라 즉각적이어야 한다
    this.laneShift = 5;
    // 오른 만큼 물이 밀린다. 이 구간이 유일한 회복 기회다.
    this.gap += C.STAIR_STEP_PUSH * (this.has('recover') ? 1.6 : 1);
    this.score += (C.STAIR_STEP_SCORE * this.mult()) | 0;
    this.emit(EV.STAIR_STEP, this.stairStep, 0);
    if (this.stairStep >= C.STAIR_STEPS) this.clearStair();
  }

  clearStair() {
    const acc = this.stairTry > 0 ? this.stairHit / this.stairTry : 0;
    this.emit(EV.STAIR_CLEAR, acc, 0);
    this.nextStairDist = this.travelled + C.STAIR_EVERY_DIST;
    this.lane = 1;
    this.laneFrom = 1;
    this.laneShift = 0;
    this.openDraft();
  }

  // ── 특성 드래프트 ───────────────────────────────────────────
  openDraft() {
    // 디렉터가 3개를 고른다. 없으면 앞에서부터 3개.
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
    this.setState(S.RUN);
  }

  // ── 파생값 ──────────────────────────────────────────────────
  mult() {
    const step = C.COMBO_MULT_STEP * (this.has('chain') ? 1.5 : 1);
    let m = 1 + this.combo * step;
    if (m > C.COMBO_MULT_CAP) m = C.COMBO_MULT_CAP;
    if (this.has('gambler')) m *= 2;
    return m;
  }

  // 스턴 없는 기준 속도. 물은 이걸 따라간다 — 플레이어가 비틀거려도 물은 안 느려진다.
  baseSpeed() {
    const t = clamp(this.travelled / C.SPEED_RAMP_DIST, 0, 1);
    let s = C.SPEED_BASE + (C.SPEED_MAX - C.SPEED_BASE) * t;
    if (this.has('sprint')) s *= 1.15;
    return s;
  }

  comboWaterMul() {
    if (this.combo >= C.COMBO_PUSH_AT) return C.COMBO_PUSH_MUL;
    if (this.combo >= C.COMBO_HOLD_AT) return C.COMBO_HOLD_MUL;
    return 1;
  }

  comboTier() { return (this.combo / C.COMBO_TIER) | 0; }

  // **충돌은 목표 레인이 아니라 실제로 서 있는 위치로 판정한다.**
  // shiftLane() 은 this.lane 을 즉시 목적지로 바꾼다 — 그게 보간의 기준점이기 때문이다.
  // 그 값으로 충돌을 보면, 스와이프하는 순간 아직 원래 레인에 서 있는데도
  // 목적지의 장애물에 맞는다. 플레이어가 보고 있는 것과 맞는 것이 달라진다.
  // 실제로 그렇게 만들었다가 봇이 레인 이동 중에만 골라 맞았다.
  effLane() {
    const l = Math.round((this.worldX + C.LANE_W) / C.LANE_W);
    return l < 0 ? 0 : (l >= C.LANE_COUNT ? C.LANE_COUNT - 1 : l);
  }
  meters() { return this.travelled / C.METER_UNITS; }

  // 장애물이 보이기 시작하는 거리. 디렉터의 telegraph 레버와 시야 특성이 늘린다.
  drawZ() {
    let z = C.ZFAR;
    if (this.supplier && this.supplier.levers) z *= this.supplier.levers.telegraph;
    if (this.has('vision')) z *= 1.3;
    return z;
  }

  // ── 한 스텝 ─────────────────────────────────────────────────
  step() {
    this.prevWorldX = this.worldX;
    this.prevFootY = this.footY;
    this.prevGap = this.gap;

    this.tick++;
    this.stateTick++;
    this.simTime += C.SIM_DT;

    if (this.state === S.DRAFT) { this.draftFrames++; return; }
    if (this.state === S.DEAD) return;

    const base = this.baseSpeed();
    let moveSpeed = base;
    if (this.state === S.STAIR) {
      // 계단에서는 발이 아니라 리듬이 속도를 만든다
      moveSpeed = this.stairStall > 0 ? 0 : base * 0.75;
      this.stairFrames--;
      if (this.stairStall > 0) this.stairStall--;
      this.stepLane();          // 계단에서도 좌우로 옮겨 탄다. 안 하면 가운데 박혀 있다
      if (this.stairFrames <= 0) this.clearStair();
    } else {
      if (this.stumble > 0) { this.stumble--; moveSpeed = base * C.STUMBLE_SPEED_MUL; }
      this.stepLane();
      this.stepVertical();
    }

    const advance = moveSpeed / C.SIM_HZ;
    this.travelled += advance;
    this.speed = moveSpeed;

    this.stepWater(base, advance);

    if (this.state === S.RUN) {
      this.stepTrack();
      if (this.travelled >= this.nextStairDist) this.enterStair();
    }

    // 거리 점수
    this.score += advance * C.SCORE_PER_UNIT * this.mult();

    if (this.travelled > this.bestDist && !this.recordPassed) {
      this.recordPassed = true;
      this.emit(EV.RECORD, 0, 0);
    }

    this.ensureRow(Math.ceil((this.travelled + C.ZFAR * 1.5) / C.ROW_SPACING) + 2);

    if (this.gap <= 0) this.die();
  }

  stepLane() {
    if (this.laneShift > 0) {
      this.laneShift--;
      const t = 1 - this.laneShift / this.laneShiftTotal;
      const e = easeOutQuad(t);
      this.worldX = C.LANE_X[this.laneFrom]
        + (C.LANE_X[this.lane] - C.LANE_X[this.laneFrom]) * e;
    } else {
      this.worldX = C.LANE_X[this.lane];
    }
  }

  stepVertical() {
    if (this.vstate === V.GROUND) { this.footY = 0; this.height = C.PLAYER_H; return; }
    this.vFrames++;
    const t = this.vFrames / this.vTotal;
    if (t >= 1) {
      const was = this.vstate;
      this.vstate = V.GROUND;
      this.footY = 0;
      this.height = C.PLAYER_H;
      if (was === V.JUMP) this.emit(EV.LAND, 0, 0);
      return;
    }
    if (this.vstate === V.JUMP) {
      // 포물선. 4·h·t·(1−t) 는 t=0.5 에서 정점 h 가 된다.
      this.footY = 4 * C.JUMP_APEX * t * (1 - t);
      this.height = C.PLAYER_H;
    } else {
      this.footY = 0;
      this.height = C.SLIDE_H;
    }
  }

  stepWater(base, advance) {
    // 추격 거리는 깊이가 쌓일수록 좁혀진다
    const k = clamp(this.travelled / C.CHASE_TIGHTEN_DIST, 0, 1);
    this.chaseGap = C.CHASE_GAP_START + (C.CHASE_GAP_END - C.CHASE_GAP_START) * k;

    let ratio = C.WATER_RATIO * this.comboWaterMul();
    if (this.supplier && this.supplier.levers) ratio *= this.supplier.levers.waterMul;
    if (this.has('chill')) ratio *= 0.8;
    if (this.has('gambler')) ratio *= 1.25;

    let waterAdvance = base * ratio / C.SIM_HZ;
    // 너무 벌어지면 3배가 아니라 "플레이어보다 조금 빠르게" 붙는다.
    // 일정 속도 두 개뿐이고 어느 쪽인지 눈에 보인다. 순간이동하지 않는다.
    if (this.gap > this.chaseGap) {
      const chase = base * C.WATER_CHASE_MUL / C.SIM_HZ;
      if (chase > waterAdvance) waterAdvance = chase;
    }
    this.gap += advance - waterAdvance;
    if (this.gap > this.chaseGap * 1.35) this.gap = this.chaseGap * 1.35;
  }

  // ── 트랙 판정 ───────────────────────────────────────────────
  stepTrack() {
    const first = Math.max(0, Math.floor((this.travelled - C.ROW_SPACING * 2) / C.ROW_SPACING));
    const last = Math.min(this.rowMade,
      Math.ceil((this.travelled + C.ROW_SPACING * 2) / C.ROW_SPACING));
    for (let i = first; i <= last; i++) {
      const slot = i % C.ROW_POOL;
      if (this._rowDone[slot]) continue;
      const z = this._rowZ[slot] - this.travelled;

      // 코인은 통과하는 순간 먹는다
      if (z < C.COIN_R && z > -C.COIN_R) {
        const ci = slot * C.LANE_COUNT + this.effLane();
        if (this._rowCoin[ci] && !this._rowTaken[ci]) {
          this._rowTaken[ci] = 1;
          this.coins++;
          this.score += (C.COIN_SCORE * (this.has('collector') ? 2 : 1) * this.mult()) | 0;
          // b = 바깥 레인에서 챙겼는가. 디렉터의 greed 지표가 이걸 본다.
          this.emit(EV.COIN, 0, this.effLane() === 1 ? 0 : 1);
        }
      }

      // 장애물 판정은 행이 플레이어 평면을 지나는 순간 한 번만
      if (z > 0) continue;
      this._rowDone[slot] = 1;
      this.resolveRow(slot);
    }
  }

  resolveRow(slot) {
    const here = this.effLane();
    const ob = this._rowOb[slot * C.LANE_COUNT + here];
    if (ob === C.OB_NONE) {
      // 옆 레인이 막혀 있으면 점수는 준다 — 좁은 길을 지난 건 맞다.
      // 하지만 **아슬아슬**로 세지는 않는다. 빈 레인에 가만히 서 있던 것도
      // 옆이 막혔다는 이유만으로 배짱으로 집계되면, 지표가 플레이어가 아니라
      // 트랙 밀도를 재게 된다. 아슬아슬은 **마지막 순간에 끼어들었을 때**다.
      let adjacent = 0;
      for (let l = 0; l < C.LANE_COUNT; l++) {
        if (l !== here && this._rowOb[slot * C.LANE_COUNT + l] !== C.OB_NONE) adjacent++;
      }
      const dove = this.tick - this.lastShiftTick <= C.NEAR_SHIFT_FRAMES;
      if (adjacent > 0) this.reward(adjacent, dove ? 1 : 0);
      return;
    }
    // 내 레인이 막혀 있는데 자세로 넘었다.
    // 자세의 **가장자리**로 지났으면 아슬아슬이고, 정점에 맞췄으면 실력이다.
    // 너무 이른 것도 너무 늦은 것만큼 위험하므로 양쪽 끝을 다 본다.
    if (this.clears(ob)) {
      const phase = this.vTotal > 0 ? this.vFrames / this.vTotal : 0.5;
      const edge = phase < C.NEAR_PHASE || phase > 1 - C.NEAR_PHASE;
      // 직전에 이 레인으로 뛰어들어 온 것도 아슬아슬이다. 이 경우를 빼놓았더니
      // 도박꾼의 **가장 도박다운 행동** — 넘어야 하는 레인에 코인 때문에
      // 막판에 끼어드는 것 — 이 지표에 하나도 안 잡히고 있었다.
      this.reward(1, (edge || this.tick - this.lastShiftTick <= C.NEAR_SHIFT_FRAMES) ? 1 : 0);
      return;
    }
    this.takeHit(ob);
  }

  // 자세로 넘을 수 있는가. 하나로 둘을 넘을 수 없다.
  clears(ob) {
    const pad = this.has('precise') ? 18 : 0;
    const bottom = this.footY;
    const top = this.footY + this.height;
    if (ob === C.OB_LOW) return bottom + pad >= C.OB_LOW_H;
    if (ob === C.OB_BEAM) return top - pad <= C.OB_BEAM_LO;
    return false;   // 기둥은 레인을 바꾸는 수밖에 없다
  }

  reward(adjacent, daring) {
    this.combo++;
    if (this.combo > this.comboBest) this.comboBest = this.combo;
    this.nearMisses += daring;
    this.score += (C.NEAR_MISS_SCORE * adjacent * this.mult()) | 0;
    this.emit(EV.NEAR_MISS, adjacent, daring);
    this.emit(EV.COMBO, this.combo, this.comboTier());
  }

  takeHit(ob) {
    if (this.shieldCharges > 0) {
      this.shieldCharges--;
      this.emit(EV.SHIELD, 0, 0);
      return;
    }
    this.hits++;
    if (this.combo > 0) this.emit(EV.COMBO_BREAK, this.combo, 0);
    this.combo = 0;
    this.stumble = Math.round(C.STUMBLE_MS / C.SIM_DT);
    this.vstate = V.GROUND;
    this.footY = 0;
    this.height = C.PLAYER_H;
    this.emit(EV.HIT, ob, 0);
  }

  die() {
    this.deathTick = this.tick;
    if (this.score > this.bestScore) this.bestScore = this.score;
    if (this.travelled > this.bestDist) this.bestDist = this.travelled;
    if (this.comboBest > this.bestCombo) this.bestCombo = this.comboBest;
    this.combo = 0;
    this.setState(S.DEAD);
    this.emit(EV.DEATH, 0, 0);
  }

  // ── 조회 ────────────────────────────────────────────────────
  // 물이 화면을 얼마나 잠식했는가. 0 = 안 보임, 1 = 플레이어를 삼킴.
  waterK() { return clamp(1 - this.gap / C.CHASE_GAP_START, 0, 1); }
  waterNear() {
    const m = this.gap;
    return m < C.WATER_NEAR ? clamp(1 - m / C.WATER_NEAR, 0, 1) : 0;
  }
}
