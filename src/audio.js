// 오디오 — 게임필의 나머지 절반.
//
// **오디오 파일이 0개다.** mp3·wav·ogg 하나도 없다. 전부 WebAudio 절차적 합성이다.
//   - 라이선스 문제 0. 외부 에셋 출처를 기재할 것이 없다
//   - 로딩 시간 0. 첫 로딩 2초에 오디오가 기여하는 바이트가 없다
//   - 지연 0. <audio> 태그는 재생 지연이 커서 타격감을 죽인다
//
// 소리는 기존 상태 전이에 **붙기만** 한다. 전이 타이밍을 바꾸지 않는다.

import * as C from './config.js';
import { EV, S, SIDE_L } from './game.js';

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

    // BGM 층. 전부 지속 노드다 — 만들고 나면 게인·주파수만 만진다.
    this.bgm = null;
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
        this.buildMusic();
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

  // ── 배경음악 ────────────────────────────────────────────────
  // **오디오 파일 0개 규칙을 지키면서** 음악을 만든다. 그런데 박자를 내려면
  // 보통 박마다 노드를 만들어야 하고, 그건 "루프 안에서 노드를 만들지 않는다"는
  // 규칙과 정면으로 부딪힌다.
  //
  // 그래서 **박자를 LFO로 만든다.** 저주파 오실레이터가 게인을 여닫으면
  // 음이 끊겨 들리고, 그게 곧 리듬이다. 노드는 unlock 에서 한 번 만들고 끝이며
  // 이후로는 주파수와 게인만 연속 제어한다. 매 프레임 할당이 0이다.
  //
  // 층은 넷이다. **음악이 곧 상태 표시가 된다** — 눈으로 보기 전에 귀로 안다.
  //   0 베이스   항상. 템포가 속도를 따라간다
  //   1 아르페지오 콤보 티어가 오르면 열린다
  //   2 긴장 패드 물이 가까워지면 열린다 (불협 5도)
  //   3 리드     계단·부스트 구간에서만
  buildMusic() {
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);

    const layer = (type, freq, cut) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const lfo = ctx.createOscillator();     // 박자를 만드는 저주파
      lfo.type = 'square';
      lfo.frequency.value = 2;
      const lfoAmp = ctx.createGain();
      lfoAmp.gain.value = 0.5;
      const gate = ctx.createGain();
      gate.gain.value = 0.5;                  // LFO 가 ±0.5 로 흔들어 0~1 이 된다
      lfo.connect(lfoAmp); lfoAmp.connect(gate.gain);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cut;
      const out = ctx.createGain();
      out.gain.value = 0;
      osc.connect(gate); gate.connect(lp); lp.connect(out); out.connect(bus);
      osc.start(0); lfo.start(0);
      return { osc, lfo, out, lp };
    };

    // 타악 — 노이즈를 밴드패스로 좁혀 LFO 로 여닫으면 하이햇이 된다.
    // 드럼 샘플이 없어도 박자가 몸으로 느껴진다.
    const hat = (() => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 7200; bp.Q.value = 1.4;
      const lfo = ctx.createOscillator();
      lfo.type = 'square'; lfo.frequency.value = 8;
      const amp = ctx.createGain(); amp.gain.value = 0.5;
      const gate = ctx.createGain(); gate.gain.value = 0.5;
      lfo.connect(amp); amp.connect(gate.gain);
      const out = ctx.createGain(); out.gain.value = 0;
      src.connect(bp); bp.connect(gate); gate.connect(out); out.connect(bus);
      src.start(0); lfo.start(0);
      return { out, lfo, bp };
    })();

    this.bgm = {
      bus, hat,
      // 화성 진행 — 자연단음계 i · VI · III · VII.
      // 이걸 넣기 전에는 한 음만 계속 울려 "음악"이 아니라 "웅웅거림"이었다.
      // 마디마다 베이스 근음과 아르페지오·리드를 이 표에서 다시 잡는다.
      roots: [82.41, 65.41, 98.00, 73.42],     // E2 C2 G2 D2
      chordAt: 0,
      bar: 0,
      // 단조 5음 위에 쌓는다. 물에 잠기는 게임에 장조는 어울리지 않는다.
      bass: layer('triangle', 82.41, 400),      // E2
      arp:  layer('square', 329.63, 1600),      // E4
      pad:  layer('sawtooth', 246.94, 700),     // B3
      lead: layer('triangle', 493.88, 2400),    // B4
      step: 0,
    };
    // 아르페지오와 리드는 베이스보다 잘게 쪼갠다 — 층이 겹칠수록 촘촘해진다
    this.bgm.arp.lfo.frequency.value = 8;
    this.bgm.pad.lfo.frequency.value = 0.5;
    this.bgm.lead.lfo.frequency.value = 6;
  }

  // 음악 층을 상태에 맞춘다. 매 프레임 불리지만 노드를 만들지 않는다.
  updateMusic(game, t) {
    const m = this.bgm;
    if (!m) return;
    const S_PLAY = 0, S_DRAFT = 1, S_OVER = 2;
    const dead = game.state === S_OVER;
    const draft = game.state === S_DRAFT;
    const stair = false;

    // 전체 볼륨 — 죽으면 내리고, 드래프트에서는 반쯤 낮춰 생각할 여지를 준다
    m.bus.gain.setTargetAtTime(dead ? 0 : (draft ? 0.10 : 0.20), t, 0.25);

    // 템포는 전장의 밀도를 따라간다. 판이 커지는 것이 귀로 먼저 들린다.
    const spd = Math.min(1, (game.aliveL + game.aliveR) / 16);
    const beat = 2.2 + 2.2 * spd;
    m.bass.lfo.frequency.setTargetAtTime(beat, t, 0.3);
    m.arp.lfo.frequency.setTargetAtTime(beat * 4, t, 0.3);
    m.lead.lfo.frequency.setTargetAtTime(beat * 3, t, 0.3);

    // ── 화성 진행 ──
    // 마디가 바뀔 때만 근음을 바꾼다. 노드를 만들지 않고 주파수만 옮긴다 —
    // "루프 안에서 노드를 만들지 않는다"를 지키면서 곡이 흐르게 하는 방법이다.
    const barLen = 4 / beat;                    // 4박 = 한 마디 (초)
    if (t - m.chordAt > barLen) {
      m.chordAt = t;
      m.bar = (m.bar + 1) % m.roots.length;
    }
    const root = m.roots[m.bar];

    // 층 0 — 베이스는 항상. 시대가 오르면 한 옥타브 올라간다
    const boost = game.era >= 2;
    m.bass.osc.frequency.setTargetAtTime(boost ? root * 2 : root, t, 0.06);
    m.bass.out.gain.setTargetAtTime(dead ? 0 : 0.17, t, 0.2);

    // 타악 — 유닛이 많을수록 또렷해진다. 판이 달아오르는 게 박자로 들린다
    m.hat.lfo.frequency.setTargetAtTime(beat * 2, t, 0.3);
    m.hat.out.gain.setTargetAtTime(dead || draft ? 0 : 0.012 + 0.030 * spd, t, 0.3);

    // 층 1 — 전선을 밀수록 열린다. 이기고 있으면 음악이 두꺼워진다
    const tier = Math.min(4, Math.round(game.frontline() * 4));
    m.arp.out.gain.setTargetAtTime(dead ? 0 : 0.028 * tier, t, 0.25);
    m.arp.lp.frequency.setTargetAtTime(900 + 500 * tier, t, 0.3);
    m.arp.osc.frequency.setTargetAtTime(root * 4, t, 0.05);      // 근음 2옥타브 위

    // 층 2 — 물이 가까워지면 불협 5도가 깔린다. 시각 경고보다 먼저 느껴져야 한다
    const near = game.waterNear();
    m.pad.out.gain.setTargetAtTime(dead ? 0 : near * near * 0.13, t, 0.2);
    // 5도 위 — 물이 가까울수록 살짝 어긋나 불협이 된다
    m.pad.osc.frequency.setTargetAtTime(root * 3 * (1 - 0.03 * near), t, 0.3);

    // 층 3 — 계단과 부스트에서만. 규칙이 바뀐 것을 귀로도 안다
    // 층 3 — 리드는 전선을 밀고 있을 때만 열린다. **이기고 있는 게 귀로 들린다**
    const winning = game.frontline() > 0.62;
    m.lead.out.gain.setTargetAtTime((winning || boost) && !dead && !draft ? 0.075 : 0, t, 0.15);
    m.lead.osc.frequency.setTargetAtTime(root * 6, t, 0.08);     // 근음 위 5도, 2옥타브
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
    if (this.bgm) {
      this.bgm.bus.gain.setTargetAtTime(0, t, 0.02);
      this.bgm.hat.out.gain.setTargetAtTime(0, t, 0.02);
    }
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

    // 전장의 저역 — 유닛이 많을수록 두꺼워진다. 판이 커지는 게 귀로 들린다.
    const alive = game.state === S.PLAY;
    const crowd = Math.min(1, (game.aliveL + game.aliveR) / 16);
    this.runOsc.frequency.setTargetAtTime(46 + 26 * crowd, t, 0.05);
    this.runGain.gain.setTargetAtTime(alive ? 0.04 + 0.05 * crowd : 0, t, 0.08);

    // 물 근접 — 0 → 0.16 을 근접도에 비례해 연속 제어
    const near = game.waterNear();
    this.waterGain.gain.setTargetAtTime(near * near * 0.16, t, 0.08);

    this.updateMusic(game, t);
  }

  // ── 상태 전이에 붙는다. 전이 타이밍을 바꾸지 않는다 ──────────
  onEvent(type, a, b, game) {
    if (this.failed) return;
    switch (type) {
      case EV.SPAWN:
        // 진영마다 음높이가 다르다 — 내 것과 적의 것이 귀로 구분돼야 한다
        this.blip('triangle', b === SIDE_L ? 300 : 200, b === SIDE_L ? 420 : 150,
                  90, 0.07, 0);
        break;

      case EV.ATTACK:
        // 매 공격마다 난다. 아주 짧고 작아야 한다 — 안 그러면 귀가 아프다
        this.noise(28, 0.035, 2600, 1400, 'bandpass');
        break;

      case EV.KILL:
        this.blip('square', 240, 90, 130, 0.11, 0);
        this.noise(150, 0.09, 1400, 260, 'lowpass');
        break;

      case EV.BASE_HIT:
        this.blip('sine', 130, 70, 120, 0.13, 0);
        break;

      case EV.ERA_UP:
        if (b === SIDE_L) {
          // 상승 3화음 — 판이 바뀌었다는 신호
          this.blip('sine', 523.25, 523.25, 110, 0.11, 0);
          this.blip('sine', 659.25, 659.25, 110, 0.11, 0.09);
          this.blip('sine', 783.99, 783.99, 200, 0.12, 0.18);
        } else {
          this.blip('sine', 196, 147, 260, 0.09, 0);
        }
        break;

      case EV.NUKE:
        this.blip('sawtooth', 180, 40, 620, 0.16, 0);
        this.noise(620, 0.16, 5200, 200, 'lowpass');
        break;

      case EV.NO_GOLD:
      case EV.COOLDOWN:
        // 눌렀는데 안 나갔다. **짧고 낮게** — 실패도 피드백이다
        this.blip('square', 150, 110, 70, 0.06, 0);
        break;

      case EV.WATER_WARN:
        this.blip('sawtooth', 90, 150, 700, 0.12, 0);
        break;

      case EV.WATER_HIT:
        this.noise(200, 0.08, 400, 120, 'lowpass');
        break;

      case EV.DRAFT_OPEN:
        this.blip('sine', 392, 523.25, 220, 0.09, 0);
        break;

      case EV.DRAFT_PICK:
        this.blip('sine', 523.25, 784, 200, 0.12, 0);
        break;

      case EV.WIN:
        this.blip('sine', 523.25, 523.25, 130, 0.13, 0);
        this.blip('sine', 659.25, 659.25, 130, 0.13, 0.12);
        this.blip('sine', 783.99, 783.99, 130, 0.13, 0.24);
        this.blip('sine', 1046.5, 1046.5, 420, 0.14, 0.36);
        break;

      case EV.LOSE:
        this.noise(900, 0.2, 900, 70, 'lowpass');
        this.blip('sawtooth', 200, 50, 900, 0.12, 0);
        break;

      case EV.RESET:
        break;

      default:
        break;
    }
  }
}
