#!/usr/bin/env node
// 웨이브 검수 — 사람이 눈으로 350개를 볼 수는 없다. 볼 수 있게 줄여준다.
//
//   node tools/verify-chunks.js
//
// 보는 것:
//   1. 생성자 — LLM 산출물인가, 자리표시자인가  ← 제일 먼저 본다
//   2. 스키마 유효성 (mix 는 **길이 6**이다)
//   3. **적이 나오기는 하는가** — mix 가 여섯 다 0이면 적이 한 명도 안 나온다
//   4. **화면이 막히지 않는가** — tempo 가 너무 짧으면 유닛이 화면을 덮는다
//   5. 난이도 단조성
//   6. **프로파일별 구성이 실제로 갈리는가** ← 이게 "디렉터가 장식이 아니다"의 증거다
//   7. **상성 대응이 실제로 작동하는가** — 플레이어 구성에 따라 적 구성이 움직이는가
//   8. **때움 유닛** — 못 살 때 대신 나오는 유닛이 성향과 맞는가
//   9. 중복률
//
// 러너에서 배운 것을 그대로 가져온다: **치명 항목은 게임을 못 하게 만드는 것만**이다.
// "밸런스가 이상하다"는 치명이 아니다. "적이 안 나온다"는 치명이다.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHUNKS = path.join(ROOT, 'data', 'chunks.json');
const POLICY = path.join(ROOT, 'data', 'policy.json');

const TEMPO_MIN = 420;    // 이보다 짧으면 유닛이 화면을 덮는다
const TEMPO_MAX = 3000;   // 이보다 길면 아무 일도 안 일어난다

const UNIT_KINDS = 6;
const SHORT = ['검', '창', '궁', '기', '거', '투'];
const LONG = ['검사', '창병', '궁수', '기병', '거인', '투석기'];
// src/config.js 의 U_COST 와 같은 값이다. 이 도구는 게임 코드를 import 하지 않는다
// (게임은 ESM, 도구는 CJS). 순서가 곧 계약이므로 여기 다시 적는다.
const U_COST = [28, 40, 44, 62, 92, 120];

// 프로파일 구성이 "서로 다르다"고 말하려면 얼마나 달라야 하는가.
// 반올림한 라벨이 다른 것만으로는 부족하다 — 1%p 차이도 다른 라벨이 된다.
// 두 프로파일의 구성비 차이(L1)가 이 값보다 작으면 같은 웨이브로 본다.
const MIN_PROFILE_L1 = 0.25;

if (!fs.existsSync(CHUNKS)) {
  console.error('data/chunks.json 이 없다. 먼저 node tools/bake.js --offline 을 돌려라.');
  process.exit(1);
}

const doc = JSON.parse(fs.readFileSync(CHUNKS, 'utf8'));
const list = doc.chunks || [];
const pol = fs.existsSync(POLICY) ? JSON.parse(fs.readFileSync(POLICY, 'utf8')) : null;
let fatal = 0, warn = 0;

console.log('');
console.log('─── 웨이브 검수 ' + '─'.repeat(46));
console.log('  파일        data/chunks.json');
console.log('  생성자      ' + (doc.generator || '(없음)'));
console.log('  구운 시각   ' + (doc.bakedAt || '(없음)'));
console.log('  유닛 순서   ' + (doc.unitOrder ? doc.unitOrder.join(' ') : '(없음)'));
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
let badSchema = 0, badLen = 0, emptyMix = 0, tooFast = 0, tooSlow = 0;
const mixSum = new Array(UNIT_KINDS).fill(0);
let tempoSum = 0, n = 0;

for (const c of list) {
  if (!c || typeof c.profile !== 'string') { badSchema++; continue; }
  if (!Number.isInteger(c.difficulty) || c.difficulty < 0 || c.difficulty > 4) { badSchema++; continue; }
  if (!Array.isArray(c.mix)) { badSchema++; continue; }
  // 길이 6이 아니면 게임은 앞 3개만 쓴다 — 기병·거인·투석기가 영원히 안 나온다.
  // 조용히 반쪽으로 도는 고장이라 치명으로 잡는다.
  if (c.mix.length !== UNIT_KINDS) { badLen++; continue; }
  let bad = false, sum = 0;
  for (let k = 0; k < UNIT_KINDS; k++) {
    const v = c.mix[k];
    if (!Number.isInteger(v) || v < 0 || v > 9) { bad = true; break; }
    sum += v;
  }
  if (bad) { badSchema++; continue; }
  if (typeof c.tempo !== 'number' || !Number.isFinite(c.tempo)) { badSchema++; continue; }

  n++;
  if (sum === 0) emptyMix++;
  if (c.tempo < TEMPO_MIN) tooFast++;
  if (c.tempo > TEMPO_MAX) tooSlow++;
  for (let k = 0; k < UNIT_KINDS; k++) mixSum[k] += c.mix[k];
  tempoSum += c.tempo;
}

line('스키마 위반', badSchema, badSchema === 0);
line('mix 길이가 6이 아님', badLen, badLen === 0);
line('적이 한 명도 안 나옴 (mix 전부 0)', emptyMix, emptyMix === 0);
line('간격이 너무 짧음 (화면이 막힌다)', tooFast, tooFast === 0);
line('간격이 너무 김 (아무 일도 안 일어난다)', tooSlow, tooSlow === 0);
const tot = mixSum.reduce((a, b) => a + b, 0);
console.log('  평균 구성    ' + mixSum.map((v, k) => SHORT[k] + ' ' + pct(v, tot)).join(' / '));
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
// 라벨이 다른지가 아니라 **분포가 얼마나 떨어져 있는지**를 본다.
console.log('  프로파일별 구성 — 서로 달라야 디렉터가 의미를 갖는다');
console.log('    ' + '프로파일'.padEnd(11) + SHORT.map((s) => s.padStart(6)).join('') + '     최다');
const share = new Map();
for (const p of profiles) {
  const sel = list.filter((c) => c.profile === p && Array.isArray(c.mix) && c.mix.length === UNIT_KINDS);
  const acc = new Array(UNIT_KINDS).fill(0);
  for (const c of sel) for (let k = 0; k < UNIT_KINDS; k++) acc[k] += c.mix[k];
  const t = acc.reduce((a, b) => a + b, 0) || 1;
  const sh = acc.map((v) => v / t);
  share.set(p, sh);
  let top = 0;
  for (let k = 1; k < UNIT_KINDS; k++) if (sh[k] > sh[top]) top = k;
  console.log('    ' + p.padEnd(10)
    + sh.map((v) => (v * 100).toFixed(0).padStart(5) + '%').join('')
    + '   ' + LONG[top]);
}

// 쌍마다 L1 거리를 재서 가장 가까운 두 프로파일을 본다.
let minPair = ['', '', 9], pairs = 0, close = 0;
for (let i = 0; i < profiles.length; i++) {
  for (let j = i + 1; j < profiles.length; j++) {
    const a = share.get(profiles[i]), b = share.get(profiles[j]);
    let d = 0;
    for (let k = 0; k < UNIT_KINDS; k++) d += Math.abs(a[k] - b[k]);
    pairs++;
    if (d < MIN_PROFILE_L1) close++;
    if (d < minPair[2]) minPair = [profiles[i], profiles[j], d];
  }
}
const distinct = new Set([...share.values()].map((s) => s.map((v) => Math.round(v * 10)).join(','))).size;
line('서로 다른 구성 분포', distinct + '종 / ' + profiles.length + '개 프로파일', distinct >= 4);
line('구성이 겹치는 쌍 (L1<' + MIN_PROFILE_L1 + ')', close + '쌍 / ' + pairs + '쌍', close === 0);
console.log('    가장 가까운 쌍  ' + minPair[0] + ' ↔ ' + minPair[1] + '   L1 ' + minPair[2].toFixed(2));
if (distinct < 4 || close > 0) warn++;
console.log('');

// ── 상성 대응 — 플레이어가 뽑는 것에 적이 반응하는가 ──────────
// 여기가 "AI가 판단한다"의 가장 직접적인 증거다.
// **주의: 이건 src/director.js 의 applyCounter() 를 그대로 옮긴 것이다.**
// 규칙이 바뀌면 양쪽을 같이 고쳐야 한다. 입력(counterMap·counterGain)은
// data/policy.json 에서 읽으므로 표가 어긋나면 여기서 잡힌다.
if (!pol || !pol.policies || !Array.isArray(pol.counterMap)) {
  console.log('  상성 대응    data/policy.json 에 counterMap 이 없다 — 검사 못 함');
  warn++;
} else {
  const cm = pol.counterMap;

  // 삼각형이 도는가 — 아무도 안 잡히는 유닛이 있으면 그놈만 뽑으면 된다.
  let uncounted = 0, dominant = 0;
  const beats = new Array(UNIT_KINDS).fill(0);
  for (let u = 0; u < UNIT_KINDS; u++) {
    if (!Array.isArray(cm[u]) || cm[u].length === 0) uncounted++;
    else for (const e of cm[u]) beats[e]++;
  }
  for (let e = 0; e < UNIT_KINDS; e++) if (beats[e] >= UNIT_KINDS - 1) dominant++;
  line('상성이 안 걸리는 유닛', uncounted, uncounted === 0);
  line('혼자 전부를 이기는 유닛', dominant, dominant === 0);

  // 각 프로파일에 "이 유닛만 뽑는 플레이어"를 넣고 적 구성이 어떻게 움직이는지 본다.
  let rise = 0, checks = 0;
  for (const p of profiles) {
    const pp = pol.policies[p];
    if (!pp || !Array.isArray(pp.mix)) continue;
    for (let u = 0; u < UNIT_KINDS; u++) {
      const list0 = cm[u] || [];
      if (!list0.length) continue;
      const sh = new Array(UNIT_KINDS).fill(0);
      sh[u] = 1;
      const before = norm(pp.mix);
      const after = norm(counterAdjust(pp.mix, num(pp.counterGain, 0), sh, cm));
      for (const e of list0) { checks++; if (after[e] > before[e] + 1e-6) rise++; }
    }
  }
  line('플레이어 구성에 적이 반응', rise + ' / ' + checks + ' 건', rise === checks);
  if (rise !== checks) warn++;

  // 사람이 눈으로 볼 표 — 균형(가장 흔한 판정) 상태에서 무엇이 어떻게 변하는가
  const bp = pol.policies.BALANCED;
  if (bp && Array.isArray(bp.mix)) {
    console.log('');
    console.log('  상성 대응 예시 — 판정이 균형일 때 플레이어 구성에 따라 적이 바뀐다');
    console.log('    ' + '플레이어'.padEnd(12) + SHORT.map((s) => s.padStart(6)).join('') + '     늘어난 것');
    const rows = [[-1, '반응 없음']].concat(LONG.map((nm, u) => [u, nm + ' 도배']));
    for (const [u, label] of rows) {
      const sh = new Array(UNIT_KINDS).fill(0);
      if (u >= 0) sh[u] = 1;
      const m = u < 0 ? bp.mix.slice() : counterAdjust(bp.mix, num(bp.counterGain, 0), sh, cm);
      const s = norm(m);
      const up = u < 0 ? '—' : (cm[u] || []).map((e) => LONG[e]).join('·');
      console.log('    ' + label.padEnd(11) + s.map((v) => (v * 100).toFixed(0).padStart(5) + '%').join('')
                  + '   ' + up);
    }
  }

  // 정책 자체의 스키마
  let polBad = 0;
  for (const p of ['RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER', 'BALANCED']) {
    const q = pol.policies[p];
    if (!q || !Array.isArray(q.mix) || q.mix.length !== UNIT_KINDS) { polBad++; continue; }
    if (q.mix.reduce((a, b) => a + b, 0) <= 0) polBad++;
    else if (typeof q.tempo !== 'number' || q.tempo < TEMPO_MIN || q.tempo > TEMPO_MAX) polBad++;
  }
  console.log('');
  line('정책 스키마 위반 (mix[6]·tempo)', polBad, polBad === 0);
  if (polBad) fatal++;

  // ── 때움 유닛 — 이 표가 이 게임에서 구성을 실제로 결정한다 ──
  // game.js 는 뽑기로 정한 유닛을 못 사면 **가중치가 있는 것 중 가장 싼 것**으로 때운다.
  // 적의 수입으로는 비싼 유닛을 자주 못 사므로, 실제 전장에 가장 많이 서 있는 것은
  // 대개 이 "때움 유닛"이다. 여기에 검사를 1이라도 남기면 성향이 통째로 사라진다
  // (첫 계측에서 벽을 세우라는 정책이 검사 74% 로 나왔다).
  console.log('');
  console.log('  때움 유닛 — 못 살 때 대신 나오는 유닛. 이게 성향과 맞아야 한다');
  let offBrand = 0;
  for (const p of ['RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER', 'BALANCED']) {
    const q = pol.policies[p];
    if (!q || !Array.isArray(q.mix)) continue;
    let cheap = -1;
    for (let k = 0; k < UNIT_KINDS; k++) {
      if (!(q.mix[k] > 0)) continue;
      if (cheap < 0 || U_COST[k] < U_COST[cheap]) cheap = k;
    }
    // 벽·원거리·중장 성향인데 때움이 검사면 성향이 사라진다.
    const wantsHeavy = p === 'RUSHER' || p === 'SWARMER' || p === 'TURTLE';
    const bad = cheap < 0 || (wantsHeavy && cheap === 0);
    if (bad) offBrand++;
    console.log('    ' + p.padEnd(10) + (cheap < 0 ? '(없음)' : LONG[cheap] + ' ' + U_COST[cheap] + '금')
                + (bad ? '   ← 성향이 지워진다' : ''));
  }
  line('성향과 어긋난 때움 유닛', offBrand, offBrand === 0);
  if (offBrand) warn++;
}
console.log('');

// ── 중복률 ───────────────────────────────────────────────────
const seen = new Map();
let dup = 0;
for (const c of list) {
  const key = (Array.isArray(c.mix) ? c.mix.join(',') : '?') + '|' + c.tempo;
  if (seen.has(key)) dup++; else seen.set(key, 1);
}
const dupRate = list.length ? (dup / list.length * 100) : 0;
line('완전 중복 웨이브', dup + '개 (' + dupRate.toFixed(1) + '%)', dupRate < 25);
if (dupRate >= 25) warn++;

console.log('');
console.log('─'.repeat(62));
if (badSchema > 0 || badLen > 0 || emptyMix > 0 || tooFast > 0) fatal++;
console.log(fatal ? '불통과 — 위 치명 항목을 고쳐야 한다'
                  : (warn ? '조건부 통과 — 경고 ' + warn + '건을 확인해라' : '통과'));
console.log('');
process.exit(fatal ? 1 : 0);

// ── 도우미 ───────────────────────────────────────────────────
function line(label, value, ok) {
  console.log('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + String(label).padEnd(34) + value);
}
function pct(v, t) { return t ? (v / t * 100).toFixed(1) + '%' : '0%'; }
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function norm(m) {
  const t = m.reduce((a, b) => a + b, 0) || 1;
  return m.map((v) => v / t);
}
// src/director.js 의 applyCounter() 와 같은 규칙이다.
function counterAdjust(baseMix, gain, sh, cm) {
  const m = baseMix.slice();
  if (gain <= 0) return m;
  for (let u = 0; u < UNIT_KINDS; u++) {
    const s = sh[u];
    if (!s) continue;
    const l = cm[u] || [];
    const add = gain * s / (l.length || 1);
    for (const e of l) m[e] += add;
  }
  return m;
}
