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

const PROFILES = ['SAFE', 'RECKLESS', 'PRECISE', 'ERRATIC', 'BALANCED'];
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
  SAFE:     { bias: 'far',  note: '안전지대를 걷어내 도박을 강요한다' },
  RECKLESS: { bias: 'near', note: '절제에 보상, 무모함에 벌' },
  PRECISE:  { bias: 'far',  note: '실력에 걸맞은 압력' },
  ERRATIC:  { bias: 'near', note: '손에 익을 시간을 준다' },
  BALANCED: { bias: 'mix',  note: '압박과 완화를 교대한다' },
};

function tagsFor(profile, difficulty, variant) {
  const t = [];
  const bias = INTENT[profile].bias;
  t.push(bias === 'mix' ? 'mix' : bias);
  if (variant % 7 === 0) t.push('ramp');
  if (variant % 7 === 3) t.push('drop');
  if (difficulty >= 3) t.push('tight');
  return t;
}

// ─── 오프라인 청크 생성 ───────────────────────────────────────
// 각 행은 [장애물 3레인, 코인 3레인]. 장애물 0=없음 1=낮은벽 2=높은빔 3=기둥.
// **세 레인이 동시에 막힌 행은 만들지 않는다.** 만들면 어떻게 해도 못 지나간다.
function offlineChunk(profile, difficulty, variant) {
  // 씨앗은 프로파일 **인덱스**로 잡는다. 이름 길이는 식별자가 아니다 —
  // 처음에 profile.length 로 잡았다가 이름 길이가 같은 프로파일끼리 청크가 겹쳤다.
  const pi = PROFILES.indexOf(profile) + 1;
  const rnd = lcg(pi * 7919 + difficulty * 104729 + variant * 1299709);
  const bias = INTENT[profile].bias;

  // 난이도가 오르면 장애물이 늘고 코인이 위험한 자리로 간다
  const obChance = 0.30 + difficulty * 0.13;
  const steps = [];
  const lastAction = [-9, -9, -9];   // 레인별 마지막 자세 요구 행

  for (let r = 0; r < CHUNK_ROWS; r++) {
    const ob = [0, 0, 0];
    for (let l = 0; l < LANES; l++) {
      if (rnd() > obChance) continue;
      let kind = rnd();
      let v;
      if (kind < 0.40) v = OB_LOW;
      else if (kind < 0.70) v = OB_BEAM;
      else v = OB_PILLAR;
      // 같은 레인에서 자세 요구가 너무 촘촘하면 넘을 시간이 없다
      if ((v === OB_LOW || v === OB_BEAM) && r - lastAction[l] < 2) v = OB_PILLAR;
      ob[l] = v;
      if (v === OB_LOW || v === OB_BEAM) lastAction[l] = r;
    }
    // 세 레인 동시 차단 금지
    if (ob[0] && ob[1] && ob[2]) ob[(r + variant) % 3] = 0;
    // 편향 — 겁쟁이에겐 중앙을, 도박꾼에겐 바깥을 막는다
    if (bias === 'center' && !ob[1] && (ob[0] || ob[2])) {
      const src = ob[0] ? 0 : 2;
      ob[1] = ob[src]; ob[src] = 0;
    }

    const coin = [0, 0, 0];
    if (rnd() < 0.55) {
      // 빈 레인 중 하나에 코인. 위험 편향이면 장애물 옆 레인을 고른다
      const free = [];
      for (let l = 0; l < LANES; l++) if (!ob[l]) free.push(l);
      if (free.length) {
        let pick = free[(rnd() * free.length) | 0];
        if (bias === 'far') {
          for (const l of free) { if (l === 0 || l === 2) { pick = l; break; } }
        }
        coin[pick] = 1;
      }
    }
    steps.push([ob[0], ob[1], ob[2], coin[0], coin[1], coin[2]]);
  }

  return {
    id: profile + '-' + difficulty + '-' + String(variant).padStart(2, '0'),
    profile, difficulty,
    tags: tagsFor(profile, difficulty, variant),
    steps,
  };
}

// ─── LLM 베이크 ───────────────────────────────────────────────
const SYSTEM = `너는 3레인 엔들리스 러너의 레벨 디자이너다.
게임: 플레이어가 3개 레인을 달린다. 좌/우로 레인을 옮기고, 위로 점프, 아래로 슬라이드한다.
뒤에서 물이 차오르며 추격한다. 부딪히면 비틀거리고 그 사이 물이 붙는다. 두 번이면 죽는다.

장애물 세 종류가 가위바위보처럼 맞물린다. 하나로 둘을 넘을 수 없다.
  1 낮은 벽  → 점프로만 넘는다
  2 높은 빔  → 슬라이드로만 지난다
  3 기둥     → 레인을 바꾸는 수밖에 없다

너의 일: 행 6개짜리 "구간(청크)"을 설계한다.
각 행은 [장애물0, 장애물1, 장애물2, 코인0, 코인1, 코인2] 여섯 값이다.
장애물은 0~3, 코인은 0 또는 1이다. 레인 순서는 왼쪽·가운데·오른쪽이다.

반드시 지켜야 할 두 가지:
  - **세 레인을 동시에 막지 마라.** 그러면 어떻게 해도 못 지나간다
  - 같은 레인에서 점프·슬라이드를 요구하는 장애물을 두 행 이내에 연달아 두지 마라.
    점프가 끝나기 전에 다음 것이 도착해 넘을 시간이 없다

코인은 위험한 레인 옆에 두면 유혹이 되고, 안전한 레인에 두면 보상이 된다.

반드시 JSON 만 출력한다. 설명 문장을 붙이지 마라.`;

function userPrompt(profile, difficulty) {
  return `프로파일 ${profile} — ${INTENT[profile].note}
난이도 ${difficulty} (0이 가장 쉽고 4가 가장 어렵다)

이 프로파일과 난이도에 맞는 서로 다른 청크 ${VARIANTS}개를 만들어라.
${VARIANTS}개가 서로 확실히 달라야 한다 — 장애물 종류 분포, 레인 배치, 코인 위치가 겹치지 않게.

출력 형식:
{"chunks":[{"tags":["mix"],"steps":[[0,1,0,0,0,1], ... 6개]}, ... ${VARIANTS}개]}`;
}

async function callLLM(profile, difficulty) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(profile, difficulty) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return JSON.parse(body.choices[0].message.content);
}

// LLM 이 스펙을 벗어난 값을 주는 건 정상이다.
// 사람이 손으로 고치지 말고 여기서 강제한다. 규칙은 데이터가 아니라 코드가 지킨다.
function coerce(raw, profile, difficulty, variant) {
  const steps = [];
  const src = Array.isArray(raw && raw.steps) ? raw.steps : [];
  const lastAction = [-9, -9, -9];
  for (let r = 0; r < CHUNK_ROWS; r++) {
    const st = Array.isArray(src[r]) ? src[r] : [];
    const ob = [0, 0, 0], coin = [0, 0, 0];
    for (let l = 0; l < LANES; l++) {
      let v = Math.round(Number(st[l]) || 0);
      if (v < 0 || v > 3) v = 0;
      if ((v === OB_LOW || v === OB_BEAM) && r - lastAction[l] < 2) v = OB_PILLAR;
      ob[l] = v;
      if (v === OB_LOW || v === OB_BEAM) lastAction[l] = r;
      coin[l] = Number(st[3 + l]) ? 1 : 0;
    }
    if (ob[0] && ob[1] && ob[2]) ob[(r + variant) % 3] = 0;
    for (let l = 0; l < LANES; l++) if (ob[l]) coin[l] = 0;
    steps.push([ob[0], ob[1], ob[2], coin[0], coin[1], coin[2]]);
  }
  const tags = Array.isArray(raw && raw.tags) && raw.tags.length
    ? raw.tags.filter((t) => typeof t === 'string').slice(0, 4)
    : tagsFor(profile, difficulty, variant);
  return { id: profile + '-' + difficulty + '-' + String(variant).padStart(2, '0'),
           profile, difficulty, tags, steps };
}

// ─── 정책 · 문구 ──────────────────────────────────────────────
const POLICY = {
  policies: {
    SAFE:     { lanePressure: [0.7, 1.8, 0.7], density: 1.0, coinTemptation: 'risky',
                waterMul: 1.18, telegraph: 1.0, draftSlant: 0,
                preferTags: ['center', 'mix'], note: INTENT.SAFE.note },
    RECKLESS: { lanePressure: [1.2, 0.6, 1.2], density: 1.1, coinTemptation: 'safe',
                waterMul: 1.0, telegraph: 0.9, draftSlant: 1,
                preferTags: ['side', 'mix'], note: INTENT.RECKLESS.note },
    PRECISE:  { lanePressure: [1, 1, 1], density: 1.35, coinTemptation: 'risky',
                waterMul: 1.25, telegraph: 0.75, draftSlant: 0,
                preferTags: ['dense', 'mix'], note: INTENT.PRECISE.note },
    ERRATIC:  { lanePressure: [1, 1, 1], density: 0.65, coinTemptation: 'safe',
                waterMul: 0.8, telegraph: 1.4, draftSlant: 1,
                preferTags: ['sparse'], note: INTENT.ERRATIC.note },
    BALANCED: { lanePressure: [1, 1, 1], density: 1, coinTemptation: 'mid',
                waterMul: 1, telegraph: 1, draftSlant: 2,
                preferTags: ['mix'], note: INTENT.BALANCED.note },
  },
};

const OFFLINE_LINES = {
  death: [
    '물이 이겼다', '한 걸음 늦었다', '욕심이 발을 잡았다', '코인 하나가 비쌌다',
    '레인을 늦게 바꿨다', '숙였어야 했다', '뛰었어야 했다', '두 번은 못 버틴다',
    '뒤를 볼 여유가 없었다', '계단에서 리듬을 놓쳤다', '가운데가 안전하지 않았다',
    '멀리 보다 발밑을 놓쳤다', '한 번 더 갈 수 있었다', '물은 기다려주지 않는다',
    '속도가 실력을 앞질렀다', '고른 특성이 안 맞았다', '비틀거린 게 전부였다',
    '한 칸만 옆이었으면', '반응이 반 박자 늦었다', '여기까지가 오늘의 끝이다',
  ],
  record: [
    '선을 넘었다', '어제의 나를 지웠다', '기록이 갱신됐다', '여기가 새 바닥이다',
    '더 앞이 보인다', '한 구간 더 갔다', '방금이 최고다', '물을 따돌렸다',
  ],
  revive: ['다시', '한 번 더', '이번엔 오른쪽', '이번엔 안 먹는다', '리듬을 세라'],
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
  write('policy.json', Object.assign({ generator, bakedAt: stamp, version: 1 }, POLICY));
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
