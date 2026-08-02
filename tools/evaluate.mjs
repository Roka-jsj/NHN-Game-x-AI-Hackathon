// 자동 평가 — 평론가(프롬프트 8)가 매 회차 돌리는 계측기.
//
//   NODE_PATH=$(npm root -g) node tools/evaluate.mjs
//   NODE_PATH=$(npm root -g) node tools/evaluate.mjs --json    ← 루프가 읽는 형식
//
// 인상이 아니라 숫자를 낸다. 평론가는 이 숫자로 점수를 매기고,
// 점수가 낮은 항목을 고친 뒤 다시 이걸 돌려 **올랐는지 확인한다.**
// 올랐는지 확인하지 않는 수정은 수정이 아니라 추측이다.
//
// ── v2 (spec-v2) 대응 ────────────────────────────────────────────
// 게임이 3유닛·1스킬에서 6유닛·상성·5시대·포탑·3스킬·10버튼으로 커졌다.
// 계측기도 같이 커진다. 재는 것:
//
//   0. 무엇이 실제로 구현돼 있는가 — API 유무를 먼저 확인한다.
//      **없는 기능을 "0점"으로 재면 거짓말이다. "미구현"이라고 말해야 한다.**
//   1. 판이 끝나는가 — 여덟 원형 전략으로 각각 5분 안에 결말이 나는가
//   2. 전략이 갈리는가 — 결말·판길이뿐 아니라 **6유닛 구성 거리**로 다시 잰다
//   3. 새 요소가 죽어 있지 않은가 — 포탑·스킬·상성이 실제로 발생하는가
//      (한 번도 안 지어지는 포탑은 없는 기능이다)
//   4. 상성이 실제로 작동하는가 — 결투 하네스로 삼각형 6변을 직접 검증한다
//   5. 첫 30초에 무엇을 만나는가
//   6. 디렉터가 장식이 아닌가
//   7. 콘솔 청결 · 프레임 비용 · 버튼 적중
//
// ── v3 (spec-v3) 대응 ────────────────────────────────────────────
// 게임이 "한 판"에서 "원정"으로 커졌다. 계측기가 새로 재는 것:
//
//   9.  원정 — 완주율 · 스테이지별 승률 · 첫 전투 길이 · 도발 · 총 길이
//       그리고 **승계 규칙**(특성·포탑 유지 / 금·시대·병력 초기화)이 지켜지는가
//   10. 난이도 격차 — **상성을 쓰는 봇이 실제로 더 잘하는가.**
//       같은 껍데기(진화·스킬·드래프트 동일)에 **유닛 선택만 다른** 세 봇을
//       같은 상대 다섯에게 붙인다. 격차가 작으면 상성 삼각형은 장식이다.
//   11. 온보딩 — 첫 10초 / 첫 30초를 나눠 센다.
//       계약은 "10초 안에 무언가 부수거나 부서지는 것을 본다"이다.
//
// ── 이 파일의 원칙 ──────────────────────────────────────────────
// **깨진 게임을 통과시키는 평가기보다, 깨졌다고 말하는 평가기가 낫다.**
// 여러 전문가가 동시에 game.js / render.js 를 고치고 있어 중간 상태가 자주 깨진다.
// 그때 평가기는 터지지 말고 그 사실을 숫자로 낸다 — 판이 안 끝나면 -1,
// API 가 없으면 -1(미구현), 한 구간이 터지면 report.errors 에 남기고 계속 간다.
//
// **평가기는 채점자다. 채점자가 답안을 고치면 채점이 무의미해진다.**
// 이 파일은 src/*.js 를 절대 수정하지 않는다. 게임이 잘못됐으면 -1 로 보고한다.
//
// ── 재현성 ──────────────────────────────────────────────────────
// 과거에 평균 판 길이가 106→193초로 움직인 적이 있는데 원인은 게임이 아니라
// **측정 중 소스가 바뀐 것**이었다. 그래서 이제 측정 시작·종료 시점의
// 커밋 해시와 소스 해시를 찍고, 도중에 바뀌면 출력 맨 위에 경고를 낸다.
// 봇 판단에는 Math.random() 을 쓰지 않는다 — 시드 기반 결정론 난수만 쓴다.

import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const JSON_OUT = process.argv.includes('--json');

// ── CLI ────────────────────────────────────────────────────────
//   --budget=<분>     전체 벽시계 예산 (기본 18분). 넘칠 것 같으면 표본을 줄이고
//                     **줄였다는 사실을 출력에 적는다.** 조용한 축소는 거짓말이다
//   --sections=a,b    구간만 골라 돌린다 (재현성 확인용). 기본 전부
const argVal = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BUDGET_MS = Math.max(1, +argVal('budget', 18)) * 60000;
const ALL_SECTIONS = ['impl', 'match', 'counter', 'usage', 'onboard', 'director',
                      'buttons', 'perf', 'campaign', 'gap'];
const WANT = new Set(String(argVal('sections', ALL_SECTIONS.join(','))).split(',').filter(Boolean));
const on = (s) => WANT.has(s);
const T_START = Date.now();
const remainMs = () => BUDGET_MS - (Date.now() - T_START);

// ── 소스 지문 — 언제 잰 수치인지 못 박는다 ──────────────────────
// **data/*.json 도 본다.** 레버를 안 건드렸는데 판별력이 0.350→0.235 로 움직인
// 사례가 있었고, 원인은 다른 사람이 측정 도중 data/*.json 을 재생성한 것이었다.
// 디렉터의 정책·구간 데이터는 소스와 똑같이 수치를 움직인다.
const WATCH = ['src/config.js', 'src/game.js', 'src/render.js', 'src/audio.js',
               'src/director.js', 'src/main.js', 'src/feel.js', 'index.html',
               'data/chunks.json', 'data/policy.json', 'data/lines.json'];
function provenance() {
  const out = { git: '?', dirty: null, files: {} };
  try {
    out.git = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
    out.dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT }).toString().trim().length > 0;
  } catch { /* git 없어도 계측은 돈다 */ }
  for (const f of WATCH) {
    try {
      const buf = fs.readFileSync(path.join(ROOT, f));
      const st = fs.statSync(path.join(ROOT, f));
      out.files[f] = { sha1: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10),
                       bytes: buf.length, mtime: st.mtimeMs };
    } catch { out.files[f] = null; }
  }
  return out;
}
function drift(a, b) {
  const changed = [];
  for (const f of WATCH) {
    const x = a.files[f], y = b.files[f];
    if (!x || !y) { if (x !== y) changed.push(f); continue; }
    if (x.sha1 !== y.sha1) changed.push(f);
  }
  return changed;
}

function loadPlaywright() {
  try { return require('playwright'); } catch { /* 아래에서 재시도 */ }
  const globalRoot = process.env.NODE_PATH || '/usr/lib/node_modules';
  for (const base of globalRoot.split(path.delimiter)) {
    try { return require(path.join(base, 'playwright')); } catch { /* 계속 */ }
  }
  throw new Error('playwright를 찾을 수 없다. NODE_PATH=$(npm root -g) 로 실행해라.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file)] || 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// 합성 클록 — 실시간을 기다리지 않고 5분 판을 몇 초에 돌린다.
// 모듈이 로드되기 전에 주입해야 rAF·performance.now 를 갈아끼울 수 있다.
const CLOCK_INIT = () => {
  let t = 0;
  const qA = [], qB = [];
  let cur = qA;
  const origNow = window.performance.now.bind(window.performance);
  window.performance.now = () => t;
  window.requestAnimationFrame = (cb) => { cur.push(cb); return cur.length; };
  window.cancelAnimationFrame = () => {};
  window.__clock = {
    now: () => t,
    real: origNow,
    tick(ms) {
      t += ms;
      const batch = cur;
      cur = (cur === qA) ? qB : qA;
      cur.length = 0;
      for (let i = 0; i < batch.length; i++) batch[i](t);
    },
  };
};

// ── 이벤트 코드. spec-v2 §7 · spec-v3 §3 이 번호를 못 박았다 ────────
// main.js 는 이제 EV 를 __rising 에 노출한다. 그래도 계약 번호를 여기에 박아 두고
// **페이지가 내놓는 EV 와 대조한다.** 번호가 어긋나면 조용히 틀린 값을 세는 대신
// 이벤트_번호_불일치 로 보고한다 — 하드코딩의 유일한 안전한 사용법이다.
const E = {
  SPAWN: 0, ATTACK: 1, KILL: 2, BASE_HIT: 3, GOLD: 4, ERA_UP: 5, NUKE: 6,
  NO_GOLD: 7, COOLDOWN: 8, WATER_WARN: 9, WATER_HIT: 10, DRAFT_OPEN: 11,
  DRAFT_PICK: 12, WIN: 13, LOSE: 14, RESET: 15,
  TOWER_FIRE: 16, SKILL: 17, TOWER_UP: 18, COUNTER_HIT: 19,
  // v3
  STAGE_START: 20, STAGE_CLEAR: 21, TAUNT: 22, CAMPAIGN_END: 23,
};

// ── 전략 봇 ────────────────────────────────────────────────────
// **원형(archetype)이어야 한다.** 미세한 편향으로는 아무것도 갈리지 않는다 —
// 러너에서 다섯 봇의 지표 중앙값이 전부 겹쳐 임계값을 어디 둬도 분리가
// 불가능했던 적이 있다. 6유닛·상성·포탑·스킬이 생겼으니 축을 그만큼 벌린다.
//
//   swarm    싼 유닛(검사·창병)만 계속 쏟는다            물량 축
//   counter  적 구성을 읽고 상성표에서 우위 유닛을 뽑는다  판단 축  ★상성 검증용
//   cav      기병 단일 러시                              기동 축
//   siege    투석기·거인. 유닛전을 피하고 기지를 깬다      공성 축
//   tower    포탑을 최우선으로 올리고 최소 병력만 낸다      수비 축
//   skill    금을 아끼고 스킬 3종을 쿨마다 전부 쓴다        스킬 축
//   econ     모았다가 한꺼번에 쏟는다. 진화 최우선          경제 축
//   idle     아무것도 하지 않는다                         **대조군**
//
// idle 은 "가만히 있으면 진다"를 증명하는 하한선이다. idle 이 이기면
// 그건 전략 게임이 아니라 관전 게임이다.
const STRATEGIES = ['swarm', 'counter', 'cav', 'siege', 'tower', 'skill', 'econ', 'idle'];

// 봇이 드래프트에서 선호하는 특성 계열. 0=공격 1=방어 2=경제
const DRAFT_PREF = {
  swarm: 0, counter: 0, cav: 0, siege: 0, tower: 1, skill: 0, econ: 2, idle: 1,
};

const BOT = () => {
  const K_NAMES = ['SWORD', 'SPEAR', 'ARCHER', 'CAV', 'GIANT', 'CATA'];

  // ACT 이름으로만 접근한다. **인덱스로 접근하면 안 된다** —
  // v1 에서 3번은 ERA 였고 v2 에서 3번은 기병이다. 이름이 계약이다.
  function act(name) {
    const A = window.__rising.ACT;
    const v = A ? A[name] : undefined;
    return (typeof v === 'number') ? v : -1;
  }

  // 이번 판에서 봇이 쓰려 했으나 없던 API. 보고서가 "미구현"이라고 말하게 한다.
  window.__missing = Object.create(null);
  function need(name) {
    const a = act(name);
    if (a < 0) window.__missing[name] = 1;
    return a;
  }

  function kinds() {
    const C = window.__rising.C;
    return (C && C.UNIT_KINDS) ? C.UNIT_KINDS : 3;
  }

  // 살 수 있는가 — 쿨다운 · 금 · ACT 존재를 전부 본다
  function buyable(g, k) {
    if (k >= kinds()) return false;
    if (act(K_NAMES[k]) < 0) return false;
    if (g.spawnCd && g.spawnCd.length > k && g.spawnCd[k] > 0) return false;
    return g.gold >= g.cost(k);
  }
  function buy(R, g, k, t) {
    const a = need(K_NAMES[k]);
    if (a < 0) return false;
    R.inject(a, t);
    return true;
  }

  // 적 진영의 살아 있는 구성을 센다. 상성 봇의 눈이다.
  function foeMix(g, K) {
    const out = new Array(K).fill(0);
    for (let i = 0; i < g.uAlive.length; i++) {
      if (g.uAlive[i] && g.uSide[i] === 1) out[g.uKind[i]]++;
    }
    return out;
  }

  // 상성표를 읽고 적 구성에 유리한 유닛을 고른다. counter 봇의 눈.
  //
  // perGold=false — **적 구성 대비 상성 배수가 가장 높은 유닛.** 동점이면 싼 쪽.
  //   이것이 "상성을 아는 플레이어"의 문자 그대로의 정의다.
  // perGold=true  — 그 배수를 다시 가격으로 나눈다.
  //   처음엔 이쪽만 썼는데, 그러면 봇이 **검사 도배가 된다** (실측: 구성 검44창3궁2).
  //   배수 1.75 보다 가격차(검 30 vs 궁 70 같은)가 커서 상성이 늘 진다.
  //   봇의 휴리스틱이 지표를 삼킨 것이라, 두 정의를 **둘 다** 재고 차이를 보고한다.
  //   두 값의 차이 자체가 밸런스 정보다: 가격 대비 효율 > 상성 우위인가?
  //
  // **살 수 있는 것 중에서 고르지 않는다. 고른 뒤에 기다린다.**
  //   후보를 buyable 로 먼저 거르면, 비싼 카운터 유닛은 돈이 모이기 전에 매번
  //   탈락하고 봇은 최저가 유닛만 산다. 실측으로 이 봇의 구성이 **검사 90%** 였다 —
  //   "상성 봇 vs 도배 봇" 을 재려던 하네스에서 두 봇이 같은 봇이 돼 있었다.
  //   격차 0 은 게임이 낸 값이 아니라 계측기가 낸 값이었다.
  function chooseCounter(g, C, K, perGold) {
    const CT = C.COUNTER;
    if (!CT) { window.__missing.COUNTER = 1; return 0; }
    const mix = foeMix(g, K);
    let tot = 0; for (let j = 0; j < K; j++) tot += mix[j];
    if (tot === 0) return 0;              // 적이 없으면 가장 싼 것으로 시작한다
    let best = -1, bestS = -1, bestC = 0;
    for (let k = 0; k < K; k++) {         // ← buyable 로 거르지 않는다
      let s = 0;
      for (let j = 0; j < K; j++) s += mix[j] * CT[k * K + j];
      s /= tot;
      const c = g.cost(k);
      if (perGold) s /= c;
      // 동점이면 싼 쪽. 안 그러면 "아무 유닛이나 다 1.0"인 초반에 가장 비싼 것을 산다
      if (s > bestS + 1e-9 || (Math.abs(s - bestS) <= 1e-9 && best >= 0 && c < bestC)) {
        bestS = s; best = k; bestC = c;
      }
    }
    return best;
  }

  // 시드 기반 결정론 난수. **Math.random() 은 금지다** —
  // 같은 봇이 같은 결과를 내야 수치가 증거가 된다.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  window.__rngs = Object.create(null);

  // ── 격차 하네스 전용 껍데기 ──────────────────────────────────
  // **유닛 선택만 다르고 나머지는 전부 같다.** 진화·해일·드래프트를 통일하지
  // 않으면 승률 차이가 "상성을 썼는가"가 아니라 경제·스킬 차이를 잰 것이 된다.
  // 그러면 이 하네스는 아무것도 증명하지 못한다.
  window.__playGap = (spec) => {
    const R = window.__rising, g = R.game, C = R.C;
    if (g.state === 2) return;
    if (g.state === 1) { pickDraft(R, g, 0, performance.now()); return; }
    const t = performance.now(), K = kinds();

    if (g.eraReady && g.eraReady()) { const a = need('ERA'); if (a >= 0) R.inject(a, t); }
    const ready = (i) => (g.skillReady ? g.skillReady(i) : (g.skillCd ? g.skillCd[i] <= 0 : false));
    if (ready(0) && g.aliveR > 4) { const a = act('TIDE'); if (a >= 0) R.inject(a, t); }

    // ── 목표 종류를 정한다. 세 봇이 다른 것은 **이 한 줄뿐이다** ──
    const S = window.__gapSt || (window.__gapSt = { target: -1, n: 0 });
    let k = -1;
    if (spec.pick === 'spam') {
      k = spec.k;                                          // 한 종류만 도배. 무뇌
    } else if (spec.pick === 'cycle') {
      k = S.n % K;                                         // 여섯 종 균등 순환 (결정론)
    } else if (spec.pick === 'rand') {
      // 목표를 하나 뽑아 **살 때까지 붙든다.** 매 틱 다시 뽑으면 "살 수 있는 것 중
      // 아무거나"가 되어 결국 최저가 도배가 된다 — 상성 봇이 빠졌던 함정과 같다.
      if (S.target < 0) {
        const rng = window.__rngs[spec.seed] || (window.__rngs[spec.seed] = mulberry32(spec.seed));
        S.target = (rng() * K) | 0;
      }
      k = S.target;
    } else {
      k = chooseCounter(g, C, K, spec.pick === 'counterGold');   // 상성을 읽는다
    }
    // **못 사면 기다린다.** 싼 것으로 때우지 않는다.
    if (k >= 0 && k < K && buyable(g, k)) {
      buy(R, g, k, t);
      S.n++; S.target = -1;
    }
  };

  // 드래프트 — 봇마다 선호 계열이 다르다. 이것도 전략 축이다.
  function pickDraft(R, g, pref, t) {
    const C = R.C;
    let slot = 0;
    // 카드는 특성일 수도 숙련(인덱스 100+)일 수도 있다. C.draftCard 가 그 둘을
    // 같은 모양으로 준다 — 없는 빌드에서는 예전처럼 C.TRAITS 로 떨어진다.
    const card = C.draftCard || ((i) => C.TRAITS && C.TRAITS[i]);
    if (g.draftIdx) {
      for (let s = 0; s < g.draftIdx.length; s++) {
        const idx = g.draftIdx[s];
        if (idx < 0) continue;
        const c = card(idx);
        if (c && c.kind === pref) { slot = s; break; }
      }
    }
    const p0 = act('PICK0');
    R.inject(p0 >= 0 ? p0 + slot : slot, t);
  }

  window.__play = (mode, pref) => {
    const R = window.__rising, g = R.game, C = R.C;
    if (g.state === 2) return;                        // 결과 화면
    if (g.state === 1) { pickDraft(R, g, pref, performance.now()); return; }
    const t = performance.now();
    const K = kinds();

    if (mode === 'idle') return;                      // 대조군 — 손을 대지 않는다

    // 진화 — tower/idle 을 뺀 전원이 준비되면 올린다.
    // (수비 봇은 금을 포탑에 쓴다. 그게 그 봇의 정체다)
    if (mode !== 'tower' && g.eraReady && g.eraReady()) {
      const a = need('ERA');
      if (a >= 0) R.inject(a, t);
    }

    // ── 스킬 ──
    const ready = (i) => (g.skillReady ? g.skillReady(i) : (g.skillCd ? g.skillCd[i] <= 0 : false));
    if (mode === 'skill') {
      // 쿨마다 셋 다 쓴다. 스킬이 실제로 판을 바꾸는지 재는 봇이다.
      if (ready(0)) { const a = need('TIDE'); if (a >= 0) R.inject(a, t); }
      if (ready(1)) { const a = need('VOLLEY'); if (a >= 0) R.inject(a, t); }
      if (ready(2)) { const a = need('RALLY'); if (a >= 0) R.inject(a, t); }
      // 스킬만으로는 못 이긴다. 남는 금으로만 검사를 낸다.
      if (g.gold > 500 && buyable(g, 0)) buy(R, g, 0, t);
      return;
    }
    // 나머지 봇도 해일은 쓴다 — 안 쓰면 스킬이 죽은 기능인지 알 수 없다.
    if (ready(0) && g.aliveR > 4) {
      let a = act('TIDE');
      if (a < 0) a = act('NUKE');                     // v1 잔재. 있으면 쓴다
      if (a >= 0) R.inject(a, t); else window.__missing.TIDE = 1;
    }

    // ── 포탑 ──
    if (mode === 'tower') {
      const cost = g.towerCost ? g.towerCost() : -2;
      if (cost === -2) window.__missing.towerCost = 1;
      if (cost > 0 && g.gold >= cost) {
        const a = need('TOWER');
        if (a >= 0) { R.inject(a, t); return; }
      }
      // 포탑을 다 올렸거나 돈이 모자라면 창병만 세워 둔다
      if (g.gold > 260 && buyable(g, Math.min(1, K - 1))) buy(R, g, Math.min(1, K - 1), t);
      return;
    }

    // ── 유닛 ──
    if (mode === 'swarm') {
      for (const k of [0, 1]) if (buyable(g, k)) { buy(R, g, k, t); return; }
      return;
    }
    if (mode === 'cav') {
      if (buyable(g, 3)) { buy(R, g, 3, t); return; }
      if (g.gold > 200 && buyable(g, 0)) buy(R, g, 0, t);
      return;
    }
    if (mode === 'siege') {
      if (buyable(g, 5)) { buy(R, g, 5, t); return; }
      if (buyable(g, 4)) { buy(R, g, 4, t); return; }
      if (g.gold > 300 && buyable(g, 0)) buy(R, g, 0, t);
      return;
    }
    if (mode === 'econ') {
      // 모았다가 한꺼번에 쏟는다 — 단, **초반 30초는 살아남을 만큼만 낸다.**
      // 순수 축적형으로 뒀더니 19초에 기지가 무너져 idle(대조군)과 결과가
      // 같아졌다. 두 봇이 같은 줄을 내면 원형 하나를 버리는 셈이다.
      // (이 자체가 발견이다: 이 게임에서 무대응 오프닝의 수명은 19초다)
      if (g.elapsed() < 30) { if (buyable(g, 0)) buy(R, g, 0, t); return; }
      if (window.__econBurst === undefined) window.__econBurst = false;
      if (g.gold > 420) window.__econBurst = true;
      if (g.gold < 120) window.__econBurst = false;
      if (window.__econBurst) for (let k = K - 1; k >= 0; k--) if (buyable(g, k)) { buy(R, g, k, t); return; }
      return;
    }
    if (mode === 'counter') {
      // **적 구성에 가장 세게 먹히는 종을 고르고, 돈이 없으면 기다린다.**
      // (예전엔 점수를 가격으로 나누고 살 수 있는 것 중에서만 골라서 검사 90% 도배봇이었다.
      //  이 줄 하나 때문에 "상성 봇"이 "도배 봇"과 같은 봇이었다 — 아래 [10] 격차가 그것 때문에 0 이었다)
      const best = chooseCounter(g, C, K, false);
      if (best >= 0 && buyable(g, best)) buy(R, g, best, t);
      return;
    }
  };
};

const OUTCOME = ['진행중', '승리', '패배', '둘다잠김'];

// 한 구간이 터져도 전체는 계속 돈다. 터진 사실은 숫자로 남는다.
async function guard(report, label, fn, fallback) {
  try { return await fn(); }
  catch (e) { report.errors.push(label + ': ' + (e && e.message ? e.message : String(e))); return fallback; }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(n, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function run() {
  const { chromium } = loadPlaywright();
  const { server, port } = await serve();
  const url = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const report = {
    impl: null, matches: [], usage: null, counter: null,
    first30: null, director: [], buttons: null, console: [], perf: null, errors: [],
    // v3
    campaign: null, gap: null,
    provenance: { start: provenance(), end: null, changedDuringRun: [] },
    reduced: [],            // 표본을 줄였다면 그 사실을 여기에 남긴다
    load: { cpus: os.cpus().length, start: +os.loadavg()[0].toFixed(2), end: -1 },
    sections: [...WANT],
    wallMs: 0,
    tickBudget: { ticksDone: 0, wallMs: 0, tickPerMs: 0 },
  };
  const note = (s) => { report.reduced.push(s); };

  async function page0() {
    const p = await browser.newPage({ viewport: { width: 960, height: 600 } });
    p.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') report.console.push(m.type() + ': ' + m.text());
    });
    p.on('pageerror', (e) => report.console.push('pageerror: ' + e.message));
    await p.addInitScript(CLOCK_INIT);
    await p.addInitScript(BOT);
    await p.goto(url, { waitUntil: 'load' });
    // 15초로 뒀더니 부하가 높을 때 페이지 부팅이 안 끝나 계측이 2판 날아갔다.
    // **게임이 느린 게 아니라 이 기계가 붐빈 것이다.** 넉넉히 준다.
    await p.waitForFunction('!!window.__rising', null, { timeout: 45000, polling: 200 });
    return p;
  }

  // ── 0. 무엇이 구현돼 있는가 ──────────────────────────────────
  // 없는 기능을 0점으로 재면 거짓말이다. 먼저 유무를 확정한다.
  report.impl = await guard(report, 'impl', async () => {
    const p = await page0();
    const r = await p.evaluate(() => {
      const R = window.__rising, g = R.game, C = R.C, A = R.ACT || {};
      const want = ['SWORD', 'SPEAR', 'ARCHER', 'CAV', 'GIANT', 'CATA',
                    'ERA', 'TOWER', 'TIDE', 'VOLLEY', 'RALLY', 'PICK0'];
      const missingAct = want.filter((n) => typeof A[n] !== 'number');
      const has = (o, k) => o && o[k] !== undefined && o[k] !== null;
      return {
        unitKinds: C.UNIT_KINDS | 0,
        eraCount: C.ERA_COUNT | 0,
        btnCount: C.BTN_COUNT | 0,
        counterTable: !!(C.COUNTER && C.COUNTER.length === (C.UNIT_KINDS | 0) ** 2),
        counterStrong: C.COUNTER_STRONG || 0,
        spawnCdLen: g.spawnCd ? g.spawnCd.length : 0,
        skillCdLen: g.skillCd ? g.skillCd.length : 0,
        towerLv: has(g, 'towerLv'), towerCd: has(g, 'towerCd'),
        fnTowerCost: typeof g.towerCost === 'function',
        fnSkillReady: typeof g.skillReady === 'function',
        fnCost: typeof g.cost === 'function',
        hitRally: typeof R.renderer.constructor.hitRally === 'function',
        missingAct,
        // ── v3 원정 API. 없으면 원정 계측은 전부 -1(미구현)이다 ──
        camp: {
          stage: g.stage !== undefined, stageMax: g.stageMax !== undefined,
          commander: g.commander !== undefined, campaignOver: g.campaignOver !== undefined,
          fnNextStage: typeof g.nextStage === 'function',
          stageVal: g.stage === undefined ? -1 : g.stage | 0,
          stageMaxVal: g.stageMax === undefined ? -1 : g.stageMax | 0,
        },
        // 상수는 이미 config.js 에 있다. 있는데 game.js 가 안 쓰는 것과
        // 아예 없는 것은 다른 병이다 — 나눠서 보고한다.
        cfg: {
          CAMPAIGN_LEN: C.CAMPAIGN_LEN | 0,
          lenHp: (C.STAGE_HP_MUL || []).length, lenDiff: (C.STAGE_DIFF || []).length,
          lenWater: (C.STAGE_WATER_MUL || []).length, lenDip: (C.STAGE_DIP || []).length,
          lenName: (C.COMMANDER_NAME || []).length, lenTaunt: (C.COMMANDER_TAUNT || []).length,
          lenLine: (C.COMMANDER_LINE || []).length,
          hp0: (C.STAGE_HP_MUL || [])[0],
        },
        // 페이지가 내놓는 EV 를 그대로 받아 계약 번호와 대조한다
        ev: R.EV || null,
      };
    });
    await p.close();
    return r;
  }, null);

  const IMPL = report.impl || {};
  const K = IMPL.unitKinds || 3;

  // 이벤트 번호 대조 — 어긋나면 아래 모든 카운트가 조용히 틀린 값이 된다
  const evMismatch = [];
  const evMissing = [];
  if (IMPL.ev) {
    for (const [k, v] of Object.entries(E)) {
      if (IMPL.ev[k] === undefined) evMissing.push(k);
      else if (IMPL.ev[k] !== v) evMismatch.push(k + ':계약' + v + '≠실제' + IMPL.ev[k]);
    }
  }
  const CAMP_OK = !!(IMPL.camp && IMPL.camp.fnNextStage && IMPL.camp.stage &&
                     IMPL.camp.stageMax && IMPL.camp.campaignOver);

  // ── 1~3. 판이 끝나는가 · 전략이 갈리는가 · 새 요소가 쓰이는가 ──
  // 이벤트를 가로채 포탑·스킬·상성 발생 횟수를 판마다 기록한다.
  // **한 번도 안 지어지는 포탑은 없는 기능이다.** 그걸 여기서 잡는다.
  const tMatch0 = Date.now();
  const matchResults = !on('match') ? [] : await pool(STRATEGIES, 3, async (mode) => guard(report, 'match:' + mode, async () => {
    const p = await page0();
    const r = await p.evaluate(async (arg) => {
      const [mode, pref, EVC] = arg;
      const R = window.__rising, g = R.game;
      const KK = R.C.UNIT_KINDS | 0;
      const ev = Object.create(null);
      const skill = [0, 0, 0];
      let towerMax = 0;
      const orig = g.emit.bind(g);
      g.emit = (t, a, b) => {
        ev[t] = (ev[t] || 0) + 1;
        if (t === EVC.SKILL) { const i = a | 0; if (i >= 0 && i < 3) skill[i]++; }
        if (t === EVC.TOWER_UP && a > towerMax) towerMax = a | 0;
        orig(t, a, b);
      };
      for (let i = 0; i < 60 * 60 * 5; i++) {
        if (i % 12 === 0) window.__play(mode, pref);
        window.__clock.tick(1000 / 60);
        if (g.state === 2) break;
        if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
      }
      const mix = new Array(KK).fill(0);
      let tot = 0;
      for (let k = 0; k < KK; k++) { const v = g.spawnedKind ? (g.spawnedKind[k] | 0) : 0; mix[k] = v; tot += v; }
      return {
        ticks: g.tick | 0,
        seconds: +g.elapsed().toFixed(0),
        outcome: g.state === 2 ? g.outcome : -1,
        myHp: g.baseHp[0] | 0, foeHp: g.baseHp[1] | 0, era: g.era,
        kills: g.kills, lost: g.lost, spawned: g.spawned,
        mix, mixTotal: tot,
        towerLv: (g.towerLv === undefined ? -1 : g.towerLv | 0),
        towerUpMax: towerMax,
        towerFire: ev[EVC.TOWER_FIRE] || 0,
        skillUse: skill,
        skillTotal: skill[0] + skill[1] + skill[2],
        counterHit: ev[EVC.COUNTER_HIT] || 0,
        attacks: ev[EVC.ATTACK] || 0,
        drafts: ev[EVC.DRAFT_PICK] || 0,
        profile: R.director.profile,
        missing: Object.keys(window.__missing),
      };
    }, [mode, DRAFT_PREF[mode], E]);
    await p.close();
    return Object.assign({ mode }, r);
  }, { mode, seconds: -1, outcome: -1, broken: true }));
  report.matches = matchResults;

  // 처리량을 실측해 둔다 — 아래 원정·격차 구간이 예산 안에 들어가는지
  // **추측이 아니라 이 값으로** 판단하고, 안 들어가면 표본을 줄인다.
  {
    const ticks = matchResults.reduce((a, m) => a + ((m && m.ticks) || 0), 0);
    const wall = Date.now() - tMatch0;
    report.tickBudget = { ticksDone: ticks, wallMs: wall,
                          tickPerMs: wall > 0 ? +(ticks / wall).toFixed(3) : 0 };
  }
  // 관측이 없으면 보수적인 기본값(단일 페이지 실측 ≈ 0.27 tick/ms 를 3병렬로)
  const TICK_PER_MS = report.tickBudget.tickPerMs > 0.02 ? report.tickBudget.tickPerMs : 0.8;
  // 상한 틱을 그대로 쓰면 "모든 판이 상한까지 간다"는 최악 가정이라 표본을 과하게 줄인다.
  // 실측에서 대부분의 판은 상한의 절반 아래에서 끝난다. 그 계수를 곱해 기대비용으로 본다.
  const estMs = (worstTicks, frac) => Math.round(worstTicks * frac / TICK_PER_MS);

  // ── 4. 상성이 실제로 작동하는가 — 결투 하네스 ────────────────
  // EV.COUNTER_HIT 이 나온다고 상성이 "작동"하는 것은 아니다.
  // 배수가 곱해져도 그게 승부를 뒤집지 못하면 상성은 장식이다.
  // 그래서 삼각형 6변을 직접 붙여 본다. 디렉터·물·경제를 끄고 순수 전투만 남긴다.
  //   동수 — 같은 머릿수. 배수 자체가 도는가
  //   동금 — 같은 금액. 가격까지 포함해서 실제로 이득인가
  report.counter = !on('counter') ? { supported: false, pairs: [] } : await guard(report, 'counter-duel', async () => {
    const p = await page0();
    const r = await p.evaluate(async (KK) => {
      const R = window.__rising, g = R.game, C = R.C;
      if (!C.COUNTER || KK < 6) return { supported: false, pairs: [] };
      const beats = [
        [C.U_SPEAR, C.U_CAV], [C.U_CAV, C.U_ARCHER], [C.U_CAV, C.U_CATA],
        [C.U_ARCHER, C.U_SWORD], [C.U_ARCHER, C.U_GIANT], [C.U_SWORD, C.U_SPEAR],
      ];
      // 결투 격리 — 게임 코드를 고치지 않고 인스턴스 위에만 덮어쓴다.
      // **덮어쓸 대상이 없으면 예외를 던진다.** 함수 이름이 바뀌었는데 조용히
      // 새 속성을 만들면 격리가 안 된 채로 "결투했다"고 보고하게 된다 —
      // 절제가 빗나갔는데 결과만 나오는 것이 이 저장소가 반복해서 당한 함정이다.
      function isolate() {
        for (const n of ['stepAI', 'stepWater', 'stepEconomy']) {
          if (typeof g[n] !== 'function') throw new Error('결투 격리 실패: game.' + n + ' 가 없다');
        }
        g.supplier = null;
        g.stepAI = function () {};
        g.stepWater = function () {};
        g.stepEconomy = function () {};
      }
      // 소환 직후 한 칸씩 뒤로 물린다. 안 그러면 전원이 같은 x 에 겹쳐 서서
      // 사거리 차이(창병 38 vs 기병 24 같은)가 지표에서 사라진다 — 그러면
      // 이 결투는 상성 배수만 재고 사거리는 못 재는 반쪽 시험이 된다.
      function place(side, kind, n) {
        for (let i = 0; i < n; i++) {
          g.spawn(side, kind, 0);
          const idx = (g.uNext - 1 + C.UNIT_MAX) % C.UNIT_MAX;
          if (g.uKind[idx] === kind && g.uSide[idx] === side) {
            g.uX[idx] += (side === 0 ? -1 : 1) * i * C.UNIT_GAP;
            g.uPrevX[idx] = g.uX[idx];
          }
        }
      }
      function duel(atk, def, na, nd) {
        g.supplier = null;
        g.reset();
        // 설명 화면(S.BRIEF)에서는 step() 이 통째로 no-op 이다. 안 닫으면
        // 결투가 9초 동안 아무 일도 안 하고, 그건 상성이 아니라 시험이 고장난 것이다.
        if (g.state === 3 && g.dismissBrief) g.dismissBrief();
        isolate();
        g.emit = function () {};
        place(0, atk, na);
        place(1, def, nd);
        for (let i = 0; i < 60 * 120; i++) {
          g.step();
          if (g.aliveL === 0 || g.aliveR === 0) break;
          if (g.state === 2) break;
        }
        return { left: g.aliveL, right: g.aliveR, ticks: g.tick };
      }
      const out = [];
      for (const [a, d] of beats) {
        const even = duel(a, d, 8, 8);
        const budget = 480;
        const na = Math.max(2, Math.min(20, Math.round(budget / C.U_COST[a])));
        const nd = Math.max(2, Math.min(20, Math.round(budget / C.U_COST[d])));
        const gold = duel(a, d, na, nd);
        out.push({
          atk: a, def: d,
          mul: C.COUNTER[a * KK + d],
          rA: C.U_RANGE[a], rD: C.U_RANGE[d],
          evenWin: even.left > even.right, evenL: even.left, evenR: even.right,
          goldWin: gold.left > gold.right, goldL: gold.left, goldR: gold.right,
          na, nd,
        });
      }
      return { supported: true, pairs: out };
    }, K);
    await p.close();
    return r;
  }, { supported: false, pairs: [] });

  // ── 5. 새 요소가 아예 발생 가능한가 — 능력 검사 ───────────────
  // 판에서 안 나오는 것과 **낼 수가 없는 것**은 다른 병이다. 나눠서 잰다.
  // 여기서는 돈과 쿨다운을 치워 주고 입력 경로(ACT→input→효과)를 끝까지 통과시킨다.
  report.usage = !on('usage') ? null : await guard(report, 'capability', async () => {
    const p = await page0();
    const r = await p.evaluate(async (arg) => {
      const [KK, EVC] = arg;
      const R = window.__rising, g = R.game, C = R.C, A = R.ACT || {};
      const NAMES = ['SWORD', 'SPEAR', 'ARCHER', 'CAV', 'GIANT', 'CATA'];
      const seen = Object.create(null);
      const skillSeen = [0, 0, 0];
      const orig = g.emit.bind(g);
      g.emit = (t, a, b) => {
        seen[t] = (seen[t] || 0) + 1;
        if (t === EVC.SKILL) { const i = a | 0; if (i >= 0 && i < 3) skillSeen[i]++; }
        orig(t, a, b);
      };
      const step = (n) => { for (let i = 0; i < n; i++) window.__clock.tick(1000 / 60); };
      // **설명 화면(S.BRIEF=3)을 먼저 닫는다.** v3 가 원정 첫 전투 앞에 붙였고,
      // 그 화면에서는 **아무 입력이나 소비돼 화면을 닫는 데만 쓰인다.**
      // 안 닫고 시험하면 첫 소환이 삼켜져 "검사가 안 나온다"는 거짓 미구현이 나온다.
      const unbrief = () => { for (let i = 0; i < 4 && g.state === 3; i++) { if (g.dismissBrief) g.dismissBrief(); else { R.inject(0, performance.now()); step(1); } } };
      unbrief();

      // 유닛 6종 — 각각 실제로 소환되는가
      const spawnOk = [];
      for (let k = 0; k < KK; k++) {
        const a = A[NAMES[k]];
        if (typeof a !== 'number') { spawnOk.push(-1); continue; }
        g.gold = C.GOLD_CAP;
        if (g.spawnCd && g.spawnCd.length > k) g.spawnCd[k] = 0;
        const before = g.spawnedKind ? g.spawnedKind[k] | 0 : 0;
        R.inject(a, performance.now());
        step(3);
        const after = g.spawnedKind ? g.spawnedKind[k] | 0 : 0;
        spawnOk.push(after > before ? 1 : 0);
      }

      // 스킬 3종 — 각각 실제로 발동하는가.
      // **포탑 시험보다 먼저 한다.** 포탑 시험은 12초를 돌리는데 그 사이에 판이
      // 끝나면 state=OVER 가 되고, 그러면 입력이 전부 "재시작"으로 먹힌다.
      const skillOk = [-1, -1, -1];
      const SK = ['TIDE', 'VOLLEY', 'RALLY'];
      for (let i = 0; i < 3; i++) {
        if (typeof A[SK[i]] !== 'number') continue;
        if (g.state !== 0) { g.reset(); unbrief(); }   // 판이 끝나 있으면 입력이 재시작으로 먹힌다
        g.gold = C.GOLD_CAP;
        if (g.skillCd && g.skillCd.length > i) g.skillCd[i] = 0;
        const before = skillSeen[i];
        const aliveBefore = g.aliveL;
        R.inject(A[SK[i]], performance.now());
        step(3);
        // EV.SKILL 이 오면 확실하고, 증원은 병력 증가로도 확인된다
        skillOk[i] = (skillSeen[i] > before || (i === 2 && g.aliveL > aliveBefore)) ? 1 : 0;
      }

      // 포탑 — 최대 단계까지 올라가는가, 그리고 실제로 쏘는가
      let towerLv = -1, towerFire = -1;
      if (typeof A.TOWER === 'number' && g.towerLv !== undefined) {
        if (g.state !== 0) { g.reset(); unbrief(); }
        for (let n = 0; n < 4; n++) {
          g.gold = C.GOLD_CAP;
          R.inject(A.TOWER, performance.now());
          step(3);
        }
        towerLv = g.towerLv | 0;
        // 사거리 **안에** 적을 세우고 쿨다운을 지나가게 한다.
        // 처음엔 적 진영에서 소환해 걸어오게 했더니 0회가 나왔다 — 앞선 시험에서
        // 남은 내 유닛과 중간에서 부딪혀 죽어 포탑 사거리에 아무도 못 들어왔다.
        // 그건 포탑이 고장난 게 아니라 시험이 고장난 것이다. 판을 비우고 세운다.
        for (let i = 0; i < g.uAlive.length; i++) if (g.uAlive[i]) g.uAlive[i] = 0;
        g.aliveL = 0; g.aliveR = 0;
        const f0 = seen[EVC.TOWER_FIRE] || 0;
        const rng = C.TOWER_RANGE || 300;
        for (let i = 0; i < 6; i++) {
          g.spawn(1, 0, 0);
          const idx = (g.uNext - 1 + C.UNIT_MAX) % C.UNIT_MAX;
          g.uX[idx] = C.BASE_L_X + rng * 0.6 + i * C.UNIT_GAP;
          g.uPrevX[idx] = g.uX[idx];
        }
        step(60 * 8);
        towerFire = (seen[EVC.TOWER_FIRE] || 0) - f0;
      }
      return { spawnOk, towerLv, towerFire, skillOk };
    }, [K, E]);
    await p.close();
    return r;
  }, null);

  // ── 6. 온보딩 — 첫 10초 / 첫 30초를 나눠 센다 ─────────────────
  // 계약 §4: **10초 안에 플레이어가 뭔가 부수거나 부서지는 것을 본다.**
  // 30초만 재면 "9초까지 아무 일도 없다가 25초에 몰아친다"를 통과시킨다.
  // 그래서 10초 스냅샷을 따로 뜬다. 두 창을 같은 한 판에서 뽑으므로
  // 10초 값은 30초 값의 부분집합이다 (다시 돌리지 않는다 = 비용 0).
  // 봇 하나로만 재면 "그 봇이 뭘 샀는가"를 잰 것이지 게임의 첫 10초가 아니다.
  // 원정 설계자의 하네스와 6.6초 vs 11.3초로 어긋난 적이 있는데, 원인이 바로
  // 봇 하나(counter)만 쓴 것이었다. 여러 봇으로 재고 **몇 봇이 10초 안에 봤는지**를 낸다.
  const ONBOARD_BOTS = ['counter', 'swarm', 'siege', 'cav'];
  report.onboardBots = !on('onboard') ? [] : await pool(ONBOARD_BOTS, 2, async (mode) =>
    guard(report, 'onboard:' + mode, async () => {
      const p = await page0();
      const v = await p.evaluate(async (m) => {
        const g = window.__rising.game;
        const firstAt = {}; const seen10 = {};
        const orig = g.emit.bind(g);
        g.emit = (t, a, b) => {
          if (firstAt[t] === undefined) firstAt[t] = +(g.tick / 60).toFixed(2);
          if (g.tick <= 600) seen10[t] = (seen10[t] || 0) + 1;
          orig(t, a, b);
        };
        for (let i = 0; i < 1800; i++) {
          if (i % 12 === 0) window.__play(m, 0);
          window.__clock.tick(1000 / 60);
          if (g.state === 2) break;
          if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
        }
        const kill = firstAt[2], hit = firstAt[3];
        const cand = [kill, hit].filter((x) => x !== undefined);
        return { mode: m, firstKill: kill === undefined ? -1 : kill,
                 firstBaseHit: hit === undefined ? -1 : hit,
                 firstDestroy: cand.length ? Math.min.apply(null, cand) : -1,
                 destroy10: (seen10[2] | 0) + (seen10[3] | 0),
                 spawn10: seen10[0] | 0 };
      }, mode);
      await p.close();
      return v;
    }, { mode, firstDestroy: -1, destroy10: -1, broken: true }));

  report.first30 = !on('onboard') ? { seen: {}, seen10: {}, firstAt: {} }
    : await guard(report, 'onboard', async () => {
    const p = await page0();
    const r = await p.evaluate(async () => {
      const g = window.__rising.game, C = window.__rising.C;
      const seen = {}, firstAt = {};
      let seen10 = null;
      // 설명 화면은 시뮬 시계를 멈춘다. 여기 카운트는 **전투 시작 이후**의 시계다.
      // 심사자가 보는 30초에는 설명 화면도 들어가므로 그 사실을 따로 낸다.
      const briefAtStart = g.state === 3;
      const briefMs = C.BRIEF_MS | 0;
      const orig = g.emit.bind(g);
      g.emit = (t, a, b) => {
        seen[t] = (seen[t] || 0) + 1;
        if (firstAt[t] === undefined) firstAt[t] = +(g.tick / 60).toFixed(1);
        orig(t, a, b);
      };
      for (let i = 0; i < 1800; i++) {
        if (i % 12 === 0) window.__play('counter', 0);
        window.__clock.tick(1000 / 60);
        if (i === 600) seen10 = Object.assign({}, seen);     // 10초 스냅샷
        if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
      }
      return { seen, seen10: seen10 || {}, firstAt, briefAtStart, briefMs,
               gold: g.gold | 0, era: g.era, spawned: g.spawned, kills: g.kills,
               // 판이 30초 안에 끝나 버렸는지도 봐야 한다 (state 2 = 결과 화면)
               ended: g.state === 2, stage: g.stage === undefined ? -1 : g.stage | 0 };
    });
    await p.close();
    return r;
  }, { seen: {}, seen10: {}, firstAt: {} });

  // ── 7. 디렉터가 장식인가 판단인가 ────────────────────────────
  // **프로파일을 직접 고정해서 잰다.** 봇의 분류에 의존하면 BALANCED(레버가
  // 원래 중립)만 나와 "레버가 아무것도 안 한다"는 틀린 결론이 나온다.
  // 유닛이 6종이 됐으므로 구성비도 6칸으로 센다 — 3칸으로 세면 기병·투석기가
  // 아무리 갈려도 지표에 안 잡힌다.
  for (const prof of (on('director') ? ['BALANCED', 'RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER'] : [])) {
    const r = await guard(report, 'director:' + prof, async () => {
      const p = await page0();
      const v = await p.evaluate(async (arg) => {
        const [prof, KK] = arg;
        const R = window.__rising, g = R.game, d = R.director;
        d.onChunkBoundary = function (game, ci) {
          this.difficulty = Math.max(0, Math.min(4, (game.simTime / 22000) | 0));
          // profileIdx 를 0(RUSHER)로 못 박아 두었던 것을 고쳤다. 레버는 prof 로
          // 도는데 드래프트 제시·대사는 RUSHER 로 도는 반쪽 상태였다.
          // director.js 의 PROFILES 순서가 계약이다.
          this.observing = false; this.profile = prof;
          this.profileIdx = Math.max(0, ['RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER', 'BALANCED'].indexOf(prof));
          this.applyLevers();
        };
        g.reset();
        if (g.state === 3 && g.dismissBrief) g.dismissBrief();
        const spawnKind = new Array(KK).fill(0);
        const orig = g.emit.bind(g);
        g.emit = (t, a, b) => { if (t === 0 && b === 1 && a < KK) spawnKind[a]++; orig(t, a, b); };
        for (let i = 0; i < 60 * 90; i++) {
          if (i % 12 === 0) window.__play('swarm', 0);
          window.__clock.tick(1000 / 60);
          if (g.state === 2) g.reset();
          if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
        }
        let tot = 0; for (let k = 0; k < KK; k++) tot += spawnKind[k];
        const mix = spawnKind.map((v2) => +(v2 / (tot || 1)).toFixed(3));
        return {
          profile: prof, total: tot, mix,
          mixLen: d.levers && d.levers.mix ? d.levers.mix.length : 0,
          tempo: Math.round(d.levers.tempo),
        };
      }, [prof, K]);
      await p.close();
      return v;
    }, { profile: prof, total: 0, mix: new Array(K).fill(0), mixLen: 0, tempo: -1 });
    report.director.push(r);
  }

  // ── 8. 버튼이 실제로 눌리는가 ────────────────────────────────
  // 계약은 버튼 10개다. 상수만 10이고 히트박스가 5개면 나머지는 없는 버튼이다.
  report.buttons = !on('buttons') ? { declared: -1, hit: -1, hits: [], rally: -1 }
    : await guard(report, 'buttons', async () => {
    const p = await page0();
    const r = await p.evaluate(() => {
      const R = window.__rising, C = R.C;
      const Rd = R.renderer.constructor;
      const hits = [];
      for (let i = 0; i < C.BTN_COUNT; i++) {
        const cx = C.BTN_X0 + i * (C.BTN_W + C.BTN_GAP) + C.BTN_W * 0.5;
        const cy = C.BTN_Y + C.BTN_H * 0.5;
        hits.push(Rd.hitButton ? Rd.hitButton(cx, cy) : -2);
      }
      let ok = 0;
      for (let i = 0; i < hits.length; i++) if (hits[i] === i) ok++;
      let rally = -1;
      if (typeof Rd.hitRally === 'function') {
        rally = Rd.hitRally(C.RALLY_CX, C.RALLY_CY) ? 1 : 0;
      }
      return { declared: C.BTN_COUNT | 0, hit: ok, hits, rally };
    });
    await p.close();
    return r;
  }, { declared: -1, hit: -1, hits: [], rally: -1 });

  // ── 9. 프레임 비용 ───────────────────────────────────────────
  report.perf = !on('perf') ? { avg: -1, p99: -1, max: -1, over16: -1, frames: 0 }
    : await guard(report, 'perf', async () => {
    const p = await page0();
    const r = await p.evaluate(async () => {
      const real = window.__clock.real;
      const N = 7200, times = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const t0 = real();
        if (i % 12 === 0) window.__play('swarm', 0);
        window.__clock.tick(1000 / 60);
        times[i] = real() - t0;
        if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
      }
      let sum = 0, over = 0, max = 0;
      for (let i = 0; i < N; i++) { sum += times[i]; if (times[i] > 16.7) over++; if (times[i] > max) max = times[i]; }
      const sorted = Float64Array.from(times).sort();
      return { avg: +(sum / N).toFixed(4), p99: +sorted[(N * 0.99) | 0].toFixed(3),
               max: +max.toFixed(1), over16: over, frames: N };
    });
    await p.close();
    return r;
  }, { avg: -1, p99: -1, max: -1, over16: -1, frames: 0 });

  // ── 10. 원정 (spec-v3 §2) ────────────────────────────────────
  // **미구현이면 0점이 아니라 -1이다.** game.js 에 stage/nextStage 가 없으면
  // 여기서 바로 접고 그 사실만 보고한다 — 없는 기능을 재는 척하지 않는다.
  //
  // 재는 것: 완주율 · 스테이지별 승률(곡선이 오르는가) · 첫 전투 길이(40~60초)
  //          도발 발생률과 시점 · 원정 총 길이 · **승계 규칙**
  // 승계 규칙(§2)은 계약이다: 특성·포탑은 유지, 금·시대·병력은 초기화.
  // 이걸 안 재면 "다음 전투가 그냥 리셋"인 것을 못 잡는다.
  const CAMP_BOTS = [
    { name: 'counter', arche: 'counter', pref: 0 },
    { name: '도배검', gap: { pick: 'spam', k: 0 } },   // 무뇌 도배 — 3전투 안에 져야 한다
    { name: 'swarm', arche: 'swarm', pref: 0 },
    { name: 'cav', arche: 'cav', pref: 0 },
    { name: 'siege', arche: 'siege', pref: 0 },
    { name: 'idle', arche: 'idle', pref: 1 },          // 대조군
    { name: 'tower', arche: 'tower', pref: 1 },
    { name: 'skill', arche: 'skill', pref: 0 },
    { name: 'econ', arche: 'econ', pref: 2 },
  ];
  const CAMP_DROP = ['skill', 'tower', 'econ', 'siege', 'cav'];   // 예산 부족 시 이 순서로 버린다
  // 상한 이력 — **이것 때문에 두 번 틀린 결론이 나왔다.**
  //   2.5분(틱) → stage 1 이 138초에서 잘려 전부 "미결". 끝날 판을 안 끝났다고 했다
  //   3.5분(틱) → 후반 전투가 200~290초라 여전히 잘렸다
  // 그리고 **틱과 시뮬초는 1:1 이 아니다** (히트스톱이 step 을 건너뛴다. 9000틱 ≈ 138초).
  // 그래서 이제 상한을 **시뮬 초**로 건다. 틱 상한은 시뮬이 얼어붙었을 때의 안전장치일 뿐이다.
  const CAP_STAGE_SEC = 300;       // 한 전투 300 시뮬초
  const CAP_TOTAL_SEC = 900;       // 원정 전체 900 시뮬초
  const CAP_STAGE = 60 * 420;      // 안전장치(틱)
  const CAP_TOTAL = 60 * 1300;     // 안전장치(틱)

  report.campaign = { supported: false, reason: '', runs: [] };
  if (!on('campaign')) {
    report.campaign.reason = '구간 제외(--sections)';
  } else if (!CAMP_OK) {
    report.campaign.reason = '원정 API 미구현 — game.stage/stageMax/campaignOver/nextStage() 가 없다';
  } else {
    let bots = CAMP_BOTS.slice();
    // 예산 안에 안 들어가면 표본을 줄인다. **줄인 사실을 출력에 남긴다.**
    for (const d of CAMP_DROP) {
      const worst = bots.length * CAP_TOTAL_SEC * 60;
      if (estMs(worst, 0.40) < remainMs() * 0.50) break;
      bots = bots.filter((b) => b.name !== d);
      note('원정 표본 축소: ' + d + ' 봇을 뺐다 (남은 예산 ' + Math.round(remainMs() / 1000) + '초)');
    }
    const runs = await pool(bots, 3, async (bot) => guard(report, 'campaign:' + bot.name, async () => {
      const p = await page0();
      const v = await p.evaluate(async (arg) => {
        const [bot, EVC, caps] = arg;
        const R = window.__rising;
        let g = R.game;
        const play = bot.gap ? () => window.__playGap(bot.gap)
                             : () => window.__play(bot.arche, bot.pref);
        const snap = (gm) => {
          let tr = 0;
          if (gm.traits) for (let i = 0; i < gm.traits.length; i++) if (gm.traits[i]) tr++;
          return { traits: tr, tower: gm.towerLv | 0, gold: gm.gold | 0, era: gm.era | 0,
                   alive: (gm.aliveL | 0) + (gm.aliveR | 0), hp: gm.baseHp ? gm.baseHp[0] | 0 : -1 };
        };
        const goldStart = R.C.GOLD_START | 0;
        const ev = Object.create(null);
        const taunts = [];
        let endEv = null, curStage = 0, profSwitches = 0, lastProf = R.director ? R.director.profile : '?';
        const hooked = new WeakSet();
        const hook = (gm) => {
          if (hooked.has(gm)) return;
          hooked.add(gm);
          const orig = gm.emit.bind(gm);
          gm.emit = (t, a, b) => {
            ev[t] = (ev[t] || 0) + 1;
            if (t === EVC.TAUNT) {
              taunts.push({ stage: curStage, sec: +(totalTicks / 60).toFixed(1),
                            cmd: a | 0, prof: b | 0,
                            dprof: R.director ? R.director.profile : '?' });
            }
            if (t === EVC.CAMPAIGN_END) endEv = { a: a | 0, b: b | 0 };
            orig(t, a, b);
          };
        };
        let totalTicks = 0;
        hook(g);
        // 설명 화면(S.BRIEF)은 봇마다 닫는 시점이 달라진다 (idle 은 아예 안 닫는다).
        // 여기서 일괄로 닫아 모든 봇을 같은 줄에서 출발시킨다.
        // 전투 시간은 elapsed() 로 재므로 설명 시간은 어차피 안 들어간다.
        if (g.state === 3 && g.dismissBrief) g.dismissBrief();

        const stages = [];
        let aborted = '';
        let campSecBase = 0;                     // 앞선 전투들의 시뮬초 합
        const startStage = g.stage | 0;
        const stageMax = Math.max(1, Math.min(12, g.stageMax | 0));
        for (let s = 0; s < stageMax; s++) {
          if (R.game !== g) { g = R.game; hook(g); }       // 인스턴스가 바뀌면 다시 건다
          curStage = g.stage | 0;
          const cmd = g.commander === undefined ? -1 : g.commander | 0;
          const evS0 = { start: ev[EVC.STAGE_START] || 0, clear: ev[EVC.STAGE_CLEAR] || 0 };
          let ticks = 0;
          let campSec = campSecBase;
          while (ticks < caps.stage && totalTicks < caps.total
                 && (typeof g.elapsed !== 'function' || g.elapsed() < caps.stageSec)
                 && campSec < caps.totalSec) {
            if (ticks % 12 === 0) {
              play();
              if (typeof g.elapsed === 'function') campSec = campSecBase + g.elapsed();
            }
            window.__clock.tick(1000 / 60);
            ticks++; totalTicks++;
            if (g.state === 2) break;
            // 판정 변화는 9초(=540틱) 구간마다 일어난다. 600틱마다 보면 놓친다.
            if (totalTicks % 60 === 0) {
              const np = R.director ? R.director.profile : '?';
              if (np !== lastProf) { profSwitches++; lastProf = np; }
            }
            if (totalTicks % 600 === 0) await new Promise((x) => setTimeout(x, 0));
          }
          const rec = {
            stage: curStage, commander: cmd,
            // **elapsed() 를 쓴다.** 틱을 세면 설명 화면(BRIEF)처럼 시뮬이 멈추는
            // 구간까지 전투 시간에 넣게 된다 — 첫 전투 40~60초 판정이 그만큼 틀어진다.
            seconds: +(typeof g.elapsed === 'function' ? g.elapsed() : ticks / 60).toFixed(1),
            ticks,
            outcome: g.state === 2 ? g.outcome : -1,
            // 무엇이 판을 끝냈는가. 0=아직 1=병력 2=물. **미결과 패배를 가르는 근거다.**
            downBy: g.baseDownBy ? [g.baseDownBy[0] | 0, g.baseDownBy[1] | 0] : [0, 0],
            myHp: g.baseHp ? g.baseHp[0] | 0 : -1, foeHp: g.baseHp ? g.baseHp[1] | 0 : -1,
            taunts: taunts.filter((x) => x.stage === curStage).length,
            evStart: (ev[EVC.STAGE_START] || 0) - evS0.start,
            evClear: (ev[EVC.STAGE_CLEAR] || 0) - evS0.clear,
            carry: null,
          };
          stages.push(rec);
          campSecBase += rec.seconds;
          if (rec.outcome !== 1) break;                    // 졌거나 안 끝났으면 원정 종료
          if (g.campaignOver) break;                       // 마지막 전투를 이겼다
          const pre = snap(g);
          try { g.nextStage(); } catch (e) { aborted = 'nextStage() 예외: ' + e.message; break; }
          for (let i = 0; i < 30 && g.state === 2; i++) { window.__clock.tick(1000 / 60); totalTicks++; }
          const post = snap(g);
          rec.carry = { pre, post, goldStart, stagePost: g.stage | 0, statePost: g.state | 0 };
          if (g.state !== 0) { aborted = 'nextStage() 후에도 PLAY 로 안 돌아온다 (state ' + g.state + ')'; break; }
          if ((g.stage | 0) !== curStage + 1) { aborted = 'nextStage() 가 stage 를 안 올렸다 (' + curStage + '→' + g.stage + ')'; break; }
          if (campSecBase >= caps.totalSec) { aborted = '원정 전체 시간 상한 ' + caps.totalSec + '시뮬초 초과'; break; }
          if (totalTicks >= caps.total) { aborted = '틱 안전장치 ' + (caps.total / 60) + '초 초과'; break; }
        }
        const cleared = stages.filter((x) => x.outcome === 1).length;
        return {
          supported: true, name: bot.name, startStage, stageMax, stages, cleared,
          clearedSelf: g.stagesCleared === undefined ? -1 : g.stagesCleared | 0,
          completed: cleared >= stageMax ? 1 : 0,
          // 원정 총 길이는 게임이 세는 값을 우선한다 (전투 시간의 합. 결과 화면 대기는 뺀다)
          totalSeconds: +(typeof g.campaignTime === 'function'
            ? g.campaignTime() : totalTicks / 60).toFixed(1),
          wallTicks: totalTicks, totalTicks,
          campaignOver: !!g.campaignOver, aborted,
          taunts, tauntTotal: taunts.length, profSwitches,
          evTaunt: ev[EVC.TAUNT] || 0, evStageStart: ev[EVC.STAGE_START] || 0,
          evStageClear: ev[EVC.STAGE_CLEAR] || 0, evCampEnd: ev[EVC.CAMPAIGN_END] || 0,
          endEv,
        };
      }, [bot, E, { stage: CAP_STAGE, total: CAP_TOTAL,
                    stageSec: CAP_STAGE_SEC, totalSec: CAP_TOTAL_SEC }]);
      await p.close();
      return v;
    }, { supported: true, name: bot.name, broken: true, stages: [], cleared: -1, completed: -1,
         totalSeconds: -1, taunts: [], tauntTotal: -1 }));
    report.campaign = { supported: true, reason: '', runs: runs.filter(Boolean) };
    if (bots.length < CAMP_BOTS.length) report.campaign.sampled = bots.length + '/' + CAMP_BOTS.length;
  }

  // ── 11. 난이도 격차 — 상성 봇 vs 도배 봇 vs 무작위 봇 ────────────
  // 이번 계측의 핵심이다. 기존 [3] 결투는 "상성 배수가 도는가"만 본다.
  // 여기서 보는 것은 **"상성을 아는 플레이어가 실제로 더 잘하는가"** 다.
  //
  // 설계 — 세 봇의 껍데기는 완전히 같고 **유닛 선택만 다르다**:
  //   상성  적 구성을 읽고 상성표에서 금 대비 우위가 큰 유닛
  //   도배  한 종류만 계속. 검(가장 싸다) · 궁(사거리 우위) 둘로 상·하한을 잡는다
  //   무작위 시드 고정 난수로 여섯 종을 섞는다  ← **결정적 대조군**
  //
  // 무작위 봇이 중요하다. 상성 봇이 도배 봇을 이겨도 무작위 봇도 똑같이 이기면
  // 그건 "상성을 알아서"가 아니라 "한 종류만 쓰면 진다"일 뿐이다.
  // 상성이 실력이려면 **상성 > 무작위 > 도배** 순서가 나와야 한다.
  //
  // 상대 축: 원정이 있으면 **다섯 사령관 전투를 직접 차려서** 붙인다
  // (stage 를 세우고 resetBattle()). 없으면 디렉터 프로파일을 고정해 대역을 만든다.
  // 어느 쪽이든 **모든 봇이 정확히 같은 상대**를 만난다 — 그래야 차이가 봇의 것이다.
  // 다섯 봇 전부 **같은 규율**을 쓴다: 목표를 정하고 살 수 있을 때까지 기다린다.
  // 다른 것은 목표를 고르는 규칙 하나뿐이다.
  //   상성      적 구성에 가장 세게 먹히는 종
  //   상성가성비 그 배수를 가격으로 나눈 것 — 사실상 싼 유닛 쪽으로 쏠린다
  //   도배궁    한 종만 (검보다 강한 쪽으로 잡았다. 약한 도배와 비교하면 격차가 부풀려진다)
  //   순환      여섯 종 균등 — **상성 지식 없는 다양성.** 상성과의 차이가 곧 "상성을 안다"의 값이다
  //   무작위    시드 고정 난수
  const GAP_BOTS = [
    { name: '상성', spec: { pick: 'counter' } },
    { name: '상성가성비', spec: { pick: 'counterGold' } },
    { name: '도배궁', spec: { pick: 'spam', k: 2 } },
    { name: '순환', spec: { pick: 'cycle' } },
    { name: '무작위', spec: { pick: 'rand', seed: 20260802 } },
  ];
  const GAP_BOT_DROP = ['무작위', '상성가성비'];   // 예산 부족 시 이 순서로 버린다
  const GAP_FOES = CAMP_OK
    ? ['S0', 'S1', 'S2', 'S3', 'S4']                      // 사령관 다섯 (실제 전투 조건)
    : ['AUTO', 'SWARMER', 'RUSHER', 'TURTLE', 'ECONOMIST', 'BALANCED'];
  const CAP_GAP_SEC = 300;         // 한 판 300 시뮬초. 원정 구간과 같은 자로 잰다
  const CAP_GAP = 60 * 420;        // 안전장치(틱)

  report.gap = { rows: [], foes: [], bots: [], cap: CAP_GAP_SEC };
  if (on('gap')) {
    let foes = GAP_FOES.slice();
    let gbots = GAP_BOTS.slice();
    // 예산이 모자라면 **봇을 먼저 버리고 상대를 나중에 버린다.**
    // 상대(사령관 다섯)를 줄이면 난이도 곡선을 못 보게 되는데, 그게 지금 제일 궁금한 것이다.
    for (;;) {
      const worst = foes.length * gbots.length * CAP_GAP_SEC * 60;
      // (estMs 에 계수를 안 넘겨 NaN 이 나오는 바람에 상대를 5→2 로 깎은 적이 있다.
      //  표본이 조용히 줄면 격차가 0 으로 뭉개진다 — 계측기가 자기 발등을 찍은 경우다)
      if (estMs(worst, 0.45) < remainMs() * 0.85) break;
      const dropBot = GAP_BOT_DROP.find((n) => gbots.some((b) => b.name === n));
      if (dropBot) {
        gbots = gbots.filter((b) => b.name !== dropBot);
        note('격차 하네스 표본 축소: 봇 ' + dropBot + ' 를 뺐다 (남은 예산 ' +
             Math.round(remainMs() / 1000) + '초)');
        continue;
      }
      if (foes.length <= 3) break;
      const dropped = foes.pop();
      note('격차 하네스 표본 축소: 상대 ' + dropped + ' 를 뺐다 — 난이도 곡선 뒷부분을 못 본다 (남은 예산 ' +
           Math.round(remainMs() / 1000) + '초)');
    }
    const jobs = [];
    for (const foe of foes) for (const b of gbots) jobs.push({ foe, bot: b });
    const rows = await pool(jobs, 3, async (job) => guard(report, 'gap:' + job.foe + ':' + job.bot.name, async () => {
      const p = await page0();
      const v = await p.evaluate(async (arg) => {
        const [foe, spec, EVC, cap, capSec] = arg;
        const R = window.__rising, g = R.game, d = R.director;
        const PROFILES = ['RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER', 'BALANCED'];
        const KK = R.C.UNIT_KINDS | 0;
        const ev = Object.create(null);
        const orig = g.emit.bind(g);
        g.emit = (t, a, b) => { ev[t] = (ev[t] || 0) + 1; orig(t, a, b); };

        // ── 상대를 세운다. **reset 은 여기서 끝난다** ──
        // (예전에 여기서 세운 뒤 아래에서 또 reset() 을 불러 stage 가 0으로 돌아간 적이 있다.
        //  그러면 다섯 상대가 전부 같은 상대가 되고, 격차 0 이 나온다 — 계측기가 거짓말한 것이다)
        // S<n> = n 번째 전투를 직접 차린다. 게임 코드를 고치지 않고 인스턴스 위에서만
        // stage 를 세우고 resetBattle() 을 부른다 (결투 하네스의 isolate 와 같은 급).
        // **특성·포탑 승계는 없다.** 봇 간 비교용 조건이지 실제 원정 승률이 아니다.
        // **주입이 실패하면 예외를 던진다.** 조용히 넘어가면 다섯 상대가 전부
        // 같은 상대가 되고, 그 결과는 "차이 없음"이 된다 — 이 저장소에서 실제로
        // 절제 패치가 조용히 빗나가 "차이 없음"을 낸 적이 있다. 실패는 소리를 내야 한다.
        let forced = 0;
        g.reset();
        if (foe.charAt(0) === 'S' && foe.length === 2) {
          const sIdx = +foe.charAt(1);
          if (typeof g.resetBattle !== 'function' || g.stage === undefined) {
            throw new Error('stage 강제 불가: resetBattle()/stage 가 없다 (상대 축이 성립하지 않는다)');
          }
          g.stage = sIdx;
          g.resetBattle();
          if ((g.stage | 0) !== sIdx) throw new Error('stage 강제 실패: ' + sIdx + ' 로 세웠는데 ' + g.stage);
          if (g.commander === undefined) throw new Error('commander 가 없다 — 사령관 축이 성립하지 않는다');
          forced = 2;
        } else if (foe !== 'AUTO' && d && typeof d.applyLevers === 'function') {
          d.onChunkBoundary = function (game, ci) {
            this.difficulty = Math.max(0, Math.min(4, (game.simTime / 22000) | 0));
            this.observing = false; this.profile = foe;
            this.profileIdx = Math.max(0, PROFILES.indexOf(foe));
            this.applyLevers();
          };
          forced = 1;
        }
        // 설명 화면을 먼저 닫는다 — 봇마다 첫 입력이 삼켜지는 시점이 달라지면
        // 그 차이가 격차로 잡힌다. 모든 봇을 같은 줄에서 출발시킨다.
        if (g.state === 3 && g.dismissBrief) g.dismissBrief();
        let i = 0;
        for (; i < cap; i++) {
          if (i % 12 === 0) {
            window.__playGap(spec);
            // 상한은 **시뮬 초**로 건다. 틱은 히트스톱 때문에 시뮬초와 1:1 이 아니다
            if (typeof g.elapsed === 'function' && g.elapsed() >= capSec) break;
          }
          window.__clock.tick(1000 / 60);
          if (g.state === 2) break;
          if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
        }
        const mix = new Array(KK).fill(0);
        let tot = 0;
        for (let k = 0; k < KK; k++) { const v2 = g.spawnedKind ? g.spawnedKind[k] | 0 : 0; mix[k] = v2; tot += v2; }
        return {
          forced, stage: g.stage === undefined ? -1 : g.stage | 0,
          commander: g.commander === undefined ? -1 : g.commander | 0,
          seconds: +(typeof g.elapsed === 'function' ? g.elapsed() : i / 60).toFixed(0),
          outcome: g.state === 2 ? g.outcome : -1,
          myHp: g.baseHp[0] | 0, foeHp: g.baseHp[1] | 0,
          // **baseK() 를 쓴다.** ERA_BASE_HP_MUL 때문에 baseMax 가 판 도중 늘어나
          // 절대 체력 차이는 판마다 스케일이 다르다 (부록 A). 비율로 재야 비교된다.
          // 승패는 6표본이라 거칠다 — 이 연속값이 격차의 세밀한 증거다.
          hpMargin: +((g.baseK ? g.baseK(0) : 0) - (g.baseK ? g.baseK(1) : 0)).toFixed(3),
          era: g.era | 0, kills: g.kills | 0, lost: g.lost | 0,
          mix, mixTotal: tot,
          counterHit: ev[EVC.COUNTER_HIT] || 0, attacks: ev[EVC.ATTACK] || 0,
          profile: d ? d.profile : '?',
        };
      }, [job.foe, job.bot.spec, E, CAP_GAP, CAP_GAP_SEC]);
      await p.close();
      return Object.assign({ foe: job.foe, bot: job.bot.name }, v);
    }, { foe: job.foe, bot: job.bot.name, outcome: -1, seconds: -1, broken: true }));
    report.gap = { rows: rows.filter(Boolean), foes, bots: gbots.map((b) => b.name), cap: CAP_GAP_SEC };
  }

  await browser.close();
  server.close();
  report.provenance.end = provenance();
  report.provenance.changedDuringRun = drift(report.provenance.start, report.provenance.end);
  report.wallMs = Date.now() - T_START;
  report.load.end = +os.loadavg()[0].toFixed(2);

  // ══ 파생 판정 — 루프가 이 값들을 보고 다음 수정을 정한다 ═══════
  //
  // 지표를 느슨하게 만들어 통과시키지 않는다. 반대다 — 더 잡아내야 한다.
  // 그러나 **없는 기능을 0점으로 재는 것도 거짓말이다.** 미구현은 -1로 낸다.
  const M = report.matches.filter(Boolean);
  const done = M.filter((m) => m.outcome > 0 || m.outcome === 0 || m.outcome === 3);

  const unresolved = M.filter((m) => m.outcome < 0).length;
  const draws = M.filter((m) => m.outcome === 3).length;
  const wins = M.filter((m) => m.outcome === 1).length;
  const lengths = M.filter((m) => m.outcome > 0).map((m) => m.seconds);
  const avgLen = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;

  // (a) 결말 × 판길이 60초 버킷 — 1회차에 고친 지표. 키를 유지한다.
  //     "서로 다른 결말"만 세면 무승부를 없앤 개선이 후퇴로 잡힌다.
  const outcomes = new Set(M.map((m) => m.outcome + ':' + Math.floor(m.seconds / 60)));

  // (b) **6유닛 구성 거리** — 새 지표.
  //     결말이 갈려도 여덟 봇이 전부 검사만 뽑고 있으면 그건 6유닛 게임이 아니다.
  //     정규화한 구성 벡터끼리 L1/2 (0~1) 평균 거리를 낸다. 0.5 면 절반이 다르다.
  //     결말 종류를 세는 것보다 **속이기 어렵다** — 이기는 법이 하나뿐이면 0에 붙는다.
  const vecs = M.filter((m) => m.mixTotal > 0).map((m) => m.mix.map((v) => v / m.mixTotal));
  let distSum = 0, distN = 0, distMax = 0;
  for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) {
    let d = 0;
    for (let k = 0; k < vecs[i].length; k++) d += Math.abs(vecs[i][k] - vecs[j][k]);
    d *= 0.5;
    distSum += d; distN++; if (d > distMax) distMax = d;
  }
  const mixDist = distN ? +(distSum / distN).toFixed(3) : -1;

  // (c) 이기는 법이 몇 가지인가. 전부 이기면 선택이 없고, 아무도 못 이기면 못 이긴다.
  //     idle(대조군)이 이기면 그건 전략 게임이 아니다.
  const idle = M.find((m) => m.mode === 'idle');
  const idleWin = idle ? (idle.outcome === 1 ? 1 : 0) : -1;

  // (d) 새 요소가 죽어 있는가 — 능력(낼 수 있는가)과 실사용(판에서 나오는가)을 나눈다
  const U = report.usage;
  const spawnAble = U && U.spawnOk ? U.spawnOk.filter((v) => v === 1).length : -1;
  const skillAble = U && U.skillOk ? U.skillOk.filter((v) => v === 1).length : -1;
  const towerAble = U ? U.towerLv : -1;
  const towerFireAble = U ? U.towerFire : -1;

  const usedKinds = (() => {
    if (!M.length || !M[0].mix) return -1;
    const acc = new Array(K).fill(0);
    for (const m of M) if (m.mix) for (let k = 0; k < K; k++) acc[k] += m.mix[k];
    return acc.filter((v) => v > 0).length;
  })();
  const skillUseTotal = M.reduce((a, m) => a + (m.skillTotal || 0), 0);
  const skillKindsUsed = (() => {
    const acc = [0, 0, 0];
    for (const m of M) if (m.skillUse) for (let i = 0; i < 3; i++) acc[i] += m.skillUse[i];
    return acc.filter((v) => v > 0).length;
  })();
  const towerBuiltRuns = M.filter((m) => (m.towerLv | 0) > 0).length;
  const towerFireTotal = M.reduce((a, m) => a + (m.towerFire || 0), 0);

  // (e) 상성 — 발생 빈도와 삼각형 성립을 따로 낸다.
  //     빈도만 보면 "곱해지긴 하는데 아무것도 안 바뀌는" 상태를 통과시킨다.
  const atkTot = M.reduce((a, m) => a + (m.attacks || 0), 0);
  const cHit = M.reduce((a, m) => a + (m.counterHit || 0), 0);
  const counterRate = atkTot > 0 ? +(cHit / atkTot * 100).toFixed(2) : -1;
  const cp = report.counter && report.counter.supported ? report.counter.pairs : null;
  const triEven = cp ? cp.filter((x) => x.evenWin).length : -1;
  const triGold = cp ? cp.filter((x) => x.goldWin).length : -1;
  const counterBot = M.find((m) => m.mode === 'counter');
  const counterBotWin = counterBot ? (counterBot.outcome === 1 ? 1 : 0) : -1;

  // (f) 디렉터 구성 분화 — 6칸으로 센다
  const mixSig = new Set(report.director.map((d) => (d.mix || []).map((v) => Math.round(v * 10)).join(',')));

  // (g) 미구현 API 개수. 0 이 아니면 위의 여러 숫자가 -1 인 이유가 여기 있다.
  const missingApi = (IMPL.missingAct ? IMPL.missingAct.length : -1);

  // ── (h) 원정 (v3) ────────────────────────────────────────────
  // 미구현이면 전부 -1. **0 으로 내면 "돌렸는데 아무도 완주 못 했다"로 읽힌다.**
  const CR = (report.campaign && report.campaign.supported)
    ? report.campaign.runs.filter((r) => r && r.supported && !r.broken) : [];
  const arche = CR.filter((r) => r.name !== '도배검');
  const med = (a) => {
    if (!a.length) return -1;
    const s = a.slice().sort((x, y) => x - y);
    return +(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1);
  };
  const campDone = arche.filter((r) => r.completed === 1).length;
  const campRate = arche.length ? +(campDone / arche.length * 100).toFixed(1) : -1;
  const clearedAvg = arche.length
    ? +(arche.reduce((a, r) => a + r.cleared, 0) / arche.length).toFixed(2) : -1;

  // 스테이지별 승률 — 도달한 봇 중 몇이 이겼는가. 뒤가 더 어려워야 한다.
  // **미결(상한에 걸려 잘림)과 패배를 절대 섞지 않는다.** 섞으면 난이도가
  // 실제보다 어려워 보이고, 그 위에서 밸런스를 만지면 반대 방향으로 간다.
  const stageWin = [];
  if (CR.length) {
    const SM = CR[0].stageMax | 0;
    for (let s = 0; s < SM; s++) {
      let reach = 0, win = 0, lose = 0, unres = 0; const secs = [];
      for (const r of arche) {
        const rec = r.stages.find((x) => x.stage === s);
        if (!rec) continue;
        reach++;
        if (rec.outcome === 1) win++;
        else if (rec.outcome === -1) unres++;
        else lose++;
        if (rec.outcome !== -1) secs.push(rec.seconds);
      }
      const resolved = win + lose;
      stageWin.push({ stage: s, reach, win, lose, unres, resolved,
                      rate: resolved ? +(win / resolved * 100).toFixed(0) : -1, sec: med(secs) });
    }
  }
  const unresTotal = CR.reduce((a, r) => a + r.stages.filter((x) => x.outcome === -1).length, 0);
  // 결판 원인 — 병력이 부순 것과 물이 삼킨 것은 다른 게임이다
  const cause = { 병력: 0, 물: 0, 무승부: 0, 미결: 0 };
  for (const r of CR) for (const st of r.stages) {
    if (st.outcome === -1) { cause.미결++; continue; }
    if (st.outcome === 3) { cause.무승부++; continue; }
    const loser = st.outcome === 1 ? 1 : 0;
    const by = st.downBy ? st.downBy[loser] : 0;
    if (by === 2) cause.물++; else cause.병력++;
  }
  // 곡선이 오르는가 = 뒤 스테이지 승률이 앞보다 높지 않은가 (도달 2 이상인 구간만)
  // 곡선 판정은 **결말이 난 판만** 쓴다. 미결을 패배로 세면 뒤 스테이지가
  // 자동으로 어려워 보여 이 판정이 항상 ○ 가 된다 — 아무것도 안 재는 지표가 된다.
  const curveOk = (() => {
    const pts = stageWin.filter((x) => x.resolved >= 2).map((x) => x.rate);
    if (pts.length < 2) return -1;
    for (let i = 1; i < pts.length; i++) if (pts[i] > pts[0]) return 0;
    return 1;
  })();
  // 첫 전투 길이 — **이긴 전투만** 센다. 계약 §4 의 40~60초는 "가르치는 전투를
  // 이기는 데 걸리는 시간"이다. 상한에 걸려 안 끝난 판(미결)을 섞으면 그냥 상한값을
  // 재게 되고, 29초에 무너진 대조군(idle)을 섞으면 목표가 아래로 끌려간다.
  const st0 = arche.map((r) => r.stages[0]).filter(Boolean);
  const firstStageSec = med(st0.filter((s) => s.outcome === 1).map((s) => s.seconds));
  const firstStageAll = med(st0.filter((s) => s.outcome !== -1).map((s) => s.seconds));
  const firstStageUnres = st0.filter((s) => s.outcome === -1).length;
  const campMinutes = arche.length
    ? med(arche.filter((r) => r.completed === 1).map((r) => +(r.totalSeconds / 60).toFixed(2))) : -1;
  const tauntRuns = CR.filter((r) => r.tauntTotal > 0).length;
  const tauntTotal = CR.reduce((a, r) => a + (r.tauntTotal || 0), 0);
  const tauntSecs = CR.reduce((a, r) => a + (r.totalSeconds || 0), 0);
  const tauntPerMin = CR.length && tauntSecs > 0 ? +(tauntTotal / (tauntSecs / 60)).toFixed(2) : -1;
  const tauntFirst = (() => {
    const f = CR.map((r) => (r.taunts && r.taunts.length ? r.taunts[0].sec : null)).filter((v) => v !== null);
    return f.length ? med(f) : -1;
  })();
  // 승계 규칙 (§2): 특성·포탑 유지 / 금·시대·병력 초기화. 위반 건수를 센다.
  const carryBad = [];
  for (const r of CR) for (const st of r.stages) {
    const c = st.carry;
    if (!c) continue;
    if (c.post.traits < c.pre.traits) carryBad.push(r.name + ' s' + st.stage + ': 특성이 사라졌다 ' + c.pre.traits + '→' + c.post.traits);
    if (c.post.tower < c.pre.tower) carryBad.push(r.name + ' s' + st.stage + ': 포탑 단계가 내려갔다 ' + c.pre.tower + '→' + c.post.tower);
    if (c.post.era !== 0) carryBad.push(r.name + ' s' + st.stage + ': 시대가 초기화되지 않았다 (' + c.post.era + ')');
    if (c.post.alive !== 0) carryBad.push(r.name + ' s' + st.stage + ': 병력이 남았다 (' + c.post.alive + ')');
    if (c.goldStart !== undefined && c.post.gold !== c.goldStart) {
      carryBad.push(r.name + ' s' + st.stage + ': 금이 초기화되지 않았다 (' + c.post.gold + ' ≠ GOLD_START ' + c.goldStart + ')');
    }
  }
  const campAborted = CR.filter((r) => r.aborted).length;
  const spamRun = CR.find((r) => r.name === '도배검');
  const spamSurvive = spamRun ? spamRun.cleared : -1;   // 목표: 2 이하 (3전투 안에 패배)
  const campSupported = report.campaign && report.campaign.supported;

  // ── (i) 난이도 격차 — 상성 vs 도배 vs 무작위 ────────────────────
  const GR = report.gap ? report.gap.rows.filter((r) => r && !r.broken) : [];
  const byBot = {};
  for (const r of GR) {
    const b = byBot[r.bot] || (byBot[r.bot] = { n: 0, win: 0, margin: 0, sec: 0, cHit: 0, atk: 0 });
    b.n++; if (r.outcome === 1) b.win++;
    b.margin += (typeof r.hpMargin === 'number' ? r.hpMargin : 0);
    b.sec += (r.seconds > 0 ? r.seconds : 0);
    b.cHit += r.counterHit || 0; b.atk += r.attacks || 0;
  }
  const botStat = Object.entries(byBot).map(([name, b]) => ({
    name, n: b.n, win: b.win,
    rate: b.n ? +(b.win / b.n * 100).toFixed(0) : -1,
    margin: b.n ? +(b.margin / b.n).toFixed(3) : -1,
    sec: b.n ? Math.round(b.sec / b.n) : -1,
    cRate: b.atk ? +(b.cHit / b.atk * 100).toFixed(2) : -1,
  }));
  const stat = (n) => botStat.find((x) => x.name === n);
  // 다양성 대조군 — 순환(균등)을 우선 쓰고 없으면 무작위.
  // **이 봇과의 차이가 "상성을 안다"의 순수한 값이다.** 도배와의 차이에는
  // "한 종류만 쓰면 진다"가 섞여 있어 상성의 값을 부풀린다.
  const sCounter = stat('상성');
  const sRand = stat('순환') || stat('무작위');
  const spams = botStat.filter((x) => x.name.startsWith('도배'));
  // **도배의 최고치**와 비교한다. 최약 도배와 비교하면 격차가 부풀려진다.
  const bestSpam = spams.length ? spams.reduce((a, b) => (b.rate > a.rate ||
      (b.rate === a.rate && b.margin > a.margin) ? b : a)) : null;
  const gapWin = (sCounter && bestSpam) ? sCounter.rate - bestSpam.rate : -1;
  const gapMargin = (sCounter && bestSpam) ? +(sCounter.margin - bestSpam.margin).toFixed(3) : -999;
  const gapRandWin = (sCounter && sRand) ? sCounter.rate - sRand.rate : -1;
  const gapRandMargin = (sCounter && sRand) ? +(sCounter.margin - sRand.margin).toFixed(3) : -999;

  report.verdict = {
    // ── 기존 키 (자동 개선 루프의 우선순위 목록이 읽는다. 이름을 바꾸지 않는다) ──
    끝나지_않은_판: unresolved,
    서로_다른_결말: outcomes.size,
    무승부: draws,
    평균_판_길이_초: avgLen,
    디렉터_구성_분화: mixSig.size,
    콘솔_에러경고: report.console.length,
    프레임_초과: report.perf ? report.perf.over16 : -1,
    // ── v2 신규 ──
    미구현_API: missingApi,
    유닛_소환_가능_종수: spawnAble,      // 능력. 목표 6
    유닛_실사용_종수: usedKinds,          // 실사용. 목표 6
    전략_구성_거리: mixDist,              // 0~1. 목표 ≥0.35
    승리한_전략_수: wins,                 // 목표 2~6 (8봇 중)
    대조군_idle_승리: idleWin,            // 목표 0
    포탑_최대단계: towerAble,             // 능력. 목표 2
    포탑_건설_판수: towerBuiltRuns,       // 실사용. 목표 ≥1
    포탑_사격_횟수: towerFireTotal,       // 실사용. 목표 ≥1
    스킬_발동_가능_종수: skillAble,        // 능력. 목표 3
    스킬_실사용_종수: skillKindsUsed,      // 실사용. 목표 3
    스킬_총_사용: skillUseTotal,
    상성_타격_비율_퍼센트: counterRate,    // 목표 ≥3
    상성_삼각형_동수: triEven,            // 6변 중 몇 변이 성립하는가. 목표 6
    상성_삼각형_동금: triGold,            // 같은 금액으로도 이기는가. 목표 ≥5
    상성봇_승리: counterBotWin,
    버튼_적중: report.buttons ? report.buttons.hit : -1,   // 목표 = BTN_COUNT
    계측_실패_구간: report.errors.length,
    // ── v3 신규 · 원정 (§2·§4). 미구현이면 전부 -1 ──
    원정_구현: campSupported ? 1 : 0,
    원정_완주_봇수: campSupported ? campDone : -1,          // 목표 ≤1 (8봇 중)
    원정_완주율_퍼센트: campSupported ? campRate : -1,      // 목표 ≤12.5
    원정_평균_클리어_전투수: campSupported ? clearedAvg : -1,
    난이도_곡선_뒤가_어렵다: campSupported ? curveOk : -1,   // 1=그렇다 0=아니다
    첫_전투_길이_초: campSupported ? firstStageSec : -1,     // 목표 40~60
    원정_총_길이_분: campSupported ? campMinutes : -1,
    도발_발생_원정수: campSupported ? tauntRuns : -1,        // 0 이면 도발은 없는 기능
    도발_분당_횟수: campSupported ? tauntPerMin : -1,        // 목표 0.2~2.0
    도발_첫_시점_초: campSupported ? tauntFirst : -1,
    원정_승계규칙_위반: campSupported ? carryBad.length : -1, // 목표 0
    원정_중단_봇수: campSupported ? campAborted : -1,         // 목표 0
    원정_미결_전투수: campSupported ? unresTotal : -1,        // 상한에 걸려 잘린 판. **패배가 아니다**
    결판_병력: campSupported ? cause.병력 : -1,
    결판_물: campSupported ? cause.물 : -1,
    무뇌도배_생존_전투수: campSupported ? spamSurvive : -1,   // 목표 ≤2
    // ── v3 신규 · 난이도 격차 (§5.5). 이번 계측의 핵심 ──
    상성봇_승률_퍼센트: sCounter ? sCounter.rate : -1,
    도배봇_최고승률_퍼센트: bestSpam ? bestSpam.rate : -1,
    다양성봇_승률_퍼센트: sRand ? sRand.rate : -1,
    다양성봇_이름: sRand ? sRand.name : '없음',
    상성_도배_격차_퍼센트포인트: gapWin,                      // 목표 ≥40
    상성_도배_격차_기지비율: gapMargin,                       // 연속값. 목표 ≥0.30
    상성_다양성_격차_퍼센트포인트: gapRandWin,               // 목표 >0 (상성 > 그냥 섞기)
    상성_다양성_격차_기지비율: gapRandMargin,
    상성가성비봇_승률_퍼센트: stat('상성가성비') ? stat('상성가성비').rate : -1,
    // 온보딩 — 10초 안에 파괴를 본 봇 수 / 전체
    첫10초_파괴본_봇수: (report.onboardBots || []).filter((o) => o && !o.broken && o.firstDestroy >= 0 && o.firstDestroy <= 10).length,
    온보딩_표본_봇수: (report.onboardBots || []).filter((o) => o && !o.broken).length,
    // ── 계측 자체의 건전성 ──
    이벤트_번호_불일치: IMPL.ev ? evMismatch.length : -1,
    이벤트_번호_미노출: IMPL.ev ? evMissing.length : -1,
    표본_축소_건수: report.reduced.length,
    측정중_소스변경: report.provenance.changedDuringRun.length,
  };

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }

  // ══ 사람이 읽는 출력 ════════════════════════════════════════
  const UN = ['검', '창', '궁', '기', '거', '투'];
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n) => String(v).padStart(n);

  console.log('\n─── 자동 평가 ' + '─'.repeat(48));

  // ── 언제·무엇을 잰 것인가. 이게 없으면 수치는 증거가 아니라 일화다 ──
  {
    const P = report.provenance;
    const st = P.start;
    console.log('  커밋 ' + st.git + (st.dirty ? ' (+커밋되지 않은 변경 있음)' : '') +
      '   소스 ' + WATCH.map((f) => (st.files[f] ? path.basename(f) + ':' + st.files[f].sha1.slice(0, 6) : ''))
        .filter(Boolean).join(' '));
    console.log('  측정 ' + new Date(T_START).toISOString().slice(0, 19).replace('T', ' ') +
      ' ~ ' + Math.round(report.wallMs / 1000) + '초   구간 ' + report.sections.join(',') +
      '   처리량 ' + report.tickBudget.tickPerMs + ' tick/ms');
    // **느린 것이 게임인지 부하인지 갈라 준다.** 여러 에이전트가 같은 4코어를 쓴다.
    // load 가 코어 수를 크게 넘으면 벽시계 수치는 게임 성능이 아니라 경합을 잰 것이다.
    console.log('  부하 CPU ' + report.load.cpus + '코어  loadavg 시작 ' + report.load.start +
      ' → 끝 ' + report.load.end +
      (report.load.end > report.load.cpus * 1.5
        ? '   ⚠ 다른 프로세스와 경합 중이다 — 총 실행 시간은 게임이 아니라 부하 때문이다' : ''));
    if (P.changedDuringRun.length) {
      console.log('  ⚠⚠ 측정 도중 소스가 바뀌었다: ' + P.changedDuringRun.join(' '));
      console.log('     **이 회차 수치는 하나의 빌드를 잰 것이 아니다.** 다시 재라.');
    }
    if (report.reduced.length) {
      console.log('  ⚠ 표본을 줄였다 (전부 잰 것이 아니다):');
      for (const s of report.reduced) console.log('    · ' + s);
    }
    if (WANT.size < ALL_SECTIONS.length) {
      console.log('  ⚠ 부분 실행이다. 빠진 구간: ' + ALL_SECTIONS.filter((s) => !on(s)).join(' ') +
        ' — 그 구간의 숫자는 "안 잰 것"이지 "0"이 아니다');
    }
  }

  console.log('\n[0] 구현 현황 — 없는 기능은 0점이 아니라 미구현이다');
  if (!report.impl) console.log('  ✖ 확인 실패');
  else {
    console.log('  유닛 ' + IMPL.unitKinds + '종 (계약 6)   시대 ' + IMPL.eraCount +
      ' (계약 5)   버튼 ' + IMPL.btnCount + ' (계약 10)   spawnCd 길이 ' + IMPL.spawnCdLen);
    console.log('  상성표 ' + (IMPL.counterTable ? '있음 x' + IMPL.counterStrong : '✖ 없음') +
      '   towerLv ' + (IMPL.towerLv ? '있음' : '✖') +
      '   skillCd[' + IMPL.skillCdLen + ']' +
      '   towerCost() ' + (IMPL.fnTowerCost ? '있음' : '✖') +
      '   skillReady() ' + (IMPL.fnSkillReady ? '있음' : '✖') +
      '   hitRally ' + (IMPL.hitRally ? '있음' : '✖'));
    console.log('  ACT 미구현: ' + (IMPL.missingAct && IMPL.missingAct.length
      ? '✖ ' + IMPL.missingAct.join(' ') : '없음'));
    const cm = IMPL.camp || {};
    console.log('  원정 API    stage ' + (cm.stage ? '있음' : '✖') +
      '   stageMax ' + (cm.stageMax ? '있음(' + cm.stageMaxVal + ')' : '✖') +
      '   commander ' + (cm.commander ? '있음' : '✖') +
      '   campaignOver ' + (cm.campaignOver ? '있음' : '✖') +
      '   nextStage() ' + (cm.fnNextStage ? '있음' : '✖'));
    const cf = IMPL.cfg || {};
    console.log('  원정 상수   CAMPAIGN_LEN ' + cf.CAMPAIGN_LEN +
      '   STAGE_HP_MUL[' + cf.lenHp + '] DIFF[' + cf.lenDiff + '] WATER[' + cf.lenWater +
      '] DIP[' + cf.lenDip + ']   사령관 이름[' + cf.lenName + '] 도발[' + cf.lenTaunt + ']');
    console.log('  이벤트 번호 ' + (!IMPL.ev ? '✖ __rising 이 EV 를 노출하지 않는다'
      : (evMismatch.length ? '✖ 계약과 다름: ' + evMismatch.join(' ') : '계약과 일치') +
        (evMissing.length ? '   ✖ 미노출: ' + evMissing.join(' ') : '')));
    if (!CAMP_OK) {
      console.log('  → 원정 미구현. [9] 원정 계측은 전부 -1 이다. ' +
        '**0 이 아니다** — 재 봤더니 아무도 완주 못 한 것이 아니라, 잴 것이 없다.');
    }
  }

  console.log('\n[1] 여덟 원형 전략 — 결말·판길이·6유닛 구성이 갈려야 한다');
  if (CAMP_OK) {
    console.log('  ⚠ 원정이 구현된 뒤로 이 표는 **첫 전투(stage 0)만** 잰 것이다. ' +
      'STAGE_HP_MUL[0]=' + ((IMPL.cfg && IMPL.cfg.hp0 !== undefined) ? IMPL.cfg.hp0 : '?') +
      ' 라 판 길이가 v2 대비 짧게 나오는 것이 정상이다.');
    console.log('  → "8개 원형 중 몇이 이기는가"의 v3 판 답은 이 줄이 아니라 [9] 원정 완주율이다.');
  }
  console.log('  ' + pad('봇', 9) + pad('결말', 9) + '  초  ' + ' 내기지 적기지 시대  처치  ' +
    pad('구성(검창궁기거투)', 22) + '탑 스킬 상성');
  for (const m of M) {
    const mix = m.mix ? m.mix.map((v, i) => (v ? UN[i] + v : '')).filter(Boolean).join('') : '?';
    console.log('  ' + pad(m.mode, 9) +
      pad(m.broken ? '✖계측실패' : (m.outcome < 0 ? '5분내안끝남' : OUTCOME[m.outcome]), 9) +
      num(m.seconds, 4) + '  ' + num(m.myHp ?? '?', 5) + num(m.foeHp ?? '?', 6) +
      num(m.era ?? '?', 5) + num(m.kills ?? '?', 6) + '  ' + pad(mix, 22) +
      num(m.towerLv ?? '?', 2) + num(m.skillTotal ?? '?', 4) + num(m.counterHit ?? '?', 6));
  }
  const anyMissing = new Set();
  for (const m of M) if (m.missing) for (const x of m.missing) anyMissing.add(x);
  if (anyMissing.size) console.log('  ⚠ 봇이 쓰려 했으나 없던 API: ' + [...anyMissing].join(' '));

  console.log('\n[2] 새 요소가 죽어 있지 않은가 — 능력 / 실사용을 나눠 잰다');
  if (!on('usage')) console.log('  — 구간 제외 (안 잰 것이다)');
  else if (!U) console.log('  ✖ 확인 실패');
  else {
    console.log('  유닛 소환   ' + U.spawnOk.map((v, i) =>
      (UN[i] || i) + (v === 1 ? '○' : v === 0 ? '✖' : '—')).join(' ') +
      '   (○ 소환됨  ✖ 눌러도 안 나옴  — ACT 미구현)');
    console.log('  포탑        최대단계 ' + (U.towerLv < 0 ? '미구현' : U.towerLv + '/2') +
      '   시험사격 ' + (U.towerFire < 0 ? '미구현' : U.towerFire + '회') +
      '   실제 판에서 건설 ' + towerBuiltRuns + '/' + M.length + '판, 사격 ' + towerFireTotal + '회');
    console.log('  스킬        ' + ['해일', '화살비', '증원'].map((n, i) =>
      n + (U.skillOk[i] === 1 ? '○' : U.skillOk[i] === 0 ? '✖' : '—')).join(' ') +
      '   실제 판에서 ' + skillUseTotal + '회 (' + skillKindsUsed + '종)');
  }

  console.log('\n[3] 상성이 실제로 작동하는가');
  if (!cp) console.log('  — 상성표가 없거나 유닛이 6종이 아니다. 측정 불가');
  else {
    for (const x of cp) {
      console.log('  ' + pad(UN[x.atk] + ' > ' + UN[x.def], 8) + 'x' + x.mul.toFixed(2) +
        '   동수 8:8 → ' + num(x.evenL, 2) + ':' + num(x.evenR, 2) + (x.evenWin ? ' ○' : ' ✖') +
        '   동금 ' + num(x.na, 2) + ':' + num(x.nd, 2) + ' → ' +
        num(x.goldL, 2) + ':' + num(x.goldR, 2) + (x.goldWin ? ' ○' : ' ✖') +
        '   사거리 ' + num(x.rA, 3) + ' vs ' + num(x.rD, 3) +
        (!x.evenWin && x.rD > x.rA ? '  ← 방어자가 더 멀리 때린다' : ''));
    }
    console.log('  삼각형 성립  동수 ' + triEven + '/6   동금 ' + triGold + '/6');
    const outranged = cp.filter((x) => !x.evenWin && x.rD > x.rA).length;
    const failed = cp.filter((x) => !x.evenWin).length;
    if (failed > 0 && outranged === failed) {
      console.log('  ⚠ 실패한 ' + failed + '변이 전부 "사거리가 짧은 쪽이 우위"인 조합이다.');
      console.log('    상성 배수 x' + (cp[0] ? cp[0].mul.toFixed(2) : '?') +
        ' 는 근접이 원거리에게 닿기 전에 죽는 것을 뒤집지 못한다 — 배수가 아니라 접근 문제다.');
    }
  }
  console.log('  실전 상성 타격 ' + cHit + '회 / 전체 공격 ' + atkTot + '회 = ' +
    (counterRate < 0 ? '측정불가' : counterRate + '%'));

  console.log('\n[4] 온보딩 — 첫 10초 / 첫 30초 (계약 §4: 10초 안에 부수거나 부서지는 것을 본다)');
  const N30 = { 0: '소환', 2: '처치', 3: '기지피해', 5: '시대진화', 7: '금부족', 9: '물경고',
                11: '드래프트', 16: '포탑사격', 17: '스킬', 18: '포탑건설', 19: '상성타격',
                20: '전투시작', 22: '도발' };
  const F10 = report.first30.seen10 || {};
  console.log('  ' + pad('사건', 10) + pad('첫10초', 9) + pad('첫30초', 9) + '첫 등장');
  for (const k of Object.keys(N30)) {
    const c10 = F10[k] | 0, c30 = report.first30.seen[k] | 0;
    console.log('  ' + pad(N30[k], 10) +
      pad(c10 ? c10 + '회' : '—', 9) + pad(c30 ? c30 + '회' : '—', 9) +
      (c30 ? report.first30.firstAt[k] + '초' + (c10 ? '' : '   ← 10초 안에는 없다')
           : '30초 안에 안 나온다'));
  }
  {
    // "부수거나 부서지는 것" = 처치(2) 또는 기지피해(3). 둘 다 0 이면 계약 위반이다.
    const d10 = (F10[2] | 0) + (F10[3] | 0);
    const fk = report.first30.firstAt[2], fb = report.first30.firstAt[3];
    const first = [fk, fb].filter((v) => v !== undefined).sort((a, b) => a - b)[0];
    console.log('  → 첫 10초 파괴(처치+기지피해) ' + d10 + '회' +
      (first === undefined ? '   ✖ 30초 안에 한 번도 없다'
        : '   첫 파괴 ' + first + '초' + (first <= 10 ? ' ○' : ' ✖ 계약은 10초다')));
    if (report.first30.ended) console.log('  ⚠ 이 판은 30초 안에 끝났다 — 위 카운트는 판 전체다');
    const OB = (report.onboardBots || []).filter((x) => x && !x.broken);
    if (OB.length) {
      console.log('  여러 봇으로 다시 — "첫 파괴"가 봇 하나의 취향이 아닌지 확인한다');
      for (const o of OB) {
        console.log('    ' + pad(o.mode, 9) + '첫 파괴 ' +
          (o.firstDestroy < 0 ? '30초 안에 없음' : o.firstDestroy + '초') +
          '   (첫 처치 ' + (o.firstKill < 0 ? '—' : o.firstKill + '초') +
          ' / 첫 기지피해 ' + (o.firstBaseHit < 0 ? '—' : o.firstBaseHit + '초') + ')' +
          '   첫10초 파괴 ' + o.destroy10 + '회 · 소환 ' + o.spawn10 + '회');
      }
      const ok10 = OB.filter((o) => o.firstDestroy >= 0 && o.firstDestroy <= 10).length;
      console.log('    → 10초 안에 파괴를 본 봇 ' + ok10 + '/' + OB.length +
        (ok10 === OB.length ? '  ○ 계약 §4 충족' : '  ✖ 계약 §4 는 전원 10초 이내를 요구한다'));
    }
    if (report.first30.briefAtStart) {
      console.log('  ⚠ 판 앞에 설명 화면(S.BRIEF, 최대 ' + (report.first30.briefMs / 1000) +
        '초)이 있다. 시뮬 시계가 멈추므로 위 표에는 안 들어간다 — ' +
        '**심사자가 보는 30초에는 들어간다.** 입력 한 번이면 닫힌다.');
    }
  }

  console.log('\n[5] 디렉터 — 프로파일을 고정하고 적 구성을 쟀다 (6칸)');
  for (const d of report.director) {
    console.log('  ' + pad(d.profile, 10) +
      (d.mix || []).map((v, i) => UN[i] + num((v * 100).toFixed(0), 3) + '%').join(' ') +
      '  간격 ' + d.tempo + 'ms  levers.mix 길이 ' + d.mixLen + '  (표본 ' + d.total + ')');
  }

  console.log('\n[6] 버튼   선언 ' + report.buttons.declared + '개 중 히트박스 적중 ' +
    report.buttons.hit + '개   증원 원형버튼 ' +
    (report.buttons.rally < 0 ? '미구현' : report.buttons.rally ? '적중' : '✖ 안 맞음'));
  console.log('[7] 프레임 avg ' + report.perf.avg + 'ms  p99 ' + report.perf.p99 +
              'ms  max ' + report.perf.max + 'ms  16.7ms 초과 ' + report.perf.over16 + '회');
  console.log('[8] 콘솔   ' + (report.console.length ? report.console.slice(0, 4).join(' | ') : '에러·경고 0개'));

  // ── [9] 원정 ────────────────────────────────────────────────
  console.log('\n[9] 원정 — 완주율 · 스테이지별 승률 · 첫 전투 길이 · 도발');
  if (!campSupported) {
    console.log('  — 측정 불가: ' + (report.campaign ? report.campaign.reason : '구간이 안 돌았다'));
    console.log('    (config.js 에 원정 상수는 있다. game.js 가 아직 안 쓴다 — 상수만으로는 원정이 아니다)');
  } else {
    if (report.campaign.sampled) console.log('  ⚠ 표본 ' + report.campaign.sampled + ' 봇만 돌렸다');
    const campBroken = report.campaign.runs.filter((r) => r && r.broken);
    if (campBroken.length) {
      console.log('  ✖ 계측 실패 ' + campBroken.length + '봇: ' + campBroken.map((r) => r.name).join(' ') +
        '   (아래 수치는 나머지 ' + CR.length + '봇만 잰 것이다)');
    }
    console.log('  ' + pad('봇', 9) + pad('클리어', 8) + pad('총초', 7) + '스테이지별 (초/결말/사령관)');
    for (const r of CR) {
      const line = r.stages.map((s) => 's' + s.stage + ':' + s.seconds + '초' +
        (s.outcome === 1 ? '승' : s.outcome === -1 ? '미결' : '패') +
        (s.commander >= 0 ? '/사' + s.commander : '')).join('  ');
      console.log('  ' + pad(r.name, 9) + pad(r.cleared + '/' + r.stageMax + (r.completed ? ' ★완주' : ''), 8) +
        pad(r.totalSeconds, 7) + line + (r.aborted ? '   ✖ ' + r.aborted : ''));
    }
    console.log('  완주 ' + campDone + '/' + arche.length + ' (' + campRate + '%)  ' +
      '평균 클리어 ' + clearedAvg + '전투   원정 총 길이(완주 기준) ' +
      (campMinutes < 0 ? '완주 없음' : campMinutes + '분'));
    console.log('  스테이지별  ' + stageWin.map((x) => 's' + x.stage +
      (x.reach ? ' 승' + x.win + '패' + x.lose + '미결' + x.unres + '/도달' + x.reach +
        ' → 승률 ' + (x.resolved ? x.rate + '%(n=' + x.resolved + ')' : '결말0') + ' ' + x.sec + '초'
        : ' 도달0')).join('  |  '));
    console.log('  결판 원인  병력 ' + cause.병력 + ' · 물 ' + cause.물 + ' · 무승부 ' +
      cause.무승부 + ' · 미결 ' + cause.미결 +
      '   (**미결은 패배가 아니다** — 상한 안에 결말이 안 난 것이다)');
    console.log('  곡선  ' + (curveOk === 1 ? '○ 뒤 전투가 더 어렵다'
      : curveOk === 0 ? '✖ 뒤 전투가 더 쉽다 — 난이도 곡선이 거꾸로다' : '— 표본 부족')
      + '   (결말 난 판만 쓴다. 미결을 패배로 세면 이 판정은 언제나 ○ 가 된다)');
    // 절벽 감지 — 곡선이 아니라 벽이면 그건 난이도가 아니라 차단이다
    for (let i = 1; i < stageWin.length; i++) {
      const a = stageWin[i - 1], b = stageWin[i];
      if (a.resolved >= 2 && b.resolved >= 1 && a.rate >= 60 && b.rate === 0) {
        console.log('  ⚠ 절벽: s' + a.stage + ' ' + a.rate + '% → s' + b.stage +
          ' 0% (n=' + b.resolved + '). 곡선이 아니라 벽이다 — 이 지점의 원인을 따로 찾아야 한다');
      }
    }
    console.log('  첫 전투 길이  이긴 판 중앙값 ' + firstStageSec + '초  ' +
      (firstStageSec < 0 ? '(이긴 봇 없음)' : (firstStageSec >= 40 && firstStageSec <= 60) ? '○ 목표 40~60'
        : '✖ 목표 40~60 을 벗어났다') +
      '   / 결말난 판 전체 ' + firstStageAll + '초, 상한 내 안 끝난 판 ' + firstStageUnres + '개');
    console.log('  한 전투 상한 ' + CAP_STAGE_SEC + '시뮬초 · 원정 상한 ' + CAP_TOTAL_SEC +
      '시뮬초. "미결" 은 이 상한 안에 결말이 안 난 것이다 — 진 것이 아니다');
    console.log('  ⚠ 봇은 결정론적이다. **격자 한 칸이 표본 1개다** — 위 퍼센트는 방향만 보고, ' +
      '한 판이 뒤집히면 20~30%p 가 움직인다는 것을 감안해라');
    console.log('  도발  ' + tauntRuns + '/' + CR.length + ' 원정에서 발생, 총 ' + tauntTotal +
      '회, 분당 ' + tauntPerMin + '회, 첫 도발 ' + tauntFirst + '초  ' +
      (tauntTotal === 0 ? '✖ 한 번도 안 나온다 — 있는 기능이 아니다'
        : tauntPerMin > 2 ? '✖ 너무 잦다 (2회/분 초과)' : '○'));
    console.log('  도발/판정변화  ' + CR.map((r) => r.name + ' ' + r.tauntTotal + '/' + r.profSwitches).join('  ') +
      '   (도발이 판정 변화와 맞물려야 한다. 분모가 0인데 도발이 나오면 장식이다)');
    if (carryBad.length) {
      console.log('  ✖ 승계 규칙 위반 ' + carryBad.length + '건 (§2: 특성·포탑 유지 / 금·시대·병력 초기화)');
      for (const s of carryBad.slice(0, 6)) console.log('     · ' + s);
    } else if (CR.some((r) => r.stages.some((s) => s.carry))) {
      console.log('  ○ 승계 규칙 준수 — 특성·포탑 유지, 시대·병력 초기화');
    }
  }

  // ── [10] 난이도 격차 ────────────────────────────────────────
  console.log('\n[10] 난이도 격차 — 상성을 아는 봇이 실제로 더 잘하는가');
  if (!GR.length) console.log('  — 측정 불가 (구간이 안 돌았거나 전부 실패)');
  else {
    console.log('  껍데기(진화·해일·드래프트)는 전부 같고 **유닛 선택만 다르다.** ' +
      '상대 ' + report.gap.foes.length + '종 · 한 판 상한 ' + report.gap.cap + '초');
    const gapBroken = report.gap.rows.filter((r) => r && r.broken).length;
    if (gapBroken) console.log('  ✖ 계측 실패 ' + gapBroken + '판 — 그만큼 표본이 작다');
    const sFoe = GR.filter((r) => String(r.foe).charAt(0) === 'S' && String(r.foe).length === 2);
    if (sFoe.length) {
      const bad = sFoe.filter((r) => r.forced !== 2).length;
      console.log('  상대 = 사령관 다섯 (stage 0~4 전투를 직접 차렸다). ' +
        '**특성·포탑 승계 없음** — 실제 원정보다 불리한 조건이다. 봇 간 비교용 숫자다.');
      if (bad) console.log('  ✖ ' + bad + '판에서 stage 강제가 실패했다 — 상대 축이 무너졌다. 아래 격차를 믿지 마라');
    } else {
      console.log('  상대 = 디렉터 프로파일 고정 (원정 미구현 시의 대역)');
    }
    console.log('  ' + pad('봇', 8) + pad('승률', 12) + pad('기지비율차', 12) + pad('평균초', 8) +
      pad('상성타격%', 10) + '상대별 결말');
    for (const s of botStat) {
      const per = report.gap.foes.map((f) => {
        const row = GR.find((r) => r.foe === f && r.bot === s.name);
        return f.slice(0, 4) + ':' + (!row ? '?' : row.outcome === 1 ? '승'
          : row.outcome === -1 ? '미결' : row.outcome === 3 ? '잠김' : '패');
      }).join(' ');
      console.log('  ' + pad(s.name, 8) + pad(s.win + '/' + s.n + ' (' + s.rate + '%)', 12) +
        pad((s.margin >= 0 ? '+' : '') + s.margin, 12) + pad(s.sec, 8) + pad(s.cRate, 10) + per);
    }
    console.log('  ── 격차 ──');
    console.log('  상성 − 도배(최고 ' + (bestSpam ? bestSpam.name : '?') + ')   승률 ' +
      (gapWin >= 0 ? '+' : '') + gapWin + '%p   기지비율 ' + (gapMargin >= 0 ? '+' : '') + gapMargin +
      '   ' + (gapWin >= 40 ? '○ 뚜렷하다' : gapWin > 0 ? '△ 있지만 약하다' : '✖ 상성이 이득이 아니다'));
    console.log('  상성 − ' + (sRand ? sRand.name : '다양성') + '            승률 ' +
      (gapRandWin >= 0 ? '+' : '') + gapRandWin + '%p   기지비율 ' +
      (gapRandMargin >= 0 ? '+' : '') + gapRandMargin +
      '   ' + (gapRandWin > 0 ? '○ 상성이 무작위보다 낫다'
        : '✖ 다양성 대조군과 같다 — "상성을 안다"가 아니라 "한 종류만 쓰면 진다"를 잰 것이다'));
    if (bestSpam && bestSpam.rate > 0) {
      console.log('  ⚠ 도배 봇이 ' + bestSpam.rate + '% 이긴다. 계약 §5.5 는 도배가 벌을 받기를 요구한다.');
    }
    const sGold = stat('상성가성비');
    if (sCounter && sGold) {
      console.log('  참고  상성(배수최대) vs 상성가성비(배수/가격)  승률 ' + sCounter.rate + '% vs ' +
        sGold.rate + '%   기지비율 ' + sCounter.margin + ' vs ' + sGold.margin);
      console.log('        가성비 쪽이 앞서면 이 게임에서 **가격 대비 효율이 상성 우위보다 크다**는 뜻이다 ' +
        '(그 봇은 사실상 싼 유닛 도배가 된다)');
    }
    console.log('  ⚠ 결정론 봇이라 **한 칸이 표본 1개**다. 승률 25%↔50% 는 한 판 차이다. ' +
      '연속값인 기지비율차를 같이 봐라');
  }

  if (report.errors.length) console.log('\n[11] 계측 실패 구간: ' + report.errors.join(' | '));

  console.log('\n─── 판정 ' + '─'.repeat(52) + '   (-1 = 미구현·측정불가)');
  // 이름이 재는 것과 어긋나기 시작한 지표에는 경고를 붙인다.
  // 이 저장소는 "지표가 실제로 무엇을 재는지"를 놓쳐 세 번 틀린 결론을 냈다.
  const NOTE = {
    승리한_전략_수: '← ⚠ v3 에서는 **첫 전투(가르치는 전투)** 승리 수다. 5~7 이 정상. 난이도는 원정_완주_봇수로 봐라',
    평균_판_길이_초: '← ⚠ 첫 전투(stage 0)만의 길이다. v2 값과 직접 비교하지 마라',
    서로_다른_결말: '← ⚠ 첫 전투 기준',
    원정_미결_전투수: '← 상한에 걸려 잘린 판. 패배가 아니다',
    상성_도배_격차_퍼센트포인트: '← 이번 계측의 핵심. 표본이 작으니 기지비율 격차와 같이 봐라',
  };
  for (const [k, v] of Object.entries(report.verdict)) {
    console.log('  ' + k.replace(/_/g, ' ').padEnd(26) + String(v).padEnd(8) + (NOTE[k] || ''));
  }

  // ── 계약 §5.5 목표 수치표 대조 ────────────────────────────────
  // 사양서의 표를 그대로 계측 항목으로 만든 것이다. 주관이 안 들어간다.
  console.log('\n─── 계약 §5.5 목표 대조 ' + '─'.repeat(37));
  const OBok = (report.onboardBots || []).filter((o) => o && !o.broken);
  const OB10 = OBok.filter((o) => o.firstDestroy >= 0 && o.firstDestroy <= 10).length;
  const d10n = (report.first30.seen10 ? ((report.first30.seen10[2] | 0) + (report.first30.seen10[3] | 0)) : -1);
  const rows55 = [
    ['8개 원형 중 첫 전투 승리', wins + '/' + M.length, CAMP_OK ? '참고치 (첫 전투는 가르치는 전투다)' : '2~3',
      CAMP_OK ? null : (wins >= 2 && wins <= 3)],
    ['8개 원형 중 원정 완주', campSupported ? campDone + '/' + arche.length : '미구현', '≤1',
      campSupported ? campDone <= 1 : null],
    ['무뇌 도배 생존 전투수', campSupported ? spamSurvive : '미구현', '≤2 (3전투 안에 패배)',
      campSupported ? (spamSurvive >= 0 && spamSurvive <= 2) : null],
    ['대조군 idle 승리', idleWin, '0', idleWin === 0],
    ['상성 − 도배 승률 격차', GR.length ? gapWin + '%p' : '미측정', '≥40%p',
      GR.length ? gapWin >= 40 : null],
    ['상성 − 도배 기지비율 격차', GR.length ? gapMargin : '미측정', '≥0.30',
      GR.length ? gapMargin >= 0.30 : null],
    ['상성 − 다양성 승률 격차', GR.length ? gapRandWin + '%p' : '미측정', '>0 (상성이 앞선다)',
      GR.length ? gapRandWin > 0 : null],
    ['첫 전투 길이', campSupported ? firstStageSec + '초' : '미구현', '40~60초',
      campSupported ? (firstStageSec >= 40 && firstStageSec <= 60) : null],
    ['첫 10초 파괴를 본 봇', OBok.length ? OB10 + '/' + OBok.length : d10n + '회(단일봇)',
      '전원', OBok.length ? OB10 === OBok.length : d10n >= 1],
    ['난이도 곡선 뒤가 더 어렵다', campSupported ? (curveOk === 1 ? '그렇다' : curveOk === 0 ? '아니다' : '표본부족') : '미구현',
      '그렇다', campSupported ? (curveOk === 1) : null],
  ];
  for (const [name, now, want, okv] of rows55) {
    console.log('  ' + pad(name, 26) + pad(now, 14) + pad(want, 26) +
      (okv === null ? '—' : okv ? '○' : '✖'));
  }
  console.log('');
}

run().catch((e) => { console.error(e); process.exit(2); });
