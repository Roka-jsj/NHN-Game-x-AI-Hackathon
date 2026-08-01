// 오디오 — 게임필의 나머지 절반.
//
// **오디오 파일이 0개다.** mp3·wav·ogg 하나도 없다. 전부 WebAudio 절차적 합성이다.
//   - 라이선스 문제 0. 외부 에셋 출처를 기재할 것이 없다
//   - 로딩 시간 0. 첫 로딩 2초에 오디오가 기여하는 바이트가 없다
//   - 지연 0. <audio> 태그는 재생 지연이 커서 타격감을 죽인다
//
// 소리는 기존 상태 전이에 **붙기만** 한다. 전이 타이밍을 바꾸지 않는다.

import * as C from './config.js';
import { EV, S } from './game.js';

const MASTER_CAP = 0.7;

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.ready = false;
    this.failed = false;

    this.noiseBuf = null;
    this.waterGain = null;
    this.runOsc = null;
    this.runGain = null;
  }

  // 첫 사용자 제스처에서 반드시 불려야 한다.
  // 안 하면 심사자 아이폰에서 완전 무음이다. 실기기로만 확인 가능하다.
  unlock() {
    if (this.failed) return;
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) { this.failed = true; return; }
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : MASTER_CAP;
        this.master.connect(this.ctx.destination);
        this.buildNoise();
        this.buildWaterLoop();
        this.buildRunDrone();
        // 전화 수신 등으로 다시 suspended 로 돌아가는 경우도 처리한다
        this.ctx.onstatechange = () => {
          if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        };
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      // resume 만으로 안 풀리는 기기가 있다. 무음 버퍼를 한 번 재생한다.
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      src.connect(this.master);
      src.start(0);
      this.ready = true;
    } catch (e) {
      this.failed = true;   // 소리가 없어도 게임은 100% 돈다
    }
  }

  buildNoise() {
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  // 물 근접 저역 노이즈. 한 번 만들어 계속 돌리고 게인만 연속 제어한다.
  // 이게 이 게임의 긴장을 만든다 — 시각 경고보다 먼저 느껴져야 한다.
  buildWaterLoop() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 200;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(0);
    this.waterGain = g;
  }

  // 질주 저역. 속도가 오르면 음도 오른다 — 빨라지는 게 귀로 들린다.
  buildRunDrone() {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 55;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    o.connect(g); g.connect(this.master);
    o.start(0);
    this.runOsc = o;
    this.runGain = g;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : MASTER_CAP;
  }

  // 탭이 숨겨질 때. 배경에서 계속 울리면 안 된다.
  hush() {
    if (!this.ready || this.failed) return;
    const t = this.ctx.currentTime;
    this.runGain.gain.setTargetAtTime(0, t, 0.02);
    this.waterGain.gain.setTargetAtTime(0, t, 0.02);
  }

  // 같은 소리를 연속 재생할 때 ±3% 피치 변화. 안 하면 기계처럼 들린다.
  // 이건 연출이라 난수를 써도 된다 — 판정과 무관하다.
  vary(f) { return f * (1 + (Math.random() * 2 - 1) * 0.03); }

  // 일회용 오실레이터. ended 에서 disconnect 해 노드가 쌓이지 않게 한다.
  blip(type, f0, f1, ms, gain, delay) {
    if (!this.ready || this.failed) return;
    const t = this.ctx.currentTime + (delay || 0);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(this.vary(f0), t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, this.vary(f1)), t + ms / 1000);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g); g.connect(this.master);
    o.onended = () => { o.disconnect(); g.disconnect(); };
    o.start(t);
    o.stop(t + ms / 1000 + 0.01);
  }

  noise(ms, gain, cutFrom, cutTo, type) {
    if (!this.ready || this.failed) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type || 'lowpass';
    f.frequency.setValueAtTime(cutFrom, t);
    if (cutTo !== cutFrom) f.frequency.exponentialRampToValueAtTime(Math.max(20, cutTo), t + ms / 1000);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
    src.start(t);
    src.stop(t + ms / 1000);
  }

  // ── 매 프레임 — 연속 파라미터만 만진다. 노드를 만들지 않는다 ──
  update(game) {
    if (!this.ready || this.failed) return;
    const t = this.ctx.currentTime;

    // 질주음 — 속도에 연동
    const alive = game.state !== S.DEAD && game.state !== S.DRAFT;
    const spd = game.speed / C.SPEED_MAX;
    this.runOsc.frequency.setTargetAtTime(48 + 46 * spd, t, 0.05);
    this.runGain.gain.setTargetAtTime(alive ? 0.05 + 0.05 * spd : 0, t, 0.08);

    // 물 근접 — 0 → 0.16 을 근접도에 비례해 연속 제어
    const near = game.waterNear();
    this.waterGain.gain.setTargetAtTime(near * near * 0.16, t, 0.08);
  }

  // ── 상태 전이에 붙는다. 전이 타이밍을 바꾸지 않는다 ──────────
  onEvent(type, a, b, game) {
    if (this.failed) return;
    switch (type) {
      case EV.MOVE:
        // 레인 이동 — 짧은 스와이프음. 방향에 따라 위/아래로 쓸린다
        this.blip('triangle', b > 0 ? 420 : 520, b > 0 ? 560 : 400, 70, 0.07, 0);
        break;

      case EV.JUMP:
        this.blip('triangle', 300, 620, 130, 0.09, 0);
        break;

      case EV.SLIDE:
        this.noise(180, 0.09, 1800, 500, 'lowpass');
        break;

      case EV.LAND:
        this.blip('sine', 120, 70, 60, 0.12, 0);
        this.noise(15, 0.06, 2000, 2000, 'lowpass');
        break;

      case EV.COIN:
        this.blip('sine', 880, 1320, 90, 0.10, 0);
        break;

      case EV.NEAR_MISS:
        if (a > 0) this.noise(90, 0.07, 2600, 900, 'bandpass');
        break;

      case EV.COMBO: {
        // 티어가 오를수록 화음이 위로 쌓인다. 콤보가 귀로 들린다.
        const tier = b > 5 ? 5 : b;
        if (tier > 0) {
          const f = 330 * Math.pow(1.5, tier - 1);
          this.blip('sine', f, f, 140, 0.09, 0);
        }
        break;
      }

      case EV.HIT:
        // 충돌 — 저역 임팩트 + 마찰. 죽는 소리는 아니지만 아프게 들려야 한다
        this.blip('square', 180, 60, 180, 0.16, 0);
        this.noise(260, 0.16, 1200, 180, 'lowpass');
        break;

      case EV.SHIELD:
        this.blip('sine', 660, 990, 160, 0.12, 0);
        break;

      case EV.STAIR_ENTER:
        this.blip('sine', 440, 660, 160, 0.10, 0);
        this.blip('sine', 660, 880, 200, 0.09, 0.1);
        break;

      case EV.STAIR_STEP: {
        // 오를수록 음이 올라간다. 리듬이 귀로 들린다.
        const n = a > 18 ? 18 : a;
        this.blip('triangle', 300 + n * 26, 300 + n * 26, 90, 0.11, 0);
        break;
      }

      case EV.STAIR_MISS:
        this.blip('square', 200, 110, 160, 0.13, 0);
        break;

      case EV.STAIR_CLEAR:
        this.blip('sine', 523.25, 523.25, 80, 0.11, 0);
        this.blip('sine', 659.25, 659.25, 80, 0.11, 0.08);
        this.blip('sine', 783.99, 783.99, 120, 0.11, 0.16);
        break;

      case EV.DRAFT_OPEN:
        this.blip('sine', 392, 523.25, 220, 0.09, 0);
        break;

      case EV.DRAFT_PICK:
        this.blip('sine', 523.25, 784, 200, 0.12, 0);
        break;

      case EV.RECORD:
        this.blip('sine', 660, 990, 90, 0.10, 0);
        this.blip('sine', 990, 1320, 120, 0.10, 0.09);
        break;

      case EV.DEATH:
        // 화이트노이즈 + 로우패스 800 → 80Hz 스윕, 800ms
        this.noise(800, 0.22, 800, 80, 'lowpass');
        break;

      case EV.RESET:
        break;

      default:
        break;
    }
  }
}
