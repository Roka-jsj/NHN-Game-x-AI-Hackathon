// AI 디렉터 계층1 — 런타임. 로컬. 0ms. 절대 안 죽는다.
//
// 이건 난이도를 올리는 시스템이 아니다.
// 플레이어가 **어떻게 돈을 쓰는지**를 판정하고, 그 반대편으로 적을 다시 짠다.
//
// 러너에서는 "어느 레인을 달리는가"를 읽었다. 여기서는 "무엇을 사는가"를 읽는다.
// 후자가 훨씬 강한 축이다 — 플레이어의 전략이 통째로 지표가 되기 때문이다.
//
// 규칙:
//  - 판정은 결정론적이다. Math.random() 을 쓰지 않는다. 재현 불가능해지면 증거가 못 된다
//  - 프레임 단위 로직에 손대지 않는다. 구간 경계에서만 개입한다
//  - 네트워크 호출은 같은 도메인 data/*.json 한 번뿐. API 키는 어디에도 없다
//  - data/*.json 이 죽어도 게임은 100% 돈다. 줄어드는 건 다양성뿐이다

import * as C from './config.js';
import { EV, SIDE_L } from './game.js';

export const PROFILES = ['RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER', 'BALANCED'];
export const PROFILE_KR = ['돌격형', '수비형', '경제형', '물량형', '균형'];

export const REASONS = [
  '관찰 중',
  '쉬지 않고 병력을 쏟아붓는다',
  '금을 쌓아 두고 나오지 않는다',
  '병력보다 시대에 먼저 투자한다',
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

// ── 내장 폴백 웨이브 12개 ────────────────────────────────────
// data/*.json 이 죽어도 게임이 100% 돌아가게 하는 최소 라이브러리.
// 모듈 로드 시 한 번만 만든다. 루프 안이 아니다.
const FALLBACK_CHUNKS = [];
for (let c = 0; c < 12; c++) {
  FALLBACK_CHUNKS.push({
    id: 'fallback-' + c,
    profile: 'BALANCED',
    difficulty: (c / 3) | 0,
    tags: ['mix'],
    // [검사, 궁수, 거인] 가중치 + 템포(ms)
    mix: [6 - (c % 3), 3 + (c % 2), 1 + ((c / 4) | 0)],
    tempo: 1500 - (c % 4) * 120,
  });
}

// 문서 지시대로 폴백에서는 BALANCED 고정이다.
const FALLBACK_POLICY = {
  BALANCED: {
    mix: [5, 3, 2], tempo: 1400, goldMul: 1, eraThresh: 1,
    waterMul: 1, draftSlant: 2, preferTags: ['mix'],
  },
};

const FALLBACK_LINES = {
  death: ['기지가 무너졌다', '한 파도 늦었다', '아끼다 잠겼다'],
  record: ['적진을 넘었다'],
  revive: ['다시'],
};

// 전 프로파일 정책 — data/policy.json 이 살아 있을 때의 기본값.
// LLM 베이크가 이 표를 대체·확장한다.
//
// **핵심은 "반대편으로 짠다"이지 "더 세게"가 아니다.**
const BUILTIN_POLICY = {
  // 돌격형 — 계속 쏟아붓는다. 그러면 거인으로 벽을 세워 소모를 강요한다.
  RUSHER: {
    mix: [1, 2, 6], tempo: 1900, goldMul: 1.0, eraThresh: 1.0,
    waterMul: 0.9, draftSlant: 1, preferTags: ['wall', 'mix'],
  },
  // 수비형 — 웅크린다. 물이 빨리 차고 원거리로 찔러 나오게 만든다.
  TURTLE: {
    mix: [2, 7, 1], tempo: 1150, goldMul: 1.05, eraThresh: 1.0,
    waterMul: 1.35, draftSlant: 0, preferTags: ['ranged', 'mix'],
  },
  // 경제형 — 진화가 앞선다. 진화가 끝나기 전에 두들긴다.
  ECONOMIST: {
    mix: [6, 3, 1], tempo: 900, goldMul: 1.15, eraThresh: 0.8,
    waterMul: 1.0, draftSlant: 1, preferTags: ['rush', 'mix'],
  },
  // 물량형 — 싼 유닛만 뽑는다. 광역에 강한 큰 유닛으로 받아친다.
  SWARMER: {
    mix: [1, 3, 6], tempo: 1700, goldMul: 1.0, eraThresh: 0.9,
    waterMul: 1.0, draftSlant: 0, preferTags: ['heavy', 'mix'],
  },
  BALANCED: {
    mix: [5, 3, 2], tempo: 1400, goldMul: 1, eraThresh: 1,
    waterMul: 1, draftSlant: 2, preferTags: ['mix'],
  },
};

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

export class Director {
  constructor(game) {
    this.game = game;

    // 지표 — 최근 8구간 슬라이딩 윈도
    this.wAggro = new Ring(C.METRIC_WINDOW);   // 소환 빈도 (구간당)
    this.wHoard = new Ring(C.METRIC_WINDOW);   // 금을 쌓아 두는 정도
    this.wEcon = new Ring(C.METRIC_WINDOW);    // 진화에 쓴 비중
    this.wSwarm = new Ring(C.METRIC_WINDOW);   // 싼 유닛 비율
    this.wFront = new Ring(C.METRIC_WINDOW);   // 전선 위치

    this.profile = 'BALANCED';
    this.profileIdx = 4;
    this.observing = true;
    this.reasonIdx = 0;
    this.draftReason = DRAFT_REASONS[0];
    this.switches = 0;

    this.levers = BUILTIN_POLICY.BALANCED;
    this.difficulty = 0;

    this.chunks = FALLBACK_CHUNKS;
    this.policy = BUILTIN_POLICY;
    this.lines = FALLBACK_LINES;
    this.usingFallback = true;
    this.librarySize = FALLBACK_CHUNKS.length;
    this.deathLine = FALLBACK_LINES.death[0];

    this.candidates = new Int32Array(512);
    this.lastChunk = -1;
    this.lastSwitchChunk = -99;

    this.resetCounters();
    game.supplier = this;
  }

  resetCounters() {
    this.spawnCount = 0;
    this.spawnCheap = 0;
    this.goldSum = 0;
    this.goldSamples = 0;
    this.spentUnits = 0;
    this.spentEra = 0;
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
    this.wAggro.reset(); this.wHoard.reset(); this.wEcon.reset();
    this.wSwarm.reset(); this.wFront.reset();
    this.resetCounters();
    this.lastChunk = -1;
    this.lastSwitchChunk = -99;
    this.observing = true;
    this.reasonIdx = 0;
    this.switches = 0;
    this.difficulty = 0;
    this.profile = 'BALANCED';
    this.profileIdx = 4;
    this.applyLevers();
  }

  // ── 이벤트 수신 — 지표 수집 ─────────────────────────────────
  onEvent(type, a, b, game) {
    switch (type) {
      case EV.SPAWN:
        if (b === SIDE_L) {
          this.spawnCount++;
          if (a === C.U_SWORD) this.spawnCheap++;
        }
        break;
      case EV.ERA_UP: if (b === SIDE_L) this.spentEra++; break;
      case EV.DRAFT_PICK:
        if (b === 0) this.draftAtk++; else if (b === 1) this.draftDef++;
        break;
      case EV.LOSE: this.pickDeathLine(game); break;
      default: break;
    }
  }

  // ── 매 스텝 — 구간 경계 감지와 표본 수집 ─────────────────────
  step(game) {
    this.goldSum += game.gold;
    this.goldSamples++;

    const ci = (game.simTime / C.CHUNK_MS) | 0;
    if (ci !== this.lastChunk) {
      if (this.lastChunk >= 0) this.closeChunk(game);
      this.lastChunk = ci;
      this.onChunkBoundary(game, ci);
    }
  }

  // 구간이 끝날 때 그 구간의 지표를 윈도에 밀어 넣는다.
  //
  // ★ 러너에서 배운 것: **모든 지표는 도달 가능한 범위로 정규화해야 한다.**
  //   거기서는 분모를 잘못 잡아 RECKLESS 와 PRECISE 가 구조적으로 판정 불가능했다.
  //   그래서 여기서는 분모를 전부 "그 구간에 실제로 가능했던 최대치"로 잡는다.
  closeChunk(game) {
    const secs = C.CHUNK_MS / 1000;
    // 소환 빈도 — 가장 싼 유닛을 쿨다운 한계로 계속 뽑았을 때가 1.0
    const maxSpawns = secs / (C.U_SPAWN_CD[C.U_SWORD] / 1000);
    this.wAggro.push(clamp(this.spawnCount / maxSpawns, 0, 1));

    // 쌓아 두는 정도 — 이 구간 평균 보유 금을 상한 대비로
    const avg = this.goldSamples > 0 ? this.goldSum / this.goldSamples : 0;
    this.wHoard.push(clamp(avg / (C.GOLD_CAP * 0.5), 0, 1));

    // 경제 지향 — 진화에 쓴 비중. 유닛에 한 푼도 안 썼으면 1.0
    const tot = game.goldSpentUnits + game.goldSpentEra;
    this.wEcon.push(tot > 0 ? clamp(game.goldSpentEra / tot, 0, 1) : 0.5);

    // 물량 지향 — 뽑은 것 중 가장 싼 유닛의 비율
    this.wSwarm.push(this.spawnCount > 0 ? clamp(this.spawnCheap / this.spawnCount, 0, 1) : 0.5);

    this.wFront.push(game.frontline());

    this.spawnCount = 0; this.spawnCheap = 0;
    this.goldSum = 0; this.goldSamples = 0;
  }

  onChunkBoundary(game, ci) {
    // 난이도는 경과 시간으로 오른다. 0~4.
    this.difficulty = clamp((game.simTime / 22000) | 0, 0, 4);

    if (ci < C.OBSERVE_CHUNKS) { this.observing = true; this.applyLevers(); return; }
    this.observing = false;

    const aggro = this.wAggro.mean();
    const hoard = this.wHoard.mean();
    const econ = this.wEcon.mean();
    const swarm = this.wSwarm.mean();

    const raw = classify(aggro, hoard, econ, swarm);
    let next = raw;
    if (raw !== this.profile && nearBoundary(aggro, hoard, econ, swarm)) {
      // 히스테리시스 — 경계값 ±0.05 안에서는 직전 프로파일을 유지한다.
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
    }
    this.applyLevers();
  }

  applyLevers() {
    const p = this.policy[this.profile] || this.policy.BALANCED || FALLBACK_POLICY.BALANCED;
    // 난이도가 오르면 템포가 빨라지고 수입이 는다. 종류 구성은 프로파일이 정한다.
    const d = this.difficulty;
    this.levers = {
      mix: p.mix,
      tempo: Math.max(420, p.tempo * (1 - d * 0.11)),
      goldMul: p.goldMul * (1 + d * 0.1),
      eraThresh: p.eraThresh,
      waterMul: p.waterMul,
      draftSlant: p.draftSlant,
      preferTags: p.preferTags,
    };
    // 구운 웨이브가 있으면 구성비를 거기서 가져온다 (계층2 산출물)
    const ch = this.selectChunk();
    if (ch) { this.levers.mix = ch.mix; this.levers.tempo = ch.tempo; }
  }

  // ── 웨이브 선택 — 결정론적. Math.random() 없음 ───────────────
  selectChunk() {
    if (!this.chunks || this.chunks.length === 0) return null;
    const tags = this.levers ? this.levers.preferTags : null;
    let n = this.collect(this.profile, this.difficulty, tags);
    if (n === 0) n = this.collect(this.profile, this.difficulty, null);
    if (n === 0) n = this.collect(this.profile, -1, null);
    if (n === 0) n = this.collect(null, -1, null);
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
    this.deathLine = pool[(game.runs * 7 + (game.kills | 0)) % pool.length];
  }

  // ── 디렉터 뷰가 읽는 값 ─────────────────────────────────────
  get profileName() { return PROFILE_KR[this.profileIdx] || PROFILE_KR[4]; }
  get metricAggro() { return this.wAggro.mean(); }
  get metricHoard() { return this.wHoard.mean(); }
  get metricEcon() { return this.wEcon.mean(); }
  get metricSwarm() { return this.wSwarm.mean(); }
  get metricFront() { return this.wFront.mean(); }
}

// ── 프로파일 판정 — 결정론적 ──────────────────────────────────
function classify(aggro, hoard, econ, swarm) {
  // 순서가 곧 우선순위다. 웅크리는 사람을 먼저 잡아야 한다 —
  // 물이 차오르는 게임에서 가장 위험한 습관이기 때문이다.
  if (aggro < C.TH_AGGRO_LOW && hoard > C.TH_HOARD_HIGH) return 'TURTLE';
  if (econ > C.TH_ECON_HIGH) return 'ECONOMIST';
  if (aggro > C.TH_AGGRO_HIGH && swarm > C.TH_SWARM_HIGH) return 'SWARMER';
  if (aggro > C.TH_AGGRO_HIGH) return 'RUSHER';
  return 'BALANCED';
}

function nearBoundary(aggro, hoard, econ, swarm) {
  const m = C.HYSTERESIS;
  return Math.abs(aggro - C.TH_AGGRO_HIGH) < m
      || Math.abs(aggro - C.TH_AGGRO_LOW) < m
      || Math.abs(hoard - C.TH_HOARD_HIGH) < m
      || Math.abs(econ - C.TH_ECON_HIGH) < m
      || Math.abs(swarm - C.TH_SWARM_HIGH) < m;
}

// ── 스키마 검증 — 파손된 데이터는 폴백으로 간다 ───────────────
function validateChunks(doc) {
  if (!doc || !Array.isArray(doc.chunks) || doc.chunks.length === 0) return false;
  for (let i = 0; i < doc.chunks.length; i++) {
    const c = doc.chunks[i];
    if (!c || typeof c.profile !== 'string') return false;
    if (!Number.isInteger(c.difficulty) || c.difficulty < 0 || c.difficulty > 4) return false;
    if (!Array.isArray(c.mix) || c.mix.length !== 3) return false;
    for (let k = 0; k < 3; k++) {
      if (typeof c.mix[k] !== 'number' || c.mix[k] < 0 || c.mix[k] > 99) return false;
    }
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
    out[k] = {
      mix: Array.isArray(got.mix) && got.mix.length === 3 ? got.mix : base.mix,
      tempo: typeof got.tempo === 'number' ? got.tempo : base.tempo,
      goldMul: typeof got.goldMul === 'number' ? got.goldMul : base.goldMul,
      eraThresh: typeof got.eraThresh === 'number' ? got.eraThresh : base.eraThresh,
      waterMul: typeof got.waterMul === 'number' ? got.waterMul : base.waterMul,
      draftSlant: Number.isInteger(got.draftSlant) ? got.draftSlant : base.draftSlant,
      preferTags: Array.isArray(got.preferTags) ? got.preferTags : base.preferTags,
    };
  }
  return out;
}
