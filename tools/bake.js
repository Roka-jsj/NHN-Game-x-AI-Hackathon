#!/usr/bin/env node
// 계층 2 — 오프라인 베이크. 로컬에서 node 로만 실행한다.
// **게임은 이 파일을 절대 로드하지 않는다.** 브라우저는 data/*.json 만 fetch 한다.
//
//   저술본으로 굽기(제출본):   node tools/bake.js --authored
//   실전 LLM 베이크:           OPENAI_API_KEY=... node tools/bake.js
//   자리표시자(파이프라인 점검): node tools/bake.js --offline
//
// 세 모드는 **같은 스키마**를 낸다. 다른 것은 내용의 출처뿐이고,
// 그 출처는 chunks.json 의 generator·provenance 와 웨이브마다의 src 에 남는다.
// **아무 모드도 출처를 속이지 않는다** — 그게 이 파일의 첫째 계약이다.
//
// 왜 오프라인 베이크인가:
//   런타임에 LLM 을 부르면 API 키가 프론트엔드에 들어간다. GitHub Pages 는 정적
//   호스팅이고 프론트엔드 키는 100% 노출된다. 심사자는 엔지니어다.
//   그래서 LLM 은 개발 중에만 돌고, 런타임은 정적 JSON 만 읽는다.
//
// 산출물:
//   data/chunks.json  5프로파일 × 5난이도 × 14변형 = 350   (mix 는 **길이 6**)
//   data/policy.json  프로파일 → 레버 매핑 + 상성 대응표
//   data/lines.json   연출 문구
//
// ★ API 키는 process.env 에서만 읽는다. 코드·커밋에 절대 넣지 않는다 (.env 는 .gitignore).

'use strict';

const fs = require('fs');
const path = require('path');
const AUTHORED = require('./authored-waves.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data');

const PROFILES = ['RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER', 'BALANCED'];
const DIFFICULTIES = [0, 1, 2, 3, 4];
const VARIANTS = 14;

// ─── 유닛 6종 — src/config.js 와 같은 순서다 ───────────────────
// 이 파일은 게임 코드를 import 하지 않는다 (게임은 ESM, 도구는 CJS).
// 그래서 순서와 상성만 여기 다시 적는다. **순서가 곧 계약이다.**
const UNIT_KINDS = 6;
const U_SWORD = 0, U_SPEAR = 1, U_ARCHER = 2, U_CAV = 3, U_GIANT = 4, U_CATA = 5;
const UNIT_NAME = ['검사', '창병', '궁수', '기병', '거인', '투석기'];
const U_COST = [28, 40, 44, 62, 92, 120];   // src/config.js 의 U_COST 와 같은 값

// 상성 — [이기는 쪽, 지는 쪽]. 삼각형이 돌아야 한다.
//   창병 > 기병   기병 > 궁수·투석기   궁수 > 검사·거인   검사 > 창병
const BEATS = [
  [U_SPEAR, U_CAV],
  [U_CAV, U_ARCHER], [U_CAV, U_CATA],
  [U_ARCHER, U_SWORD], [U_ARCHER, U_GIANT],
  [U_SWORD, U_SPEAR],
];

// counterMap[지는 쪽] = [그것을 잡는 쪽들]
// 런타임은 이 표를 쓰지 않는다 — config.js 의 COUNTER 를 직접 읽는다.
// 이건 **검수와 사람 눈을 위한 산출물**이고, verify-chunks 가 삼각형이
// 돌아가는지(하나가 전부를 이기지 않는지)를 이걸로 확인한다.
function buildCounterMap() {
  const map = [];
  for (let u = 0; u < UNIT_KINDS; u++) map.push([]);
  for (const [a, d] of BEATS) map[d].push(a);
  return map;
}

const ARGV = process.argv.slice(2);
const OFFLINE = ARGV.includes('--offline');
const AUTHORED_ONLY = ARGV.includes('--authored');
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const KEY = process.env.OPENAI_API_KEY;   // 코드에 하드코딩하지 않는다. .env 는 .gitignore 에 있다
// 한 칸이 영원히 멈추면 25칸짜리 배치가 통째로 멈춘다. 반드시 끊는다.
// (테스트·급할 때 줄일 수 있게 환경변수로 뺐다. 기본값이 실전값이다)
const TIMEOUT_MS = Math.max(1000, Number(process.env.BAKE_TIMEOUT_MS) || 60000);
const RETRIES = Math.max(1, Number(process.env.BAKE_RETRIES) || 3);

// ─── 결정론적 난수 — 오프라인 자리표시자 전용 ──────────────────
// 같은 씨앗이면 같은 결과가 나와야 파이프라인 점검이 재현 가능하다.
// 저술본(--authored)과 LLM 경로에는 난수가 한 번도 안 쓰인다.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ─── 프로파일별 설계 의도 ─────────────────────────────────────
// 디렉터는 난이도를 올리는 시스템이 아니다. 성향의 **반대편으로** 판을 다시 짠다.
const INTENT = {
  RUSHER:
    '쉬지 않고 병력을 쏟아붓는 상대다. 거인으로 벽을 세우고 창병으로 돌파를 끊어 '
    + '소모를 강요해라. 궁수를 섞어 뭉친 근접을 녹여라. 템포는 느려도 된다 — '
    + '벽을 세우는 쪽이 급할 이유가 없다.',
  TURTLE:
    '금을 쌓고 나오지 않는 상대다. 궁수와 투석기로 찔러서 끌어내라. '
    + '투석기는 기지에 강하니 웅크릴수록 손해가 쌓인다. 근접은 최소로 둬라.',
  ECONOMIST:
    '병력보다 시대에 먼저 투자하는 상대다. 검사로 수를 채우고 가장 빠른 기병으로 '
    + '뒤를 파고들어라. 진화가 끝나기 전에 두들겨야 하므로 템포가 가장 빨라야 한다. '
    + '느리고 비싼 유닛(거인·투석기)은 쓰지 마라.',
  SWARMER:
    '싼 유닛만 끝없이 뽑는 상대다. 거인으로 앞을 막아 숫자를 무의미하게 만들고 '
    + '궁수로 검사를 상성으로 녹여라. 투석기를 뒤에 둬도 좋다.',
  BALANCED:
    '치우침이 없는 상대다. 여섯 종을 고르게 섞고 템포는 중간으로 둬라. '
    + '한 종에 쏠리면 그 종을 잡는 유닛 하나에 판이 끝난다.',
};

// 프로파일별 기본 구성 — [검사, 창병, 궁수, 기병, 거인, 투석기]
// src/director.js 의 BUILTIN_POLICY 와 같은 표다. 여기가 구워져 policy.json 이 된다.
//
// ★ 이 표는 LLM 산출물이 아니다. 저장소의 봇 계측·스윕으로 정해진 값이고
//   director.js 의 BUILTIN_POLICY 와 **글자 그대로 같아야 한다**.
//   그래서 policy.json 의 generator 는 chunks.json 과 따로 적는다 (아래 write 참고).
//
// ★ 가중치 0 은 "안 뽑는다"가 아니라 **"이 종류로 때우지도 않는다"**이다.
//   game.js 는 뽑기로 정한 유닛을 못 사면 가중치가 있는 것 중 가장 싼 것으로 때운다.
//   벽을 세우라는 정책에 검사를 1이라도 남기면 적의 74%가 검사가 된다(계측함).
//   프로파일마다 **가장 싼 가중치 유닛이 그 성향의 유닛**이어야 한다.
const POLICY = {
  RUSHER: {
    mix: [0, 3, 3, 0, 8, 1], tempo: 1900, goldMul: 1.3, eraThresh: 1.0,
    waterMul: 0.9, draftSlant: 1, counterGain: 4, preferTags: ['wall', 'mix'],
  },
  TURTLE: {
    mix: [0, 0, 6, 1, 0, 5], tempo: 1150, goldMul: 1.2, eraThresh: 1.0,
    waterMul: 1.35, draftSlant: 0, counterGain: 3, preferTags: ['ranged', 'mix'],
  },
  ECONOMIST: {
    mix: [7, 1, 1, 5, 0, 0], tempo: 900, goldMul: 1.15, eraThresh: 0.8,
    waterMul: 1.0, draftSlant: 1, counterGain: 3, preferTags: ['rush', 'mix'],
  },
  SWARMER: {
    mix: [0, 0, 6, 0, 7, 3], tempo: 1700, goldMul: 1.25, eraThresh: 0.9,
    waterMul: 1.0, draftSlant: 0, counterGain: 5, preferTags: ['heavy', 'mix'],
  },
  // 균형에서 레버를 완전 중립으로 두면 디렉터는 대부분의 판에서 장식이 된다.
  // 그래서 균형일수록 **상성 대응(counterGain)을 가장 세게** 건다.
  BALANCED: {
    mix: [4, 3, 3, 2, 2, 1], tempo: 1400, goldMul: 1, eraThresh: 1,
    waterMul: 1, draftSlant: 2, counterGain: 6, preferTags: ['mix'],
  },
};

const TAG_POOL = ['mix', 'wall', 'ranged', 'rush', 'heavy', 'swarm', 'siege', 'fast'];

// ─── 때움 유닛 규칙 — 이 파일에서 유일하게 모델을 덮어쓰는 곳 ────
// game.js 는 뽑기로 정한 유닛을 못 사면 **가중치가 있는 것 중 가장 싼 것**으로
// 때운다. 그래서 프로파일마다 "가장 싼 가중치 유닛"이 그 성향의 유닛이어야 한다.
// 이건 취향이 아니라 계측 결과다(벽 정책이 검사 74% 로 나왔다).
// 모델이 그보다 싼 유닛에 가중치를 주면 **0 으로 내리고 repaired 로 센다.**
// 그 외의 구성 판단은 모델 것을 그대로 둔다 — 덮어쓰면 LLM 산출물이 아니게 된다.
const BRAND_UNIT = {
  RUSHER: U_SPEAR,      // 벽의 때움은 창병
  TURTLE: U_ARCHER,     // 농성을 끌어내는 때움은 궁수
  ECONOMIST: U_SWORD,   // 가장 싼 검사가 그대로 성향이다
  SWARMER: U_ARCHER,    // 물량의 천적은 궁수
  BALANCED: U_SWORD,
};

function enforceBrand(mix, profile) {
  const brand = BRAND_UNIT[profile];
  if (brand === undefined) return { mix, repaired: false };
  let repaired = false;
  const out = mix.slice();
  for (let k = 0; k < UNIT_KINDS; k++) {
    if (U_COST[k] < U_COST[brand] && out[k] > 0) { out[k] = 0; repaired = true; }
  }
  if (!(out[brand] > 0)) { out[brand] = Math.max(1, mix[brand] | 0); repaired = true; }
  return { mix: out, repaired };
}

function tagsFor(profile, difficulty, variant) {
  const t = ['mix'];
  if (profile === 'RUSHER') t.push(variant % 2 ? 'wall' : 'heavy');
  if (profile === 'SWARMER') t.push(variant % 2 ? 'heavy' : 'wall');
  if (profile === 'TURTLE') t.push(variant % 2 ? 'ranged' : 'siege');
  if (profile === 'ECONOMIST') t.push(variant % 2 ? 'rush' : 'fast');
  if (difficulty >= 3) t.push('swarm');
  return t;
}

// ─── 저술 웨이브 — tools/authored-waves.js ────────────────────
// Claude 가 상성표·단가표·때움 규칙을 읽고 한 줄씩 직접 설계한 350개다.
// LLM 호출이 실패했을 때 메우는 것도 자리표시자가 아니라 **이쪽**이다.
function authoredChunk(profile, difficulty, variant) {
  const a = AUTHORED.get(profile, difficulty, variant);
  if (!a) return null;
  return {
    id: `${profile}-${difficulty}-${variant}`,
    profile, difficulty,
    tags: a.tags, mix: a.mix, tempo: a.tempo,
    note: a.note,
    src: 'authored',
  };
}

// ─── 오프라인 자리표시자 ──────────────────────────────────────
// 기준 구성을 난수로 흔들 뿐 의도가 없다. **LLM 산출물도 저술본도 아니다.**
// 파이프라인·스키마·폴백을 점검할 때만 쓴다. 결정론적이다.
function offlineChunk(profile, difficulty, variant) {
  const rnd = lcg(hash(profile) * 7919 + difficulty * 131 + variant * 17);
  const base = (POLICY[profile] || POLICY.BALANCED).mix;

  // 변형마다 흔든다. **0인 자리는 0으로 둔다** — 프로파일의 성격을 지우면
  // 350개를 구워도 전부 같은 웨이브가 된다. 검수의 "프로파일 분화"가 이걸 잡는다.
  const mix = base.map((v) => (v === 0 ? 0 : clamp(Math.round(v + (rnd() * 4 - 2)), 0, 9)));
  let sum = 0;
  for (let k = 0; k < UNIT_KINDS; k++) sum += mix[k];
  if (sum === 0) {
    // 성격이 가장 강한 자리를 되살린다. 적이 한 명도 안 나오는 판은 없어야 한다.
    let top = 0;
    for (let k = 1; k < UNIT_KINDS; k++) if (base[k] > base[top]) top = k;
    mix[top] = Math.max(1, base[top]);
  }

  // 난이도가 오르면 템포가 빨라진다. 이건 단조여야 한다 — 검수가 확인한다.
  const b = (POLICY[profile] || POLICY.BALANCED).tempo;
  const tempo = clamp(Math.round(b * (1 - difficulty * 0.11) + (rnd() * 160 - 80)), 420, 3000);

  return {
    id: `${profile}-${difficulty}-${variant}`,
    profile, difficulty,
    tags: tagsFor(profile, difficulty, variant),
    mix, tempo,
    src: 'offline',
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h >>> 0;
}

const SYSTEM = `너는 한 화면 레인 전투 게임의 웨이브 디자이너다.
플레이어는 왼쪽 기지에서 유닛을 소환하고, 너는 오른쪽(적) 사령관의 웨이브 구성을 설계한다.

유닛 여섯 종류 (mix 배열의 순서가 이것이다):
  0 검사    28금  가장 싸고 빠르다. 물량
  1 창병    40금  근접인데 사거리가 길다. 기병을 막는다
  2 궁수    44금  원거리. 근접에 약하다
  3 기병    62금  가장 빠르다. 파고들어 궁수·투석기를 썬다
  4 거인    92금  느리고 단단하다. 앞을 막는다
  5 투석기 120금  초장거리. 기지에 강하다. 매우 느리고 가장 비싸다

상성 (삼각형이 돈다. 하나로 전부를 이길 수 없다):
  창병 > 기병      기병 > 궁수·투석기      궁수 > 검사·거인      검사 > 창병

★ 이 게임의 숨은 규칙 — 이걸 모르면 구성이 통째로 무너진다:
  적은 뽑기로 정한 유닛을 못 사면 **가중치가 0이 아닌 것 중 가장 싼 것**으로 때운다.
  그래서 가중치 0 은 "덜 뽑는다"가 아니라 **"이 종류로 때우지도 않는다"**는 뜻이다.
  벽을 세우라는 판에 검사를 1이라도 남기면 실제 화면의 적 대부분이 검사가 된다.
  **네가 의도한 성향의 유닛이 "가중치가 있는 것 중 가장 싼 것"이 되게 짜라.**

너는 웨이브마다 세 가지를 정한다.
  mix    [검사, 창병, 궁수, 기병, 거인, 투석기] 가중치. 각 0~9 정수. 합이 0이면 안 된다
  tempo  소환 간격 ms. 420~3000. **비싼 구성일수록 길게, 싼 구성일수록 짧게**
  note   이 웨이브가 무슨 상황을 만들려는 것인지 한 문장(한국어, 40자 이내)

**절대 규칙**
1. 여섯 다 0인 mix 를 만들지 마라 — 적이 한 명도 안 나온다
2. tempo 는 420 밑으로 내려가면 화면이 유닛으로 막힌다. 그 밑으로 쓰지 마라
3. 난이도가 오르면 tempo 가 **줄어야** 한다 (더 자주 나온다)
4. **프로파일의 반대편으로 짜라.** 더 세게가 아니라 다르게다
5. 한 프로파일 안의 14개 변형은 서로 달라야 한다. 같은 mix 를 반복하지 마라
6. 프로파일의 성격은 유지해라 — 벽을 세우라고 했는데 거인이 0이면 안 된다

JSON 하나만 출력해라. 설명을 붙이지 마라.
{"chunks":[{"mix":[정수×6],"tempo":정수,"tags":["문자열"],"note":"문장"}, ... 정확히 14개]}`;

function userPrompt(profile, difficulty) {
  const p = POLICY[profile] || POLICY.BALANCED;
  const brand = UNIT_NAME[BRAND_UNIT[profile]];
  return `프로파일: ${profile}
난이도: ${difficulty} (0=가장 쉬움, 4=가장 어려움)
상대에 대한 판단: ${INTENT[profile]}
설계 기준 구성(참고): [${p.mix.join(', ')}]  기준 템포: ${p.tempo}ms
이 칸의 때움 유닛은 **${brand}**여야 한다 — ${brand}보다 싼 종류에는 가중치를 주지 마라.
위 판단의 **반대편으로** 웨이브 14개를 짜라. 쓸 수 있는 태그: ${TAG_POOL.join(', ')}`;
}

const LINES_SYSTEM = `너는 한 화면 레인 전투 게임의 연출 문구를 쓴다.
플레이어는 물이 차오르는 협곡에서 적 사령관과 싸우고, 지면 화면 가운데에 한 줄이 뜬다.
그 한 줄은 위로가 아니라 **원인 진단**이어야 한다 — 다음 판에 무엇을 바꿀지 알려주는 문장.
20자 이내, 한국어, 마침표 없이. 같은 말을 두 번 쓰지 마라.
JSON 하나만 출력해라: {"death":[문자열×28],"record":[문자열×4],"revive":[문자열×4]}`;

// LLM 이 무엇을 주든 **스키마에 맞게 강제한다.**
// 모델이 규칙을 어길 수 있다고 가정하고 짠다. 그게 방어다.
// 돌려주는 src 가 그 웨이브의 실제 출처다 — 여기가 흐려지면 전부가 거짓말이 된다.
function coerce(raw, profile, difficulty, variant) {
  const fb = authoredChunk(profile, difficulty, variant)
    || offlineChunk(profile, difficulty, variant);

  let src = 'llm';
  let mix = Array.isArray(raw && raw.mix) ? raw.mix : null;
  if (!mix || mix.length !== UNIT_KINDS) { mix = fb.mix; src = fb.src; }
  mix = mix.map((v) => clamp(Math.round(Number(v) || 0), 0, 9));
  let sum = 0;
  for (let k = 0; k < UNIT_KINDS; k++) sum += mix[k];
  if (sum === 0) { mix = fb.mix.slice(); src = fb.src; }

  // 때움 유닛 규칙만 강제한다 (위 주석 참고). 나머지 판단은 모델 것이다.
  const eb = enforceBrand(mix, profile);
  mix = eb.mix;

  let tempo = Math.round(Number(raw && raw.tempo));
  if (!Number.isFinite(tempo)) tempo = fb.tempo;
  tempo = clamp(tempo, 420, 3000);

  let tags = Array.isArray(raw && raw.tags) ? raw.tags.filter((t) => TAG_POOL.indexOf(t) >= 0) : [];
  if (tags.length === 0) tags = fb.tags;
  // 태그가 정책의 preferTags 와 하나도 안 겹치면 그 웨이브는 **선택될 수 없다.**
  // director.selectChunk() 가 태그로 먼저 거르기 때문이다. 겹치는 것을 하나 넣어 준다.
  const want = (POLICY[profile] || POLICY.BALANCED).preferTags;
  if (!tags.some((t) => want.indexOf(t) >= 0)) tags = tags.concat([want[0]]);

  const note = typeof (raw && raw.note) === 'string' && raw.note.trim()
    ? raw.note.trim().slice(0, 60) : fb.note;

  const out = {
    id: fb.id, profile, difficulty, tags, mix, tempo, src,
  };
  if (note) out.note = note;
  if (src === 'llm' && eb.repaired) out.repaired = true;
  return out;
}

// ─── 저술 연출 문구 ───────────────────────────────────────────
// Claude 가 직접 쓴 것이다. 죽은 이유를 이름 붙여 주는 문장만 남긴다 —
// "아쉽다" 같은 말은 다음 판을 바꾸지 못한다.
// ★ src/render.js 가 실제로 읽는 것은 death 하나뿐이다 (director.deathLine).
//   record·revive·commanderTaunt 는 아직 아무도 안 읽는다 — 아래 _unused 참고.
const AUTHORED_LINES = {
  death: [
    '기지가 무너졌다', '한 파도 늦었다', '아끼다 잠겼다', '병력이 모자랐다',
    '진화가 반 박자 늦었다', '물이 먼저 도착했다', '앞을 막을 것이 없었다',
    '금은 남았는데 시간이 없었다', '숫자로는 안 되는 상대였다', '벽이 필요했다',
    '해일을 아꼈어야 했다', '두 번은 못 막는다', '전선이 너무 멀었다',
    '물은 기다려주지 않는다', '경제만으로는 못 이긴다', '한 번 더 뽑을 수 있었다',
    '거인 하나가 부족했다', '궁수를 놓친 대가다', '여기까지가 오늘의 끝이다',
    '적이 먼저 시대를 넘었다', '창병을 세웠어야 했다', '기병이 뒤를 돌았다',
    '투석기가 기지를 갈았다', '포탑 하나면 달랐다', '화살비를 아꼈다',
    // ↓ 여기서부터 이번에 저술해 늘린 것. 전부 "한 종류만 뽑았다"의 변주다 —
    //   이 게임에서 지는 이유의 대부분이 거기 있기 때문이다.
    '같은 유닛만 뽑았다', '읽히는 손버릇이었다', '적이 답을 먼저 세웠다',
    '한 종류로는 삼각형을 못 이긴다', '앞줄이 먼저 비었다', '뒤가 비어 있었다',
    '벽만 세우다 시간을 잃었다', '전부 앞에 보냈다', '돈을 쓸 곳을 잘못 골랐다',
  ],
  record: ['적진을 넘었다', '전선이 뒤집혔다', '물보다 빨랐다', '읽히지 않았다'],
  revive: ['다시', '한 판 더', '이번엔 다르게', '이번엔 섞어서'],
  // 사령관별 추가 도발. **아직 아무도 안 읽는다.**
  // src/render.js 는 C.COMMANDER_TAUNT(사령관당 한 줄)를 쓰고 있다.
  // 데이터로 돌리려면 render.js 한 줄만 바꾸면 되지만 그 파일은 이 도구의 소유가
  // 아니다. config 의 첫 줄과 **겹치지 않는 추가분**만 담는다 — 충돌하지 않는다.
  commanderTaunt: [
    ['수는 줄지 않는다', '하나를 베면 둘이 온다', '세어 보긴 했나'],
    ['벌써 늦었다', '숨 돌릴 틈을 준 적 없다', '따라오기만 하는군'],
    ['네 지갑이 먼저 빈다', '나는 아직 시작도 안 했다', '모아 봐야 내 것이 더 크다'],
    ['서두르는 쪽이 진다', '벽은 지치지 않는다', '물이 네 편인 줄 아나'],
    ['네가 쓰는 것을 나도 쓴다', '거울은 늘 반 박자 빠르다', '또 그거군'],
  ],
  _unused: 'record · revive · commanderTaunt 는 현재 src 가 읽지 않는다. '
    + 'render.js 가 읽는 것은 death 뿐이다(director.deathLine).',
};

// ─── LLM 호출 ─────────────────────────────────────────────────
// 실패는 던진다. 조용히 성공한 척하지 않는다.
async function chat(system, user, temperature) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    response_format: { type: 'json_object' },
  };
  // 타임아웃이 없으면 한 칸에서 영원히 멈춘다. 25칸짜리 배치라 치명적이다.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) { /* 본문이 없어도 상태코드는 남는다 */ }
    throw new Error(`HTTP ${res.status} ${detail}`);
  }
  const j = await res.json();
  // choices 가 없거나 content 가 없는 응답은 실제로 온다 (필터·길이 초과).
  // 여기서 안 막으면 TypeError 가 나고 원인이 로그에 안 남는다.
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  const content = msg && typeof msg.content === 'string' ? msg.content : '';
  if (!content) throw new Error('빈 응답 (choices/content 없음)');
  return JSON.parse(content);
}

async function withRetry(label, fn) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt < RETRIES) {
        const wait = 600 * attempt;
        process.stdout.write(`재시도 ${attempt}/${RETRIES - 1} (${e.message}) `);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw last;
}

// 모델이 {chunks:[...]} 를 주는 게 정상이고, 배열 하나만 줄 수도 있다.
// 둘 다 받아준다 — 못 받으면 그 호출의 결과가 통째로 버려진다.
// (실제로 이 파일에 그 버그가 있었다: 프롬프트는 객체 하나를 요구하는데 코드가
//  raw.chunks 만 읽어서, 키를 넣고 구워도 모델 출력이 전부 버려지고 있었다.)
function asList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  for (const k of ['chunks', 'waves', 'data', 'items', 'result']) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  // {"0":{...},"1":{...}} 처럼 오는 경우도 있다.
  const vals = Object.values(raw).filter((v) => v && typeof v === 'object' && Array.isArray(v.mix));
  return vals.length ? vals : [];
}

// ─── 난이도 단조성 보정 ───────────────────────────────────────
// 칸마다 독립 호출이라 모델은 난이도 사이의 단조성을 보장하지 못한다.
// 저술본·자리표시자에서는 이미 단조라 아무 일도 안 일어난다(무동작이 정상이다).
function enforceMonotonic(chunks) {
  let fixed = 0;
  for (const p of PROFILES) {
    let prev = Infinity;
    for (const d of DIFFICULTIES) {
      const cell = chunks.filter((c) => c.profile === p && c.difficulty === d);
      if (!cell.length) continue;
      let s = 0;
      for (const c of cell) s += c.tempo;
      const avg = s / cell.length;
      if (avg > prev - 20) {
        const target = prev * 0.9;
        const k = target / avg;
        for (const c of cell) { c.tempo = clamp(Math.round(c.tempo * k), 420, 3000); c.tempoScaled = true; }
        let s2 = 0;
        for (const c of cell) s2 += c.tempo;
        prev = s2 / cell.length;
        fixed++;
      } else {
        prev = avg;
      }
    }
  }
  return fixed;
}

// ─── 실행 ─────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  if (OFFLINE && AUTHORED_ONLY) {
    console.error('--offline 과 --authored 는 같이 못 쓴다. 하나만 골라라.');
    process.exit(1);
  }

  const chunks = [];
  let generator;
  let lines = AUTHORED_LINES;
  let linesGen = 'authored:claude';
  let llmCells = 0, failCells = 0;

  if (OFFLINE) {
    generator = 'offline-placeholder';
    for (const p of PROFILES) {
      for (const d of DIFFICULTIES) {
        for (let v = 0; v < VARIANTS; v++) chunks.push(offlineChunk(p, d, v));
      }
    }
    console.log('오프라인 결정론 생성으로 ' + chunks.length + '개를 만들었다.');
    console.log('');
    console.log('  ⚠ 이건 LLM 산출물도 저술본도 아니다. 파이프라인·스키마·폴백 점검용 자리표시자다.');
    console.log('  ⚠ 제출본은 --authored 로 굽거나 실제 키로 다시 구워야 한다.');
    console.log('');
  } else if (AUTHORED_ONLY) {
    generator = 'authored:claude';
    for (const p of PROFILES) {
      for (const d of DIFFICULTIES) {
        for (let v = 0; v < VARIANTS; v++) {
          chunks.push(authoredChunk(p, d, v) || offlineChunk(p, d, v));
        }
      }
    }
    console.log('저술본 ' + AUTHORED.count() + '개를 tools/authored-waves.js 에서 읽었다.');
  } else if (!KEY) {
    // **조용히 폴백하지 않는다.** 키 없이 실전 베이크를 요청받았으면 그렇다고 말한다.
    console.error('OPENAI_API_KEY 가 없다. 실전 LLM 베이크를 할 수 없다.');
    console.error('');
    console.error('  제출본을 굽는다      : node tools/bake.js --authored');
    console.error('  파이프라인만 점검한다 : node tools/bake.js --offline');
    console.error('  실전 베이크          : OPENAI_API_KEY=... node tools/bake.js');
    process.exit(1);
  } else {
    generator = 'openai:' + MODEL;
    for (const p of PROFILES) {
      for (const d of DIFFICULTIES) {
        process.stdout.write(`베이크 ${p} 난이도 ${d} ... `);
        let list = null;
        try {
          // **빈 응답도 재시도 대상이다.** 스키마가 어긋난 응답 하나로 그 칸 14개를
          // 통째로 버리는 것보다, 같은 값으로 두 번 더 물어보는 쪽이 싸다.
          list = await withRetry(`${p}-${d}`, async () => {
            const raw = await chat(SYSTEM, userPrompt(p, d), 0.9);
            const l = asList(raw);
            if (l.length === 0) throw new Error('배열을 못 찾았다 (키: ' + Object.keys(raw || {}).join(',') + ')');
            return l;
          });
        } catch (e) {
          failCells++;
          console.log('실패 — 저술본으로 메운다: ' + e.message);
          for (let v = 0; v < VARIANTS; v++) {
            chunks.push(authoredChunk(p, d, v) || offlineChunk(p, d, v));
          }
          continue;
        }
        llmCells++;
        let used = 0;
        for (let v = 0; v < VARIANTS; v++) {
          const c = coerce(list[v], p, d, v);
          if (c.src === 'llm') used++;
          chunks.push(c);
        }
        console.log(`완료 (모델 ${used}/${VARIANTS})`);
      }
    }

    // 연출 문구도 같은 파이프라인을 탄다. 실패하면 저술본이고, 그렇다고 적는다.
    process.stdout.write('베이크 연출 문구 ... ');
    try {
      const raw = await withRetry('lines', () => chat(LINES_SYSTEM, '문구를 써라.', 1.0));
      const d = Array.isArray(raw && raw.death) ? raw.death.filter((s) => typeof s === 'string' && s.trim()) : [];
      if (d.length < 8) throw new Error('death 가 ' + d.length + '개뿐이다');
      lines = {
        death: d.map((s) => s.trim().slice(0, 40)),
        record: (Array.isArray(raw.record) ? raw.record : AUTHORED_LINES.record)
          .filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 40)),
        revive: (Array.isArray(raw.revive) ? raw.revive : AUTHORED_LINES.revive)
          .filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 40)),
        commanderTaunt: AUTHORED_LINES.commanderTaunt,
        _unused: AUTHORED_LINES._unused,
      };
      if (!lines.record.length) lines.record = AUTHORED_LINES.record;
      if (!lines.revive.length) lines.revive = AUTHORED_LINES.revive;
      linesGen = 'openai:' + MODEL;
      console.log('완료 (death ' + lines.death.length + '줄)');
    } catch (e) {
      console.log('실패 — 저술본을 쓴다: ' + e.message);
    }
  }

  const scaled = enforceMonotonic(chunks);
  if (scaled) console.log(`난이도 단조성 보정: ${scaled}칸의 템포를 낮췄다.`);

  // ── 출처 집계 — 여기서 나온 숫자가 곧 주장할 수 있는 범위다 ──
  const tally = { authored: 0, llm: 0, offline: 0 };
  let repaired = 0;
  for (const c of chunks) {
    tally[c.src] = (tally[c.src] || 0) + 1;
    if (c.repaired) repaired++;
  }
  // generator 문자열이 **실제 내용과 어긋나지 않게** 만든다.
  // 예전에는 25칸이 전부 실패해도 generator 가 'openai:...' 로 적혔다.
  if (tally.llm === 0 && generator.indexOf('openai') === 0) {
    generator = tally.authored >= tally.offline ? 'authored:claude' : 'offline-placeholder';
    console.log('모델 응답이 하나도 안 남았다 — generator 를 실제 내용에 맞춰 다시 적는다.');
  } else if (tally.llm > 0 && tally.llm < chunks.length) {
    generator = `openai:${MODEL}+fallback`;
  }

  const stamp = new Date().toISOString();
  write('chunks.json', {
    generator, bakedAt: stamp, version: 3,
    unitOrder: UNIT_NAME, unitKinds: UNIT_KINDS,
    provenance: {
      authored: tally.authored, llm: tally.llm, offline: tally.offline,
      brandRepaired: repaired, llmCells, failCells,
      // 사람이 읽는 한 줄. README·심사자료가 이 문장을 그대로 쓸 수 있어야 한다.
      summary: describe(tally, chunks.length),
    },
    cellIntent: AUTHORED.CELL_INTENT,
    chunks,
  });
  write('policy.json', {
    // ★ 정책표는 LLM 이 만든 것이 아니다. 저장소의 봇 계측·스윕으로 정해졌고
    //   src/director.js 의 BUILTIN_POLICY 와 같은 표다. 그래서 따로 적는다.
    generator: 'repo-measured (src/director.js BUILTIN_POLICY 와 동일)',
    bakedAt: stamp, version: 3,
    unitOrder: UNIT_NAME, unitKinds: UNIT_KINDS,
    counterMap: buildCounterMap(),
    policies: POLICY,
  });
  write('lines.json', Object.assign({ generator: linesGen, bakedAt: stamp, version: 3 }, lines));

  console.log('');
  console.log('  출처   ' + describe(tally, chunks.length));
  if (repaired) console.log(`  때움 규칙으로 고친 모델 웨이브 ${repaired}개 (검사/창병 가중치를 0으로 내렸다)`);
  console.log('');
  console.log('다음: node tools/verify-chunks.js');
}

function describe(t, total) {
  const parts = [];
  if (t.authored) parts.push(`저술 ${t.authored}`);
  if (t.llm) parts.push(`LLM ${t.llm}`);
  if (t.offline) parts.push(`자리표시자 ${t.offline}`);
  return parts.join(' · ') + ` / 총 ${total}`;
}

function write(name, obj) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 0) + '\n');
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  console.log('  data/' + name + '  ' + kb + 'KB');
}

main().catch((e) => { console.error(e); process.exit(2); });
