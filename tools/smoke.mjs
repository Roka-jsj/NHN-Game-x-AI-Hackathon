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
// 앞의 행들을 읽고 레인 비용을 계산해 목표 레인을 고른 뒤,
// 자세(점프·슬라이드)는 **리드타임을 역산해서** 누른다.
//
// ★ 봇은 화면 주사율이 아니라 고정 60Hz 격자에서만 판단하고, 주입하는 timeStamp도
//   격자 시각이다. 이렇게 하지 않으면 120Hz 회차의 봇이 두 배 자주 폴링해서
//   반응이 빨라지고, 게임이 아니라 측정 도구 때문에 결과가 갈린다.
//   사람의 반응 속도는 주사율에 비례해서 빨라지지 않는다.
//
// ★ 봇이 무능하면 난이도 판단 전체가 틀린다. 이 봇은 두 번 크게 틀렸다:
//   (1) 리드타임 없이 장애물 위에서 눌러 점프가 안 끝났고,
//   (2) 레인을 옮긴 뒤 return 해버려 옮긴 레인의 낮은 벽에 그대로 박았다.
//   둘 다 게임이 아니라 측정 도구의 버그였다.
const BOT = () => {
  const GRID = 1000 / 60;
  window.__bot = {
    k: 0, next: 0, mode: 'play', decisions: 0,
    step() {
      const now = window.performance.now();
      while (now + 1e-6 >= this.next) {
        this.decide(this.next);
        this.k++;
        this.next = this.k * GRID;
      }
    },

    // 레인 통과 비용. 0=자유, 1=자세로 넘음, 99=기둥(자세로는 못 넘는다)
    cost(g, row, lane) {
      if (row < 0 || row > g.rowMade) return 0;
      const ob = g.rowOb(row, lane);
      if (ob === 0) return 0;
      if (ob === 3) return 99;
      return 1;
    },

    // 결정론적 흔들림. Math.random 을 쓰면 재현성 게이트가 무의미해진다.
    jitter(n) { return ((n * 2654435761) % 1000) / 1000; },

    decide(t) {
      const R = window.__rising;
      if (!R) return;
      const g = R.game, C = R.C, A = R.ACT;
      this.decisions++;
      const S_RUN = 0, S_STAIR = 1, S_DRAFT = 2, S_DEAD = 3;

      if (g.state === S_DEAD) { R.inject(A.LEFT, t); return; }
      if (g.state === S_DRAFT) { R.inject(A.PICK0 + (this.pickSlot | 0), t); return; }
      if (g.state === S_STAIR) {
        // 계단은 순서 게임이다. sloppy 봇만 결정론적으로 가끔 틀린다.
        let side = g.stairSide;
        if (this.mode === 'sloppy' && this.jitter(g.stairStep + 7) > 0.75) side = 1 - side;
        R.inject(side === 0 ? A.LEFT : A.RIGHT, t);
        return;
      }
      // idle 모드: 아무것도 하지 않고 물에 잠기기를 기다린다 (사망→재시작 왕복 검증)
      if (this.mode === 'idle') return;

      // ── 성향별 봇 ────────────────────────────────────────────
      // 디렉터가 사람을 읽는지 확인하려면 **정말로 다르게 노는** 플레이어가 필요하다.
      //
      // 처음엔 하나의 봇에 -0.4 중앙 가중치, -0.6 코인 가중치 같은 미세한
      // 편향을 얹어 다섯 성향을 만들었다. 그러고 판정 시점의 지표 분포를
      // 재 봤더니 다섯 봇의 중앙값이 lane 0.57~0.60, greed 0.33~0.40,
      // near 0.17~0.25 로 전부 겹쳤다. 임계값을 어디에 두든 분리될 수 없는
      // 분포였다. 즉 **측정 도구가 재려는 공간을 못 덮고 있었다.**
      //
      // 그래서 미세 편향이 아니라 원형(archetype)으로 다시 짰다:
      //   safe    겁쟁이  중앙에서 나가지 않는다. 코인을 아예 안 본다
      //   greedy  도박꾼  코인이 있으면 넘어야 하는 레인이라도 간다. 늦게 끼어든다
      //   precise 장인    멀리 보고 일찍 옮기고, 자세의 정점을 장애물에 맞춘다
      //   sloppy  초심자  리드타임이 0.3배에서 1.7배까지 들쭉날쭉하다
      //   play    보통    적당히 피하고 가까운 코인만 줍는다
      const M = this.mode;

      const look = M === 'precise' ? 6 : (M === 'greedy' ? 3 : 4);
      const first = Math.floor(g.travelled / C.ROW_SPACING);
      let row = -1, z = 0;
      for (let r = first; r <= first + look; r++) {
        if (r > g.rowMade) break;
        const zz = g.rowZ(r) - g.travelled;
        if (zz <= 8) continue;
        let any = false;
        for (let l = 0; l < 3; l++) if (g.rowOb(r, l)) { any = true; break; }
        if (!any) continue;
        row = r; z = zz; break;
      }

      // 겁쟁이는 앞이 비면 무조건 중앙으로 돌아온다. 코인은 쳐다보지 않는다.
      if (row < 0) {
        if (M === 'safe') { if (g.lane !== 1) R.inject(g.lane < 1 ? A.RIGHT : A.LEFT, t); return; }
        if (M === 'greedy' || M === 'play') this.chaseCoin(g, R, A, t, first, M === 'greedy' ? 3 : 2);
        return;
      }

      // ── 목표 레인 ──
      let best;
      if (M === 'safe') {
        // 중앙이 기둥일 때만 비켜선다. 낮은 벽·높은 빔은 자세로 넘고 자리를 지킨다.
        best = this.cost(g, row, 1) > 90 ? (this.cost(g, row, 0) > 90 ? 2 : 0) : 1;
        if (Math.abs(best - g.lane) > 1) best = g.lane;
      } else {
        let bestCost = 1e9;
        best = g.lane;
        for (let l = 0; l < 3; l++) {
          if (Math.abs(l - g.lane) > 1) continue;          // 한 번에 한 칸
          let c = this.cost(g, row, l) * 10 + this.cost(g, row + 1, l);
          if (l !== g.lane) c += 0.5;                      // 굳이 안 옮긴다
          // 도박꾼은 **넘을 수 있는** 장애물이 있어도 코인 쪽으로 간다.
          // 기둥(990)만은 못 넘는다. 이게 도박꾼과 자살의 차이다.
          if (this.coinNear(g, row, l)) c -= (M === 'greedy' ? 12 : (M === 'play' ? 0.6 : 0));
          if (c < bestCost) { bestCost = c; best = l; }
        }
      }

      // ── 언제 옮기는가 ──
      // 이동(130ms) 후에 점프(정점까지 230ms)까지 해야 하므로 둘 다 들어갈 여유가 필요하다.
      // 그리고 **옮겼다고 끝내면 안 된다** — 옮긴 레인에서 점프해야 할 수도 있다.
      // 도박꾼은 마지막 순간에 끼어들어 보간이 끝나기 전에 행을 만난다. 그게 아슬아슬이다.
      //
      // precise 의 임계값을 300 으로 올렸더니 90초에 12번 죽었다. 이건 목표가 아니라
      // **최소 여유**라서, 크게 잡으면 늦게 나타난 행에는 아예 못 옮긴다.
      // 장인다움은 늦게 못 움직이는 게 아니라 더 멀리 보는 것이다 — lookahead 로 준다.
      let shiftAt = M === 'greedy' ? 70 : 170;
      if (M === 'sloppy') shiftAt = 40 + this.jitter(row + 3) * 300;
      let lane = g.lane;
      if (best !== g.lane && z > shiftAt) {
        R.inject(best < g.lane ? A.LEFT : A.RIGHT, t);
        lane = best;
      }

      // ── 자세 ──
      // 점프 460ms 는 정점이 230ms 뒤다. 속도 × 0.23 만큼 앞에서 눌러야
      // 정점이 장애물 위에 온다. 배수 1.0 이 곧 정확한 플레이다.
      const ob = g.rowOb(row, lane);
      const spd = g.speed > 1 ? g.speed : 1;
      let mul = 1;
      if (M === 'greedy') mul = 0.62;
      // 초심자는 실제로 못 맞춘다. 0.15배(코앞)에서 2.0배(너무 이르게)까지 튄다 —
      // 그래야 부딪히고, 부딪혀야 ERRATIC 이 잡으려던 사람이 된다.
      else if (M === 'sloppy') mul = 0.15 + this.jitter(row) * 1.85;
      if (ob === 1) {
        const lead = spd * (C.JUMP_MS / 2000) * mul;
        if (z <= lead && g.vstate !== 1) R.inject(A.JUMP, t);
      } else if (ob === 2) {
        const lead = (spd * (C.SLIDE_MS / 3000) + 60) * mul;
        if (z <= lead && g.vstate !== 2) R.inject(A.SLIDE, t);
      }
    },

    // 이 행이나 바로 다음 행에 아직 안 먹은 코인이 있는가
    coinNear(g, row, lane) {
      return (g.rowCoin(row, lane) && !g.rowTaken(row, lane))
          || (g.rowCoin(row + 1, lane) && !g.rowTaken(row + 1, lane));
    },

    // 장애물이 없을 때만 부른다. 코인은 대개 위험한 레인에 있으므로
    // 이 함수를 켜고 끄는 것만으로 greed 지표가 갈린다.
    chaseCoin(g, R, A, t, first, span) {
      for (let r = first; r <= first + span; r++) {
        if (r > g.rowMade) break;
        const zz = g.rowZ(r) - g.travelled;
        if (zz <= 8 || zz > 700) continue;
        for (let l = 0; l < 3; l++) {
          if (!g.rowCoin(r, l) || g.rowTaken(r, l)) continue;
          if (l === g.lane) return;
          if (Math.abs(l - g.lane) === 1 && zz > 120) {
            R.inject(l < g.lane ? A.LEFT : A.RIGHT, t);
            return;
          }
        }
      }
    },
  };
};

// 3분 연속 구동하며 프레임당 CPU 비용과 힙 톱니를 잰다.
// 합성 클록 위에서 재므로 "실기기 프레임 안정성(게이트 #2)"이 아니라
// "프레임 하나를 만드는 데 드는 CPU 비용"을 잰다. 개선 전/후 비교용 숫자다.
const PERF = async (frameMs, frames) => {
  const real = window.__clock.real;
  const times = new Float64Array(frames);
  const states = new Uint8Array(frames);   // 스파이크 프레임에 무엇을 그리고 있었나
  const heapN = Math.ceil(frames / 60);
  const heap = new Float64Array(heapN);
  let hi = 0;
  for (let i = 0; i < frames; i++) {
    const t0 = real();
    window.__bot.step();
    window.__clock.tick(frameMs);
    times[i] = real() - t0;
    states[i] = window.__rising.game.state;
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
    if (times[i] > 16.7 && spikes.length < 24) spikes.push(i + ':' + times[i].toFixed(1) + '/' + states[i]);
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
    meters: window.__rising.game.meters(),
    runs: window.__rising.game.runs,
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
    // 부분 대조군 — 어느 계통이 스파이크를 만드는지 좁힌다.
    //   --off=render / audio / director
    // 픽셀 수를 1/4로 줄여 본다. 스파이크가 채우기 면적에 비례하면
    // 여기서 눈에 띄게 줄어든다 — 그러면 우리 JS 가 아니라 래스터 비용이다.
    if (process.argv.includes('--half')) {
      await page.evaluate(() => {
        const cv = document.getElementById('game');
        cv.width = Math.max(1, Math.round(cv.width / 2));
        cv.height = Math.max(1, Math.round(cv.height / 2));
        window.__rising.renderer.resize(cv.width / window.__rising.C.VIEW_W);
      });
    }
    const offArg = process.argv.find((a) => a.startsWith('--off='));
    if (offArg) {
      await page.evaluate((which) => {
        const R = window.__rising;
        if (which === 'render') R.renderer.draw = () => {};
        if (which === 'audio') { R.audio.onEvent = () => {}; R.audio.update = () => {}; }
        if (which === 'director') R.director.step = () => {};
      }, offArg.slice(6));
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
    console.log(`  최종 판수      ${p.runs}판, 마지막 판 ${p.meters.toFixed(0)}m`);
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
    const state = await page.evaluate(async ({ frameMs, frames, hideAt, mode, pickSlot }) => {
      window.__bot.mode = mode || 'play';
      window.__bot.pickSlot = pickSlot || 0;
      let sawDead = false;
      let lastProfile = null, switches = 0;
      const seen = {};
      // 판이 끝나면 travelled 가 0으로 돌아간다. 마지막 값만 보면 아무것도 못 잰다.
      // 누적 주행거리와 최고 도달을 따로 센다.
      let dist = 0, maxDist = 0, prevDist = 0, deaths = 0, coins = 0, prevCoins = 0;
      let stairs = 0, drafts = 0, picks = 0;
      let prevState = -1, hideJump = -1;
      // 트랙 통과 가능성은 봇이 아니라 **정적으로** 센다.
      // 봇이 죽는 건 봇이 못해서일 수도 있지만, 세 레인이 동시에 막힌 행은
      // 누가 플레이해도 즉사다. 생성된 행을 하나씩 직접 본다.
      let rowsSeen = 0, rowsBlocked = 0, lastRow = -1;
      const draftKinds = [0, 0, 0];
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

        if (gg.travelled >= prevDist) dist += gg.travelled - prevDist;
        else dist += gg.travelled;              // 리셋됐다
        prevDist = gg.travelled;
        if (gg.travelled > maxDist) maxDist = gg.travelled;
        if (gg.coins >= prevCoins) coins += gg.coins - prevCoins; else coins += gg.coins;
        prevCoins = gg.coins;

        if (gg.state !== prevState) {
          if (gg.state === 3) { sawDead = true; deaths++; }
          if (gg.state === 1) stairs++;
          // 드래프트에서 러너로 돌아왔다 = 특성을 하나 골랐다.
          // 최종 traits 배열만 보면 안 된다 — 그 사이에 죽으면 0으로 리셋된다.
          if (prevState === 2 && gg.state === 0) picks++;
          if (gg.state === 2) {
            drafts++;
            for (let s = 0; s < gg.draftIdx.length; s++) {
              const idx = gg.draftIdx[s];
              if (idx >= 0) draftKinds[window.__rising.C.TRAITS[idx].kind]++;
            }
          }
          prevState = gg.state;
        }

        while (lastRow < gg.rowMade) {
          lastRow++;
          if (lastRow < 0) continue;
          rowsSeen++;
          let blocked = 0;
          for (let l = 0; l < 3; l++) if (gg.rowOb(lastRow, l)) blocked++;
          if (blocked === 3) rowsBlocked++;
        }

        const d = window.__rising.director;
        if (d && !d.observing) {
          if (d.profile !== lastProfile) { lastProfile = d.profile; switches++; seen[d.profile] = (seen[d.profile] || 0) + 1; }
        }
        if (i % 240 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      const g = window.__rising.game;
      const f = window.__rising.feel;
      let traits = 0;
      for (let i = 0; i < g.traits.length; i++) traits += g.traits[i];
      return {
        tick: g.tick, runs: g.runs, sawDead, state: g.state,
        dist, maxDist, deaths, coins, hideJump,
        stairs, drafts, picks, traits, draftKinds,
        rowsSeen, rowsBlocked,
        travelled: g.travelled, worldX: g.worldX, gap: g.gap,
        hits: g.hits, nearMisses: g.nearMisses, jumps: g.jumps, slides: g.slides,
        accumulator: window.__rising.accumulator,
        freeze: f ? f.freezeFrames : 0,
        slow: f ? f.slowFrames : 0,
        shake: f ? f.shakeMag : 0,
        score: g.score, comboBest: g.comboBest, bestScore: g.bestScore,
        profiles: Object.keys(seen), switches,
        library: window.__rising.director ? window.__rising.director.librarySize : 0,
        fallback: window.__rising.director ? window.__rising.director.usingFallback : true,
      };
    }, { frameMs, frames, hideAt: opts.hideAt || 0, mode: opts.mode, pickSlot: opts.pickSlot });

    if (shotArg > -1 && opts.shot) await page.screenshot({ path: process.argv[shotArg + 1] });
    await page.close();
    return { state, logs };
  }

  // ── 게이트 #1 · 60Hz vs 120Hz ────────────────────────────────
  const a = await drive(1000 / 60, 30, { shot: true });
  const b = await drive(1000 / 120, 30);
  const distErr = a.state.dist === 0 ? 1 : Math.abs(a.state.dist - b.state.dist) / a.state.dist;
  results.push({
    gate: '#1 60Hz vs 120Hz 속도 동일성',
    detail: `30초 누적 주행 — 60Hz ${a.state.dist.toFixed(0)} / 120Hz ${b.state.dist.toFixed(0)} ` +
            `(오차 ${(distErr * 100).toFixed(2)}%), 시뮬 틱 ${a.state.tick} / ${b.state.tick}, ` +
            `코인 ${a.state.coins} / ${b.state.coins}, 사망 ${a.state.deaths} / ${b.state.deaths}`,
    pass: distErr < 0.03,
  });

  // ── 통과 가능성 · 세 레인 동시 차단 행이 생성되는가 ──────────
  // 봇의 실력과 무관한 판정이다. 이런 행이 하나라도 나오면 즉사 확정이고,
  // 데이터가 무엇을 주든 코드가 막아야 한다.
  results.push({
    gate: '통과 가능성 — 세 레인 동시 차단 행 (정적 검사)',
    detail: `60Hz·120Hz 두 회차에서 생성된 행 ${a.state.rowsSeen + b.state.rowsSeen}개 중 ` +
            `세 레인 동시 차단 ${a.state.rowsBlocked + b.state.rowsBlocked}개`,
    pass: a.state.rowsBlocked === 0 && b.state.rowsBlocked === 0,
  });

  // ── 게이트 #8 · 콘솔 청결 ────────────────────────────────────
  results.push({
    gate: '#8 콘솔 청결',
    detail: a.logs.length ? a.logs.join(' | ') : '에러·경고 0개',
    pass: a.logs.length === 0,
  });

  // ── 재현성 · 같은 입력이면 같은 결과 ─────────────────────────
  // 결정론의 실증. 난수가 하나라도 섞이면 여기서 갈린다.
  const rep = await drive(1000 / 60, 30);
  const same = rep.state.travelled === a.state.travelled
            && rep.state.worldX === a.state.worldX
            && rep.state.score === a.state.score
            && rep.state.coins === a.state.coins;
  results.push({
    gate: '재현성 — 판정에 난수가 섞이지 않았는가',
    detail: `동일 입력 2회: 누적 주행 ${a.state.dist.toFixed(3)}/${rep.state.dist.toFixed(3)}, ` +
            `코인 ${a.state.coins}/${rep.state.coins}, 점수 ${a.state.score}/${rep.state.score}, ` +
            `최종 worldX ${a.state.worldX.toFixed(6)}/${rep.state.worldX.toFixed(6)}`,
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
      const before = { lane: g.lane, x: g.worldX };
      R.inject(R.ACT.LEFT, window.performance.now());
      window.__clock.tick(1000 / 60);            // 1프레임 — 큐가 비워지는가
      const f1 = { lane: g.lane, x: g.worldX, shift: g.laneShift };
      window.__clock.tick(1000 / 60);            // 2프레임 — 실제로 움직였는가
      return { before, f1, x2: g.worldX };
    });
    await page.close();
    // 두 가지를 따로 잰다. 처음엔 "1프레임 안에 worldX 가 움직여야 한다"로 묶어
    // 놓고 실패를 봤는데, 원인은 게임이 아니라 **고정 타임스텝 누산기**였다.
    // 합성 클록의 delta 가 부동소수점 때문에 SIM_DT 보다 1e-15 작을 때가 있어
    // 그 프레임은 시뮬 스텝을 건너뛰고 다음 프레임에 두 번 돈다. 의도된 동작이고
    // 시간당 스텝 수는 정확하다(게이트 #1 오차 0.00%).
    // 입력 지연이 재려는 것은 **큐가 언제 비워지는가**이고, 그건 1프레임이다.
    results.push({
      gate: '#4 입력 지연 — 큐 소비 프레임 수 (코드 레벨)',
      detail: `좌 스와이프 주입 → 1프레임 후 레인 ${latency.before.lane}→${latency.f1.lane} ` +
              `(보간 ${latency.f1.shift}프레임 예약됨) → 2프레임 후 worldX ` +
              `${latency.before.x.toFixed(1)}→${latency.x2.toFixed(1)}. ` +
              `큐 소비 1프레임, 화면 반영은 누산기가 스텝을 흘리면 최대 2프레임`,
      pass: latency.f1.lane === 0 && latency.f1.shift > 0 && latency.x2 < latency.before.x,
    });
  }

  // ── 루프 왕복 · 죽고 다시 시작되는가 ─────────────────────────
  const idle = await drive(1000 / 60, 32, { mode: 'idle' });
  results.push({
    gate: '루프 왕복 — 죽고 다시 시작된다',
    detail: `방치 32초: 사망 관측 ${idle.state.sawDead}, 사망 ${idle.state.deaths}회, ` +
            `판수 ${idle.state.runs}, 현재 상태 ${idle.state.state} (3=DEAD)`,
    pass: idle.state.sawDead && idle.state.runs >= 2 && idle.state.state !== 3,
  });

  // ── 계단 · 드래프트가 실제로 열리고 특성이 붙는가 ────────────
  {
    const long = await drive(1000 / 60, 90, { mode: 'play' });
    results.push({
      gate: '계단 스프린트 → 특성 드래프트 → 특성 적용',
      detail: `90초 플레이: 계단 진입 ${long.state.stairs}회, 드래프트 개방 ${long.state.drafts}회, ` +
              `특성 선택 ${long.state.picks}회 (현재 보유 ${long.state.traits}개), ` +
              `최고 도달 ${(long.state.maxDist / 1000).toFixed(0)}m, 사망 ${long.state.deaths}회`,
      pass: long.state.stairs >= 1 && long.state.drafts >= 1 && long.state.picks >= 1,
    });
  }

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

  // ── 오디오 · 실제 제스처로 unlock 되고, 모든 소리 경로가 예외 없이 도는가 ──
  // iOS 사파리 실기기 확인(게이트 #6)은 대체하지 못한다. 코드가 터지지 않는지만 본다.
  {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
    await page.addInitScript(CLOCK_INIT);
    await page.addInitScript(BOT);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('!!window.__rising', null, { timeout: 5000 });
    // 진짜 포인터 제스처. unlock() 은 핸들러 안에서만 불린다.
    await page.mouse.move(210, 700);
    await page.mouse.down();
    await page.mouse.up();
    const au = await page.evaluate(async () => {
      const R = window.__rising, g = R.game;
      window.__bot.mode = 'play';
      for (let i = 0; i < 2400; i++) {
        window.__bot.step();
        window.__clock.tick(1000 / 60);
        if (i % 600 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      const x = R.audio;
      return {
        ready: x.ready, failed: x.failed,
        ctxState: x.ctx ? x.ctx.state : 'none',
        meters: g.meters(), coins: g.coins,
        muteWorks: (R.setMuted(true), x.master ? x.master.gain.value : -1),
      };
    });
    await page.close();
    results.push({
      gate: '오디오 — 제스처 unlock + 전 경로 무예외 (코드 레벨)',
      detail: `unlock ${au.ready} / 실패 ${au.failed} / AudioContext ${au.ctxState}, ` +
              `40초 플레이(${au.meters.toFixed(0)}m·코인 ${au.coins}) 중 예외 0, ` +
              `음소거 시 마스터 게인 ${au.muteWorks}, ` +
              `로그 ${logs.length ? logs.join(' | ') : '에러·경고 0개'}`,
      pass: au.ready === true && au.failed === false && au.muteWorks === 0 && logs.length === 0,
    });
  }

  // ── 디렉터 · 성향별로 다른 프로파일이 판정되는가 ─────────────
  {
    const modes = ['safe', 'greedy', 'precise', 'sloppy'];
    const found = [];
    const kindsBy = {};
    let maxSw = 0;
    for (const m of modes) {
      const r = await drive(1000 / 60, 90, { mode: m });
      found.push(m + '→[' + r.state.profiles.join(',') + '] 전환' + r.state.switches + '회');
      kindsBy[m] = r.state.draftKinds;
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
      detail: '90초 플레이 중 최대 전환 ' + maxSw + '회 (프레임 단위로 튀면 수백 회가 나온다)',
      pass: maxSw <= 8,
    });
    // 제시되는 특성 3개의 성향이 실제로 갈리는가.
    // 디렉터가 "판단했다"는 말이 화면 문구가 아니라 **제시 목록**으로 증명되는 지점이다.
    const K = ['공격', '방어', '조작'];
    const shown = modes.map((m) => m + ' ' + kindsBy[m].map((n, i) => K[i] + n).join('/'));
    const sig = modes.map((m) => kindsBy[m].join(','));
    const distinct = new Set(sig.filter((s) => s !== '0,0,0')).size;
    results.push({
      gate: '드래프트 — 성향별로 제시되는 특성 계열이 갈리는가',
      detail: shown.join(' | ') + `  ·  서로 다른 제시 분포 ${distinct}종`,
      pass: distinct >= 2,
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
      detail: `30초 누적 주행 ${blocked.state.dist.toFixed(0)} (폴백 ${blocked.state.fallback}), ` +
              `세 레인 동시 차단 ${blocked.state.rowsBlocked}개, 치명 로그 ${warnOnly(blocked.logs).length}개`,
      pass: blocked.state.dist > 0 && blocked.state.rowsBlocked === 0 && warnOnly(blocked.logs).length === 0,
    });
    results.push({
      gate: '#10 LLM 폴백 — JSON 파손',
      detail: `30초 누적 주행 ${corrupt.state.dist.toFixed(0)} (폴백 ${corrupt.state.fallback}), ` +
              `세 레인 동시 차단 ${corrupt.state.rowsBlocked}개, 치명 로그 ${warnOnly(corrupt.logs).length}개`,
      pass: corrupt.state.dist > 0 && corrupt.state.rowsBlocked === 0 && warnOnly(corrupt.logs).length === 0,
    });
    results.push({
      gate: '계층2 — 구운 청크가 실제로 로드되는가',
      detail: `정상 경로에서 라이브러리 ${a.state.library}개, 폴백 사용 ${a.state.fallback} ` +
              `(차단 시 폴백 ${blocked.state.fallback} 으로 바뀌어야 한다)`,
      pass: a.state.library > 0 && a.state.fallback === false && blocked.state.fallback === true,
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
