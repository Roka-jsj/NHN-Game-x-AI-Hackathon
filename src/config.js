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
export const PLAYER_RADIUS = 14;
export const PLATFORM_THICKNESS = 12;         // 세로 두께. 착지 판정에 쓰이는 치수다
export const PLATFORM_REACH = 76;             // 벽에서 튀어나온 길이. 렌더 전용, 판정 무관
export const WALL_INSET = 64;                 // 화면 가장자리 → 벽면

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

// ─── 낙하 ────────────────────────────────────────────────────
export const FALL_ACC_PER_STEP = 1.2;
export const FALL_MAX_SPEED = 42;

// ─── 카메라 ──────────────────────────────────────────────────
export const CAM_ANCHOR = 0.40;               // 플레이어를 화면 상단 40%에 유지
export const CAM_LERP = 0.12;

// ─── 발판 풀 ─────────────────────────────────────────────────
export const PLAT_POOL = 64;                  // 링버퍼. 화면에 동시에 보이는 건 10개 안팎
export const LOOKAHEAD = 12;                  // 착지 후보 탐색 범위 (인덱스)

// 패스 1 고정 패턴. 랜덤 없음. 전부 [LEAP_DIST_MIN, LEAP_DIST_MAX] 안이다.
// 패스 4에서 디렉터가 이 배열 대신 청크를 공급한다.
export const GAP_PATTERN = [150, 210, 130, 280, 170, 240, 120, 330];

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

// ─── 통일 규칙 ───────────────────────────────────────────────
export const RADIUS = 4;                      // 모서리 반경은 이거 하나 (플레이어는 원)
export const STROKE = 2;                      // 선 굵기는 이거 하나
export const UNIT = 8;                        // 여백은 8의 배수만
export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// ─── 디바이스 ────────────────────────────────────────────────
export const DPR_CAP = 2;                     // 3배 기기에서 픽셀이 4배가 되는 걸 막는다
