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
//   data/chunks.json  5프로파일 × 5난이도 × 14변형 = 350
//   data/policy.json  프로파일 → 레버 매핑
//   data/lines.json   연출 문구 (사망 40 / 신기록 40 / 부활 40)

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data');

const PROFILES = ['RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER', 'BALANCED'];
const DIFFICULTIES = [0, 1, 2, 3, 4];
const VARIANTS = 14;
const CHUNK_ROWS = 6;

const LANES = 3;
const OB_NONE = 0, OB_LOW = 1, OB_BEAM = 2, OB_PILLAR = 3;

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
// 디렉터는 난이도를 올리는 시스템이 아니다. 성향의 반대편으로 판을 다시 짠다.
const INTENT = {
  // 프로파일마다 **반대편으로** 짠다. 더 세게가 아니다.
  RUSHER:    '쉬지 않고 병력을 쏟아붓는 상대다. 거인 비중을 높여 벽을 세우고 템포를 늦춰 소모를 강요해라.',
  TURTLE:    '금을 쌓고 나오지 않는 상대다. 궁수 비중을 높이고 템포를 빠르게 해 찔러서 끌어내라.',
  ECONOMIST: '병력보다 시대에 먼저 투자하는 상대다. 싼 유닛으로 템포를 최대한 빠르게 해 진화가 끝나기 전에 두들겨라.',
  SWARMER:   '싼 유닛만 끝없이 뽑는 상대다. 거인 비중을 높여 숫자를 무의미하게 만들어라.',
  BALANCED:  '치우침이 없는 상대다. 세 종류를 고르게 섞고 템포는 중간으로 둬라.',
};

const TAG_POOL = ['mix', 'wall', 'ranged', 'rush', 'heavy', 'swarm'];

function tagsFor(profile, difficulty, variant) {
  const t = ['mix'];
  if (profile === 'RUSHER' || profile === 'SWARMER') t.push(variant % 2 ? 'wall' : 'heavy');
  if (profile === 'TURTLE') t.push('ranged');
  if (profile === 'ECONOMIST') t.push('rush');
  if (difficulty >= 3) t.push('swarm');
  return t;
}

// 오프라인 자리표시자. LLM 없이도 파이프라인·스키마·폴백을 점검할 수 있어야 한다.
// **결정론적이다** — 같은 입력이면 같은 웨이브가 나온다.
function offlineChunk(profile, difficulty, variant) {
  const rnd = lcg(hash(profile) * 7919 + difficulty * 131 + variant * 17);
  let mix;
  switch (profile) {
    case 'RUSHER':    mix = [1, 2, 6]; break;
    case 'TURTLE':    mix = [2, 7, 1]; break;
    case 'ECONOMIST': mix = [6, 3, 1]; break;
    case 'SWARMER':   mix = [1, 3, 6]; break;
    default:          mix = [5, 3, 2]; break;
  }
  // 변형마다 ±2 흔든다. 0 밑으로는 안 내려간다.
  mix = mix.map((v) => clamp(Math.round(v + (rnd() * 4 - 2)), 0, 9));
  if (mix[0] + mix[1] + mix[2] === 0) mix[0] = 1;

  // 난이도가 오르면 템포가 빨라진다. 이건 단조여야 한다 — 검수가 확인한다.
  const base = profile === 'ECONOMIST' ? 900 : (profile === 'TURTLE' ? 1150 : 1700);
  const tempo = clamp(Math.round(base * (1 - difficulty * 0.11) + (rnd() * 160 - 80)), 420, 3000);

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

유닛 세 종류:
  0 검사  싸고 빠르다. 물량
  1 궁수  멀리서 때린다. 근접에 약하다
  2 거인  느리고 비싸고 단단하다. 앞을 막는다

너는 두 가지를 정한다.
  mix    [검사, 궁수, 거인] 가중치. 각 0~9 정수. 합이 0이면 안 된다
  tempo  소환 간격 ms. 420~3000

**절대 규칙**
1. 셋 다 0인 mix 를 만들지 마라 — 적이 아무것도 안 나온다
2. tempo 는 420 밑으로 내려가면 화면이 유닛으로 막힌다. 그 밑으로 쓰지 마라
3. 난이도가 오르면 tempo 가 **줄어야** 한다 (더 자주 나온다)
4. **프로파일의 반대편으로 짜라.** 더 세게가 아니라 다르게다

JSON 하나만 출력해라. 설명을 붙이지 마라.
{"mix":[정수,정수,정수],"tempo":정수,"tags":["문자열"]}`;

function userPrompt(profile, difficulty) {
  return `프로파일: ${profile}
난이도: ${difficulty} (0=가장 쉬움, 4=가장 어려움)
상대에 대한 판단: ${INTENT[profile]}
위 판단의 **반대편으로** 웨이브를 짜라.`;
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
  if (!mix || mix.length !== 3) mix = fb.mix;
  mix = mix.map((v) => clamp(Math.round(Number(v) || 0), 0, 9));
  if (mix[0] + mix[1] + mix[2] === 0) mix = fb.mix;

  let tempo = Math.round(Number(raw && raw.tempo));
  if (!Number.isFinite(tempo)) tempo = fb.tempo;
  tempo = clamp(tempo, 420, 3000);

  let tags = Array.isArray(raw && raw.tags) ? raw.tags.filter((t) => TAG_POOL.indexOf(t) >= 0) : [];
  if (tags.length === 0) tags = fb.tags;

  return { id: fb.id, profile, difficulty, tags, mix, tempo };
}

const POLICY = {
  RUSHER: {
    mix: [1, 2, 6], tempo: 1900, goldMul: 1.0, eraThresh: 1.0,
    waterMul: 0.9, draftSlant: 1, preferTags: ['wall', 'mix'],
  },
  TURTLE: {
    mix: [2, 7, 1], tempo: 1150, goldMul: 1.05, eraThresh: 1.0,
    waterMul: 1.35, draftSlant: 0, preferTags: ['ranged', 'mix'],
  },
  ECONOMIST: {
    mix: [6, 3, 1], tempo: 900, goldMul: 1.15, eraThresh: 0.8,
    waterMul: 1.0, draftSlant: 1, preferTags: ['rush', 'mix'],
  },
  SWARMER: {
    mix: [1, 3, 6], tempo: 1700, goldMul: 1.0, eraThresh: 0.9,
    waterMul: 1.0, draftSlant: 0, preferTags: ['heavy', 'mix'],
  },
  BALANCED: {
    mix: [5, 3, 2], tempo: 1400, goldMul: 1, eraThresh: 1,
    waterMul: 1, draftSlant: 2, preferTags: ['mix'],
  },
};

const OFFLINE_LINES = {
  death: [
    '기지가 무너졌다', '한 파도 늦었다', '아끼다 잠겼다', '병력이 모자랐다',
    '진화가 반 박자 늦었다', '물이 먼저 도착했다', '앞을 막을 것이 없었다',
    '금은 남았는데 시간이 없었다', '숫자로는 안 되는 상대였다', '벽이 필요했다',
    '해일을 아꼈어야 했다', '두 번은 못 막는다', '전선이 너무 멀었다',
    '물은 기다려주지 않는다', '경제만으로는 못 이긴다', '한 번 더 뽑을 수 있었다',
    '거인 하나가 부족했다', '궁수를 놓친 대가다', '여기까지가 오늘의 끝이다',
    '적이 먼저 시대를 넘었다',
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
        const list = Array.isArray(raw.chunks) ? raw.chunks : [];
        for (let v = 0; v < VARIANTS; v++) chunks.push(coerce(list[v], p, d, v));
        console.log('완료');
      }
    }
  }

  const stamp = new Date().toISOString();
  write('chunks.json', { generator, bakedAt: stamp, version: 1, chunks });
  write('policy.json', { generator, bakedAt: stamp, version: 1, policies: POLICY });
  write('lines.json', Object.assign({ generator, bakedAt: stamp, version: 1 }, OFFLINE_LINES));

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
