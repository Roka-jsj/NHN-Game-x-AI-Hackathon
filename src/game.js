// 시뮬레이션 — 유닛 · 전투 · 경제 · 시대 진화 · 물 · 특성.
// 이 파일은 시각·청각·입력장치를 모른다. 순수하게 상태만 굴린다.
//
// 규칙 1: 고정 스텝이다. 이 파일 어디에도 deltaTime을 곱하는 코드가 없다.
// 규칙 2: 상태 전이는 setState() 한 곳에서만 일어난다.
// 규칙 3: 판정에 Math.random()을 쓰지 않는다. 재현 가능해야 한다.
// 규칙 4: 루프 안에서 객체·배열을 만들지 않는다. 유닛은 전부 타입배열 풀이다.

import * as C from './config.js';

export const S = { PLAY: 0, DRAFT: 1, OVER: 2 };
export const STATE_NAME = ['PLAY', 'DRAFT', 'OVER'];

// 진영. 0 = 나, 1 = 적.
export const SIDE_L = 0, SIDE_R = 1;

// 입력 행동 — 버튼 다섯 개가 전부다. 플래시게임답게 손가락 하나로 끝난다.
export const ACT = {
  SWORD: 0, ARCHER: 1, GIANT: 2, ERA: 3, NUKE: 4,
  PICK0: 5, PICK1: 6, PICK2: 7, RESTART: 8,
};

export const EV = {
  SPAWN: 0,         // a = 종류, b = 진영
  ATTACK: 1,        // a = 종류, b = 진영
  KILL: 2,          // a = 죽은 유닛 종류, b = 죽인 진영
  BASE_HIT: 3,      // a = 피해, b = 맞은 진영
  GOLD: 4,          // a = 금액
  ERA_UP: 5,        // a = 새 시대, b = 진영
  NUKE: 6,
  NO_GOLD: 7,       // 살 돈이 없다 — 눌렀는데 안 나가는 것을 소리로 알린다
  COOLDOWN: 8,      // 쿨다운 중이다
  WATER_WARN: 9,
  WATER_HIT: 10,    // 물이 지면에 닿아 기지가 깎인다
  DRAFT_OPEN: 11,
  DRAFT_PICK: 12,   // a = 특성 인덱스, b = 계열
  WIN: 13,
  LOSE: 14,
  RESET: 15,
};

// 디렉터가 없을 때 적이 쓰는 고정 웨이브. 랜덤 0.
// [지연ms, 유닛종류] 가 반복된다. 이것만으로도 게임은 100% 돌아간다.
export const FALLBACK_WAVE = new Int16Array([
  1200, 0,  1600, 0,  2400, 1,  1800, 0,
  3000, 2,  1600, 1,  1400, 0,  2600, 1,
  3400, 2,  1500, 0,  2000, 1,  2800, 0,
]);

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// 협곡 바닥. 가운데가 FLOOR_DIP 만큼 낮다.
// 이 한 줄이 이 게임의 교착을 푼다 — 전선이 기지보다 먼저 잠긴다.
export function groundAt(x) {
  const mid = C.VIEW_W * 0.5;
  const half = C.VIEW_W * 0.5;
  const t = (x - mid) / half;               // -1 .. 1
  return C.GROUND_Y + C.FLOOR_DIP * (1 - t * t);
}

export class Game {
  constructor() {
    // ─ 유닛 풀. 루프 안에서 객체를 만들지 않기 위해 타입배열로 둔다 ─
    const N = C.UNIT_MAX;
    this.uAlive = new Uint8Array(N);
    this.uSide = new Uint8Array(N);
    this.uKind = new Uint8Array(N);
    this.uEra = new Uint8Array(N);
    this.uX = new Float32Array(N);
    this.uPrevX = new Float32Array(N);
    this.uHp = new Float32Array(N);
    this.uHpMax = new Float32Array(N);
    this.uCd = new Float32Array(N);       // 남은 공격 쿨다운 ms
    this.uHitFlash = new Uint8Array(N);   // 맞은 직후 프레임 수 (렌더용)
    this.uAttack = new Uint8Array(N);     // 공격 모션 프레임 (렌더용)

    // 화살 풀 — 연출 전용. 판정은 쏘는 순간 끝나 있다.
    const A = C.ARROW_MAX;
    this.aLife = new Int16Array(A);
    this.aTotal = new Int16Array(A);
    this.aX0 = new Float32Array(A); this.aY0 = new Float32Array(A);
    this.aX1 = new Float32Array(A); this.aY1 = new Float32Array(A);
    this.aSide = new Uint8Array(A);
    this.aNext = 0;

    this.supplier = null;     // 디렉터가 붙는다. 없으면 고정 웨이브
    this.onEvent = null;

    // 세션 기록. 전부 메모리에만 둔다 (localStorage 금지)
    this.wins = 0;
    this.losses = 0;
    this.bestTime = 0;
    this.runs = 0;

    // main 이 프레임 시작에서 심어주는 시각 기준점
    this.frameWall = 0;
    this.frameSimBase = 0;

    this.traits = new Uint8Array(C.TRAITS.length);
    this.draftIdx = new Int8Array(C.TRAIT_OFFER);
    this.spawnCd = new Float32Array(C.UNIT_KINDS);

    this.reset();
  }

  // ── 리셋 ────────────────────────────────────────────────────
  reset() {
    this.tick = 0;
    this.simTime = 0;
    this.state = S.PLAY;
    this.stateTick = 0;

    this.uAlive.fill(0);
    this.aLife.fill(0);
    this.uNext = 0;
    this.aliveL = 0;
    this.aliveR = 0;

    this.baseHp = [C.BASE_HP, C.BASE_HP];
    this.baseMax = [C.BASE_HP, C.BASE_HP];
    this.baseFlash = [0, 0];
    // 무엇이 기지를 무너뜨렸는가. 0=아직 1=병력 2=물.
    // 물과 병력이 같은 프레임에 기지를 0으로 만들면 무승부로 끝나 버린다.
    // **병력이 무너뜨린 것이 물보다 먼저다** — 그게 이 게임에서 이겼다는 뜻이다.
    this.baseDownBy = [0, 0];

    this.gold = C.GOLD_START;
    this.xp = 0;
    this.era = 0;
    this.spawnCd.fill(0);
    this.nukeCd = C.NUKE_CD * 0.45;    // 첫 판에도 한 번은 쓸 수 있게 절반만 채워 시작

    this.aiGold = C.AI_GOLD_START;
    this.aiXp = 0;
    this.aiEra = 0;
    this.aiThink = 0;
    this.aiWaveIdx = 0;
    this.aiWaveTimer = FALLBACK_WAVE[0];

    this.water = C.WATER_Y0;
    this.prevWater = this.water;
    this.waterWarned = false;

    // 통계 — 디렉터의 지표이자 결과 화면의 재료
    this.spawned = 0;
    this.spawnedKind = new Uint16Array(C.UNIT_KINDS);
    this.goldSpentUnits = 0;
    this.goldSpentEra = 0;
    this.kills = 0;
    this.lost = 0;
    this.nukes = 0;
    this.goldPeak = 0;
    this.goldSum = 0;
    this.goldSamples = 0;

    this.traits.fill(0);
    this.draftOpen = false;
    this.draftFrames = 0;
    this.pendingDraft = 0;

    this.outcome = C.WIN_NONE;
    this.endTick = -1;

    if (this.supplier && this.supplier.onRunStart) this.supplier.onRunStart();
    this.runs++;
    this.emit(EV.RESET, 0, 0);
  }

  emit(type, a, b) { if (this.onEvent) this.onEvent(type, a, b); }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.stateTick = 0;
  }

  nowWall() { return this.frameWall + (this.simTime - this.frameSimBase); }

  // ── 특성 ────────────────────────────────────────────────────
  has(id) {
    for (let i = 0; i < C.TRAITS.length; i++) {
      if (C.TRAITS[i].id === id) return this.traits[i] === 1;
    }
    return false;
  }

  applyTrait(idx) {
    this.traits[idx] = 1;
    if (C.TRAITS[idx].id === 'wall') {
      this.baseMax[SIDE_L] += 400;
      this.baseHp[SIDE_L] += 400;
    }
  }

  // ── 파생 스탯 ───────────────────────────────────────────────
  // 시대 배수와 특성을 여기 한 곳에서만 적용한다. 흩뿌리면 반드시 어긋난다.
  statHp(kind, era, side) {
    let v = C.U_HP[kind] * C.ERA_HP_MUL[era];
    if (side === SIDE_L && this.has('thick')) v *= 1.25;
    return v;
  }
  statDmg(kind, era, side) {
    let v = C.U_DMG[kind] * C.ERA_DMG_MUL[era];
    if (side === SIDE_L && this.has('sharp')) v *= 1.2;
    return v;
  }
  statSpeed(kind, side) {
    let v = C.U_SPEED[kind];
    if (side === SIDE_L && this.has('swift')) v *= 1.25;
    return v;
  }
  statCooldown(kind, side) {
    let v = C.U_COOLDOWN[kind];
    if (side === SIDE_L && kind === C.U_ARCHER && this.has('volley')) v *= 0.7;
    return v;
  }
  cost(kind) { return Math.round(C.U_COST[kind] * C.ERA_COST_MUL[this.era]); }
  aiCost(kind) { return Math.round(C.U_COST[kind] * C.ERA_COST_MUL[this.aiEra]); }
  spawnCooldown(kind) {
    return C.U_SPAWN_CD[kind] * (this.has('rush') ? 0.7 : 1);
  }
  goldRate() { return C.GOLD_RATE * (this.has('mine') ? 1.3 : 1); }
  eraNeed() {
    return this.era + 1 < C.ERA_COUNT ? C.ERA_XP[this.era + 1] : -1;
  }
  eraReady() {
    const need = this.eraNeed();
    return need > 0 && this.xp >= need;
  }

  // ── 입력 진입점 — main 의 입력 큐만 이걸 부른다 ──────────────
  input(act, simTs, wallTs) {
    if (this.state === S.OVER) {
      // 결과 화면에서는 아무 입력이나 재시작이다
      this.reset();
      return;
    }
    if (this.state === S.DRAFT) {
      if (act >= ACT.PICK0 && act <= ACT.PICK2) this.pickTrait(act - ACT.PICK0);
      // 유닛 버튼도 그대로 선택에 매핑한다 — 손이 이미 거기 있다
      else if (act <= ACT.GIANT) this.pickTrait(act);
      return;
    }
    switch (act) {
      case ACT.SWORD: case ACT.ARCHER: case ACT.GIANT: this.buy(act); break;
      case ACT.ERA: this.buyEra(); break;
      case ACT.NUKE: this.fireNuke(); break;
      default: break;
    }
  }

  // ── 구매 ────────────────────────────────────────────────────
  buy(kind) {
    if (this.spawnCd[kind] > 0) { this.emit(EV.COOLDOWN, kind, 0); return; }
    const c = this.cost(kind);
    if (this.gold < c) { this.emit(EV.NO_GOLD, kind, 0); return; }
    this.gold -= c;
    this.goldSpentUnits += c;
    this.spawnCd[kind] = this.spawnCooldown(kind);
    this.spawn(SIDE_L, kind, this.era);
  }

  buyEra() {
    if (!this.eraReady()) { this.emit(EV.NO_GOLD, -1, 0); return; }
    this.xp -= this.eraNeed();
    this.era++;
    this.goldSpentEra += this.eraNeed();
    this.gold += C.ERA_UP_GOLD;
    // 진화는 판을 되돌리는 순간이다. 물이 크게 밀린다.
    this.water += C.WATER_ERA_PUSH;
    this.emit(EV.ERA_UP, this.era, SIDE_L);
    this.openDraft();
  }

  fireNuke() {
    if (this.nukeCd > 0) { this.emit(EV.COOLDOWN, -1, 0); return; }
    this.nukeCd = C.NUKE_CD;
    this.nukes++;
    // 적 유닛 전부에게 피해. 기지는 건드리지 않는다 — 그러면 이건 승리 버튼이 된다
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i] || this.uSide[i] !== SIDE_R) continue;
      this.damage(i, C.NUKE_DMG, SIDE_L);
    }
    this.water += C.NUKE_WATER_PUSH;
    this.emit(EV.NUKE, 0, 0);
  }

  // ── 유닛 소환 ───────────────────────────────────────────────
  spawn(side, kind, era) {
    // 풀에서 빈 자리를 찾는다. 없으면 소환하지 않는다 — 조용히 실패해야
    // 프레임이 튀지 않는다.
    let idx = -1;
    for (let k = 0; k < C.UNIT_MAX; k++) {
      const i = (this.uNext + k) % C.UNIT_MAX;
      if (!this.uAlive[i]) { idx = i; break; }
    }
    if (idx < 0) return;
    this.uNext = (idx + 1) % C.UNIT_MAX;

    const hp = this.statHp(kind, era, side);
    this.uAlive[idx] = 1;
    this.uSide[idx] = side;
    this.uKind[idx] = kind;
    this.uEra[idx] = era;
    this.uX[idx] = side === SIDE_L ? C.SPAWN_L_X : C.SPAWN_R_X;
    this.uPrevX[idx] = this.uX[idx];
    this.uHp[idx] = hp;
    this.uHpMax[idx] = hp;
    this.uCd[idx] = 0;
    this.uHitFlash[idx] = 0;
    this.uAttack[idx] = 0;

    if (side === SIDE_L) { this.aliveL++; this.spawned++; this.spawnedKind[kind]++; }
    else this.aliveR++;
    this.emit(EV.SPAWN, kind, side);
  }

  // ── 한 스텝 ─────────────────────────────────────────────────
  step() {
    this.prevWater = this.water;
    for (let i = 0; i < C.UNIT_MAX; i++) if (this.uAlive[i]) this.uPrevX[i] = this.uX[i];

    this.tick++;
    this.stateTick++;
    this.simTime += C.SIM_DT;

    if (this.state === S.DRAFT) { this.draftFrames++; return; }
    if (this.state === S.OVER) return;

    this.stepEconomy();
    this.stepAI();
    this.stepUnits();
    this.stepArrows();
    this.stepWater();
    this.checkEnd();
  }

  stepEconomy() {
    const dt = C.SIM_DT / 1000;
    this.gold += this.goldRate() * dt;
    if (this.gold > C.GOLD_CAP) this.gold = C.GOLD_CAP;
    if (this.gold > this.goldPeak) this.goldPeak = this.gold;
    this.goldSum += this.gold;
    this.goldSamples++;

    for (let k = 0; k < C.UNIT_KINDS; k++) {
      if (this.spawnCd[k] > 0) {
        this.spawnCd[k] -= C.SIM_DT;
        if (this.spawnCd[k] < 0) this.spawnCd[k] = 0;
      }
    }
    if (this.nukeCd > 0) {
      this.nukeCd -= C.SIM_DT;
      if (this.nukeCd < 0) this.nukeCd = 0;
    }

    // 적도 같은 규칙으로 번다. 레버가 배수를 준다.
    let rate = C.AI_GOLD_RATE;
    if (this.supplier && this.supplier.levers) rate *= this.supplier.levers.goldMul;
    this.aiGold += rate * dt;
  }

  // 적 사령관. **결정론적이다.** 디렉터의 레버가 성향을 정한다.
  stepAI() {
    this.aiThink -= C.SIM_DT;
    if (this.aiThink > 0) return;
    this.aiThink = C.AI_THINK_MS;

    const lv = this.supplier && this.supplier.levers ? this.supplier.levers : null;

    // 시대 진화 — 경험치가 차면 올린다. 레버가 문턱을 조절한다.
    if (this.aiEra + 1 < C.ERA_COUNT) {
      const need = C.AI_ERA_XP[this.aiEra + 1] * (lv ? lv.eraThresh : 1);
      if (this.aiXp >= need) {
        this.aiXp -= need;
        this.aiEra++;
        this.emit(EV.ERA_UP, this.aiEra, SIDE_R);
      }
    }

    // 디렉터가 없으면 고정 웨이브를 돈다. 게임은 100% 돌아간다.
    if (!lv) {
      this.aiWaveTimer -= C.AI_THINK_MS;
      if (this.aiWaveTimer <= 0) {
        const kind = FALLBACK_WAVE[this.aiWaveIdx * 2 + 1];
        this.spawn(SIDE_R, kind, this.aiEra);
        this.aiWaveIdx = (this.aiWaveIdx + 1) % (FALLBACK_WAVE.length / 2);
        this.aiWaveTimer = FALLBACK_WAVE[this.aiWaveIdx * 2];
      }
      return;
    }

    // 레버가 정한 구성비대로, 살 수 있으면 산다.
    // 무엇을 뽑을지는 mix 로, 얼마나 자주 뽑을지는 tempo 로 정해진다.
    if (this.aiHold === undefined) this.aiHold = 0;
    this.aiHold -= C.AI_THINK_MS;
    if (this.aiHold > 0) return;

    const kind = this.pickAiKind(lv);
    const c = this.aiCost(kind);
    if (this.aiGold < c) return;
    this.aiGold -= c;
    this.spawn(SIDE_R, kind, this.aiEra);
    this.aiHold = lv.tempo;
  }

  // 결정론적 선택. Math.random 없음 — 재현 불가능해지면 증거가 못 된다.
  pickAiKind(lv) {
    // mix 는 세 종류의 가중치다. 누적 합을 tick 기반 위상으로 자른다.
    const total = lv.mix[0] + lv.mix[1] + lv.mix[2];
    if (total <= 0) return C.U_SWORD;
    const phase = ((this.tick * 2654435761) % 1000) / 1000 * total;
    if (phase < lv.mix[0]) return C.U_SWORD;
    if (phase < lv.mix[0] + lv.mix[1]) return C.U_ARCHER;
    return C.U_GIANT;
  }

  // ── 유닛 갱신 ───────────────────────────────────────────────
  stepUnits() {
    const dt = C.SIM_DT / 1000;
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i]) continue;
      if (this.uHitFlash[i] > 0) this.uHitFlash[i]--;
      if (this.uAttack[i] > 0) this.uAttack[i]--;
      if (this.uCd[i] > 0) this.uCd[i] -= C.SIM_DT;

      const side = this.uSide[i];
      const kind = this.uKind[i];
      const dir = side === SIDE_L ? 1 : -1;
      const range = C.U_RANGE[kind];

      // 사거리 안의 가장 가까운 적을 찾는다
      const target = this.findTarget(i, side, dir, range);
      if (target >= 0) {
        if (this.uCd[i] <= 0) {
          this.uCd[i] = this.statCooldown(kind, side);
          this.uAttack[i] = 8;
          this.damage(target, this.statDmg(kind, this.uEra[i], side), side);
          if (kind === C.U_ARCHER) this.shoot(i, target, side);
          this.emit(EV.ATTACK, kind, side);
        }
        continue;   // 싸우는 동안에는 전진하지 않는다
      }

      // 적 기지에 닿았는가
      const baseX = side === SIDE_L ? C.BASE_R_X : C.BASE_L_X;
      if (Math.abs(this.uX[i] - baseX) <= C.BASE_W * 0.5 + range) {
        if (this.uCd[i] <= 0) {
          this.uCd[i] = this.statCooldown(kind, side);
          this.uAttack[i] = 8;
          let dmg = this.statDmg(kind, this.uEra[i], side) * C.BASE_DMG_MUL;
          if (side === SIDE_L && this.has('siege')) dmg *= 2;
          this.hitBase(side === SIDE_L ? SIDE_R : SIDE_L, dmg);
        }
        continue;
      }

      // 앞에 아군이 막고 있으면 밀지 않는다. 이게 없으면 전부 한 점에 뭉친다.
      if (this.blockedAhead(i, side, dir)) continue;
      this.uX[i] += this.statSpeed(kind, side) * dir * dt;
    }

    // 물에 잠긴 유닛은 익사한다. **가운데가 가장 낮으므로 전선이 먼저 잠긴다** —
    // 밀지 못하고 물고 늘어지는 쪽이 먼저 병력을 잃는다.
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i]) continue;
      if (groundAt(this.uX[i]) <= this.water) continue;
      this.damage(i, C.DROWN_DPS * dt, this.uSide[i] === SIDE_L ? SIDE_R : SIDE_L);
    }
  }

  // 화살 하나를 띄운다. 판정과 무관하다 — 이미 맞은 것을 눈에 보이게 할 뿐이다.
  shoot(from, to, side) {
    const a = this.aNext;
    this.aNext = (this.aNext + 1) % C.ARROW_MAX;
    const total = Math.max(1, Math.round(C.ARROW_MS / C.SIM_DT));
    this.aLife[a] = total;
    this.aTotal[a] = total;
    this.aX0[a] = this.uX[from];
    this.aY0[a] = groundAt(this.uX[from]) - C.U_H[C.U_ARCHER] * 0.6;
    this.aX1[a] = this.uX[to];
    this.aY1[a] = groundAt(this.uX[to]) - C.U_H[this.uKind[to]] * 0.5;
    this.aSide[a] = side;
  }

  stepArrows() {
    for (let i = 0; i < C.ARROW_MAX; i++) if (this.aLife[i] > 0) this.aLife[i]--;
  }

  findTarget(i, side, dir, range) {
    const x = this.uX[i];
    let best = -1, bestD = 1e9;
    for (let j = 0; j < C.UNIT_MAX; j++) {
      if (!this.uAlive[j] || this.uSide[j] === side) continue;
      const d = (this.uX[j] - x) * dir;      // 앞쪽이 양수
      if (d < -6 || d > range) continue;
      if (d < bestD) { bestD = d; best = j; }
    }
    return best;
  }

  blockedAhead(i, side, dir) {
    const x = this.uX[i];
    for (let j = 0; j < C.UNIT_MAX; j++) {
      if (j === i || !this.uAlive[j] || this.uSide[j] !== side) continue;
      const d = (this.uX[j] - x) * dir;
      if (d > 0 && d < C.UNIT_GAP) return true;
    }
    return false;
  }

  damage(idx, dmg, byWhom) {
    this.uHp[idx] -= dmg;
    this.uHitFlash[idx] = 4;
    if (this.uHp[idx] > 0) return;

    const kind = this.uKind[idx];
    const side = this.uSide[idx];
    this.uAlive[idx] = 0;
    if (side === SIDE_L) { this.aliveL--; } else { this.aliveR--; }

    if (byWhom === SIDE_L) {
      this.kills++;
      this.gold += C.U_BOUNTY[kind] * (this.has('loot') ? 2 : 1);
      this.xp += C.U_XP[kind] * (this.has('study') ? 1.4 : 1);
      // 적을 잡으면 물이 밀린다. **공격이 곧 생존이다** — 이게 교착을 푼다.
      this.water += C.WATER_KILL_PUSH * (this.has('revive') ? 1.8 : 1);
    } else {
      this.lost++;
      this.aiXp += C.U_XP[kind];
      this.aiGold += C.U_BOUNTY[kind];
    }
    this.emit(EV.KILL, kind, byWhom);
  }

  hitBase(side, dmg) {
    this.baseHp[side] -= dmg;
    this.baseFlash[side] = 5;
    if (this.baseHp[side] <= 0) {
      this.baseHp[side] = 0;
      if (this.baseDownBy[side] === 0) this.baseDownBy[side] = 1;   // 병력
    }
    this.emit(EV.BASE_HIT, dmg, side);
  }

  // ── 물 ──────────────────────────────────────────────────────
  stepWater() {
    const dt = C.SIM_DT / 1000;
    const t = this.simTime / 1000;
    let rise = C.WATER_RISE;
    if (t > C.WATER_ACCEL_AT) rise *= C.WATER_ACCEL_MUL;
    if (this.has('drain')) rise *= 0.75;
    if (this.supplier && this.supplier.levers) rise *= this.supplier.levers.waterMul;

    this.water -= rise * dt;                       // y가 작아질수록 높이 찬다
    if (this.water < C.WATER_MIN_Y) this.water = C.WATER_MIN_Y;
    if (this.water > C.WATER_Y0) this.water = C.WATER_Y0;

    if (!this.waterWarned && this.water < C.GROUND_Y + C.WATER_WARN) {
      this.waterWarned = true;
      this.emit(EV.WATER_WARN, 0, 0);
    }

    // 수면이 **기지 발밑**을 넘으면 양쪽 기지가 깎인다.
    // 기지는 협곡 가장자리(높은 곳)에 있어 전선보다 한참 늦게 잠긴다 —
    // 그때까지 승부가 안 났으면 둘 다 죽는 게 맞다.
    if (this.water <= C.WATER_BASE_AT) {
      // **물은 밀리는 쪽을 먼저 삼킨다.**
      // 양쪽을 똑같이 깎았더니 두 기지가 같은 프레임에 0이 되어 무승부가
      // 기본 결말이 됐다(네 전략 중 둘). 전선이 어디 있느냐로 갈라야
      // 밀어붙인 쪽이 보상을 받고, 그래야 전략 선택에 의미가 생긴다.
      //   전선 0.5 → 양쪽 같음.  0.8(내가 밀고 있음) → 적이 1.6배, 내가 0.4배
      const front = this.frontline();
      const d = C.WATER_DPS * dt * 2;
      this.baseHp[SIDE_L] -= d * (1 - front);
      this.baseHp[SIDE_R] -= d * front;
      for (let sd = 0; sd < 2; sd++) {
        if (this.baseHp[sd] <= 0) {
          this.baseHp[sd] = 0;
          if (this.baseDownBy[sd] === 0) this.baseDownBy[sd] = 2;   // 물
        }
      }
      if (this.tick % 30 === 0) this.emit(EV.WATER_HIT, 0, 0);
    }
  }

  checkEnd() {
    if (this.baseHp[SIDE_R] <= 0 && this.baseHp[SIDE_L] <= 0) {
      // 둘 다 0이면 **무엇이 무너뜨렸는지**로 가른다.
      // 병력으로 적진을 함락시켰다면 그건 이긴 것이다. 물이 뒤따라온 것뿐이다.
      if (this.baseDownBy[SIDE_R] === 1 && this.baseDownBy[SIDE_L] !== 1) return this.finish(C.WIN_PLAYER);
      if (this.baseDownBy[SIDE_L] === 1 && this.baseDownBy[SIDE_R] !== 1) return this.finish(C.WIN_ENEMY);
      return this.finish(C.WIN_DROWN);
    }
    if (this.baseHp[SIDE_R] <= 0) return this.finish(C.WIN_PLAYER);
    // 내 기지만 무너졌으면 그냥 패배다. 물이 높다고 무승부가 아니다 —
    // 적 기지는 멀쩡한데 "둘 다 잠겼다"고 하면 거짓말이다.
    if (this.baseHp[SIDE_L] <= 0) return this.finish(C.WIN_ENEMY);
  }

  finish(outcome) {
    this.outcome = outcome;
    this.endTick = this.tick;
    if (outcome === C.WIN_PLAYER) {
      this.wins++;
      const t = this.simTime / 1000;
      if (this.bestTime === 0 || t < this.bestTime) this.bestTime = t;
    } else this.losses++;
    this.setState(S.OVER);
    this.emit(outcome === C.WIN_PLAYER ? EV.WIN : EV.LOSE, outcome, 0);
  }

  // ── 특성 드래프트 ───────────────────────────────────────────
  openDraft() {
    if (this.supplier && this.supplier.draftOffer) {
      this.supplier.draftOffer(this, this.draftIdx);
    } else {
      for (let i = 0; i < C.TRAIT_OFFER; i++) this.draftIdx[i] = i;
    }
    this.draftOpen = true;
    this.draftFrames = 0;
    this.setState(S.DRAFT);
    this.emit(EV.DRAFT_OPEN, 0, 0);
  }

  pickTrait(slot) {
    if (!this.draftOpen) return;
    const idx = this.draftIdx[clamp(slot, 0, C.TRAIT_OFFER - 1)];
    if (idx < 0) return;
    this.applyTrait(idx);
    this.draftOpen = false;
    this.emit(EV.DRAFT_PICK, idx, C.TRAITS[idx].kind);
    this.setState(S.PLAY);
  }

  // ── 조회 ────────────────────────────────────────────────────
  elapsed() { return this.simTime / 1000; }
  waterK() {
    // 0 = 안 보임, 1 = 지면까지 찼다
    const span = C.WATER_Y0 - C.GROUND_Y;
    return clamp((C.WATER_Y0 - this.water) / span, 0, 1);
  }
  waterNear() {
    const d = this.water - C.GROUND_Y;
    return d < C.WATER_WARN ? clamp(1 - d / C.WATER_WARN, 0, 1) : 0;
  }
  baseK(side) { return clamp(this.baseHp[side] / this.baseMax[side], 0, 1); }
  goldAvg() { return this.goldSamples > 0 ? this.goldSum / this.goldSamples : 0; }

  // 전선의 화면 x. 게임필이 파편을 어디에 뿌릴지 정할 때 쓴다.
  frontlineX() {
    return C.BASE_L_X + (C.BASE_R_X - C.BASE_L_X) * this.frontline();
  }

  // 전선 — 양쪽 최전방 유닛의 중간. 밀고 있는지 밀리는지가 한 숫자로 나온다.
  frontline() {
    let fl = C.BASE_L_X, fr = C.BASE_R_X;
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!this.uAlive[i]) continue;
      if (this.uSide[i] === SIDE_L) { if (this.uX[i] > fl) fl = this.uX[i]; }
      else if (this.uX[i] < fr) fr = this.uX[i];
    }
    const mid = (fl + fr) * 0.5;
    return clamp((mid - C.BASE_L_X) / (C.BASE_R_X - C.BASE_L_X), 0, 1);
  }
}
