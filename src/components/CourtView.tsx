import { useRef, useEffect, useState, useCallback } from 'react';
import { OffenseTactic, DefenseTactic } from '../engine/types';
import { GameState } from '../sim/types';
import { COURT_W, COURT_H, SCALE, CANVAS_W, CANVAS_H, BASKET_X_LEFT, BASKET_X_RIGHT, BASKET_Y, THREE_PT_RADIUS, PAINT_W, PAINT_H, FT_CIRCLE_R, CENTER_CIRCLE_R, HALF_X } from '../sim/constants';
import { getTeamBasket } from '../sim/utils';
import { getSlotPositions } from '../sim/playbook';
import { initGameState, tick } from '../sim/core';
import { emptyBoxStats } from '../sim/stats';

// ══════════════════════════════════════════════════════════════════════════
// DRAWING FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

function drawCourt(ctx: CanvasRenderingContext2D) {
  const s = SCALE;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 2;

  ctx.strokeRect(1, 1, CANVAS_W - 2, CANVAS_H - 2);

  ctx.beginPath();
  ctx.moveTo(HALF_X * s, 0);
  ctx.lineTo(HALF_X * s, COURT_H * s);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(HALF_X * s, BASKET_Y * s, CENTER_CIRCLE_R * s, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, CANVAS_H);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(CANVAS_W, 0);
  ctx.lineTo(CANVAS_W, CANVAS_H);
  ctx.stroke();

  for (const side of [0, 1]) {
    const bx = side === 0 ? BASKET_X_LEFT : BASKET_X_RIGHT;
    const dir = side === 0 ? 1 : -1;

    const paintLeft = bx - (side === 0 ? 0 : PAINT_H);
    const paintTop = (BASKET_Y - PAINT_W / 2);
    ctx.fillStyle = 'rgba(63, 185, 80, 0.04)';
    ctx.fillRect(paintLeft * s, paintTop * s, PAINT_H * s, PAINT_W * s);
    ctx.strokeRect(paintLeft * s, paintTop * s, PAINT_H * s, PAINT_W * s);

    const ftX = bx + dir * PAINT_H;
    ctx.beginPath();
    ctx.arc(ftX * s, BASKET_Y * s, FT_CIRCLE_R * s, 0, Math.PI * 2);
    ctx.stroke();

    const corner3Y = 22;
    const arcAngle = Math.acos(corner3Y / THREE_PT_RADIUS);
    const arcStartX = bx + dir * Math.sqrt(THREE_PT_RADIUS * THREE_PT_RADIUS - corner3Y * corner3Y);
    const baselineX = side === 0 ? 0 : COURT_W;
    
    const cornerY1 = BASKET_Y - corner3Y;
    const cornerY2 = BASKET_Y + corner3Y;
    ctx.beginPath();
    ctx.moveTo(baselineX * s, cornerY1 * s);
    ctx.lineTo(arcStartX * s, cornerY1 * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(baselineX * s, cornerY2 * s);
    ctx.lineTo(arcStartX * s, cornerY2 * s);
    ctx.stroke();
    
    ctx.beginPath();
    if (side === 0) {
      ctx.arc(bx * s, BASKET_Y * s, THREE_PT_RADIUS * s, -arcAngle, arcAngle);
    } else {
      ctx.arc(bx * s, BASKET_Y * s, THREE_PT_RADIUS * s, Math.PI - arcAngle, Math.PI + arcAngle);
    }
    ctx.stroke();
    
    ctx.beginPath();
    if (side === 0) {
      ctx.arc(bx * s, BASKET_Y * s, 4 * s, -Math.PI / 2, Math.PI / 2);
    } else {
      ctx.arc(bx * s, BASKET_Y * s, 4 * s, Math.PI / 2, -Math.PI / 2);
    }
    ctx.stroke();
    
    const hashPaintTop = BASKET_Y - PAINT_W / 2;
    const hashPaintBottom = BASKET_Y + PAINT_W / 2;
    const paintStart = side === 0 ? bx : bx - PAINT_H;
    const hashPositions = [7, 11, 14, 17];
    for (const hp of hashPositions) {
      const hx = (paintStart + hp) * s;
      ctx.beginPath();
      ctx.moveTo(hx, (hashPaintTop - 0.5) * s);
      ctx.lineTo(hx, (hashPaintTop + 0.5) * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hx, (hashPaintBottom - 0.5) * s);
      ctx.lineTo(hx, (hashPaintBottom + 0.5) * s);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(bx * s, BASKET_Y * s, 1.5 * s, 0, Math.PI * 2);
    ctx.strokeStyle = '#f85149';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 2;

    ctx.beginPath();
    const bbX = (bx - dir * 1) * s;
    ctx.moveTo(bbX, (BASKET_Y - 2) * s);
    ctx.lineTo(bbX, (BASKET_Y + 2) * s);
    ctx.strokeStyle = '#484f58';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 2;
  }
}

function drawSlots(ctx: CanvasRenderingContext2D, state: GameState) {
  if (state.phase !== 'setup' && state.phase !== 'action') return;
  
  const basketPos = getTeamBasket(state.possession);
  const dir = state.possession === 0 ? 1 : -1;
  const slots = getSlotPositions(basketPos, dir);
  const s = SCALE;
  
  ctx.strokeStyle = 'rgba(255, 255, 0, 0.3)';
  ctx.lineWidth = 1;
  
  for (const [slotName, slotPos] of slots.entries()) {
    const occupied = state.slots.get(slotName);
    
    ctx.beginPath();
    ctx.arc(slotPos.x * s, slotPos.y * s, 8, 0, Math.PI * 2);
    if (occupied) {
      ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.4)';
      ctx.stroke();
    }
  }
}

function drawPlayers(ctx: CanvasRenderingContext2D, state: GameState) {
  const s = SCALE;

  for (const sp of state.players) {
    const x = sp.pos.x * s;
    const groundY = sp.pos.y * s;
    const jumpOffset = (sp.jumpZ || 0) * 3;
    const y = groundY - jumpOffset;
    const r = 12 + (sp.jumpZ || 0) * 0.8;

    if (sp.jumpZ > 0.5) {
      const shadowSize = Math.max(4, 10 - sp.jumpZ * 0.5);
      const shadowAlpha = Math.max(0.1, 0.35 - sp.jumpZ * 0.02);
      ctx.beginPath();
      ctx.arc(x, groundY, shadowSize, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${shadowAlpha})`;
      ctx.fill();
    }

    if (sp.isScreening) {
      ctx.beginPath();
      ctx.arc(x, y, r + 8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    if (sp.isDefensiveSliding) {
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    
    if (sp.isCutting) {
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (sp.hasBall) {
      ctx.beginPath();
      ctx.arc(x, y, r + 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 165, 0, 0.4)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r + 12, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = sp.teamIdx === 0 ? '#f85149' : '#58a6ff';
    ctx.fill();
    ctx.strokeStyle = sp.teamIdx === 0 ? '#da3633' : '#388bfd';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = sp.player.name.split(' ').map(n => n[0]).join('');
    ctx.fillText(label, x, y);

    ctx.font = '8px monospace';
    ctx.fillStyle = '#8b949e';
    ctx.fillText(sp.player.name.split(' ')[1] || sp.player.name, x, y + r + 10);
    
    if (sp.currentRole) {
      ctx.font = '6px monospace';
      ctx.fillStyle = '#3fb950';
      const roleAbbrev = sp.currentRole === 'ballHandler' ? 'BH' : 
                        sp.currentRole === 'screener' ? 'SC' :
                        sp.currentRole === 'cutter' ? 'CT' :
                        sp.currentRole === 'spacer' ? 'SP' : 'PU';
      ctx.fillText(roleAbbrev, x, y + r + 20);
    }
    
    if (sp.fatigue > 0.3) {
      const fatigueHeight = sp.fatigue * 8;
      ctx.fillStyle = `rgba(255, 0, 0, ${sp.fatigue * 0.7})`;
      ctx.fillRect(x - 2, y - r - fatigueHeight - 2, 4, fatigueHeight);
    }
  }
}

function drawBall(ctx: CanvasRenderingContext2D, state: GameState) {
  const s = SCALE;
  const bx = state.ball.pos.x * s;
  const by = state.ball.pos.y * s;
  const zPx = state.ball.z * 3;

  if (state.ball.inFlight || state.ball.bouncing) {
    const shadowSize = Math.max(2, 6 - state.ball.z * 0.3);
    const shadowAlpha = Math.max(0.1, 0.4 - state.ball.z * 0.02);
    ctx.beginPath();
    ctx.arc(bx, by, shadowSize, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${shadowAlpha})`;
    ctx.fill();

    let elevation = zPx;
    if (state.ball.jumpBall?.active) {
      elevation = state.ball.jumpBall.height * 3;
    }
    
    const ballSize = 5 + Math.max(0, (10 - state.ball.z) * 0.2);
    
    ctx.beginPath();
    ctx.arc(bx, by - elevation, ballSize, 0, Math.PI * 2);
    ctx.fillStyle = '#e69138';
    ctx.fill();
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    
    if (state.ball.isShot && state.ball.inFlight) {
      const spinAngle = state.ball.flightProgress * Math.PI * 6;
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + Math.cos(spinAngle) * 3, by - elevation + Math.sin(spinAngle) * 1.5);
      ctx.lineTo(bx - Math.cos(spinAngle) * 3, by - elevation - Math.sin(spinAngle) * 1.5);
      ctx.stroke();
    }
  } else if (!state.ball.carrier) {
    ctx.beginPath();
    ctx.arc(bx, by, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#e69138';
    ctx.fill();
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawHUD(ctx: CanvasRenderingContext2D, state: GameState) {
  ctx.fillStyle = 'rgba(13, 17, 23, 0.95)';
  ctx.fillRect(CANVAS_W / 2 - 220, 0, 440, 50);
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.strokeRect(CANVAS_W / 2 - 220, 0, 440, 50);

  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#f85149';
  ctx.fillText('Hawks', CANVAS_W / 2 - 150, 16);
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(String(state.score[0]), CANVAS_W / 2 - 80, 22);

  ctx.fillStyle = '#3fb950';
  ctx.font = 'bold 16px monospace';
  const min = Math.floor(state.clockSeconds / 60);
  const sec = Math.floor(state.clockSeconds % 60);
  ctx.fillText(`Q${state.quarter} ${min}:${sec.toString().padStart(2, '0')}`, CANVAS_W / 2, 16);
  
  ctx.font = '10px monospace';
  ctx.fillStyle = state.shotClock < 5 ? '#f85149' : '#8b949e';
  ctx.fillText(`SC: ${Math.ceil(state.shotClock)}`, CANVAS_W / 2, 34);

  ctx.fillStyle = '#58a6ff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('Wolves', CANVAS_W / 2 + 150, 16);
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(String(state.score[1]), CANVAS_W / 2 + 80, 22);

  if (state.lastEvent) {
    ctx.fillStyle = 'rgba(13, 17, 23, 0.9)';
    ctx.fillRect(CANVAS_W / 2 - 200, CANVAS_H - 32, 400, 28);
    ctx.strokeStyle = '#30363d';
    ctx.strokeRect(CANVAS_W / 2 - 200, CANVAS_H - 32, 400, 28);
    ctx.fillStyle = '#e6edf3';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(state.lastEvent, CANVAS_W / 2, CANVAS_H - 18);
  }

  const posX = state.possession === 0 ? CANVAS_W / 2 - 80 : CANVAS_W / 2 + 80;
  ctx.beginPath();
  ctx.arc(posX, 38, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#3fb950';
  ctx.fill();
  
  ctx.fillStyle = state.possession === 0 ? '#f85149' : '#58a6ff';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('●', posX, 38);

  if (state.currentPlay) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    const playText = `${state.currentPlay.name} - Step ${state.currentStep + 1}`;
    ctx.fillText(playText, 10, CANVAS_H - 10);
  }
  
  ctx.fillStyle = state.possessionStage === 'desperation' ? '#f85149' : 
                  state.possessionStage === 'late' ? '#e3b341' :
                  state.possessionStage === 'mid' ? '#3fb950' : '#58a6ff';
  ctx.font = '8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`Possession: ${state.possessionStage.toUpperCase()}`, 10, CANVAS_H - 25);
  
  ctx.fillStyle = '#8b949e';
  ctx.font = '8px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`Phase: ${state.phase.toUpperCase()}`, CANVAS_W - 10, CANVAS_H - 10);
}

// ══════════════════════════════════════════════════════════════════════════
// REACT COMPONENT
// ══════════════════════════════════════════════════════════════════════════

export function CourtView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(initGameState());
  const animRef = useRef<number>(0);
  const [, forceUpdate] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [maxSpeed, setMaxSpeed] = useState(false);
  const [homeTacticO, setHomeTacticO] = useState<OffenseTactic>('motion');
  const [homeTacticD, setHomeTacticD] = useState<DefenseTactic>('man');
  const [awayTacticO, setAwayTacticO] = useState<OffenseTactic>('motion');
  const [awayTacticD, setAwayTacticD] = useState<DefenseTactic>('man');

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    drawCourt(ctx);
    drawSlots(ctx, stateRef.current);
    drawPlayers(ctx, stateRef.current);
    drawBall(ctx, stateRef.current);
    drawHUD(ctx, stateRef.current);
  }, []);

  useEffect(() => {
    stateRef.current.homeTacticO = homeTacticO;
    stateRef.current.homeTacticD = homeTacticD;
    stateRef.current.awayTacticO = awayTacticO;
    stateRef.current.awayTacticD = awayTacticD;
  }, [homeTacticO, homeTacticD, awayTacticO, awayTacticD]);

  useEffect(() => {
    let lastTime = 0;
    let accumulator = 0;
    const TICK_MS = 1000 / 60;
    let frameCount = 0;

    const loop = (time: number) => {
      if (lastTime === 0) lastTime = time;

      if (running && (stateRef.current.clockSeconds > 0 || !stateRef.current.gameStarted)) {
        if (maxSpeed) {
          const TICKS_PER_FRAME = 2000;
          let gameEnded = false;
          for (let i = 0; i < TICKS_PER_FRAME; i++) {
            tick(stateRef.current);
            if (stateRef.current.clockSeconds <= 0 && stateRef.current.gameStarted) {
              gameEnded = true;
              break;
            }
          }
          frameCount++;
          if (frameCount % 30 === 0 || gameEnded) {
            draw();
            forceUpdate(n => n + 1);
          }
        } else {
          const delta = (time - lastTime) * speed;
          accumulator += delta;
          while (accumulator >= TICK_MS) {
            tick(stateRef.current);
            accumulator -= TICK_MS;
          }
          forceUpdate(n => n + 1);
          draw();
        }
      } else {
        draw();
      }

      lastTime = time;
      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [running, speed, maxSpeed, draw]);

  const handlePlayPause = () => setRunning(r => !r);
  const handleReset = () => {
    stateRef.current = initGameState();
    setRunning(false);
    forceUpdate(n => n + 1);
  };

  const offenseTactics: OffenseTactic[] = ['fast_break', 'motion', 'shoot', 'inside', 'iso'];
  const defenseTactics: DefenseTactic[] = ['man', 'zone', 'press', 'gamble', 'fortress'];

  const gs = stateRef.current;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-4 flex-wrap justify-center">
        <button
          onClick={handlePlayPause}
          className="bg-[var(--color-accent-dim)] hover:bg-[var(--color-accent)] text-white font-bold px-4 py-1.5 rounded text-sm transition-colors"
        >
          {running ? '⏸ Pause' : '▶ Play'}
        </button>
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-dim)]">
          Speed:
          {[0.5, 1, 2, 4].map(s => (
            <button
              key={s}
              onClick={() => { setMaxSpeed(false); setSpeed(s); }}
              className={`px-2 py-1 rounded text-xs border transition-colors ${
                !maxSpeed && speed === s
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-dim)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]'
              }`}
            >
              {s}x
            </button>
          ))}
          <button
            onClick={() => setMaxSpeed(m => !m)}
            className={`px-2 py-1 rounded text-xs border transition-colors font-bold ${
              maxSpeed
                ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-dim)]'
                : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]'
            }`}
          >
            Max
          </button>
        </div>
        <button
          onClick={handleReset}
          className="border border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] px-3 py-1.5 rounded text-sm transition-colors"
        >
          Reset
        </button>
      </div>

      {/* Tactic selectors */}
      <div className="flex gap-6 flex-wrap justify-center text-xs">
        <div className="flex flex-col gap-1">
          <span className="text-[#f85149] font-bold">Hawks Tactics</span>
          <div className="flex gap-1">
            <span className="text-[var(--color-text-dim)] w-8">OFF:</span>
            {offenseTactics.map(t => (
              <button key={t} onClick={() => setHomeTacticO(t)}
                className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                  homeTacticO === t ? 'border-[#f85149] text-[#f85149]' : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
                }`}>{t}</button>
            ))}
          </div>
          <div className="flex gap-1">
            <span className="text-[var(--color-text-dim)] w-8">DEF:</span>
            {defenseTactics.map(t => (
              <button key={t} onClick={() => setHomeTacticD(t)}
                className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                  homeTacticD === t ? 'border-[#f85149] text-[#f85149]' : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
                }`}>{t}</button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[#58a6ff] font-bold">Wolves Tactics</span>
          <div className="flex gap-1">
            <span className="text-[var(--color-text-dim)] w-8">OFF:</span>
            {offenseTactics.map(t => (
              <button key={t} onClick={() => setAwayTacticO(t)}
                className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                  awayTacticO === t ? 'border-[#58a6ff] text-[#58a6ff]' : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
                }`}>{t}</button>
            ))}
          </div>
          <div className="flex gap-1">
            <span className="text-[var(--color-text-dim)] w-8">DEF:</span>
            {defenseTactics.map(t => (
              <button key={t} onClick={() => setAwayTacticD(t)}
                className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                  awayTacticD === t ? 'border-[#58a6ff] text-[#58a6ff]' : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
                }`}>{t}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Canvas */}
      <div className="border border-[var(--color-border)] rounded overflow-hidden" style={{ maxWidth: '100%', overflowX: 'auto' }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
        />
      </div>

      {/* Game info */}
      <div className="text-xs text-[var(--color-text-dim)] text-center max-w-4xl">
        <div className="mb-1">
          <span className="text-[var(--color-accent)]">Q{gs.quarter}</span>
          {' | '}
          <span style={{ color: gs.possession === 0 ? '#f85149' : '#58a6ff' }}>
            {gs.possession === 0 ? 'Hawks' : 'Wolves'} ball
          </span>
          {' | '}Phase: <span className="text-[var(--color-accent)]">{gs.phase}</span>
          {gs.currentPlay && 
            <span> | Play: <span className="text-yellow-400">{gs.currentPlay.name}</span> (Step {gs.currentStep + 1})</span>
          }
        </div>
        <div>{gs.lastEvent}</div>
      </div>

      {/* Box Score */}
      {gs.gameStarted && (() => {
        const teams = [
          { name: 'Hawks', color: '#f85149', teamIdx: 0 as const },
          { name: 'Wolves', color: '#58a6ff', teamIdx: 1 as const },
        ];
        const totalMin = Math.round((48 * 60 - gs.clockSeconds + (gs.quarter - 1) * 12 * 60) / 60);
        return (
          <div className="w-full max-w-4xl text-xs font-mono">
            {teams.map(team => {
              const players = gs.players.filter(p => p.teamIdx === team.teamIdx);
              return (
                <div key={team.teamIdx} className="mb-3">
                  <div className="font-bold mb-1 text-sm" style={{ color: team.color }}>
                    {team.name} — {gs.score[team.teamIdx]}
                  </div>
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="text-[var(--color-text-dim)] border-b border-[var(--color-border)]">
                        <th className="text-left py-1 pr-2 w-32">Player</th>
                        <th className="text-center px-1 w-8">PTS</th>
                        <th className="text-center px-1 w-8">REB</th>
                        <th className="text-center px-1 w-8">AST</th>
                        <th className="text-center px-1 w-8">STL</th>
                        <th className="text-center px-1 w-8">BLK</th>
                        <th className="text-center px-1 w-8">TO</th>
                        <th className="text-center px-1 w-8">PF</th>
                        <th className="text-center px-1 w-16">FG</th>
                        <th className="text-center px-1 w-16">3PT</th>
                        <th className="text-center px-1 w-16">FT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {players.map(p => {
                        const s = gs.boxStats.get(p.id) || emptyBoxStats();
                        return (
                          <tr key={p.id} className="border-b border-[var(--color-border)] border-opacity-30 hover:bg-[var(--color-surface-hover)]">
                            <td className="text-left py-0.5 pr-2 truncate" style={{ color: team.color }}>
                              <span className="text-[var(--color-text-dim)] mr-1">{p.player.position}</span>
                              {p.player.name.split(' ').pop()}
                            </td>
                            <td className="text-center font-bold" style={{ color: s.pts >= 20 ? '#ffd700' : 'inherit' }}>{s.pts}</td>
                            <td className="text-center">{s.reb}</td>
                            <td className="text-center">{s.ast}</td>
                            <td className="text-center">{s.stl}</td>
                            <td className="text-center">{s.blk}</td>
                            <td className="text-center">{s.tov}</td>
                            <td className="text-center">{s.pf}</td>
                            <td className="text-center">{s.fgm}-{s.fga}</td>
                            <td className="text-center">{s.tpm}-{s.tpa}</td>
                            <td className="text-center">{s.ftm}-{s.fta}</td>
                          </tr>
                        );
                      })}
                      <tr className="font-bold text-[var(--color-text-dim)]">
                        <td className="text-left py-0.5 pr-2">TOTAL</td>
                        {(() => {
                          const totals = players.reduce((acc, p) => {
                            const s = gs.boxStats.get(p.id) || emptyBoxStats();
                            return { pts: acc.pts + s.pts, reb: acc.reb + s.reb, ast: acc.ast + s.ast, stl: acc.stl + s.stl, blk: acc.blk + s.blk, tov: acc.tov + s.tov, pf: acc.pf + s.pf, fgm: acc.fgm + s.fgm, fga: acc.fga + s.fga, tpm: acc.tpm + s.tpm, tpa: acc.tpa + s.tpa, ftm: acc.ftm + s.ftm, fta: acc.fta + s.fta };
                          }, { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 });
                          return (<>
                            <td className="text-center">{totals.pts}</td>
                            <td className="text-center">{totals.reb}</td>
                            <td className="text-center">{totals.ast}</td>
                            <td className="text-center">{totals.stl}</td>
                            <td className="text-center">{totals.blk}</td>
                            <td className="text-center">{totals.tov}</td>
                            <td className="text-center">{totals.pf}</td>
                            <td className="text-center">{totals.fgm}-{totals.fga}</td>
                            <td className="text-center">{totals.tpm}-{totals.tpa}</td>
                            <td className="text-center">{totals.ftm}-{totals.fta}</td>
                          </>);
                        })()}
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}
