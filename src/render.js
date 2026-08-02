// 드로우 — 어떻게 그리는가만 담당한다. 무엇이 언제 일어나는가는 모른다.
//
// 이 파일의 규칙:
//  1. 루프 안에서 객체·배열·문자열을 만들지 않는다. 하나도.
//     숫자는 문자열로 조립하지 않고 자리별로 그린다 (= 캔버스에서의 tabular-nums).
//  2. ctx.shadowBlur 를 쓰지 않는다. 캔버스에서 압도적으로 비싸다.
//  3. 정적 지오메트리는 Path2D 로 한 번만 만든다.
//  4. save()/restore() 를 타이트 루프에서 남발하지 않는다. setTransform 으로 대체한다.
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

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const DOT = '.';

const BTN_NAME = ['검사', '궁수', '거인', '진화', '해일'];
const LABEL_GOLD = '금';
const LABEL_XP = '경험';
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
const DV_MIX = '  구성 검:궁:거';
const DV_TEMPO = '  간격';
const DV_WATER = '  water';

const TOGGLE_SIZE = 40;

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

    if (feel.shakeX !== 0 || feel.shakeY !== 0 || feel.shakeA !== 0) {
      ctx.translate(HALF_W + feel.shakeX, HALF_H + feel.shakeY);
      if (feel.shakeA !== 0) ctx.rotate(feel.shakeA);
      ctx.translate(-HALF_W, -HALF_H);
    }

    this.drawField(game);
    this.drawBase(game, SIDE_R);
    this.drawBase(game, SIDE_L);
    this.drawUnits(game, alpha);
    this.drawParticles(feel);
    this.drawRings(feel);
    this.drawWater(game, alpha);
    this.drawFloats(feel);

    ctx.setTransform(s, 0, 0, s, 0, 0);
    this.drawHud(game, feel, director, directorView, muted);
    this.drawButtons(game);
    this.drawBanner(feel);
    if (game.state === S.DRAFT) this.drawDraft(game, feel, director);
    if (game.state === S.OVER) this.drawResult(game, feel, director);
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
    ctx.beginPath();
    ctx.moveTo(0, C.VIEW_H);
    for (let x = 0; x <= C.VIEW_W; x += 16) ctx.lineTo(x, groundAt(x));
    ctx.lineTo(C.VIEW_W, C.VIEW_H);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.4)];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    for (let x = 0; x <= C.VIEW_W; x += 16) {
      if (x === 0) ctx.moveTo(x, groundAt(x)); else ctx.lineTo(x, groundAt(x));
    }
    ctx.stroke();

    // 지층 — 바닥 아래 가로선. 깊이가 보여야 물이 무섭다.
    ctx.strokeStyle = C.RAMP_BG[C.rampIndex(0.55)];
    ctx.lineWidth = 1;
    ctx.stroke(this.strataPath);
    ctx.lineWidth = C.STROKE;

    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.7)];
    ctx.fill(this.cliffPath);
  }

  // ── 기지 ────────────────────────────────────────────────────
  // ── 기지 — 사각형 하나가 아니라 성채로 보여야 한다 ─────────
  // 총안(battlement) · 성문 아치 · 깃대. 셋이면 "기지"로 읽힌다.
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

    // 깃대와 깃발 — 시대가 오르면 깃발이 늘어난다. 진화가 기지에도 보인다
    const era = mine ? game.era : game.aiEra;
    const px = mine ? x + 12 : x + w - 12;
    ctx.fillStyle = main;
    ctx.fillRect(px - 1.5, y - 62, 3, 30);
    for (let f = 0; f <= era; f++) {
      ctx.fillStyle = f === 0 ? main : C.COL_BONUS;
      const fy = y - 58 + f * 8;
      ctx.beginPath();
      ctx.moveTo(px, fy);
      ctx.lineTo(px + (mine ? 16 : -16), fy + 3);
      ctx.lineTo(px, fy + 6);
      ctx.closePath();
      ctx.fill();
    }

    // 체력 막대 — 기지 위에
    const bw = w + 20, bh = 9;
    const bx = cx - bw * 0.5, by = y - 78;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.92)];
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = k > 0.3 ? (mine ? C.COL_PLAYER : C.COL_STRUCT) : C.COL_DANGER;
    ctx.fillRect(bx, by, bw * k, bh);
    ctx.strokeStyle = dark;
    ctx.strokeRect(bx, by, bw, bh);
  }

  // ── 유닛 — 실루엣만으로 종류와 시대가 읽혀야 한다 ──────────
  // 사각형 하나로는 검사·궁수·거인이 구분되지 않았다. 사람 형태로 그린다.
  //   검사  한 손에 칼. 보통 체구
  //   궁수  작고 낮다. 앞으로 활을 당기고 있다
  //   거인  어깨가 넓고 몽둥이가 두껍다
  // 시대는 **머리 위에 붙는 것**으로 구분한다 — 돌(없음) 청동(볏) 강철(견갑) 기계(안테나).
  //
  // 걷는 위상을 x 좌표에서 뽑는다. 상태를 따로 안 들고도 걸을 때만 다리가 움직이고
  // 멈춰 싸울 때는 저절로 멎는다. 결정론적이고 할당이 0이다.
  drawUnits(game, alpha) {
    const ctx = this.ctx;
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!game.uAlive[i]) continue;
      const kind = game.uKind[i];
      const side = game.uSide[i];
      const mine = side === SIDE_L;
      const x = game.uPrevX[i] + (game.uX[i] - game.uPrevX[i]) * alpha;
      const era = game.uEra[i];
      const grow = 1 + era * 0.08;
      const w = C.U_W[kind] * grow;
      const h = C.U_H[kind] * grow;
      const gy = groundAt(x);
      const dir = mine ? 1 : -1;
      const hit = game.uHitFlash[i] > 0;
      const atk = game.uAttack[i];
      const walk = Math.sin(x * 0.09 + i);

      // **피격을 몸 색으로 표시하면 안 된다.** 밀집 전투에서는 매 프레임 맞으므로
      // 전원이 계속 붉어져 아군과 적군이 구분되지 않는다. 실제로 그렇게 됐다 —
      // 물 때문인 줄 알고 물 알파를 세 번 낮췄는데 원인은 이쪽이었다.
      // 소속은 몸 색이 유지하고, 피격은 **붉은 테두리**로 알린다.
      const body = mine ? C.RAMP_PLAYER[C.rampIndex(0.92)] : C.RAMP_STRUCT[C.rampIndex(0.88)];
      const dark = hit ? C.COL_DANGER : C.RAMP_BG[C.rampIndex(0.8)];

      // 발밑 그림자 — 지면에 붙어 있다는 느낌을 준다
      ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.5)];
      ctx.beginPath();
      ctx.ellipse(x, gy, w * 0.62, 3.5, 0, 0, TAU);
      ctx.fill();

      // 공격 순간 앞으로 기운다
      const lunge = atk > 0 ? dir * 4 : 0;
      const legH = h * 0.34;
      const torsoH = h * 0.44;
      const headR = w * 0.30;
      const hipY = gy - legH;
      const shY = hipY - torsoH;

      ctx.fillStyle = body;
      ctx.strokeStyle = dark;
      ctx.lineWidth = C.STROKE;

      // 다리 둘 — 걷는 위상에 따라 벌어진다
      const spread = walk * w * 0.26;
      const lw = Math.max(3, w * 0.17);
      ctx.fillRect(x - lw * 0.5 + spread + lunge, hipY, lw, legH);
      ctx.fillRect(x - lw * 0.5 - spread + lunge, hipY, lw, legH);

      // 몸통
      const bw = w * (kind === C.U_GIANT ? 0.86 : 0.62);
      ctx.fillRect(x - bw * 0.5 + lunge, shY, bw, torsoH);
      ctx.strokeRect(x - bw * 0.5 + lunge, shY, bw, torsoH);

      // 머리
      ctx.beginPath();
      ctx.arc(x + lunge + dir * w * 0.06, shY - headR * 0.9, headR, 0, TAU);
      ctx.fill();

      // ── 종류별 특징 — 이게 실루엣을 가른다 ──
      const handY = shY + torsoH * 0.3;
      if (kind === C.U_SWORD) {
        // 칼 — 공격할 때 앞으로 내려친다
        const swing = atk > 0 ? 0.9 : -0.5;
        ctx.save();
        ctx.translate(x + lunge + dir * bw * 0.5, handY);
        ctx.rotate(dir * swing);
        ctx.fillRect(0, -2, dir * h * 0.46, 4);
        ctx.fillRect(-dir * 3, -6, dir * 5, 12);        // 손잡이 가드
        ctx.restore();
      } else if (kind === C.U_ARCHER) {
        // 활 — 앞으로 당기고 있다. 공격할 때 더 휜다
        const flex = atk > 0 ? 1.35 : 1;
        ctx.strokeStyle = body;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x + lunge + dir * bw * 0.55, handY, h * 0.3 * flex, -1.1, 1.1);
        ctx.stroke();
        ctx.strokeStyle = dark;
        ctx.lineWidth = C.STROKE;
      } else {
        // 거인 — 어깨판과 몽둥이. 실루엣을 옆으로 키운다
        ctx.fillRect(x - w * 0.52 + lunge, shY - 3, w * 1.04, h * 0.11);
        ctx.strokeRect(x - w * 0.52 + lunge, shY - 3, w * 1.04, h * 0.11);
        const swing = atk > 0 ? 0.7 : -0.3;
        ctx.save();
        ctx.translate(x + lunge + dir * bw * 0.5, handY);
        ctx.rotate(dir * swing);
        ctx.fillRect(0, -4, dir * h * 0.4, 9);
        ctx.restore();
      }

      // ── 시대 표식 — 머리 위 ──
      const hy = shY - headR * 1.9;
      if (era === 1) {                                   // 청동 — 볏
        ctx.beginPath();
        ctx.moveTo(x + lunge - headR * 0.7, hy + headR * 0.5);
        ctx.lineTo(x + lunge, hy - headR * 0.5);
        ctx.lineTo(x + lunge + headR * 0.7, hy + headR * 0.5);
        ctx.closePath();
        ctx.fill();
      } else if (era === 2) {                            // 강철 — 뿔 둘
        ctx.fillRect(x + lunge - headR * 1.0, hy, 3, headR * 0.9);
        ctx.fillRect(x + lunge + headR * 0.7, hy, 3, headR * 0.9);
      } else if (era >= 3) {                             // 기계 — 안테나와 등
        ctx.fillRect(x + lunge - 1.5, hy - headR * 0.8, 3, headR * 1.4);
        ctx.fillStyle = C.COL_BONUS;
        ctx.beginPath();
        ctx.arc(x + lunge, hy - headR * 0.9, 2.6, 0, TAU);
        ctx.fill();
        ctx.fillStyle = body;
      }

      // 체력 — 남은 만큼만. 가득 차 있으면 안 그린다 (선이 시끄러워진다)
      const hk = game.uHp[i] / game.uHpMax[i];
      if (hk < 0.999) {
        const bx = x - w * 0.5, by = shY - headR * 2.4;
        ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.9)];
        ctx.fillRect(bx, by, w, 3.5);
        ctx.fillStyle = hk > 0.35 ? (mine ? C.COL_PLAYER : C.COL_STRUCT) : C.COL_DANGER;
        ctx.fillRect(bx, by, w * hk, 3.5);
      }
    }

    // 화살 — 궁수가 쏜 것이 날아가는 게 보여야 한다.
    // 이게 없으면 원거리 공격이 "아무 일도 안 일어나는데 적이 죽는" 것으로 보인다.
    ctx.lineWidth = 2;
    for (let i = 0; i < C.ARROW_MAX; i++) {
      if (game.aLife[i] <= 0) continue;
      const t = 1 - game.aLife[i] / game.aTotal[i];
      const ax = game.aX0[i] + (game.aX1[i] - game.aX0[i]) * t;
      const ay = game.aY0[i] + (game.aY1[i] - game.aY0[i]) * t - Math.sin(t * Math.PI) * 22;
      ctx.strokeStyle = game.aSide[i] === SIDE_L
        ? C.RAMP_PLAYER[C.rampIndex(0.9)] : C.RAMP_STRUCT[C.rampIndex(0.9)];
      const d = game.aX1[i] > game.aX0[i] ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(ax - d * 7, ay);
      ctx.lineTo(ax + d * 7, ay);
      ctx.stroke();
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

    // 수면 — 사인 두 개를 겹쳐 물결을 만든다. 문자열도 객체도 안 만든다.
    const t = game.simTime * 0.0016;
    // 물빛을 붉게 깔았더니 잠긴 유닛이 전부 붉어져 **아군과 적군이 안 갈렸다.**
    // 0.82 → 0.4 → 0.28 로 낮춰도 색조는 남는다. 색조가 아니라 밝기 문제였다.
    // 그래서 물속은 **어둡게** 깔고, 붉은색은 수면 근처 띠와 수면선에만 쓴다.
    // "붉은색 = 나를 죽이는 것"은 유지되면서 아래가 읽힌다.
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.62)];
    ctx.beginPath();
    ctx.moveTo(0, C.VIEW_H);
    for (let x = 0; x <= C.VIEW_W; x += 24) {
      const y = wy + Math.sin(x * 0.017 + t) * 4 + Math.sin(x * 0.041 - t * 1.7) * 2.5;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(C.VIEW_W, C.VIEW_H);
    ctx.closePath();
    ctx.fill();

    // 수면 바로 아래 붉은 띠 — 위험은 수면에 있다
    ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.34)];
    ctx.beginPath();
    ctx.moveTo(0, wy);
    for (let x = 0; x <= C.VIEW_W; x += 24) {
      const y = wy + Math.sin(x * 0.017 + t) * 4 + Math.sin(x * 0.041 - t * 1.7) * 2.5;
      ctx.lineTo(x, y);
    }
    for (let x = C.VIEW_W; x >= 0; x -= 24) {
      const y = wy + 16 + Math.sin(x * 0.017 + t) * 4 + Math.sin(x * 0.041 - t * 1.7) * 2.5;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    // 수면선을 밝게 — 어디까지 찼는지가 한눈에 읽혀야 한다
    ctx.strokeStyle = C.COL_DANGER;
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    for (let x = 0; x <= C.VIEW_W; x += 24) {
      const y = wy + Math.sin(x * 0.017 + t) * 4 + Math.sin(x * 0.041 - t * 1.7) * 2.5;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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
    }

    // ── 전선 막대 — 이 게임에서 가장 중요한 한 줄 ──
    // 숫자를 읽지 않고도 **내가 밀고 있는지 밀리는지**가 보여야 한다.
    // 전쟁시대류에서 이게 없으면 판세를 알 수 없어 무엇을 살지 정할 수가 없다.
    {
      const bw = 320, bh = 10;
      const bx = HALF_W - bw * 0.5, by = C.UNIT * 6.5;
      const f = game.frontline();
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.7)];
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.9)];
      ctx.fillRect(bx, by, bw * f, bh);
      // 가운데 눈금 — 균형점
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

  // ── 버튼 — 이 게임의 조작 전부 ──────────────────────────────
  // 살 수 있는지 없는지가 **색이 아니라 밝기**로 읽혀야 한다.
  // 쿨다운은 버튼 위를 덮는 막대로 보여 준다 — 숫자를 읽게 하지 않는다.
  drawButtons(game) {
    const ctx = this.ctx;
    ctx.textBaseline = 'top';
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = C.BTN_X0 + i * (C.BTN_W + C.BTN_GAP);
      const y = C.BTN_Y;

      let ok = true, cd = 0, cost = 0, ready = true;
      if (i <= C.B_GIANT) {
        cost = game.cost(i);
        ok = game.gold >= cost;
        cd = game.spawnCd[i] / game.spawnCooldown(i);
      } else if (i === C.B_ERA) {
        ready = game.eraReady();
        ok = ready;
      } else {
        cd = game.nukeCd / C.NUKE_CD;
        ok = cd <= 0;
      }

      const accent = i === C.B_ERA || i === C.B_NUKE;
      const base = accent ? C.RAMP_BONUS : C.RAMP_PLAYER;

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

      // 아이콘 — 유닛 실루엣을 그대로 축소해 넣는다.
      // 글자만 있으면 무엇을 사는지 손이 기억하지 못한다.
      this.drawBtnIcon(i, x + C.BTN_W - C.UNIT * 4, y + C.BTN_H * 0.55,
                       base[C.rampIndex(ok ? 0.95 : 0.3)]);

      ctx.textAlign = 'left';
      ctx.font = FONT_MID;
      ctx.fillStyle = base[C.rampIndex(ok ? 1 : 0.35)];
      ctx.fillText(BTN_NAME[i], x + C.UNIT * 1.5, y + C.UNIT);

      ctx.font = FONT_TINY;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.4)];
      ctx.fillText(C.KEY_HINT[i], x + C.BTN_W - C.UNIT * 2, y + C.UNIT);

      ctx.font = FONT_SMALL;
      if (i <= C.B_GIANT) {
        ctx.fillStyle = ok ? C.COL_BONUS : C.RAMP_BONUS[C.rampIndex(0.35)];
        this.drawLeft(cost, x + C.UNIT * 1.5, y + C.UNIT * 4.6, 9);
      } else if (i === C.B_ERA) {
        ctx.fillStyle = ready ? C.COL_BONUS : C.RAMP_PLAYER[C.rampIndex(0.35)];
        ctx.fillText(ready ? READY : C.ERA_NAME[Math.min(C.ERA_COUNT - 1, game.era + 1)],
                     x + C.UNIT * 1.5, y + C.UNIT * 4.6);
      } else {
        ctx.fillStyle = ok ? C.COL_BONUS : C.RAMP_PLAYER[C.rampIndex(0.35)];
        if (ok) ctx.fillText(READY, x + C.UNIT * 1.5, y + C.UNIT * 4.6);
        else this.drawLeft(Math.ceil(game.nukeCd / 1000), x + C.UNIT * 1.5, y + C.UNIT * 4.6, 9);
      }
    }
  }

  // 버튼 아이콘 — 유닛 실루엣의 축소판. 형태만으로 구분돼야 한다.
  drawBtnIcon(i, cx, cy, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (i === C.B_SWORD) {
      ctx.fillRect(cx - 4, cy - 8, 8, 16);
      ctx.beginPath(); ctx.arc(cx, cy - 12, 4, 0, TAU); ctx.fill();
      ctx.fillRect(cx + 5, cy - 10, 3, 18);                 // 칼
    } else if (i === C.B_ARCHER) {
      ctx.fillRect(cx - 3, cy - 6, 7, 14);
      ctx.beginPath(); ctx.arc(cx, cy - 10, 3.5, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 8, cy - 2, 8, -1.1, 1.1); ctx.stroke();
    } else if (i === C.B_GIANT) {
      ctx.fillRect(cx - 7, cy - 8, 14, 18);
      ctx.fillRect(cx - 10, cy - 10, 20, 4);                // 어깨
      ctx.beginPath(); ctx.arc(cx, cy - 14, 3.5, 0, TAU); ctx.fill();
    } else if (i === C.B_ERA) {
      // 위로 향한 화살표 — 올라간다
      ctx.beginPath();
      ctx.moveTo(cx, cy - 11); ctx.lineTo(cx + 9, cy + 2); ctx.lineTo(cx + 4, cy + 2);
      ctx.lineTo(cx + 4, cy + 10); ctx.lineTo(cx - 4, cy + 10); ctx.lineTo(cx - 4, cy + 2);
      ctx.lineTo(cx - 9, cy + 2); ctx.closePath(); ctx.fill();
    } else {
      // 해일 — 파도 두 줄
      ctx.beginPath();
      for (let k = 0; k < 2; k++) {
        const yy = cy - 4 + k * 9;
        ctx.moveTo(cx - 11, yy);
        ctx.quadraticCurveTo(cx - 5, yy - 6, cx, yy);
        ctx.quadraticCurveTo(cx + 5, yy + 6, cx + 11, yy);
      }
      ctx.stroke();
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
      if (drawVal) { ctx.fillStyle = color || C.COL_PLAYER; drawVal(x + w - C.UNIT * 9, ly); }
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
      cx += this.drawLeft(lv.mix[0], cx, vy, 8) + 4;
      cx += this.drawLeft(lv.mix[1], cx, vy, 8) + 4;
      this.drawLeft(lv.mix[2], cx, vy, 8);
    }, C.COL_BONUS);
    line(DV_TEMPO, (vx, vy) => this.drawLeft(lv.tempo, vx, vy, 8), C.COL_BONUS);
    line(DV_WATER, (vx, vy) => this.drawFixed1(lv.waterMul * 10, vx, vy), C.COL_BONUS);
  }
}
