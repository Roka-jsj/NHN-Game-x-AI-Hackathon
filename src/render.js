// 드로우 — 어떻게 그리는가만 담당한다. 무엇이 언제 일어나는가는 모른다.
//
// 이 파일의 규칙:
//  1. 루프 안에서 객체·배열·문자열을 만들지 않는다. 하나도.
//     숫자는 문자열로 조립하지 않고 자리별로 그린다 (= 캔버스에서의 tabular-nums).
//  2. ctx.shadowBlur 를 쓰지 않는다. 캔버스에서 압도적으로 비싸다.
//  3. 정적 지오메트리는 Path2D 로 한 번만 만든다.
//  4. save()/restore() 를 타이트 루프에서 남발하지 않는다. setTransform 으로 대체한다.

import * as C from './config.js';
import { S } from './game.js';
import { easeOutBack, easeOutCubic } from './feel.js';
import { REASONS } from './director.js';

const TAU = Math.PI * 2;
const HALF_W = C.VIEW_W * 0.5;
const HALF_H = C.VIEW_H * 0.5;

const FONT_SCORE = '30px ' + C.FONT_STACK;
const FONT_BIG = '46px ' + C.FONT_STACK;
const FONT_MID = '20px ' + C.FONT_STACK;
const FONT_SMALL = '16px ' + C.FONT_STACK;
const FONT_TINY = '13px ' + C.FONT_STACK;

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const DOT = '.';
const SIGN_MINUS = '-';
const LABEL_RETRY = '아무 키나 눌러 다시';
const LABEL_PROFILE = '프로파일';
const LABEL_BEST = '최고 점수';
const LABEL_COMBO = '최고 콤보';
const LABEL_DIST = '도달 거리';
const LABEL_M = 'm';
const LABEL_HOLD = '물이 느려졌다';
const LABEL_PUSH = '물이 밀린다';
const LABEL_AI = 'AI';
const LABEL_STAIR = '계단';
const LABEL_DRAFT = '하나를 고른다';
const LABEL_WHY = '디렉터가 이 셋을 고른 이유';
const PROFILE_UNKNOWN = '—';
const KIND_NAME = ['공격', '방어', '조작'];

const DV_PROFILE = '프로파일';
const DV_OBSERVING = '관찰 중';
const DV_LANE = 'laneBias';
const DV_GREED = 'greed';
const DV_REACT = 'reactionMs';
const DV_LEVERS = '다음 구간 레버';
const DV_DENSITY = '  density';
const DV_WATER = '  water';
const DV_TELE = '  telegraph';

const TOGGLE_SIZE = 44;
const RUNG_SPACING = 150;              // 속도감을 만드는 가로 눈금 간격
const TRACK_HALF = C.LANE_W * 1.5 + 46;

export class Renderer {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.viewScale = 1;
    this.digits = new Uint8Array(12);
    this.waterGrad = null;

    // 하늘·지평선 위 격자. 논리 해상도가 고정이라 진짜 한 번만 만든다.
    this.skyPath = new Path2D();
    for (let y = C.UNIT * 6; y < C.HORIZON_Y; y += C.UNIT * 6) {
      this.skyPath.moveTo(0, y);
      this.skyPath.lineTo(C.VIEW_W, y);
    }
    for (let x = 0; x <= C.VIEW_W; x += C.UNIT * 6) {
      this.skyPath.moveTo(x, 0);
      this.skyPath.lineTo(x, C.HORIZON_Y);
    }
  }

  resize(viewScale) {
    this.viewScale = viewScale;
    // 물 근접 경고. 화면 좌표 고정이라 리사이즈 때만 만든다.
    this.waterGrad = this.ctx.createLinearGradient(0, C.VIEW_H - 320, 0, C.VIEW_H);
    this.waterGrad.addColorStop(0, C.RAMP_DANGER[0]);
    this.waterGrad.addColorStop(1, C.RAMP_DANGER[C.rampIndex(0.5)]);
  }

  // ── 원근 투영 ───────────────────────────────────────────────
  // 곱셈 두 번, 나눗셈 한 번. 폴리곤이 많아도 싸다.
  scaleAt(z) { return C.ZNEAR / (C.ZNEAR + (z < 0 ? 0 : z)); }
  groundY(s) { return C.HORIZON_Y + (C.GROUND_Y - C.HORIZON_Y) * s; }

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

  drawFixed(v, x, y) {
    const ctx = this.ctx;
    const neg = v < 0;
    const a = neg ? -v : v;
    const whole = a | 0;
    const frac = ((a - whole) * 100 + 0.5) | 0;
    const prev = ctx.textAlign;
    ctx.textAlign = 'left';
    let cx = x;
    if (neg) { ctx.fillText(SIGN_MINUS, cx, y); cx += 6; }
    cx += this.drawLeft(whole, cx, y, 9);
    ctx.fillText(DOT, cx, y); cx += 5;
    ctx.fillText(DIGITS[(frac / 10) | 0], cx, y); cx += 9;
    ctx.fillText(DIGITS[frac % 10], cx, y);
    ctx.textAlign = prev;
  }

  static hitToggle(lx, ly) {
    return lx >= C.VIEW_W - TOGGLE_SIZE - C.UNIT * 2 && lx <= C.VIEW_W
        && ly >= 0 && ly <= TOGGLE_SIZE + C.UNIT * 2;
  }
  static hitMute(lx, ly) {
    return lx >= 0 && lx <= TOGGLE_SIZE + C.UNIT * 2
        && ly >= 0 && ly <= TOGGLE_SIZE + C.UNIT * 2;
  }

  // ── 한 프레임 ───────────────────────────────────────────────
  draw(game, feel, alpha, director, directorView, muted) {
    const ctx = this.ctx;
    const s = this.viewScale;

    const px = game.prevWorldX + (game.worldX - game.prevWorldX) * alpha;
    const foot = game.prevFootY + (game.footY - game.prevFootY) * alpha;

    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

    if (feel.shakeX !== 0 || feel.shakeY !== 0 || feel.shakeA !== 0) {
      ctx.translate(HALF_W + feel.shakeX, HALF_H + feel.shakeY);
      if (feel.shakeA !== 0) ctx.rotate(feel.shakeA);
      ctx.translate(-HALF_W, -HALF_H);
    }

    // ── 하늘 격자 — 제도 감각. 지오메트리는 캐시돼 있다 ──
    ctx.strokeStyle = C.COL_GRID;
    ctx.lineWidth = C.STROKE;
    ctx.stroke(this.skyPath);

    if (game.state === S.STAIR) this.drawStairs(game, alpha);
    else this.drawTrack(game);

    this.drawPlayer(game, feel, px, foot);
    this.drawWater(game, alpha);

    ctx.setTransform(s, 0, 0, s, 0, 0);
    this.drawHud(game, feel, director, directorView, muted);
    if (game.state === S.DRAFT) this.drawDraft(game, feel, director);
    if (game.state === S.DEAD) this.drawResult(game, feel, director);
  }

  // ── 러너 트랙 ───────────────────────────────────────────────
  drawTrack(game) {
    const ctx = this.ctx;
    const far = game.drawZ();
    const sFar = this.scaleAt(far);
    const yFar = this.groundY(sFar);
    const yNear = C.GROUND_Y;

    // 바닥면
    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.75)];
    ctx.beginPath();
    ctx.moveTo(C.VP_X - TRACK_HALF * 1.8, C.VIEW_H);
    ctx.lineTo(C.VP_X + TRACK_HALF * 1.8, C.VIEW_H);
    ctx.lineTo(C.VP_X + TRACK_HALF * sFar, yFar);
    ctx.lineTo(C.VP_X - TRACK_HALF * sFar, yFar);
    ctx.closePath();
    ctx.fill();

    // 가로 눈금 — 이게 속도를 만든다
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.22)];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    let z = RUNG_SPACING - (game.travelled % RUNG_SPACING);
    for (; z < far; z += RUNG_SPACING) {
      const sc = this.scaleAt(z);
      const gy = this.groundY(sc);
      ctx.moveTo(C.VP_X - TRACK_HALF * sc, gy);
      ctx.lineTo(C.VP_X + TRACK_HALF * sc, gy);
    }
    ctx.stroke();

    // 레인 경계 — 소실점으로 모인다
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.4)];
    ctx.beginPath();
    for (let k = 0; k < 2; k++) {
      const wx = (k === 0 ? -1 : 1) * C.LANE_W * 0.5;
      ctx.moveTo(C.VP_X + wx * 1.8, C.VIEW_H);
      ctx.lineTo(C.VP_X + wx * sFar, yFar);
    }
    ctx.stroke();
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.7)];
    ctx.beginPath();
    ctx.moveTo(C.VP_X - TRACK_HALF * 1.8, C.VIEW_H);
    ctx.lineTo(C.VP_X - TRACK_HALF * sFar, yFar);
    ctx.moveTo(C.VP_X + TRACK_HALF * 1.8, C.VIEW_H);
    ctx.lineTo(C.VP_X + TRACK_HALF * sFar, yFar);
    ctx.stroke();

    // ── 장애물과 코인 — 먼 것부터 그린다 ──
    const firstRow = Math.max(0, Math.floor(game.travelled / C.ROW_SPACING));
    const lastRow = Math.min(game.rowMade,
      Math.ceil((game.travelled + far) / C.ROW_SPACING));

    for (let i = lastRow; i >= firstRow; i--) {
      const z = game.rowZ(i) - game.travelled;
      if (z < -C.ROW_SPACING || z > far) continue;
      const sc = this.scaleAt(z);
      const gy = this.groundY(sc);
      const fade = C.rampIndex(0.35 + 0.65 * sc);

      for (let l = 0; l < C.LANE_COUNT; l++) {
        const ob = game.rowOb(i, l);
        if (ob === C.OB_NONE) continue;
        const cx = C.VP_X + C.LANE_X[l] * sc;
        const ow = ob === C.OB_LOW ? C.OB_W_LOW
                 : (ob === C.OB_BEAM ? C.OB_W_BEAM : C.OB_W_PILLAR);
        const hw = ow * 0.5 * sc;
        ctx.fillStyle = C.RAMP_STRUCT[fade];
        if (ob === C.OB_LOW) {
          // 낮고 넓은 덩어리 — 넘으라는 뜻
          ctx.fillRect(cx - hw, gy - C.OB_LOW_H * sc, hw * 2, C.OB_LOW_H * sc);
        } else if (ob === C.OB_BEAM) {
          // 공중에 떠 있고 아래가 비어 있다 — 숙이라는 뜻
          ctx.fillRect(cx - hw, gy - C.OB_BEAM_HI * sc,
                       hw * 2, (C.OB_BEAM_HI - C.OB_BEAM_LO) * sc);
          // 기둥 두 개로 떠 있음을 명시한다
          const leg = 7 * sc;
          ctx.fillRect(cx - hw, gy - C.OB_BEAM_LO * sc, leg, C.OB_BEAM_LO * sc);
          ctx.fillRect(cx + hw - leg, gy - C.OB_BEAM_LO * sc, leg, C.OB_BEAM_LO * sc);
        } else {
          // 위아래가 다 막힌 기둥 — 돌아가라는 뜻
          ctx.fillRect(cx - hw, gy - C.OB_PILLAR_H * sc, hw * 2, C.OB_PILLAR_H * sc);
        }
      }

      for (let l = 0; l < C.LANE_COUNT; l++) {
        if (!game.rowCoin(i, l) || game.rowTaken(i, l)) continue;
        const cx = C.VP_X + C.LANE_X[l] * sc;
        ctx.fillStyle = C.RAMP_BONUS[fade];
        ctx.beginPath();
        ctx.arc(cx, gy - C.COIN_H * sc, C.COIN_R * sc, 0, TAU);
        ctx.fill();
      }
    }
  }

  // ── 계단 구간 — 규칙이 바뀐 걸 눈으로 안다 ──────────────────
  drawStairs(game, alpha) {
    const ctx = this.ctx;
    const total = C.STAIR_STEPS;
    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.75)];
    ctx.fillRect(0, C.HORIZON_Y, C.VIEW_W, C.VIEW_H - C.HORIZON_Y);

    // 남은 칸을 위로 쌓아 보여준다. 좌우가 번갈아 나온다.
    for (let k = total - 1; k >= 0; k--) {
      const rel = k - game.stairStep;
      if (rel < -1 || rel > 9) continue;
      const z = rel * 190 + 40;
      const sc = this.scaleAt(z < 0 ? 0 : z);
      const gy = this.groundY(sc) - rel * 26 * sc;
      const side = (k % 2 === 0) ? 0 : 1;
      const cx = C.VP_X + (side === 0 ? -C.LANE_W : C.LANE_W) * sc;
      const hw = C.OB_W * 0.75 * sc;
      const next = rel === 0;
      ctx.fillStyle = next ? C.COL_PLAYER : C.RAMP_STRUCT[C.rampIndex(0.3 + 0.5 * sc)];
      ctx.fillRect(cx - hw, gy - 26 * sc, hw * 2, 26 * sc);
    }

    // 다음에 눌러야 할 쪽을 화면 절반으로 크게 알려준다
    const side = game.stairSide;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(game.stairStall > 0 ? 0.03 : 0.07)];
    ctx.fillRect(side === 0 ? 0 : HALF_W, C.HORIZON_Y, HALF_W, C.VIEW_H - C.HORIZON_Y);

    // 남은 시간 막대
    const t = game.stairFrames / Math.round(C.STAIR_MS / C.SIM_DT);
    ctx.fillStyle = t < 0.3 ? C.COL_DANGER : C.COL_BONUS;
    ctx.fillRect(C.UNIT * 4, C.HORIZON_Y - C.UNIT * 3,
                 (C.VIEW_W - C.UNIT * 8) * (t < 0 ? 0 : t), C.UNIT);

    ctx.fillStyle = C.COL_PLAYER;
    ctx.font = FONT_MID;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(LABEL_STAIR, HALF_W, C.HORIZON_Y - C.UNIT * 8);
    ctx.font = FONT_SCORE;
    this.drawNumber(total - game.stairStep, HALF_W, C.HORIZON_Y + C.UNIT * 2, 18);
  }

  // ── 플레이어 ────────────────────────────────────────────────
  drawPlayer(game, feel, worldX, foot) {
    const ctx = this.ctx;
    const sc = 1;                      // 플레이어는 z=0
    const cx = C.VP_X + worldX;
    const gy = C.GROUND_Y;
    const h = game.height;

    // 그림자 — 점프·슬라이드가 읽히는 유일한 단서다
    const lift = foot / C.JUMP_APEX;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.55 - 0.3 * lift)];
    ctx.beginPath();
    ctx.ellipse(cx, gy + 6, C.PLAYER_W * 0.55 * (1 - lift * 0.35),
                10 * (1 - lift * 0.4), 0, 0, TAU);
    ctx.fill();

    // 트레일
    for (let i = 0; i < C.TRAIL_MAX; i++) {
      const age = feel.tAge[i];
      if (age < 0) continue;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex((1 - age / C.TRAIL_FRAMES) * 0.16)];
      ctx.fillRect(C.VP_X + feel.tX[i] - C.PLAYER_W * 0.3,
                   C.GROUND_Y - feel.tY[i] - C.PLAYER_H * 0.5,
                   C.PLAYER_W * 0.6, C.PLAYER_H * 0.5);
    }

    // 콤보 후광 — shadowBlur 대신 반투명 겹치기
    const tier = game.comboTier();
    if (tier > 0) {
      const rings = tier > 3 ? 3 : tier;
      for (let k = rings; k >= 1; k--) {
        ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.22 - k * 0.05)];
        ctx.lineWidth = C.STROKE;
        ctx.beginPath();
        ctx.ellipse(cx + feel.shakeX, gy - foot - h * 0.5 + feel.shakeY,
                    C.PLAYER_W * 0.62 + k * 9, h * 0.6 + k * 9, 0, 0, TAU);
        ctx.stroke();
      }
    }

    // 몸통 — 스쿼시 & 스트레치
    const w = C.PLAYER_W * feel.sx;
    const hh = h * feel.sy;
    // 비틀거릴 때는 깜빡인다. 붉게 칠하지 않는다 —
    // 붉은색은 "나를 죽이는 것"이고 플레이어는 "내가 통제하는 것"이다.
    // 색 규칙을 깨면 화면 전체의 의미가 흐려진다.
    ctx.fillStyle = (game.stumble > 0 && ((game.tick / 4) | 0) % 2 === 0)
      ? C.RAMP_PLAYER[C.rampIndex(0.35)] : C.COL_PLAYER;
    ctx.beginPath();
    ctx.roundRect(cx - w * 0.5, gy - foot - hh, w, hh, C.RADIUS);
    ctx.fill();

    // 방패가 남아 있으면 테두리로 알려준다
    if (game.shieldCharges > 0) {
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.9)];
      ctx.lineWidth = C.STROKE;
      ctx.strokeRect(cx - w * 0.5 - 6, gy - foot - hh - 6, w + 12, hh + 12);
    }

    // 파티클
    for (let i = 0; i < C.PARTICLE_MAX; i++) {
      const life = feel.pLife[i];
      if (life <= 0) continue;
      const kind = feel.pKind[i];
      const ramp = kind === 2 ? C.RAMP_DANGER : (kind === 1 ? C.RAMP_BONUS : C.RAMP_STRUCT);
      ctx.fillStyle = ramp[C.rampIndex(life / feel.pMax[i])];
      const sz = feel.pSize[i];
      ctx.fillRect(C.VP_X + feel.pX[i] - sz, C.GROUND_Y - feel.pY[i] - sz, sz * 2, sz * 2);
    }

    // 링
    ctx.lineWidth = C.STROKE;
    for (let i = 0; i < C.RING_MAX; i++) {
      const st = feel.ringStep[i];
      if (st < 0) continue;
      const t = st / feel.ringSteps;
      const r = C.RING_R0 + (C.RING_R1 - C.RING_R0) * easeOutCubic(t);
      ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(1 - t)];
      ctx.beginPath();
      ctx.arc(C.VP_X + feel.ringX[i], C.GROUND_Y - feel.ringY[i], r, 0, TAU);
      ctx.stroke();
    }
  }

  // ── 물 — 뒤에서 차오른다 ────────────────────────────────────
  drawWater(game, alpha) {
    const ctx = this.ctx;
    const gap = game.prevGap + (game.gap - game.prevGap) * alpha;
    const k = 1 - gap / C.CHASE_GAP_START;
    const kk = k < 0 ? 0 : (k > 1 ? 1 : k);
    if (kk <= 0.001) return;

    const top = C.VIEW_H - kk * (C.VIEW_H - C.GROUND_Y);
    ctx.fillStyle = C.COL_DANGER;
    ctx.beginPath();
    ctx.moveTo(0, C.VIEW_H);
    ctx.lineTo(0, top);
    // 수면은 사인파로 일렁인다. 결정론적이다.
    for (let x = 0; x <= C.VIEW_W; x += 30) {
      const w = Math.sin(x * 0.02 + game.simTime * 0.004) * 7;
      ctx.lineTo(x, top + w);
    }
    ctx.lineTo(C.VIEW_W, C.VIEW_H);
    ctx.closePath();
    ctx.fill();

    const near = game.waterNear();
    if (near > 0) {
      ctx.globalAlpha = near * near;
      ctx.fillStyle = this.waterGrad;
      ctx.fillRect(0, C.VIEW_H - 320, C.VIEW_W, 320);
      ctx.globalAlpha = 1;
    }
  }

  // ── HUD ─────────────────────────────────────────────────────
  drawHud(game, feel, director, directorView, muted) {
    const ctx = this.ctx;

    if (feel.flashFrames > 0) {
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(feel.flashFrames / 3 * 0.3)];
      ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
    }

    ctx.fillStyle = C.COL_PLAYER;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = FONT_SCORE;
    this.drawNumber(game.score, HALF_W, C.UNIT * 2, 18);

    ctx.font = FONT_SMALL;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.6)];
    const wd = this.drawNumber(game.meters(), HALF_W - 10, C.UNIT * 7, 10);
    ctx.fillText(LABEL_M, HALF_W - 10 + wd * 0.5 + 7, C.UNIT * 7);

    if (game.combo > 0) {
      ctx.font = FONT_MID;
      ctx.fillStyle = game.combo >= C.COMBO_PUSH_AT ? C.COL_BONUS : C.COL_PLAYER;
      this.drawNumber(game.combo, HALF_W, C.UNIT * 12, 13);
    }
    if (game.combo >= C.COMBO_HOLD_AT) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.85)];
      ctx.fillText(game.combo >= C.COMBO_PUSH_AT ? LABEL_PUSH : LABEL_HOLD, HALF_W, C.UNIT * 16);
    }

    // 획득한 특성 — 좌하단에 이름만
    // 획득 특성 — 우상단, AI 토글 아래. 트랙 위에 겹치지 않는다.
    ctx.textAlign = 'right';
    ctx.font = FONT_TINY;
    let ty = C.UNIT * 9;
    for (let i = 0; i < C.TRAITS.length; i++) {
      if (!game.traits[i]) continue;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.85)];
      ctx.fillText(C.TRAITS[i].name, C.VIEW_W - C.UNIT * 2, ty);
      ty += C.UNIT * 2.2;
    }
    ctx.textAlign = 'center';

    if (director && directorView) this.drawDirectorView(game, director);
    this.drawToggle(directorView);
    this.drawMute(muted);
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

  // 음소거 토글. 심사자가 사무실에서 열 수도 있다. 상태는 메모리에만.
  drawMute(on) {
    const ctx = this.ctx;
    const a = C.rampIndex(on ? 0.28 : 0.75);
    ctx.strokeStyle = C.RAMP_PLAYER[a];
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(C.UNIT, C.UNIT, TOGGLE_SIZE, TOGGLE_SIZE);
    const cx = C.UNIT + TOGGLE_SIZE * 0.5;
    const cy = C.UNIT + TOGGLE_SIZE * 0.5;
    ctx.fillStyle = C.RAMP_PLAYER[a];
    ctx.fillRect(cx - 9, cy - 4, 6, 8);
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - 4);
    ctx.lineTo(cx + 3, cy - 9);
    ctx.lineTo(cx + 3, cy + 9);
    ctx.lineTo(cx - 3, cy + 4);
    ctx.closePath();
    ctx.fill();
    if (on) {
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy - 10);
      ctx.lineTo(cx + 10, cy + 10);
      ctx.stroke();
    }
  }

  // ── 특성 드래프트 — AI 디렉터의 전시장 ──────────────────────
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
    ctx.fillText(LABEL_DRAFT, HALF_W, C.UNIT * 8);

    const cardH = 132;
    const gapY = C.UNIT * 3;
    const top = HALF_H - (cardH * 3 + gapY * 2) * 0.5;

    for (let i = 0; i < C.TRAIT_OFFER; i++) {
      const idx = game.draftIdx[i];
      if (idx < 0) continue;
      const tr = C.TRAITS[idx];
      const y = top + i * (cardH + gapY);
      const w = (C.VIEW_W - C.UNIT * 8) * e;
      const x = HALF_W - w * 0.5;

      ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
      ctx.lineWidth = C.STROKE;
      ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.9)];
      ctx.beginPath();
      ctx.roundRect(x, y, w, cardH, C.RADIUS);
      ctx.fill();
      ctx.stroke();

      // 계열 표시 — 공격/방어/조작
      ctx.textAlign = 'left';
      ctx.font = FONT_TINY;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.9)];
      ctx.fillText(KIND_NAME[tr.kind], x + C.UNIT * 2, y + C.UNIT * 3);

      ctx.font = FONT_MID;
      ctx.fillStyle = C.COL_PLAYER;
      ctx.fillText(tr.name, x + C.UNIT * 2, y + cardH * 0.45);
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.6)];
      ctx.fillText(tr.desc, x + C.UNIT * 2, y + cardH * 0.75);
      ctx.textAlign = 'center';
    }

    // 디렉터가 왜 이 셋을 골랐는가 — 문장보다 강한 증거
    if (director) {
      ctx.font = FONT_TINY;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.45)];
      ctx.fillText(LABEL_WHY, HALF_W, C.VIEW_H - C.UNIT * 11);
      ctx.fillStyle = C.COL_BONUS;
      ctx.font = FONT_SMALL;
      ctx.fillText(director.draftReason || REASONS[0], HALF_W, C.VIEW_H - C.UNIT * 7);
    }
    ctx.textBaseline = 'top';
  }

  // ── 결과 ────────────────────────────────────────────────────
  drawResult(game, feel, director) {
    const ctx = this.ctx;
    if (feel.resultStep < 0) return;
    const s = this.viewScale;
    const t = feel.resultStep / feel.resultSteps;
    const e = t >= 1 ? 1 : easeOutBack(t);

    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.8)];
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

    ctx.setTransform(s * e, 0, 0, s * e, HALF_W * s, HALF_H * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (director && director.deathLine) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.55)];
      ctx.fillText(director.deathLine, 0, -C.UNIT * 17);
    }

    ctx.fillStyle = C.COL_PLAYER;
    ctx.font = FONT_BIG;
    this.drawNumber(game.score, 0, -C.UNIT * 10, 27);

    ctx.font = FONT_SMALL;
    ctx.textAlign = 'right';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.6)];
    ctx.fillText(LABEL_DIST, -C.UNIT * 2, -C.UNIT * 2);
    ctx.fillText(LABEL_BEST, -C.UNIT * 2, C.UNIT * 2);
    ctx.fillText(LABEL_COMBO, -C.UNIT * 2, C.UNIT * 6);
    ctx.fillText(LABEL_PROFILE, -C.UNIT * 2, C.UNIT * 10);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.COL_PLAYER;
    const wd = this.drawLeft(game.meters(), C.UNIT * 2, -C.UNIT * 2, 10);
    ctx.fillText(LABEL_M, C.UNIT * 2 + wd + 4, -C.UNIT * 2);
    this.drawLeft(game.bestScore, C.UNIT * 2, C.UNIT * 2, 10);
    this.drawLeft(game.bestCombo, C.UNIT * 2, C.UNIT * 6, 10);
    ctx.fillText(director ? director.profileName : PROFILE_UNKNOWN, C.UNIT * 2, C.UNIT * 10);

    ctx.textAlign = 'center';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.65)];
    ctx.fillText(LABEL_RETRY, 0, C.UNIT * 16);

    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.textBaseline = 'top';
  }

  // ── 디렉터 뷰 — 디버그 오버레이가 아니라 제품 기능이다 ───────
  drawDirectorView(game, d) {
    const ctx = this.ctx;
    const lh = C.UNIT * 2.5;
    const panelH = lh * 8 + C.UNIT * 2;
    const x = C.UNIT * 2;
    // 지평선 위 하늘 영역에 둔다. 아래로 두면 플레이어와 트랙을 가린다 —
    // 실제로 하단에 뒀다가 플레이어가 패널 뒤로 숨었다.
    const top = C.UNIT * 9;
    let y = top;

    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(x - C.UNIT, y - C.UNIT, C.UNIT * 30, panelH);
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.2)];
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(x - C.UNIT, y - C.UNIT, C.UNIT * 30, panelH);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = FONT_TINY;

    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_PROFILE, x, y);
    ctx.fillStyle = d.observing ? C.COL_BONUS : C.COL_PLAYER;
    ctx.fillText(d.observing ? DV_OBSERVING : d.profileName, x + C.UNIT * 9, y);
    y += lh;

    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_LANE, x, y);
    ctx.fillStyle = C.COL_PLAYER; this.drawFixed(d.metricLane, x + C.UNIT * 11, y);
    y += lh;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_GREED, x, y);
    ctx.fillStyle = C.COL_PLAYER; this.drawFixed(d.metricGreed, x + C.UNIT * 11, y);
    y += lh;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_REACT, x, y);
    ctx.fillStyle = C.COL_PLAYER; this.drawFixed(d.metricReact, x + C.UNIT * 11, y);
    y += lh + C.UNIT * 0.5;

    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_LEVERS, x, y);
    y += lh;
    ctx.fillStyle = C.COL_PLAYER;
    ctx.fillText(DV_DENSITY, x, y); this.drawFixed(d.levers.density, x + C.UNIT * 11, y);
    y += lh;
    ctx.fillText(DV_WATER, x, y); this.drawFixed(d.levers.waterMul, x + C.UNIT * 11, y);
    y += lh;
    ctx.fillText(DV_TELE, x, y); this.drawFixed(d.levers.telegraph, x + C.UNIT * 11, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.4)];
    this.drawNumber(d.librarySize, C.UNIT * 30, top, 8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
  }
}
