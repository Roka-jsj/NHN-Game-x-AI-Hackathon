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
// 색은 이제 여섯이 아니다. config 가 넷을 더 줬고 각각 **계약이 있다**:
//   U_COL[6]     병종. 아군·적군이 같은 색을 쓰고 진영은 명도가 가른다
//   COL_THREAT   적의 예고와 적 스킬 **전용**. 이 색이 뜨면 뜻은 하나다 — 곧 맞는다
//   ERA_TINT[5]  시대. 배경·지형·기지에만 얇게. 유닛 색을 덮지 않는다
//   SKILL_COL[4] 내 스킬. 적 스킬은 COL_THREAT 이다
// 새 색을 더 만들지 않는다. 대비가 더 필요하면 알파 램프로 번다.
//
// **루프 안에서 rgba 문자열을 만들지 않는다.** 미리 구운 램프(RAMP_*)를 쓰거나,
// 불투명해야 하는 자리(겹치는 몸)는 아래 mixOver 로 모듈에 한 번만 굽는다.

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
// 폰 세로 전용 — 화면 전체가 0.4배가 되므로 UI 글자만 키운다. 문자열은 모듈에 굽는다
const FONT_BTN_P = '19px ' + C.FONT_STACK;
const FONT_SMALL_P = '22px ' + C.FONT_STACK;
const FONT_MICRO_P = '15px ' + C.FONT_STACK;

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const DOT = '.';

// 0 검사 1 창병 2 궁수 3 기병 4 거인 5 투석기 6 진화 7 포탑 8 해일 9 화살비
const BTN_NAME = ['검사', '창병', '궁수', '기병', '거인', '투석기', '진화', '포탑', '해일', '화살비'];

// 버튼에 실제로 찍히는 글자. **스킬은 시대마다 이름이 바뀐다** —
// 해일→격류→범람, 화살비→쇠뇌비→융단폭격. 여기서 BTN_NAME 을 그대로 쓰면
// 시대를 올려도 버튼에는 계속 "해일"이라고 적혀 있어서,
// **이 게임에서 가장 큰 변화가 화면에 안 보인다.**
// 그리고 마지막 시대에서는 다 쓴 진화 칸이 총진군(4번째 스킬)이 된다.
// game 이 아직 skillName 을 안 주면 조용히 예전 이름으로 떨어진다.
// **유닛 버튼(0..UNIT_KINDS-1)도 같은 규칙이다** — spec-v4 §1 이 30개 이름을
// ERA_UNIT_NAME[era][kind] 로 확정했다. 이 버튼은 항상 **내(SIDE_L) 시대**를
// 읽는다 — 적 진영용 버튼 줄은 없다(있다면 game.aiEra 를 읽어야 한다).
function btnLabel(game, i) {
  if (!game || typeof game.skillName !== 'function') return BTN_NAME[i];
  if (i < C.UNIT_KINDS) {
    const row = C.ERA_UNIT_NAME && C.ERA_UNIT_NAME[game.era];
    return (row && row[i]) || BTN_NAME[i];
  }
  if (i === C.B_TIDE) return game.skillName(C.SK_TIDE) || BTN_NAME[i];
  if (i === C.B_VOLLEY) return game.skillName(C.SK_VOLLEY) || BTN_NAME[i];
  if (i === C.B_ERA && !game.eraReady() && game.era >= C.ERA_COUNT - 1) {
    return game.skillName(C.SK_SURGE) || BTN_NAME[i];
  }
  // 포탑도 다 쓰면 다른 것이 된다 — 최강병기(거신)가 다 쓴 포탑 칸을 물려받는다.
  // towerLv 가 TOWER_MAX 에 닿은 순간부터 이 칸의 이름이 바뀐다(조건이 이미
  // 버튼을 재활용하는 이유다) — 원정에서 이미 썼어도(wpnUsed) 이름은 그대로
  // 남는다. "이게 무엇이었는지"는 계속 보여야 한다.
  if (i === C.B_TOWER && game.towerLv >= C.TOWER_MAX) {
    return C.WEAPON_NAME || BTN_NAME[i];
  }
  return BTN_NAME[i];
}
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
// game 이 skillName 을 아직 안 주는 빌드에서의 대비책. 화면이 비지는 않는다
const RALLY_NAME = (C.SKILL_NAME && C.SKILL_NAME[C.SK_RALLY]) || '증원';
const PROFILE_UNKNOWN = '—';
const KIND_NAME = ['공격', '방어', '경제'];
const READY = '준비';

// **config 의 BAN_* 코드와 길이가 반드시 같아야 한다.** 코드가 더 많으면
// 화면에 `undefined` 가 찍힌다. 그려질 때 범위를 한 번 더 막는다.
const BAN_TXT = ['시대가 바뀌었다', '해일', '물이 차오른다', '전투를 이겼다', '원정이 끝났다'];

// ── 원정·사령관 (spec-v3 §3) ──
// game.js 가 아직 이 필드를 안 줬으면 **아무것도 그리지 않는다.** 예외를 던지지 않는다.
const LBL_READ = 'AI 가 나를 읽었다';
const LBL_STAGE = '전투';
const LBL_NEXT_FOE = '다음 상대';
const LBL_CLEAR = '전투 승리';
const LBL_CAMP_WIN = '원정 완주';
const LBL_CAMP_END = '원정 종료';
const LBL_NEXT_KEY = '아무 키나 눌러 다음 전투';
const LBL_NEW_KEY = '아무 키나 눌러 새 원정';
const LBL_BEATEN = '격파한 사령관';
const LBL_FOE_ERA = '적 시대';
const LBL_FOE_UP = '적이 진화했다';
const LBL_CAMP_TIME = '원정 누적';
const LBL_MYMIX = '내가 뽑은 구성';
const LBL_SLASH = '/';
const BR_TITLE = '차오른다';
const BR_SUB = '금으로 병력을 사서 적 기지를 부순다. 버티면 물이 먼저 삼킨다.';
const BR_1 = '적 기지를 부순다';
const BR_2 = '금이 차면 병력을 산다';
const BR_3 = '물이 차오른다';
const BR_RING = '상성이 돈다 — 하나로 전부를 이길 수 없다';
const BR_ARROW = '화살표 쪽이 이긴다';
// **거인과 투석기는 나가는 화살표가 없다.** 표(C.COUNTER)에 우위가 여섯뿐이고
// 그 둘은 이기는 상대가 없다 — 버그가 아니라 설계다. 화면이 그 말을 해야
// "이 둘은 상성이 안 뜬다"가 고장으로 안 읽힌다.
const BR_NOEDGE = '이 둘은 이기는 상대가 없다 — 벽과 공성이 값어치다';
// ── 범례 — 플레이어가 끝까지 몰랐던 것들 ──
const BR_L1 = '진화 — 아래 글자는 다음 시대. 경험치가 차야 켜진다';
const BR_L2 = '포탑 120금 — 기지 위 대포. 두 단계까지 올린다';
const BR_L3 = ' — 우하단 원. 병력을 공짜로 세운다';
const BR_L4 = '회색 칸 — 붉은 값은 금 부족, 아래 막대는 소환 대기';
const BR_L5 = '위 가운데 막대가 전선. 삼각형이 오른쪽일수록 이긴다';
const BR_L6 = '잠기면 어두워진다 — 아군은 채운 몸, 적군은 밝은 테';
// 설명 화면의 확인 버튼. **이 화면은 저절로 닫히지 않는다** — 이 버튼을 눌러야
// 시작한다. 예전에는 이 자리에 작은 글씨가 깜빡였고 9초 뒤 화면이 혼자 사라졌다.
const BR_START = '전투 시작';
const BR_HINT = '화면 아무 곳을 누르거나 아무 키나 눌러도 시작합니다';
const BR_BTN_W = 260;
const BR_BTN_H = 52;
const CMD_NAME = C.COMMANDER_NAME || null;
const CMD_TITLE = C.COMMANDER_TITLE || null;
const CMD_LINE = C.COMMANDER_LINE || null;
const CMD_TAUNT = C.COMMANDER_TAUNT || null;
const CAMP_LEN = C.CAMPAIGN_LEN || 5;
// game.js 가 S.BRIEF 를 아직 안 줬으면 -1 — 어떤 state 와도 안 같으므로 조용히 꺼진다
const BRIEF = (typeof S.BRIEF === 'number') ? S.BRIEF : -1;

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
// 판별값 — 「몰아 뽑았다」와 「맞게 몰아 뽑았다」를 가르는 값.
// 위 넷과 성질이 다르다. 넷은 **너는 이런 사람이다**이고 이건 **지금 맞게
// 뽑고 있는가**다. 그리고 이 값만이 처벌을 **깎는다**. 그래서 같은 막대 넷에
// 다섯 번째로 끼워 넣지 않고 줄을 따로 준다.
const DV_EDGE = '상성 우위';
// 걸린 처벌의 상태를 한 낱말로. 매 프레임 문자열을 만들면 그게 GC 스파이크다.
const DV_EDGE_VERDICT = ['처벌', '부분 면제', '면제'];

const TOGGLE_SIZE = 40;

// 매 프레임 배열 리터럴을 만들면 그게 곧 GC 스파이크다. 상수는 모듈에 굽는다.
const DV_MET_NAME = [DV_AGGRO, DV_HOARD, DV_ECON, DV_SWARM];
const DV_MET_THR = Float32Array.from([C.TH_AGGRO_HIGH, C.TH_HOARD_HIGH, C.TH_ECON_HIGH, C.TH_SWARM_HIGH]);

// 상성 탐지용 공간 버킷. 32px 씩 끊어 진영별로 "이 칸에 어떤 종류가 있나"를
// 비트마스크로 들고 있는다. 공격 모션 중인 유닛만 앞쪽 칸을 훑으면
// **상성 우위로 때리는 중인지**를 O(1) 에 가깝게 알 수 있다.
const BUCKET_W = 32;
const BUCKET_N = (C.VIEW_W / BUCKET_W | 0) + 2;

// ── 스킬 연출 길이 (렌더 프레임) ──
// 예전에는 40·48·36 이었다. 도형이 한 번 지나가고 끝나서 **큰 기술이 터진 것이
// 화면에 안 남았다.** 실측: 화살비·증원·진화가 전장 픽셀의 1.2% 미만만 칠했다
// (해일만 17%). 그래서 셋 다 3단 구조로 다시 짰다 —
//   예고(telegraph) → 발동(strike) → 여파(aftermath).
// 아래 T_* 는 그 세 막의 경계다. t(0~1) 기준이라 길이를 바꿔도 비율이 안 깨진다.
const FX_TIDE_F = 64, FX_VOLLEY_F = 66, FX_RALLY_F = 54;
const FX_TOWER_F = 10;
const FX_ERA_F = 88;
// 화면 전환 스윕 — 내 진화 순간에만 켜진다. 사용자: "진화하면 배경도
// 바뀌었으면 좋겠다" — 배경은 이미(paintBackground) 그 프레임에 바로 다시
// 굽히지만, 그 전환 자체가 눈에 안 띄었다. 그 순간에 새 시대색이 화면을
// 훑고 지나가 "지금 세계가 바뀌었다"를 한 번 크게 말해 준다.
const FX_ERA_SWEEP_F = 42;
const SWEEP_BANDS = 7;
const VOLLEY_N = 26;

// 막 경계 — 예고가 끝나는 시점 / 발동이 끝나는 시점
const T_TIDE_TELE = 0.20, T_TIDE_HIT = 0.76;
const T_VOL_TELE = 0.24, T_VOL_HIT = 0.78;
const T_RAL_TELE = 0.20, T_RAL_HIT = 0.72;

// 스킬이 지나간 자리 — **판이 바뀌었다는 증거는 연출이 끝난 뒤에도 남는다.**
// 해일이 훑은 젖은 땅, 화살비가 파낸 구덩이, 증원이 세운 집결 표식.
// 연출 자체와 수명이 다르므로 따로 센다 (약 2.7초).
const SCAR_F = 160;
const CRATER_N = 14;

// 전경 바위 — 화면 아래 두 모서리. 원경(능선)·중경(기지·유닛)과 갈라 놓는 층이다
const FG_N = 7;

// ── 순수 드로잉 좌표 (spec-v2 §0 이 render.js 지역 상수로 허용한 것) ──
// 버튼 열 좌표는 **config 가 단일 출처다.** 한때 여기 지역 상수로 복사해
// 뒀었는데, 그러면 config 를 고친 사람이 화면이 안 움직이는 이유를 못 찾는다.
// (config 가 10칸에 맞지 않아 BTN_X0 = -13 을 내놓던 문제는 config 에서 고쳤다.)
const BTN_W = C.BTN_W, BTN_GAP = C.BTN_GAP, BTN_X0 = C.BTN_X0;
const BTN_R = 5;                       // 버튼 모서리

// **버튼 열의 세로 배치만** 화면 비율에 따라 바뀐다. 가로 좌표는 config 가 단일 출처다.
// 폰 세로에서는 전체가 0.4배로 줄어 66px 칸이 27 CSS px 이 된다 — 눌리지 않는다.
// 그래서 세로에서는 칸을 높이고 글자를 키운다. 히트테스트가 같은 값을 읽어야 하므로
// **이 객체가 그리기와 히트테스트의 단일 출처다.** (가로 배치는 config 그대로다)
const LAY = {
  portrait: 0,
  y: C.BTN_Y, h: C.BTN_H,
  iconDX: 60, iconDY: 40, iconR: 19,
  nameDY: 6, costDY: C.BTN_H - 22, coinDY: C.BTN_H - 14,
};
function applyLayout(portrait) {
  LAY.portrait = portrait ? 1 : 0;
  LAY.h = portrait ? 92 : C.BTN_H;
  LAY.y = portrait ? C.VIEW_H - 92 - C.UNIT : C.BTN_Y;
  LAY.iconDX = portrait ? 58 : 60;
  LAY.iconDY = portrait ? 48 : 40;
  LAY.iconR = portrait ? 21 : 19;
  LAY.nameDY = portrait ? 5 : 6;
  LAY.costDY = LAY.h - (portrait ? 30 : 22);
  LAY.coinDY = LAY.h - (portrait ? 19 : 14);
}
const btnX = (i) => BTN_X0 + i * (BTN_W + BTN_GAP);

// 버튼 한 칸의 색 — **화면의 유닛과 같은 색이어야 한다.**
// 그래야 "이 버튼이 저 유닛"이 글자 없이 연결된다. 스킬 칸도 같은 규칙으로
// 자기 연출 색을 쓴다 (해일 = 물빛, 화살비 = 호박). 진화·포탑은 금색 그대로다.
const BTN_RAMP = (() => {
  const a = new Array(C.BTN_COUNT);
  for (let i = 0; i < C.BTN_COUNT; i++) a[i] = C.RAMP_BONUS;
  for (let k = 0; k < C.UNIT_KINDS && k < C.BTN_COUNT; k++) a[k] = C.RAMP_UNIT[k];
  if (C.RAMP_SKILL) {
    a[C.B_TIDE] = C.RAMP_SKILL[C.SK_TIDE] || C.RAMP_BONUS;
    a[C.B_VOLLEY] = C.RAMP_SKILL[C.SK_VOLLEY] || C.RAMP_BONUS;
  }
  return a;
})();

// 버튼 열 전체가 차지하는 상자 — 통째로 구워 두고 붙이기 위한 것
const STRIP_X = BTN_X0 - 3;
const STRIP_W = C.BTN_COUNT * (BTN_W + BTN_GAP) - BTN_GAP + 6;
const STRIP_MAXH = 92 + 6;

// ── 사령관 카드 — 오른쪽 위. AI 토글(904~) 앞에서 끝난다 ──
const CMD_X = 706, CMD_Y = 8, CMD_W = 190, CMD_H = 116;
const FX_FOE_ERA_F = 130;              // 적이 진화한 순간을 알리는 시간
const CMD_PR = 17;                     // 초상 반지름
const FX_LINE_F = 250;                 // 전투 시작 대사가 떠 있는 렌더 프레임
const FX_TAUNT_F = 200;                // 도발
const BUB_W_MAX = 400;

// 설명 화면의 상성도. 굽는 쪽(paintBrief)과 매 프레임 화살표를 그리는 쪽(drawBrief)이
// 같은 좌표를 봐야 하므로 모듈에 둔다.
//
// **좌표를 유닛 종류로 색인한다.** 그래야 C.COUNTER 표를 그대로 그릴 수 있고,
// 나중에 밸런스가 바뀌어 우위 한 쌍이 늘거나 줄어도 그림이 저절로 따라온다.
// 네 칸(검사→창병→기병→궁수)은 마름모로 돌리고, 그 고리 밖에 있는 둘은
// **자기를 이기는 유닛 옆에** 매단다.
//   예전 배치의 실패 둘 — (1) 투석기가 (414,350) 에 있어서 그 이름표가
//   「전투 시작」 버튼(350..610 × 380..432) 위에 겹쳤다. (2) 거인이 궁수 바로
//   옆(158,350)이라 궁수→거인 화살표의 몸통이 24px 짜리 토막이 되어,
//   플레이어 눈에는 "거인은 화살표가 하나도 없다" 로 보였다.
// 고리를 26px 올렸다 — 화면 아래에 **범례 세 줄**이 들어갈 자리를 냈다.
// 플레이어가 끝까지 몰랐던 것들(진화 버튼의 회색, 포탑 120, 우하단 원의 이름,
// 회색 버튼의 두 가지 이유, 상단 분절 막대, 물에 잠긴 진영)이 전부 거기 산다.
const RING_CX = 286, RING_CY = 246, RING_R = 74;
const RING_NX = new Float32Array(C.UNIT_KINDS);
const RING_NY = new Float32Array(C.UNIT_KINDS);
const RING_LDY = new Float32Array(C.UNIT_KINDS);   // 이름을 배지 위/아래 어디에 두는가
(() => {
  const put = (k, x, y, ldy) => { RING_NX[k] = x; RING_NY[k] = y; RING_LDY[k] = ldy; };
  put(C.U_SWORD,  RING_CX,          RING_CY - RING_R, -44);   // 위 칸만 이름을 위에
  put(C.U_SPEAR,  RING_CX + RING_R, RING_CY,           44);
  put(C.U_CAV,    RING_CX,          RING_CY + RING_R,  44);
  put(C.U_ARCHER, RING_CX - RING_R, RING_CY,           44);
  put(C.U_GIANT,  92,  188, 44);                              // 궁수가 이긴다
  put(C.U_CATA,   112, 320, -42);                             // 기병이 이긴다 (이름은 위로)
})();

// 그릴 화살표 목록 — **C.COUNTER 를 읽어서 만든다.** 손으로 쓴 목록은 표와
// 반드시 어긋난다 (실제로 어긋나 있었다: 표에 우위가 여섯인데 화면에는 다섯,
// 그중 하나는 안 보이는 토막이었다).
const CTR_A = new Uint8Array(C.UNIT_KINDS * C.UNIT_KINDS);
const CTR_D = new Uint8Array(C.UNIT_KINDS * C.UNIT_KINDS);
const CTR_N = (() => {
  const seq = [C.U_SWORD, C.U_SPEAR, C.U_CAV, C.U_ARCHER];   // 고리를 읽는 순서
  const beats = (a, d) => a !== d && C.COUNTER && C.COUNTER[a * C.UNIT_KINDS + d] > 1;
  let n = 0;
  const push = (a, d) => { CTR_A[n] = a; CTR_D[n] = d; n++; };
  // 1) 고리부터 — 순서대로 이어지는 우위. 이게 "상성이 돈다"를 말한다
  for (let i = 0; i < seq.length; i++) {
    const a = seq[i], d = seq[(i + 1) % seq.length];
    if (beats(a, d)) push(a, d);
  }
  // 2) 표에 있는데 아직 안 그린 우위 전부
  for (let a = 0; a < C.UNIT_KINDS; a++) {
    for (let d = 0; d < C.UNIT_KINDS; d++) {
      if (!beats(a, d)) continue;
      let dup = 0;
      for (let k = 0; k < n; k++) if (CTR_A[k] === a && CTR_D[k] === d) { dup = 1; break; }
      if (!dup) push(a, d);
    }
  }
  return n;
})();
// 화살표 하나가 나타나는 간격 (렌더 프레임).
// 40 이었다 — 여섯 개가 다 나오는 데 **4초**가 걸렸고, 그래서 이 화면을 3초쯤
// 본 사람은 "화살표가 네 개뿐"이라고 읽었다 (아트 디렉터의 보고가 정확히 그것이다).
// 표에는 우위가 여섯이고 그중 둘(궁수→거인 · 기병→투석기)이 마지막에 나온다.
// 22 면 2.2초에 여섯이 다 선다.
const BRIEF_STEP = 22;

// ── 결과 카드 (렌더 프레임) ──
// 판이 끝난 **직후 잠깐은 전장을 그대로 보여 준다.** 기지가 터지는 순간과
// 배너가 여기 산다. 그 다음에 결과 카드가 **불투명하게** 올라온다 —
// 예전에는 첫 프레임부터 알파 0.55 짜리 막을 깔아서, 살아 있는 전장과
// 배너 글자가 통계 위로 비쳐 "처치 / 프로파일" 이 안 읽혔다.
const RESULT_HOLD_F = 16;              // 카드가 올라오기 전에 전장을 보여 주는 시간
const RESULT_REVEAL_F = 22;            // 카드 안쪽(선·숫자)이 차오르는 시간

// 결과 화면의 구성 패널 — 카드는 가운데 좁게 서 있고 **왼쪽이 통째로 비어 있다.**
// 통계 아래에 붙였더니 「아무 키나」 줄과 겹쳤다 (통계 줄 수가 원정/단판에서 다르다).
const RMIX_X = 40, RMIX_W = 240, RMIX_Y = 262;

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

// ── 시대 배율 — **그리기 전용이다. 판정에 절대 쓰지 않는다** ──
// 사용자가 "진화해도 이미지가 안 바뀐다"고 했다. 실제로는 바뀌고 있었지만
// 바뀌는 것이 **장식**(볏·안테나·점)이라 게임 크기에서 사라졌다.
// 그래서 덩어리 자체를 바꾼다: 키·어깨·머리·다리·무기 길이.
// 체력이 6.4배, 피해가 6.8배가 되는 진화라면 화면에서도 커져야 한다.
const ERA_GROW = Float32Array.from([1, 1.11, 1.24, 1.38, 1.54]);
const ERA_SHOULDER = Float32Array.from([0.92, 1.0, 1.16, 1.06, 1.30]);
const ERA_HEAD = Float32Array.from([1.08, 1.0, 1.0, 0.92, 1.18]);
const ERA_LEG = Float32Array.from([0.80, 1.0, 1.14, 1.06, 1.38]);
const ERA_WEAP = Float32Array.from([0.84, 1.0, 1.10, 1.18, 1.34]);
const eraIdx = (e) => (e > 0 ? (e < 4 ? e : 4) : 0);

// 겹친 아군을 세려면 **불투명한** 중간톤이 있어야 한다.
// 알파 램프로는 안 된다: 어두운 톤이 밝은 몸 **위에** 얹히면 다시 밝아져서,
// 정작 뭉치는 자리에서만 효과가 사라진다. (실측으로 확인했다 — 램프를
// 0.78 → 0.62 로 내려도 전선의 흰 반죽은 조금도 안 갈렸다. 배경 위에서만
// 어두워졌을 뿐이다.) 그래서 배경과 미리 섞어 색 하나를 굽는다.
// 전장은 6색 제약에서 풀렸다 — HUD 는 계속 램프만 쓴다.
function mixOver(hex, bg, a) {
  const h = (t, i) => parseInt(t.slice(i, i + 2), 16);
  const r = Math.round(h(hex, 1) * a + h(bg, 1) * (1 - a));
  const g = Math.round(h(hex, 3) * a + h(bg, 3) * (1 - a));
  const b = Math.round(h(hex, 5) * a + h(bg, 5) * (1 - a));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// ── 병종 색 — 규칙 1 을 화면에 옮긴 표 ────────────────────────
// 플레이어: "x=200~580 구간이 실루엣 하나로 뭉쳐 몇 기인지도, 검사인지 창병인지
// 궁수인지도 셀 수 없다." **상성 삼각형이 핵심인 게임에서 내가 뭘 뽑았는지
// 화면으로 확인이 안 된다.** 실루엣은 하나를 떼어 놓고 볼 때만 읽힌다.
//
// 색으로 풀되 **진영을 색에 쓰지 않는다.** 양쪽이 같은 색을 쓰고,
//   아군 = 밝은 채움 + 어두운 테        (색이 그대로 산다)
//   적군 = 가라앉은 채움 + 밝은 심 테   (같은 색이 어둡게 깔리고 테가 종류를 말한다)
// 진영은 명도와 잉크 방향이 가른다. 그건 실측으로 검증된 설계이고 안 건드린다.
//
// **알파 램프로는 안 된다.** 어두운 톤이 밝은 몸 위에 얹히면 다시 밝아져서
// 정작 뭉치는 자리에서만 효과가 사라진다 (위 mixOver 주석의 그 실측). 그래서
// 배경과 미리 섞어 **불투명한 색**을 굽는다. 인덱스는 (side*UNIT_KINDS + kind)*2 + tone.
const UK = C.UNIT_KINDS;
const U_BODY = new Array(2 * UK * 2);
// 적군의 밝은 심 테 — 어두운 몸이 배경에 묻히지 않게 하고, **거기서 병종이 읽힌다**
const U_RIM = new Array(UK);
// 물속에서 되살릴 때 쓰는 중간 톤 (수면 아래는 어두운 막이 한 겹 더 얹힌다)
const U_SUNK = new Array(UK);
(() => {
  for (let k = 0; k < UK; k++) {
    const hex = C.U_COL[k];
    U_BODY[(SIDE_L * UK + k) * 2] = hex;                          // 아군 밝은 톤
    U_BODY[(SIDE_L * UK + k) * 2 + 1] = mixOver(hex, C.COL_BG, 0.60);
    U_BODY[(SIDE_R * UK + k) * 2] = mixOver(hex, C.COL_BG, 0.40);  // 적군 — 가라앉는다
    U_BODY[(SIDE_R * UK + k) * 2 + 1] = mixOver(hex, C.COL_BG, 0.27);
    U_RIM[k] = mixOver(hex, C.COL_BG, 0.82);
    U_SUNK[k] = mixOver(hex, C.COL_BG, 0.72);
  }
})();
const uBody = (side, kind, tone) => U_BODY[(side * UK + kind) * 2 + tone];

// ── 스킬 색 — 내 것만. 적 스킬은 COL_THREAT 이다 (규칙 2) ─────
// [side][skill] 두 축을 하나로 굽는다. 루프에서 삼항을 두 번 타지 않는다.
const SK_RAMP = new Array(2 * C.SKILL_COUNT);
for (let i = 0; i < C.SKILL_COUNT; i++) {
  SK_RAMP[SIDE_L * C.SKILL_COUNT + i] = C.RAMP_SKILL[i] || C.RAMP_BONUS;
  SK_RAMP[SIDE_R * C.SKILL_COUNT + i] = C.RAMP_THREAT;
}
// 스킬 이름 — 시대마다 바뀐다. 적 쪽은 적 시대로 읽어야 한다
function skName(game, i, mine) {
  const row = C.SKILL_TIER_NAME && C.SKILL_TIER_NAME[i];
  if (!row) return C.SKILL_NAME[i] || '';
  const t = mine
    ? (game.skillTier ? game.skillTier(i) : 0)
    : (game.aiSkillTier ? game.aiSkillTier(i) : 0);
  const ti = t < row.length ? (t < 0 ? 0 : t) : row.length - 1;
  return row[ti] || C.SKILL_NAME[i];
}

// ── 시대 색조 — 화면의 공기 ───────────────────────────────────
// 실루엣은 이미 시대마다 커진다(검사 684 → 2156 픽셀). 그건 확대해야 보이는 차이다.
// **시대는 화면의 공기가 바뀌어야 한다** — 하늘·지층·기지에 얇게 깐다.
// 유닛 색을 절대 덮지 않는다: 여기 쓰이는 것은 전부 유닛보다 뒤에 그려진다.
const ERA_RAMP = (e) => C.RAMP_ERA[e < 0 ? 0 : (e >= C.ERA_COUNT ? C.ERA_COUNT - 1 : e)];
// ERA_TINT 는 **깔개**라 일부러 어둡다 (돌 시대 #2A3F4A 는 배경과 거의 붙어 있다).
// 그래서 앞에 세워야 하는 것 — 재무장 표식·시대 강조선 — 에는 그대로 못 쓴다.
// 색상은 그대로 두고 **밝기만** 올린 짝을 굽는다. 새 색을 만드는 것이 아니다.
const ERA_LIT = C.ERA_TINT.map((h) => {
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const k = m > 0 ? 226 / m : 1;
  const cl = (v) => { const x = Math.round(v * k); return (x > 255 ? 255 : x).toString(16).padStart(2, '0'); };
  return '#' + cl(r) + cl(g) + cl(b);
});
const ERA_LIT_RAMP = ERA_LIT.map((h) => {
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  const out = new Array(C.RAMP_STEPS + 1);
  for (let i = 0; i <= C.RAMP_STEPS; i++) out[i] = `rgba(${r},${g},${b},${(i / C.RAMP_STEPS).toFixed(3)})`;
  return out;
});
const eraLit = (e) => ERA_LIT_RAMP[e < 0 ? 0 : (e >= C.ERA_COUNT ? C.ERA_COUNT - 1 : e)];

// 적 예고 (EV.AI_CAST) — 이 화면이 통째로 비어 있었다.
// 플레이어가 원정 6판을 전부 진 이유가 "적 스킬이 안 보여서"였다.
const LBL_CAST = '적';
const LBL_INBOUND = '온다';
const LBL_REARM = '재무장';
const CAST_Y = 92;                     // 예고 띠 — HUD 아래, 하늘 안
const CAST_W = 250, CAST_H = 34;
const CAST_H_FIRST = 54;               // "첫 조우" — 이름만이 아니라 효과 한 줄도 보여준다

// ── 보스 — 심연. render 는 game.boss* 필드를 읽기만 한다(다른 예고·HUD와 같은
// 규칙 — 이벤트를 안 듣는다). 일반 AI_CAST 띠(CAST_Y=92, 폭 250)와 자리·크기를
// 달리해서 헷갈리지 않게 한다: 보스 예고는 훨씬 크고 화면 전체가 물든다.
// y=198 — 사령관 말풍선(CMD_Y+CMD_H=124 에서 자라 최대 y=190까지 내려온다,
// drawCommander/drawBubble 참조)과 겹치면 도발 대사가 예고 글자를 덮는다.
// 그 아래로 내려서 둘이 같은 순간에 떠도 서로 안 가린다.
const BOSS_WARN_Y = 198, BOSS_WARN_W = 480, BOSS_WARN_H = 92;
// y=66 — 전선 막대(HUD_BAR_Y=30, 높이 17 → 47까지)와 적 예고 띠(CAST_Y=92) 사이의
// 좁은 틈이다. 처음에 56으로 뒀더니 이름표가 전선 막대 한가운데 겹쳐 "아군 …
// 심 연 … 적군" 처럼 글자가 섞였다(스크린샷으로 잡았다) — 그래서 아래로 뺐다.
const BOSS_BAR_Y = 66, BOSS_BAR_W = 300, BOSS_BAR_H = 10;

// ── 최강병기 — 거신. 보스의 거울이다. 다만 이건 **위협이 아니라 내 자산**이라
// 화면 전체를 위협색으로 물들이지 않는다(규칙 2: COL_THREAT 는 적 전용) —
// 왼쪽 위 고정 카드 하나로 충분하다. 금 표시(x=60)·특성 알약(y=68) 아래,
// 적 예고 띠(CAST_Y=92, 폭 250, 가운데 정렬)와 x 로 안 겹치게 왼쪽에 둔다.
// WPN_BAR_W 는 210 → 280. WEAPON_HINT 실측 폭이 FONT_MICRO 에서 약 252px 라
// 210 폭 카드 밖으로 텍스트가 흘러넘쳤다(스크린샷으로 확인) — 카드가 자기
// 안의 문장을 못 담으면 카드가 아니다. 오른쪽으로 56→336 까지, 다음 HUD
// 요소(별자리 칩 x=375~, 예고 띠 x=355~)와는 여전히 안 겹친다.
const WPN_BAR_X = 56, WPN_BAR_Y = 90, WPN_BAR_W = 280, WPN_BAR_H = 54;
const LABEL_WPN_USED = C.WEAPON_USED_LABEL || '소진';
const LABEL_WPN_DEAD = C.WEAPON_DEAD_LABEL || '파괴됨';

// ── 별자리 — x=300~700, y=8~48 이 상시 비어 있는 유일한 HUD 여백이다
// (트레잇 알약은 x=300 에서 자르고(4090행), 사령관 카드는 x=706 부터 시작한다).
// 매 전투 다시 뽑히는 규칙이라 상시 칩 하나 + 전투 시작 직후 잠깐의 리빌로 다룬다.
const ZOD_CHIP_X = HALF_W, ZOD_CHIP_Y = 8, ZOD_CHIP_W = 210, ZOD_CHIP_H = 26;
const ZOD_REVEAL_F = 170;      // ~2.8초. 일반 스킬 예고보다 길고 보스 예고보다 짧다

// ── 툴팁 — 포탑 버튼은 SKILL_DESC 같은 데이터 배열이 없다(진화/포탑은
// "사는 것"이지 "쓰는 스킬"이 아니라서 애초에 그 배열에 안 들어 있었다).
// 여기 문장 하나만 새로 쓴다 — 나머지(유닛·스킬·특성·별자리)는 전부 이미
// 있는 config 문자열을 그대로 읽는다.
const TT_TOWER_DESC = '사거리 안 적을 자동 공격한다 — 최대 단계에서 최강병기 소환 칸이 된다';

// 유닛 하나가 무엇에 강하고 무엇에 약한지 한 줄로 — C.COUNTER(공격자×방어자
// 행렬)를 그대로 읽는다. 새 데이터를 안 만든다. era 행이 없으면(방어 시대
// 데이터 없음) 조용히 빈 문자열을 반환한다 — 툴팁 한 줄이 없어질 뿐 죽지 않는다.
function unitCounterHint(kind, eraNames) {
  if (!eraNames) return '';
  let beats = -1, beatenBy = -1;
  for (let d = 0; d < C.UNIT_KINDS; d++) if (C.COUNTER[kind * C.UNIT_KINDS + d] > 1) { beats = d; break; }
  for (let a = 0; a < C.UNIT_KINDS; a++) if (C.COUNTER[a * C.UNIT_KINDS + kind] > 1) { beatenBy = a; break; }
  const parts = [];
  if (beats >= 0) parts.push(eraNames[beats] + '에게 강하다');
  if (beatenBy >= 0) parts.push(eraNames[beatenBy] + '에게 약하다');
  return parts.join(' · ');
}

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
    this.btnPoor = new Uint8Array(C.BTN_COUNT);   // 막힌 이유가 "돈"인가 (쿨다운과 갈라야 한다)
    this.bgCanvas = null;
    this.btnCanvas = null;
    this.btnSig = -1;
    this.btnScale = -1;
    this.bakedScale = -1;
    this.bakedEra = -1;
    this.cmdCanvas = null;
    this.cmdSig = -1;
    this.cmdScale = -1;
    this.briefCanvas = null;
    this.briefScale = -1;
    // 결과 카드는 다 뜬 뒤로 안 바뀐다. 구워 두고 붙인다
    this.resCardCanvas = null;
    this.resCardOn = 0;
    this.resCardScale = -1;
    this.stageSeed = 0;              // 전투마다 지형·능선이 달라진다
    this.bakedStage = -1;
    this.bakedDip = -1;
    this.fallX = FALL_X_L;
    this.fallX2 = -1;

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

  // 지금 상대하는 사령관. 필드가 없으면 -1 — 사령관 UI 를 통째로 안 그린다
  commanderOf(game) {
    if (!CMD_NAME) return -1;
    const c = game.commander;
    if (typeof c !== 'number') return -1;
    const i = c | 0;
    return (i >= 0 && i < CMD_NAME.length) ? i : -1;
  }

  // ── 전장 변주 — 전투마다 협곡이 다르다 ─────────────────────
  // groundAt() 의 서명은 game.js 소유다. 여기서는 **결과를 관찰만** 한다 —
  // 가운데 깊이가 바뀌었으면 정적 지형을 다시 굽는다. 능선·잡석 씨앗도
  // 전투 번호로 흔들어 사령관마다 다른 전장이라는 인상을 만든다.
  syncStage(game) {
    const st = (typeof game.stage === 'number') ? (game.stage | 0) : 0;
    // game.js 가 지형을 바꾸면 terrainSeq 가 오른다. 그 필드가 없던 시절에는
    // 지면 함수를 직접 찍어 보고 판단한다 — 둘 다 관찰이지 계약 변경이 아니다.
    const dip = (typeof game.terrainSeq === 'number') ? game.terrainSeq : groundAt(HALF_W);
    if (st === this.bakedStage && Math.abs(dip - this.bakedDip) < 0.5) return;
    this.bakedStage = st;
    this.bakedDip = dip;
    this.stageSeed = (st * 53) & 255;
    this.fallX = FALL_X_L + (st * 17) % 44;
    this.fallX2 = (st & 1) ? C.VIEW_W - FALL_X_L - (st * 23) % 44 : -1;
    this.buildBackground();
    this.bakedScale = -1;              // 오프스크린 배경을 다시 굽는다
  }

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
    const SD = this.stageSeed;
    this.ridgeFar = this.buildRidge(13, 176, 250, 3 + SD);
    this.ridgeMid = this.buildRidge(9, 128, 206, 11 + SD);
    this.ridgeNear = this.buildRidge(6, 92, 156, 29 + SD);
    // 근경 능선의 등줄기 — 봉우리에서 발치로 내려긋는 선. 결이 있어야 바위로 읽힌다
    this.ridgeLines = new Path2D();
    for (let i = 0; i <= 6; i++) {
      const x = (C.VIEW_W / 6) * i;
      const h = 92 + this.rn(29 + SD + i * 5) * 64;
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
      const x = 20 + this.rn(SD + i * 3) * (C.VIEW_W - 40);
      const g = groundAt(x);
      const r = 2 + this.rn(SD + i * 3 + 1) * 4;
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
    this.maxGy = 0;                        // 살아 있는 유닛 중 가장 낮은 발밑 y
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
    // **진영별로 따로 잡는다.** 예전에는 한 벌뿐이었고 game.skillCd(내 것)만
    // 봤다. 그래서 적이 해일을 쏘면 화면에 아무 일도 안 일어나거나, 내 기지
    // 앞(SPAWN_L_X)에서 내 색으로 터졌다 — 사용자 보고: "상대와 내가 쓰는
    // 기술 이펙트가 구분이 안 된다". 색·위치·진행 방향 셋 다 갈라야 한다.
    // 인덱스는 side * SKILL_COUNT + skill.
    this.fxSkill = new Int16Array(2 * C.SKILL_COUNT);
    this.fxSkillX = new Float32Array(2 * C.SKILL_COUNT);
    this.prevSkillCd = new Float32Array(2 * C.SKILL_COUNT);
    // 발동한 **순간의 등급**을 붙잡는다. 연출이 도는 1초 사이에 시대가 오르면
    // 등급이 바뀌고, 그러면 화면의 물기둥 수와 실제 피해 구역이 어긋난다.
    this.fxTier = new Uint8Array(2 * C.SKILL_COUNT);
    this.fxTower = new Int16Array(2);
    this.fxTowerX = new Float32Array(2);
    this.prevTowerCd = new Float32Array(2);
    this.prevTowerLv = new Int8Array(2);
    this.fxEra = new Int16Array(2);
    this.prevEra = new Int8Array(2);
    this.fxEraSweep = 0;             // 내 진화 순간의 화면 스윕 (SIDE_L 전용)
    this.fxEraSweepEra = 0;          // 스윕이 물들 새 시대 — 색은 여기서 정한다

    // ── 툴팁 상태 — 전부 렌더러 자신의 UI 상태다(게임을 안 건드린다) ──
    // hoverKind: 0 없음 · 1 버튼(유닛·진화·포탑·해일·화살비, hoverIdx=버튼번호)
    //            2 증원 원형 · 3 별자리 칩 · 4 특성 알약(hoverIdx) · 5 숙련 알약(hoverIdx)
    this.hoverKind = 0; this.hoverIdx = -1;
    this.hoverSig = -1;               // (kind,idx,era) 서명 — 바뀔 때만 문장을 다시 짓는다
    this.hoverL1 = ''; this.hoverL2 = ''; this.hoverL3 = '';
    this.hoverAX = 0; this.hoverAY = 0;   // 툴팁이 붙을 화면 좌표(그 요소의 자리)
    // 특성·숙련 알약의 자리 — drawHud 가 그리면서 채운다(같은 프레임, 같은 계산을
    // 두 번 안 한다). 폭만 있으면 된다 — y·h는 알약 줄 하나뿐이라 상수다.
    this.chipX = new Float32Array(24);
    this.chipW = new Float32Array(24);
    this.chipKind = new Int8Array(24);   // 1=특성 2=숙련
    this.chipIdx = new Int16Array(24);
    this.chipN = 0;
    this.prevTick = -1;
    // 증원 기둥 개수 — doRally() 가 RALLY_TIER_MIX[tier] 합만큼 유닛을 내므로
    // (3/4/5기) 기둥도 그 합만큼 서야 한다. 스킬이 **터지는 순간(1회)**에만
    // 계산해 여기 저장한다 — drawSkillFxSide 에서 매 프레임 reduce 하지 않는다.
    this.fxRallyN = new Uint8Array(2).fill(C.RALLY_COUNT);

    // 원정·사령관 — 상태의 변화만 본다. 필드가 없으면 전부 -1 로 남아 아무 일도 안 난다
    this.prevStage = -2;
    this.prevProfile = -1;
    this.prevObserving = 1;
    this.fxFoeEra = 0;               // 적이 진화한 순간
    this.fxLine = 0;                 // 전투 시작 대사
    this.prevZodiac = -1;
    this.fxZodiac = 0;               // 별자리 리빌 — 전투가 바뀌어 별자리가 다시 뽑힌 순간
    this.seenSkill = new Uint8Array(C.SKILL_COUNT);  // 원정 전체 기준 "첫 조우" — 한 번만 효과를 크게 보여준다
    this.prevCastSk = -1;             // 예고가 새로 시작된 프레임만 "첫 조우" 여부를 다시 판정한다
    this.castIsFirst = 0;             // 그 판정을 캐스팅 내내(여러 프레임) 그대로 들고 있는다
    this.fxTaunt = 0;                // 도발
    this.overTime = -1;              // 결과 화면에 **멈춘** 시간을 찍기 위해 판이 끝난 순간을 잡는다
    this.overFrames = 0;             // 판이 끝난 뒤 흐른 렌더 프레임. 결과 카드의 시계다
    this.foeMix = new Int32Array(C.UNIT_KINDS);   // 지금 살아 있는 적 구성
    this.foeMax = 1;

    // 화살비 — 결정론적 산포. Math.random 을 쓰면 매 프레임 화살이 순간이동한다.
    this.vOff = new Float32Array(VOLLEY_N);
    this.vDelay = new Float32Array(VOLLEY_N);
    for (let i = 0; i < VOLLEY_N; i++) {
      this.vOff[i] = (((i * 2654435761) % 997) / 997) * 2 - 1;
      this.vDelay[i] = ((i * 40503) % 251) / 251;
    }
    // 구덩이 산포 — 화살비가 땅에 남기는 자국. 같은 이유로 미리 굽는다
    this.cOff = new Float32Array(CRATER_N);
    this.cSz = new Float32Array(CRATER_N);
    for (let i = 0; i < CRATER_N; i++) {
      this.cOff[i] = (((i * 1103515245 + 12345) % 733) / 733) * 2 - 1;
      this.cSz[i] = 0.55 + ((i * 22695477) % 311) / 311 * 0.75;
    }

    // ── 흉터 — 스킬이 끝난 뒤에도 남는 것 ──
    // fxSkill 과 같은 인덱스(side * SKILL_COUNT + skill)를 쓴다. 한 벌 더 만들지 않는다.
    this.scarLife = new Int16Array(2 * C.SKILL_COUNT);
    this.scarX = new Float32Array(2 * C.SKILL_COUNT);
  }

  // main 이 리사이즈에서만 부른다. 창 크기를 여기서만 읽는다 —
  // 매 프레임 innerWidth 를 읽으면 레이아웃을 강제할 수 있다.
  resize(viewScale) {
    this.viewScale = viewScale;
    this.bakedScale = -1; this.btnScale = -1; this.cmdScale = -1;
    const portrait = (typeof window !== 'undefined')
      ? (window.innerHeight > window.innerWidth * 1.15) : 0;
    if (!!portrait !== !!LAY.portrait) this.btnSig = -1;
    applyLayout(portrait);
  }

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
    if (ly < LAY.y || ly > LAY.y + LAY.h) return -1;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = btnX(i);
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
  // 별자리 칩 — 툴팁 전용 히트테스트다(구매·입력용이 아니다). drawZodiacHud 와
  // 정확히 같은 사각형(ZOD_CHIP_X 는 중심 x).
  static hitZodiac(lx, ly) {
    const bx = ZOD_CHIP_X - ZOD_CHIP_W * 0.5;
    return lx >= bx && lx <= bx + ZOD_CHIP_W && ly >= ZOD_CHIP_Y && ly <= ZOD_CHIP_Y + ZOD_CHIP_H;
  }

  // ── 한 프레임 ───────────────────────────────────────────────
  draw(game, feel, alpha, director, directorView, muted) {
    const ctx = this.ctx;
    const s = this.viewScale;

    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

    this.pollFx(game, director);
    this.syncStage(game);

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
    // 흉터는 **지면에 남은 것**이라 유닛보다 먼저다. 유닛이 그 위를 밟고 지나가야 한다
    this.drawScars(game);
    // 보스는 유닛보다 먼저 — 몸집이 커서 뒤에 깔려야 몰려드는 병력이 위에서 읽힌다
    this.drawBoss(game);
    this.drawWeapon(game);
    this.drawUnits(game, alpha);
    this.drawStun(game);
    this.drawRearm(game);
    this.drawEraFx(game);
    this.drawEraSweep();
    this.drawSkillFx(game);
    // 적 예고는 **스킬 연출보다 위**다. 지금 터지고 있는 것보다 다음에 올 것이
    // 더 급한 정보다 — 플레이어가 원정 6판을 진 이유가 정확히 이것이었다.
    this.drawAiCast(game);
    // 보스 예고는 그 위다 — 한 판에 한 번뿐인 사건이 스킬 하나보다 급하다
    this.drawBossWarn(game);
    this.drawParticles(feel);
    this.drawRings(feel);
    this.drawWater(game, alpha);
    this.drawWaterfalls(game, alpha);
    this.drawOverhang();
    this.drawFloats(feel);

    ctx.setTransform(s, 0, 0, s, 0, 0);
    // 화면 좌표계다 — 셰이크 변환 밖이라 비네트는 흔들리지 않고 가장자리에 붙어 있다.
    this.drawTension(feel);
    this.drawHud(game, feel, director, directorView, muted);
    this.drawButtons(game);
    this.drawRally(game);
    this.drawTooltip(game);
    // 결과 카드가 올라오면 **배너는 안 그린다.** 둘은 같은 순간에 같은 자리에서
    // 같은 말을 한다 — 배너 '전투를 이겼다' 와 제목 '전투 승리' 가 둘 다
    // HALF_W 중앙정렬 · FONT_BIG · y 140 언저리다. 반투명 막 아래로 배너가
    // 비쳐 두 글자열이 겹쳐 「전전투 승리다」·「원원정 종료다」로 읽혔다.
    // (그래서 막을 불투명하게 만든 것과 별개로, 원인 자체를 여기서 끊는다.)
    const showResult = game.state === S.OVER && feel.resultStep >= 0
                    && this.overFrames > RESULT_HOLD_F;
    if (!showResult) this.drawBanner(feel);
    if (game.state === S.DRAFT) this.drawDraft(game, feel, director);
    if (showResult) this.drawResult(game, feel, director);
    // 설명 화면 — game.js 가 아직 S.BRIEF 를 안 줬으면 BRIEF 가 -1 이라 절대 안 걸린다
    if (game.state === BRIEF) this.drawBrief(game, feel);
  }

  // ── 연출 트리거 — 상태의 변화만 본다 ────────────────────────
  // 쿨다운이 **올라간** 프레임이 곧 발동한 순간이다. 이벤트 배선이 없어도,
  // 그 필드가 아직 없어도 (undefined → 0) 조용히 아무 일도 안 일어난다.
  pollFx(game, director) {
    const restart = game.tick < this.prevTick;
    if (restart) {                            // 새 판
      this.fxSkill.fill(0);
      this.fxTier.fill(0);
      this.scarLife.fill(0);                  // 지난 판의 자국이 새 판에 남지 않는다
      this.fxTower.fill(0);
      this.fxEra.fill(0);
      this.fxEraSweep = 0;
      this.hoverKind = 0; this.hoverSig = -1;   // 지난 판의 툴팁이 새 판에 안 남는다
      this.prevSkillCd.fill(0);
      this.prevTowerCd.fill(0);
      this.prevTowerLv.fill(0);
      this.prevEra.fill(0);
      this.prevProfile = -1;
      this.prevObserving = 1;
      this.prevZodiac = -1;
      this.fxZodiac = 0;
      this.seenSkill.fill(0);        // 새 원정에서는 다시 처음부터 가르친다
      this.prevCastSk = -1;
      this.castIsFirst = 0;
      this.fxRallyN.fill(C.RALLY_COUNT);
    }
    this.prevTick = game.tick;

    // ── 원정 — 전투가 바뀌면 사령관이 나타나 한마디 한다 ──
    // game.js 가 아직 stage/commander 를 안 주면 stage 는 -1 로 남고 아무것도 안 뜬다.
    const stage = (typeof game.stage === 'number') ? (game.stage | 0) : -1;
    const cmd = this.commanderOf(game);
    if (cmd >= 0 && (stage !== this.prevStage || restart)) this.fxLine = FX_LINE_F;
    this.prevStage = stage;
    if (this.fxLine > 0) this.fxLine--;

    // ── 별자리 — 매 resetBattle() 마다 다시 뽑힌다(game.js 는 안 건드린다,
    // game.zodiac 은 이미 공개돼 있다). 값이 바뀐 프레임을 리빌 시작으로 잡는다.
    const zod = (typeof game.zodiac === 'number') ? (game.zodiac | 0) : -1;
    if (zod !== this.prevZodiac) this.fxZodiac = ZOD_REVEAL_F;
    this.prevZodiac = zod;
    if (this.fxZodiac > 0) this.fxZodiac--;

    // ── 도발 — **디렉터가 플레이어를 새로 판정한 순간**이 곧 이 기능이다 ──
    // 이벤트 배선 없이 판정값의 변화만 본다. 디렉터가 없으면 조용히 지나간다.
    if (director) {
      const pi = director.profileIdx | 0;
      const obs = director.observing ? 1 : 0;
      if (!obs && (pi !== this.prevProfile || this.prevObserving)) this.fxTaunt = FX_TAUNT_F;
      this.prevProfile = pi;
      this.prevObserving = obs;
    }
    if (this.fxTaunt > 0) this.fxTaunt--;
    if (this.fxFoeEra > 0) this.fxFoeEra--;

    // 결과 화면의 시간은 **멈춰 있어야 한다.** 판이 끝난 순간을 한 번만 잡는다
    if (game.state === S.OVER) {
      if (this.overTime < 0) this.overTime = game.elapsed();
      // 결과 카드는 **자기 시계로** 올라온다. 히트스톱에 물리지 않아야
      // "전장 잠깐 → 불투명한 카드" 순서가 언제나 같은 길이로 나온다.
      if (this.overFrames < 4096) this.overFrames++;
    } else { this.overTime = -1; this.overFrames = 0; this.resCardOn = 0; }

    const front = game.frontlineX ? game.frontlineX() : HALF_W;
    for (let s = 0; s < 2; s++) {
      // 쿨다운이 **올라간** 프레임이 발동한 순간이다. 적 쪽은 aiSkillCd 다 —
      // 그 배열이 없는 빌드에서는 조용히 아무 일도 안 일어난다.
      const cds = s === SIDE_L ? game.skillCd : game.aiSkillCd;
      for (let i = 0; i < C.SKILL_COUNT; i++) {
        const k = s * C.SKILL_COUNT + i;
        const cd = cds ? (cds[i] || 0) : (s === SIDE_L && i === C.SK_TIDE ? (game.nukeCd || 0) : 0);
        if (cd > this.prevSkillCd[k] + 1) {
          this.fxSkill[k] = i === C.SK_TIDE ? FX_TIDE_F : (i === C.SK_VOLLEY ? FX_VOLLEY_F : FX_RALLY_F);
          // 등급을 그 자리에서 굳힌다 — 화살비의 낙하 구역 수와 해일의 밀어냄이
          // 여기서 갈린다. game 이 tier 를 안 주는 빌드에서는 조용히 0 이다
          const tf = s === SIDE_L ? game.skillTier : game.aiSkillTier;
          this.fxTier[k] = (typeof tf === 'function' ? (tf.call(game, i) | 0) : 0) & 3;
          // 증원 기둥 개수 — doRally() 의 실제 소환 수(RALLY_TIER_MIX 합)로 맞춘다.
          // 기능(3/4/5기)과 화면(기둥 3개 고정)이 어긋나 있던 자리(spec-map-base-skill §4.1).
          if (i === C.SK_RALLY) {
            const mix = C.RALLY_TIER_MIX && C.RALLY_TIER_MIX[this.fxTier[k]];
            let n = C.RALLY_COUNT;
            if (mix) { n = 0; for (let u = 0; u < mix.length; u++) n += mix[u]; }
            this.fxRallyN[s] = n;
          }
          // 증원은 **쏜 쪽 기지 앞**에서 솟는다. 화살비만 전선에 떨어진다.
          this.fxSkillX[k] = i === C.SK_VOLLEY ? front : (s === SIDE_L ? C.SPAWN_L_X : C.SPAWN_R_X);
          // 흉터도 같은 순간에 예약한다. 연출보다 오래 산다 — 그게 "판이 바뀌었다"는 증거다.
          // 해일은 자기 진영 반대편 전체를 훑으므로 자국의 기준점이 전선이다.
          this.scarLife[k] = SCAR_F;
          this.scarX[k] = i === C.SK_TIDE ? front : this.fxSkillX[k];
        }
        this.prevSkillCd[k] = cd;
        if (this.fxSkill[k] > 0) this.fxSkill[k]--;
        if (this.scarLife[k] > 0) this.scarLife[k]--;
      }
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
      if (era > this.prevEra[s]) {
        this.fxEra[s] = FX_ERA_F;
        // 적 진화는 **내 진화와 다른 방식으로** 알린다. 배너를 뺏지 않되 놓치지도 않게
        if (s === SIDE_R) this.fxFoeEra = FX_FOE_ERA_F;
        // 내 진화만 화면 전체를 훑는다 — "배경이 바뀌었다"를 느껴야 할 사람은 나다
        else { this.fxEraSweep = FX_ERA_SWEEP_F; this.fxEraSweepEra = era; }
      }
      this.prevEra[s] = era;
      if (this.fxEra[s] > 0) this.fxEra[s]--;
    }
    if (this.fxEraSweep > 0) this.fxEraSweep--;
  }

  // ── 배경 굽기 ───────────────────────────────────────────────
  // 오프스크린 캔버스 하나에 정적 배경 전체를 굽고 매 프레임 한 번 붙인다.
  // p50 은 원래도 0.5ms 였다 — 문제는 JS 가 아니라 **래스터 양**이었고,
  // 큰 채우기 스무 번이 합성 스레드에 밀려 스파이크로 돌아왔다.
  // document 가 없는 환경(도구 스크립트)에서는 조용히 예전처럼 직접 그린다.
  paintBackground(game) {
    const era = game.era | 0;
    const e = era < 0 ? 0 : (era >= C.ERA_COUNT ? C.ERA_COUNT - 1 : era);
    if (typeof document === 'undefined') { this.drawSky(e); this.drawTerrain(e); return; }
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
      this.drawTerrain(e);
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
    const RE = ERA_RAMP(era);
    const RL = eraLit(era);
    // 위가 어둡고 지평선이 밝다. 다만 **맨 위도 배경색보다는 확실히 밝아야** 한다 —
    // 그래야 순수 배경색으로 칠한 근경(처마)이 검은 덩어리로 읽힌다.
    const bh = C.GROUND_Y / SKY_BANDS;
    for (let i = 0; i < SKY_BANDS; i++) {
      const t = i / (SKY_BANDS - 1);
      ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.32 + t * t * 0.46)];
      ctx.fillRect(0, bh * i, C.VIEW_W, bh + 1);
    }
    // ── 시대의 공기 ── 사용자: "진화하면 배경도 바뀌었으면 좋겠다."
    // 실루엣은 이미 시대마다 커지지만 그건 확대해야 보인다. **하늘부터 바뀐다.**
    // 위로 갈수록 짙게 깔아 시대마다 다른 하늘색이 되게 한다.
    // 예전 알파(0.06~0.40)는 인프라만 있고 눈에는 안 남았다 — 실측 뒤 크게 올렸다.
    // 배경은 한 번 굽는 그림이므로 이 스무 번의 채우기는 매 프레임 비용이 0 이다.
    for (let i = 0; i < SKY_BANDS; i++) {
      const t = i / (SKY_BANDS - 1);
      ctx.fillStyle = RE[C.rampIndex(0.52 * (1 - t) * (1 - t) + 0.16)];
      ctx.fillRect(0, bh * i, C.VIEW_W, bh + 1);
    }
    // 시대의 구름 — 위쪽의 빈 하늘을 메운다. 다섯 시대가 다른 결을 가진다
    ctx.fillStyle = RL[C.rampIndex(0.08 + era * 0.035)];
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const cx = 40 + this.rn(this.stageSeed + 90 + i * 7) * (C.VIEW_W - 80);
      const cy = 26 + this.rn(this.stageSeed + 91 + i * 7) * 132;
      const w = 70 + this.rn(this.stageSeed + 92 + i * 7) * 150;
      const h = 8 + (i % 3) * 5 + era * 1.5;
      ctx.moveTo(cx + w * 0.5, cy);
      ctx.ellipse(cx, cy, w * 0.5, h, 0, 0, TAU);
    }
    ctx.fill();

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
    // 랜드마크에 시대색을 한 겹 더 — 모양만이 아니라 색으로도 시대가 읽히게
    ctx.fillStyle = RL[C.rampIndex(0.32 + era * 0.05)];
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

    // 건너편 둑 — **협곡의 모양이 여기서 한 번 더 보여야 한다.**
    // 예전에는 곧은 가로선 다섯이었다. 전투마다 협곡 깊이가 다른데(STAGE_DIP,
    // game.stageDip) 화면에서는 지면 한 줄만 그 사실을 알고 있었고, 그 위 300px 은
    // 그 판이 어떤 지형인지 모르는 장식이었다. 이제 지면 곡선을 줄여 되풀이한다 —
    // 깊은 협곡이면 이 층들도 같이 깊어진다.
    for (let i = 0; i < 7; i++) {
      const k = 0.78 - i * 0.10;                   // 위로 갈수록 얕아진다 (원근)
      const off = 12 + i * 26;
      ctx.strokeStyle = (i < 3 ? C.RAMP_STRUCT : RE)[C.rampIndex(0.24 - i * 0.022)];
      ctx.lineWidth = i < 3 ? 1.4 : 1;
      ctx.beginPath();
      for (let x = 0; x <= C.VIEW_W; x += 24) {
        const y = C.GROUND_Y - off + (groundAt(x) - C.GROUND_Y) * k + this.rn(i * 13 + x * 0.05) * 4;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.lineWidth = C.STROKE;
    // 층 사이의 그늘 — 선만 있으면 종이가 되고, 이 띠가 있어야 벽이 된다
    ctx.fillStyle = RE[C.rampIndex(0.42)];
    ctx.beginPath();
    for (let x = 0; x <= C.VIEW_W; x += 24) {
      ctx.lineTo(x, C.GROUND_Y - 12 + (groundAt(x) - C.GROUND_Y) * 0.78);
    }
    for (let x = C.VIEW_W; x >= 0; x -= 24) {
      ctx.lineTo(x, C.GROUND_Y - 12 + (groundAt(x) - C.GROUND_Y) * 0.78 + 14);
    }
    ctx.closePath();
    ctx.fill();

    // 지평선 안개 — 능선 발치를 흐려 원경과 근경을 분리한다
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.20 - i * 0.045)];
      ctx.fillRect(0, C.GROUND_Y - 58 + i * 15, C.VIEW_W, 15);
    }
    // 시대의 지평선 빛 — 안개 위에 얇게. 다섯 시대가 여기서 가장 크게 갈린다
    // (예전엔 이 말과 값(0.03~0.098)이 안 맞았다 — 가장 크게 갈려야 할 자리가
    // 가장 옅었다. 여기부터 올렸다.)
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = RL[C.rampIndex(0.10 + i * 0.07)];
      ctx.fillRect(0, C.GROUND_Y - 66 + i * 13, C.VIEW_W, 13);
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

    // ── 시대의 티끌 ── 하늘의 470px 이 죽은 장식이었다 (플레이어 보고:
    // "위 470px은 장식용 산과 하늘"). 여기에 **시대마다 다른 것이 떠오른다** —
    // 돌 시대의 재, 화약 시대의 불티, 기계 시대의 증기. 색만 바뀌는 게 아니라
    // 시대가 오를수록 수와 속도가 는다. 한 경로에 모아 한 번만 칠한다.
    const eI2 = eraIdx(game.era);
    ctx.fillStyle = eraLit(eI2)[C.rampIndex(0.10 + eI2 * 0.045)];
    ctx.beginPath();
    const mn = 10 + eI2 * 4;
    for (let i = 0; i < mn; i++) {
      const sp = 26 + this.rn(i * 5 + 40) * (30 + eI2 * 26);
      const span = C.GROUND_Y + 60;
      const y = C.GROUND_Y - ((this.rn(i * 5 + 41) * span + t * sp) % span);
      const x = this.rn(i * 5 + 43) * C.VIEW_W + Math.sin(t * 0.7 + i) * 16;
      const sz = 1.6 + this.rn(i * 5 + 44) * (2 + eI2 * 0.8);
      ctx.rect(x, y, sz, sz);
    }
    ctx.fill();
    ctx.lineWidth = C.STROKE;
  }

  // ── 근경 — 협곡 바닥 · 지층 · 벽 ────────────────────────────
  drawTerrain(era) {
    const ctx = this.ctx;
    const RE = ERA_RAMP(era || 0);
    const RL = eraLit(era || 0);

    ctx.fillStyle = C.RAMP_GRID[C.rampIndex(0.95)];
    ctx.fill(this.floorFill);
    // 시대의 땅 — 얇게 얹는다. **유닛보다 뒤에 있으므로 병종 색을 덮지 않는다**
    // (예전 0.42는 실측상 안 느껴졌다 — 올렸다)
    ctx.fillStyle = RE[C.rampIndex(0.62)];
    ctx.fill(this.floorFill);

    // 지층 띠 — 물때처럼 쌓였다. 이 깊이가 있어야 물이 무섭다
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.5)];
    ctx.fill(this.strataFill);
    ctx.fillStyle = RE[C.rampIndex(0.48)];
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
    ctx.fillStyle = RL[C.rampIndex(0.16)];
    ctx.fill(this.rubble);

    // 협곡 벽
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.75)];
    ctx.fill(this.cliffPath);
    ctx.fillStyle = RE[C.rampIndex(0.52)];
    ctx.fill(this.cliffPath);
    ctx.strokeStyle = RL[C.rampIndex(0.22)];
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

    for (let s = 0; s < 2; s++) {
      const x = s === 0 ? this.fallX : this.fallX2;
      if (x < 0) continue;
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

    // 시대의 성벽 — **기지도 시대를 입는다.** 아래쪽으로 갈수록 짙게 물들여
    // 오래된 돌 위에 새 시대가 얹혔다는 결을 만든다. 유닛보다 뒤이므로 안전하다.
    {
      const eb = ((mine ? game.era : game.aiEra) | 0);
      const REb = ERA_RAMP(eb);
      // **얇게.** 0.40/0.22 로 깔아 봤더니 내 성이 회분홍이 되어 진영 대비가
      // 죽었다 (기지의 밝기가 곧 진영이다). 색조는 남기고 무게만 뺀다.
      ctx.fillStyle = REb[C.rampIndex(0.24)];
      ctx.fillRect(x, y + h * 0.45, w, h * 0.55);
      ctx.fillStyle = REb[C.rampIndex(0.12)];
      ctx.fillRect(x, y, w, h * 0.45);
      // 시대의 띠 한 줄 — 성벽 허리. 진화하면 이 선의 색이 바뀐다
      ctx.fillStyle = eraLit(eb)[C.rampIndex(mine ? 0.55 : 0.34)];
      ctx.fillRect(x + 4, y + h * 0.45 - 3, w - 8, 3);
    }

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
      // **내 진화는 금색, 적 진화는 적 색이다.** 같은 연출을 주면 내 성취가 묻히고,
      // 아무 연출도 안 주면 적이 진화한 줄 모른다 (사용자가 실제로 못 느꼈다).
      const ramp = s === SIDE_L ? C.RAMP_BONUS : C.RAMP_STRUCT;
      const mine = s === SIDE_L;
      const sz0 = mine ? 1 : 0.74;
      const gy = groundAt(cx);
      const dir = mine ? 1 : -1;

      // 이 게임에서 가장 큰 사건인데 얇은 고리 둘로 끝났다 (실측: 전장의 1.17%).
      // 진화는 **세계가 바뀌는 것**이다 — 빛기둥이 하늘까지 서고, 지면을 따라
      // 충격이 판을 건너가고, 잠깐 화면 전체가 밝아진다.

      // (1) 전면 섬광도 같은 이유로 뺐다 (위 drawSkillFx 의 장막과 같은 비용).
      //     진화는 드물어서 3분 평균에는 거의 안 잡히지만, 터지는 그 순간에
      //     프레임을 버리면 **가장 큰 사건이 끊겨 보인다.** WebGL 에서 되살린다.

      // (2) 빛기둥 — 기지에서 하늘 끝까지. 사다리꼴이라 위로 갈수록 벌어진다
      if (t < 0.62) {
        const bt = t / 0.62;
        const a = bt < 0.22 ? bt / 0.22 : 1 - (bt - 0.22) / 0.78;
        const aa = (a < 0 ? 0 : a) * (mine ? 1 : 0.7);
        const w = (mine ? 44 : 30) * (0.5 + easeOutCubic(bt) * 0.8);
        ctx.fillStyle = ramp[C.rampIndex(0.55 * aa)];
        ctx.beginPath();
        this.addTrap(cx, 0, gy, w * 2.1, w, 0);
        ctx.fill();
        ctx.fillStyle = ramp[C.rampIndex(0.95 * aa)];
        ctx.beginPath();
        this.addTrap(cx, 0, gy, w * 0.7, w * 0.34, 0);
        ctx.fill();
      }

      // (3) 고리 셋 — 시차를 두고 나간다. 하나보다 셋이 훨씬 크게 읽힌다
      ctx.strokeStyle = ramp[C.rampIndex(1 - t)];
      for (let r = 0; r < 3; r++) {
        const p = t - r * 0.13;
        if (p <= 0) continue;
        const pe = easeOutCubic(p);
        ctx.lineWidth = (5 - r * 1.2) * (1 - p) + 0.8;
        ctx.beginPath();
        ctx.arc(cx, cy, 26 + (330 - r * 76) * pe * sz0, 0, TAU);
        ctx.stroke();
      }

      // (4) 지면 충격 — 판을 가로질러 달린다. 진화가 **전장에 도달한다**
      if (t < 0.7) {
        const st = t / 0.7;
        const reach = C.VIEW_W * 1.05 * easeOutCubic(st);
        ctx.strokeStyle = ramp[C.rampIndex(0.9 * (1 - st))];
        ctx.lineWidth = 6 * (1 - st) + 1;
        ctx.beginPath();
        const ex = cx + dir * reach;
        ctx.moveTo(cx, gy - 3);
        ctx.lineTo(ex, groundAt(ex) - 3);
        ctx.stroke();
        // 충격이 지나간 자리에서 튀어 오르는 지면
        ctx.fillStyle = ramp[C.rampIndex(0.8 * (1 - st))];
        ctx.beginPath();
        for (let i = 0; i < 12; i++) {
          const px = cx + dir * reach * (i / 12);
          const h = 16 * (1 - st) * (0.5 + this.cSz[i % CRATER_N]);
          this.addSpike(px, groundAt(px), 0, -1, h, 3.5);
        }
        ctx.fill();
      }

      // (5) 솟아오르는 알갱이 — 기지가 새 시대를 뱉는다. 예전보다 배로 많다
      ctx.fillStyle = ramp[C.rampIndex(1 - t)];
      ctx.beginPath();
      for (let i = 0; i < 24; i++) {
        const px = cx + (this.rn(s * 23 + i * 3) - 0.5) * (C.BASE_W + 70);
        const py = gy - 10 - e * (70 + this.rn(s * 23 + i * 3 + 1) * 210);
        const sz = 5 * (1 - t) + 1;
        ctx.rect(px - sz * 0.5, py - sz * 0.5, sz, sz);
      }
      ctx.fill();
      ctx.lineWidth = C.STROKE;
    }
  }

  // ── 시대 전환 스윕 — 내 기지에서 화면 끝까지 새 시대색이 훑고 지나간다 ──
  // 사용자: "진화하면 배경도 바뀌었으면 좋겠다." paintBackground 는 era가
  // 오른 그 프레임에 이미 새 하늘·지층으로 다시 굽지만(bakedEra 비교),
  // **전환 자체**가 순간이라 눈이 못 따라갔다. 여기서 그 순간을 한 번
  // 크게 말해 준다. 띠 몇 장뿐이라 값싸다 — 전면 fillRect 한 장(위 drawEraFx
  // 주석의 그 교훈)과 달리 화면의 일부 폭만, 그것도 아주 드문 순간에만 그린다.
  drawEraSweep() {
    const f = this.fxEraSweep;
    if (f <= 0) return;
    const ctx = this.ctx;
    const t = 1 - f / FX_ERA_SWEEP_F;
    const RL = eraLit(this.fxEraSweepEra);
    // 내 기지(왼쪽)에서 시작해 화면 오른쪽 끝까지 — 진화가 세계로 번져 나간다
    const bandW = 210;
    const head = -bandW + (C.VIEW_W + bandW * 2) * easeOutCubic(t);
    for (let i = 0; i < SWEEP_BANDS; i++) {
      const bt = i / (SWEEP_BANDS - 1);
      const x = head - bandW * 0.5 + bandW * bt;
      const fall = 1 - Math.abs(bt - 0.5) * 2;             // 가운데가 가장 밝다
      const a = fall * (1 - t) * 0.6;
      if (a <= 0.01) continue;
      ctx.fillStyle = RL[C.rampIndex(a)];
      ctx.fillRect(x, 0, bandW / SWEEP_BANDS + 2, C.VIEW_H);
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
    // 적 구성도 여기서 센다 — 이미 도는 루프다. HUD 가 "적이 뭘 뽑고 있나"를 그린다
    this.foeMix.fill(0);
    let n = 0;
    for (let i = 0; i < C.UNIT_MAX; i++) {
      if (!game.uAlive[i]) continue;
      const kind = game.uKind[i];
      if (game.uSide[i] === SIDE_R) this.foeMix[kind]++;
      const x = game.uPrevX[i] + (game.uX[i] - game.uPrevX[i]) * alpha;
      const grow = ERA_GROW[eraIdx(game.uEra[i])];
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
    // 가장 낮은 곳에 선 유닛의 발밑. 물이 여기보다 아래면 잠긴 유닛이 하나도 없다 —
    // 잠긴 유닛 되살리기 패스를 통째로 건너뛰는 값싼 판정이다
    let mgy = 0;
    for (let j = 0; j < n; j++) { const g0 = sgy[list[j]]; if (g0 > mgy) mgy = g0; }
    this.maxGy = mgy;
    let fmx = 3;
    for (let k = 0; k < C.UNIT_KINDS; k++) if (this.foeMix[k] > fmx) fmx = this.foeMix[k];
    this.foeMax = fmx;

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

    // 2) 몸 — **진영이 색이 아니라 잉크로 갈린다.**
    //    아군: 흰 몸 + 어두운 테 (밝은 덩어리)
    //    적군: 어두운 몸 + 밝은 테 (테두리만 빛나는 덩어리)
    //    새 색을 만들 수 없으므로 대비를 **채움/윤곽의 반전**으로 번다.
    //    실측한 실패: 양쪽 다 "밝은 채움 + 어두운 테"였고, 20기가 겹치자
    //    명도가 비슷한 흰 반죽 하나로 뭉쳐 경계가 사라졌다.
    //
    //    같은 편끼리도 갈려야 한다. 인접한 유닛은 대개 인덱스가 인접하므로
    //    i&1 로 두 단계 명도를 번갈아 준다 — 겹쳐도 몇 기인지 세어진다.
    //    (x 로 위상을 만들면 걸을 때마다 명도가 깜빡인다. 인덱스는 안 변한다)
    ctx.lineWidth = C.STROKE;
    // **적을 먼저, 내 병력을 나중에 그린다.** 겹치면 내 것이 위에 온다 —
    // 조종하는 쪽이 가려지면 무엇을 하고 있는지가 안 보인다.
    for (let pi = 0; pi < 2; pi++) {
      const s = pi === 0 ? SIDE_R : SIDE_L;
      const dir = s === SIDE_L ? 1 : -1;
      const mine = s === SIDE_L;
      const ramp = mine ? C.RAMP_PLAYER : C.RAMP_STRUCT;

      // 몸 — **병종 × 명암 두 단계**로 묶어 칠한다.
      // 예전에는 명암 두 단계뿐이었고(전부 흰색/회청색), 그래서 스무 기가 겹치면
      // 병종이 사라졌다. 이제 색이 병종을 말하고 두 단계는 **같은 병종끼리**를 가른다
      // (인접한 유닛은 대개 인덱스가 인접하므로 i&1 이면 옆 사람과 갈린다.
      //  x 로 위상을 만들면 걸을 때마다 명도가 깜빡인다 — 인덱스는 안 변한다).
      // 색은 램프가 아니라 배경과 미리 섞은 **불투명한 색**이다. 알파로는 겹칠 때
      // 아래가 다시 밝아져 정작 뭉치는 자리에서만 효과가 사라진다.
      for (let k = 0; k < UK; k++) {
        if (SIEGE[k]) continue;                 // 공성 병기는 맨 위에 따로 올린다
        for (let tone = 0; tone < 2; tone++) {
          let any = 0;
          for (let j = 0; j < n; j++) {
            const i = list[j];
            if (game.uSide[i] !== s || game.uKind[i] !== k || (i & 1) !== tone) continue;
            if (!any) { ctx.fillStyle = uBody(s, k, tone); ctx.beginPath(); any = 1; }
            this.addUnitFill(game, i, dir);
          }
          if (any) ctx.fill();
        }
      }

      // 안쪽 디테일 — 방패 보스 · 면갑 · 안장 · 거인의 얼굴 그늘.
      // 아군은 어둡게 파고, 적군은 몸이 이미 어두우므로 **밝게 새긴다.**
      ctx.fillStyle = mine ? C.RAMP_BG[C.rampIndex(0.85)] : C.RAMP_STRUCT[C.rampIndex(0.95)];
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s) continue;
        this.addUnitDark(game, i, dir);
      }
      ctx.fill();

      // 윤곽 — 밀집했을 때 서로 겹쳐 한 덩어리로 보이는 것을 끊는다.
      // 전선에는 30기가 21px 간격으로 겹쳐 선다. 이 선이 약하면 반죽이 된다.
      // 어두운 분리선은 진영·병종과 무관하므로 **한 번에** 긋는다.
      ctx.strokeStyle = C.COL_BG;
      ctx.lineWidth = mine ? 3.1 : 3.2;
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s || SIEGE[game.uKind[i]]) continue;
        this.addUnitOutline(game, i, dir);
      }
      ctx.stroke();
      // 적군만 **밝은 심**을 한 번 더 얹는다. 어두운 몸이 배경에 묻히지 않게 하는
      // 것도 이 선이 맡고, **적의 병종은 여기서 읽힌다** — 몸은 가라앉아 있으므로.
      if (!mine) {
        ctx.lineWidth = 1.4;
        for (let k = 0; k < UK; k++) {
          if (SIEGE[k]) continue;
          let any = 0;
          for (let j = 0; j < n; j++) {
            const i = list[j];
            if (game.uSide[i] !== s || game.uKind[i] !== k) continue;
            if (!any) { ctx.strokeStyle = U_RIM[k]; ctx.beginPath(); any = 1; }
            this.addUnitOutline(game, i, dir);
          }
          if (any) ctx.stroke();
        }
      }

      // 공성 병기 — 대열을 통과하는 유닛이라 남의 몸에 묻힌다.
      // 그래서 **몸 패스가 다 끝난 뒤 맨 위에 다시 올린다.**
      // 혼자 앞서 나가다 죽는 그림이 이 유닛의 성격이고, 그게 보여야 한다.
      for (let k = 0; k < UK; k++) {
        if (!SIEGE[k]) continue;
        let anyS = 0;
        for (let j = 0; j < n; j++) {
          const i = list[j];
          if (game.uSide[i] !== s || game.uKind[i] !== k) continue;
          if (!anyS) { ctx.fillStyle = uBody(s, k, 0); ctx.beginPath(); anyS = 1; }
          this.addUnitFill(game, i, dir);
        }
        if (!anyS) continue;
        ctx.fill();
        for (let pass = 0; pass < 2; pass++) {
          if (pass === 1 && mine) break;
          ctx.strokeStyle = pass === 0 ? C.COL_BG : U_RIM[k];
          ctx.lineWidth = pass === 0 ? (mine ? 2.6 : 3.2) : 1.4;
          ctx.beginPath();
          for (let j = 0; j < n; j++) {
            const i = list[j];
            if (game.uSide[i] !== s || game.uKind[i] !== k) continue;
            this.addUnitOutline(game, i, dir);
          }
          ctx.stroke();
        }
      }

      // 선 디테일 — 활시위 · 안테나 · 기병 고삐. 채우면 뭉개지는 것들
      ctx.strokeStyle = ramp[C.rampIndex(mine ? 0.94 : 0.95)];
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

    // 2.5) 발판과 지배선 — **진영을 방향과 땅으로 못 박는다.**
    // 몸이 아무리 겹쳐도 지면선의 이 줄은 안 겹친다. 오른쪽을 향한 흰 삼각형이
    // 내 편, 왼쪽을 향한 회색이 적이다. 그리고 전선까지의 **지면 자체**를
    // 같은 색으로 칠한다 — "어디까지가 내 편인가"가 글자 없이 읽힌다.
    // 지배선을 따로 stroke 하면 그리기 호출이 둘 늘어난다. 색이 같으므로
    // 같은 경로에 넣어 **호출을 늘리지 않고** 얻는다.
    let fx = game.frontlineX ? game.frontlineX() : HALF_W;
    if (!(fx > 0)) fx = HALF_W;
    if (fx < 24) fx = 24; else if (fx > C.VIEW_W - 24) fx = C.VIEW_W - 24;
    for (let s = 0; s < 2; s++) {
      const dir = s === SIDE_L ? 1 : -1;
      ctx.fillStyle = s === SIDE_L ? C.COL_PLAYER : C.COL_STRUCT;
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (game.uSide[i] !== s) continue;
        const gx = sx[i], gy = sgy[i] + 2.5;
        ctx.moveTo(gx + dir * 7.5, gy);
        ctx.lineTo(gx - dir * 3.5, gy - 4);
        ctx.lineTo(gx - dir * 3.5, gy + 4);
        ctx.closePath();
      }
      // 내 땅은 이어진 선, 적 땅은 **끊긴 선**이다. 얇은 선에서는 명도 차만으로
      // 부족해서 (실측: 슬레이트 선과 흰 선이 한눈에 안 갈렸다) 모양을 바꾼다.
      const x0 = s ? fx : 0, x1 = s ? C.VIEW_W : fx;
      if (s) {
        for (let x = x0; x < x1; x += 34) {
          const xe = x + 20 < x1 ? x + 20 : x1;
          ctx.moveTo(x, groundAt(x) - 1);
          ctx.lineTo(xe, groundAt(xe) - 1);
          ctx.lineTo(xe, groundAt(xe) + 3);
          ctx.lineTo(x, groundAt(x) + 3);
          ctx.closePath();
        }
      } else {
        ctx.moveTo(x0, groundAt(x0) - 1);
        for (let x = x0 + 48; x < x1; x += 48) ctx.lineTo(x, groundAt(x) - 1);
        ctx.lineTo(x1, groundAt(x1) - 1);
        ctx.lineTo(x1, groundAt(x1) + 3);
        for (let x = x1 - 48; x > x0; x -= 48) ctx.lineTo(x, groundAt(x) + 3);
        ctx.lineTo(x0, groundAt(x0) + 3);
        ctx.closePath();
      }
      ctx.fill();
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
    // 바퀴 둘을 멀리 떼고 그 사이에 삼각 프레임을 세운다. 돌·청동·강철은
    // 팔이 평형추를 달고 돈다(던진다) — 화약·기계는 **던지지 않고 쏜다**,
    // 팔 대신 포신 하나가 가대 위에 얹힌다. 던지는 병기와 쏘는 병기는
    // 사거리·소리도 다르지만 여기서는 실루엣만 가른다.
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
      if (era >= 3) {
        // 대포·곡사포 — 가대 위에 얹힌 포신. 곡사포(기계)는 더 가파르게 쳐든다
        this.addBar(mx, axY - 5, dir * 0.60, -0.80, h * 0.34, 0, 5.4, 4.6); // 가대
        const ba = era >= 4 ? 0.60 : 0.26;   // 양수 = 위로 쳐든다((ux,uy)=(cos,-sin) 규칙)
        const bc = Math.cos(ba), bs = Math.sin(ba);
        const blen = h * (era >= 4 ? 0.92 : 0.82);
        const brX = mx - dir * bc * 5, brY = axY - 5 - bs * 5;
        this.addBar(brX, brY, dir * bc, -bs, blen, 9, 6.6, 4.4);        // 포신
        this.addBar(brX, brY, dir * bc, -bs, 7, 9, 8, 8);               // 약실(포미)
        const tipX = brX + dir * bc * blen, tipY = brY - bs * blen;
        this.smY[i] = brY - 12; this.smR[i] = w * 0.22;
        this.wtX[i] = tipX; this.wtY[i] = tipY;
        this.addEraBanner(mx, mastY, w, era, dir);
        return;
      }
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
    const eI = eraIdx(era);
    const legH = h * (archer ? 0.30 : (giant ? 0.33 : 0.33));
    const torsoH = h * (giant ? 0.44 : 0.40);
    const headR = w * (giant ? 0.22 : (archer ? 0.27 : 0.28)) * ERA_HEAD[eI];
    const hipY = gy - legH;
    const lean = giant ? 0.22 : (kind === C.U_SWORD ? 0.15 : (archer ? -0.28 : 0.03));
    const lnv = Math.sqrt(lean * lean + 1);
    const ux = (dir * lean) / lnv, uy = -1 / lnv;
    const bx0 = x + lunge;
    const shX = bx0 + ux * torsoH, shY = hipY + uy * torsoH;
    // 어깨·허리·다리·무기가 **시대마다 다른 덩어리**가 된다.
    // 돌 시대는 좁고 마르고, 기계 시대는 넓고 굵다. 장식이 아니라 이게 실루엣이다.
    const bwT = w * (giant ? 0.94 : (archer ? 0.44 : 0.52)) * ERA_SHOULDER[eI];
    const bwH = w * (giant ? 0.60 : (archer ? 0.36 : 0.42)) * (0.55 + 0.45 * ERA_SHOULDER[eI]);
    const ew = ERA_WEAP[eI];

    // 다리 — 걷는 위상은 x 에서 나온다. 멈추면 저절로 멎는다
    const lw = (giant ? w * 0.23 : Math.max(3, w * 0.16)) * ERA_LEG[eI];
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
    this.addHead(hx, hy, headR, eI);

    const handY = shY + torsoH * 0.28;
    const hx0 = shX + dir * bwT * 0.46;

    if (kind === C.U_SWORD) {
      // 무기 자체가 시대마다 다르다 — spec-v4 §1: 돌도끼 → 검+방패 → 검+방패
      // (판금은 addEraGear 가 뿔·견갑·망토로 판다) → 총검 라이플 → 각진 동력 블레이드.
      // 방패는 청동·강철에만 있다 — 총 든 손엔 방패가 없고, 파워아머는 방패가 없어도 된다.
      if (era === 0) {
        // 돌도끼병 — 방패 없이 짧고 두꺼운 돌도끼. 내려찍는다
        const a = atk > 0 ? -0.70 : 0.95;
        const c = Math.cos(a), s = Math.sin(a);
        const cl = h * 0.40 * ew;
        this.addBar(hx0, handY, dir * c, -s, cl, 6, 3.4, 2.6);
        this.addSpike(hx0 + dir * c * cl, handY - s * cl, dir * c, -s, 11, 6);  // 돌도끼날(쐐기)
        this.wtX[i] = hx0 + dir * c * (cl + 11); this.wtY[i] = handY - s * (cl + 11);
      } else if (era === 3) {
        // 총검병 — 방패 없이 총검 라이플. 겨눈 자세라 거의 수평이다
        const a = atk > 0 ? -0.08 : 0.06;
        const c = Math.cos(a), s = Math.sin(a);
        const len = h * 0.82 * ew + (atk > 0 ? 8 : 0);
        const px = bx0 + dir * w * 0.08;
        this.addBar(px, handY, dir * c, -s, len, w * 0.30, 2.1, 1.7);
        this.addSpike(px + dir * c * len, handY - s * len, dir * c, -s, 9, 2.5);  // 총검 날
        this.wtX[i] = px + dir * c * (len + 9); this.wtY[i] = handY - s * (len + 9);
      } else if (era === 4) {
        // 강습병 — 방패 없이 두껍고 각진 동력 블레이드. 파워아머다운 짧고 굵은 실루엣
        const a = atk > 0 ? -0.62 : 1.18;
        const c = Math.cos(a), s = Math.sin(a);
        const cl = h * 0.44 * ew;
        this.addBar(hx0, handY - 3, dir * c, -s, cl, 6, 5.4, 3.8);
        this.wtX[i] = hx0 + dir * c * cl; this.wtY[i] = handY - 3 - s * cl;
      } else {
        // 청동·강철 — 검 + 원형 방패
        this.addCircle(bx0 + dir * w * 0.44, hipY - torsoH * 0.44, w * 0.36);
        const a = atk > 0 ? -0.62 : 1.18;
        const c = Math.cos(a), s = Math.sin(a);
        this.addBar(hx0, handY - 3, dir * c, -s, h * 0.50 * ew, 8, 2.9 * ew, 1.4);
        this.addBar(hx0, handY - 3, s, dir * c, 7, 7, 2, 2);        // 손잡이 가드
        this.addCircle(hx0 - dir * c * 8, handY - 3 + s * 8, 2.4);  // 손잡이 끝
        this.wtX[i] = hx0 + dir * c * h * 0.50 * ew; this.wtY[i] = handY - 3 - s * h * 0.50 * ew;
      }
    } else if (kind === C.U_SPEAR) {
      // 창 — **몸 길이보다 앞으로 훨씬 더 나간다.** 이게 사거리다
      const a = atk > 0 ? 0.02 : 0.15;
      const c = Math.cos(a), s = Math.sin(a);
      const len = h * 1.12 * ew + (atk > 0 ? 12 : 0);
      const px = bx0 + dir * w * 0.10;
      this.addBar(px, handY, dir * c, -s, len, w * 0.72, 2.3, 2.1);
      this.addSpike(px + dir * c * len, handY - s * len, dir * c, -s, 15, 4.6);
      this.addSpike(px - dir * c * w * 0.72, handY + s * w * 0.72, -dir * c, s, 7, 2.6); // 물미
      // 등 뒤 네모 방패 — 창병만의 세로 판
      this.addBar(shX - dir * bwT * 0.55, shY + 2, ux, uy, torsoH * 0.86, 0, bwT * 0.20, bwT * 0.16);
      this.wtX[i] = px + dir * c * (len + 15); this.wtY[i] = handY - s * (len + 15);
    } else if (kind === C.U_ARCHER) {
      // 사거리 무기의 **구조**가 시대마다 다르다 — 활(선으로, addUnitLines) →
      // 석궁(짧고 단단한 틀) → 총(어깨에 견착한 장총, 화살통이 없다).
      if (era === 2) {
        // 석궁병 — 몸 앞에 짧은 총열대 + 가로 활틀. 화살통 대신 이 틀이 표식이다
        const bxx = shX + dir * w * 0.30, byy = handY - torsoH * 0.10;
        this.addBar(bxx, byy, dir, 0, h * 0.46 * ew, h * 0.10, 2.2, 1.8);
        this.addBar(bxx + dir * h * 0.30 * ew, byy, -uy, ux, h * 0.26 * ew, h * 0.13, 2.4, 1.6);
        this.wtX[i] = bxx + dir * h * 0.46 * ew; this.wtY[i] = byy;
      } else if (era >= 3) {
        // 머스킷병·저격수 — 어깨에 견착한 장총. 화살통이 없다.
        // 저격수(기계)는 조준경이 붙고 총열을 더 곧게 편다
        const a = era >= 4 ? -0.16 : -0.04;
        const c = Math.cos(a), s = Math.sin(a);
        const bxx = shX + dir * w * 0.16, byy = handY - torsoH * 0.06;
        const len = h * 0.60 * ew;
        this.addBar(bxx, byy, dir * c, -s, len, h * 0.16, 2.4, 1.7);
        if (era >= 4) {
          this.addBar(bxx + dir * c * len * 0.5, byy - s * len * 0.5, -s, -dir * c, 5, 2, 1.6, 1.6); // 조준경
        }
        this.wtX[i] = bxx + dir * c * len; this.wtY[i] = byy - s * len;
      } else {
        // 투석꾼·청동궁수 — 등에 멘 화살통과 **위로 삐죽한 화살깃**
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
      }
    } else {
      // 거인 — 어깨판 · 등의 혹 · 끝이 부푼 몽둥이. 목이 없다
      const sx2 = shX, sy2 = shY;
      this.addTrap(sx2, sy2 - h * 0.045, sy2 + h * 0.055, w * 0.88, w * 1.06, dir * 2);
      this.addCircle(sx2 - dir * w * 0.42, sy2 + h * 0.01, w * 0.27);   // 등 혹
      const a = atk > 0 ? -0.62 : 0.66;
      const c = Math.cos(a), s = Math.sin(a);
      const cl = h * 0.52 * ew;
      this.addBar(hx0, handY, dir * c, -s, cl, 7, 3.4, 8.5);
      this.addCircle(hx0 + dir * c * cl, handY - s * cl, w * 0.21 * ew);     // 몽둥이 대가리
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
    const eI = eraIdx(era);
    const legH = h * (archer ? 0.30 : 0.33);
    const torsoH = h * (giant ? 0.44 : 0.40);
    const headR = w * (giant ? 0.22 : (archer ? 0.27 : 0.28)) * ERA_HEAD[eI];
    const hipY = gy - legH;
    const lean = giant ? 0.22 : (kind === C.U_SWORD ? 0.15 : (archer ? -0.28 : 0.03));
    const lnv = Math.sqrt(lean * lean + 1);
    const ux = (dir * lean) / lnv, uy = -1 / lnv;
    const bx0 = x + lunge;
    const shX = bx0 + ux * torsoH, shY = hipY + uy * torsoH;
    const hgap = giant ? headR * 0.72 : headR * 0.92;
    const hx = shX + ux * hgap + dir * w * 0.03;
    const hy = shY + uy * hgap;

    if (kind === C.U_SWORD && (era === 1 || era === 2)) {
      // 방패 보스 — 방패가 있는 시대(청동·강철)에만. 돌·화약·기계는 방패가 없다
      this.addCircle(bx0 + dir * w * 0.44, hipY - torsoH * 0.44, w * 0.13);
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
    const eI = eraIdx(game.uEra[i]);
    const legH = h * (archer ? 0.30 : 0.33);
    const torsoH = h * (giant ? 0.44 : 0.40);
    const hipY = gy - legH;
    const lean = giant ? 0.22 : (kind === C.U_SWORD ? 0.15 : (archer ? -0.28 : 0.03));
    const lnv = Math.sqrt(lean * lean + 1);
    const ux = (dir * lean) / lnv, uy = -1 / lnv;
    const bx0 = x + lunge;
    const shX = bx0 + ux * torsoH, shY = hipY + uy * torsoH;
    const bwT = w * (giant ? 0.94 : (archer ? 0.44 : 0.52)) * ERA_SHOULDER[eI];
    const bwH = w * (giant ? 0.60 : (archer ? 0.36 : 0.42)) * (0.55 + 0.45 * ERA_SHOULDER[eI]);
    const nx = -uy, ny = ux;
    ctx.moveTo(bx0 - nx * bwH * 0.5, hipY - ny * bwH * 0.5);
    ctx.lineTo(shX - nx * bwT * 0.5, shY - ny * bwT * 0.5);
    ctx.lineTo(shX + nx * bwT * 0.5, shY + ny * bwT * 0.5);
    ctx.lineTo(bx0 + nx * bwH * 0.5, hipY + ny * bwH * 0.5);
    ctx.closePath();
    if (kind === C.U_SWORD && (game.uEra[i] === 1 || game.uEra[i] === 2)) {
      this.addCircle(bx0 + dir * w * 0.44, hipY - torsoH * 0.44, w * 0.36);
    }
    // 머리 — 시대마다 모양이 다르므로 윤곽에도 넣는다. 밀집했을 때
    // 머리 줄만 봐도 몇 기가 어느 시대인지가 읽힌다
    const headR = w * (giant ? 0.22 : (archer ? 0.27 : 0.28)) * ERA_HEAD[eI];
    const hgap = giant ? headR * 0.72 : headR * 0.92;
    this.addHead(shX + ux * hgap + dir * w * 0.03, shY + uy * hgap, headR, eI);
  }

  // 머리 — **시대의 얼굴이다.** 원 → 원 → 뿔 자리 → 챙 넓은 사다리꼴 → 각진 면갑.
  // 장식을 얹는 대신 머리 자체의 윤곽을 바꾼다. 작게 그려도 안 사라진다.
  addHead(hx, hy, r, eI) {
    const ctx = this.ctx;
    if (eI >= 4) {                       // 기계 — 각진 통짜 면갑
      ctx.rect(hx - r * 1.02, hy - r * 1.02, r * 2.04, r * 2.04);
    } else if (eI === 3) {               // 화약 — 아래가 넓은 사다리꼴 (챙)
      this.addTrap(hx, hy - r * 1.05, hy + r * 1.05, r * 1.35, r * 2.3, 0);
    } else {
      this.addCircle(hx, hy, r);
    }
  }

  // 선으로만 읽히는 것 — 활과 시위. 채우면 활이 안 보인다
  // 석궁(강철)·총(화약·기계)은 activeUnitFill 이 이미 채운 도형으로 그린다 —
  // 활대가 없으니 여기서는 그릴 게 없다.
  addUnitLines(game, i, dir) {
    const ctx = this.ctx;
    if (game.uKind[i] !== C.U_ARCHER) return;
    if (game.uEra[i] >= 2) return;
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
    const R = h * 0.36 * ERA_WEAP[eraIdx(game.uEra[i])];
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
  // 해일 벽면의 표면 높이. q>0 이 진행 방향 앞쪽이다.
  // 앞(u)은 3제곱이라 마지막에 뚝 떨어진다 — 그래서 **벽면**으로 보인다.
  // 뒤(v)는 1.5제곱이라 길게 끌린다 — 그래서 꼬리가 생긴다.
  tideSurf(q, RF, RBK, hgt) {
    let k;
    if (q > 0) { const u = q / RF; k = u >= 1 ? 0 : 1 - u * u * u; }
    else { const v = -q / RBK; k = v >= 1 ? 0 : 1 - Math.pow(v, 1.5); }
    return -hgt * k;
  }

  drawSkillFx(game) {
    // **여기에 전면 장막(fillRect 한 장)이 있었다. 재서 걷어냈다.**
    // 스킬이 도는 동안 판 전체를 한 겹 눌러 두면 도형이 두 배로 밝게 읽힌다 —
    // 그림은 실제로 좋아졌는데, 3분 실측에서 **버려진 프레임이 1000프레임당
    // 1.5개에서 4.1개로 늘었다.** JS 드로우 시간은 그대로였다(p95 1.6→1.8ms).
    // 즉 비용이 JS 가 아니라 **래스터 면적**이었다 — 이 파일이 이미 한 번 배운 교훈이다.
    // 전면 합성은 Canvas 2D 에서 제일 비싸고 GPU 에서 제일 싸다. WebGL 로 옮길 때
    // 되살릴 것 1순위이지, 2D 폴백에 남길 것이 아니다.
    // 양쪽을 **같은 코드로** 그리되 색·위치·진행 방향만 진영에서 받는다.
    // 코드를 두 벌로 복사하면 한쪽만 고쳐지는 날이 반드시 온다.
    for (let s = 0; s < 2; s++) this.drawSkillFxSide(game, s);
  }

  // ── 흉터 — 스킬이 지나갔다는 증거 ───────────────────────────
  // 연출이 끝나면 40프레임 만에 흔적 없이 사라지던 것이 "가볍다"의 절반이었다.
  // 여기 있는 것은 전부 **지면에 남는 것**이라 유닛보다 먼저 그린다 (유닛이 그 위를 밟는다).
  // 색은 진영에서 받고, 같은 색끼리 묶어 종류마다 한 번씩만 칠한다.
  drawScars(game) {
    const ctx = this.ctx;
    let any = 0;
    for (let k = 0; k < 2 * C.SKILL_COUNT; k++) if (this.scarLife[k] > 0) { any = 1; break; }
    if (!any) return;

    for (let side = 0; side < 2; side++) {
      const mine = side === SIDE_L;
      // 자국도 **누가 남겼는지**를 색으로 말한다. 스킬 연출과 같은 규칙이다 —
      // 내 것은 SKILL_COL, 적 것은 COL_THREAT. 흰 심(RB)만 진영을 유지한다.
      const RB = mine ? C.RAMP_PLAYER : C.RAMP_THREAT;
      const dir = mine ? 1 : -1;
      const base = side * C.SKILL_COUNT;
      const RA = SK_RAMP[base + C.SK_TIDE];
      const RV = SK_RAMP[base + C.SK_VOLLEY];
      const RY = SK_RAMP[base + C.SK_RALLY];

      // 해일이 훑고 간 자리 — 젖은 땅. 물러난 물가 선이 쏜 쪽으로 천천히 끌려간다
      let L = this.scarLife[base + C.SK_TIDE];
      if (L > 0) {
        const a = L / SCAR_F;                       // 1 → 0
        const s = 1 - a;
        const x0 = mine ? this.scarX[base + C.SK_TIDE] - 300 * s : C.VIEW_W;
        const x1 = mine ? C.VIEW_W : this.scarX[base + C.SK_TIDE] + 300 * s;
        const xa = mine ? x0 : 0, xb = mine ? C.VIEW_W : x1;
        // 젖은 띠 — 지면 바로 아래를 어둡게. 물이 핥고 간 자리다
        ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.62 * a)];
        ctx.beginPath();
        ctx.moveTo(xa, groundAt(xa));
        for (let x = xa; x <= xb; x += 16) ctx.lineTo(x, groundAt(x));
        for (let x = xb; x >= xa; x -= 16) ctx.lineTo(x, groundAt(x) + 15);
        ctx.closePath();
        ctx.fill();
        // 물러나는 포말 선 — 어디까지 잠겼었는지가 이 선 하나로 읽힌다
        const edge = mine ? x0 : x1;
        ctx.strokeStyle = RB[C.rampIndex(0.5 * a)];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(edge, groundAt(edge) - 9);
        ctx.lineTo(edge, groundAt(edge) + 5);
        ctx.stroke();
        // 떠밀려 온 잔해 — 굵기가 아니라 개수로 무게를 낸다
        ctx.fillStyle = RA[C.rampIndex(0.34 * a)];
        ctx.beginPath();
        for (let i = 0; i < CRATER_N; i++) {
          const x = xa + (xb - xa) * ((i * 7919 % 101) / 101);
          const g = groundAt(x);
          const w = 3 + this.cSz[i] * 5;
          ctx.rect(x, g - 2 - this.cSz[i] * 3, w, 2.4);
        }
        ctx.fill();
        ctx.lineWidth = C.STROKE;
      }

      // 화살비가 파낸 지면 — 구덩이와 아직 박혀 있는 화살대
      L = this.scarLife[base + C.SK_VOLLEY];
      if (L > 0) {
        const a = L / SCAR_F;
        const bx = this.scarX[base + C.SK_VOLLEY];
        // 반경도 등급을 따른다 — 표적과 자국이 어긋나면 화면이 거짓말을 한다
        const tr = this.fxTier[base + C.SK_VOLLEY];
        const r = (C.VOLLEY_TIER_R && C.VOLLEY_TIER_R[tr]) || C.VOLLEY_RADIUS;
        // 구덩이 — 지면을 실제로 파낸다. 어두운 색 하나로 한 번에
        ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.78 * a)];
        ctx.beginPath();
        for (let i = 0; i < CRATER_N; i++) {
          const x = bx + this.cOff[i] * r;
          const g = groundAt(x);
          const w = 7 + this.cSz[i] * 11;
          ctx.moveTo(x - w * 0.5, g);
          ctx.lineTo(x - w * 0.2, g + 4 + this.cSz[i] * 4);
          ctx.lineTo(x + w * 0.25, g + 3 + this.cSz[i] * 3);
          ctx.lineTo(x + w * 0.5, g);
          ctx.closePath();
        }
        ctx.fill();
        // 박힌 화살대 — 쏜 방향으로 기울어 있다. 누가 쐈는지가 각도로 남는다
        ctx.fillStyle = RV[C.rampIndex(0.72 * a)];
        ctx.beginPath();
        for (let i = 0; i < CRATER_N; i++) {
          const x = bx + this.cOff[i] * r * 0.92;
          const g = groundAt(x);
          const tilt = (0.20 + this.cSz[i] * 0.16) * dir;
          this.addBar(x, g, tilt, -1, 11 + this.cSz[i] * 7, 0, 1.1, 0.7);
        }
        ctx.fill();
      }

      // 증원이 세운 집결 표식 — 깃대 하나가 땅에 남는다
      L = this.scarLife[base + C.SK_RALLY];
      if (L > 0) {
        const a = L / SCAR_F;
        const bx = this.scarX[base + C.SK_RALLY];
        const g = groundAt(bx);
        ctx.fillStyle = RY[C.rampIndex(0.62 * a)];
        ctx.beginPath();
        ctx.rect(bx - 1.5, g - 40, 3, 40);
        ctx.moveTo(bx, g - 38);
        ctx.lineTo(bx + dir * 20, g - 33);
        ctx.lineTo(bx, g - 28);
        ctx.closePath();
        for (let i = 0; i < 3; i++) ctx.rect(bx - 15 + i * 12, g - 2, 7, 2.5);
        ctx.fill();
        ctx.strokeStyle = RY[C.rampIndex(0.34 * a)];
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(bx + 34, g);
        ctx.ellipse(bx, g, 34, 10, 0, 0, TAU);
        ctx.stroke();
        ctx.lineWidth = C.STROKE;
      }
    }
  }

  drawSkillFxSide(game, side) {
    const ctx = this.ctx;
    const mine = side === SIDE_L;
    // **색이 스킬을 말하고, 진영은 색의 정체를 말한다.**
    //   내 스킬  = SKILL_COL[해일 물빛 · 화살비 호박 · 증원 연둣빛]
    //   적 스킬  = COL_THREAT 하나 (규칙 2 — 이 색이 뜨면 뜻은 "곧 맞는다" 뿐이다)
    // 예전에는 양쪽이 흰색/회청색이었고 강조가 금색/붉은색이었다. 그래서
    // 「해일」에 물이 없었고, 적 화살비가 배경 빗줄기와 같은 회색이었다.
    const SC = SK_RAMP;
    const RB = mine ? C.RAMP_PLAYER : C.RAMP_THREAT;      // 거품·마루 (물의 흰 살)
    const RA = mine ? C.RAMP_BONUS : C.RAMP_THREAT;       // 강조
    const dir = mine ? 1 : -1;                            // 진행 방향
    const base = side * C.SKILL_COUNT;

    // ══ 해일 ══ 예고: 기지 앞이 부풀고 압력선이 먼저 달린다
    //            발동: **물의 벽.** 뒤가 안 보인다 — 가리는 것이 곧 무게다
    //            여파: 물러난 물이 젖은 땅을 남긴다 (drawScars)
    let f = this.fxSkill[base + C.SK_TIDE];
    if (f > 0) {
      const t = 1 - f / FX_TIDE_F;
      const ox = mine ? C.SPAWN_L_X : C.SPAWN_R_X;      // 쏜 쪽
      const og = groundAt(ox);

      // ── 1막 예고 ── 착탄 전에 "온다"는 것이 먼저 보여야 크기가 다르게 읽힌다
      if (t < T_TIDE_TELE * 1.5) {
        const tt = t / T_TIDE_TELE;
        const a = tt < 1 ? tt : 1 - (tt - 1) / 0.5;
        const aa = a < 0 ? 0 : (a > 1 ? 1 : a);
        // 솟는 물기둥 — 기지 앞의 지면이 부푼다
        ctx.fillStyle = RA[C.rampIndex(0.60 * aa)];
        ctx.beginPath();
        const ch = 104 * easeOutCubic(tt < 1 ? tt : 1);
        ctx.moveTo(ox - dir * 58, og);
        ctx.lineTo(ox - dir * 34, og - ch * 0.72);
        ctx.lineTo(ox + dir * 6, og - ch);
        ctx.lineTo(ox + dir * 46, og - ch * 0.55);
        ctx.lineTo(ox + dir * 62, og);
        ctx.closePath();
        ctx.fill();
        // 압력선 — 물보다 먼저 달려가는 결. 이것이 실제 예고다
        ctx.strokeStyle = RB[C.rampIndex(0.66 * aa)];
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const ph = tt * 1.45 + this.vDelay[i] * 0.85;
          const p = ph - (ph | 0);
          const x0 = ox + dir * p * (C.VIEW_W * 0.92);
          const len = 34 + this.vOff[i] * 30;
          const y = groundAt(x0) - 10 - i * 8;
          ctx.moveTo(x0, y);
          ctx.lineTo(x0 - dir * (len < 12 ? 12 : len), y);
        }
        ctx.stroke();
        ctx.lineWidth = C.STROKE;
      }

      // ── 2막 발동 ── 물의 벽이 판을 훑는다
      const H0 = T_TIDE_TELE * 0.62, H1 = T_TIDE_HIT + 0.05;
      if (t >= H0 && t < H1) {
        const ht = (t - H0) / (H1 - H0);
        // 앞은 짧고 서고(벽면), 뒤는 길게 끈다(꼬리). 마루가 아니라 **벽**이어야 한다
        const RF = 150, RBK = 330;
        const span = C.VIEW_W + RF + RBK;
        const cx = mine ? -RBK + span * ht : C.VIEW_W + RBK - span * ht;
        const hgt = 138 + 104 * Math.sin(Math.PI * (ht > 1 ? 1 : ht));
        const Q0 = -RBK, Q1 = RF, STEP = 14;
        // 표면 높이는 tideSurf() 가 준다. **여기서 화살표 함수를 만들면 매 프레임 할당이다** —
        // 클로저 하나가 60Hz × 두 진영이면 초당 120개의 쓰레기가 된다. 메서드로 뺀다.

        // (a) 몸통 — **배경색으로 꽉 채운다.** 뒤에 선 유닛이 실제로 가려진다.
        //     반투명한 붉은 덩어리는 앞을 지나가도 아무것도 안 가려서 무게가 없었다.
        ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.94)];
        ctx.beginPath();
        ctx.moveTo(cx + Q0 * dir, C.VIEW_H);
        for (let q = Q0; q <= Q1; q += STEP) { const px = cx + q * dir; ctx.lineTo(px, groundAt(px) + this.tideSurf(q, RF, RBK, hgt)); }
        ctx.lineTo(cx + Q1 * dir, C.VIEW_H);
        ctx.closePath();
        ctx.fill();

        // (b) **물이다.** 플레이어가 정확히 짚었다 — "이름이 「해일」인데 물이 없습니다."
        //     예전에는 붉은 띠 한 줄이었고 나머지는 배경색 덩어리였다. 물 한 방울이
        //     없었으니 이름이 거짓말이었다. 이제 벽 전체가 물빛으로 찬다:
        //     깊은 살(수면부터 바닥까지) 위에 밝은 표층(52px)을 얹는다.
        //     내 것은 SKILL_COL[해일]의 물빛, 적 것은 COL_THREAT 이다.
        const WT = SC[base + C.SK_TIDE];
        // 거품은 **양쪽 다 흰색**이다. 물이라는 것은 거품이 말하고,
        // 누구의 물인지는 몸 색(WT)이 말한다 — 그래야 적 해일도 '물'로 읽힌다.
        const FOAM = C.RAMP_PLAYER;
        ctx.fillStyle = WT[C.rampIndex(0.34)];
        ctx.beginPath();
        ctx.moveTo(cx + Q0 * dir, C.VIEW_H);
        for (let q = Q0; q <= Q1; q += STEP) { const px = cx + q * dir; ctx.lineTo(px, groundAt(px) + this.tideSurf(q, RF, RBK, hgt)); }
        ctx.lineTo(cx + Q1 * dir, C.VIEW_H);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = WT[C.rampIndex(0.62)];
        ctx.beginPath();
        for (let q = Q0; q <= Q1; q += STEP) { const px = cx + q * dir; ctx.lineTo(px, groundAt(px) + this.tideSurf(q, RF, RBK, hgt)); }
        for (let q = Q1; q >= Q0; q -= STEP) { const px = cx + q * dir; ctx.lineTo(px, groundAt(px) + this.tideSurf(q, RF, RBK, hgt) + 52); }
        ctx.closePath();
        ctx.fill();

        // (c) 물속의 결 — 세로 소용돌이 + 가로로 끌리는 흐름선.
        //     통짜 덩어리가 아니라 **흐르는 것**으로 읽혀야 물이 된다
        ctx.strokeStyle = RB[C.rampIndex(0.26)];
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 12; i++) {
          const q = Q0 + (Q1 - Q0) * ((i * 61 % 100) / 100);
          const px = cx + q * dir;
          const sy = groundAt(px) + this.tideSurf(q, RF, RBK, hgt);
          ctx.moveTo(px, sy + 8 + this.vOff[i] * 10);
          ctx.lineTo(px + dir * (10 + this.vOff[i] * 16), sy + 62 + this.vDelay[i] * 40);
        }
        // 가로 흐름 — 물이 어느 쪽으로 가는지가 이 선들로 읽힌다
        for (let i = 0; i < 9; i++) {
          const q = Q0 + (Q1 - Q0) * this.vDelay[i];
          const px = cx + q * dir;
          const sy = groundAt(px) + this.tideSurf(q, RF, RBK, hgt) + 14 + i * 7;
          const ln = 40 + this.vOff[i] * 34;
          ctx.moveTo(px, sy);
          ctx.lineTo(px - dir * (ln < 16 ? 16 : ln), sy + 3);
        }
        ctx.stroke();

        // (d) 마루의 흰 거품 — 벽의 윗날. 이 선이 굵어야 물이 무거워 보인다
        ctx.strokeStyle = FOAM[C.rampIndex(0.92)];
        ctx.lineWidth = 5;
        ctx.beginPath();
        for (let q = Q0; q <= Q1; q += STEP) {
          const px = cx + q * dir;
          const py = groundAt(px) + this.tideSurf(q, RF, RBK, hgt);
          if (q === Q0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.lineWidth = C.STROKE;

        // (e) 말려 넘어가는 마루 끝 — 파도가 부서지는 그 모양
        ctx.fillStyle = FOAM[C.rampIndex(0.80)];
        ctx.beginPath();
        for (let i = 0; i < 7; i++) {
          const q = -18 - i * 24;
          const px = cx + q * dir;
          const py = groundAt(px) + this.tideSurf(q, RF, RBK, hgt);
          const w = 22 - i * 2;
          ctx.moveTo(px, py);
          ctx.lineTo(px + dir * w, py - 4 - i * 1.5);
          ctx.lineTo(px + dir * w * 0.5, py + 13 + i * 2);
          ctx.closePath();
        }
        ctx.fill();

        // (f) 물보라 — 벽 앞으로 튄다. 개수로 무게를 낸다
        ctx.fillStyle = FOAM[C.rampIndex(0.70)];
        ctx.beginPath();
        for (let i = 0; i < 22; i++) {
          const q = 10 + this.vDelay[i % VOLLEY_N] * 120;
          const px = cx + q * dir;
          const py = groundAt(px) - hgt * (0.35 + this.vOff[i % VOLLEY_N] * 0.55) - 10 - i * 3;
          const sz = 5.5 - i * 0.14;
          ctx.rect(px, py, sz, sz);
        }
        ctx.fill();

        // (g) **밀어냄** — 2등급부터 적이 실제로 뒤로 간다 (C.TIDE_PUSH_PX).
        //     시뮬이 하는 일을 화면이 안 그리면 "넉백이 안 보인다"가 된다.
        //     벽 앞으로 뻗는 갈매기표의 길이가 곧 밀리는 거리다.
        const tier = this.fxTier[base + C.SK_TIDE];
        const push = (C.TIDE_PUSH_PX && C.TIDE_PUSH_PX[tier]) || 0;
        if (push > 0) {
          ctx.fillStyle = FOAM[C.rampIndex(0.92)];
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const px = cx + (Q1 - 6) * dir;
            const py = groundAt(px) - 18 - i * 22;
            this.addBar(px, py, dir, 0, push, 0, 2.6, 2.6);
            this.addSpike(px + dir * push, py, dir, 0, 12, 7);
          }
          ctx.fill();
        }
      }

      // ── 3막 여파 ── 물이 빠지며 지면을 훑는다 (남는 자국은 drawScars 가 맡는다)
      if (t >= T_TIDE_HIT) {
        const at = (t - T_TIDE_HIT) / (1 - T_TIDE_HIT);
        const a = 1 - at;
        ctx.fillStyle = RB[C.rampIndex(0.34 * a)];
        ctx.beginPath();
        for (let i = 0; i < 18; i++) {
          const x = C.VIEW_W * ((i * 53 % 100) / 100);
          const g = groundAt(x);
          ctx.rect(x - dir * at * 90, g - 4 - this.vOff[i % VOLLEY_N] * 12 * a, 12 + this.cSz[i % CRATER_N] * 14, 2.5);
        }
        ctx.fill();
      }
    }

    // ══ 화살비 ══ 예고: 표적이 지면에 그려지고 고리가 조여든다
    //              발동: 화살이 꽂히고 지면이 튄다
    //              여파: 먼지가 오르고 화살대가 박힌 채 남는다 (drawScars)
    f = this.fxSkill[base + C.SK_VOLLEY];
    if (f > 0) {
      const t = 1 - f / FX_VOLLEY_F;
      const front = this.fxSkillX[base + C.SK_VOLLEY];
      // **등급이 오르면 떨어지는 자리가 는다** — 전선 → 전선+상대 후방 → 셋.
      // 화면이 한 군데만 그리면, 후방에서 사라지는 증원이 설명되지 않는다.
      // 좌표는 volleyZoneX() 하나로만 읽는다 — game.doVolley 와 같은 출처다.
      const tier = this.fxTier[base + C.SK_VOLLEY];
      const R0 = (C.VOLLEY_TIER_R && C.VOLLEY_TIER_R[tier]) || C.VOLLEY_RADIUS;
      const ZN = (C.VOLLEY_TIER_ZONES && C.VOLLEY_TIER_ZONES[tier]) || 1;
      const VC = SC[base + C.SK_VOLLEY];               // 화살비의 색 (내 것 / 적 것)

      // ── 1막 예고 ── **어디에 떨어지는지가 떨어지기 전에** 보여야 한다
      if (t < T_VOL_TELE) {
        const tt = t / T_VOL_TELE;
        const k = 2.6 - 1.6 * easeOutCubic(tt);
        // 지면이 물든다 — 여기가 위험 구역이다
        ctx.fillStyle = VC[C.rampIndex(0.24 * tt)];
        ctx.beginPath();
        for (let z = 0; z < ZN; z++) {
          const bx = this.volleyZoneX(side, z, front), R = z === 0 ? R0 : R0 * 0.75;
          const bg = groundAt(bx);
          ctx.moveTo(bx + R, bg - 2);
          ctx.ellipse(bx, bg - 2, R, 20, 0, 0, TAU);
        }
        ctx.fill();
        // 조여드는 고리 — 2.6배에서 1배로. 조여드는 동안 굵어진다
        ctx.strokeStyle = VC[C.rampIndex(0.40 + 0.6 * tt)];
        ctx.lineWidth = 1.5 + 3 * tt;
        ctx.beginPath();
        for (let z = 0; z < ZN; z++) {
          const bx = this.volleyZoneX(side, z, front), R = z === 0 ? R0 : R0 * 0.75;
          const bg = groundAt(bx);
          ctx.moveTo(bx + R * k, bg - 2);
          ctx.ellipse(bx, bg - 2, R * k, 20 * k, 0, 0, TAU);
        }
        ctx.stroke();
        // 표적 기둥과 눈금 — 폭이 얼마인지가 읽힌다
        ctx.strokeStyle = VC[C.rampIndex(0.9 * tt)];
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        for (let z = 0; z < ZN; z++) {
          const bx = this.volleyZoneX(side, z, front), R = z === 0 ? R0 : R0 * 0.75;
          for (let s = -1; s <= 1; s += 2) {
            const ex = bx + s * R;
            ctx.moveTo(ex, groundAt(ex) - 46 * tt);
            ctx.lineTo(ex, groundAt(ex) + 6);
            ctx.moveTo(ex - s * 14, groundAt(ex) - 46 * tt);
            ctx.lineTo(ex, groundAt(ex) - 46 * tt);
          }
        }
        ctx.stroke();
        // 화면 위에서 들어오는 그림자 — 하늘에서 뭔가 오고 있다
        ctx.strokeStyle = RB[C.rampIndex(0.34 * tt)];
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let z = 0; z < ZN; z++) {
          const bx = this.volleyZoneX(side, z, front), R = z === 0 ? R0 : R0 * 0.75;
          for (let i = z ? 1 : 0; i < VOLLEY_N; i += (z ? 2 : 1)) {
            const x = bx + this.vOff[i] * R * 1.1;
            const y = -30 + tt * 90 + this.vDelay[i] * 40;
            ctx.moveTo(x, y);
            ctx.lineTo(x - 0.22 * dir * 26, y + 26);
          }
        }
        ctx.stroke();
        ctx.lineWidth = C.STROKE;
      }

      // ── 2막 발동 ── 화살이 꽂힌다
      if (t >= T_VOL_TELE * 0.9) {
        const at = (t - T_VOL_TELE * 0.9) / (T_VOL_HIT - T_VOL_TELE * 0.9);
        // 남아 있는 표적 — 발동 중에도 구역이 계속 읽혀야 한다
        ctx.strokeStyle = VC[C.rampIndex(0.6 * (1 - at))];
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let z = 0; z < ZN; z++) {
          const bx = this.volleyZoneX(side, z, front), R = z === 0 ? R0 : R0 * 0.75;
          const bg = groundAt(bx);
          ctx.moveTo(bx + R, bg - 2);
          ctx.ellipse(bx, bg - 2, R, 20, 0, 0, TAU);
        }
        ctx.stroke();
        ctx.lineWidth = C.STROKE;

        // 화살 — 위에서 아래로. 촉이 아래를 향한다. 예전보다 굵고 길다
        ctx.fillStyle = RB[C.rampIndex(0.95)];
        ctx.beginPath();
        for (let z = 0; z < ZN; z++) {
          const bx = this.volleyZoneX(side, z, front), R = z === 0 ? R0 : R0 * 0.75;
          for (let i = z ? 1 : 0; i < VOLLEY_N; i += (z ? 2 : 1)) {
            const lt = (at - this.vDelay[i] * 0.42) / 0.5;
            if (lt <= 0 || lt >= 1) continue;
            const ax = bx + this.vOff[i] * R;
            const g = groundAt(ax);
            const ay = g - 300 + 308 * lt * lt;
            const tilt = 0.22 * dir;
            this.addBar(ax, ay, tilt, 1, 26, 0, 1.8, 0.7);
            this.addSpike(ax + tilt * 26, ay + 26, tilt, 1, 9, 3.0);
          }
        }
        ctx.fill();

        // 착탄 — 흙이 튄다. 예전에는 작은 가시 셋이었다. 지금은 위로 뿜는다
        ctx.fillStyle = VC[C.rampIndex(0.92)];
        ctx.beginPath();
        for (let z = 0; z < ZN; z++) {
          const bx = this.volleyZoneX(side, z, front), R = z === 0 ? R0 : R0 * 0.75;
          for (let i = z ? 1 : 0; i < VOLLEY_N; i += (z ? 2 : 1)) {
            const lt = (at - this.vDelay[i] * 0.42) / 0.5;
            if (lt < 1 || lt > 1.7) continue;
            const p = (lt - 1) / 0.7;
            const ax = bx + this.vOff[i] * R;
            const g = groundAt(ax);
            const h = 26 * (1 - p);
            this.addSpike(ax, g, 0, -1, h + 10, 4.2 * (1 - p) + 1);
            this.addSpike(ax, g, -0.72, -0.7, h * 0.7, 3 * (1 - p) + 0.8);
            this.addSpike(ax, g, 0.72, -0.7, h * 0.7, 3 * (1 - p) + 0.8);
          }
        }
        ctx.fill();

        // 지면 충격파 — 구역 가운데에서 좌우로 퍼지는 밝은 선.
        // 한 발 한 발이 아니라 **한 번의 사건**으로 묶어 주는 것이 이 선이다
        if (at > 0.18 && at < 1.15) {
          const st = (at - 0.18) / 0.97;
          ctx.strokeStyle = RB[C.rampIndex(0.75 * (1 - st))];
          ctx.lineWidth = 4 * (1 - st) + 1;
          ctx.beginPath();
          for (let z = 0; z < ZN; z++) {
            const bx = this.volleyZoneX(side, z, front), R = z === 0 ? R0 : R0 * 0.75;
            for (let s = -1; s <= 1; s += 2) {
              const x0 = bx + s * R * 0.1, x1 = bx + s * R * (0.1 + 1.5 * easeOutCubic(st));
              ctx.moveTo(x0, groundAt(x0) - 3);
              ctx.lineTo(x1, groundAt(x1) - 3);
            }
          }
          ctx.stroke();
          ctx.lineWidth = C.STROKE;
        }
      }

      // ── 3막 여파 ── 먼지가 오른다
      if (t >= T_VOL_HIT * 0.86) {
        const dt = (t - T_VOL_HIT * 0.86) / (1 - T_VOL_HIT * 0.86);
        ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.55 * (1 - dt))];
        ctx.beginPath();
        for (let z = 0; z < ZN; z++) {
          const bx = this.volleyZoneX(side, z, front), R = z === 0 ? R0 : R0 * 0.75;
          for (let i = 0; i < CRATER_N; i++) {
            const x = bx + this.cOff[i] * R;
            const g = groundAt(x);
            const r = (10 + this.cSz[i] * 16) * (0.4 + dt);
            this.addCircle(x + this.cOff[i] * 22 * dt, g - 10 - dt * (34 + this.cSz[i] * 30), r);
          }
        }
        ctx.fill();
      }
    }

    // ══ 증원 ══ 예고: 지면이 갈라지고 먼지가 인다
    //            발동: 빛기둥이 솟고 기치가 선다
    //            여파: 기둥이 가라앉고 집결 표식이 남는다 (drawScars)
    f = this.fxSkill[base + C.SK_RALLY];
    if (f > 0) {
      const t = 1 - f / FX_RALLY_F;
      const bx = this.fxSkillX[base + C.SK_RALLY];
      const g = groundAt(bx);
      // 기둥 개수는 실제 소환 수(doRally() 가 RALLY_TIER_MIX[tier] 합만큼 내는 수)를
      // 따라간다 — 3기일 때 30px 그대로, 5기일 때 18px 로 좁아져 겹치지 않는다.
      const n = this.fxRallyN[side] || C.RALLY_COUNT;
      const SPREAD = 30 * 3 / n;
      const mid = (n - 1) * 0.5;
      const RY = SC[base + C.SK_RALLY];      // 증원의 색 (내 것 = 연둣빛 / 적 것 = 자홍)

      // ── 1막 예고 ── 땅이 먼저 갈라진다. 뭔가 올라온다는 것을 지면이 말한다
      if (t < T_RAL_TELE * 1.3) {
        const tt = t / T_RAL_TELE;
        const a = tt < 1 ? tt : 1 - (tt - 1) / 0.3;
        const aa = a < 0 ? 0 : (a > 1 ? 1 : a);
        ctx.strokeStyle = RY[C.rampIndex(0.9 * aa)];
        ctx.lineWidth = 1.5 + 3 * aa;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const px = bx + (i - mid) * SPREAD;
          const w = 16 * easeOutCubic(tt < 1 ? tt : 1);
          ctx.moveTo(px - w, groundAt(px - w));
          ctx.lineTo(px - w * 0.3, groundAt(px) - 5);
          ctx.lineTo(px + w * 0.3, groundAt(px) + 3);
          ctx.lineTo(px + w, groundAt(px + w));
        }
        ctx.stroke();
        ctx.lineWidth = C.STROKE;
        // 갈라진 틈에서 이는 먼지
        ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.5 * aa)];
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const px = bx + (this.vOff[i] * 1.6) * SPREAD;
          this.addCircle(px, g - 6 - tt * 22 * this.cSz[i % CRATER_N], 5 + this.cSz[i % CRATER_N] * 9);
        }
        ctx.fill();
      }

      // ── 2막 발동 ── 빛기둥. 예전 74px 에서 122px 로, 그리고 기치가 달린다
      if (t >= T_RAL_TELE * 0.72) {
        const rt = (t - T_RAL_TELE * 0.72) / (T_RAL_HIT - T_RAL_TELE * 0.72);
        const fade = rt > 1 ? 1 - (rt - 1) / (1 / (T_RAL_HIT - T_RAL_TELE * 0.72) - 1) : 1;
        const fa = fade < 0 ? 0 : (fade > 1 ? 1 : fade);
        const hgt = 122 * easeOutCubic(rt < 1 ? rt : 1);
        ctx.fillStyle = RY[C.rampIndex(0.95 * fa)];
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const px = bx + (i - mid) * SPREAD;
          const h = hgt * (Math.abs(i - mid) < 0.6 ? 1 : 0.84);
          ctx.rect(px - 6, g - h, 12, h);
          this.addSpike(px, g - h - 20, 0, -1, 22, 8);
          // 기치 — 기둥 꼭대기에 걸린 깃발. 진영 방향으로 날린다
          if (rt > 0.45) {
            const fy = g - h + 12;
            ctx.moveTo(px, fy);
            ctx.lineTo(px + dir * 22, fy + 6);
            ctx.lineTo(px, fy + 13);
            ctx.closePath();
          }
          // 기둥을 타고 오르는 알갱이
          for (let k = 0; k < 4; k++) {
            const py = g - ((t * 190 + k * 24 + i * 13) % 130);
            ctx.rect(px - 11 + k * 6, py, 3.5, 3.5);
          }
        }
        ctx.fill();
        // 기둥 심 — 안쪽이 더 밝으면 빛으로 읽힌다
        ctx.fillStyle = RB[C.rampIndex(0.85 * fa)];
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const px = bx + (i - mid) * SPREAD;
          const h = hgt * (Math.abs(i - mid) < 0.6 ? 1 : 0.84);
          ctx.rect(px - 2, g - h + 6, 4, h - 6);
        }
        ctx.fill();
        // 퍼지는 고리 둘 — 하나는 빠르게 크게, 하나는 늦게 따라온다
        ctx.strokeStyle = RY[C.rampIndex(0.9 * fa)];
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let k = 0; k < 2; k++) {
          const p = rt - k * 0.3;
          if (p <= 0) continue;
          const r = 14 + 96 * easeOutCubic(p > 1 ? 1 : p);
          ctx.moveTo(bx + r, g);
          ctx.ellipse(bx, g, r, r * 0.30, 0, 0, TAU);
        }
        ctx.stroke();
        ctx.lineWidth = C.STROKE;
      }

      // ── 3막 여파 ── 기둥이 가라앉으며 흙먼지가 주저앉는다
      if (t >= T_RAL_HIT) {
        const at = (t - T_RAL_HIT) / (1 - T_RAL_HIT);
        ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.45 * (1 - at))];
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const px = bx + this.vOff[i] * SPREAD * 2.4;
          this.addCircle(px, g - 8 - at * 12, (6 + this.cSz[i % CRATER_N] * 12) * (0.6 + at * 0.8));
        }
        ctx.fill();
      }
    }
  }

  // 화살비의 낙하 구역 — game.doVolley 와 **같은 순서·같은 좌표**여야 한다.
  //   0 전선 · 1 상대 후방 · 2 그 둘의 중간. 반경은 0 번만 R, 나머지는 0.75R.
  // 여기가 어긋나면 화면이 거짓말을 한다 — 표적이 뜬 자리에 피해가 안 들어간다.
  volleyZoneX(side, z, front) {
    if (z === 0) return front;
    const rear = side === SIDE_L ? C.SPAWN_R_X : C.SPAWN_L_X;
    return z === 1 ? rear : (front + rear) * 0.5;
  }

  // ── 보스 — 심연. 실루엣 · 예고 · 체력바 ────────────────────
  // render 는 game.boss* 를 읽기만 한다 — 다른 모든 것과 같은 규칙이다.
  // uKind 풀 밖의 존재라 drawUnits 의 시대별 분기를 하나도 안 탄다.
  // **루프 안 할당 0** — addTrap/addSpike/addCircle 은 현재 경로에 점만
  // 더한다(Path2D 를 새로 안 만든다), 다른 유닛 실루엣과 같은 방식이다.
  drawBoss(game) {
    if (!game.bossActive) return;
    const ctx = this.ctx;
    const x = game.bossX, gy = groundAt(x);
    const w = C.BOSS_W, h = C.BOSS_H;
    const exposed = game.bossExposeMs > 0;
    const flash = game.bossHitFlash > 0;
    // 물이 높을수록 짙어진다 — 방어가 늘어난 것이 몸 색에도 보인다(팔레트는 그대로,
    // 램프의 위치만 옮긴다). 노출 중에는 테두리가 COL_BONUS로 바뀐다 —
    // "지금 쳐라"는 기회의 뜻이라 위협색(COL_THREAT, 규칙 2)을 쓰면 안 된다.
    const wk = (typeof game.waterK === 'function') ? game.waterK() : 0;
    const body = C.RAMP_STRUCT[C.rampIndex(0.30 + 0.30 * wk)];
    const rim = exposed ? C.COL_BONUS : C.RAMP_STRUCT[C.rampIndex(0.62)];

    ctx.fillStyle = body;
    ctx.beginPath();
    // 육중한 두 단 몸통 — 유닛보다 훨씬 크다는 것이 실루엣만으로 읽혀야 한다
    this.addTrap(x, gy - h, gy - h * 0.40, w * 0.60, w, 0);
    this.addTrap(x, gy - h * 0.46, gy - h * 0.08, w * 0.98, w * 0.68, 0);
    // 어깨의 뒤틀린 뿔 둘 — 굳은 파도 모양
    this.addSpike(x - w * 0.30, gy - h * 0.84, -0.4, -1, 30, 9);
    this.addSpike(x + w * 0.30, gy - h * 0.84, 0.4, -1, 30, 9);
    ctx.fill();

    ctx.strokeStyle = rim;
    ctx.lineWidth = exposed ? 3.4 : 2.2;
    ctx.beginPath();
    this.addTrap(x, gy - h, gy - h * 0.40, w * 0.60, w, 0);
    this.addTrap(x, gy - h * 0.46, gy - h * 0.08, w * 0.98, w * 0.68, 0);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;

    // 균열 — 물·피해의 색(COL_DANGER)이다. 맞은 순간만 흰 섬광
    ctx.fillStyle = flash ? C.COL_PLAYER : C.COL_DANGER;
    ctx.beginPath();
    this.addSpike(x - w * 0.14, gy - h * 0.64, 0, -1, 18, 4);
    this.addSpike(x + w * 0.14, gy - h * 0.64, 0, -1, 18, 4);
    ctx.fill();

    // 슬램 예고 중 — 발밑에 균열 고리가 조여든다. 위협색 하나만 쓴다(규칙 2)
    if (game.bossSlamCasting) {
      const total = C.BOSS_SLAM_CAST_MS > 0 ? C.BOSS_SLAM_CAST_MS : 1;
      const left = game.bossSlamCastMs > 0 ? game.bossSlamCastMs : 0;
      let p = 1 - left / total;
      p = p < 0 ? 0 : (p > 1 ? 1 : p);
      ctx.strokeStyle = C.RAMP_THREAT[C.rampIndex(0.5 + 0.4 * p)];
      ctx.lineWidth = 2 + 3 * p;
      ctx.beginPath();
      const rr = C.BOSS_SLAM_RADIUS * (1 - 0.55 * p);
      ctx.moveTo(x + rr, gy - 2);
      ctx.ellipse(x, gy - 2, rr, 16, 0, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }
  }

  // ── 최강병기 — 거신. 실루엣. 보스(drawBoss)의 거울이지만 **위협이 아니라
  // 내 자산**이다 — 몸 색이 COL_STRUCT(적)가 아니라 COL_PLAYER(내 것) 계열이다.
  // 이 게임의 색 규칙("밝기로 진영을, 색상으로 병종을 말한다")을 그대로 따른다.
  // render 는 game.wpn* 를 읽기만 한다 — 다른 모든 것과 같은 규칙이다.
  drawWeapon(game) {
    if (!game.wpnActive) return;
    const ctx = this.ctx;
    const x = game.wpnX, gy = groundAt(x);
    const w = C.WEAPON_W, h = C.WEAPON_H;
    const flash = game.wpnHitFlash > 0;
    const body = C.RAMP_PLAYER[C.rampIndex(0.40)];
    const rim = C.RAMP_PLAYER[C.rampIndex(0.80)];

    ctx.fillStyle = body;
    ctx.beginPath();
    // 곧게 선 두 단 몸통 — 심연의 굽은 두 단과 실루엣만으로 갈린다
    this.addTrap(x, gy - h, gy - h * 0.55, w * 0.42, w * 0.74, 0);
    this.addTrap(x, gy - h * 0.58, gy - h * 0.06, w * 0.86, w * 0.60, 0);
    // 각진 어깨판 — 심연의 뒤틀린 뿔과 대비된다. 사람이 만든 것이라는 뜻이다
    ctx.rect(x - w * 0.56, gy - h * 0.78, w * 0.20, h * 0.16);
    ctx.rect(x + w * 0.36, gy - h * 0.78, w * 0.20, h * 0.16);
    ctx.fill();

    ctx.strokeStyle = rim;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    this.addTrap(x, gy - h, gy - h * 0.55, w * 0.42, w * 0.74, 0);
    this.addTrap(x, gy - h * 0.58, gy - h * 0.06, w * 0.86, w * 0.60, 0);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;

    // 가슴의 동력원 — 금색 코어. 포탑 칸에서 태어났다는 것을 색으로 잇는다
    ctx.fillStyle = C.COL_BONUS;
    ctx.beginPath();
    this.addCircle(x, gy - h * 0.40, 7);
    ctx.fill();

    // 피격 — 다른 유닛과 같은 규칙(942행 참조): 몸 색은 그대로, 붉은 테두리만 켠다
    if (flash) {
      ctx.strokeStyle = C.COL_DANGER;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.rect(x - w * 0.5, gy - h, w, h * 0.94);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }
  }

  // ── 최강병기 — HUD 카드. 보스처럼 화면을 위협색으로 물들이지 않는다
  // (규칙 2: COL_THREAT 는 적 전용) — 이건 위협이 아니라 내 자산이다.
  // 왼쪽 위 고정 카드 하나에 소환 대기·활동·파괴 세 상태를 전부 담는다.
  drawWeaponHud(game) {
    if (!C.WEAPON_ENABLE || !game.wpnState) return;
    const ctx = this.ctx;
    const bx = WPN_BAR_X, by = WPN_BAR_Y, bw = WPN_BAR_W, bh = WPN_BAR_H;

    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.94)];
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 6);
    ctx.fill();
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.55)];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx + 1, by + 1, bw - 2, bh - 2, 6);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = FONT_TINY;
    ctx.fillStyle = C.COL_PLAYER;
    ctx.fillText(C.WEAPON_NAME, bx + 8, by + 4);

    if (game.wpnState === 3) {                    // 파괴됐다
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.65)];
      ctx.fillText(LABEL_WPN_DEAD, bx + 8, by + 20);
      return;
    }

    if (game.wpnState === 1) {                    // 소환 중 — 이미 돈은 냈다
      const total = C.WEAPON_CAST_MS > 0 ? C.WEAPON_CAST_MS : 1;
      const left = game.wpnCastMs > 0 ? game.wpnCastMs : 0;
      let p = 1 - left / total;
      p = p < 0 ? 0 : (p > 1 ? 1 : p);
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.62)];
      ctx.fillText(C.WEAPON_WARN_LINE, bx + 8, by + 18);
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.5)];
      ctx.fillText(C.WEAPON_HINT, bx + 8, by + 32);
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.22)];
      ctx.fillRect(bx + 8, by + bh - 8, bw - 16, 3);
      ctx.fillStyle = C.COL_BONUS;
      ctx.fillRect(bx + 8, by + bh - 8, (bw - 16) * (1 - p), 3);
      return;
    }

    // wpnState === 2 — 활동 중. 체력바만 (문장은 소환 중에 이미 한 번 읽혔다)
    const k = game.wpnHpMax > 0 ? game.wpnHp / game.wpnHpMax : 0;
    ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.25)];
    ctx.fillRect(bx + 8, by + 18, bw - 16, 7);
    ctx.fillStyle = C.COL_PLAYER;
    ctx.fillRect(bx + 8, by + 18, (bw - 16) * (k > 0 ? k : 0), 7);
  }

  // ── 별자리 — 상시 칩 + 전투 시작 리빌. 0건 → 신설(spec-explain-ui §4).
  // 매 전투 바뀌는 "그날의 규칙" 이라 위협도 자산도 아니다 — 중립 톤(RAMP_BONUS)을
  // 쓴다. game.zodiac* 은 game.js 가 이미 공개해 뒀다 — 여긴 읽기만 한다.
  drawZodiacHud(game) {
    if (typeof game.zodiac !== 'number') return;
    const ctx = this.ctx;
    const name = game.zodiacName, desc = game.zodiacDesc;
    if (!name) return;
    const title = (C.ZODIAC_TITLE && C.ZODIAC_TITLE[game.zodiac]) || '';
    const reveal = this.fxZodiac > 0;
    const beat = reveal ? 0.55 + 0.45 * Math.sin(game.simTime * 0.02) : 0;

    const cx = ZOD_CHIP_X, cy = ZOD_CHIP_Y, w = ZOD_CHIP_W, h = ZOD_CHIP_H;
    const bx = cx - w * 0.5;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.85)];
    ctx.beginPath();
    ctx.roundRect(bx, cy, w, h, 13);
    ctx.fill();
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(reveal ? 0.5 + 0.4 * beat : 0.5)];
    ctx.lineWidth = reveal ? 2 : 1.2;
    ctx.beginPath();
    ctx.roundRect(bx + 0.5, cy + 0.5, w - 1, h - 1, 13);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;

    // 배지 — 12분할 중 하나를 가리키는 작은 링(유닛 종류가 아니라 별자리이므로
    // drawUnitBadge 는 재사용하지 않는다. 원 하나 + 눈금 하나로 충분하다)
    const bcx = bx + 16, bcy = cy + h * 0.5, br = 8;
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.7)];
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    this.addCircle(bcx, bcy, br);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;
    const ang = -Math.PI / 2 + (game.zodiac / C.ZODIAC_COUNT) * Math.PI * 2;
    ctx.fillStyle = C.COL_BONUS;
    ctx.beginPath();
    this.addCircle(bcx + Math.cos(ang) * br, bcy + Math.sin(ang) * br, 2.2);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_TINY;
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.85)];
    ctx.fillText(name + ' · ' + title, bcx + br + 8, bcy);
    ctx.textBaseline = 'top';

    if (reveal && desc) {
      ctx.textAlign = 'center';
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.62)];
      ctx.fillText(desc, cx, cy + h + 2);
      ctx.textAlign = 'left';
    }
  }

  // 등장 전 예고 — 일반 스킬 예고(작은 띠 하나, CAST_Y)보다 훨씬 크다.
  // 색은 여전히 COL_THREAT 하나뿐이다(규칙 2) — 다만 화면 전체가 옅게 물들어
  // "이건 스킬 하나가 아니다"를 크기로 말한다.
  drawBossWarn(game) {
    if (game.bossState !== 1) return;
    const ctx = this.ctx;
    const total = C.BOSS_CAST_MS > 0 ? C.BOSS_CAST_MS : 1;
    const left = game.bossWarnMs > 0 ? game.bossWarnMs : 0;
    let p = 1 - left / total;
    p = p < 0 ? 0 : (p > 1 ? 1 : p);
    const R = C.RAMP_THREAT;
    const beat = 0.55 + 0.45 * Math.sin(game.simTime * (0.006 + 0.02 * p));

    ctx.fillStyle = R[C.rampIndex(0.045 + 0.045 * beat)];
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

    const bx0 = HALF_W - BOSS_WARN_W * 0.5, by0 = BOSS_WARN_Y;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.94)];
    ctx.beginPath();
    ctx.roundRect(bx0, by0, BOSS_WARN_W, BOSS_WARN_H, 8);
    ctx.fill();
    ctx.strokeStyle = R[C.rampIndex(0.55 + 0.4 * beat)];
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(bx0 + 2, by0 + 2, BOSS_WARN_W - 4, BOSS_WARN_H - 4, 8);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = FONT_MID;
    ctx.fillStyle = R[C.rampIndex(0.7)];
    ctx.fillText(C.BOSS_WARN_LINE, HALF_W, by0 + 10);
    ctx.font = FONT_BIG;
    ctx.fillStyle = C.COL_THREAT;
    ctx.fillText(C.BOSS_NAME, HALF_W, by0 + 32);
    ctx.font = FONT_TINY;
    ctx.fillStyle = R[C.rampIndex(0.62)];
    ctx.fillText(C.BOSS_HINT, HALF_W, by0 + BOSS_WARN_H - 20);

    // 남은 시간 막대
    ctx.fillStyle = R[C.rampIndex(0.22)];
    ctx.fillRect(bx0 + 12, by0 + BOSS_WARN_H - 8, BOSS_WARN_W - 24, 3);
    ctx.fillStyle = C.COL_THREAT;
    ctx.fillRect(bx0 + 12, by0 + BOSS_WARN_H - 8, (BOSS_WARN_W - 24) * (1 - p), 3);
    ctx.textAlign = 'left';
  }

  // 보스 체력바 — 상단 중앙, 일반 유닛엔 아예 없는 UI다. 등장 전(예고)에도
  // 빈 틀만 보여 "곧 여기에 뭔가 채워진다"를 미리 알린다. 처치 후에는
  // 바 대신 처치 표식 하나만 남긴다.
  drawBossBar(game) {
    if (!game.bossOn || game.bossState === 0) return;
    const ctx = this.ctx;
    const bx = HALF_W - BOSS_BAR_W * 0.5, by = BOSS_BAR_Y;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = FONT_SMALL;
    ctx.fillStyle = C.COL_STRUCT;
    ctx.fillText(C.BOSS_NAME, HALF_W, by - 15);

    if (game.bossDefeated) {
      ctx.font = FONT_TINY;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.68)];
      ctx.fillText(C.BOSS_DEFEATED_LABEL, HALF_W, by);
      ctx.textAlign = 'left';
      return;
    }

    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.95)];
    ctx.fillRect(bx - 2, by - 2, BOSS_BAR_W + 4, BOSS_BAR_H + 4);
    ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.25)];
    ctx.fillRect(bx, by, BOSS_BAR_W, BOSS_BAR_H);
    if (game.bossActive) {
      const k = game.bossHpMax > 0 ? game.bossHp / game.bossHpMax : 0;
      const exposed = game.bossExposeMs > 0;
      ctx.fillStyle = exposed ? C.COL_BONUS : C.COL_STRUCT;
      ctx.fillRect(bx, by, BOSS_BAR_W * (k > 0 ? k : 0), BOSS_BAR_H);
      // 물의 방어 — 얇은 표식 하나. 지금 얼마나 덜 맞는지가 눈에 보인다
      const wk = (typeof game.waterK === 'function') ? game.waterK() : 0;
      if (wk > 0.02) {
        ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.55)];
        ctx.fillRect(bx, by + BOSS_BAR_H + 2, BOSS_BAR_W * wk, 2);
      }
    }
    ctx.textAlign = 'left';

    // 슬램 예고 — 보스 바 테두리에 끼워 넣는다. 일반 스킬 예고(화면 위쪽 띠)와
    // 자리를 달리해서 헷갈리지 않는다 — 이미 보스를 보고 있는 눈이 여기도 본다.
    if (game.bossSlamCasting) {
      ctx.strokeStyle = C.RAMP_THREAT[C.rampIndex(0.5 + 0.45 * Math.sin(game.simTime * 0.02))];
      ctx.lineWidth = 2;
      ctx.strokeRect(bx - 4, by - 4, BOSS_BAR_W + 8, BOSS_BAR_H + 8);
      ctx.lineWidth = C.STROKE;
      ctx.textAlign = 'center';
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.COL_THREAT;
      ctx.fillText(C.BOSS_SLAM_NAME, HALF_W, by + BOSS_BAR_H + 12);
      ctx.textAlign = 'left';
    }
  }

  // ── 적의 예고 (EV.AI_CAST) ─────────────────────────────────
  // **이 화면이 통째로 비어 있었다.** 적 스킬은 걸린 뒤 0.7~1초 뜸을 들이는데
  // 그 창에 아무것도 안 그려서, 플레이어에게는 그냥 군대가 사라져 있었다.
  // 여기서 말해야 하는 것은 셋이다 — **무엇이 · 어디에 · 언제.**
  // 색은 COL_THREAT 하나만 쓴다 (규칙 2). 이 색이 뜨면 뜻은 하나여야 한다.
  drawAiCast(game) {
    const sk = (typeof game.aiCastSkill === 'number') ? (game.aiCastSkill | 0) : -1;
    // prevCastSk 는 **캐스팅이 없는 프레임(sk<0)에도** 갱신해야 한다 — 아래
    // early return 뒤에서 갱신하면 "캐스팅 없음" 구간 내내 이전 값이 그대로
    // 남아, 같은 스킬이 다시 걸릴 때 sk === prevCastSk 가 되어 "새로 시작된
    // 프레임"을 영영 못 잡는다(같은 스킬이 반복 조우해도 첫 조우 배너가
    // 계속 뜨는 버그였다 — 스크린샷으로 잡았다).
    const prevSk = this.prevCastSk;
    this.prevCastSk = sk;
    if (sk < 0 || sk >= C.SKILL_COUNT) return;
    // "첫 조우" 판정은 이 예고가 **새로 시작된 프레임에만** 다시 한다 — 캐스팅은
    // 여러 프레임에 걸쳐 그려지므로, 매 프레임 다시 판정하면 다음 프레임에
    // 이미 seenSkill 이 켜져 있어 밴드가 1프레임 만에 다시 쪼그라든다.
    if (sk !== prevSk) {
      this.castIsFirst = this.seenSkill[sk] ? 0 : 1;
      if (this.castIsFirst) this.seenSkill[sk] = 1;
    }
    const ctx = this.ctx;
    const total = (C.AI_CAST_MS && C.AI_CAST_MS[sk]) || 900;
    const left = game.aiCastMs > 0 ? game.aiCastMs : 0;
    let p = 1 - left / total;                 // 0 = 방금 걸렸다 · 1 = 지금 터진다
    p = p < 0 ? 0 : (p > 1 ? 1 : p);
    const R = C.RAMP_THREAT;
    // 맥박은 시뮬 시간에서 나온다 — 결정론이고, **임박할수록 빨라진다**
    const beat = 0.58 + 0.42 * Math.sin(game.simTime * (0.010 + 0.026 * p));
    const tier = (typeof game.aiSkillTier === 'function') ? (game.aiSkillTier(sk) | 0) : 0;
    const front = game.frontlineX ? game.frontlineX() : HALF_W;

    if (sk === C.SK_VOLLEY) {
      // ── 어디에 — **실제 피해 구역 위에** 표적을 놓는다 ──
      const r0 = (C.VOLLEY_TIER_R && C.VOLLEY_TIER_R[tier]) || C.VOLLEY_RADIUS;
      const zones = (C.VOLLEY_TIER_ZONES && C.VOLLEY_TIER_ZONES[tier]) || 1;
      // 지면 얼룩 — 여기가 위험 구역이다
      ctx.fillStyle = R[C.rampIndex(0.10 + 0.14 * beat)];
      ctx.beginPath();
      for (let z = 0; z < zones; z++) {
        const cx = this.volleyZoneX(SIDE_R, z, front), r = z === 0 ? r0 : r0 * 0.75;
        const g = groundAt(cx);
        ctx.moveTo(cx + r, g - 2);
        ctx.ellipse(cx, g - 2, r, 21, 0, 0, TAU);
      }
      ctx.fill();
      // 조여드는 고리 — 남은 시간이 **크기**로 읽힌다
      ctx.strokeStyle = R[C.rampIndex(0.45 + 0.5 * p)];
      ctx.lineWidth = 1.6 + 3.4 * p;
      ctx.beginPath();
      for (let z = 0; z < zones; z++) {
        const cx = this.volleyZoneX(SIDE_R, z, front), r = z === 0 ? r0 : r0 * 0.75;
        const g = groundAt(cx);
        const k = 2.5 - 1.5 * easeOutCubic(p);
        ctx.moveTo(cx + r * k, g - 2);
        ctx.ellipse(cx, g - 2, r * k, 21 * k, 0, 0, TAU);
      }
      ctx.stroke();
      // 구역의 폭 — 기둥 둘. "여기부터 여기까지"가 못 박힌다
      ctx.strokeStyle = R[C.rampIndex(0.55 + 0.4 * beat)];
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (let z = 0; z < zones; z++) {
        const cx = this.volleyZoneX(SIDE_R, z, front), r = z === 0 ? r0 : r0 * 0.75;
        for (let e = -1; e <= 1; e += 2) {
          const ex = cx + e * r, eg = groundAt(ex);
          ctx.moveTo(ex, eg + 6);
          ctx.lineTo(ex, eg - 54);
          ctx.moveTo(ex, eg - 54);
          ctx.lineTo(ex - e * 15, eg - 54);
        }
      }
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
      // 하늘에서 내려오는 그림자 — **위에서 온다**는 것을 방향으로 말한다
      ctx.fillStyle = R[C.rampIndex(0.30 + 0.4 * p)];
      ctx.beginPath();
      for (let z = 0; z < zones; z++) {
        const cx = this.volleyZoneX(SIDE_R, z, front), r = z === 0 ? r0 : r0 * 0.75;
        const nn = z === 0 ? 9 : 6;
        for (let i = 0; i < nn; i++) {
          const x = cx + this.vOff[(i * 3 + z * 7) % VOLLEY_N] * r * 0.92;
          const y = 108 + ((p * 150 + i * 26) % 150);
          this.addSpike(x, y, 0, 1, 13, 3.4);
        }
      }
      ctx.fill();
    } else if (sk === C.SK_TIDE) {
      // ── 해일 — 적 기지에서 판 전체를 훑으러 온다 ──
      const ox = C.SPAWN_R_X, og = groundAt(ox);
      // 부풀어 오르는 벽 — 적 쪽에서 무언가가 선다
      const wh = 30 + 74 * easeOutCubic(p);
      ctx.fillStyle = R[C.rampIndex(0.16 + 0.22 * beat)];
      ctx.beginPath();
      ctx.moveTo(ox + 66, og);
      ctx.lineTo(ox + 42, og - wh * 0.7);
      ctx.lineTo(ox - 6, og - wh);
      ctx.lineTo(ox - 52, og - wh * 0.55);
      ctx.lineTo(ox - 70, og);
      ctx.closePath();
      ctx.fill();
      // 지면을 따라 달려오는 압력선 — **판 전체가 맞는다**는 것을 폭으로 말한다
      ctx.strokeStyle = R[C.rampIndex(0.22 + 0.30 * beat)];
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(0, groundAt(0) - 5);
      for (let x = 48; x <= C.VIEW_W; x += 48) ctx.lineTo(x, groundAt(x) - 5);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
      // 왼쪽으로 달려가는 갈매기표 — 오는 방향이 곧 이 스킬의 정체다
      ctx.fillStyle = R[C.rampIndex(0.55 + 0.35 * p)];
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const ph = (p * 1.1 + i * 0.083) % 1;
        const x = C.VIEW_W - ph * C.VIEW_W;
        const y = groundAt(x) - 16 - (i % 4) * 15;
        this.addSpike(x, y, -1, 0, 17, 8);
      }
      ctx.fill();
      // 밀어냄 — 2등급부터 **전선이 실제로 뒤로 간다.** 길이가 곧 그 거리다
      const push = (C.TIDE_PUSH_PX && C.TIDE_PUSH_PX[tier]) || 0;
      if (push > 0) {
        const fg = groundAt(front);
        ctx.fillStyle = R[C.rampIndex(0.85)];
        ctx.beginPath();
        this.addBar(front, fg - 30, -1, 0, push, 0, 3, 3);
        this.addSpike(front - push, fg - 30, -1, 0, 13, 8);
        ctx.fill();
      }
      // 넘어뜨림 — 3등급. 넘어진 사람 표식 둘을 전선에 세운다
      if ((C.TIDE_STUN_MS && C.TIDE_STUN_MS[tier]) > 0) {
        ctx.strokeStyle = R[C.rampIndex(0.9)];
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let i = 0; i < 2; i++) {
          const x = front - 40 + i * 80, g = groundAt(x);
          ctx.moveTo(x - 13, g - 7); ctx.lineTo(x + 13, g - 7);
          ctx.moveTo(x + 9, g - 13); ctx.lineTo(x + 13, g - 7);
          ctx.lineTo(x + 9, g - 1);
        }
        ctx.stroke();
        ctx.lineWidth = C.STROKE;
      }
    } else if (sk === C.SK_RALLY) {
      // ── 증원 — 적 기지 앞의 땅이 갈라진다 ──
      const bx = C.SPAWN_R_X, g = groundAt(bx), SPREAD = 30;
      ctx.strokeStyle = R[C.rampIndex(0.45 + 0.45 * beat)];
      ctx.lineWidth = 2 + 3 * p;
      ctx.beginPath();
      for (let i = 0; i < C.RALLY_COUNT; i++) {
        const px = bx + (i - 1) * SPREAD, w = 18 * easeOutCubic(p);
        ctx.moveTo(px - w, groundAt(px - w));
        ctx.lineTo(px, groundAt(px) - 6);
        ctx.lineTo(px + w, groundAt(px + w));
      }
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
      ctx.fillStyle = R[C.rampIndex(0.5 + 0.4 * p)];
      ctx.beginPath();
      for (let i = 0; i < C.RALLY_COUNT; i++) {
        const px = bx + (i - 1) * SPREAD;
        this.addSpike(px, g - 16 - 34 * p, 0, -1, 18, 8);
      }
      ctx.fill();
    } else {
      // ── 총진군 — 살아 있는 적 전부가 잠깐 빨라진다. 발밑에 고리를 깐다 ──
      ctx.strokeStyle = R[C.rampIndex(0.4 + 0.5 * beat)];
      ctx.lineWidth = 2;
      ctx.beginPath();
      let any = 0;
      for (let j = 0; j < this.aliveN; j++) {
        const i = this.list[j];
        if (game.uSide[i] !== SIDE_R) continue;
        const rr = 8 + this.sw[i] * 0.5 * (0.6 + 0.5 * p);
        ctx.moveTo(this.sx[i] + rr, this.sgy[i] + 2);
        ctx.ellipse(this.sx[i], this.sgy[i] + 2, rr, rr * 0.32, 0, 0, TAU);
        any = 1;
      }
      if (any) ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }

    // ── 언제 — 하늘에 뜬 띠 하나. 이름과 남은 시간이 같이 읽힌다 ──
    // 원정 전체 기준 "첫 조우"에만 띠를 키워 효과 한 줄을 더 보여준다.
    // 두 번째부터는 다시 원래 크기(이미 배운 사람에게는 소음이라 안 키운다).
    const castH = this.castIsFirst ? CAST_H_FIRST : CAST_H;
    const bx0 = HALF_W - CAST_W * 0.5;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.93)];
    ctx.beginPath();
    ctx.roundRect(bx0, CAST_Y, CAST_W, castH, 6);
    ctx.fill();
    ctx.strokeStyle = R[C.rampIndex(0.5 + 0.5 * beat)];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx0 + 1, CAST_Y + 1, CAST_W - 2, castH - 2, 6);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;
    // 경고 세모 — 글자를 못 읽어도 이 모양은 읽힌다
    ctx.fillStyle = R[C.rampIndex(0.55 + 0.45 * beat)];
    ctx.beginPath();
    ctx.moveTo(bx0 + 17, CAST_Y + 8);
    ctx.lineTo(bx0 + 27, CAST_Y + 25);
    ctx.lineTo(bx0 + 7, CAST_Y + 25);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(1)];
    ctx.fillRect(bx0 + 16, CAST_Y + 13, 2, 6);
    ctx.fillRect(bx0 + 16, CAST_Y + 21, 2, 2);
    // 남은 시간 막대 — 줄어드는 것이 시계다. castH 를 따라가므로 좌표식은 안 바뀐다
    ctx.fillStyle = R[C.rampIndex(0.22)];
    ctx.fillRect(bx0 + 6, CAST_Y + castH - 6, CAST_W - 12, 3);
    ctx.fillStyle = C.COL_THREAT;
    ctx.fillRect(bx0 + 6, CAST_Y + castH - 6, (CAST_W - 12) * (1 - p), 3);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = FONT_TINY;
    ctx.fillStyle = R[C.rampIndex(0.7)];
    ctx.fillText(LBL_CAST, bx0 + 34, CAST_Y + 9);
    ctx.font = FONT_MID;
    ctx.fillStyle = C.COL_THREAT;
    ctx.fillText(skName(game, sk, false), bx0 + 50, CAST_Y + 6);
    ctx.textAlign = 'right';
    ctx.font = FONT_TINY;
    ctx.fillStyle = R[C.rampIndex(0.62)];
    ctx.fillText(LBL_INBOUND, bx0 + CAST_W - 12, CAST_Y + 10);
    ctx.textAlign = 'left';

    if (this.castIsFirst) {
      ctx.font = FONT_MICRO;
      ctx.fillStyle = R[C.rampIndex(0.6)];
      ctx.fillText(C.SKILL_DESC[sk] || '', bx0 + 50, CAST_Y + 22);
    }
  }

  // ── 재무장 — 진화 직후 1.25초, 병력이 굳는다 ────────────────
  // config 가 이 구간을 만들어 뒀는데 **화면에서 아무도 안 읽고 있었다.**
  // 그래서 진화는 "숫자가 커지는 것"으로 보였다. 여기서 대가가 보여야
  // "언제 누를지"가 판단이 된다 — 전선이 맞붙은 순간에 올리면 그 자리에서 죽는다.
  drawRearm(game) {
    const ctx = this.ctx;
    const full = C.ERA_REARM_MS > 0 ? C.ERA_REARM_MS : 1;
    for (let s = 0; s < 2; s++) {
      const ms = (s === SIDE_L ? game.rearmMs : game.aiRearmMs) || 0;
      if (!(ms > 0)) continue;
      const q = 1 - ms / full;                        // 0 → 1 로 차오른다
      const era = (s === SIDE_L ? game.era : game.aiEra) | 0;
      const RE = ERA_RAMP(era);                       // 깔개 — 유닛을 눌러 굳힌다
      const RL = eraLit(era);                         // 앞에 서는 선 — 밝기만 올린 짝
      // 유닛마다 **차오르는 상자.** 굳어 있다는 것과 언제 풀리는지가 같이 읽힌다
      ctx.fillStyle = RE[C.rampIndex(0.72)];
      ctx.beginPath();
      let any = 0;
      for (let j = 0; j < this.aliveN; j++) {
        const i = this.list[j];
        if (game.uSide[i] !== s) continue;
        const w = this.sw[i] + 8, h = this.sh[i] + 8;
        const x = this.sx[i] - w * 0.5, y = this.sgy[i] + 3 - h;
        ctx.rect(x, y + h * (1 - q), w, h * q);
        any = 1;
      }
      if (any) ctx.fill();
      ctx.strokeStyle = RL[C.rampIndex(0.9)];
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let j = 0; j < this.aliveN; j++) {
        const i = this.list[j];
        if (game.uSide[i] !== s) continue;
        const w = this.sw[i] + 8, h = this.sh[i] + 8;
        const x = this.sx[i] - w * 0.5, y = this.sgy[i] + 3 - h;
        // 네 모서리만 — 통째로 두르면 유닛이 안 보인다
        const c = 6;
        ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
        ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c);
        ctx.moveTo(x + w, y + h - c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - c, y + h);
        ctx.moveTo(x + c, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - c);
      }
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
      // 한 마디 — **굳어 있는 병력 위**에 붙인다.
      // 처음엔 기지 위에 뒀는데 오른쪽 것이 사령관 카드(706~896 × 8~124) 뒤로
      // 들어갔다. 그리고 기지가 아니라 병력이 굳는 것이므로, 병력을 가리키는
      // 편이 뜻도 맞다. 병력이 하나도 없으면 기지 위로 떨어진다.
      let cx = s === SIDE_L ? C.BASE_L_X : C.BASE_R_X;
      let cn = 0, csum = 0;
      for (let j = 0; j < this.aliveN; j++) {
        const i = this.list[j];
        if (game.uSide[i] !== s) continue;
        csum += this.sx[i]; cn++;
      }
      if (cn > 0) cx = csum / cn;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const eraClamped = era < C.ERA_COUNT ? era : C.ERA_COUNT - 1;
      const nameTxt = C.ERA_NAME[eraClamped] + ' · ' + C.ERA_ABILITY_NAME[eraClamped];
      const descTxt = C.ERA_ABILITY_DESC[eraClamped];
      // 능력 설명(항목 B)이 시대에 따라 길이가 크게 다르다 — 예:
      // '연합'(청동) 한 줄이 '버팀'(강철)의 세 배 가깝다. 좌우 기지 근처(BASE_L_X=92)
      // 에서 고정 70px 여백만 두면 긴 줄이 캔버스 밖으로 잘린다. 실측 폭으로
      // 여백을 잡아 **어떤 시대·어느 쪽 기지든** 화면 안에 들어오게 한다.
      ctx.font = FONT_TINY;
      const nameHalfW = ctx.measureText(nameTxt).width * 0.5;
      ctx.font = FONT_MICRO;
      const descHalfW = ctx.measureText(descTxt).width * 0.5;
      const half = Math.max(70, nameHalfW, descHalfW) + 6;
      if (cx < half) cx = half; else if (cx > C.VIEW_W - half) cx = C.VIEW_W - half;
      const ty = groundAt(cx) - 132;
      ctx.font = FONT_SMALL;
      ctx.fillStyle = RL[C.rampIndex(0.95)];
      ctx.fillText(LBL_REARM, cx, ty);
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.9)];
      ctx.font = FONT_TINY;
      ctx.fillText(nameTxt, cx, ty + 16);
      // 시대 능력 효과 한 줄 — 항목 A(드래프트 머리말)와 같은 상수를 재사용
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.62)];
      ctx.font = FONT_MICRO;
      ctx.fillText(descTxt, cx, ty + 30);
      // 남은 시간 — 짧은 막대 하나. 언제 풀리는지가 숫자 없이 읽힌다
      ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.9)];
      ctx.fillRect(cx - 27, ty + 42, 54, 4);
      ctx.fillStyle = RL[C.rampIndex(0.95)];
      ctx.fillRect(cx - 27, ty + 42, 54 * q, 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }
  }

  // ── 넘어진 병력 — 범람(해일 3등급)이 실제로 하는 일 ─────────
  // game.uStun 을 읽는다. 이게 없으면 "해일이 세다"가 숫자로만 존재한다.
  // 색은 **누가 넘어뜨렸는가**로 정한다: 내 병력이 넘어졌으면 적이 한 것이므로
  // COL_THREAT, 적 병력이 넘어졌으면 내 해일이므로 SKILL_COL[해일] 이다.
  drawStun(game) {
    if (!game.uStun) return;
    const ctx = this.ctx;
    for (let s = 0; s < 2; s++) {
      const ramp = s === SIDE_L ? C.RAMP_THREAT : (C.RAMP_SKILL[C.SK_TIDE] || C.RAMP_PLAYER);
      ctx.strokeStyle = ramp[C.rampIndex(0.85)];
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      let any = 0;
      for (let j = 0; j < this.aliveN; j++) {
        const i = this.list[j];
        if (game.uSide[i] !== s || !game.uStun[i]) continue;
        // 머리 위에서 도는 별 — 어디서나 통하는 "넘어졌다"의 기호
        const cx = this.sx[i], cy = this.sgy[i] - this.sh[i] - 9;
        const a = game.simTime * 0.008 + i;
        for (let k = 0; k < 3; k++) {
          const th = a + k * 2.094;
          ctx.moveTo(cx + Math.cos(th) * 9 - 2.5, cy + Math.sin(th) * 3.5);
          ctx.lineTo(cx + Math.cos(th) * 9 + 2.5, cy + Math.sin(th) * 3.5);
        }
        any = 1;
      }
      if (any) ctx.stroke();
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

    // 물 몸통 — 예전엔 COL_BG 한 겹이라 물이 배경으로 위장했다. 이제 전용
    // 색(WATER_COL)을 쓴다. 깊이는 여전히 COL_BG 급으로 어두워 아군 흰 몸·
    // 적 밝은 테와의 대비를 그대로 지킨다 — 바뀐 건 색상이지 밝기가 아니다.
    ctx.fillStyle = C.RAMP_WATER[1][C.rampIndex(0.66)];
    ctx.beginPath();
    ctx.moveTo(0, C.VIEW_H);
    for (let i = 0; i <= last; i++) ctx.lineTo(i * 24, wy + wave[i]);
    ctx.lineTo(C.VIEW_W, C.VIEW_H);
    ctx.closePath();
    ctx.fill();

    // 표면 — 얕은 층에만 청록빛을 얹는다. 깊은 곳과 갈라야 "물"이 된다
    ctx.fillStyle = C.RAMP_WATER[0][C.rampIndex(0.30)];
    ctx.beginPath();
    ctx.moveTo(0, wy + wave[0]);
    for (let i = 0; i <= last; i++) ctx.lineTo(i * 24, wy + wave[i]);
    ctx.lineTo(C.VIEW_W, wy + wave[last]);
    for (let i = last; i >= 0; i--) ctx.lineTo(i * 24, wy + wave[i] + 46);
    ctx.closePath();
    ctx.fill();

    // 잠긴 유닛의 진영을 되살린다.
    // **물빛이 양쪽을 같은 회색으로 만든다** (원정2 전투4, 134초에 잡혔다).
    // 위의 어두운 막(알파 0.66)이 내 흰 몸을 회청색으로 내리고, 동시에 적의
    // 밝은 윤곽선도 같이 내린다. 두 진영이 같은 중간 회색에서 만난다.
    // 그래서 **수면 아래에만** 진영의 잉크를 한 번 더 얹는다. 물 위의 문법을
    // 그대로 쓴다 — 아군은 밝은 덩어리, 적군은 테만 빛나는 덩어리.
    // 위치는 drawUnits 가 이번 프레임에 이미 계산해 둔 것을 그대로 읽는다.
    if (this.aliveN > 0 && wy < this.maxGy) {
      const list = this.list, sgy = this.sgy, n = this.aliveN;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, C.VIEW_H);
      for (let i = 0; i <= last; i++) ctx.lineTo(i * 24, wy + wave[i]);
      ctx.lineTo(C.VIEW_W, C.VIEW_H);
      ctx.closePath();
      ctx.clip();
      // **병종 색도 물속에서 살아 있어야 한다.** 예전에는 아군을 흰색 한 겹으로,
      // 적군을 회청색 테 한 겹으로 되살렸다 — 진영은 돌아왔지만 병종이 죽었다.
      // 어차피 종류별로 나눠 그리는 값은 위 drawUnits 와 같은 구조다.
      for (let pi = 0; pi < 2; pi++) {
        const s = pi === 0 ? SIDE_R : SIDE_L;
        const dir = s === SIDE_L ? 1 : -1;
        const mine = s === SIDE_L;
        if (mine) {                          // 아군 — 몸을 다시 밝힌다 (병종 색으로)
          for (let k = 0; k < UK; k++) {
            let anyF = 0;
            for (let j = 0; j < n; j++) {
              const i = list[j];
              if (game.uSide[i] !== s || game.uKind[i] !== k || sgy[i] <= wy) continue;
              if (!anyF) { ctx.fillStyle = U_SUNK[k]; ctx.beginPath(); anyF = 1; }
              this.addUnitFill(game, i, dir);
            }
            if (anyF) ctx.fill();
          }
          continue;
        }
        // 적군은 밝은 테만 되살린다. **아군 쪽 분리선은 여기서 다시 긋지 않는다** —
        // 유닛 경로를 한 번 더 짓는 값이 비싸고(128기 잠긴 프레임에서 실측 +1.7ms),
        // 물속에서 갈려야 하는 것은 몇 기인가보다 **어느 편인가**다.
        ctx.lineWidth = 2.0;
        for (let k = 0; k < UK; k++) {
          let anyO = 0;
          for (let j = 0; j < n; j++) {
            const i = list[j];
            if (game.uSide[i] !== s || game.uKind[i] !== k || sgy[i] <= wy) continue;
            if (!anyO) { ctx.strokeStyle = U_RIM[k]; ctx.beginPath(); anyO = 1; }
            this.addUnitOutline(game, i, dir);
          }
          if (anyO) ctx.stroke();
        }
      }
      ctx.restore();
      ctx.lineWidth = C.STROKE;
    }

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

  // ── 긴장도 비네트 — 위기가 "계속" 화면에 남아 있다는 신호 ──────
  // 사용자: "게임이 너무 긴장감이 없다". feel.tension 은 사건이 아니라 상태라
  // (feel.js 의 updateTension 참고) 여기서도 한 번 반짝이고 끝나면 안 된다.
  // 그래서 히트플래시(fillRect 한 장)와 달리 **가장자리에서 안쪽으로 갈수록
  // 옅어지는 밴드를 여러 겹 쌓아** 그라디언트를 흉내낸다 — 이 파일은
  // createRadialGradient 를 안 쓴다(리사이즈마다 다시 굽거나 매 프레임 새로
  // 만들어야 한다, paintBackground 주석과 같은 이유). RAMP_DANGER 는 이미
  // 16단계 알파로 구워져 있으므로 새 fillStyle 문자열을 만들지 않는다.
  // 화면 중앙(전장)은 절대 안 가린다 — 밴드는 가장자리에만 쌓인다.
  //
  // feel 은 여기서도 **읽기만** 한다. tension·tensionPulse 는 feel.step() 이
  // game 을 읽어 이미 계산해 둔 값이다 — render 는 game 을 직접 보지 않는다.
  drawTension(feel) {
    const p = feel.tensionPulse;
    if (!(p > 0.004)) return;
    const ctx = this.ctx;
    const maxA = C.TENSION_VIGNETTE_MAX * p;
    const BANDS = 4;
    for (let i = 0; i < BANDS; i++) {
      const a = maxA * (1 - i / BANDS);
      if (!(a > 0.004)) continue;
      ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(a)];
      const w = 10 + i * 16;
      ctx.fillRect(0, 0, C.VIEW_W, w);              // 위
      ctx.fillRect(0, C.VIEW_H - w, C.VIEW_W, w);   // 아래
      ctx.fillRect(0, 0, w, C.VIEW_H);              // 왼쪽
      ctx.fillRect(C.VIEW_W - w, 0, w, C.VIEW_H);   // 오른쪽
    }
  }

  // ── 툴팁 — 무엇이 가리켜졌는가 ───────────────────────────────
  // 특성·숙련 알약 — drawHud 가 이번 프레임에 채워 둔 chipX/chipW 를 본다.
  // y·h 는 알약 줄 하나뿐이라 상수(68, 15)다 — drawHud 의 그 자리와 같다.
  hitChip(lx, ly) {
    if (ly < 68 || ly > 83) return -1;
    for (let i = 0; i < this.chipN; i++) {
      if (lx >= this.chipX[i] && lx <= this.chipX[i] + this.chipW[i]) return i;
    }
    return -1;
  }

  // 포인터 아래에 무엇이 있는가 — hoverKind/hoverIdx 를 쓴다(반환값 없음,
  // 새 객체를 안 만든다). 우선순위는 화면에서 좁고 겹치기 쉬운 것부터다.
  pickHover(game, lx, ly) {
    const ci = this.hitChip(lx, ly);
    // chipKind 는 1=특성 2=숙련이지만 hoverKind 의 1·2 는 이미 버튼·증원이 쓴다 —
    // +3 만큼 밀어 4=특성 5=숙련으로 옮긴다(버그였다: 처음엔 그대로 대입해서
    // 특성 알약을 가리켜도 버튼 0번(검사 유닛) 툴팁이 뜨는 충돌이 있었다).
    if (ci >= 0) { this.hoverKind = this.chipKind[ci] + 3; this.hoverIdx = this.chipIdx[ci]; return; }
    if (Renderer.hitZodiac(lx, ly)) { this.hoverKind = 3; this.hoverIdx = -1; return; }
    if (Renderer.hitRally && Renderer.hitRally(lx, ly)) { this.hoverKind = 2; this.hoverIdx = -1; return; }
    const b = Renderer.hitButton(lx, ly);
    if (b >= 0) { this.hoverKind = 1; this.hoverIdx = b; return; }
    this.hoverKind = 0; this.hoverIdx = -1;
  }

  // 매 프레임 불린다(main.js 의 두 draw 호출 지점 앞). 마우스는 누르지 않아도
  // 뜬다(호버) — 어떤 액션도 큐에 안 넣으므로 클릭 계약을 안 건드린다. 터치는
  // TOOLTIP_HOLD_MS 이상 눌려 있을 때만 뜬다 — 그 전까지는 pointerdown 이 이미
  // 발동시킨 동작(구매·스킬)만 있고 툴팁은 없다.
  updateHover(game, lx, ly, ptrIsMouse, ptrDown, ptrDownWall, nowWall) {
    if (!game || game.state !== S.PLAY) { this.hoverKind = 0; this.hoverSig = -1; return; }
    const show = ptrIsMouse ? true : (ptrDown && (nowWall - ptrDownWall) >= C.TOOLTIP_HOLD_MS);
    if (!show) { this.hoverKind = 0; return; }
    this.pickHover(game, lx, ly);
    this.hoverAX = lx; this.hoverAY = ly;
    if (this.hoverKind === 0) { this.hoverSig = -1; return; }
    // era 를 서명에 넣는다 — 유닛·스킬 이름과 등급이 시대에 따라 바뀐다.
    const sig = this.hoverKind * 100000 + (this.hoverIdx + 1) * 10 + (game.era | 0);
    if (sig === this.hoverSig) return;         // 같은 것을 계속 가리키는 중 — 문장 재조립 없음
    this.hoverSig = sig;
    this.buildHoverText(game);
  }

  // 문장을 짓는다 — hoverSig 가 바뀔 때만 불린다(위 updateHover). 여기서만
  // 문자열을 조립한다 — 그 외 어디서도 툴팁이 새 문자열을 안 만든다.
  buildHoverText(game) {
    this.hoverL2 = ''; this.hoverL3 = '';
    if (this.hoverKind === 1) {                 // 버튼 — 유닛 0~5, 진화 6, 포탑 7, 해일 8, 화살비 9
      const idx = this.hoverIdx;
      if (idx < C.UNIT_KINDS) {
        const era = game.era | 0;
        const row = C.ERA_UNIT_NAME && C.ERA_UNIT_NAME[era];
        this.hoverL1 = (row && row[idx]) || '';
        this.hoverL2 = '체력' + C.U_HP[idx] + ' · 공격' + C.U_DMG[idx]
          + ' · 사거리' + Math.round(game.statRange(idx)) + ' · ' + game.cost(idx) + '금';
        this.hoverL3 = unitCounterHint(idx, row);
      } else if (idx === C.B_ERA) {
        if (game.era >= C.ERA_COUNT - 1) {
          this.hoverL1 = C.SKILL_NAME[C.SK_SURGE]; this.hoverL2 = C.SKILL_DESC[C.SK_SURGE];
        } else {
          const next = game.era + 1;
          this.hoverL1 = '진화 (' + game.eraNeed() + ' 경험치)';
          this.hoverL2 = C.ERA_NAME[next] + ' 시대 · ' + C.ERA_ABILITY_NAME[next];
          this.hoverL3 = C.ERA_ABILITY_DESC[next];
        }
      } else if (idx === C.B_TOWER) {
        if (game.towerLv >= C.TOWER_MAX && game.wpnEligible()) {
          this.hoverL1 = C.WEAPON_NAME; this.hoverL2 = C.WEAPON_HINT;
        } else {
          const cost = game.towerCost();
          this.hoverL1 = '포탑 강화' + (cost > 0 ? ' (' + cost + '금)' : ' (최대)');
          this.hoverL2 = TT_TOWER_DESC;
        }
      } else if (idx === C.B_TIDE) {
        this.hoverL1 = C.SKILL_NAME[C.SK_TIDE]; this.hoverL2 = C.SKILL_DESC[C.SK_TIDE];
      } else if (idx === C.B_VOLLEY) {
        this.hoverL1 = C.SKILL_NAME[C.SK_VOLLEY]; this.hoverL2 = C.SKILL_DESC[C.SK_VOLLEY];
      }
    } else if (this.hoverKind === 2) {           // 증원
      this.hoverL1 = C.SKILL_NAME[C.SK_RALLY]; this.hoverL2 = C.SKILL_DESC[C.SK_RALLY];
    } else if (this.hoverKind === 3) {           // 별자리
      const title = (C.ZODIAC_TITLE && C.ZODIAC_TITLE[game.zodiac]) || '';
      this.hoverL1 = (game.zodiacName || '') + (title ? ' · ' + title : '');
      this.hoverL2 = game.zodiacDesc || '';
    } else if (this.hoverKind === 4) {           // 특성
      const tr = C.TRAITS[this.hoverIdx];
      this.hoverL1 = tr.name; this.hoverL2 = tr.desc;
    } else if (this.hoverKind === 5) {           // 숙련
      const m = C.MASTERY[this.hoverIdx];
      this.hoverL1 = m.name + '×' + game.mastery[this.hoverIdx]; this.hoverL2 = m.desc;
    }
  }

  // 작은 카드 하나 — 드래프트 카드·재무장 표와 같은 재료(RAMP_BG 바탕,
  // RAMP_PLAYER 테두리, COL_BONUS 제목)로 짓는다. 화면 밖으로 안 나가게 clamp.
  drawTooltip(game) {
    if (this.hoverKind === 0 || !this.hoverL1) return;
    const ctx = this.ctx;
    ctx.font = FONT_TINY;
    let w = ctx.measureText(this.hoverL1).width;
    ctx.font = FONT_MICRO;
    if (this.hoverL2) w = Math.max(w, ctx.measureText(this.hoverL2).width);
    if (this.hoverL3) w = Math.max(w, ctx.measureText(this.hoverL3).width);
    w += 20;
    const lines = 1 + (this.hoverL2 ? 1 : 0) + (this.hoverL3 ? 1 : 0);
    const h = 10 + lines * 15;

    // 앵커 — 무엇을 가리키는지에 따라 다른 자리다. 손가락이 가리는 자리
    // (버튼 바로 위)가 아니라 그 요소의 "고정된 자리" 위·아래에 뜬다.
    let ax = this.hoverAX, ay = this.hoverAY - h - 8;
    if (this.hoverKind === 1) { ax = btnX(this.hoverIdx) + BTN_W * 0.5; ay = LAY.y - h - 6; }
    else if (this.hoverKind === 2) { ax = C.RALLY_CX; ay = C.RALLY_CY - C.RALLY_R - h - 6; }
    else if (this.hoverKind === 3) { ax = ZOD_CHIP_X; ay = ZOD_CHIP_Y + ZOD_CHIP_H + 6; }
    else if (this.hoverKind === 4 || this.hoverKind === 5) { ay = 68 + 15 + 6; }

    let x = ax - w * 0.5;
    if (x < 4) x = 4; else if (x + w > C.VIEW_W - 4) x = C.VIEW_W - 4 - w;
    let y = ay;
    if (y < 4) y = 4;
    if (y + h > C.VIEW_H - 4) y = C.VIEW_H - 4 - h;

    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.94)];
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.fill();
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.4)];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;

    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    let ty = y + 6;
    ctx.font = FONT_TINY;
    ctx.fillStyle = C.COL_BONUS;
    ctx.fillText(this.hoverL1, x + 10, ty);
    ty += 15;
    ctx.font = FONT_MICRO;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.75)];
    if (this.hoverL2) { ctx.fillText(this.hoverL2, x + 10, ty); ty += 15; }
    if (this.hoverL3) { ctx.fillText(this.hoverL3, x + 10, ty); }
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

    // 획득 특성 — 금 아래에 알약으로. 내 것은 내 쪽에 모아 둔다.
    // 숙련(반복 획득)은 종류별 알약 하나에 **횟수를 붙여** 보여 준다.
    // 특성 18종을 다 모으면 알약이 줄을 넘치므로 폭 상한(300)에서 자른다.
    ctx.font = FONT_MICRO;
    const mCount = game.mastery ? game.mastery.length : 0;
    let px = 60;
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.20)];
    ctx.beginPath();
    let anyT = 0;
    // 툴팁이 쓸 자리 — 이 루프가 어차피 매 프레임 폭을 계산하므로 그 값을
    // 그대로 받아 적는다(재계산 없음, 새 객체 없음 — 고정 배열에 숫자만 쓴다).
    this.chipN = 0;
    for (let i = 0; i < C.TRAITS.length; i++) {
      if (!game.traits[i]) continue;
      const tw = C.TRAITS[i].name.length * 11 + 10;
      ctx.roundRect(px, 68, tw, 15, 7);
      if (this.chipN < this.chipX.length) {
        this.chipX[this.chipN] = px; this.chipW[this.chipN] = tw;
        this.chipKind[this.chipN] = 1; this.chipIdx[this.chipN] = i;
        this.chipN++;
      }
      px += tw + 5; anyT = 1;
      if (px > 300) break;
    }
    for (let m = 0; m < mCount && px <= 300; m++) {
      if (!game.mastery[m]) continue;
      const tw = (C.MASTERY[m].name.length + 2) * 11 + 10;
      ctx.roundRect(px, 68, tw, 15, 7);
      if (this.chipN < this.chipX.length) {
        this.chipX[this.chipN] = px; this.chipW[this.chipN] = tw;
        this.chipKind[this.chipN] = 2; this.chipIdx[this.chipN] = m;
        this.chipN++;
      }
      px += tw + 5; anyT = 1;
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
      for (let m = 0; m < mCount && px <= 300; m++) {
        if (!game.mastery[m]) continue;
        const tw = (C.MASTERY[m].name.length + 2) * 11 + 10;
        ctx.fillText(C.MASTERY[m].name + '×' + game.mastery[m], px + 5, 71);
        px += tw + 5;
      }
    }

    this.drawFrontBar(game);
    this.drawWaterGauge(game);
    this.drawBossBar(game);
    this.drawWeaponHud(game);
    this.drawZodiacHud(game);

    this.drawCommander(game, director);
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

  // ── 사령관 — AI 디렉터에게 얼굴을 준다 (spec-v3 §3) ─────────
  // 카드(초상·이름·칭호·원정 진행·적 편성 아이콘)는 **거의 안 바뀐다.** 구워 둔다.
  // 매 프레임 그리는 것은 편성 막대 두 번과 말풍선뿐이다.
  drawCommander(game, director) {
    const ctx = this.ctx;
    const cmd = this.commanderOf(game);
    const stage = (typeof game.stage === 'number') ? (game.stage | 0) : 0;
    const stageMax = (typeof game.stageMax === 'number') ? (game.stageMax | 0) : CAMP_LEN;
    const aiEra = game.aiEra | 0, myEra = game.era | 0;

    // 서명에 두 시대가 다 들어간다 — 누가 앞서는지가 카드에 그려지기 때문이다
    const sig = (cmd + 1) * 977 + stage * 31 + stageMax * 7 + aiEra * 131 + myEra * 1009;
    if (typeof document !== 'undefined') {
      const s = this.viewScale > 2 ? 2 : (this.viewScale < 0.25 ? 0.25 : this.viewScale);
      if (this.cmdSig !== sig || this.cmdScale !== s) {
        const w = Math.ceil(CMD_W * s), h = Math.ceil(CMD_H * s);
        if (!this.cmdCanvas) this.cmdCanvas = document.createElement('canvas');
        if (this.cmdCanvas.width !== w || this.cmdCanvas.height !== h) {
          this.cmdCanvas.width = w; this.cmdCanvas.height = h;
        }
        const octx = this.cmdCanvas.getContext('2d');
        const prev = this.ctx;
        this.ctx = octx;
        octx.setTransform(s, 0, 0, s, -CMD_X * s, -CMD_Y * s);
        octx.clearRect(CMD_X, CMD_Y, CMD_W, CMD_H);
        this.paintCommanderCard(cmd, stage, stageMax, aiEra, myEra);
        this.ctx = prev;
        this.cmdSig = sig; this.cmdScale = s;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.cmdCanvas, CMD_X, CMD_Y, CMD_W, CMD_H);
      ctx.imageSmoothingEnabled = true;
    } else {
      this.paintCommanderCard(cmd, stage, stageMax, aiEra, myEra);
    }

    // 적 편성 막대 — **"적이 뭘 뽑고 있나"가 1초 안에 읽혀야 한다.**
    // 지금 살아 있는 적 구성이다. 아이콘 줄은 카드에 구워져 있고 여기서는 막대만 칠한다.
    const mx = CMD_X + 10, mw = CMD_W - 20, cw = mw / C.UNIT_KINDS;
    const my = CMD_Y + 78, mh = 15;
    // **막대도 그 병종 색이다.** 전장에서 보라색 덩어리를 세고 여기서 보라색 막대를
    // 보면 "거인이 늘었다"가 두 번 말할 필요 없이 이어진다. 여섯 칸뿐이라 값이 싸다
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      const v = this.foeMix[k];
      if (v <= 0) continue;
      const f = v / this.foeMax;
      ctx.fillStyle = C.RAMP_UNIT[k][C.rampIndex(0.9)];
      ctx.fillRect(mx + cw * k + 2, my + mh * (1 - f), cw - 4, mh * f);
    }

    // 적이 진화한 순간 — 카드가 밝게 뛴다. 내 진화의 금빛 배너와 겹치지 않는 신호다
    if (this.fxFoeEra > 0) {
      const t = this.fxFoeEra / FX_FOE_ERA_F;
      ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.35 + 0.65 * t)];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(CMD_X - 2, CMD_Y - 2, CMD_W + 4, CMD_H + 4, 8);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
      if (this.fxTaunt <= 0 && this.fxLine <= 0) {
        const fade = t > 0.75 ? 1 : t / 0.75;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.font = FONT_MID;
        ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(fade)];
        ctx.fillText(LBL_FOE_UP, CMD_X + CMD_W - 46, CMD_Y + CMD_H + 12);
        ctx.font = FONT_SMALL;
        ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(fade * 0.9)];
        ctx.fillText(C.ERA_NAME[aiEra < C.ERA_COUNT ? aiEra : C.ERA_COUNT - 1],
                     CMD_X + CMD_W, CMD_Y + CMD_H + 14);
        ctx.textAlign = 'left';
      }
    }

    // 도발 중이면 초상에 금빛 고리가 돈다 — 놓치지 않게
    if (this.fxTaunt > 0) {
      const t = this.fxTaunt / FX_TAUNT_F;
      const px = CMD_X + 8 + CMD_PR, py = CMD_Y + 4 + CMD_PR;
      ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.35 + 0.65 * t)];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(px, py, CMD_PR + 4 + (1 - t) * 7, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }

    // 말풍선 — 도발이 대사보다 우선한다
    if (cmd < 0) return;
    if (this.fxTaunt > 0) {
      this.drawBubble(CMD_TAUNT ? CMD_TAUNT[cmd] : null,
                      director && !director.observing ? director.profileName : null,
                      1 - this.fxTaunt / FX_TAUNT_F, 1);
    } else if (this.fxLine > 0) {
      this.drawBubble(CMD_LINE ? CMD_LINE[cmd] : null, null,
                      1 - this.fxLine / FX_LINE_F, 0);
    }
  }

  // 말풍선 — 카드 아래에서 오른쪽 정렬로 자란다. 하늘 쪽이라 전장을 안 가린다.
  // 문자열을 만들지 않는다. 폭은 글자 수로 잡는다 (measureText 는 객체를 만든다).
  drawBubble(text, tag, t, taunt) {
    if (!text) return;
    const ctx = this.ctx;
    const fade = t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1;
    const grow = t < 0.12 ? easeOutBack(t / 0.12) : 1;
    const fs = taunt ? 19 : 16;
    let w = text.length * fs * 0.94 + 30;
    if (w > BUB_W_MAX) w = BUB_W_MAX;
    const h = tag ? 56 : 40;
    const x = CMD_X + CMD_W - w * grow, y = CMD_Y + CMD_H + 10;

    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.94 * fade)];
    ctx.beginPath();
    ctx.roundRect(x, y, w * grow, h, 7);
    ctx.moveTo(CMD_X + CMD_W - 40, y - 9);       // 꼬리 — 초상 쪽을 가리킨다
    ctx.lineTo(CMD_X + CMD_W - 18, y + 1);
    ctx.lineTo(CMD_X + CMD_W - 42, y + 1);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = (taunt ? C.RAMP_BONUS : C.RAMP_STRUCT)[C.rampIndex((taunt ? 0.95 : 0.6) * fade)];
    ctx.lineWidth = taunt ? 2.5 : 1.6;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w * grow - 1, h - 1, 7);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;
    if (grow < 1) return;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let ty = y + 11;
    if (tag) {
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.85 * fade)];
      ctx.fillText(LBL_READ, x + 14, ty);
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.75 * fade)];
      ctx.fillText(tag, x + 14 + LBL_READ.length * 10.5, ty);
      ty += 17;
    }
    ctx.font = taunt ? FONT_MID : FONT_SMALL;
    ctx.fillStyle = taunt ? C.RAMP_BONUS[C.rampIndex(fade)] : C.RAMP_PLAYER[C.rampIndex(0.9 * fade)];
    ctx.fillText(text, x + 14, ty);
  }

  // 카드 한 장 — 초상 · 이름 · 칭호 · 원정 진행 · **적 시대** · 적 편성.
  // 여기에 적 시대가 있는 이유: 내 시대는 좌상단에 크게 있는데 적 시대는
  // 어디에도 없었다. 그래서 "같이 진화하고 있다"가 안 느껴졌다 (사용자 지적).
  paintCommanderCard(cmd, stage, stageMax, aiEra, myEra) {
    const ctx = this.ctx;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.92)];
    ctx.beginPath();
    ctx.roundRect(CMD_X, CMD_Y, CMD_W, CMD_H, 7);
    ctx.fill();
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.5)];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(CMD_X + 0.5, CMD_Y + 0.5, CMD_W - 1, CMD_H - 1, 7);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const tx = CMD_X + (cmd >= 0 ? CMD_PR * 2 + 18 : 10);
    if (cmd >= 0) {
      this.drawEmblem(cmd, CMD_X + 8 + CMD_PR, CMD_Y + 4 + CMD_PR, CMD_PR);
      ctx.font = FONT_MID;
      ctx.fillStyle = C.COL_STRUCT;
      ctx.fillText(CMD_NAME[cmd], tx, CMD_Y + 4);
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.62)];
      if (CMD_TITLE) ctx.fillText(CMD_TITLE[cmd], tx + CMD_NAME[cmd].length * 20 + 6, CMD_Y + 11);

      // 원정 진행 — 몇 번째 전투인가. 지나온 칸은 금색이다
      ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.9)];
      ctx.beginPath();
      for (let i = 0; i < stageMax; i++) if (i < stage) ctx.rect(tx + i * 12, CMD_Y + 28, 8, 6);
      ctx.fill();
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.28)];
      ctx.beginPath();
      for (let i = 0; i < stageMax; i++) if (i > stage) ctx.rect(tx + i * 12, CMD_Y + 28, 8, 6);
      ctx.fill();
      ctx.fillStyle = C.COL_PLAYER;
      ctx.fillRect(tx + stage * 12, CMD_Y + 27, 8, 8);
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
      ctx.fillText(LBL_STAGE, tx + stageMax * 12 + 6, CMD_Y + 28);
      this.drawLeft(stage + 1, tx + stageMax * 12 + 24, CMD_Y + 28, 7);
      ctx.fillText(LBL_SLASH, tx + stageMax * 12 + 32, CMD_Y + 28);
      this.drawLeft(stageMax, tx + stageMax * 12 + 38, CMD_Y + 28, 7);
    }

    // ── 적 시대 사다리 — **한 줄에 두 진영의 시대가 같이 있다** ──
    // 채워진 칸이 적의 시대, 그 아래 흰 표식이 내 시대다. 누가 앞서는지가
    // 숫자를 읽지 않고 위치로 읽힌다.
    const ey = CMD_Y + 48;
    ctx.font = FONT_MICRO;
    ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.62)];
    ctx.fillText(LBL_FOE_ERA, CMD_X + 10, ey);
    ctx.font = FONT_SMALL;
    ctx.fillStyle = C.COL_STRUCT;
    ctx.fillText(C.ERA_NAME[aiEra < C.ERA_COUNT ? aiEra : C.ERA_COUNT - 1], CMD_X + 10, ey + 12);
    const lx = CMD_X + 56, lw = (CMD_W - 66) / C.ERA_COUNT;
    ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.20)];
    ctx.beginPath();
    for (let i = 0; i < C.ERA_COUNT; i++) ctx.rect(lx + i * lw, ey + 1, lw - 3, 9);
    ctx.fill();
    ctx.fillStyle = C.COL_STRUCT;
    ctx.beginPath();
    for (let i = 0; i <= aiEra && i < C.ERA_COUNT; i++) ctx.rect(lx + i * lw, ey + 1, lw - 3, 9);
    ctx.fill();
    // 내 시대 표식 — 같은 사다리 위. 앞서 있으면 오른쪽에 선다
    ctx.fillStyle = C.COL_PLAYER;
    ctx.beginPath();
    const mxp = lx + (myEra < C.ERA_COUNT ? myEra : C.ERA_COUNT - 1) * lw + (lw - 3) * 0.5;
    ctx.moveTo(mxp, ey + 11);
    ctx.lineTo(mxp + 4.5, ey + 17);
    ctx.lineTo(mxp - 4.5, ey + 17);
    ctx.closePath();
    ctx.fill();

    // 적 편성 — 아이콘 줄과 막대 홈은 안 바뀐다. 여기 굽고 막대만 매 프레임 얹는다
    const mx = CMD_X + 10, mw = CMD_W - 20, cw = mw / C.UNIT_KINDS;
    ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.16)];
    ctx.beginPath();
    for (let k = 0; k < C.UNIT_KINDS; k++) ctx.rect(mx + cw * k + 2, CMD_Y + 78, cw - 4, 15);
    ctx.fill();
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      this.drawMixIcon(k, mx + cw * (k + 0.5), CMD_Y + 104, C.RAMP_UNIT[k][C.rampIndex(0.72)]);
    }
  }

  // ── 사령관 문장(紋章) — 사진이 아니라 기호다 ────────────────
  // 여섯 색 안에서 다섯이 갈리려면 **형태가 서로 다른 종류**여야 한다:
  //   무리 = 점의 무리 · 쇄도 = 겹친 화살촉 · 금고 = 금화와 자물쇠
  //   성벽 = 총안 있는 벽 · 거울 = 좌우 대칭축
  drawEmblem(cmd, cx, cy, r) {
    const ctx = this.ctx;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(1)];
    ctx.beginPath();
    this.addCircle(cx, cy, r);
    ctx.fill();
    ctx.strokeStyle = C.RAMP_STRUCT[C.rampIndex(0.55)];
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    this.addCircle(cx, cy, r);
    ctx.stroke();

    ctx.fillStyle = C.COL_STRUCT;
    ctx.beginPath();
    const u = r / 21;                       // 21 기준으로 그리고 배율만 곱한다
    if (cmd === 0) {                        // 무리 — 점이 떼로 몰려온다
      for (let row = 0; row < 3; row++) {
        const n = 3 - Math.abs(row - 1);
        for (let k = 0; k < n; k++) {
          const px = cx + (row - 1) * 9 * u;
          const py = cy + (k - (n - 1) * 0.5) * 9 * u;
          this.addSpike(px + 4 * u, py, -1, 0, 8 * u, 3.4 * u);
        }
      }
    } else if (cmd === 1) {                 // 쇄도 — 겹친 화살촉
      for (let k = 0; k < 3; k++) {
        const ox = cx + 11 * u - k * 9 * u;
        ctx.moveTo(ox, cy - 11 * u);
        ctx.lineTo(ox - 9 * u, cy);
        ctx.lineTo(ox, cy + 11 * u);
        ctx.lineTo(ox - 3.4 * u, cy + 11 * u);
        ctx.lineTo(ox - 12.4 * u, cy);
        ctx.lineTo(ox - 3.4 * u, cy - 11 * u);
        ctx.closePath();
      }
    } else if (cmd === 2) {                 // 금고 — 자물쇠 손잡이와 금화
      ctx.rect(cx - 12 * u, cy - 7 * u, 24 * u, 18 * u);
      ctx.rect(cx - 7 * u, cy - 13 * u, 14 * u, 6 * u);
    } else if (cmd === 3) {                 // 성벽 — 총안
      ctx.rect(cx - 13 * u, cy - 3 * u, 26 * u, 15 * u);
      for (let k = 0; k < 3; k++) ctx.rect(cx - 13 * u + k * 10 * u, cy - 11 * u, 6 * u, 8 * u);
    } else {                                // 거울 — 좌우 대칭
      ctx.moveTo(cx - 3 * u, cy - 12 * u);
      ctx.lineTo(cx - 3 * u, cy + 12 * u);
      ctx.lineTo(cx - 14 * u, cy);
      ctx.closePath();
      ctx.moveTo(cx + 3 * u, cy - 12 * u);
      ctx.lineTo(cx + 3 * u, cy + 12 * u);
      ctx.lineTo(cx + 14 * u, cy);
      ctx.closePath();
    }
    ctx.fill();

    // 금색 한 점 — 다섯이 한 벌로 보이게 하는 표식. 자리가 다 다르다
    ctx.fillStyle = C.COL_BONUS;
    ctx.beginPath();
    if (cmd === 0) this.addCircle(cx - 13 * u, cy, 3 * u);
    else if (cmd === 1) this.addSpike(cx - 13 * u, cy, -1, 0, 7 * u, 3 * u);
    else if (cmd === 2) this.addCircle(cx, cy + 2 * u, 5 * u);
    else if (cmd === 3) ctx.rect(cx - 4 * u, cy + 1 * u, 8 * u, 11 * u);
    else { ctx.rect(cx - 1 * u, cy - 15 * u, 2 * u, 30 * u); }
    ctx.fill();
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
      const sy = LAY.y - 3, sh = LAY.h + 6;
      if (this.btnSig !== sig || this.btnScale !== s) {
        const w = Math.ceil(STRIP_W * s), h = Math.ceil(STRIP_MAXH * s);
        if (!this.btnCanvas) this.btnCanvas = document.createElement('canvas');
        if (this.btnCanvas.width !== w || this.btnCanvas.height !== h) {
          this.btnCanvas.width = w; this.btnCanvas.height = h;
        }
        const octx = this.btnCanvas.getContext('2d');
        const prev = this.ctx;
        this.ctx = octx;
        octx.setTransform(s, 0, 0, s, -STRIP_X * s, -sy * s);
        octx.clearRect(STRIP_X, sy, STRIP_W, STRIP_MAXH);
        this.paintButtonStrip(game);
        this.ctx = prev;
        this.btnSig = sig; this.btnScale = s;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.btnCanvas, 0, 0, Math.ceil(STRIP_W * s), Math.ceil(sh * s),
                    STRIP_X, sy, STRIP_W, sh);
      ctx.imageSmoothingEnabled = true;
    } else {
      this.paintButtonStrip(game);
    }
    this.drawButtonCooldowns();
  }

  // 무엇이 바뀌면 다시 구워야 하는가 — 가격·구매가능·**막힌 이유**·모드·남은 초·시대.
  // 쿨다운 원호와 남은 시간 막대는 서명에 넣지 않는다. 그건 매 프레임 위에 따로 그린다.
  //
  // btnPoor 를 따로 든다. 예전에는 "돈이 없다" 와 "아직 못 뽑는다" 가 둘 다
  // ok=0 하나로 뭉개져 **같은 회색**이었다 (실측: 소지금 37에 궁수 20이 회색).
  // 화면에 이유가 없으면 플레이어는 가격표를 의심한다. 그래서 이유를 나눈다 —
  //   돈이 없다   → 가격이 **붉어진다** (동전도 같이 죽는다)
  //   쿨다운      → 가격은 **금색 그대로**, 대신 칸 아래 **줄어드는 막대**가 산다
  computeButtonState(game) {
    const skillCd = game.skillCd;
    const ok = this.btnOk, cd = this.btnCd, cost = this.btnCost, mode = this.btnMode;
    const poor = this.btnPoor;
    let sig = (game.era | 0) * 7919;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      let o = 1, c = 0, price = -1, m = 0, p = 0;
      if (i < C.UNIT_KINDS) {
        price = game.cost(i);
        p = game.gold >= price ? 0 : 1;
        const full = game.spawnCooldown ? game.spawnCooldown(i) : C.U_SPAWN_CD[i];
        c = full > 0 ? game.spawnCd[i] / full : 0;
        o = (!p && !(c > 0)) ? 1 : 0;
        m = 0;                                     // 가격
      } else if (i === C.B_ERA) {
        o = game.eraReady() ? 1 : 0;
        m = 1;                                     // 다음 시대 이름 / 준비
      } else if (i === C.B_TOWER) {
        // 최강병기(거신) — 포탑이 다 쓴 칸을 물려받는다. towerLv 가 TOWER_MAX 에
        // 닿기 전에는 예전 그대로(가격 또는 "최대"). 닿은 뒤에는 이 칸 전체가
        // 병기 칸이다 — 셋 중 하나: 원정에서 이미 썼다(m=6) · 아직 시대가 안
        // 찼다(m=7) · 값만 남았다(m=0, 보통 가격 표시와 같은 길).
        if (game.towerLv >= C.TOWER_MAX) {
          if (game.wpnUsed) { m = 6; o = 0; }
          else if (game.era < C.ERA_COUNT - 1) { m = 7; o = 0; }
          else {
            price = C.WEAPON_COST;
            p = game.gold >= price ? 0 : 1;
            m = 0; o = p ? 0 : 1;
          }
        } else {
          price = game.towerCost ? game.towerCost() : -1;
          if (price < 0) { m = 2; o = 0; }           // 최대
          else { m = 0; p = game.gold >= price ? 0 : 1; o = p ? 0 : 1; }
        }
      } else {
        const sk = i === C.B_TIDE ? C.SK_TIDE : C.SK_VOLLEY;
        const raw = skillCd ? (skillCd[sk] || 0) : (sk === C.SK_TIDE ? (game.nukeCd || 0) : 0);
        c = raw / C.SKILL_CD[sk];
        o = raw <= 0 ? 1 : 0;
        m = o ? 3 : 4;                             // 준비 / 남은 초
        price = o ? -1 : Math.ceil(raw / 1000);
      }
      ok[i] = o; cd[i] = c; cost[i] = price; mode[i] = m; poor[i] = p;
      sig = (sig * 131 + o * 3 + m * 11 + p * 5 + (price + 1) * 37) | 0;
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
    const icy = LAY.y + LAY.iconDY, ir = LAY.iconR;
    ctx.lineWidth = 4;
    ctx.strokeStyle = C.RAMP_BG[C.rampIndex(0.85)];
    ctx.beginPath();
    for (let i = 0; i < C.BTN_COUNT; i++) {
      if (cd[i] <= 0) continue;
      const icx = btnX(i) + LAY.iconDX;
      ctx.moveTo(icx + ir, icy);
      ctx.arc(icx, icy, ir, 0, TAU);
    }
    ctx.stroke();
    for (let g = 0; g < 2; g++) {
      ctx.strokeStyle = (g ? C.RAMP_BONUS : C.RAMP_PLAYER)[C.rampIndex(0.8)];
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if (cd[i] <= 0 || (i >= C.B_ERA) !== !!g) continue;
        const icx = btnX(i) + LAY.iconDX;
        const a0 = -Math.PI * 0.5;
        ctx.moveTo(icx, icy - ir);
        ctx.arc(icx, icy, ir, a0, a0 + TAU * cd[i]);
        any = 1;
      }
      if (any) ctx.stroke();
    }
    ctx.lineWidth = C.STROKE;

    // 남은 시간 막대 — 칸 아래를 가로지른다. **원호만으로는 부족했다.**
    // 아이콘 위의 얇은 호는 그림의 일부처럼 보여서, 플레이어는 회색 칸을 보고
    // "돈이 모자란가?" 하고 소지금을 다시 셌다. 줄어드는 가로 막대는 시계다.
    const bary = LAY.y + LAY.h - 4;
    ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.22)];
    ctx.beginPath();
    for (let i = 0; i < C.BTN_COUNT; i++) {
      if (cd[i] <= 0) continue;
      ctx.rect(btnX(i) + 4, bary, BTN_W - 8, 3);
    }
    ctx.fill();
    for (let g = 0; g < 2; g++) {
      ctx.fillStyle = (g ? C.RAMP_BONUS : C.RAMP_PLAYER)[C.rampIndex(0.85)];
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if (cd[i] <= 0 || (i >= C.B_ERA) !== !!g) continue;
        const w = cd[i] > 1 ? 1 : cd[i];
        ctx.rect(btnX(i) + 4, bary, (BTN_W - 8) * w, 3);
        any = 1;
      }
      if (any) ctx.fill();
    }
  }

  // 버튼 열 한 장 — 카드 · 아이콘 · 글자. 쿨다운 원호는 여기 없다
  paintButtonStrip(game) {
    const ctx = this.ctx;
    const ok = this.btnOk, cost = this.btnCost, mode = this.btnMode, poor = this.btnPoor;
    const by = LAY.y, bh = LAY.h, P = LAY.portrait;
    ctx.textBaseline = 'top';

    // 2) 카드 — **그리기 호출 수가 곧 비용이다.** 칸마다 fill/stroke 를 부르면
    //    열 칸에서 서른 번이 되고, 그 서른 번이 합성 스레드를 밀어 스파이크가 된다.
    //    같은 색으로 칠할 것은 경로 하나에 모아 한 번에 칠한다.
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.96)];
    ctx.beginPath();
    for (let i = 0; i < C.BTN_COUNT; i++) {
      ctx.roundRect(btnX(i), by, BTN_W, bh, BTN_R);
    }
    ctx.fill();
    for (let g = 0; g < 2; g++) {                    // 물든 안쪽 — 유닛/특수기 두 계열
      ctx.fillStyle = (g ? C.RAMP_BONUS : C.RAMP_PLAYER)[C.rampIndex(0.07)];
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if (!ok[i] || (i >= C.B_ERA) !== !!g) continue;
        ctx.roundRect(btnX(i), by, BTN_W, bh, BTN_R);
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
        ctx.roundRect(btnX(i) + 0.5, by + 0.5, BTN_W - 1, bh - 1, BTN_R);
        any = 1;
      }
      if (any) ctx.stroke();
    }
    ctx.lineWidth = C.STROKE;

    // 2.5) 병종 띠 — 칸 왼쪽 모서리의 색 조각. **전장의 그 색 그대로다.**
    //      테두리(살 수 있는가)는 건드리지 않는다 — 채널을 섞으면 둘 다 안 읽힌다.
    for (let i = 0; i < C.BTN_COUNT; i++) {
      ctx.fillStyle = BTN_RAMP[i][C.rampIndex(ok[i] ? 1 : 0.40)];
      ctx.beginPath();
      ctx.roundRect(btnX(i) + 1, by + 3, 4, bh - 6, 2);
      ctx.fill();
    }

    // 3) 아이콘 — **칸마다 제 색이다.** 이 그림은 서명이 바뀔 때만 굽는 오프스크린
    //    한 장이라 칸당 fill 한 번을 써도 매 프레임 비용이 0 이다.
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = btnX(i);
      ctx.fillStyle = BTN_RAMP[i][C.rampIndex(ok[i] ? 0.98 : 0.32)];
      ctx.beginPath();
      if (this.addBtnIconFill(i, x + LAY.iconDX, by + LAY.iconDY)) ctx.fill();
    }
    ctx.lineWidth = 2;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = btnX(i);
      ctx.strokeStyle = BTN_RAMP[i][C.rampIndex(ok[i] ? 0.98 : 0.32)];
      ctx.beginPath();
      if (this.addBtnIconStroke(i, x + LAY.iconDX, by + LAY.iconDY)) ctx.stroke();
    }
    ctx.lineWidth = C.STROKE;
    ctx.fillStyle = C.COL_BG;                        // 방패 보스·바퀴 축 구멍
    ctx.beginPath();
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = btnX(i);
      this.addBtnIconHole(i, x + LAY.iconDX, by + LAY.iconDY);
    }
    ctx.fill();


    // 4) 동전 표식 — 색이 둘뿐이다. 경로를 모아 두 번에 칠한다.
    //    **기준은 ok 가 아니라 poor 다.** 쿨다운으로 막힌 칸은 돈이 있는 칸이므로
    //    동전이 살아 있어야 한다 — 그래야 "돈이 없다"와 눈에 갈린다.
    for (let pass = 0; pass < 3; pass++) {
      ctx.fillStyle = pass === 0 ? C.COL_BONUS
        : (pass === 1 ? C.RAMP_DANGER[C.rampIndex(0.75)] : C.RAMP_BG[C.rampIndex(0.95)]);
      ctx.beginPath();
      let any = 0;
      for (let i = 0; i < C.BTN_COUNT; i++) {
        if (mode[i] !== 0 || cost[i] < 0) continue;
        if (pass < 2 && (poor[i] === 0) !== (pass === 0)) continue;
        const x = btnX(i);
        const cyy = by + LAY.coinDY;
        this.addCircle(x + (P ? 14 : 12), cyy, pass === 2 ? (P ? 2.2 : 1.8) : (P ? 5.5 : 4.5));
        any = 1;
      }
      if (any) ctx.fill();
    }

    // 5) 글자 — **폰트를 세 번만 간다.** ctx.font 교체는 비싸고,
    //    칸마다 갈면 한 프레임에 서른 번이 된다. 실측에서 이게 스파이크의 주범이었다.
    ctx.textAlign = 'left';
    ctx.font = P ? FONT_BTN_P : FONT_BTN;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      // 이름도 그 병종 색이다. 검사는 거의 흰색이라 기본은 무채색으로 남는다
      ctx.fillStyle = BTN_RAMP[i][C.rampIndex(ok[i] ? 1 : 0.42)];
      ctx.fillText(btnLabel(game, i), btnX(i) + 10, by + LAY.nameDY);
    }

    ctx.font = P ? FONT_SMALL_P : FONT_SMALL;
    const ly = by + LAY.costDY;
    for (let i = 0; i < C.BTN_COUNT; i++) {
      const x = btnX(i);
      const m = mode[i];
      if (m === 0) {
        // 돈이 모자라면 **가격이 붉어진다.** 돈은 되는데 쿨다운이면 금색 그대로다
        ctx.fillStyle = poor[i] ? C.RAMP_DANGER[C.rampIndex(0.95)] : C.COL_BONUS;
        this.drawLeft(cost[i], x + (P ? 24 : 20), ly, P ? 13 : 9);
      } else if (m === 1) {
        ctx.fillStyle = ok[i] ? C.COL_BONUS : C.RAMP_PLAYER[C.rampIndex(0.32)];
        ctx.fillText(ok[i] ? READY : C.ERA_NAME[Math.min(C.ERA_COUNT - 1, game.era + 1)], x + 10, ly);
      } else if (m === 2) {
        ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.5)];
        ctx.fillText(LABEL_MAX, x + 10, ly);
      } else if (m === 3) {
        ctx.fillStyle = C.COL_BONUS;
        ctx.fillText(READY, x + 10, ly);
      } else if (m === 6) {
        // 최강병기 — 원정에서 이미 썼다. 최대(m=2)와 같은 자리, 다른 말.
        ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.5)];
        ctx.fillText(LABEL_WPN_USED, x + 10, ly);
      } else if (m === 7) {
        // 최강병기 — towerLv 는 찼지만 이 전투의 시대가 아직 안 찼다.
        // 진화 버튼(m=1)과 같은 말투: 준비되면 뭐가 뜰지 미리 보여 준다.
        ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.32)];
        ctx.fillText(C.ERA_NAME[C.ERA_COUNT - 1], x + 10, ly);
      } else {
        ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.34)];
        const wsec = this.drawLeft(cost[i], x + 10, ly, P ? 13 : 9);
        ctx.fillText(LABEL_S, x + 10 + wsec + 1, ly);
      }
    }

    ctx.font = P ? FONT_MICRO_P : FONT_MICRO;
    ctx.textAlign = 'right';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.38)];
    for (let i = 0; i < C.BTN_COUNT; i++) {
      ctx.fillText(C.KEY_HINT[i], btnX(i) + BTN_W - 5, by + LAY.nameDY);
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
    // **증원도 제 색을 가진다.** 우하단 원만 금색으로 남으면 그 칸이
    // 진화·포탑과 같은 것으로 읽힌다 — 스킬인데 스킬로 안 보였다.
    const RY = (C.RAMP_SKILL && C.RAMP_SKILL[C.SK_RALLY]) || C.RAMP_BONUS;

    ctx.fillStyle = C.COL_BG;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, TAU);
    ctx.fill();
    if (ok) {
      ctx.fillStyle = RY[C.rampIndex(0.10)];
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
    }

    if (cd > 0) {                       // 쿨다운 — 남은 만큼의 원호
      ctx.strokeStyle = RY[C.rampIndex(0.30)];
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 2, -Math.PI * 0.5, -Math.PI * 0.5 + TAU * cd);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;
    }
    ctx.strokeStyle = RY[C.rampIndex(ok ? 0.95 : 0.30)];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();

    // 아이콘 — 작은 사람 셋이 위로 솟는다. "셋이 온다"가 그대로 보인다
    ctx.fillStyle = RY[C.rampIndex(ok ? 1 : 0.32)];
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
    // **이름을 단다.** 다른 아홉 칸은 전부 이름이 있는데 이 칸만 'R' 하나였고,
    // 그래서 무슨 버튼인지 알 방법이 화면에 없었다. 시대가 오르면 이름이
    // 바뀌므로(증원→원군→정예군) game 에게 묻는다 — 스킬 버튼과 같은 규칙이다.
    const name = (game && typeof game.skillName === 'function')
      ? (game.skillName(C.SK_RALLY) || RALLY_NAME) : RALLY_NAME;
    ctx.fillStyle = RY[C.rampIndex(ok ? 1 : 0.34)];
    ctx.fillText(name, cx, cy - r + 3);
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
    const banTxt = BAN_TXT[feel.bannerCode];
    if (banTxt) ctx.fillText(banTxt, HALF_W, y);
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

    // 진화 직후에만 열리는 화면이다(buyEra() 가 openDraft() 를 곧장 부른다) —
    // era 는 항상 ≥1. "방금 뭐가 바뀌었는지"를 카드보다 먼저 두 줄로 박는다.
    if (game.era > 0) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.COL_BONUS;
      ctx.fillText('◈ ' + C.ERA_NAME[game.era] + ' 시대 진입 — ' + C.ERA_ABILITY_NAME[game.era], HALF_W, 94);
      ctx.font = FONT_MICRO;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.62)];
      ctx.fillText(C.ERA_ABILITY_DESC[game.era], HALF_W, 112);
    }

    const cw = C.VIEW_W * 0.66;
    for (let i = 0; i < C.TRAIT_OFFER; i++) {
      const idx = game.draftIdx[i];
      if (idx < 0) continue;
      // 특성이든 숙련이든 카드 한 장은 같은 함수로만 읽는다.
      // C.TRAITS[idx] 로 직접 읽으면 숙련 인덱스(100+)에서 undefined 가 되고
      // 그 프레임에 렌더가 통째로 죽는다 — 드래프트는 화면이 멈춘 상태다.
      const tr = C.draftCard(idx);
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

  // ── 설명 화면 — 심사자가 이 게임을 처음 보는 2초 ────────────
  // **읽는 화면이 아니라 보는 화면이다.** 긴 문단은 아무도 안 읽는다.
  // 좌우 기지 · 금으로 병력 · 차오르는 물, 그리고 **상성도**를 그림으로 말한다.
  // 화살표 목록은 C.COUNTER 에서 뽑는다 (CTR_A/CTR_D) — 표에 있는 우위가 전부 나온다.
  // 전부 정적이므로 한 번 굽고, 매 프레임은 화살표와 "눌러 시작"만 얹는다.
  drawBrief(game, feel) {
    const ctx = this.ctx;
    if (typeof document !== 'undefined') {
      const s = this.viewScale > 2 ? 2 : (this.viewScale < 0.25 ? 0.25 : this.viewScale);
      // 증원의 이름은 시대마다 바뀐다 (증원→원군→정예군). 서명에 넣지 않으면
      // 굽힌 그림에 옛 이름이 그대로 남는다 — 버튼에서 겪은 그 실패다
      const sig = s + LAY.portrait * 100 + ((game && game.era | 0) + 1) * 1000;
      if (this.briefScale !== sig) {
        const w = Math.ceil(C.VIEW_W * s), h = Math.ceil(C.VIEW_H * s);
        if (!this.briefCanvas) this.briefCanvas = document.createElement('canvas');
        if (this.briefCanvas.width !== w || this.briefCanvas.height !== h) {
          this.briefCanvas.width = w; this.briefCanvas.height = h;
        }
        const octx = this.briefCanvas.getContext('2d');
        const prev = this.ctx;
        this.ctx = octx;
        octx.setTransform(s, 0, 0, s, 0, 0);
        octx.clearRect(0, 0, C.VIEW_W, C.VIEW_H);
        this.paintBrief(game);
        this.ctx = prev;
        this.briefScale = sig;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.briefCanvas, 0, 0, C.VIEW_W, C.VIEW_H);
      ctx.imageSmoothingEnabled = true;
    } else {
      this.paintBrief(game);
    }
    // 상성 화살표 — **하나씩 순서대로** 그린다. 한꺼번에 보여 주면 그림이
    // 아니라 무늬가 된다. game.stateTick 이 BRIEF 진입 후 프레임 수다.
    // 목록은 C.COUNTER 에서 뽑은 것이라 **표에 있는 우위가 전부** 나온다.
    const tick = (typeof game.stateTick === 'number') ? game.stateTick : 600;
    // **화살표도 이기는 쪽의 병종 색이다.** 여섯 개가 다 금색이면 어느 화살표가
    // 누구에게서 나갔는지 선을 눈으로 따라가야 알 수 있다. 색이 그걸 대신한다
    for (let k = 0; k < CTR_N; k++) {
      const f = (tick - k * BRIEF_STEP) / BRIEF_STEP;
      if (f <= 0) continue;
      const g = f > 1 ? 1 : easeOutCubic(f);
      const a = CTR_A[k], d = CTR_D[k];
      const x0 = RING_NX[a], y0 = RING_NY[a];
      ctx.fillStyle = C.RAMP_UNIT[a][C.rampIndex(0.95)];
      ctx.beginPath();
      this.addArrow(x0, y0, x0 + (RING_NX[d] - x0) * g, y0 + (RING_NY[d] - y0) * g, 30);
      ctx.fill();
    }

    // 진짜 버튼 열을 설명 위에 다시 올린다 — 화살표가 가리키는 그 칸이다
    this.drawButtons(game);
    this.drawRally(game);
    // ── 확인 버튼 ────────────────────────────────────────────
    // 화면이 혼자 사라지지 않으므로 **누를 곳이 눈에 보여야 한다.** 숨쉬듯
    // 밝기만 오가고 크기는 안 변한다 — 커졌다 작아지는 버튼은 누르기 어렵다.
    // BRIEF 상태에서는 stateTick 만 도므로 그것으로 맥을 만든다 (결정론 유지).
    const pulse = 0.62 + 0.38 * Math.sin(game.stateTick * 0.09);
    const bx = HALF_W - BR_BTN_W * 0.5, by = LAY.y - BR_BTN_H - 30;
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.10 + 0.10 * pulse)];
    ctx.beginPath();
    ctx.roundRect(bx, by, BR_BTN_W, BR_BTN_H, 10);
    ctx.fill();
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(pulse)];
    ctx.lineWidth = C.STROKE;
    ctx.beginPath();
    ctx.roundRect(bx + 1, by + 1, BR_BTN_W - 2, BR_BTN_H - 2, 10);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_MID;
    ctx.fillStyle = C.COL_BONUS;
    ctx.fillText(BR_START, HALF_W, by + BR_BTN_H * 0.5);
    // 버튼 밖도 다 받는다는 사실을 **글로 적어 둔다.** 안 적으면 아무도 모른다.
    ctx.font = FONT_MICRO;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.42)];
    ctx.fillText(BR_HINT, HALF_W, by + BR_BTN_H + 14);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  paintBrief(game) {
    const ctx = this.ctx;
    // 화면을 덮되 **버튼 열은 위에 다시 올린다** (drawBrief 가 그 일을 한다).
    // 설명이 가리키는 손가락 자리가 진짜 버튼이어야 배운다.
    const H = LAY.y - 6;
    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, C.VIEW_W, H);
    ctx.clip();
    ctx.strokeStyle = C.RAMP_GRID[C.rampIndex(0.55)];
    ctx.lineWidth = 1;
    ctx.stroke(this.bgPath);
    ctx.restore();
    ctx.lineWidth = C.STROKE;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_BIG;
    ctx.fillStyle = C.COL_PLAYER;
    ctx.fillText(BR_TITLE, HALF_W, 40);
    ctx.font = FONT_SMALL;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.6)];
    ctx.fillText(BR_SUB, HALF_W, 72);
    ctx.strokeStyle = C.RAMP_BONUS[C.rampIndex(0.5)];
    ctx.beginPath();
    ctx.moveTo(HALF_W - 210, 90); ctx.lineTo(HALF_W + 210, 90);
    ctx.stroke();

    // ── 왼쪽 — 상성 고리. 이 화면에서 가장 중요한 그림이다 ──
    ctx.font = FONT_MID;
    ctx.fillStyle = C.COL_BONUS;
    ctx.fillText(BR_RING, 286, 118);

    const cx = RING_CX, cy = RING_CY;
    // 화살표는 여기서 굽지 않는다 — **하나씩 순서대로 나타나야** 고리가 읽힌다.
    // 배지와 이름은 **전장에서 쓰는 그 색**이다. 설명 화면에서 익힌 색이
    // 그대로 버튼이고 그대로 유닛이어야 한 번 배운 것이 두 번 쓰인다.
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      this.drawUnitBadge(k, RING_NX[k], RING_NY[k], 1, C.U_COL[k]);
    }
    ctx.font = FONT_SMALL;
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      ctx.fillStyle = C.RAMP_UNIT[k][C.rampIndex(0.95)];
      ctx.fillText(BTN_NAME[k], RING_NX[k], RING_NY[k] + RING_LDY[k]);
    }
    ctx.font = FONT_MICRO;
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(0.62)];
    ctx.fillText(BR_ARROW, cx, cy);
    // 거인·투석기에는 나가는 화살표가 없다. **그 사실 자체를 적는다** —
    // 안 적으면 화면이 덜 그려진 것으로 보인다 (실제로 그렇게 보고됐다).
    ctx.textAlign = 'left';
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.42)];
    ctx.fillText(BR_NOEDGE, 16, 352);
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.22)];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(RING_NX[C.U_GIANT], RING_NY[C.U_GIANT] + 30);
    ctx.lineTo(10, 344);
    ctx.moveTo(RING_NX[C.U_CATA], RING_NY[C.U_CATA] + 30);
    ctx.lineTo(10, 344);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;
    ctx.textAlign = 'center';

    // ── 오른쪽 — 판이 어떻게 굴러가는가. 세 줄 ──
    const RX = 600;
    ctx.textAlign = 'left';
    for (let r = 0; r < 3; r++) {
      const y = 150 + r * 84;
      ctx.fillStyle = C.RAMP_BG[C.rampIndex(0.75)];
      ctx.beginPath();
      ctx.roundRect(RX - 26, y - 34, 330, 68, 8);
      ctx.fill();
      ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.14)];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(RX - 26, y - 34, 330, 68, 8);
      ctx.stroke();
      ctx.lineWidth = C.STROKE;

      if (r === 0) {                                 // 기지 → 기지
        ctx.fillStyle = C.COL_PLAYER;
        ctx.beginPath();
        ctx.rect(RX - 8, y - 14, 20, 28);
        for (let k = 0; k < 3; k++) ctx.rect(RX - 8 + k * 7, y - 20, 5, 6);
        ctx.fill();
        ctx.fillStyle = C.COL_STRUCT;
        ctx.beginPath();
        ctx.rect(RX + 76, y - 14, 20, 28);
        for (let k = 0; k < 3; k++) ctx.rect(RX + 76 + k * 7, y - 20, 5, 6);
        ctx.fill();
        ctx.fillStyle = C.COL_BONUS;
        ctx.beginPath();
        this.addBar(RX + 20, y, 1, 0, 34, 0, 2.4, 2.4);
        this.addSpike(RX + 54, y, 1, 0, 14, 7);
        ctx.fill();
      } else if (r === 1) {                          // 금 → 병력
        ctx.fillStyle = C.COL_BONUS;
        ctx.beginPath();
        this.addCircle(RX + 2, y, 12);
        ctx.fill();
        ctx.fillStyle = C.COL_BG;
        ctx.beginPath();
        this.addCircle(RX + 2, y, 4.6);
        ctx.fill();
        ctx.fillStyle = C.COL_BONUS;
        ctx.beginPath();
        this.addBar(RX + 22, y, 1, 0, 26, 0, 2.4, 2.4);
        this.addSpike(RX + 48, y, 1, 0, 13, 7);
        ctx.fill();
        this.drawUnitBadge(C.U_SWORD, RX + 82, y, 0.9, C.COL_PLAYER);
      } else {                                       // 물이 차오른다
        ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.5)];
        ctx.fillRect(RX - 10, y + 4, 116, 20);
        ctx.fillStyle = C.COL_DANGER;
        ctx.fillRect(RX - 10, y + 2, 116, 3);
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          const ax = RX + 8 + k * 40;
          this.addBar(ax, y + 2, 0, -1, 18, 0, 2.2, 2.2);
          this.addSpike(ax, y - 16, 0, -1, 11, 6.5);
        }
        ctx.fill();
      }
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.8)];
      ctx.fillText(r === 0 ? BR_1 : (r === 1 ? BR_2 : BR_3), RX + 132, y);
    }

    // 아래를 가리키던 큰 화살표 둘은 뺐다 — **범례가 그 자리를 대신한다.**
    // 화살표는 "저기를 봐라"까지만 말했고, 정작 그 칸이 왜 회색인지는 안 말했다.
    // 그게 플레이어가 끝까지 몰랐던 것이었다.

    // ── 범례 — **끝까지 몰랐던 것들** ──────────────────────────
    // 실제 플레이 보고에서 나온 여섯 가지다. 가운데는 「전투 시작」 버튼이
    // 차지하므로 좌우 두 덩이로 나눠 그 사이를 비워 둔다.
    // 세로 좌표는 H(=버튼 열 바로 위)에서 되짚는다 — 폰 세로에서 버튼 열이
    // 올라오면 범례도 같이 올라온다.
    const LG0 = H - 74, LGH = 26;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_MICRO;
    for (let col = 0; col < 2; col++) {
      const lx = col ? 620 : 12;
      for (let r = 0; r < 3; r++) {
        const y = LG0 + r * LGH;
        const n = col * 3 + r;
        // 아이콘 — 글자를 못 읽어도 어느 칸 얘기인지는 모양이 말한다
        const ix = lx + 12;
        if (n === 0) {                                   // 진화
          ctx.fillStyle = C.COL_BONUS;
          ctx.beginPath();
          ctx.moveTo(ix, y - 8); ctx.lineTo(ix + 7, y + 1); ctx.lineTo(ix + 3, y + 1);
          ctx.lineTo(ix + 3, y + 8); ctx.lineTo(ix - 3, y + 8); ctx.lineTo(ix - 3, y + 1);
          ctx.lineTo(ix - 7, y + 1); ctx.closePath();
          ctx.fill();
        } else if (n === 1) {                            // 포탑
          ctx.fillStyle = C.COL_BONUS;
          ctx.beginPath();
          ctx.rect(ix - 8, y + 2, 16, 6);
          ctx.rect(ix - 5, y - 4, 10, 6);
          this.addBar(ix + 2, y - 2, 1, -0.2, 10, 1, 2, 1.5);
          ctx.fill();
        } else if (n === 2) {                            // 증원
          ctx.fillStyle = (C.SKILL_COL && C.SKILL_COL[C.SK_RALLY]) || C.COL_BONUS;
          ctx.beginPath();
          for (let k = 0; k < 3; k++) {
            const px = ix + (k - 1) * 6;
            const hh = k === 1 ? 9 : 6;
            ctx.rect(px - 1.6, y - hh * 0.5 + 2, 3.2, hh);
            this.addCircle(px, y - hh * 0.5, 1.9);
          }
          ctx.fill();
        } else if (n === 3) {                            // 회색 칸 두 종류
          ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.9)];
          ctx.beginPath(); ctx.roundRect(ix - 10, y - 7, 9, 14, 2); ctx.fill();
          ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.30)];
          ctx.beginPath(); ctx.roundRect(ix + 1, y - 7, 9, 14, 2); ctx.fill();
          ctx.fillStyle = C.COL_PLAYER;
          ctx.fillRect(ix + 2, y + 4, 4, 2);
        } else if (n === 4) {                            // 전선 막대
          ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.7)];
          ctx.fillRect(ix - 11, y - 4, 22, 9);
          ctx.fillStyle = C.COL_PLAYER;
          ctx.fillRect(ix - 11, y - 4, 12, 9);
          ctx.fillStyle = C.COL_BONUS;
          ctx.beginPath();
          ctx.moveTo(ix + 1, y - 5); ctx.lineTo(ix - 3, y - 10); ctx.lineTo(ix + 5, y - 10);
          ctx.closePath(); ctx.fill();
        } else {                                         // 물
          ctx.fillStyle = C.RAMP_DANGER[C.rampIndex(0.45)];
          ctx.fillRect(ix - 11, y - 1, 22, 9);
          ctx.fillStyle = C.COL_DANGER;
          ctx.fillRect(ix - 11, y - 3, 22, 2.5);
          ctx.fillStyle = C.COL_PLAYER;
          ctx.fillRect(ix - 8, y - 10, 5, 8);
          ctx.strokeStyle = C.COL_STRUCT;
          ctx.lineWidth = 1.4;
          ctx.strokeRect(ix + 3.5, y - 9.5, 5, 8);
          ctx.lineWidth = C.STROKE;
        }
        // 글자
        ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.62)];
        if (n === 2) {
          // 증원의 이름은 game 이 준다 (증원→원군→정예군). 문자열을 만들지 않고
          // 이름과 설명을 **따로** 찍는다 — 이 파일의 규율이다
          const nm = (game && typeof game.skillName === 'function')
            ? (game.skillName(C.SK_RALLY) || RALLY_NAME) : RALLY_NAME;
          ctx.fillStyle = (C.SKILL_COL && C.SKILL_COL[C.SK_RALLY]) || C.COL_BONUS;
          ctx.fillText(nm, lx + 28, y);
          ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.62)];
          ctx.fillText(BR_L3, lx + 28 + nm.length * 11, y);
        } else {
          ctx.fillText(n === 0 ? BR_L1 : (n === 1 ? BR_L2
            : (n === 3 ? BR_L4 : (n === 4 ? BR_L5 : BR_L6))), lx + 28, y);
        }
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
  }

  // 두 점을 잇는 화살표. 양 끝을 gap 만큼 비워 아이콘을 안 덮는다
  addArrow(x0, y0, x1, y1, gap) {
    let dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len, uy = dy / len;
    const sx = x0 + ux * gap, sy = y0 + uy * gap;
    const ex = x1 - ux * gap, ey = y1 - uy * gap;
    const body = Math.sqrt((ex - sx) * (ex - sx) + (ey - sy) * (ey - sy)) - 14;
    if (body <= 0) return;
    this.addBar(sx, sy, ux, uy, body, 0, 2.2, 2.2);
    this.addSpike(sx + ux * body, sy + uy * body, ux, uy, 14, 7);
  }

  // 유닛 배지 — 버튼 아이콘을 그대로 키워 쓴다. 버튼과 같은 그림이어야 배운다
  drawUnitBadge(kind, cx, cy, sc, color) {
    const ctx = this.ctx;
    ctx.fillStyle = C.RAMP_BG[C.rampIndex(1)];
    ctx.beginPath();
    this.addCircle(cx, cy, 27 * sc);
    ctx.fill();
    ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.35)];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this.addCircle(cx, cy, 27 * sc);
    ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (this.addBtnIconFill(kind, 0, 0)) ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (this.addBtnIconStroke(kind, 0, 0)) ctx.stroke();
    ctx.fillStyle = C.COL_BG;
    ctx.beginPath();
    this.addBtnIconHole(kind, 0, 0);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = C.STROKE;
  }

  // ── 결과 ────────────────────────────────────────────────────
  drawResult(game, feel, director) {
    const ctx = this.ctx;
    if (feel.resultStep < 0) return;
    // 카드가 올라온 뒤로 흐른 시간. feel.resultStep 이 아니라 렌더 프레임을 쓴다 —
    // resultStep 은 히트스톱 동안 멈추므로, 그걸 기준으로 삼으면 카드가 뜰 때
    // 이미 다 차 있는 판과 아직 0 인 판이 섞인다.
    const t0 = (this.overFrames - RESULT_HOLD_F) / RESULT_REVEAL_F;
    const t = t0 < 0 ? 0 : (t0 > 1 ? 1 : t0);
    const e = t >= 1 ? 1 : easeOutBack(t);

    // ── 다 뜬 결과 카드는 **한 픽셀도 안 바뀐다.** 구워서 붙인다 ──
    // 이 화면은 다음 입력이 올 때까지 무한히 떠 있고, 그동안 매 프레임
    // 문양 다섯 · 통계 네 줄 · 스무 번 넘는 fillText 를 다시 그리고 있었다.
    // 버튼 열·사령관 카드·설명 화면이 이미 쓰는 규칙을 여기에도 적용한다.
    // 들어오는 연출(e < 1) 동안만 직접 그린다 — 그때는 매 프레임 달라지니까.
    if (t >= 1 && typeof document !== 'undefined') {
      const s = this.viewScale > 2 ? 2 : (this.viewScale < 0.25 ? 0.25 : this.viewScale);
      if (!this.resCardOn || this.resCardScale !== s) {
        const w = Math.ceil(C.VIEW_W * s), h = Math.ceil(C.VIEW_H * s);
        if (!this.resCardCanvas) this.resCardCanvas = document.createElement('canvas');
        if (this.resCardCanvas.width !== w || this.resCardCanvas.height !== h) {
          this.resCardCanvas.width = w; this.resCardCanvas.height = h;
        }
        const octx = this.resCardCanvas.getContext('2d');
        const prev = this.ctx;
        this.ctx = octx;
        octx.setTransform(s, 0, 0, s, 0, 0);
        octx.clearRect(0, 0, C.VIEW_W, C.VIEW_H);
        this.paintResult(game, director, 1);
        this.ctx = prev;
        this.resCardOn = 1; this.resCardScale = s;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.resCardCanvas, 0, 0, C.VIEW_W, C.VIEW_H);
      ctx.imageSmoothingEnabled = true;
      return;
    }
    this.paintResult(game, director, e);
  }

  // 결과 카드 한 장. e 는 차오르는 정도(1 이면 다 떴다).
  paintResult(game, director, e) {
    const ctx = this.ctx;
    // 원정 상태 — 필드가 없으면 stage = -1 이고 예전 화면 그대로다
    const stage = (typeof game.stage === 'number') ? (game.stage | 0) : -1;
    const stageMax = (typeof game.stageMax === 'number') ? (game.stageMax | 0) : CAMP_LEN;
    const won = game.outcome === C.WIN_PLAYER;
    const campOver = !!game.campaignOver;
    const camp = stage >= 0 && !!CMD_NAME;
    const cleared = camp ? stage + (won ? 1 : 0) : 0;
    const goNext = camp && won && !campOver;

    // **막은 처음부터 불투명하다.** 예전에는 0.55 에서 시작해 420ms 에 걸쳐
    // 덮었고, 그 동안 전장·HUD·배너가 통계 위로 비쳤다. 결과 화면은 읽는
    // 화면이지 연출이 아니다 — 들어오는 연출은 위의 HOLD 프레임이 맡는다.
    ctx.fillStyle = C.COL_BG;
    ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 제목 — **전투 클리어와 원정 종료는 다르게 느껴져야 한다**
    let title = won ? LABEL_WIN : (game.outcome === C.WIN_DROWN ? LABEL_DROWN : LABEL_LOSE);
    if (camp) {
      if (goNext) title = LBL_CLEAR;
      else if (cleared >= stageMax) title = LBL_CAMP_WIN;
      else title = LBL_CAMP_END;
    }
    const col = (won || cleared >= stageMax) ? C.RAMP_BONUS
      : (game.outcome === C.WIN_DROWN ? C.RAMP_DANGER : C.RAMP_PLAYER);
    const topY = camp ? HALF_H - C.UNIT * 20 : HALF_H - C.UNIT * 15;
    ctx.strokeStyle = col[C.rampIndex(0.4 * e)];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(HALF_W - 200 * e, topY); ctx.lineTo(HALF_W + 200 * e, topY);
    ctx.moveTo(HALF_W - 200 * e, topY + C.UNIT * 7.5); ctx.lineTo(HALF_W + 200 * e, topY + C.UNIT * 7.5);
    ctx.stroke();
    ctx.lineWidth = C.STROKE;
    ctx.font = FONT_BIG;
    ctx.fillStyle = col[C.rampIndex(1)];
    ctx.fillText(title, HALF_W, topY + C.UNIT * 3.8);

    // 원정 행렬 — 다섯 사령관. 격파한 자는 금색이고 가위표가 쳐진다.
    // 이 한 줄이 "한 판"이 아니라 "여정"이라고 말한다.
    if (camp) {
      const n = stageMax < CMD_NAME.length ? stageMax : CMD_NAME.length;
      const gap = 96, x0 = HALF_W - (n - 1) * gap * 0.5;
      const ey = topY + C.UNIT * 16;
      ctx.font = FONT_MICRO;
      for (let i = 0; i < n; i++) {
        const ex = x0 + i * gap;
        const beaten = i < cleared;
        this.drawEmblem(i, ex, ey, 26 * (beaten ? 1 : 0.86));
        if (beaten) {                        // 격파 — 금색 가위표
          ctx.strokeStyle = C.COL_BONUS;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(ex - 16, ey - 16); ctx.lineTo(ex + 16, ey + 16);
          ctx.moveTo(ex + 16, ey - 16); ctx.lineTo(ex - 16, ey + 16);
          ctx.stroke();
          ctx.lineWidth = C.STROKE;
        } else if (i === cleared) {          // 다음 상대 — 흰 고리
          ctx.strokeStyle = C.RAMP_PLAYER[C.rampIndex(0.9)];
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(ex, ey, 31, 0, TAU);
          ctx.stroke();
          ctx.lineWidth = C.STROKE;
        }
        ctx.fillStyle = beaten ? C.COL_BONUS
          : (i === cleared ? C.COL_PLAYER : C.RAMP_STRUCT[C.rampIndex(0.45)]);
        ctx.fillText(CMD_NAME[i], ex, ey + 40);
      }
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.55)];
      ctx.fillText(LBL_BEATEN, HALF_W, ey - 44);
      ctx.fillStyle = C.COL_BONUS;
      this.drawNumber(cleared, HALF_W + 54, ey - 44, 10);
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.45)];
      ctx.fillText(LBL_SLASH, HALF_W + 64, ey - 44);
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.7)];
      this.drawNumber(stageMax, HALF_W + 76, ey - 44, 10);
      // 다음 상대의 대사 한 줄 — "한 판 더"가 눌리는 자리다
      if (goNext && cleared < CMD_NAME.length && CMD_LINE) {
        ctx.font = FONT_MICRO;
        ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.7)];
        ctx.fillText(LBL_NEXT_FOE, HALF_W, ey + 64);
        ctx.font = FONT_SMALL;
        ctx.fillStyle = C.COL_STRUCT;
        ctx.fillText(CMD_LINE[cleared], HALF_W, ey + 86);
      }
    }

    if (director && director.deathLine && !won && !camp) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
      ctx.fillText(director.deathLine, HALF_W, HALF_H - C.UNIT * 5);
    }

    // 통계 — 원정 화면에서는 줄을 줄인다. 숫자보다 여정이 먼저다
    ctx.font = FONT_SMALL;
    const lx = HALF_W - C.UNIT * 2, vx = HALF_W + C.UNIT * 2;
    let y = camp ? HALF_H + C.UNIT * 11 : HALF_H - C.UNIT * 0.5;
    const row = (label, drawVal) => {
      ctx.textAlign = 'right';
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.55)];
      ctx.fillText(label, lx, y);
      ctx.textAlign = 'left';
      ctx.fillStyle = C.COL_PLAYER;
      drawVal(vx, y);
      ctx.textAlign = 'center';
      y += C.UNIT * 3.4;
    };
    // **판이 끝난 순간에 멈춘 시간**을 찍는다. elapsed() 를 매 프레임 읽으면
    // 결과 화면에서 시간이 계속 늘어난다 (실제로 그렇게 보였다)
    // game.js 가 endTime 에서 시계를 세운다. 그 전 빌드에서는 렌더가 잡아 둔
    // 값을 쓴다 — 어느 쪽이든 결과 화면의 시간은 **늘어나지 않는다**
    const secs = (typeof game.stageTime === 'function') ? game.stageTime()
      : (this.overTime >= 0 ? this.overTime : game.elapsed());
    row(LABEL_TIME, (x, yy) => {
      const w = this.drawFixed1(secs * e, x, yy);
      ctx.fillText(LABEL_S, x + w + 2, yy);
    });
    if (camp && typeof game.campaignTime === 'function') {
      row(LBL_CAMP_TIME, (x, yy) => {
        const w = this.drawFixed1(game.campaignTime() * e, x, yy);
        ctx.fillText(LABEL_S, x + w + 2, yy);
      });
    }
    if (!camp) {
      row(LABEL_KILL, (x, yy) => this.drawLeft(game.kills * e, x, yy, 9));
      row(LABEL_LOST, (x, yy) => this.drawLeft(game.lost * e, x, yy, 9));
      row(LABEL_SPAWN, (x, yy) => this.drawLeft(game.spawned * e, x, yy, 9));
    } else {
      row(LABEL_KILL, (x, yy) => this.drawLeft(game.kills * e, x, yy, 9));
    }
    row(LABEL_PROFILE, (x, yy) =>
      ctx.fillText(director ? director.profileName : PROFILE_UNKNOWN, x, yy));

    // ── 내가 실제로 뽑은 구성 ──────────────────────────────────
    // 상성 삼각형이 이 게임의 핵심인데, 판이 끝난 뒤에도 **내가 뭘 뽑았는지**를
    // 볼 곳이 없었다. 색은 전장·버튼·설명 화면과 같다 — 한 번 배운 것이 여기서
    // 다시 쓰인다. game 이 spawnedKind 를 안 주는 빌드에서는 조용히 건너뛴다.
    //
    // **구워서 붙인다.** 처음엔 매 프레임 그렸다가 계측기가 잡았다 —
    // 막대 6 + 아이콘 6 + 숫자 6(fillText 12)이 결과 화면 내내 돌았고,
    // 결과 화면은 다음 입력이 올 때까지 **얼마든지 오래** 떠 있다.
    // 프레임 초과가 58 → 66 으로 올랐고 이 패널 하나가 그 8 전부였다.
    // 그림은 판이 끝난 뒤로 안 바뀐다. 한 번 굽고 한 번 붙이는 것이 맞다.
    this.paintResultMix(game.spawnedKind);

    ctx.textAlign = 'center';
    ctx.fillStyle = C.RAMP_BONUS[C.rampIndex(goNext ? 0.95 : 0.6)];
    ctx.font = goNext ? FONT_MID : FONT_SMALL;
    ctx.fillText(camp ? (goNext ? LBL_NEXT_KEY : LBL_NEW_KEY) : LABEL_RETRY,
                 HALF_W, C.VIEW_H - C.UNIT * 4);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
  }

  paintResultMix(smk) {
    const ctx = this.ctx;
    if (!smk || smk.length < C.UNIT_KINDS) return;
    let mx = 1;
    for (let k = 0; k < C.UNIT_KINDS; k++) if (smk[k] > mx) mx = smk[k];
    const MW = RMIX_W / C.UNIT_KINDS, MH = 30;
    const my = RMIX_Y + 22;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_MICRO;
    ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.45)];
    ctx.fillText(LBL_MYMIX, RMIX_X + RMIX_W * 0.5, RMIX_Y + 8);
    // 홈은 색이 하나다 — 한 경로에 모은다
    ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.16)];
    ctx.beginPath();
    for (let k = 0; k < C.UNIT_KINDS; k++) ctx.rect(RMIX_X + MW * (k + 0.5) - 11, my, 22, MH);
    ctx.fill();
    for (let k = 0; k < C.UNIT_KINDS; k++) {
      const cx2 = RMIX_X + MW * (k + 0.5);
      const fr = smk[k] / mx;
      ctx.fillStyle = C.RAMP_UNIT[k][C.rampIndex(smk[k] > 0 ? 0.9 : 0.2)];
      ctx.fillRect(cx2 - 11, my + MH * (1 - fr), 22, MH * fr);
      this.drawMixIcon(k, cx2, my + MH + 11, C.RAMP_UNIT[k][C.rampIndex(smk[k] > 0 ? 0.95 : 0.3)]);
      if (smk[k] > 0) {
        ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.8)];
        this.drawNumber(smk[k], cx2, my + MH + 24, 7);
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
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
    const H = 288;                    // 판별 줄이 들어오면서 268 → 288

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

    // ── 판별 줄 — 「지금 내가 맞게 뽑고 있는가」 ────────────────────
    // 이 줄이 없으면 플레이어는 **벌을 왜 받는지 알 방법이 없다.** 적 수입과
    // 템포가 이 값으로 깎이는데 화면에는 결과만 나타나기 때문이다.
    // 막대는 실제로 적용되는 **지수평균**이고, 세로 눈금이 **순간값**이다.
    // 둘을 같이 보여야 "지금 좋아지는 중"과 "이미 벌어 둔 것"이 구분된다.
    {
      const ey = y + 112;
      const ea = d.edgeAvg > 0 ? (d.edgeAvg > 1 ? 1 : d.edgeAvg) : 0;
      const ei = d.edge > 0 ? (d.edge > 1 ? 1 : d.edge) : 0;
      ctx.font = FONT_MICRO;
      ctx.textAlign = 'left';
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.5)];
      ctx.fillText(DV_EDGE, x + 10, ey);
      ctx.fillStyle = C.RAMP_STRUCT[C.rampIndex(0.24)];
      ctx.fillRect(MET_X, ey + 1, MET_W, 8);
      // 벌면 상금색, 못 벌면 위험색 — 색만으로 처벌 여부가 읽힌다
      ctx.fillStyle = ea > 0.02 ? C.COL_BONUS : C.RAMP_DANGER[C.rampIndex(0.55)];
      ctx.fillRect(MET_X, ey + 1, MET_W * (ea > 0.02 ? ea : 0.02), 8);
      ctx.fillStyle = C.RAMP_PLAYER[C.rampIndex(0.85)];   // 순간값 눈금
      ctx.fillRect(MET_X + MET_W * ei, ey - 1, 1.5, 12);
      ctx.textAlign = 'right';
      ctx.fillStyle = ea > 0.02 ? C.COL_BONUS : C.RAMP_PLAYER[C.rampIndex(0.45)];
      ctx.fillText(DV_EDGE_VERDICT[ea >= 0.66 ? 2 : (ea >= 0.02 ? 1 : 0)], x + w - 10, ey + 13);
      ctx.textAlign = 'left';
    }

    // 보는 것 → 하는 것. 두 6칸을 위아래로 붙여 인과가 보이게 한다
    const pm = d.playerMix;
    const mix = lv && lv.mix ? lv.mix : null;
    let mixSum = 0;
    if (mix) for (let k = 0; k < C.UNIT_KINDS && k < mix.length; k++) mixSum += mix[k] > 0 ? mix[k] : 0;

    this.drawMixRow(x, y + 138, w, DV_SEE, pm, 1, C.RAMP_PLAYER, d);
    this.drawMixRow(x, y + 196, w, DV_DO, mix, mixSum > 0 ? mixSum : 1, C.RAMP_BONUS, d);

    // 나머지 레버 두 개
    ctx.font = FONT_MICRO;
    const by = y + 258;
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
      // 유닛 아이콘 — 작게. 글자를 안 쓰고 **병종 색으로** 말한다
      this.drawMixIcon(k, cx, top + BH + 9, C.RAMP_UNIT[k][C.rampIndex(frac > 0.02 ? 0.95 : 0.3)]);
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
