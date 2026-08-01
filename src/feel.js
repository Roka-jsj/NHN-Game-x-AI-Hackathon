// 게임필 — 손끝의 감촉. 시뮬레이션 결과에 붙기만 하고 결과를 바꾸지 않는다.
//
// 이 파일은 게임 규칙을 모른다. "무슨 일이 일어났는가"만 이벤트로 받고
// "그게 어떻게 느껴지는가"를 만든다.
//
// 히트스톱은 시뮬레이션 프레임 단위다. 렌더 프레임이 아니다.
// 시뮬은 주사율과 무관하게 60Hz 고정이므로, 프레임 수로 세면
// 60Hz와 120Hz에서 지속 시간이 저절로 같아진다.

import * as C from './config.js';
import { EV, S, SIDE_L } from './game.js';

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
  }

  // 탭 전환 복귀 시 호출. 히트스톱·셰이크가 누적되어 터지는 걸 막는다.
  clearTransient() {
    this.freezeFrames = 0;
    this.shakeMag = 0; this.shakeRotMag = 0;
    this.shakeX = 0; this.shakeY = 0; this.shakeA = 0;
    this.flashFrames = 0;
    this.bannerFrames = 0;
  }

  reset() {
    this.clearTransient();
    this.pLife.fill(0);
    for (let i = 0; i < C.RING_MAX; i++) this.ringStep[i] = -1;
    for (let i = 0; i < C.FLOAT_MAX; i++) this.fStep[i] = -1;
    this.resultStep = -1;
  }

  // 히트스톱 — 이 스텝의 시뮬레이션만 건너뛴다. 렌더는 계속 돈다.
  consumeFreeze() {
    if (this.freezeFrames <= 0) return false;
    this.freezeFrames--;
    return true;
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
    if (this.bannerFrames > 0) this.bannerFrames--;

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

    if (game.state === S.OVER) {
      if (this.resultStep < this.resultSteps) this.resultStep++;
    } else this.resultStep = -1;
  }

  addShake(mag, rot) {
    if (mag > this.shakeMag) this.shakeMag = mag;
    if (rot > this.shakeRotMag) this.shakeRotMag = rot;
  }

  burst(x, y, n, kind) {
    for (let k = 0; k < n; k++) {
      const i = this.pNext;
      this.pNext = (this.pNext + 1) % C.PARTICLE_MAX;
      const a = (k / n) * Math.PI * 2;
      const sp = 1.4 + Math.random() * 2.6;
      this.pX[i] = x;
      this.pY[i] = y;
      this.pVX[i] = Math.cos(a) * sp;
      this.pVY[i] = Math.sin(a) * sp - 1.4;
      this.pLife[i] = C.PART_LIFE;
      this.pMax[i] = C.PART_LIFE;
      this.pSize[i] = 3 + Math.random() * 3;
      this.pKind[i] = kind;
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

  // ── 이벤트 → 감촉 ───────────────────────────────────────────
  onEvent(type, a, b, game) {
    switch (type) {
      case EV.SPAWN:
        this.burst(b === SIDE_L ? C.SPAWN_L_X : C.SPAWN_R_X, C.GROUND_Y - 6, 3, 0);
        break;

      case EV.ATTACK:
        // 매 공격마다 히트스톱을 걸면 화면이 계속 굳는다. 셰이크만 아주 약하게.
        this.addShake(C.SHAKE_HIT, 0);
        break;

      case EV.KILL:
        this.freezeFrames = C.HITSTOP_KILL;
        this.addShake(C.SHAKE_KILL, 0);
        this.burst(game.frontlineX ? game.frontlineX() : C.VIEW_W * 0.5, C.GROUND_Y - 20,
                   C.PART_KILL, b === SIDE_L ? 1 : 2);
        break;

      case EV.BASE_HIT:
        this.freezeFrames = C.HITSTOP_BASE;
        this.addShake(C.SHAKE_BASE, 0);
        this.float(b === SIDE_L ? C.BASE_L_X : C.BASE_R_X, C.GROUND_Y - C.BASE_H - 30, a, 0);
        break;

      case EV.ERA_UP:
        if (b === SIDE_L) {
          this.freezeFrames = C.HITSTOP_ERA;
          this.addShake(C.SHAKE_ERA, 0);
          this.flashFrames = C.FLASH_FRAMES;
          this.ring(C.BASE_L_X, C.GROUND_Y - C.BASE_H * 0.5);
          this.burst(C.BASE_L_X, C.GROUND_Y - C.BASE_H * 0.5, C.PART_ERA, 1);
          this.banner(C.BAN_ERA);
        }
        break;

      case EV.NUKE:
        this.freezeFrames = C.HITSTOP_NUKE;
        this.addShake(C.SHAKE_NUKE, 0.01);
        this.flashFrames = C.FLASH_FRAMES;
        this.ring(C.VIEW_W * 0.62, C.GROUND_Y - 40);
        this.burst(C.VIEW_W * 0.62, C.GROUND_Y - 40, C.PART_NUKE, 2);
        this.banner(C.BAN_NUKE);
        break;

      case EV.WATER_WARN:
        this.banner(C.BAN_WATER);
        this.addShake(C.SHAKE_KILL, 0);
        break;

      case EV.WATER_HIT:
        this.addShake(C.SHAKE_HIT * 2, 0);
        break;

      case EV.WIN:
      case EV.LOSE:
        this.freezeFrames = C.HITSTOP_END;
        this.addShake(C.SHAKE_END, C.SHAKE_ROT_END);
        this.resultStep = 0;
        break;

      case EV.RESET:
        this.reset();
        break;

      default:
        break;
    }
  }
}
