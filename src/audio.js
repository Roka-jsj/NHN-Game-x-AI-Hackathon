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
// game.js 에 16~19 가 들어왔지만 이 우회로는 남겨 둔다.
// 계약(spec-v2 §7)이 번호를 못 박아 뒀고, 기존 0~15 와 겹칠 수 없으므로
// game.js 가 잠깐 되돌아가도 오디오는 터지지 않고 default 로 빠진다.
const E_TOWER_FIRE  = EV.TOWER_FIRE  !== undefined ? EV.TOWER_FIRE  : 16;
const E_SKILL       = EV.SKILL       !== undefined ? EV.SKILL       : 17;
const E_TOWER_UP    = EV.TOWER_UP    !== undefined ? EV.TOWER_UP    : 18;
const E_COUNTER_HIT = EV.COUNTER_HIT !== undefined ? EV.COUNTER_HIT : 19;
// v3 원정. game.js 가 아직 이 이벤트를 안 낼 수 있다 — 안 오면 사령관 층은
// 게인 0 으로 남고 곡은 v2 와 **완전히 똑같이** 들린다. 예외는 나지 않는다.
const E_STAGE_START  = EV.STAGE_START  !== undefined ? EV.STAGE_START  : 20;
const E_STAGE_CLEAR  = EV.STAGE_CLEAR  !== undefined ? EV.STAGE_CLEAR  : 21;
const E_TAUNT        = EV.TAUNT        !== undefined ? EV.TAUNT        : 22;
const E_CAMPAIGN_END = EV.CAMPAIGN_END !== undefined ? EV.CAMPAIGN_END : 23;
const E_SKILL_UP     = EV.SKILL_UP     !== undefined ? EV.SKILL_UP     : 24;

// 스킬 번호. config 가 아직 총진군을 모를 수도 있다 — 없으면 3 으로 둔다.
const SK_TIDE   = (typeof C.SK_TIDE   === 'number') ? C.SK_TIDE   : 0;
const SK_VOLLEY = (typeof C.SK_VOLLEY === 'number') ? C.SK_VOLLEY : 1;
const SK_RALLY  = (typeof C.SK_RALLY  === 'number') ? C.SK_RALLY  : 2;
const SK_SURGE  = (typeof C.SK_SURGE  === 'number') ? C.SK_SURGE  : 3;

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
// 시대 진화 팡파르. 이벤트마다 배열을 새로 만들지 않는다
const ERA1_SEQ = Float32Array.of(523.25, 659.25, 783.99);
const ERA2_SEQ = Float32Array.of(587.33, 739.99, 880.00, 1174.7);
const ERA3_SEQ = Float32Array.of(392.00, 587.33, 783.99, 1174.7);
const ERA4_SEQ = Float32Array.of(523.25, 698.46, 880, 1046.5, 1396.9, 1760);
// 화살비의 착탄. **불규칙해야 "비"로 들린다** — 등간격이면 기계음이다
const VOLLEY_HIT = Float32Array.of(0.44, 0.487, 0.516, 0.567, 0.601, 0.658, 0.702, 0.778);
// 증원의 북. 간격이 줄어든다 = 모여드는 소리
const RALLY_DRUM = Float32Array.of(0, 0.235, 0.415, 0.545, 0.635, 0.695);
// 증원의 뿔피리. **올라간다.** 넷 중 유일하게 음정으로 해결되는 스킬이다
const RALLY_HORN = Float32Array.of(196.00, 261.63, 392.00, 523.25);
// 스킬 등급이 오를 때의 종. 스킬마다 다른 음이다
const SKILLUP_SEMI = Int8Array.of(0, 3, 7, 10);
// 거울의 등장 악구. 같은 줄을 두 번 쓴다 — 두 번째가 어긋난 복사본이다
const MIRROR_SEQ = Int8Array.of(0, 7, 3, 10);
// 원정 완주. E3 → G#4(장3도) → E5. **이 게임에서 장조는 여기 한 번뿐이다**
const CAMP_WIN_SEQ = Float32Array.of(164.81, 246.94, 329.63, 415.30, 493.88, 659.25);

// 상성 타격이 초당 몇 번씩 터지면 소리가 기관총이 된다.
// 이 간격 안에 겹치면 짧은 판(版)으로 대체한다 — 타격감은 남기고 비용만 줄인다.
const COUNTER_DENSE = 0.085;

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

// ─── 사령관 5인 테마 ─────────────────────────────────────────
// **기존 9층과 싸우면 안 된다.** 시대가 이미 음색(파형·컷오프·배음)을 갖고 있고
// 구간이 층 게인을, 전선이 선법을 갖고 있다. 그래서 사령관은 **남은 축**만 쓴다:
//   음정(근음 위 어느 음을 고집하는가) · 음역(옥타브 배수) · 리듬 밀도(박 대비 맥동)
//   포락선 모양(게이트 LFO 파형 — 사각=단절, 톱니=타격, 사인=호흡)
// 이 넷이 성격이다. 음량과 템포는 **구분에 쓰지 않는다** — 그건 구분이 아니다.
//
//   0 무리(물량형) 끊임없이 밀려온다 — 쉼이 없다. 촘촘한 16분 + 디튠된 그림자
//                  성부가 맥놀이를 만들어 "여럿"으로 들린다. b7 로 열려 비어 있다
//   1 쇄도(돌격형) 급하고 앞으로 쏠린다 — 삼연음 갤럽, 높은 음역, **증4도(트라이톤)**.
//                  해결되지 않아 계속 앞으로 밀린다. 게이트는 톱니(타격 후 감쇠)
//   2 금고(축재형) 참았다가 터진다 — 9초 주기로 필터가 완전히 닫혔다가 열린다.
//                  터질 때만 들린다. 그 사이는 거의 무음이다
//   3 성벽(농성형) 움직이지 않는다 — 근음+12도 오르간 포인트(1:3 이라 완전히 융합한다).
//                  맥동이 거의 없고(박×0.03) 음역이 가장 낮다. 리듬이 아니라 **벽**이다
//   4 거울(균형형) 마지막 사령관. **플레이어를 읽고 따라온다** — 음정을 스스로 고르지
//                  않고 플레이어 선율(lead)을 반 박자 늦게 되받는다. 음색도 플레이어의
//                  시대 파형을 그대로 쓴다. 도발이 쌓일수록 더 바짝 따라붙는다
const CMD_N     = 5;
// 저역에서는 **음정 선택이 곧 거칠기**다. 성벽을 5도(62·82Hz)로 뒀더니 두 음의
// 합성 주기가 20.7Hz 로 잡혀 "움직이지 않는" 사령관에서 20Hz 떨림이 측정됐다.
// 근음+12도(41·123Hz = 1:3)로 바꾸면 완전히 융합해 맥동이 0 이 된다.
const CMD_INT   = Int8Array.of(10,  6,  3,  0,  0);       // 근음 위 반음 (거울은 미사용)
const CMD_INT2  = Int8Array.of( 3, 11, 15, 19,  0);       // 그림자 성부
const CMD_OCT   = Float32Array.of(2, 6, 1, 0.5, 4);       // 음역 배수 — 다섯이 겹치지 않는다
const CMD_RATE  = Float32Array.of(4, 3, 0.5, 0.03, 2);    // 박 대비 맥동 배수 = 리듬 밀도
const CMD_WAVE  = ['sawtooth', 'square',   'triangle', 'sine',     'triangle'];
const CMD_WAVE2 = ['sawtooth', 'triangle', 'sine',     'triangle', 'sine'];
const CMD_LFO   = ['square',   'sawtooth', 'sawtooth', 'sine',     'triangle'];
const CMD_LAMP  = Float32Array.of(0.50, -0.50, -0.50, 0.30, 0.42); // 음수 = 타격 후 감쇠
const CMD_DET   = Float32Array.of(19, 5, 0, 3, 0);        // 그림자 디튠(cent) — 무리만 크게
const CMD_CUT   = Float32Array.of(900, 3000, 560, 210, 1800);
const CMD_SWW   = ['sine', 'sawtooth', 'sawtooth', 'sine', 'triangle'];
const CMD_SWR   = Float32Array.of(0.50, 1.10, 0.108, 0.055, 0.35); // 스웰 Hz
// 무리는 **쉬지 않는다** = 스웰이 거의 평평해야 한다. 쇄도는 매번 앞으로 쏠린다.
// 처음엔 0.30/-0.55 로 뒀는데 변조깊이가 0.642/0.634 로 붙어 둘이 안 갈렸다.
const CMD_SWD   = Float32Array.of(0.12, -0.75, -1.00, 0.16, -0.50); // 음수 = 터지고 잦아든다
const CMD_SWC   = Float32Array.of(120, -700, -1500, 40, -500);      // 스웰 → 컷오프(Hz)
const CMD_PFRQ  = Float32Array.of(260, 1800, 92, 120, 900);        // 타악 밴드
const CMD_PQ    = Float32Array.of(1.4, 3.2, 0.8, 6.0, 2.0);
const CMD_PRATE = Float32Array.of(4, 3, 0.25, 0.125, 2);
const CMD_PLFO  = ['square', 'sawtooth', 'sawtooth', 'sine', 'square'];
const CMD_PAMP  = Float32Array.of(0.50, -0.50, -0.50, 0.45, 0.50);
const CMD_PGAIN = Float32Array.of(0.070, 0.048, 0.042, 0.030, 0.040);
const CMD_GAIN  = Float32Array.of(0.042, 0.040, 0.052, 0.046, 0.038);

// 상수가 아직 안 들어왔을 수도 있다. 이 저장소의 방어 패턴을 그대로 쓴다.
const CAMPAIGN_LEN = (typeof C.CAMPAIGN_LEN === 'number' && C.CAMPAIGN_LEN > 0) ? C.CAMPAIGN_LEN : 5;

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

    // 진영 버스. unlock() 에서 네 개를 만들고 이후로는 파라미터만 만진다
    this.sideFix = null;   // 고정 정위 — 소환·타격·포탑처럼 자주 나는 것
    this.sideSwp = null;   // 이동 정위 — 스킬·진화처럼 화면을 가로지르는 것
    this.sideGains = null; // hush() 가 훑을 게인 목록

    // BGM 층. 전부 지속 노드다 — 만들고 나면 게인·주파수만 만진다.
    this.bgm = null;
    this.cmd = null;        // 사령관 테마 층. 역시 지속 노드다
    this.tCounter = 0;      // 마지막 상성 타격음 시각. 난전에서 소리를 솎는다

    // ── 원정 상태. game.js 가 아직 안 보내면 전부 기본값에 머문다 ──
    this.cmdSeen = false;   // STAGE_START 나 game.commander 를 한 번이라도 봤는가
    this.cmdIdx = 0;
    this.stage = 0;
    this.stageMax = CAMPAIGN_LEN;
    this.campEnd = false;
    this.duckUntil = 0;     // 도발이 곡을 잠깐 눌러 앉힌다
    this.cmdMuteUntil = 0;  // 전투 클리어 직후 사령관 테마가 사라진다
    this.readLevel = 0;     // 도발 누적 — 거울이 얼마나 바짝 따라붙는가
    this.readAt = 0;
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
        this.buildSideBuses();
        this.buildWaterLoop();
        this.buildRunDrone();
        this.buildMusic();
        this.buildCommander();
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

  // ── 진영의 소리 공간 ────────────────────────────────────────
  // 사용자가 짚은 것: "상대와 내가 쓰는 기술이나 그런거에 대한 이펙트가 구분이 안된다".
  // 아트는 이걸 **위치와 색**으로 갈랐다 — 내 스킬은 흰금색이 왼→오른쪽,
  // 적 스킬은 회청+붉은색이 오른→왼쪽. 소리도 **같은 축**을 써야 한 사건으로 붙는다.
  //
  // 축을 셋 쓴다. 하나로는 못 가른다:
  //   1) 정위(pan)   내 것 왼→오른쪽, 적 것 오른→왼쪽. 아트의 진행 방향과 같다
  //   2) 음색(filter) 내 것은 위가 열려 맑고(highshelf), 적 것은 위가 닫혀 탁하다(lowpass)
  //   3) 음높이       적이 낮다 (호출부의 p 배수)
  //
  // **정위 하나에 걸면 안 된다.** 폰 스피커 한 개, 모노 출력, 한쪽 이어폰에서는
  // 팬이 통째로 사라진다. 2·3번은 모노로 합쳐도 살아남는다 — 팬은 그 위의 보너스다.
  // StereoPanner 가 없는 기기(구형 사파리)에서는 팬만 빠지고 나머지는 그대로다.
  buildSideBuses() {
    const ctx = this.ctx;
    const gains = [];
    const mk = (mine, sweep) => {
      const inp = ctx.createGain();
      inp.gain.value = 1;
      gains.push(inp);
      const tone = ctx.createBiquadFilter();
      if (mine) {
        // 내 것 — 위를 연다. 금속 광택이 남는다.
        // 문턱을 2400 에 뒀더니 증원·총진군(전부 200~500Hz대)이 선반 아래로
        // 통째로 빠져 적 것과 중심주파수가 1.3배밖에 안 벌어졌다. 1900 으로 내린다
        tone.type = 'highshelf';
        tone.frequency.value = sweep ? 1900 : 2800;
        tone.gain.value = sweep ? 7.0 : 3.5;
      } else {
        // 적 것 — 위를 닫는다. 물 건너에서 오는 소리처럼 둔해진다.
        // Q 를 1 쯤 남겨 문턱에 약간의 날을 둔다. 완전히 뭉개면 폰에서 사라진다
        tone.type = 'lowpass';
        tone.frequency.value = sweep ? 1400 : 2400;
        tone.Q.value = sweep ? 1.1 : 0.8;
      }
      inp.connect(tone);
      let tail = tone;
      let pan = null;
      if (typeof ctx.createStereoPanner === 'function') {
        pan = ctx.createStereoPanner();
        pan.pan.value = mine ? -0.42 : 0.42;
        tone.connect(pan);
        tail = pan;
      }
      tail.connect(this.master);
      return { in: inp, tone, pan };
    };
    this.sideFix = [mk(true, false), mk(false, false)];
    this.sideSwp = [mk(true, true),  mk(false, true)];
    this.sideGains = gains;
  }

  // 이 진영의 소리가 들어갈 입구. 버스가 없으면 예전처럼 master 로 간다
  sideIn(side, sweep) {
    const arr = sweep ? this.sideSwp : this.sideFix;
    if (!arr) return this.master;
    const b = arr[side === SIDE_L ? 0 : 1];
    return b ? b.in : this.master;
  }

  // 화면을 가로지르는 소리의 정위를 움직인다. **아트의 진행 방향과 같다.**
  // 내 스킬은 내 기지(왼쪽)에서 출발해 적 쪽으로 가고, 적 스킬은 그 반대다.
  // 노드를 만들지 않는다 — 이미 있는 팬 파라미터에 램프를 건다.
  sweepPan(side, dur) {
    if (!this.ctx || !this.sideSwp) return;
    const b = this.sideSwp[side === SIDE_L ? 0 : 1];
    if (!b || !b.pan) return;
    const t = this.ctx.currentTime;
    const from = side === SIDE_L ? -0.88 : 0.88;
    const to   = side === SIDE_L ?  0.44 : -0.44;
    b.pan.pan.cancelScheduledValues(t);
    b.pan.pan.setValueAtTime(from, t);
    b.pan.pan.linearRampToValueAtTime(to, t + (dur > 0.15 ? dur : 0.15));
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

  // ── 사령관 테마 층 ──────────────────────────────────────────
  // BGM 버스 **안**에 들어간다. 드래프트에서 같이 낮아지고 죽으면 같이 사라지며
  // hush() 도 자동으로 잡는다(out 을 outs 에 넣는다). 노드는 여기서 한 번 만든다.
  //
  // 두 겹으로 나눈 이유가 있다. env 는 스웰 LFO 가 붙는 곳이라 **게인이 0 이 되지
  // 않는다**(LFO 가 계속 ±로 흔든다). 그래서 hush·음소거가 실제로 무음이 되려면
  // LFO 가 안 붙은 out 이 따로 있어야 한다. 이걸 한 노드로 합치면 탭을 숨겨도
  // 사령관 테마만 살아남는다.
  buildCommander() {
    const ctx = this.ctx, m = this.bgm;
    if (!m) return;

    const out = ctx.createGain(); out.gain.value = 0;
    out.connect(m.bus);
    m.outs.push(out);                       // hush() 가 반드시 잡는다

    const env = ctx.createGain(); env.gain.value = 0.5;
    env.connect(out);

    // 스웰 — "참았다가 터진다"와 "움직이지 않는다"를 가르는 축.
    // 진폭이 base(0.5)를 못 넘게 묶어 게인이 음수로 가지 않는다(위상 반전 방지).
    const swell = ctx.createOscillator();
    swell.type = 'sine'; swell.frequency.value = 0.3;
    const swAmp = ctx.createGain(); swAmp.gain.value = 0;
    swell.connect(swAmp); swAmp.connect(env.gain);
    const swCut = ctx.createGain(); swCut.gain.value = 0;   // 같은 스웰이 필터도 연다
    swell.connect(swCut);

    // 맥동 성부 + 그림자 성부. 둘이 같은 게이트를 지난다 — 리듬이 어긋나지 않는다
    const osc = ctx.createOscillator();
    osc.type = CMD_WAVE[0]; osc.frequency.value = TONIC * 2;
    const shade = ctx.createOscillator();
    shade.type = CMD_WAVE2[0]; shade.frequency.value = TONIC * 2;
    const lfo = ctx.createOscillator();
    lfo.type = CMD_LFO[0]; lfo.frequency.value = 8;
    const lAmp = ctx.createGain(); lAmp.gain.value = CMD_LAMP[0];
    const gate = ctx.createGain(); gate.gain.value = 0.5;
    lfo.connect(lAmp); lAmp.connect(gate.gain);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = CMD_CUT[0];
    swCut.connect(lp.frequency);
    osc.connect(gate); shade.connect(gate); gate.connect(lp); lp.connect(env);

    // 타악 성부 — 리듬 밀도가 성격이다
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = CMD_PFRQ[0]; bp.Q.value = CMD_PQ[0];
    const plfo = ctx.createOscillator();
    plfo.type = CMD_PLFO[0]; plfo.frequency.value = 8;
    const pAmp = ctx.createGain(); pAmp.gain.value = CMD_PAMP[0];
    const pGate = ctx.createGain(); pGate.gain.value = 0.5;
    plfo.connect(pAmp); pAmp.connect(pGate.gain);
    const pOut = ctx.createGain(); pOut.gain.value = CMD_PGAIN[0];
    src.connect(bp); bp.connect(pGate); pGate.connect(pOut); pOut.connect(env);

    osc.start(0); shade.start(0); lfo.start(0); swell.start(0); plfo.start(0); src.start(0);

    this.cmd = {
      out, env, swell, swAmp, swCut, osc, shade, lfo, lAmp, gate, lp,
      bp, plfo, pAmp, pOut, idx: -1, mirrorWave: -1,
    };
  }

  // 사령관이 바뀔 때만 부른다. **매 프레임이 아니다.** 전부 속성 대입이라 할당이 없다.
  applyCommander(i) {
    const c = this.cmd;
    if (!c) return;
    c.idx = i;
    c.osc.type = CMD_WAVE[i];
    c.shade.type = CMD_WAVE2[i];
    c.shade.detune.value = CMD_DET[i];
    c.lfo.type = CMD_LFO[i];
    c.lAmp.gain.value = CMD_LAMP[i];
    c.swell.type = CMD_SWW[i];
    c.swAmp.gain.value = 0.5 * CMD_SWD[i];
    c.swCut.gain.value = CMD_SWC[i];
    c.bp.frequency.value = CMD_PFRQ[i];
    c.bp.Q.value = CMD_PQ[i];
    c.plfo.type = CMD_PLFO[i];
    c.pAmp.gain.value = CMD_PAMP[i];
    c.pOut.gain.value = CMD_PGAIN[i];
    c.mirrorWave = -1;
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

    // ── 원정 상태를 읽는다. **읽기만 한다.** 없으면 기본값에 머문다 ──
    if (game && typeof game.stage === 'number') this.stage = game.stage | 0;
    if (game && typeof game.stageMax === 'number' && game.stageMax > 0) this.stageMax = game.stageMax | 0;
    if (game && typeof game.commander === 'number') {
      this.cmdIdx = clamp(game.commander | 0, 0, CMD_N - 1);
      this.cmdSeen = true;
    }
    if (game && typeof game.campaignOver === 'boolean') this.campEnd = game.campaignOver;
    // 원정 진행도 0..1. **뒤로 갈수록 곡이 조인다** — 난이도 곡선을 소리가 따라간다
    const camp = this.cmdSeen
      ? clamp(this.stage / Math.max(1, this.stageMax - 1), 0, 1) : 0;

    // **전선이 밀리면 화성이 어두워진다.** 0 = 밀고 있다, 1 = 밀리고 있다.
    // 원정 후반에는 같은 전선이라도 더 어둡게 읽힌다 — 여유가 사라진다.
    const dark = clamp((0.5 - front) * 2.6 + 0.22 * camp, 0, 1);

    // 전체 볼륨 — 죽으면 내리고, 드래프트에서는 반쯤 낮춰 생각할 여지를 준다.
    // 도발이 방금 나갔으면 곡을 눌러 앉힌다. 그 0.4초는 사령관의 것이다.
    const ducking = t < this.duckUntil;
    m.bus.gain.setTargetAtTime(
      (dead ? 0 : (draft ? 0.10 : 0.20)) * (ducking ? 0.34 : 1), t, ducking ? 0.04 : 0.25);

    // 템포는 전장의 밀도를 따라간다. 판이 커지는 것이 귀로 먼저 들린다.
    // 구간이 오르면 기본 템포도 조금 올라간다 — 곡이 조여든다.
    const beat = 2.1 + 2.1 * spd + 0.18 * sec + 0.35 * camp;
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
        // 마디가 바뀔 때만 진행표를 다시 고른다 — 마디 중간에 조가 튀지 않는다.
        // **원정 후반·마지막 사령관에서는 프리기아가 더 빨리 온다.** 이미 있던
        // 어두운 진행을 원정 구조에 연결하는 지점이다.
        const darkTh = 0.55 - 0.18 * camp - (this.cmdSeen && this.cmdIdx === 4 ? 0.10 : 0);
        m.prog = dark > darkTh ? PROG_DARK : PROG[m.era];
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
    // 원정 후반에는 물이 같은 높이라도 더 무겁게 들린다 — 마감 시계가 짧아진 것이다
    m.pad.out.gain.setTargetAtTime(
      dead ? 0 : (near * near * 0.12 + dark * 0.04 + 0.030 * camp * near), t, 0.2);
    // 5도 위 — 물이 가깝거나 밀리고 있으면 살짝 어긋나 맥놀이가 생긴다
    m.pad.osc.frequency.setTargetAtTime(
      root * 3 * (1 - 0.030 * near - 0.018 * dark), t, 0.3);
    m.pad.lp.frequency.setTargetAtTime(cut[2], t, 0.4);

    // 층 sub — **물이 가까우면 층이 늘어난다.** 발밑이 무거워진다
    m.sub.out.gain.setTargetAtTime(
      dead || draft ? 0 : (0.02 + 0.10 * near * near + 0.018 * camp)
                          * (0.4 + 0.6 * S_PERC[sec]), t, 0.3);

    // 층 sonar — 물속 링잉. 물이 가까울 때만 들린다
    m.sonar.lfo.frequency.setTargetAtTime(0.35 + 0.5 * near, t, 0.5);
    m.sonar.out.gain.setTargetAtTime(dead ? 0 : near * near * near * 0.055, t, 0.4);

    // 층 lead — 선율. 구간 2부터 본격적으로, 이기고 있으면 확실히 열린다
    const winning = front > 0.62;
    const leadG = (dead || draft) ? 0
      : (0.024 + (winning ? 0.036 : 0) + (era >= 3 ? 0.010 : 0)) * S_LEAD[sec] * (fillBar ? 1.35 : 1);
    m.lead.out.gain.setTargetAtTime(leadG, t, 0.15);
    m.lead.lp.frequency.setTargetAtTime(cut[3] * (1 - 0.3 * dark), t, 0.3);

    this.updateCommander(t, root, beat, spd, sec, era, camp, dead, draft);
  }

  // ── 사령관 테마 — 매 프레임. 노드를 만들지 않는다 ────────────
  // 사령관을 한 번도 못 봤으면 게인 0 에 머문다. 곡은 v2 와 같은 소리를 낸다.
  updateCommander(t, root, beat, spd, sec, era, camp, dead, draft) {
    const c = this.cmd;
    if (!c) return;
    const i = clamp(this.cmdIdx | 0, 0, CMD_N - 1);
    if (i !== c.idx) this.applyCommander(i);

    // 도발 누적은 8초에 걸쳐 식는다. 거울만 이걸 쓴다
    const read = clamp(this.readLevel * (1 - (t - this.readAt) / 8), 0, 1);

    if (i === 4) {
      // ── 거울. **스스로 음정을 고르지 않는다.** 플레이어 선율을 되받는다 ──
      // setTargetAtTime 의 시정수가 곧 "따라오는 지연"이다. 읽힐수록 짧아진다.
      // 8분음표 길이(0.5/beat ≈ 0.12초)보다 짧아야 음 하나하나를 따라잡는다.
      // 0.30 으로 뒀더니 선율을 못 쫓고 평균 근처를 헤매 금고와 음역이 겹쳤다(코사인 0.93).
      const lag = 0.10 - 0.05 * read;
      const lf = this.bgm.lead.osc.frequency.value;
      c.osc.frequency.setTargetAtTime(lf, t, lag);              // 같은 음. 반 박자 늦게
      c.shade.frequency.setTargetAtTime(lf * 0.5, t, lag * 2.2); // 흐릿한 그림자
      // 음색도 플레이어의 시대를 그대로 쓴다 — 시대가 바뀔 때만 대입한다
      if (c.mirrorWave !== era) {
        c.osc.type = ERA_WAVE[era][4];
        c.shade.type = ERA_WAVE[era][2];
        c.mirrorWave = era;
      }
      c.lfo.frequency.setTargetAtTime(beat * 2, t, 0.2);
      c.plfo.frequency.setTargetAtTime(beat * 2, t, 0.2);
      c.swell.frequency.setTargetAtTime(0.22 + 0.85 * spd, t, 0.6);
      c.swAmp.gain.setTargetAtTime(-0.5 * (0.25 + 0.7 * read), t, 0.8);
      c.lp.frequency.setTargetAtTime(ERA_CUT[era][3] * 0.85 * (1 + 0.35 * read), t, 0.5);
    } else {
      c.osc.frequency.setTargetAtTime(
        root * SEMI[SEMI_ZERO + CMD_INT[i]] * CMD_OCT[i], t, 0.07);
      c.shade.frequency.setTargetAtTime(
        root * SEMI[SEMI_ZERO + CMD_INT2[i]] * CMD_OCT[i], t, 0.07);
      c.lfo.frequency.setTargetAtTime(beat * CMD_RATE[i], t, 0.25);
      c.plfo.frequency.setTargetAtTime(beat * CMD_PRATE[i], t, 0.25);
      // 원정 후반일수록 스웰이 빨라진다 — 같은 사령관도 뒤에서 더 조인다
      c.swell.frequency.setTargetAtTime(CMD_SWR[i] * (0.85 + 0.35 * camp), t, 0.6);
      c.lp.frequency.setTargetAtTime(CMD_CUT[i] * (0.85 + 0.3 * spd), t, 0.4);
    }

    const on = this.cmdSeen && !dead && !this.campEnd && t >= this.cmdMuteUntil;
    const g = on
      ? CMD_GAIN[i] * 2 * (0.55 + 0.45 * S_HARM[sec]) * (1 + 0.30 * camp) * (draft ? 0.35 : 1)
      : 0;
    c.out.gain.setTargetAtTime(g, t, on ? 0.5 : 0.25);
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
    // 진영 버스도 같이 닫는다. update() 가 돌아오면 다시 연다
    const s = this.sideGains;
    if (s) for (let i = 0; i < s.length; i++) s[i].gain.setTargetAtTime(0, t, 0.02);
  }

  // 같은 소리를 연속 재생할 때 ±3% 피치 변화. 안 하면 기계처럼 들린다.
  // 이건 연출이라 난수를 써도 된다 — 판정과 무관하다.
  vary(f) { return f * (1 + (Math.random() * 2 - 1) * 0.03); }

  // 일회용 오실레이터. ended 에서 disconnect 해 노드가 쌓이지 않게 한다.
  // cut 을 주면 로우패스를 한 장 물린다 — 같은 파형도 다른 악기가 된다.
  // dest 를 주면 그 버스로 간다(진영 버스). 안 주면 예전처럼 master 로 간다.
  blip(type, f0, f1, ms, gain, delay, cut, dest) {
    if (!this.ready || this.failed) return;
    const out = dest || this.master;
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
      o.connect(g); g.connect(f); f.connect(out);
      o.onended = () => { o.disconnect(); g.disconnect(); f.disconnect(); };
    } else {
      o.connect(g); g.connect(out);
      o.onended = () => { o.disconnect(); g.disconnect(); };
    }
    o.start(t);
    o.stop(t + ms / 1000 + 0.01);
  }

  // 노이즈 단발. delay·Q 까지 받는다 — 이게 타격음의 절반을 만든다.
  nz(ms, gain, cutFrom, cutTo, type, delay, q, dest) {
    if (!this.ready || this.failed) return;
    const dur = Math.min(ms, 1900) / 1000;   // 노이즈 버퍼가 2초다
    const out = dest || this.master;
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
    src.connect(f); f.connect(g); g.connect(out);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
    src.start(t);
    src.stop(t + dur);
  }

  // 예전 이름 유지 — 지연 없는 노이즈
  noise(ms, gain, cutFrom, cutTo, type, dest) {
    this.nz(ms, gain, cutFrom, cutTo, type, 0, 0, dest);
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

    // hush() 로 닫힌 진영 버스를 다시 연다. 탭이 숨어 있는 동안에는
    // rAF 가 안 도니까 여기도 안 불린다 — 돌아온 뒤에만 열린다
    const sg = this.sideGains;
    if (sg) for (let i = 0; i < sg.length; i++) sg[i].gain.setTargetAtTime(1, t, 0.05);

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
    // 고정 정위 버스. 소환은 자주 나므로 스윕이 아니라 제자리에 선다 —
    // **내 병력은 왼쪽에서, 적 병력은 오른쪽에서 나온다.** 화면과 같다
    const d = this.sideIn(side, false);

    switch (k) {
      case 0:  // 검사 — 가볍고 짧다
        this.blip('square', 520 * p, 700 * p, 70, 0.060 * v, 0, 3000 * br, d);
        this.nz(45, 0.045 * v, 4200 * br, 2200, 'bandpass', 0, 3, d);
        break;

      case 1:  // 창병 — 중간 무게. 나무 '툭'
        this.blip('triangle', 300 * p, 386 * p, 115, 0.070 * v, 0, 1800 * br, d);
        this.nz(70, 0.048 * v, 900, 400, 'lowpass', 0, 0, d);
        break;

      case 2:  // 궁수 — 가장 높고 가장 짧다. 활시위
        this.nz(55, 0.065 * v, 6000 * br, 1500, 'bandpass', 0, 2, d);
        this.blip('sine', 1000 * p, 1520 * p, 55, 0.042 * v, 0.01, 0, d);
        break;

      case 3:  // 기병 — 3연타. 다른 다섯과 리듬으로 갈린다
        this.blip('triangle', 236 * p, 300 * p, 45, 0.050 * v, 0, 0, d);
        this.blip('triangle', 252 * p, 320 * p, 45, 0.050 * v, 0.055, 0, d);
        this.blip('triangle', 268 * p, 350 * p, 70, 0.058 * v, 0.110, 0, d);
        this.nz(70, 0.040 * v, 2600, 800, 'bandpass', 0.02, 1.2, d);
        break;

      case 4:  // 거인 — 낮고 길다
        this.blip('sine', 96 * p, 58 * p, 420, 0.105 * v, 0, 0, d);
        this.blip('triangle', 192 * p, 116 * p, 300, 0.038 * v, 0, 700 * br, d);
        this.nz(280, 0.085 * v, 500, 110, 'lowpass', 0, 0, d);
        break;

      default: // 5 투석기 — 가장 길다. 도르래가 감기고 나무가 삐걱인다
        this.blip('sawtooth', 78 * p, 50 * p, 520, 0.095 * v, 0, 700 * br, d);
        this.nz(30, 0.045 * v, 3000, 1800, 'bandpass', 0.00, 4, d);
        this.nz(30, 0.045 * v, 3000, 1800, 'bandpass', 0.09, 4, d);
        this.nz(30, 0.045 * v, 3000, 1800, 'bandpass', 0.18, 4, d);
        this.nz(240, 0.070 * v, 320, 90, 'lowpass', 0.26, 0, d);
        break;
    }
    // 기계 시대의 금속 광택 — 같은 유닛도 시대가 오르면 다르게 들린다
    if (e >= 3) this.blip('square', 1250 * p, 940 * p, 40, 0.014 * e * v, 0.02, 6000, d);
  }

  // ── 시대 진화 ───────────────────────────────────────────────
  // 사용자가 진화에 "큰 변화가 없다"고 **세 번** 말했다. 예전 진화음은
  // 0.24~0.43초짜리 3~6음 팡파르 하나였다 — 소환음(0.4초)과 같은 크기다.
  // 크기가 같으면 사건이 아니다. 그래서 셋을 더한다:
  //   앞머리  0.38초의 리저 + 문턱을 넘는 타격. **오는 것이 먼저 들린다**
  //   본체    시대별 팡파르 (음색이 시대다 — 사인 → 삼각 → 톱니 → 사각)
  //   꼬리    1.5초의 여운. 여기서 판이 바뀐 것이 앉는다
  // 그리고 곡을 1초 눌러 앉힌다(duck) — 도발과 같은 장치다. 진화가 곡을 이긴다.
  //
  // **내 진화와 적 진화는 반대로 간다.** 재료는 같고 방향이 다르다:
  //   내 것  올라간다 · 왼→오른쪽 · 꼬리에서 필터가 열린다(밝아진다)
  //   적 것  내려온다 · 오른→왼쪽 · 꼬리에서 필터가 닫힌다(어두워진다) · 낮다
  eraVoice(era, side) {
    const mine = side !== undefined ? side === SIDE_L : true;
    const e = clamp(era | 0, 1, 4);
    const p = mine ? 1 : 0.62;
    const v = mine ? 1 : 0.90;
    const d = this.sideIn(mine ? SIDE_L : 1, true);
    this.sweepPan(mine ? SIDE_L : 1, 1.8);
    if (this.ctx) this.duckUntil = this.ctx.currentTime + (mine ? 1.05 : 0.80);

    // ── 앞머리 — 시대가 오는 소리. 내 것은 빨려 올라가고 적 것은 내려앉는다 ──
    if (mine) {
      this.nz(380, 0.085, 260, 6200, 'bandpass', 0, 0.8, d);
      this.blip('sawtooth', 90, 300, 380, 0.070, 0, 2200, d);
    } else {
      this.nz(380, 0.085 * v, 5200 * p, 200, 'bandpass', 0, 0.8, d);
      this.blip('sawtooth', 300 * p, 78 * p, 380, 0.070 * v, 0, 2200, d);
    }
    this.nz(300, 0.150 * v, 3800 * p, 160, 'lowpass', 0.38, 0, d);
    this.blip('sine', 132 * p, 34, 640, 0.150 * v, 0.38, 0, d);

    // ── 본체 — 시대는 음높이가 아니라 **음색**이다 ──
    const seq = e === 1 ? ERA1_SEQ : (e === 2 ? ERA2_SEQ : (e === 3 ? ERA3_SEQ : ERA4_SEQ));
    const wave = e === 1 ? 'sine' : (e === 2 ? 'triangle' : (e === 3 ? 'sawtooth' : 'square'));
    const cut  = e === 1 ? 3000 : (e === 2 ? 3600 : (e === 3 ? 3000 : 5200));
    const step = e === 4 ? 0.062 : 0.115;
    const T0 = 0.50;
    const n = seq.length;
    for (let i = 0; i < n; i++) {
      const f = seq[mine ? i : n - 1 - i] * p;    // 적은 거꾸로 내려온다
      const t0 = T0 + i * step;
      const last = i === n - 1;
      this.blip(wave, f, f, last ? 620 : 155, (last ? 0.115 : 0.095) * v, t0, cut * p, d);
      if (e >= 2) this.nz(30, 0.034 * v, 4200 * p, 2600 * p, 'bandpass', t0, 7, d);
    }
    // 시대의 성격이 남는 한 겹
    if (e === 3) {                     // 화약 — 폭발이 시대 이름이다
      this.nz(560, 0.130 * v, 2600 * p, 120, 'lowpass', T0, 0, d);
      this.blip('sawtooth', 130 * p, 42, 540, 0.115 * v, T0, 900, d);
    } else if (e === 4) {              // 기계 — 래칫이 물려 돌아간다
      for (let i = 0; i < 5; i++) this.nz(24, 0.032 * v, 5200 * p, 3200 * p, 'bandpass', T0 + 0.40 + i * 0.048, 9, d);
      this.blip('square', 130.81 * p, 130.81 * p, 460, 0.090 * v, T0 + 0.36, 1200, d);
    }

    // ── 꼬리 — 여기가 없으면 팡파르가 "삑"으로 끝난다 ──
    // 내 것은 필터가 열리며 밝아지고, 적 것은 닫히며 어두워진다.
    const tail = T0 + n * step + 0.02;
    const base = mine ? 82.41 : 51.91;          // E2 대 G#1 — 적은 한참 아래다
    this.blip(mine ? 'triangle' : 'sawtooth', base * 2, base * 2, 1500, 0.070 * v, tail, 900, d);
    this.blip('sine', base, base, 1650, 0.085 * v, tail, 0, d);
    this.nz(1300, 0.055 * v, mine ? 300 : 900, mine ? 2600 : 110, 'lowpass', tail, 0, d);
    if (mine) this.blip('sine', base * 6, base * 6, 1400, 0.030, tail + 0.10, 5000, d);
    else this.blip('sine', base * 3 * 1.012, base * 3, 1400, 0.038 * v, tail + 0.10, 800, d);
  }

  // ── 스킬 4종 — 넷이 완전히 달라야 한다 ──────────────────────
  // 사용자가 짚은 것 둘을 여기서 같이 푼다:
  //   "스킬을 썼을때 임팩트도 너무 간단하다"  → 셋이 다 1초 미만에 끝났다.
  //      3단 구조(예비동작 → 본체 → 여운)를 넣어 길이와 무게를 준다
  //   "상대와 내가 쓰는 기술이 구분이 안된다" → 진영 버스로 가른다
  //
  // 넷의 정체성은 **서로 다른 축**에 걸린다. 같은 축에 넷을 늘어놓으면
  // 결국 "높은 삑 / 낮은 삑"이 된다:
  //   해일   무게   — 사건이 적고(2~3), 낮고, 가장 길다. 음정이 없다
  //   화살비 쏟아짐 — 사건이 가장 많다(20+). 높다. 불규칙한 착탄이 정체성이다
  //   증원   솟아오름 — 유일하게 **음정이 올라가며 해결된다**. 북이 빨라진다
  //   총진군 행군   — 등간격의 낮은 발소리. 밀도가 일정하다
  //
  // tier 는 진화로 오른 스킬 등급이다(0~2). **진화하면 스킬 소리도 바뀐다** —
  // 버튼의 글자가 바뀌는데 소리가 그대로면 바뀐 걸 귀로 알 수가 없다.
  skillVoice(idx, side, tier) {
    if (!this.ready || this.failed) return;
    const mine = side === SIDE_L;
    const p = mine ? 1 : 0.72;    // 적이 낮다 — **모노에서도 살아남는 축**
    const v = mine ? 1 : 0.86;    // 내 것이 앞에 온다. 다만 위협은 남긴다
    const q = clamp(tier | 0, 0, 2);
    const d = this.sideIn(side, true);

    if (idx === SK_VOLLEY) {
      // ── 화살비 — 쏟아진다. **개수가 정체성이다** ──
      this.sweepPan(side, 1.15);
      // 1) 시위가 한꺼번에 놓인다
      this.nz(95, 0.100 * v, 2400 * p, 7400 * p, 'bandpass', 0, 1.2, d);
      this.blip('square', 900 * p, 1700 * p, 60, 0.045 * v, 0, 8000, d);
      // 2) 내려온다. 등급이 오르면 화살이 늘어난다
      const n = 10 + q * 2;
      for (let i = 0; i < n; i++) {
        this.blip('sine', (2050 - i * 92) * p, (400 - i * 12) * p,
                  205, 0.036 * v, 0.05 + i * 0.037, 9000, d);
      }
      this.nz(720, 0.072 * v, 7600 * p, 1300, 'bandpass', 0.05, 0.8, d);
      // 3) 꽂힌다 — **불규칙한 착탄이 "비"를 만든다.** 등간격이면 기계음이다
      for (let i = 0; i < VOLLEY_HIT.length; i++) {
        this.nz(34, 0.060 * v, 3400 * p, 1100, 'bandpass', VOLLEY_HIT[i], 2.2, d);
      }
      this.nz(300, 0.095 * v, 1700, 240, 'lowpass', 0.46, 0, d);
      this.blip('triangle', 300 * p, 104 * p, 300, 0.072 * v, 0.46, 1300, d);
      if (q >= 2) {   // 융단폭격 — 두 번째 파도가 뒤에 떨어진다
        for (let i = 0; i < 6; i++) {
          this.nz(30, 0.050 * v, 3000 * p, 950, 'bandpass', 0.90 + i * 0.052, 2.2, d);
        }
        this.nz(340, 0.078 * v, 1500, 200, 'lowpass', 0.95, 0, d);
        this.blip('sine', 92 * p, 46 * p, 380, 0.062 * v, 0.95, 0, d);
      }

    } else if (idx === SK_RALLY) {
      // ── 증원 — 솟아오른다. **넷 중 유일하게 음정으로 해결된다** ──
      this.sweepPan(side, 1.7);
      // 1) 북이 빨라진다. 간격이 줄어드는 것이 곧 "모여든다"
      for (let i = 0; i < RALLY_DRUM.length; i++) {
        this.nz(155, (0.058 + 0.010 * i) * v, 520, 120, 'lowpass', RALLY_DRUM[i], 0, d);
        this.blip('sine', 84 * p, 52 * p, 135, 0.052 * v, RALLY_DRUM[i], 0, d);
      }
      // 2) 뿔피리가 올라간다. 살짝 어긋난 짝이 붙어 여럿으로 들린다
      for (let i = 0; i < RALLY_HORN.length; i++) {
        const f = RALLY_HORN[i] * p;
        const t0 = 0.72 + i * 0.185;
        const ln = i === RALLY_HORN.length - 1 ? 780 : 265;
        this.blip('sawtooth', f, f, ln, 0.082 * v, t0, 1000 + 300 * i, d);
        this.blip('sawtooth', f * 1.008, f * 1.008, ln, 0.058 * v, t0, 1000 + 300 * i, d);
        if (q >= 1) this.blip('triangle', f * 2, f * 2, ln, 0.030 * v, t0, 4200, d);
      }
      // 3) 마지막에 위로 쓸어 올린다 — 여기서 소리가 해결된다
      this.nz(560, 0.055 * v, 400, 5400 * p, 'bandpass', 1.20, 0.9, d);
      if (q >= 2) this.blip('square', 523.25 * p, 1046.5 * p, 560, 0.045 * v, 1.30, 6000, d);

    } else if (idx === SK_SURGE) {
      // ── 총진군 — 행군. **밀도가 일정하다.** 다른 셋과 여기서 갈린다 ──
      // 예전에는 이 스킬이 해일과 **똑같은 소리**를 냈다(else 로 흘렀다).
      this.sweepPan(side, 1.9);
      for (let i = 0; i < 8; i++) {
        const t0 = i * 0.115;
        this.nz(95, 0.072 * v, 260, 90, 'lowpass', t0, 0, d);
        this.blip('triangle', 62 * p, 44 * p, 115, 0.055 * v, t0, 300, d);
      }
      // 전군이 한 소리로 합쳐진다
      this.blip('sawtooth', 98 * p, 147 * p, 950, 0.105 * v, 0.90, 800, d);
      this.blip('sawtooth', 98.7 * p, 148 * p, 950, 0.075 * v, 0.90, 800, d);
      this.nz(950, 0.085 * v, 700, 3400 * p, 'lowpass', 0.90, 0, d);
      this.blip('square', 196 * p, 294 * p, 760, 0.058 * v, 1.12, 2400, d);

    } else {
      // ── 해일 — 무게. **사건이 적고 가장 길다** ──
      this.sweepPan(side, 2.2);
      // 1) 빨아들인다. 무너지기 전에 물이 뒤로 빠진다 — 이 0.6초가 무게를 만든다
      this.nz(620, 0.085 * v, 90, 1500 * p, 'lowpass', 0, 0, d);
      this.blip('sine', 38 * p, 96 * p, 620, 0.075 * v, 0, 0, d);
      // 격류(1등급) — 빨아들이는 소리에 물살이 섞인다
      if (q >= 1) this.nz(560, 0.052 * v, 200, 2900 * p, 'bandpass', 0.05, 0.7, d);
      // 2) 무너진다 — 이 게임에서 가장 무거운 한 방.
      // 게인은 여기서 더 못 올린다: 난전 실측에서 master 최대가 0.877 까지 갔다
      // (여유 1.1dB). 무게는 게인이 아니라 **길이와 저역 비중**에서 나온다
      this.nz(1150, 0.170 * v, 2600 * p, 70, 'lowpass', 0.62, 0, d);
      this.blip('sawtooth', 210 * p, 27, 1050, 0.135 * v, 0.62, 520, d);
      this.blip('sine', 74 * p, 24, 980, 0.122 * v, 0.64, 0, d);
      this.blip('triangle', 148 * p, 48, 700, 0.068 * v, 0.62, 400, d);
      // 범람(2등급) — **두 번째 파도가 온다.** 첫 파의 꼬리에 겹쳐 두면 묻힌다.
      // 1.15초의 빈 구간에 놓아야 "한 번 더 왔다"로 들린다. 넘어뜨리는 쓸림까지 붙인다
      if (q >= 2) {
        this.nz(760, 0.112 * v, 2000 * p, 90, 'lowpass', 1.16, 0, d);
        this.blip('sawtooth', 165 * p, 25, 780, 0.092 * v, 1.16, 460, d);
        this.nz(520, 0.070 * v, 260, 1900 * p, 'bandpass', 1.30, 1.1, d);   // 휩쓸린다
      }
      // 3) 물러난다. 꼬리가 길다 — **무게는 길이에서 온다**
      this.nz(1250, 0.078 * v, 620, 105, 'lowpass', q >= 2 ? 2.05 : 1.55, 0, d);
      this.blip('sine', 46 * p, 30, 1200, 0.058 * v, q >= 2 ? 2.05 : 1.55, 0, d);
    }
  }

  // ── 원정의 소리 ─────────────────────────────────────────────
  // 전투 시작 · 클리어 · 도발 · 원정 종료가 서로 절대 헷갈리면 안 된다.
  // 넷이 길이·음역·해결 여부로 갈린다:
  //   시작   사령관마다 다르다. 그 사령관의 음정과 리듬으로 자기를 소개한다
  //   클리어 상승하지만 **해결되지 않는다**(장7도에서 멈춘다) = 아직 남았다
  //   도발   0.4초. 화성 밖의 트라이톤. 곡을 눌러 앉히고 벤다
  //   종료   완주는 이 게임 유일의 장3도. 실패는 전부 아래로 무너진다

  // 전투 시작 — 다섯 사령관이 **자기 음정과 자기 리듬으로** 등장한다.
  // 테마 층과 같은 재료를 쓰므로 등장음과 배경음이 같은 인물로 들린다.
  commanderCall(i) {
    const f0 = TONIC * SEMI[SEMI_ZERO + CMD_INT[i]] * CMD_OCT[i];
    this.nz(300, 0.070, 700, 120, 'lowpass', 0, 0);      // 공통: 문이 열린다

    if (i === 0) {
      // 무리 — 셀 수 없다. 여덟 번 밀려오고 끝나지 않는다
      for (let k = 0; k < 8; k++) {
        this.blip('sawtooth', f0 * (k & 1 ? 0.994 : 1), f0, 95, 0.036, 0.06 + k * 0.075, 950);
      }
      this.nz(70, 0.048, 300, 200, 'bandpass', 0.06, 1.4);
      this.nz(70, 0.048, 300, 200, 'bandpass', 0.36, 1.4);
      this.nz(70, 0.048, 300, 200, 'bandpass', 0.66, 1.4);

    } else if (i === 1) {
      // 쇄도 — 가속한다. 간격이 줄고 트라이톤에서 멈춘다. 해결되지 않는다
      let d = 0.04, gap = 0.17;
      for (let k = 0; k < 6; k++) {
        this.blip('square', f0 * 0.5, f0, 70, 0.050, d, 3400);
        this.nz(40, 0.045, 2400, 1200, 'bandpass', d, 3);
        d += gap; gap *= 0.72;
      }
      this.blip('square', f0, f0, 300, 0.070, d, 4200);

    } else if (i === 2) {
      // 금고 — 마른 소리 하나. 0.6초의 침묵. 그리고 터진다
      this.nz(45, 0.050, 2600, 1800, 'bandpass', 0, 6);
      this.blip('triangle', f0 * 4, f0 * 4, 60, 0.028, 0.02, 3000);
      this.blip('sine', f0, f0 * 0.5, 900, 0.125, 0.62);
      this.nz(700, 0.120, 1800, 80, 'lowpass', 0.62, 0);
      this.blip('triangle', f0 * 2, f0 * 2, 500, 0.050, 0.66, 1200);

    } else if (i === 3) {
      // 성벽 — 타격이 없다. 근음과 12도가 서고 그대로 있는다.
      // f0 가 41Hz(E1)라 그대로 쓰면 폰 스피커에서 사라진다. 2·3배음이 실체를 만든다
      this.blip('sine', f0 * 2, f0 * 2, 1500, 0.095, 0);
      this.blip('sine', f0 * 3, f0 * 3, 1400, 0.055, 0.05);
      this.blip('triangle', f0, f0, 1500, 0.065, 0, 300);
      this.nz(1200, 0.042, 160, 90, 'lowpass', 0, 0);

    } else {
      // 거울 — 같은 악구가 두 번. 두 번째는 어긋난 복사본이다
      for (let k = 0; k < 4; k++) {
        const f = f0 * SEMI[SEMI_ZERO + MIRROR_SEQ[k]];
        this.blip('triangle', f, f, 130, 0.052, k * 0.11, 2400);
      }
      for (let k = 0; k < 4; k++) {
        const f = f0 * SEMI[SEMI_ZERO + MIRROR_SEQ[k]] * 1.007;
        this.blip('triangle', f, f, 130, 0.042, 0.50 + k * 0.11, 2100);
      }
      this.nz(240, 0.045, 1400, 400, 'bandpass', 0.50, 2);
    }
  }

  // 전투 클리어 — **끝이 아니라 다음이다.** 장7도에서 멈춰 해결하지 않는다.
  // EV.WIN(옥타브로 닫는다)과 반드시 다르게 들려야 한다.
  stageClearVoice() {
    if (this.ctx) this.cmdMuteUntil = this.ctx.currentTime + 2.6;  // 사령관이 사라진다
    this.blip('sawtooth', 220, 62, 900, 0.070, 0, 900);            // 상대의 음이 무너진다
    this.blip('sine', 392.00, 392.00, 150, 0.095, 0.14);
    this.blip('sine', 523.25, 523.25, 150, 0.095, 0.28);
    this.blip('sine', 659.25, 659.25, 150, 0.095, 0.42);
    this.blip('sine', 987.77, 987.77, 430, 0.090, 0.56);           // 장7도 — 열어 둔다
    this.nz(60, 0.045, 5200, 3000, 'bandpass', 0.56, 6);
  }

  // 도발 — **"AI 가 나를 읽었다"의 순간.** 0.4초. 길면 방해가 된다.
  // 곡을 눌러 앉히고(duck) 화성 밖의 트라이톤으로 벤다. 녹지 않아야 짚힌다.
  tauntVoice(prof) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.duckUntil = t + 0.42;
    const p = 1 + 0.055 * clamp(prof | 0, 0, 4);   // 무엇을 읽었는지가 음정에 남는다
    this.nz(110, 0.065, 500, 5200, 'bandpass', 0, 2.5);       // 알아채는 '스윽'
    this.blip('sine', 2637 * p, 2637 * p, 70, 0.050, 0.06, 9000);
    this.blip('sine', 3729 * p, 3729 * p, 90, 0.042, 0.10, 9000);
    this.blip('sine', 78, 41, 260, 0.080, 0.10);              // 발밑이 꺼진다
    // 거울은 이 누적을 먹고 더 바짝 따라붙는다
    const cur = clamp(this.readLevel * (1 - (t - this.readAt) / 8), 0, 1);
    this.readLevel = clamp(cur + 0.45, 0, 1);
    this.readAt = t;
  }

  // 원정 종료. 완주와 실패가 정반대 방향으로 간다
  campaignVoice(full) {
    if (this.ctx) this.cmdMuteUntil = this.ctx.currentTime + 30;
    this.campEnd = true;
    if (full) {
      // 완주 — **이 게임에서 유일한 장3도.** 물에 잠기는 게임에 장조는 없었다
      for (let k = 0; k < CAMP_WIN_SEQ.length; k++) {
        this.blip('triangle', CAMP_WIN_SEQ[k], CAMP_WIN_SEQ[k], 190, 0.085, k * 0.13, 4000);
      }
      this.blip('sine', 329.63, 329.63, 2400, 0.085, 0.80);
      this.blip('sine', 415.30, 415.30, 2400, 0.075, 0.84);   // 장3도
      this.blip('sine', 493.88, 493.88, 2400, 0.070, 0.88);
      this.blip('triangle', 82.41, 82.41, 2600, 0.075, 0.80, 500);
      this.nz(1600, 0.050, 240, 4000, 'lowpass', 0.80, 0);    // 물이 빠진다
    } else {
      // 실패 — 전부 아래로. 사령관의 음이 마지막까지 남아 가라앉는다
      this.blip('sawtooth', 196, 30, 1700, 0.105, 0, 800);
      this.blip('sawtooth', 197.8, 30.4, 1700, 0.075, 0, 800);  // 어긋나 무너진다
      this.nz(1500, 0.130, 1400, 60, 'lowpass', 0.05, 0);
      this.blip('sine', 62, 34, 1400, 0.095, 0.55);
      this.nz(700, 0.075, 300, 70, 'lowpass', 1.10, 0);
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
        // 매 공격마다 난다. 아주 짧고 작아야 한다 — 안 그러면 귀가 아프다.
        // b = 때린 진영. 진영 버스만 태운다 — 난타전에서 **누가 때리고 있는지**가
        // 좌우로 갈린다. 소리 자체는 예전과 같다
        this.noise(28, 0.035, 2600, 1400, 'bandpass', this.sideIn(b, false));
        break;

      case E_COUNTER_HIT: {
        // **상성 우위.** 일반 타격(28ms 노이즈 한 장)과 확실히 달라야 한다.
        // 날카로운 파열 + 급강하 + 짧은 울림 + 배를 치는 서브. "제대로 먹혔다".
        // b = 때린 진영. 내가 먹였으면 밝게 울리고, 내가 맞았으면 낮고 둔탁하다.
        if (!this.ready) break;
        const mine = b === SIDE_L;
        const p = mine ? 1 : 0.62;
        const v = mine ? 1 : 0.8;
        const d = this.sideIn(b, false);
        // 난전에서는 초당 예닐곱 번 터진다. 그대로 다 내면 기관총이 된다.
        const now = this.ctx.currentTime;
        const dense = now - this.tCounter < COUNTER_DENSE;
        this.tCounter = now;
        if (dense) {
          this.nz(55, 0.075 * v, 5200 * p, 1000, 'bandpass', 0, 1.6, d);
          this.blip('square', 1050 * p, 320 * p, 55, 0.055 * v, 0, 0, d);
          break;
        }
        this.nz(95, 0.125 * v, 5400 * p, 800, 'bandpass', 0, 1.6, d);
        this.blip('square', 1150 * p, 260 * p, 95, 0.095 * v, 0, 0, d);
        // 울림은 내가 먹였을 때만. 이게 "제대로 먹혔다"의 정체다
        if (mine) this.blip('sine', 1318.5, 1318.5, 230, 0.050, 0.03, 0, d);
        this.blip('sine', 92, 58, 170, 0.085 * v, 0, 0, d);
        this.nz(170, 0.045 * v, 900, 200, 'lowpass', 0.05, 0, d);
        break;
      }

      case EV.KILL: {
        // b = **죽인** 진영이다(game.js 계약). 소리가 서야 할 자리는 죽은 쪽이므로
        // 뒤집는다 — 아군 오사가 없어서 죽은 진영은 항상 1-b 다.
        // 초당 여러 건 터지는 사건이라 정위를 붙일지 실측으로 정했다(아래 참조).
        const d = this.sideIn(1 - (b | 0), false);
        this.blip('square', 240, 90, 130, 0.11, 0, 0, d);
        this.noise(150, 0.09, 1400, 260, 'lowpass', d);
        break;
      }

      case EV.BASE_HIT: {
        // b = **맞은** 진영. 맞은 성이 곧 그 자리다 — 그대로 쓴다.
        // 이전에는 내 성이 깎이는 소리와 적 성이 깎이는 소리가 **완전히 같았다.**
        const d = this.sideIn(b, false);
        this.blip('sine', 130, 70, 120, 0.13, 0, 0, d);
        break;
      }

      case EV.ERA_UP:
        // b = 진영. **둘 다 사건급이다.** 예전에는 적의 진화가 0.32초짜리
        // 블립 두 개였고 시대가 몇이든 똑같은 소리였다 — 적이 기계 시대로
        // 올라간 것과 청동으로 올라간 것을 구분할 방법이 없었다
        if (this.ready) this.eraVoice(a, b);
        break;

      case E_SKILL_UP: {
        // a = 스킬 번호, b = 새 등급. **진화가 무기를 바꾼 순간이다.**
        // 진화 팡파르 뒤에 놓는다(0.95초~) — 앞에 겹치면 둘 다 안 들린다.
        // 여러 스킬이 한 번에 오를 수 있어 스킬 번호로 어긋나게 둔다.
        if (!this.ready) break;
        const k = clamp(a | 0, 0, 3);
        const tq = clamp(b | 0, 0, 2);
        const d = this.sideIn(SIDE_L, false);
        const f = 660 * SEMI[SEMI_ZERO + SKILLUP_SEMI[k]] * (1 + 0.06 * tq);
        const t0 = 0.98 + k * 0.085;
        this.blip('triangle', f, f * 1.5, 270, 0.055, t0, 6000, d);
        this.nz(40, 0.030, 5200, 3400, 'bandpass', t0, 8, d);
        break;
      }

      case E_TOWER_FIRE:
        // a = 포탑 단계(1 또는 2). 1단계는 쇠뇌, 2단계는 대포다.
        // b = 진영 — 내 포탑과 적 포탑이 좌우로 갈린다
        {
          const d = this.sideIn(b, false);
          if ((a | 0) >= 2) {
            this.blip('sawtooth', 360, 58, 175, 0.095, 0, 1200, d);
            this.nz(210, 0.100, 2200, 170, 'lowpass', 0, 0, d);
            this.blip('sine', 120, 48, 230, 0.055, 0.02, 0, d);
          } else {
            this.blip('square', 700, 180, 80, 0.070, 0, 2600, d);
            this.nz(70, 0.065, 3200, 700, 'bandpass', 0, 1.2, d);
          }
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

      case E_SKILL: {
        // a = 스킬 번호, b = 진영. **등급은 game 에서 읽기만 한다** —
        // 없으면 0 등급 소리가 나고 게임은 그대로 돈다
        let tier = 0;
        if (game && typeof game.eraTier === 'function') {
          const era = b === SIDE_L ? (game.era | 0) : (game.aiEra | 0);
          const t = game.eraTier(a | 0, era);
          if (typeof t === 'number' && t >= 0) tier = t;
        }
        this.skillVoice(a | 0, b, tier);
        break;
      }

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

      // ── v3 원정 ──────────────────────────────────────────
      case E_STAGE_START:
        // a = 전투 번호, b = 사령관 인덱스. **여기서 테마가 갈린다**
        this.stage = clamp(a | 0, 0, 99);
        this.cmdIdx = clamp(b | 0, 0, CMD_N - 1);
        this.cmdSeen = true;
        this.campEnd = false;
        this.cmdMuteUntil = 0;
        this.readLevel = 0;
        if (this.ready) {
          this.readAt = this.ctx.currentTime;
          this.commanderCall(this.cmdIdx);
        }
        break;

      case E_STAGE_CLEAR:
        if (this.ready) this.stageClearVoice();
        break;

      case E_TAUNT:
        // a = 사령관 인덱스, b = 판정된 플레이어 프로파일
        this.tauntVoice(b);
        break;

      case E_CAMPAIGN_END:
        // a = 클리어 수, b = 1 이면 완주
        if (this.ready) this.campaignVoice((b | 0) === 1);
        break;

      case EV.RESET:
        // 곡을 처음부터 다시 전개시킨다. 노드는 그대로 둔다
        this.duckUntil = 0;
        this.cmdMuteUntil = 0;
        this.readLevel = 0;
        // 원정 종료 뒤 다시 시작하는 경로. 여기서 안 풀면 사령관 층이 영영 죽는다.
        // 진짜로 끝난 상태라면 update() 가 game.campaignOver 로 매 프레임 다시 세운다.
        this.campEnd = false;
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
