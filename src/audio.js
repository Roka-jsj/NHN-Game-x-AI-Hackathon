// 오디오 — 게임필의 나머지 절반.
//
// **오디오 파일이 0개다.** mp3·wav·ogg 하나도 없다. 전부 WebAudio 절차적 합성이다.
//   - 라이선스 문제 0. 외부 에셋 출처를 기재할 것이 없다
//   - 로딩 시간 0. 첫 로딩 2초에 오디오가 기여하는 바이트가 없다
//   - 지연 0. <audio> 태그는 재생 지연이 커서 타격감을 죽인다
//
// 소리는 기존 상태 전이에 **붙기만** 한다. 전이 타이밍을 바꾸지 않는다.
//
// 규칙 두 개가 이 파일의 구조를 전부 결정한다.
//   1. 루프 안에서 노드를 만들지 않는다 — 지속음(BGM·물·질주)은 unlock() 에서
//      한 번 만들고, 이후로는 파라미터만 만진다. 박자는 LFO 게이팅으로 만든다.
//   2. 단발 효과음(blip·nz)은 이벤트마다 만든다. 그건 매 프레임이 아니다.

import * as C from './config.js';
import { EV, S, SIDE_L } from './game.js';

const MASTER_CAP = 0.7;

// ─── 이벤트 코드 방어 ─────────────────────────────────────────
// game.js 를 다른 사람이 동시에 고치고 있다. 16~19 가 아직 없을 수 있다.
// 계약(spec-v2 §7)이 번호를 못 박아 뒀으므로 없으면 그 번호로 대신한다.
// 기존 0~15 와 절대 겹치지 않으므로 오작동하지 않는다.
const E_TOWER_FIRE  = EV.TOWER_FIRE  !== undefined ? EV.TOWER_FIRE  : 16;
const E_SKILL       = EV.SKILL       !== undefined ? EV.SKILL       : 17;
const E_TOWER_UP    = EV.TOWER_UP    !== undefined ? EV.TOWER_UP    : 18;
const E_COUNTER_HIT = EV.COUNTER_HIT !== undefined ? EV.COUNTER_HIT : 19;

// ─── 음정표 ──────────────────────────────────────────────────
// 반음 비율을 미리 굽는다. 루프 안에서 Math.pow 를 부르지 않기 위해서다.
// 인덱스 = 반음 + SEMI_ZERO.
const SEMI_ZERO = 24;
const SEMI = (() => {
  const a = new Float32Array(97);
  for (let i = 0; i < a.length; i++) a[i] = Math.pow(2, (i - SEMI_ZERO) / 12);
  return a;
})();
const TONIC = 82.41;                       // E2. 물에 잠기는 게임에 장조는 없다

// ─── 시대별 음색 ─────────────────────────────────────────────
// **시대는 음높이가 아니라 음색으로 구분된다.** 배음 구조와 필터가 바뀐다.
//   돌   거의 사인. 배음이 없다. 원시적이고 비어 있다
//   청동 삼각파. 부드러운 홀수 배음
//   강철 사각파가 섞인다. 금속성
//   화약 톱니. 배음이 꽉 찬다. 거칠다
//   기계 톱니+사각. 필터가 활짝 열려 산업적으로 날이 선다
//                     bass       harm       arp        pad         lead
const ERA_WAVE = [
  ['triangle', 'sine',     'sine',     'sine',     'sine'],
  ['triangle', 'triangle', 'triangle', 'triangle', 'triangle'],
  ['triangle', 'square',   'square',   'sawtooth', 'triangle'],
  ['sawtooth', 'square',   'square',   'sawtooth', 'sawtooth'],
  ['square',   'sawtooth', 'sawtooth', 'sawtooth', 'square'],
];
//                      bass  arp   pad   lead   (기본 컷오프 Hz)
const ERA_CUT = [
  [300,  760,  460, 1200],
  [380, 1050,  600, 1700],
  [500, 1450,  740, 2300],
  [660, 2050,  880, 3100],
  [880, 2900, 1080, 4100],
];
// 배음층 게인 — 시대가 오를수록 두꺼워진다
const ERA_HARM = [0.0, 0.045, 0.095, 0.155, 0.215];
// 조성 이동 — 음색과 **함께** 바뀐다. 이것만으로는 시대를 표현하지 않는다
const ERA_KEY = [0, 2, 3, 5, 7];

// ─── 화성 진행 ───────────────────────────────────────────────
// 근음의 반음 오프셋. 시대마다 진행이 다르다 — 시대가 오르면 곡이 바뀐다.
const PROG = [
  Int8Array.of(0, -4,  3, -2),   // 돌   i VI III VII — 자연단음계, 비어 있다
  Int8Array.of(0, -2, -4, -2),   // 청동 i VII VI VII
  Int8Array.of(0,  5, -4, -5),   // 강철 i iv VI V — 이끄는 힘이 생긴다
  Int8Array.of(0, -4,  3, -5),   // 화약 i VI III V
  Int8Array.of(0,  1,  0, -2),   // 기계 i bII i bVII — 프리기아. 기계적이고 차갑다
];
// **전선이 밀리면 화성이 어두워진다.** 프리기아 + 이끔음. 지고 있는 게 귀로 들린다.
const PROG_DARK = Int8Array.of(0, 1, -4, -5);

// 단5음계 (자연단음계 펜타토닉) 도수
const PENTA = Int8Array.of(0, 3, 5, 7, 10);
// 화음 구성음 도수
const CHORD = Int8Array.of(0, 3, 7, 10, 12);

// 선율 — 8분음표 8개(= 한 마디). -1 은 쉼표.
// 구간이 올라갈수록 음이 촘촘해진다. **같은 4마디만 반복하지 않는다.**
const MEL = [
  Int8Array.of( 0, -1,  2, -1,  1, -1,  0, -1),
  Int8Array.of( 0,  2,  1,  2,  3, -1,  2, -1),
  Int8Array.of( 4,  3,  2,  3,  1,  2,  0, -1),
  Int8Array.of( 4, -1,  3,  4,  2,  3,  1,  0),
  Int8Array.of( 4,  3,  4,  2,  3,  1,  2,  0),
];
// 8마디마다 한 번, 마지막 마디에 채움 악구가 들어간다
const MEL_FILL = Int8Array.of(4, 3, 4, 3, 2, 1, 2, 0);
const ARPP = Int8Array.of(0, 2, 4, 2, 1, 3, 4, 3);

// 구간별 층 게인 배수 — 판 안에서 곡이 자라야 한다.
// 도입을 35초로 뒀더니 판의 앞 3분의 1이 베이스만 남아 비었다.
// 24초로 당기고 도입에도 아르페지오를 옅게 남긴다 — 비는 것과 성기는 것은 다르다.
// 기지 체력이 780→1400 으로 오르며 판이 길어졌다. 구간을 다섯으로 늘려
// 3분을 넘겨도 곡이 평평해지지 않게 한다.
//   0 도입  1 전개  2 절정  3 종반  4 최종
const SEC_AT = [24, 64, 112, 168];
const S_ARP  = [0.30, 0.70, 0.95, 1.00, 1.00];
const S_LEAD = [0.00, 0.30, 0.85, 1.00, 1.00];
const S_HARM = [0.10, 0.40, 0.85, 1.00, 1.00];
const S_PERC = [0.40, 0.68, 0.88, 1.00, 1.00];

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

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
  // 층은 아홉이다. **음악이 곧 상태 표시가 된다** — 눈으로 보기 전에 귀로 안다.
  //   bass  항상. 템포가 전장 밀도를 따라간다
  //   harm  배음층. **시대가 오를수록 열린다** (돌 0 → 기계 최대)
  //   arp   화음 분산. 구간 1부터, 전선을 밀수록 두꺼워진다
  //   pad   긴장 패드. 물이 가까워지면 열린다 (불협 5도)
  //   lead  선율. 구간 2부터. 이기고 있으면 확실히 열린다
  //   sub   초저역. **물이 가까우면 층이 늘어난다**
  //   hat   하이햇. 구간이 오르면 8분 → 16분
  //   ind   산업 타악. 화약·기계 시대와 포탑에서 열린다
  //   sonar 물속 링잉. 물이 가까울 때만
  buildMusic() {
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);
    const outs = [];

    // 음정층 — osc → 게이트(LFO) → 로우패스 → 출력
    const layer = (type, freq, cut, lfoHz) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const lfo = ctx.createOscillator();     // 박자를 만드는 저주파
      lfo.type = 'square';
      lfo.frequency.value = lfoHz;
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
      outs.push(out);
      return { osc, lfo, out, lp };
    };

    // 타악층 — 노이즈를 밴드패스로 좁혀 LFO 로 여닫으면 타악기가 된다.
    // 드럼 샘플이 없어도 박자가 몸으로 느껴진다.
    const perc = (freq, q, lfoHz, type) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = type || 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
      const lfo = ctx.createOscillator();
      lfo.type = 'square'; lfo.frequency.value = lfoHz;
      const amp = ctx.createGain(); amp.gain.value = 0.5;
      const gate = ctx.createGain(); gate.gain.value = 0.5;
      lfo.connect(amp); amp.connect(gate.gain);
      const out = ctx.createGain(); out.gain.value = 0;
      src.connect(bp); bp.connect(gate); gate.connect(out); out.connect(bus);
      src.start(0); lfo.start(0);
      outs.push(out);
      return { out, lfo, bp };
    };

    this.bgm = {
      bus, outs,
      bass:  layer('triangle', TONIC,     400, 2),
      harm:  layer('sine',     TONIC * 2, 900, 2),
      arp:   layer('sine',     TONIC * 4, 1600, 8),
      pad:   layer('sine',     TONIC * 3, 700, 0.5),
      lead:  layer('sine',     TONIC * 6, 2400, 6),
      sub:   layer('sine',     TONIC * 0.5, 160, 1),
      hat:   perc(7200, 1.4, 8),
      ind:   perc(190, 2.2, 4),
      sonar: perc(1350, 12, 0.45),

      era: -1,          // -1 이면 다음 update 에서 음색을 굽는다
      prog: PROG[0],
      key: 0,
      bar: 0,           // 0..3 진행 위치
      barCount: 0,      // 8마디 악구 판정용
      note: 0,          // 0..7 8분음표 위치
      noteAt: 0,
      root: TONIC,
      sec: 0,
    };
  }

  // 시대가 바뀔 때만 부른다. **매 프레임이 아니다.**
  // osc.type 대입은 노드 생성이 아니라 속성 대입이다 — 할당이 없다.
  applyEraTimbre(era) {
    const m = this.bgm;
    const w = ERA_WAVE[era];
    m.bass.osc.type = w[0];
    m.harm.osc.type = w[1];
    m.arp.osc.type  = w[2];
    m.pad.osc.type  = w[3];
    m.lead.osc.type = w[4];
    m.prog = PROG[era];
    m.key = ERA_KEY[era];
    m.era = era;
  }

  // 음악 층을 상태에 맞춘다. 매 프레임 불리지만 **노드를 만들지 않는다.**
  updateMusic(game, t) {
    const m = this.bgm;
    if (!m) return;
    const dead = game.state === S.OVER;
    const draft = game.state === S.DRAFT;

    const era = clamp(game.era | 0, 0, ERA_WAVE.length - 1);
    if (era !== m.era) this.applyEraTimbre(era);

    const front = game.frontline();
    const near = game.waterNear();
    const spd = Math.min(1, (game.aliveL + game.aliveR) / 16);
    const el = game.elapsed ? game.elapsed() : 0;
    const towerLv = game.towerLv | 0;

    // 곡 전개 — 판이 2~3분이다. 그 안에서 도입·전개·절정·종반이 지나가야 한다.
    const sec = el < SEC_AT[0] ? 0 : (el < SEC_AT[1] ? 1
              : (el < SEC_AT[2] ? 2 : (el < SEC_AT[3] ? 3 : 4)));
    m.sec = sec;

    // **전선이 밀리면 화성이 어두워진다.** 0 = 밀고 있다, 1 = 밀리고 있다.
    const dark = clamp((0.5 - front) * 2.6, 0, 1);

    // 전체 볼륨 — 죽으면 내리고, 드래프트에서는 반쯤 낮춰 생각할 여지를 준다
    m.bus.gain.setTargetAtTime(dead ? 0 : (draft ? 0.10 : 0.20), t, 0.25);

    // 템포는 전장의 밀도를 따라간다. 판이 커지는 것이 귀로 먼저 들린다.
    // 구간이 오르면 기본 템포도 조금 올라간다 — 곡이 조여든다.
    const beat = 2.1 + 2.1 * spd + 0.18 * sec;
    const cut = ERA_CUT[era];

    // ── 박자 클록 ──
    // 노드를 만들지 않고 8분음표를 센다. 마디·악구가 여기서 흐른다.
    const nlen = 0.5 / beat;
    if (t - m.noteAt > nlen) {
      // 탭 복귀 등으로 크게 벌어지면 누산하지 않고 지금으로 맞춘다
      if (t - m.noteAt > 1.2) m.noteAt = t; else m.noteAt += nlen;
      m.note++;
      if (m.note > 7) {
        m.note = 0;
        m.bar = (m.bar + 1) & 3;
        m.barCount++;
        // 마디가 바뀔 때만 진행표를 다시 고른다 — 마디 중간에 조가 튀지 않는다
        m.prog = dark > 0.55 ? PROG_DARK : PROG[m.era];
        m.root = TONIC * SEMI[SEMI_ZERO + m.key + m.prog[m.bar]];
        m.bass.osc.frequency.setValueAtTime(m.root * (era >= 2 ? 2 : 1), t);
        m.harm.osc.frequency.setValueAtTime(m.root * (era >= 2 ? 4 : 2), t);
        m.sub.osc.frequency.setValueAtTime(m.root * 0.5, t);
      }
      const n = m.note;
      const fill = (m.barCount & 7) === 7;

      // 아르페지오 — 화음 구성음을 훑는다
      const ct = CHORD[ARPP[n]];
      m.arp.osc.frequency.setValueAtTime(
        m.root * SEMI[SEMI_ZERO + ct] * 4, t);

      // 리드 — 실제 선율이다. 드론이 아니다.
      // 아르페지오보다 한 옥타브 위에 둔다. 같은 옥타브에 겹치면 둘 다 안 들린다.
      // 8마디 악구가 번갈아 한 단계 촘촘한 줄을 쓴다 — 16마디 주기가 생겨
      // 같은 구간에 오래 머물러도 선율이 굳지 않는다.
      const alt = ((m.barCount >> 3) & 1) ? Math.min(sec + 1, MEL.length - 1) : sec;
      const row = fill ? MEL_FILL : MEL[alt];
      const d = row[n];
      if (d >= 0) {
        m.lead.osc.frequency.setValueAtTime(
          m.root * SEMI[SEMI_ZERO + PENTA[d]] * 8, t);
      }
    }

    const root = m.root;
    // 8마디마다 마지막 한 마디는 채움 악구다. 같은 4마디만 도는 것을 끊는다.
    const fillBar = (m.barCount & 7) === 7;

    m.bass.lfo.frequency.setTargetAtTime(beat, t, 0.3);
    m.harm.lfo.frequency.setTargetAtTime(beat * 2, t, 0.3);
    m.arp.lfo.frequency.setTargetAtTime(beat * 4, t, 0.3);
    m.lead.lfo.frequency.setTargetAtTime(beat * 2, t, 0.3);
    m.sub.lfo.frequency.setTargetAtTime(beat * 0.5, t, 0.4);

    // 층 bass — 항상. 어두워지면 필터가 닫혀 답답해진다
    m.bass.out.gain.setTargetAtTime(dead ? 0 : 0.165, t, 0.2);
    m.bass.lp.frequency.setTargetAtTime(cut[0] * (1 - 0.35 * dark), t, 0.4);

    // 층 harm — **시대의 배음.** 돌 시대에는 아예 없다
    m.harm.out.gain.setTargetAtTime(
      dead ? 0 : ERA_HARM[era] * S_HARM[sec], t, 0.35);
    m.harm.lp.frequency.setTargetAtTime(cut[1] * 0.8, t, 0.4);

    // 하이햇 — 구간이 오르면 8분에서 16분으로 잘게 쪼개진다
    m.hat.lfo.frequency.setTargetAtTime(beat * (sec >= 2 ? 4 : 2) * (fillBar ? 2 : 1), t, 0.3);
    m.hat.out.gain.setTargetAtTime(
      dead || draft ? 0 : (0.010 + 0.026 * spd) * S_PERC[sec], t, 0.3);

    // 산업 타악 — 화약·기계 시대와 포탑에서 열린다. 판이 기계화되는 소리다
    m.ind.lfo.frequency.setTargetAtTime(beat * (fillBar ? 2 : 1), t, 0.3);
    const indOn = (era >= 3 ? 0.045 : 0) + (era >= 4 ? 0.030 : 0) + 0.012 * towerLv;
    m.ind.out.gain.setTargetAtTime(dead || draft ? 0 : indOn * S_PERC[sec], t, 0.4);

    // 층 arp — 전선을 밀수록 열린다. 이기고 있으면 음악이 두꺼워진다
    const tier = clamp(Math.round(front * 4), 0, 4);
    m.arp.out.gain.setTargetAtTime(dead ? 0 : 0.026 * tier * S_ARP[sec], t, 0.25);
    m.arp.lp.frequency.setTargetAtTime(
      (cut[1] * 0.55 + cut[1] * 0.12 * tier) * (1 - 0.3 * dark), t, 0.3);

    // 층 pad — 물이 가까워지면 불협 5도가 깔린다. 시각 경고보다 먼저 느껴져야 한다
    m.pad.out.gain.setTargetAtTime(dead ? 0 : (near * near * 0.12 + dark * 0.04), t, 0.2);
    // 5도 위 — 물이 가깝거나 밀리고 있으면 살짝 어긋나 맥놀이가 생긴다
    m.pad.osc.frequency.setTargetAtTime(
      root * 3 * (1 - 0.030 * near - 0.018 * dark), t, 0.3);
    m.pad.lp.frequency.setTargetAtTime(cut[2], t, 0.4);

    // 층 sub — **물이 가까우면 층이 늘어난다.** 발밑이 무거워진다
    m.sub.out.gain.setTargetAtTime(
      dead || draft ? 0 : (0.02 + 0.10 * near * near) * (0.4 + 0.6 * S_PERC[sec]), t, 0.3);

    // 층 sonar — 물속 링잉. 물이 가까울 때만 들린다
    m.sonar.lfo.frequency.setTargetAtTime(0.35 + 0.5 * near, t, 0.5);
    m.sonar.out.gain.setTargetAtTime(dead ? 0 : near * near * near * 0.055, t, 0.4);

    // 층 lead — 선율. 구간 2부터 본격적으로, 이기고 있으면 확실히 열린다
    const winning = front > 0.62;
    const leadG = (dead || draft) ? 0
      : (0.024 + (winning ? 0.036 : 0) + (era >= 3 ? 0.010 : 0)) * S_LEAD[sec] * (fillBar ? 1.35 : 1);
    m.lead.out.gain.setTargetAtTime(leadG, t, 0.15);
    m.lead.lp.frequency.setTargetAtTime(cut[3] * (1 - 0.3 * dark), t, 0.3);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : MASTER_CAP;
  }

  // 탭이 숨겨질 때. 배경에서 계속 울리면 안 된다.
  // **새로 만든 층도 반드시 여기에 걸린다** — outs 배열로 전부 훑는다.
  hush() {
    if (!this.ready || this.failed) return;
    const t = this.ctx.currentTime;
    this.runGain.gain.setTargetAtTime(0, t, 0.02);
    this.waterGain.gain.setTargetAtTime(0, t, 0.02);
    if (this.bgm) {
      this.bgm.bus.gain.setTargetAtTime(0, t, 0.02);
      const o = this.bgm.outs;
      for (let i = 0; i < o.length; i++) o[i].gain.setTargetAtTime(0, t, 0.02);
    }
  }

  // 같은 소리를 연속 재생할 때 ±3% 피치 변화. 안 하면 기계처럼 들린다.
  // 이건 연출이라 난수를 써도 된다 — 판정과 무관하다.
  vary(f) { return f * (1 + (Math.random() * 2 - 1) * 0.03); }

  // 일회용 오실레이터. ended 에서 disconnect 해 노드가 쌓이지 않게 한다.
  // cut 을 주면 로우패스를 한 장 물린다 — 같은 파형도 다른 악기가 된다.
  blip(type, f0, f1, ms, gain, delay, cut) {
    if (!this.ready || this.failed) return;
    const t = this.ctx.currentTime + (delay || 0);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(this.vary(f0), t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, this.vary(f1)), t + ms / 1000);
    g.gain.setValueAtTime(Math.max(0.0002, gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    if (cut) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(cut, t);
      o.connect(g); g.connect(f); f.connect(this.master);
      o.onended = () => { o.disconnect(); g.disconnect(); f.disconnect(); };
    } else {
      o.connect(g); g.connect(this.master);
      o.onended = () => { o.disconnect(); g.disconnect(); };
    }
    o.start(t);
    o.stop(t + ms / 1000 + 0.01);
  }

  // 노이즈 단발. delay·Q 까지 받는다 — 이게 타격음의 절반을 만든다.
  nz(ms, gain, cutFrom, cutTo, type, delay, q) {
    if (!this.ready || this.failed) return;
    const dur = Math.min(ms, 1900) / 1000;   // 노이즈 버퍼가 2초다
    const t = this.ctx.currentTime + (delay || 0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type || 'lowpass';
    if (q) f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(20, cutFrom), t);
    if (cutTo !== cutFrom) f.frequency.exponentialRampToValueAtTime(Math.max(20, cutTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
    src.start(t);
    src.stop(t + dur);
  }

  // 예전 이름 유지 — 지연 없는 노이즈
  noise(ms, gain, cutFrom, cutTo, type) {
    this.nz(ms, gain, cutFrom, cutTo, type, 0, 0);
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

  // ── 유닛 6종 소환음 ─────────────────────────────────────────
  // **귀로 구분돼야 한다.** 무거운 유닛은 낮고 길게, 빠른 유닛은 높고 짧게.
  //   검사   짧고 밝은 금속 스침       — 가장 가볍다
  //   창병   나무 자루가 땅을 찍는 '툭'
  //   궁수   활시위. 아주 짧고 높은 바람소리
  //   기병   말발굽 3연타. **리듬으로 구분된다**
  //   거인   낮고 긴 발구름
  //   투석기 삐걱이는 도르래 + 낮은 쿵. 가장 길다
  spawnVoice(kind, side, era) {
    const k = (kind >= 0 && kind < 6) ? kind : 0;
    const p = side === SIDE_L ? 1 : 0.74;   // 진영은 여전히 음높이로 갈린다
    const v = side === SIDE_L ? 1 : 0.85;   // 적 소환은 조금 작게 — 내 것이 앞에 온다
    const e = clamp(era | 0, 0, 4);
    const br = 1 + 0.10 * e;                // 시대가 오르면 밝아진다

    switch (k) {
      case 0:  // 검사 — 가볍고 짧다
        this.blip('square', 520 * p, 700 * p, 70, 0.060 * v, 0, 3000 * br);
        this.nz(45, 0.045 * v, 4200 * br, 2200, 'bandpass', 0, 3);
        break;

      case 1:  // 창병 — 중간 무게. 나무 '툭'
        this.blip('triangle', 300 * p, 386 * p, 115, 0.070 * v, 0, 1800 * br);
        this.nz(70, 0.048 * v, 900, 400, 'lowpass', 0, 0);
        break;

      case 2:  // 궁수 — 가장 높고 가장 짧다. 활시위
        this.nz(55, 0.065 * v, 6000 * br, 1500, 'bandpass', 0, 2);
        this.blip('sine', 1000 * p, 1520 * p, 55, 0.042 * v, 0.01);
        break;

      case 3:  // 기병 — 3연타. 다른 다섯과 리듬으로 갈린다
        this.blip('triangle', 236 * p, 300 * p, 45, 0.050 * v, 0);
        this.blip('triangle', 252 * p, 320 * p, 45, 0.050 * v, 0.055);
        this.blip('triangle', 268 * p, 350 * p, 70, 0.058 * v, 0.110);
        this.nz(70, 0.040 * v, 2600, 800, 'bandpass', 0.02, 1.2);
        break;

      case 4:  // 거인 — 낮고 길다
        this.blip('sine', 96 * p, 58 * p, 420, 0.105 * v, 0);
        this.blip('triangle', 192 * p, 116 * p, 300, 0.038 * v, 0, 700 * br);
        this.nz(280, 0.085 * v, 500, 110, 'lowpass', 0, 0);
        break;

      default: // 5 투석기 — 가장 길다. 도르래가 감기고 나무가 삐걱인다
        this.blip('sawtooth', 78 * p, 50 * p, 520, 0.095 * v, 0, 700 * br);
        this.nz(30, 0.045 * v, 3000, 1800, 'bandpass', 0.00, 4);
        this.nz(30, 0.045 * v, 3000, 1800, 'bandpass', 0.09, 4);
        this.nz(30, 0.045 * v, 3000, 1800, 'bandpass', 0.18, 4);
        this.nz(240, 0.070 * v, 320, 90, 'lowpass', 0.26, 0);
        break;
    }
    // 기계 시대의 금속 광택 — 같은 유닛도 시대가 오르면 다르게 들린다
    if (e >= 3) this.blip('square', 1250 * p, 940 * p, 40, 0.014 * e * v, 0.02, 6000);
  }

  // ── 시대 진화 5단계 ─────────────────────────────────────────
  // 음높이만 올리지 않는다. 파형과 배음 구조가 통째로 바뀐다.
  eraVoice(era) {
    const e = clamp(era | 0, 1, 4);
    if (e === 1) {          // 청동 — 순한 사인 3화음. 아직 부드럽다
      this.blip('sine', 523.25, 523.25, 120, 0.10, 0);
      this.blip('sine', 659.25, 659.25, 120, 0.10, 0.09);
      this.blip('sine', 783.99, 783.99, 240, 0.11, 0.18);
    } else if (e === 2) {   // 강철 — 삼각파 + 금속 링. 단단해진다
      this.blip('triangle', 587.33, 587.33, 130, 0.10, 0);
      this.blip('triangle', 739.99, 739.99, 130, 0.10, 0.08);
      this.blip('triangle', 880.00, 880.00, 300, 0.11, 0.16);
      this.nz(320, 0.055, 3400, 2600, 'bandpass', 0.16, 14);
    } else if (e === 3) {   // 화약 — 톱니 팡파르 + 폭발. 시대 이름이 그대로 들린다
      this.nz(90, 0.16, 900, 4000, 'lowpass', 0);
      this.nz(520, 0.15, 2600, 120, 'lowpass', 0.06);
      this.blip('sawtooth', 130, 44, 500, 0.13, 0.05, 900);
      this.blip('sawtooth', 392, 392, 150, 0.085, 0.20, 2200);
      this.blip('sawtooth', 587.33, 587.33, 150, 0.085, 0.30, 2600);
      this.blip('sawtooth', 783.99, 783.99, 340, 0.095, 0.40, 3200);
    } else {                // 기계 — 사각파 급속 아르페지오 + 래칫. 차갑다
      const seq = [523.25, 698.46, 880, 1046.5, 1396.9, 1760];
      for (let i = 0; i < seq.length; i++) {
        this.blip('square', seq[i], seq[i], 90, 0.070, i * 0.055, 5200);
        this.nz(26, 0.030, 5000, 3200, 'bandpass', i * 0.055, 8);
      }
      this.blip('square', 130.81, 130.81, 420, 0.090, 0.33, 1200);
      this.nz(360, 0.060, 260, 80, 'lowpass', 0.33, 0);
    }
  }

  // ── 스킬 3종 — 셋이 완전히 달라야 한다 ──────────────────────
  // 적이 쓰면 낮고 둔하게 들린다. 누가 썼는지 화면을 안 봐도 안다.
  skillVoice(idx, side) {
    const p = side === SIDE_L ? 1 : 0.78;
    const v = side === SIDE_L ? 1 : 0.80;
    if (idx === C.SK_VOLLEY) {
      // 화살비 — 위에서 쏟아진다. 높은 휘파람 여러 개 + 빗소리 + 착탄
      for (let i = 0; i < 6; i++) {
        this.blip('sine', (1900 - i * 110) * p, (460 - i * 20) * p, 190, 0.042 * v, i * 0.055);
      }
      this.nz(760, 0.085 * v, 7200 * p, 1100, 'bandpass', 0.04, 0.8);
      this.nz(240, 0.075 * v, 1600, 260, 'lowpass', 0.42, 0);
      this.blip('triangle', 300 * p, 120 * p, 220, 0.055 * v, 0.42, 1400);
    } else if (idx === C.SK_RALLY) {
      // 증원 — 뿔피리. **음정이 있다.** 셋 중 유일하게 화성으로 들린다
      this.nz(180, 0.075 * v, 480, 130, 'lowpass', 0, 0);       // 북
      this.blip('sawtooth', 196.00 * p, 196.00 * p, 280, 0.080 * v, 0.00, 900);
      this.blip('sawtooth', 197.6 * p,  197.6 * p,  280, 0.055 * v, 0.00, 900);  // 살짝 어긋나 두꺼워진다
      this.blip('sawtooth', 261.63 * p, 261.63 * p, 300, 0.080 * v, 0.17, 1000);
      this.blip('sawtooth', 263.6 * p,  263.6 * p,  300, 0.055 * v, 0.17, 1000);
      this.nz(180, 0.070 * v, 480, 130, 'lowpass', 0.34, 0);
      this.blip('sawtooth', 392.00 * p, 392.00 * p, 420, 0.085 * v, 0.34, 1300);
      this.blip('sawtooth', 394.9 * p,  394.9 * p,  420, 0.060 * v, 0.34, 1300);
    } else {
      // 해일 — 물이 차올랐다가 무너진다. 음정이 거의 없다. 전부 필터 스윕이다
      this.nz(900, 0.150 * v, 110, 1700 * p, 'lowpass', 0, 0);  // 차오름
      this.blip('sawtooth', 220 * p, 38, 900, 0.120 * v, 0, 600);
      this.nz(760, 0.145 * v, 1000, 90, 'lowpass', 0.86, 0);    // 무너짐
      this.blip('sine', 62 * p, 38, 720, 0.100 * v, 0.86);
    }
  }

  // ── 상태 전이에 붙는다. 전이 타이밍을 바꾸지 않는다 ──────────
  onEvent(type, a, b, game) {
    if (this.failed) return;
    switch (type) {
      case EV.SPAWN: {
        // a = 종류, b = 진영. 여섯 종류가 서로 다른 악기다
        const era = game ? (b === SIDE_L ? (game.era | 0) : (game.aiEra | 0)) : 0;
        this.spawnVoice(a, b, era);
        break;
      }

      case EV.ATTACK:
        // 매 공격마다 난다. 아주 짧고 작아야 한다 — 안 그러면 귀가 아프다
        this.noise(28, 0.035, 2600, 1400, 'bandpass');
        break;

      case E_COUNTER_HIT: {
        // **상성 우위.** 일반 타격(28ms 노이즈 한 장)과 확실히 달라야 한다.
        // 날카로운 파열 + 급강하 + 짧은 울림 + 배를 치는 서브. "제대로 먹혔다".
        // b = 때린 진영. 내가 먹였으면 밝게 울리고, 내가 맞았으면 낮고 둔탁하다.
        const mine = b === SIDE_L;
        const p = mine ? 1 : 0.62;
        const v = mine ? 1 : 0.8;
        this.nz(95, 0.125 * v, 5400 * p, 800, 'bandpass', 0, 1.6);
        this.blip('square', 1150 * p, 260 * p, 95, 0.095 * v, 0);
        // 울림은 내가 먹였을 때만. 이게 "제대로 먹혔다"의 정체다
        if (mine) this.blip('sine', 1318.5, 1318.5, 230, 0.050, 0.03);
        this.blip('sine', 92, 58, 170, 0.085 * v, 0);
        this.nz(170, 0.045 * v, 900, 200, 'lowpass', 0.05, 0);
        break;
      }

      case EV.KILL:
        this.blip('square', 240, 90, 130, 0.11, 0);
        this.noise(150, 0.09, 1400, 260, 'lowpass');
        break;

      case EV.BASE_HIT:
        this.blip('sine', 130, 70, 120, 0.13, 0);
        break;

      case EV.ERA_UP:
        if (b === SIDE_L) this.eraVoice(a);
        else {
          // 적의 진화는 아래로 떨어진다. 좋은 소식이 아니다
          this.blip('sine', 196, 147, 260, 0.085, 0);
          this.blip('triangle', 98, 74, 320, 0.060, 0.06, 700);
        }
        break;

      case E_TOWER_FIRE:
        // a = 포탑 단계(1 또는 2). 1단계는 쇠뇌, 2단계는 대포다
        if ((a | 0) >= 2) {
          this.blip('sawtooth', 360, 58, 175, 0.095, 0, 1200);
          this.nz(210, 0.100, 2200, 170, 'lowpass', 0, 0);
          this.blip('sine', 120, 48, 230, 0.055, 0.02);
        } else {
          this.blip('square', 700, 180, 80, 0.070, 0, 2600);
          this.nz(70, 0.065, 3200, 700, 'bandpass', 0, 1.2);
        }
        break;

      case E_TOWER_UP:
        // 쇠가 물려 들어가는 소리. 진화(사인 화음)와 헷갈리면 안 된다
        this.nz(40, 0.060, 2000, 3200, 'bandpass', 0.00, 5);
        this.nz(40, 0.060, 2000, 3200, 'bandpass', 0.07, 5);
        this.nz(40, 0.065, 2000, 3200, 'bandpass', 0.14, 5);
        this.blip('square', 300, 620, 200, 0.075, 0.14, 2400);
        this.blip('sine', 84, 58, 280, 0.090, 0.21);
        this.nz(260, 0.070, 400, 100, 'lowpass', 0.21, 0);
        break;

      case E_SKILL:
        this.skillVoice(a | 0, b);
        break;

      // EV.NUKE 는 **일부러 듣지 않는다.**
      // 해일이 EV.SKILL(a=0) 과 EV.NUKE 를 둘 다 낸다 — feel.js 가 아직
      // NUKE 로 배너·셰이크를 내야 해서다. 둘 다 들으면 해일에만 소리가
      // 두 번 겹친다. 스킬 셋은 E_SKILL 한 곳에서만 다룬다.

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
        // 곡을 처음부터 다시 전개시킨다. 노드는 그대로 둔다
        if (this.bgm) {
          const m = this.bgm;
          m.bar = 0; m.barCount = 0; m.note = 0; m.sec = 0;
          m.noteAt = this.ctx ? this.ctx.currentTime : 0;
          m.era = -1;                 // 다음 update 에서 음색을 다시 굽는다
        }
        break;

      default:
        break;
    }
  }
}
