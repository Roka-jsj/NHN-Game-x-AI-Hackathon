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
// ── 이 파일의 원칙 ──────────────────────────────────────────────
// **깨진 게임을 통과시키는 평가기보다, 깨졌다고 말하는 평가기가 낫다.**
// 여러 전문가가 동시에 game.js / render.js 를 고치고 있어 중간 상태가 자주 깨진다.
// 그때 평가기는 터지지 말고 그 사실을 숫자로 낸다 — 판이 안 끝나면 -1,
// API 가 없으면 -1(미구현), 한 구간이 터지면 report.errors 에 남기고 계속 간다.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const JSON_OUT = process.argv.includes('--json');

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

// ── 이벤트 코드. spec-v2 §7 이 번호를 못 박았다 ────────────────────
// main.js 는 EV 를 __rising 에 노출하지 않는다. 그래서 번호를 여기에 박는다.
// 계약이 번호를 고정했으므로 이건 추측이 아니라 계약을 읽은 것이다.
const E = {
  SPAWN: 0, ATTACK: 1, KILL: 2, BASE_HIT: 3, GOLD: 4, ERA_UP: 5, NUKE: 6,
  NO_GOLD: 7, COOLDOWN: 8, WATER_WARN: 9, WATER_HIT: 10, DRAFT_OPEN: 11,
  DRAFT_PICK: 12, WIN: 13, LOSE: 14, RESET: 15,
  TOWER_FIRE: 16, SKILL: 17, TOWER_UP: 18, COUNTER_HIT: 19,
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

  // 드래프트 — 봇마다 선호 계열이 다르다. 이것도 전략 축이다.
  function pickDraft(R, g, pref, t) {
    const C = R.C;
    let slot = 0;
    if (g.draftIdx && C.TRAITS) {
      for (let s = 0; s < g.draftIdx.length; s++) {
        const idx = g.draftIdx[s];
        if (idx >= 0 && C.TRAITS[idx] && C.TRAITS[idx].kind === pref) { slot = s; break; }
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
      // **상성표를 읽고 금 대비 우위가 가장 큰 유닛을 뽑는다.**
      // 이 봇이 다른 봇을 못 이기면 상성은 장식이다.
      const CT = C.COUNTER;
      if (!CT) { window.__missing.COUNTER = 1; if (buyable(g, 0)) buy(R, g, 0, t); return; }
      const mix = foeMix(g, K);
      let tot = 0; for (let j = 0; j < K; j++) tot += mix[j];
      let best = -1, bestS = -1;
      for (let k = 0; k < K; k++) {
        if (!buyable(g, k)) continue;
        let s = 0;
        if (tot === 0) s = 1;
        else for (let j = 0; j < K; j++) s += mix[j] * CT[k * K + j];
        s /= g.cost(k);
        if (s > bestS) { bestS = s; best = k; }
      }
      if (best >= 0) buy(R, g, best, t);
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
  };

  async function page0() {
    const p = await browser.newPage({ viewport: { width: 960, height: 600 } });
    p.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') report.console.push(m.type() + ': ' + m.text());
    });
    p.on('pageerror', (e) => report.console.push('pageerror: ' + e.message));
    await p.addInitScript(CLOCK_INIT);
    await p.addInitScript(BOT);
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForFunction('!!window.__rising', null, { timeout: 15000, polling: 200 });
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
      };
    });
    await p.close();
    return r;
  }, null);

  const IMPL = report.impl || {};
  const K = IMPL.unitKinds || 3;

  // ── 1~3. 판이 끝나는가 · 전략이 갈리는가 · 새 요소가 쓰이는가 ──
  // 이벤트를 가로채 포탑·스킬·상성 발생 횟수를 판마다 기록한다.
  // **한 번도 안 지어지는 포탑은 없는 기능이다.** 그걸 여기서 잡는다.
  const matchResults = await pool(STRATEGIES, 3, async (mode) => guard(report, 'match:' + mode, async () => {
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

  // ── 4. 상성이 실제로 작동하는가 — 결투 하네스 ────────────────
  // EV.COUNTER_HIT 이 나온다고 상성이 "작동"하는 것은 아니다.
  // 배수가 곱해져도 그게 승부를 뒤집지 못하면 상성은 장식이다.
  // 그래서 삼각형 6변을 직접 붙여 본다. 디렉터·물·경제를 끄고 순수 전투만 남긴다.
  //   동수 — 같은 머릿수. 배수 자체가 도는가
  //   동금 — 같은 금액. 가격까지 포함해서 실제로 이득인가
  report.counter = await guard(report, 'counter-duel', async () => {
    const p = await page0();
    const r = await p.evaluate(async (KK) => {
      const R = window.__rising, g = R.game, C = R.C;
      if (!C.COUNTER || KK < 6) return { supported: false, pairs: [] };
      const beats = [
        [C.U_SPEAR, C.U_CAV], [C.U_CAV, C.U_ARCHER], [C.U_CAV, C.U_CATA],
        [C.U_ARCHER, C.U_SWORD], [C.U_ARCHER, C.U_GIANT], [C.U_SWORD, C.U_SPEAR],
      ];
      // 결투 격리 — 게임 코드를 고치지 않고 인스턴스 위에만 덮어쓴다.
      function isolate() {
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
  report.usage = await guard(report, 'capability', async () => {
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
        if (g.state !== 0) g.reset();          // 판이 끝나 있으면 입력이 재시작으로 먹힌다
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
        if (g.state !== 0) g.reset();
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

  // ── 6. 첫 30초에 무엇을 만나는가 ──────────────────────────────
  report.first30 = await guard(report, 'first30', async () => {
    const p = await page0();
    const r = await p.evaluate(async () => {
      const g = window.__rising.game;
      const seen = {}, firstAt = {};
      const orig = g.emit.bind(g);
      g.emit = (t, a, b) => {
        seen[t] = (seen[t] || 0) + 1;
        if (firstAt[t] === undefined) firstAt[t] = +(g.tick / 60).toFixed(1);
        orig(t, a, b);
      };
      for (let i = 0; i < 1800; i++) {
        if (i % 12 === 0) window.__play('counter', 0);
        window.__clock.tick(1000 / 60);
        if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
      }
      return { seen, firstAt, gold: g.gold | 0, era: g.era, spawned: g.spawned, kills: g.kills };
    });
    await p.close();
    return r;
  }, { seen: {}, firstAt: {} });

  // ── 7. 디렉터가 장식인가 판단인가 ────────────────────────────
  // **프로파일을 직접 고정해서 잰다.** 봇의 분류에 의존하면 BALANCED(레버가
  // 원래 중립)만 나와 "레버가 아무것도 안 한다"는 틀린 결론이 나온다.
  // 유닛이 6종이 됐으므로 구성비도 6칸으로 센다 — 3칸으로 세면 기병·투석기가
  // 아무리 갈려도 지표에 안 잡힌다.
  for (const prof of ['BALANCED', 'RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER']) {
    const r = await guard(report, 'director:' + prof, async () => {
      const p = await page0();
      const v = await p.evaluate(async (arg) => {
        const [prof, KK] = arg;
        const R = window.__rising, g = R.game, d = R.director;
        d.onChunkBoundary = function (game, ci) {
          this.difficulty = Math.max(0, Math.min(4, (game.simTime / 22000) | 0));
          this.observing = false; this.profile = prof; this.profileIdx = 0; this.applyLevers();
        };
        g.reset();
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
  report.buttons = await guard(report, 'buttons', async () => {
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
  report.perf = await guard(report, 'perf', async () => {
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

  await browser.close();
  server.close();

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
  };

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }

  // ══ 사람이 읽는 출력 ════════════════════════════════════════
  const UN = ['검', '창', '궁', '기', '거', '투'];
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n) => String(v).padStart(n);

  console.log('\n─── 자동 평가 ' + '─'.repeat(48));

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
  }

  console.log('\n[1] 여덟 원형 전략 — 결말·판길이·6유닛 구성이 갈려야 한다');
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
  if (!U) console.log('  ✖ 확인 실패');
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

  console.log('\n[4] 첫 30초');
  const N30 = { 0: '소환', 2: '처치', 3: '기지피해', 5: '시대진화', 7: '금부족', 9: '물경고',
                11: '드래프트', 16: '포탑사격', 17: '스킬', 18: '포탑건설', 19: '상성타격' };
  for (const k of Object.keys(N30)) {
    const c = report.first30.seen[k];
    console.log('  ' + pad(N30[k], 9) + (c ? num(c, 3) + '회   첫 등장 ' + report.first30.firstAt[k] + '초'
                                           : '  — 30초 안에 안 나온다'));
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
  if (report.errors.length) console.log('[9] 계측 실패 구간: ' + report.errors.join(' | '));

  console.log('\n─── 판정 ' + '─'.repeat(52) + '   (-1 = 미구현·측정불가)');
  for (const [k, v] of Object.entries(report.verdict)) {
    console.log('  ' + k.replace(/_/g, ' ').padEnd(24) + v);
  }
  console.log('');
}

run().catch((e) => { console.error(e); process.exit(2); });
