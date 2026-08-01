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
const CHUNK_SIZE = 6;

const GAP_FLOOR = 130, GAP_CEIL = 390;
const THICK_MIN = 0.7, THICK_MAX = 1.4;
const F_BONUS = 1, F_CRUMBLE = 2, F_MOVING = 4;

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
function offlineChunk(profile, difficulty, variant) {
  // 씨앗은 프로파일 **인덱스**로 잡는다.
  // 처음에 profile.length 로 잡았다가 검수 스크립트에 걸렸다 —
  // PRECISE/ERRATIC(둘 다 7자), RECKLESS/BALANCED(둘 다 8자)가 같은 씨앗을 써서
  // 청크 12.3%가 완전 중복이었다. 이름 길이는 식별자가 아니다.
  const pi = PROFILES.indexOf(profile) + 1;
  const rnd = lcg(pi * 7919 + difficulty * 104729 + variant * 1299709);
  const bias = INTENT[profile].bias;

  // 난이도가 오르면 평균 간격이 늘고 두께가 얇아진다 (단조성 검수 대상)
  const baseGap = 150 + difficulty * 45;
  const spread = 60 + difficulty * 25;
  const thick = clamp(1.05 - difficulty * 0.07, THICK_MIN, THICK_MAX);

  const steps = [];
  let bonusPlaced = false;
  for (let i = 0; i < CHUNK_SIZE; i++) {
    // ramp / drop 변형은 리듬을 고정하되, 편향과 변형별 흔들림은 그대로 살린다.
    // 그러지 않으면 같은 프로파일·난이도의 ramp 들이 서로 똑같아진다.
    let g;
    const jitter = (rnd() * 2 - 1) * spread * 0.35;
    if (variant % 7 === 0) {
      g = baseGap - spread + (i / (CHUNK_SIZE - 1)) * spread * 2.4 + jitter;
    } else if (variant % 7 === 3) {
      g = baseGap + spread - (i / (CHUNK_SIZE - 1)) * spread * 2.4 + jitter;
    } else {
      g = baseGap + (rnd() * 2 - 1) * spread;
    }
    if (bias === 'far') g += 55;
    if (bias === 'near') g -= 40;
    g = clamp(Math.round(g), GAP_FLOOR, GAP_CEIL);

    let flags = 0;
    // 한 구간에 보너스는 0~1개
    if (!bonusPlaced && rnd() < 0.22) { flags |= F_BONUS; bonusPlaced = true; }
    // 부서지는 발판은 난이도 1부터, 이동 발판은 2부터
    if (difficulty >= 1 && rnd() < 0.10 + difficulty * 0.06) flags |= F_CRUMBLE;
    if (difficulty >= 2 && !(flags & F_CRUMBLE) && rnd() < 0.08 + difficulty * 0.05) flags |= F_MOVING;

    steps.push([g, Math.round(thick * 100) / 100, flags]);
  }

  return {
    id: profile + '-' + difficulty + '-' + String(variant).padStart(2, '0'),
    profile, difficulty,
    tags: tagsFor(profile, difficulty, variant),
    steps,
  };
}

// ─── LLM 베이크 ───────────────────────────────────────────────
const SYSTEM = `너는 세로 원버튼 아케이드 게임의 레벨 디자이너다.
게임: 플레이어는 좌우 벽의 발판을 번갈아 도약해 오른다. 아래에서 물이 차오른다.
누르는 시간이 도약 거리(90~420px)를 정하고, 조준점은 사인파로 진동한다.
착지 허용폭은 20px 안팎이다. 정확히 겨누려면 오래 눌러야 하는데, 그동안 물이 오른다.

너의 일: 발판 6개짜리 "구간(청크)"을 설계한다.
각 발판은 [간격, 두께배수, 플래그] 세 값이다.
  간격     130~390 (정수). 직전 발판에서 이 발판까지의 세로 거리
  두께배수 0.7~1.4. 작을수록 착지가 어렵다
  플래그   비트필드. 0=보통, 1=보너스(앰버), 2=부서짐, 4=이동
           부서짐과 이동을 동시에 주지 마라 (읽을 수 없어진다)
           보너스는 한 구간에 최대 1개

반드시 JSON 만 출력한다. 설명 문장을 붙이지 마라.`;

function userPrompt(profile, difficulty) {
  return `프로파일 ${profile} — ${INTENT[profile].note}
난이도 ${difficulty} (0이 가장 쉽고 4가 가장 어렵다)

이 프로파일과 난이도에 맞는 서로 다른 청크 ${VARIANTS}개를 만들어라.
${VARIANTS}개가 서로 확실히 달라야 한다 — 간격 분포, 리듬, 플래그 배치가 겹치지 않게.

출력 형식:
{"chunks":[{"tags":["far"],"steps":[[간격,두께,플래그], ... 6개]}, ... ${VARIANTS}개]}`;
}

async function callLLM(profile, difficulty) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + KEY,
    },
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
  const text = body.choices[0].message.content;
  return JSON.parse(text);
}

// LLM 이 스펙을 벗어난 값을 주는 건 정상이다. 사람이 손으로 고치지 말고 여기서 강제한다.
function coerce(raw, profile, difficulty, variant) {
  const steps = [];
  const src = Array.isArray(raw && raw.steps) ? raw.steps : [];
  let bonusPlaced = false;
  for (let i = 0; i < CHUNK_SIZE; i++) {
    const st = Array.isArray(src[i]) ? src[i] : [];
    const g = clamp(Math.round(Number(st[0]) || 200), GAP_FLOOR, GAP_CEIL);
    const th = clamp(Math.round((Number(st[1]) || 1) * 100) / 100, THICK_MIN, THICK_MAX);
    let f = Number(st[2]) || 0;
    f = f & (F_BONUS | F_CRUMBLE | F_MOVING);
    if ((f & F_CRUMBLE) && (f & F_MOVING)) f &= ~F_MOVING;
    if (f & F_BONUS) { if (bonusPlaced) f &= ~F_BONUS; else bonusPlaced = true; }
    steps.push([g, th, f]);
  }
  const tags = Array.isArray(raw && raw.tags) && raw.tags.length
    ? raw.tags.filter((t) => typeof t === 'string').slice(0, 4)
    : tagsFor(profile, difficulty, variant);
  return {
    id: profile + '-' + difficulty + '-' + String(variant).padStart(2, '0'),
    profile, difficulty, tags, steps,
  };
}

// ─── 정책 · 문구 ──────────────────────────────────────────────
const POLICY = {
  policies: {
    SAFE:     { gapProfile: [1.6, 1.0, 0.95], platformThickness: [1, 1, 1],
                waterSpeed: 26, aimWobble: 1, bonusPlacement: 'far', coyoteFrames: 5,
                preferTags: ['far', 'mix'], note: INTENT.SAFE.note },
    RECKLESS: { gapProfile: [1.0, 1.0, 1.0], platformThickness: [1, 1, 0.7],
                waterSpeed: 22, aimWobble: 1, bonusPlacement: 'near', coyoteFrames: 5,
                preferTags: ['near', 'mix'], note: INTENT.RECKLESS.note },
    PRECISE:  { gapProfile: [1.0, 1.05, 1.1], platformThickness: [0.75, 0.75, 0.75],
                waterSpeed: 27.5, aimWobble: 1.4, bonusPlacement: 'far', coyoteFrames: 5,
                preferTags: ['far', 'ramp'], note: INTENT.PRECISE.note },
    ERRATIC:  { gapProfile: [0.9, 0.9, 0.85], platformThickness: [1.35, 1.35, 1.35],
                waterSpeed: 18, aimWobble: 0.5, bonusPlacement: 'near', coyoteFrames: 8,
                preferTags: ['near'], note: INTENT.ERRATIC.note },
    BALANCED: { gapProfile: [1, 1, 1], platformThickness: [1, 1, 1],
                waterSpeed: 22, aimWobble: 1, bonusPlacement: 'mid', coyoteFrames: 5,
                preferTags: ['mix'], note: INTENT.BALANCED.note },
  },
};

const OFFLINE_LINES = {
  death: [
    '물이 이겼다', '한 뼘 모자랐다', '재는 동안 차올랐다', '조금만 짧게 눌렀다면',
    '겨누다 잠겼다', '손끝이 늦었다', '거리가 아니라 순간을 놓쳤다', '진동을 못 읽었다',
    '멀리 보다 발밑을 놓쳤다', '차오르는 쪽이 빨랐다', '한 번 더 눌렀어야 했다',
    '정확했지만 느렸다', '빨랐지만 거칠었다', '발판이 먼저 무너졌다', '벽이 비어 있었다',
    '조준선이 길었다', '조준선이 짧았다', '물은 기다려주지 않는다', '숨을 고를 곳이 없었다',
    '높이는 남았는데 시간이 없었다',
  ],
  record: [
    '선을 넘었다', '어제의 나를 지웠다', '기록이 갱신됐다', '여기가 새 바닥이다',
    '점선을 통과했다', '더 위가 보인다', '한 칸 더 올라섰다', '방금이 최고다',
  ],
  revive: ['다시', '한 번 더', '이번엔 짧게', '이번엔 길게', '진동을 읽어라'],
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
