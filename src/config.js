// 차오른다 (RISING) — 모든 상수는 이 파일에만 있다.
// 수치를 바꾸고 싶으면 여기만 본다. 다른 파일에 숫자를 흩뿌리지 않는다.

// ─── 논리 좌표계 ──────────────────────────────────────────────
export const VIEW_W = 540;
export const VIEW_H = 960;

// ─── 시뮬레이션 ───────────────────────────────────────────────
export const SIM_HZ = 60;
export const SIM_DT = 1000 / SIM_HZ;          // 16.667ms
export const MAX_FRAME_DELTA = 250;           // 탭 복귀 시 누산기 폭주(죽음의 나선) 차단
export const MAX_STEPS_PER_FRAME = 8;         // 위 클램프의 이중 안전판

// ─── 여백 단위 ────────────────────────────────────────────────
export const UNIT_PX = 8;                     // 여백은 8의 배수만 쓴다

// ─── 원근 투영 ────────────────────────────────────────────────
// 레인 3개가 소실점으로 모이는 고전적 러너 투영.
// 에셋 0개로 서브웨이 서퍼·템플런의 화면을 만든다.
//
//   s = ZNEAR / (ZNEAR + z)        z=0 에서 1, 멀어질수록 0
//   화면x = VP_X + worldX × s
//   화면y = HORIZON_Y + (GROUND_Y − HORIZON_Y) × s
//
// 이 식은 곱셈 두 번과 나눗셈 한 번이다. 폴리곤이 아무리 많아도 싸다.
export const HORIZON_Y = 260;
// 플레이어가 서 있는 화면 y. 아래로 240px 을 비워 둔다 —
// 물이 차오를 공간이다. 이 여백이 없으면 물이 곧바로 플레이어를 덮어
// 화면이 안 읽힌다. 실제로 820 으로 뒀다가 그렇게 됐다.
export const GROUND_Y = 720;
export const VP_X = VIEW_W * 0.5;
export const ZNEAR = 520;
// 이보다 먼 것은 그리지 않는다. 420 속도에서 5.5초 앞까지 보인다 —
// 반응하기엔 충분하고, 더 늘리면 원경에 장애물이 뭉쳐 읽히지 않는다.
export const ZFAR = 2300;

// ─── 레인 ────────────────────────────────────────────────────
export const LANE_COUNT = 3;
export const LANE_W = 150;                    // 레인 중심 간 월드 거리
export const LANE_SHIFT_MS = 130;             // 레인 이동 소요. 관성 특성이 0으로 만든다
export const LANE_X = [-LANE_W, 0, LANE_W];

// ─── 플레이어 ─────────────────────────────────────────────────
export const PLAYER_W = 64;
export const PLAYER_H = 120;
export const JUMP_MS = 460;
export const JUMP_APEX = 150;                 // 발밑이 이만큼 뜬다
export const SLIDE_MS = 380;
export const SLIDE_H = 55;                    // 슬라이드 중 키

// ─── 속도 ────────────────────────────────────────────────────
export const SPEED_BASE = 420;                // 월드 단위 / 초
export const SPEED_MAX = 760;
export const SPEED_RAMP_DIST = 9000;          // 이 거리에 걸쳐 최고 속도까지 오른다
export const STUMBLE_MS = 1100;               // 충돌 후 비틀거리는 시간
export const STUMBLE_SPEED_MUL = 0.25;

// ─── 장애물 ───────────────────────────────────────────────────
// 세 종류가 가위바위보처럼 맞물린다. 하나로 둘을 넘을 수 없다.
export const OB_NONE = 0;
export const OB_LOW = 1;      // 낮은 벽  → 점프로만 넘는다
export const OB_BEAM = 2;     // 높은 빔  → 슬라이드로만 지난다
export const OB_PILLAR = 3;   // 기둥     → 레인을 바꾸는 수밖에 없다

// 폭은 종류마다 다르다. **형태만으로 구분돼야 한다** — 색으로 때우지 않는다.
//   낮은 벽: 넓고 낮다   → 넘어라
//   높은 빔: 넓고 얇고 떠 있다 → 숙여라
//   기둥:   좁고 높다   → 돌아가라
export const OB_W = 112;
export const OB_W_LOW = 112;
export const OB_W_BEAM = 128;
export const OB_W_PILLAR = 62;
export const OB_DEPTH = 64;
export const OB_LOW_H = 70;                   // 0 ~ 70 을 막는다
export const OB_BEAM_LO = 80;                 // 80 ~ 300 을 막는다
export const OB_BEAM_HI = 300;
export const OB_PILLAR_H = 300;

// ─── 코인 ─────────────────────────────────────────────────────
export const COIN_R = 18;
export const COIN_H = 92;                     // 지면에서 이 높이에 뜬다
export const COIN_SCORE = 25;

// ─── 트랙 ─────────────────────────────────────────────────────
export const ROW_SPACING = 240;               // 행 간 월드 거리. 420 속도에서 0.57초
export const CHUNK_ROWS = 6;                  // 구간 = 행 6개
export const ROW_POOL = 64;                   // 링버퍼
// 같은 레인에서 "자세를 요구하는" 장애물 사이에 최소 이만큼의 행을 비운다.
// 점프는 460ms 인데 행 간격은 최고 속도에서 316ms 다.
// 연속으로 놓으면 점프가 끝나기 전에 다음 것이 도착해 **어떻게 눌러도 못 넘는다.**
// 실제로 그렇게 만들었다가 봇이 매번 같은 자리에서 죽었다.
export const MIN_ACTION_ROWS = 2;

// ─── 물 추격 ──────────────────────────────────────────────────
// 앞선 버전에서 측정으로 검증한 규칙을 그대로 이식한다.
// 일정 속도 두 개뿐이고 어느 쪽인지 눈에 보인다. 순간이동하지 않는다.
export const WATER_RATIO = 0.88;              // 평소 물 속도 = 플레이어 속도 × 이 값
export const WATER_CHASE_MUL = 1.25;          // 너무 벌어지면 플레이어보다 빨라진다
export const CHASE_GAP_START = 620;           // 초반 최대 간격
export const CHASE_GAP_END = 340;             // 후반 최대 간격 — 코앞까지 붙는다
export const CHASE_TIGHTEN_DIST = 12000;      // 이 거리에 걸쳐 좁혀진다
export const WATER_NEAR = 260;                // 이 안이면 근접 경고

// ─── 콤보 — 무피격 연속 회피 ──────────────────────────────────
// 정확함이 곧 생존이다. 이 관계가 이 게임의 척추다.
export const COMBO_HOLD_AT = 3;               // 이 콤보부터 물이 느려진다
export const COMBO_PUSH_AT = 6;               // 이 콤보부터 물이 밀린다
export const COMBO_HOLD_MUL = 0.75;
export const COMBO_PUSH_MUL = 0.5;
export const COMBO_TIER = 3;

// ─── 점수 ─────────────────────────────────────────────────────
export const SCORE_PER_UNIT = 1 / 12;         // 거리 점수
export const COMBO_MULT_STEP = 0.25;          // 배수 = 1 + 콤보 × 0.25
// 배수 상한. 콤보는 무피격이면 끝없이 오르는데 배수까지 같이 오르면
// 점수가 지수적으로 폭주한다 — 실제로 3분에 275만 점이 나왔다.
// 콤보 자체는 계속 세고(물을 붙잡는 힘은 유지), 배수만 여기서 자른다.
export const COMBO_MULT_CAP = 6;
export const NEAR_MISS_Z = 90;                // 이 거리 안으로 스치면 아슬아슬 회피
export const NEAR_MISS_SCORE = 15;

// ─── 게임필 ───────────────────────────────────────────────────
// 전부 "시뮬레이션 프레임" 단위다. 렌더 프레임이 아니다.
// 시뮬은 주사율과 무관하게 60Hz 고정이므로, 프레임 수로 세면
// 60Hz와 120Hz에서 지속 시간이 저절로 같아진다.
export const HITSTOP_COIN = 2;
export const HITSTOP_NEAR = 3;
export const HITSTOP_HIT = 8;
export const HITSTOP_STAIR = 3;
export const HITSTOP_DEATH = 8;

export const DEATH_SLOW_FRAMES = 24;          // 400ms
export const DEATH_SLOW_RATE = 0.15;
export const RESULT_UI_MS = 260;

export const SHAKE_COIN = 1.5;
export const SHAKE_NEAR = 3;
export const SHAKE_HIT = 12;
export const SHAKE_STAIR = 4;
export const SHAKE_DEATH = 14;
export const SHAKE_DECAY = 0.85;
export const SHAKE_ROT_DEATH = 0.02;
export const SHAKE_WATER_MAX = 1.6;

export const SQUASH_MS = 120;
export const SQUASH_JUMP_X = 0.78;
export const SQUASH_JUMP_Y = 1.30;
export const SQUASH_LAND_X = 1.34;
export const SQUASH_LAND_Y = 0.68;
export const SQUASH_HIT_X = 1.40;
export const SQUASH_HIT_Y = 0.60;

export const RING_MS = 220;
export const RING_R0 = 18;
export const RING_R1 = 62;
export const RING_MAX = 4;

export const PARTICLE_MAX = 128;
export const PART_COIN = 6;
export const PART_NEAR = 4;
export const PART_HIT = 16;
export const PART_DEATH = 24;
export const PART_GRAVITY = 0.42;

export const TRAIL_MAX = 32;
export const TRAIL_FRAMES = 6;

// ─── 계단 스프린트 (무한의 계단 이식) ──────────────────────────
// 관문마다 트랙이 계단으로 변한다. 장애물이 사라지고 리듬만 남는다.
// 규칙이 바뀐 걸 눈으로 알 수 있어야 한다.
export const STAIR_FIRST_DIST = 8400;         // 첫 관문. 20초는 러너 문법만 가르친다
export const STAIR_EVERY_DIST = 9600;
export const STAIR_STEPS = 18;                // 이만큼 오르면 구간 종료
export const STAIR_MS = 6000;                 // 제한 시간
export const STAIR_STEP_PUSH = 120;           // 한 칸당 물이 밀리는 거리
export const STAIR_MISS_STALL = 24;           // 틀리면 이 프레임만큼 정지
export const STAIR_STEP_SCORE = 40;

// ─── 특성 드래프트 ────────────────────────────────────────────
// 관문 직후 3개 중 1개를 고른다.
// **어떤 3개를 제시할지가 곧 디렉터의 판단이다.**
export const TRAIT_OFFER = 3;
export const DRAFT_UI_MS = 260;

// 계열: 0 = 공격, 1 = 방어, 2 = 조작
export const TRAITS = [
  { id: 'gambler',   kind: 0, name: '도박사',   desc: '점수 2배 · 물 25% 빨라짐' },
  { id: 'sprint',    kind: 0, name: '가속',     desc: '이동 속도 15% 증가' },
  { id: 'collector', kind: 0, name: '수집가',   desc: '코인 점수 2배' },
  { id: 'chain',     kind: 0, name: '연쇄',     desc: '콤보 배수 50% 증가' },
  { id: 'chill',     kind: 1, name: '저체온',   desc: '물 상승 20% 감소' },
  { id: 'shield',    kind: 1, name: '방패',     desc: '충돌 1회를 무효로 한다' },
  { id: 'vision',    kind: 1, name: '시야',     desc: '장애물이 더 멀리서 보인다' },
  { id: 'recover',   kind: 1, name: '회복',     desc: '계단 한 칸당 물이 더 밀린다' },
  { id: 'inertia',   kind: 2, name: '관성',     desc: '레인 이동이 즉시 끝난다' },
  { id: 'glide',     kind: 2, name: '활공',     desc: '점프 체공 40% 증가' },
  { id: 'precise',   kind: 2, name: '정밀',     desc: '회피 판정 폭 50% 증가' },
  { id: 'brake',     kind: 2, name: '제동',     desc: '슬라이드 지속 50% 증가' },
];

// ─── AI 디렉터 계층1 ──────────────────────────────────────────
export const OBSERVE_CHUNKS = 3;              // 구간 3개 관찰 후 첫 판정
export const METRIC_WINDOW = 8;               // 최근 8회 슬라이딩 윈도
export const HYSTERESIS = 0.05;               // 경계값 ±0.05 안에서는 프로파일을 바꾸지 않는다

// 프로파일 판정 임계값 — 결정론적이어야 재현 가능하다
export const TH_LANE_HIGH = 0.55;             // 중앙 레인 체류 비율
export const TH_GREED_LOW = 0.35;
export const TH_GREED_HIGH = 0.65;
export const TH_REACT_FAST = 0.40;            // 정규화된 반응 시간
export const TH_NEAR_HIGH = 0.45;
export const TH_STDEV = 0.22;

// 레버 범위
export const LEVER_DENSITY_MIN = 0.6, LEVER_DENSITY_MAX = 1.5;
export const LEVER_WATER_MIN = 0.72, LEVER_WATER_MAX = 1.30;   // WATER_RATIO 배수
export const LEVER_TELEGRAPH_MIN = 0.7, LEVER_TELEGRAPH_MAX = 1.4;

export const REACT_NORM_MS = 900;             // 반응 시간 정규화 기준

export const DATA_CHUNKS = 'data/chunks.json';
export const DATA_POLICY = 'data/policy.json';
export const DATA_LINES = 'data/lines.json';

// ─── 표시 ─────────────────────────────────────────────────────
export const METER_UNITS = 40;                // 40 월드 단위 = 1m

// ─── 팔레트 — 이 6색 외에 어떤 색도 쓰지 않는다 ────────────────
// 내가 통제하는 것은 흰색, 나를 죽이는 것은 붉은색, 나머지는 청회색.
export const COL_BG      = '#12242E';         // 배경. 수면 아래의 습한 어둠
export const COL_GRID    = '#1B3341';         // 제도 격자. 깊이감만 담당
export const COL_STRUCT  = '#7E9AA6';         // 트랙·장애물. 안전하지만 시선을 끌지 않는다
export const COL_PLAYER  = '#F4F7F5';         // 플레이어·UI. 내가 통제하는 것
export const COL_DANGER  = '#C4463A';         // 물·충돌. 이 색이 보이면 죽는다는 뜻
export const COL_BONUS   = '#F2B441';         // 코인·특성. 한 구간에 몇 개만

// 투명도는 써도 되지만 색상 자체를 섞어 새 색을 만들지 않는다.
// rgba 문자열을 매 프레임 조립하면 루프 안 할당이 된다.
// 그래서 색마다 알파 단계표를 한 번만 만들어두고 인덱스로 꺼내 쓴다.
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

// ─── 통일 규칙 ────────────────────────────────────────────────
export const RADIUS = 4;                      // 모서리 반경은 이거 하나
export const STROKE = 2;                      // 선 굵기는 이거 하나
export const UNIT = UNIT_PX;
export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// ─── 디바이스 ─────────────────────────────────────────────────
export const DPR_CAP = 2;                     // 3배 기기에서 픽셀이 4배가 되는 걸 막는다
export const SWIPE_PX = 24;                   // 이 거리를 넘는 순간 스와이프로 확정한다
