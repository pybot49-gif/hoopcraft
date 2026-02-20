import { useRef, useEffect, useState, useCallback } from 'react';
import { metroHawks, bayCityWolves } from '../store/teamsSlice';
import { Player, Team, OffenseTactic, DefenseTactic } from '../engine/types';
import { skillModifier, createRng } from '../engine/utils';
import { getTacticAdvantage } from '../engine/tactics';

// ── Court dimensions (NBA full court in feet, scaled to canvas) ──
const COURT_W = 94; // feet
const COURT_H = 50;
const SCALE = 10; // pixels per foot
const CANVAS_W = COURT_W * SCALE;
const CANVAS_H = COURT_H * SCALE;

// Court landmarks in feet from left
const BASKET_X_LEFT = 5.25;
const BASKET_X_RIGHT = COURT_W - 5.25;
const BASKET_Y = COURT_H / 2;
const THREE_PT_RADIUS = 23.75;
const PAINT_W = 16;
const PAINT_H = 19;
const FT_CIRCLE_R = 6;
const CENTER_CIRCLE_R = 6;
const HALF_X = COURT_W / 2;

// ── Sim types ──
interface Vec2 { x: number; y: number }

type PossessionPhase = 'jumpball' | 'inbound' | 'advance' | 'setup' | 'action' | 'shooting' | 'rebound' | 'freethrow';

interface SimPlayer {
  player: Player;
  pos: Vec2;
  vel: Vec2;
  targetPos: Vec2;
  teamIdx: 0 | 1; // 0=home(hawks), 1=away(wolves)
  hasBall: boolean;
  fatigue: number; // 0-1, 0=fresh
  courtIdx: number; // 0-4 index within team
  defendingPlayer?: SimPlayer; // for man defense
  screeningFor?: SimPlayer; // for screens
  rollingToBasket?: boolean; // for pick and roll
}

interface BallState {
  pos: Vec2;
  carrier: SimPlayer | null;
  inFlight: boolean;
  flightFrom: Vec2;
  flightTo: Vec2;
  flightProgress: number;
  flightDuration: number;
  isShot: boolean;
  shotWillScore: boolean;
  jumpBall?: {
    active: boolean;
    height: number;
    winner: SimPlayer | null;
  };
}

interface PlayState {
  type: 'pickandroll' | 'motion' | 'iso' | 'fastbreak' | 'inside' | 'none';
  ballHandler?: SimPlayer;
  screener?: SimPlayer;
  progress: number; // 0-1
  targetSpots?: Vec2[];
}

interface GameState {
  players: SimPlayer[];
  ball: BallState;
  score: [number, number];
  quarter: number;
  clockSeconds: number; // seconds remaining in quarter
  possession: 0 | 1;
  phase: PossessionPhase;
  phaseTicks: number;
  shotClock: number;
  running: boolean;
  speed: number;
  homeTacticO: OffenseTactic;
  homeTacticD: DefenseTactic;
  awayTacticO: OffenseTactic;
  awayTacticD: DefenseTactic;
  rng: () => number;
  lastEvent: string;
  play: PlayState;
  gameStarted: boolean;
}

// ── Offensive positions (relative to basket, normalized 0-1 of half court) ──
function getOffenseSpots(basketX: number, dir: number): Vec2[] {
  // dir: 1 = attacking right, -1 = attacking left
  return [
    { x: basketX - dir * 28, y: BASKET_Y },           // PG - top of key
    { x: basketX - dir * 22, y: BASKET_Y - 14 },      // SG - right wing
    { x: basketX - dir * 22, y: BASKET_Y + 14 },      // SF - left wing
    { x: basketX - dir * 10, y: BASKET_Y - 8 },       // PF - right block/elbow
    { x: basketX - dir * 6, y: BASKET_Y },             // C - low post
  ];
}

function getDefenseSpots(offenseSpots: Vec2[], basketX: number, tacticD: DefenseTactic): Vec2[] {
  switch (tacticD) {
    case 'zone': {
      // 2-3 zone positions
      return [
        { x: basketX - (basketX > HALF_X ? 20 : -20), y: BASKET_Y - 12 }, // guard left
        { x: basketX - (basketX > HALF_X ? 20 : -20), y: BASKET_Y + 12 }, // guard right
        { x: basketX - (basketX > HALF_X ? 12 : -12), y: BASKET_Y - 8 },  // forward left
        { x: basketX - (basketX > HALF_X ? 12 : -12), y: BASKET_Y + 8 },  // forward right
        { x: basketX - (basketX > HALF_X ? 4 : -4), y: BASKET_Y },         // center
      ];
    }
    case 'fortress': {
      // Pack the paint
      return [
        { x: basketX - (basketX > HALF_X ? 15 : -15), y: BASKET_Y - 6 },
        { x: basketX - (basketX > HALF_X ? 15 : -15), y: BASKET_Y + 6 },
        { x: basketX - (basketX > HALF_X ? 8 : -8), y: BASKET_Y - 10 },
        { x: basketX - (basketX > HALF_X ? 8 : -8), y: BASKET_Y + 10 },
        { x: basketX - (basketX > HALF_X ? 2 : -2), y: BASKET_Y },
      ];
    }
    default: {
      // Man defense: between offensive player and basket
      return offenseSpots.map(op => ({
        x: op.x + (basketX - op.x) * 0.3,
        y: op.y + (BASKET_Y - op.y) * 0.15,
      }));
    }
  }
}

function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function initGameState(): GameState {
  const rng = createRng(Date.now());
  const allPlayers: SimPlayer[] = [];

  const makeTeamPlayers = (team: Team, teamIdx: 0 | 1) => {
    team.players.slice(0, 5).forEach((p, i) => {
      allPlayers.push({
        player: p,
        pos: { x: HALF_X, y: 15 + i * 5 }, // Start near center court
        vel: { x: 0, y: 0 },
        targetPos: { x: HALF_X, y: 15 + i * 5 },
        teamIdx: teamIdx as 0 | 1,
        hasBall: false,
        fatigue: 0,
        courtIdx: i,
      });
    });
  };

  makeTeamPlayers(metroHawks, 0);
  makeTeamPlayers(bayCityWolves, 1);

  return {
    players: allPlayers,
    ball: {
      pos: { x: HALF_X, y: BASKET_Y },
      carrier: null,
      inFlight: false,
      flightFrom: { x: 0, y: 0 },
      flightTo: { x: 0, y: 0 },
      flightProgress: 0,
      flightDuration: 0,
      isShot: false,
      shotWillScore: false,
      jumpBall: {
        active: false,
        height: 0,
        winner: null
      }
    },
    score: [0, 0],
    quarter: 1,
    clockSeconds: 12 * 60,
    possession: 0,
    phase: 'jumpball',
    phaseTicks: 0,
    shotClock: 24,
    running: false,
    speed: 1,
    homeTacticO: 'motion',
    homeTacticD: 'man',
    awayTacticO: 'motion',
    awayTacticD: 'man',
    rng,
    lastEvent: 'Ready for tip-off...',
    play: { type: 'none', progress: 0 },
    gameStarted: false,
  };
}

function getTeamBasket(possession: 0 | 1): Vec2 {
  // Team attacks opposite basket
  const bx = possession === 0 ? BASKET_X_RIGHT : BASKET_X_LEFT;
  return { x: bx, y: BASKET_Y };
}

function getOwnBasket(possession: 0 | 1): Vec2 {
  const bx = possession === 0 ? BASKET_X_LEFT : BASKET_X_RIGHT;
  return { x: bx, y: BASKET_Y };
}

function movePlayerToward(sp: SimPlayer, dt: number) {
  const dx = sp.targetPos.x - sp.pos.x;
  const dy = sp.targetPos.y - sp.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.3) {
    sp.vel.x *= 0.8;
    sp.vel.y *= 0.8;
    return;
  }
  const speed = (sp.player.physical.speed / 100) * 12 * (1 - sp.fatigue * 0.3); // feet per tick-second
  const accel = (sp.player.physical.acceleration / 100) * 20;
  const targetVx = (dx / d) * speed;
  const targetVy = (dy / d) * speed;
  const blend = Math.min(1, accel * dt);
  sp.vel.x += (targetVx - sp.vel.x) * blend;
  sp.vel.y += (targetVy - sp.vel.y) * blend;
  sp.pos.x += sp.vel.x * dt;
  sp.pos.y += sp.vel.y * dt;
  sp.pos.x = clamp(sp.pos.x, 1, COURT_W - 1);
  sp.pos.y = clamp(sp.pos.y, 1, COURT_H - 1);
  sp.fatigue = Math.min(1, sp.fatigue + dt * 0.001 * (1 - sp.player.physical.stamina / 100));
}

function executePickAndRoll(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
  if (state.play.type !== 'pickandroll') return;

  const ballHandler = state.play.ballHandler || getBallHandler(state);
  const screener = state.play.screener;
  if (!ballHandler || !screener) return;

  const progress = Math.min(1, state.play.progress + 0.02);
  state.play.progress = progress;

  if (progress < 0.3) {
    // Set screen
    screener.targetPos = {
      x: ballHandler.pos.x + dir * 3,
      y: ballHandler.pos.y + (state.rng() > 0.5 ? 3 : -3)
    };
  } else if (progress < 0.6) {
    // Use screen
    ballHandler.targetPos = {
      x: screener.pos.x + dir * 2,
      y: screener.pos.y
    };
    // Screener starts to roll
    screener.rollingToBasket = true;
    screener.targetPos = {
      x: basket.x - dir * 8,
      y: basket.y + (state.rng() - 0.5) * 6
    };
  } else {
    // Read defense and execute
    const defenderOnBall = findDefender(ballHandler, state);
    const defenderOnScreener = findDefender(screener, state);
    
    if (defenderOnScreener && dist(defenderOnScreener.pos, screener.pos) > 8) {
      // Pass to rolling big
      if (state.rng() < 0.4) {
        passBall(state, ballHandler, screener);
        return;
      }
    }
    
    if (dist(ballHandler.pos, basket) < 18 && state.rng() < 0.3) {
      // Pull-up jumper
      attemptShot(state, ballHandler, basket);
    } else if (state.rng() < 0.2) {
      // Drive to basket
      ballHandler.targetPos = {
        x: basket.x - dir * 8,
        y: basket.y + (state.rng() - 0.5) * 8
      };
    }
  }
}

function executeMotionOffense(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
  if (state.play.type !== 'motion') return;

  const progress = Math.min(1, state.play.progress + 0.015);
  state.play.progress = progress;

  // Continuous movement
  for (let i = 0; i < offTeam.length; i++) {
    const p = offTeam[i];
    if (p.hasBall) continue;

    // Create movement patterns
    const t = (progress + i * 0.2) % 1;
    const angle = t * Math.PI * 2;
    const radius = 8 + i * 2;
    
    p.targetPos = {
      x: basket.x - dir * (15 + Math.cos(angle) * radius),
      y: basket.y + Math.sin(angle) * radius
    };
  }

  // Ball movement
  const ballHandler = getBallHandler(state);
  if (ballHandler && state.rng() < 0.08) {
    const nearbyOpen = offTeam.filter(p => 
      p !== ballHandler && 
      dist(p.pos, ballHandler.pos) < 20 &&
      !findDefender(p, state) || dist(findDefender(p, state)!.pos, p.pos) > 5
    );
    if (nearbyOpen.length > 0) {
      const target = nearbyOpen[Math.floor(state.rng() * nearbyOpen.length)];
      passBall(state, ballHandler, target);
    }
  }
}

function executeIsoPlay(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
  if (state.play.type !== 'iso') return;

  const ballHandler = getBallHandler(state);
  if (!ballHandler) return;

  // Clear out other players
  for (const p of offTeam) {
    if (p === ballHandler) continue;
    p.targetPos = {
      x: basket.x - dir * (25 + (p.courtIdx - 2) * 5),
      y: BASKET_Y + (p.courtIdx - 2) * 12
    };
  }

  // Iso player goes 1v1
  const defender = findDefender(ballHandler, state);
  if (defender) {
    if (dist(ballHandler.pos, basket) < 15) {
      ballHandler.targetPos = {
        x: basket.x - dir * 2,
        y: basket.y + (state.rng() - 0.5) * 4
      };
    } else {
      // Jab step, crossover moves
      ballHandler.targetPos = {
        x: ballHandler.pos.x + (state.rng() - 0.5) * 3,
        y: ballHandler.pos.y + (state.rng() - 0.5) * 3
      };
    }
  }
}

function executeFastBreak(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
  if (state.play.type !== 'fastbreak') return;

  const ballHandler = getBallHandler(state);
  if (!ballHandler) return;

  // Ball handler pushes pace
  ballHandler.targetPos = {
    x: basket.x - dir * 15,
    y: basket.y
  };

  // Wings fill lanes
  if (offTeam.length >= 3) {
    offTeam[1].targetPos = { x: basket.x - dir * 18, y: basket.y - 15 }; // Left wing
    offTeam[2].targetPos = { x: basket.x - dir * 18, y: basket.y + 15 }; // Right wing
  }

  // Trailing bigs
  for (let i = 3; i < offTeam.length; i++) {
    offTeam[i].targetPos = {
      x: ballHandler.pos.x - dir * 10,
      y: basket.y + (i - 3) * 8 - 4
    };
  }
}

function executeInsidePlay(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
  if (state.play.type !== 'inside') return;

  // Get the big man (usually center or PF)
  const bigMan = offTeam[4] || offTeam[3]; // C or PF
  if (!bigMan) return;

  // Post up
  bigMan.targetPos = {
    x: basket.x - dir * 8,
    y: basket.y + (state.rng() - 0.5) * 6
  };

  // Entry pass
  const ballHandler = getBallHandler(state);
  if (ballHandler && ballHandler !== bigMan && dist(ballHandler.pos, bigMan.pos) < 20 && state.rng() < 0.1) {
    passBall(state, ballHandler, bigMan);
  }

  // Other players space out
  for (const p of offTeam) {
    if (p === bigMan) continue;
    p.targetPos = {
      x: basket.x - dir * 20,
      y: BASKET_Y + (p.courtIdx - 2) * 10
    };
  }
}

function setupPlay(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number): void {
  const tacticO = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  const ballHandler = getBallHandler(state);
  
  // Determine play type based on tactic and situation
  let playType: PlayState['type'] = 'none';
  
  switch (tacticO) {
    case 'fast_break':
      if (state.phase === 'advance' || (state.phaseTicks < 10 && state.shotClock > 20)) {
        playType = 'fastbreak';
      }
      break;
    case 'motion':
      playType = 'motion';
      break;
    case 'iso':
      if (ballHandler?.player.isSuperstar) {
        playType = 'iso';
      }
      break;
    case 'inside':
      playType = 'inside';
      break;
    case 'shoot':
      // Quick shots, no specific play
      break;
  }

  // Pick and roll is common for many tactics
  if (playType === 'none' && state.rng() < 0.3) {
    playType = 'pickandroll';
    state.play.screener = offTeam.find(p => p.player.position === 'C' || p.player.position === 'PF');
  }

  state.play.type = playType;
  state.play.ballHandler = ballHandler || undefined;
  state.play.progress = 0;
}

function findDefender(offensivePlayer: SimPlayer, state: GameState): SimPlayer | null {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
  
  if (tacticD === 'man') {
    // Find assigned defender (by position or proximity)
    return defTeam[offensivePlayer.courtIdx] || defTeam.reduce((closest, def) => 
      dist(def.pos, offensivePlayer.pos) < dist(closest.pos, offensivePlayer.pos) ? def : closest
    );
  } else {
    // Zone - find closest defender
    return defTeam.reduce((closest, def) => 
      dist(def.pos, offensivePlayer.pos) < dist(closest.pos, offensivePlayer.pos) ? def : closest
    );
  }
}

function tick(state: GameState): GameState {
  const dt = 0.1; // game seconds per tick
  state.phaseTicks++;

  // Clock
  if (state.phase !== 'jumpball' && state.gameStarted) {
    state.clockSeconds -= dt;
    state.shotClock -= dt;
  }

  if (state.clockSeconds <= 0 && state.gameStarted) {
    state.clockSeconds = 0;
    if (state.quarter < 4) {
      state.quarter++;
      state.clockSeconds = 12 * 60;
      state.possession = (state.quarter % 2 === 0 ? 1 : 0) as 0 | 1;
      state.phase = 'inbound';
      state.phaseTicks = 0;
      state.shotClock = 24;
      resetPositions(state);
      return state;
    } else {
      state.running = false;
      return state;
    }
  }

  if (state.shotClock <= 0 && state.gameStarted) {
    // Shot clock violation - turnover
    changePossession(state, 'Shot clock violation');
    return state;
  }

  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const basket = getTeamBasket(state.possession);
  const dir = state.possession === 0 ? 1 : -1;

  // Handle ball in flight
  if (state.ball.inFlight) {
    state.ball.flightProgress += dt / state.ball.flightDuration;
    const t = Math.min(1, state.ball.flightProgress);

    if (state.ball.jumpBall?.active) {
      // Jump ball animation
      const height = Math.sin(t * Math.PI) * 15;
      state.ball.jumpBall.height = height;
      state.ball.pos.y = BASKET_Y - height;

      if (t >= 1) {
        // Determine winner
        const centers = [offTeam[4], defTeam[4]].filter(Boolean);
        if (centers.length >= 2) {
          const c1 = centers[0];
          const c2 = centers[1];
          const jump1 = c1.player.physical.vertical + c1.player.physical.height;
          const jump2 = c2.player.physical.vertical + c2.player.physical.height;
          const winner = jump1 + state.rng() * 20 > jump2 + state.rng() * 20 ? c1 : c2;
          state.ball.jumpBall.winner = winner;
          clearBallCarrier(state);
          winner.hasBall = true;
          state.ball.carrier = winner;
          state.possession = winner.teamIdx;
          state.lastEvent = `${winner.player.name} wins the tip-off!`;
          state.phase = 'advance';
          state.phaseTicks = 0;
          state.gameStarted = true;
        }
        state.ball.inFlight = false;
        state.ball.jumpBall.active = false;
      }
    } else {
      // Regular ball flight
      state.ball.pos.x = state.ball.flightFrom.x + (state.ball.flightTo.x - state.ball.flightFrom.x) * t;
      state.ball.pos.y = state.ball.flightFrom.y + (state.ball.flightTo.y - state.ball.flightFrom.y) * t;

      if (t >= 1) {
        state.ball.inFlight = false;
        if (state.ball.isShot) {
          if (state.ball.shotWillScore) {
            const distToBasket = dist(state.ball.flightFrom, basket);
            const pts = distToBasket > 22 ? 3 : 2;
            state.score[state.possession] += pts;
            state.lastEvent = `${getBallHandler(state)?.player.name || 'Player'} scores ${pts}!`;
            changePossession(state, '');
          } else {
            state.phase = 'rebound';
            state.phaseTicks = 0;
            state.lastEvent = 'Miss! Rebound...';
          }
          state.ball.isShot = false;
        } else {
          // Pass received - find closest offensive player to target
          let closest: SimPlayer | null = null;
          let closestD = Infinity;
          for (const p of offTeam) {
            const d = dist(p.pos, state.ball.pos);
            if (d < closestD) { closestD = d; closest = p; }
          }
          if (closest) {
            clearBallCarrier(state);
            closest.hasBall = true;
            state.ball.carrier = closest;
          }
        }
      }
    }
    
    // Move players even during flight
    for (const p of state.players) movePlayerToward(p, dt);
    return state;
  }

  // Phase logic
  switch (state.phase) {
    case 'jumpball': {
      // Position players around center court for jump ball
      const hawkCenter = state.players.find(p => p.teamIdx === 0 && p.player.position === 'C');
      const wolvesCenter = state.players.find(p => p.teamIdx === 1 && p.player.position === 'C');
      
      if (hawkCenter) hawkCenter.targetPos = { x: HALF_X - 2, y: BASKET_Y };
      if (wolvesCenter) wolvesCenter.targetPos = { x: HALF_X + 2, y: BASKET_Y };
      
      // Other players form circle around center
      const otherPlayers = state.players.filter(p => 
        p !== hawkCenter && p !== wolvesCenter
      );
      otherPlayers.forEach((p, i) => {
        const angle = (i / otherPlayers.length) * Math.PI * 2;
        const radius = 12;
        p.targetPos = {
          x: HALF_X + Math.cos(angle) * radius,
          y: BASKET_Y + Math.sin(angle) * radius
        };
      });

      if (state.phaseTicks > 30) {
        // Toss up the ball
        state.ball.inFlight = true;
        state.ball.flightFrom = { x: HALF_X, y: BASKET_Y };
        state.ball.flightTo = { x: HALF_X, y: BASKET_Y };
        state.ball.flightProgress = 0;
        state.ball.flightDuration = 1.0;
        state.ball.isShot = false;
        state.ball.jumpBall = { active: true, height: 0, winner: null };
        state.lastEvent = 'Jump ball!';
      }
      break;
    }
    case 'inbound': {
      // Made basket inbound
      const ownBasket = getOwnBasket(state.possession);
      const inbounder = offTeam[0]; // Usually PG
      
      // Inbounder at baseline
      inbounder.targetPos = { 
        x: ownBasket.x + (dir > 0 ? -8 : 8), 
        y: BASKET_Y + (state.rng() - 0.5) * 20 
      };
      
      clearBallCarrier(state);
      inbounder.hasBall = true;
      state.ball.carrier = inbounder;
      
      // Other offensive players spread out to receive
      for (let i = 1; i < offTeam.length; i++) {
        offTeam[i].targetPos = { 
          x: ownBasket.x + dir * (10 + i * 4), 
          y: BASKET_Y + (i - 2) * 8 
        };
      }
      
      // Defensive pressure
      const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
      if (tacticD === 'press') {
        for (let i = 0; i < defTeam.length; i++) {
          const target = offTeam[Math.min(i, offTeam.length - 1)];
          defTeam[i].targetPos = {
            x: target.pos.x + (ownBasket.x - target.pos.x) * 0.3,
            y: target.pos.y
          };
        }
      }
      
      if (state.phaseTicks > 15) {
        state.phase = 'advance';
        state.phaseTicks = 0;
      }
      break;
    }
    case 'advance': {
      const handler = getBallHandler(state);
      if (handler) {
        // Advance to half court or beyond
        const targetX = state.play.type === 'fastbreak' ? 
          basket.x - dir * 20 : // Fast break - push further
          HALF_X + dir * 8;     // Normal advance
          
        handler.targetPos = { x: targetX, y: BASKET_Y };
        
        // Check for fast break opportunity
        const defenseBack = defTeam.every(d => d.pos.x * dir < (HALF_X + dir * 10));
        if (!defenseBack && state.rng() < 0.3) {
          state.play.type = 'fastbreak';
        }
        
        if (Math.abs(handler.pos.x - HALF_X) < 12) {
          state.phase = 'setup';
          state.phaseTicks = 0;
        }
      }
      break;
    }
    case 'setup': {
      // Set up offensive and defensive positions
      const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
      const spots = getOffenseSpots(basket.x, dir);
      
      for (let i = 0; i < offTeam.length; i++) {
        offTeam[i].targetPos = { ...spots[i] };
        // Add some randomness
        offTeam[i].targetPos.x += (state.rng() - 0.5) * 3;
        offTeam[i].targetPos.y += (state.rng() - 0.5) * 3;
      }
      
      const defSpots = getDefenseSpots(spots, basket.x, tacticD);
      for (let i = 0; i < defTeam.length; i++) {
        defTeam[i].targetPos = { ...defSpots[i] };
      }
      
      if (state.phaseTicks > 20) {
        // Set up the play
        setupPlay(state, offTeam, basket, dir);
        state.phase = 'action';
        state.phaseTicks = 0;
      }
      break;
    }
    case 'action': {
      const handler = getBallHandler(state);
      if (!handler) { 
        state.phase = 'setup'; 
        state.phaseTicks = 0; 
        break; 
      }

      // Execute specific plays
      switch (state.play.type) {
        case 'pickandroll':
          executePickAndRoll(state, offTeam, basket, dir);
          break;
        case 'motion':
          executeMotionOffense(state, offTeam, basket, dir);
          break;
        case 'iso':
          executeIsoPlay(state, offTeam, basket, dir);
          break;
        case 'fastbreak':
          executeFastBreak(state, offTeam, basket, dir);
          break;
        case 'inside':
          executeInsidePlay(state, offTeam, basket, dir);
          break;
      }

      const distToBasket = dist(handler.pos, basket);

      // Decision logic with tactic modifiers
      const tacticO = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
      const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
      const advantage = getTacticAdvantage(tacticO, tacticD);
      
      const roll = state.rng();
      const timeUrgency = state.phaseTicks > 60 || state.shotClock < 8;
      
      if (timeUrgency) {
        // Forced action
        if (distToBasket < 25 || state.shotClock < 3) {
          attemptShot(state, handler, basket);
        } else {
          driveToBasket(state, handler, basket, dir);
        }
      } else if (tacticO === 'shoot' && roll < 0.08) {
        // Shoot-first offense
        attemptShot(state, handler, basket);
      } else if (roll < 0.02 + advantage * 0.5) {
        attemptShot(state, handler, basket);
      } else if (roll < 0.06 && state.play.type !== 'iso') {
        // Pass (less likely in ISO)
        const passTargets = offTeam.filter(p => p !== handler);
        if (passTargets.length > 0) {
          const target = passTargets[Math.floor(state.rng() * passTargets.length)];
          passBall(state, handler, target);
        }
      } else if (roll < 0.1) {
        driveToBasket(state, handler, basket, dir);
      } else {
        // Check for steal with defensive tactic modifiers
        const nearestDef = defTeam.reduce((best, d) =>
          dist(d.pos, handler.pos) < dist(best.pos, handler.pos) ? d : best, defTeam[0]);
        let stealChance = skillModifier(nearestDef.player.skills.defense.steal) * 0.015;
        
        if (tacticD === 'gamble') stealChance *= 1.5;
        if (tacticD === 'press') stealChance *= 1.2;
        
        if (dist(nearestDef.pos, handler.pos) < 3 && state.rng() < stealChance) {
          clearBallCarrier(state);
          nearestDef.hasBall = true;
          state.ball.carrier = nearestDef;
          state.lastEvent = `${nearestDef.player.name} steals the ball!`;
          changePossession(state, '');
        }
      }

      // Move defenders based on tactic
      updateDefensePositions(state, defTeam, offTeam, basket, tacticD);
      break;
    }
    case 'shooting': {
      // Handled by ball in flight
      if (!state.ball.inFlight) {
        state.phase = 'action';
        state.phaseTicks = 0;
      }
      break;
    }
    case 'rebound': {
      // All players converge on ball with rebounding skill
      for (const p of state.players) {
        p.targetPos = { 
          x: state.ball.pos.x + (state.rng() - 0.5) * 4, 
          y: state.ball.pos.y + (state.rng() - 0.5) * 4 
        };
      }
      
      if (state.phaseTicks > 8) {
        // Determine who gets rebound based on position, size, and skill
        const nearPlayers = [...state.players]
          .sort((a, b) => dist(a.pos, state.ball.pos) - dist(b.pos, state.ball.pos))
          .slice(0, 5); // Top 5 closest players compete
          
        let rebounder: SimPlayer | null = null;
        let bestReboundValue = 0;
        
        for (const p of nearPlayers) {
          const rebSkill = p.player.skills.athletic.rebounding;
          const height = p.player.physical.height;
          const position = dist(p.pos, state.ball.pos);
          
          const reboundValue = skillModifier(rebSkill) * 
            (height / 200) * 
            (10 - position) * // Closer is better
            state.rng();
            
          if (reboundValue > bestReboundValue) {
            bestReboundValue = reboundValue;
            rebounder = p;
          }
        }
        
        if (!rebounder) rebounder = nearPlayers[0];
        
        clearBallCarrier(state);
        rebounder.hasBall = true;
        state.ball.carrier = rebounder;
        state.ball.pos = { ...rebounder.pos };
        state.lastEvent = `${rebounder.player.name} grabs the rebound`;
        
        if (rebounder.teamIdx !== state.possession) {
          // Defensive rebound - change possession
          changePossession(state, '');
        } else {
          // Offensive rebound - reset shot clock
          state.shotClock = 24;
          state.phase = 'setup';
          state.phaseTicks = 0;
        }
      }
      break;
    }
  }

  // Move all players
  for (const p of state.players) {
    movePlayerToward(p, dt);
    
    // Reset rolling state if play is over
    if (state.play.type !== 'pickandroll') {
      p.rollingToBasket = false;
    }
  }

  // Ball follows carrier
  if (state.ball.carrier && !state.ball.inFlight) {
    state.ball.pos = { ...state.ball.carrier.pos };
  }

  return state;
}

function updateDefensePositions(
  state: GameState, 
  defTeam: SimPlayer[], 
  offTeam: SimPlayer[], 
  basket: Vec2, 
  tacticD: DefenseTactic
) {
  const ballHandler = getBallHandler(state);
  
  switch (tacticD) {
    case 'man':
      // Assign each defender to an offensive player
      for (let i = 0; i < defTeam.length && i < offTeam.length; i++) {
        const defender = defTeam[i];
        const assignment = offTeam[i];
        defender.targetPos = {
          x: assignment.pos.x + (basket.x - assignment.pos.x) * 0.3,
          y: assignment.pos.y + (basket.y - assignment.pos.y) * 0.2
        };
        defender.defendingPlayer = assignment;
      }
      break;
      
    case 'zone':
      // Shift zone based on ball position
      if (ballHandler) {
        const zoneShift = {
          x: (ballHandler.pos.x - basket.x) * 0.3,
          y: (ballHandler.pos.y - basket.y) * 0.3
        };
        
        const baseSpots = getDefenseSpots([], basket.x, tacticD);
        for (let i = 0; i < defTeam.length; i++) {
          defTeam[i].targetPos = {
            x: baseSpots[i].x + zoneShift.x,
            y: baseSpots[i].y + zoneShift.y
          };
        }
      }
      break;
      
    case 'press':
      // Full court pressure
      for (let i = 0; i < defTeam.length && i < offTeam.length; i++) {
        const defender = defTeam[i];
        const target = offTeam[i];
        defender.targetPos = {
          x: target.pos.x - (target.pos.x - basket.x) * 0.1, // Stay between target and their basket
          y: target.pos.y
        };
      }
      break;
      
    case 'gamble':
      // Aggressive, go for steals
      if (ballHandler) {
        const ballDefender = defTeam[0];
        ballDefender.targetPos = {
          x: ballHandler.pos.x + (state.rng() - 0.5) * 2,
          y: ballHandler.pos.y + (state.rng() - 0.5) * 2
        };
        
        // Others play help defense
        for (let i = 1; i < defTeam.length; i++) {
          defTeam[i].targetPos = {
            x: basket.x - (basket.x > HALF_X ? 12 : -12),
            y: basket.y + (i - 2) * 6
          };
        }
      }
      break;
      
    case 'fortress':
      // Pack the paint, give up perimeter
      const baseSpots = getDefenseSpots([], basket.x, tacticD);
      for (let i = 0; i < defTeam.length; i++) {
        defTeam[i].targetPos = { ...baseSpots[i] };
      }
      break;
  }
}

function getBallHandler(state: GameState): SimPlayer | null {
  return state.ball.carrier;
}

function clearBallCarrier(state: GameState) {
  for (const p of state.players) {
    p.hasBall = false;
  }
  state.ball.carrier = null;
}

function attemptShot(state: GameState, handler: SimPlayer, basket: Vec2) {
  const distToBasket = dist(handler.pos, basket);
  let shotSkill: number;
  
  if (distToBasket > 22) {
    shotSkill = handler.player.skills.shooting.three_point;
  } else if (distToBasket > 10) {
    shotSkill = handler.player.skills.shooting.mid_range;
  } else {
    shotSkill = handler.player.skills.finishing.layup;
  }

  // Apply tactic and defense modifiers
  const tacticO = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
  const advantage = getTacticAdvantage(tacticO, tacticD);
  
  let basePct = distToBasket > 22 ? 0.35 : distToBasket > 10 ? 0.45 : 0.60;
  
  // Contest from nearest defender
  const nearestDef = state.players
    .filter(p => p.teamIdx !== state.possession)
    .reduce((best, d) => dist(d.pos, handler.pos) < dist(best.pos, handler.pos) ? d : best);
    
  const contestDistance = dist(nearestDef.pos, handler.pos);
  if (contestDistance < 4) {
    basePct *= 0.7; // Heavy contest
  } else if (contestDistance < 6) {
    basePct *= 0.85; // Light contest
  }
  
  const pct = basePct * skillModifier(shotSkill) * (1 + advantage);
  const willScore = state.rng() < pct;

  state.ball.inFlight = true;
  state.ball.flightFrom = { ...handler.pos };
  state.ball.flightTo = { ...basket };
  state.ball.flightProgress = 0;
  state.ball.flightDuration = 0.6 + distToBasket * 0.02;
  state.ball.isShot = true;
  state.ball.shotWillScore = willScore;
  clearBallCarrier(state);
  state.phase = 'shooting';
  state.play = { type: 'none', progress: 0 }; // End current play
  state.lastEvent = `${handler.player.name} shoots from ${distToBasket.toFixed(0)}ft`;
}

function passBall(state: GameState, from: SimPlayer, to: SimPlayer) {
  // Check for steal on pass
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const passLine = { from: from.pos, to: to.pos };
  
  for (const def of defTeam) {
    const distToLine = distanceToLine(def.pos, passLine);
    if (distToLine < 3) {
      const stealChance = skillModifier(def.player.skills.defense.steal) * 0.05;
      if (state.rng() < stealChance) {
        clearBallCarrier(state);
        def.hasBall = true;
        state.ball.carrier = def;
        state.lastEvent = `${def.player.name} intercepts the pass!`;
        changePossession(state, '');
        return;
      }
    }
  }

  state.ball.inFlight = true;
  state.ball.flightFrom = { ...from.pos };
  state.ball.flightTo = { ...to.pos };
  state.ball.flightProgress = 0;
  const d = dist(from.pos, to.pos);
  state.ball.flightDuration = 0.2 + d * 0.015;
  state.ball.isShot = false;
  state.ball.shotWillScore = false;
  clearBallCarrier(state);
  state.lastEvent = `${from.player.name} passes to ${to.player.name}`;
}

function distanceToLine(point: Vec2, line: { from: Vec2; to: Vec2 }): number {
  const A = point.x - line.from.x;
  const B = point.y - line.from.y;
  const C = line.to.x - line.from.x;
  const D = line.to.y - line.from.y;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  
  if (lenSq === 0) return Math.sqrt(A * A + B * B);
  
  let param = dot / lenSq;
  param = Math.max(0, Math.min(1, param));
  
  const xx = line.from.x + param * C;
  const yy = line.from.y + param * D;
  
  const dx = point.x - xx;
  const dy = point.y - yy;
  return Math.sqrt(dx * dx + dy * dy);
}

function driveToBasket(state: GameState, handler: SimPlayer, basket: Vec2, _dir: number) {
  handler.targetPos = {
    x: basket.x + (handler.pos.x > basket.x ? 3 : -3),
    y: basket.y + (state.rng() - 0.5) * 8,
  };
}

function changePossession(state: GameState, event: string) {
  state.possession = (1 - state.possession) as 0 | 1;
  state.phase = 'inbound';
  state.phaseTicks = 0;
  state.shotClock = 24;
  state.play = { type: 'none', progress: 0 };
  if (event) state.lastEvent = event;
  resetPositions(state);
}

function resetPositions(state: GameState) {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const dir = state.possession === 0 ? 1 : -1;
  const ownBasket = getOwnBasket(state.possession);

  clearBallCarrier(state);
  
  // Spread out for inbound
  for (let i = 0; i < offTeam.length; i++) {
    offTeam[i].pos = { 
      x: ownBasket.x + dir * (8 + i * 3), 
      y: BASKET_Y + (i - 2) * 6 
    };
    offTeam[i].targetPos = { ...offTeam[i].pos };
    offTeam[i].rollingToBasket = false;
  }

  // Defense transitions
  for (let i = 0; i < defTeam.length; i++) {
    defTeam[i].pos = { 
      x: ownBasket.x + dir * (15 + i * 3), 
      y: BASKET_Y + (i - 2) * 6 
    };
    defTeam[i].targetPos = { ...defTeam[i].pos };
  }

  state.ball.pos = { ...offTeam[0].pos };
  state.ball.inFlight = false;
}

// ── Drawing functions (keeping original style) ──
function drawCourt(ctx: CanvasRenderingContext2D) {
  const s = SCALE;

  // Background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Court surface
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 2;

  // Court outline
  ctx.strokeRect(1, 1, CANVAS_W - 2, CANVAS_H - 2);

  // Half court line
  ctx.beginPath();
  ctx.moveTo(HALF_X * s, 0);
  ctx.lineTo(HALF_X * s, COURT_H * s);
  ctx.stroke();

  // Center circle
  ctx.beginPath();
  ctx.arc(HALF_X * s, BASKET_Y * s, CENTER_CIRCLE_R * s, 0, Math.PI * 2);
  ctx.stroke();

  // Draw both sides
  for (const side of [0, 1]) {
    const bx = side === 0 ? BASKET_X_LEFT : BASKET_X_RIGHT;
    const dir = side === 0 ? 1 : -1;

    // Paint / key
    const paintLeft = bx - (side === 0 ? 0 : PAINT_H);
    const paintTop = (BASKET_Y - PAINT_W / 2);
    ctx.fillStyle = 'rgba(63, 185, 80, 0.04)';
    ctx.fillRect(paintLeft * s, paintTop * s, PAINT_H * s, PAINT_W * s);
    ctx.strokeRect(paintLeft * s, paintTop * s, PAINT_H * s, PAINT_W * s);

    // Free throw circle
    const ftX = bx + dir * PAINT_H;
    ctx.beginPath();
    ctx.arc(ftX * s, BASKET_Y * s, FT_CIRCLE_R * s, 0, Math.PI * 2);
    ctx.stroke();

    // Three-point arc
    ctx.beginPath();
    const startAngle = side === 0 ? -Math.PI / 2 : Math.PI / 2;
    const endAngle = side === 0 ? Math.PI / 2 : -Math.PI / 2;
    ctx.arc(bx * s, BASKET_Y * s, THREE_PT_RADIUS * s, startAngle, endAngle, side === 1);
    // Corner three lines
    const cornerY1 = BASKET_Y - THREE_PT_RADIUS;
    const cornerY2 = BASKET_Y + THREE_PT_RADIUS;
    if (side === 0) {
      ctx.moveTo(0, Math.max(0, cornerY1 * s));
      ctx.lineTo(0, 0);
      ctx.moveTo(0, Math.min(CANVAS_H, cornerY2 * s));
      ctx.lineTo(0, CANVAS_H);
    } else {
      ctx.moveTo(CANVAS_W, Math.max(0, cornerY1 * s));
      ctx.lineTo(CANVAS_W, 0);
      ctx.moveTo(CANVAS_W, Math.min(CANVAS_H, cornerY2 * s));
      ctx.lineTo(CANVAS_W, CANVAS_H);
    }
    ctx.stroke();

    // Basket (rim)
    ctx.beginPath();
    ctx.arc(bx * s, BASKET_Y * s, 1.5 * s, 0, Math.PI * 2);
    ctx.strokeStyle = '#f85149';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 2;

    // Backboard
    ctx.beginPath();
    const bbX = (bx - dir * 1) * s;
    ctx.moveTo(bbX, (BASKET_Y - 3) * s);
    ctx.lineTo(bbX, (BASKET_Y + 3) * s);
    ctx.strokeStyle = '#484f58';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 2;
  }
}

function drawPlayers(ctx: CanvasRenderingContext2D, state: GameState) {
  const s = SCALE;

  for (const sp of state.players) {
    const x = sp.pos.x * s;
    const y = sp.pos.y * s;
    const r = 12;

    // Special effects
    if (sp.rollingToBasket) {
      // Rolling to basket indicator
      ctx.beginPath();
      ctx.arc(x, y, r + 8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Glow for ball carrier
    if (sp.hasBall) {
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 165, 0, 0.35)';
      ctx.fill();
    }

    // Player circle
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = sp.teamIdx === 0 ? '#f85149' : '#58a6ff';
    ctx.fill();
    ctx.strokeStyle = sp.teamIdx === 0 ? '#da3633' : '#388bfd';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Jersey number / initials
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = sp.player.name.split(' ').map(n => n[0]).join('');
    ctx.fillText(label, x, y);

    // Name below
    ctx.font = '8px monospace';
    ctx.fillStyle = '#8b949e';
    ctx.fillText(sp.player.name.split(' ')[1] || sp.player.name, x, y + r + 10);
  }
}

function drawBall(ctx: CanvasRenderingContext2D, state: GameState) {
  const s = SCALE;
  const bx = state.ball.pos.x * s;
  const by = state.ball.pos.y * s;

  if (state.ball.inFlight) {
    // Draw ball shadow
    ctx.beginPath();
    ctx.arc(bx, by + 3, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    // Elevated ball (arc effect)
    let elevation = 0;
    if (state.ball.jumpBall?.active) {
      elevation = state.ball.jumpBall.height;
    } else {
      const t = state.ball.flightProgress;
      elevation = Math.sin(t * Math.PI) * (state.ball.isShot ? 15 : 5);
    }
    
    ctx.beginPath();
    ctx.arc(bx, by - elevation, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#e69138';
    ctx.fill();
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (!state.ball.carrier) {
    ctx.beginPath();
    ctx.arc(bx, by, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#e69138';
    ctx.fill();
  }
}

function drawHUD(ctx: CanvasRenderingContext2D, state: GameState) {
  // Scoreboard background
  ctx.fillStyle = 'rgba(13, 17, 23, 0.9)';
  ctx.fillRect(CANVAS_W / 2 - 200, 0, 400, 44);
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.strokeRect(CANVAS_W / 2 - 200, 0, 400, 44);

  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Home team
  ctx.fillStyle = '#f85149';
  ctx.fillText('Hawks', CANVAS_W / 2 - 130, 16);
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(String(state.score[0]), CANVAS_W / 2 - 60, 22);

  // Clock
  ctx.fillStyle = '#3fb950';
  ctx.font = 'bold 16px monospace';
  const min = Math.floor(state.clockSeconds / 60);
  const sec = Math.floor(state.clockSeconds % 60);
  ctx.fillText(`Q${state.quarter} ${min}:${sec.toString().padStart(2, '0')}`, CANVAS_W / 2, 16);
  ctx.font = '10px monospace';
  ctx.fillStyle = '#8b949e';
  ctx.fillText(`SC: ${Math.ceil(state.shotClock)}`, CANVAS_W / 2, 34);

  // Away team
  ctx.fillStyle = '#58a6ff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('Wolves', CANVAS_W / 2 + 130, 16);
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(String(state.score[1]), CANVAS_W / 2 + 60, 22);

  // Event text
  if (state.lastEvent) {
    ctx.fillStyle = 'rgba(13, 17, 23, 0.85)';
    ctx.fillRect(CANVAS_W / 2 - 180, CANVAS_H - 28, 360, 24);
    ctx.fillStyle = '#e6edf3';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(state.lastEvent, CANVAS_W / 2, CANVAS_H - 16);
  }

  // Possession indicator
  const posX = state.possession === 0 ? CANVAS_W / 2 - 60 : CANVAS_W / 2 + 60;
  ctx.beginPath();
  ctx.arc(posX, 36, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#3fb950';
  ctx.fill();

  // Play indicator
  if (state.play.type !== 'none') {
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`Play: ${state.play.type}`, CANVAS_W / 2, CANVAS_H - 4);
  }
}

// ── React Component ──
export function CourtView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(initGameState());
  const animRef = useRef<number>(0);
  const [, forceUpdate] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
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

    const loop = (time: number) => {
      if (lastTime === 0) lastTime = time;
      const delta = (time - lastTime) * speed;
      lastTime = time;

      if (running && (stateRef.current.clockSeconds > 0 || !stateRef.current.gameStarted)) {
        accumulator += delta;
        while (accumulator >= TICK_MS) {
          tick(stateRef.current);
          accumulator -= TICK_MS;
        }
        forceUpdate(n => n + 1);
      }

      draw();
      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [running, speed, draw]);

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
              onClick={() => setSpeed(s)}
              className={`px-2 py-1 rounded text-xs border transition-colors ${
                speed === s
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-dim)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]'
              }`}
            >
              {s}x
            </button>
          ))}
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
      <div className="text-xs text-[var(--color-text-dim)] text-center">
        <span className="text-[var(--color-accent)]">Q{gs.quarter}</span>
        {' | '}
        <span style={{ color: gs.possession === 0 ? '#f85149' : '#58a6ff' }}>
          {gs.possession === 0 ? 'Hawks' : 'Wolves'} ball
        </span>
        {' | '}Phase: {gs.phase}
        {gs.play.type !== 'none' && ` | Play: ${gs.play.type}`}
        {' | '}{gs.lastEvent}
      </div>
    </div>
  );
}