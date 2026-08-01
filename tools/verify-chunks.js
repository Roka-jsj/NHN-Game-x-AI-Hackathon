#!/usr/bin/env node
// 청크 검수 — 사람이 눈으로 350개를 볼 수는 없다. 볼 수 있게 줄여준다.
//
//   node tools/verify-chunks.js
//
// 보는 것:
//   1. 생성자 — LLM 산출물인가, 자리표시자인가  ← 제일 먼저 본다
//   2. 스키마 유효성
//   3. **통과 가능성** — 세 레인이 동시에 막힌 행이 없는가 (있으면 즉사 확정)
//   4. **반응 가능성** — 같은 레인에서 자세 요구가 너무 촘촘하지 않은가
//   5. 난이도 단조성 · 중복률

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHUNKS = path.join(ROOT, 'data', 'chunks.json');

const CHUNK_ROWS = 6;
const LANES = 3;
const OB_LOW = 1, OB_BEAM = 2, OB_PILLAR = 3;
// 점프 460ms · 행 간격 240 · 최고 속도 760 → 행 사이는 316ms.
// 같은 레인에서 자세 요구가 두 행 안에 붙으면 점프가 끝나기 전에 다음 것이 온다.
const MIN_ACTION_ROWS = 2;

if (!fs.existsSync(CHUNKS)) {
  console.error('data/chunks.json 이 없다. 먼저 node tools/bake.js --offline 을 돌려라.');
  process.exit(1);
}

const doc = JSON.parse(fs.readFileSync(CHUNKS, 'utf8'));
const list = doc.chunks || [];
let fatal = 0, warn = 0;

console.log('');
console.log('─── 청크 검수 ' + '─'.repeat(48));
console.log('  파일        data/chunks.json');
console.log('  생성자      ' + (doc.generator || '(없음)'));
console.log('  구운 시각   ' + (doc.bakedAt || '(없음)'));
console.log('  청크 수     ' + list.length + (list.length === 350 ? '  (5×5×14 = 350 충족)' : '  ← 350이 아니다'));
console.log('');

if (String(doc.generator || '').indexOf('placeholder') >= 0) {
  console.log('  ████ 경고 ████');
  console.log('  이 파일은 LLM 산출물이 아니라 오프라인 자리표시자다.');
  console.log('  파이프라인·스키마·폴백 점검용이며, 이대로 제출하면');
  console.log('  "LLM이 만든 350청크"는 사실이 아니게 된다.');
  console.log('  제출 전에 OPENAI_API_KEY 로 다시 굽고 사람이 검수해라.');
  console.log('');
  warn++;
}

// ── 스키마 · 통과 가능성 · 반응 가능성 ────────────────────────
let badSchema = 0, blockedAll = 0, tooTight = 0, coinOnObstacle = 0;
let obCount = 0, rowCount = 0;
const kindCount = [0, 0, 0, 0];

for (const c of list) {
  if (!c || !Array.isArray(c.steps) || c.steps.length !== CHUNK_ROWS) { badSchema++; continue; }
  const lastAction = [-9, -9, -9];
  for (let r = 0; r < c.steps.length; r++) {
    const st = c.steps[r];
    if (!Array.isArray(st) || st.length !== 6) { badSchema++; continue; }
    rowCount++;
    let blocked = 0;
    for (let l = 0; l < LANES; l++) {
      const v = st[l];
      if (!Number.isInteger(v) || v < 0 || v > 3) { badSchema++; continue; }
      kindCount[v]++;
      if (v !== 0) { blocked++; obCount++; }
      if (v === OB_LOW || v === OB_BEAM) {
        if (r - lastAction[l] < MIN_ACTION_ROWS) tooTight++;
        lastAction[l] = r;
      }
      const coin = st[3 + l];
      if (coin !== 0 && coin !== 1) badSchema++;
      if (coin === 1 && v !== 0) coinOnObstacle++;
    }
    if (blocked === LANES) blockedAll++;
  }
}

line('스키마 위반', badSchema, badSchema === 0);
line('세 레인 동시 차단 (즉사 확정)', blockedAll, blockedAll === 0);
line('자세 요구가 너무 촘촘 (반응 불가)', tooTight, tooTight === 0);
line('장애물 위에 코인', coinOnObstacle, coinOnObstacle === 0);
console.log('  행당 장애물   ' + (rowCount ? (obCount / rowCount).toFixed(2) : '0') + '개 (레인 3개 중)');
console.log('  장애물 분포   없음 ' + pct(kindCount[0]) + ' / 낮은벽 ' + pct(kindCount[1]) +
            ' / 높은빔 ' + pct(kindCount[2]) + ' / 기둥 ' + pct(kindCount[3]));
console.log('');

// ── 난이도 단조성 ────────────────────────────────────────────
console.log('  난이도 단조성 — 난이도가 오르면 행당 장애물이 늘어야 한다');
const profiles = [...new Set(list.map((c) => c.profile))];
let monoFail = 0;
for (const p of profiles) {
  const row = [];
  for (let d = 0; d <= 4; d++) {
    const sel = list.filter((c) => c.profile === p && c.difficulty === d);
    if (!sel.length) { row.push(null); continue; }
    let n = 0, rows = 0;
    for (const c of sel) for (const st of c.steps) { rows++; for (let l = 0; l < LANES; l++) if (st[l]) n++; }
    row.push(n / rows);
  }
  const parts = row.map((r) => (r === null ? '  — ' : r.toFixed(2).padStart(5)));
  let ok = true;
  for (let d = 1; d <= 4; d++) {
    if (row[d] === null || row[d - 1] === null) continue;
    if (row[d] < row[d - 1] - 0.05) ok = false;
  }
  if (!ok) monoFail++;
  console.log('    ' + p.padEnd(9) + parts.join('  ') + (ok ? '   ok' : '   ← 역전'));
}
if (monoFail) { console.log('    ' + monoFail + '개 프로파일에서 난이도 역전'); warn++; }
console.log('');

// ── 중복률 ───────────────────────────────────────────────────
const seen = new Map();
let dup = 0;
for (const c of list) {
  const key = JSON.stringify(c.steps);
  if (seen.has(key)) dup++; else seen.set(key, 1);
}
const dupRate = list.length ? (dup / list.length * 100) : 0;
line('완전 중복 청크', dup + '개 (' + dupRate.toFixed(1) + '%)', dupRate < 5);
if (dupRate >= 5) warn++;

console.log('');
console.log('─'.repeat(62));
if (badSchema > 0 || blockedAll > 0 || tooTight > 0) fatal++;
console.log(fatal ? '불통과 — 위 치명 항목을 고쳐야 한다'
                  : (warn ? '조건부 통과 — 경고 ' + warn + '건을 확인해라' : '통과'));
console.log('');
process.exit(fatal ? 1 : 0);

function line(label, value, ok) {
  console.log('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + String(label).padEnd(30) + value);
}
function pct(n) {
  const t = rowCount * LANES;
  return t ? (n / t * 100).toFixed(1) + '%' : '0%';
}
