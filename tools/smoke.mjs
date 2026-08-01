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
  const pending = [];
  const origNow = window.performance.now.bind(window.performance);
  window.performance.now = () => t;
  window.requestAnimationFrame = (cb) => { pending.push(cb); return pending.length; };
  window.cancelAnimationFrame = () => {};
  window.__clock = {
    now: () => t,
    real: origNow,
    tick(ms) {
      t += ms;
      const batch = pending.splice(0, pending.length);
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
      if (g.state === S_READY && !this.pressed) {
        // 반대편 벽의 다음 발판까지의 간격
        const target = g.platIdx + 1;
        g.ensurePlatform(target + 2);
        const gap = g.platYAt(target) - g.playerY;
        const ratio = (gap - C.LEAP_DIST_MIN) / (C.LEAP_DIST_MAX - C.LEAP_DIST_MIN);
        const clamped = Math.max(0, Math.min(1, ratio));
        this.hold = Math.max(C.CHARGE_MIN_MS, clamped * C.CHARGE_MAX_MS);
        R.inject('down', t);
        this.pressed = true;
        this.pressAt = t;
        return;
      }
      if (g.state === S_CHARGING && this.pressed && t - this.pressAt >= this.hold) {
        R.inject('up', t);
        this.pressed = false;
      }
    },
  };
};

async function run() {
  const { chromium } = loadPlaywright();
  const { server, port } = await serve();
  const url = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const results = [];
  const shotArg = process.argv.indexOf('--shot');

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
      for (let i = 0; i < frames; i++) {
        if (hideAt && i === hideAt) {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
          // 30초를 건너뛴다 — 실제 탭 전환과 같은 상황
          window.__clock.tick(30000);
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          document.dispatchEvent(new Event('visibilitychange'));
        }
        window.__bot.step();
        window.__clock.tick(frameMs);
        if (window.__rising.game.state === 5) sawDead = true;
        if (i % 240 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      const g = window.__rising.game;
      const f = window.__rising.feel;
      return {
        tick: g.tick, depth: g.depth, runs: g.runs, sawDead,
        playerY: g.playerY, bestY: g.bestY, runBestY: g.runBestY,
        waterY: g.waterY, state: g.state, perfect: g.perfectCount,
        accumulator: window.__rising.accumulator,
        freeze: f ? f.freezeFrames : 0,
        slow: f ? f.slowFrames : 0,
        shake: f ? f.shakeMag : 0,
      };
    }, { frameMs, frames, hideAt: opts.hideAt || 0, mode: opts.mode });

    if (shotArg > -1 && opts.shot) await page.screenshot({ path: process.argv[shotArg + 1] });
    await page.close();
    return { state, logs };
  }

  // ── 게이트 #1 · 60Hz vs 120Hz ────────────────────────────────
  const a = await drive(1000 / 60, 30, { shot: true });
  const b = await drive(1000 / 120, 30);
  const depthErr = a.state.depth === 0 ? 1 : Math.abs(a.state.depth - b.state.depth) / a.state.depth;
  results.push({
    gate: '#1 60Hz vs 120Hz 속도 동일성',
    detail: `30초 후 도달 발판 — 60Hz ${a.state.depth} / 120Hz ${b.state.depth} (오차 ${(depthErr * 100).toFixed(2)}%), ` +
            `시뮬 틱 ${a.state.tick} / ${b.state.tick}, ` +
            `완벽착지 ${a.state.perfect} / ${b.state.perfect}, ` +
            `도달높이 ${a.state.runBestY.toFixed(2)} / ${b.state.runBestY.toFixed(2)}`,
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
  // 대조군(탭 전환 없음)과 비교한다. 절대값이 아니라 편차가 증거다.
  const ctrl = await drive(1000 / 60, 20);
  const c = await drive(1000 / 60, 20, { hideAt: 300 });
  const tickDrift = Math.abs(c.state.tick - ctrl.state.tick) / ctrl.state.tick;
  results.push({
    gate: '#3 탭 전환 복귀 (30초 방치)',
    detail: `시뮬 틱 — 대조군 ${ctrl.state.tick} / 탭 전환 ${c.state.tick} (편차 ${(tickDrift * 100).toFixed(2)}%), ` +
            `누산기 잔여 ${c.state.accumulator.toFixed(3)}ms, ` +
            `히트스톱 잔여 ${c.state.freeze}f / 슬로우 잔여 ${c.state.slow}f — 누적 폭발 없음`,
    pass: tickDrift < 0.03 && c.state.freeze <= 8 && c.state.slow <= 24,
  });

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
    const warnOnly = (logs) => logs.filter((l) => l.startsWith('error') || l.startsWith('pageerror'));
    results.push({
      gate: '#10 LLM 폴백 — 차단',
      detail: `30초 플레이 도달 발판 ${blocked.state.depth}, 치명 로그 ${warnOnly(blocked.logs).length}개`,
      pass: blocked.state.depth > 0 && warnOnly(blocked.logs).length === 0,
    });
    results.push({
      gate: '#10 LLM 폴백 — JSON 파손',
      detail: `30초 플레이 도달 발판 ${corrupt.state.depth}, 치명 로그 ${warnOnly(corrupt.logs).length}개`,
      pass: corrupt.state.depth > 0 && warnOnly(corrupt.logs).length === 0,
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
