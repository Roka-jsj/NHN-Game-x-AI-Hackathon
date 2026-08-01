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

const ANCHOR_Y = C.CAM_ANCHOR * C.VIEW_H;
const HALF_W = C.VIEW_W * 0.5;
const HALF_H = C.VIEW_H * 0.5;
const TAU = Math.PI * 2;

// 폰트 문자열을 매 프레임 조립하면 그것도 할당이다. 한 번만 만든다.
const FONT_SCORE = '28px ' + C.FONT_STACK;
const FONT_BIG = '44px ' + C.FONT_STACK;
const FONT_SMALL = '18px ' + C.FONT_STACK;

// 숫자 렌더용 — 문자 하나짜리 상수 문자열. 루프에서 새로 만들지 않는다.
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const UNIT_M = 'm';
const LABEL_PERFECT = '완벽 착지';
const LABEL_RETRY = '탭하면 다시';
const LABEL_PROFILE = '프로파일';

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

    // 제도 격자 — 패스 5에서 내용이 채워진다. 스크롤용으로 타일 2장 높이만큼 만든다.
    this.gridPath = new Path2D();
    this.hasGrid = false;

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

  draw(game, feel, alpha, director) {
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
      ctx.strokeStyle = C.COL_GRID;
      ctx.lineWidth = 1;
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
    ctx.fillStyle = C.COL_STRUCT;
    for (let i = first; i <= last; i++) {
      if (game.platBonusAt(i)) continue;      // 보너스는 색이 달라 따로 그린다
      const sy = originY - game.platYAt(i);
      if (sy < -40 || sy > C.VIEW_H + 40) continue;
      const th = C.PLATFORM_THICKNESS * game.platThickAt(i);
      const x = game.platSideAt(i) === 0
        ? C.WALL_INSET : C.VIEW_W - C.WALL_INSET - C.PLATFORM_REACH;
      ctx.fillRect(x, sy - th * 0.5, C.PLATFORM_REACH, th);
    }
    // 같은 fillStyle 을 쓰는 것끼리 모아 그린다 — 상태 변경 1회
    ctx.fillStyle = C.COL_BONUS;
    for (let i = first; i <= last; i++) {
      if (!game.platBonusAt(i)) continue;
      const sy = originY - game.platYAt(i);
      if (sy < -40 || sy > C.VIEW_H + 40) continue;
      const th = C.PLATFORM_THICKNESS * game.platThickAt(i);
      const x = game.platSideAt(i) === 0
        ? C.WALL_INSET : C.VIEW_W - C.WALL_INSET - C.PLATFORM_REACH;
      ctx.fillRect(x, sy - th * 0.5, C.PLATFORM_REACH, th);
    }

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
    const w = this.drawNumber(game.heightMeters(), HALF_W - 8, C.UNIT * 4, 17);
    ctx.fillText(UNIT_M, HALF_W - 8 + w * 0.5 + 8, C.UNIT * 4);

    if (game.state === S.DEAD && feel.resultStep >= 0) {
      const t = feel.resultStep / feel.resultSteps;
      const e = t >= 1 ? 1 : easeOutBack(t);
      ctx.setTransform(s * e, 0, 0, s * e, HALF_W * s, HALF_H * s);
      ctx.fillStyle = C.COL_PLAYER;
      ctx.textBaseline = 'middle';
      ctx.font = FONT_BIG;
      const wb = this.drawNumber(game.heightMeters(), -12, -C.UNIT * 9, 26);
      ctx.fillText(UNIT_M, -12 + wb * 0.5 + 12, -C.UNIT * 9);
      ctx.font = FONT_SMALL;
      ctx.fillText(LABEL_PERFECT, -C.UNIT * 5, 0);
      this.drawNumber(game.perfectCount, C.UNIT * 5, 0, 11);
      if (director && director.profileName) {
        ctx.fillText(LABEL_PROFILE, -C.UNIT * 6, C.UNIT * 5);
        ctx.fillText(director.profileName, C.UNIT * 5, C.UNIT * 5);
      }
      ctx.fillText(LABEL_RETRY, 0, C.UNIT * 11);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.textBaseline = 'top';
    }
  }
}
