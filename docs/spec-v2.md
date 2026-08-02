# 확장 계약 v2 — 규모 확대

여러 전문가가 **동시에** 작업한다. 서로의 파일을 열지 않고도 맞물리게 하려면
무엇이 존재하는지가 먼저 못 박혀 있어야 한다. 이 문서가 그 계약이다.

**이 계약을 바꾸려면 통합 담당(메인)에게 말해야 한다. 혼자 바꾸면 남의 작업이 깨진다.**

---

## 0. 절대 제약 (전원 공통 — 위반 시 즉시 중단)

- 순수 HTML + CSS + JS + Canvas 2D. **npm·번들러·프레임워크·빌드 단계 없음**
- **외부 에셋 0개.** 이미지·오디오·폰트 파일을 추가하지 않는다
- **팔레트 6색만.** `COL_BG COL_GRID COL_STRUCT COL_PLAYER COL_DANGER COL_BONUS`
  대비가 더 필요하면 색이 아니라 **알파 램프**(`C.RAMP_*`, `C.rampIndex(a)`)로 번다
- **루프 안에서 객체·배열·문자열을 만들지 않는다.** 풀과 타입배열을 쓴다.
  숫자는 문자열로 조립하지 않고 자리별로 그린다
- **판정에 `Math.random()` 금지.** 연출(파티클·셰이크)에만 허용.
  재현 불가능해지면 AI 디렉터가 증거가 못 된다
- `localStorage` / `sessionStorage` 0건
- 고정 타임스텝 60Hz. 시뮬레이션 코드에 `deltaTime` 을 곱하지 않는다
- 상수는 `src/config.js` 에만 둔다. 순수 드로잉 좌표만 `render.js` 지역 상수 허용

## 1. 파일 소유권 (겹치면 충돌한다)

| 파일 | 소유자 |
|---|---|
| `src/config.js` | **메인만** — 상수 추가가 필요하면 메인에게 요청 |
| `src/game.js` | 시스템 설계자 |
| `src/render.js` | 아트 디렉터 |
| `src/audio.js` | 오디오 감독 |
| `src/director.js`, `tools/bake.js`, `tools/verify-chunks.js` | 밸런스·AI 감독 |
| `tools/evaluate.mjs` | QA 감독 |
| `src/main.js`, `src/feel.js` | 메인 |

---

## 2. 유닛 — 3종 → **6종**

`C.U_*` 인덱스. `C.U_HP/U_DMG/U_RANGE/U_SPEED/U_COOLDOWN/U_COST/U_XP/U_BOUNTY/U_W/U_H/U_SPAWN_CD`
전부 길이 6 배열이다.

| # | 상수 | 이름 | 성격 |
|---|---|---|---|
| 0 | `U_SWORD` | 검사 | 싸고 빠르다. 물량 |
| 1 | `U_SPEAR` | 창병 | 근접인데 사거리가 길다. 기병을 막는다 |
| 2 | `U_ARCHER` | 궁수 | 원거리. 근접에 약하다 |
| 3 | `U_CAV` | 기병 | 빠르게 파고든다. 궁수·투석기를 썬다 |
| 4 | `U_GIANT` | 거인 | 느리고 단단하다. 앞을 막는다 |
| 5 | `U_CATA` | 투석기 | 초장거리. **기지에 강하다.** 매우 느리고 비싸다 |

### 상성 — `C.COUNTER[attacker][defender]` (6×6 피해 배수, Float32Array)

삼각형이 돌아야 한다. 하나로 전부를 이길 수 없다.

```
창병 > 기병      기병 > 궁수·투석기      궁수 > 검사·거인      검사 > 창병
```

배수는 `C.COUNTER_STRONG`(우위) / `1`(보통) 두 값만 쓴다. 표는 config 에 있다.

## 3. 시대 — 4개 → **5개**

`C.ERA_NAME = ['돌','청동','강철','화약','기계']`, `C.ERA_COUNT = 5`.
`ERA_HP_MUL / ERA_DMG_MUL / ERA_COST_MUL / ERA_XP` 전부 길이 5.

**시대는 눈과 귀로 구분돼야 한다.** 아트는 머리 위 표식과 실루엣으로,
오디오는 음색·화성으로 시대를 알린다.

## 4. 기지 포탑 — 신규

기지 위에 자동 사격 포탑을 산다. 2단계까지 올린다.

- `game.towerLv` (0~2), `game.towerCd`
- 상수: `C.TOWER_COST[2]`, `C.TOWER_DMG[2]`, `C.TOWER_RANGE`, `C.TOWER_CD`
- 사거리 안 가장 앞선 적을 자동으로 쏜다. 이벤트 `EV.TOWER_FIRE`
- 아트: 기지 옥상에 포탑을 그린다. 단계가 보여야 한다

## 5. 스킬 — 1개 → **3개**

| 상수 | 이름 | 효과 |
|---|---|---|
| `SK_TIDE` | 해일 | 적 전체 피해 + 물 밀기 |
| `SK_VOLLEY` | 화살비 | **전선 부근**에만 피해. 아군은 안 맞는다 |
| `SK_RALLY` | 증원 | 현재 시대 검사 3기 즉시 무료 소환 |

각각 독립 쿨다운 `game.skillCd[3]`. 상수 `C.SKILL_CD[3]`, `C.SKILL_DMG[3]`.
이벤트 `EV.SKILL` (a = 스킬 번호).

## 6. 버튼 — 5개 → **10개**

`C.BTN_COUNT = 10`. 순서: 검사·창병·궁수·기병·거인·투석기·진화·포탑·해일·화살비
… 는 11개가 되므로 **증원은 키보드 0 과 마지막 칸을 공유하지 않는다.**
실제 배치는 아래 인덱스로 고정한다.

```
0 검사  1 창병  2 궁수  3 기병  4 거인  5 투석기
6 진화  7 포탑  8 해일  9 화살비
```

증원(`SK_RALLY`)은 **진화 버튼 롱프레스가 아니라** 키보드 `R` 과
화면 우하단 별도 원형 버튼으로 낸다 (`Renderer.hitRally`).

키보드: `1~6` 유닛, `7` 진화, `8` 포탑, `9` 해일, `0` 화살비, `R` 증원.

## 7. 이벤트 코드 (game.js 가 emit, feel·audio·director 가 듣는다)

기존 코드는 번호를 **바꾸지 않는다.** 아래를 뒤에 붙인다.

```
16 EV.TOWER_FIRE     a = 포탑 단계
17 EV.SKILL          a = 스킬 번호(0 해일 1 화살비 2 증원)
18 EV.TOWER_UP       a = 새 단계
19 EV.COUNTER_HIT    a = 공격자 종류, b = 진영   (상성 우위로 때렸다)
```

## 8. game 객체가 노출하는 것 (아트·오디오·QA 가 읽는다)

기존에 더해:

```
game.towerLv          0~2
game.towerCd          ms
game.skillCd[3]       ms
game.spawnCd[6]       ms  ← 길이가 6으로 늘었다
game.spawnedKind[6]
game.cost(kind)       현재 시대 가격
game.skillReady(i)    boolean
game.towerCost()      다음 단계 가격. 최대면 -1
```

## 9. 각 전문가에게

- **시스템 설계자** — 위 전부를 `game.js` 에 구현한다. 상성·포탑·스킬·6유닛.
  통과 가능성만큼 중요한 것: **판이 2~3분에 끝나야 한다.**
  `node tools/evaluate.mjs` 로 확인하고, 안 끝나면 수치가 아니라 구조를 의심해라
- **아트 디렉터** — 6종이 **실루엣만으로** 구분돼야 한다. 색으로 때우지 마라.
  10개 버튼이 좁은 화면에서 읽혀야 한다. 포탑·스킬 연출을 만든다
- **오디오 감독** — 6종 소환음·상성 타격음·포탑·스킬 3종·시대 5단계.
  **오디오 파일 0개.** LFO 게이팅으로 박자를 만들고 노드는 unlock 에서만 만든다
- **밸런스·AI 감독** — 디렉터가 6유닛 구성비를 짜게 하고, 베이크 스키마를
  `mix[6]` 으로 늘린다. 프로파일별 구성이 **실제로 갈리는지** 검수로 증명해라
- **QA 감독** — 평가기가 새 요소(포탑·스킬·상성)를 재게 만든다.
  "전략이 갈리는가"를 6유닛 조합으로 다시 정의해라

---

## 부록 A — `ACT` 상수 (메인이 못 박는다)

`src/main.js` 가 이 이름과 번호로 입력 큐에 넣는다. 바꾸면 즉시 깨진다.

```js
export const ACT = {
  SWORD: 0, SPEAR: 1, ARCHER: 2, CAV: 3, GIANT: 4, CATA: 5,
  ERA: 6, TOWER: 7, TIDE: 8, VOLLEY: 9, RALLY: 10,
  PICK0: 11, PICK1: 12, PICK2: 13, RESTART: 14,
};
```

**유닛 행동 번호(0~5)가 곧 유닛 종류 인덱스다.** `Renderer.hitButton` 이 버튼
인덱스를 그대로 큐에 넣고, 버튼 0~5 가 유닛 0~5 이므로 변환이 필요 없다.
버튼 6~9(진화·포탑·해일·화살비)도 같은 번호로 맞물린다.
증원만 버튼 줄 밖(우하단 원형·키 `R`)이라 10 이다.

## 부록 B — `Renderer` 정적 메서드 (메인이 부른다)

```js
Renderer.hitButton(lx, ly)   // 0~9, 없으면 -1
Renderer.hitRally(lx, ly)    // boolean  ← 아트 디렉터가 새로 추가
Renderer.hitCard(lx, ly)     // 0~2, 없으면 -1
Renderer.hitToggle(lx, ly)
Renderer.hitMute(lx, ly)
```
