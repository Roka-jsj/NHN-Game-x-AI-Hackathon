// AI 디렉터 계층1 — 런타임. 로컬. 0ms. 절대 안 죽는다.
//
// 이건 난이도를 올리는 시스템이 아니다.
// 플레이어가 **어떻게 돈을 쓰는지 · 무엇을 뽑는지**를 판정하고,
// 그 반대편으로 적을 다시 짠다.
//
// 러너에서는 "어느 레인을 달리는가"를 읽었다. 여기서는 "무엇을 사는가"를 읽는다.
// 후자가 훨씬 강한 축이다 — 플레이어의 전략이 통째로 지표가 되기 때문이다.
//
// v2 에서 늘어난 것:
//   - 유닛 3종 → 6종. 레버의 mix 가 길이 6이다
//   - 상성표(C.COUNTER)를 읽어 **플레이어가 많이 뽑는 유닛을 잡는 유닛**을 늘린다.
//     이게 "AI가 판단한다"의 가장 직접적인 증거다 — 기병을 뽑으면 창병이 는다
//   - 포탑이 생겼으므로 "전선에 내보내지 않고 지키는 성향"을 따로 읽는다
//
// 규칙:
//  - 판정은 결정론적이다. Math.random() 을 쓰지 않는다. 재현 불가능해지면 증거가 못 된다
//  - 프레임 단위 로직에 손대지 않는다. 구간 경계에서만 개입한다
//  - 네트워크 호출은 같은 도메인 data/*.json 한 번뿐. API 키는 어디에도 없다
//  - data/*.json 이 죽어도 게임은 100% 돈다. 줄어드는 건 다양성뿐이다
//
// ★ 지표의 철칙 (러너에서 크게 데인 곳):
//   **모든 분모는 "그 구간에 실제로 가능했던 최대치"여야 한다.**
//   거기서는 분모를 잘못 잡아 두 프로파일이 구조적으로 판정 불가능했다.
//   여기서 분모는 전부 측정값이다 — 그 구간에 실제로 들어온 금, 실제로 번 경험치.

import * as C from './config.js';
import { EV, SIDE_L } from './game.js';

export const PROFILES = ['RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER', 'BALANCED'];
export const PROFILE_KR = ['돌격형', '수비형', '경제형', '물량형', '균형'];

export const REASONS = [
  '관찰 중',
  '쉬지 않고 병력을 쏟아붓는다',
  '금을 쌓아 두고 나오지 않는다',
  '금을 모아 두었다가 한 번에 쏟는다',
  '싼 유닛만 끝없이 뽑는다',
  '어느 쪽으로도 치우치지 않았다',
];

// 드래프트 제시 이유 — 문자열을 만들지 않기 위해 상수로 고정
export const DRAFT_REASONS = [
  '기본 구성으로 제시한다',
  '병력은 충분하다 — 버틸 것을 준다',
  '너무 웅크린다 — 나갈 이유를 준다',
  '경제가 앞선다 — 그 이점을 쓸 수단을 준다',
  '숫자로만 밀고 있다 — 한 방을 준다',
  '균형이 잡혀 있다 — 세 계열을 하나씩 준다',
];

const KINDS = C.UNIT_KINDS;

// game.js 가 v2 로 넘어가는 중이라 새 이벤트 코드가 아직 없을 수 있다.
// 계약(docs/spec-v2.md §7)이 번호를 못 박았으므로 없으면 그 번호로 메운다.
// 없는 이벤트는 그냥 안 들어올 뿐이고, 그래도 디렉터는 돈다.
const EV_TOWER_UP = intOr(EV && EV.TOWER_UP, 18);

// 유닛의 "싼 정도" — 0(가장 비쌈) ~ 1(가장 쌈).
// 물량 지향을 "가장 싼 유닛의 개수 비율"로 재면 6종에서는 너무 거칠다.
// 단가로 재면 창병·궁수를 섞어도 물량은 물량으로, 투석기를 섞으면 즉시 떨어진다.
// 시대 배수(ERA_COST_MUL)는 여섯 종에 똑같이 곱해지므로 정규화하면 사라진다.
const UNIT_CHEAP = (() => {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < KINDS; k++) {
    const c = C.U_COST[k];
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  const out = new Float32Array(KINDS);
  const span = hi - lo || 1;
  for (let k = 0; k < KINDS; k++) out[k] = 1 - (C.U_COST[k] - lo) / span;
  return out;
})();

// COUNTERS_OF[플레이어 유닛] = 그것을 **잡는** 유닛들.
// 표를 손으로 옮겨 적지 않는다. config 의 상성표에서 직접 읽는다 —
// 밸런스가 바뀌면 디렉터의 대응도 같이 바뀐다.
const COUNTERS_OF = (() => {
  const out = [];
  for (let u = 0; u < KINDS; u++) {
    const list = [];
    if (C.COUNTER && C.COUNTER.length === KINDS * KINDS) {
      for (let e = 0; e < KINDS; e++) if (C.COUNTER[e * KINDS + u] > 1) list.push(e);
    }
    out.push(list);
  }
  return out;
})();

class Ring {
  constructor(n) { this.a = new Float32Array(n); this.n = n; this.i = 0; this.c = 0; }
  reset() { this.i = 0; this.c = 0; this.a.fill(0); }
  push(v) { this.a[this.i] = v; this.i = (this.i + 1) % this.n; if (this.c < this.n) this.c++; }
  mean() {
    if (this.c === 0) return 0;
    let s = 0;
    for (let k = 0; k < this.c; k++) s += this.a[k];
    return s / this.c;
  }
  stdev() {
    if (this.c < 2) return 0;
    const m = this.mean();
    let s = 0;
    for (let k = 0; k < this.c; k++) { const d = this.a[k] - m; s += d * d; }
    return Math.sqrt(s / this.c);
  }
}

// ── 내장 폴백 웨이브 12개 ────────────────────────────────────
// data/*.json 이 죽어도 게임이 100% 돌아가게 하는 최소 라이브러리.
// 모듈 로드 시 한 번만 만든다. 루프 안이 아니다.
// mix 는 [검사, 창병, 궁수, 기병, 거인, 투석기] 가중치다.
const FALLBACK_CHUNKS = [];
for (let c = 0; c < 12; c++) {
  FALLBACK_CHUNKS.push({
    id: 'fallback-' + c,
    profile: 'BALANCED',
    difficulty: (c / 3) | 0,
    tags: ['mix'],
    mix: [
      5 - (c % 3), 2 + (c % 2), 3 - ((c / 6) | 0),
      1 + (c % 2), 1 + ((c / 4) | 0), (c % 3) === 0 ? 1 : 0,
    ],
    tempo: 1500 - (c % 4) * 120,
  });
}

// 문서 지시대로 폴백에서는 BALANCED 고정이다.
const FALLBACK_POLICY = {
  BALANCED: {
    mix: [4, 3, 3, 2, 2, 1], tempo: 1400, goldMul: 1, eraThresh: 1,
    waterMul: 1, draftSlant: 2, counterGain: 6, preferTags: ['mix'],
  },
};

// 전 프로파일 정책 — data/policy.json 이 살아 있을 때의 기본값.
// LLM 베이크가 이 표를 대체·확장한다. (tools/bake.js 의 POLICY 와 같은 표다)
//
// **핵심은 "반대편으로 짠다"이지 "더 세게"가 아니다.**
// mix = [검사, 창병, 궁수, 기병, 거인, 투석기]
// counterGain = 플레이어 구성에 반응해 상성 유닛에 더 얹는 총 가중치.
//   0이면 "구성을 안 본다". 클수록 플레이어가 뽑는 것에 직접 맞받는다.
// ★ 계측에서 배운 규칙: **가중치 0 은 "안 뽑는다"가 아니라 "이 종류로 때우지도
//   않는다"이다.** game.js 는 뽑기로 정한 유닛을 못 사면 잠시 기다렸다가
//   *가중치가 있는 것 중 가장 싼 것*으로 때운다. 그래서 벽을 세우라는 정책에
//   검사 가중치를 1이라도 남기면, 적의 수입으로는 검사만 계속 나와
//   구성이 통째로 무너진다 (첫 계측에서 적의 74%가 검사였다).
//   그래서 프로파일마다 **가장 싼 가중치 유닛이 그 성향에 맞는 유닛**이 되게 짠다.
const BUILTIN_POLICY = {
  // 돌격형 — 쉬지 않고 쏟아붓는다. 그러면 **벽을 세워 소모를 강요한다.**
  // 거인이 앞을 막고 창병이 기병 돌파를 끊고 궁수가 뭉친 근접을 녹인다.
  // 검사 0 — 못 사서 때울 때도 창병이어야 벽이 유지된다.
  // 템포는 느리다. 비싼 벽은 수가 적고, 대신 하나하나가 안 죽는다.
  RUSHER: {
    mix: [0, 3, 3, 0, 8, 1], tempo: 1900, goldMul: 1.3, eraThresh: 1.0,
    waterMul: 0.9, draftSlant: 1, counterGain: 4, preferTags: ['wall', 'mix'],
  },
  // 수비형 — 웅크린다. **원거리로 찔러 끌어내고 물을 빠르게 민다.**
  // 투석기는 기지 피해 배수(U_BASE_MUL)가 붙어 있다 — 웅크리면 기지가 깎인다.
  // 근접은 0이다. 웅크린 상대에게 근접을 보내면 그건 상대가 원하는 판이다.
  TURTLE: {
    mix: [0, 0, 6, 1, 0, 5], tempo: 1150, goldMul: 1.2, eraThresh: 1.0,
    waterMul: 1.35, draftSlant: 0, counterGain: 3, preferTags: ['ranged', 'mix'],
  },
  // 경제형 — 진화가 앞선다. **진화가 끝나기 전에 싼 유닛으로 두들긴다.**
  // 검사로 수를 채우고 기병(가장 빠르다)이 뒤를 파고든다. 템포가 가장 빠르다.
  ECONOMIST: {
    mix: [7, 1, 1, 5, 0, 0], tempo: 900, goldMul: 1.15, eraThresh: 0.8,
    waterMul: 1.0, draftSlant: 1, counterGain: 3, preferTags: ['rush', 'mix'],
  },
  // 물량형 — 싼 유닛만 뽑는다. **큰 유닛으로 숫자를 무의미하게 만든다.**
  // 거인이 좁은 전선을 막고, 궁수가 검사를 상성으로 녹인다.
  // 근접 싼 유닛(검사·창병)이 0이라 때울 때조차 궁수가 나온다 — 물량의 천적이다.
  SWARMER: {
    mix: [0, 0, 6, 0, 7, 3], tempo: 1700, goldMul: 1.25, eraThresh: 0.9,
    waterMul: 1.0, draftSlant: 0, counterGain: 5, preferTags: ['heavy', 'mix'],
  },
  // 균형 — 성향이 안 잡힌 상태다. 여기서 레버를 중립으로 두면 디렉터는
  // **대부분의 판에서 아무것도 안 하는 장식**이 된다 (러너에서 실제로 겪었다).
  // 그래서 균형일수록 상성 대응을 가장 세게 건다 — 성향이 없으면 구성을 본다.
  BALANCED: {
    mix: [4, 3, 3, 2, 2, 1], tempo: 1400, goldMul: 1, eraThresh: 1,
    waterMul: 1, draftSlant: 2, counterGain: 6, preferTags: ['mix'],
  },
};

// ── 사령관 인격 — 그 전투의 **기본 성격** ────────────────────
//
// ★ 여기가 v3 의 핵심 구조다. 층이 둘이다.
//   1층(인격) 사령관이 원래 어떤 군대를 굴리는가. 전투 내내 안 바뀐다.
//   2층(판독) 디렉터가 플레이어를 읽고 그 위에 덧칠한다. 9초마다 바뀐다.
//   **둘을 섞지 않는다.** 사령관이 디렉터를 대체하면 판독이 안 보이고,
//   디렉터가 사령관을 덮으면 다섯 명이 전부 같은 얼굴이 된다.
//
// BUILTIN_POLICY 와 헷갈리지 마라. 저건 **플레이어 프로파일에 대한 대응책**이고
// (키가 플레이어의 성향이다), 이건 **적 자신의 성격**이다 (키가 사령관이다).
// 무리(SWARMER)가 궁수·거인을 뽑으면 안 된다 — 그건 물량형을 *잡는* 구성이지
// 물량형 자신의 구성이 아니다. 이름과 화면이 어긋나면 사령관은 얼굴이 아니다.
//
// readW = 판독층의 지분. 0이면 플레이어를 무시하고 제 성격대로만 간다.
//   **거울이 0.85 로 가장 높다.** 마지막 사령관은 플레이어를 따라오므로
//   도배가 안 통해야 한다는 것이 계약(§3)이다.
const PERSONA = [
  // 0 무리 (SWARMER) — 싼 것을 빨리, 많이. 가장 읽기 쉬운 상대다 (가르치는 전투)
  { mix: [8, 5, 2, 1, 0, 0], tempo: 980, readW: 0.25, cg: 3,
    goldMul: 1.00, eraThresh: 1.05, waterMul: 0.95, tags: ['rush', 'mix'] },
  // 1 쇄도 (RUSHER) — 빠른 것으로 계속 찌른다. 기병 중심, 템포가 가장 빠르다
  { mix: [4, 2, 0, 8, 1, 0], tempo: 880, readW: 0.32, cg: 4,
    goldMul: 1.05, eraThresh: 1.00, waterMul: 1.00, tags: ['rush', 'mix'] },
  // 2 금고 (ECONOMIST) — 모아서 비싼 것을 낸다. 진화가 빠르다(문턱 0.75)
  { mix: [1, 1, 3, 2, 5, 4], tempo: 1450, readW: 0.42, cg: 4,
    goldMul: 1.10, eraThresh: 0.75, waterMul: 1.00, tags: ['heavy', 'mix'] },
  // 3 성벽 (TURTLE) — 벽을 세우고 원거리로 갉는다. 물을 밀어 **시계**로 이긴다
  { mix: [0, 5, 6, 0, 5, 3], tempo: 1550, readW: 0.42, cg: 4,
    goldMul: 1.05, eraThresh: 0.95, waterMul: 1.30, tags: ['wall', 'ranged'] },
  // 4 거울 (BALANCED) — **플레이어를 읽고 따라온다.** 판독 지분이 가장 크고
  //   상성 대응이 가장 세다. 한 종류 도배는 여기서 반드시 벌을 받아야 한다
  { mix: [3, 3, 3, 3, 2, 2], tempo: 1180, readW: 0.85, cg: 7,
    goldMul: 1.05, eraThresh: 0.90, waterMul: 1.05, tags: ['mix'] },
];

// ── 도배 처벌 계수 — "읽히면 손해" ───────────────────────────
//
// ★ 이 프로젝트의 난이도 설계 전체가 이 네 줄에 있다.
//   나쁜 난이도는 적 체력·수입을 그냥 올리는 것이다. 그러면 잘 하는 플레이어와
//   못 하는 플레이어가 **똑같이** 느려질 뿐 아무도 배우지 못한다.
//   좋은 난이도는 **실수를 처벌**한다. 이 게임에서 실수는 하나로 정의된다:
//   **한 종류만 뽑는 것.** 상성 삼각형이 있는 게임에서 구성이 한 점에 몰리면
//   그건 "나를 잡는 유닛 하나만 뽑으면 된다"고 적에게 알려주는 것과 같다.
//
//   focus = 플레이어 구성의 집중도(0=고르게, 1=한 종류). 정규화 허핀달이다.
//   focus 가 0 이면 아래 계수는 **전부 1배** — 다양하게 쓰는 플레이어는
//   난이도가 하나도 안 오른다. 이게 "곡선이지 상수가 아니다"의 실제 구현이다.
const FOCUS_CG = 1.6;      // 상성 대응 가중치 ×(1+1.6·focus)
const FOCUS_TEMPO = 0.30;  // 소환 간격 ×(1−0.30·focus)  — 도배 상대에겐 더 빨리 나온다
const FOCUS_GOLD = 0.34;   // 적 수입 ×(1+0.34·focus)
const FOCUS_ERA = 0.20;    // 적 진화 문턱 ×(1−0.20·focus)
// 새 전투가 시작돼도 사령관은 **앞 전투에서 본 것을 기억한다.**
// 원정이 여정이라면 정보도 이어져야 한다 — 2전투부터는 첫 9초부터 맞받는다.
// 기억은 현재 창이 차면서 사라진다 (MEM_FADE 구간 뒤엔 지분 0).
const MEM_FADE = 3;

const FALLBACK_LINES = {
  death: ['기지가 무너졌다', '한 파도 늦었다', '아끼다 잠겼다'],
  record: ['적진을 넘었다'],
  revive: ['다시'],
};

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function intOr(v, d) { return Number.isInteger(v) ? v : d; }

export class Director {
  constructor(game) {
    this.game = game;

    // 지표 — 최근 8구간 슬라이딩 윈도
    this.wAggro = new Ring(C.METRIC_WINDOW);   // 유입 금 중 병력에 쓴 비중
    this.wHoard = new Ring(C.METRIC_WINDOW);   // 쌓아 둘 수 있었던 만큼 쌓아 뒀는가
    this.wSwarm = new Ring(C.METRIC_WINDOW);   // 뽑은 유닛의 싼 정도 (단가 기준)
    this.wTower = new Ring(C.METRIC_WINDOW);   // 전선이 아니라 기지에 쓴 정도
    this.wFront = new Ring(C.METRIC_WINDOW);   // 전선 위치
    // 경제 지향은 **두 개의 합**으로 잡는다. 한 구간에 진화가 0번인 것이 정상이라
    // 구간마다 비율을 내면 0과 1 사이를 튄다. 윈도 합끼리 나눠야 안정적이다.
    this.wXpEarn = new Ring(C.METRIC_WINDOW);  // 그 구간에 실제로 번 경험치
    this.wXpEra = new Ring(C.METRIC_WINDOW);   // 그중 시대에 넣은 경험치
    // 플레이어 구성 — 상성 대응의 입력. 개수를 담고 총합으로 나눈다.
    this.wKind = [];
    for (let k = 0; k < KINDS; k++) this.wKind.push(new Ring(C.METRIC_WINDOW));
    this.wSpawnN = new Ring(C.METRIC_WINDOW);

    this.profile = 'BALANCED';
    this.profileIdx = 4;
    this.observing = true;
    this.reasonIdx = 0;
    this.draftReason = DRAFT_REASONS[0];
    this.switches = 0;
    // 판정이 **바뀐 순간**을 밖에서 감지할 수 있어야 한다 — 사령관의 도발이
    // 여기 걸린다 (계약 §3: "AI 가 나를 읽었다"가 문장으로 나타나는 순간).
    // 한 스텝 동안만 true 다. game.js 는 profileIdx 변화로도 감지할 수 있지만,
    // 그건 "같은 프로파일로 다시 판정" 을 못 잡는다. 이 플래그는 잡는다.
    this.justSwitched = false;
    this.switchAtMs = -1e9;

    this.difficulty = 0;

    // 사령관 — game.js 가 setCommander() 로 알려준다.
    // **안 알려줘도 돈다.** 원정이 아직 안 붙은 game.js 에서는 -1 로 남고
    // 예전과 똑같이 동작한다 (인격층 없이 판독층만).
    this.commanderIdx = -1;
    this.commanderProfile = null;
    this.stage = 0;
    this.stageK = 1;

    // 사령관의 기억 — 앞 전투에서 플레이어가 무엇을 뽑았는가.
    // 원정 첫 전투(stage 0)에서는 비어 있다. 가르치는 전투는 백지로 시작한다.
    this.memShare = new Float32Array(KINDS);
    this.memWeight = 0;
    this.effShare = new Float32Array(KINDS);

    this.chunks = FALLBACK_CHUNKS;
    this.policy = BUILTIN_POLICY;
    this.lines = FALLBACK_LINES;
    this.usingFallback = true;
    this.librarySize = FALLBACK_CHUNKS.length;
    this.deathLine = FALLBACK_LINES.death[0];

    this.candidates = new Int32Array(512);
    this.lastChunk = -1;
    this.lastSwitchChunk = -99;

    // 레버의 mix 는 매번 새로 만들지 않고 이 버퍼를 덮어쓴다.
    // **데이터의 배열을 그대로 넘기면 안 된다** — 상성 보정이 라이브러리를 영구히 오염시킨다.
    this.mixBuf = new Array(KINDS).fill(0);
    this.spawnKind = new Int32Array(KINDS);
    this.mixShare = new Float32Array(KINDS);

    this.levers = null;
    this.resetCounters();
    this.beginChunk(game);
    this.applyLevers();
    game.supplier = this;
  }

  resetCounters() {
    this.spawnCount = 0;
    this.cheapSum = 0;
    this.spawnKind.fill(0);
    this.goldSum = 0;
    this.goldSamples = 0;
    this.spawnGold = 0;      // 이벤트로 직접 센 병력 지출 (game 이 안 세줄 때의 대비)
    this.towerGold = 0;
    this.eraXpSpent = 0;
    this.draftAtk = 0;
    this.draftDef = 0;
  }

  // 구간이 시작될 때의 스냅샷. 분모를 "이 구간에 실제로 가능했던 최대치"로
  // 잡으려면 시작값을 알아야 한다.
  beginChunk(game) {
    this.resetCounters();
    this.goldAtStart = game ? num(game.gold, 0) : 0;
    this.xpAtStart = game ? num(game.xp, 0) : 0;
    // game.goldSpentUnits 에는 **포탑 값이 들어 있다** (game.js 가 그렇게 센다).
    // 공격성은 전선에 나간 금만 세야 하므로 포탑을 따로 빼둔다.
    this.unitGoldAtStart = game ? num(game.goldSpentUnits, NaN) : NaN;
    this.towerGoldAtStart = game ? num(game.goldSpentTower, NaN) : NaN;
  }

  // ── 계층 2 산출물 로딩 ──────────────────────────────────────
  // 실패·파손·스키마 불일치는 전부 폴백이다. console.warn 한 줄만 남기고
  // 사용자 화면에는 아무 표시도 하지 않는다.
  async load() {
    try {
      const [c, p, l] = await Promise.all([
        fetch(C.DATA_CHUNKS).then((r) => r.json()),
        fetch(C.DATA_POLICY).then((r) => r.json()),
        fetch(C.DATA_LINES).then((r) => r.json()),
      ]);
      if (!validateChunks(c)) throw new Error('chunks schema');
      if (!validatePolicy(p)) throw new Error('policy schema');
      if (!validateLines(l)) throw new Error('lines schema');
      this.chunks = c.chunks;
      this.librarySize = c.chunks.length;
      this.policy = mergePolicy(p.policies);
      this.lines = l;
      this.usingFallback = false;
      if (c.generator && c.generator.indexOf('placeholder') >= 0) {
        console.info('[director] data/chunks.json 은 오프라인 플레이스홀더다. D-3 베이크로 교체해야 한다.');
      }
    } catch (e) {
      console.warn('[director] 계층2 데이터를 쓸 수 없어 내장 폴백으로 동작한다:', e.message);
      this.chunks = FALLBACK_CHUNKS;
      this.policy = FALLBACK_POLICY;
      this.lines = FALLBACK_LINES;
      this.usingFallback = true;
      this.librarySize = FALLBACK_CHUNKS.length;
    }
    this.applyLevers();
  }

  // ── 사령관 연결 — game.js 가 전투 시작마다 부른다 ────────────
  // 서명은 계약이다: setCommander(사령관 인덱스, 전투 번호, 프로파일 이름).
  // **셋 다 없어도 안 죽는다.** game.js 가 아직 원정을 안 붙였으면 아예 안 불린다.
  setCommander(idx, stage, profileName) {
    const n = PERSONA.length;
    this.commanderIdx = Number.isInteger(idx) && idx >= 0 ? idx % n : -1;
    this.stage = Number.isInteger(stage) && stage >= 0 ? stage : 0;
    // 프로파일 이름은 game.js 가 주는 것을 그대로 믿지 않는다 — 오타 하나에
    // 정책이 통째로 BALANCED 로 떨어지면 원인을 아무도 못 찾는다.
    const p = typeof profileName === 'string' ? profileName : null;
    this.commanderProfile = p && PROFILES.indexOf(p) >= 0
      ? p : (this.commanderIdx >= 0 && C.COMMANDER_PROFILE
        ? C.COMMANDER_PROFILE[this.commanderIdx] : null);

    // 스테이지 곡선을 **처벌 강도**에 태운다. 수입·체력 곡선은 game.js 소관이라
    // 여기서 또 곱하면 두 번 곱해진다 (계측에서 실제로 겪은 실패다).
    // 여기서 쓰는 것은 "실수를 얼마나 아프게 처벌하는가" 하나뿐이다.
    const sd = C.STAGE_DIFF && C.STAGE_DIFF.length
      ? num(C.STAGE_DIFF[Math.min(this.stage, C.STAGE_DIFF.length - 1)], 1) : 1;
    this.stageK = clamp(sd, 0.5, 2);

    // 첫 전투는 가르치는 전투다 — 기억 없이 백지에서 시작한다.
    if (this.stage <= 0) { this.memWeight = 0; this.memShare.fill(0); }
    this.applyLevers();
  }

  onRunStart() {
    // 창을 비우기 **전에** 플레이어 구성을 기억으로 옮긴다.
    // (game.js 는 전투마다 onRunStart() → setCommander() 순서로 부른다.
    //  stage 0 이면 setCommander 가 이 기억을 곧바로 지운다)
    this.rememberMix();
    this.wAggro.reset(); this.wHoard.reset(); this.wSwarm.reset();
    this.wTower.reset(); this.wFront.reset();
    this.wXpEarn.reset(); this.wXpEra.reset(); this.wSpawnN.reset();
    for (let k = 0; k < KINDS; k++) this.wKind[k].reset();
    this.beginChunk(this.game);
    this.lastChunk = -1;
    this.lastSwitchChunk = -99;
    this.observing = true;
    this.reasonIdx = 0;
    this.switches = 0;
    this.difficulty = 0;
    this.profile = 'BALANCED';
    this.profileIdx = 4;
    this.justSwitched = false;
    this.switchAtMs = -1e9;
    this.applyLevers();
  }

  // 이번 전투의 플레이어 구성을 기억으로 넘긴다. 표본이 없으면 손대지 않는다 —
  // 빈 기억으로 덮으면 앞 전투에서 배운 것이 사라진다.
  rememberMix() {
    const tot = this.wSpawnN.mean();
    if (!(tot > 0.5)) return;
    for (let k = 0; k < KINDS; k++) {
      this.memShare[k] = clamp(this.wKind[k].mean() / tot, 0, 1);
    }
    this.memWeight = 1;
  }

  // ── 이벤트 수신 — 지표 수집 ─────────────────────────────────
  onEvent(type, a, b, game) {
    switch (type) {
      case EV.SPAWN:
        if (b === SIDE_L && a >= 0 && a < KINDS) {
          this.spawnCount++;
          this.spawnKind[a]++;
          this.cheapSum += UNIT_CHEAP[a];
          this.spawnGold += game && typeof game.cost === 'function'
            ? num(game.cost(a), C.U_COST[a]) : C.U_COST[a];
        }
        break;
      case EV.ERA_UP:
        // a = 새 시대. 그 시대에 들어가느라 낸 경험치가 곧 "시대에 넣은 투자"다.
        if (b === SIDE_L && a > 0 && a < C.ERA_XP.length) this.eraXpSpent += C.ERA_XP[a];
        break;
      case EV_TOWER_UP:
        // a = 새 단계(1~2). 전선이 아니라 기지에 쓴 금이다.
        if (a > 0 && a <= C.TOWER_COST.length) this.towerGold += C.TOWER_COST[a - 1];
        break;
      case EV.DRAFT_PICK:
        if (b === 0) this.draftAtk++; else if (b === 1) this.draftDef++;
        break;
      case EV.LOSE: this.pickDeathLine(game); break;
      default: break;
    }
  }

  // ── 매 스텝 — 구간 경계 감지와 표본 수집 ─────────────────────
  step(game) {
    // 도발 플래그는 **딱 한 스텝** 살아 있다. 켜진 스텝에 game.js·렌더가
    // 읽고, 다음 스텝에 꺼진다. 여기서 끄면 "켜진 채로 잊히는" 일이 없다.
    if (this.justSwitched && game.simTime > this.switchAtMs) this.justSwitched = false;

    this.goldSum += game.gold;
    this.goldSamples++;

    const ci = (game.simTime / C.CHUNK_MS) | 0;
    if (ci !== this.lastChunk) {
      if (this.lastChunk >= 0) this.closeChunk(game);
      this.lastChunk = ci;
      this.beginChunk(game);
      this.onChunkBoundary(game, ci);
    }
  }

  // 구간이 끝날 때 그 구간의 지표를 윈도에 밀어 넣는다.
  //
  // ★ 러너에서 배운 것: **모든 지표는 도달 가능한 범위로 정규화해야 한다.**
  //   거기서는 분모를 잘못 잡아 RECKLESS 와 PRECISE 가 구조적으로 판정 불가능했다.
  //   그래서 여기서는 분모를 전부 **측정값**으로 잡는다 —
  //   "그 구간에 실제로 들어온 금", "그 구간에 실제로 번 경험치".
  //   상수로 박은 분모는 시대·특성·처치 보상이 바뀌는 순간 도달 불가능해진다.
  closeChunk(game) {
    const secs = C.CHUNK_MS / 1000;

    // 이 구간에 쓴 금. game 이 세주면 그걸 쓰고(무료 증원이 안 섞인다),
    // 아니면 소환·포탑 이벤트로 직접 센 값을 쓴다.
    const spentNow = num(game.goldSpentUnits, NaN);
    const towerNow = num(game.goldSpentTower, NaN);
    const haveGameCount = Number.isFinite(spentNow) && Number.isFinite(this.unitGoldAtStart);
    const towerGold = Number.isFinite(towerNow) && Number.isFinite(this.towerGoldAtStart)
      ? Math.max(0, towerNow - this.towerGoldAtStart) : this.towerGold;
    // 포탑은 전선에 나가지 않는 금이다. 공격성에서 빼고 "지키는 성향"으로 센다.
    const spent = haveGameCount
      ? Math.max(0, spentNow - this.unitGoldAtStart) : (this.spawnGold + towerGold);
    const spentUnits = Math.max(0, spent - towerGold);

    // 이 구간에 **실제로 들어온 금** = 보유 변화 + 그 사이에 쓴 금.
    // 수입 특성(광맥)·처치 보상·진화 보너스가 전부 여기 들어간다.
    // 상수(GOLD_RATE)로 박으면 특성 하나에 분모가 틀어진다.
    let income = (num(game.gold, 0) - this.goldAtStart) + spent;
    const floorIncome = C.GOLD_RATE * secs * 0.5;
    if (!(income > floorIncome)) income = floorIncome;

    // 공격성 — 들어온 금을 전선으로 얼마나 내보냈는가.
    // 1.0 = 들어온 만큼 전부 병력으로 바꿨다. **쿨다운이 아니라 금이 한계다** —
    // 검사 쿨다운(420ms)으로는 구간당 21기가 가능하지만 수입으로는 5기가 한계다.
    // 쿨다운을 분모로 잡으면 최대치가 0.24 라 TH_AGGRO_HIGH(0.62)가 도달 불가능하다.
    this.wAggro.push(clamp(spentUnits / income, 0, 1));

    // 쌓아 두는 정도 — 이 구간에 **쌓을 수 있었던 최대 평균 보유액** 대비.
    // 한 푼도 안 쓰면 보유는 시작값에서 유입만큼 선형으로 오른다 →
    // 그때의 평균이 goldAtStart + income/2 다. 상한(GOLD_CAP)에 막히면 그게 최대다.
    const avg = this.goldSamples > 0 ? this.goldSum / this.goldSamples : num(game.gold, 0);
    let maxAvg = Math.min(C.GOLD_CAP, this.goldAtStart + income * 0.5);
    if (maxAvg < C.U_COST[C.U_SWORD]) maxAvg = C.U_COST[C.U_SWORD];
    this.wHoard.push(clamp(avg / maxAvg, 0, 1));

    // 진화 전환율 — **번 경험치 중 시대에 넣은 비중.** (판정에는 안 쓴다)
    //   분자·분모가 같은 단위(경험치)다. 진화는 금이 아니라 경험치를 쓴다 —
    //   금 지출과 비교하던 예전 식은 단위가 서로 달라 애초에 비율이 아니었다.
    //   **재 보니 상한이 0.42 였다.** 시대 요구치(240·640·1300·2400)가 벌이보다
    //   훨씬 느리게 열려서, 번 경험치의 대부분은 늘 "아직 안 쓴" 상태로 남는다.
    //   그래서 이 값으로는 프로파일을 가를 수 없다 (classify 주석 참고).
    //   다만 **진화를 아예 안 하는 사람 0.05 / 하는 사람 0.35** 로는 갈려서
    //   디렉터 뷰에 그대로 보여준다. 판정에 못 쓴다고 못 보여줄 이유는 없다.
    const earned = Math.max(0, (num(game.xp, 0) - this.xpAtStart) + this.eraXpSpent);
    this.wXpEarn.push(earned);
    this.wXpEra.push(this.eraXpSpent);

    // 물량 지향 — 뽑은 유닛의 단가. 전부 검사면 1.0, 전부 투석기면 0.0.
    this.wSwarm.push(this.spawnCount > 0 ? clamp(this.cheapSum / this.spawnCount, 0, 1) : 0.5);

    // 지키는 성향 — 포탑은 전선에 나가지 않는 금이다. 0 / 0.5 / 1.
    this.wTower.push(clamp(num(game.towerLv, 0) / C.TOWER_MAX, 0, 1));

    // 플레이어 구성 — 상성 대응의 입력. 개수 그대로 담고 총합으로 나눈다.
    for (let k = 0; k < KINDS; k++) this.wKind[k].push(this.spawnKind[k]);
    this.wSpawnN.push(this.spawnCount);

    this.wFront.push(typeof game.frontline === 'function' ? game.frontline() : 0.5);
  }

  onChunkBoundary(game, ci) {
    // 난이도는 경과 시간으로 오른다. 0~4.
    // **원정에서는 스테이지가 바닥을 올린다** — 4전투에서 0초에 나오는 웨이브가
    // 1전투 0초와 같으면 원정은 같은 판을 다섯 번 하는 것이다.
    // 바닥은 stage−1 이다. stage 를 그대로 바닥으로 쓰면 마지막 전투가 시작
    // 3초 만에 최고 난이도 웨이브로 시작해 "가르치는 구간"이 통째로 사라진다.
    const byTime = clamp((game.simTime / 22000) | 0, 0, 4);
    const floor = clamp(this.stage - 1, 0, 4);
    this.difficulty = byTime > floor ? byTime : floor;

    if (ci < C.OBSERVE_CHUNKS) { this.observing = true; this.applyLevers(); return; }
    this.observing = false;

    const aggro = this.metricAggro;
    const hoard = this.metricHoard;
    const swarm = this.metricSwarm;
    const tower = this.metricTower;

    // 히스테리시스 — **판정을 바꾸려면 경계를 0.05 만큼 넘어야 한다.**
    // 유지하는 데는 아무 조건도 없다. 예전에는 "아무 지표든 아무 경계 근처면
    // 직전 판정을 유지"였는데, 경계가 일곱 개라 지표 하나가 우연히 어딘가에
    // 걸치면 **판정이 통째로 얼어붙었다** — 기병만 뽑는 봇이 aggro 0.98 로
    // 명백한 돌격형인데도 swarm 이 0.63(경계 0.66 근처)이라 균형에 갇혔다.
    const raw = classify(aggro, hoard, swarm, tower, 0);
    let next = raw;
    if (raw !== this.profile && classify(aggro, hoard, swarm, tower, C.HYSTERESIS) !== raw) {
      next = this.profile;
    }
    // 방금 바꿨으면 잠시 유지한다. 레버가 세계를 바꾼 결과를 보고 다시 판정해야
    // 하는데, 즉시 재판정하면 자기 정책의 효과에 반응해 진동한다.
    // (러너에서 SAFE 정책이 SAFE 판정을 스스로 무너뜨리는 진동을 겪었다)
    if (next !== this.profile && ci - this.lastSwitchChunk < C.PROFILE_DWELL) next = this.profile;
    if (next !== this.profile) {
      this.lastSwitchChunk = ci;
      this.profile = next;
      this.profileIdx = PROFILES.indexOf(next);
      this.reasonIdx = this.profileIdx + 1;
      this.switches++;
      // 도발이 걸리는 지점. 한 스텝만 켜져 있다 (step 이 다음 스텝에 끈다).
      this.justSwitched = true;
      this.switchAtMs = game ? num(game.simTime, 0) : 0;
    }
    this.applyLevers();
  }

  applyLevers() {
    const p = this.policy[this.profile] || this.policy.BALANCED || FALLBACK_POLICY.BALANCED;
    const d = this.difficulty;
    // 사령관 인격. 원정이 안 붙었으면 null 이고, 그때는 예전과 똑같이 돈다.
    const per = this.commanderIdx >= 0 ? PERSONA[this.commanderIdx] : null;

    // 구운 웨이브가 있으면 판독층의 구성비를 거기서 가져온다 (계층2 산출물).
    // 없으면 정책의 기본 구성이다.
    const tags = per ? per.tags : p.preferTags;
    const ch = this.selectChunk(p.preferTags);
    const read = ch && Array.isArray(ch.mix) ? ch.mix : p.mix;
    const m = this.mixBuf;

    // ── 두 층을 섞는다 ────────────────────────────────────────
    // 합이 다른 두 표를 그냥 더하면 **합이 큰 쪽이 조용히 이긴다.**
    // (인격 합 16 · 청크 합 17 처럼 우연히 비슷할 때는 안 보이다가,
    //  청크 하나가 합 24 로 구워지는 순간 인격이 사라진다)
    // 그래서 둘 다 합 10 으로 정규화한 뒤 지분으로 섞는다.
    const w = per ? clamp(num(per.readW, 0.5), 0, 1) : 1;
    let sr = 0, sp = 0;
    for (let k = 0; k < KINDS; k++) {
      sr += num(read[k], 0) > 0 ? num(read[k], 0) : 0;
      if (per) sp += num(per.mix[k], 0) > 0 ? num(per.mix[k], 0) : 0;
    }
    const kr = sr > 0 ? 10 / sr : 0;
    const kp = sp > 0 ? 10 / sp : 0;
    for (let k = 0; k < KINDS; k++) {
      const rv = Math.max(0, num(read[k], 0)) * kr;
      const pv = per ? Math.max(0, num(per.mix[k], 0)) * kp : 0;
      m[k] = per ? pv * (1 - w) + rv * w : rv;
    }

    // ── 도배 처벌 — 이 판의 난이도는 여기서 결정된다 ───────────
    // focus 는 플레이어가 **얼마나 읽히는가**다. 고르게 쓰면 0, 한 종류면 1.
    // 아래 네 배수는 focus 가 0 이면 전부 1배다 — 다양하게 쓰는 플레이어에게는
    // 난이도가 1g 도 오르지 않는다. 실수한 사람만 벌을 받는다.
    const focus = this.metricFocus;
    const sk = num(this.stageK, 1);          // 뒤 전투일수록 처벌이 날카롭다
    const bite = clamp(focus * sk, 0, 1.6);

    const cgBase = per ? num(per.cg, num(p.counterGain, 0)) : num(p.counterGain, 0);
    this.applyCounter(m, cgBase * (1 + FOCUS_CG * bite));

    // 템포 — 구운 웨이브의 tempo 에는 난이도가 이미 들어 있으므로 거기에
    // **또** 난이도를 곱하지 않는다 (예전에 두 번 깎여 다섯 프로파일이 전부
    // 하한 420ms 에 붙었다). 인격 템포와 섞고, 처벌만 곱한다.
    const readTempo = ch ? num(ch.tempo, p.tempo) : p.tempo * (1 - d * 0.11);
    const baseTempo = per ? num(per.tempo, readTempo) * (1 - w) + readTempo * w : readTempo;
    const tempo = baseTempo * (1 - FOCUS_TEMPO * bite);

    const goldMul = (per ? num(per.goldMul, 1) : 1) * p.goldMul * (1 + d * 0.1)
      * (1 + FOCUS_GOLD * bite);
    const eraThresh = (per ? num(per.eraThresh, 1) : 1) * p.eraThresh
      * (1 - FOCUS_ERA * bite);

    this.levers = {
      mix: m,
      tempo: Math.max(420, tempo),
      goldMul,
      eraThresh: Math.max(0.4, eraThresh),
      waterMul: (per ? num(per.waterMul, 1) : 1) * p.waterMul,
      draftSlant: p.draftSlant,
      preferTags: tags,
      // ↓ game.js 가 아직 안 읽는다. 읽으면 사령관이 스킬·포탑까지 성격대로 쓴다.
      //   (지금은 game.js 가 C.CMD_SKILL_MUL / C.CMD_TOWER 로 직접 정한다)
      skillBias: 1 + 0.5 * bite,
      towerWant: per && per.tags.indexOf('wall') >= 0 ? 2 : (this.stage > 1 ? 1 : 0),
    };
  }

  // ── 상성 대응 — "AI가 판단한다"의 가장 직접적인 증거 ─────────
  // 플레이어가 기병을 많이 뽑으면 창병이 늘고, 검사를 도배하면 궁수가 는다.
  // 프로파일(성향)이 판의 뼈대를 정하고, 여기서 **플레이어의 실제 구성**에
  // 반응해 살을 붙인다. 결정론적이다 — 같은 플레이면 같은 대응이 나온다.
  applyCounter(m, gain) {
    if (!(gain > 0)) return;
    if (!this.loadShare()) return;
    for (let u = 0; u < KINDS; u++) {
      const share = this.effShare[u];
      if (share <= 0) continue;
      const list = COUNTERS_OF[u];
      // 한 유닛을 여러 종이 잡으면 나눠 준다. 총 가중치는 gain 을 넘지 않는다.
      const add = gain * share / (list.length || 1);
      for (let i = 0; i < list.length; i++) m[list[i]] += add;
    }
    for (let k = 0; k < KINDS; k++) m[k] = Math.round(m[k] * 100) / 100;
  }

  // 상성 대응과 도배 판정이 함께 쓰는 **유효 구성비**를 effShare 에 채운다.
  // 이번 전투의 관측 + 앞 전투의 기억. 기억은 관측이 쌓이면서 사라진다.
  // 돌려주는 값: 쓸 만한 표본이 있는가.
  loadShare() {
    const tot = this.wSpawnN.mean();
    const have = tot > 0.5;
    // 기억 지분 — 이번 전투에서 본 구간이 MEM_FADE 개를 넘으면 0 이다.
    // 이게 없으면 사령관은 매 전투 백지에서 시작하고, 도배는 매번 처음
    // 두세 구간을 공짜로 얻는다. 원정이 여정이라면 정보도 이어져야 한다.
    const seen = this.wSpawnN.c;
    const mw = this.memWeight > 0 ? clamp((MEM_FADE - seen) / MEM_FADE, 0, 1) : 0;
    if (!have && mw <= 0) return false;
    // 관측이 아직 없으면(전투 첫 구간) 기억만으로 대응한다.
    for (let u = 0; u < KINDS; u++) {
      const now = have ? clamp(this.wKind[u].mean() / tot, 0, 1) : 0;
      this.effShare[u] = have ? now * (1 - mw) + this.memShare[u] * mw : this.memShare[u];
    }
    return true;
  }

  // ── 웨이브 선택 — 결정론적. Math.random() 없음 ───────────────
  selectChunk(tags) {
    if (!this.chunks || this.chunks.length === 0) return null;
    let n = this.collect(this.profile, this.difficulty, tags);
    if (n === 0) n = this.collect(this.profile, this.difficulty, null);
    if (n === 0) n = this.collect(this.profile, -1, null);
    // **다른 프로파일의 웨이브로는 절대 메우지 않는다.**
    // 예전엔 마지막 수단으로 아무 웨이브나 집었는데, 폴백 라이브러리가 전부
    // BALANCED 라서 다섯 프로파일이 전부 같은 구성을 냈다. 계측에서 잡혔다 —
    // RUSHER 와 SWARMER 의 적 구성 차이가 정확히 0.00 이었다.
    // 프로파일 전용 웨이브가 없으면 null 을 돌려주고 **정책의 기본 구성**을 쓴다.
    // 정책은 언제나 프로파일별로 다르므로 그게 항상 더 낫다.
    if (n === 0) return null;
    // 구간 인덱스로 순환한다. 같은 판이면 같은 순서가 나온다.
    const pick = this.candidates[Math.abs(this.lastChunk * 7 + this.switches) % n];
    return this.chunks[pick];
  }

  collect(profile, difficulty, tags) {
    let n = 0;
    for (let i = 0; i < this.chunks.length && n < this.candidates.length; i++) {
      const c = this.chunks[i];
      if (profile && c.profile !== profile) continue;
      if (difficulty >= 0 && c.difficulty !== difficulty) continue;
      if (tags && tags.length) {
        let hit = false;
        for (let t = 0; t < tags.length; t++) {
          if (c.tags && c.tags.indexOf(tags[t]) >= 0) { hit = true; break; }
        }
        if (!hit) continue;
      }
      this.candidates[n++] = i;
    }
    return n;
  }

  // ── 특성 드래프트 — 디렉터의 전시장 ─────────────────────────
  // **어떤 셋을 제시할지가 곧 판단이다.** 화면에 이유가 한 줄 뜬다.
  draftOffer(game, out) {
    this.draftReason = DRAFT_REASONS[this.observing ? 0 : this.profileIdx + 1];
    const slant = this.levers.draftSlant;   // 0=공격 1=방어 2=혼합
    let n = 0;
    // 1) 성향에 맞는 계열에서 먼저 채운다
    if (slant < 2) {
      for (let i = 0; i < C.TRAITS.length && n < C.TRAIT_OFFER - 1; i++) {
        if (game.traits[i]) continue;
        if (C.TRAITS[i].kind !== slant) continue;
        out[n++] = i;
      }
    } else {
      // 혼합 — 세 계열을 하나씩
      for (let k = 0; k < 3 && n < C.TRAIT_OFFER; k++) {
        for (let i = 0; i < C.TRAITS.length; i++) {
          if (game.traits[i] || C.TRAITS[i].kind !== k) continue;
          let dup = false;
          for (let q = 0; q < n; q++) if (out[q] === i) dup = true;
          if (!dup) { out[n++] = i; break; }
        }
      }
    }
    // 2) 남으면 아무거나 채운다
    const start = (game.era * 5 + this.switches) % C.TRAITS.length;
    for (let k = 0; k < C.TRAITS.length && n < C.TRAIT_OFFER; k++) {
      const i = (start + k) % C.TRAITS.length;
      if (game.traits[i]) continue;
      let dup = false;
      for (let q = 0; q < n; q++) if (out[q] === i) dup = true;
      if (dup) continue;
      out[n++] = i;
    }
    while (n < C.TRAIT_OFFER) out[n++] = -1;
  }

  pickDeathLine(game) {
    const pool = this.lines.death;
    if (!pool || pool.length === 0) return;
    this.deathLine = pool[((game ? game.runs * 7 + (game.kills | 0) : 0)) % pool.length];
  }

  // ── 디렉터 뷰가 읽는 값 ─────────────────────────────────────
  get profileName() { return PROFILE_KR[this.profileIdx] || PROFILE_KR[4]; }
  get metricAggro() { return this.wAggro.mean(); }
  get metricHoard() { return this.wHoard.mean(); }
  get metricSwarm() { return this.wSwarm.mean(); }
  get metricTower() { return this.wTower.mean(); }
  get metricFront() { return this.wFront.mean(); }
  // 경제 지향 — 윈도 합끼리 나눈다. 경험치가 거의 안 돌면 판단 보류(0.5)다.
  get metricEcon() {
    const earn = this.wXpEarn.mean();
    if (earn < 1) return 0.5;
    return clamp(this.wXpEra.mean() / earn, 0, 1);
  }
  // 도배 지수 — **이 게임의 난이도가 걸려 있는 하나의 숫자다.**
  // 정규화 허핀달: 여섯 종을 고르게 뽑으면 0, 한 종류만 뽑으면 1.
  // (원식 H = Σs², 최소 1/6 최대 1 → (H−1/6)/(1−1/6) 로 0~1 에 편다)
  // 기억이 살아 있으면 앞 전투의 구성도 같이 센다 — 사령관은 잊지 않는다.
  get metricFocus() {
    if (!this.loadShare()) return 0;
    let h = 0;
    for (let k = 0; k < KINDS; k++) h += this.effShare[k] * this.effShare[k];
    const inv = 1 / KINDS;
    return clamp((h - inv) / (1 - inv), 0, 1);
  }
  // 사령관 — 디렉터 뷰·렌더가 읽는다. 원정이 안 붙었으면 -1 / null 이다.
  get commanderName() {
    return this.commanderIdx >= 0 && C.COMMANDER_NAME
      ? (C.COMMANDER_NAME[this.commanderIdx] || '') : '';
  }
  // 플레이어 구성비 — 디렉터 뷰·검수가 읽는다. 매번 새 배열을 만들지 않는다.
  get playerMix() {
    const tot = this.wSpawnN.mean();
    for (let k = 0; k < KINDS; k++) {
      this.mixShare[k] = tot > 0 ? clamp(this.wKind[k].mean() / tot, 0, 1) : 0;
    }
    return this.mixShare;
  }
}

// ── 프로파일 판정 — 결정론적 ──────────────────────────────────
//
// 다섯이 전부 **구조적으로 도달 가능해야** 한다.
// 봇 여섯을 100초씩 돌려 실제로 닿는 것을 확인했다 (괄호가 측정값):
//   TURTLE     들어온 금의 30% 미만만 병력에 쓰고, 쌓아 뒀거나 포탑을 올렸다
//              (포탑 봇: aggro 0.05 · hoard 0.76 · tower 0.73 → TURTLE 82%)
//   ECONOMIST  쓰기는 쓰는데 늘 큰 잔고를 안고 있다
//              (문턱 260 저축 봇: aggro 0.82 · hoard 0.74 → ECONOMIST 86%)
//   SWARMER    잔고 없이 싼 것을 끝없이 (spam: aggro 0.95 · hoard 0.14 · swarm 0.98)
//   RUSHER     잔고 없이 비싼 것까지 (giant/cav: aggro 0.93 · hoard 0.29 · swarm 0.61)
//   BALANCED   그 사이. 판 초반 두세 구간이 실제로 여기 머문다
// eps 는 **들어가는 조건에만** 붙는다. 0이면 순수 판정, HYSTERESIS 면
// "이 판정으로 갈아탈 만큼 확실한가"를 묻는 것이다.
//
// ★ 경제형을 무엇으로 잡는가 — 여기서 한 번 크게 틀렸고 계측으로 잡았다.
//   처음엔 "번 경험치 중 시대에 넣은 비중(econ)"으로 잡았다. 단위도 맞고
//   말도 되는데, **재 보니 0.30~0.42 를 못 벗어났다.** 이유는 게임 구조다:
//   시대 요구치가 240·640·1300·2400 으로 벌이보다 훨씬 느리게 열려서,
//   아무리 진화를 서둘러도 번 경험치의 대부분은 아직 안 쓰인 채 쌓여 있다.
//   TH_ECON_HIGH(0.55)는 **구조적으로 도달 불가능**했다 — 러너에서 겪은 것과
//   똑같은 실패다. 그래서 판정에서 뺐다. (지표 자체는 디렉터 뷰에 남는다.
//   진화를 아예 안 하는 사람은 0.05, 하는 사람은 0.35 로 실제로 갈린다)
//
//   대신 실제로 넓게 퍼지는 축을 썼다. 봇 여섯을 재보니 hoard 는
//   0.14 → 1.00 으로 깨끗하게 퍼졌고 TH_HOARD_HIGH(0.45)가 정확히 그 한가운데다.
//   이 게임에서 "경제형"은 **금을 안고 있다가 한 번에 쏟는 사람**이다.
function classify(aggro, hoard, swarm, tower, eps) {
  const e = eps || 0;
  // 순서가 곧 우선순위다. 웅크리는 사람을 먼저 잡아야 한다 —
  // 물이 차오르는 게임에서 가장 위험한 습관이기 때문이다.
  // 포탑에 묻은 금도 "전선에 안 나온 금"이라 같은 축으로 센다.
  if (aggro < C.TH_AGGRO_LOW - e
      && (hoard > C.TH_HOARD_HIGH + e || tower > C.TH_HOARD_HIGH + e)) return 'TURTLE';
  // 쓰기는 쓰는데 늘 큰 잔고를 안고 있다 — 모았다가 쏟는 사람이다.
  if (hoard > C.TH_HOARD_HIGH + e) return 'ECONOMIST';
  // 잔고 없이 싼 것을 끝없이 — 물량.
  if (aggro > C.TH_AGGRO_HIGH + e && swarm > C.TH_SWARM_HIGH + e) return 'SWARMER';
  // 잔고 없이 비싼 것까지 섞어 계속 밀어붙인다 — 돌격.
  if (aggro > C.TH_AGGRO_HIGH + e) return 'RUSHER';
  return 'BALANCED';
}

// ── 스키마 검증 — 파손된 데이터는 폴백으로 간다 ───────────────
// mix 는 **길이 6**이다. 길이 3짜리 옛 데이터는 통과시키지 않는다 —
// 통과시키면 기병·거인·투석기가 영원히 안 나오는 조용한 고장이 된다.
function validateChunks(doc) {
  if (!doc || !Array.isArray(doc.chunks) || doc.chunks.length === 0) return false;
  for (let i = 0; i < doc.chunks.length; i++) {
    const c = doc.chunks[i];
    if (!c || typeof c.profile !== 'string') return false;
    if (!Number.isInteger(c.difficulty) || c.difficulty < 0 || c.difficulty > 4) return false;
    if (!Array.isArray(c.mix) || c.mix.length !== KINDS) return false;
    let sum = 0;
    for (let k = 0; k < KINDS; k++) {
      const v = c.mix[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 99) return false;
      sum += v;
    }
    if (sum <= 0) return false;      // 적이 한 명도 안 나온다
    if (typeof c.tempo !== 'number' || c.tempo < 200 || c.tempo > 6000) return false;
  }
  return true;
}

function validatePolicy(doc) {
  if (!doc || !doc.policies || typeof doc.policies !== 'object') return false;
  return true;
}

function validateLines(doc) {
  return !!(doc && Array.isArray(doc.death) && doc.death.length > 0);
}

// 구운 정책을 내장 정책 위에 덮는다. 빠진 키는 내장값이 남는다 —
// 부분적으로 망가진 데이터가 게임을 죽이지 못하게 한다.
function mergePolicy(p) {
  const out = {};
  for (const k of PROFILES) {
    const base = BUILTIN_POLICY[k];
    const got = p[k];
    if (!got) { out[k] = base; continue; }
    let mix = base.mix;
    if (Array.isArray(got.mix) && got.mix.length === KINDS) {
      let sum = 0, ok = true;
      for (let i = 0; i < KINDS; i++) {
        const v = got.mix[i];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) { ok = false; break; }
        sum += v;
      }
      if (ok && sum > 0) mix = got.mix;
    }
    out[k] = {
      mix,
      tempo: typeof got.tempo === 'number' ? got.tempo : base.tempo,
      goldMul: typeof got.goldMul === 'number' ? got.goldMul : base.goldMul,
      eraThresh: typeof got.eraThresh === 'number' ? got.eraThresh : base.eraThresh,
      waterMul: typeof got.waterMul === 'number' ? got.waterMul : base.waterMul,
      draftSlant: Number.isInteger(got.draftSlant) ? got.draftSlant : base.draftSlant,
      counterGain: typeof got.counterGain === 'number' ? got.counterGain : base.counterGain,
      preferTags: Array.isArray(got.preferTags) ? got.preferTags : base.preferTags,
    };
  }
  return out;
}
