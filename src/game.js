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
};

const TAU = Math.PI * 2;

function easeOutQuad(t) { return t * (2 - t); }

export class Game {
  constructor() {
    // ─ 발판 링버퍼. 루프 안에서 객체를 만들지 않기 위해 타입배열로 둔다 ─
    this._platY = new Float64Array(C.PLAT_POOL);
    this._platSide = new Uint8Array(C.PLAT_POOL);
    this._platThick = new Float32Array(C.PLAT_POOL);
    this._platBonus = new Uint8Array(C.PLAT_POOL);

    // 발판 공급자. 패스 1은 고정 패턴, 패스 4에서 디렉터가 갈아끼운다.
    this.supplier = null;

    this.onEvent = null;       // (type, a, b) => void
    this.coyoteFrames = 5;     // 패스 4에서 디렉터가 5~8로 조정한다
    this.waterRisePerStep = C.WATER_RISE_PER_STEP;
    this.aimWobbleScale = 1;

    this.bestY = 0;            // 최고 기록. 메모리에만 둔다 (localStorage 금지)
    this.runs = 0;

    // main이 프레임 시작에서 심어주는 시각 기준점. 판 리셋과 무관하므로 여기서만 잡는다.
    this.frameWall = 0;
    this.frameSimBase = 0;

    this.reset();
  }

  // ── 발판 접근 ───────────────────────────────────────────────
  platYAt(i)     { return this._platY[i % C.PLAT_POOL]; }
  platSideAt(i)  { return this._platSide[i % C.PLAT_POOL]; }
  platThickAt(i) { return this._platThick[i % C.PLAT_POOL]; }
  platBonusAt(i) { return this._platBonus[i % C.PLAT_POOL]; }

  // 착지 허용폭 = 발판 반두께 + 플레이어 반지름
  toleranceAt(i) {
    return C.PLATFORM_THICKNESS * this.platThickAt(i) * 0.5 + C.PLAYER_RADIUS;
  }

  ensurePlatform(i) {
    while (this.platMade < i) {
      const n = this.platMade + 1;
      const slot = n % C.PLAT_POOL;
      if (n === 0) {
        this._platY[slot] = 0;
        this._platSide[slot] = 0;
        this._platThick[slot] = 1;
        this._platBonus[slot] = 0;
      } else {
        const prev = (n - 1) % C.PLAT_POOL;
        // supplier가 없으면 패스 1의 고정 패턴. 랜덤 0.
        const gap = this.supplier
          ? this.supplier.gapFor(n)
          : C.GAP_PATTERN[(n - 1) % C.GAP_PATTERN.length];
        this._platY[slot] = this._platY[prev] + gap;
        this._platSide[slot] = n % 2;
        this._platThick[slot] = this.supplier ? this.supplier.thickFor(n) : 1;
        this._platBonus[slot] = this.supplier ? this.supplier.bonusFor(n) : 0;
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
    // 멀리 뛰어 한 칸 건너뛰는 플레이가 성립한다.
    const targetSide = 1 - this.side;
    let best = -1, bestDist = Infinity;
    for (let i = this.platIdx + 1; i <= this.platIdx + C.LOOKAHEAD; i++) {
      this.ensurePlatform(i);
      if (this._platSide[i % C.PLAT_POOL] !== targetSide) continue;
      const d = Math.abs(this._platY[i % C.PLAT_POOL] - landingY);
      if (d < bestDist) { bestDist = d; best = i; }
    }

    const tol = best >= 0 ? this.toleranceAt(best) : C.BASE_TOLERANCE;
    const aimError = best >= 0 ? bestDist / tol : 2;

    this.pendingTarget = best;
    this.pendingHit = aimError <= 1;
    this.pendingPerfect = aimError <= C.PERFECT_RATIO;
    this.lastAimError = aimError > 2 ? 2 : aimError;
    this.lastAimSigned = best >= 0 ? (landingY - this.platYAt(best)) : 0;
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
      this.waterY += this.waterRisePerStep;
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
            if (Math.abs(this._platY[i % C.PLAT_POOL] - this.playerY) <= this.toleranceAt(i)) {
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
    if (this.pendingHit) {
      this.grab(this.pendingTarget, false);
    } else {
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
    this.side = this.platSideAt(idx);
    this.platIdx = idx;
    this.playerX = this.wallX(this.side);
    this.depth++;
    this.ensurePlatform(idx + C.LOOKAHEAD);

    if (this.platBonusAt(idx)) {
      this._platBonus[idx % C.PLAT_POOL] = 0;
      this.waterY -= C.WATER_START_GAP * 0.12;   // 유혹의 대가: 물이 내려간다
      this.emit(EV.BONUS, 0, 0);
    }

    if (viaCoyote) {
      this.landedResolveTo = S.READY;
      this.setState(S.LANDED);
      this.emit(EV.COYOTE, 0, 0);
      this.emit(EV.LAND, this.lastAimError, 0);
    } else {
      if (this.pendingPerfect) {
        this.perfectCount++;
        this.emit(EV.PERFECT, this.lastAimError, 0);
      } else {
        this.emit(EV.LAND, this.lastAimError, 0);
      }
      this.landedResolveTo = S.READY;
      this.setState(S.LANDED);
    }
  }

  die() {
    this.deathTick = this.tick;
    if (this.runBestY > this.bestY) this.bestY = this.runBestY;
    this.setState(S.DEAD);
    this.emit(EV.DEATH, 0, 0);
  }

  // ── 조회 ────────────────────────────────────────────────────
  heightMeters() { return Math.max(0, this.runBestY) / C.METER_PX; }
  waterMargin()  { return this.playerY - this.waterY; }
}
