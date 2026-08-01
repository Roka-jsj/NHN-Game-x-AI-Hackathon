#!/usr/bin/env node
// 웨이브 검수 — 사람이 눈으로 350개를 볼 수는 없다. 볼 수 있게 줄여준다.
//
//   node tools/verify-chunks.js
//
// 보는 것:
//   1. 생성자 — LLM 산출물인가, 자리표시자인가  ← 제일 먼저 본다
//   2. 스키마 유효성
//   3. **적이 나오기는 하는가** — mix 가 셋 다 0이면 적이 한 명도 안 나온다
//   4. **화면이 막히지 않는가** — tempo 가 너무 짧으면 유닛이 화면을 덮는다
//   5. 난이도 단조성 · 프로파일 분화 · 중복률
//
// 러너에서 배운 것을 그대로 가져온다: **치명 항목은 게임을 못 하게 만드는 것만**이다.
// "밸런스가 이상하다"는 치명이 아니다. "적이 안 나온다"는 치명이다.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHUNKS = path.join(ROOT, 'data', 'chunks.json');

const TEMPO_MIN = 420;    // 이보다 짧으면 유닛이 화면을 덮는다
const TEMPO_MAX = 3000;   // 이보다 길면 아무 일도 안 일어난다

if (!fs.existsSync(CHUNKS)) {
  console.error('data/chunks.json 이 없다. 먼저 node tools/bake.js --offline 을 돌려라.');
  process.exit(1);
}

const doc = JSON.parse(fs.readFileSync(CHUNKS, 'utf8'));
const list = doc.chunks || [];
let fatal = 0, warn = 0;

console.log('');
console.log('─── 웨이브 검수 ' + '─'.repeat(46));
console.log('  파일        data/chunks.json');
console.log('  생성자      ' + (doc.generator || '(없음)'));
console.log('  구운 시각   ' + (doc.bakedAt || '(없음)'));
console.log('  웨이브 수   ' + list.length + (list.length === 350 ? '  (5×5×14 = 350 충족)' : '  ← 350이 아니다'));
console.log('');

if (String(doc.generator || '').indexOf('placeholder') >= 0) {
  console.log('  ████ 경고 ████');
  console.log('  이 파일은 LLM 산출물이 아니라 오프라인 자리표시자다.');
  console.log('  파이프라인·스키마·폴백 점검용이며, 이대로 제출하면');
  console.log('  "LLM이 만든 350웨이브"는 사실이 아니게 된다.');
  console.log('  제출 전에 OPENAI_API_KEY 로 다시 굽고 사람이 검수해라.');
  console.log('');
  warn++;
}

// ── 스키마 · 적이 나오는가 · 화면이 막히지 않는가 ──────────────
let badSchema = 0, emptyMix = 0, tooFast = 0, tooSlow = 0;
const mixSum = [0, 0, 0];
let tempoSum = 0, n = 0;

for (const c of list) {
  if (!c || typeof c.profile !== 'string') { badSchema++; continue; }
  if (!Number.isInteger(c.difficulty) || c.difficulty < 0 || c.difficulty > 4) { badSchema++; continue; }
  if (!Array.isArray(c.mix) || c.mix.length !== 3) { badSchema++; continue; }
  let bad = false;
  for (let k = 0; k < 3; k++) {
    const v = c.mix[k];
    if (!Number.isInteger(v) || v < 0 || v > 9) { bad = true; break; }
  }
  if (bad) { badSchema++; continue; }
  if (typeof c.tempo !== 'number' || !Number.isFinite(c.tempo)) { badSchema++; continue; }

  n++;
  if (c.mix[0] + c.mix[1] + c.mix[2] === 0) emptyMix++;
  if (c.tempo < TEMPO_MIN) tooFast++;
  if (c.tempo > TEMPO_MAX) tooSlow++;
  for (let k = 0; k < 3; k++) mixSum[k] += c.mix[k];
  tempoSum += c.tempo;
}

line('스키마 위반', badSchema, badSchema === 0);
line('적이 한 명도 안 나옴 (mix 전부 0)', emptyMix, emptyMix === 0);
line('간격이 너무 짧음 (화면이 막힌다)', tooFast, tooFast === 0);
line('간격이 너무 김 (아무 일도 안 일어난다)', tooSlow, tooSlow === 0);
const tot = mixSum[0] + mixSum[1] + mixSum[2];
console.log('  평균 구성    검사 ' + pct(mixSum[0], tot) + ' / 궁수 ' + pct(mixSum[1], tot) +
            ' / 거인 ' + pct(mixSum[2], tot));
console.log('  평균 간격    ' + (n ? Math.round(tempoSum / n) : 0) + 'ms');
console.log('');

// ── 난이도 단조성 ────────────────────────────────────────────
console.log('  난이도 단조성 — 난이도가 오르면 간격이 짧아져야 한다 (더 자주 나온다)');
const profiles = [...new Set(list.map((c) => c.profile))];
let monoFail = 0;
for (const p of profiles) {
  const row = [];
  for (let d = 0; d <= 4; d++) {
    const sel = list.filter((c) => c.profile === p && c.difficulty === d);
    if (!sel.length) { row.push(null); continue; }
    let s = 0;
    for (const c of sel) s += c.tempo;
    row.push(s / sel.length);
  }
  const parts = row.map((r) => (r === null ? '   — ' : String(Math.round(r)).padStart(5)));
  let ok = true;
  for (let d = 1; d <= 4; d++) {
    if (row[d] === null || row[d - 1] === null) continue;
    if (row[d] > row[d - 1] + 40) ok = false;
  }
  if (!ok) monoFail++;
  console.log('    ' + p.padEnd(10) + parts.join('  ') + (ok ? '   ok' : '   ← 역전'));
}
if (monoFail) { console.log('    ' + monoFail + '개 프로파일에서 난이도 역전'); warn++; }
console.log('');

// ── 프로파일별 성향이 실제로 갈리는가 ────────────────────────
// 이게 없으면 350개를 구워도 전부 같은 웨이브다.
console.log('  프로파일별 구성 — 서로 달라야 디렉터가 의미를 갖는다');
const sig = new Map();
for (const p of profiles) {
  const sel = list.filter((c) => c.profile === p);
  let a = 0, b = 0, cc = 0;
  for (const c of sel) { a += c.mix[0]; b += c.mix[1]; cc += c.mix[2]; }
  const t = a + b + cc || 1;
  sig.set(p, [Math.round(a / t * 10), Math.round(b / t * 10), Math.round(cc / t * 10)].join(','));
  console.log('    ' + p.padEnd(10) + '검 ' + pct(a, t) + '  궁 ' + pct(b, t) + '  거 ' + pct(cc, t));
}
const distinct = new Set(sig.values()).size;
line('서로 다른 구성 분포', distinct + '종 / ' + profiles.length + '개 프로파일', distinct >= 3);
if (distinct < 3) warn++;
console.log('');

// ── 중복률 ───────────────────────────────────────────────────
const seen = new Map();
let dup = 0;
for (const c of list) {
  const key = c.mix.join(',') + '|' + c.tempo;
  if (seen.has(key)) dup++; else seen.set(key, 1);
}
const dupRate = list.length ? (dup / list.length * 100) : 0;
line('완전 중복 웨이브', dup + '개 (' + dupRate.toFixed(1) + '%)', dupRate < 25);
if (dupRate >= 25) warn++;

console.log('');
console.log('─'.repeat(62));
if (badSchema > 0 || emptyMix > 0 || tooFast > 0) fatal++;
console.log(fatal ? '불통과 — 위 치명 항목을 고쳐야 한다'
                  : (warn ? '조건부 통과 — 경고 ' + warn + '건을 확인해라' : '통과'));
console.log('');
process.exit(fatal ? 1 : 0);

function line(label, value, ok) {
  console.log('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + String(label).padEnd(34) + value);
}
function pct(v, t) { return t ? (v / t * 100).toFixed(1) + '%' : '0%'; }
