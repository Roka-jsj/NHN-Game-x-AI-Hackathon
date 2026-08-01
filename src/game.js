// 시뮬레이션 — 물리 · 충돌 · 물 · 발판.
// 이 파일은 시각·청각·입력장치를 모른다. 순수하게 상태만 굴린다.
//
// 규칙 1: 고정 스텝이다. 이 파일 어디에도 deltaTime을 곱하는 코드가 없다.
//         초당 값은 config에서 per-step 상수로 이미 나눠져 들어온다.
// 규칙 2: 상태 전이는 setState() 한 곳에서만 일어난다.
// 규칙 3: 판정에 Math.random()을 쓰지 않는다. 재현 가능해야 한다.

import * as C from './config.js';

export const S = {
  READY: 0, CHARGING: 1, LEAPING: 2, LANDED: 3, FALLING: 4, DEAD: 5,
};
export const STATE_NAME = ['READY', 'CHARGING', 'LEAPING', 'LANDED', 'FALLING', 'DEAD'];

// 상위 레이어(게임필·오디오)가 붙는 지점. 숫자 코드라 객체를 만들지 않는다.
export const EV = {
  CHARGE_START: 0,
  OVERCHARGE: 1,
  FIRE: 2,
  LAND: 3,
  PERFECT: 4,
  MISS: 5,
  COYOTE: 6,
  BONUS: 7,
  RECORD: 8,
  DEATH: 9,
  RESET: 10,
  COMBO: 11,        // a = 새 콤보 값, b = 티어
  COMBO_BREAK: 12,  // a = 끊긴 콤보 값
  SKIP: 13,         // a = 건너뛴 발판 수
  GATE: 14,         // a = 통과한 발판 수
  CRUMBLE: 15,      // 발 밑이 무너졌다
};

const TAU = Math.PI * 2;

function easeOutQuad(t) { return t * (2 - t); }

export class Game {
  constructor() {
    // ─ 발판 링버퍼. 루프 안에서 객체를 만들지 않기 위해 타입배열로 둔다 ─
    this._platY = new Float64Array(C.PLAT_POOL);
    this._platSide = new Uint8Array(C.PLAT_POOL);
    this._platThick = new Float32Array(C.PLAT_POOL);
    this._platFlags = new Uint8Array(C.PLAT_POOL);
    // 부서지는 발판의 남은 프레임. 0 = 멀쩡, >0 = 무너지는 중, -1 = 사라짐
    this._platCrumble = new Int16Array(C.PLAT_POOL);

    // 발판 공급자. 패스 1은 고정 패턴, 패스 4에서 디렉터가 갈아끼운다.
    this.supplier = null;

    this.onEvent = null;       // (type, a, b) => void
    this.coyoteFrames = 5;     // 패스 4에서 디렉터가 5~8로 조정한다
    this.waterRisePerStep = C.WATER_RISE_PER_STEP;
    this.aimWobbleScale = 1;

    // 최고 기록. 전부 메모리에만 둔다 (localStorage 금지)
    this.bestY = 0;            // 높이 — 화면의 점선 기록선
    this.bestScore = 0;
    this.bestCombo = 0;
    this.runs = 0;

    // main이 프레임 시작에서 심어주는 시각 기준점. 판 리셋과 무관하므로 여기서만 잡는다.
    this.frameWall = 0;
    this.frameSimBase = 0;

    this.reset();
  }

  // ── 발판 접근 ───────────────────────────────────────────────
  platBaseY(i)   { return this._platY[i % C.PLAT_POOL]; }
  platSideAt(i)  { return this._platSide[i % C.PLAT_POOL]; }
  platThickAt(i) { return this._platThick[i % C.PLAT_POOL]; }
  platFlagsAt(i) { return this._platFlags[i % C.PLAT_POOL]; }
  platBonusAt(i) { return this._platFlags[i % C.PLAT_POOL] & C.F_BONUS; }
  platGone(i)    { return this._platCrumble[i % C.PLAT_POOL] === -1; }
  crumbleLeft(i) { return this._platCrumble[i % C.PLAT_POOL]; }

  // 이동 발판의 위치는 시각의 함수다. 사인파라 **미래를 계산할 수 있다.**
  // 판정·조준·렌더가 전부 이 함수 하나를 쓴다. 보이는 것과 맞는 것이 같아야 한다.
  platYAtTime(i, t) {
    const slot = i % C.PLAT_POOL;
    const base = this._platY[slot];
    if ((this._platFlags[slot] & C.F_MOVING) === 0) return base;
    return base + C.MOVE_AMP * Math.sin(TAU * t / C.MOVE_PERIOD_MS + i * 1.7);
  }
  platYAt(i) { return this.platYAtTime(i, this.simTime); }

  leapDurationFor(dist) {
    const span = (dist - C.LEAP_DIST_MIN) / (C.LEAP_DIST_MAX - C.LEAP_DIST_MIN);
    const k = span < 0 ? 0 : (span > 1 ? 1 : span);
    return C.LEAP_TIME_MIN + (C.LEAP_TIME_MAX - C.LEAP_TIME_MIN) * k;
  }

  // 지금 떼면 어느 발판을 노리게 되는가, 그리고 도착 시각은 언제인가.
  // 렌더가 이걸로 "발판이 도착 순간에 있을 자리"를 그린다.
  // 이동 발판을 도착 시점에 판정하면서 미래를 안 보여주면 그건 불공정한 게임이다.
  previewTarget(nowSim) {
    const dist = this.aimPreview(nowSim);
    const landingY = this.playerY + dist + this.wobbleOffset(dist, nowSim);
    const arrive = nowSim + this.leapDurationFor(dist);
    const targetSide = 1 - this.side;
    let best = -1, bestD = Infinity;
    for (let i = this.platIdx + 1; i <= this.platIdx + C.LOOKAHEAD; i++) {
      this.ensurePlatform(i);
      if (this._platSide[i % C.PLAT_POOL] !== targetSide) continue;
      if (this.platGone(i)) continue;
      const d = Math.abs(this.platYAtTime(i, arrive) - landingY);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.previewIdx = best;
    this.previewArrive = arrive;
    this.previewLandingY = landingY;
    return best;
  }

  // 착지 허용폭 = 발판 반두께 + 플레이어 반지름
  toleranceAt(i) {
    return C.PLATFORM_THICKNESS * this.platThickAt(i) * 0.5 + C.PLAYER_RADIUS;
  }

  ensurePlatform(i) {
    while (this.platMade < i) {
      const n = this.platMade + 1;
      const slot = n % C.PLAT_POOL;
      this._platCrumble[slot] = 0;
      if (n === 0) {
        this._platY[slot] = 0;
        this._platSide[slot] = 0;
        this._platThick[slot] = 1;
        this._platFlags[slot] = 0;      // 시작 발판은 언제나 멀쩡한 발판이다
      } else {
        const prev = (n - 1) % C.PLAT_POOL;
        // supplier가 없으면 패스 1의 고정 패턴. 랜덤 0.
        let gap = this.supplier
          ? this.supplier.gapFor(n)
          : C.GAP_PATTERN[(n - 1) % C.GAP_PATTERN.length];
        // 직전 발판이 무너지는 발판이면 오래 겨눌 시간이 없다.
        // 먼 간격을 붙이면 어떻게 눌러도 못 넘는 배치가 된다.
        if ((this._platFlags[prev] & C.F_CRUMBLE) && gap > C.CRUMBLE_NEXT_GAP_MAX) {
          gap = C.CRUMBLE_NEXT_GAP_MAX;
        }
        this._platY[slot] = this._platY[prev] + gap;
        this._platSide[slot] = n % 2;
        this._platThick[slot] = this.supplier ? this.supplier.thickFor(n) : 1;
        this._platFlags[slot] = this.supplier ? this.supplier.flagsFor(n) : 0;
      }
      this.platMade = n;
    }
  }

  wallX(side) {
    return side === 0
      ? C.WALL_INSET + C.PLAYER_RADIUS
      : C.VIEW_W - C.WALL_INSET - C.PLAYER_RADIUS;
  }

  // ── 리셋 ────────────────────────────────────────────────────
  reset() {
    this.tick = 0;
    this.simTime = 0;
    this.state = S.READY;
    this.stateTick = 0;

    this.platMade = -1;
    if (this.supplier && this.supplier.onRunStart) this.supplier.onRunStart();
    this.ensurePlatform(C.LOOKAHEAD + 2);

    this.platIdx = 0;
    this.side = 0;
    this.playerX = this.wallX(0);
    this.playerY = 0;
    this.prevPlayerX = this.playerX;
    this.prevPlayerY = this.playerY;

    this.waterY = -C.WATER_START_GAP;
    this.prevWaterY = this.waterY;

    this.camY = this.playerY;
    this.prevCamY = this.camY;

    this.fallVel = 0;
    this.coyoteLeft = 0;

    // 차지
    this.chargePressSim = 0;
    this.chargePressWall = 0;
    this.overchargeFlagged = false;

    // 입력 버퍼 (패스 2)
    this.bufferTick = -1;
    this.bufferWall = 0;
    this.bufferReleased = false;
    this.bufferReleaseWall = 0;

    // 도약
    this.leapFromX = 0; this.leapFromY = 0;
    this.leapToX = 0;   this.leapToY = 0;
    this.leapStep = 0;  this.leapSteps = 1;
    this.aimDist = 0;
    this.landedResolveTo = S.READY;

    // 판정 결과 (디렉터가 읽는다)
    this.pendingTarget = -1;
    this.pendingHit = false;
    this.pendingPerfect = false;
    this.lastAimError = 0;
    this.lastAimSigned = 0;
    this.lastChargeRatio = 0;
    this.lastChargeMs = 0;

    // 기록
    this.depth = 0;
    this.perfectCount = 0;
    this.runBestY = 0;
    this.recordPassed = this.bestY <= 0;
    this.deathTick = -1;

    // 콤보 · 점수
    this.combo = 0;
    this.comboBest = 0;
    this.score = 0;
    this.lastSkip = 0;
    this.chaseMargin = C.CHASE_MARGIN_START;
    this.rideOffset = 0;

    this.runs++;
    this.emit(EV.RESET, 0, 0);
  }

  emit(type, a, b) { if (this.onEvent) this.onEvent(type, a, b); }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.stateTick = 0;
  }

  // ── 입력 진입점 — main.js의 입력 큐만 이걸 부른다 ─────────────
  press(simTs, wallTs) {
    if (this.state === S.DEAD) { this.reset(); return true; }
    if (this.state === S.READY) {
      this.beginCharge(simTs, wallTs);
      return true;
    }
    // 착지 직전 입력을 기억한다. "눌렀는데 안 먹었다"를 제거한다.
    this.bufferTick = this.tick;
    this.bufferWall = wallTs;
    this.bufferReleased = false;
    return false;
  }

  // 착지 직후 READY 로 넘어올 때만 불린다.
  tryBufferedCharge() {
    if (this.bufferTick < 0) return;
    if (this.tick - this.bufferTick > C.INPUT_BUFFER_FRAMES) { this.bufferTick = -1; return; }

    // 차지 시작 시각은 "착지한 순간"이다. 버퍼에 머문 시간만큼 차지가 부풀면 안 된다.
    const startWall = this.nowWall();
    this.beginCharge(this.simTime, startWall);
    this.bufferTick = -1;

    // 착지 전에 이미 손을 뗐다면, 플레이어가 실제로 누른 만큼을 그대로 재현한다.
    // 그러지 않으면 짧은 탭이 무한 차지로 남는다.
    if (this.bufferReleased) {
      const held = this.bufferReleaseWall - this.bufferWall;
      this.fire(this.simTime + held, held, false);
    }
  }

  // 시뮬 시각 → 벽시계 시각. 프레임 시작에서 main이 기준점을 심어준다.
  nowWall() {
    return this.frameWall + (this.simTime - this.frameSimBase);
  }

  beginCharge(simTs, wallTs) {
    this.chargePressSim = simTs;
    this.chargePressWall = wallTs;
    this.overchargeFlagged = false;
    this.setState(S.CHARGING);
    this.emit(EV.CHARGE_START, 0, 0);
  }

  // 탭이 숨겨지면 차지를 취소한다. 복귀 시 30분짜리 차지가 되면 안 된다.
  cancelCharge() {
    if (this.state === S.CHARGING) this.setState(S.READY);
  }

  release(wallTs) {
    if (this.state !== S.CHARGING) {
      // 버퍼에 들어간 입력의 릴리스. 착지 시점에 그대로 재현하기 위해 기억한다.
      if (this.bufferTick >= 0 && !this.bufferReleased) {
        this.bufferReleased = true;
        this.bufferReleaseWall = wallTs;
      }
      return;
    }
    const rawMs = wallTs - this.chargePressWall;
    // 조준 진동은 "실제로 뗀 순간"의 위상으로 판정한다. 보이는 것과 판정이 어긋나지 않게.
    this.fire(this.chargePressSim + rawMs, rawMs, false);
  }

  // 매 프레임 입력 소비 직후 호출. 무한 차지를 봉쇄한다.
  checkOvercharge(nowWall) {
    if (this.state !== S.CHARGING) return;
    const held = nowWall - this.chargePressWall;
    if (!this.overchargeFlagged && held >= C.OVERCHARGE_WARN_MS) {
      this.overchargeFlagged = true;
      this.emit(EV.OVERCHARGE, 0, 0);
    }
    if (held >= C.OVERCHARGE_FIRE_MS) {
      // 강제 발사 시각을 정확히 1200ms 지점에 고정한다.
      // 프레임 지터가 판정 결과를 흔들면 실패가 플레이어 탓이 아니게 된다.
      this.fire(this.chargePressSim + C.OVERCHARGE_FIRE_MS, C.OVERCHARGE_FIRE_MS, true);
    }
  }

  // ── 발사 ────────────────────────────────────────────────────
  fire(releaseSim, rawChargeMs, forced) {
    let ms = rawChargeMs;
    if (ms < C.CHARGE_MIN_MS) ms = C.CHARGE_MIN_MS;          // 오발 구제
    if (ms > C.CHARGE_MAX_MS) ms = C.CHARGE_MAX_MS;
    const ratio = ms / C.CHARGE_MAX_MS;

    let dist = C.LEAP_DIST_MIN + (C.LEAP_DIST_MAX - C.LEAP_DIST_MIN) * ratio;
    if (forced) dist *= C.OVERCHARGE_PENALTY;

    const wob = this.wobbleOffset(dist, releaseSim);
    const landingY = this.playerY + dist + wob;

    // 착지 후보: 반대편 벽의 발판 중 조준점에 가장 가까운 것.
    // 이동 발판은 **도착 시점의 위치**로 고른다 — 조준 중에 화면에 그려준 예측선과 같은 기준이다.
    // 멀리 뛰어 한 칸 건너뛰는 플레이가 성립한다.
    const arrive = releaseSim + this.leapDurationFor(dist);
    const targetSide = 1 - this.side;
    let best = -1, bestDist = Infinity;
    for (let i = this.platIdx + 1; i <= this.platIdx + C.LOOKAHEAD; i++) {
      this.ensurePlatform(i);
      if (this._platSide[i % C.PLAT_POOL] !== targetSide) continue;
      if (this.platGone(i)) continue;
      const d = Math.abs(this.platYAtTime(i, arrive) - landingY);
      if (d < bestDist) { bestDist = d; best = i; }
    }

    // 한 칸 건너뛰기. 같은 벽의 발판은 한 칸 걸러 있으므로 차이를 2로 나눈다.
    this.lastSkip = best > this.platIdx + 1 ? ((best - this.platIdx - 1) / 2) | 0 : 0;

    // 착지 판정은 여기서 하지 않는다. **도착하는 순간**에 한다.
    // 이동 발판은 도약하는 동안 움직이고, 부서지는 발판은 사라질 수 있다.
    // "내가 내려앉은 자리에 발판이 있었는가"가 플레이어가 이해하는 규칙이다.
    this.pendingTarget = best;
    this.lastChargeRatio = ratio;
    this.lastChargeMs = ms;

    this.leapFromX = this.playerX;
    this.leapFromY = this.playerY;
    this.leapToX = this.wallX(targetSide);
    this.leapToY = landingY;

    const span = (dist - C.LEAP_DIST_MIN) / (C.LEAP_DIST_MAX - C.LEAP_DIST_MIN);
    const clamped = span < 0 ? 0 : (span > 1 ? 1 : span);
    const durMs = C.LEAP_TIME_MIN + (C.LEAP_TIME_MAX - C.LEAP_TIME_MIN) * clamped;
    // 프레임 수로 고정한다 → 60Hz와 120Hz에서 소요 시간이 같다
    this.leapSteps = Math.max(1, Math.round(durMs / C.SIM_DT));
    this.leapStep = 0;
    this.aimDist = dist;

    this.setState(S.LEAPING);
    this.emit(EV.FIRE, dist, forced ? 1 : 0);
  }

  // 사인파다. 랜덤이 아니다. 읽을 수 있으면 실력이 된다.
  wobbleOffset(dist, t) {
    const amp = dist * C.WOBBLE_RATIO * this.aimWobbleScale;
    return amp * Math.sin(TAU * t / C.WOBBLE_PERIOD_MS);
  }

  // 렌더가 조준점 위치를 물어보는 지점. 판정과 같은 함수를 쓴다 (WYSIWYG).
  aimPreview(nowSim) {
    const held = nowSim - this.chargePressSim;
    let ms = held < C.CHARGE_MIN_MS ? C.CHARGE_MIN_MS : held;
    if (ms > C.CHARGE_MAX_MS) ms = C.CHARGE_MAX_MS;
    const ratio = ms / C.CHARGE_MAX_MS;
    return C.LEAP_DIST_MIN + (C.LEAP_DIST_MAX - C.LEAP_DIST_MIN) * ratio;
  }

  // ── 한 스텝 ─────────────────────────────────────────────────
  step() {
    // 보간용 이전 상태
    this.prevPlayerX = this.playerX;
    this.prevPlayerY = this.playerY;
    this.prevWaterY = this.waterY;
    this.prevCamY = this.camY;

    this.tick++;
    this.stateTick++;
    this.simTime += C.SIM_DT;

    if (this.state !== S.DEAD) {
      // 물은 선형이다. 이징을 걸면 예측이 불가능해지고, 그 순간 실패가 플레이어 탓이 아니게 된다.
      //
      // 속도는 세 갈래지만 전부 일정 속도다. 순간이동하지 않는다.
      //  ① 콤보가 물을 붙잡는다 — 연속 완벽 착지 3회면 멈추고, 6회면 내려간다
      //  ② 너무 앞서면 3배속으로 따라붙는다 (안 그러면 물이 영원히 안 보인다)
      //  ③ 그 외에는 기본 속도
      let rise = this.waterRisePerStep * this.comboWaterMul();
      const margin = this.playerY - this.waterY;
      if (margin > this.chaseMargin) {
        const chase = this.waterRisePerStep * C.WATER_CHASE_MUL;
        if (chase > rise) rise = chase;
      }
      this.waterY += rise;

      // 깊이가 쌓일수록 물이 더 가까이 따라붙는다. 후반에는 한 번 오래 겨누는 것도 위험해진다.
      const t = this.depth / C.CHASE_TIGHTEN_DEPTH;
      const k = t > 1 ? 1 : t;
      this.chaseMargin = C.CHASE_MARGIN_START
        + (C.CHASE_MARGIN_END - C.CHASE_MARGIN_START) * k;
    }

    this.tickCrumble();

    // 이동 발판 위에서는 발판을 타고 같이 움직인다
    if (this.state === S.READY || this.state === S.CHARGING || this.state === S.LANDED) {
      if (this.platFlagsAt(this.platIdx) & C.F_MOVING) {
        this.playerY = this.platYAt(this.platIdx) + this.rideOffset;
      }
    }

    switch (this.state) {
      case S.CHARGING:
        break;

      case S.LEAPING: {
        this.leapStep++;
        let p = this.leapStep / this.leapSteps;
        if (p > 1) p = 1;
        const e = easeOutQuad(p);
        this.playerX = this.leapFromX + (this.leapToX - this.leapFromX) * e;
        this.playerY = this.leapFromY + (this.leapToY - this.leapFromY) * e;
        if (p >= 1) this.resolveLanding();
        break;
      }

      case S.LANDED:
        // 착지 판정은 진입 시점에 이미 끝났다. 이 상태는 1스텝짜리 비트다.
        this.setState(this.landedResolveTo);
        if (this.state === S.READY) this.tryBufferedCharge();
        break;

      case S.FALLING: {
        this.fallVel += C.FALL_ACC_PER_STEP;
        if (this.fallVel > C.FALL_MAX_SPEED) this.fallVel = C.FALL_MAX_SPEED;
        this.playerY -= this.fallVel;
        if (this.coyoteLeft > 0) {
          this.coyoteLeft--;
          // 미끄러지는 동안 같은 벽의 발판 범위를 통과하면 붙잡는다.
          // 오버슛만 구제된다 — 짧게 쏜 건 구제되지 않는다.
          for (let i = this.platIdx + 1; i <= this.platIdx + C.LOOKAHEAD; i++) {
            this.ensurePlatform(i);
            if (this._platSide[i % C.PLAT_POOL] !== this.side) continue;
            if (this.platGone(i)) continue;
            if (Math.abs(this.platYAt(i) - this.playerY) <= this.toleranceAt(i)) {
              this.grab(i, true);
              break;
            }
          }
        }
        break;
      }

      default:
        break;
    }

    if (this.playerY > this.runBestY) {
      this.runBestY = this.playerY;
      if (!this.recordPassed && this.playerY > this.bestY) {
        this.recordPassed = true;
        this.emit(EV.RECORD, 0, 0);
      }
    }

    // 카메라는 플레이어를 화면 상단 40%에 유지한다
    this.camY += (this.playerY - this.camY) * C.CAM_LERP;

    if (this.state !== S.DEAD && this.playerY - C.PLAYER_RADIUS <= this.waterY) {
      this.die();
    }
  }

  resolveLanding() {
    // 도착 시점 판정. 발판이 움직였거나 사라졌으면 그 결과가 그대로 반영된다.
    const t = this.pendingTarget;
    let aimError = 2, signed = 0;
    if (t >= 0 && !this.platGone(t)) {
      const tol = this.toleranceAt(t);
      signed = this.leapToY - this.platYAt(t);
      aimError = Math.abs(signed) / tol;
    }
    this.lastAimError = aimError > 2 ? 2 : aimError;
    this.lastAimSigned = signed;
    this.pendingHit = aimError <= 1;
    this.pendingPerfect = aimError <= C.PERFECT_RATIO;

    if (this.pendingHit) {
      this.grab(this.pendingTarget, false);
    } else {
      if (this.combo > 0) this.emit(EV.COMBO_BREAK, this.combo, 0);
      this.combo = 0;
      this.side = 1 - this.side;
      this.playerX = this.wallX(this.side);
      this.fallVel = 0;
      this.coyoteLeft = this.coyoteFrames;
      this.landedResolveTo = S.FALLING;
      this.setState(S.LANDED);
      this.emit(EV.MISS, this.lastAimSigned, 0);
    }
  }

  grab(idx, viaCoyote) {
    const skip = viaCoyote ? 0 : this.lastSkip;
    const slot = idx % C.PLAT_POOL;
    this.side = this.platSideAt(idx);
    this.platIdx = idx;
    this.playerX = this.wallX(this.side);
    this.rideOffset = this.playerY - this.platYAt(idx);
    this.depth++;
    this.ensurePlatform(idx + C.LOOKAHEAD);

    let bonus = false;
    if (this._platFlags[slot] & C.F_BONUS) {
      this._platFlags[slot] &= ~C.F_BONUS;
      this.waterY -= C.BONUS_WATER_PUSH;   // 유혹의 대가: 물이 내려간다
      bonus = true;
    }

    // 부서지는 발판은 붙는 순간부터 무너지기 시작한다.
    // 여기 오래 서서 정확히 겨눌 수는 없다 — 정확함과 시간이 정면으로 부딪힌다.
    if ((this._platFlags[slot] & C.F_CRUMBLE) && this._platCrumble[slot] === 0) {
      this._platCrumble[slot] = C.CRUMBLE_FRAMES;
    }

    // 관문 — 끝없이 오르기만 하면 진척이 안 느껴진다. 일정 간격마다 사건을 만든다.
    if (this.depth % C.GATE_EVERY === 0) {
      this.score += C.GATE_SCORE;
      this.waterY -= C.GATE_WATER_PUSH;
      this.emit(EV.GATE, this.depth, 0);
    }

    // ── 콤보 — 연속 완벽 착지만 이어진다 ──
    // 그냥 붙기만 해서는 끊긴다. 코요테 구제도 끊는다 — 그건 실수를 봐준 것이지 실력이 아니다.
    const perfect = !viaCoyote && this.pendingPerfect;
    if (perfect) {
      this.perfectCount++;
      this.combo += 1 + (skip > 0 ? 1 : 0);   // 건너뛰며 완벽하면 두 칸 오른다
      if (this.combo > this.comboBest) this.comboBest = this.combo;
      this.emit(EV.PERFECT, this.lastAimError, 0);
      this.emit(EV.COMBO, this.combo, this.comboTier());
    } else {
      if (this.combo > 0) this.emit(EV.COMBO_BREAK, this.combo, 0);
      this.combo = 0;
      if (viaCoyote) this.emit(EV.COYOTE, 0, 0);
      this.emit(EV.LAND, this.lastAimError, 0);
    }

    if (skip > 0) this.emit(EV.SKIP, skip, 0);
    if (bonus) this.emit(EV.BONUS, 0, 0);

    // ── 점수 — 멀리 뛸수록, 건너뛸수록, 콤보가 높을수록 ──
    const mult = 1 + this.combo * C.COMBO_MULT_STEP;
    let gain = C.SCORE_BASE + this.aimDist * C.SCORE_PER_PX + skip * C.SCORE_SKIP;
    if (bonus) gain += C.SCORE_BONUS;
    this.score += (gain * mult) | 0;

    this.landedResolveTo = S.READY;
    this.setState(S.LANDED);
  }

  // 부서지는 발판의 시계. 플레이어 주변만 돈다.
  tickCrumble() {
    const first = this.platIdx - 4 < 0 ? 0 : this.platIdx - 4;
    const last = this.platIdx + C.LOOKAHEAD;
    for (let i = first; i <= last; i++) {
      const slot = i % C.PLAT_POOL;
      const c = this._platCrumble[slot];
      if (c <= 0) continue;
      const next = c - 1;
      this._platCrumble[slot] = next === 0 ? -1 : next;
      if (next === 0 && i === this.platIdx) {
        if (this.state === S.READY || this.state === S.CHARGING || this.state === S.LANDED) {
          this.dropFromPlatform();
        }
      }
    }
  }

  dropFromPlatform() {
    if (this.combo > 0) this.emit(EV.COMBO_BREAK, this.combo, 0);
    this.combo = 0;
    this.fallVel = 0;
    this.coyoteLeft = 0;      // 발판이 사라졌다. 구제할 발판이 없다
    this.setState(S.FALLING);
    this.emit(EV.CRUMBLE, 0, 0);
  }

  die() {
    this.deathTick = this.tick;
    if (this.runBestY > this.bestY) this.bestY = this.runBestY;
    if (this.score > this.bestScore) this.bestScore = this.score;
    if (this.comboBest > this.bestCombo) this.bestCombo = this.comboBest;
    this.combo = 0;
    this.setState(S.DEAD);
    this.emit(EV.DEATH, 0, 0);
  }

  // ── 조회 ────────────────────────────────────────────────────
  heightMeters() { return Math.max(0, this.runBestY) / C.METER_PX; }
  waterMargin()  { return this.playerY - this.waterY; }
  comboTier()    { return (this.combo / C.COMBO_TIER) | 0; }

  // 콤보가 물에 거는 힘. 1 = 평소, 0 = 멈춤, 음수 = 내려감.
  comboWaterMul() {
    if (this.combo >= C.COMBO_PUSH_AT) return C.COMBO_PUSH_MUL;
    if (this.combo >= C.COMBO_HOLD_AT) return 0;
    return 1;
  }
}
