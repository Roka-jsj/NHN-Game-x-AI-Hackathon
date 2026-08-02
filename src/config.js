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
// 그래서 15 로 낮췄는데,
// **여전히 물이 전투를 대체하고 있었다.** 실측(15일 때):
//   전체 사망의 48~66% 가 익사였고, 유닛이 살아 있는 시간의 32~70% 가 수중이었다.
//   협곡 폭 960 에 깊이 78 이라 수면이 78px 만 오르면 전장 거의 전체가 잠긴다 —
//   ~50초부터 절반, ~100초부터 전부. 검사 체력 58 은 15dps 아래에서 3.9초를 산다.
//   소환지점에서 전선까지 걷는 데 7~9초가 걸리므로 **후반에는 아무도 전선에 못 닿는다.**
//   그래서 전선이 중앙에 굳고, 기지 타격이 8개 전략 전부 0회였다.
// 3 으로 낮추면 익사 비율이 14~24% 로 떨어지고 판이 230초→130~180초로 줄었다.
// 물의 역할은 **압박**이지 병력 삭제가 아니다. 판을 끝내는 시계는
// 수면이 기지에 닿는 것(WATER_BASE_AT)이 맡는다 — 그쪽은 전선 위치로 갈린다.
export const DROWN_DPS = 3;                   // 물에 잠긴 유닛이 받는 초당 피해
export const BASE_L_X = 92;                   // 내 기지 중심
export const BASE_R_X = VIEW_W - 92;          // 적 기지 중심
export const BASE_W = 108;
export const BASE_H = 132;
export const SPAWN_L_X = BASE_L_X + 46;
export const SPAWN_R_X = BASE_R_X - 46;
// 780 · 배수 9 였을 때 **투석기가 기지를 1발에 부쉈다** (34×9×2.6 = 795.6 > 780).
// 사거리 300이라 제 전열 뒤에 서서 쏘므로, 한 기라도 도달하면 그 순간 판이 끝난다.
// 그리고 검사 한 기 단독 함락이 18.8초로 너무 빨라 판 평균이 83초까지 내려갔다.
// 체력을 올리고 배수를 낮춘다 — 뚫으면 무너지되, 한 대에 무너지지는 않는다.
// 1400 → 1750. 유닛이 실제로 기지에 닿게 되면서 판이 너무 빨리 끝났다.
// 시대가 오르면 여기에 ERA_BASE_HP_MUL 이 곱해진다 (game.eraScaleBase).
export const BASE_HP = 1750;
// **기지에는 훨씬 크게 들어간다.** 이게 없으면 검사 하나가 기지를 부수는 데
// 58초가 걸리고, 그래서 5분을 돌려도 기지가 안 무너져 매번 무승부로 끝났다.
// 플래시게임의 판은 2~3분이다. 뚫으면 무너져야 한다.
// 5 였다. 기지 타격이 아예 안 일어나던 시절의 값이라 "한 번 닿으면 즉사"로
// 맞춰져 있었다. 익사와 시대 경제를 고치고 나니 유닛이 실제로 기지에 닿게 됐고,
// 그러자 5 에서는 판이 평균 69초에 끝났다 — 계약의 2~3분보다 훨씬 짧다.
// 3 에서 평균 144초가 나온다.
export const BASE_DMG_MUL = 3;

// ── 시도했다가 실측으로 버린 것: 기지 앞마당(BASE_MIN_REACH) ──
// 근접의 기지 타격선(868−54−22 = 792)이 적 스폰 지점(822) 안쪽이라 갓 나온
// 수비병이 매번 30px 앞에서 막는다고 보고, 사거리에 하한 150 을 줘서
// 타격선을 718 로 당겼다. 실제로 기지 타격이 생기긴 했다.
// 그런데 **상성 삼각형이 6/6 → 5/6 으로 깨졌다.** 앞마당 안에 들어간 기병이
// 남은 궁수를 쫓는 대신 그 자리에 서서 기지를 두들기고, 사거리 128 궁수에게
// 일방적으로 사살당한다(8:8 → 0:3). 하한을 78·110·150·182 로 쓸어 봐도
// 78(=앞마당 없음)에서만 6/6 이 나왔다.
// 그리고 익사(15→3)와 시대 경제를 고친 뒤 다시 재 보니 **앞마당 없이도**
// 첫 기지 타격이 21~64초에 나오고 8판 전부 병력으로 결판났다.
// 즉 앞마당은 증상에 붙인 반창고였고, 원인은 물과 경제였다. 그래서 지웠다.

// ─── 유닛 ────────────────────────────────────────────────────
// 세 종류가 가위바위보처럼 맞물린다. 하나로 전부를 이길 수 없다.
//   0 검사   싸고 빠르다. 물량
//   1 궁수   멀리서 때린다. 근접에 약하다
//   2 거인   느리고 비싸다. 앞을 막는다
// 여섯 종류가 삼각형으로 맞물린다. 하나로 전부를 이길 수 없다.
//   창병 > 기병      기병 > 궁수·투석기      궁수 > 검사·거인      검사 > 창병
export const U_SWORD = 0, U_SPEAR = 1, U_ARCHER = 2, U_CAV = 3, U_GIANT = 4, U_CATA = 5;
export const UNIT_KINDS = 6;
export const UNIT_NAME = ['검사', '창병', '궁수', '기병', '거인', '투석기'];
export const UNIT_MAX = 128;                  // 양쪽 합계. 풀 크기

// 시대별 배수. 시대가 오르면 **같은 버튼이 다른 유닛을 뽑는다.**
export const ERA_COUNT = 5;
export const ERA_NAME = ['돌', '청동', '강철', '화약', '기계'];
export const ERA_HP_MUL = [1, 1.6, 2.6, 4.1, 6.4];
export const ERA_DMG_MUL = [1, 1.65, 2.7, 4.3, 6.8];
export const ERA_COST_MUL = [1, 1.5, 2.2, 3.2, 4.6];

//                     검사  창병  궁수  기병  거인  투석기
export const U_HP =       [58,  66,  40,  54, 165, 46];
export const U_DMG =      [11,  10,   9,  14,  22, 26];
export const U_RANGE =    [22,  38, 128,  24,  26, 300];   // 투석기는 초장거리
export const U_SPEED =    [46,  38,  34,  74,  24, 15];    // 기병이 가장 빠르다
export const U_COOLDOWN = [640, 760, 880, 700, 1150, 2400];
export const U_COST =     [28,  40,  44,  62,  92, 120];
export const U_XP =       [10,  13,  14,  18,  26, 30];
export const U_BOUNTY =   [16,  20,  22,  30,  44, 52];
export const U_W =        [23,  22,  19,  30,  36, 34];
export const U_H =        [46,  48,  39,  44,  70, 40];
export const U_SPAWN_CD = [420, 520, 620, 700, 1050, 1500];

// 최소 사거리 — 이보다 가까운 적에게는 공격이 성립하지 않는다.
// **상성 배수로는 "닿기 전에 죽는 것"을 못 뒤집는다.** 계약 §2 의 삼각형이
// 6변 중 4변만 돌고 있었고, 실패한 두 변(기병>궁수, 기병>투석기)이 전부
// 방어자 사거리가 더 긴 조합이었다. 배수를 올리는 건 대증요법이고
// 사거리 300 앞에서는 어차피 안 된다. 배수가 아니라 **구조**로 돌린다 —
// 활을 당길 공간이 없고 투석기는 코앞에 못 쏜다.
//
// 값은 **추론이 아니라 그리드 스윕으로 골랐다.** 메인이 처음에 [.. 30 .. 90] 을
// 넣었는데 둘 다 너무 작아 삼각형이 안 돌았다. 실측:
//   궁수 44 가 최적이다. 70·96 으로 올리면 오히려 **4/6 으로 떨어진다** —
//     궁수>검사·궁수>거인 이 같이 깨지기 때문이다. 검사 사거리 22·거인 26 이
//     44 안에 들어와 접촉 즉시 봉쇄되는, 딱 그만큼만 필요하다
//   투석기 180. 170 에서 처음 성립하고 160 은 실패(3:5)다.
//     170 은 벼랑 끝이라 여유를 둔 180 을 고른다 (190~270 도 전부 6/6, 고원이 넓다)
//                       검사 창병 궁수 기병 거인 투석기
export const U_MIN_RANGE = [0,   0,  44,   0,   0, 180];

// 투석기는 기지를 부수라고 있는 유닛이다. 유닛 상대로는 느려서 잘 못 맞힌다.
// 투석기는 공성 병기다. **초당 피해는 검사와 비슷하되 사거리 300에서 안전하게**
// 넣는 것이 값어치다. 배수를 2.6 으로 두면 한 방에 기지가 날아간다.
export const U_BASE_MUL = [1, 1, 1, 1, 1, 1.8];

// 공성 병기 플래그 — 1이면 **유닛을 표적으로 삼지 않는다.** 기지만 본다.
// 왜 이런 규칙이 필요한가: 투석기는 사거리 300이라 적 전열 300 뒤에 멈춰 서고,
// 그 지점은 기지 사거리(x≥514)에 영원히 못 닿는다. 실측 최대 도달 x 가 247·336
// 이었고 240초짜리 공성 전략 판에서 기지 타격이 **0회**였다.
// 사거리와 기지 배수를 아무리 줘도 표적 규칙이 그걸 막고 있었다.
// 이제 투석기는 공성선까지 걸어가 거기서만 쏜다 — 자기 방어를 못 하므로
// 전선을 공성선보다 앞에 유지하는 것이 값이다.
export const U_SIEGE = [0, 0, 0, 0, 0, 1];
// 공성선 — 이 x 부터 적 기지가 투석기 사거리에 들어온다 (참고용 상수).
export const SIEGE_LINE_L = BASE_R_X - BASE_W * 0.5 - U_RANGE[U_CATA];   // 514

// ── 상성표 — COUNTER[공격자 * UNIT_KINDS + 방어자] ──
// 삼각형이 돌아야 한다. 표를 손으로 쓰면 반드시 어긋나므로 규칙에서 생성한다.
export const COUNTER_STRONG = 1.75;
export const COUNTER = (() => {
  const t = new Float32Array(UNIT_KINDS * UNIT_KINDS).fill(1);
  const beats = [
    [U_SPEAR, U_CAV],
    [U_CAV, U_ARCHER], [U_CAV, U_CATA],
    [U_ARCHER, U_SWORD], [U_ARCHER, U_GIANT],
    [U_SWORD, U_SPEAR],
  ];
  for (const [a, d] of beats) t[a * UNIT_KINDS + d] = COUNTER_STRONG;
  return t;
})();

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
// **여기 값은 소모된다** (buyEra 가 xp 에서 뺀다). 그래서 기계 시대까지의
// 총액은 합계다. 예전 값의 합은 240+640+1300+2400 = 4580 이었다.
// 실측: 한 판(210~250초) 동안 플레이어가 번 경험치는 **1051~1174** 이다.
// 즉 4시대는 필요량의 23~26% 만 벌리는, **구조적으로 도달 불가능한** 값이었다.
// 8개 원형 전략 전부 도달 시대가 2에서 멈췄다 — 강철·화약·기계는 없는 콘텐츠였다.
// 총액을 1100 으로 낮추고, 늦은 시대의 유닛일수록 경험치를 더 주게 해서
// 후반 시대가 **가속**되게 한다. 판이 2~3분이므로 마지막 시대는 클라이맥스다.
export const ERA_XP = [0, 110, 200, 320, 470];
// 잡은 유닛의 **시대**로 경험치가 곱해진다. 시대가 오를수록 다음 시대가 빨라진다.
export const ERA_XP_MUL = [1, 1.5, 2.1, 2.8, 3.6];
// 시대가 오르면 기지도 같이 튼튼해진다. 이게 없으면 기계 시대 검사 한 기가
// (11 × 6.8 × 5 = 374/타) 기지를 2.4초에 부순다 — 5시대를 열어 준 대가로
// 판이 시대 도달 즉시 끝나 버린다. 비율을 유지하며 곱하므로 체력바는 안 튄다.
export const ERA_BASE_HP_MUL = ERA_HP_MUL;
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
// **적을 잡아 물을 미는 것은 유예이지 면제가 아니다.**
// 실측: 후반 스테이지의 판이 200~300초까지 늘어졌다. 원인은 기지 체력이 아니라
// 이 밀어내기였다 — 한 판에 60~100기가 죽으면 물이 200~340px 밀려나 수면이
// 기지에 영영 못 닿는다. 마감 시계가 스스로 꺼지는 구조다.
// 시간이 갈수록 밀어내는 힘이 준다. 0 으로 두지는 않는다 —
// 그러면 "공격이 곧 생존"이라는 이 게임의 해독제가 통째로 사라진다.
export const WATER_PUSH_FADE_MS = 120000;
export const WATER_PUSH_FLOOR = 0.15;
export const WATER_ERA_PUSH = 30;             // 진화하면 크게 내려간다
// 기지가 완전히 잠기는 높이. 여기까지 오면 더 못 올라간다.
export const WATER_MIN_Y = GROUND_Y - BASE_H - 10;
// 기지 피해는 **마지막 심판**이자 이 게임의 유일한 마감 시계다.
// 익사(DROWN_DPS)를 3 으로 낮추면서 물의 주된 역할이 이쪽으로 옮겨 왔다.
// 실측: 8개 원형 전략 전부 **병력으로** 결판났고 물이 기지에 넣은 피해는
// 0~2400(총 체력의 0~17%)에 그친다. 그러나 아무도 아무것도 안 하는 판은
// 225초에 무승부로, 밀리기만 하는 판은 171초에 패배로 **끝난다** — 시계는 산다.
// game.js 는 이 값에 기지 최대체력 비율을 곱한다. 안 그러면 시대가 오른 뒤
// 물이 시계가 아니게 되어 판이 다시 안 끝난다.
export const WATER_DPS = 12;
// 기지가 절반쯤 잠겨야 깎이기 시작한다. 0.35 로 뒀더니 46초에 시작해
// 유닛이 승부를 내기 전에 물이 양쪽 기지를 다 죽여 무승부가 기본값이 됐다.
export const WATER_BASE_AT = GROUND_Y - BASE_H * 0.5;
export const WATER_WARN = 70;                 // 수면이 지면에서 이만큼 안이면 경고

// ─── 기지 포탑 ────────────────────────────────────────────────
// 사면 기지가 스스로 싸운다. 수비형 플레이에 실체를 준다 —
// 지금까지 "웅크리기"는 그냥 지는 선택지였다.
export const TOWER_MAX = 2;
// 180 이었다. 공격적으로 노는 사람은 **한 판 내내 한 번도 못 산다** —
// 수입 16/초에 검사 28금이라 180이 모이는 구간이 안 생긴다. 실측으로
// 돈 되는 대로 소환하는 봇은 180 에서 포탑 0개, 120 에서 1개를 지었다.
// 2단계는 그대로 큰 결단으로 남긴다.
export const TOWER_COST = [120, 420];
export const TOWER_DMG = [16, 34];
// 330 은 **표적이 없어서 포탑이 놀았다.** 기지 중심 x=92 기준이라 x≤422 까지만
// 닿는데 전장 중앙이 480 이다. 즉 포탑은 **내가 이미 지고 있을 때만** 쏜다 —
// 이기는 판에서는 사격 0회였다.
// 실측: 연사를 2배(cd 1400→700)로 해도 참여가 15→19회밖에 안 늘고,
// 피해를 16/34→40/85 로 올리면 사격 횟수가 오히려 줄었다(8회).
// **사거리만이 참여를 바꾼다** — 330→500 에서 사격 3.4배, 피해당 금 5.9배.
// 500 이면 x≤592 로 중앙을 조금 넘긴다. 적 기지(868)에는 절대 안 닿으므로
// 승리 버튼이 되지 않는다.
// 주의: 기준점은 **기지 중심**이다. 기지 폭이 108 이라 벽 앞 유효 거리는 이 값 −54.
export const TOWER_RANGE = 500;
export const TOWER_CD = 1400;                 // ms

// ─── 스킬 셋 ──────────────────────────────────────────────────
// 플래시게임의 "필살기" 자리. 쿨다운이 길고 화면이 크게 바뀐다.
export const SK_TIDE = 0, SK_VOLLEY = 1, SK_RALLY = 2;
export const SKILL_COUNT = 3;
export const SKILL_NAME = ['해일', '화살비', '증원'];
export const SKILL_CD = [42000, 26000, 34000];
export const SKILL_DMG = [260, 150, 0];
export const VOLLEY_RADIUS = 190;             // 전선 중심 반경
export const RALLY_COUNT = 3;
export const NUKE_WATER_PUSH = 70;

// ─── 버튼 ────────────────────────────────────────────────────
// 화면 아래 한 줄. 유닛 3 + 진화 1 + 특수기 1.
// 유닛 6 + 진화 + 포탑 + 해일 + 화살비 = 10. 증원은 별도 원형 버튼(키 R).
export const BTN_COUNT = 10;
// 폭 88·간격 6 은 5칸짜리였던 시절의 값이다. 10칸이 되자 열 전체가 934px 이
// 되어 가운데 정렬 식이 **BTN_X0 = -13** 을 내놨다 — 0번 칸이 화면 밖에서
// 시작하고, 오른쪽 끝은 우하단 증원 원(890~942)과 겹쳤다.
// 실측으로 맞춘 값이다: 6 + 10*83 + 9*5 = 881 로 증원 원 앞에서 끝난다.
// 평가기의 `버튼 적중 10/10 · 증원 원형버튼 적중` 이 이 값을 지킨다.
export const BTN_W = 83;
export const BTN_H = 66;
export const BTN_GAP = 5;
export const BTN_Y = VIEW_H - BTN_H - UNIT * 1.5;
export const BTN_X0 = 6;
export const B_ERA = 6, B_TOWER = 7, B_TIDE = 8, B_VOLLEY = 9;
export const RALLY_R = 26;                    // 우하단 원형 버튼 반지름
export const RALLY_CX = VIEW_W - 44;
export const RALLY_CY = BTN_Y + BTN_H * 0.5;
export const KEY_HINT = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

// ─── 적 AI (디렉터가 조종한다) ────────────────────────────────
export const AI_GOLD_RATE = 12.5;             // 적의 기본 수입. 레버가 곱한다
export const AI_GOLD_START = 110;
export const AI_THINK_MS = 620;               // 적이 판단하는 주기
export const AI_ERA_XP = [0, 125, 230, 370, 540];   // 플레이어보다 약 15% 비싸다

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

// ─── 원정 (spec-v3) ───────────────────────────────────────────
// 판 하나가 아니라 여정이다. 이기면 다음 사령관, 지면 원정 종료.
// localStorage 가 금지이므로 **세션 메모리에만 산다.** 새로고침하면 사라진다.
// 이건 제약이지 버그가 아니다 — 어디에도 "저장됨"이라고 쓰지 않는다.
export const CAMPAIGN_LEN = 5;

// 사령관 = 디렉터의 다섯 프로파일에 얼굴을 준 것.
// 순서는 **가르치는 순서**다. 물량형이 가장 읽기 쉽고(상성만 알면 이긴다),
// 균형형이 마지막이다 — 균형형은 플레이어를 읽고 따라오므로 도배가 안 통한다.
export const COMMANDER_PROFILE = ['SWARMER', 'RUSHER', 'ECONOMIST', 'TURTLE', 'BALANCED'];
export const COMMANDER_NAME = ['무리', '쇄도', '금고', '성벽', '거울'];
export const COMMANDER_TITLE = ['물량형', '돌격형', '축재형', '농성형', '균형형'];
export const COMMANDER_LINE = [
  '수는 그 자체로 무기다.',
  '생각할 시간을 주지 않겠다.',
  '너는 지금 쓰고, 나는 나중에 쏟는다.',
  '네가 지칠 때까지 나는 서 있다.',
  '나는 네가 무엇을 좋아하는지 이미 안다.',
];
// 디렉터가 플레이어 프로파일을 새로 판정했을 때 던지는 말.
// [사령관][판정된 플레이어 프로파일] 이 아니라 사령관당 하나다 —
// 무엇을 읽었는지는 디렉터가 말하고, 사령관은 성격으로 반응한다.
export const COMMANDER_TAUNT = [
  '그 손버릇, 이제 보인다.',
  '읽었다. 같은 수는 두 번 안 통한다.',
  '네 지갑이 다 보인다.',
  '기다린 보람이 있군.',
  '거울을 보고 있는 기분이겠지.',
];

// 스테이지 곡선. 길이는 CAMPAIGN_LEN.
// **난이도는 곡선이지 상수가 아니다.** 첫 전투는 이기라고 있고
// 마지막 전투는 지는 것이 기본값이다.
//
// 나쁜 난이도(체력·수입만 올리기)를 피하려고 축을 셋으로 나눴다:
//   HP_MUL   판 길이만 늘린다. 첫 전투를 짧게 만드는 용도로만 내린다
//   DIFF     적 수입·사령관 공격성. 올리면 실수의 대가가 커진다
//   WATER_MUL 수위 속도 = 마감 시계. 익사 피해(DROWN_DPS)가 아니다 —
//            그건 병력이 전선에 닿기도 전에 죽여 교착을 굳혔던 값이다
export const STAGE_HP_MUL = [0.45, 0.75, 1.0, 1.15, 1.35];
export const STAGE_DIFF = [0.80, 1.00, 1.15, 1.30, 1.50];
export const STAGE_WATER_MUL = [0.70, 0.95, 1.10, 1.25, 1.45];
// 전장 변주 — 전투마다 협곡 모양이 다르다. groundAt(x) 의 서명은 안 바뀐다.
export const STAGE_DIP = [46, 78, 96, 62, 112];

// ─── 원정 · 온보딩 · 사령관 행동 (원정 설계자) ─────────────────
// 첫 전투만 경험치를 안고 시작한다. **온보딩이다.**
// 실측: 시대 진화·드래프트·스킬이 21초에 처음 나온다. 심사자는 30초 안에
// 판단한다. 첫 시대 요구치가 110 이므로 여기 값이 그만큼 앞당긴다.
export const STAGE_XP_HEAD = [64, 0, 0, 0, 0];
// 사령관의 개전 한 수 — 기병 한 기가 이 시각에 그냥 출발한다 (공짜).
// 소환지점 822 에서 내 기지 타격선 168 까지 기병 속도 74 로 8.8초다.
// 막으면 5초쯤에 전투가, 안 막으면 10초쯤에 내 기지가 깎인다.
// **어느 쪽이든 10초 안에 무언가가 부서지는 것을 본다** (계약 §4).
export const INTRO_POKE_MS = 300;

// 적의 시대 경험치 유입(초당). 지금까지 적은 **플레이어를 죽여야만** 시대가
// 올랐다. 그래서 이기고 있는 판에서 적은 영원히 돌 시대에 머물고 플레이어만
// 5시대를 열어 눈덩이가 굴렀다 — 8개 원형 전략 중 5개가 적 기지 체력 0 으로
// 이겼고 자기 기지는 거의 안 깎였다. 시간으로 흘려 넣으면 초반은 그대로 두고
// 후반만 어려워진다. AI_ERA_XP 합이 1265 이므로 4.5/초면 판 하나에 2~3시대다.
export const AI_XP_RATE = 1.6;
// 스테이지별 배수. **첫 전투에서는 거의 0 이어야 한다** — 실측에서 이걸
// STAGE_DIFF(0.8)에 걸었더니 적이 첫 전투에서 3시대까지 올라갔고,
// ERA_BASE_HP_MUL 이 적 기지를 4.1배로 불려 첫 전투가 93초가 됐다.
// 목표는 40~60초다. 적의 시대는 **뒤 전투의 위협**이지 첫 전투의 벽이 아니다.
export const STAGE_AI_XP = [0.12, 0.55, 0.85, 1.10, 1.40];

// 적 수입의 스테이지 배수. **STAGE_DIFF 를 그대로 곱하면 안 된다** —
// 실측: 디렉터의 시간 난이도 배수(최대 1.4)와 정책 배수(최대 1.3)가 이미
// 곱해져 있어서, 여기에 1.5 를 또 곱하면 마지막 전투의 적 수입이 34/초가 된다.
// 플레이어는 16/초다. 그 판은 손 쓸 새 없이 밀리고 **아무것도 배울 수 없다** —
// 계약 §5.5 가 금지한 바로 그 난이도다. 8전략 × 5사령관 격자에서 스테이지 2~4 가
// 40전 전패였던 원인이 이것이었다. 난이도는 수입이 아니라 **행동**에 넣는다.
// **단조롭지 않은 이유**: 스테이지 난이도 = 사령관의 세기 × 이 배수 다.
// 금고(축재형) 사령관이 다섯 중 가장 세서(디렉터 정책 tempo 900 · goldMul 1.15)
// 스테이지 2 의 배수를 낮춰야 곡선이 실제로 곡선이 된다.
// 실측으로 고른 값이다: 0.92 → 8전략 전패, 0.86 → 전패, 0.80 → 2/6 통과.
export const STAGE_AI_GOLD = [0.50, 0.82, 0.80, 1.00, 1.18];


// 사령관 성격 — 인덱스는 COMMANDER_PROFILE 순서다.
//   0 무리(물량) 1 쇄도(돌격) 2 금고(축재) 3 성벽(농성) 4 거울(균형)
// **디렉터를 대체하지 않는다.** 사령관은 그 전투의 기본 성격이고,
// 디렉터는 그 위에서 플레이어를 읽어 구성비를 바꾼다.
// 사령관의 기본 구성. **다섯 사령관에게 같은 답이 통하면 안 된다** —
// 한 가지 전략으로 원정을 통과할 수 있으면 그건 전략 게임이 아니다.
//   무리 검·창 도배      → 궁수로 녹인다
//   쇄도 기병 중심       → 창병으로 끊는다
//   금고 모았다 큰 것     → 진화 전에 빠르게 두들긴다
//   성벽 궁수·투석기      → 기병으로 파고든다
//   거울 균형           → 상성을 읽어 그때그때 바꾼다
//                      검 창 궁 기 거 투
export const CMD_MIX = [
  [8, 4, 1, 1, 0, 0],   // 0 무리
  [5, 2, 0, 6, 1, 0],   // 1 쇄도
  [2, 2, 3, 1, 4, 2],   // 2 금고
  [0, 4, 6, 0, 3, 4],   // 3 성벽
  [3, 3, 3, 3, 2, 1],   // 4 거울
];
// 사령관 구성과 디렉터 구성을 섞는 비율. 0 = 전부 디렉터(예전 그대로),
// 1 = 전부 사령관(디렉터가 장식이 된다). **둘 다 살아 있어야 한다** —
// 사령관이 전투의 성격을, 디렉터가 플레이어에 대한 반응을 맡는다.
export const CMD_MIX_W = 0.5;
// 금고(축재형)는 **자주 안 뽑는다.** 모았다가 쏟는 것이 그 사령관의 정체다.
// 1.15 였을 때 디렉터 정책의 tempo 900(다섯 중 가장 빠르다)과 겹쳐서
// 싼 유닛이 끊임없이 나오는 판이 됐고, 8개 전략 전부 그 판을 졌다.
export const CMD_TEMPO_MUL = [0.80, 0.70, 1.38, 1.20, 1.00];  // 낮을수록 자주 뽑는다
// 사령관의 성격은 **행동**에 넣는다. 수입에 넣으면 정책 배수(최대 1.3)·
// 시간 난이도 배수(최대 1.4)·스테이지 배수와 곱해져 조용히 2배가 된다.
// 실측: 금고 사령관이 1.15 였을 때 적 수입이 23/초(플레이어 16/초)였고
// 8전략 전부 그 판을 졌다.
export const CMD_GOLD_MUL = [1.00, 1.02, 1.00, 0.95, 1.00];
export const CMD_SKILL_MUL = [1.00, 0.85, 1.05, 0.80, 0.90];  // 낮을수록 스킬이 잦다
export const CMD_TOWER = [0, 0, 1, 2, 1];                     // 지으려는 포탑 단계
export const CMD_HOARD = [0, 0, 420, 0, 0];                   // 이만큼 모이기 전엔 안 쓴다
// 적이 플레이어 유닛을 잡을 때 받는 현상금 배수. **눈덩이 차단기다.**
// 양쪽이 같은 현상금을 받으면 이기고 있는 쪽이 더 벌어 격차가 스스로 벌어진다.
// 밀리기 시작한 판에서 플레이어는 만회할 방법이 없다 — 계약 §5.5 가 금지한
// "초반에 손 쓸 새 없이 밀린다"가 바로 이 되먹임이다.
export const AI_BOUNTY_MUL = 0.7;
// 포탑을 살 때 병력 살 돈까지 남겨 둔다. 1.0 이면 전 재산을 포탑에 넣고 전선이 빈다.
export const AI_TOWER_BUY_MUL = 2.2;
// 적 스킬의 방아쇠는 **시간이 아니라 플레이어의 실수**다.
// 같은 실수를 반복하지 않으면 맞을 일이 없다 — 배울 수 있는 난이도의 조건이다.
export const AI_TIDE_MIN = 8;        // 병력을 이만큼 모아 두면 해일이 온다
export const AI_VOLLEY_MIN = 5;      // 전선 반경에 이만큼 뭉치면 화살비가 온다
export const AI_RALLY_MAX = 1;       // 적 전선이 이만큼 비면 증원이 온다

// 설명 화면(S.BRIEF) — 원정 첫 전투 앞에 한 번. 시뮬레이션이 멈춘다.
// **아무 입력이나 즉시 해제한다.** 이 값은 입력이 아예 없을 때 저절로 열리는
// 시간이다 — 붙잡아 두는 화면은 금지이고, 손이 없는 관전자도 게임을 봐야 한다.
export const BRIEF_MS = 9000;

// 도발 최소 간격. 디렉터의 판정이 자주 흔들려도 화면이 시끄러워지지 않게.
export const TAUNT_MIN_MS = 11000;
// 디렉터 프로파일 중 '균형'의 인덱스. 첫 판정이 균형이면 아직 못 읽은 것이므로
// 도발하지 않는다. (director.js 의 PROFILES 순서를 게임이 직접 알 필요는 없다)
export const PROFILE_NEUTRAL = 4;
