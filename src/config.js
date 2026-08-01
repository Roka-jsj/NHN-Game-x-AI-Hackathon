// 차오른다 (RISING) — 모든 상수는 이 파일에만 있다.
// 수치를 바꾸고 싶으면 여기만 본다. 다른 파일에 숫자를 흩뿌리지 않는다.

// ─── 논리 좌표계 ──────────────────────────────────────────────
// 월드 y는 위로 증가한다. 화면 y는 아래로 증가한다. render에서 뒤집는다.
export const VIEW_W = 540;
export const VIEW_H = 960;

// ─── 시뮬레이션 ───────────────────────────────────────────────
export const SIM_HZ = 60;
export const SIM_DT = 1000 / SIM_HZ;          // 16.667ms
export const MAX_FRAME_DELTA = 250;           // 탭 복귀 시 누산기 폭주(죽음의 나선) 차단
export const MAX_STEPS_PER_FRAME = 8;         // 위 클램프의 이중 안전판

// ─── 기하 ────────────────────────────────────────────────────
export const UNIT_PX = 8;                     // 여백 단위. 8의 배수만 쓴다
export const PLAYER_RADIUS = 14;
export const PLATFORM_THICKNESS = 12;         // 세로 두께. 착지 판정에 쓰이는 치수다
export const PLATFORM_REACH = 76;             // 벽에서 튀어나온 길이. 렌더 전용, 판정 무관
export const WALL_INSET = 64;                 // 화면 가장자리 → 벽면
// 발판이 시작되는 x. 벽면이 아니라 **플레이어 지름 + 여백 8px** 만큼 떨어져서 시작한다.
// 실루엣 테스트에서 플레이어 원과 발판 막대가 한 덩어리로 뭉쳐 읽히지 않았다.
// 색으로 때우지 않고 형태를 고쳤다 — 플레이어는 벽을 잡고, 선반은 그 옆에서 뻗어 나온다.
export const PLATFORM_X0 = WALL_INSET + PLAYER_RADIUS * 2 + UNIT_PX;

// 착지 허용폭 = 발판 반두께 + 플레이어 반지름.
// aimError는 이 값으로 정규화한다. 디렉터 임계값 0.4/0.6이 의미를 갖는 유일한 기준이다.
export const BASE_TOLERANCE = PLATFORM_THICKNESS / 2 + PLAYER_RADIUS;  // 20px
export const PERFECT_RATIO = 0.12;            // 완벽 착지 = 발판 중심 ±12%

// ─── 차지 · 도약 ─────────────────────────────────────────────
export const CHARGE_MAX_MS = 900;
export const CHARGE_MIN_MS = 80;              // 그 미만 릴리스는 80ms로 취급 (오발 구제)
export const OVERCHARGE_WARN_MS = 900;        // 이 시점부터 경고 연출
export const OVERCHARGE_FIRE_MS = 1200;       // 강제 발사
export const OVERCHARGE_PENALTY = 0.85;       // 강제 발사에만 −15%

export const LEAP_DIST_MIN = 90;
export const LEAP_DIST_MAX = 420;
export const LEAP_TIME_MIN = 180;
export const LEAP_TIME_MAX = 420;

// ─── 조준 진동 — 사인파다. Math.random() 금지. 읽을 수 있어야 실력이 된다 ───
export const WOBBLE_RATIO = 0.06;             // 진폭 = 조준선 길이 × 0.06
export const WOBBLE_PERIOD_MS = 620;

// ─── 물 — 반드시 선형. 이징 금지 ─────────────────────────────
export const WATER_SPEED_PX_S = 22;
// per-step 상수로 미리 나눠둔다. 시뮬레이션 코드에서 deltaTime을 곱하지 않기 위해서다.
// 고정 스텝인데 delta를 곱하면 이중 적용이다 (QA A1).
export const WATER_RISE_PER_STEP = WATER_SPEED_PX_S / SIM_HZ;
export const WATER_START_GAP = 520;           // 시작 시 플레이어 아래 여유
export const WATER_NEAR_PX = 200;             // 이 거리 안이면 근접 경고

// ── 추격 규칙 ────────────────────────────────────────────────
// 문서 수치(22px/s 선형)만으로는 물이 영원히 위협이 되지 않는다.
// 플레이어는 도약 200px을 0.6초에 하므로 상승 속도가 약 333px/s다.
// 물이 22px/s로 오르면 30초 뒤 수면은 화면 9장 아래에 있다.
// "차지하는 동안 물이 오른다"는 문서의 핵심 문장이 실제로는 작동하지 않는다.
//
// 그래서 거리가 벌어지면 물이 3배속으로 따라붙는다.
// **여전히 선형이다** — 일정 속도 두 개뿐이고, 어느 쪽인지 눈으로 보인다.
// 순간이동하지 않는다. 예측 가능해야 실패가 플레이어 탓이 된다.
export const WATER_CHASE_MUL = 3;
export const CHASE_MARGIN_START = 640;        // 초반: 화면 2/3 아래에서 따라온다
export const CHASE_MARGIN_END = 300;          // 후반: 코앞까지 붙는다
export const CHASE_TIGHTEN_DEPTH = 60;        // 이 발판 수에 걸쳐 좁혀진다

// ─── 콤보 — 연속 완벽 착지 ───────────────────────────────────
// 이 게임의 척추다. 완벽 착지(±12%)는 오래 정확히 겨눠야 나오고,
// 겨누는 동안 물은 오른다. 그런데 완벽 착지가 쌓이면 물이 멈추고, 더 쌓이면 내려간다.
// **정확함이 곧 생존이다.** 문서가 "게임 전체"라고 한 긴장이 여기서 닫힌다.
export const COMBO_HOLD_AT = 3;               // 이 콤보부터 물이 멈춘다
export const COMBO_PUSH_AT = 6;               // 이 콤보부터 물이 내려간다
export const COMBO_PUSH_MUL = -0.5;           // 내려가는 속도 (기본 속도의 절반)
export const COMBO_TIER = 3;                  // 티어 하나당 콤보 3

// ─── 점수 ────────────────────────────────────────────────────
export const SCORE_BASE = 10;                 // 착지 기본점
export const SCORE_PER_PX = 1 / 20;           // 멀리 뛸수록 더 준다 — 위험에 보상
export const SCORE_SKIP = 25;                 // 한 칸 건너뛰기 성공
export const SCORE_BONUS = 150;               // 앰버 발판
export const COMBO_MULT_STEP = 0.5;           // 배수 = 1 + 콤보 × 0.5
export const BONUS_WATER_PUSH = 220;          // 앰버를 먹으면 물이 이만큼 내려간다

// ─── 낙하 ────────────────────────────────────────────────────
export const FALL_ACC_PER_STEP = 1.2;
export const FALL_MAX_SPEED = 42;

// ─── 카메라 ──────────────────────────────────────────────────
export const CAM_ANCHOR = 0.40;               // 플레이어를 화면 상단 40%에 유지
export const CAM_LERP = 0.12;

// ─── 발판 종류 — 비트필드 ────────────────────────────────────
// 청크 스텝의 3번째 값이 이 비트필드다. [간격, 두께배수, 플래그]
//
// 왜 종류를 늘리는가: 가만히 있는 발판만 있으면 "오래 겨눌수록 정확하다"가
// 항상 옳은 전략이 된다. 그러면 문서가 말한 긴장("재는 동안 물은 오른다")이
// 물이 느린 순간 전부 사라진다. 발판 자체가 시간을 압박해야 매 순간 선택이 생긴다.
export const F_BONUS = 1;      // 앰버 — 먹으면 물이 내려간다
export const F_CRUMBLE = 2;    // 부서진다 — 붙는 순간부터 무너진다. 오래 겨눌 수 없다
export const F_MOVING = 4;     // 위아래로 흔들린다 — 사인파. 읽을 수 있다
export const F_MAX = 7;

export const CRUMBLE_FRAMES = 42;             // 0.7초. 이 안에 떠나야 한다
export const CRUMBLE_WARN = 15;               // 남은 프레임이 이하면 경고 연출
// 부서지는 발판 **다음** 간격의 상한.
// 390px 도약은 818ms 차지를 요구하는데 발판은 700ms 만에 무너진다 —
// 그 조합은 어떻게 눌러도 못 넘는다. 실패가 플레이어 탓이 아니게 되는 배치다.
// 청크가 뭘 주든 여기서 잘라낸다. 데이터가 아니라 규칙으로 막는다.
export const CRUMBLE_NEXT_GAP_MAX = 300;      // 필요한 차지 약 600ms — 반응 시간까지 감안
export const MOVE_AMP = 34;                   // 이동 발판 진폭
export const MOVE_PERIOD_MS = 1800;           // 주기. 조준 진동(620ms)과 배수 관계가 아니게 둔다

// ─── 관문 ────────────────────────────────────────────────────
// 끝없이 오르기만 하면 진척이 안 느껴진다. 일정 간격마다 사건을 만든다.
export const GATE_EVERY = 12;                 // 발판 12개마다
export const GATE_SCORE = 200;
export const GATE_WATER_PUSH = 120;

// ─── 발판 풀 ─────────────────────────────────────────────────
export const PLAT_POOL = 64;                  // 링버퍼. 화면에 동시에 보이는 건 10개 안팎
// 착지 후보 탐색 범위. 최대 도약 420px / 최소 간격 100px = 4.2칸이고
// 후보는 같은 벽(한 칸 걸러)만 세므로 8이면 충분하다.
// 이 값이 곧 "발판을 얼마나 앞서 생성하는가"이기도 하다 —
// 크게 잡으면 디렉터가 아직 관찰하지 않은 구간까지 미리 만들어버린다.
export const LOOKAHEAD = 8;

// 패스 1 고정 패턴. 랜덤 없음. 전부 [LEAP_DIST_MIN, LEAP_DIST_MAX] 안이다.
// 패스 4에서 디렉터가 이 배열 대신 청크를 공급한다.
export const GAP_PATTERN = [150, 210, 130, 280, 170, 240, 120, 330];

// ─── 게임필 (패스 2) ─────────────────────────────────────────
// 전부 "시뮬레이션 프레임" 단위다. 렌더 프레임이 아니다.
// 시뮬은 주사율과 무관하게 60Hz 고정이므로, 프레임 수로 세면
// 60Hz와 120Hz에서 지속 시간이 저절로 같아진다.
export const HITSTOP_LAND = 3;
export const HITSTOP_PERFECT = 6;
export const HITSTOP_DEATH = 8;
export const HITSTOP_RECORD = 4;

export const DEATH_SLOW_FRAMES = 24;          // 400ms
export const DEATH_SLOW_RATE = 0.15;          // 0.15배속
export const RESULT_UI_MS = 260;

export const INPUT_BUFFER_FRAMES = 6;         // 착지 100ms 전 입력을 기억한다

export const SHAKE_LAND = 3;
export const SHAKE_PERFECT = 5;
export const SHAKE_DEATH = 12;
export const SHAKE_RECORD = 6;
export const SHAKE_DECAY = 0.85;
export const SHAKE_ROT_DEATH = 0.02;
export const SHAKE_WATER_MAX = 1.6;           // 물 근접 상시 미세 진동

export const SQUASH_MS = 120;                 // easeOutBack 복귀
export const SQUASH_CHARGE_X = 1.12;
export const SQUASH_CHARGE_Y = 0.88;
export const SQUASH_FIRE_X = 0.72;
export const SQUASH_FIRE_Y = 1.35;
export const SQUASH_LAND_X = 1.38;
export const SQUASH_LAND_Y = 0.62;

export const RING_MS = 220;                   // 완벽 착지 흰 링 확산
export const RING_R0 = 14;
export const RING_R1 = 48;
export const RING_MAX = 4;

export const PARTICLE_MAX = 128;
export const PART_LAND = 6;
export const PART_PERFECT = 12;
export const PART_DEATH = 20;
export const PART_GRAVITY = 0.42;

export const TRAIL_MAX = 32;
export const TRAIL_FRAMES = 4;                // 도약 중 잔상
export const CAM_LEAD = 2.2;                  // 카메라가 상승 방향으로 앞을 본다 (렌더 전용)

// ─── AI 디렉터 계층1 (패스 4) ────────────────────────────────
export const CHUNK_SIZE = 6;                  // 구간 = 발판 6개
export const OBSERVE_CHUNKS = 3;              // 구간 3개(발판 18개) 관찰 후 첫 판정
export const METRIC_WINDOW = 8;               // 최근 8회 슬라이딩 윈도
export const HYSTERESIS = 0.05;               // 경계값 ±0.05 안에서는 프로파일을 바꾸지 않는다

// 프로파일 판정 임계값 — 문서 그대로. 결정론적이어야 재현 가능하다.
export const TH_CHARGE_LOW = 0.35;
export const TH_CHARGE_HIGH = 0.65;
export const TH_AIM_LOW = 0.4;
export const TH_AIM_HIGH = 0.6;
export const TH_STDEV = 0.22;

// 레버 범위
export const LEVER_THICK_MIN = 0.7, LEVER_THICK_MAX = 1.4;
export const LEVER_WATER_MIN = 18, LEVER_WATER_MAX = 34;
export const LEVER_WOBBLE_MIN = 0.5, LEVER_WOBBLE_MAX = 1.4;
export const LEVER_COYOTE_MIN = 5, LEVER_COYOTE_MAX = 8;

// 간격 분류 경계 (근 / 중 / 원)
export const GAP_NEAR = 180;
export const GAP_MID = 300;
// ── 생성 가능한 간격의 범위 ──
// 문서의 "차지 0% → 90px" 는 실제로 도달할 수 없는 값이다.
// 최소 차지가 80ms 로 강제되므로 실제 최소 도약은
//   90 + 330 × (80/900) = 119.3px
// 이고, 그보다 짧은 간격은 **어떻게 눌러도 넘어간다.**
// 하한을 100 으로 뒀다가 92px 간격이 생성돼 봇이 매번 29px 오버슛하며 죽었다.
export const LEAP_DIST_ACHIEVABLE_MIN =
  LEAP_DIST_MIN + (LEAP_DIST_MAX - LEAP_DIST_MIN) * (CHARGE_MIN_MS / CHARGE_MAX_MS);
export const GAP_FLOOR = 130;
// 상한도 "최대 도약 420" 이 아니다.
// 플레이어는 발판 중심에서 최대 허용폭(두꺼운 발판이면 약 23px)만큼 아래에 붙을 수 있고,
// 그러면 다음 발판까지의 실제 거리가 그만큼 늘어난다.
export const GAP_CEIL = 390;

export const DATA_CHUNKS = 'data/chunks.json';
export const DATA_POLICY = 'data/policy.json';
export const DATA_LINES = 'data/lines.json';

// ─── 표시 ────────────────────────────────────────────────────
export const METER_PX = 40;                   // 40px = 1m

// ─── 팔레트 — 이 6색 외에 어떤 색도 쓰지 않는다 ───────────────
// 내가 통제하는 것은 흰색, 나를 죽이는 것은 붉은색, 나머지는 청회색.
export const COL_BG      = '#12242E';         // 배경. 수면 아래의 습한 어둠
export const COL_GRID    = '#1B3341';         // 제도 격자. 깊이감만 담당
export const COL_STRUCT  = '#7E9AA6';         // 발판·구조. 안전하지만 시선을 끌지 않는다
export const COL_PLAYER  = '#F4F7F5';         // 플레이어·조준선·조준점·게이지
export const COL_DANGER  = '#C4463A';         // 물·위험. 이 색이 보이면 죽는다는 뜻
export const COL_BONUS   = '#F2B441';         // 보너스. 한 구간에 0~1개

// 투명도는 써도 되지만 색상 자체를 섞어 새 색을 만들지 않는다.
// rgba 문자열을 매 프레임 조립하면 루프 안 할당이 된다 (패스 3 위반).
// 그래서 색마다 알파 단계표를 한 번만 만들어두고 인덱스로 꺼내 쓴다.
// 이 함수를 거치지 않는 색상 리터럴은 소스 어디에도 없다 — grep으로 확인 가능하다.
export const ALPHA_STEPS = 16;

export function makeRamp(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const ramp = new Array(ALPHA_STEPS + 1);
  for (let i = 0; i <= ALPHA_STEPS; i++) {
    ramp[i] = 'rgba(' + r + ',' + g + ',' + b + ',' + (i / ALPHA_STEPS).toFixed(3) + ')';
  }
  return ramp;
}

// 램프 인덱스. 0~1 알파를 단계로 양자화한다. 문자열을 만들지 않는다.
export function rampIndex(a) {
  const i = (a * ALPHA_STEPS + 0.5) | 0;
  return i < 0 ? 0 : (i > ALPHA_STEPS ? ALPHA_STEPS : i);
}

export const RAMP_PLAYER = makeRamp(COL_PLAYER);
export const RAMP_STRUCT = makeRamp(COL_STRUCT);
export const RAMP_DANGER = makeRamp(COL_DANGER);
export const RAMP_BONUS = makeRamp(COL_BONUS);
export const RAMP_GRID = makeRamp(COL_GRID);
export const RAMP_BG = makeRamp(COL_BG);

// ─── 통일 규칙 ───────────────────────────────────────────────
export const RADIUS = 4;                      // 모서리 반경은 이거 하나 (플레이어는 원)
export const STROKE = 2;                      // 선 굵기는 이거 하나
export const UNIT = UNIT_PX;                  // 여백은 8의 배수만
export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// ─── 디바이스 ────────────────────────────────────────────────
export const DPR_CAP = 2;                     // 3배 기기에서 픽셀이 4배가 되는 걸 막는다
