// 드로우 — 어떻게 그리는가만 담당한다. 무엇이 언제 일어나는가는 모른다.
//
// 이 파일의 규칙:
//  1. 루프 안에서 객체·배열·문자열을 만들지 않는다. 하나도.
//     숫자는 문자열로 조립하지 않고 자리별로 그린다 (= 캔버스에서의 tabular-nums).
//  2. ctx.shadowBlur 를 쓰지 않는다. 캔버스에서 압도적으로 비싸다.
//  3. 정적 지오메트리는 Path2D 로 한 번만 만든다. 배경 전체가 여기 해당한다.
//  4. save()/restore() 를 타이트 루프에서 남발하지 않는다. 회전은 삼각함수로 직접 푼다.
//  5. **같은 색으로 그릴 것은 모아서 한 번에 그린다.** 128 유닛 × 20 도형을
//     각각 fillRect 로 그리면 상태 전환만으로 프레임이 넘어간다. 유닛은
//     "그림자 → 몸 → 어두운 디테일 → 윤곽 → 선 디테일 → 피격 → 상성 → 흰 심 → 체력"
//     순서로 **경로를 모아 한 번씩** 칠한다. fillStyle 변경이 유닛 수와 무관해진다.
//
// 겹치는 도형을 하나의 경로에 모을 때는 **감기 방향이 같아야 한다.**
// nonzero 규칙이라 방향이 반대인 도형이 겹치면 구멍이 뚫린다.
// ctx.rect 와 ctx.arc(…, false) 가 기준이고, 아래 addBar/addSpike 가 그 방향을 따른다.
//
// 화면 규칙: **카메라는 움직이지 않는다.** 전장 전체가 한 화면에 있다.
// 플래시게임의 핵심이 그거다 — 스크롤 없이 판 전체가 보인다.
//
// 색은 여섯 개뿐이다 (COL_BG GRID STRUCT PLAYER DANGER BONUS).
// 새 색을 만들지 않는다. 대비가 더 필요하면 알파 램프로 번다.

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
const FONT_MICRO = '10px ' + C.FONT_STACK;
const FONT_BTN = '14px ' + C.FONT_STACK;

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const DOT = '.';

// 0 검사 1 창병 2 궁수 3 기병 4 거인 5 투석기 6 진화 7 포탑 8 해일 9 화살비
const BTN_NAME = ['검사', '창병', '궁수', '기병', '거인', '투석기', '진화', '포탑', '해일', '화살비'];
const LABEL_GOLD = '금';
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
const LABEL_ME = '아군';
const LABEL_FOE = '적군';
const LABEL_WATER = '수위';
const KEY_RALLY = 'R';
const PROFILE_UNKNOWN = '—';
const KIND_NAME = ['공격', '방어', '경제'];
const READY = '준비';

const BAN_TXT = ['시대가 바뀌었다', '해일', '물이 차오른다'];

const DV_TITLE = 'AI 디렉터';
const DV_OBSERVING = '관찰 중';
const DV_AGGRO = '공격성';
const DV_HOARD = '비축';
const DV_ECON = '경제';
const DV_SWARM = '물량';
const DV_SEE = '보는 것 — 플레이어 구성';
const DV_DO = '지시 — 다음 웨이브 구성';
const DV_TEMPO = '간격';
const DV_WATER = '수위 배수';

const TOGGLE_SIZE = 40;

// 매 프레임 배열 리터럴을 만들면 그게 곧 GC 스파이크다. 상수는 모듈에 굽는다.
const DV_MET_NAME = [DV_AGGRO, DV_HOARD, DV_ECON, DV_SWARM];
const DV_MET_THR = Float32Array.from([C.TH_AGGRO_HIGH, C.TH_HOARD_HIGH, C.TH_ECON_HIGH, C.TH_SWARM_HIGH]);

// 상성 탐지용 공간 버킷. 32px 씩 끊어 진영별로 "이 칸에 어떤 종류가 있나"를
// 비트마스크로 들고 있는다. 공격 모션 중인 유닛만 앞쪽 칸을 훑으면
// **상성 우위로 때리는 중인지**를 O(1) 에 가깝게 알 수 있다.
const BUCKET_W = 32;
const BUCKET_N = (C.VIEW_W / BUCKET_W | 0) + 2;

// 스킬 연출 길이 (렌더 프레임)
const FX_TIDE_F = 40, FX_VOLLEY_F = 48, FX_RALLY_F = 36;
const FX_TOWER_F = 10;
const FX_ERA_F = 34;
const VOLLEY_N = 26;

// ── 순수 드로잉 좌표 (spec-v2 §0 이 render.js 지역 상수로 허용한 것) ──
// 버튼 열: config 의 BTN_X0 는 −13 이라 0번 칸이 화면 밖에서 시작했다.
// 열 칸 전부가 화면 안에 있고 우하단 증원 원(890~942)과 겹치지 않아야 한다.
const BTN_W = 83, BTN_GAP = 5, BTN_X0 = 6;
const BTN_H = C.BTN_H, BTN_Y = C.BTN_Y;
const BTN_R = 5;                       // 버튼 모서리
const BTN_ICON_DX = 60;                // 칸 안 아이콘 중심
const BTN_ICON_DY = 40;
// 버튼 열 전체가 차지하는 상자 — 통째로 구워 두고 붙이기 위한 것
const STRIP_X = BTN_X0 - 3, STRIP_Y = C.BTN_Y - 3;
const STRIP_W = C.BTN_COUNT * (BTN_W + BTN_GAP) - BTN_GAP + 6;
const STRIP_H = C.BTN_H + 6;

// 상단 HUD
const HUD_HP_W = 92, HUD_HP_H = 13;
const HUD_FRONT_W = 236, HUD_FRONT_H = 17;
const HUD_BAR_Y = 30;
const HUD_TOTAL = HUD_HP_W * 2 + HUD_FRONT_W + 24;
const HUD_X0 = HALF_W - HUD_TOTAL * 0.5;

// 수위 게이지 — 오른쪽 세로. 물은 위로 차오르므로 세로로 읽혀야 한다
const WG_X = 932, WG_Y = 158, WG_W = 18, WG_H = 174;
// 눈금 두 개 — 협곡 바닥, 기지 발밑. 상수다
const WG_MARKS = Float32Array.from([
  (C.VIEW_H - (C.GROUND_Y + C.FLOOR_DIP)) / (C.VIEW_H - C.WATER_MIN_Y),
  (C.VIEW_H - C.WATER_BASE_AT) / (C.VIEW_H - C.WATER_MIN_Y),
]);

// 드래프트 카드
const CARD_H = 92, CARD_GAP = C.UNIT * 2;
const CARD_TOP = HALF_H - (CARD_H * 3 + CARD_GAP * 2) * 0.5 + 8;

// 배경 층
const SKY_BANDS = 12;
const RAIN_N = 64;
const FALL_X_L = 28;
const FALL_TOP = 118, FALL_W = 26;
const RND_N = 256;

// 공성 병기는 **대열을 통과한다** (game.js §U_SIEGE). 남의 몸에 묻히면
// 혼자 앞서 나가 죽는 그 성격이 안 보이므로 맨 위에 다시 올려 그린다.
// config 에 아직 없으면 전부 0 — 예전과 똑같이 동작한다.
const SIEGE = (C.U_SIEGE && C.U_SIEGE.length >= C.UNIT_KINDS)
  ? C.U_SIEGE : new Uint8Array(C.UNIT_KINDS);

export class Renderer {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.viewScale = 1;
    this.digits = new Uint8Array(12);
    this.metVal = new Float32Array(4);
    this.btnOk = new Uint8Array(C.BTN_COUNT);
    this.btnCd = new Float32Array(C.BTN_COUNT);
    this.btnCost = new Int32Array(C.BTN_COUNT);
    this.btnMode = new Uint8Array(C.BTN_COUNT);
    this.bgCanvas = null;
    this.btnCanvas = null;
    this.btnSig = -1;
    this.btnScale = -1;
    this.bakedScale = -1;
    this.bakedEra = -1;

    // 결정론적 잡음. Math.random 을 쓰면 프레임마다 지형이 바뀐다.
    this.rnd = new Float32Array(RND_N);
    for (let i = 0; i < RND_N; i++) {
      let h = (i * 2654435761 + 374761393) >>> 0;
      h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
      this.rnd[i] = (h >>> 8) / 16777216;
    }

    this.buildBackground();
    this.buildScratch();
    this.buildFx();
  }

  rn(i) { return this.rnd[i & (RND_N - 1)]; }

  // ── 배경 — 전부 정적이다. 한 번만 굽는다 ────────────────────
  buildBackground() {
    // 격자 — 하늘의 눈금. 깊이만 담당한다
    this.bgPath = new Path2D();
    for (let y = C.UNIT * 5; y < C.GROUND_Y; y += C.UNIT * 5) {
      this.bgPath.moveTo(0, y);
      this.bgPath.lineTo(C.VIEW_W, y);
    }
    for (let x = 0; x <= C.VIEW_W; x += C.UNIT * 5) {
      this.bgPath.moveTo(x, 0);
      this.bgPath.lineTo(x, C.GROUND_Y);
    }

    // 원경 — 능선 세 겹. 뒤로 갈수록 낮은 대비, 높은 위치
    this.ridgeFar = this.buildRidge(13, 176, 250, 3);
    this.ridgeMid = this.buildRidge(9, 128, 206, 11);
    this.ridgeNear = this.buildRidge(6, 92, 156, 29);
    // 근경 능선의 등줄기 — 봉우리에서 발치로 내려긋는 선. 결이 있어야 바위로 읽힌다
    this.ridgeLines = new Path2D();
    for (let i = 0; i <= 6; i++) {
      const x = (C.VIEW_W / 6) * i;
      const h = 92 + this.rn(29 + i * 5) * 64;
      this.ridgeLines.moveTo(x, C.GROUND_Y - h);
      this.ridgeLines.lineTo(x + 22, C.GROUND_Y);
      this.ridgeLines.moveTo(x, C.GROUND_Y - h);
      this.ridgeLines.lineTo(x - 26, C.GROUND_Y);
      const mx = x + C.VIEW_W / 12;
      this.ridgeLines.moveTo(mx, C.GROUND_Y - h * 0.7);
      this.ridgeLines.lineTo(mx + 14, C.GROUND_Y);
    }

    // 시대 스카이라인 — **배경이 시대를 말한다.** 누적이라 한 번만 fill 한다
    this.skyline = new Array(C.ERA_COUNT);
    for (let e = 0; e < C.ERA_COUNT; e++) this.skyline[e] = this.buildSkyline(e);
    this.skyLamp = new Path2D();                    // 기계 시대 등불 (금색)
    this.addCircleTo(this.skyLamp, 622, 150, 2.6);
    this.addCircleTo(this.skyLamp, 302, 156, 2.6);

    // 근경 — 화면 위 두 모서리에서 내려오는 바위 처마.
    // 텅 빈 하늘이 이 게임의 가장 큰 구도 문제였다. 처마가 시선을 가운데로 모으고
    // 폭포가 걸릴 자리를 만든다 — 물이 어디서 오는지가 그림으로 설명된다.
    this.overhangL = this.buildOverhang(0);
    this.overhangR = this.buildOverhang(1);
    this.overhangLip = new Path2D();                // 처마 아랫날의 밝은 테
    this.addOverhangLip(this.overhangLip, 0);
    this.addOverhangLip(this.overhangLip, 1);

    // 협곡 바닥 — V자다. 가운데가 낮아서 전선이 먼저 잠긴다
    this.floorFill = new Path2D();
    this.floorFill.moveTo(0, C.VIEW_H);
    for (let x = 0; x <= C.VIEW_W; x += 12) this.floorFill.lineTo(x, groundAt(x));
    this.floorFill.lineTo(C.VIEW_W, C.VIEW_H);
    this.floorFill.closePath();
    this.floorLine = new Path2D();
    for (let x = 0; x <= C.VIEW_W; x += 12) {
      if (x === 0) this.floorLine.moveTo(x, groundAt(x)); else this.floorLine.lineTo(x, groundAt(x));
    }

    // 지층 — 물때처럼 쌓인 가로 띠. 깊이가 보여야 물이 무섭다.
    // 선이 아니라 **띠**로 채운다. 선만으로는 바닥이 종이처럼 얇아 보였다.
    this.strataFill = new Path2D();
    for (let d = 18; d < 170; d += 34) {
      this.strataFill.moveTo(0, groundAt(0) + d);
      for (let x = 12; x <= C.VIEW_W; x += 12) this.strataFill.lineTo(x, groundAt(x) + d);
      for (let x = C.VIEW_W; x >= 0; x -= 12) this.strataFill.lineTo(x, groundAt(x) + d + 13);
      this.strataFill.closePath();
    }
    this.strataLine = new Path2D();
    for (let d = 35; d < 170; d += 34) {
      this.strataLine.moveTo(0, groundAt(0) + d);
      for (let x = 12; x <= C.VIEW_W; x += 12) this.strataLine.lineTo(x, groundAt(x) + d);
    }

    // 바닥 위 잡석 — 지면이 평면이 아니라 땅으로 읽히게 한다
    this.rubble = new Path2D();
    for (let i = 0; i < 46; i++) {
      const x = 20 + this.rn(i * 3) * (C.VIEW_W - 40);
      const g = groundAt(x);
      const r = 2 + this.rn(i * 3 + 1) * 4;
      this.rubble.moveTo(x - r, g);
      this.rubble.lineTo(x - r * 0.4, g - r * 0.9);
      this.rubble.lineTo(x + r * 0.5, g - r * 0.7);
      this.rubble.lineTo(x + r, g);
      this.rubble.closePath();
    }

    // 협곡 벽 — 양쪽 끝이 솟아 있다. 물이 차오를 그릇을 눈으로 보여 준다
    this.cliffPath = new Path2D();
    this.addCliff(this.cliffPath, 0);
    this.addCliff(this.cliffPath, 1);

    // 벽에 새긴 수위 눈금 — 물이 어디까지 왔는지가 세계 안에서도 읽힌다
    this.gaugeMarks = new Path2D();
    for (let i = 0; i < 9; i++) {
      const y = C.GROUND_Y + 66 - i * 26;
      const w = (i % 3 === 0) ? 15 : 8;
      this.gaugeMarks.rect(52, y, w, 2);
      this.gaugeMarks.rect(C.VIEW_W - 52 - w, y, w, 2);
    }

    // 기지 석재 — 위치가 고정이므로 줄눈을 한 번만 굽는다
    this.baseStone = [this.buildBaseStone(SIDE_L), this.buildBaseStone(SIDE_R)];

    // 수면 파형 — 한 프레임에 여러 번 쓰므로 sin 은 한 번만 계산한다
    this.waveN = (C.VIEW_W / 24 | 0) + 2;
    this.wave = new Float32Array(this.waveN);
  }

  addCircleTo(p, x, y, r) { p.moveTo(x + r, y); p.arc(x, y, r, 0, TAU); }

  // 결정론적 능선. Math.random 을 쓰면 프레임마다 산이 바뀐다.
  buildRidge(n, minH, maxH, seed) {
    const p = new Path2D();
    p.moveTo(0, C.GROUND_Y);
    for (let i = 0; i <= n; i++) {
      const x = (C.VIEW_W / n) * i;
      const h = minH + this.rn(seed + i * 5) * (maxH - minH);
      p.lineTo(x, C.GROUND_Y - h);
      p.lineTo(x + C.VIEW_W / n * 0.5, C.GROUND_Y - h * (0.62 + this.rn(seed + i * 5 + 2) * 0.2));
    }
    p.lineTo(C.VIEW_W, C.GROUND_Y);
    p.closePath();
    return p;
  }

  // 시대별 원경 구조물 — 누적이다. 돌 시대는 비어 있고, 시대가 오를수록
  // 지평선에 사람이 만든 것이 늘어난다. 배경도 시대를 말해야 한다.
  buildSkyline(era) {
    const p = new Path2D();
    const FEET = C.GROUND_Y - 148;
    if (era >= 1) {                          // 청동 — 선돌
      const xs = [252, 342, 432];
      for (let i = 0; i < 3; i++) {
        const x = xs[i], h = 42 + this.rn(i * 9) * 16;
        p.rect(x - 5, FEET - h, 10, h);
        p.rect(x - 11, FEET - h - 7, 22, 7);
      }
    }
    if (era >= 2) {                          // 강철 — 망루
      const xs = [560, 706];
      for (let i = 0; i < 2; i++) {
        const x = xs[i], h = 66 + i * 12;
        p.rect(x - 9, FEET - h, 18, h);
        for (let m = 0; m < 3; m++) p.rect(x - 13 + m * 9, FEET - h - 9, 6, 9);
      }
    }
    if (era >= 3) {                          // 화약 — 굴뚝과 연기
      const xs = [184, 782];
      for (let i = 0; i < 2; i++) {
        const x = xs[i], h = 86;
        p.rect(x - 5, FEET - h, 10, h);
        p.rect(x - 9, FEET - h - 5, 18, 5);
        for (let s = 0; s < 3; s++) {
          const r = 5 + s * 3;
          this.addCircleTo(p, x + (s & 1 ? 7 : -4), FEET - h - 16 - s * 12, r);
        }
      }
    }
    if (era >= 4) {                          // 기계 — 송전탑
      const xs = [302, 622];
      for (let i = 0; i < 2; i++) {
        const x = xs[i], h = 96;
        p.moveTo(x - 13, FEET); p.lineTo(x - 4, FEET - h); p.lineTo(x - 1, FEET - h);
        p.lineTo(x - 9, FEET); p.closePath();
        p.moveTo(x + 13, FEET); p.lineTo(x + 4, FEET - h); p.lineTo(x + 1, FEET - h);
        p.lineTo(x + 9, FEET); p.closePath();
        p.rect(x - 12, FEET - h * 0.52, 24, 3);
        p.rect(x - 17, FEET - h * 0.86, 34, 3);
      }
    }
    return p;
  }

  // 화면 위 모서리의 바위 처마. 아래로 갈수록 깊고 톱니가 있다.
  buildOverhang(side) {
    const p = new Path2D();
    const x0 = side ? C.VIEW_W : 0;
    const dir = side ? -1 : 1;
    const SPAN = 330, PTS = 11;
    p.moveTo(x0, 0);
    p.lineTo(x0 + dir * SPAN, 0);
    for (let i = PTS; i >= 0; i--) {
      const t = i / PTS;
      const x = x0 + dir * SPAN * t;
      const y = 24 + 100 * (1 - t) * (1 - t) + this.rn(side * 71 + i * 13) * 22;
      p.lineTo(x, y);
    }
    p.closePath();
    return p;
  }

  addOverhangLip(p, side) {
    const x0 = side ? C.VIEW_W : 0;
    const dir = side ? -1 : 1;
    const SPAN = 330, PTS = 11;
    for (let i = PTS; i >= 0; i--) {
      const t = i / PTS;
      const x = x0 + dir * SPAN * t;
      const y = 24 + 100 * (1 - t) * (1 - t) + this.rn(side * 71 + i * 13) * 22;
      if (i === PTS) p.moveTo(x, y); else p.lineTo(x, y);
    }
  }

  addCliff(p, side) {
    const x0 = side ? C.VIEW_W : 0;
    const dir = side ? -1 : 1;
    p.moveTo(x0, C.VIEW_H);
    p.lineTo(x0, C.GROUND_Y - 168);
    p.lineTo(x0 + dir * 30, C.GROUND_Y - 150);
    p.lineTo(x0 + dir * 22, C.GROUND_Y - 96);
    p.lineTo(x0 + dir * 44, C.GROUND_Y - 74);
    p.lineTo(x0 + dir * 34, C.GROUND_Y - 12);
    p.lineTo(x0 + dir * 62, groundAt(x0 + dir * 62));
    p.lineTo(x0 + dir * 62, C.VIEW_H);
    p.closePath();
  }

  // 기지 석재 줄눈 — 사각형 하나가 아니라 쌓아 올린 성벽으로 보여야 한다
  buildBaseStone(side) {
    const p = new Path2D();
    const cx = side === SIDE_L ? C.BASE_L_X : C.BASE_R_X;
    const gy = groundAt(cx);
    const x = cx - C.BASE_W * 0.5, y = gy - C.BASE_H;
    const rows = 8, rh = C.BASE_H / rows;
    for (let r = 1; r < rows; r++) p.rect(x + 3, y + r * rh, C.BASE_W - 6, 1.4);
    for (let r = 0; r < rows; r++) {
      const off = (r & 1) ? C.BASE_W / 6 : 0;
      for (let c = 0; c < 3; c++) {
        const jx = x + off + (c + 0.5) * (C.BASE_W / 3);
        if (jx > x + 4 && jx < x + C.BASE_W - 4) p.rect(jx, y + r * rh + 2, 1.4, rh - 3);
      }
    }
    return p;
  }

  // ── 유닛 스크래치 — 프레임마다 다시 계산하지 않기 위한 자리 ──
  buildScratch() {
    const N = C.UNIT_MAX;
    this.list = new Int16Array(N);
    this.sx = new Float32Array(N);
    this.sgy = new Float32Array(N);
    this.sw = new Float32Array(N);
    this.sh = new Float32Array(N);
    this.sflag = new Uint8Array(N);        // 1 = 상성 우위로 때리는 중
    this.smY = new Float32Array(N);        // 시대 표식이 붙는 높이 (종류마다 다르다)
    this.smR = new Float32Array(N);        // 그 표식의 크기
    this.wtX = new Float32Array(N);        // 무기 끝 — 화염·상성 타격이 여기서 난다
    this.wtY = new Float32Array(N);
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
  }

  // ── 연출 상태 — 이벤트 배선 없이 game 상태의 변화만 보고 켠다 ──
  buildFx() {
    this.fxSkill = new Int16Array(C.SKILL_COUNT);
    this.fxSkillX = new Float32Array(C.SKILL_COUNT);
    this.prevSkillCd = new Float32Array(C.SKILL_COUNT);
    this.fxTower = new Int16Array(2);
    this.fxTowerX = new Float32Array(2);
    this.prevTowerCd = new Float32Array(2);
    this.prevTowerLv = new Int8Array(2);
    this.fxEra = new Int16Array(2);
    this.prevEra = new Int8Array(2);
    this.prevTick = -1;

    // 화살비 — 결정론적 산포. Math.random 을 쓰면 매 프레임 화살이 순간이동한다.
    this.vOff = new Float32Array(VOLLEY_N);
    this.vDelay = new Float32Array(VOLLEY_N);
    for (let i = 0; i < VOLLEY_N; i++) {
      this.vOff[i] = (((i * 2654435761) % 997) / 997) * 2 - 1;
      this.vDelay[i] = ((i * 40503) % 251) / 251;
    }
  }

  resize(viewScale) { this.viewScale = viewScale; this.bakedScale = -1; this.btnScale = -1; }

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

  // 사다리꼴 — 몸통·어깨처럼 위아래 폭이 다른 덩어리
  addTrap(cx, yTop, yBot, wTop, wBot, skew) {
    const ctx = this.ctx;
    ctx.moveTo(cx - wTop * 0.5 + skew, yTop);
    ctx.lineTo(cx + wTop * 0.5 + skew, yTop);
    ctx.lineTo(cx + wBot * 0.5, yBot);
    ctx.lineTo(cx - wBot * 0.5, yBot);
    ctx.closePath();
  }

  // 별 모양 충격 — 상성 우위 타격 전용. 일반 타격(붉은 윤곽)과 절대 안 겹친다
  addBurst(x, y, r, dir) {
    for (let k = 0; k < 4; k++) {
      const a = k * (Math.PI * 0.5) + 0.39;
      this.addSpike(x, y, Math.cos(a) * dir, Math.sin(a), r, r * 0.30);
    }
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

  drawRight(v, xEnd, y, pitch) {
    let n = v < 0 ? 0 : (v | 0);
    let count = 0;
    if (n === 0) count = 1;
    else { let m = n; while (m > 0 && count < 12) { count++; m = (m / 10) | 0; } }
    return this.drawLeft(v, xEnd - count * pitch, y, pitch);
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
    if (ly < BTN_Y || ly > BTN_Y + BTN_H) return -1;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = BTN_X0 + i * (BTN_W + BTN_GAP);
      if (lx >= x && lx <= x + BTN_W) return i;
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
    for (let i = 0; i < C.TRAIT_OFFER; i++) {
      const y = CARD_TOP + i * (CARD_H + CARD_GAP);
      if (ly >= y && ly <= y + CARD_H) return i;
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

    // 배경은 **정적이다.** 하늘·능선·시대 스카이라인·협곡·지층·벽까지
    // 스무 번 넘는 큰 채우기가 매 프레임 같은 그림을 다시 래스터한다.
    // 한 번 구워 두고 한 번 붙인다. 시대가 바뀌거나 해상도가 바뀔 때만 다시 굽는다.
    this.paintBackground(game);
    this.drawRain(game);
    this.drawBase(game, SIDE_R);
    this.drawBase(game, SIDE_L);
    this.drawUnits(game, alpha);
    this.drawEraFx(game);
    this.drawSkillFx(game);
    this.drawParticles(feel);
    this.drawRings(feel);
    this.drawWater(game, alpha);
    this.drawWaterfalls(game, alpha);
    this.drawOverhang();
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
      this.fxEra.fill(0);
      this.prevSkillCd.fill(0);
      this.prevTowerCd.fill(0);
      this.prevTowerLv.fill(0);
      this.prevEra.fill(0);
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
      const lv = ((s === SIDE_L ? game.towerLv : game.aiTowerLv) | 0);
      const bought = lv !== this.prevTowerLv[s];   // 사는 순간에도 쿨다운이 찬다. 그건 사격이 아니다
      this.prevTowerLv[s] = lv;
      if (!bought && cd > this.prevTowerCd[s] + 1) {
        this.fxTower[s] = FX_TOWER_F;
        this.fxTowerX[s] = front;
      }
      this.prevTowerCd[s] = cd;
      if (this.fxTower[s] > 0) this.fxTower[s]--;

      const era = (s === SIDE_L ? game.era : game.aiEra) | 0;
      if (era > this.prevEra[s]) this.fxEra[s] = FX_ERA_F;
      this.prevEra[s] = era;
      if (this.fxEra[s] > 0) this.fxEra[s]--;
    }
  }

  // ── 배경 굽기 ───────────────────────────────────────────────
  // 오프스크린 캔버스 하나에 정적 배경 전체를 굽고 매 프레임 한 번 붙인다.
  // p50 은 원래도 0.5ms 였다 — 문제는 JS 가 아니라 **래스터 양**이었고,
  // 큰 채우기 스무 번이 합성 스레드에 밀려 스파이크로 돌아왔다.
  // document 가 없는 환경(도구 스크립트)에서는 조용히 예전처럼 직접 그린다.
  paintBackground(game) {
    const era = game.era | 0;
    const e = era < 0 ? 0 : (era >= C.ERA_COUNT ? C.ERA_COUNT - 1 : era);
    if (typeof document === 'undefined') { this.drawSky(e); this.drawTerrain(); return; }
    const s = this.viewScale > 2 ? 2 : (this.viewScale < 0.25 ? 0.25 : this.viewScale);
    if (this.bakedScale !== s || this.bakedEra !== e) {
      const w = Math.ceil(C.VIEW_W * s), h = Math.ceil(C.VIEW_H * s);
      if (!this.bgCanvas) this.bgCanvas = document.createElement('canvas');
      if (this.bgCanvas.width !== w || this.bgCanvas.height !== h) {
        this.bgCanvas.width = w; this.bgCanvas.height = h;
      }
      const octx = this.bgCanvas.getContext('2d');
      const prev = this.ctx;
      this.ctx = octx;                      // 경로 헬퍼가 this.ctx 를 쓴다
      octx.setTransform(s, 0, 0, s, 0, 0);
      octx.clearRect(0, 0, C.VIEW_W, C.VIEW_H);
      octx.fillStyle = C.COL_BG;
      octx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
      this.drawSky(e);
      this.drawTerrain();
      this.ctx = prev;
      this.bakedScale = s; this.bakedEra = e;
    }
    // 원본과 대상 픽셀 수가 같다. 보간을 끄면 더 또렷하고 복사 경로도 짧다
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.bgCanvas, 0, 0, C.VIEW_W, C.VIEW_H);
    this.ctx.imageSmoothingEnabled = true;
  }

  // ── 원경 — 하늘 · 능선 세 겹 · 시대 스카이라인 ──────────────
  // createLinearGradient 를 안 쓰는 이유는 리사이즈마다 다시 만들어야 하고
  // 알파 램프로 같은 결과를 공짜로 얻을 수 있기 때문이다.
  drawSky(era) {
    const ctx = this.ctx;
    // 위가 어둡고 지평선이 밝다. 다만 **맨 위도 배경색보다는 확실히 밝아야** 한다 —
    // 그래야 순수 배경색으로 칠한 근경(처마)이 검은 덩어리로 읽힌다.
    const bh = C.GROUND_Y / SKY_BANDS;
    for (let i = 0; i < SKY_BANDS; i++) {
      const t = i / (SKY_BANDS - 1);
      ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.32 + t * t * 0.46)];
      ctx.fillRect(0, bh * i, C.VIEW_W, bh + 1);
    }

    // 안개 낀 해 — 새 색이 아니라 금색의 아주 낮은 알파다.
    // 시대가 오를수록 밝아진다. 세계가 밝아지는 것이 곧 진보다.
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.035 + era * 0.012)];
    ctx.beginPath();
    this.addCircle(HALF_W + 168, 104, 46);
    ctx.fill();
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.07 + era * 0.02)];
    ctx.beginPath();
    this.addCircle(HALF_W + 168, 104, 25);
    ctx.fill();

    ctx.strokeStyle = C.RAMP_GRID[C.rampIndex(0.42)];
    ctx.lineWidth = 1;
    ctx.stroke(this.bgPath);
    ctx.lineWidth = C.STROKE;

    // 능선 세 겹 — 뒤가 흐리고 앞이 진하다. 이 세 겹이 하늘에 거리를 준다
    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.52)];
    ctx.fill(this.ridgeFar);
    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.86)];
    ctx.fill(this.skyline[era]);
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.55)];
    ctx.fill(this.ridgeMid);
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.86)];
    ctx.fill(this.ridgeNear);
    // 능선의 등줄기 — 검은 덩어리로 남지 않게 결을 넣는다
    ctx.strokeStyle = C.RAMP_GRID[C.rampIndex(0.55)];
    ctx.lineWidth = 1.5;
    ctx.stroke(this.ridgeLines);
    ctx.lineWidth = C.STROKE;
    if (era >= 4) {
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.55)];
      ctx.fill(this.skyLamp);
    }

    // 건너편 둑 — 능선 발치와 지면 사이가 통짜 검정으로 남아 있었다.
    // 가로 결 몇 줄이면 그게 절벽면으로 읽힌다
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.09)];
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const yy = C.GROUND_Y - 10 - i * 15;
      ctx.moveTo(0, yy + this.rn(i * 17) * 6);
      ctx.lineTo(C.VIEW_W, yy - this.rn(i * 17 + 3) * 6);
    }
    ctx.stroke();
    ctx.lineWidth = C.STROKE;

    // 지평선 안개 — 능선 발치를 흐려 원경과 근경을 분리한다
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.20 - i * 0.045)];
      ctx.fillRect(0, C.GROUND_Y - 58 + i * 15, C.VIEW_W, 15);
    }

  }

  // 비 — 물이 어디서 오는가. 수위가 오를수록 굵어진다.
  // 텅 빈 하늘을 채우면서 제목을 매 프레임 설명한다. 유일하게 살아 있는 원경이다.
  drawRain(game) {
    const ctx = this.ctx;
    const rise = (C.VIEW_H - game.water) / (C.VIEW_H - C.WATER_MIN_Y);
    const amt = rise < 0 ? 0 : (rise > 1 ? 1 : rise);
    const t = game.simTime * 0.001;
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.05 + amt * 0.10)];
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = 20 + (RAIN_N - 20) * amt | 0;
    for (let i = 0; i < n; i++) {
      const sp = 420 + this.rn(i * 7) * 320;
      const y = ((this.rn(i * 7 + 1) * C.GROUND_Y + t * sp) % (C.GROUND_Y + 40)) - 20;
      const x = this.rn(i * 7 + 3) * (C.VIEW_W + 80) - 40 + y * 0.14;
      const len = 12 + this.rn(i * 7 + 5) * 16;
      ctx.moveTo(x, y);
      ctx.lineTo(x - len * 0.14, y + len);
    }
    ctx.stroke();
    ctx.lineWidth = C.STROKE;
  }

  // ── 근경 — 협곡 바닥 · 지층 · 벽 ────────────────────────────
  drawTerrain() {
    const ctx = this.ctx;

    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.95)];
    ctx.fill(this.floorFill);

    // 지층 띠 — 물때처럼 쌓였다. 이 깊이가 있어야 물이 무섭다
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.5)];
    ctx.fill(this.strataFill);
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.10)];
    ctx.lineWidth = 1;
    ctx.stroke(this.strataLine);

    // 지면 윗날 — 빛을 받는 선. 이 한 줄이 바닥을 입체로 만든다
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.20)];
    ctx.lineWidth = C.STROKE;
    ctx.stroke(this.floorLine);

    // 잡석
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.55)];
    ctx.fill(this.rubble);

    // 협곡 벽
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.75)];
    ctx.fill(this.cliffPath);
    ctx.strokeStyle = C.RAMP_GRID[C.rampIndex(0.9)];
    ctx.lineWidth = C.STROKE;
    ctx.stroke(this.cliffPath);

    // 벽에 새긴 수위 눈금 — 잠긴 눈금은 물 아래로 들어가 자연히 사라진다
    ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.35)];
    ctx.fill(this.gaugeMarks);
  }

  // ── 폭포 — 물이 어디서 오는가. 처마 끝에서 협곡으로 쏟아진다 ──
  drawWaterfalls(game, alpha) {
    const ctx = this.ctx;
    const wy = game.prevWater + (game.water - game.prevWater) * alpha;
    const t = game.simTime * 0.001;

    {
      const s = 0;
      const x = FALL_X_L;
      const g = groundAt(x);
      const bot = wy < g ? wy : g;

      // 기둥 — 반투명한 한 덩어리
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.16)];
      ctx.fillRect(x - FALL_W * 0.5, FALL_TOP, FALL_W, bot - FALL_TOP);

      // 흐르는 줄기 — 아래로 흘러내린다
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.42)];
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const sp = 260 + this.rn(s * 40 + i * 3) * 200;
        const len = 26 + this.rn(s * 40 + i * 3 + 1) * 34;
        const span = bot - FALL_TOP;
        if (span <= 0) continue;
        const y = FALL_TOP + ((this.rn(s * 40 + i * 3 + 2) * span + t * sp) % span);
        const px = x - FALL_W * 0.5 + 1.5 + i * (FALL_W - 3) / 6;
        ctx.rect(px - 1, y, 2, y + len > bot ? bot - y : len);
      }
      ctx.fill();

      // 착수 포말 — 떨어지는 물이 부딪히는 곳
      const pulse = 0.5 + 0.5 * Math.sin(t * 7 + s * 2);
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.20 + pulse * 0.14)];
      ctx.beginPath();
      this.addCircle(x, bot, 9 + pulse * 3);
      this.addCircle(x - 12, bot + 1, 5 + pulse * 2);
      this.addCircle(x + 12, bot + 1, 5 + pulse * 2);
      ctx.fill();
    }
  }

  // 처마는 **모든 것 앞**이다. 근경이 있어야 화면에 깊이가 생긴다.
  drawOverhang() {
    const ctx = this.ctx;
    ctx.fillStyle = C.COL_BG;
    ctx.fill(this.overhangL);
    ctx.fill(this.overhangR);
    ctx.strokeStyle = C.RAMP_GRID[C.rampIndex(1)];
    ctx.lineWidth = 2.5;
    ctx.stroke(this.overhangLip);
    ctx.lineWidth = C.STROKE;
  }

  // ── 기지 — 사각형 하나가 아니라 성채로 보여야 한다 ─────────
  // 총안 · 석재 줄눈 · 성문 아치와 격자 · 버팀벽 · 망루 · 깃대 · 옥상 포탑.
  // 그리고 **깎인 만큼 부서진다** — 체력이 숫자가 아니라 형태로 읽혀야 한다.
  drawBase(game, side) {
    const ctx = this.ctx;
    const mine = side === SIDE_L;
    const cx = mine ? C.BASE_L_X : C.BASE_R_X;
    const w = C.BASE_W, h = C.BASE_H;
    const gy = groundAt(cx);
    const x = cx - w * 0.5, y = gy - h;
    const k = game.baseK(side);
    const flash = game.baseFlash[side] > 0;
    const main = mine ? C.RAMP_PLAYER[C.rampIndex(0.90)] : C.RAMP_STRUCT[C.rampIndex(0.86)];
    const dim = mine ? C.RAMP_PLAYER[C.rampIndex(0.55)] : C.RAMP_STRUCT[C.rampIndex(0.52)];
    // **피격을 몸 색으로 칠하지 않는다.** 전선이 기지에 붙으면 매 프레임 피격 상태라
    // 성문과 외곽선이 영구히 붉어진다 — 유닛에서 겪은 것과 똑같은 실패다.
    // 소속은 몸 색이 유지하고, 맞았다는 것은 안쪽에 덧그린 붉은 테로만 알린다.
    const dark = C.RAMP_BG[C.rampIndex(0.9)];
    const dir = mine ? 1 : -1;

    // 지반 — 성이 공중에 뜨지 않게 받친다
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.8)];
    ctx.beginPath();
    this.addTrap(cx, gy - 6, gy + 26, w + 14, w + 40, 0);
    ctx.fill();

    // 본체 · 버팀벽 · 총안 · 망루 — 전부 같은 색이다. **경로 하나에 모아 한 번에** 칠한다.
    // 칸마다 fillRect 를 부르면 성 하나에 열 번, 두 성이면 스무 번이 되고
    // 그 호출 수가 그대로 프레임 스파이크로 돌아온다 (실측으로 확인했다).
    const merlonW = w / 7;
    const gone = k > 0.66 ? 0 : (k > 0.33 ? 1 : 2);   // 깎이면 뒤쪽 총안부터 무너진다
    const tw = 30, tx = mine ? x - 6 : x + w - tw + 6;
    ctx.fillStyle = main;
    ctx.beginPath();
    ctx.rect(x, y, w, h);                                            // 본체
    this.addTrap(x + 11, y + h * 0.42, gy, 14, 22, 0);               // 버팀벽
    this.addTrap(x + w - 11, y + h * 0.42, gy, 14, 22, 0);
    for (let i = 0; i < 7; i += 2) {
      const slot = mine ? (3 - (i >> 1)) : (i >> 1);
      if (slot < gone) continue;
      ctx.rect(x + i * merlonW, y - 14, merlonW, 14);                // 총안
    }
    ctx.rect(tx, y - 46, tw, 46 + h * 0.55);                         // 망루
    for (let i = 0; i < 3; i += 2) ctx.rect(tx + i * (tw / 3), y - 56, tw / 3, 10);
    ctx.fill();

    // 석재 줄눈 — 어두운 색으로 한 번에
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.45)];
    ctx.fill(this.baseStone[side]);

    // 성문 — 아치 + 격자
    const gw = 34, gh = 50;
    const gx = cx - gw * 0.5 + dir * 16;
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx, gy - gh + gw * 0.5);
    ctx.arc(gx + gw * 0.5, gy - gh + gw * 0.5, gw * 0.5, Math.PI, 0);
    ctx.lineTo(gx + gw, gy);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = dim;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) ctx.rect(gx + i * (gw / 4) - 1, gy - gh + 6, 2, gh - 6);
    for (let i = 1; i < 4; i++) ctx.rect(gx + 3, gy - i * (gh / 4), gw - 6, 2);
    ctx.fill();

    // 균열 — 체력이 깎인 만큼 갈라진다. 붉은색은 쓰지 않는다.
    // 붉은색을 쓰면 밀집 전투의 피격색과 섞여 "누가 맞았는지"가 안 읽힌다
    if (k < 0.85) {
      ctx.strokeStyle = C.RAMP_BG[C.rampIndex(0.9)];
      ctx.lineWidth = 2;
      ctx.beginPath();
      const cracks = k < 0.35 ? 5 : (k < 0.62 ? 3 : 2);
      for (let i = 0; i < cracks; i++) {
        let px = x + 12 + this.rn(side * 17 + i * 5) * (w - 24);
        let py = y + 8;
        ctx.moveTo(px, py);
        for (let seg = 0; seg < 4; seg++) {
          px += (this.rn(side * 17 + i * 5 + seg + 1) - 0.5) * 22;
          py += h * 0.22;
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }

    // 외곽선 — 마지막에 둘러야 성이 배경에서 떨어진다
    ctx.strokeStyle = dark;
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(x, y, w, h);
    if (flash) {                       // 맞은 순간만. 안쪽 붉은 테 한 줄
      ctx.strokeStyle = C.COL_DANGER;
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 3, y + 3, w - 6, h - 6);
      ctx.lineWidth = C.STROKE;
    }

    // 깃대와 깃발 — 시대가 오르면 깃발이 늘어난다. 다섯 시대가 기지에도 보인다
    const era = mine ? game.era : game.aiEra;
    const px = mine ? x + w - 14 : x + 14;
    ctx.fillStyle = main;
    ctx.beginPath();
    ctx.rect(px - 1.5, y - 66, 3, 50);
    ctx.moveTo(px, y - 62); ctx.lineTo(px + dir * 17, y - 58.5); ctx.lineTo(px, y - 55);
    ctx.closePath();
    ctx.fill();
    if (era > 0) {                    // 시대 깃발 — 금색 한 번에
      ctx.fillStyle = C.COL_BONUS;
      ctx.beginPath();
      for (let f = 1; f <= era; f++) {
        const fy = y - 62 + f * 9;
        ctx.moveTo(px, fy);
        ctx.lineTo(px + dir * 17, fy + 3.5);
        ctx.lineTo(px, fy + 7);
        ctx.closePath();
      }
      ctx.fill();
    }

    this.drawTower(game, side, cx, y - 14, mine, main, dark);

    // 체력 막대 — 성 바로 위에 붙인다. 숫자와 큰 막대는 상단 HUD 가 맡으므로
    // 여기서는 짧고 얇게. 멀리 떠 있으면 어느 성 것인지 안 읽힌다.
    const bw = w * 0.74, bh = 6;
    const bx = cx - bw * 0.5, by = y - 84;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.95)];
    ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.25)];
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = k > 0.3 ? (mine ? C.COL_PLAYER : C.COL_STRUCT) : C.COL_DANGER;
    ctx.fillRect(bx, by, bw * k, bh);
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.95)];
    ctx.beginPath();
    for (let i = 1; i < 5; i++) ctx.rect(bx + bw * i * 0.2 - 0.5, by, 1, bh);
    ctx.fill();
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
      ctx.strokeStyle = mine ? C.RAMP_PLAYER[C.rampIndex(0.28)] : C.RAMP_STRUCT[C.rampIndex(0.28)];
      ctx.lineWidth = C.STROKE;
      ctx.strokeRect(px - 13, roofY - 8, 26, 8);
      return;
    }

    const f = this.fxTower[side];
    const recoil = f > 0 ? -dir * (f / FX_TOWER_F) * 5 : 0;   // 쏘면 뒤로 밀린다
    const bw = lv === 1 ? 26 : 34;
    const bh = lv === 1 ? 12 : 16;
    const my = roofY - bh - (lv === 1 ? 7 : 10);   // 포신 높이

    ctx.fillStyle = main;
    ctx.beginPath();
    ctx.rect(px - bw * 0.5, roofY - bh, bw, bh);            // 받침
    ctx.rect(px - bw * 0.28 + recoil, roofY - bh - 9, bw * 0.56, 9); // 회전대
    this.addBar(px + dir * bw * 0.2 + recoil, my, dir, -0.16, lv === 1 ? 24 : 30, 4, 3, 2.4);
    if (lv === 2) {
      this.addBar(px + dir * bw * 0.2 + recoil, my + 8, dir, -0.10, 26, 4, 2.6, 2);
      ctx.rect(px - dir * bw * 0.42, my - 6, 7, 18);        // 방패판
    }
    ctx.fill();
    ctx.strokeStyle = dark;
    ctx.lineWidth = C.STROKE;
    ctx.stroke();

    // 단계 눈금 — 두 칸 중 몇 칸이 찼는가
    for (let i = 0; i < C.TOWER_MAX; i++) {
      ctx.fillStyle = i < lv ? C.COL_BONUS : C.RAMP_BG[C.rampIndex(0.7)];
      ctx.fillRect(px - 7 + i * 8, roofY - bh - 16, 6, 4);
    }

    // 사격 — 총구 화염과 예광. 쏘는 게 안 보이면 포탑은 장식이다
    if (f > 0) {
      const t = f / FX_TOWER_F;
      const mx = px + dir * (bw * 0.2 + (lv === 1 ? 24 : 30)) + recoil;
      const myy = my - (lv === 1 ? 24 : 30) * 0.16;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(t)];
      ctx.beginPath();
      this.addSpike(mx, myy, dir, -0.1, 15 * t + 5, 6 * t + 1.8);
      this.addSpike(mx, myy, dir * 0.6, -0.8, 10 * t, 3.4 * t);
      this.addSpike(mx, myy, dir * 0.6, 0.8, 10 * t, 3.4 * t);
      ctx.fill();
      if (t > 0.5) {
        // 예광 — 두 겹. 심이 밝고 겉이 흐리면 속도가 보인다
        const tx2 = this.fxTowerX[side];
        const ty2 = groundAt(tx2) - 22;
        const a = (t - 0.5) * 2;
        ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(a * 0.35)];
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(mx, myy); ctx.lineTo(tx2, ty2); ctx.stroke();
        ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(a)];
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(mx, myy); ctx.lineTo(tx2, ty2); ctx.stroke();
        ctx.lineWidth = C.STROKE;
      }
    }
  }

  // ── 시대 진화의 순간 — 기지에서 퍼지는 금빛 파문 ────────────
  drawEraFx(game) {
    const ctx = this.ctx;
    for (let s = 0; s < 2; s++) {
      const f = this.fxEra[s];
      if (f <= 0) continue;
      const t = 1 - f / FX_ERA_F;
      const cx = s === SIDE_L ? C.BASE_L_X : C.BASE_R_X;
      const cy = groundAt(cx) - C.BASE_H * 0.5;
      const e = easeOutCubic(t);
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(1 - t)];
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 30 + 260 * e, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = 2 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 30 + 160 * e, 0, TAU);
      ctx.stroke();
      // 솟아오르는 금빛 알갱이 — 기지가 새 시대를 뱉는다
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(1 - t)];
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const px = cx + (this.rn(s * 23 + i * 3) - 0.5) * (C.BASE_W + 30);
        const py = groundAt(cx) - 10 - e * (60 + this.rn(s * 23 + i * 3 + 1) * 130);
        const sz = 4 * (1 - t) + 1;
        ctx.rect(px - sz * 0.5, py - sz * 0.5, sz, sz);
      }
      ctx.fill();
      ctx.lineWidth = C.STROKE;
    }
  }

  // ── 유닛 — 실루엣만으로 종류와 시대가 읽혀야 한다 ──────────
  //   검사    앞으로 기울고 **커다란 둥근 방패**를 든다. 칼은 짧고 위로 든다
  //   창병    똑바로 서고 창이 **몸 길이보다 앞으로 나간다**. 투구가 뾰족하다
  //   궁수    **뒤로 젖힌 자세**. 다리를 벌리고 큰 활을 앞에 든다. 등에 화살깃
  //   기병    말 위. 네 다리 · 넓고 낮다. 창에 기가 달린다
  //   거인    앞으로 웅크린 사다리꼴 덩어리. 목이 없고 등에 혹이 있다
  //   투석기  사람이 아니다. 바퀴 둘 · 삼각 뼈대 · 던지는 팔
  //
  // 시대는 머리 위 표식이 아니라 **장비 실루엣**으로 구분한다.
  //   돌  어깨 털 · 투구 없음        청동 볏           강철 뿔+견갑+망토
  //   화약 챙 넓은 모자+탄띠         기계 면갑+등짐+안테나
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
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.55)];
    ctx.beginPath();
    for (let j = 0; j < n; j++) {
      const i = list[j];
      const rx = sw[i] * 0.62;
      ctx.moveTo(sx[i] + rx, sgy[i]);
      ctx.ellipse(sx[i], sgy[i], rx, 3.5, 0, 0, TAU);
    }
    ctx.fill();

    // 2) 몸 — 진영별로 네 패스. 소속은 **몸 색**이 유지한다
    ctx.lineWidth = C.STROKE;
    for (let s = 0; s < 2; s++) {
      const dir = s === SIDE_L ? 1 : -1;
      ctx.fillStyle = s === SIDE_L
        ? C.RAMP_PLAYER[C.rampIndex(0.94)] : C.RAMP_STRUCT[C.rampIndex(0.90)];
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s || SIEGE[game.uKind[i]]) continue;
        this.addUnitFill(game, i, dir);
      }
      ctx.fill();

      // 어두운 디테일 — 방패 보스 · 면갑 · 안장 · 거인의 얼굴 그늘.
      // 새 색이 아니라 배경색이다. 이 한 패스가 유닛에 안쪽을 준다
      ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.85)];
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s) continue;
        this.addUnitDark(game, i, dir);
      }
      ctx.fill();

      // 윤곽 — 밀집했을 때 서로 겹쳐 한 덩어리로 보이는 것을 끊는다.
      // 전선에는 30기가 21px 간격으로 겹쳐 선다. 이 선이 약하면 흰 반죽이 된다
      ctx.strokeStyle = C.COL_BG;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s || SIEGE[game.uKind[i]]) continue;
        this.addUnitOutline(game, i, dir);
      }
      ctx.stroke();

      // 공성 병기 — 대열을 통과하는 유닛이라 남의 몸에 묻힌다.
      // 그래서 **몸 패스가 다 끝난 뒤 맨 위에 다시 올린다.**
      // 혼자 앞서 나가다 죽는 그림이 이 유닛의 성격이고, 그게 보여야 한다.
      ctx.fillStyle = s === SIDE_L
        ? C.RAMP_PLAYER[C.rampIndex(0.94)] : C.RAMP_STRUCT[C.rampIndex(0.90)];
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s || !SIEGE[game.uKind[i]]) continue;
        this.addUnitFill(game, i, dir);
      }
      ctx.fill();
      ctx.strokeStyle = C.COL_BG;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s || !SIEGE[game.uKind[i]]) continue;
        this.addUnitOutline(game, i, dir);
      }
      ctx.stroke();

      // 선 디테일 — 활시위 · 안테나 · 기병 고삐. 채우면 뭉개지는 것들
      ctx.strokeStyle = s === SIDE_L
        ? C.RAMP_PLAYER[C.rampIndex(0.94)] : C.RAMP_STRUCT[C.rampIndex(0.90)];
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s) continue;
        this.addUnitLines(game, i, dir);
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

    // 4) 금색 한 번 — 상성 타격 · 화약 시대 총구 화염 · 기계 시대 표시등.
    //    상성은 색이 아니라 **모양(별 폭발)** 으로 알린다. 몸은 건드리지 않는다.
    ctx.fillStyle = C.COL_BONUS;
    ctx.beginPath();
    for (let j = 0; j < n; j++) {
      const i = list[j];
      const era = game.uEra[i];
      const dir = game.uSide[i] === SIDE_L ? 1 : -1;
      if (sf[i]) {
        // 상성 우위 타격 — 무기 끝에서 터지는 금빛 별. 일반 타격과 절대 안 겹친다
        this.addBurst(this.wtX[i], this.wtY[i], 15, dir);
        this.addSpike(this.wtX[i] + dir * 10, this.wtY[i] - 9, dir, -0.3, 12, 4);
        this.addSpike(this.wtX[i] + dir * 10, this.wtY[i] + 9, dir, 0.3, 12, 4);
      }
      if (era === 3 && game.uAttack[i]) {
        this.addSpike(this.wtX[i], this.wtY[i], dir, -0.1, 13, 5);
      }
      if (era === 4) this.addCircle(this.sx[i] + dir * this.smR[i] * 0.55, this.smY[i] + this.smR[i] * 0.5, 2.4);
    }
    ctx.fill();

    // 5) 흰 심 — 상성 타격의 한가운데만. 금색 별 안에 흰 점이 박히면
    //    난전 속에서도 "지금 상성으로 때렸다"가 한 프레임에 읽힌다
    ctx.fillStyle = C.COL_PLAYER;
    ctx.beginPath();
    for (let j = 0; j < n; j++) {
      const i = list[j];
      if (!sf[i]) continue;
      this.addCircle(this.wtX[i], this.wtY[i], 3.6);
    }
    ctx.fill();

    // 6) 체력 — 남은 만큼만. 가득 차 있으면 안 그린다 (선이 시끄러워진다)
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.9)];
    ctx.beginPath();
    let any = 0;
    for (let j = 0; j < n; j++) {
      const i = list[j];
      if (game.uHp[i] >= game.uHpMax[i] * 0.999) continue;
      any = 1;
      ctx.rect(sx[i] - sw[i] * 0.5, sgy[i] - sh[i] * 1.04, sw[i], 3.5);
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
          ctx.rect(sx[i] - sw[i] * 0.5, sgy[i] - sh[i] * 1.04, sw[i] * (hk < 0 ? 0 : hk), 3.5);
        }
        ctx.fill();
      }
    }

    // 화살 — 궁수가 쏜 것이 날아가는 게 보여야 한다.
    // 이게 없으면 원거리 공격이 "아무 일도 안 일어나는데 적이 죽는" 것으로 보인다.
    for (let s = 0; s < 2; s++) {
      ctx.fillStyle = s === SIDE_L
        ? C.RAMP_PLAYER[C.rampIndex(0.92)] : C.RAMP_STRUCT[C.rampIndex(0.92)];
      ctx.beginPath();
      for (let i = 0; i < C.ARROW_MAX; i++) {
        if (game.aLife[i] <= 0 || game.aSide[i] !== s) continue;
        const t = 1 - game.aLife[i] / game.aTotal[i];
        const ax = game.aX0[i] + (game.aX1[i] - game.aX0[i]) * t;
        const ay = game.aY0[i] + (game.aY1[i] - game.aY0[i]) * t - Math.sin(t * Math.PI) * 22;
        const d = game.aX1[i] > game.aX0[i] ? 1 : -1;
        // 포물선의 접선 방향으로 눕는다. 수평 막대는 화살로 안 읽힌다
        const vy = -Math.cos(t * Math.PI) * Math.PI * 22 / Math.abs(game.aX1[i] - game.aX0[i] || 1);
        const ny = vy * 60;
        const ln = Math.sqrt(1 + ny * ny * 0.0004) || 1;
        const ux = d / ln, uy = (ny * 0.02) / ln;
        this.addBar(ax, ay, ux, uy, 7, 5, 1.1, 0.4);
        this.addSpike(ax + ux * 7, ay + uy * 7, ux, uy, 4, 1.8);
        this.addBar(ax - ux * 5, ay - uy * 5, ux, uy, 4, 0, 2.2, 0.6);   // 깃
      }
      ctx.fill();
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
    // 바퀴 둘을 멀리 떼고 그 사이에 삼각 프레임을 세운다. 팔은 평형추를 달고 돈다.
    if (kind === C.U_CATA) {
      const wr = h * 0.25;
      const axY = gy - wr;
      const bx = x - dir * w * 0.36, fx = x + dir * w * 0.30;
      this.addCircle(bx, axY, wr);
      this.addCircle(fx, axY, wr * 0.76);
      this.addBar(bx, axY, dir, 0, w * 0.70, 6, 3.8, 3.8);              // 차대
      ctx.rect(x - w * 0.34, axY - 9, w * 0.46, 7);                     // 탄약 받침
      this.addCircle(x - dir * w * 0.26, axY - 14, 4);                  // 탄
      this.addCircle(x - dir * w * 0.14, axY - 13, 3.4);
      const mx = x - dir * w * 0.02;
      const mastY = axY - h * 0.68;
      this.addBar(mx, axY, 0, -1, h * 0.68, 0, 4.6, 3);                 // 기둥
      this.addBar(bx, axY - 3, dir * 0.62, -0.78, h * 0.64, 0, 2.8, 2); // 뒤 버팀대
      this.addBar(fx, axY - 3, -dir * 0.52, -0.85, h * 0.52, 0, 2.6, 1.9); // 앞 버팀대
      const a = atk > 0 ? 0.5 : 2.35;
      const c = Math.cos(a), s = Math.sin(a);
      const ax2 = dir * c, ay2 = -s;
      this.addBar(mx, mastY, ax2, ay2, h * 0.82, h * 0.32, 3.4, 2);     // 던지는 팔
      const tipX = mx + ax2 * h * 0.82, tipY = mastY + ay2 * h * 0.82;
      this.addCircle(tipX, tipY, 5);                                     // 투척 바구니
      this.addBar(mx - ax2 * h * 0.32, mastY - ay2 * h * 0.32, ax2, ay2, 9, 0, 6.5, 6.5); // 평형추
      this.smY[i] = mastY - 12; this.smR[i] = w * 0.26;
      this.wtX[i] = tipX; this.wtY[i] = tipY;
      if (era >= 1) this.addEraBanner(mx, mastY, w, era, dir);
      return;
    }

    // ── 기병 — 말 위. 폭이 넓고 낮다. 목이 앞으로 길게 나가고 네 다리가 달린다 ──
    if (kind === C.U_CAV) {
      const bodyH = h * 0.28;
      const bodyY = gy - h * 0.58;
      const bodyW = w * 0.80;
      const belly = bodyY + bodyH;
      const cxb = x + lunge;
      ctx.rect(cxb - bodyW * 0.5, bodyY, bodyW, bodyH);
      // 네 다리 — 앞뒤가 엇갈려 달린다
      const g1 = walk * 0.62, g2 = -walk * 0.62;
      const s1 = Math.sin(g1) * dir, c1 = Math.cos(g1);
      const s2 = Math.sin(g2) * dir, c2 = Math.cos(g2);
      this.addBar(cxb + dir * bodyW * 0.36, belly, s1, c1, h * 0.34, 0, 2.8, 1.8);
      this.addBar(cxb + dir * bodyW * 0.24, belly, s2, c2, h * 0.34, 0, 2.8, 1.8);
      this.addBar(cxb - dir * bodyW * 0.36, belly, s2, c2, h * 0.34, 0, 2.8, 1.8);
      this.addBar(cxb - dir * bodyW * 0.24, belly, s1, c1, h * 0.34, 0, 2.8, 1.8);
      // 목 — 가슴에서 앞위로 길게. 이게 있어야 말로 읽힌다
      const nx = cxb + dir * bodyW * 0.42, ny = bodyY + bodyH * 0.5;
      this.addBar(nx, ny, dir * 0.56, -0.83, h * 0.38, 3, 5.4, 3.4);
      const hx2 = nx + dir * 0.56 * h * 0.38, hy2 = ny - 0.83 * h * 0.38;
      this.addBar(hx2, hy2, dir * 0.93, 0.37, h * 0.26, 3, 3.8, 2.2);   // 주둥이는 앞아래로 길게
      this.addBar(hx2, hy2 - 3, -dir * 0.26, -0.97, h * 0.10, 0, 1.8, 1); // 귀
      // 갈기 — 목 뒤로. 말이라는 것을 이 삼각형이 굳힌다
      this.addSpike(nx + dir * h * 0.10, ny - h * 0.24, -dir * 0.5, -0.87, h * 0.16, 4);
      // 꼬리
      this.addBar(cxb - dir * bodyW * 0.5, bodyY + 3, -dir * 0.78, -0.63, h * 0.26, 0, 3, 1);
      // 기수 — 말등에 앉는다
      const rY = bodyY - h * 0.32;
      ctx.rect(cxb - w * 0.12, rY, w * 0.24, h * 0.34);
      const rhR = w * 0.17;
      const rhX = cxb + dir * w * 0.04, rhY = rY - rhR * 0.9;
      this.addCircle(rhX, rhY, rhR);
      // 창 — 앞아래로 겨눈다. 공격하면 더 뻗는다. 끝에 기가 달려 폭이 넓어진다
      const la = atk > 0 ? -0.10 : 0.08;
      const lc = Math.cos(la), ls = Math.sin(la);
      const lpx = cxb + dir * w * 0.06, lpy = rY + h * 0.14;
      const llen = h * 0.92 + (atk > 0 ? 9 : 0);
      this.addBar(lpx, lpy, dir * lc, -ls, llen, w * 0.44, 2.5, 1.6);
      const ltx = lpx + dir * lc * llen, lty = lpy - ls * llen;
      this.addSpike(ltx, lty, dir * lc, -ls, 11, 3.8);
      // 기 — 창 중간에 매달린 삼각기
      const fx2 = lpx + dir * lc * llen * 0.62, fy2 = lpy - ls * llen * 0.62;
      ctx.moveTo(fx2, fy2);
      ctx.lineTo(fx2 - dir * 13, fy2 - 8);
      ctx.lineTo(fx2 - dir * 13, fy2 + 1);
      ctx.closePath();
      this.smY[i] = rhY - rhR; this.smR[i] = rhR;
      this.wtX[i] = ltx + dir * 11; this.wtY[i] = lty;
      this.addEraGear(rhX, rhY, rhR, cxb, rY, w * 0.30, h * 0.30, era, dir);
      return;
    }

    // ── 사람 형태 넷 (검사·창병·궁수·거인) ──
    // 자세(기울기)가 성격이다. 색이 아니라 이 각도가 넷을 가른다.
    const giant = kind === C.U_GIANT;
    const archer = kind === C.U_ARCHER;
    const legH = h * (archer ? 0.30 : (giant ? 0.33 : 0.33));
    const torsoH = h * (giant ? 0.44 : 0.40);
    const headR = w * (giant ? 0.22 : (archer ? 0.27 : 0.28));
    const hipY = gy - legH;
    const lean = giant ? 0.22 : (kind === C.U_SWORD ? 0.15 : (archer ? -0.28 : 0.03));
    const lnv = Math.sqrt(lean * lean + 1);
    const ux = (dir * lean) / lnv, uy = -1 / lnv;
    const bx0 = x + lunge;
    const shX = bx0 + ux * torsoH, shY = hipY + uy * torsoH;
    const bwT = w * (giant ? 0.94 : (archer ? 0.44 : 0.52));   // 어깨 폭
    const bwH = w * (giant ? 0.60 : (archer ? 0.36 : 0.42));   // 허리 폭

    // 다리 — 걷는 위상은 x 에서 나온다. 멈추면 저절로 멎는다
    const lw = giant ? w * 0.23 : Math.max(3, w * 0.16);
    const base = archer ? 0.32 : 0;
    const amp = kind === C.U_SPEAR ? 0.34 : (giant ? 0.20 : 0.30);
    const a1 = base + walk * amp, a2 = -base - walk * amp;
    this.addBar(bx0, hipY, Math.sin(a1) * dir, Math.cos(a1), legH, 0, lw * 0.62, lw * 0.52);
    this.addBar(bx0, hipY, Math.sin(a2) * dir, Math.cos(a2), legH, 0, lw * 0.62, lw * 0.52);

    // 몸통 — 어깨가 허리보다 넓은 사다리꼴. 기울기가 자세를 만든다
    const nx = -uy, ny = ux;
    ctx.moveTo(bx0 - nx * bwH * 0.5, hipY - ny * bwH * 0.5);
    ctx.lineTo(shX - nx * bwT * 0.5, shY - ny * bwT * 0.5);
    ctx.lineTo(shX + nx * bwT * 0.5, shY + ny * bwT * 0.5);
    ctx.lineTo(bx0 + nx * bwH * 0.5, hipY + ny * bwH * 0.5);
    ctx.closePath();

    // 머리 — 거인은 목이 없어 어깨 사이에 파묻힌다. 다만 완전히 묻으면
    // 실루엣이 그냥 양동이가 된다. 정수리만 어깨 위로 내놓는다
    const hgap = giant ? headR * 0.72 : headR * 0.92;
    const hx = shX + ux * hgap + dir * w * 0.03;
    const hy = shY + uy * hgap;
    this.addCircle(hx, hy, headR);

    const handY = shY + torsoH * 0.28;
    const hx0 = shX + dir * bwT * 0.46;

    if (kind === C.U_SWORD) {
      // 커다란 둥근 방패 — 검사의 첫 번째 표식. 몸 앞에 원이 하나 있다
      this.addCircle(bx0 + dir * w * 0.44, hipY - torsoH * 0.44, w * 0.36);
      // 칼 — 높이 들었다가 내려친다. 짧고 두껍다
      const a = atk > 0 ? -0.62 : 1.18;
      const c = Math.cos(a), s = Math.sin(a);
      this.addBar(hx0, handY - 3, dir * c, -s, h * 0.50, 8, 2.9, 1.4);
      this.addBar(hx0, handY - 3, s, dir * c, 7, 7, 2, 2);        // 손잡이 가드
      this.addCircle(hx0 - dir * c * 8, handY - 3 + s * 8, 2.4);  // 손잡이 끝
      this.wtX[i] = hx0 + dir * c * h * 0.50; this.wtY[i] = handY - 3 - s * h * 0.50;
    } else if (kind === C.U_SPEAR) {
      // 창 — **몸 길이보다 앞으로 훨씬 더 나간다.** 이게 사거리다
      const a = atk > 0 ? 0.02 : 0.15;
      const c = Math.cos(a), s = Math.sin(a);
      const len = h * 1.12 + (atk > 0 ? 12 : 0);
      const px = bx0 + dir * w * 0.10;
      this.addBar(px, handY, dir * c, -s, len, w * 0.72, 2.3, 2.1);
      this.addSpike(px + dir * c * len, handY - s * len, dir * c, -s, 15, 4.6);
      this.addSpike(px - dir * c * w * 0.72, handY + s * w * 0.72, -dir * c, s, 7, 2.6); // 물미
      // 등 뒤 네모 방패 — 창병만의 세로 판
      this.addBar(shX - dir * bwT * 0.55, shY + 2, ux, uy, torsoH * 0.86, 0, bwT * 0.20, bwT * 0.16);
      this.wtX[i] = px + dir * c * (len + 15); this.wtY[i] = handY - s * (len + 15);
    } else if (kind === C.U_ARCHER) {
      // 등에 멘 화살통과 **위로 삐죽한 화살깃** — 뒤로 젖힌 몸과 함께 궁수를 만든다
      const qx = shX - dir * bwT * 0.42, qy = shY + torsoH * 0.06;
      this.addBar(qx, qy, -dir * 0.30, -0.95, h * 0.34, h * 0.06, 3.4, 2.8);
      const qtX = qx - dir * 0.30 * h * 0.34, qtY = qy - 0.95 * h * 0.34;
      for (let f = -1; f <= 1; f++) {
        this.addSpike(qtX + f * 3.2, qtY, -dir * 0.24 + f * 0.10, -0.97, h * 0.15, 1.7);
      }
      // 시위에 걸린 화살 — 활 중심에서 뺨까지
      const bxx = shX + dir * w * 0.52, byy = handY - torsoH * 0.16;
      const pull = atk > 0 ? 1 : 0.72;
      this.addBar(bxx + dir * 3, byy, -dir, 0, h * 0.30 * pull, 4, 1.3, 1.3);
      this.wtX[i] = bxx + dir * h * 0.30; this.wtY[i] = byy;
    } else {
      // 거인 — 어깨판 · 등의 혹 · 끝이 부푼 몽둥이. 목이 없다
      const sx2 = shX, sy2 = shY;
      this.addTrap(sx2, sy2 - h * 0.045, sy2 + h * 0.055, w * 0.88, w * 1.06, dir * 2);
      this.addCircle(sx2 - dir * w * 0.42, sy2 + h * 0.01, w * 0.27);   // 등 혹
      const a = atk > 0 ? -0.62 : 0.66;
      const c = Math.cos(a), s = Math.sin(a);
      const cl = h * 0.52;
      this.addBar(hx0, handY, dir * c, -s, cl, 7, 3.4, 8.5);
      this.addCircle(hx0 + dir * c * cl, handY - s * cl, w * 0.21);     // 몽둥이 대가리
      this.wtX[i] = hx0 + dir * c * (cl + w * 0.19); this.wtY[i] = handY - s * (cl + w * 0.19);
    }

    this.smY[i] = hy - headR; this.smR[i] = headR;
    this.addEraGear(hx, hy, headR, shX, shY, bwT, torsoH, era, dir);
  }

  // ── 시대 장비 — 다섯 시대가 실루엣으로 갈려야 한다 ──────────
  // 머리 위 표식만으로 때우면 밀집 전투에서 아무것도 안 보인다.
  // 어깨·등·허리까지 같이 바뀐다.
  addEraGear(hx, hy, r, shX, shY, bwT, torsoH, era, dir) {
    const ctx = this.ctx;
    if (era === 0) {
      // 돌 — 어깨 털. 투구가 없고 윤곽이 거칠다
      for (let k = -1; k <= 1; k++) {
        this.addSpike(shX + k * bwT * 0.34, shY - 1, k * 0.5, -0.87, r * 0.85, 2.6);
      }
    } else if (era === 1) {
      // 청동 — 앞뒤로 선 볏
      ctx.moveTo(hx - dir * r * 0.9, hy - r * 0.55);
      ctx.lineTo(hx, hy - r * 2.0);
      ctx.lineTo(hx + dir * r * 0.9, hy - r * 0.55);
      ctx.closePath();
      ctx.rect(hx - r, hy - r * 0.15, r * 2, r * 0.5);           // 챙
    } else if (era === 2) {
      // 강철 — 뿔 둘 + 견갑 + 망토
      this.addBar(hx - r * 0.82, hy - r * 0.35, -0.42, -0.91, r * 1.35, 0, 2, 1);
      this.addBar(hx + r * 0.82, hy - r * 0.35, 0.42, -0.91, r * 1.35, 0, 2, 1);
      this.addTrap(shX - dir * bwT * 0.42, shY - 3, shY + torsoH * 0.26, bwT * 0.40, bwT * 0.30, 0);
      this.addTrap(shX + dir * bwT * 0.42, shY - 3, shY + torsoH * 0.26, bwT * 0.40, bwT * 0.30, 0);
      ctx.moveTo(shX - dir * bwT * 0.34, shY);                    // 망토
      ctx.lineTo(shX - dir * bwT * 0.9, shY + torsoH * 1.05);
      ctx.lineTo(shX - dir * bwT * 0.2, shY + torsoH * 0.95);
      ctx.closePath();
    } else if (era === 3) {
      // 화약 — 챙 넓은 모자 + 탄띠
      ctx.rect(hx - r * 1.85, hy - r * 0.5, r * 3.7, 3.2);
      this.addTrap(hx, hy - r * 1.75, hy - r * 0.45, r * 1.2, r * 1.7, 0);
      this.addBar(shX - dir * bwT * 0.40, shY + torsoH * 0.62, dir * 0.62, -0.78, torsoH * 0.86, 0, 2.6, 2.6);
    } else {
      // 기계 — 면갑(어두운 패스) + 등짐 + 배기관 + 안테나
      ctx.rect(hx - r * 1.05, hy - r * 1.25, r * 2.1, r * 0.55);  // 면갑 테
      ctx.rect(hx - 1.4, hy - r * 2.5, 2.8, r * 1.4);             // 안테나
      this.addCircle(hx, hy - r * 2.5, 2.4);
      this.addTrap(shX - dir * bwT * 0.62, shY + 1, shY + torsoH * 0.72, bwT * 0.46, bwT * 0.38, 0); // 등짐
      this.addBar(shX - dir * bwT * 0.62, shY, 0, -1, torsoH * 0.5, 0, 2.4, 1.8);   // 배기관
    }
  }

  // 투석기·기계는 사람 장비가 안 붙는다. 기둥 끝의 깃발로 시대를 말한다
  addEraBanner(mx, mastY, w, era, dir) {
    const ctx = this.ctx;
    for (let f = 0; f < era; f++) {
      const fy = mastY - 2 + f * 6;
      ctx.moveTo(mx, fy);
      ctx.lineTo(mx + dir * (11 - f), fy + 2.4);
      ctx.lineTo(mx, fy + 4.8);
      ctx.closePath();
    }
    if (era >= 4) { ctx.rect(mx - 1.3, mastY - 16, 2.6, 12); this.addCircle(mx, mastY - 16, 2.2); }
  }

  // 어두운 안쪽 — 방패 보스 · 면갑 · 안장 · 거인의 얼굴 그늘 · 바퀴 축.
  // 유닛이 흰 덩어리로 뭉치는 것을 이 한 패스가 막는다.
  addUnitDark(game, i, dir) {
    const ctx = this.ctx;
    const kind = game.uKind[i];
    const era = game.uEra[i];
    const x = this.sx[i], gy = this.sgy[i], w = this.sw[i], h = this.sh[i];
    const atk = game.uAttack[i];
    const lunge = atk > 0 ? dir * 4 : 0;

    if (kind === C.U_CATA) {
      const wr = h * 0.25, axY = gy - wr;
      this.addCircle(x - dir * w * 0.36, axY, wr * 0.34);
      this.addCircle(x + dir * w * 0.30, axY, wr * 0.26);
      return;
    }
    if (kind === C.U_CAV) {
      const bodyY = gy - h * 0.58;
      ctx.rect(x + lunge - w * 0.20, bodyY - 3, w * 0.40, 4);      // 안장 그늘
      return;
    }

    const giant = kind === C.U_GIANT;
    const archer = kind === C.U_ARCHER;
    const legH = h * (archer ? 0.30 : 0.33);
    const torsoH = h * (giant ? 0.44 : 0.40);
    const headR = w * (giant ? 0.22 : (archer ? 0.27 : 0.28));
    const hipY = gy - legH;
    const lean = giant ? 0.22 : (kind === C.U_SWORD ? 0.15 : (archer ? -0.28 : 0.03));
    const lnv = Math.sqrt(lean * lean + 1);
    const ux = (dir * lean) / lnv, uy = -1 / lnv;
    const bx0 = x + lunge;
    const shX = bx0 + ux * torsoH, shY = hipY + uy * torsoH;
    const hgap = giant ? headR * 0.72 : headR * 0.92;
    const hx = shX + ux * hgap + dir * w * 0.03;
    const hy = shY + uy * hgap;

    if (kind === C.U_SWORD) {
      this.addCircle(bx0 + dir * w * 0.44, hipY - torsoH * 0.44, w * 0.13);   // 방패 보스
    } else if (giant) {
      ctx.rect(hx - headR * 0.7, hy - 1, headR * 1.4, 2.4);                   // 눈 그늘
    }
    if (era === 4) ctx.rect(hx - headR * 0.85, hy - headR * 0.5, headR * 1.7, headR * 0.55); // 면갑 틈
  }

  // 어두운 윤곽 — 몸의 큰 덩어리만. 전부 두르면 선이 시끄럽다
  addUnitOutline(game, i, dir) {
    const ctx = this.ctx;
    const kind = game.uKind[i];
    const x = this.sx[i], gy = this.sgy[i], w = this.sw[i], h = this.sh[i];
    const atk = game.uAttack[i];
    const lunge = atk > 0 ? dir * 4 : 0;

    if (kind === C.U_CATA) {
      const wr = h * 0.25, axY = gy - wr;
      const bx = x - dir * w * 0.36, fx = x + dir * w * 0.30;
      this.addCircle(bx, axY, wr);
      this.addCircle(fx, axY, wr * 0.76);
      // 바큇살 — 굴러가는 물건이라는 것을 이 두 줄이 말한다
      const sp = wr * 0.72;
      ctx.moveTo(bx - sp, axY - sp); ctx.lineTo(bx + sp, axY + sp);
      ctx.moveTo(bx - sp, axY + sp); ctx.lineTo(bx + sp, axY - sp);
      return;
    }
    if (kind === C.U_CAV) {
      const bodyH = h * 0.28, bodyY = gy - h * 0.58, bodyW = w * 0.80;
      ctx.rect(x + lunge - bodyW * 0.5, bodyY, bodyW, bodyH);
      ctx.rect(x + lunge - w * 0.12, bodyY - h * 0.32, w * 0.24, h * 0.34);
      return;
    }
    const giant = kind === C.U_GIANT;
    const archer = kind === C.U_ARCHER;
    const legH = h * (archer ? 0.30 : 0.33);
    const torsoH = h * (giant ? 0.44 : 0.40);
    const hipY = gy - legH;
    const lean = giant ? 0.22 : (kind === C.U_SWORD ? 0.15 : (archer ? -0.28 : 0.03));
    const lnv = Math.sqrt(lean * lean + 1);
    const ux = (dir * lean) / lnv, uy = -1 / lnv;
    const bx0 = x + lunge;
    const shX = bx0 + ux * torsoH, shY = hipY + uy * torsoH;
    const bwT = w * (giant ? 0.94 : (archer ? 0.44 : 0.52));
    const bwH = w * (giant ? 0.60 : (archer ? 0.36 : 0.42));
    const nx = -uy, ny = ux;
    ctx.moveTo(bx0 - nx * bwH * 0.5, hipY - ny * bwH * 0.5);
    ctx.lineTo(shX - nx * bwT * 0.5, shY - ny * bwT * 0.5);
    ctx.lineTo(shX + nx * bwT * 0.5, shY + ny * bwT * 0.5);
    ctx.lineTo(bx0 + nx * bwH * 0.5, hipY + ny * bwH * 0.5);
    ctx.closePath();
    if (kind === C.U_SWORD) {
      this.addCircle(bx0 + dir * w * 0.44, hipY - torsoH * 0.44, w * 0.36);
    }
  }

  // 선으로만 읽히는 것 — 활과 시위. 채우면 활이 안 보인다
  addUnitLines(game, i, dir) {
    const ctx = this.ctx;
    if (game.uKind[i] !== C.U_ARCHER) return;
    const x = this.sx[i], gy = this.sgy[i], w = this.sw[i], h = this.sh[i];
    const atk = game.uAttack[i];
    const lunge = atk > 0 ? dir * 4 : 0;
    const legH = h * 0.30, torsoH = h * 0.40;
    const hipY = gy - legH;
    const lean = -0.28;
    const lnv = Math.sqrt(lean * lean + 1);
    const ux = (dir * lean) / lnv, uy = -1 / lnv;
    const bx0 = x + lunge;
    const shX = bx0 + ux * torsoH, shY = hipY + uy * torsoH;
    const handY = shY + torsoH * 0.28;
    const bxx = shX + dir * w * 0.52, byy = handY - torsoH * 0.16;
    const R = h * 0.36;
    // 활대
    ctx.moveTo(bxx + dir * R * Math.cos(1.16), byy - R * Math.sin(1.16));
    ctx.arc(bxx, byy, R, dir > 0 ? -1.16 : Math.PI + 1.16, dir > 0 ? 1.16 : Math.PI - 1.16, dir < 0);
    // 시위 — 당기면 뒤로 꺾인다. 활이 살아 있다는 신호
    const pull = atk > 0 ? R * 0.62 : R * 0.34;
    const tipY = R * Math.sin(1.16);
    ctx.moveTo(bxx + dir * R * Math.cos(1.16), byy - tipY);
    ctx.lineTo(bxx - dir * pull, byy);
    ctx.lineTo(bxx + dir * R * Math.cos(1.16), byy + tipY);
  }

  // ── 스킬 연출 — 셋이 서로 달라 보여야 한다 ──────────────────
  //   해일    화면을 가로지르는 **물마루**. 가로로 흐른다
  //   화살비  전선 위에서 **아래로 쏟아진다**. 표적 원이 먼저 그려진다
  //   증원    내 기지에서 **위로 솟는다**. 금빛 기둥
  // 방향이 셋 다 달라야 한 프레임만 봐도 무엇이 터졌는지 안다.
  drawSkillFx(game) {
    const ctx = this.ctx;

    // 해일 — 화면을 가로지르는 마루. 전장 전체를 훑는다
    let f = this.fxSkill[C.SK_TIDE];
    if (f > 0) {
      const t = 1 - f / FX_TIDE_F;
      const cx = -220 + (C.VIEW_W + 440) * easeOutCubic(t);
      const R = 210, HGT = 126;
      // 마루 — 뾰족한 산이 아니라 **물마루**여야 한다. 앞은 서고 뒤는 길게 끌린다
      ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.5 * (1 - t * 0.55))];
      ctx.beginPath();
      ctx.moveTo(cx - R, C.VIEW_H);
      for (let d = -R; d <= R; d += 14) {
        const px = cx + d;
        const k = d > 0 ? 1 - (d / R) * (d / R) * (d / R) : 1 - (d / R) * (d / R);
        ctx.lineTo(px, groundAt(px) - HGT * (k > 0 ? Math.sqrt(k) : 0));
      }
      ctx.lineTo(cx + R, C.VIEW_H);
      ctx.closePath();
      ctx.fill();
      // 마루 위 흰 거품 — 물이라는 것을 이 선이 말한다
      ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.75 * (1 - t))];
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let d = -R; d <= R; d += 14) {
        const px = cx + d;
        const k = d > 0 ? 1 - (d / R) * (d / R) * (d / R) : 1 - (d / R) * (d / R);
        const py = groundAt(px) - HGT * (k > 0 ? Math.sqrt(k) : 0);
        if (d === -R) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
      // 물보라 — 마루 꼭대기에서 앞으로 튄다
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.65 * (1 - t))];
      ctx.beginPath();
      for (let i = 0; i < 14; i++) {
        const d = this.vOff[i] * 80;
        const px = cx + d + i * 3;
        const k = 1 - (d / R) * (d / R);
        const py = groundAt(px) - HGT * Math.sqrt(k > 0 ? k : 0) - 6 - (i * 6) - t * 30;
        const sz = 5 - i * 0.2;
        ctx.rect(px, py, sz, sz);
      }
      ctx.fill();
    }

    // 화살비 — **전선 부근**에만 쏟아진다. 어디에 떨어지는지가 보여야 한다
    f = this.fxSkill[C.SK_VOLLEY];
    if (f > 0) {
      const t = 1 - f / FX_VOLLEY_F;
      const bx = this.fxSkillX[C.SK_VOLLEY];
      // 착탄 지대 — 지면에 그은 타원과 양 끝 기둥. 표적이 먼저 보여야 한다
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.85 * (1 - t))];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(bx, groundAt(bx) - 3, C.VOLLEY_RADIUS, 18, 0, 0, TAU);
      for (let s = -1; s <= 1; s += 2) {
        const ex = bx + s * C.VOLLEY_RADIUS;
        ctx.moveTo(ex, groundAt(ex) - 30);
        ctx.lineTo(ex, groundAt(ex));
      }
      ctx.stroke();
      // 화살 — 위에서 아래로. 촉이 아래를 향한다
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.95)];
      ctx.beginPath();
      for (let i = 0; i < VOLLEY_N; i++) {
        const lt = (t - this.vDelay[i] * 0.45) / 0.5;
        if (lt <= 0 || lt >= 1) continue;
        const ax = bx + this.vOff[i] * C.VOLLEY_RADIUS;
        const g = groundAt(ax);
        const ay = g - 250 + 258 * lt * lt;
        this.addBar(ax, ay, 0.22, 1, 18, 0, 1.2, 0.5);
        this.addSpike(ax + 0.22 * 18, ay + 18, 0.22, 1, 6, 2.2);
      }
      ctx.fill();
      // 착탄 자국
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.85 * (1 - t))];
      ctx.beginPath();
      for (let i = 0; i < VOLLEY_N; i++) {
        const lt = (t - this.vDelay[i] * 0.45) / 0.5;
        if (lt < 1 || lt > 1.8) continue;
        const ax = bx + this.vOff[i] * C.VOLLEY_RADIUS;
        const g = groundAt(ax);
        this.addSpike(ax, g, 0, -1, 12, 3.4);
        this.addSpike(ax, g, -0.7, -0.7, 8, 2.4);
        this.addSpike(ax, g, 0.7, -0.7, 8, 2.4);
      }
      ctx.fill();
      ctx.lineWidth = C.STROKE;
    }

    // 증원 — 내 기지 앞에서 솟는다. 금색 기둥과 퍼지는 고리
    f = this.fxSkill[C.SK_RALLY];
    if (f > 0) {
      const t = 1 - f / FX_RALLY_F;
      const bx = this.fxSkillX[C.SK_RALLY];
      const g = groundAt(bx);
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.9 * (1 - t))];
      ctx.beginPath();
      for (let i = 0; i < C.RALLY_COUNT; i++) {
        const px = bx + (i - 1) * 24;
        const hgt = 74 * easeOutCubic(Math.min(1, t * 2.2));
        ctx.rect(px - 4, g - hgt, 8, hgt);
        this.addSpike(px, g - hgt - 14, 0, -1, 16, 6);
        // 기둥을 타고 오르는 알갱이
        for (let k = 0; k < 3; k++) {
          const py = g - ((t * 150 + k * 26 + i * 11) % 90);
          ctx.rect(px - 8 + k * 6, py, 3, 3);
        }
      }
      ctx.fill();
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.85 * (1 - t))];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      const r = 12 + 62 * easeOutCubic(t);
      ctx.moveTo(bx + r, g);
      ctx.ellipse(bx, g, r, r * 0.32, 0, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }
  }

  // 파티클 — 최대 160개다. 하나씩 fillStyle 을 갈고 fillRect 를 부르면
  // 난전 한 프레임에 320번의 그리기 호출이 된다. 그게 그대로 스파이크다.
  // 색 3종 × 밝기 4단으로 **12묶음**으로 줄인다. 눈으로는 차이가 없다.
  drawParticles(feel) {
    const ctx = this.ctx;
    let live = 0;
    for (let i = 0; i < C.PARTICLE_MAX; i++) if (feel.pLife[i] > 0) { live = 1; break; }
    if (!live) return;
    for (let k = 0; k < 3; k++) {
      const ramp = k === 1 ? C.RAMP_BONUS : (k === 2 ? C.RAMP_DANGER : C.RAMP_PLAYER);
      for (let b = 3; b >= 0; b--) {
        ctx.fillStyle = ramp[C.rampIndex((b + 1) * 0.25)];
        ctx.beginPath();
        let any = 0;
        for (let i = 0; i < C.PARTICLE_MAX; i++) {
          if (feel.pLife[i] <= 0 || feel.pKind[i] !== k) continue;
          const a = feel.pLife[i] / feel.pMax[i];
          let bb = (a * 4) | 0; if (bb > 3) bb = 3; if (bb < 0) bb = 0;
          if (bb !== b) continue;
          const sz = feel.pSize[i] * a;
          ctx.rect(feel.pX[i] - sz * 0.5, feel.pY[i] - sz * 0.5, sz, sz);
          any = 1;
        }
        if (any) ctx.fill();
      }
    }
  }

  drawRings(feel) {
    const ctx = this.ctx;
    for (let i = 0; i < C.RING_MAX; i++) {
      if (feel.ringStep[i] < 0) continue;
      const t = feel.ringStep[i] / feel.ringSteps;
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(1 - t)];
      ctx.lineWidth = 3 * (1 - t) + 0.6;
      ctx.beginPath();
      ctx.arc(feel.ringX[i], feel.ringY[i], C.RING_R * easeOutCubic(t), 0, TAU);
      ctx.stroke();
    }
    ctx.lineWidth = C.STROKE;
  }

  // 떠오르는 숫자 — 피해와 수입이 어디서 났는지 눈으로 따라갈 수 있어야 한다
  drawFloats(feel) {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_SMALL;
    let live = 0;
    for (let i = 0; i < C.FLOAT_MAX; i++) if (feel.fStep[i] >= 0) { live = 1; break; }
    if (!live) return;
    for (let k = 0; k < 2; k++) {
      const ramp = k === 1 ? C.RAMP_BONUS : C.RAMP_DANGER;
      for (let b = 3; b >= 0; b--) {
        let set = 0;
        for (let i = 0; i < C.FLOAT_MAX; i++) {
          if (feel.fStep[i] < 0 || (feel.fKind[i] === 1) !== (k === 1)) continue;
          const t = feel.fStep[i] / feel.fSteps;
          let bb = ((1 - t) * 4) | 0; if (bb > 3) bb = 3; if (bb < 0) bb = 0;
          if (bb !== b) continue;
          if (!set) { ctx.fillStyle = ramp[C.rampIndex((b + 1) * 0.25)]; set = 1; }
          this.drawNumber(feel.fVal[i], feel.fX[i], feel.fY[i] - C.FLOAT_RISE * easeOutCubic(t), 9);
        }
      }
    }
  }

  // ── 물 — 배경이 아니라 위협이다 ─────────────────────────────
  // 물빛을 붉게 깔았더니 잠긴 유닛이 전부 붉어져 **아군과 적군이 안 갈렸다.**
  // 색조가 아니라 밝기 문제였다. 물속은 어둡게 깔고 붉은색은 수면에만 쓴다.
  drawWater(game, alpha) {
    const ctx = this.ctx;
    const wy = game.prevWater + (game.water - game.prevWater) * alpha;
    if (wy >= C.VIEW_H) return;

    // 수면 — 사인 두 개를 겹쳐 물결을 만든다. 한 프레임에 여러 번 그리므로
    // sin 은 한 번만 돌리고 값을 재사용한다 (문자열도 객체도 안 만든다).
    const t = game.simTime * 0.0016;
    const wave = this.wave;
    for (let i = 0, x = 0; i < this.waveN; i++, x += 24) {
      wave[i] = Math.sin(x * 0.017 + t) * 4 + Math.sin(x * 0.041 - t * 1.7) * 2.5;
    }
    const last = (C.VIEW_W / 24) | 0;

    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.66)];
    ctx.beginPath();
    ctx.moveTo(0, C.VIEW_H);
    for (let i = 0; i <= last; i++) ctx.lineTo(i * 24, wy + wave[i]);
    ctx.lineTo(C.VIEW_W, C.VIEW_H);
    ctx.closePath();
    ctx.fill();

    // 반사 — 수면 바로 아래에 세로로 늘어진 빛. 물이 거울이라는 신호다.
    // 기지·폭포처럼 밝은 것 아래에만 둔다
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.06)];
    ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const rx = 40 + this.rn(i * 11) * (C.VIEW_W - 80);
      const wob = Math.sin(t * 2.4 + i) * 3;
      ctx.rect(rx + wob, wy + 4, 2.5, 16 + this.rn(i * 11 + 1) * 30);
    }
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

    // 물마루 포말 — 수면 위로 튀는 흰 점. 물이 살아 있다
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.30)];
    ctx.beginPath();
    for (let i = 0; i <= last; i += 2) {
      const cur = wave[i];
      if (cur > 2.5) ctx.rect(i * 24, wy + cur - 3, 12, 2);
    }
    ctx.fill();
  }

  // ── HUD — 여섯 개가 항상 보여야 한다 ────────────────────────
  //   금 · 경험치/시대 · 전선 위치 · 내 기지 체력 · 적 기지 체력 · 물 높이
  drawHud(game, feel, director, directorView, muted) {
    const ctx = this.ctx;

    if (feel.flashFrames > 0) {
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(feel.flashFrames / C.FLASH_FRAMES * 0.3)];
      ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
    }

    ctx.textBaseline = 'top';

    // 금 — 왼쪽 위. 가장 자주 보는 숫자다. 동전 하나를 붙여 무엇인지 못 박는다
    ctx.fillStyle = C.COL_BONUS;
    ctx.beginPath();
    this.addCircle(64, 24, 8);
    ctx.fill();
    ctx.fillStyle = C.COL_BG;
    ctx.beginPath();
    this.addCircle(64, 24, 3.4);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.font = FONT_SCORE;
    ctx.fillStyle = C.COL_BONUS;
    const gx = 80;
    const gw = this.drawLeft(game.gold, gx, 10, 15);
    ctx.font = FONT_TINY;
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.55)];
    ctx.fillText(LABEL_GOLD, gx + gw + 4, 24);

    // 시대와 경험치 — 다섯 칸짜리 눈금. 몇 단계 남았는지가 보여야 한다
    ctx.font = FONT_SMALL;
    ctx.fillStyle = C.COL_PLAYER;
    ctx.fillText(C.ERA_NAME[game.era], 60, 46);
    {
      const need = game.eraNeed();
      const bw = 128, bh = 7, bx = 96, by = 50;
      ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.95)];
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.30)];
      ctx.fillRect(bx, by, bw, bh);
      if (need > 0) {
        ctx.fillStyle = game.eraReady() ? C.COL_BONUS : C.RAMP_BONUS[C.rampIndex(0.62)];
        ctx.fillRect(bx, by, bw * Math.min(1, game.xp / need), bh);
      } else {
        ctx.fillStyle = C.COL_BONUS;
        ctx.fillRect(bx, by, bw, bh);
      }
      // 다섯 시대 눈금. 지나온 칸은 금색 점. 같은 색은 경로 하나에 모은다
      ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.95)];
      ctx.beginPath();
      for (let i = 1; i < C.ERA_COUNT; i++) ctx.rect(bx + bw * (i / C.ERA_COUNT), by - 1, 2, bh + 2);
      ctx.fill();
      if (game.era > 0) {
        ctx.fillStyle = C.COL_BONUS;
        ctx.beginPath();
        for (let i = 0; i < game.era; i++) ctx.rect(bx - 1 + bw * (i / C.ERA_COUNT), by - 5, 3, 3);
        ctx.fill();
      }
    }

    // 획득 특성 — 금 아래에 알약으로. 내 것은 내 쪽에 모아 둔다
    ctx.font = FONT_MICRO;
    let px = 60;
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.20)];
    ctx.beginPath();
    let anyT = 0;
    for (let i = 0; i < C.TRAITS.length; i++) {
      if (!game.traits[i]) continue;
      const tw = C.TRAITS[i].name.length * 11 + 10;
      ctx.roundRect(px, 68, tw, 15, 7);
      px += tw + 5; anyT = 1;
      if (px > 300) break;
    }
    if (anyT) {
      ctx.fill();
      ctx.fillStyle = C.COL_BONUS;
      px = 60;
      for (let i = 0; i < C.TRAITS.length; i++) {
        if (!game.traits[i]) continue;
        const tw = C.TRAITS[i].name.length * 11 + 10;
        ctx.fillText(C.TRAITS[i].name, px + 5, 71);
        px += tw + 5;
        if (px > 300) break;
      }
    }

    this.drawFrontBar(game);
    this.drawWaterGauge(game);

    if (director && directorView) this.drawDirectorView(game, director);
    this.drawToggle(directorView);
    this.drawMute(muted);
  }

  // ── 전선 막대 — 이 게임에서 가장 중요한 한 줄 ──
  // 숫자를 읽지 않고도 **내가 밀고 있는지 밀리는지**가 보여야 한다.
  // 양 끝에 두 기지 체력을 붙여 넷을 하나의 그림으로 읽게 한다.
  drawFrontBar(game) {
    const ctx = this.ctx;
    const y = HUD_BAR_Y;

    // 시간
    ctx.textAlign = 'center';
    ctx.font = FONT_TINY;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    this.drawFixed1(game.elapsed(), HALF_W - 12, 8);

    // 내 기지 체력 (왼쪽에서 오른쪽으로 찬다)
    const kL = game.baseK(SIDE_L), kR = game.baseK(SIDE_R);
    const lx = HUD_X0, rx = HUD_X0 + HUD_HP_W + 12 + HUD_FRONT_W + 12;
    const hy = y + (HUD_FRONT_H - HUD_HP_H) * 0.5;
    for (let s = 0; s < 2; s++) {
      const bx = s === 0 ? lx : rx;
      const k = s === 0 ? kL : kR;
      const col = k > 0.3 ? (s === 0 ? C.COL_PLAYER : C.COL_STRUCT) : C.COL_DANGER;
      ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.95)];
      ctx.fillRect(bx - 1, hy - 1, HUD_HP_W + 2, HUD_HP_H + 2);
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.22)];
      ctx.fillRect(bx, hy, HUD_HP_W, HUD_HP_H);
      // 남은 체력 + 성 표식 — 같은 색이므로 한 경로에 모은다.
      // 안쪽(전장 쪽)에서 바깥으로 줄어든다 — 적이 밀고 들어오는 방향과 같다
      const mx = s === 0 ? bx - 12 : bx + HUD_HP_W + 3;
      ctx.fillStyle = col;
      ctx.beginPath();
      if (s === 0) ctx.rect(bx, hy, HUD_HP_W * k, HUD_HP_H);
      else ctx.rect(bx + HUD_HP_W * (1 - k), hy, HUD_HP_W * k, HUD_HP_H);
      ctx.rect(mx, hy + 2, 9, HUD_HP_H - 2);
      ctx.rect(mx, hy - 2, 3, 4);
      ctx.rect(mx + 6, hy - 2, 3, 4);
      ctx.fill();
      // 라벨은 바깥쪽, 숫자는 안쪽. 서로 겹치지 않는다
      ctx.font = FONT_MICRO;
      ctx.textAlign = 'left';
      const ty = hy + HUD_HP_H + 4;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.42)];
      ctx.fillText(s === 0 ? LABEL_ME : LABEL_FOE, s === 0 ? bx : bx + HUD_HP_W - 22, ty);
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.7)];
      const v = game.baseHp[s] < 0 ? 0 : game.baseHp[s];
      if (s === 0) this.drawRight(v, bx + HUD_HP_W, ty, 7);
      else this.drawLeft(v, bx, ty, 7);
    }

    // 전선 — 가운데. 흰쪽이 내 영역이다
    const fx = HUD_X0 + HUD_HP_W + 12;
    const f = game.frontline();
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.95)];
    ctx.fillRect(fx - 2, y - 2, HUD_FRONT_W + 4, HUD_FRONT_H + 4);
    ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.72)];
    ctx.fillRect(fx, y, HUD_FRONT_W, HUD_FRONT_H);
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.92)];
    ctx.fillRect(fx, y, HUD_FRONT_W * f, HUD_FRONT_H);
    // 가운데 기준선 — 이보다 오른쪽이면 이기고 있다
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(1)];
    ctx.fillRect(fx + HUD_FRONT_W * 0.5 - 1, y - 4, 2, HUD_FRONT_H + 8);
    // 전선 촉 — 지금 어디인지
    ctx.fillStyle = C.COL_BONUS;
    ctx.beginPath();
    const px = fx + HUD_FRONT_W * f;
    ctx.moveTo(px, y - 1);
    ctx.lineTo(px - 5, y - 8);
    ctx.lineTo(px + 5, y - 8);
    ctx.closePath();
    ctx.fill();
  }

  // ── 수위 게이지 — 물은 위로 차오른다. 세로로 읽혀야 한다 ────
  drawWaterGauge(game) {
    const ctx = this.ctx;
    const span = C.VIEW_H - C.WATER_MIN_Y;
    let k = (C.VIEW_H - game.water) / span;
    k = k < 0 ? 0 : (k > 1 ? 1 : k);
    const warn = game.water < C.GROUND_Y + C.WATER_WARN;
    const pulse = warn ? 0.72 + 0.28 * Math.sin(game.simTime * 0.006) : 0.5;

    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.9)];
    ctx.fillRect(WG_X - 2, WG_Y - 2, WG_W + 4, WG_H + 4);
    ctx.strokeStyle = C.RAMP_DANGER[C.rampIndex(pulse)];
    ctx.lineWidth = C.STROKE;
    ctx.strokeRect(WG_X - 2, WG_Y - 2, WG_W + 4, WG_H + 4);

    // 채워진 물
    const fh = WG_H * k;
    ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.55)];
    ctx.fillRect(WG_X, WG_Y + WG_H - fh, WG_W, fh);
    ctx.fillStyle = C.COL_DANGER;
    ctx.fillRect(WG_X, WG_Y + WG_H - fh - 2, WG_W, 2.5);

    // 눈금 — 협곡 바닥과 기지 발밑. 여기 닿으면 무슨 일이 나는지가 보인다
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.45)];
    ctx.fillRect(WG_X - 7, WG_Y + WG_H - WG_H * WG_MARKS[0] - 1, WG_W + 14, 1.6);
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.7)];
    ctx.fillRect(WG_X - 7, WG_Y + WG_H - WG_H * WG_MARKS[1] - 1, WG_W + 14, 1.6);

    ctx.font = FONT_MICRO;
    ctx.textAlign = 'center';
    ctx.fillStyle = C.COL_DANGER;
    ctx.fillText(LABEL_WATER, WG_X + WG_W * 0.5 - 4, WG_Y - 16);
    ctx.textAlign = 'left';
  }

  // ── 버튼 열 — 이 게임의 조작 전부 ───────────────────────────
  // 열 칸이라 한 칸이 83×66 이다. **가격·쿨다운·살 수 있는가·무슨 유닛인가**가
  // 한눈에 들어와야 한다. 쿨다운은 원호로, 못 사는 상태는 알파로.
  // 버튼 열은 **글자가 많다.** 이름 10 + 키 10 + 값의 자릿수 30 ≈ 50번의 fillText 다.
  // 자리별로 그리는 규칙(문자열을 안 만든다)은 유지해야 하고, fillText 호출 수가
  // 곧 프레임 스파이크다 — 실측에서 버튼만 빼도 초과가 61→37 로 떨어졌다.
  // 그런데 **버튼 그림은 거의 안 바뀐다.** 가격·구매가능·모드가 그대로면 같은 그림이다.
  // 그래서 상태 서명이 바뀔 때만 굽고, 매 프레임은 한 번 붙이고 쿨다운 원호만 얹는다.
  drawButtons(game) {
    const ctx = this.ctx;
    const sig = this.computeButtonState(game);
    if (typeof document !== 'undefined') {
      const s = this.viewScale > 2 ? 2 : (this.viewScale < 0.25 ? 0.25 : this.viewScale);
      if (this.btnSig !== sig || this.btnScale !== s) {
        const w = Math.ceil(STRIP_W * s), h = Math.ceil(STRIP_H * s);
        if (!this.btnCanvas) this.btnCanvas = document.createElement('canvas');
        if (this.btnCanvas.width !== w || this.btnCanvas.height !== h) {
          this.btnCanvas.width = w; this.btnCanvas.height = h;
        }
        const octx = this.btnCanvas.getContext('2d');
        const prev = this.ctx;
        this.ctx = octx;
        octx.setTransform(s, 0, 0, s, -STRIP_X * s, -STRIP_Y * s);
        octx.clearRect(STRIP_X, STRIP_Y, STRIP_W, STRIP_H);
        this.paintButtonStrip(game);
        this.ctx = prev;
        this.btnSig = sig; this.btnScale = s;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.btnCanvas, STRIP_X, STRIP_Y, STRIP_W, STRIP_H);
      ctx.imageSmoothingEnabled = true;
    } else {
      this.paintButtonStrip(game);
    }
    this.drawButtonCooldowns();
  }

  // 무엇이 바뀌면 다시 구워야 하는가 — 가격·구매가능·모드·남은 초·시대.
  // 쿨다운 원호는 서명에 넣지 않는다. 그건 매 프레임 위에 따로 그린다.
  computeButtonState(game) {
    const skillCd = game.skillCd;
    const ok = this.btnOk, cd = this.btnCd, cost = this.btnCost, mode = this.btnMode;
    let sig = (game.era | 0) * 7919;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      let o = 1, c = 0, price = -1, m = 0;
      if (i < C.UNIT_KINDS) {
        price = game.cost(i);
        o = game.gold >= price ? 1 : 0;
        const full = game.spawnCooldown ? game.spawnCooldown(i) : C.U_SPAWN_CD[i];
        c = full > 0 ? game.spawnCd[i] / full : 0;
        if (c > 0) o = 0;
        m = 0;                                     // 가격
      } else if (i === C.B_ERA) {
        o = game.eraReady() ? 1 : 0;
        m = 1;                                     // 다음 시대 이름 / 준비
      } else if (i === C.B_TOWER) {
        price = game.towerCost ? game.towerCost() : -1;
        if (price < 0) { m = 2; o = 0; }           // 최대
        else { m = 0; o = game.gold >= price ? 1 : 0; }
      } else {
        const sk = i === C.B_TIDE ? C.SK_TIDE : C.SK_VOLLEY;
        const raw = skillCd ? (skillCd[sk] || 0) : (sk === C.SK_TIDE ? (game.nukeCd || 0) : 0);
        c = raw / C.SKILL_CD[sk];
        o = raw <= 0 ? 1 : 0;
        m = o ? 3 : 4;                             // 준비 / 남은 초
        price = o ? -1 : Math.ceil(raw / 1000);
      }
      ok[i] = o; cd[i] = c; cost[i] = price; mode[i] = m;
      sig = (sig * 131 + o * 3 + m * 11 + (price + 1) * 37) | 0;
    }
    return sig;
  }

  // 쿨다운 원호 — 매 프레임 바뀐다. 구운 그림 위에 얹는다
  drawButtonCooldowns() {
    const ctx = this.ctx;
    const cd = this.btnCd;
    let anyCd = 0;
    for (let i = 0; i < C.BTN_COUNT; i++) if (cd[i] > 0) { anyCd = 1; break; }
    if (!anyCd) return;
    ctx.lineWidth = 4;
    ctx.strokeStyle = C.RAMP_BG[C.rampIndex(0.85)];
    ctx.beginPath();
    for (let i = 0; i < C.BTN_COUNT; i++) {
      if (cd[i] <= 0) continue;
      const icx = BTN_X0 + i * (BTN_W + BTN_GAP) + BTN_ICON_DX;
      ctx.moveTo(icx + 19, C.BTN_Y + BTN_ICON_DY);
      ctx.arc(icx, C.BTN_Y + BTN_ICON_DY, 19, 0, TAU);
    }
    ctx.stroke();
    for (let g = 0; g < 2; g++) {
      ctx.strokeStyle = (g ? C.RAMP_BONUS : C.RAMP_PLAYER)[C.rampIndex(0.8)];
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if (cd[i] <= 0 || (i >= C.B_ERA) !== !!g) continue;
        const icx = BTN_X0 + i * (BTN_W + BTN_GAP) + BTN_ICON_DX;
        const a0 = -Math.PI * 0.5;
        ctx.moveTo(icx, C.BTN_Y + BTN_ICON_DY - 19);
        ctx.arc(icx, C.BTN_Y + BTN_ICON_DY, 19, a0, a0 + TAU * cd[i]);
        any = 1;
      }
      if (any) ctx.stroke();
    }
    ctx.lineWidth = C.STROKE;
  }

  // 버튼 열 한 장 — 카드 · 아이콘 · 글자. 쿨다운 원호는 여기 없다
  paintButtonStrip(game) {
    const ctx = this.ctx;
    const ok = this.btnOk, cost = this.btnCost, mode = this.btnMode;
    ctx.textBaseline = 'top';

    // 2) 카드 — **그리기 호출 수가 곧 비용이다.** 칸마다 fill/stroke 를 부르면
    //    열 칸에서 서른 번이 되고, 그 서른 번이 합성 스레드를 밀어 스파이크가 된다.
    //    같은 색으로 칠할 것은 경로 하나에 모아 한 번에 칠한다.
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.96)];
    ctx.beginPath();
    for (let i = 0; i < C.BTN_COUNT; i++) {
      ctx.roundRect(BTN_X0 + i * (BTN_W + BTN_GAP), BTN_Y, BTN_W, BTN_H, BTN_R);
    }
    ctx.fill();
    for (let g = 0; g < 2; g++) {                    // 물든 안쪽 — 유닛/특수기 두 계열
      ctx.fillStyle = (g ? C.RAMP_BONUS : C.RAMP_PLAYER)[C.rampIndex(0.07)];
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if (!ok[i] || (i >= C.B_ERA) !== !!g) continue;
        ctx.roundRect(BTN_X0 + i * (BTN_W + BTN_GAP), BTN_Y, BTN_W, BTN_H, BTN_R);
        any = 1;
      }
      if (any) ctx.fill();
    }
    for (let g = 0; g < 4; g++) {                    // 테두리 — 계열×가능여부 넷
      const acc = g & 1, on = g >> 1;
      ctx.strokeStyle = (acc ? C.RAMP_BONUS : C.RAMP_PLAYER)[C.rampIndex(on ? 0.92 : 0.24)];
      ctx.lineWidth = on ? C.STROKE : 1;
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if ((i >= C.B_ERA) !== !!acc || (!!ok[i]) !== !!on) continue;
        ctx.roundRect(BTN_X0 + i * (BTN_W + BTN_GAP) + 0.5, BTN_Y + 0.5, BTN_W - 1, BTN_H - 1, BTN_R);
        any = 1;
      }
      if (any) ctx.stroke();
    }
    ctx.lineWidth = C.STROKE;

    // 3) 아이콘 — 채우는 것 넷 묶음, 선인 것 둘 묶음, 파낸 구멍 한 묶음
    for (let g = 0; g < 4; g++) {
      const acc = g & 1, on = g >> 1;
      ctx.fillStyle = (acc ? C.RAMP_BONUS : C.RAMP_PLAYER)[C.rampIndex(on ? 0.95 : 0.30)];
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if ((i >= C.B_ERA) !== !!acc || (!!ok[i]) !== !!on) continue;
        const x = BTN_X0 + i * (BTN_W + BTN_GAP);
        if (this.addBtnIconFill(i, x + BTN_ICON_DX, BTN_Y + BTN_ICON_DY)) any = 1;
      }
      if (any) ctx.fill();
    }
    ctx.lineWidth = 2;
    for (let g = 0; g < 4; g++) {
      const acc = g & 1, on = g >> 1;
      ctx.strokeStyle = (acc ? C.RAMP_BONUS : C.RAMP_PLAYER)[C.rampIndex(on ? 0.95 : 0.30)];
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if ((i >= C.B_ERA) !== !!acc || (!!ok[i]) !== !!on) continue;
        const x = BTN_X0 + i * (BTN_W + BTN_GAP);
        if (this.addBtnIconStroke(i, x + BTN_ICON_DX, BTN_Y + BTN_ICON_DY)) any = 1;
      }
      if (any) ctx.stroke();
    }
    ctx.lineWidth = C.STROKE;
    ctx.fillStyle = C.COL_BG;                        // 방패 보스·바퀴 축 구멍
    ctx.beginPath();
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = BTN_X0 + i * (BTN_W + BTN_GAP);
      this.addBtnIconHole(i, x + BTN_ICON_DX, BTN_Y + BTN_ICON_DY);
    }
    ctx.fill();


    // 4) 동전 표식 — 색이 둘뿐이다. 경로를 모아 두 번에 칠한다
    for (let pass = 0; pass < 3; pass++) {
      ctx.fillStyle = pass === 0 ? C.COL_BONUS
        : (pass === 1 ? C.RAMP_BONUS[C.rampIndex(0.30)] : C.RAMP_BG[C.rampIndex(0.95)]);
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if (mode[i] !== 0 || cost[i] < 0) continue;
        if (pass < 2 && (ok[i] === 1) !== (pass === 0)) continue;
        const x = BTN_X0 + i * (BTN_W + BTN_GAP);
        const cyy = BTN_Y + BTN_H - 14;
        this.addCircle(x + 12, cyy, pass === 2 ? 1.8 : 4.5);
        any = 1;
      }
      if (any) ctx.fill();
    }

    // 5) 글자 — **폰트를 세 번만 간다.** ctx.font 교체는 비싸고,
    //    칸마다 갈면 한 프레임에 서른 번이 된다. 실측에서 이게 스파이크의 주범이었다.
    ctx.textAlign = 'left';
    ctx.font = FONT_BTN;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const base = i >= C.B_ERA ? C.RAMP_BONUS : C.RAMP_PLAYER;
      ctx.fillStyle = base[C.rampIndex(ok[i] ? 1 : 0.4)];
      ctx.fillText(BTN_NAME[i], BTN_X0 + i * (BTN_W + BTN_GAP) + 7, BTN_Y + 6);
    }

    ctx.font = FONT_SMALL;
    const ly = BTN_Y + BTN_H - 22;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = BTN_X0 + i * (BTN_W + BTN_GAP);
      const m = mode[i];
      if (m === 0) {
        ctx.fillStyle = ok[i] ? C.COL_BONUS : C.RAMP_BONUS[C.rampIndex(0.34)];
        this.drawLeft(cost[i], x + 20, ly, 9);
      } else if (m === 1) {
        ctx.fillStyle = ok[i] ? C.COL_BONUS : C.RAMP_PLAYER[C.rampIndex(0.32)];
        ctx.fillText(ok[i] ? READY : C.ERA_NAME[Math.min(C.ERA_COUNT - 1, game.era + 1)], x + 7, ly);
      } else if (m === 2) {
        ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.5)];
        ctx.fillText(LABEL_MAX, x + 7, ly);
      } else if (m === 3) {
        ctx.fillStyle = C.COL_BONUS;
        ctx.fillText(READY, x + 7, ly);
      } else {
        ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.34)];
        const wsec = this.drawLeft(cost[i], x + 7, ly, 9);
        ctx.fillText(LABEL_S, x + 7 + wsec + 1, ly);
      }
    }

    ctx.font = FONT_MICRO;
    ctx.textAlign = 'right';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.38)];
    for (let i = 0; i < C.BTN_COUNT; i++) {
      ctx.fillText(C.KEY_HINT[i], BTN_X0 + i * (BTN_W + BTN_GAP) + BTN_W - 5, BTN_Y + 6);
    }
    ctx.textAlign = 'left';
  }


  // ── 증원 — 우하단 원형. 키보드 R ────────────────────────────
  drawRally(game) {
    const ctx = this.ctx;
    const cx = C.RALLY_CX, cy = C.RALLY_CY, r = C.RALLY_R;
    const raw = game.skillCd ? (game.skillCd[C.SK_RALLY] || 0) : 0;
    const cd = raw / C.SKILL_CD[C.SK_RALLY];
    const ok = raw <= 0;

    ctx.fillStyle = C.COL_BG;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, TAU);
    ctx.fill();
    if (ok) {
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.10)];
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
    }

    if (cd > 0) {                       // 쿨다운 — 남은 만큼의 원호
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.30)];
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 2, -Math.PI * 0.5, -Math.PI * 0.5 + TAU * cd);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(ok ? 0.95 : 0.30)];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();

    // 아이콘 — 작은 사람 셋이 위로 솟는다. "셋이 온다"가 그대로 보인다
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(ok ? 1 : 0.32)];
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const px = cx + (i - 1) * 9;
      const h = i === 1 ? 14 : 10;
      ctx.rect(px - 2.5, cy - h * 0.5 + 1, 5, h);
      this.addCircle(px, cy - h * 0.5 - 2.5, 2.8);
    }
    ctx.fill();
    ctx.font = FONT_MICRO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.42)];
    ctx.fillText(KEY_RALLY, cx, cy + r - 13);
    ctx.textAlign = 'left';
  }

  // 버튼 아이콘 — 전장 유닛 실루엣의 축소판. 형태만으로 구분돼야 한다.
  // **칠하지 않는다.** 현재 경로에 더하기만 하고 호출한 쪽이 묶어서 칠한다.
  // 그려야 할 게 있으면 1 을 돌려준다 (빈 경로에 fill 을 부르지 않기 위해).
  addBtnIconFill(i, cx, cy) {
    const ctx = this.ctx;
    if (i === C.U_SWORD) {
      // 검사 — 큰 둥근 방패 + 짧은 칼
      this.addBar(cx - 1, cy + 8, 0.15, -1, 15, 0, 3.4, 2.8);
      this.addCircle(cx + 1, cy - 10, 3.6);
      this.addBar(cx + 4, cy - 3, 0.66, -0.75, 14, 3, 2, 1.2);
      this.addBar(cx + 4, cy - 3, 0.75, 0.66, 5, 5, 1.6, 1.6);
      this.addCircle(cx - 6, cy + 1, 6);
    } else if (i === C.U_SPEAR) {
      this.addBar(cx - 2, cy + 8, 0, -1, 15, 0, 3, 2.6);
      this.addCircle(cx - 2, cy - 10, 3.4);
      this.addSpike(cx - 2, cy - 15, 0, -1, 5, 3);
      this.addBar(cx - 11, cy - 2, 1, -0.08, 25, 0, 1.5, 1.3);
      this.addSpike(cx + 14, cy - 3, 1, -0.08, 7, 2.8);
    } else if (i === C.U_ARCHER) {
      // 궁수 — 뒤로 젖힌 몸 + 등의 화살깃 (활은 선 패스에서)
      this.addBar(cx - 3, cy + 8, -0.26, -1, 14, 0, 3, 2.6);
      this.addCircle(cx - 7, cy - 8, 3.2);
      for (let k = -1; k <= 1; k++) this.addSpike(cx - 10 + k * 2.6, cy - 4, -0.2 + k * 0.1, -1, 7, 1.4);
    } else if (i === C.U_CAV) {
      ctx.rect(cx - 11, cy - 1, 17, 6);
      this.addBar(cx + 5, cy, 0.62, -0.78, 9, 2, 3.2, 2);
      this.addBar(cx + 10, cy - 6, 0.94, 0.34, 6, 1, 2.4, 1.6);
      this.addBar(cx - 9, cy + 5, -0.3, 1, 7, 0, 1.7, 1.2);
      this.addBar(cx - 5, cy + 5, 0.3, 1, 7, 0, 1.7, 1.2);
      this.addBar(cx + 1, cy + 5, -0.3, 1, 7, 0, 1.7, 1.2);
      this.addBar(cx + 4, cy + 5, 0.3, 1, 7, 0, 1.7, 1.2);
      this.addBar(cx - 11, cy - 1, -0.7, -0.7, 6, 0, 1.6, 1);
      ctx.rect(cx - 4, cy - 10, 5, 9);
      this.addCircle(cx - 1.5, cy - 12, 2.6);
      this.addBar(cx - 2, cy - 6, 1, 0.16, 16, 3, 1.3, 1);
    } else if (i === C.U_GIANT) {
      this.addTrap(cx - 1, cy - 7, cy + 9, 15, 11, 0);
      ctx.rect(cx - 11, cy - 11, 21, 5);
      this.addCircle(cx - 1, cy - 13, 3);
      this.addCircle(cx - 10, cy - 6, 4);
      this.addBar(cx + 8, cy - 3, 0.72, -0.69, 11, 2, 2, 4);
      this.addCircle(cx + 16, cy - 11, 4.2);
    } else if (i === C.U_CATA) {
      this.addCircle(cx - 9, cy + 8, 5);
      this.addCircle(cx + 7, cy + 8, 3.4);
      this.addBar(cx - 9, cy + 8, 1, 0, 16, 0, 1.8, 1.8);
      this.addBar(cx - 2, cy + 8, 0, -1, 12, 0, 2.2, 1.7);
      this.addBar(cx - 2, cy - 4, 0.64, -0.77, 13, 5, 1.9, 1.4);
      this.addCircle(cx + 6.3, cy - 14, 2.8);
    } else if (i === C.B_ERA) {
      ctx.moveTo(cx, cy - 12); ctx.lineTo(cx + 10, cy + 1); ctx.lineTo(cx + 4.5, cy + 1);
      ctx.lineTo(cx + 4.5, cy + 10); ctx.lineTo(cx - 4.5, cy + 10); ctx.lineTo(cx - 4.5, cy + 1);
      ctx.lineTo(cx - 10, cy + 1); ctx.closePath();
    } else if (i === C.B_TOWER) {
      ctx.rect(cx - 10, cy + 3, 20, 8);
      for (let m = 0; m < 3; m++) ctx.rect(cx - 10 + m * 8, cy, 5, 3);
      ctx.rect(cx - 6, cy - 6, 12, 7);
      this.addBar(cx + 3, cy - 4, 1, -0.2, 13, 2, 2.6, 1.9);
    } else if (i === C.B_TIDE) {
      return 0;                                    // 해일은 선으로만 그린다
    } else {
      // 화살비 — 화살 셋이 지면으로 쏟아진다
      for (let k = 0; k < 3; k++) {
        const px = cx - 8 + k * 8, oy = (k & 1) * 4;
        this.addBar(px - 3, cy - 13 + oy, 0.2, 1, 13, 0, 1.2, 0.6);
        this.addSpike(px - 0.4, cy + 0.5 + oy, 0.2, 1, 4.5, 2);
      }
      ctx.rect(cx - 12, cy + 8, 24, 2.4);
    }
    return 1;
  }

  addBtnIconStroke(i, cx, cy) {
    const ctx = this.ctx;
    if (i === C.U_ARCHER) {
      ctx.moveTo(cx + 5 + 9 * Math.cos(1.15), cy - 1 - 9 * Math.sin(1.15));
      ctx.arc(cx + 5, cy - 1, 9, -1.15, 1.15);
      ctx.lineTo(cx - 1, cy - 1);
      ctx.lineTo(cx + 5 + 9 * Math.cos(1.15), cy - 1 + 9 * Math.sin(1.15));
      return 1;
    }
    if (i === C.B_TIDE) {                          // 해일 — 가로로 흐르는 물결 셋
      for (let k = 0; k < 3; k++) {
        const yy = cy - 7 + k * 7;
        ctx.moveTo(cx - 12, yy);
        ctx.quadraticCurveTo(cx - 6, yy - 5, cx, yy);
        ctx.quadraticCurveTo(cx + 6, yy + 5, cx + 12, yy);
      }
      return 1;
    }
    return 0;
  }

  addBtnIconHole(i, cx, cy) {
    if (i === C.U_SWORD) this.addCircle(cx - 6, cy + 1, 2.1);
    else if (i === C.U_CATA) this.addCircle(cx - 9, cy + 8, 1.7);
  }

  drawBanner(feel) {
    if (feel.bannerFrames <= 0) return;
    const ctx = this.ctx;
    const t = 1 - feel.bannerFrames / feel.bannerTotal;
    const fade = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
    const y = C.GROUND_Y * 0.40 - easeOutCubic(t) * 24;
    const col = feel.bannerCode === C.BAN_WATER ? C.RAMP_DANGER : C.RAMP_BONUS;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 가로선 두 줄 — 글자가 배경에 묻히지 않게 받쳐 준다
    ctx.strokeStyle = col[C.rampIndex(fade * 0.55)];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(HALF_W - 190, y - 30); ctx.lineTo(HALF_W + 190, y - 30);
    ctx.moveTo(HALF_W - 190, y + 30); ctx.lineTo(HALF_W + 190, y + 30);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;
    ctx.font = FONT_BIG;
    ctx.fillStyle = col[C.rampIndex(fade)];
    ctx.fillText(BAN_TXT[feel.bannerCode], HALF_W, y);
    ctx.textBaseline = 'top';
  }

  drawToggle(on) {
    const ctx = this.ctx;
    const a = C.rampIndex(on ? 0.85 : 0.30);
    const x = C.VIEW_W - TOGGLE_SIZE - C.UNIT, y = C.UNIT;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.85)];
    ctx.beginPath(); ctx.roundRect(x, y, TOGGLE_SIZE, TOGGLE_SIZE, 5); ctx.fill();
    if (on) { ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.14)]; ctx.beginPath(); ctx.roundRect(x, y, TOGGLE_SIZE, TOGGLE_SIZE, 5); ctx.fill(); }
    ctx.strokeStyle = on ? C.RAMP_BONUS[a] : C.RAMP_PLAYER[a];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, TOGGLE_SIZE - 1, TOGGLE_SIZE - 1, 5); ctx.stroke();
    ctx.fillStyle = on ? C.RAMP_BONUS[a] : C.RAMP_PLAYER[a];
    ctx.font = FONT_TINY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(LABEL_AI, x + TOGGLE_SIZE * 0.5, y + TOGGLE_SIZE * 0.5);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
  }

  drawMute(muted) {
    const ctx = this.ctx;
    const a = C.rampIndex(muted ? 0.30 : 0.78);
    const x = C.UNIT, y = C.UNIT;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.85)];
    ctx.beginPath(); ctx.roundRect(x, y, TOGGLE_SIZE, TOGGLE_SIZE, 5); ctx.fill();
    ctx.strokeStyle = C.RAMP_PLAYER[a];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, TOGGLE_SIZE - 1, TOGGLE_SIZE - 1, 5); ctx.stroke();
    ctx.fillStyle = C.RAMP_PLAYER[a];
    ctx.beginPath();
    ctx.moveTo(x + 12, y + 16); ctx.lineTo(x + 17, y + 16); ctx.lineTo(x + 23, y + 10);
    ctx.lineTo(x + 23, y + 30); ctx.lineTo(x + 17, y + 24); ctx.lineTo(x + 12, y + 24);
    ctx.closePath();
    ctx.fill();
    if (muted) {
      ctx.beginPath();
      ctx.moveTo(x + 27, y + 15); ctx.lineTo(x + 34, y + 25);
      ctx.moveTo(x + 34, y + 15); ctx.lineTo(x + 27, y + 25);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x + 25, y + 20, 5, -0.9, 0.9);
      ctx.moveTo(x + 33, y + 15);
      ctx.arc(x + 25, y + 20, 9, -0.9, 0.9);
      ctx.stroke();
    }
  }

  // ── 특성 드래프트 ───────────────────────────────────────────
  // 판이 멈추는 유일한 순간이다. 카드 셋이 카드처럼 보여야 한다.
  drawDraft(game, feel, director) {
    const ctx = this.ctx;
    const t = Math.min(1, game.draftFrames / Math.round(C.DRAFT_UI_MS / C.SIM_DT));
    const e = easeOutBack(t);

    // 결정의 순간이다. 뒤가 비치면 방해된다.
    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
    // 아주 옅은 배경 격자 — 완전한 검정은 화면이 꺼진 것처럼 보인다
    ctx.strokeStyle = C.RAMP_GRID[C.rampIndex(0.5)];
    ctx.lineWidth = 1;
    ctx.stroke(this.bgPath);
    ctx.lineWidth = C.STROKE;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.COL_BONUS;
    ctx.font = FONT_MID;
    ctx.fillText(LABEL_DRAFT, HALF_W, C.UNIT * 7);
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.4)];
    ctx.beginPath();
    ctx.moveTo(HALF_W - 90, C.UNIT * 9.6); ctx.lineTo(HALF_W + 90, C.UNIT * 9.6);
    ctx.stroke();

    const cw = C.VIEW_W * 0.66;
    for (let i = 0; i < C.TRAIT_OFFER; i++) {
      const idx = game.draftIdx[i];
      if (idx < 0) continue;
      const tr = C.TRAITS[idx];
      const y = CARD_TOP + i * (CARD_H + CARD_GAP);
      const w = cw * e;
      const x = HALF_W - w * 0.5;

      ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.95)];
      ctx.beginPath();
      ctx.roundRect(x, y, w, CARD_H, 8);
      ctx.fill();
      ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.4)];
      ctx.lineWidth = C.STROKE;
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, w - 1, CARD_H - 1, 8);
      ctx.stroke();

      // 계열 색띠 — 왼쪽 세로 막대. 공격·방어·경제가 한눈에 갈린다
      ctx.fillStyle = C.COL_BONUS;
      ctx.beginPath();
      ctx.roundRect(x, y, 7, CARD_H, 4);
      ctx.fill();

      // 계열 아이콘 — 칼(공격) · 방패(방어) · 동전(경제)
      const ix = x + 44, iy = y + CARD_H * 0.5;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.9)];
      ctx.beginPath();
      if (tr.kind === 0) {
        this.addBar(ix - 8, iy + 9, 0.72, -0.69, 24, 0, 3.2, 1.4);
        this.addBar(ix - 6, iy + 6, 0.69, 0.72, 8, 8, 2, 2);
      } else if (tr.kind === 1) {
        ctx.moveTo(ix - 11, iy - 11); ctx.lineTo(ix + 11, iy - 11);
        ctx.lineTo(ix + 11, iy + 2); ctx.lineTo(ix, iy + 13); ctx.lineTo(ix - 11, iy + 2);
        ctx.closePath();
      } else {
        this.addCircle(ix, iy, 12);
      }
      ctx.fill();
      if (tr.kind !== 0) {
        ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.95)];
        ctx.beginPath();
        if (tr.kind === 1) { ctx.rect(ix - 5, iy - 6, 10, 3); ctx.rect(ix - 1.5, iy - 6, 3, 13); }
        else this.addCircle(ix, iy, 5);
        ctx.fill();
      }

      ctx.textAlign = 'left';
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.7)];
      ctx.fillText(KIND_NAME[tr.kind], x + 74, y + 22);
      ctx.font = FONT_MID;
      ctx.fillStyle = C.COL_PLAYER;
      ctx.fillText(tr.name, x + 74, y + 44);
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.62)];
      ctx.fillText(tr.desc, x + 74, y + 68);

      // 번호 배지 — 키보드로도 고를 수 있다
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.16)];
      ctx.beginPath();
      this.addCircle(x + w - 30, y + CARD_H * 0.5, 15);
      ctx.fill();
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.85)];
      ctx.font = FONT_MID;
      ctx.textAlign = 'center';
      ctx.fillText(C.KEY_HINT[i], x + w - 30, y + CARD_H * 0.5);
    }

    // **디렉터가 이 셋을 고른 이유** — 문장보다 강한 증거다
    if (director) {
      ctx.textAlign = 'center';
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.38)];
      ctx.fillText(LABEL_WHY, HALF_W, C.VIEW_H - C.UNIT * 8);
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.COL_BONUS;
      ctx.fillText(director.draftReason, HALF_W, C.VIEW_H - C.UNIT * 4.6);
    }
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
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
    const col = won ? C.RAMP_BONUS : (game.outcome === C.WIN_DROWN ? C.RAMP_DANGER : C.RAMP_PLAYER);
    ctx.strokeStyle = col[C.rampIndex(0.4 * e)];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(HALF_W - 200 * e, HALF_H - C.UNIT * 15); ctx.lineTo(HALF_W + 200 * e, HALF_H - C.UNIT * 15);
    ctx.moveTo(HALF_W - 200 * e, HALF_H - C.UNIT * 7.5); ctx.lineTo(HALF_W + 200 * e, HALF_H - C.UNIT * 7.5);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;
    ctx.font = FONT_BIG;
    ctx.fillStyle = col[C.rampIndex(1)];
    ctx.fillText(won ? LABEL_WIN : (game.outcome === C.WIN_DROWN ? LABEL_DROWN : LABEL_LOSE),
                 HALF_W, HALF_H - C.UNIT * 11.2);

    if (director && director.deathLine && !won) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
      ctx.fillText(director.deathLine, HALF_W, HALF_H - C.UNIT * 5);
    }

    // 통계 다섯 — 라벨은 오른쪽 정렬, 값은 왼쪽 정렬
    ctx.font = FONT_SMALL;
    const lx = HALF_W - C.UNIT * 2, vx = HALF_W + C.UNIT * 2;
    let y = HALF_H - C.UNIT * 0.5;
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
    ctx.textAlign = 'left';
  }

  // ── 디렉터 뷰 — 디버그 오버레이가 아니라 제품 기능이다 ───────
  // **AI가 무엇을 보고 무엇을 지시했는지가 화면에 전부 있어야 한다.**
  //   보는 것 : 지표 넷 + 플레이어 구성비 6칸 (director.playerMix)
  //   하는 것 : 다음 웨이브 구성비 6칸 (levers.mix) + 간격 + 수위 배수
  // 두 6칸을 나란히 놓으면 "기병을 많이 뽑았더니 창병이 늘었다"가 그림으로 보인다.
  drawDirectorView(game, d) {
    const ctx = this.ctx;
    const x = C.UNIT * 2, y = 96, w = 250;
    const lv = d.levers;
    const H = 268;

    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.97)];
    ctx.beginPath();
    ctx.roundRect(x, y, w, H, 6);
    ctx.fill();
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.5)];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, H - 1, 6);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // 제목줄
    ctx.fillStyle = C.COL_BONUS;
    ctx.font = FONT_TINY;
    ctx.fillText(DV_TITLE, x + 10, y + 9);
    ctx.textAlign = 'right';
    ctx.font = FONT_SMALL;
    ctx.fillStyle = C.COL_PLAYER;
    ctx.fillText(d.observing ? DV_OBSERVING : d.profileName, x + w - 10, y + 6);
    ctx.textAlign = 'left';
    ctx.font = FONT_MICRO;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(REASONS[d.observing ? 0 : d.reasonIdx], x + 10, y + 27);

    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.18)];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 8, y + 42); ctx.lineTo(x + w - 8, y + 42);
    ctx.stroke();

    // 지표 넷 — 막대 하나에 값과 임계선을 같이 얹는다
    const MET_X = x + 54, MET_W = w - 64;
    const met = DV_MET_NAME, thr = DV_MET_THR;
    const val = this.metVal;
    val[0] = d.metricAggro; val[1] = d.metricHoard; val[2] = d.metricEcon; val[3] = d.metricSwarm;
    for (let i = 0; i < 4; i++) {
      const my = y + 50 + i * 15;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
      ctx.font = FONT_MICRO;
      ctx.fillText(met[i], x + 10, my);
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.24)];
      ctx.fillRect(MET_X, my + 1, MET_W, 8);
      const v = val[i] < 0 ? 0 : (val[i] > 1 ? 1 : val[i]);
      ctx.fillStyle = v >= thr[i] ? C.COL_BONUS : C.RAMP_PLAYER[C.rampIndex(0.75)];
      ctx.fillRect(MET_X, my + 1, MET_W * v, 8);
      ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.9)];   // 임계선
      ctx.fillRect(MET_X + MET_W * thr[i], my - 1, 1.5, 12);
    }

    // 보는 것 → 하는 것. 두 6칸을 위아래로 붙여 인과가 보이게 한다
    const pm = d.playerMix;
    const mix = lv && lv.mix ? lv.mix : null;
    let mixSum = 0;
    if (mix) for (let k = 0; k < C.UNIT_KINDS && k < mix.length; k++) mixSum += mix[k] > 0 ? mix[k] : 0;

    this.drawMixRow(x, y + 118, w, DV_SEE, pm, 1, C.RAMP_PLAYER, d);
    this.drawMixRow(x, y + 176, w, DV_DO, mix, mixSum > 0 ? mixSum : 1, C.RAMP_BONUS, d);

    // 나머지 레버 두 개
    ctx.font = FONT_MICRO;
    const by = y + 238;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_TEMPO, x + 10, by);
    ctx.fillStyle = C.COL_BONUS;
    if (lv) this.drawLeft(lv.tempo, x + 52, by, 7);
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
    ctx.fillText(DV_WATER, x + 110, by);
    ctx.fillStyle = C.COL_BONUS;
    if (lv) this.drawFixed1(lv.waterMul, x + 178, by);
  }

  // 6칸 구성비 한 줄 — 유닛 아이콘 위에 세로 막대. 어느 유닛인지 글자 없이 읽힌다
  drawMixRow(x, y, w, label, arr, total, ramp) {
    const ctx = this.ctx;
    ctx.font = FONT_MICRO;
    ctx.textAlign = 'left';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.42)];
    ctx.fillText(label, x + 10, y);

    const CW = (w - 24) / C.UNIT_KINDS;
    const BH = 26;
    const top = y + 14;
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      const cx = x + 12 + CW * (k + 0.5);
      let v = arr && k < arr.length ? arr[k] : 0;
      if (!(v > 0)) v = 0;
      const frac = total > 0 ? v / total : 0;
      // 홈
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.18)];
      ctx.fillRect(cx - CW * 0.30, top, CW * 0.60, BH);
      ctx.fillStyle = ramp[C.rampIndex(frac > 0 ? 0.45 + frac * 0.55 : 0.2)];
      const bh = BH * (frac > 1 ? 1 : frac);
      ctx.fillRect(cx - CW * 0.30, top + BH - bh, CW * 0.60, bh);
      // 유닛 아이콘 — 작게. 글자를 안 쓴다
      this.drawMixIcon(k, cx, top + BH + 9, ramp[C.rampIndex(frac > 0.02 ? 0.95 : 0.35)]);
    }
    ctx.textAlign = 'left';
  }

  // 구성비 아래 미니 아이콘 — 12px 안에서 여섯이 갈려야 한다
  drawMixIcon(k, cx, cy, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    if (k === C.U_SWORD) {                       // 방패 + 짧은 칼
      this.addCircle(cx - 3, cy, 3.4);
      this.addBar(cx + 2, cy + 3, 0.6, -0.8, 8, 0, 1.1, 0.6);
      ctx.fill();
    } else if (k === C.U_SPEAR) {                // 긴 가로선
      this.addBar(cx - 7, cy, 1, 0, 14, 0, 1.1, 1.0);
      this.addSpike(cx + 7, cy, 1, 0, 4, 2);
      ctx.rect(cx - 8, cy - 5, 2.4, 10);
      ctx.fill();
    } else if (k === C.U_ARCHER) {               // 활 곡선
      ctx.arc(cx - 1, cy, 5.5, -1.2, 1.2);
      ctx.moveTo(cx - 1 + 5.5 * Math.cos(1.2), cy - 5.5 * Math.sin(1.2));
      ctx.lineTo(cx - 5, cy);
      ctx.lineTo(cx - 1 + 5.5 * Math.cos(1.2), cy + 5.5 * Math.sin(1.2));
      ctx.stroke();
    } else if (k === C.U_CAV) {                  // 네 다리
      ctx.rect(cx - 6, cy - 3, 12, 4);
      for (let i = 0; i < 4; i++) ctx.rect(cx - 5 + i * 3.2, cy + 1, 1.4, 4);
      ctx.rect(cx + 4, cy - 7, 2.6, 5);
      ctx.fill();
    } else if (k === C.U_GIANT) {                // 넓은 사다리꼴
      this.addTrap(cx, cy - 5, cy + 5, 12, 8, 0);
      ctx.fill();
    } else {                                     // 바퀴 둘 + 팔
      this.addCircle(cx - 4, cy + 3, 3);
      this.addCircle(cx + 4, cy + 3, 2);
      this.addBar(cx - 3, cy + 2, 0.62, -0.78, 9, 0, 1.1, 0.8);
      ctx.fill();
    }
    ctx.lineWidth = C.STROKE;
  }
}
