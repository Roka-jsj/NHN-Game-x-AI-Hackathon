// AI 디렉터 계층1 — 런타임. 로컬. 0ms. 절대 안 죽는다.
//
// 이건 난이도를 올리는 시스템이 아니다.
// 플레이어가 겁쟁이인지 도박꾼인지 판정하고, **그 반대편으로 판을 다시 짠다.**
//
// 규칙:
//  - 판정은 결정론적이다. Math.random() 을 쓰지 않는다. 재현 불가능해지면 증거가 못 된다
//  - 프레임 단위 로직에 손대지 않는다. 구간 경계에서만 개입한다
//  - 네트워크 호출은 같은 도메인 data/*.json 한 번뿐. API 키는 어디에도 없다
//  - data/*.json 이 죽어도 게임은 100% 돈다. 줄어드는 건 다양성뿐이다

import * as C from './config.js';
import { EV, FALLBACK_PATTERN } from './game.js';

export const PROFILES = ['SAFE', 'RECKLESS', 'PRECISE', 'ERRATIC', 'BALANCED'];
export const PROFILE_KR = ['겁쟁이', '도박꾼', '장인', '초심자', '균형'];

export const REASONS = [
  '관찰 중',
  '중앙만 달리고 코인을 지나친다',
  '코인을 다 쫓고 아슬아슬하게 스친다',
  '반응이 빠르고 거의 부딪히지 않는다',
  '반응 시간이 들쭉날쭉하다',
  '어느 쪽으로도 치우치지 않았다',
];

// 드래프트 제시 이유 — 문자열을 만들지 않기 위해 상수로 고정
export const DRAFT_REASONS = [
  '기본 구성으로 제시한다',
  '안전하게만 달린다 — 위험을 감수할 이유를 준다',
  '너무 욕심을 낸다 — 버틸 수단을 준다',
  '실력이 충분하다 — 더 밀어붙일 수단을 준다',
  '아직 손에 안 익었다 — 다루기 쉬운 쪽을 준다',
  '균형이 잡혀 있다 — 세 계열을 하나씩 준다',
];

class Ring {
  constructor(n) { this.a = new Float32Array(n); this.n = n; this.i = 0; this.c = 0; }
  reset() { this.i = 0; this.c = 0; }
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

// ── 내장 폴백 청크 12개 ──────────────────────────────────────
// data/*.json 이 죽어도 게임이 100% 돌아가게 하는 최소 라이브러리.
// 모듈 로드 시 한 번만 만든다. 루프 안이 아니다.
const FALLBACK_CHUNKS = [];
for (let c = 0; c < 12; c++) {
  const steps = [];
  for (let r = 0; r < C.CHUNK_ROWS; r++) {
    const p = ((c * 5 + r) % 12) * 6;
    steps.push([
      FALLBACK_PATTERN[p], FALLBACK_PATTERN[p + 1], FALLBACK_PATTERN[p + 2],
      FALLBACK_PATTERN[p + 3], FALLBACK_PATTERN[p + 4], FALLBACK_PATTERN[p + 5],
    ]);
  }
  FALLBACK_CHUNKS.push({
    id: 'fallback-' + c, profile: 'BALANCED',
    difficulty: (c / 3) | 0, tags: ['mix'], steps,
  });
}

// 문서 지시대로 폴백에서는 BALANCED 고정이다.
const FALLBACK_POLICY = {
  BALANCED: {
    lanePressure: [1, 1, 1], density: 1, coinTemptation: 'mid',
    waterMul: 1, telegraph: 1, draftSlant: 2, preferTags: ['mix'],
  },
};

const FALLBACK_LINES = {
  death: ['물이 이겼다', '한 걸음 늦었다', '욕심이 발을 잡았다'],
  record: ['선을 넘었다'],
  revive: ['다시'],
};

// 전 프로파일 정책 — data/policy.json 이 살아 있을 때의 기본값.
// LLM 베이크가 이 표를 대체·확장한다.
const BUILTIN_POLICY = {
  // 안전지대를 걷어내 도박을 강요한다
  SAFE: {
    lanePressure: [0.7, 1.8, 0.7], density: 1.0, coinTemptation: 'risky',
    waterMul: 1.18, telegraph: 1.0, draftSlant: 0, preferTags: ['center', 'mix'],
  },
  // 절제에 보상, 무모함에 벌
  RECKLESS: {
    lanePressure: [1.2, 0.6, 1.2], density: 1.1, coinTemptation: 'safe',
    waterMul: 1.0, telegraph: 0.9, draftSlant: 1, preferTags: ['side', 'mix'],
  },
  // 실력에 걸맞은 압력
  PRECISE: {
    lanePressure: [1, 1, 1], density: 1.35, coinTemptation: 'risky',
    waterMul: 1.25, telegraph: 0.75, draftSlant: 0, preferTags: ['dense', 'mix'],
  },
  // 손에 익을 시간을 준다
  ERRATIC: {
    lanePressure: [1, 1, 1], density: 0.65, coinTemptation: 'safe',
    waterMul: 0.8, telegraph: 1.4, draftSlant: 1, preferTags: ['sparse'],
  },
  // 3구간 압박 → 1구간 완화 교대
  BALANCED: {
    lanePressure: [1, 1, 1], density: 1, coinTemptation: 'mid',
    waterMul: 1, telegraph: 1, draftSlant: 2, preferTags: ['mix'],
  },
};

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

export class Director {
  constructor(game) {
    this.game = game;

    // 지표 — 최근 8구간 슬라이딩 윈도
    this.wLane = new Ring(C.METRIC_WINDOW);
    this.wGreed = new Ring(C.METRIC_WINDOW);
    this.wReact = new Ring(C.METRIC_WINDOW);
    this.wNear = new Ring(C.METRIC_WINDOW);
    this.wWater = new Ring(C.METRIC_WINDOW);
    this.wHit = new Ring(C.METRIC_WINDOW);

    this.profile = 'BALANCED';
    this.profileIdx = 4;
    this.observing = true;
    this.reasonIdx = 0;
    this.draftReason = DRAFT_REASONS[0];
    this.switches = 0;
    this.lastSwitchDist = 0;

    this.levers = BUILTIN_POLICY.BALANCED;
    this.difficulty = 0;
    this.balancedPhase = 0;

    this.chunks = FALLBACK_CHUNKS;
    this.policy = BUILTIN_POLICY;
    this.lines = FALLBACK_LINES;
    this.usingFallback = true;
    this.librarySize = FALLBACK_CHUNKS.length;
    this.deathLine = FALLBACK_LINES.death[0];

    this.candidates = new Int32Array(512);
    this.assigned = new Map();      // 청크 인덱스 → 청크
    this.lastPlayerChunk = -1;
    this.lastSwitchChunk = -99;

    this.resetCounters();
    game.supplier = this;
  }

  resetCounters() {
    this.centerFrames = 0;
    this.sideFrames = 0;
    this.coinsSeen = 0;
    this.coinsTaken = 0;
    this.lastSeenRow = -1;
    this.rowsPassed = 0;
    this.nearCount = 0;
    this.hitCount = 0;
    this.jumpCount = 0;
    this.slideCount = 0;
    this.stairAcc = 0;
    this.draftAtk = 0;
    this.draftDef = 0;
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
  }

  onRunStart() {
    this.wLane.reset(); this.wGreed.reset(); this.wReact.reset();
    this.wNear.reset(); this.wWater.reset(); this.wHit.reset();
    this.resetCounters();
    this.assigned.clear();
    this.lastPlayerChunk = -1;
    this.lastSwitchChunk = -99;
    this.observing = true;
    this.reasonIdx = 0;
    this.switches = 0;
    this.difficulty = 0;
    this.balancedPhase = 0;
    this.profile = 'BALANCED';
    this.profileIdx = 4;
    this.applyLevers();
  }

  // ── 트랙 공급 — game.js 가 행마다 이걸 부른다 ────────────────
  chunkFor(ci) {
    let ch = this.assigned.get(ci);
    if (!ch) {
      ch = this.selectChunk(ci);
      this.assigned.set(ci, ch);
      if (this.assigned.size > 24) {
        const oldest = this.assigned.keys().next().value;
        this.assigned.delete(oldest);
      }
    }
    return ch;
  }

  fillRow(game, n, base) {
    const ci = (n / C.CHUNK_ROWS) | 0;
    const ch = this.chunkFor(ci);
    const st = ch.steps[n % C.CHUNK_ROWS];
    const lv = this.levers;

    // 1) 청크 원본
    let o0 = st[0], o1 = st[1], o2 = st[2];
    let c0 = st[3], c1 = st[4], c2 = st[5];

    // 2) 밀도 레버 — 결정론적으로 덜어내거나 옮긴다. 새로 만들지는 않는다.
    if (lv.density < 1) {
      const drop = (n * 7) % 3;
      if (lv.density < 0.8 || drop === 0) {
        if (drop === 0) o0 = 0; else if (drop === 1) o1 = 0; else o2 = 0;
      }
    }

    // 3) 레인 압박 — 비어 있는 "압박 대상 레인"으로 장애물을 옮긴다.
    //    새로 만들지 않고 위치만 바꾸므로 통과 가능성이 유지된다.
    const want = lv.lanePressure[0] > lv.lanePressure[1]
      ? (lv.lanePressure[0] > lv.lanePressure[2] ? 0 : 2)
      : (lv.lanePressure[1] > lv.lanePressure[2] ? 1 : 2);
    if (lv.lanePressure[want] > 1.3) {
      const cur = [o0, o1, o2];
      if (cur[want] === 0) {
        for (let l = 0; l < 3; l++) {
          if (l !== want && cur[l] !== 0) { cur[want] = cur[l]; cur[l] = 0; break; }
        }
      }
      o0 = cur[0]; o1 = cur[1]; o2 = cur[2];
    }

    // 4) 유혹의 위치 — 코인을 안전한 레인에 둘지, 위험한 레인 옆에 둘지
    if (lv.coinTemptation === 'risky') {
      // 장애물이 있는 레인의 바로 옆으로 코인을 민다
      const oo = [o0, o1, o2], cc = [c0, c1, c2];
      let moved = false;
      for (let l = 0; l < 3 && !moved; l++) {
        if (oo[l] === 0) continue;
        const nb = l === 0 ? 1 : (l === 2 ? 1 : (n % 2 === 0 ? 0 : 2));
        if (oo[nb] === 0) {
          for (let k = 0; k < 3; k++) if (cc[k]) { cc[k] = 0; break; }
          cc[nb] = 1; moved = true;
        }
      }
      c0 = cc[0]; c1 = cc[1]; c2 = cc[2];
    } else if (lv.coinTemptation === 'safe') {
      const oo = [o0, o1, o2], cc = [0, 0, 0];
      let placed = false;
      for (let l = 0; l < 3 && !placed; l++) {
        const t = (l + (n % 3)) % 3;
        if (oo[t] === 0 && (c0 || c1 || c2)) { cc[t] = 1; placed = true; }
      }
      c0 = cc[0]; c1 = cc[1]; c2 = cc[2];
    }

    // 5) **안전장치 — 세 레인이 동시에 막히면 하나를 연다.**
    //    데이터가 뭘 주든, 레버가 뭘 하든, 통과 불가능한 행은 나올 수 없다.
    if (o0 !== 0 && o1 !== 0 && o2 !== 0) {
      const open = n % 3;
      if (open === 0) o0 = 0; else if (open === 1) o1 = 0; else o2 = 0;
    }

    // 6) 기둥 일부를 **움직이는 기둥**으로 승격한다.
    //    판정은 기둥과 같고 그리는 자리만 달라지므로, 위의 통과 가능성 검사가
    //    전부 그대로 유효하다. 청크 스키마(0~3)도 안 바뀐다 —
    //    구운 350청크를 다시 굽지 않아도 네 번째 종류가 생긴다.
    //    처음 5200 거리 안에서는 안 나온다. 기둥을 먼저 가르쳐야 한다.
    if (game.travelled > C.DRIFT_FROM_DIST || n * C.ROW_SPACING > C.DRIFT_FROM_DIST) {
      if (n % C.DRIFT_EVERY === 0) {
        if (o0 === C.OB_PILLAR) o0 = C.OB_DRIFT;
        else if (o1 === C.OB_PILLAR) o1 = C.OB_DRIFT;
        else if (o2 === C.OB_PILLAR) o2 = C.OB_DRIFT;
      }
    }

    game._rowOb[base] = o0;
    game._rowOb[base + 1] = o1;
    game._rowOb[base + 2] = o2;
    game._rowCoin[base] = c0;
    game._rowCoin[base + 1] = c1;
    game._rowCoin[base + 2] = c2;
  }

  // ── 청크 선택 — 결정론적. Math.random() 없음 ────────────────
  selectChunk(ci) {
    const tags = this.levers.preferTags;
    let n = this.collect(this.profile, this.difficulty, tags);
    if (n === 0) n = this.collect(this.profile, this.difficulty, null);
    if (n === 0) n = this.collect(null, this.difficulty, null);
    if (n === 0) n = this.collect(null, -1, null);
    if (n === 0) return FALLBACK_CHUNKS[ci % FALLBACK_CHUNKS.length];
    return this.chunks[this.candidates[(ci * 5 + this.switches) % n]];
  }

  collect(profile, difficulty, tags) {
    let n = 0;
    for (let i = 0; i < this.chunks.length && n < this.candidates.length; i++) {
      const c = this.chunks[i];
      if (profile && c.profile !== profile) continue;
      if (difficulty >= 0 && c.difficulty !== difficulty) continue;
      if (tags) {
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

  // ── 특성 드래프트 — 어떤 3개를 제시할지가 곧 디렉터의 판단이다 ──
  draftOffer(game, out) {
    const slant = this.levers.draftSlant;   // 0=공격 1=방어 2=혼합
    this.draftReason = DRAFT_REASONS[this.observing ? 0 : this.profileIdx + 1];

    let n = 0;
    // 1순위: 성향의 반대편 계열을 먼저 채운다
    const order = slant === 2 ? [0, 1, 2] : (slant === 0 ? [0, 2, 1] : [1, 2, 0]);
    const start = (this.switches * 3 + game.runs) % C.TRAITS.length;
    for (let pass = 0; pass < order.length && n < C.TRAIT_OFFER; pass++) {
      const kind = order[pass];
      for (let k = 0; k < C.TRAITS.length && n < C.TRAIT_OFFER; k++) {
        const i = (start + k) % C.TRAITS.length;
        if (game.traits[i]) continue;
        if (C.TRAITS[i].kind !== kind) continue;
        let dup = false;
        for (let q = 0; q < n; q++) if (out[q] === i) dup = true;
        if (dup) continue;
        out[n++] = i;
        // 혼합이면 계열당 하나씩만
        if (slant === 2) break;
      }
    }
    // 남으면 아무거나 채운다
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

  // ── 이벤트 수신 — 지표 수집 ─────────────────────────────────
  onEvent(type, a, b, game) {
    switch (type) {
      // b === 1 일 때만 센다 — 바깥 레인에서 챙긴 코인만 욕심이다
      case EV.COIN: if (b === 1) this.coinsTaken++; break;
      // b === 1 일 때만 센다. a(옆 레인 장애물 수)는 트랙 밀도이지
      // 플레이어의 배짱이 아니다. 빈 레인에 가만히 서 있어도 옆이 막혀 있으면
      // 켜지던 값이라, 봇 넷이 전부 near 0.5~0.7 로 뭉쳐 RECKLESS/PRECISE
      // 판정이 트랙 밀도로 결정되고 있었다.
      case EV.NEAR_MISS: if (b === 1) this.nearCount++; break;
      case EV.HIT: this.hitCount++; break;
      case EV.JUMP: this.jumpCount++; this.noteReaction(game); break;
      case EV.SLIDE: this.slideCount++; this.noteReaction(game); break;
      case EV.MOVE: this.noteReaction(game); break;
      case EV.STAIR_CLEAR: this.stairAcc = a; break;
      case EV.DRAFT_PICK:
        if (b === 0) this.draftAtk++; else if (b === 1) this.draftDef++;
        break;
      case EV.DEATH: this.pickDeathLine(game); break;
      default: break;
    }
  }

  // 반응 시간의 대리 지표 — 회피 입력 시점에 **내 레인의** 장애물까지의 거리.
  // 늦게 반응할수록 장애물이 가까이 와 있다. 0 = 여유, 1 = 코앞.
  //
  // 두 번 틀렸던 자리다.
  //  (1) 처음엔 "아무 레인에나 장애물이 있는 행"을 기준으로 삼았다. 그러면 코인을
  //      쫓느라 옆으로 옮긴 것까지 회피로 세어져 지표가 조작을 읽지 못한다.
  //      **내가 지금 서 있는 레인이 막혀 있을 때** 누른 것만 회피다.
  //  (2) 정규화 분모가 ROW_SPACING×4(=960)였다. 실제 입력은 z 100~180 에서
  //      나오므로 전원이 0.82~0.90 에 몰렸고, TH_REACT_FAST=0.40 은
  //      z>576 — 두 행 반 앞 — 을 요구해 도달 불가능했다. PRECISE 가
  //      구조적으로 절대 판정될 수 없었다. 분모는 한 행 간격이 맞다.
  noteReaction(game) {
    const lane = game.effLane();
    const first = Math.floor(game.travelled / C.ROW_SPACING);
    for (let i = first; i <= first + 6; i++) {
      if (i > game.rowMade) break;
      const z = game.rowZ(i) - game.travelled;
      if (z <= 0) continue;
      if (game.rowOb(i, lane) === C.OB_NONE) continue;
      const spd = game.speed > 1 ? game.speed : 1;
      this.wReact.push(clamp(1 - (z / spd) / C.REACT_REF_S, 0, 1));
      return;
    }
  }

  pickDeathLine(game) {
    const pool = this.lines.death;
    if (!pool || pool.length === 0) return;
    this.deathLine = pool[(game.runs * 7 + ((game.travelled / C.ROW_SPACING) | 0)) % pool.length];
  }

  // ── 매 스텝 — 구간 경계 감지와 표본 수집 ─────────────────────
  step(game) {
    // **목표 레인이 아니라 실제로 서 있는 레인**을 센다. 스와이프한 순간
    // game.lane 은 이미 목적지를 가리키므로, 그걸 세면 아직 옮기지도 않은
    // 프레임이 중앙 체류로 잡힌다. 충돌 판정에서 똑같이 당했던 함정이다.
    if (game.effLane() === 1) this.centerFrames++; else this.sideFrames++;

    // 코인은 **지나간 행**에서, 그것도 **기회 단위로** 센다.
    //  · 생성 시점에 세면 분자(먹은 코인)는 이미 지나간 행의 것이고
    //    분모(본 코인)는 14행 앞의 것이라 둘이 다른 구간을 가리킨다.
    //  · 세 레인의 코인을 전부 분모에 넣으면 분모가 구조적으로 부풀어 오른다.
    //    플레이어는 한 번에 한 레인에만 있을 수 있으므로 같은 행의 코인 두 개를
    //    동시에 먹는 것은 **불가능**하다. 그렇게 재면 완벽하게 욕심을 부려도
    //    greed 가 0.5 를 넘지 못하고, TH_GREED_HIGH=0.65 인 RECKLESS 는
    //    설계상 절대 판정될 수 없었다.
    //    그래서 "코인이 하나라도 있던 행"을 하나의 기회로 센다. 전부 챙기면 1.0 이다.
    const passed = Math.floor(game.travelled / C.ROW_SPACING);
    while (this.lastSeenRow < passed) {
      this.lastSeenRow++;
      if (this.lastSeenRow < 0 || this.lastSeenRow > game.rowMade) continue;
      // 바깥 레인(0, 2)에 코인이 있던 행만 기회로 센다
      if (game.rowCoin(this.lastSeenRow, 0) || game.rowCoin(this.lastSeenRow, 2)) this.coinsSeen++;
    }

    const ci = ((game.travelled / C.ROW_SPACING) / C.CHUNK_ROWS) | 0;
    if (ci !== this.lastPlayerChunk) {
      if (this.lastPlayerChunk >= 0) this.closeChunk(game);
      this.lastPlayerChunk = ci;
      this.onChunkBoundary(game, ci);
    }
  }

  // 구간이 끝날 때 그 구간의 지표를 윈도에 밀어 넣는다
  closeChunk(game) {
    const frames = this.centerFrames + this.sideFrames;
    this.wLane.push(frames > 0 ? this.centerFrames / frames : 0.5);
    this.wGreed.push(this.coinsSeen > 0 ? clamp(this.coinsTaken / this.coinsSeen, 0, 1) : 0.5);
    this.wNear.push(clamp(this.nearCount / C.CHUNK_ROWS, 0, 1));
    this.wWater.push(clamp(game.gap / C.CHASE_GAP_START, 0, 1));
    this.wHit.push(clamp(this.hitCount / C.CHUNK_ROWS, 0, 1));
    this.centerFrames = 0; this.sideFrames = 0;
    this.coinsSeen = 0; this.coinsTaken = 0;
    this.nearCount = 0; this.hitCount = 0;
  }

  onChunkBoundary(game, ci) {
    this.difficulty = clamp(((game.travelled / 2600) | 0), 0, 4);

    if (ci < C.OBSERVE_CHUNKS) { this.observing = true; this.applyLevers(); return; }
    this.observing = false;

    const lane = this.wLane.mean();
    const greed = this.wGreed.mean();
    const react = this.wReact.mean();
    const sd = this.wReact.stdev();
    const near = this.wNear.mean();
    const hit = this.wHit.mean();

    const raw = classify(lane, greed, react, sd, near, hit);
    let next = raw;
    if (raw !== this.profile && nearBoundary(lane, greed, react, sd, near)) {
      // 히스테리시스 — 경계값 ±0.05 안에서는 직전 프로파일을 유지한다.
      // 이게 없으면 프로파일이 구간마다 튄다.
      next = this.profile;
    }
    // 방금 바꿨으면 잠시 유지한다. 레버가 세계를 바꾼 결과를 보고 다시 판정해야
    // 하는데, 즉시 재판정하면 자기 정책의 효과에 반응해 진동한다.
    if (next !== this.profile && ci - this.lastSwitchChunk < C.PROFILE_DWELL) next = this.profile;
    if (next !== this.profile) {
      this.lastSwitchChunk = ci;
      this.profile = next;
      this.profileIdx = PROFILES.indexOf(next);
      this.reasonIdx = this.profileIdx + 1;
      this.lastSwitchDist = game.travelled;
      this.switches++;
    }
    this.applyLevers();
  }

  applyLevers() {
    const p = this.policy[this.profile] || this.policy.BALANCED || FALLBACK_POLICY.BALANCED;
    this.levers = p;
    // BALANCED 는 3구간 압박 → 1구간 완화로 교대한다
    if (this.profile === 'BALANCED') {
      this.balancedPhase = (this.balancedPhase + 1) % 4;
    }
  }

  // ── 디렉터 뷰가 읽는 값 ─────────────────────────────────────
  get profileName() { return PROFILE_KR[this.profileIdx] || PROFILE_KR[4]; }
  get metricLane() { return this.wLane.mean(); }
  get metricGreed() { return this.wGreed.mean(); }
  get metricReact() { return this.wReact.mean(); }
  get metricStdev() { return this.wReact.stdev(); }
  get metricNear() { return this.wNear.mean(); }
  get metricHit() { return this.wHit.mean(); }
  get dodgeStyle() {
    const t = this.jumpCount + this.slideCount;
    return t === 0 ? 0.5 : this.jumpCount / t;
  }
}

// ── 프로파일 판정 — 결정론적 ──────────────────────────────────
function classify(lane, greed, react, sd, near, hit) {
  if (lane > C.TH_LANE_HIGH && greed < C.TH_GREED_LOW) return 'SAFE';
  if (greed > C.TH_GREED_HIGH && near > C.TH_NEAR_HIGH) return 'RECKLESS';
  // ERRATIC 을 PRECISE 보다 먼저 본다.
  // 문서의 나열 순서는 PRECISE 가 앞이지만, 반응이 들쭉날쭉한 사람은 평균이
  // 아무리 빨라도 초심자다. 뒤에 두면 "가끔 아주 빠른 초심자"가 전부 장인으로
  // 판정돼서, 정작 손에 익을 시간을 줘야 할 사람에게 압력을 더하게 된다.
  //
  // 피격률도 같이 본다. 문서의 축은 reactionStdev 하나였는데, 측정해 보니
  // **초심자일수록 자주 죽고, 죽으면 지표 윈도가 리셋돼서 편차가 오히려 작아진다.**
  // (초심자 봇 sd 0.23 < 겁쟁이 봇 sd 0.34) 편차만으로는 잡으려는 사람을
  // 구조적으로 놓친다. 자주 부딪히는 것은 리셋에 지워지지 않는 신호다.
  if (sd > C.TH_STDEV || hit > C.TH_HIT_HIGH) return 'ERRATIC';
  if (react < C.TH_REACT_FAST && near < C.TH_NEAR_HIGH) return 'PRECISE';
  return 'BALANCED';
}

function nearBoundary(lane, greed, react, sd, near) {
  const m = C.HYSTERESIS;
  return Math.abs(lane - C.TH_LANE_HIGH) < m
      || Math.abs(greed - C.TH_GREED_LOW) < m
      || Math.abs(greed - C.TH_GREED_HIGH) < m
      || Math.abs(react - C.TH_REACT_FAST) < m
      || Math.abs(near - C.TH_NEAR_HIGH) < m
      || Math.abs(sd - C.TH_STDEV) < m;
}

// ── 스키마 검증 — 통과하지 못하면 폴백이다 ────────────────────
function validateChunks(c) {
  if (!c || !Array.isArray(c.chunks) || c.chunks.length === 0) return false;
  for (let i = 0; i < c.chunks.length; i++) {
    const k = c.chunks[i];
    if (!k || typeof k.profile !== 'string') return false;
    if (PROFILES.indexOf(k.profile) < 0) return false;
    if (typeof k.difficulty !== 'number' || k.difficulty < 0 || k.difficulty > 4) return false;
    if (!Array.isArray(k.steps) || k.steps.length !== C.CHUNK_ROWS) return false;
    for (let s = 0; s < k.steps.length; s++) {
      const st = k.steps[s];
      if (!Array.isArray(st) || st.length !== 6) return false;
      let blocked = 0;
      for (let v = 0; v < 3; v++) {
        if (!Number.isInteger(st[v]) || st[v] < 0 || st[v] > 3) return false;
        if (st[v] !== 0) blocked++;
      }
      if (blocked === 3) return false;   // 통과 불가능한 행은 데이터로도 못 들어온다
      for (let v = 3; v < 6; v++) {
        if (st[v] !== 0 && st[v] !== 1) return false;
      }
    }
  }
  return true;
}

function validatePolicy(p) {
  if (!p || typeof p.policies !== 'object' || p.policies === null) return false;
  const keys = Object.keys(p.policies);
  if (keys.length === 0) return false;
  for (let i = 0; i < keys.length; i++) {
    const v = p.policies[keys[i]];
    if (!v) return false;
    if (!Array.isArray(v.lanePressure) || v.lanePressure.length !== 3) return false;
    if (typeof v.density !== 'number') return false;
    if (typeof v.waterMul !== 'number') return false;
    if (typeof v.telegraph !== 'number') return false;
    if (typeof v.draftSlant !== 'number') return false;
    if (['safe', 'mid', 'risky'].indexOf(v.coinTemptation) < 0) return false;
  }
  return true;
}

function validateLines(l) {
  if (!l) return false;
  return Array.isArray(l.death) && l.death.length > 0
      && Array.isArray(l.record) && Array.isArray(l.revive);
}

function mergePolicy(p) {
  const out = {};
  for (let i = 0; i < PROFILES.length; i++) {
    const k = PROFILES[i];
    const v = p[k] || BUILTIN_POLICY[k];
    // 레버는 범위 밖으로 나갈 수 없다. 데이터가 뭘 주든 여기서 자른다.
    out[k] = {
      lanePressure: v.lanePressure,
      density: clamp(v.density, C.LEVER_DENSITY_MIN, C.LEVER_DENSITY_MAX),
      coinTemptation: v.coinTemptation,
      waterMul: clamp(v.waterMul, C.LEVER_WATER_MIN, C.LEVER_WATER_MAX),
      telegraph: clamp(v.telegraph, C.LEVER_TELEGRAPH_MIN, C.LEVER_TELEGRAPH_MAX),
      draftSlant: v.draftSlant | 0,
      preferTags: v.preferTags || ['mix'],
    };
  }
  return out;
}
