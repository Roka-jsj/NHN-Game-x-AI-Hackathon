// 드로우 — 어떻게 그리는가만 담당한다. 무엇이 언제 일어나는가는 모른다.
//
// 이 파일의 규칙:
//  1. 루프 안에서 객체·배열·문자열을 만들지 않는다. 하나도.
//     숫자는 문자열로 조립하지 않고 자리별로 그린다 (= 캔버스에서의 tabular-nums).
//  2. ctx.shadowBlur 를 쓰지 않는다. 캔버스에서 압도적으로 비싸다.
//  3. 정적 지오메트리는 Path2D 로 한 번만 만든다.
//  4. save()/restore() 를 타이트 루프에서 남발하지 않는다. 회전은 삼각함수로 직접 푼다.
//  5. **같은 색으로 그릴 것은 모아서 한 번에 그린다.** 128 유닛 × 20 도형을
//     각각 fillRect 로 그리면 상태 전환만으로 프레임이 넘어간다. 유닛은
//     "그림자 → 아군 몸 → 아군 윤곽 → 적 몸 → 적 윤곽 → 피격 → 강조 → 체력"
//     순서로 **경로를 모아 한 번씩** 칠한다. fillStyle 변경이 유닛 수와 무관해진다.
//
// 겹치는 도형을 하나의 경로에 모을 때는 **감기 방향이 같아야 한다.**
// nonzero 규칙이라 방향이 반대인 도형이 겹치면 구멍이 뚫린다.
// ctx.rect 와 ctx.arc(…, false) 가 기준이고, 아래 addBar/addSpike 가 그 방향을 따른다.
//
// 화면 규칙: **카메라는 움직이지 않는다.** 전장 전체가 한 화면에 있다.
// 플래시게임의 핵심이 그거다 — 스크롤 없이 판 전체가 보인다.

import * as C from './config.js';
import { S, SIDE_L, SIDE_R, groundAt } from './game.js';
import { easeOutBack, easeOutCubic } from './feel.js';
import { REASONS } from './director.js';

const TAU = Math.PI * 2;
const HALF_W = C.VIEW_W * 0.5;
const HALF_H = C.VIEW_H * 0.5;

const FONT_BIG = '44px ' + C.FONT_STACK;
const FONT_SCORE = '26px ' + C.FONT_STACK;
const FONT_MID = '19px ' + C.FONT_STACK;
const FONT_SMALL = '15px ' + C.FONT_STACK;
const FONT_TINY = '12px ' + C.FONT_STACK;
const FONT_BTN = '14px ' + C.FONT_STACK;

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const DOT = '.';

// 0 검사 1 창병 2 궁수 3 기병 4 거인 5 투석기 6 진화 7 포탑 8 해일 9 화살비
const BTN_NAME = ['검사', '창병', '궁수', '기병', '거인', '투석기', '진화', '포탑', '해일', '화살비'];
const LABEL_GOLD = '금';
const LABEL_ERA = '시대';
const LABEL_AI = 'AI';
const LABEL_RETRY = '아무 키나 눌러 다시';
const LABEL_WIN = '적 기지 함락';
const LABEL_LOSE = '기지가 무너졌다';
const LABEL_DROWN = '둘 다 잠겼다';
const LABEL_TIME = '걸린 시간';
const LABEL_KILL = '처치';
const LABEL_LOST = '잃은 병력';
const LABEL_SPAWN = '소환';
const LABEL_PROFILE = '프로파일';
const LABEL_DRAFT = '하나를 고른다';
const LABEL_WHY = '디렉터가 이 셋을 고른 이유';
const LABEL_S = 's';
const LABEL_MAX = '최대';
const KEY_RALLY = 'R';
const PROFILE_UNKNOWN = '—';
const KIND_NAME = ['공격', '방어', '경제'];
const READY = '준비';

const BAN_TXT = ['시대가 바뀌었다', '해일', '물이 차오른다'];

const DV_PROFILE = '프로파일';
const DV_OBSERVING = '관찰 중';
const DV_AGGRO = 'aggression';
const DV_HOARD = 'hoard';
const DV_ECON = 'economy';
const DV_SWARM = 'swarm';
const DV_LEVERS = '다음 웨이브 레버';
const DV_MIX = '  구성';
const DV_TEMPO = '  간격';
const DV_WATER = '  water';

const TOGGLE_SIZE = 40;

// 상성 탐지용 공간 버킷. 32px 씩 끊어 진영별로 "이 칸에 어떤 종류가 있나"를
// 비트마스크로 들고 있는다. 공격 모션 중인 유닛만 앞쪽 칸을 훑으면
// **상성 우위로 때리는 중인지**를 O(1) 에 가깝게 알 수 있다.
const BUCKET_W = 32;
const BUCKET_N = (C.VIEW_W / BUCKET_W | 0) + 2;

// 스킬 연출 길이 (렌더 프레임)
const FX_TIDE_F = 40, FX_VOLLEY_F = 48, FX_RALLY_F = 36;
const FX_TOWER_F = 10;
const VOLLEY_N = 26;

export class Renderer {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.viewScale = 1;
    this.digits = new Uint8Array(12);

    // 배경 — 지평선 위 절벽 실루엣과 격자. 논리 해상도가 고정이라 한 번만 만든다.
    this.bgPath = new Path2D();
    for (let y = C.UNIT * 5; y < C.GROUND_Y; y += C.UNIT * 5) {
      this.bgPath.moveTo(0, y);
      this.bgPath.lineTo(C.VIEW_W, y);
    }
    for (let x = 0; x <= C.VIEW_W; x += C.UNIT * 5) {
      this.bgPath.moveTo(x, 0);
      this.bgPath.lineTo(x, C.GROUND_Y);
    }

    // 먼 산 두 겹 — 하늘에 깊이를 준다. 이미지 파일이 아니라 결정론적 해시로
    // 만든 다각형이고 Path2D 로 한 번만 굽는다. 매 프레임 비용은 fill 한 번이다.
    this.ridgeFar = this.buildRidge(11, 96, 168, 0.62);
    this.ridgeNear = this.buildRidge(7, 140, 232, 1.0);

    // 협곡 지층 — 바닥 아래 가로선 몇 줄. 깊이가 보여야 물이 무섭다.
    this.strataPath = new Path2D();
    for (let d = 26; d < 150; d += 30) {
      for (let x = 0; x <= C.VIEW_W; x += 14) {
        const y = groundAt(x) + d;
        if (x === 0) this.strataPath.moveTo(x, y); else this.strataPath.lineTo(x, y);
      }
      this.strataPath.moveTo(0, groundAt(0) + d + 30);
    }

    // 협곡 바닥 — 지형은 시간에 따라 변하지 않는다. 매 프레임 60번 lineTo 할 이유가 없다.
    this.floorFill = new Path2D();
    this.floorFill.moveTo(0, C.VIEW_H);
    for (let x = 0; x <= C.VIEW_W; x += 16) this.floorFill.lineTo(x, groundAt(x));
    this.floorFill.lineTo(C.VIEW_W, C.VIEW_H);
    this.floorFill.closePath();
    this.floorLine = new Path2D();
    for (let x = 0; x <= C.VIEW_W; x += 16) {
      if (x === 0) this.floorLine.moveTo(x, groundAt(x)); else this.floorLine.lineTo(x, groundAt(x));
    }

    // 협곡 벽 — 양쪽 끝이 솟아 있다. 물이 차오를 그릇을 눈으로 보여 준다.
    this.cliffPath = new Path2D();
    this.cliffPath.moveTo(0, C.VIEW_H);
    this.cliffPath.lineTo(0, C.GROUND_Y - 150);
    this.cliffPath.lineTo(38, C.GROUND_Y - 120);
    this.cliffPath.lineTo(48, C.GROUND_Y);
    this.cliffPath.lineTo(0, C.VIEW_H);
    this.cliffPath.moveTo(C.VIEW_W, C.VIEW_H);
    this.cliffPath.lineTo(C.VIEW_W, C.GROUND_Y - 150);
    this.cliffPath.lineTo(C.VIEW_W - 38, C.GROUND_Y - 120);
    this.cliffPath.lineTo(C.VIEW_W - 48, C.GROUND_Y);
    this.cliffPath.lineTo(C.VIEW_W, C.VIEW_H);

    // ── 유닛 스크래치 — 프레임마다 다시 계산하지 않기 위한 자리 ──
    const N = C.UNIT_MAX;
    this.list = new Int16Array(N);
    this.sx = new Float32Array(N);
    this.sgy = new Float32Array(N);
    this.sw = new Float32Array(N);
    this.sh = new Float32Array(N);
    this.sflag = new Uint8Array(N);        // 1 = 상성 우위로 때리는 중
    this.aliveN = 0;
    this.bucket = new Uint8Array(BUCKET_N * 2);

    // 상성 마스크 — COUNTER 표를 비트로 굽는다. 표를 손으로 옮기지 않는다.
    this.counterMask = new Uint8Array(C.UNIT_KINDS);
    for (let a = 0; a < C.UNIT_KINDS; a++) {
      let m = 0;
      for (let d = 0; d < C.UNIT_KINDS; d++) {
        if (C.COUNTER[a * C.UNIT_KINDS + d] > 1) m |= 1 << d;
      }
      this.counterMask[a] = m;
    }

    // ── 연출 상태 — 이벤트 배선 없이 game 상태의 변화만 보고 켠다 ──
    // (포탑·스킬은 시스템 설계자가 붙이는 중이다. 없으면 그냥 안 켜진다)
    this.fxSkill = new Int16Array(C.SKILL_COUNT);
    this.fxSkillX = new Float32Array(C.SKILL_COUNT);
    this.prevSkillCd = new Float32Array(C.SKILL_COUNT);
    this.fxTower = new Int16Array(2);
    this.fxTowerX = new Float32Array(2);
    this.prevTowerCd = new Float32Array(2);
    this.prevTick = -1;

    // 화살비 — 결정론적 산포. Math.random 을 쓰면 매 프레임 화살이 순간이동한다.
    this.vOff = new Float32Array(VOLLEY_N);
    this.vDelay = new Float32Array(VOLLEY_N);
    for (let i = 0; i < VOLLEY_N; i++) {
      this.vOff[i] = (((i * 2654435761) % 997) / 997) * 2 - 1;
      this.vDelay[i] = ((i * 40503) % 251) / 251;
    }

    // 수면 파형 — 한 프레임에 세 번 그리므로 sin 은 한 번만 계산한다.
    this.waveN = (C.VIEW_W / 24 | 0) + 2;
    this.wave = new Float32Array(this.waveN);
  }

  // 결정론적 능선. Math.random 을 쓰면 프레임마다 산이 바뀐다.
  buildRidge(n, minH, maxH) {
    const p = new Path2D();
    p.moveTo(0, C.GROUND_Y);
    for (let i = 0; i <= n; i++) {
      const h1 = ((i * 2654435761) % 1000) / 1000;
      const x = (C.VIEW_W / n) * i;
      const h = minH + h1 * (maxH - minH);
      p.lineTo(x, C.GROUND_Y - h);
      p.lineTo(x + C.VIEW_W / n * 0.5, C.GROUND_Y - h * 0.72);
    }
    p.lineTo(C.VIEW_W, C.GROUND_Y);
    p.closePath();
    return p;
  }

  resize(viewScale) { this.viewScale = viewScale; }

  // ── 경로 조각 — 전부 현재 경로에 더하기만 한다. 칠하지 않는다 ──
  // 방향(ux,uy) 으로 len 만큼 뻗고 뒤로 back 만큼 나온 막대.
  // 회전에 save/restore/translate 를 쓰지 않는 이유는 그게 유닛당 4번이면
  // 128 유닛에서 512번의 행렬 조작이 되기 때문이다.
  addBar(px, py, ux, uy, len, back, th0, th1) {
    const ctx = this.ctx;
    const n0x = -uy * th0, n0y = ux * th0;
    const n1x = -uy * th1, n1y = ux * th1;
    const x0 = px - ux * back, y0 = py - uy * back;
    const x1 = px + ux * len, y1 = py + uy * len;
    ctx.moveTo(x0 - n0x, y0 - n0y);
    ctx.lineTo(x1 - n1x, y1 - n1y);
    ctx.lineTo(x1 + n1x, y1 + n1y);
    ctx.lineTo(x0 + n0x, y0 + n0y);
    ctx.closePath();
  }

  // 창날·화염 같은 뾰족한 것
  addSpike(px, py, ux, uy, len, half) {
    const ctx = this.ctx;
    const nx = -uy * half, ny = ux * half;
    ctx.moveTo(px - nx, py - ny);
    ctx.lineTo(px + ux * len, py + uy * len);
    ctx.lineTo(px + nx, py + ny);
    ctx.closePath();
  }

  addCircle(x, y, r) {
    const ctx = this.ctx;
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TAU);
  }

  // 숫자를 자리별로 고정 피치에 그린다. 문자열을 만들지 않는다.
  drawNumber(v, cx, y, pitch) {
    const ctx = this.ctx;
    let n = v < 0 ? 0 : (v | 0);
    let count = 0;
    if (n === 0) this.digits[count++] = 0;
    while (n > 0 && count < 12) { this.digits[count++] = n % 10; n = (n / 10) | 0; }
    const total = count * pitch;
    let x = cx - total * 0.5 + pitch * 0.5;
    for (let i = count - 1; i >= 0; i--) { ctx.fillText(DIGITS[this.digits[i]], x, y); x += pitch; }
    return total;
  }

  drawLeft(v, x, y, pitch) {
    const ctx = this.ctx;
    let n = v < 0 ? 0 : (v | 0);
    let count = 0;
    if (n === 0) this.digits[count++] = 0;
    while (n > 0 && count < 12) { this.digits[count++] = n % 10; n = (n / 10) | 0; }
    let cx = x;
    for (let i = count - 1; i >= 0; i--) { ctx.fillText(DIGITS[this.digits[i]], cx, y); cx += pitch; }
    return count * pitch;
  }

  drawFixed1(v, x, y) {
    const ctx = this.ctx;
    const a = v < 0 ? 0 : v;
    const whole = a | 0;
    const frac = ((a - whole) * 10 + 0.5) | 0;
    const prev = ctx.textAlign;
    ctx.textAlign = 'left';
    let cx = x + this.drawLeft(whole, x, y, 9);
    ctx.fillText(DOT, cx, y); cx += 5;
    ctx.fillText(DIGITS[frac > 9 ? 9 : frac], cx, y);
    ctx.textAlign = prev;
    return cx + 9 - x;
  }

  // ── 히트테스트 — main 이 부른다 ─────────────────────────────
  static hitButton(lx, ly) {
    if (ly < C.BTN_Y || ly > C.BTN_Y + C.BTN_H) return -1;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = C.BTN_X0 + i * (C.BTN_W + C.BTN_GAP);
      if (lx >= x && lx <= x + C.BTN_W) return i;
    }
    return -1;
  }
  // 증원 — 줄에 넣으면 11칸이 되어 전부 좁아진다. 우하단 원형으로 뺀다.
  static hitRally(lx, ly) {
    const dx = lx - C.RALLY_CX, dy = ly - C.RALLY_CY;
    return dx * dx + dy * dy <= C.RALLY_R * C.RALLY_R;
  }
  static hitToggle(lx, ly) {
    return lx >= C.VIEW_W - TOGGLE_SIZE - C.UNIT * 2 && lx <= C.VIEW_W
        && ly >= 0 && ly <= TOGGLE_SIZE + C.UNIT * 2;
  }
  static hitMute(lx, ly) {
    return lx >= 0 && lx <= TOGGLE_SIZE + C.UNIT * 2
        && ly >= 0 && ly <= TOGGLE_SIZE + C.UNIT * 2;
  }
  // 드래프트 카드 — 세로로 셋
  static hitCard(lx, ly) {
    const cardH = 86, gap = C.UNIT * 2;
    const top = HALF_H - (cardH * 3 + gap * 2) * 0.5;
    for (let i = 0; i < C.TRAIT_OFFER; i++) {
      const y = top + i * (cardH + gap);
      if (ly >= y && ly <= y + cardH) return i;
    }
    return -1;
  }

  // ── 한 프레임 ───────────────────────────────────────────────
  draw(game, feel, alpha, director, directorView, muted) {
    const ctx = this.ctx;
    const s = this.viewScale;

    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

    this.pollFx(game);

    if (feel.shakeX !== 0 || feel.shakeY !== 0 || feel.shakeA !== 0) {
      ctx.translate(HALF_W + feel.shakeX, HALF_H + feel.shakeY);
      if (feel.shakeA !== 0) ctx.rotate(feel.shakeA);
      ctx.translate(-HALF_W, -HALF_H);
    }

    this.drawField(game);
    this.drawBase(game, SIDE_R);
    this.drawBase(game, SIDE_L);
    this.drawUnits(game, alpha);
    this.drawSkillFx(game);
    this.drawParticles(feel);
    this.drawRings(feel);
    this.drawWater(game, alpha);
    this.drawFloats(feel);

    ctx.setTransform(s, 0, 0, s, 0, 0);
    this.drawHud(game, feel, director, directorView, muted);
    this.drawButtons(game);
    this.drawRally(game);
    this.drawBanner(feel);
    if (game.state === S.DRAFT) this.drawDraft(game, feel, director);
    if (game.state === S.OVER) this.drawResult(game, feel, director);
  }

  // ── 연출 트리거 — 상태의 변화만 본다 ────────────────────────
  // 쿨다운이 **올라간** 프레임이 곧 발동한 순간이다. 이벤트 배선이 없어도,
  // 그 필드가 아직 없어도 (undefined → 0) 조용히 아무 일도 안 일어난다.
  pollFx(game) {
    if (game.tick < this.prevTick) {          // 새 판
      this.fxSkill.fill(0);
      this.fxTower.fill(0);
      this.prevSkillCd.fill(0);
      this.prevTowerCd.fill(0);
    }
    this.prevTick = game.tick;

    const cds = game.skillCd;
    const front = game.frontlineX ? game.frontlineX() : HALF_W;
    for (let i = 0; i < C.SKILL_COUNT; i++) {
      const cd = cds ? (cds[i] || 0) : (i === C.SK_TIDE ? (game.nukeCd || 0) : 0);
      if (cd > this.prevSkillCd[i] + 1) {
        this.fxSkill[i] = i === C.SK_TIDE ? FX_TIDE_F : (i === C.SK_VOLLEY ? FX_VOLLEY_F : FX_RALLY_F);
        this.fxSkillX[i] = i === C.SK_VOLLEY ? front : C.SPAWN_L_X;
      }
      this.prevSkillCd[i] = cd;
      if (this.fxSkill[i] > 0) this.fxSkill[i]--;
    }

    for (let s = 0; s < 2; s++) {
      const cd = (s === SIDE_L ? game.towerCd : game.aiTowerCd) || 0;
      if (cd > this.prevTowerCd[s] + 1) {
        this.fxTower[s] = FX_TOWER_F;
        this.fxTowerX[s] = front;
      }
      this.prevTowerCd[s] = cd;
      if (this.fxTower[s] > 0) this.fxTower[s]--;
    }
  }

  // ── 전장 ────────────────────────────────────────────────────
  drawField(game) {
    const ctx = this.ctx;

    // 하늘 — 위로 갈수록 어둡다. 띠 여섯 줄이면 그라디언트로 보인다.
    // createLinearGradient 를 안 쓰는 이유는 리사이즈마다 다시 만들어야 하고
    // 알파 램프로 같은 결과를 공짜로 얻을 수 있기 때문이다.
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.10 + i * 0.055)];
      ctx.fillRect(0, C.GROUND_Y * (i / 6), C.VIEW_W, C.GROUND_Y / 6 + 1);
    }

    ctx.strokeStyle = C.RAMP_GRID[C.rampIndex(0.55)];
    ctx.lineWidth = C.STROKE;
    ctx.stroke(this.bgPath);

    // 먼 산 두 겹
    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.85)];
    ctx.fill(this.ridgeFar);
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.75)];
    ctx.fill(this.ridgeNear);

    // 협곡 바닥 — V자다. 가운데가 낮아서 전선이 먼저 잠긴다.
    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.9)];
    ctx.fill(this.floorFill);
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.4)];
    ctx.lineWidth = C.STROKE;
    ctx.stroke(this.floorLine);

    // 지층 — 바닥 아래 가로선. 깊이가 보여야 물이 무섭다.
    ctx.strokeStyle = C.RAMP_BG[C.rampIndex(0.55)];
    ctx.lineWidth = 1;
    ctx.stroke(this.strataPath);
    ctx.lineWidth = C.STROKE;

    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.7)];
    ctx.fill(this.cliffPath);
  }

  // ── 기지 — 사각형 하나가 아니라 성채로 보여야 한다 ─────────
  // 총안(battlement) · 성문 아치 · 깃대 · 옥상 포탑.
  drawBase(game, side) {
    const ctx = this.ctx;
    const mine = side === SIDE_L;
    const cx = mine ? C.BASE_L_X : C.BASE_R_X;
    const w = C.BASE_W, h = C.BASE_H;
    const gy = groundAt(cx);
    const x = cx - w * 0.5, y = gy - h;
    const k = game.baseK(side);
    const flash = game.baseFlash[side] > 0;
    const main = mine ? C.RAMP_PLAYER[C.rampIndex(0.88)] : C.RAMP_STRUCT[C.rampIndex(0.84)];
    const dark = flash ? C.COL_DANGER : C.RAMP_BG[C.rampIndex(0.85)];

    // 본체
    ctx.fillStyle = main;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = dark;
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(x, y, w, h);

    // 총안 — 위쪽 요철. 이 하나로 "성"이 된다
    const merlonW = w / 7;
    for (let i = 0; i < 7; i += 2) {
      ctx.fillRect(x + i * merlonW, y - 13, merlonW, 13);
      ctx.strokeRect(x + i * merlonW, y - 13, merlonW, 13);
    }

    // 옆 탑 — 안쪽(전장 쪽)에 하나. 실루엣이 대칭이 아니어야 방향이 읽힌다
    const tx = mine ? x + w - 16 : x - 12;
    ctx.fillRect(tx, y - 34, 28, 34);
    ctx.strokeRect(tx, y - 34, 28, 34);

    // 성문 아치
    const gw = 32, gh = 48;
    const gx = cx - gw * 0.5 + (mine ? 14 : -14);
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx, gy - gh + gw * 0.5);
    ctx.arc(gx + gw * 0.5, gy - gh + gw * 0.5, gw * 0.5, Math.PI, 0);
    ctx.lineTo(gx + gw, gy);
    ctx.closePath();
    ctx.fill();

    // 깃대와 깃발 — 시대가 오르면 깃발이 늘어난다. 다섯 시대가 기지에도 보인다
    const era = mine ? game.era : game.aiEra;
    const px = mine ? x + 12 : x + w - 12;
    ctx.fillStyle = main;
    ctx.fillRect(px - 1.5, y - 76, 3, 44);
    for (let f = 0; f <= era; f++) {
      ctx.fillStyle = f === 0 ? main : C.COL_BONUS;
      const fy = y - 72 + f * 8;
      ctx.beginPath();
      ctx.moveTo(px, fy);
      ctx.lineTo(px + (mine ? 16 : -16), fy + 3);
      ctx.lineTo(px, fy + 6);
      ctx.closePath();
      ctx.fill();
    }

    this.drawTower(game, side, cx, y - 13, mine, main, dark);

    // 체력 막대 — 기지 위에
    const bw = w + 20, bh = 9;
    const bx = cx - bw * 0.5, by = y - 92;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.92)];
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = k > 0.3 ? (mine ? C.COL_PLAYER : C.COL_STRUCT) : C.COL_DANGER;
    ctx.fillRect(bx, by, bw * k, bh);
    ctx.strokeStyle = dark;
    ctx.strokeRect(bx, by, bw, bh);
  }

  // ── 포탑 — 기지 옥상. 단계(0/1/2)가 형태로 읽혀야 한다 ──────
  //  0 빈 받침 (여기에 뭔가 올라간다는 것을 알린다)
  //  1 포신 하나
  //  2 받침이 커지고 포신 둘 + 방패판
  drawTower(game, side, cx, roofY, mine, main, dark) {
    const ctx = this.ctx;
    const lvRaw = mine ? game.towerLv : game.aiTowerLv;
    const lv = lvRaw > 0 ? (lvRaw | 0) : 0;
    const dir = mine ? 1 : -1;
    const px = cx - dir * 6;

    if (lv === 0) {
      // 빈 자리 — 흐리게. 살 수 있는 칸이 있다는 신호다
      ctx.strokeStyle = mine ? C.RAMP_PLAYER[C.rampIndex(0.3)] : C.RAMP_STRUCT[C.rampIndex(0.3)];
      ctx.lineWidth = C.STROKE;
      ctx.strokeRect(px - 13, roofY - 8, 26, 8);
      return;
    }

    const bw = lv === 1 ? 26 : 34;
    const bh = lv === 1 ? 12 : 16;
    const my = roofY - bh - (lv === 1 ? 7 : 10);   // 포신 높이

    ctx.fillStyle = main;
    ctx.beginPath();
    ctx.rect(px - bw * 0.5, roofY - bh, bw, bh);            // 받침
    ctx.rect(px - bw * 0.28, roofY - bh - 9, bw * 0.56, 9); // 회전대
    // 포신 — 전장 쪽으로
    this.addBar(px + dir * bw * 0.2, my, dir, -0.16, lv === 1 ? 24 : 30, 4, 3, 2.4);
    if (lv === 2) {
      this.addBar(px + dir * bw * 0.2, my + 8, dir, -0.10, 26, 4, 2.6, 2);
      ctx.rect(px - dir * bw * 0.42, my - 6, 7, 18);        // 방패판
    }
    ctx.fill();
    ctx.strokeStyle = dark;
    ctx.lineWidth = C.STROKE;
    ctx.stroke();

    // 단계 눈금 — 두 칸 중 몇 칸이 찼는가
    for (let i = 0; i < C.TOWER_MAX; i++) {
      ctx.fillStyle = i < lv ? C.COL_BONUS : C.RAMP_BG[C.rampIndex(0.7)];
      ctx.fillRect(px - 7 + i * 8, roofY - bh - 15, 6, 4);
    }

    // 사격 — 총구 화염과 예광. 쏘는 게 안 보이면 포탑은 장식이다
    const f = this.fxTower[side];
    if (f > 0) {
      const t = f / FX_TOWER_F;
      const mx = px + dir * (bw * 0.2 + (lv === 1 ? 24 : 30));
      const myy = my - (lv === 1 ? 24 : 30) * 0.16;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(t)];
      ctx.beginPath();
      this.addSpike(mx, myy, dir, -0.1, 12 * t + 4, 5 * t + 1.5);
      this.addSpike(mx, myy, dir * 0.6, -0.8, 9 * t, 3 * t);
      this.addSpike(mx, myy, dir * 0.6, 0.8, 9 * t, 3 * t);
      ctx.fill();
      if (t > 0.55) {
        const tx2 = this.fxTowerX[side];
        ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex((t - 0.55) * 2)];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx, myy);
        ctx.lineTo(tx2, groundAt(tx2) - 22);
        ctx.stroke();
      }
    }
  }

  // ── 유닛 — 실루엣만으로 종류와 시대가 읽혀야 한다 ──────────
  //   검사    한 손에 칼, 다른 손에 둥근 방패. 보통 체구
  //   창병    앞으로 길게 뻗은 창. **몸보다 무기가 먼저 닿는다**는 게 형태로 보인다
  //   궁수    작고 낮다. 활을 앞으로 당기고 등에 화살통
  //   기병    말 위. 네 다리가 달리고 폭이 넓다. 창을 앞아래로 겨눈다
  //   거인    어깨가 넓고 몽둥이가 두껍다. 머리가 작다
  //   투석기  사람이 아니다. 바퀴 둘 · 기둥 · 던지는 팔
  //
  // 시대는 머리 위 표식 + **실루엣 자체**로 구분한다.
  //   돌(없음) 청동(볏) 강철(뿔+견갑) 화약(챙 넓은 모자, 발사 시 화염) 기계(안테나+등짐)
  //
  // 걷는 위상을 x 좌표에서 뽑는다. 상태를 따로 안 들고도 걸을 때만 다리가 움직이고
  // 멈춰 싸울 때는 저절로 멎는다. 결정론적이고 할당이 0이다.
  drawUnits(game, alpha) {
    const ctx = this.ctx;
    const list = this.list, sx = this.sx, sgy = this.sgy, sw = this.sw, sh = this.sh, sf = this.sflag;
    const bucket = this.bucket;
    bucket.fill(0);

    // 0) 한 번만 계산해 두고 여러 패스에서 나눠 쓴다
    let n = 0;
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!game.uAlive[i]) continue;
      const kind = game.uKind[i];
      const x = game.uPrevX[i] + (game.uX[i] - game.uPrevX[i]) * alpha;
      const grow = 1 + game.uEra[i] * 0.08;
      sx[i] = x;
      sgy[i] = groundAt(x);
      sw[i] = C.U_W[kind] * grow;
      sh[i] = C.U_H[kind] * grow;
      sf[i] = 0;
      let bi = (x / BUCKET_W) | 0;
      if (bi < 0) bi = 0; else if (bi >= BUCKET_N) bi = BUCKET_N - 1;
      bucket[game.uSide[i] * BUCKET_N + bi] |= 1 << kind;
      list[n++] = i;
    }
    this.aliveN = n;

    // 상성 우위로 때리는 중인가 — 공격 모션인 유닛만 앞쪽 칸을 훑는다
    for (let j = 0; j < n; j++) {
      const i = list[j];
      if (!game.uAttack[i]) continue;
      const kind = game.uKind[i];
      const m = this.counterMask[kind];
      if (!m) continue;
      const side = game.uSide[i];
      const dir = side === SIDE_L ? 1 : -1;
      const r = C.U_RANGE[kind] + 14;
      let a = sx[i], b = sx[i] + dir * r;
      if (dir < 0) { const t = a; a = b; b = t; }
      let i0 = (a / BUCKET_W) | 0, i1 = (b / BUCKET_W) | 0;
      if (i0 < 0) i0 = 0;
      if (i1 >= BUCKET_N) i1 = BUCKET_N - 1;
      const base = (1 - side) * BUCKET_N;
      for (let bi = i0; bi <= i1; bi++) {
        if (bucket[base + bi] & m) { sf[i] = 1; break; }
      }
    }

    // 1) 그림자 — 색이 하나다. 128개를 한 번에 칠한다
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.5)];
    ctx.beginPath();
    for (let j = 0; j < n; j++) {
      const i = list[j];
      const rx = sw[i] * 0.62;
      ctx.moveTo(sx[i] + rx, sgy[i]);
      ctx.ellipse(sx[i], sgy[i], rx, 3.5, 0, 0, TAU);
    }
    ctx.fill();

    // 2) 몸 — 진영별로 한 번씩. 소속은 **몸 색**이 유지한다
    ctx.lineWidth = C.STROKE;
    for (let s = 0; s < 2; s++) {
      const dir = s === SIDE_L ? 1 : -1;
      ctx.fillStyle = s === SIDE_L
        ? C.RAMP_PLAYER[C.rampIndex(0.92)] : C.RAMP_STRUCT[C.rampIndex(0.88)];
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s) continue;
        this.addUnitFill(game, i, dir);
      }
      ctx.fill();

      // 윤곽 — 밀집했을 때 서로 겹쳐 한 덩어리로 보이는 것을 끊는다
      ctx.strokeStyle = C.RAMP_BG[C.rampIndex(0.8)];
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s) continue;
        this.addUnitOutline(game, i, dir);
      }
      ctx.stroke();

      // 활 — 궁수만. 선으로 그려야 활시위가 보인다
      ctx.strokeStyle = s === SIDE_L
        ? C.RAMP_PLAYER[C.rampIndex(0.92)] : C.RAMP_STRUCT[C.rampIndex(0.88)];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s || game.uKind[i] !== C.U_ARCHER) continue;
        const w = sw[i], h = sh[i];
        const legH = h * 0.32, torsoH = h * 0.42;
        const hy = sgy[i] - legH - torsoH + torsoH * 0.30;
        const flex = game.uAttack[i] > 0 ? 1.3 : 1;
        const bx = sx[i] + dir * w * 0.42;
        ctx.moveTo(bx + dir * h * 0.3 * flex * Math.cos(1.1), hy - h * 0.3 * flex * Math.sin(1.1));
        ctx.arc(bx, hy, h * 0.3 * flex, dir > 0 ? -1.1 : Math.PI - 1.1,
                dir > 0 ? 1.1 : Math.PI + 1.1, dir < 0);
      }
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }

    // 3) 피격 — **몸 색으로 칠하지 않는다.** 밀집 전투에서 전원이 붉어지면
    //    아군과 적군이 구분되지 않는다. 실제로 그렇게 실패했다.
    //    소속은 몸 색이 유지하고, 맞았다는 것은 **붉은 테두리**로만 알린다.
    ctx.strokeStyle = C.COL_DANGER;
    ctx.beginPath();
    for (let j = 0; j < n; j++) {
      const i = list[j];
      if (!game.uHitFlash[i]) continue;
      const w = sw[i], h = sh[i];
      ctx.rect(sx[i] - w * 0.5, sgy[i] - h * 0.92, w, h * 0.92);
    }
    ctx.stroke();

    // 4) 금색 한 번 — 상성 타격 · 화약 시대 화염 · 기계 시대 표시등.
    //    상성은 색이 아니라 **모양(쐐기)** 으로 알린다. 몸은 건드리지 않는다.
    ctx.fillStyle = C.COL_BONUS;
    ctx.beginPath();
    for (let j = 0; j < n; j++) {
      const i = list[j];
      const era = game.uEra[i];
      const kind = game.uKind[i];
      const dir = game.uSide[i] === SIDE_L ? 1 : -1;
      const x = sx[i], w = sw[i], h = sh[i];
      if (sf[i]) {
        const cy = sgy[i] - h * 0.62;
        const fx = x + dir * (w * 0.55);
        this.addSpike(fx, cy - 6, dir, -0.22, 13, 4.5);
        this.addSpike(fx + dir * 8, cy + 5, dir, 0.22, 13, 4.5);
      }
      if (era === 3 && game.uAttack[i] && kind !== C.U_CATA) {
        this.addSpike(x + dir * w * 0.62, sgy[i] - h * 0.6, dir, -0.1, 11, 4);
      }
      if (era === 4) {
        const headTop = kind === C.U_CATA ? sgy[i] - h * 1.05
          : (kind === C.U_CAV ? sgy[i] - h * 1.02 : sgy[i] - h * 0.9);
        this.addCircle(x, headTop - w * 0.42, 2.6);
      }
    }
    ctx.fill();

    // 5) 체력 — 남은 만큼만. 가득 차 있으면 안 그린다 (선이 시끄러워진다)
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.9)];
    ctx.beginPath();
    let any = 0;
    for (let j = 0; j < n; j++) {
      const i = list[j];
      if (game.uHp[i] >= game.uHpMax[i] * 0.999) continue;
      any = 1;
      ctx.rect(sx[i] - sw[i] * 0.5, sgy[i] - sh[i] * 1.02, sw[i], 3.5);
    }
    if (any) {
      ctx.fill();
      for (let pass = 0; pass < 3; pass++) {
        ctx.fillStyle = pass === 0 ? C.COL_PLAYER : (pass === 1 ? C.COL_STRUCT : C.COL_DANGER);
        ctx.beginPath();
        for (let j = 0; j < n; j++) {
          const i = list[j];
          const hk = game.uHp[i] / game.uHpMax[i];
          if (hk >= 0.999) continue;
          const low = hk <= 0.35;
          if (pass === 2 ? !low : (low || (game.uSide[i] === SIDE_L) !== (pass === 0))) continue;
          ctx.rect(sx[i] - sw[i] * 0.5, sgy[i] - sh[i] * 1.02, sw[i] * (hk < 0 ? 0 : hk), 3.5);
        }
        ctx.fill();
      }
    }

    // 화살 — 궁수가 쏜 것이 날아가는 게 보여야 한다.
    // 이게 없으면 원거리 공격이 "아무 일도 안 일어나는데 적이 죽는" 것으로 보인다.
    ctx.lineWidth = 2;
    for (let s = 0; s < 2; s++) {
      ctx.strokeStyle = s === SIDE_L
        ? C.RAMP_PLAYER[C.rampIndex(0.9)] : C.RAMP_STRUCT[C.rampIndex(0.9)];
      ctx.beginPath();
      for (let i = 0; i < C.ARROW_MAX; i++) {
        if (game.aLife[i] <= 0 || game.aSide[i] !== s) continue;
        const t = 1 - game.aLife[i] / game.aTotal[i];
        const ax = game.aX0[i] + (game.aX1[i] - game.aX0[i]) * t;
        const ay = game.aY0[i] + (game.aY1[i] - game.aY0[i]) * t - Math.sin(t * Math.PI) * 22;
        const d = game.aX1[i] > game.aX0[i] ? 1 : -1;
        ctx.moveTo(ax - d * 7, ay);
        ctx.lineTo(ax + d * 7, ay);
      }
      ctx.stroke();
    }
    ctx.lineWidth = C.STROKE;
  }

  // 유닛 하나의 **채우는** 도형 전부를 현재 경로에 더한다.
  // 겹치는 도형의 감기 방향이 전부 같아야 한다 (addBar/addSpike/addCircle 이 맞춰 둔다).
  addUnitFill(game, i, dir) {
    const ctx = this.ctx;
    const kind = game.uKind[i];
    const era = game.uEra[i];
    const atk = game.uAttack[i];
    const x = this.sx[i], gy = this.sgy[i], w = this.sw[i], h = this.sh[i];
    const walk = Math.sin(x * 0.09 + i);
    const lunge = atk > 0 ? dir * 4 : 0;

    // ── 투석기 — 사람이 아니라 기계다. 사람 골격을 쓰지 않는다 ──
    if (kind === C.U_CATA) {
      const wr = h * 0.27;
      const axY = gy - wr;
      const bx = x - dir * w * 0.30, fx = x + dir * w * 0.18;
      this.addCircle(bx, axY, wr);
      this.addCircle(fx, axY, wr * 0.84);
      this.addBar(bx, axY, dir, 0, w * 0.52, 4, 3.2, 3.2);        // 차대
      const mastY = axY - h * 0.58;
      this.addBar(x - dir * 2, axY, 0, -1, h * 0.58, 0, 3.4, 2.6); // 기둥
      this.addBar(bx, axY - 2, dir * 0.72, -0.69, h * 0.5, 0, 2.6, 2.2); // 버팀대
      const a = atk > 0 ? 0.55 : 2.3;
      const c = Math.cos(a), s = Math.sin(a);
      this.addBar(x - dir * 2, mastY, dir * c, -s, h * 0.72, 6, 3, 2);
      this.addCircle(x - dir * 2 + dir * c * h * 0.72, mastY - s * h * 0.72, 4.4); // 투척 바구니
      if (era >= 1) this.addEraMark(x, mastY - 8, w * 0.3, era, dir);
      if (era === 3 && atk) this.addSpike(x - dir * 2 + dir * c * h * 0.8, mastY - s * h * 0.8, dir * c, -s, 10, 4);
      return;
    }

    // ── 기병 — 말 위. 폭이 넓고 낮다. 네 다리가 달린다 ──
    if (kind === C.U_CAV) {
      const bodyH = h * 0.26;
      const bodyY = gy - h * 0.60;
      const bodyW = w * 0.86;
      const belly = bodyY + bodyH;
      ctx.rect(x - bodyW * 0.5 + lunge, bodyY, bodyW, bodyH);
      // 네 다리 — 앞뒤가 엇갈려 달린다
      const g1 = walk * 0.55, g2 = -walk * 0.55;
      this.addBar(x + lunge + dir * bodyW * 0.34, belly, Math.sin(g1) * dir, Math.cos(g1), h * 0.38, 0, 2.4, 1.8);
      this.addBar(x + lunge + dir * bodyW * 0.22, belly, Math.sin(g2) * dir, Math.cos(g2), h * 0.38, 0, 2.4, 1.8);
      this.addBar(x + lunge - dir * bodyW * 0.34, belly, Math.sin(g2) * dir, Math.cos(g2), h * 0.38, 0, 2.4, 1.8);
      this.addBar(x + lunge - dir * bodyW * 0.22, belly, Math.sin(g1) * dir, Math.cos(g1), h * 0.38, 0, 2.4, 1.8);
      // 목과 머리 — 앞으로 낮게 뻗는다
      const nx = x + lunge + dir * bodyW * 0.42, ny = bodyY + bodyH * 0.3;
      this.addBar(nx, ny, dir * 0.72, -0.69, h * 0.3, 3, 4.5, 3);
      const hx = nx + dir * 0.72 * h * 0.3, hy = ny - 0.69 * h * 0.3;
      this.addBar(hx, hy, dir * 0.95, -0.31, h * 0.17, 2, 3, 2.4);
      // 꼬리
      this.addBar(x + lunge - dir * bodyW * 0.5, bodyY + 3, -dir * 0.82, -0.57, h * 0.2, 0, 2.4, 1);
      // 기수
      const rY = bodyY - h * 0.30;
      ctx.rect(x + lunge - w * 0.10, rY, w * 0.22, h * 0.32);
      this.addCircle(x + lunge + dir * w * 0.02, rY - w * 0.17, w * 0.17);
      // 창 — 앞아래로 겨눈다. 공격하면 더 뻗는다
      const la = atk > 0 ? -0.12 : 0.06;
      this.addBar(x + lunge + w * 0.02 * dir, rY + h * 0.1, dir * Math.cos(la), -Math.sin(la),
                  h * 0.85 + (atk > 0 ? 8 : 0), w * 0.4, 2.2, 1.6);
      if (era >= 1) this.addEraMark(x + lunge + dir * w * 0.02, rY - w * 0.34, w * 0.17, era, dir);
      return;
    }

    // ── 사람 형태 넷 (검사·창병·궁수·거인) ──
    const giant = kind === C.U_GIANT;
    const legH = h * 0.32, torsoH = h * 0.42;
    const headR = w * (giant ? 0.22 : 0.29);
    const hipY = gy - legH, shY = hipY - torsoH;
    const bw = w * (giant ? 0.84 : 0.58);
    const spread = walk * w * (kind === C.U_SPEAR ? 0.30 : 0.24);
    const lw = giant ? w * 0.22 : Math.max(3, w * 0.17);
    ctx.rect(x - lw * 0.5 + spread + lunge, hipY, lw, legH);
    ctx.rect(x - lw * 0.5 - spread + lunge, hipY, lw, legH);
    ctx.rect(x - bw * 0.5 + lunge, shY, bw, torsoH);
    this.addCircle(x + lunge + dir * w * 0.06, shY - headR * 0.9, headR);

    const handY = shY + torsoH * 0.30;
    const hx = x + lunge + dir * bw * 0.5;

    if (kind === C.U_SWORD) {
      // 칼 — 들었다가 내려친다. 반대 손에 둥근 방패
      const a = atk > 0 ? -0.35 : 0.95;
      const c = Math.cos(a), s = Math.sin(a);
      this.addBar(hx, handY, dir * c, -s, h * 0.50, 7, 2.4, 1.4);
      this.addBar(hx, handY, s, dir * c, 6, 6, 1.8, 1.8);   // 손잡이 가드
      this.addCircle(x + lunge + dir * bw * 0.62, handY + torsoH * 0.25, w * 0.30);
    } else if (kind === C.U_SPEAR) {
      // 창 — **몸 길이보다 앞으로 더 나간다.** 이게 사거리다
      const a = atk > 0 ? 0.02 : 0.13;
      const c = Math.cos(a), s = Math.sin(a);
      const len = h * 0.92 + (atk > 0 ? 10 : 0);
      const px = x + lunge + dir * bw * 0.25;
      this.addBar(px, handY, dir * c, -s, len, w * 0.62, 2.2, 2.0);
      this.addSpike(px + dir * c * len, handY - s * len, dir * c, -s, 12, 4.2);
      ctx.rect(x - bw * 0.62 + lunge, shY + torsoH * 0.12, bw * 0.24, torsoH * 0.6); // 작은 방패
    } else if (kind === C.U_ARCHER) {
      // 화살 — 시위에 걸려 있다. 활은 선으로 따로 그린다
      this.addBar(x + lunge + dir * bw * 0.1, handY, dir, 0, h * 0.38, 0, 1.3, 1.3);
      this.addBar(x + lunge - dir * bw * 0.35, shY + 2, -dir * 0.34, -0.94, h * 0.26, 0, 3, 2.4); // 화살통
    } else {
      // 거인 — 어깨판과 몽둥이. 끝이 두꺼워야 무게가 보인다
      ctx.rect(x - w * 0.52 + lunge, shY - 3, w * 1.04, h * 0.11);
      const a = atk > 0 ? -0.45 : 0.55;
      const c = Math.cos(a), s = Math.sin(a);
      this.addBar(hx, handY, dir * c, -s, h * 0.42, 6, 3, 7);
    }

    // 시대 — 어깨·등의 실루엣도 같이 바뀐다
    if (era >= 2) ctx.rect(x - bw * 0.78 + lunge, shY - 2, bw * 1.56, h * 0.055);
    if (era >= 4) ctx.rect(x - dir * bw * 0.78 + lunge, shY + 3, bw * 0.5, torsoH * 0.62);
    if (era >= 1) this.addEraMark(x + lunge, shY - headR * 1.8, headR, era, dir);
  }

  // 머리 위 시대 표식 — 다섯 시대가 서로 달라야 한다
  addEraMark(x, hy, r, era, dir) {
    const ctx = this.ctx;
    if (era === 1) {                    // 청동 — 볏
      ctx.moveTo(x, hy - r * 0.9);
      ctx.lineTo(x + r * 0.7, hy + r * 0.4);
      ctx.lineTo(x - r * 0.7, hy + r * 0.4);
      ctx.closePath();
    } else if (era === 2) {             // 강철 — 뿔 둘
      this.addBar(x - r * 0.85, hy + r * 0.3, -0.34, -0.94, r * 1.1, 0, 1.6, 1);
      this.addBar(x + r * 0.85, hy + r * 0.3, 0.34, -0.94, r * 1.1, 0, 1.6, 1);
    } else if (era === 3) {             // 화약 — 챙 넓은 모자
      ctx.rect(x - r * 1.6, hy - 1, r * 3.2, 3);
      ctx.rect(x - r * 0.75, hy - r * 0.85, r * 1.5, r * 0.85);
    } else {                            // 기계 — 안테나 (등불은 금색 패스에서)
      ctx.rect(x - 1.3, hy - r * 0.5, 2.6, r * 1.3);
    }
  }

  // 어두운 윤곽 — 몸의 큰 덩어리만. 전부 두르면 선이 시끄럽다
  addUnitOutline(game, i, dir) {
    const ctx = this.ctx;
    const kind = game.uKind[i];
    const x = this.sx[i], gy = this.sgy[i], w = this.sw[i], h = this.sh[i];
    const atk = game.uAttack[i];
    const lunge = atk > 0 ? dir * 4 : 0;

    if (kind === C.U_CATA) {
      const wr = h * 0.27, axY = gy - wr;
      const bx = x - dir * w * 0.30, fx = x + dir * w * 0.18;
      this.addCircle(bx, axY, wr);
      this.addCircle(fx, axY, wr * 0.84);
      ctx.moveTo(bx - wr * 0.7, axY - wr * 0.7); ctx.lineTo(bx + wr * 0.7, axY + wr * 0.7);
      ctx.moveTo(bx - wr * 0.7, axY + wr * 0.7); ctx.lineTo(bx + wr * 0.7, axY - wr * 0.7);
      return;
    }
    if (kind === C.U_CAV) {
      const bodyH = h * 0.26, bodyY = gy - h * 0.60, bodyW = w * 0.86;
      ctx.rect(x - bodyW * 0.5 + lunge, bodyY, bodyW, bodyH);
      ctx.rect(x + lunge - w * 0.10, bodyY - h * 0.30, w * 0.22, h * 0.32);
      return;
    }
    const giant = kind === C.U_GIANT;
    const legH = h * 0.32, torsoH = h * 0.42;
    const hipY = gy - legH, shY = hipY - torsoH;
    const bw = w * (giant ? 0.84 : 0.58);
    ctx.rect(x - bw * 0.5 + lunge, shY, bw, torsoH);
    if (giant) ctx.rect(x - w * 0.52 + lunge, shY - 3, w * 1.04, h * 0.11);
    if (kind === C.U_SWORD) {
      const handY = shY + torsoH * 0.30;
      this.addCircle(x + lunge + dir * bw * 0.62, handY + torsoH * 0.25, w * 0.30);
    }
  }

  // ── 스킬 연출 — 셋이 서로 달라 보여야 한다 ──────────────────
  drawSkillFx(game) {
    const ctx = this.ctx;

    // 해일 — 화면을 가로지르는 마루. 전장 전체를 훑는다
    let f = this.fxSkill[C.SK_TIDE];
    if (f > 0) {
      const t = 1 - f / FX_TIDE_F;
      const cx = -160 + (C.VIEW_W + 320) * easeOutCubic(t);
      ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.55 * (1 - t * 0.7))];
      ctx.beginPath();
      ctx.moveTo(cx - 170, C.VIEW_H);
      for (let d = -170; d <= 170; d += 17) {
        const px = cx + d;
        const k = 1 - Math.abs(d) / 170;
        ctx.lineTo(px, groundAt(px) - 150 * k * k);
      }
      ctx.lineTo(cx + 170, C.VIEW_H);
      ctx.closePath();
      ctx.fill();
      // 물보라 — 마루 끝에서 튄다
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.55 * (1 - t))];
      ctx.beginPath();
      for (let i = 0; i < 9; i++) {
        const px = cx + (this.vOff[i] * 90);
        const py = groundAt(px) - 150 * 0.6 - i * 9 - t * 40;
        ctx.rect(px, py, 4, 4);
      }
      ctx.fill();
    }

    // 화살비 — **전선 부근**에만 쏟아진다. 어디에 떨어지는지가 보여야 한다
    f = this.fxSkill[C.SK_VOLLEY];
    if (f > 0) {
      const t = 1 - f / FX_VOLLEY_F;
      const bx = this.fxSkillX[C.SK_VOLLEY];
      // 착탄 지대 — 두 벽
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.75 * (1 - t))];
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let s = -1; s <= 1; s += 2) {
        const ex = bx + s * C.VOLLEY_RADIUS;
        ctx.moveTo(ex, groundAt(ex) - 130);
        ctx.lineTo(ex, groundAt(ex));
      }
      ctx.stroke();
      // 화살
      ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.95)];
      ctx.beginPath();
      for (let i = 0; i < VOLLEY_N; i++) {
        const lt = (t - this.vDelay[i] * 0.45) / 0.5;
        if (lt <= 0 || lt >= 1) continue;
        const ax = bx + this.vOff[i] * C.VOLLEY_RADIUS;
        const g = groundAt(ax);
        const ay = g - 250 + 258 * lt * lt;
        ctx.moveTo(ax - 5, ay - 18);
        ctx.lineTo(ax, ay);
      }
      ctx.stroke();
      // 착탄 자국
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.8 * (1 - t))];
      ctx.beginPath();
      for (let i = 0; i < VOLLEY_N; i++) {
        const lt = (t - this.vDelay[i] * 0.45) / 0.5;
        if (lt < 1 || lt > 1.8) continue;
        const ax = bx + this.vOff[i] * C.VOLLEY_RADIUS;
        this.addSpike(ax, groundAt(ax), 0, -1, 10, 3);
      }
      ctx.fill();
      ctx.lineWidth = C.STROKE;
    }

    // 증원 — 내 기지 앞에서 솟는다. 금색 기둥과 고리
    f = this.fxSkill[C.SK_RALLY];
    if (f > 0) {
      const t = 1 - f / FX_RALLY_F;
      const bx = this.fxSkillX[C.SK_RALLY];
      const g = groundAt(bx);
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.85 * (1 - t))];
      ctx.beginPath();
      for (let i = 0; i < C.RALLY_COUNT; i++) {
        const px = bx + (i - 1) * 22;
        const hgt = 64 * easeOutCubic(Math.min(1, t * 2.2));
        ctx.rect(px - 3, g - hgt, 6, hgt);
        this.addSpike(px, g - hgt - 12, 0, -1, 14, 5);
      }
      ctx.fill();
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.8 * (1 - t))];
      ctx.lineWidth = 2;
      ctx.beginPath();
      const r = 12 + 56 * easeOutCubic(t);
      ctx.moveTo(bx + r, g);
      ctx.ellipse(bx, g, r, r * 0.32, 0, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }
  }

  drawParticles(feel) {
    const ctx = this.ctx;
    for (let i = 0; i < C.PARTICLE_MAX; i++) {
      if (feel.pLife[i] <= 0) continue;
      const a = feel.pLife[i] / feel.pMax[i];
      const ramp = feel.pKind[i] === 1 ? C.RAMP_BONUS
        : (feel.pKind[i] === 2 ? C.RAMP_DANGER : C.RAMP_PLAYER);
      ctx.fillStyle = ramp[C.rampIndex(a)];
      const s = feel.pSize[i] * a;
      ctx.fillRect(feel.pX[i] - s * 0.5, feel.pY[i] - s * 0.5, s, s);
    }
  }

  drawRings(feel) {
    const ctx = this.ctx;
    ctx.lineWidth = C.STROKE;
    for (let i = 0; i < C.RING_MAX; i++) {
      if (feel.ringStep[i] < 0) continue;
      const t = feel.ringStep[i] / feel.ringSteps;
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(1 - t)];
      ctx.beginPath();
      ctx.arc(feel.ringX[i], feel.ringY[i], C.RING_R * easeOutCubic(t), 0, TAU);
      ctx.stroke();
    }
  }

  // 떠오르는 숫자 — 피해와 수입이 어디서 났는지 눈으로 따라갈 수 있어야 한다
  drawFloats(feel) {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_SMALL;
    for (let i = 0; i < C.FLOAT_MAX; i++) {
      if (feel.fStep[i] < 0) continue;
      const t = feel.fStep[i] / feel.fSteps;
      const ramp = feel.fKind[i] === 1 ? C.RAMP_BONUS : C.RAMP_DANGER;
      ctx.fillStyle = ramp[C.rampIndex(1 - t)];
      this.drawNumber(feel.fVal[i], feel.fX[i], feel.fY[i] - C.FLOAT_RISE * easeOutCubic(t), 9);
    }
  }

  // ── 물 ──────────────────────────────────────────────────────
  drawWater(game, alpha) {
    const ctx = this.ctx;
    const wy = game.prevWater + (game.water - game.prevWater) * alpha;
    if (wy >= C.VIEW_H) return;

    // 수면 — 사인 두 개를 겹쳐 물결을 만든다. 한 프레임에 세 번 그리므로
    // sin 은 한 번만 돌리고 값을 재사용한다 (문자열도 객체도 안 만든다).
    const t = game.simTime * 0.0016;
    const wave = this.wave;
    for (let i = 0, x = 0; i < this.waveN; i++, x += 24) {
      wave[i] = Math.sin(x * 0.017 + t) * 4 + Math.sin(x * 0.041 - t * 1.7) * 2.5;
    }
    const last = (C.VIEW_W / 24) | 0;

    // 물빛을 붉게 깔았더니 잠긴 유닛이 전부 붉어져 **아군과 적군이 안 갈렸다.**
    // 색조가 아니라 밝기 문제였다. 물속은 어둡게 깔고 붉은색은 수면에만 쓴다.
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.62)];
    ctx.beginPath();
    ctx.moveTo(0, C.VIEW_H);
    for (let i = 0; i <= last; i++) ctx.lineTo(i * 24, wy + wave[i]);
    ctx.lineTo(C.VIEW_W, C.VIEW_H);
    ctx.closePath();
    ctx.fill();

    // 수면 바로 아래 붉은 띠 — 위험은 수면에 있다
    ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.34)];
    ctx.beginPath();
    ctx.moveTo(0, wy);
    for (let i = 0; i <= last; i++) ctx.lineTo(i * 24, wy + wave[i]);
    for (let i = last; i >= 0; i--) ctx.lineTo(i * 24, wy + 16 + wave[i]);
    ctx.closePath();
    ctx.fill();

    // 수면선을 밝게 — 어디까지 찼는지가 한눈에 읽혀야 한다
    ctx.strokeStyle = C.COL_DANGER;
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    for (let i = 0; i <= last; i++) {
      if (i === 0) ctx.moveTo(0, wy + wave[0]); else ctx.lineTo(i * 24, wy + wave[i]);
    }
    ctx.stroke();
  }

  // ── HUD ─────────────────────────────────────────────────────
  drawHud(game, feel, director, directorView, muted) {
    const ctx = this.ctx;

    if (feel.flashFrames > 0) {
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(feel.flashFrames / C.FLASH_FRAMES * 0.3)];
      ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
    }

    ctx.textBaseline = 'top';

    // 금 — 왼쪽 위. 가장 자주 보는 숫자다
    ctx.textAlign = 'left';
    ctx.font = FONT_SCORE;
    ctx.fillStyle = C.COL_BONUS;
    const gx = C.UNIT * 7;
    const gw = this.drawLeft(game.gold, gx, C.UNIT * 2, 15);
    ctx.font = FONT_TINY;
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.6)];
    ctx.fillText(LABEL_GOLD, gx + gw + 4, C.UNIT * 3.5);

    // 시대와 경험치
    ctx.font = FONT_SMALL;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.75)];
    ctx.fillText(C.ERA_NAME[game.era], gx, C.UNIT * 6.5);
    const need = game.eraNeed();
    if (need > 0) {
      const bw = 132, bh = 6, bx = gx + 40, by = C.UNIT * 7.6;
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.25)];
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = game.eraReady() ? C.COL_BONUS : C.RAMP_BONUS[C.rampIndex(0.6)];
      ctx.fillRect(bx, by, bw * Math.min(1, game.xp / need), bh);
      // 시대 눈금 — 다섯 칸이라는 것이 보여야 한다
      ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.9)];
      for (let i = 1; i < C.ERA_COUNT; i++) ctx.fillRect(bx + bw * (i / C.ERA_COUNT), by - 2, 2, bh + 4);
      ctx.fillStyle = C.COL_BONUS;
      for (let i = 0; i < game.era; i++) ctx.fillRect(bx - 1 + bw * (i / C.ERA_COUNT), by - 5, 3, 3);
    }

    // ── 전선 막대 — 이 게임에서 가장 중요한 한 줄 ──
    // 숫자를 읽지 않고도 **내가 밀고 있는지 밀리는지**가 보여야 한다.
    {
      const bw = 320, bh = 10;
      const bx = HALF_W - bw * 0.5, by = C.UNIT * 6.5;
      const f = game.frontline();
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.7)];
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.9)];
      ctx.fillRect(bx, by, bw * f, bh);
      ctx.fillStyle = C.RAMP_BG[C.rampIndex(1)];
      ctx.fillRect(HALF_W - 1, by - 3, 2, bh + 6);
      ctx.strokeStyle = C.RAMP_BG[C.rampIndex(1)];
      ctx.lineWidth = C.STROKE;
      ctx.strokeRect(bx, by, bw, bh);
    }

    // 시간 — 가운데 위
    ctx.textAlign = 'center';
    ctx.font = FONT_SMALL;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.55)];
    this.drawFixed1(game.elapsed(), HALF_W - 14, C.UNIT * 2.0);

    // 획득 특성 — 오른쪽 위, AI 토글 아래
    ctx.textAlign = 'right';
    ctx.font = FONT_TINY;
    let ty = C.UNIT * 8;
    for (let i = 0; i < C.TRAITS.length; i++) {
      if (!game.traits[i]) continue;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.85)];
      ctx.fillText(C.TRAITS[i].name, C.VIEW_W - C.UNIT * 2, ty);
      ty += C.UNIT * 2.1;
    }

    if (director && directorView) this.drawDirectorView(game, director);
    this.drawToggle(directorView);
    this.drawMute(muted);
  }

  // ── 버튼 열 — 이 게임의 조작 전부 ───────────────────────────
  // 열 칸이라 한 칸이 88×66 이다. **글자가 아니라 아이콘이 먼저 읽혀야 한다.**
  // 살 수 있는지 없는지는 색이 아니라 밝기로, 쿨다운은 차오르는 막대로.
  drawButtons(game) {
    const ctx = this.ctx;
    ctx.textBaseline = 'top';
    const skillCd = game.skillCd;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = C.BTN_X0 + i * (C.BTN_W + C.BTN_GAP);
      const y = C.BTN_Y;

      let ok = true, cd = 0, cost = -1, ready = true, maxed = false;
      if (i < C.UNIT_KINDS) {
        cost = game.cost(i);
        ok = game.gold >= cost;
        const full = game.spawnCooldown ? game.spawnCooldown(i) : C.U_SPAWN_CD[i];
        cd = full > 0 ? game.spawnCd[i] / full : 0;
      } else if (i === C.B_ERA) {
        ready = game.eraReady();
        ok = ready;
      } else if (i === C.B_TOWER) {
        cost = game.towerCost ? game.towerCost() : -1;
        maxed = cost < 0;
        ok = !maxed && game.gold >= cost;
      } else {
        const sk = i === C.B_TIDE ? C.SK_TIDE : C.SK_VOLLEY;
        const raw = skillCd ? (skillCd[sk] || 0) : (sk === C.SK_TIDE ? (game.nukeCd || 0) : 0);
        cd = raw / C.SKILL_CD[sk];
        ok = raw <= 0;
        ready = ok;
      }

      const accent = i >= C.B_ERA;
      const base = accent ? C.RAMP_BONUS : C.RAMP_PLAYER;
      const lit = base[C.rampIndex(ok ? 0.95 : 0.3)];

      ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.95)];
      ctx.fillRect(x, y, C.BTN_W, C.BTN_H);
      ctx.strokeStyle = base[C.rampIndex(ok ? 0.9 : 0.28)];
      ctx.lineWidth = C.STROKE;
      ctx.strokeRect(x, y, C.BTN_W, C.BTN_H);

      // 쿨다운 — 아래에서 위로 차오른다
      if (cd > 0) {
        ctx.fillStyle = base[C.rampIndex(0.14)];
        ctx.fillRect(x, y + C.BTN_H * (1 - cd), C.BTN_W, C.BTN_H * cd);
      }

      // 아이콘 — 마지막 칸은 증원 원형 버튼에 가리므로 왼쪽으로 물린다
      this.drawBtnIcon(i, x + (i === C.BTN_COUNT - 1 ? 46 : C.BTN_W - 22), y + C.BTN_H * 0.60, lit);

      ctx.textAlign = 'left';
      ctx.font = FONT_BTN;
      ctx.fillStyle = base[C.rampIndex(ok ? 1 : 0.35)];
      ctx.fillText(BTN_NAME[i], x + 7, y + 5);

      ctx.font = FONT_TINY;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.4)];
      ctx.fillText(C.KEY_HINT[i], x + C.BTN_W - 12, y + 5);

      ctx.font = FONT_SMALL;
      const ly = y + C.BTN_H - 21;
      if (cost >= 0) {
        ctx.fillStyle = ok ? C.COL_BONUS : C.RAMP_BONUS[C.rampIndex(0.35)];
        this.drawLeft(cost, x + 7, ly, 9);
      } else if (i === C.B_ERA) {
        ctx.fillStyle = ready ? C.COL_BONUS : C.RAMP_PLAYER[C.rampIndex(0.35)];
        ctx.fillText(ready ? READY : C.ERA_NAME[Math.min(C.ERA_COUNT - 1, game.era + 1)], x + 7, ly);
      } else if (maxed) {
        ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.5)];
        ctx.fillText(LABEL_MAX, x + 7, ly);
      } else {
        ctx.fillStyle = ok ? C.COL_BONUS : C.RAMP_PLAYER[C.rampIndex(0.35)];
        if (ok) ctx.fillText(READY, x + 7, ly);
        else {
          const sk = i === C.B_TIDE ? C.SK_TIDE : C.SK_VOLLEY;
          const raw = skillCd ? (skillCd[sk] || 0) : (game.nukeCd || 0);
          this.drawLeft(Math.ceil(raw / 1000), x + 7, ly, 9);
        }
      }
    }
  }

  // ── 증원 — 우하단 원형. 키보드 R ────────────────────────────
  drawRally(game) {
    const ctx = this.ctx;
    const cx = C.RALLY_CX, cy = C.RALLY_CY, r = C.RALLY_R;
    const raw = game.skillCd ? (game.skillCd[C.SK_RALLY] || 0) : 0;
    const cd = raw / C.SKILL_CD[C.SK_RALLY];
    const ok = raw <= 0;

    // 버튼 열과 겹친다. 배경을 먼저 덮어 원이 깨끗하게 뚫리게 한다
    ctx.fillStyle = C.COL_BG;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, 0, TAU);
    ctx.fill();

    if (cd > 0) {                       // 쿨다운 — 시계방향으로 줄어드는 부채꼴
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.16)];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, -Math.PI * 0.5, -Math.PI * 0.5 + TAU * cd);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(ok ? 0.95 : 0.32)];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();

    // 아이콘 — 작은 사람 셋. "셋이 온다"가 그대로 보인다
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(ok ? 1 : 0.35)];
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const px = cx + (i - 1) * 9;
      const h = i === 1 ? 13 : 10;
      ctx.rect(px - 2.5, cy - h * 0.5 + 1, 5, h);
      this.addCircle(px, cy - h * 0.5 - 2.5, 2.8);
    }
    ctx.fill();
    ctx.font = FONT_TINY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.45)];
    ctx.fillText(KEY_RALLY, cx, cy + r - 14);
    ctx.textAlign = 'left';
  }

  // 버튼 아이콘 — 유닛 실루엣의 축소판. 형태만으로 구분돼야 한다.
  drawBtnIcon(i, cx, cy, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (i === C.U_SWORD) {
      ctx.beginPath();
      ctx.rect(cx - 3, cy - 7, 6, 13);
      this.addCircle(cx, cy - 10, 3.4);
      this.addBar(cx + 4, cy - 4, 0.72, -0.69, 15, 3, 1.8, 1.2);
      this.addCircle(cx - 5, cy - 1, 3.6);              // 방패
      ctx.fill();
    } else if (i === C.U_SPEAR) {
      ctx.beginPath();
      ctx.rect(cx - 3, cy - 7, 6, 13);
      this.addCircle(cx, cy - 10, 3.4);
      this.addBar(cx - 4, cy - 4, 1, -0.1, 20, 4, 1.5, 1.3);   // 길게 뻗은 창
      this.addSpike(cx + 16, cy - 6, 1, -0.1, 6, 2.6);
      ctx.fill();
    } else if (i === C.U_ARCHER) {
      ctx.beginPath();
      ctx.rect(cx - 3, cy - 6, 6, 12);
      this.addCircle(cx, cy - 9, 3.2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + 6, cy - 3, 8, -1.1, 1.1);
      ctx.stroke();
    } else if (i === C.U_CAV) {
      ctx.beginPath();
      ctx.rect(cx - 10, cy - 2, 17, 6);                 // 말 몸통
      this.addBar(cx + 6, cy - 1, 0.7, -0.71, 9, 2, 3, 2);
      this.addBar(cx + 12, cy - 7, 0.95, -0.3, 5, 1, 2.2, 1.8);
      this.addBar(cx - 8, cy + 4, -0.3, 1, 7, 0, 1.6, 1.2);
      this.addBar(cx - 4, cy + 4, 0.3, 1, 7, 0, 1.6, 1.2);
      this.addBar(cx + 2, cy + 4, -0.3, 1, 7, 0, 1.6, 1.2);
      this.addBar(cx + 5, cy + 4, 0.3, 1, 7, 0, 1.6, 1.2);
      ctx.rect(cx - 3, cy - 10, 5, 9);                  // 기수
      this.addCircle(cx - 0.5, cy - 12, 2.6);
      ctx.fill();
    } else if (i === C.U_GIANT) {
      ctx.beginPath();
      ctx.rect(cx - 7, cy - 7, 14, 16);
      ctx.rect(cx - 10, cy - 10, 20, 4);                // 어깨
      this.addCircle(cx, cy - 13, 3);
      this.addBar(cx + 8, cy - 4, 0.72, -0.69, 12, 2, 2, 4.5);
      ctx.fill();
    } else if (i === C.U_CATA) {
      ctx.beginPath();
      this.addBar(cx - 9, cy + 5, 1, 0, 16, 0, 2.4, 2.4);
      this.addBar(cx - 2, cy + 5, 0, -1, 12, 0, 2.4, 2);
      this.addBar(cx - 2, cy - 7, -0.72, 0.69, 13, 2, 2, 1.6);
      this.addCircle(cx - 9, cy + 5, 4.6);
      this.addCircle(cx + 5, cy + 5, 3.6);
      ctx.fill();
    } else if (i === C.B_ERA) {
      ctx.beginPath();
      ctx.moveTo(cx, cy - 11); ctx.lineTo(cx + 9, cy + 2); ctx.lineTo(cx + 4, cy + 2);
      ctx.lineTo(cx + 4, cy + 10); ctx.lineTo(cx - 4, cy + 10); ctx.lineTo(cx - 4, cy + 2);
      ctx.lineTo(cx - 9, cy + 2); ctx.closePath(); ctx.fill();
    } else if (i === C.B_TOWER) {
      ctx.beginPath();
      ctx.rect(cx - 9, cy + 2, 18, 8);                  // 옥상
      ctx.rect(cx - 6, cy - 5, 12, 7);                  // 받침
      this.addBar(cx + 3, cy - 3, 1, -0.2, 12, 2, 2.4, 1.8);   // 포신
      ctx.fill();
    } else if (i === C.B_TIDE) {
      ctx.beginPath();
      for (let k = 0; k < 2; k++) {
        const yy = cy - 4 + k * 9;
        ctx.moveTo(cx - 11, yy);
        ctx.quadraticCurveTo(cx - 5, yy - 6, cx, yy);
        ctx.quadraticCurveTo(cx + 5, yy + 6, cx + 11, yy);
      }
      ctx.stroke();
    } else {
      // 화살비 — 화살 셋이 지면으로 쏟아진다
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const px = cx - 8 + k * 8;
        ctx.moveTo(px - 4, cy - 12 + (k & 1) * 4);
        ctx.lineTo(px, cy + 3 + (k & 1) * 3);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.rect(cx - 11, cy + 8, 22, 2);
      ctx.fill();
    }
  }

  drawBanner(feel) {
    if (feel.bannerFrames <= 0) return;
    const ctx = this.ctx;
    const t = 1 - feel.bannerFrames / feel.bannerTotal;
    const fade = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_BIG;
    ctx.fillStyle = feel.bannerCode === C.BAN_WATER
      ? C.RAMP_DANGER[C.rampIndex(fade)] : C.RAMP_BONUS[C.rampIndex(fade)];
    ctx.fillText(BAN_TXT[feel.bannerCode], HALF_W, C.GROUND_Y * 0.42 - easeOutCubic(t) * 24);
    ctx.textBaseline = 'top';
  }

  drawToggle(on) {
    const ctx = this.ctx;
    const a = C.rampIndex(on ? 0.75 : 0.28);
    ctx.strokeStyle = C.RAMP_PLAYER[a];
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(C.VIEW_W - TOGGLE_SIZE - C.UNIT, C.UNIT, TOGGLE_SIZE, TOGGLE_SIZE);
    ctx.fillStyle = C.RAMP_PLAYER[a];
    ctx.font = FONT_TINY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(LABEL_AI, C.VIEW_W - TOGGLE_SIZE * 0.5 - C.UNIT, C.UNIT + TOGGLE_SIZE * 0.5);
    ctx.textBaseline = 'top';
  }

  drawMute(muted) {
    const ctx = this.ctx;
    const a = C.rampIndex(muted ? 0.28 : 0.75);
    const x = C.UNIT, y = C.UNIT;
    ctx.strokeStyle = C.RAMP_PLAYER[a];
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(x, y, TOGGLE_SIZE, TOGGLE_SIZE);
    ctx.fillStyle = C.RAMP_PLAYER[a];
    ctx.beginPath();
    ctx.moveTo(x + 13, y + 15); ctx.lineTo(x + 19, y + 15); ctx.lineTo(x + 25, y + 9);
    ctx.lineTo(x + 25, y + 31); ctx.lineTo(x + 19, y + 25); ctx.lineTo(x + 13, y + 25);
    ctx.closePath();
    ctx.fill();
    if (muted) {
      ctx.beginPath();
      ctx.moveTo(x + 9, y + 31); ctx.lineTo(x + 31, y + 9);
      ctx.stroke();
    }
  }

  // ── 특성 드래프트 ───────────────────────────────────────────
  drawDraft(game, feel, director) {
    const ctx = this.ctx;
    const t = Math.min(1, game.draftFrames / Math.round(C.DRAFT_UI_MS / C.SIM_DT));
    const e = easeOutBack(t);

    // 결정의 순간이다. 뒤가 비치면 방해된다.
    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.COL_PLAYER;
    ctx.font = FONT_MID;
    ctx.fillText(LABEL_DRAFT, HALF_W, C.UNIT * 6);

    const cardH = 86, gap = C.UNIT * 2;
    const top = HALF_H - (cardH * 3 + gap * 2) * 0.5;

    for (let i = 0; i < C.TRAIT_OFFER; i++) {
      const idx = game.draftIdx[i];
      if (idx < 0) continue;
      const tr = C.TRAITS[idx];
      const y = top + i * (cardH + gap);
      const w = (C.VIEW_W * 0.62) * e;
      const x = HALF_W - w * 0.5;

      ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
      ctx.lineWidth = C.STROKE;
      ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.9)];
      ctx.beginPath();
      ctx.roundRect(x, y, w, cardH, C.RADIUS);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.font = FONT_TINY;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.9)];
      ctx.fillText(KIND_NAME[tr.kind], x + C.UNIT * 2, y + C.UNIT * 2.5);
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.45)];
      ctx.fillText(C.KEY_HINT[i], x + w - C.UNIT * 2.5, y + C.UNIT * 2.5);

      ctx.font = FONT_MID;
      ctx.fillStyle = C.COL_PLAYER;
      ctx.fillText(tr.name, x + C.UNIT * 2, y + cardH * 0.5);
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.6)];
      ctx.fillText(tr.desc, x + C.UNIT * 2, y + cardH * 0.78);
    }

    // **디렉터가 이 셋을 고른 이유** — 문장보다 강한 증거다
    if (director) {
      ctx.textAlign = 'center';
      ctx.font = FONT_TINY;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.4)];
      ctx.fillText(LABEL_WHY, HALF_W, C.VIEW_H - C.UNIT * 7);
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.85)];
      ctx.fillText(director.draftReason, HALF_W, C.VIEW_H - C.UNIT * 4);
    }
    ctx.textBaseline = 'top';
  }

  // ── 결과 ────────────────────────────────────────────────────
  drawResult(game, feel, director) {
    const ctx = this.ctx;
    if (feel.resultStep < 0) return;
    const t = feel.resultStep / feel.resultSteps;
    const e = t >= 1 ? 1 : easeOutBack(t);

    ctx.fillStyle = t >= 1 ? C.COL_BG : C.RAMP_BG[C.rampIndex(0.55 + 0.45 * t)];
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const won = game.outcome === C.WIN_PLAYER;
    ctx.font = FONT_BIG;
    ctx.fillStyle = won ? C.COL_BONUS : C.COL_PLAYER;
    ctx.fillText(won ? LABEL_WIN : (game.outcome === C.WIN_DROWN ? LABEL_DROWN : LABEL_LOSE),
                 HALF_W, HALF_H - C.UNIT * 11);

    if (director && director.deathLine && !won) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
      ctx.fillText(director.deathLine, HALF_W, HALF_H - C.UNIT * 5.5);
    }

    // 통계 넷 — 라벨은 오른쪽 정렬, 값은 왼쪽 정렬
    ctx.font = FONT_SMALL;
    const lx = HALF_W - C.UNIT * 2, vx = HALF_W + C.UNIT * 2;
    let y = HALF_H - C.UNIT * 1;
    const row = (label, drawVal) => {
      ctx.textAlign = 'right';
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.55)];
      ctx.fillText(label, lx, y);
      ctx.textAlign = 'left';
      ctx.fillStyle = C.COL_PLAYER;
      drawVal(vx, y);
      y += C.UNIT * 3.4;
    };
    row(LABEL_TIME, (x, yy) => {
      const w = this.drawFixed1(game.elapsed() * e, x, yy);
      ctx.fillText(LABEL_S, x + w + 2, yy);
    });
    row(LABEL_KILL, (x, yy) => this.drawLeft(game.kills * e, x, yy, 9));
    row(LABEL_LOST, (x, yy) => this.drawLeft(game.lost * e, x, yy, 9));
    row(LABEL_SPAWN, (x, yy) => this.drawLeft(game.spawned * e, x, yy, 9));
    row(LABEL_PROFILE, (x, yy) =>
      ctx.fillText(director ? director.profileName : PROFILE_UNKNOWN, x, yy));

    ctx.textAlign = 'center';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.6)];
    ctx.fillText(LABEL_RETRY, HALF_W, C.VIEW_H - C.UNIT * 5);
    ctx.textBaseline = 'top';
  }

  // ── 디렉터 뷰 — 디버그 오버레이가 아니라 제품 기능이다 ───────
  drawDirectorView(game, d) {
    const ctx = this.ctx;
    const lh = C.UNIT * 2.4;
    const panelH = lh * 9 + C.UNIT * 2;
    const x = C.UNIT * 2;
    const y = C.UNIT * 12;
    const w = 230;

    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(x, y, w, panelH);
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.35)];
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(x, y, w, panelH);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = FONT_TINY;
    let ly = y + C.UNIT;

    const line = (label, drawVal, color) => {
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.45)];
      ctx.fillText(label, x + C.UNIT, ly);
      if (drawVal) { ctx.fillStyle = color || C.COL_PLAYER; drawVal(x + w - C.UNIT * 12, ly); }
      ly += lh;
    };

    line(DV_PROFILE, (vx, vy) => {
      ctx.fillText(d.observing ? DV_OBSERVING : d.profileName, vx, vy);
    }, C.COL_BONUS);
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.6)];
    ctx.fillText(REASONS[d.observing ? 0 : d.reasonIdx], x + C.UNIT, ly);
    ly += lh;

    line(DV_AGGRO, (vx, vy) => this.drawFixed1(d.metricAggro * 10, vx, vy));
    line(DV_HOARD, (vx, vy) => this.drawFixed1(d.metricHoard * 10, vx, vy));
    line(DV_ECON, (vx, vy) => this.drawFixed1(d.metricEcon * 10, vx, vy));
    line(DV_SWARM, (vx, vy) => this.drawFixed1(d.metricSwarm * 10, vx, vy));

    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.45)];
    ctx.fillText(DV_LEVERS, x + C.UNIT, ly);
    ly += lh;
    const lv = d.levers;
    line(DV_MIX, (vx, vy) => {
      let cx = vx;
      for (let m = 0; m < lv.mix.length && m < C.UNIT_KINDS; m++) {
        cx += this.drawLeft(lv.mix[m], cx, vy, 7) + 3;
      }
    }, C.COL_BONUS);
    line(DV_TEMPO, (vx, vy) => this.drawLeft(lv.tempo, vx, vy, 8), C.COL_BONUS);
    line(DV_WATER, (vx, vy) => this.drawFixed1(lv.waterMul * 10, vx, vy), C.COL_BONUS);
  }
}
