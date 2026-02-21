#!/usr/bin/env node
/**
 * Hoopcraft Tick Simulation Analyzer
 * 
 * Runs a full game via Playwright (headless), collects per-tick data from
 * CourtView's window.__hoopcraft_ticks, then prints a comprehensive report.
 *
 * Usage:
 *   node scripts/analyze.mjs            # build + run analysis
 *   node scripts/analyze.mjs --no-build # skip build, use existing dist/
 *
 * Requires: playwright (npx playwright install chromium)
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

// ── Launch browser & serve from filesystem ─────────────────────────────
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Intercept all network requests → serve from dist/
await ctx.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  let relPath = url.pathname.replace(/^\/hoopcraft/, '') || '/index.html';
  if (relPath === '/') relPath = '/index.html';
  const filePath = path.join(distDir, relPath);
  try {
    const body = readFileSync(filePath);
    const ext = path.extname(filePath);
    const ct = {
      '.html': 'text/html', '.js': 'application/javascript',
      '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
    }[ext] || 'application/octet-stream';
    await route.fulfill({ body, contentType: ct });
  } catch {
    await route.fulfill({ status: 404, body: 'Not found' });
  }
});

console.log('Loading game...');
await page.goto('http://hoopcraft.local/hoopcraft/');
await page.waitForTimeout(2000);

// ── Start the Court View game ──────────────────────────────────────────
for (const text of ['Court', 'Court View', '🏟️ Court View']) {
  const btn = await page.$(`button:has-text("${text}")`);
  if (btn && await btn.isVisible()) { await btn.click(); console.log(`Tab: ${text}`); break; }
}
await page.waitForTimeout(500);

// Max speed
for (const text of ['8x', '4x']) {
  const btn = await page.$(`button:has-text("${text}")`);
  if (btn && await btn.isVisible()) { await btn.click(); console.log(`Speed: ${text}`); break; }
}
await page.waitForTimeout(300);

// Start
for (const text of ['Start', 'Play', '▶']) {
  const btn = await page.$(`button:has-text("${text}")`);
  if (btn && await btn.isVisible()) { await btn.click(); console.log('Game started'); break; }
}

// ── Wait for game to finish ────────────────────────────────────────────
console.log('Running game (this takes ~3-4 minutes at 4x speed)...');
const startTime = Date.now();
for (let i = 0; i < 300; i++) {
  await page.waitForTimeout(1000);
  const tc = await page.evaluate(() => (window).__hoopcraft_ticks?.length || 0);
  if (i % 30 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  ${elapsed}s elapsed — ${tc} ticks (${(tc / 60).toFixed(0)}s game time)`);
  }
  const done = await page.evaluate(() => document.body.innerText.includes('FINAL'));
  if (done && tc > 5000) break;
}

// ── Analyze ────────────────────────────────────────────────────────────
const report = await page.evaluate(() => {
  const ticks = (window).__hoopcraft_ticks;
  if (!ticks || ticks.length === 0) return ['ERROR: No ticks collected'];

  const lines = [];
  const players = new Map();
  const phaseTime = {};
  let lastEvent = '';
  let fastBreaks = 0;
  let totalPossessions = 0;
  let lastPossession = -1;
  const lastPos = new Map();
  const playCount = {};
  let totalPlays = 0;

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    phaseTime[t.phase] = (phaseTime[t.phase] || 0) + 1;

    // Deduplicated event counting
    if (t.event !== lastEvent) {
      if (t.event?.includes('Fast break') || t.event?.includes('Breakaway')) fastBreaks++;
      if (t.event?.includes('Running:')) {
        totalPlays++;
        const playName = t.play || 'unknown';
        playCount[playName] = (playCount[playName] || 0) + 1;
      }
      lastEvent = t.event;
    }

    // Possession changes
    if (t.possession !== lastPossession) { totalPossessions++; lastPossession = t.possession; }

    for (const p of t.players) {
      if (!players.has(p.id)) {
        players.set(p.id, {
          name: p.name, pos: p.pos, teamIdx: p.teamIdx,
          backcourt: 0, frontcourt: 0, total: 0, idle: 0,
          ballTime: 0, roles: {},
          // Position heatmap (court divided into 4 zones)
          zones: { paint: 0, midrange: 0, three: 0, backcourt: 0 },
        });
      }
      const pd = players.get(p.id);
      pd.total++;
      if (p.hasBall) pd.ballTime++;
      if (p.role) pd.roles[p.role] = (pd.roles[p.role] || 0) + 1;

      // Court position
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

      // Idle detection (moved < 0.9 ft/s between ticks)
      const lp = lastPos.get(p.id);
      if (lp) {
        const moved = Math.sqrt((p.x - lp.x) ** 2 + (p.y - lp.y) ** 2);
        if (moved < 0.015) pd.idle++;
      }
      lastPos.set(p.id, { x: p.x, y: p.y });
    }
  }

  // Spacing analysis (sample every 10th tick)
  const spacingViolations = {};
  let spacingSamples = 0;
  for (let i = 0; i < ticks.length; i += 10) {
    const t = ticks[i];
    spacingSamples++;
    const off = t.players.filter(p => p.teamIdx === t.possession);
    for (let a = 0; a < off.length; a++) {
      for (let b = a + 1; b < off.length; b++) {
        const d = Math.sqrt((off[a].x - off[b].x) ** 2 + (off[a].y - off[b].y) ** 2);
        if (d < 6) {
          const key = [off[a].name, off[b].name].sort().join(' + ');
          spacingViolations[key] = (spacingViolations[key] || 0) + 1;
        }
      }
    }
  }

  // ── Format Report ──────────────────────────────────────────────────
  const bar = (pct) => '█'.repeat(Math.round(pct / 2));

  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║            HOOPCRAFT TICK SIMULATION ANALYSIS               ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`Ticks: ${ticks.length} | Game: ${(ticks.length / 60).toFixed(0)}s | Possessions: ${totalPossessions} | Plays: ${totalPlays}`);
  lines.push('');

  // Phase breakdown
  lines.push('┌─ PHASE TIME ─────────────────────────────────────────────────');
  for (const [phase, count] of Object.entries(phaseTime).sort((a, b) => b[1] - a[1])) {
    const pct = count / ticks.length * 100;
    lines.push(`│ ${phase.padEnd(10)} ${pct.toFixed(1).padStart(5)}% ${bar(pct)}`);
  }
  lines.push('');

  // Fast breaks
  const fbPct = totalPossessions > 0 ? (fastBreaks / totalPossessions * 100).toFixed(1) : '0';
  lines.push(`┌─ FAST BREAKS: ${fastBreaks} / ${totalPossessions} possessions (${fbPct}%) ──── NBA avg: 15-20%`);
  lines.push('');

  // Play variety
  lines.push('┌─ PLAY SELECTION ──────────────────────────────────────────────');
  const sortedPlays = Object.entries(playCount).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedPlays.slice(0, 10)) {
    lines.push(`│ ${name.padEnd(25)} ${count}x (${(count / totalPlays * 100).toFixed(0)}%)`);
  }
  lines.push('');

  // Player stats
  lines.push('┌─ PLAYER STATS ────────────────────────────────────────────────');
  lines.push('│ Name              Pos  Tm  Front%  Idle%  Ball%  Top Roles');
  lines.push('│ ────────────────  ───  ──  ──────  ─────  ─────  ─────────────');
  for (const [, pd] of players) {
    const fcPct = (pd.frontcourt / pd.total * 100).toFixed(0);
    const idlePct = (pd.idle / pd.total * 100).toFixed(0);
    const ballPct = (pd.ballTime / pd.total * 100).toFixed(1);
    const topRoles = Object.entries(pd.roles)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, c]) => `${r}:${(c / pd.total * 100).toFixed(0)}%`)
      .join(' ');
    lines.push(`│ ${pd.name.padEnd(18)} ${pd.pos.padEnd(3)}  ${String(pd.teamIdx).padEnd(2)}  ${fcPct.padStart(4)}%   ${idlePct.padStart(3)}%   ${ballPct.padStart(5)}%  ${topRoles}`);
  }
  lines.push('');

  // Position zones
  lines.push('┌─ POSITION ZONES (offense only) ───────────────────────────────');
  lines.push('│ Name              Paint  Mid   3PT   Backcourt');
  lines.push('│ ────────────────  ─────  ────  ────  ─────────');
  for (const [, pd] of players) {
    const z = pd.zones;
    const total = pd.total || 1;
    lines.push(`│ ${pd.name.padEnd(18)} ${(z.paint/total*100).toFixed(0).padStart(3)}%   ${(z.midrange/total*100).toFixed(0).padStart(3)}%  ${(z.three/total*100).toFixed(0).padStart(3)}%   ${(z.backcourt/total*100).toFixed(0).padStart(3)}%`);
  }
  lines.push('');

  // Spacing
  lines.push(`┌─ SPACING VIOLATIONS (<6ft, sampled ${spacingSamples} ticks) ──────────────`);
  const sortedSpacing = Object.entries(spacingViolations).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (sortedSpacing.length === 0) {
    lines.push('│ None! Great spacing.');
  }
  for (const [pair, count] of sortedSpacing) {
    lines.push(`│ ${pair.padEnd(35)} ${(count / spacingSamples * 100).toFixed(1)}%`);
  }

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║                        END OF REPORT                        ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  return lines;
});

console.log('');
for (const line of report) console.log(line);

// Get final score
const score = await page.evaluate(() => {
  const text = document.body.innerText;
  const match = text.match(/(\d+)\s*[-–]\s*(\d+)/);
  return match ? `${match[1]} - ${match[2]}` : 'unknown';
});
console.log(`\nFinal Score: ${score}`);

await browser.close();
process.exit(0);
