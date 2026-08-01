// 오디오 — 게임필의 나머지 절반.
//
// **오디오 파일이 0개다.** mp3·wav·ogg 하나도 없다. 전부 WebAudio 절차적 합성이다.
// 그 결과:
//   - 라이선스 문제 0. 외부 에셋 출처를 기재할 것이 없다
//   - 로딩 시간 0. 첫 로딩 2초(게이트 #7)에 오디오가 기여하는 바이트가 없다
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

    this.noiseBuf = null;
    this.chargeOsc = null;
    this.chargeGain = null;
    this.waterGain = null;
    this.overcharge = false;
    this.failed = false;
  }

  // 첫 사용자 제스처에서 반드시 불려야 한다.
  // 안 하면 심사자 아이폰에서 완전 무음이다. 이건 실기기로만 확인 가능하다.
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
    lp.frequency.value = 220;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(0);
    this.waterGain = g;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : MASTER_CAP;
  }

  // 같은 소리를 연속 재생할 때 ±3% 피치 변화. 안 하면 기계처럼 들린다.
  // 특히 연속 착지에서 확연하다. 이건 연출이라 난수를 써도 된다 — 판정과 무관하다.
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

  startCharge() {
    if (!this.ready || this.failed) return;
    this.stopCharge();
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    g.gain.setValueAtTime(0.06, t);
    o.connect(g); g.connect(this.master);
    o.start(t);
    this.chargeOsc = o;
    this.chargeGain = g;
    this.overcharge = false;
  }

  // 릴리스 시 즉시 정지. 감쇠 없이 끊는 게 명료하다.
  stopCharge() {
    if (this.chargeOsc) {
      try { this.chargeOsc.stop(); } catch (e) { /* 이미 정지 */ }
      this.chargeOsc.disconnect();
      this.chargeGain.disconnect();
      this.chargeOsc = null;
      this.chargeGain = null;
    }
  }

  // ── 매 프레임 — 연속 파라미터만 만진다. 노드를 만들지 않는다 ──
  update(game) {
    if (!this.ready || this.failed) return;
    const t = this.ctx.currentTime;

    if (this.chargeOsc && game.state === S.CHARGING) {
      // 220 → 660Hz 선형 상승. 차지 진행도에 연동한다.
      const held = game.simTime - game.chargePressSim;
      const r = held < 0 ? 0 : (held > C.CHARGE_MAX_MS ? 1 : held / C.CHARGE_MAX_MS);
      this.chargeOsc.frequency.setTargetAtTime(220 + 440 * r, t, 0.01);
      // 오버차지 맥동 — 6프레임 주기로 게인이 뛴다
      if (this.overcharge) {
        const on = (((game.tick / 6) | 0) & 1) === 0;
        this.chargeGain.gain.setTargetAtTime(on ? 0.10 : 0.06, t, 0.005);
      }
    }

    // 물 근접 — 0 → 0.15 를 근접도에 비례해 연속 제어
    const margin = game.waterMargin();
    let near = 0;
    if (margin < C.WATER_NEAR_PX) near = margin <= 0 ? 1 : 1 - margin / C.WATER_NEAR_PX;
    this.waterGain.gain.setTargetAtTime(near * near * 0.15, t, 0.08);
  }

  // ── 상태 전이에 붙는다. 전이 타이밍을 바꾸지 않는다 ──
  onEvent(type, a, b, game) {
    if (this.failed) return;
    switch (type) {
      case EV.CHARGE_START:
        this.startCharge();
        break;

      case EV.OVERCHARGE:
        this.overcharge = true;
        break;

      case EV.FIRE:
        this.stopCharge();
        this.blip('square', 880, 220, 40, 0.12, 0);   // 처프
        break;

      case EV.LAND:
        this.kick();
        break;

      case EV.PERFECT:
        this.kick();
        // 완전 5도 위 음을 동시에. 이게 중독의 소리다.
        this.blip('sine', 180, 180, 90, 0.09, 0);
        break;

      case EV.COMBO: {
        // 티어가 오를수록 화음이 위로 쌓인다. 콤보가 귀로 들린다.
        const tier = b > 5 ? 5 : b;
        if (tier > 0) {
          const f = 330 * Math.pow(1.5, tier - 1);
          this.blip('sine', f, f, 130, 0.09, 0);
        }
        break;
      }

      case EV.COMBO_BREAK:
        this.blip('sine', 200, 120, 90, 0.06, 0);
        break;

      case EV.MISS:
        this.noise(80, 0.10, 1400, 600, 'bandpass');   // 마찰감
        break;

      case EV.CRUMBLE:
        this.noise(140, 0.12, 900, 200, 'lowpass');
        break;

      case EV.BONUS:
        this.blip('sine', 660, 990, 120, 0.10, 0);
        break;

      case EV.GATE:
        this.blip('sine', 440, 440, 90, 0.08, 0);
        this.blip('sine', 660, 660, 110, 0.07, 0.06);
        break;

      case EV.RECORD:
        // 상승 아르페지오 3음 — 근음 · 3도 · 5도
        this.blip('sine', 523.25, 523.25, 70, 0.10, 0);
        this.blip('sine', 659.25, 659.25, 70, 0.10, 0.07);
        this.blip('sine', 783.99, 783.99, 90, 0.10, 0.14);
        break;

      case EV.DEATH:
        this.stopCharge();
        // 화이트노이즈 + 로우패스 800 → 80Hz 스윕, 800ms
        this.noise(800, 0.22, 800, 80, 'lowpass');
        break;

      case EV.RESET:
        this.stopCharge();
        this.overcharge = false;
        break;

      default:
        break;
    }
  }

  // 사인 킥 120 → 60Hz 60ms + 화이트노이즈 버스트 15ms
  kick() {
    this.blip('sine', 120, 60, 60, 0.16, 0);
    this.noise(15, 0.10, 2000, 2000, 'lowpass');
  }
}
