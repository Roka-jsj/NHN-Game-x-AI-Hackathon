// 헤드리스 검증 하네스 — 개발 전용. 게임은 이 파일을 절대 로드하지 않는다.
//
// 실행:
//   NODE_PATH=$(npm root -g) node tools/smoke.mjs
//   NODE_PATH=$(npm root -g) node tools/smoke.mjs --shot out.png
//
// 이 하네스가 재는 것 (품질 게이트 번호):
//   #1  60Hz vs 120Hz 게임 속도 동일성   ← 합성 클록으로 실제 측정
//   #3  탭 전환 복귀                      ← visibilitychange 디스패치
//   #8  콘솔 청결                         ← 에러·경고 수집
//   #10 LLM 폴백                          ← data/*.json 차단·파손 주입
//
// 재지 못하는 것 (사람이 실기기로 재야 함):
//   #2 프레임 안정성 실측 · #4 입력 지연 · #5 모바일 제스처 · #6 iOS 사파리 소리
//   #7 첫 로딩 2초(LTE) · #9 링크 접근성 · #11 재시도 욕구
//
// 추측으로 고치지 않기 위한 도구다. 재고 → 고치고 → 다시 잰다.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

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

// 합성 클록. 모듈이 로드되기 전에 주입해야 rAF·performance.now 를 갈아끼울 수 있다.
const CLOCK_INIT = () => {
  let t = 0;
  // 큐 두 개를 번갈아 쓴다. splice(0) 는 매 프레임 새 배열을 만들고,
  // 그러면 하네스 자신이 힙 톱니를 만들어 게임의 할당량 측정을 오염시킨다.
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

// 페이지 안에서 도는 봇. 결정론적으로 논다.
// 다음 발판까지의 간격에서 필요한 차지 시간을 역산해 누른다.
//
// ★ 봇은 화면 주사율이 아니라 고정 60Hz 격자에서만 판단하고, 주입하는 timeStamp도
//   격자 시각이다. 이렇게 하지 않으면 120Hz 회차의 봇이 두 배 자주 폴링해서
//   반응이 빨라지고, 게임이 아니라 측정 도구 때문에 결과가 갈린다.
//   사람의 반응 속도는 주사율에 비례해서 빨라지지 않는다.
const BOT = () => {
  const GRID = 1000 / 60;
  window.__bot = {
    k: 0,
    nextAt: 0,
    pressed: false,
    pressAt: 0,
    hold: 0,
    decisions: 0,
    step() {
      const now = window.performance.now();
      while (now + 1e-6 >= this.nextAt) {
        this.decide(this.nextAt);
        this.k++;
        this.nextAt = this.k * GRID;
      }
    },
    decide(t) {
      const R = window.__rising;
      if (!R) return;
      const g = R.game, C = R.C;
      this.decisions++;
      const S_READY = 0, S_CHARGING = 1, S_DEAD = 5;

      if (g.state === S_DEAD) {
        if (!this.pressed) { R.inject('down', t); this.pressed = true; this.pressAt = t; }
        else if (t - this.pressAt > 50) { R.inject('up', t); this.pressed = false; }
        return;
      }
      // idle 모드: 아무것도 하지 않고 물에 잠기기를 기다린다 (사망→재시작 왕복 검증)
      if (this.mode === 'idle') return;

      // 성향별 봇 — 디렉터가 실제로 사람을 읽는지 확인하려면
      // 서로 다르게 노는 플레이어가 필요하다.
      //   safe     : 바로 다음 발판만, 정확하게        → 짧은 차지 + 낮은 오차
      //   precise  : 한 칸 건너뛰되 정확하게           → 긴 차지 + 낮은 오차
      //   reckless : 한 칸 건너뛰고 대충                → 긴 차지 + 높은 오차
      let off = 1, bias = 0, careful = true;
      if (this.mode === 'precise') { off = 3; }
      else if (this.mode === 'reckless') { off = 3; bias = 0.7; careful = false; }

      if (g.state === S_READY && !this.pressed) {
        let target = g.platIdx + off;
        g.ensurePlatform(target + 2);
        let gap = g.platYAt(target) - g.playerY;
        if (gap > C.LEAP_DIST_MAX) { target = g.platIdx + 1; gap = g.platYAt(target) - g.playerY; }
        const tol = C.PLATFORM_THICKNESS * g.platThickAt(target) * 0.5 + C.PLAYER_RADIUS;
        this.target = target;
        this.bias = bias * tol;
        this.wantGap = gap + this.bias;
        this.careful = careful;
        this.hold = this.holdFor(target, C);
        R.inject('down', t);
        this.pressed = true;
        this.pressAt = t;
        return;
      }
      if (g.state === S_CHARGING && this.pressed) {
        // 진동은 사인파라 **역산할 수 있다.** 숙련자가 하는 일이 이것이다:
        // "지금 떼면 조준점이 어디에 있을지"를 알고, 그만큼 눌러야 할 시간을 되민다.
        // 랜덤이었다면 이 계산은 존재할 수 없고, 봇도 사람도 실력을 쌓을 수 없다.
        //
        // 처음엔 "진동이 0이 될 때까지 기다렸다 뗀다"로 짰다가 봇이 한 번도 착지하지 못했다.
        // 기다리는 동안 차지가 계속 쌓여 도약 거리가 자라기 때문이다. 기다리면 안 되고 보정해야 한다.
        if (this.careful) this.hold = this.holdFor(this.target, C, g);
        if (t - this.pressAt < this.hold) return;
        R.inject('up', t);
        this.pressed = false;
      }
    },

    // 목표 발판에 맞추는 차지 시간.
    // 조준 진동도 이동 발판도 전부 시각의 함수라 **역산할 수 있다.**
    // 고정점 반복 6회면 수렴한다. 랜덤이었다면 이 함수는 존재할 수 없다.
    holdFor(target, C, g) {
      const span = C.LEAP_DIST_MAX - C.LEAP_DIST_MIN;
      const raw = (d) => Math.max(C.CHARGE_MIN_MS,
        Math.min(C.CHARGE_MAX_MS, (d - C.LEAP_DIST_MIN) / span * C.CHARGE_MAX_MS));
      if (!g) return raw(this.wantGap);
      let h = raw(this.wantGap);
      for (let k = 0; k < 6; k++) {
        const dist = C.LEAP_DIST_MIN + span * Math.min(1, h / C.CHARGE_MAX_MS);
        const arrive = g.chargePressSim + h + g.leapDurationFor(dist);
        const gap = g.platYAtTime(target, arrive) - g.playerY + this.bias;
        const w = g.wobbleOffset(dist, g.chargePressSim + h);
        h = raw(gap - w);
      }
      return h;
    },
  };
};

// 3분 연속 구동하며 프레임당 CPU 비용과 힙 톱니를 잰다.
// 합성 클록 위에서 재므로 "실기기 프레임 안정성(게이트 #2)"이 아니라
// "프레임 하나를 만드는 데 드는 CPU 비용"을 잰다. 개선 전/후 비교용 숫자다.
const PERF = async (frameMs, frames) => {
  const real = window.__clock.real;
  const times = new Float64Array(frames);
  const heapN = Math.ceil(frames / 60);
  const heap = new Float64Array(heapN);
  let hi = 0;
  for (let i = 0; i < frames; i++) {
    const t0 = real();
    window.__bot.step();
    window.__clock.tick(frameMs);
    times[i] = real() - t0;
    if (i % 60 === 0 && hi < heapN) {
      heap[hi++] = (performance.memory && performance.memory.usedJSHeapSize) || 0;
    }
    if (i % 600 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const sorted = Float64Array.from(times).sort();
  let sum = 0;
  const spikes = [];
  for (let i = 0; i < frames; i++) {
    sum += times[i];
    if (times[i] > 16.7 && spikes.length < 24) spikes.push(i + ':' + times[i].toFixed(1));
  }
  // 힙 하강 = GC. 하강 폭의 최댓값이 톱니 진폭이다.
  let drops = 0, maxDrop = 0;
  for (let i = 1; i < hi; i++) {
    const d = heap[i - 1] - heap[i];
    if (d > 0) { drops++; if (d > maxDrop) maxDrop = d; }
  }
  return {
    frames,
    avg: sum / frames,
    p50: sorted[(frames * 0.5) | 0],
    p99: sorted[(frames * 0.99) | 0],
    max: sorted[frames - 1],
    over16: spikes.length, spikes,
    heapStart: heap[0], heapEnd: heap[hi - 1],
    gcDrops: drops, sawtoothKB: maxDrop / 1024,
    depth: window.__rising.game.depth,
  };
};

async function run() {
  const { chromium } = loadPlaywright();
  const { server, port } = await serve();
  const url = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const results = [];
  const allProfiles = [];
  const shotArg = process.argv.indexOf('--shot');
  const perfOnly = process.argv.includes('--perf');

  if (perfOnly) {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push(e.message));
    await page.addInitScript(CLOCK_INIT);
    await page.addInitScript(BOT);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('!!window.__rising', null, { timeout: 5000 });
    await page.evaluate(`window.__perf = ${PERF.toString()}`);
    // 대조군: rAF 체인을 끊어 게임 루프를 죽이고 클록만 돌린다.
    // 여기서 나오는 힙 증가·톱니는 전부 브라우저·하네스 몫이다. 우리 코드의 몫이 아니다.
    if (process.argv.includes('--null')) {
      await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
    }
    const p = await page.evaluate(() => window.__perf(1000 / 60, 10800));
    await page.close();
    await browser.close();
    server.close();
    console.log('\n─── 3분 연속 구동 (10800 프레임) ' + '─'.repeat(28));
    console.log(`  프레임당 CPU   avg ${p.avg.toFixed(4)}ms  p50 ${p.p50.toFixed(4)}ms  ` +
                `p99 ${p.p99.toFixed(4)}ms  max ${p.max.toFixed(3)}ms`);
    console.log(`  16.7ms 초과    ${p.over16}회 (${(p.over16 / p.frames * 100).toFixed(3)}%)  ` +
                `[프레임:ms] ${p.spikes.join(' ')}`);
    console.log(`  힙             시작 ${(p.heapStart / 1048576).toFixed(2)}MB → 끝 ${(p.heapEnd / 1048576).toFixed(2)}MB`);
    console.log(`  GC 하강        ${p.gcDrops}회, 톱니 진폭 최대 ${p.sawtoothKB.toFixed(1)}KB`);
    console.log(`  도달 발판      ${p.depth}`);
    console.log(`  콘솔           ${logs.length ? logs.join(' | ') : '에러·경고 0개'}`);
    console.log('─'.repeat(62) + '\n');
    console.log('※ 합성 클록 위 측정이다. 프레임 하나를 만드는 CPU 비용이지,');
    console.log('  실기기 프레임 안정성(게이트 #2)이 아니다. 그건 사람이 Performance 탭으로 잰다.\n');
    process.exit(0);
  }

  // ── 한 회차를 특정 프레임 간격으로 구동한다 ──────────────────
  async function drive(frameMs, seconds, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const logs = [];
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') logs.push(`${t}: ${m.text()}`);
    });
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

    await page.addInitScript(CLOCK_INIT);
    await page.addInitScript(BOT);
    if (opts.route) await opts.route(page);

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('!!window.__rising', null, { timeout: 5000 });

    const frames = Math.round((seconds * 1000) / frameMs);
    const state = await page.evaluate(async ({ frameMs, frames, hideAt, mode }) => {
      window.__bot.mode = mode || 'play';
      let sawDead = false;
      let lastProfile = null, switches = 0;
      const seen = {};
      // 판이 끝나면 depth 가 0으로 돌아간다. 마지막 값만 보면 아무것도 못 잰다.
      // 누적 착지 수와 최고 도달을 따로 센다.
      let landed = 0, maxDepth = 0, prevDepth = 0, deaths = 0;
      let hideJump = -1;
      for (let i = 0; i < frames; i++) {
        if (hideAt && i === hideAt) {
          const before = window.__rising.game.tick;
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
          // 30초를 건너뛴다 — 실제 탭 전환과 같은 상황
          window.__clock.tick(30000);
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          document.dispatchEvent(new Event('visibilitychange'));
          window.__clock.tick(frameMs);   // 복귀 후 첫 프레임
          hideJump = window.__rising.game.tick - before;
        }
        window.__bot.step();
        window.__clock.tick(frameMs);
        const gg = window.__rising.game;
        if (gg.state === 5) sawDead = true;
        if (gg.depth > prevDepth) landed += gg.depth - prevDepth;
        else if (gg.depth < prevDepth) deaths++;
        prevDepth = gg.depth;
        if (gg.depth > maxDepth) maxDepth = gg.depth;
        const d = window.__rising.director;
        if (d && !d.observing) {
          if (d.profile !== lastProfile) { lastProfile = d.profile; switches++; seen[d.profile] = (seen[d.profile] || 0) + 1; }
        }
        if (i % 240 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      const g = window.__rising.game;
      const f = window.__rising.feel;
      return {
        tick: g.tick, depth: g.depth, runs: g.runs, sawDead,
        landed, maxDepth, deaths, hideJump,
        playerY: g.playerY, bestY: g.bestY, runBestY: g.runBestY,
        waterY: g.waterY, state: g.state, perfect: g.perfectCount,
        accumulator: window.__rising.accumulator,
        freeze: f ? f.freezeFrames : 0,
        slow: f ? f.slowFrames : 0,
        shake: f ? f.shakeMag : 0,
        score: g.score, comboBest: g.comboBest,
        profiles: Object.keys(seen), switches,
        library: window.__rising.director ? window.__rising.director.librarySize : 0,
        fallback: window.__rising.director ? window.__rising.director.usingFallback : true,
      };
    }, { frameMs, frames, hideAt: opts.hideAt || 0, mode: opts.mode });

    if (shotArg > -1 && opts.shot) await page.screenshot({ path: process.argv[shotArg + 1] });
    await page.close();
    return { state, logs };
  }

  // ── 게이트 #1 · 60Hz vs 120Hz ────────────────────────────────
  const a = await drive(1000 / 60, 30, { shot: true });
  const b = await drive(1000 / 120, 30);
  const depthErr = a.state.landed === 0 ? 1 : Math.abs(a.state.landed - b.state.landed) / a.state.landed;
  results.push({
    gate: '#1 60Hz vs 120Hz 속도 동일성',
    detail: `30초 누적 착지 — 60Hz ${a.state.landed} / 120Hz ${b.state.landed} (오차 ${(depthErr * 100).toFixed(2)}%), ` +
            `시뮬 틱 ${a.state.tick} / ${b.state.tick}, ` +
            `최고 도달 ${a.state.maxDepth} / ${b.state.maxDepth}, 사망 ${a.state.deaths} / ${b.state.deaths}`,
    pass: depthErr < 0.03,
  });

  // ── 게이트 #8 · 콘솔 청결 ────────────────────────────────────
  results.push({
    gate: '#8 콘솔 청결',
    detail: a.logs.length ? a.logs.join(' | ') : '에러·경고 0개',
    pass: a.logs.length === 0,
  });

  // ── 재현성 · 같은 타이밍에 떼면 같은 결과 ────────────────────
  // 조준 진동이 사인파라는 것의 실증. 난수였다면 여기서 갈린다.
  const rep = await drive(1000 / 60, 30);
  const same = rep.state.playerY === a.state.playerY
            && rep.state.depth === a.state.depth
            && rep.state.perfect === a.state.perfect;
  results.push({
    gate: '재현성 — 조준 진동이 사인파인가',
    detail: `동일 입력 2회: 도달 발판 ${a.state.depth}/${rep.state.depth}, ` +
            `완벽착지 ${a.state.perfect}/${rep.state.perfect}, ` +
            `최종 playerY ${a.state.playerY.toFixed(6)} / ${rep.state.playerY.toFixed(6)}`,
    pass: same,
  });

  // ── 입력 지연 · 큐가 프레임 시작에서 소비되는가 ──────────────
  {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    await page.addInitScript(CLOCK_INIT);
    await page.addInitScript(BOT);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('!!window.__rising', null, { timeout: 5000 });
    const latency = await page.evaluate(() => {
      const R = window.__rising, g = R.game;
      window.__clock.tick(1000 / 60);            // 루프 기동
      window.__clock.tick(1000 / 60);
      const before = g.state;
      R.inject('down', window.performance.now());
      window.__clock.tick(1000 / 60);            // 딱 한 프레임
      return { before, after: g.state };
    });
    await page.close();
    results.push({
      gate: '#4 입력 지연 — 큐 소비 프레임 수 (코드 레벨)',
      detail: `입력 주입 → 1프레임 후 상태 ${latency.before} → ${latency.after} (0=READY, 1=CHARGING)`,
      pass: latency.before === 0 && latency.after === 1,
    });
  }

  // ── 루프 왕복 · 죽고 다시 시작되는가 ─────────────────────────
  const idle = await drive(1000 / 60, 32, { mode: 'idle' });
  results.push({
    gate: '루프 왕복 — 죽고 다시 시작된다',
    detail: `방치 32초: 사망 관측 ${idle.state.sawDead}, 재시작 후 판수 ${idle.state.runs}, ` +
            `현재 상태 ${idle.state.state} (5=DEAD), 도달 발판 ${idle.state.depth}`,
    pass: idle.state.sawDead && idle.state.runs >= 2 && idle.state.state !== 5,
  });

  // ── 게이트 #3 · 탭 전환 복귀 ─────────────────────────────────
  // 30초를 건너뛴 직후 첫 프레임에서 시뮬이 몇 스텝 돌았는지를 **직접** 잰다.
  // 누산기가 폭주하면 여기서 1800스텝(30초분)이 한 프레임에 쏟아진다.
  // 대조군 비교는 사망 횟수 변동에 묻혀서 이 신호를 못 잡는다.
  const c = await drive(1000 / 60, 20, { hideAt: 300 });
  results.push({
    gate: '#3 탭 전환 복귀 (30초 방치) — 누산기 폭주',
    detail: `숨김 30초를 건너뛴 직후 첫 프레임의 시뮬 스텝 ${c.state.hideJump}개 ` +
            `(폭주하면 1800개가 한 프레임에 쏟아진다. 정상은 0~1)  ·  ` +
            `누산기 잔여 ${c.state.accumulator.toFixed(3)}ms, 히트스톱 잔여 ${c.state.freeze}f / 슬로우 ${c.state.slow}f`,
    pass: c.state.hideJump >= 0 && c.state.hideJump <= 2 && c.state.freeze <= 8 && c.state.slow <= 24,
  });

  // ── 디렉터 · 5개 프로파일이 실제로 판정되는가 ────────────────
  {
    const modes = ['safe', 'precise', 'reckless'];
    const found = [];
    let maxSw = 0;
    for (const m of modes) {
      const r = await drive(1000 / 60, 45, { mode: m });
      found.push(m + '→[' + r.state.profiles.join(',') + '] 전환' + r.state.switches + '회');
      if (r.state.switches > maxSw) maxSw = r.state.switches;
      for (const p of r.state.profiles) if (allProfiles.indexOf(p) < 0) allProfiles.push(p);
    }
    results.push({
      gate: '디렉터 — 성향별로 다른 프로파일이 판정되는가',
      detail: found.join(' | ') + '  ·  관측된 프로파일 ' + allProfiles.length + '종: ' + allProfiles.join(','),
      pass: allProfiles.length >= 3,
    });
    results.push({
      gate: '디렉터 — 프로파일이 매 프레임 튀지 않는가',
      detail: '45초 플레이 중 최대 전환 ' + maxSw + '회 (프레임 단위로 튀면 수백 회가 나온다)',
      pass: maxSw <= 8,
    });
  }

  // ── 게이트 #10 · LLM 폴백 (data/*.json 존재할 때만 의미 있음) ─
  if (fs.existsSync(path.join(ROOT, 'data'))) {
    const blocked = await drive(1000 / 60, 30, {
      route: async (page) => {
        await page.route('**/data/*.json', (r) => r.abort());
      },
    });
    const corrupt = await drive(1000 / 60, 30, {
      route: async (page) => {
        await page.route('**/data/*.json', (r) =>
          r.fulfill({ status: 200, contentType: 'application/json', body: '{"chunks":[[[' }));
      },
    });
    // 일부러 차단했으니 브라우저의 리소스 로드 실패 로그는 당연히 찍힌다.
    // 그건 테스터가 만든 것이고 게임의 잘못이 아니다. 그 외 에러만 센다.
    const warnOnly = (logs) => logs.filter((l) =>
      (l.startsWith('error') || l.startsWith('pageerror')) && l.indexOf('Failed to load resource') < 0);
    results.push({
      gate: '#10 LLM 폴백 — 차단',
      detail: `30초 누적 착지 ${blocked.state.landed}, 치명 로그 ${warnOnly(blocked.logs).length}개`,
      pass: blocked.state.landed > 0 && warnOnly(blocked.logs).length === 0,
    });
    results.push({
      gate: '#10 LLM 폴백 — JSON 파손',
      detail: `30초 누적 착지 ${corrupt.state.landed}, 치명 로그 ${warnOnly(corrupt.logs).length}개`,
      pass: corrupt.state.landed > 0 && warnOnly(corrupt.logs).length === 0,
    });
  }

  await browser.close();
  server.close();

  console.log('\n─── 헤드리스 측정 결과 ' + '─'.repeat(40));
  let failed = 0;
  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) failed++;
    console.log(`[${mark}] ${r.gate}\n        ${r.detail}`);
  }
  console.log('─'.repeat(62));
  console.log(failed === 0 ? '전부 통과.' : `${failed}개 실패.`);
  console.log('\n※ 실기기로만 잴 수 있는 항목(#2 실측 · #4 · #5 · #6 · #7 · #9 · #11)은 여기서 판정하지 않는다.\n');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(2); });
