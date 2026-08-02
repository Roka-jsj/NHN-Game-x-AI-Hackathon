// 차오른다 (RISING) — 모든 상수는 이 파일에만 있다.
// 수치를 바꾸고 싶으면 여기만 본다. 다른 파일에 숫자를 흩뿌리지 않는다.
//
// 장르: 플래시게임 계보의 **한 화면 레인 전투** (전쟁시대 · 벌레전쟁 계보)
//   자원을 모아 유닛을 소환하고, 유닛은 알아서 전진해 싸우고,
//   적 기지를 부수면 이긴다. 시대를 올리면 유닛이 통째로 바뀐다.
//
// 이 장르의 고질병은 **교착**이다. 양쪽이 버티기만 하면 아무 일도 안 일어난다.
// 그래서 물이 차오른다 — 버티는 쪽이 먼저 죽는다. 제목이 곧 장르의 해독제다.

// ─── 논리 좌표계 ──────────────────────────────────────────────
// 가로다. 전장 전체가 한 화면에 들어와야 한다 — 카메라는 움직이지 않는다.
// 플래시게임의 핵심은 "스크롤 없이 다 보인다"는 것이다.
export const VIEW_W = 960;
export const VIEW_H = 540;

// ─── 시뮬레이션 ───────────────────────────────────────────────
export const SIM_HZ = 60;
export const SIM_DT = 1000 / SIM_HZ;          // 16.667ms
export const MAX_FRAME_DELTA = 250;           // 탭 복귀 시 누산기 폭주 차단
export const MAX_STEPS_PER_FRAME = 8;

// ─── 여백 단위 ────────────────────────────────────────────────
export const UNIT_PX = 8;
export const UNIT = UNIT_PX;

// ─── 전장 ────────────────────────────────────────────────────
export const GROUND_Y = 372;                  // 양쪽 기지가 선 높이 (협곡의 가장자리)
// **협곡은 V자다.** 가운데가 가장 낮다.
// 평평하게 뒀더니 90초 동안 양쪽 기지가 2밖에 안 깎이는 교착이 나왔고,
// 물이 양쪽을 똑같이 깎아 무승부로 끝나는 구조였다.
// 가운데가 낮으면 **전선이 먼저 잠긴다** — 밀지 못하고 물고 늘어지는 쪽이 먼저
// 병력을 잃는다. 기지는 높은 쪽에 있어 마지막에 잠긴다.
// 제목이 배경이 아니라 판을 가르는 규칙이 되는 지점이다.
export const FLOOR_DIP = 78;                  // 가운데가 이만큼 낮다
// 42 로 뒀더니 전선이 통째로 쓸려나가 **오히려 교착이 굳어졌다** —
// 밀고 들어간 병력이 낮은 가운데에서 매번 전멸해 돌파가 성립하지 않았다.
// 압박은 되되 전멸은 아니어야 한다. 높은 쪽(적 기지 방향)에서 싸울수록 유리하다.
export const DROWN_DPS = 15;                  // 물에 잠긴 유닛이 받는 초당 피해
export const BASE_L_X = 92;                   // 내 기지 중심
export const BASE_R_X = VIEW_W - 92;          // 적 기지 중심
export const BASE_W = 108;
export const BASE_H = 132;
export const SPAWN_L_X = BASE_L_X + 46;
export const SPAWN_R_X = BASE_R_X - 46;
export const BASE_HP = 780;
// **기지에는 훨씬 크게 들어간다.** 이게 없으면 검사 하나가 기지를 부수는 데
// 58초가 걸리고, 그래서 5분을 돌려도 기지가 안 무너져 매번 무승부로 끝났다.
// 플래시게임의 판은 2~3분이다. 뚫으면 무너져야 한다.
export const BASE_DMG_MUL = 9;

// ─── 유닛 ────────────────────────────────────────────────────
// 세 종류가 가위바위보처럼 맞물린다. 하나로 전부를 이길 수 없다.
//   0 검사   싸고 빠르다. 물량
//   1 궁수   멀리서 때린다. 근접에 약하다
//   2 거인   느리고 비싸다. 앞을 막는다
export const U_SWORD = 0, U_ARCHER = 1, U_GIANT = 2;
export const UNIT_KINDS = 3;
export const UNIT_MAX = 96;                   // 양쪽 합계. 풀 크기

// 시대별 배수. 시대가 오르면 **같은 버튼이 다른 유닛을 뽑는다.**
export const ERA_COUNT = 4;
export const ERA_NAME = ['돌', '청동', '강철', '기계'];
export const ERA_HP_MUL = [1, 1.7, 2.9, 4.8];
export const ERA_DMG_MUL = [1, 1.75, 3.0, 5.0];
export const ERA_COST_MUL = [1, 1.6, 2.5, 3.9];

// 기본 스탯 (돌 시대 기준)
export const U_HP = [58, 40, 165];
export const U_DMG = [11, 9, 22];
export const U_RANGE = [22, 128, 26];         // 사거리
export const U_SPEED = [46, 34, 24];          // 초당 전진
export const U_COOLDOWN = [640, 880, 1150];   // ms
export const U_COST = [28, 44, 92];
export const U_XP = [10, 14, 26];             // 처치 시 얻는 경험치
export const U_BOUNTY = [16, 22, 44];         // 처치 시 얻는 금
// 실루엣이 작으면 종류가 안 읽힌다. 첫 스크린샷에서 검사·궁수·거인이
// 전부 같은 막대로 보였다 — 색이 아니라 크기와 형태로 구분돼야 한다.
export const U_W = [23, 19, 36];              // 그리는 폭
export const U_H = [46, 39, 70];
export const U_SPAWN_CD = [420, 620, 1050];   // 소환 쿨다운 ms

// 유닛끼리 겹치지 않게 하는 최소 간격. 이게 없으면 전부 한 점에 뭉친다.
export const UNIT_GAP = 21;

// 화살 — **연출 전용이다.** 피해는 쏘는 순간 이미 들어갔고, 이건 그게 눈에
// 보이게 하는 것뿐이다. 화살에 판정을 걸면 원거리 유닛의 실제 사거리가
// 비행 시간만큼 늘어나 밸런스가 조용히 어긋난다.
export const ARROW_MAX = 48;
export const ARROW_MS = 220;

// ─── 경제 ────────────────────────────────────────────────────
export const GOLD_START = 120;
export const GOLD_RATE = 16;                  // 초당 자동 수입
export const GOLD_CAP = 1600;
// 시대를 올리는 데 필요한 경험치. 마지막 값 뒤로는 더 오를 곳이 없다.
export const ERA_XP = [0, 260, 720, 1500];
export const ERA_UP_GOLD = 60;                // 진화 시 보너스 금

// ─── 물 ──────────────────────────────────────────────────────
// 전쟁시대류의 고질병은 교착이다. 물이 그걸 푼다 — 버티면 먼저 죽는다.
// **협곡이 잠긴다.** 물은 지면 아래에서 올라와 전장을 삼킨다 —
// 유닛도 기지도 물에 잠긴다. 그래야 "차오른다"가 배경이 아니라 위협이 된다.
// 버튼 줄은 지면 아래에 있고 물 위에 그려진다. UI 는 세계보다 위다.
export const WATER_Y0 = VIEW_H;               // 화면 맨 아래에서 시작
export const WATER_RISE = 2.6;                // 초당 상승
export const WATER_ACCEL_AT = 70;             // 이 초부터 상승이 빨라진다
export const WATER_ACCEL_MUL = 2.1;
export const WATER_KILL_PUSH = 3.4;           // 적 하나 잡을 때마다 내려간다
export const WATER_ERA_PUSH = 30;             // 진화하면 크게 내려간다
// 기지가 완전히 잠기는 높이. 여기까지 오면 더 못 올라간다.
export const WATER_MIN_Y = GROUND_Y - BASE_H - 10;
// 기지 피해는 **마지막 심판**이지 주된 압박이 아니다.
// 주된 압박은 익사다 — 전선이 먼저 잠기므로 밀지 못하는 쪽이 병력을 잃는다.
// 기지 피해를 세게 두면 양쪽이 똑같이 깎여 무승부가 기본값이 된다.
export const WATER_DPS = 10;
// 기지가 절반쯤 잠겨야 깎이기 시작한다. 0.35 로 뒀더니 46초에 시작해
// 유닛이 승부를 내기 전에 물이 양쪽 기지를 다 죽여 무승부가 기본값이 됐다.
export const WATER_BASE_AT = GROUND_Y - BASE_H * 0.5;
export const WATER_WARN = 70;                 // 수면이 지면에서 이만큼 안이면 경고

// ─── 특수기 ───────────────────────────────────────────────────
// 플래시게임의 "필살기" 자리. 쿨다운이 길고 화면이 크게 바뀐다.
export const NUKE_CD = 42000;                 // ms
export const NUKE_DMG = 260;
export const NUKE_WATER_PUSH = 70;

// ─── 버튼 ────────────────────────────────────────────────────
// 화면 아래 한 줄. 유닛 3 + 진화 1 + 특수기 1.
export const BTN_COUNT = 5;
export const BTN_W = 148;
export const BTN_H = 74;
export const BTN_GAP = 12;
export const BTN_Y = VIEW_H - BTN_H - UNIT * 2;
export const BTN_X0 = (VIEW_W - (BTN_W * BTN_COUNT + BTN_GAP * (BTN_COUNT - 1))) * 0.5;
export const B_SWORD = 0, B_ARCHER = 1, B_GIANT = 2, B_ERA = 3, B_NUKE = 4;

// ─── 적 AI (디렉터가 조종한다) ────────────────────────────────
export const AI_GOLD_RATE = 9.2;             // 적의 기본 수입. 레버가 곱한다
export const AI_GOLD_START = 110;
export const AI_THINK_MS = 620;               // 적이 판단하는 주기
export const AI_ERA_XP = [0, 300, 800, 1650];

// ─── 승패 ────────────────────────────────────────────────────
export const RESULT_UI_MS = 420;
export const WIN_NONE = 0, WIN_PLAYER = 1, WIN_ENEMY = 2, WIN_DROWN = 3;

// ─── 게임필 ───────────────────────────────────────────────────
// 히트스톱은 **시뮬레이션 프레임** 단위다. 렌더 프레임이 아니다.
// 시뮬이 60Hz 고정이므로 60Hz와 120Hz에서 지속 시간이 저절로 같아진다.
export const HITSTOP_HIT = 2;
export const HITSTOP_KILL = 5;
export const HITSTOP_ERA = 10;
export const HITSTOP_NUKE = 14;
export const HITSTOP_BASE = 4;
export const HITSTOP_END = 12;

export const SHAKE_HIT = 1.2;
export const SHAKE_KILL = 3;
export const SHAKE_ERA = 7;
export const SHAKE_NUKE = 16;
export const SHAKE_BASE = 5;
export const SHAKE_END = 14;
export const SHAKE_DECAY = 0.85;
export const SHAKE_ROT_END = 0.02;

export const SQUASH_MS = 130;

export const PARTICLE_MAX = 160;
export const PART_HIT = 3;
export const PART_KILL = 10;
export const PART_ERA = 24;
export const PART_NUKE = 40;
export const PART_GRAVITY = 0.4;
export const PART_LIFE = 34;

export const RING_MAX = 12;
export const RING_MS = 420;
export const RING_R = 90;

export const FLOAT_MAX = 16;                  // 떠오르는 숫자 (피해·수입)
export const FLOAT_MS = 700;
export const FLOAT_RISE = 34;

export const BANNER_MS = 1100;
export const BAN_ERA = 0;
export const BAN_NUKE = 1;
export const BAN_WATER = 2;
export const FLASH_FRAMES = 4;

// ─── 팔레트 — 정확히 6색 ──────────────────────────────────────
// 내가 통제하는 것은 흰색, 나를 죽이는 것은 붉은색, 나머지는 청회색.
// 색을 늘리는 대신 알파 램프로 대비를 번다.
export const COL_BG      = '#12242E';         // 배경. 수면 아래의 습한 어둠
export const COL_GRID    = '#1B3341';         // 지면·먼 지형. 깊이감만 담당
export const COL_STRUCT  = '#7E9AA6';         // 적 유닛·적 기지
export const COL_PLAYER  = '#F4F7F5';         // 내 유닛·내 기지·UI
export const COL_DANGER  = '#C4463A';         // 물·피해
export const COL_BONUS   = '#F2B441';         // 금·진화·특수기

export const FONT_STACK = 'system-ui, -apple-system, "Noto Sans KR", sans-serif';
export const STROKE = 2;
export const RADIUS = 4;
export const DPR_CAP = 2;

// 알파 램프 — 매 프레임 rgba 문자열을 만들지 않기 위해 미리 굽는다.
export const RAMP_STEPS = 16;
function hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function makeRamp(hex) {
  const [r, g, b] = hexToRgb(hex);
  const out = new Array(RAMP_STEPS + 1);
  for (let i = 0; i <= RAMP_STEPS; i++) out[i] = `rgba(${r},${g},${b},${(i / RAMP_STEPS).toFixed(3)})`;
  return out;
}
export function rampIndex(a) {
  const i = Math.round(a * RAMP_STEPS);
  return i < 0 ? 0 : (i > RAMP_STEPS ? RAMP_STEPS : i);
}
export const RAMP_PLAYER = makeRamp(COL_PLAYER);
export const RAMP_STRUCT = makeRamp(COL_STRUCT);
export const RAMP_DANGER = makeRamp(COL_DANGER);
export const RAMP_BONUS = makeRamp(COL_BONUS);
export const RAMP_GRID = makeRamp(COL_GRID);
export const RAMP_BG = makeRamp(COL_BG);

// ─── AI 디렉터 ────────────────────────────────────────────────
export const DATA_CHUNKS = 'data/chunks.json';
export const DATA_POLICY = 'data/policy.json';
export const DATA_LINES = 'data/lines.json';

export const METRIC_WINDOW = 8;               // 최근 8구간 슬라이딩 윈도
export const CHUNK_MS = 9000;                 // 판정 구간 길이
export const OBSERVE_CHUNKS = 1;              // 처음 한 구간은 관찰만

// 판정 임계값 — 러너에서 배운 교훈을 그대로 가져온다.
// **도달 불가능한 임계값을 두지 않는다.** 지표를 고친 뒤 봇 분포에서 다시 잡는다.
export const TH_AGGRO_HIGH = 0.62;            // 소환 빈도
export const TH_AGGRO_LOW = 0.30;
export const TH_HOARD_HIGH = 0.45;            // 금을 쌓아 두는 정도
export const TH_ECON_HIGH = 0.55;             // 진화에 쓴 비중
export const TH_SWARM_HIGH = 0.66;            // 싼 유닛 비율
export const HYSTERESIS = 0.05;
export const PROFILE_DWELL = 2;               // 판정을 바꾼 뒤 유지할 구간 수

// ─── 특성 드래프트 ────────────────────────────────────────────
// 시대를 올릴 때마다 셋 중 하나를 고른다. 어떤 셋을 제시할지가 디렉터의 판단이다.
export const TRAIT_OFFER = 3;
export const DRAFT_UI_MS = 260;
export const TRAITS = [
  // kind 0=공격 1=방어 2=경제
  { id: 'sharp',   kind: 0, name: '예리함',   desc: '내 유닛 공격력 +20%' },
  { id: 'swift',   kind: 0, name: '기민함',   desc: '내 유닛 이동 +25%' },
  { id: 'volley',  kind: 0, name: '연사',     desc: '궁수 공격 속도 +30%' },
  { id: 'siege',   kind: 0, name: '공성',     desc: '기지 피해 2배' },
  { id: 'thick',   kind: 1, name: '두꺼움',   desc: '내 유닛 체력 +25%' },
  { id: 'wall',    kind: 1, name: '방벽',     desc: '내 기지 체력 +400' },
  { id: 'drain',   kind: 1, name: '배수',     desc: '물 상승 −25%' },
  { id: 'revive',  kind: 1, name: '재기',     desc: '적 처치 시 물이 더 밀린다' },
  { id: 'mine',    kind: 2, name: '광맥',     desc: '금 수입 +30%' },
  { id: 'loot',    kind: 2, name: '전리품',   desc: '처치 보상 2배' },
  { id: 'study',   kind: 2, name: '연구',     desc: '경험치 +40%' },
  { id: 'rush',    kind: 2, name: '속성',     desc: '소환 쿨다운 −30%' },
];

// ─── 접근성 · 입력 ────────────────────────────────────────────
export const KEY_HINT = ['1', '2', '3', '4', '5'];
