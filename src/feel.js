// 게임필 — 손끝의 감촉. 시뮬레이션 결과에 붙기만 하고 결과를 바꾸지 않는다.
//
// 이 파일은 게임 규칙을 모른다. "무슨 일이 일어났는가"만 이벤트로 받고
// "그게 어떻게 느껴지는가"를 만든다. 물리 수치는 건드리지 않는다.
//
// 히트스톱은 시뮬레이션 프레임 단위다. 렌더 프레임이 아니다.
// 시뮬은 주사율과 무관하게 60Hz 고정이므로, 프레임 수로 세면
// 60Hz와 120Hz에서 지속 시간이 저절로 같아진다.

import * as C from './config.js';
import { EV, S } from './game.js';

export function easeOutBack(t) {
  const s = 1.70158;
  const u = t - 1;
  return u * u * ((s + 1) * u + s) + 1;
}
export function easeOutCubic(t) {
  const u = t - 1;
  return u * u * u + 1;
}

export class Feel {
  constructor() {
    // ─ 히트스톱 · 슬로우 ─
    this.freezeFrames = 0;
    this.slowFrames = 0;
    this.slowAcc = 0;

    // ─ 셰이크 ─ (렌더 전용. 판정에 절대 관여하지 않으므로 난수를 써도 된다)
    this.shakeMag = 0;
    this.shakeRotMag = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeA = 0;

    // ─ 스쿼시 & 스트레치 ─
    this.sx = 1; this.sy = 1;
    this.fromX = 1; this.fromY = 1;
    this.restX = 1; this.restY = 1;
    this.tweenStep = 0;
    this.tweenSteps = Math.max(1, Math.round(C.SQUASH_MS / C.SIM_DT));

    // ─ 파티클 ─ (고정 크기 배열 재사용. 정식 풀 검증은 패스 3)
    const P = C.PARTICLE_MAX;
    this.pX = new Float32Array(P);
    this.pY = new Float32Array(P);
    this.pVX = new Float32Array(P);
    this.pVY = new Float32Array(P);
    this.pLife = new Int16Array(P);
    this.pMax = new Int16Array(P);
    this.pSize = new Float32Array(P);
    this.pKind = new Uint8Array(P);   // 0=먼지 1=완벽 2=물보라
    this.pNext = 0;

    // ─ 링 ─
    this.ringX = new Float32Array(C.RING_MAX);
    this.ringY = new Float32Array(C.RING_MAX);
    this.ringStep = new Int16Array(C.RING_MAX);
    this.ringSteps = Math.max(1, Math.round(C.RING_MS / C.SIM_DT));
    this.ringNext = 0;
    for (let i = 0; i < C.RING_MAX; i++) this.ringStep[i] = -1;

    // ─ 트레일 ─
    this.tX = new Float32Array(C.TRAIL_MAX);
    this.tY = new Float32Array(C.TRAIL_MAX);
    this.tAge = new Int16Array(C.TRAIL_MAX);
    this.tNext = 0;
    for (let i = 0; i < C.TRAIL_MAX; i++) this.tAge[i] = -1;

    // ─ 결과 UI ─
    this.resultStep = -1;
    this.resultSteps = Math.max(1, Math.round(C.RESULT_UI_MS / C.SIM_DT));

    this.flashFrames = 0;      // 신기록 흰 섬광
    this.overcharge = false;
    this.lastTier = 0;         // 콤보 티어. 오를 때만 보상을 준다
  }

  // 탭 전환 복귀 시 호출. 히트스톱·셰이크가 누적되어 터지는 걸 막는다.
  clearTransient() {
    this.freezeFrames = 0;
    this.slowFrames = 0;
    this.slowAcc = 0;
    this.shakeMag = 0;
    this.shakeRotMag = 0;
    this.shakeX = 0; this.shakeY = 0; this.shakeA = 0;
    this.flashFrames = 0;
    this.overcharge = false;
  }

  reset() {
    this.clearTransient();
    this.sx = 1; this.sy = 1;
    this.fromX = 1; this.fromY = 1; this.restX = 1; this.restY = 1;
    this.tweenStep = this.tweenSteps;
    this.resultStep = -1;
    for (let i = 0; i < C.PARTICLE_MAX; i++) this.pLife[i] = 0;
    for (let i = 0; i < C.RING_MAX; i++) this.ringStep[i] = -1;
    for (let i = 0; i < C.TRAIL_MAX; i++) this.tAge[i] = -1;
  }

  // ── 이 스텝을 건너뛸 것인가 ─────────────────────────────────
  // true를 반환하면 main은 game.step()을 부르지 않는다.
  // 누산기는 건드리지 않는다 — 정지는 시뮬레이션만 멈추고 렌더는 계속한다.
  consumeFreeze() {
    if (this.freezeFrames > 0) { this.freezeFrames--; return true; }
    if (this.slowFrames > 0) {
      this.slowFrames--;
      this.slowAcc += C.DEATH_SLOW_RATE;
      if (this.slowAcc >= 1) { this.slowAcc -= 1; return false; }
      return true;
    }
    return false;
  }

  // 정지 중에도 도는 것 — 셰이크만. 화면이 굳어 보이면 안 된다.
  stepFrozen() {
    this.decayShake();
    if (this.flashFrames > 0) this.flashFrames--;
  }

  decayShake() {
    if (this.shakeMag > 0.02) {
      // 셰이크 오프셋은 렌더에만 쓰인다. 시뮬레이션·판정과 무관하다.
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

  // ── 한 스텝 ─────────────────────────────────────────────────
  step(game) {
    this.decayShake();
    if (this.flashFrames > 0) this.flashFrames--;

    // 스쿼시 복귀 — easeOutBack
    if (this.tweenStep < this.tweenSteps) {
      this.tweenStep++;
      const t = this.tweenStep / this.tweenSteps;
      const e = easeOutBack(t);
      this.sx = this.fromX + (this.restX - this.fromX) * e;
      this.sy = this.fromY + (this.restY - this.fromY) * e;
    }

    // 파티클
    for (let i = 0; i < C.PARTICLE_MAX; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pX[i] += this.pVX[i];
      this.pY[i] += this.pVY[i];
      this.pVY[i] -= C.PART_GRAVITY;
      this.pLife[i]--;
    }

    // 링
    for (let i = 0; i < C.RING_MAX; i++) {
      if (this.ringStep[i] < 0) continue;
      this.ringStep[i]++;
      if (this.ringStep[i] > this.ringSteps) this.ringStep[i] = -1;
    }

    // 트레일 — 도약 중에만 남긴다
    for (let i = 0; i < C.TRAIL_MAX; i++) {
      if (this.tAge[i] >= 0) {
        this.tAge[i]++;
        if (this.tAge[i] > C.TRAIL_FRAMES) this.tAge[i] = -1;
      }
    }
    if (game.state === S.LEAPING) {
      const i = this.tNext;
      this.tX[i] = game.playerX;
      this.tY[i] = game.playerY;
      this.tAge[i] = 0;
      this.tNext = (i + 1) % C.TRAIL_MAX;
    }

    // 결과 UI 등장
    if (this.resultStep >= 0 && this.resultStep < this.resultSteps) this.resultStep++;

    // 물 근접 상시 미세 진동 — 시각 경고보다 먼저 몸이 안다
    const margin = game.waterMargin();
    if (margin < C.WATER_NEAR_PX && margin > 0) {
      const near = 1 - margin / C.WATER_NEAR_PX;
      const want = near * near * C.SHAKE_WATER_MAX;
      if (want > this.shakeMag) this.shakeMag = want;
    }
  }

  // ── 이벤트 수신 ─────────────────────────────────────────────
  onEvent(type, a, b, game) {
    switch (type) {
      case EV.CHARGE_START:
        this.setPose(C.SQUASH_CHARGE_X, C.SQUASH_CHARGE_Y, true);
        this.overcharge = false;
        break;

      case EV.OVERCHARGE:
        this.overcharge = true;
        break;

      case EV.FIRE:
        this.sx = C.SQUASH_FIRE_X; this.sy = C.SQUASH_FIRE_Y;
        this.setPose(1, 1, false);
        this.overcharge = false;
        break;

      case EV.LAND:
        this.sx = C.SQUASH_LAND_X; this.sy = C.SQUASH_LAND_Y;
        this.setPose(1, 1, false);
        this.freezeFrames = C.HITSTOP_LAND;
        this.addShake(C.SHAKE_LAND, 0);
        this.burst(game.playerX, game.playerY, C.PART_LAND, 0);
        break;

      case EV.PERFECT:
        this.sx = C.SQUASH_LAND_X; this.sy = C.SQUASH_LAND_Y;
        this.setPose(1, 1, false);
        this.freezeFrames = C.HITSTOP_PERFECT;
        this.addShake(C.SHAKE_PERFECT, 0);
        this.burst(game.playerX, game.playerY, C.PART_PERFECT, 1);
        this.ring(game.playerX, game.playerY);
        break;

      case EV.RECORD:
        this.freezeFrames = C.HITSTOP_RECORD;
        this.addShake(C.SHAKE_RECORD, 0);
        this.flashFrames = 3;
        break;

      // 콤보가 오를수록 보상이 커진다. 티어가 바뀌는 순간이 사건이 되어야 한다.
      case EV.COMBO: {
        const tier = b;
        if (tier > this.lastTier) {
          this.lastTier = tier;
          this.freezeFrames = C.HITSTOP_PERFECT + (tier > 3 ? 3 : tier);
          this.addShake(C.SHAKE_PERFECT + tier, 0);
          this.ring(game.playerX, game.playerY);
          this.flashFrames = 2;
        }
        break;
      }

      case EV.COMBO_BREAK:
        this.lastTier = 0;
        this.addShake(C.SHAKE_LAND, 0);
        break;

      case EV.SKIP:
        this.burst(game.playerX, game.playerY, C.PART_PERFECT, 1);
        break;

      case EV.GATE:
        this.freezeFrames = C.HITSTOP_RECORD;
        this.addShake(C.SHAKE_RECORD, 0);
        this.flashFrames = 3;
        this.ring(game.playerX, game.playerY);
        break;

      case EV.CRUMBLE:
        this.addShake(C.SHAKE_PERFECT, C.SHAKE_ROT_DEATH * 0.5);
        this.burst(game.playerX, game.playerY, C.PART_LAND, 0);
        break;

      case EV.DEATH:
        this.freezeFrames = C.HITSTOP_DEATH;
        this.slowFrames = C.DEATH_SLOW_FRAMES;
        this.slowAcc = 0;
        this.addShake(C.SHAKE_DEATH, C.SHAKE_ROT_DEATH);
        this.burst(game.playerX, game.playerY, C.PART_DEATH, 2);
        this.resultStep = 0;
        break;

      case EV.RESET:
        this.reset();
        this.lastTier = 0;
        break;

      default:
        break;
    }
  }

  setPose(x, y, immediate) {
    this.fromX = this.sx; this.fromY = this.sy;
    this.restX = x; this.restY = y;
    this.tweenStep = 0;
    if (immediate) { /* 차지 자세로 부드럽게 눌린다 */ }
  }

  addShake(mag, rot) {
    if (mag > this.shakeMag) this.shakeMag = mag;
    if (rot > this.shakeRotMag) this.shakeRotMag = rot;
  }

  ring(x, y) {
    const i = this.ringNext;
    this.ringX[i] = x; this.ringY[i] = y; this.ringStep[i] = 0;
    this.ringNext = (i + 1) % C.RING_MAX;
  }

  // 배열 재사용. 넘치면 가장 오래된 것을 덮어쓴다. new 하지 않는다.
  burst(x, y, count, kind) {
    for (let n = 0; n < count; n++) {
      const i = this.pNext;
      this.pNext = (i + 1) % C.PARTICLE_MAX;
      // 방향은 난수다 — 파티클은 연출이고 판정에 관여하지 않는다
      const ang = Math.random() * Math.PI * 2;
      const spd = kind === 2 ? 1.6 + Math.random() * 4.4 : 0.8 + Math.random() * 2.6;
      this.pX[i] = x;
      this.pY[i] = y;
      this.pVX[i] = Math.cos(ang) * spd;
      this.pVY[i] = Math.abs(Math.sin(ang)) * spd * (kind === 2 ? 1.8 : 1.1);
      const life = kind === 2 ? 34 : 20;
      this.pLife[i] = life;
      this.pMax[i] = life;
      this.pSize[i] = kind === 1 ? 3 : 2;
      this.pKind[i] = kind;
    }
  }
}
