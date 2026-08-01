#!/usr/bin/env node
// 청크 검수 — 사람이 눈으로 350개를 볼 수는 없다. 볼 수 있게 줄여준다.
//
//   node tools/verify-chunks.js
//
// 보는 것:
//   1. 생성자 — LLM 산출물인가, 자리표시자인가  ← 제일 먼저 본다
//   2. 스키마 유효성
//   3. 도달 가능성 — 간격이 도약 범위 안인가
//   4. 난이도 단조성 — 난이도가 오르면 실제로 어려워지는가
//   5. 중복률 — LLM 이 같은 걸 14번 뱉지 않았는가

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHUNKS = path.join(ROOT, 'data', 'chunks.json');

const CHUNK_SIZE = 6;
const GAP_FLOOR = 130, GAP_CEIL = 390;
const THICK_MIN = 0.7, THICK_MAX = 1.4;
const LEAP_MIN = 90, LEAP_MAX = 420;
// 최소 차지 80ms 가 강제되므로 실제로 낼 수 있는 가장 짧은 도약은 90px 가 아니다.
const CHARGE_MIN_MS = 80, CHARGE_MAX_MS = 900;
const LEAP_REACH_MIN = LEAP_MIN + (LEAP_MAX - LEAP_MIN) * (CHARGE_MIN_MS / CHARGE_MAX_MS);
const PLAYER_R = 14, PLAT_TH = 12;
const F_BONUS = 1, F_CRUMBLE = 2, F_MOVING = 4;

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

// ── 1. 생성자 ────────────────────────────────────────────────
if (String(doc.generator || '').indexOf('placeholder') >= 0) {
  console.log('  ████ 경고 ████');
  console.log('  이 파일은 LLM 산출물이 아니라 오프라인 자리표시자다.');
  console.log('  파이프라인·스키마·폴백 점검용이며, 이대로 제출하면');
  console.log('  "LLM이 만든 350청크"는 사실이 아니게 된다.');
  console.log('  제출 전에 OPENAI_API_KEY 로 다시 굽고 사람이 검수해라.');
  console.log('');
  warn++;
}

// ── 2·3. 스키마와 도달 가능성 ────────────────────────────────
let badSchema = 0, tooFar = 0, tooNear = 0, bonusOver = 0, bothFlags = 0;
let minGap = Infinity, maxGap = -Infinity;

for (const c of list) {
  if (!c || !Array.isArray(c.steps) || c.steps.length !== CHUNK_SIZE) { badSchema++; continue; }
  let bonuses = 0;
  for (const st of c.steps) {
    if (!Array.isArray(st) || st.length !== 3) { badSchema++; continue; }
    const [g, th, f] = st;
    if (typeof g !== 'number' || g < GAP_FLOOR || g > GAP_CEIL) badSchema++;
    if (typeof th !== 'number' || th < THICK_MIN || th > THICK_MAX) badSchema++;
    if (!Number.isInteger(f) || f < 0 || f > 7) badSchema++;
    if (g < minGap) minGap = g;
    if (g > maxGap) maxGap = g;

    // 도달 가능성. 플레이어는 발판 중심에서 허용폭만큼 아래에 붙을 수 있고,
    // 그러면 다음 발판까지의 실제 거리가 그만큼 늘어난다.
    // 그래서 여유를 "빼야" 한다. 더해주면 도달 불가능한 구간을 통과시킨다.
    const tol = PLAT_TH * th * 0.5 + PLAYER_R;
    if (g > LEAP_MAX - tol) tooFar++;
    // 최소 도약보다 짧은 간격은 어떻게 눌러도 넘어간다
    if (g < LEAP_REACH_MIN - tol) tooNear++;

    if (f & F_BONUS) bonuses++;
    if ((f & F_CRUMBLE) && (f & F_MOVING)) bothFlags++;
  }
  if (bonuses > 1) bonusOver++;
}

line('스키마 위반', badSchema, badSchema === 0);
line('도달 불가 — 너무 멀다', tooFar, tooFar === 0);
line('도달 불가 — 너무 가깝다', tooNear, tooNear === 0);
line('한 구간에 보너스 2개 이상', bonusOver, bonusOver === 0);
line('부서짐+이동 동시 부여', bothFlags, bothFlags === 0);
console.log('  간격 범위   ' + minGap + ' ~ ' + maxGap +
            '  (실제 도약 가능 ' + LEAP_REACH_MIN.toFixed(0) + ' ~ ' + LEAP_MAX + ')');
console.log('');

// ── 4. 난이도 단조성 ─────────────────────────────────────────
console.log('  난이도 단조성 — 난이도가 오르면 평균 간격은 늘고 두께는 얇아져야 한다');
const profiles = [...new Set(list.map((c) => c.profile))];
let monoFail = 0;
for (const p of profiles) {
  const row = [];
  for (let d = 0; d <= 4; d++) {
    const sel = list.filter((c) => c.profile === p && c.difficulty === d);
    if (!sel.length) { row.push(null); continue; }
    let g = 0, t = 0, n = 0;
    for (const c of sel) for (const st of c.steps) { g += st[0]; t += st[1]; n++; }
    row.push({ gap: g / n, th: t / n });
  }
  const parts = row.map((r) => (r ? r.gap.toFixed(0).padStart(4) + '/' + r.th.toFixed(2) : '  — '));
  let ok = true;
  for (let d = 1; d <= 4; d++) {
    if (!row[d] || !row[d - 1]) continue;
    if (row[d].gap < row[d - 1].gap - 5 || row[d].th > row[d - 1].th + 0.02) ok = false;
  }
  if (!ok) monoFail++;
  console.log('    ' + p.padEnd(9) + parts.join('  ') + (ok ? '   ok' : '   ← 역전'));
}
if (monoFail) { console.log('    ' + monoFail + '개 프로파일에서 난이도 역전'); warn++; }
console.log('');

// ── 5. 중복률 ────────────────────────────────────────────────
const seen = new Map();
let dup = 0;
for (const c of list) {
  const key = JSON.stringify(c.steps);
  if (seen.has(key)) dup++; else seen.set(key, 1);
}
const dupRate = list.length ? (dup / list.length * 100) : 0;
line('완전 중복 청크', dup + '개 (' + dupRate.toFixed(1) + '%)', dupRate < 5);
if (dupRate >= 5) warn++;

// 플래그 분포
let nb = 0, nc = 0, nm = 0, total = 0;
for (const c of list) for (const st of c.steps) {
  total++;
  if (st[2] & F_BONUS) nb++;
  if (st[2] & F_CRUMBLE) nc++;
  if (st[2] & F_MOVING) nm++;
}
console.log('  발판 종류   보통 ' + pct(total - nb - nc - nm, total) +
            ' / 보너스 ' + pct(nb, total) +
            ' / 부서짐 ' + pct(nc, total) +
            ' / 이동 ' + pct(nm, total));

console.log('');
console.log('─'.repeat(62));
if (badSchema > 0 || tooFar > 0 || tooNear > 0) fatal++;
console.log(fatal ? '불통과 — 위 치명 항목을 고쳐야 한다'
                  : (warn ? '조건부 통과 — 경고 ' + warn + '건을 확인해라' : '통과'));
console.log('');
process.exit(fatal ? 1 : 0);

function line(label, value, ok) {
  console.log('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + String(label).padEnd(26) + value);
}
function pct(n, t) { return t ? (n / t * 100).toFixed(1) + '%' : '0%'; }
