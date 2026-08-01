// 자동 평가 — 평론가(프롬프트 8)가 매 회차 돌리는 계측기.
//
//   NODE_PATH=$(npm root -g) node tools/evaluate.mjs
//   NODE_PATH=$(npm root -g) node tools/evaluate.mjs --json    ← 루프가 읽는 형식
//
// 인상이 아니라 숫자를 낸다. 평론가는 이 숫자로 점수를 매기고,
// 점수가 낮은 항목을 고친 뒤 다시 이걸 돌려 **올랐는지 확인한다.**
// 올랐는지 확인하지 않는 수정은 수정이 아니라 추측이다.
//
// 재는 것:
//   1. 판이 끝나는가 — 네 가지 전략으로 각각 5분 안에 결말이 나는가
//   2. 결말이 갈리는가 — 전부 같은 결말이면 전략 선택이 무의미하다
//   3. 판 길이 — 플래시게임의 판은 2~3분이다
//   4. 첫 30초에 무엇을 만나는가
//   5. 디렉터가 장식이 아닌가 — 프로파일을 고정하고 적 구성이 실제로 갈리는지
//   6. 콘솔 청결 · 프레임 비용

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

// 네 가지 전략. **원형이어야 한다** — 미세한 편향으로는 아무것도 갈리지 않는다.
// (러너에서 이걸로 크게 데였다: 다섯 봇의 지표 중앙값이 전부 겹쳐서
//  임계값을 어디에 두든 분리가 불가능했다)
const STRATEGIES = ['spam', 'giant', 'turtle', 'econ'];

const BOT = () => {
  window.__play = (mode) => {
    const R = window.__rising, A = R.ACT, g = R.game;
    if (g.state === 2) return;                        // 결과 화면
    if (g.state === 1) { R.inject(A.PICK0, performance.now()); return; }
    const t = performance.now();
    if (mode !== 'turtle' && g.eraReady()) R.inject(A.ERA, t);
    if (mode === 'econ') {
      // 모았다가 한꺼번에 쏟는다
      if (g.gold > 400) for (let k = 0; k < 3; k++) {
        if (g.spawnCd[k] <= 0 && g.gold >= g.cost(k)) { R.inject(k, t); break; }
      }
    } else if (mode === 'turtle') {
      if (g.gold > 900) R.inject(0, t);
    } else if (mode === 'giant') {
      if (g.spawnCd[2] <= 0 && g.gold >= g.cost(2)) R.inject(2, t);
      else if (g.spawnCd[0] <= 0 && g.gold >= g.cost(0)) R.inject(0, t);
    } else {
      for (let k = 0; k < 3; k++) {
        if (g.spawnCd[k] <= 0 && g.gold >= g.cost(k)) { R.inject(k, t); break; }
      }
    }
    if (g.nukeCd <= 0 && g.aliveR > 4) R.inject(A.NUKE, t);
  };
};

const OUTCOME = ['진행중', '승리', '패배', '둘다잠김'];

async function run() {
  const { chromium } = loadPlaywright();
  const { server, port } = await serve();
  const url = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const report = { matches: [], first30: null, director: [], console: [], perf: null };

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

  // ── 1~3. 판이 끝나는가 · 결말이 갈리는가 · 얼마나 걸리는가 ──
  for (const mode of STRATEGIES) {
    const p = await page0();
    const r = await p.evaluate(async (mode) => {
      const g = window.__rising.game;
      for (let i = 0; i < 60 * 60 * 5; i++) {
        if (i % 12 === 0) window.__play(mode);
        window.__clock.tick(1000 / 60);
        if (g.state === 2) break;
        if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
      }
      return {
        seconds: +g.elapsed().toFixed(0), outcome: g.state === 2 ? g.outcome : -1,
        myHp: g.baseHp[0] | 0, foeHp: g.baseHp[1] | 0, era: g.era,
        kills: g.kills, lost: g.lost, spawned: g.spawned,
        profile: window.__rising.director.profile,
      };
    }, mode);
    await p.close();
    report.matches.push(Object.assign({ mode }, r));
  }

  // ── 4. 첫 30초에 무엇을 만나는가 ──
  {
    const p = await page0();
    report.first30 = await p.evaluate(async () => {
      const g = window.__rising.game;
      const seen = {}, firstAt = {};
      const orig = g.emit.bind(g);
      g.emit = (t, a, b) => {
        seen[t] = (seen[t] || 0) + 1;
        if (firstAt[t] === undefined) firstAt[t] = +(g.tick / 60).toFixed(1);
        orig(t, a, b);
      };
      for (let i = 0; i < 1800; i++) {
        if (i % 12 === 0) window.__play('spam');
        window.__clock.tick(1000 / 60);
        if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
      }
      return { seen, firstAt, gold: g.gold | 0, era: g.era, spawned: g.spawned, kills: g.kills };
    });
    await p.close();
  }

  // ── 5. 디렉터가 장식인가 판단인가 ──
  // **프로파일을 직접 고정해서 잰다.** 봇의 분류에 의존하면 BALANCED(레버가
  // 원래 중립)만 나와 "레버가 아무것도 안 한다"는 틀린 결론이 나온다.
  for (const prof of ['BALANCED', 'RUSHER', 'TURTLE', 'ECONOMIST', 'SWARMER']) {
    const p = await page0();
    const r = await p.evaluate(async (prof) => {
      const R = window.__rising, g = R.game, d = R.director;
      d.onChunkBoundary = function (game, ci) {
        this.difficulty = Math.max(0, Math.min(4, (game.simTime / 22000) | 0));
        this.observing = false; this.profile = prof; this.profileIdx = 0; this.applyLevers();
      };
      g.reset();
      const spawnKind = [0, 0, 0];
      const orig = g.emit.bind(g);
      g.emit = (t, a, b) => { if (t === 0 && b === 1) spawnKind[a]++; orig(t, a, b); };
      for (let i = 0; i < 60 * 90; i++) {
        if (i % 12 === 0) window.__play('spam');
        window.__clock.tick(1000 / 60);
        if (g.state === 2) g.reset();
        if (i % 600 === 0) await new Promise((x) => setTimeout(x, 0));
      }
      const tot = spawnKind[0] + spawnKind[1] + spawnKind[2] || 1;
      return {
        profile: prof, total: tot,
        sword: +(spawnKind[0] / tot).toFixed(3),
        archer: +(spawnKind[1] / tot).toFixed(3),
        giant: +(spawnKind[2] / tot).toFixed(3),
        tempo: Math.round(d.levers.tempo),
      };
    }, prof);
    await p.close();
    report.director.push(r);
  }

  // ── 6. 프레임 비용 ──
  {
    const p = await page0();
    report.perf = await p.evaluate(async () => {
      const real = window.__clock.real;
      const N = 7200, times = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const t0 = real();
        if (i % 12 === 0) window.__play('spam');
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
  }

  await browser.close();
  server.close();

  // ── 파생 판정 — 루프가 이 값들을 보고 다음 수정을 정한다 ──
  // 결말 종류만 세면 안 된다. 무승부를 없애자 승/승/패/승이 되어 "종류 2"로
  // 떨어졌는데, 이건 후퇴가 아니라 **지표가 조악했던 것**이다 —
  // 무승부가 병증이었고 승패는 정상 결말이다.
  // 전략이 갈리는지는 결말과 **판 길이**를 함께 봐야 한다.
  // 82초 승리와 222초 승리는 같은 결말이지만 전혀 다른 판이다.
  const outcomes = new Set(report.matches.map((m) => m.outcome + ':' + Math.floor(m.seconds / 60)));
  const unresolved = report.matches.filter((m) => m.outcome < 0).length;
  const draws = report.matches.filter((m) => m.outcome === 3).length;
  const lengths = report.matches.filter((m) => m.outcome > 0).map((m) => m.seconds);
  const avgLen = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
  const mixSig = new Set(report.director.map((d) => [d.sword, d.archer, d.giant]
    .map((v) => Math.round(v * 10)).join(',')));

  report.verdict = {
    끝나지_않은_판: unresolved,
    서로_다른_결말: outcomes.size,
    무승부: draws,
    평균_판_길이_초: avgLen,
    디렉터_구성_분화: mixSig.size,
    콘솔_에러경고: report.console.length,
    프레임_초과: report.perf.over16,
  };

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log('\n─── 자동 평가 ' + '─'.repeat(48));
  console.log('\n[1] 판 결말 — 전략마다 다른 결말이 나와야 한다');
  for (const m of report.matches) {
    console.log('  ' + m.mode.padEnd(7) +
      (m.outcome < 0 ? '5분 내 안 끝남' : OUTCOME[m.outcome]).padEnd(9) +
      String(m.seconds).padStart(4) + '초   내기지 ' + String(m.myHp).padStart(4) +
      '  적기지 ' + String(m.foeHp).padStart(4) + '  시대 ' + m.era +
      '  처치 ' + m.kills + '  판정 ' + m.profile);
  }

  console.log('\n[2] 첫 30초');
  const N = { 0: '소환', 2: '처치', 3: '기지피해', 5: '시대진화', 6: '해일',
              7: '금부족', 9: '물경고', 11: '드래프트', 13: '승리', 14: '패배' };
  for (const k of Object.keys(N)) {
    const c = report.first30.seen[k];
    console.log('  ' + N[k].padEnd(9) + (c ? String(c).padStart(3) + '회   첫 등장 ' + report.first30.firstAt[k] + '초'
                                            : '  — 30초 안에 안 나온다'));
  }

  console.log('\n[3] 디렉터 — 프로파일을 고정하고 적 구성을 쟀다');
  for (const d of report.director) {
    console.log('  ' + d.profile.padEnd(10) + '검 ' + (d.sword * 100).toFixed(0).padStart(3) + '%' +
      '  궁 ' + (d.archer * 100).toFixed(0).padStart(3) + '%' +
      '  거 ' + (d.giant * 100).toFixed(0).padStart(3) + '%' +
      '  간격 ' + d.tempo + 'ms   (표본 ' + d.total + ')');
  }

  console.log('\n[4] 프레임   avg ' + report.perf.avg + 'ms  p99 ' + report.perf.p99 +
              'ms  max ' + report.perf.max + 'ms  16.7ms 초과 ' + report.perf.over16 + '회');
  console.log('[5] 콘솔     ' + (report.console.length ? report.console.join(' | ') : '에러·경고 0개'));

  console.log('\n─── 판정 ' + '─'.repeat(52));
  for (const [k, v] of Object.entries(report.verdict)) {
    console.log('  ' + k.replace(/_/g, ' ').padEnd(20) + v);
  }
  console.log('');
}

run().catch((e) => { console.error(e); process.exit(2); });
