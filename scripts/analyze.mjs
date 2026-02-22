#!/usr/bin/env node
/**
 * Hoopcraft Tick Simulation Analyzer v2
 * 
 * Deep basketball analysis — movement, passing, shot selection, positioning,
 * player behavior patterns. Runs full game at Max speed (~2s).
 *
 * Usage:
 *   node scripts/analyze.mjs            # build + run
 *   node scripts/analyze.mjs --no-build # skip build
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const skipBuild = process.argv.includes('--no-build');
const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');

// ── Build ──────────────────────────────────────────────────────────────
if (!skipBuild) {
  console.log('Building...');
  execSync('npx vite build', { cwd: root, stdio: 'inherit' });
}
if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error('dist/index.html not found. Run `npx vite build` first.');
  process.exit(1);
}

// ── Launch browser ─────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await ctx.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  let relPath = url.pathname.replace(/^\/hoopcraft/, '') || '/index.html';
  if (relPath === '/') relPath = '/index.html';
  const filePath = path.join(distDir, relPath);
  try {
    const body = readFileSync(filePath);
    const ext = path.extname(filePath);
    const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream';
    await route.fulfill({ body, contentType: ct });
  } catch { await route.fulfill({ status: 404, body: 'Not found' }); }
});

// Capture browser console for debug output
const browserLogs = [];
page.on('console', msg => {
  const t = msg.text();
  if (t.includes('[FREEZE]') || t.includes('[SCV]') || t.includes('[BALL]')) {
    console.log('BROWSER: ' + t);
    browserLogs.push(t);
  }
});

console.log('Loading game...');
await page.goto('http://hoopcraft.local/hoopcraft/');
await page.waitForTimeout(2000);

// Start Court View
for (const text of ['Court', 'Court View', '🏟️ Court View']) {
  const btn = await page.$(`button:has-text("${text}")`);
  if (btn && await btn.isVisible()) { await btn.click(); break; }
}
await page.waitForTimeout(500);

// Max speed
const maxBtn = await page.$('button:has-text("Max")');
if (maxBtn && await maxBtn.isVisible()) {
  await maxBtn.click();
  console.log('Speed: Max');
}
await page.waitForTimeout(300);

// Start
for (const text of ['Start', 'Play', '▶']) {
  const btn = await page.$(`button:has-text("${text}")`);
  if (btn && await btn.isVisible()) { await btn.click(); console.log('Game started'); break; }
}

// ── Wait for game to finish ────────────────────────────────────────────
console.log('Running...');
const startTime = Date.now();
for (let i = 0; i < 300; i++) {
  await page.waitForTimeout(500);
  const tc = await page.evaluate(() => (window).__hoopcraft_ticks?.length || 0);
  if (i % 10 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  ${elapsed}s — ${tc} ticks (${(tc / 60).toFixed(0)}s game)`);
  }
  const done = await page.evaluate(() => document.body.innerText.includes('FINAL'));
  if ((done && tc > 5000) || tc >= 170000) break;
}
console.log(`Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

// ── DEEP ANALYSIS ──────────────────────────────────────────────────────
const report = await page.evaluate(() => {
  const ticks = (window).__hoopcraft_ticks;
  if (!ticks || ticks.length === 0) return ['ERROR: No ticks collected'];

  const L = [];
  const hr = '═'.repeat(70);
  const sr = '─'.repeat(70);
  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);
  const pct = (a, b) => b > 0 ? (a / b * 100).toFixed(1) : '0.0';
  const bar = (p) => '█'.repeat(Math.round(p / 2.5));

  // ── Collect all data ───────────────────────────────────────────────
  const players = new Map();
  const phaseTime = {};
  const events = []; // deduplicated events
  let lastEvent = '';
  let lastPossession = -1;
  let totalPossessions = 0;
  const playCount = {};
  let totalPlays = 0;
  let lastPlay = null;
  
  // PassCount tracking
  let passCountSamples = [];
  let lastPassCount = 0;

  // Event-level tracking
  let passes = 0, steals = 0, turnovers = 0, fastBreaks = 0;
  let scores = 0, rebounds = 0, blocks = 0, fouls = 0;
  let alleyOops = 0, assists = 0;
  let lastAssists = [0, 0];
  const shotTypes = {}; // event text → count
  const passTypes = { chest: 0, overhead: 0, lob: 0, bounce: 0, outlet: 0, alleyoop: 0, unknown: 0 };

  // Movement tracking per player
  const initPlayer = (p) => ({
    name: p.name, pos: p.pos, teamIdx: p.teamIdx,
    total: 0, idle: 0, ballTime: 0,
    cutting: 0, screening: 0, driving: 0, dribbling: 0, catching: 0,
    roles: {},
    zones: { paint: 0, midrange: 0, three: 0, backcourt: 0 },
    totalDist: 0, // total distance traveled
    speeds: [], // sampled speeds (ft/s)
    maxSpeed: 0,
    fatigueSum: 0,
    frontcourt: 0, backcourt: 0,
    // Heatmap: 10x5 grid
    heatmap: Array.from({length: 10}, () => Array(5).fill(0)),
  });

  let prevPositions = new Map();

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    phaseTime[t.phase] = (phaseTime[t.phase] || 0) + 1;

    // Events (deduplicated)
    if (t.event && t.event !== lastEvent) {
      events.push({ t: t.t, event: t.event, phase: t.phase });
      const ev = t.event.toLowerCase();
      if (ev.includes('pass to') || ev.includes('pass ')) passes++;
      if (ev.includes('steals')) steals++;
      if (ev.includes('intercept')) { steals++; turnovers++; }
      if (ev.includes('fast break') || ev.includes('breakaway')) fastBreaks++;
      if (ev.includes('scores') || ev.includes('makes ft')) scores++;
      if (ev.includes('rebound')) rebounds++;
      if (ev.includes('block')) blocks++;
      if (ev.includes('foul')) fouls++;
      if (ev.includes('alley-oop') || ev.includes('alley oop')) alleyOops++;
      // Count assists from event text as backup
      if (ev.includes('ast:')) {
        // assist already tracked from tick data
      }
      // Pass type
      if (ev.includes('chest pass')) passTypes.chest++;
      else if (ev.includes('overhead pass')) passTypes.overhead++;
      else if (ev.includes('lob pass')) passTypes.lob++;
      else if (ev.includes('bounce pass')) passTypes.bounce++;
      else if (ev.includes('outlet')) passTypes.outlet++;
      else if (ev.includes('alley-oop')) passTypes.alleyoop++;
      else if (ev.includes('pass to')) passTypes.unknown++;
      // Shot types
      if (ev.includes('three') || ev.includes('3-pointer') || ev.includes('3pt')) {
        shotTypes['3PT'] = (shotTypes['3PT'] || 0) + 1;
      } else if (ev.includes('dunk')) {
        shotTypes['Dunk'] = (shotTypes['Dunk'] || 0) + 1;
      } else if (ev.includes('layup')) {
        shotTypes['Layup'] = (shotTypes['Layup'] || 0) + 1;
      } else if (ev.includes('mid-range') || ev.includes('midrange') || ev.includes('jumper')) {
        shotTypes['Mid-range'] = (shotTypes['Mid-range'] || 0) + 1;
      } else if (ev.includes('floater')) {
        shotTypes['Floater'] = (shotTypes['Floater'] || 0) + 1;
      } else if (ev.includes('hook')) {
        shotTypes['Hook'] = (shotTypes['Hook'] || 0) + 1;
      }
      lastEvent = t.event;
    }

    // Play tracking
    if (t.play && t.play !== lastPlay) {
      totalPlays++;
      playCount[t.play] = (playCount[t.play] || 0) + 1;
    }
    lastPlay = t.play || null;

    // Track passCount distribution
    if (t.passCount !== undefined && t.passCount !== lastPassCount) {
      passCountSamples.push(t.passCount);
      lastPassCount = t.passCount;
    }

    // Assists (from tick data)
    if (t.assists) {
      const totalAst = t.assists[0] + t.assists[1];
      if (totalAst > lastAssists[0] + lastAssists[1]) {
        assists = totalAst;
      }
      lastAssists = [...t.assists];
    }

    // Possessions
    if (t.possession !== lastPossession) { totalPossessions++; lastPossession = t.possession; }

    // Per-player
    for (const p of t.players) {
      if (!players.has(p.id)) players.set(p.id, initPlayer(p));
      const pd = players.get(p.id);
      pd.total++;
      if (p.hasBall) pd.ballTime++;
      if (p.isCutting) pd.cutting++;
      if (p.isScreening) pd.screening++;
      if (p.isDriving) pd.driving++;
      if (p.isDribbling) pd.dribbling++;
      if (p.catchTimer > 0) pd.catching++;
      pd.fatigueSum += p.fatigue;
      if (p.role) pd.roles[p.role] = (pd.roles[p.role] || 0) + 1;

      // Movement / speed
      const prev = prevPositions.get(p.id);
      if (prev) {
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        pd.totalDist += d;
        const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (i % 6 === 0) pd.speeds.push(spd); // sample every 6 ticks
        if (spd > pd.maxSpeed) pd.maxSpeed = spd;
        if (d < 0.015) pd.idle++;
      }
      prevPositions.set(p.id, { x: p.x, y: p.y });

      // Court zones
      const HALF = 47;
      const basket = p.teamIdx === 0 ? { x: 89, y: 25 } : { x: 5, y: 25 };
      const distBasket = Math.sqrt((p.x - basket.x) ** 2 + (p.y - basket.y) ** 2);
      const inFrontcourt = p.teamIdx === 0 ? p.x > HALF : p.x < HALF;
      if (inFrontcourt) {
        pd.frontcourt++;
        if (distBasket < 8) pd.zones.paint++;
        else if (distBasket < 18) pd.zones.midrange++;
        else pd.zones.three++;
      } else {
        pd.backcourt++;
        pd.zones.backcourt++;
      }

      // Heatmap (10x5 grid: 9.4ft x 10ft cells)
      const gx = Math.min(9, Math.floor(p.x / 9.4));
      const gy = Math.min(4, Math.floor(p.y / 10));
      pd.heatmap[gx][gy]++;
    }
  }

  // ── Spacing analysis (sample every 10 ticks) ──────────────────────
  const spacingViolations = {};
  const avgTeamSpacing = [0, 0];
  const teamSpacingSamples = [0, 0];
  let spacingSamples = 0;
  for (let i = 0; i < ticks.length; i += 10) {
    const t = ticks[i];
    spacingSamples++;
    for (const teamIdx of [0, 1]) {
      const team = t.players.filter(p => p.teamIdx === teamIdx);
      let teamSpacingSum = 0;
      let pairs = 0;
      for (let a = 0; a < team.length; a++) {
        for (let b = a + 1; b < team.length; b++) {
          const d = Math.sqrt((team[a].x - team[b].x) ** 2 + (team[a].y - team[b].y) ** 2);
          teamSpacingSum += d;
          pairs++;
          if (d < 6 && teamIdx === t.possession) {
            const key = [team[a].name, team[b].name].sort().join(' + ');
            spacingViolations[key] = (spacingViolations[key] || 0) + 1;
          }
        }
      }
      if (pairs > 0) {
        avgTeamSpacing[teamIdx] += teamSpacingSum / pairs;
        teamSpacingSamples[teamIdx]++;
      }
    }
  }

  // ── Ball movement analysis ─────────────────────────────────────────
  let ballInFlightTicks = 0;
  let ballStationaryTicks = 0;
  for (const t of ticks) {
    if (t.ballInFlight) ballInFlightTicks++;
    else ballStationaryTicks++;
  }

  // ── Possession length analysis ─────────────────────────────────────
  const possessionLengths = [];
  let posStart = 0;
  let curPoss = ticks[0]?.possession;
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].possession !== curPoss) {
      possessionLengths.push((i - posStart) / 60); // in seconds
      posStart = i;
      curPoss = ticks[i].possession;
    }
  }
  possessionLengths.push((ticks.length - posStart) / 60);
  const avgPossLen = possessionLengths.reduce((a, b) => a + b, 0) / possessionLengths.length;
  const shortPoss = possessionLengths.filter(l => l < 4).length;
  const longPoss = possessionLengths.filter(l => l > 18).length;

  // PassCount distribution analysis
  const passCountDist = {};
  for (const pc of passCountSamples) {
    passCountDist[pc] = (passCountDist[pc] || 0) + 1;
  }
  const totalPassCountSamples = passCountSamples.length;
  const maxPassCount = Math.max(...passCountSamples);

  // ══════════════════════════════════════════════════════════════════════
  // FORMAT REPORT
  // ══════════════════════════════════════════════════════════════════════
  
  L.push(`╔${hr}╗`);
  L.push(`║  HOOPCRAFT DEEP BASKETBALL ANALYSIS v2                              ║`);
  L.push(`╚${hr}╝`);
  L.push('');
  L.push(`Ticks: ${ticks.length} | Game: ${(ticks.length/60).toFixed(0)}s (${(ticks.length/60/60).toFixed(1)}min)`);
  L.push(`Possessions: ${totalPossessions} | Plays Run: ${totalPlays} | Events: ${events.length}`);
  L.push('');

  // ── 1. GAME FLOW ──────────────────────────────────────────────────
  L.push(`┌─ 1. GAME FLOW ${sr.slice(15)}`);
  for (const [phase, count] of Object.entries(phaseTime).sort((a, b) => b[1] - a[1])) {
    const p = count / ticks.length * 100;
    L.push(`│ ${pad(phase, 12)} ${rpad(p.toFixed(1), 5)}% ${bar(p)}`);
  }
  L.push(`│`);
  L.push(`│ Avg possession: ${avgPossLen.toFixed(1)}s | Short (<4s): ${shortPoss} | Long (>18s): ${longPoss}`);
  L.push(`│ NBA avg possession: ~14.8s (2024-25)`);
  L.push('');

  // ── 2. SCORING & EVENTS ────────────────────────────────────────────
  L.push(`┌─ 2. SCORING & EVENTS ${sr.slice(22)}`);
  L.push(`│ Scores: ${scores} | Assists: ${assists} | Passes: ${passes} | Steals: ${steals} | Rebounds: ${rebounds}`);
  L.push(`│ Blocks: ${blocks} | Fouls: ${fouls} | Turnovers: ${turnovers} | Alley-oops: ${alleyOops}`);
  L.push(`│ Assist Rate: ${scores > 0 ? (assists / scores * 100).toFixed(0) : 0}% of scores assisted — NBA avg: ~60-65%`);
  L.push(`│ Fast Breaks: ${fastBreaks}/${totalPossessions} (${pct(fastBreaks, totalPossessions)}%) — NBA avg: 15-20%`);
  L.push(`│ Passes/Possession: ${(passes / totalPossessions).toFixed(1)} — NBA avg: ~4-5 per made basket`);
  L.push(`│`);
  L.push(`│ PassCount distribution at decision points:`);
  for (let i = 0; i <= maxPassCount; i++) {
    const count = passCountDist[i] || 0;
    const pct = totalPassCountSamples > 0 ? (count / totalPassCountSamples * 100).toFixed(1) : '0.0';
    L.push(`│   passCount=${i}: ${rpad(count, 4)} samples (${pct}%)`);
  }
  L.push(`│`);
  L.push(`│ Pass Types:`);
  for (const [type, count] of Object.entries(passTypes).filter(([,c]) => c > 0).sort((a, b) => b[1] - a[1])) {
    L.push(`│   ${pad(type, 12)} ${rpad(count, 4)}  (${pct(count, passes)}%)`);
  }
  L.push(`│`);
  L.push(`│ Shot Types:`);
  for (const [type, count] of Object.entries(shotTypes).sort((a, b) => b[1] - a[1])) {
    L.push(`│   ${pad(type, 12)} ${rpad(count, 4)}  (${pct(count, Object.values(shotTypes).reduce((a,b)=>a+b,0))}%)`);
  }
  L.push('');

  // ── 3. PLAY SELECTION ──────────────────────────────────────────────
  L.push(`┌─ 3. PLAY SELECTION ${sr.slice(20)}`);
  const sortedPlays = Object.entries(playCount).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedPlays) {
    L.push(`│ ${pad(name, 28)} ${rpad(count, 3)}x (${rpad(pct(count, totalPlays), 5)}%)`);
  }
  L.push('');

  // ── 4. BALL MOVEMENT ───────────────────────────────────────────────
  L.push(`┌─ 4. BALL MOVEMENT ${sr.slice(19)}`);
  L.push(`│ Ball in flight: ${pct(ballInFlightTicks, ticks.length)}% of game`);
  L.push(`│ Ball held/stationary: ${pct(ballStationaryTicks, ticks.length)}% of game`);
  L.push(`│ Avg team spacing: Team0 ${(avgTeamSpacing[0]/teamSpacingSamples[0]).toFixed(1)}ft | Team1 ${(avgTeamSpacing[1]/teamSpacingSamples[1]).toFixed(1)}ft`);
  L.push(`│ NBA avg player spacing: ~12-15ft between teammates`);
  L.push('');

  // ── 5. PLAYER MOVEMENT & BEHAVIOR ──────────────────────────────────
  L.push(`┌─ 5. PLAYER MOVEMENT & BEHAVIOR ${sr.slice(33)}`);
  L.push(`│ ${pad('Name', 18)} ${pad('Pos', 3)} ${rpad('Dist(ft)', 8)} ${rpad('AvgSpd', 6)} ${rpad('MaxSpd', 6)} ${rpad('Idle%', 5)} ${rpad('Fatigue', 7)}`);
  L.push(`│ ${pad('─'.repeat(18), 18)} ${pad('───', 3)} ${rpad('────────', 8)} ${rpad('──────', 6)} ${rpad('──────', 6)} ${rpad('─────', 5)} ${rpad('───────', 7)}`);
  for (const [, pd] of players) {
    const avgSpd = pd.speeds.length > 0 ? (pd.speeds.reduce((a,b) => a+b, 0) / pd.speeds.length).toFixed(1) : '0';
    const avgFatigue = (pd.fatigueSum / pd.total).toFixed(2);
    L.push(`│ ${pad(pd.name, 18)} ${pad(pd.pos, 3)} ${rpad(pd.totalDist.toFixed(0), 8)} ${rpad(avgSpd, 6)} ${rpad(pd.maxSpeed.toFixed(1), 6)} ${rpad(pct(pd.idle, pd.total), 5)} ${rpad(avgFatigue, 7)}`);
  }
  L.push(`│`);
  L.push(`│ NBA avg: ~2.5 miles/game (~13,200ft), ~4.5 ft/s avg`);
  L.push('');

  // ── 6. PLAYER ACTIONS (% of ticks) ─────────────────────────────────
  L.push(`┌─ 6. PLAYER ACTIONS (% of time) ${sr.slice(33)}`);
  L.push(`│ ${pad('Name', 18)} ${rpad('Ball%', 5)} ${rpad('Drib%', 5)} ${rpad('Cut%', 5)} ${rpad('Scrn%', 5)} ${rpad('Drive%', 6)} ${rpad('Catch%', 6)} ${rpad('Stand%', 6)}`);
  L.push(`│ ${pad('─'.repeat(18), 18)} ${rpad('─────', 5)} ${rpad('─────', 5)} ${rpad('─────', 5)} ${rpad('─────', 5)} ${rpad('──────', 6)} ${rpad('──────', 6)} ${rpad('──────', 6)}`);
  for (const [, pd] of players) {
    const standing = pd.total - pd.cutting - pd.screening - pd.driving - pd.dribbling;
    L.push(`│ ${pad(pd.name, 18)} ${rpad(pct(pd.ballTime, pd.total), 5)} ${rpad(pct(pd.dribbling, pd.total), 5)} ${rpad(pct(pd.cutting, pd.total), 5)} ${rpad(pct(pd.screening, pd.total), 5)} ${rpad(pct(pd.driving, pd.total), 6)} ${rpad(pct(pd.catching, pd.total), 6)} ${rpad(pct(standing > 0 ? standing : 0, pd.total), 6)}`);
  }
  L.push(`│`);
  L.push(`│ "Standing" = not cutting, screening, driving, or dribbling`);
  L.push(`│ NBA: Off-ball players move ~70% of possession (cuts, screens, relocations)`);
  L.push('');

  // ── 7. ROLES DISTRIBUTION ──────────────────────────────────────────
  L.push(`┌─ 7. ROLE ASSIGNMENTS (% of time) ${sr.slice(35)}`);
  const allRoles = new Set();
  for (const [, pd] of players) for (const r of Object.keys(pd.roles)) allRoles.add(r);
  const roles = [...allRoles].sort();
  L.push(`│ ${pad('Name', 18)} ${roles.map(r => rpad(r.slice(0, 8), 9)).join('')}`);
  L.push(`│ ${pad('─'.repeat(18), 18)} ${roles.map(() => rpad('─'.repeat(8), 9)).join('')}`);
  for (const [, pd] of players) {
    const vals = roles.map(r => rpad(pct(pd.roles[r] || 0, pd.total), 9));
    L.push(`│ ${pad(pd.name, 18)} ${vals.join('')}`);
  }
  L.push('');

  // ── 8. COURT POSITIONING ───────────────────────────────────────────
  L.push(`┌─ 8. COURT POSITIONING ${sr.slice(23)}`);
  L.push(`│ ${pad('Name', 18)} ${pad('Pos', 3)} ${rpad('Paint', 5)} ${rpad('Mid', 5)} ${rpad('3PT', 5)} ${rpad('Back', 5)} ${rpad('Front%', 6)}`);
  L.push(`│ ${pad('─'.repeat(18), 18)} ${pad('───', 3)} ${rpad('─────', 5)} ${rpad('─────', 5)} ${rpad('─────', 5)} ${rpad('─────', 5)} ${rpad('──────', 6)}`);
  for (const [, pd] of players) {
    const t = pd.total || 1;
    L.push(`│ ${pad(pd.name, 18)} ${pad(pd.pos, 3)} ${rpad(pct(pd.zones.paint, t), 5)} ${rpad(pct(pd.zones.midrange, t), 5)} ${rpad(pct(pd.zones.three, t), 5)} ${rpad(pct(pd.zones.backcourt, t), 5)} ${rpad(pct(pd.frontcourt, t), 6)}`);
  }
  L.push(`│`);
  L.push(`│ NBA: Guards ~25-35% 3PT zone, Centers ~35-45% paint`);
  L.push(`│ Expected: C should be highest paint%, PG highest backcourt%`);
  L.push('');

  // ── 9. HEATMAPS (ASCII) ───────────────────────────────────────────
  L.push(`┌─ 9. HEATMAPS (Team 0 — top 3 players by ball%) ${sr.slice(49)}`);
  const team0 = [...players.values()].filter(p => p.teamIdx === 0).sort((a, b) => b.ballTime - a.ballTime);
  const heatChars = ' ░▒▓█';
  for (const pd of team0.slice(0, 3)) {
    L.push(`│ ${pd.name} (${pd.pos}):`);
    // Find max for normalization
    let maxH = 0;
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 10; gx++) if (pd.heatmap[gx][gy] > maxH) maxH = pd.heatmap[gx][gy];
    for (let gy = 0; gy < 5; gy++) {
      let row = '│   ';
      for (let gx = 0; gx < 10; gx++) {
        const norm = maxH > 0 ? pd.heatmap[gx][gy] / maxH : 0;
        const ci = Math.min(4, Math.floor(norm * 5));
        row += heatChars[ci] + heatChars[ci];
      }
      row += `  ${gy === 2 ? '← basket (left)     basket (right) →' : ''}`;
      L.push(row);
    }
    L.push('│');
  }
  L.push('');

  // ── 10. SPACING ────────────────────────────────────────────────────
  L.push(`┌─ 10. SPACING VIOLATIONS (<6ft, sampled ${spacingSamples} ticks) ${sr.slice(50)}`);
  const sortedSpacing = Object.entries(spacingViolations).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (sortedSpacing.length === 0) L.push('│ None!');
  for (const [pair, count] of sortedSpacing) {
    L.push(`│ ${pad(pair, 38)} ${pct(count, spacingSamples)}%`);
  }
  L.push('');

  // ── 11. REALISM ISSUES ─────────────────────────────────────────────
  L.push(`┌─ 11. REALISM ASSESSMENT ${sr.slice(25)}`);
  const issues = [];
  const warnings = [];
  const good = [];

  // Fast break rate
  const fbRate = fastBreaks / totalPossessions * 100;
  if (fbRate > 25) issues.push(`❌ Fast break rate ${fbRate.toFixed(0)}% — way too high (NBA: 15-20%)`);
  else if (fbRate > 20) warnings.push(`⚠️  Fast break rate ${fbRate.toFixed(0)}% — slightly high`);
  else good.push(`✅ Fast break rate ${fbRate.toFixed(0)}% — realistic`);

  // Passes per possession
  const ppp = passes / totalPossessions;
  if (ppp < 1.5) issues.push(`❌ Only ${ppp.toFixed(1)} passes/possession — NBA has ~4-5 per made basket`);
  else if (ppp < 3) warnings.push(`⚠️  ${ppp.toFixed(1)} passes/possession — should be higher`);
  else good.push(`✅ ${ppp.toFixed(1)} passes/possession`);

  // Possession length
  if (avgPossLen < 8) issues.push(`❌ Avg possession ${avgPossLen.toFixed(1)}s — too short (NBA: ~14.8s)`);
  else if (avgPossLen < 12) warnings.push(`⚠️  Avg possession ${avgPossLen.toFixed(1)}s — slightly short`);
  else good.push(`✅ Avg possession ${avgPossLen.toFixed(1)}s`);

  // Idle rate
  const avgIdle = [...players.values()].reduce((s, p) => s + p.idle / p.total, 0) / players.size * 100;
  if (avgIdle > 40) issues.push(`❌ Avg idle ${avgIdle.toFixed(0)}% — players standing still too much`);
  else if (avgIdle > 25) warnings.push(`⚠️  Avg idle ${avgIdle.toFixed(0)}% — could be more active`);
  else good.push(`✅ Avg idle ${avgIdle.toFixed(0)}%`);

  // PG ball time
  const pgs = [...players.values()].filter(p => p.pos === 'PG');
  for (const pg of pgs) {
    const ballPct = pg.ballTime / pg.total * 100;
    if (ballPct > 20) warnings.push(`⚠️  ${pg.name} (PG) has ball ${ballPct.toFixed(0)}% — NBA PGs: ~15-18%`);
    else if (ballPct < 8) warnings.push(`⚠️  ${pg.name} (PG) has ball only ${ballPct.toFixed(0)}% — too low`);
    else good.push(`✅ ${pg.name} (PG) ball time ${ballPct.toFixed(0)}%`);
  }

  // Center in paint
  const centers = [...players.values()].filter(p => p.pos === 'C');
  for (const c of centers) {
    const paintPct = c.zones.paint / c.total * 100;
    if (paintPct < 10) warnings.push(`⚠️  ${c.name} (C) only ${paintPct.toFixed(0)}% in paint — should be higher`);
    else good.push(`✅ ${c.name} (C) paint time ${paintPct.toFixed(0)}%`);
  }

  // Standing rate
  for (const [, pd] of players) {
    const standPct = (pd.total - pd.cutting - pd.screening - pd.driving - pd.dribbling) / pd.total * 100;
    if (standPct > 85) issues.push(`❌ ${pd.name} standing ${standPct.toFixed(0)}% of the time — not moving`);
  }

  // Assist rate
  const assistRate = scores > 0 ? assists / scores * 100 : 0;
  if (assistRate < 40) issues.push(`❌ Assist rate ${assistRate.toFixed(0)}% — too low (NBA: 60-65%)`);
  else if (assistRate < 55) warnings.push(`⚠️  Assist rate ${assistRate.toFixed(0)}% — slightly low`);
  else good.push(`✅ Assist rate ${assistRate.toFixed(0)}%`);

  // Team spacing
  for (let ti = 0; ti < 2; ti++) {
    const sp = avgTeamSpacing[ti] / teamSpacingSamples[ti];
    if (sp < 10) issues.push(`❌ Team ${ti} avg spacing ${sp.toFixed(1)}ft — too clumped (NBA: 12-15ft)`);
    else if (sp < 12) warnings.push(`⚠️  Team ${ti} avg spacing ${sp.toFixed(1)}ft — slightly tight`);
    else good.push(`✅ Team ${ti} avg spacing ${sp.toFixed(1)}ft`);
  }

  for (const g of good) L.push(`│ ${g}`);
  for (const w of warnings) L.push(`│ ${w}`);
  for (const i of issues) L.push(`│ ${i}`);
  L.push('');

  L.push(`╔${hr}╗`);
  L.push(`║  END OF ANALYSIS                                                    ║`);
  L.push(`╚${hr}╝`);
  return L;
});

console.log('');
for (const line of report) console.log(line);
const scvCount = browserLogs.filter(l => l.includes('[SCV]')).length;
console.log(`\nShot Clock Violations: ${scvCount}`);

// Final score — extract from box score headers "Hawks — 111" and "Wolves — 85"
const score = await page.evaluate(() => {
  const teamDivs = document.querySelectorAll('.font-bold.mb-1.text-sm');
  if (teamDivs.length >= 2) {
    const t0 = teamDivs[0].textContent?.match(/(\d+)/);
    const t1 = teamDivs[1].textContent?.match(/(\d+)/);
    if (t0 && t1) return `${t0[1]} - ${t1[1]}`;
  }
  const text = document.body.innerText;
  const eventMatch = text.match(/\((\d{2,3})-(\d{2,3})\)/);
  return eventMatch ? `${eventMatch[1]} - ${eventMatch[2]}` : 'unknown';
});
console.log(`\nFinal Score: ${score}`);

// Box Score — read table cells directly
const boxScore = await page.evaluate(() => {
  const tables = document.querySelectorAll('table');
  if (!tables.length) return '';
  const result = [];
  // Team headers are siblings before each table
  const teamDivs = document.querySelectorAll('.font-bold.mb-1.text-sm');
  let tIdx = 0;
  for (const table of tables) {
    if (teamDivs[tIdx]) result.push('\n' + teamDivs[tIdx].textContent);
    tIdx++;
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('th, td');
      const vals = [];
      cells.forEach(c => vals.push(c.textContent.trim().padStart(4)));
      result.push('│ ' + vals.join(' '));
    }
  }
  return result.join('\n');
});
if (boxScore.trim()) {
  console.log('\n┌─ BOX SCORE ─────────────────────────────────────────────────────────');
  console.log(boxScore);
  console.log('└─────────────────────────────────────────────────────────────────────');
}

await browser.close();
process.exit(0);
