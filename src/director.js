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
import { EV } from './game.js';

export const PROFILES = ['SAFE', 'RECKLESS', 'PRECISE', 'ERRATIC', 'BALANCED'];
export const PROFILE_KR = ['겁쟁이', '도박꾼', '장인', '초심자', '균형'];

// 전환 이유 — 문자열을 만들지 않기 위해 상수로 고정해둔다
export const REASONS = [
  '관찰 중',
  '차지가 짧고 조준이 정확하다',
  '차지가 길고 조준이 거칠다',
  '차지가 길고 조준이 정확하다',
  '차지 편차가 크다',
  '어느 쪽으로도 치우치지 않았다',
];

// 최근 N회 슬라이딩 윈도. 링버퍼라 push 해도 할당이 없다.
class Ring {
  constructor(n) { this.a = new Float32Array(n); this.n = n; this.i = 0; this.c = 0; }
  reset() { this.i = 0; this.c = 0; }
  push(v) {
    this.a[this.i] = v;
    this.i = (this.i + 1) % this.n;
    if (this.c < this.n) this.c++;
  }
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
// 각 원소는 발판 6개의 [간격, 두께배수, 보너스여부].
// 플래그: 1=보너스(앰버) 2=부서짐 4=이동
const FALLBACK_CHUNKS = [
  { profile: 'BALANCED', difficulty: 0, tags: ['near'], steps: [[140,1,0],[160,1,0],[130,1,0],[180,1,0],[150,1,0],[170,1,0]] },
  { profile: 'BALANCED', difficulty: 0, tags: ['mid'],  steps: [[200,1,0],[180,1,0],[220,1,0],[190,1,0],[210,1,0],[200,1,0]] },
  { profile: 'BALANCED', difficulty: 1, tags: ['mix'],  steps: [[150,1,0],[260,1,0],[140,1,1],[240,1,2],[170,1,0],[280,1,0]] },
  { profile: 'BALANCED', difficulty: 1, tags: ['far'],  steps: [[300,1,0],[260,1,2],[320,1,0],[280,1,0],[300,1,0],[270,1,1]] },
  { profile: 'BALANCED', difficulty: 2, tags: ['mix'],  steps: [[180,0.9,0],[320,0.9,4],[160,0.9,1],[350,0.9,0],[200,0.9,2],[300,0.9,0]] },
  { profile: 'BALANCED', difficulty: 2, tags: ['near'], steps: [[130,0.9,2],[150,0.9,0],[140,0.9,4],[160,0.9,1],[135,0.9,0],[155,0.9,2]] },
  { profile: 'BALANCED', difficulty: 3, tags: ['far'],  steps: [[340,0.85,0],[300,0.85,4],[370,0.85,0],[320,0.85,1],[360,0.85,2],[330,0.85,0]] },
  { profile: 'BALANCED', difficulty: 3, tags: ['mix'],  steps: [[160,0.85,2],[380,0.85,0],[150,0.85,4],[340,0.85,1],[180,0.85,2],[360,0.85,0]] },
  { profile: 'BALANCED', difficulty: 4, tags: ['far'],  steps: [[380,0.8,4],[350,0.8,2],[400,0.8,0],[360,0.8,1],[390,0.8,4],[370,0.8,2]] },
  { profile: 'BALANCED', difficulty: 4, tags: ['mix'],  steps: [[140,0.8,2],[400,0.8,4],[160,0.8,2],[380,0.8,1],[150,0.8,2],[395,0.8,4]] },
  { profile: 'BALANCED', difficulty: 2, tags: ['ramp'], steps: [[130,1,0],[190,1,0],[250,1,2],[310,1,0],[350,1,1],[390,1,0]] },
  { profile: 'BALANCED', difficulty: 3, tags: ['drop'], steps: [[390,0.9,0],[330,0.9,4],[270,0.9,0],[210,0.9,1],[160,0.9,2],[130,0.9,0]] },
];

// ── 내장 폴백 정책 ───────────────────────────────────────────
// 문서 지시대로 폴백에서는 BALANCED 고정이다.
const FALLBACK_POLICY = {
  BALANCED: {
    gapProfile: [1, 1, 1], platformThickness: [1, 1, 1],
    waterSpeed: 22, aimWobble: 1, bonusPlacement: 'mid', coyoteFrames: 5,
    preferTags: ['mix'],
  },
};

// ── 내장 폴백 문구 ───────────────────────────────────────────
const FALLBACK_LINES = {
  death: ['물이 이겼다', '한 뼘 모자랐다', '재는 동안 차올랐다'],
  record: ['선을 넘었다'],
  revive: ['다시'],
};

// 전 프로파일 정책 — data/policy.json 이 살아 있을 때 쓰는 기본값.
// LLM 베이크가 이 표를 대체·확장한다.
const BUILTIN_POLICY = {
  // 안전지대를 걷어내 도박을 강요한다
  SAFE:     { gapProfile: [1.6, 1.0, 0.95], platformThickness: [1, 1, 1],
              waterSpeed: 26, aimWobble: 1, bonusPlacement: 'far', coyoteFrames: 5,
              preferTags: ['far', 'mix'] },
  // 절제에 보상, 무모함에 벌
  RECKLESS: { gapProfile: [1.0, 1.0, 1.0], platformThickness: [1, 1, 0.7],
              waterSpeed: 22, aimWobble: 1, bonusPlacement: 'near', coyoteFrames: 5,
              preferTags: ['near', 'mix'] },
  // 실력에 걸맞은 압력
  PRECISE:  { gapProfile: [1.0, 1.05, 1.1], platformThickness: [0.75, 0.75, 0.75],
              waterSpeed: 27.5, aimWobble: 1.4, bonusPlacement: 'far', coyoteFrames: 5,
              preferTags: ['far', 'ramp'] },
  // 손에 익을 시간을 준다
  ERRATIC:  { gapProfile: [0.9, 0.9, 0.85], platformThickness: [1.35, 1.35, 1.35],
              waterSpeed: 18, aimWobble: 0.5, bonusPlacement: 'near', coyoteFrames: 8,
              preferTags: ['near'] },
  // 3구간 압박 → 1구간 완화 교대
  BALANCED: { gapProfile: [1, 1, 1], platformThickness: [1, 1, 1],
              waterSpeed: 22, aimWobble: 1, bonusPlacement: 'mid', coyoteFrames: 5,
              preferTags: ['mix'] },
};

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

export class Director {
  constructor(game) {
    this.game = game;

    // 지표 — 최근 8회 슬라이딩 윈도
    this.wCharge = new Ring(C.METRIC_WINDOW);
    this.wAim = new Ring(C.METRIC_WINDOW);
    this.wHesitation = new Ring(C.METRIC_WINDOW);
    this.wWaterMargin = new Ring(C.METRIC_WINDOW);

    this.missOver = 0;
    this.missUnder = 0;
    this.landings = 0;
    this.perfects = 0;
    this.lastLandTick = 0;
    this.retryLatency = 0;

    // 판정
    this.profile = 'BALANCED';
    this.profileIdx = 4;
    this.observing = true;
    this.reasonIdx = 0;
    this.lastSwitchDepth = 0;
    this.switches = 0;

    // 구간
    this.chunkCount = 0;
    this.lastPlayerChunk = -1;
    this.assigned = new Map();   // 청크 인덱스 → 청크 객체 (구간 경계에서만 쓴다)
    this.levers = BUILTIN_POLICY.BALANCED;
    this.difficulty = 0;
    this.balancedPhase = 0;

    // 데이터
    this.chunks = FALLBACK_CHUNKS;
    this.policy = BUILTIN_POLICY;
    this.lines = FALLBACK_LINES;
    this.usingFallback = true;
    this.librarySize = FALLBACK_CHUNKS.length;
    this.deathLine = FALLBACK_LINES.death[0];

    // 후보 인덱스 버퍼. 매 선택마다 배열을 만들지 않는다.
    this.candidates = new Int32Array(512);

    game.supplier = this;
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
      // 사용자에게는 아무 표시도 하지 않는다. 게임은 그대로 돈다.
      console.warn('[director] 계층2 데이터를 쓸 수 없어 내장 폴백으로 동작한다:', e.message);
      this.chunks = FALLBACK_CHUNKS;
      this.policy = FALLBACK_POLICY;
      this.lines = FALLBACK_LINES;
      this.usingFallback = true;
      this.librarySize = FALLBACK_CHUNKS.length;
    }
  }

  // ── 판 시작 ─────────────────────────────────────────────────
  onRunStart() {
    this.wCharge.reset(); this.wAim.reset();
    this.wHesitation.reset(); this.wWaterMargin.reset();
    this.missOver = 0; this.missUnder = 0;
    this.landings = 0; this.perfects = 0;
    this.chunkCount = 0;
    this.lastPlayerChunk = -1;
    this.assigned.clear();
    this.observing = true;
    this.reasonIdx = 0;
    this.switches = 0;
    this.difficulty = 0;
    this.balancedPhase = 0;
    this.profile = 'BALANCED';
    this.profileIdx = 4;
    this.applyLevers();
  }

  // ── 발판 공급 — game.js 가 이 세 개를 부른다 ────────────────
  chunkFor(n) {
    const ci = ((n - 1) / C.CHUNK_SIZE) | 0;
    let ch = this.assigned.get(ci);
    if (!ch) {
      // 필요한 순간에 정한다. 미리 왕창 만들어두면 아직 관찰하지 않은 플레이로 판을 짜게 된다.
      ch = this.selectChunk(ci);
      this.assigned.set(ci, ch);
      if (this.assigned.size > 24) {
        // 오래된 것부터 버린다 (Map 은 삽입 순서를 지킨다)
        const oldest = this.assigned.keys().next().value;
        this.assigned.delete(oldest);
      }
    }
    return ch;
  }

  stepOf(n) { return (n - 1) % C.CHUNK_SIZE; }

  gapFor(n) {
    const ch = this.chunkFor(n);
    const raw = ch.steps[this.stepOf(n)][0];
    const g = this.levers.gapProfile;
    const scale = raw < C.GAP_NEAR ? g[0] : (raw < C.GAP_MID ? g[1] : g[2]);
    return clamp(raw * scale, C.GAP_FLOOR, C.GAP_CEIL);
  }

  thickFor(n) {
    const ch = this.chunkFor(n);
    const st = ch.steps[this.stepOf(n)];
    const raw = st[0];
    const t = this.levers.platformThickness;
    const band = raw < C.GAP_NEAR ? t[0] : (raw < C.GAP_MID ? t[1] : t[2]);
    return clamp(st[1] * band, C.LEVER_THICK_MIN, C.LEVER_THICK_MAX);
  }

  // 발판 종류 비트필드. 보너스만 레버가 위치를 통제한다.
  flagsFor(n) {
    const ch = this.chunkFor(n);
    const st = ch.steps[this.stepOf(n)];
    let flags = st[2] & C.F_MAX;

    if (flags & C.F_BONUS) {
      // 유혹의 위치는 레버가 정한다. 청크가 보너스를 제안해도 위치가 안 맞으면 안 놓는다.
      const place = this.levers.bonusPlacement;
      const raw = st[0];
      const band = raw < C.GAP_NEAR ? 'near' : (raw < C.GAP_MID ? 'mid' : 'far');
      if (place === 'none' || band !== place) flags &= ~C.F_BONUS;
    }

    // 난이도 0에서는 부서지는 발판도 이동 발판도 나오지 않는다.
    // 첫 판 첫 10초에 규칙을 다 던지면 아무도 배우지 못한다.
    if (this.difficulty < 1) flags &= ~C.F_CRUMBLE;
    if (this.difficulty < 2) flags &= ~C.F_MOVING;

    // 한 발판이 부서지면서 동시에 움직이지는 않는다. 읽을 수 없어진다.
    if ((flags & C.F_CRUMBLE) && (flags & C.F_MOVING)) flags &= ~C.F_MOVING;
    return flags;
  }

  // ── 청크 선택 — 결정론적. Math.random() 없음 ────────────────
  selectChunk(ci) {
    this.chunkCount = ci;
    const want = this.profile;
    const diff = this.difficulty;
    const tags = this.levers.preferTags;

    // 1순위: 프로파일 + 난이도 + 선호 태그
    let n = this.collect(want, diff, tags);
    // 2순위: 프로파일 + 난이도
    if (n === 0) n = this.collect(want, diff, null);
    // 3순위: 난이도만
    if (n === 0) n = this.collect(null, diff, null);
    // 4순위: 전부
    if (n === 0) n = this.collect(null, -1, null);
    if (n === 0) return FALLBACK_CHUNKS[ci % FALLBACK_CHUNKS.length];

    // 변형 선택도 결정론적이다. 구간 번호로 순회한다.
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

  // ── 이벤트 수신 — 지표 수집 ─────────────────────────────────
  onEvent(type, a, b, game) {
    switch (type) {
      case EV.FIRE:
        this.wCharge.push(game.lastChargeRatio);
        break;
      case EV.PERFECT:
        this.wAim.push(game.lastAimError);
        this.landings++; this.perfects++;
        this.lastLandTick = game.tick;
        break;
      case EV.LAND:
        this.wAim.push(game.lastAimError);
        this.landings++;
        this.lastLandTick = game.tick;
        break;
      case EV.MISS:
        this.wAim.push(game.lastAimError);
        if (a > 0) this.missOver++; else this.missUnder++;
        break;
      case EV.CHARGE_START:
        if (this.lastLandTick > 0) {
          this.wHesitation.push((game.tick - this.lastLandTick) * C.SIM_DT);
        }
        break;
      case EV.RESET:
        if (game.deathTick > 0) this.retryLatency = (game.tick - game.deathTick) * C.SIM_DT;
        break;
      case EV.DEATH:
        this.pickDeathLine(game);
        break;
      default:
        break;
    }
  }

  pickDeathLine(game) {
    const pool = this.lines.death;
    if (!pool || pool.length === 0) return;
    // 결정론적 선택 — 판 번호와 깊이로 고른다
    this.deathLine = pool[(game.runs * 7 + game.depth) % pool.length];
  }

  // ── 매 스텝 — 구간 경계 감지와 물 여유 표본 ──────────────────
  step(game) {
    this.wWaterMargin.push(game.waterMargin());
    const ci = (game.platIdx / C.CHUNK_SIZE) | 0;
    if (ci !== this.lastPlayerChunk) {
      this.lastPlayerChunk = ci;
      this.onChunkBoundary(game, ci);
    }
  }

  onChunkBoundary(game, ci) {
    // 난이도는 깊이를 따라 오른다
    this.difficulty = clamp((game.depth / 12) | 0, 0, 4);

    if (ci < C.OBSERVE_CHUNKS) { this.observing = true; return; }
    this.observing = false;

    const cr = this.wCharge.mean();
    const ae = this.wAim.mean();
    const sd = this.wCharge.stdev();

    const raw = classify(cr, ae, sd);
    let next = raw;
    if (raw !== this.profile && nearBoundary(cr, ae, sd)) {
      // 히스테리시스 — 경계값 ±0.05 안에서는 직전 프로파일을 유지한다.
      // 이게 없으면 프로파일이 구간마다 튄다.
      next = this.profile;
    }
    if (next !== this.profile) {
      this.profile = next;
      this.profileIdx = PROFILES.indexOf(next);
      this.reasonIdx = reasonFor(next);
      this.lastSwitchDepth = game.depth;
      this.switches++;
    }
    this.applyLevers();
  }

  applyLevers() {
    const p = this.policy[this.profile] || this.policy.BALANCED || FALLBACK_POLICY.BALANCED;
    this.levers = p;

    // BALANCED 는 3구간 압박 → 1구간 완화로 교대한다
    let waterSpeed = p.waterSpeed;
    if (this.profile === 'BALANCED') {
      this.balancedPhase = (this.balancedPhase + 1) % 4;
      waterSpeed = this.balancedPhase === 3 ? p.waterSpeed * 0.8 : p.waterSpeed * 1.1;
    }

    const g = this.game;
    g.waterRisePerStep = clamp(waterSpeed, C.LEVER_WATER_MIN, C.LEVER_WATER_MAX) / C.SIM_HZ;
    g.aimWobbleScale = clamp(p.aimWobble, C.LEVER_WOBBLE_MIN, C.LEVER_WOBBLE_MAX);
    g.coyoteFrames = clamp(p.coyoteFrames | 0, C.LEVER_COYOTE_MIN, C.LEVER_COYOTE_MAX);
    this.appliedWaterSpeed = clamp(waterSpeed, C.LEVER_WATER_MIN, C.LEVER_WATER_MAX);
  }

  // ── 디렉터 뷰가 읽는 값 ─────────────────────────────────────
  get profileName() { return PROFILE_KR[this.profileIdx] || PROFILE_KR[4]; }
  get metricCharge() { return this.wCharge.mean(); }
  get metricAim() { return this.wAim.mean(); }
  get metricStdev() { return this.wCharge.stdev(); }
  get perfectRate() { return this.landings === 0 ? 0 : this.perfects / this.landings; }
  get missBias() {
    const t = this.missOver + this.missUnder;
    return t === 0 ? 0.5 : this.missOver / t;
  }
}

// ── 프로파일 판정 — 문서 임계값 그대로. 결정론적 ──────────────
function classify(cr, ae, sd) {
  if (cr < C.TH_CHARGE_LOW && ae < C.TH_AIM_LOW) return 'SAFE';
  if (cr > C.TH_CHARGE_HIGH && ae > C.TH_AIM_HIGH) return 'RECKLESS';
  if (cr > C.TH_CHARGE_HIGH && ae < C.TH_AIM_LOW) return 'PRECISE';
  if (sd > C.TH_STDEV) return 'ERRATIC';
  return 'BALANCED';
}

// 임계값 근처인가. 여기 걸리면 프로파일을 바꾸지 않는다.
function nearBoundary(cr, ae, sd) {
  const m = C.HYSTERESIS;
  return Math.abs(cr - C.TH_CHARGE_LOW) < m
      || Math.abs(cr - C.TH_CHARGE_HIGH) < m
      || Math.abs(ae - C.TH_AIM_LOW) < m
      || Math.abs(ae - C.TH_AIM_HIGH) < m
      || Math.abs(sd - C.TH_STDEV) < m;
}

function reasonFor(profile) {
  switch (profile) {
    case 'SAFE': return 1;
    case 'RECKLESS': return 2;
    case 'PRECISE': return 3;
    case 'ERRATIC': return 4;
    default: return 5;
  }
}

// ── 스키마 검증 — 통과하지 못하면 폴백이다 ────────────────────
function validateChunks(c) {
  if (!c || !Array.isArray(c.chunks) || c.chunks.length === 0) return false;
  for (let i = 0; i < c.chunks.length; i++) {
    const k = c.chunks[i];
    if (!k || typeof k.profile !== 'string') return false;
    if (PROFILES.indexOf(k.profile) < 0) return false;
    if (typeof k.difficulty !== 'number' || k.difficulty < 0 || k.difficulty > 4) return false;
    if (!Array.isArray(k.steps) || k.steps.length !== C.CHUNK_SIZE) return false;
    for (let s = 0; s < k.steps.length; s++) {
      const st = k.steps[s];
      if (!Array.isArray(st) || st.length !== 3) return false;
      if (typeof st[0] !== 'number' || st[0] < C.GAP_FLOOR || st[0] > C.GAP_CEIL) return false;
      if (typeof st[1] !== 'number' || st[1] < C.LEVER_THICK_MIN || st[1] > C.LEVER_THICK_MAX) return false;
      // 플래그 비트필드: 1=보너스 2=부서짐 4=이동
      if (!Number.isInteger(st[2]) || st[2] < 0 || st[2] > C.F_MAX) return false;
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
    if (!Array.isArray(v.gapProfile) || v.gapProfile.length !== 3) return false;
    if (!Array.isArray(v.platformThickness) || v.platformThickness.length !== 3) return false;
    if (typeof v.waterSpeed !== 'number') return false;
    if (typeof v.aimWobble !== 'number') return false;
    if (typeof v.coyoteFrames !== 'number') return false;
    if (['near', 'mid', 'far', 'none'].indexOf(v.bonusPlacement) < 0) return false;
  }
  return true;
}

function validateLines(l) {
  if (!l) return false;
  return Array.isArray(l.death) && l.death.length > 0
      && Array.isArray(l.record) && Array.isArray(l.revive);
}

// 베이크 결과가 일부 프로파일만 담고 있어도 나머지는 내장값으로 메운다.
function mergePolicy(p) {
  const out = {};
  for (let i = 0; i < PROFILES.length; i++) {
    const k = PROFILES[i];
    out[k] = p[k] || BUILTIN_POLICY[k];
  }
  return out;
}
