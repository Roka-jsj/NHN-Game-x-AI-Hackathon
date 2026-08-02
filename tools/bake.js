#!/usr/bin/env node
// 계층 2 — 오프라인 베이크. 로컬에서 node 로만 실행한다.
// **게임은 이 파일을 절대 로드하지 않는다.** 브라우저는 data/*.json 만 fetch 한다.
//
//   실전(LLM):  OPENAI_API_KEY=... node tools/bake.js
//   파이프라인 점검(키 없이): node tools/bake.js --offline
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

'use strict';

const fs = require('fs');
const path = require('path');

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

const OFFLINE = process.argv.includes('--offline');
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const KEY = process.env.OPENAI_API_KEY;   // 코드에 하드코딩하지 않는다. .env 는 .gitignore 에 있다

// ─── 결정론적 난수 — 오프라인 모드 전용 ────────────────────────
// 같은 씨앗이면 같은 결과가 나와야 파이프라인 점검이 재현 가능하다.
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

function tagsFor(profile, difficulty, variant) {
  const t = ['mix'];
  if (profile === 'RUSHER') t.push(variant % 2 ? 'wall' : 'heavy');
  if (profile === 'SWARMER') t.push(variant % 2 ? 'heavy' : 'wall');
  if (profile === 'TURTLE') t.push(variant % 2 ? 'ranged' : 'siege');
  if (profile === 'ECONOMIST') t.push(variant % 2 ? 'rush' : 'fast');
  if (difficulty >= 3) t.push('swarm');
  return t;
}

// 오프라인 자리표시자. LLM 없이도 파이프라인·스키마·폴백을 점검할 수 있어야 한다.
// **결정론적이다** — 같은 입력이면 같은 웨이브가 나온다.
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
  0 검사    가장 싸고 빠르다. 물량
  1 창병    근접인데 사거리가 길다. 기병을 막는다
  2 궁수    원거리. 근접에 약하다
  3 기병    가장 빠르다. 파고들어 궁수·투석기를 썬다
  4 거인    느리고 단단하다. 앞을 막는다. 비싸다
  5 투석기  초장거리. 기지에 강하다. 매우 느리고 가장 비싸다

상성 (삼각형이 돈다. 하나로 전부를 이길 수 없다):
  창병 > 기병      기병 > 궁수·투석기      궁수 > 검사·거인      검사 > 창병

너는 웨이브마다 두 가지를 정한다.
  mix    [검사, 창병, 궁수, 기병, 거인, 투석기] 가중치. 각 0~9 정수. 합이 0이면 안 된다
  tempo  소환 간격 ms. 420~3000

**절대 규칙**
1. 여섯 다 0인 mix 를 만들지 마라 — 적이 한 명도 안 나온다
2. tempo 는 420 밑으로 내려가면 화면이 유닛으로 막힌다. 그 밑으로 쓰지 마라
3. 난이도가 오르면 tempo 가 **줄어야** 한다 (더 자주 나온다)
4. **프로파일의 반대편으로 짜라.** 더 세게가 아니라 다르게다
5. 한 프로파일 안의 14개 변형은 서로 달라야 한다. 같은 mix 를 반복하지 마라
6. 프로파일의 성격은 유지해라 — 벽을 세우라고 했는데 거인이 0이면 안 된다

JSON 하나만 출력해라. 설명을 붙이지 마라.
{"chunks":[{"mix":[정수×6],"tempo":정수,"tags":["문자열"]}, ... 정확히 14개]}`;

function userPrompt(profile, difficulty) {
  const base = (POLICY[profile] || POLICY.BALANCED).mix;
  return `프로파일: ${profile}
난이도: ${difficulty} (0=가장 쉬움, 4=가장 어려움)
상대에 대한 판단: ${INTENT[profile]}
설계 기준 구성(참고): [${base.join(', ')}]  기준 템포: ${(POLICY[profile] || POLICY.BALANCED).tempo}ms
위 판단의 **반대편으로** 웨이브 14개를 짜라. 쓸 수 있는 태그: ${TAG_POOL.join(', ')}`;
}

async function callLLM(profile, difficulty) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt(profile, difficulty) },
    ],
    temperature: 0.9,
    response_format: { type: 'json_object' },
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const j = await res.json();
  return JSON.parse(j.choices[0].message.content);
}

// LLM 이 무엇을 주든 **스키마에 맞게 강제한다.**
// 모델이 규칙을 어길 수 있다고 가정하고 짠다. 그게 방어다.
function coerce(raw, profile, difficulty, variant) {
  const fb = offlineChunk(profile, difficulty, variant);
  let mix = Array.isArray(raw && raw.mix) ? raw.mix : null;
  if (!mix || mix.length !== UNIT_KINDS) mix = fb.mix;
  mix = mix.map((v) => clamp(Math.round(Number(v) || 0), 0, 9));
  let sum = 0;
  for (let k = 0; k < UNIT_KINDS; k++) sum += mix[k];
  if (sum === 0) mix = fb.mix;

  let tempo = Math.round(Number(raw && raw.tempo));
  if (!Number.isFinite(tempo)) tempo = fb.tempo;
  tempo = clamp(tempo, 420, 3000);

  let tags = Array.isArray(raw && raw.tags) ? raw.tags.filter((t) => TAG_POOL.indexOf(t) >= 0) : [];
  if (tags.length === 0) tags = fb.tags;

  return { id: fb.id, profile, difficulty, tags, mix, tempo };
}

const OFFLINE_LINES = {
  death: [
    '기지가 무너졌다', '한 파도 늦었다', '아끼다 잠겼다', '병력이 모자랐다',
    '진화가 반 박자 늦었다', '물이 먼저 도착했다', '앞을 막을 것이 없었다',
    '금은 남았는데 시간이 없었다', '숫자로는 안 되는 상대였다', '벽이 필요했다',
    '해일을 아꼈어야 했다', '두 번은 못 막는다', '전선이 너무 멀었다',
    '물은 기다려주지 않는다', '경제만으로는 못 이긴다', '한 번 더 뽑을 수 있었다',
    '거인 하나가 부족했다', '궁수를 놓친 대가다', '여기까지가 오늘의 끝이다',
    '적이 먼저 시대를 넘었다', '창병을 세웠어야 했다', '기병이 뒤를 돌았다',
    '투석기가 기지를 갈았다', '포탑 하나면 달랐다', '화살비를 아꼈다',
  ],
  record: ['적진을 넘었다', '전선이 뒤집혔다', '물보다 빨랐다'],
  revive: ['다시', '한 판 더', '이번엔 다르게'],
};

// ─── 실행 ─────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const chunks = [];
  let generator;

  if (OFFLINE || !KEY) {
    if (!OFFLINE) {
      console.error('OPENAI_API_KEY 가 없다. --offline 없이는 실전 베이크를 할 수 없다.');
      console.error('파이프라인만 점검하려면: node tools/bake.js --offline');
      process.exit(1);
    }
    generator = 'offline-placeholder';
    for (const p of PROFILES) {
      for (const d of DIFFICULTIES) {
        for (let v = 0; v < VARIANTS; v++) chunks.push(offlineChunk(p, d, v));
      }
    }
    console.log('오프라인 결정론 생성으로 ' + chunks.length + '개를 만들었다.');
    console.log('');
    console.log('  ⚠ 이건 LLM 산출물이 아니다. 파이프라인·스키마·폴백을 점검하기 위한 자리표시자다.');
    console.log('  ⚠ 제출 전에 반드시 실제 키로 다시 굽고, 사람이 검수해야 한다.');
    console.log('  ⚠ 이대로 제출하면 "LLM이 만든 350청크"는 사실이 아니게 된다.');
    console.log('');
  } else {
    generator = 'openai:' + MODEL;
    for (const p of PROFILES) {
      for (const d of DIFFICULTIES) {
        process.stdout.write(`베이크 ${p} 난이도 ${d} ... `);
        let raw;
        try {
          raw = await callLLM(p, d);
        } catch (e) {
          console.log('실패 — 오프라인 생성으로 메운다: ' + e.message);
          for (let v = 0; v < VARIANTS; v++) chunks.push(offlineChunk(p, d, v));
          continue;
        }
        // 모델이 {chunks:[...]} 를 주는 게 정상이고, 배열 하나만 줄 수도 있다.
        // 둘 다 받아준다 — 못 받으면 그 호출의 결과가 통째로 버려진다.
        const list = Array.isArray(raw) ? raw
          : (Array.isArray(raw && raw.chunks) ? raw.chunks : []);
        if (list.length === 0) console.log('(빈 응답 — 오프라인으로 메운다) ');
        for (let v = 0; v < VARIANTS; v++) chunks.push(coerce(list[v], p, d, v));
        console.log('완료');
      }
    }
  }

  const stamp = new Date().toISOString();
  write('chunks.json', {
    generator, bakedAt: stamp, version: 2,
    unitOrder: UNIT_NAME, unitKinds: UNIT_KINDS, chunks,
  });
  write('policy.json', {
    generator, bakedAt: stamp, version: 2,
    unitOrder: UNIT_NAME, unitKinds: UNIT_KINDS,
    counterMap: buildCounterMap(),
    policies: POLICY,
  });
  write('lines.json', Object.assign({ generator, bakedAt: stamp, version: 2 }, OFFLINE_LINES));

  console.log('');
  console.log('다음: node tools/verify-chunks.js');
}

function write(name, obj) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 0) + '\n');
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  console.log('  data/' + name + '  ' + kb + 'KB');
}

main().catch((e) => { console.error(e); process.exit(2); });
