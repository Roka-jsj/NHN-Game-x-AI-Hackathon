// 게임필 — 손끝의 감촉. 시뮬레이션 결과에 붙기만 하고 결과를 바꾸지 않는다.
//
// 이 파일은 게임 규칙을 모른다. "무슨 일이 일어났는가"만 이벤트로 받고
// "그게 어떻게 느껴지는가"를 만든다.
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
    this.freezeFrames = 0;
    this.slowFrames = 0;
    this.slowAcc = 0;

    // 셰이크는 렌더 전용이다. 판정에 관여하지 않으므로 난수를 써도 된다.
    this.shakeMag = 0;
    this.shakeRotMag = 0;
    this.shakeX = 0; this.shakeY = 0; this.shakeA = 0;

    this.sx = 1; this.sy = 1;
    this.fromX = 1; this.fromY = 1;
    this.restX = 1; this.restY = 1;
    this.tweenStep = 0;
    this.tweenSteps = Math.max(1, Math.round(C.SQUASH_MS / C.SIM_DT));

    const P = C.PARTICLE_MAX;
    this.pX = new Float32Array(P);
    this.pY = new Float32Array(P);
    this.pVX = new Float32Array(P);
    this.pVY = new Float32Array(P);
    this.pLife = new Int16Array(P);
    this.pMax = new Int16Array(P);
    this.pSize = new Float32Array(P);
    this.pKind = new Uint8Array(P);   // 0=먼지 1=코인 2=충돌
    this.pNext = 0;

    this.ringX = new Float32Array(C.RING_MAX);
    this.ringY = new Float32Array(C.RING_MAX);
    this.ringStep = new Int16Array(C.RING_MAX);
    this.ringSteps = Math.max(1, Math.round(C.RING_MS / C.SIM_DT));
    this.ringNext = 0;
    for (let i = 0; i < C.RING_MAX; i++) this.ringStep[i] = -1;

    this.tX = new Float32Array(C.TRAIL_MAX);
    this.tY = new Float32Array(C.TRAIL_MAX);
    this.tAge = new Int16Array(C.TRAIL_MAX);
    this.tNext = 0;
    for (let i = 0; i < C.TRAIL_MAX; i++) this.tAge[i] = -1;

    this.resultStep = -1;
    this.resultSteps = Math.max(1, Math.round(C.RESULT_UI_MS / C.SIM_DT));
    this.flashFrames = 0;
    this.lastTier = 0;
  }

  // 탭 전환 복귀 시 호출. 히트스톱·셰이크가 누적되어 터지는 걸 막는다.
  clearTransient() {
    this.freezeFrames = 0;
    this.slowFrames = 0;
    this.slowAcc = 0;
    this.shakeMag = 0; this.shakeRotMag = 0;
    this.shakeX = 0; this.shakeY = 0; this.shakeA = 0;
    this.flashFrames = 0;
  }

  reset() {
    this.clearTransient();
    this.sx = 1; this.sy = 1;
    this.fromX = 1; this.fromY = 1; this.restX = 1; this.restY = 1;
    this.tweenStep = this.tweenSteps;
    this.resultStep = -1;
    this.lastTier = 0;
    for (let i = 0; i < C.PARTICLE_MAX; i++) this.pLife[i] = 0;
    for (let i = 0; i < C.RING_MAX; i++) this.ringStep[i] = -1;
    for (let i = 0; i < C.TRAIL_MAX; i++) this.tAge[i] = -1;
  }

  // true 를 반환하면 main 은 game.step() 을 부르지 않는다.
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

  stepFrozen() {
    this.decayShake();
    if (this.flashFrames > 0) this.flashFrames--;
  }

  decayShake() {
    if (this.shakeMag > 0.02) {
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
    this.decayShake();
    if (this.flashFrames > 0) this.flashFrames--;

    if (this.tweenStep < this.tweenSteps) {
      this.tweenStep++;
      const t = this.tweenStep / this.tweenSteps;
      const e = easeOutBack(t);
      this.sx = this.fromX + (this.restX - this.fromX) * e;
      this.sy = this.fromY + (this.restY - this.fromY) * e;
    }

    for (let i = 0; i < C.PARTICLE_MAX; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pX[i] += this.pVX[i];
      this.pY[i] += this.pVY[i];
      this.pVY[i] -= C.PART_GRAVITY;
      this.pLife[i]--;
    }

    for (let i = 0; i < C.RING_MAX; i++) {
      if (this.ringStep[i] < 0) continue;
      this.ringStep[i]++;
      if (this.ringStep[i] > this.ringSteps) this.ringStep[i] = -1;
    }

    for (let i = 0; i < C.TRAIL_MAX; i++) {
      if (this.tAge[i] >= 0) {
        this.tAge[i]++;
        if (this.tAge[i] > C.TRAIL_FRAMES) this.tAge[i] = -1;
      }
    }
    // 잔상은 달리는 동안 계속 남는다. 속도감의 절반이 여기서 나온다.
    if (game.state === S.RUN && (game.tick & 1) === 0) {
      const i = this.tNext;
      this.tX[i] = game.worldX;
      this.tY[i] = game.footY;
      this.tAge[i] = 0;
      this.tNext = (i + 1) % C.TRAIL_MAX;
    }

    if (this.resultStep >= 0 && this.resultStep < this.resultSteps) this.resultStep++;

    // 물 근접 상시 미세 진동 — 시각 경고보다 먼저 몸이 안다
    const near = game.waterNear();
    if (near > 0) {
      const want = near * near * C.SHAKE_WATER_MAX;
      if (want > this.shakeMag) this.shakeMag = want;
    }
  }

  onEvent(type, a, b, game) {
    switch (type) {
      case EV.JUMP:
        this.sx = C.SQUASH_JUMP_X; this.sy = C.SQUASH_JUMP_Y;
        this.setPose(1, 1);
        break;

      case EV.LAND:
        this.sx = C.SQUASH_LAND_X; this.sy = C.SQUASH_LAND_Y;
        this.setPose(1, 1);
        this.burst(game.worldX, 0, 4, 0);
        break;

      case EV.SLIDE:
        this.sx = 1.2; this.sy = 0.7;
        this.setPose(1, 1);
        this.burst(game.worldX, 0, 4, 0);
        break;

      case EV.COIN:
        this.freezeFrames = C.HITSTOP_COIN;
        this.addShake(C.SHAKE_COIN, 0);
        this.burst(game.worldX, C.COIN_H, C.PART_COIN, 1);
        break;

      case EV.NEAR_MISS:
        if (a > 0) {
          this.freezeFrames = C.HITSTOP_NEAR;
          this.addShake(C.SHAKE_NEAR, 0);
          this.burst(game.worldX, game.footY + 40, C.PART_NEAR, 0);
        }
        break;

      case EV.COMBO: {
        const tier = b;
        if (tier > this.lastTier) {
          this.lastTier = tier;
          this.addShake(C.SHAKE_NEAR + tier, 0);
          this.ring(game.worldX, game.footY + C.PLAYER_H * 0.5);
          this.flashFrames = 2;
        }
        break;
      }

      case EV.COMBO_BREAK:
        this.lastTier = 0;
        break;

      case EV.HIT:
        this.sx = C.SQUASH_HIT_X; this.sy = C.SQUASH_HIT_Y;
        this.setPose(1, 1);
        this.freezeFrames = C.HITSTOP_HIT;
        this.addShake(C.SHAKE_HIT, C.SHAKE_ROT_DEATH * 0.5);
        this.burst(game.worldX, game.footY + 50, C.PART_HIT, 2);
        break;

      case EV.SHIELD:
        this.freezeFrames = C.HITSTOP_HIT;
        this.addShake(C.SHAKE_NEAR, 0);
        this.ring(game.worldX, game.footY + C.PLAYER_H * 0.5);
        break;

      case EV.STAIR_STEP:
        this.freezeFrames = C.HITSTOP_STAIR;
        this.addShake(C.SHAKE_STAIR, 0);
        this.burst(game.worldX, 0, 3, 0);
        break;

      case EV.STAIR_MISS:
        this.addShake(C.SHAKE_HIT * 0.6, 0);
        break;

      case EV.STAIR_CLEAR:
        this.flashFrames = 3;
        this.ring(0, C.PLAYER_H * 0.5);
        break;

      case EV.RECORD:
        this.flashFrames = 3;
        this.addShake(C.SHAKE_STAIR, 0);
        break;

      case EV.DEATH:
        this.freezeFrames = C.HITSTOP_DEATH;
        this.slowFrames = C.DEATH_SLOW_FRAMES;
        this.slowAcc = 0;
        this.addShake(C.SHAKE_DEATH, C.SHAKE_ROT_DEATH);
        this.burst(game.worldX, game.footY + 50, C.PART_DEATH, 2);
        this.resultStep = 0;
        break;

      case EV.RESET:
        this.reset();
        break;

      default:
        break;
    }
  }

  setPose(x, y) {
    this.fromX = this.sx; this.fromY = this.sy;
    this.restX = x; this.restY = y;
    this.tweenStep = 0;
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
      const ang = Math.random() * Math.PI * 2;
      const spd = kind === 2 ? 1.8 + Math.random() * 4.2 : 0.8 + Math.random() * 2.4;
      this.pX[i] = x;
      this.pY[i] = y;
      this.pVX[i] = Math.cos(ang) * spd;
      this.pVY[i] = Math.abs(Math.sin(ang)) * spd * (kind === 2 ? 1.8 : 1.2);
      const life = kind === 2 ? 34 : 20;
      this.pLife[i] = life;
      this.pMax[i] = life;
      this.pSize[i] = kind === 1 ? 3 : 2;
      this.pKind[i] = kind;
    }
  }
}
