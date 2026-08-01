// 드로우 — 어떻게 그리는가만 담당한다. 무엇이 언제 일어나는가는 모른다.
//
// 이 파일의 규칙:
//  1. 루프 안에서 객체·배열·문자열을 만들지 않는다. 하나도.
//     숫자는 문자열로 조립하지 않고 자리별로 그린다 (= 캔버스에서의 tabular-nums).
//  2. ctx.shadowBlur 를 쓰지 않는다. 캔버스에서 압도적으로 비싸다.
//     글로우가 필요하면 반투명 도형을 겹친다.
//  3. 정적 배경은 오프스크린에 한 번 그려두고 매 프레임 drawImage 한 번으로 낸다.
//  4. save()/restore() 를 타이트 루프에서 남발하지 않는다. setTransform 으로 대체한다.

import * as C from './config.js';
import { S } from './game.js';
import { easeOutBack, easeOutCubic } from './feel.js';
import { REASONS } from './director.js';

const ANCHOR_Y = C.CAM_ANCHOR * C.VIEW_H;
const HALF_W = C.VIEW_W * 0.5;
const HALF_H = C.VIEW_H * 0.5;
const TAU = Math.PI * 2;

// 폰트 문자열을 매 프레임 조립하면 그것도 할당이다. 한 번만 만든다.
const FONT_SCORE = '28px ' + C.FONT_STACK;
const FONT_BIG = '44px ' + C.FONT_STACK;
const FONT_SMALL = '18px ' + C.FONT_STACK;
const FONT_COMBO = '22px ' + C.FONT_STACK;
const FONT_TINY = '13px ' + C.FONT_STACK;

// 숫자 렌더용 — 문자 하나짜리 상수 문자열. 루프에서 새로 만들지 않는다.
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const DOT = '.';
const SIGN_MINUS = '-';
const LABEL_RETRY = '탭하면 다시';
const LABEL_PROFILE = '프로파일';
const LABEL_BEST = '최고 점수';
const LABEL_COMBO = '최고 콤보';
const LABEL_HOLD = '물이 멈췄다';
const LABEL_PUSH = '물이 내려간다';
const LABEL_AI = 'AI';
const PROFILE_UNKNOWN = '—';

const DV_PROFILE = '프로파일';
const DV_OBSERVING = '관찰 중';
const DV_CHARGE = 'chargeRatio';
const DV_AIM = 'aimError';
const DV_STDEV = 'chargeStdev';
const DV_LEVERS = '다음 구간 레버';
const DV_WATER = '  waterSpeed';
const DV_THICK = '  thickness';
const DV_WOBBLE = '  aimWobble';

const TOGGLE_SIZE = 44;   // 손가락으로 누를 수 있는 최소 크기

// 스크롤하는 정적 요소(제도 격자)의 타일 높이. 이 높이로 나눈 나머지만큼 밀어 그린다.
const TILE_H = 240;

export class Renderer {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.viewScale = 1;
    this.waterGrad = null;

    // 자릿수 버퍼. 숫자를 그릴 때마다 배열을 만들지 않는다.
    this.digits = new Uint8Array(12);

    // ── 정적 지오메트리는 Path2D 로 한 번만 만든다 ──
    //
    // 문서는 "정적 배경을 별도 캔버스에 한 번 렌더해두고 매 프레임 drawImage 한 번"을
    // 지시했다. 그대로 만들고 **재봤더니 그게 이 프로젝트에서 가장 비싼 코드였다.**
    //
    //   오프스크린 캔버스 blit : avg 1.031ms/frame, 16.7ms 초과 18회 (최대 648ms)
    //   ImageBitmap 으로 blit  : avg 1.027ms/frame, 16.7ms 초과 18회 (최대 646ms)
    //   Path2D 캐시 (이 코드)  : avg 0.019ms/frame, 16.7ms 초과 0회
    //
    // 캔버스↔캔버스 전송이 주기적으로 큰 동기화를 유발한다. ImageBitmap 으로 바꿔도
    // 똑같았다. 목적은 "정적인 것을 매 프레임 다시 계산하지 않는다"이고,
    // Path2D 는 그 목적을 55배 싸게 달성한다. 지오메트리는 여기서 한 번만 만들어지고
    // 매 프레임에는 래스터화만 일어난다.
    //
    // 논리 해상도가 540×960 고정이라 이 경로들은 화면 크기와 무관하다. 진짜 한 번만 만든다.
    this.wallPath = new Path2D();
    this.wallPath.rect(0, 0, C.WALL_INSET, C.VIEW_H);
    this.wallPath.rect(C.VIEW_W - C.WALL_INSET, 0, C.WALL_INSET, C.VIEW_H);

    // 제도 격자 — 거의 안 보인다. 깊이감만 담당한다.
    // 타일 하나(TILE_H)만큼 밀어 그리므로, 화면 높이 + 타일 하나를 덮도록 만든다.
    // 여백 단위 8의 배수만 쓴다 — 격자 간격도 예외가 아니다.
    this.gridPath = new Path2D();
    const G = C.UNIT * 6;                       // 48px
    const span = C.VIEW_H + TILE_H;
    for (let gy = 0; gy <= span; gy += G) {
      this.gridPath.moveTo(C.WALL_INSET, gy);
      this.gridPath.lineTo(C.VIEW_W - C.WALL_INSET, gy);
    }
    for (let gx = C.WALL_INSET + G; gx < C.VIEW_W - C.WALL_INSET; gx += G) {
      this.gridPath.moveTo(gx, 0);
      this.gridPath.lineTo(gx, span);
    }
    this.hasGrid = true;

    // 십자 조준점은 모양이 늘 같다. 한 번 만들어 두고 위치만 옮긴다.
    this.crosshair = new Path2D();
    this.crosshair.moveTo(-10, 0); this.crosshair.lineTo(10, 0);
    this.crosshair.moveTo(0, -10); this.crosshair.lineTo(0, 10);
  }

  // resize 에서만 불린다. 매 프레임 금지.
  resize(viewScale) {
    this.viewScale = viewScale;
    // 화면 좌표 고정이라 리사이즈 때만 만든다.
    this.waterGrad = this.ctx.createLinearGradient(0, C.VIEW_H - 260, 0, C.VIEW_H);
    this.waterGrad.addColorStop(0, C.RAMP_DANGER[0]);
    this.waterGrad.addColorStop(1, C.RAMP_DANGER[C.rampIndex(0.45)]);
  }

  // 숫자를 자리별로 고정 피치에 그린다.
  // 문자열을 만들지 않고, 자릿수가 늘어도 글자가 흔들리지 않는다 (tabular-nums 등가).
  drawNumber(v, cx, y, pitch) {
    const ctx = this.ctx;
    let n = v < 0 ? 0 : (v | 0);
    let count = 0;
    if (n === 0) { this.digits[count++] = 0; }
    while (n > 0 && count < 12) { this.digits[count++] = n % 10; n = (n / 10) | 0; }
    const total = count * pitch;
    let x = cx - total * 0.5 + pitch * 0.5;
    for (let i = count - 1; i >= 0; i--) {
      ctx.fillText(DIGITS[this.digits[i]], x, y);
      x += pitch;
    }
    return total;
  }

  // 논리 좌표가 디렉터 뷰 토글 안에 있는가. main 의 포인터 핸들러가 쓴다.
  static hitToggle(lx, ly) {
    return lx >= C.VIEW_W - TOGGLE_SIZE - C.UNIT * 2 && lx <= C.VIEW_W
        && ly >= 0 && ly <= TOGGLE_SIZE + C.UNIT * 2;
  }

  draw(game, feel, alpha, director, directorView) {
    const ctx = this.ctx;
    const s = this.viewScale;

    const camY = game.prevCamY + (game.camY - game.prevCamY) * alpha;
    const px = game.prevPlayerX + (game.playerX - game.prevPlayerX) * alpha;
    const py = game.prevPlayerY + (game.playerY - game.prevPlayerY) * alpha;
    const wy = game.prevWaterY + (game.waterY - game.prevWaterY) * alpha;

    // 카메라 리드 — 상승 방향으로 살짝 앞을 본다. 렌더 전용이다.
    const camEff = camY + (game.playerY - game.prevPlayerY) * C.CAM_LEAD;
    const originY = ANCHOR_Y + camEff;   // 월드 y=0 이 놓이는 화면 y

    ctx.setTransform(s, 0, 0, s, 0, 0);

    // 스크린 셰이크 — 이동 + 미세 회전
    if (feel.shakeX !== 0 || feel.shakeY !== 0 || feel.shakeA !== 0) {
      ctx.translate(HALF_W + feel.shakeX, HALF_H + feel.shakeY);
      if (feel.shakeA !== 0) ctx.rotate(feel.shakeA);
      ctx.translate(-HALF_W, -HALF_H);
    }

    // ── 정적 배경 — 지오메트리는 캐시돼 있다. 매 프레임 계산하지 않는다 ──
    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
    if (this.hasGrid) {
      // 격자만 카메라를 따라 스크롤한다. 타일 높이로 나눈 나머지만큼 밀어 그린다.
      let off = originY % TILE_H;
      if (off > 0) off -= TILE_H;
      ctx.translate(0, off);
      // 선 굵기는 프로젝트 전체에서 2px 하나뿐이다. 격자도 예외가 아니다.
      // 격자색(#1B3341)이 배경(#12242E)과 거의 같아서 2px 이어도 조용하다.
      ctx.strokeStyle = C.COL_GRID;
      ctx.lineWidth = C.STROKE;
      ctx.stroke(this.gridPath);
      ctx.translate(0, -off);
    }
    ctx.fillStyle = C.COL_GRID;
    ctx.fill(this.wallPath);

    // ── 발판 — 보이는 구간만 순회한다 ──
    // 0..platMade 를 전부 도는 건 O(n) 이 계속 자라고,
    // 발판 풀이 64칸 링버퍼라 옛 인덱스는 재활용된 슬롯을 읽어 유령 발판을 그린다.
    const first = game.platIdx - 8 < 0 ? 0 : game.platIdx - 8;
    const last = game.platMade < game.platIdx + C.LOOKAHEAD
      ? game.platMade : game.platIdx + C.LOOKAHEAD;

    // ① 이동 발판의 궤도를 먼저 깔아준다. 어디까지 오갈지 보여야 읽을 수 있다.
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.22)];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    for (let i = first; i <= last; i++) {
      if ((game.platFlagsAt(i) & C.F_MOVING) === 0 || game.platGone(i)) continue;
      const cy = originY - game.platBaseY(i);
      if (cy < -60 || cy > C.VIEW_H + 60) continue;
      const cx = game.platSideAt(i) === 0
        ? C.PLATFORM_X0 + C.PLATFORM_REACH * 0.5
        : C.VIEW_W - C.PLATFORM_X0 - C.PLATFORM_REACH * 0.5;
      ctx.moveTo(cx, cy - C.MOVE_AMP);
      ctx.lineTo(cx, cy + C.MOVE_AMP);
    }
    ctx.stroke();

    // ② 보통 발판 — 같은 fillStyle 끼리 모아 그린다
    ctx.fillStyle = C.COL_STRUCT;
    for (let i = first; i <= last; i++) {
      const f = game.platFlagsAt(i);
      if (game.platGone(i) || (f & C.F_BONUS) || (f & C.F_CRUMBLE)) continue;
      const sy = originY - game.platYAt(i);
      if (sy < -40 || sy > C.VIEW_H + 40) continue;
      const th = C.PLATFORM_THICKNESS * game.platThickAt(i);
      const x = game.platSideAt(i) === 0
        ? C.PLATFORM_X0 : C.VIEW_W - C.PLATFORM_X0 - C.PLATFORM_REACH;
      ctx.fillRect(x, sy - th * 0.5, C.PLATFORM_REACH, th);
    }

    // ③ 부서지는 발판 — 무너지는 동안 얇아지고 붉어진다. 색이 곧 규칙이다
    for (let i = first; i <= last; i++) {
      const f = game.platFlagsAt(i);
      if (game.platGone(i) || (f & C.F_CRUMBLE) === 0) continue;
      const sy = originY - game.platYAt(i);
      if (sy < -40 || sy > C.VIEW_H + 40) continue;
      const left = game.crumbleLeft(i);
      const live = left > 0 ? left / C.CRUMBLE_FRAMES : 1;
      const th = C.PLATFORM_THICKNESS * game.platThickAt(i) * (0.4 + 0.6 * live);
      const x = game.platSideAt(i) === 0
        ? C.PLATFORM_X0 : C.VIEW_W - C.PLATFORM_X0 - C.PLATFORM_REACH;
      // 무너지기 시작하면 위험색으로 넘어간다
      ctx.fillStyle = left > 0 ? C.RAMP_DANGER[C.rampIndex(0.45 + 0.55 * (1 - live))]
                               : C.RAMP_STRUCT[C.rampIndex(0.55)];
      // 갈라진 틈 — 조각 3개로 그린다
      const seg = C.PLATFORM_REACH / 3 - 3;
      for (let k = 0; k < 3; k++) {
        ctx.fillRect(x + k * (C.PLATFORM_REACH / 3), sy - th * 0.5, seg, th);
      }
    }

    // ④ 보너스 앰버 — 한 구간에 0~1개
    ctx.fillStyle = C.COL_BONUS;
    for (let i = first; i <= last; i++) {
      if (game.platGone(i) || (game.platFlagsAt(i) & C.F_BONUS) === 0) continue;
      const sy = originY - game.platYAt(i);
      if (sy < -40 || sy > C.VIEW_H + 40) continue;
      const th = C.PLATFORM_THICKNESS * game.platThickAt(i);
      const x = game.platSideAt(i) === 0
        ? C.PLATFORM_X0 : C.VIEW_W - C.PLATFORM_X0 - C.PLATFORM_REACH;
      ctx.fillRect(x, sy - th * 0.5, C.PLATFORM_REACH, th);
    }

    // ⑤ 관문 — 12발판마다 가로선. 끝없이 오르는 데 마디를 준다
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.30)];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    for (let i = first; i <= last; i++) {
      if (i === 0 || i % C.GATE_EVERY !== 0) continue;
      const gy = originY - game.platBaseY(i);
      if (gy < -8 || gy > C.VIEW_H + 8) continue;
      ctx.moveTo(C.WALL_INSET, gy);
      ctx.lineTo(C.VIEW_W - C.WALL_INSET, gy);
    }
    ctx.stroke();

    // ── 최고 기록선 — 점선 한 줄. 통과하는 순간이 사건이 되도록 ──
    if (game.bestY > 0) {
      const by = originY - game.bestY;
      if (by > -8 && by < C.VIEW_H + 8) {
        ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.35)];
        ctx.lineWidth = C.STROKE;
        ctx.beginPath();
        for (let x = C.WALL_INSET; x < C.VIEW_W - C.WALL_INSET; x += C.UNIT * 3) {
          ctx.moveTo(x, by);
          ctx.lineTo(x + C.UNIT * 1.5, by);
        }
        ctx.stroke();
      }
    }

    // ── 물 ──
    const waterSy = originY - wy;
    if (waterSy < C.VIEW_H) {
      ctx.fillStyle = C.COL_DANGER;
      ctx.fillRect(0, waterSy, C.VIEW_W, C.VIEW_H - waterSy + 8);
    }

    // 물 근접 경고 — 하단 그라디언트 하나만 허용된다
    const margin = game.waterMargin();
    if (margin < C.WATER_NEAR_PX) {
      const near = margin <= 0 ? 1 : 1 - margin / C.WATER_NEAR_PX;
      ctx.globalAlpha = near * near;
      ctx.fillStyle = this.waterGrad;
      ctx.fillRect(0, C.VIEW_H - 260, C.VIEW_W, 260);
      ctx.globalAlpha = 1;
    }

    const playerSy = originY - py;

    // ── 트레일 ──
    for (let i = 0; i < C.TRAIL_MAX; i++) {
      const age = feel.tAge[i];
      if (age < 0) continue;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex((1 - age / C.TRAIL_FRAMES) * 0.30)];
      ctx.beginPath();
      ctx.arc(feel.tX[i], originY - feel.tY[i], C.PLAYER_RADIUS * 0.7, 0, TAU);
      ctx.fill();
    }

    // ── 조준선 — 이 게임의 시그니처. 선형이다. 이징 금지 ──
    if (game.state === S.CHARGING) {
      const nowSim = game.simTime + alpha * C.SIM_DT;
      const dist = game.aimPreview(nowSim);
      const wob = game.wobbleOffset(dist, nowSim);
      const blink = feel.overcharge && (((game.tick / 6) | 0) & 1) === 0;
      ctx.strokeStyle = blink ? C.COL_DANGER : C.COL_PLAYER;
      ctx.lineWidth = C.STROKE;
      ctx.beginPath();
      ctx.moveTo(px, playerSy);
      ctx.lineTo(px, playerSy - dist);
      // 제도 눈금 — 90px마다. "뛴다"가 아니라 "잰다"는 감각
      for (let d = C.LEAP_DIST_MIN; d <= dist; d += 90) {
        const ty = playerSy - d;
        ctx.moveTo(px - 6, ty);
        ctx.lineTo(px + 6, ty);
      }
      ctx.stroke();

      // 예측 발판 — 이동 발판이 "도착하는 순간" 어디 있을지를 그려준다.
      // 도착 시점에 판정하면서 미래를 안 보여주면 실패가 플레이어 탓이 아니게 된다.
      const pi = game.previewTarget(nowSim);
      if (pi >= 0 && (game.platFlagsAt(pi) & C.F_MOVING)) {
        const gy = originY - game.platYAtTime(pi, game.previewArrive);
        const gth = C.PLATFORM_THICKNESS * game.platThickAt(pi);
        const gx = game.platSideAt(pi) === 0
          ? C.PLATFORM_X0 : C.VIEW_W - C.PLATFORM_X0 - C.PLATFORM_REACH;
        ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.55)];
        ctx.strokeRect(gx, gy - gth * 0.5, C.PLATFORM_REACH, gth);
        ctx.strokeStyle = blink ? C.COL_DANGER : C.COL_PLAYER;
      }

      // 십자 조준점 — 사인파로 진동한다. Path2D 재사용
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.translate(px + feel.shakeX, playerSy - dist - wob + feel.shakeY);
      ctx.stroke(this.crosshair);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      if (feel.shakeX !== 0 || feel.shakeY !== 0 || feel.shakeA !== 0) {
        ctx.translate(HALF_W + feel.shakeX, HALF_H + feel.shakeY);
        if (feel.shakeA !== 0) ctx.rotate(feel.shakeA);
        ctx.translate(-HALF_W, -HALF_H);
      }
    }

    // ── 링 — 완벽 착지 확산 ──
    ctx.lineWidth = C.STROKE;
    for (let i = 0; i < C.RING_MAX; i++) {
      const st = feel.ringStep[i];
      if (st < 0) continue;
      const t = st / feel.ringSteps;
      const r = C.RING_R0 + (C.RING_R1 - C.RING_R0) * easeOutCubic(t);
      ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(1 - t)];
      ctx.beginPath();
      ctx.arc(feel.ringX[i], originY - feel.ringY[i], r, 0, TAU);
      ctx.stroke();
    }

    // ── 파티클 ──
    for (let i = 0; i < C.PARTICLE_MAX; i++) {
      const life = feel.pLife[i];
      if (life <= 0) continue;
      const kind = feel.pKind[i];
      const ramp = kind === 2 ? C.RAMP_DANGER : (kind === 1 ? C.RAMP_PLAYER : C.RAMP_STRUCT);
      ctx.fillStyle = ramp[C.rampIndex(life / feel.pMax[i])];
      const sz = feel.pSize[i];
      ctx.fillRect(feel.pX[i] - sz, originY - feel.pY[i] - sz, sz * 2, sz * 2);
    }

    // ── 콤보 후광 — 티어가 오를수록 두꺼워진다.
    // shadowBlur 는 쓰지 않는다. 반투명 원을 겹친다.
    const tier = game.comboTier();
    if (tier > 0) {
      const rings = tier > 3 ? 3 : tier;
      for (let k = rings; k >= 1; k--) {
        ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.10 - k * 0.02)];
        ctx.beginPath();
        ctx.arc(px + feel.shakeX, playerSy + feel.shakeY,
                C.PLAYER_RADIUS + k * 9, 0, TAU);
        ctx.fill();
      }
    }

    // ── 플레이어 — 스쿼시 & 스트레치. save/restore 대신 setTransform ──
    ctx.setTransform(
      s * feel.sx, 0, 0, s * feel.sy,
      (px + feel.shakeX) * s, (playerSy + feel.shakeY) * s
    );
    ctx.fillStyle = C.COL_PLAYER;
    ctx.beginPath();
    ctx.arc(0, 0, C.PLAYER_RADIUS, 0, TAU);
    ctx.fill();

    // ── HUD — 셰이크의 영향을 받지 않는다 ──
    ctx.setTransform(s, 0, 0, s, 0, 0);

    if (feel.flashFrames > 0) {
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(feel.flashFrames / 3 * 0.35)];
      ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
    }

    ctx.fillStyle = C.COL_PLAYER;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = FONT_SCORE;
    this.drawNumber(game.score, HALF_W, C.UNIT * 4, 17);

    // 콤보 — 플레이어 옆에 붙인다. 시선이 화면 구석으로 끌려가면 안 된다.
    if (game.combo > 0) {
      ctx.font = FONT_COMBO;
      ctx.textAlign = 'left';
      ctx.fillStyle = game.combo >= C.COMBO_PUSH_AT ? C.COL_BONUS : C.COL_PLAYER;
      const side = game.playerX < HALF_W ? 1 : -1;
      ctx.textAlign = side > 0 ? 'left' : 'right';
      const cx = px + side * (C.PLAYER_RADIUS + C.UNIT * 2);
      this.drawNumber(game.combo, cx + side * C.UNIT * 2, playerSy - C.UNIT * 2, 14);
      ctx.textAlign = 'center';
    }

    // 물이 붙잡혀 있다는 사실은 알려줘야 한다. 콤보의 의미가 여기서 드러난다.
    if (game.combo >= C.COMBO_HOLD_AT) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.85)];
      ctx.fillText(game.combo >= C.COMBO_PUSH_AT ? LABEL_PUSH : LABEL_HOLD, HALF_W, C.UNIT * 10);
    }

    if (director && directorView) this.drawDirectorView(game, director);
    this.drawToggle(directorView);

    if (game.state === S.DEAD && feel.resultStep >= 0) {
      const t = feel.resultStep / feel.resultSteps;
      const e = t >= 1 ? 1 : easeOutBack(t);
      ctx.setTransform(s * e, 0, 0, s * e, HALF_W * s, HALF_H * s);
      ctx.fillStyle = C.COL_PLAYER;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (director && director.deathLine) {
        ctx.font = FONT_SMALL;
        ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.55)];
        ctx.fillText(director.deathLine, 0, -C.UNIT * 15);
      }

      ctx.fillStyle = C.COL_PLAYER;
      ctx.font = FONT_BIG;
      this.drawNumber(game.score, 0, -C.UNIT * 9, 26);

      ctx.font = FONT_SMALL;
      ctx.textAlign = 'right';
      ctx.fillText(LABEL_BEST, -C.UNIT * 2, -C.UNIT * 3);
      ctx.fillText(LABEL_COMBO, -C.UNIT * 2, C.UNIT * 1);
      ctx.fillText(LABEL_PROFILE, -C.UNIT * 2, C.UNIT * 5);
      ctx.textAlign = 'left';
      this.drawNumber(game.bestScore, C.UNIT * 6, -C.UNIT * 3, 11);
      this.drawNumber(game.comboBest, C.UNIT * 6, C.UNIT * 1, 11);
      ctx.fillText(director ? director.profileName : PROFILE_UNKNOWN, C.UNIT * 2, C.UNIT * 5);

      ctx.textAlign = 'center';
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.65)];
      ctx.fillText(LABEL_RETRY, 0, C.UNIT * 11);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
    }
  }

  // 디렉터 뷰 토글 — 우상단. 게임 입력과 겹치지 않는 히트영역이다.
  drawToggle(on) {
    const ctx = this.ctx;
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(on ? 0.75 : 0.28)];
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(
      C.VIEW_W - TOGGLE_SIZE - C.UNIT, C.UNIT,
      TOGGLE_SIZE, TOGGLE_SIZE
    );
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(on ? 0.75 : 0.28)];
    ctx.font = FONT_TINY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(LABEL_AI, C.VIEW_W - TOGGLE_SIZE * 0.5 - C.UNIT, C.UNIT + TOGGLE_SIZE * 0.5);
    ctx.textBaseline = 'top';
  }

  // ── 디렉터 뷰 ──────────────────────────────────────────────
  // 디버그 오버레이가 아니라 제품 기능이다.
  // "AI가 실제로 판단하고 있다"에 대한 가장 강한 증거는 문장이 아니라 이 화면이다.
  drawDirectorView(game, d) {
    const ctx = this.ctx;
    const lh = C.UNIT * 2.5;
    const panelH = lh * 9 + C.UNIT * 2;
    const x = C.UNIT * 2;
    // 하단에 붙인다. 플레이어는 화면 상단 40%에 고정돼 있으므로 아래가 비어 있다.
    // 처음엔 상단에 뒀다가 발판과 플레이어를 가렸다.
    const top = C.VIEW_H - panelH - C.UNIT * 3;
    let y = top;

    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.85)];
    ctx.fillRect(x - C.UNIT, y - C.UNIT, C.UNIT * 30, panelH);
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.20)];
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(x - C.UNIT, y - C.UNIT, C.UNIT * 30, panelH);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = FONT_TINY;

    // 현재 프로파일
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_PROFILE, x, y);
    ctx.fillStyle = d.observing ? C.COL_BONUS : C.COL_PLAYER;
    ctx.fillText(d.observing ? DV_OBSERVING : d.profileName, x + C.UNIT * 9, y);
    y += lh;

    // 판정 근거가 된 지표 3개 — 실시간
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_CHARGE, x, y);
    ctx.fillStyle = C.COL_PLAYER;
    this.drawFixed(d.metricCharge, x + C.UNIT * 11, y);
    y += lh;

    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_AIM, x, y);
    ctx.fillStyle = C.COL_PLAYER;
    this.drawFixed(d.metricAim, x + C.UNIT * 11, y);
    y += lh;

    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_STDEV, x, y);
    ctx.fillStyle = C.COL_PLAYER;
    this.drawFixed(d.metricStdev, x + C.UNIT * 11, y);
    y += lh + C.UNIT * 0.5;

    // 다음 구간에 적용된 레버
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_LEVERS, x, y);
    y += lh;
    ctx.fillStyle = C.COL_PLAYER;
    ctx.fillText(DV_WATER, x, y);
    this.drawFixed(d.appliedWaterSpeed || 0, x + C.UNIT * 11, y);
    y += lh;
    ctx.fillText(DV_THICK, x, y);
    this.drawFixed(d.levers.platformThickness[1], x + C.UNIT * 11, y);
    y += lh;
    ctx.fillText(DV_WOBBLE, x, y);
    this.drawFixed(d.levers.aimWobble, x + C.UNIT * 11, y);
    y += lh + C.UNIT * 0.5;

    // 직전 전환 시점과 이유
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(REASONS[d.reasonIdx], x, y);

    // 라이브러리 크기 — 폴백(12)인지 베이크 산출물(350)인지가 여기서 드러난다
    ctx.textAlign = 'right';
    this.drawNumber(d.librarySize, C.UNIT * 30, top, 8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
  }

  // 소수 둘째 자리까지. 문자열을 만들지 않는다.
  drawFixed(v, x, y) {
    const ctx = this.ctx;
    const neg = v < 0;
    const a = neg ? -v : v;
    const whole = a | 0;
    const frac = ((a - whole) * 100 + 0.5) | 0;
    const prevAlign = ctx.textAlign;
    ctx.textAlign = 'left';
    let cx = x;
    if (neg) { ctx.fillText(SIGN_MINUS, cx, y); cx += 6; }
    cx += this.drawLeft(whole, cx, y, 9);
    ctx.fillText(DOT, cx, y); cx += 5;
    ctx.fillText(DIGITS[(frac / 10) | 0], cx, y); cx += 9;
    ctx.fillText(DIGITS[frac % 10], cx, y);
    ctx.textAlign = prevAlign;
  }

  drawLeft(v, x, y, pitch) {
    const ctx = this.ctx;
    let n = v < 0 ? 0 : (v | 0);
    let count = 0;
    if (n === 0) { this.digits[count++] = 0; }
    while (n > 0 && count < 12) { this.digits[count++] = n % 10; n = (n / 10) | 0; }
    let cx = x;
    for (let i = count - 1; i >= 0; i--) { ctx.fillText(DIGITS[this.digits[i]], cx, y); cx += pitch; }
    return count * pitch;
  }
}
