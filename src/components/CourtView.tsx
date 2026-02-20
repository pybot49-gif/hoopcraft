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

// ── Enhanced Sim types ──
interface Vec2 { x: number; y: number }

type PossessionPhase = 'jumpball' | 'inbound' | 'advance' | 'setup' | 'action' | 'shooting' | 'rebound' | 'freethrow';

interface Movement {
  driftX: number;
  driftY: number;
  speed: number;
  lastMoveTime: number;
  isDefensiveSliding: boolean;
  isCutting: boolean;
  isScreening: boolean;
}

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
  lastShotContested: number; // timestamp when last contested a shot
  movement: Movement;
  ballHandlerMoves: {
    crossoverCooldown: number;
    hesitationCooldown: number;
    lastMoveTime: number;
  };
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
  stage: number; // Current stage of the play
  stageTimer: number; // Time in current stage
  targetSpots?: Vec2[];
  passCount: number;
  lastPassTime: number;
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
  gameTime: number; // Total elapsed game time for animations
  lastPassFrom: SimPlayer | null; // Track who just passed to prevent ping-pong
  lastPassTime: number; // When the last pass occurred
  crossedHalfCourt: boolean; // Track if offense has crossed half court
  advanceClockSeconds: number; // 8-second violation counter
  recentPassTargets: { player: SimPlayer; time: number }[]; // Track recent pass recipients
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
        lastShotContested: 0,
        movement: {
          driftX: 0,
          driftY: 0,
          speed: 0,
          lastMoveTime: 0,
          isDefensiveSliding: false,
          isCutting: false,
          isScreening: false,
        },
        ballHandlerMoves: {
          crossoverCooldown: 0,
          hesitationCooldown: 0,
          lastMoveTime: 0,
        },
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
    play: { type: 'none', progress: 0, stage: 0, stageTimer: 0, passCount: 0, lastPassTime: 0 },
    gameStarted: false,
    gameTime: 0,
    lastPassFrom: null,
    lastPassTime: 0,
    crossedHalfCourt: false,
    advanceClockSeconds: 0,
    recentPassTargets: [],
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

// ── Enhanced Movement System ──
function addCollisionAvoidance(player: SimPlayer, allPlayers: SimPlayer[]) {
  // Add repulsion force when within 2ft of each other
  for (const other of allPlayers) {
    if (other === player) continue;
    const d = dist(player.pos, other.pos);
    if (d < 2 && d > 0) {
      const pushX = (player.pos.x - other.pos.x) / d;
      const pushY = (player.pos.y - other.pos.y) / d;
      const strength = (2 - d) * 2; // Stronger push when closer
      player.targetPos.x += pushX * strength;
      player.targetPos.y += pushY * strength;
    }
  }
}

function addIdleMovement(player: SimPlayer, gameTime: number) {
  // Athletes are never completely still - add subtle drift/sway
  const t = gameTime * 0.5 + player.courtIdx * 1.2; // Different phase for each player
  player.movement.driftX = Math.sin(t) * 0.5;
  player.movement.driftY = Math.cos(t * 1.3) * 0.3;
  
  // Occasionally add larger repositioning moves
  if (gameTime - player.movement.lastMoveTime > 2 + Math.random() * 3) {
    player.movement.lastMoveTime = gameTime;
    player.targetPos.x += (Math.random() - 0.5) * 4;
    player.targetPos.y += (Math.random() - 0.5) * 4;
  }
}

function movePlayerToward(sp: SimPlayer, dt: number, gameTime: number, allPlayers: SimPlayer[]) {
  // Add idle movement first
  addIdleMovement(sp, gameTime);
  
  // Apply drift to target position
  const adjustedTarget = {
    x: sp.targetPos.x + sp.movement.driftX,
    y: sp.targetPos.y + sp.movement.driftY
  };
  
  // Add collision avoidance
  addCollisionAvoidance(sp, allPlayers);
  
  const dx = adjustedTarget.x - sp.pos.x;
  const dy = adjustedTarget.y - sp.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  
  if (d < 0.3) {
    sp.vel.x *= 0.8;
    sp.vel.y *= 0.8;
    return;
  }
  
  // Enhanced speed calculation based on context (reduced from 12 to 6 for more realistic movement)
  let baseSpeed = (sp.player.physical.speed / 100) * 6 * (1 - sp.fatigue * 0.3);
  
  // Movement type modifiers
  if (sp.movement.isDefensiveSliding) baseSpeed *= 0.9; // Sliding is slightly slower
  if (sp.movement.isCutting) baseSpeed *= 1.2; // Cutting is faster
  if (sp.hasBall) baseSpeed *= 0.8; // Dribbling slows you down
  
  const accel = (sp.player.physical.acceleration / 100) * 15; // Reduced from 20 to 15
  const targetVx = (dx / d) * baseSpeed;
  const targetVy = (dy / d) * baseSpeed;
  const blend = Math.min(1, accel * dt * 0.7); // Reduced blend factor for more human-like acceleration
  
  sp.vel.x += (targetVx - sp.vel.x) * blend;
  sp.vel.y += (targetVy - sp.vel.y) * blend;
  sp.pos.x += sp.vel.x * dt;
  sp.pos.y += sp.vel.y * dt;
  sp.pos.x = clamp(sp.pos.x, 1, COURT_W - 1);
  sp.pos.y = clamp(sp.pos.y, 1, COURT_H - 1);
  sp.fatigue = Math.min(1, sp.fatigue + dt * 0.001 * (1 - sp.player.physical.stamina / 100));
}

// ── Enhanced Ball Handler AI ──
function executeBallHandlerMoves(state: GameState, handler: SimPlayer, defender: SimPlayer | null) {
  if (!defender) return;
  
  const gameTime = state.gameTime;
  const defDistance = dist(handler.pos, defender.pos);
  
  // Dribble moves when defender is close
  if (defDistance < 6 && gameTime - handler.ballHandlerMoves.lastMoveTime > 1) {
    const rand = state.rng();
    
    // Crossover move
    if (rand < 0.3 && handler.ballHandlerMoves.crossoverCooldown <= 0) {
      handler.targetPos.x += (state.rng() - 0.5) * 4;
      handler.ballHandlerMoves.crossoverCooldown = 2;
      handler.ballHandlerMoves.lastMoveTime = gameTime;
      return;
    }
    
    // Hesitation move
    if (rand < 0.6 && handler.ballHandlerMoves.hesitationCooldown <= 0) {
      handler.vel.x *= 0.3; // Slow down suddenly
      handler.vel.y *= 0.3;
      handler.ballHandlerMoves.hesitationCooldown = 1.5;
      handler.ballHandlerMoves.lastMoveTime = gameTime;
      return;
    }
    
    // Between the legs (represented as lateral movement)
    if (rand < 0.8) {
      handler.targetPos.y += (state.rng() - 0.5) * 3;
      handler.ballHandlerMoves.lastMoveTime = gameTime;
    }
  }
  
  // Reduce cooldowns
  handler.ballHandlerMoves.crossoverCooldown = Math.max(0, handler.ballHandlerMoves.crossoverCooldown - 0.1);
  handler.ballHandlerMoves.hesitationCooldown = Math.max(0, handler.ballHandlerMoves.hesitationCooldown - 0.1);
  
  // Slow down when defender is directly ahead
  if (defDistance < 4) {
    const basket = getTeamBasket(state.possession);
    const toBasket = { x: basket.x - handler.pos.x, y: basket.y - handler.pos.y };
    const toDefender = { x: defender.pos.x - handler.pos.x, y: defender.pos.y - handler.pos.y };
    
    // Calculate if defender is between handler and basket
    const dot = (toBasket.x * toDefender.x + toBasket.y * toDefender.y) / 
                (Math.sqrt(toBasket.x * toBasket.x + toBasket.y * toBasket.y) * Math.sqrt(toDefender.x * toDefender.x + toDefender.y * toDefender.y));
    
    if (dot > 0.7) { // Defender is roughly in front
      handler.vel.x *= 0.6;
      handler.vel.y *= 0.6;
    }
  }
}

// ── Enhanced Defensive AI ──
function updateEnhancedDefense(state: GameState, defTeam: SimPlayer[], offTeam: SimPlayer[], basket: Vec2, tacticD: DefenseTactic) {
  const ballHandler = getBallHandler(state);
  
  for (const defender of defTeam) {
    let assignment: SimPlayer | null = null;
    
    // Determine assignment based on defensive tactic
    switch (tacticD) {
      case 'man':
        assignment = offTeam[defender.courtIdx] || offTeam[0];
        break;
      case 'zone':
        // Zone defense - guard area and closest threats
        assignment = offTeam.reduce((closest, off) => 
          dist(defender.pos, off.pos) < dist(defender.pos, closest.pos) ? off : closest
        );
        break;
      default:
        assignment = offTeam[defender.courtIdx] || offTeam[0];
    }
    
    defender.defendingPlayer = assignment;
    
    if (!assignment) continue;
    
    // Enhanced defensive positioning
    if (assignment === ballHandler) {
      // On-ball defense
      defender.movement.isDefensiveSliding = true;
      
      // Stay between ball handler and basket
      const basketDir = { 
        x: basket.x - assignment.pos.x, 
        y: basket.y - assignment.pos.y 
      };
      const basketDist = Math.sqrt(basketDir.x * basketDir.x + basketDir.y * basketDir.y);
      
      if (basketDist > 0) {
        basketDir.x /= basketDist;
        basketDir.y /= basketDist;
        
        // Position slightly in front of ball handler toward basket
        defender.targetPos = {
          x: assignment.pos.x + basketDir.x * 2,
          y: assignment.pos.y + basketDir.y * 2
        };
      }
    } else {
      // Off-ball defense with enhanced rotations
      defender.movement.isDefensiveSliding = false;
      
      // Enhanced help defense logic
      if (ballHandler && dist(ballHandler.pos, basket) < 15) {
        // Ball handler is driving - need help defense
        const helpPos = {
          x: ballHandler.pos.x + (basket.x - ballHandler.pos.x) * 0.6,
          y: ballHandler.pos.y + (basket.y - ballHandler.pos.y) * 0.6
        };
        
        // Weak side help - closest help defender steps up
        const distToHelp = dist(defender.pos, helpPos);
        if (distToHelp < 10 && distToHelp < 8) {
          defender.targetPos = helpPos;
          
          // When help defender leaves, their assignment becomes "open" 
          // This should trigger kick-out pass recognition in offense
          const myAssignment = assignment;
          if (myAssignment && dist(defender.pos, myAssignment.pos) > 6) {
            // Assignment is now open due to help defense
          }
        } else {
          // Deny passing lane to assignment but stay ready to rotate
          defender.targetPos = {
            x: assignment.pos.x + (ballHandler!.pos.x - assignment.pos.x) * 0.4,
            y: assignment.pos.y + (ballHandler!.pos.y - assignment.pos.y) * 0.4
          };
        }
      } else {
        // Normal off-ball defense - between assignment and basket
        defender.targetPos = {
          x: assignment.pos.x + (basket.x - assignment.pos.x) * 0.3,
          y: assignment.pos.y + (basket.y - assignment.pos.y) * 0.2
        };
      }
    }
    
    // Screen defense communication
    const nearbyScreener = offTeam.find(p => p.movement.isScreening && dist(p.pos, defender.pos) < 6);
    if (nearbyScreener && assignment === ballHandler) {
      // Screen is coming - decide to switch or fight through
      const shouldSwitch = state.rng() < 0.4; // 40% chance to switch
      
      if (shouldSwitch) {
        // Switch assignments with the screener's defender
        const screenerDefender = defTeam.find(d => d.defendingPlayer === nearbyScreener);
        if (screenerDefender) {
          defender.defendingPlayer = nearbyScreener;
          screenerDefender.defendingPlayer = assignment;
        }
      } else {
        // Fight through the screen - more aggressive positioning
        defender.targetPos = {
          x: assignment.pos.x + (assignment.pos.x > nearbyScreener.pos.x ? 2 : -2),
          y: assignment.pos.y + (assignment.pos.y > nearbyScreener.pos.y ? 2 : -2)
        };
      }
    }
    
    // Closeout on shooters - when assignment gets the ball, sprint at them
    if (assignment === ballHandler && state.play.lastPassTime > 0 && 
        state.gameTime - state.play.lastPassTime < 1) {
      defender.movement.speed = 1.5; // Sprint to close out
      const closeoutDist = Math.max(3, dist(defender.pos, assignment.pos) - 2);
      const closeoutDir = {
        x: (assignment.pos.x - defender.pos.x) / dist(defender.pos, assignment.pos),
        y: (assignment.pos.y - defender.pos.y) / dist(defender.pos, assignment.pos)
      };
      defender.targetPos = {
        x: assignment.pos.x - closeoutDir.x * closeoutDist,
        y: assignment.pos.y - closeoutDir.y * closeoutDist
      };
    }
    
    // Contest shots - sprint at shooter when shot goes up
    if (state.phase === 'shooting' && assignment === ballHandler) {
      defender.targetPos = { ...assignment.pos };
      defender.lastShotContested = state.gameTime;
    }
  }
}

// ── Enhanced Play Execution System ──
function executePickAndRollStages(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
  if (state.play.type !== 'pickandroll') return;

  const ballHandler = state.play.ballHandler || getBallHandler(state);
  const screener = state.play.screener;
  if (!ballHandler || !screener) return;

  state.play.stageTimer += 0.1;
  
  switch (state.play.stage) {
    case 0: // Stage 1: Screener walks up to set screen (2s)
      screener.movement.isScreening = true;
      screener.targetPos = {
        x: ballHandler.pos.x + dir * 3,
        y: ballHandler.pos.y + (state.rng() > 0.5 ? 3 : -3)
      };
      
      if (state.play.stageTimer > 2) {
        state.play.stage = 1;
        state.play.stageTimer = 0;
      }
      break;
      
    case 1: // Stage 2: Screen is set, ball handler decides to use it or reject it (1s)
      // Sometimes reject the screen (go opposite direction)
      const rejectScreen = state.rng() < 0.3;
      
      if (rejectScreen) {
        ballHandler.targetPos = {
          x: screener.pos.x - dir * 4, // Go opposite direction
          y: screener.pos.y + (state.rng() > 0.5 ? 6 : -6)
        };
      } else {
        ballHandler.targetPos = {
          x: screener.pos.x + dir * 3,
          y: screener.pos.y
        };
      }
      
      if (state.play.stageTimer > 1) {
        state.play.stage = 2;
        state.play.stageTimer = 0;
      }
      break;
      
    case 2: // Stage 3: Read & React (2s)
      const defenderOnBall = findDefender(ballHandler, state);
      const defenderOnScreener = findDefender(screener, state);
      
      // Screener rolls to basket
      screener.rollingToBasket = true;
      screener.targetPos = {
        x: basket.x - dir * 8,
        y: basket.y + (state.rng() - 0.5) * 6
      };
      
      // Decision tree based on defense
      if (defenderOnScreener && dist(defenderOnScreener.pos, screener.pos) > 8) {
        // Pass to rolling screener
        if (state.rng() < 0.4 && state.play.stageTimer > 0.5) {
          passBall(state, ballHandler, screener);
          return;
        }
      }
      
      if (dist(ballHandler.pos, basket) < 18 && state.rng() < 0.3 && state.play.stageTimer > 1) {
        // Pull-up jumper
        attemptShot(state, ballHandler, basket);
        return;
      }
      
      if (state.play.stageTimer > 2) {
        // End play - either shoot or reset
        if (state.rng() < 0.5) {
          attemptShot(state, ballHandler, basket);
        } else {
          state.play.type = 'none';
        }
      }
      break;
  }
}

function executeMotionOffenseStages(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
  if (state.play.type !== 'motion') return;

  state.play.stageTimer += 0.1;
  
  // Continuous ball movement - pass every 2-3 seconds
  const ballHandler = getBallHandler(state);
  if (ballHandler && state.play.stageTimer > 2.5 && state.play.passCount < 4) {
    const openPlayers = offTeam.filter(p => {
      if (p === ballHandler) return false;
      const defender = findDefender(p, state);
      return !defender || dist(defender.pos, p.pos) > 5;
    });
    
    if (openPlayers.length > 0 && state.rng() < 0.7) {
      const target = openPlayers[Math.floor(state.rng() * openPlayers.length)];
      passBall(state, ballHandler, target);
      state.play.passCount++;
      state.play.lastPassTime = state.gameTime;
      state.play.stageTimer = 0; // Reset timer after pass
      return;
    }
  }
  
  // After 3-4 passes, look for the shot
  if (state.play.passCount >= 3 || state.play.stageTimer > 8) {
    if (ballHandler) {
      const distToBasket = dist(ballHandler.pos, basket);
      const defender = findDefender(ballHandler, state);
      const isOpen = !defender || dist(defender.pos, ballHandler.pos) > 6;
      
      if (isOpen && distToBasket < 25 && state.rng() < 0.6) {
        attemptShot(state, ballHandler, basket);
        return;
      }
    }
  }
  
  // Enhanced off-ball movement with specific cutting patterns
  for (let i = 0; i < offTeam.length; i++) {
    const p = offTeam[i];
    if (p.hasBall) continue;
    
    // Create varied cutting patterns based on position and timing
    const t = (state.play.stageTimer + i * 0.7) % 6; // 6-second cycles for more variety
    p.movement.isCutting = true;
    
    // Different cut patterns based on player position
    const cutPattern = (i + Math.floor(state.play.stageTimer / 2)) % 4;
    
    switch (cutPattern) {
      case 0: // Baseline cut
        if (t < 1.5) {
          p.targetPos = {
            x: basket.x - dir * 12,
            y: BASKET_Y + (p.pos.y > BASKET_Y ? 20 : -20)
          };
        } else if (t < 3) {
          p.targetPos = {
            x: basket.x - dir * 6,
            y: BASKET_Y + (p.pos.y > BASKET_Y ? 8 : -8)
          };
        } else {
          // Pop out to corner
          p.targetPos = {
            x: basket.x - dir * 22,
            y: BASKET_Y + (p.pos.y > BASKET_Y ? 18 : -18)
          };
        }
        break;
        
      case 1: // UCLA cut (high to low)
        if (t < 2) {
          p.targetPos = {
            x: basket.x - dir * 4,
            y: BASKET_Y
          };
        } else {
          p.targetPos = {
            x: basket.x - dir * 25,
            y: BASKET_Y + (i % 2 === 0 ? -12 : 12)
          };
        }
        break;
        
      case 2: // Flare screen/cut
        if (t < 1) {
          // Set flare screen
          p.movement.isScreening = true;
          p.targetPos = {
            x: basket.x - dir * 18,
            y: BASKET_Y + (i - 2) * 8
          };
        } else if (t < 3) {
          // Flare out for three
          p.targetPos = {
            x: basket.x - dir * 26,
            y: BASKET_Y + (i % 2 === 0 ? -15 : 15)
          };
        } else {
          // Relocate
          p.targetPos = {
            x: basket.x - dir * (16 + (i * 2)),
            y: BASKET_Y + Math.sin(t + i) * 10
          };
        }
        break;
        
      default: // V-cut (out then in)
        if (t < 1.5) {
          // V out
          p.targetPos = {
            x: basket.x - dir * 24,
            y: BASKET_Y + (i - 2) * 10
          };
        } else if (t < 3) {
          // V in
          p.targetPos = {
            x: basket.x - dir * 12,
            y: BASKET_Y + (i - 2) * 6
          };
        } else {
          // Reset position
          p.targetPos = {
            x: basket.x - dir * 20,
            y: BASKET_Y + (i - 2) * 8
          };
        }
        break;
    }
  }
}

function executeIsoPlayStages(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
  if (state.play.type !== 'iso') return;

  const ballHandler = getBallHandler(state);
  if (!ballHandler) return;

  state.play.stageTimer += 0.1;
  
  switch (state.play.stage) {
    case 0: // Stage 1: Clear out (2s)
      for (const p of offTeam) {
        if (p === ballHandler) continue;
        p.targetPos = {
          x: basket.x - dir * (25 + (p.courtIdx - 2) * 5),
          y: BASKET_Y + (p.courtIdx - 2) * 12
        };
      }
      
      if (state.play.stageTimer > 2) {
        state.play.stage = 1;
        state.play.stageTimer = 0;
      }
      break;
      
    case 1: // Stage 2: 1v1 work (3-5s)
      const defender = findDefender(ballHandler, state);
      const distToBasket = dist(ballHandler.pos, basket);
      
      if (distToBasket < 15) {
        // Drive to basket
        ballHandler.targetPos = {
          x: basket.x - dir * 4,
          y: basket.y + (state.rng() - 0.5) * 6
        };
      } else {
        // Jab step, crossover moves
        executeBallHandlerMoves(state, ballHandler, defender);
      }
      
      if (state.play.stageTimer > 5 || distToBasket < 8) {
        state.play.stage = 2;
        state.play.stageTimer = 0;
      }
      break;
      
    case 2: // Stage 3: Shoot or kick out
      if (state.rng() < 0.8) {
        attemptShot(state, ballHandler, basket);
      } else {
        // Look for kick out if double-teamed
        const nearbyDefenders = state.players.filter(p => 
          p.teamIdx !== state.possession && dist(p.pos, ballHandler.pos) < 8
        );
        
        if (nearbyDefenders.length > 1) {
          const openTeammates = offTeam.filter(p => {
            if (p === ballHandler) return false;
            const def = findDefender(p, state);
            return !def || dist(def.pos, p.pos) > 8;
          });
          
          if (openTeammates.length > 0) {
            const target = openTeammates[0];
            passBall(state, ballHandler, target);
            return;
          }
        }
        attemptShot(state, ballHandler, basket);
      }
      break;
  }
}

function executeFastBreakStages(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
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
    offTeam[1].targetPos = { x: basket.x - dir * 18, y: basket.y - 15 };
    offTeam[2].targetPos = { x: basket.x - dir * 18, y: basket.y + 15 };
  }

  // Check for numbers advantage
  const defenseBack = state.players.filter(p => 
    p.teamIdx !== state.possession && 
    Math.abs(p.pos.x - basket.x) < 20
  ).length;
  
  const offenseAhead = offTeam.filter(p => 
    Math.abs(p.pos.x - basket.x) < 25
  ).length;
  
  if (offenseAhead > defenseBack && dist(ballHandler.pos, basket) < 20) {
    // Attack immediately on numbers advantage
    attemptShot(state, ballHandler, basket);
  }
}

function executeInsidePlayStages(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number) {
  if (state.play.type !== 'inside') return;

  const bigMan = offTeam[4] || offTeam[3]; // C or PF
  if (!bigMan) return;

  state.play.stageTimer += 0.1;
  
  // Post up
  bigMan.targetPos = {
    x: basket.x - dir * 8,
    y: basket.y + (state.rng() - 0.5) * 6
  };

  // Entry pass
  const ballHandler = getBallHandler(state);
  if (ballHandler && ballHandler !== bigMan && 
      dist(ballHandler.pos, bigMan.pos) < 20 && 
      state.play.stageTimer > 1 && state.rng() < 0.15) {
    passBall(state, ballHandler, bigMan);
    state.play.lastPassTime = state.gameTime;
    return;
  }

  // If big man has the ball in the post
  if (bigMan.hasBall && dist(bigMan.pos, basket) < 12) {
    if (state.play.stageTimer > 2) {
      // Back down defender and shoot
      attemptShot(state, bigMan, basket);
    }
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

function setupEnhancedPlay(state: GameState, offTeam: SimPlayer[], basket: Vec2, dir: number): void {
  const tacticO = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  const ballHandler = getBallHandler(state);
  
  // Track failed possessions (simplified - in full implementation you'd track this more thoroughly)
  const failedPossessions = Math.floor(state.gameTime / 24) % 3; // Rough approximation
  
  // Reset play state
  state.play = {
    type: 'none',
    progress: 0,
    stage: 0,
    stageTimer: 0,
    passCount: 0,
    lastPassTime: 0,
    ballHandler: ballHandler || undefined
  };
  
  // Superstars demand the ball more - try to get ball to superstar
  const superstar = offTeam.find(p => p.player.isSuperstar);
  if (superstar && superstar !== ballHandler && state.rng() < 0.3) {
    // Try to get ball to superstar through a play
    if (dist(ballHandler?.pos || { x: 0, y: 0 }, superstar.pos) < 20) {
      state.play.type = 'iso';
      state.play.ballHandler = superstar || undefined;
      return;
    }
  }
  
  // After 2-3 failed possessions, increase play complexity
  let complexityBoost = failedPossessions >= 2 ? 0.3 : 0;
  
  // Determine play type based on tactic and situation
  switch (tacticO) {
    case 'fast_break':
      if (state.phase === 'advance' || (state.phaseTicks < 10 && state.shotClock > 20)) {
        state.play.type = 'fastbreak';
      } else {
        state.play.type = failedPossessions >= 2 ? 'pickandroll' : 'motion'; // More complex after failures
      }
      break;
    case 'motion':
      state.play.type = 'motion';
      break;
    case 'iso':
      if (ballHandler?.player.isSuperstar || superstar) {
        state.play.type = 'iso';
        state.play.ballHandler = superstar || ballHandler || undefined;
      } else {
        state.play.type = 'motion';
      }
      break;
    case 'inside':
      state.play.type = 'inside';
      break;
    case 'shoot':
      // Quick motion offense
      state.play.type = failedPossessions >= 2 ? 'pickandroll' : 'motion';
      break;
  }

  // Pick and roll is more common with complexity boost
  if (state.play.type === 'motion' && state.rng() < (0.4 + complexityBoost)) {
    state.play.type = 'pickandroll';
    state.play.screener = offTeam.find(p => p.player.position === 'C' || p.player.position === 'PF');
  }
  
  // Occasionally run multiple screens or motion sets with complexity
  if (complexityBoost > 0 && state.rng() < complexityBoost) {
    // More advanced plays after failures - just increase the stage complexity for existing plays
    state.play.stage = 1; // Start at advanced stage
  }
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

function getIntelligentPassTargets(state: GameState, handler: SimPlayer, offTeam: SimPlayer[]): SimPlayer[] {
  const basket = getTeamBasket(state.possession);
  
  const candidates = offTeam.filter(p => {
    if (p === handler) return false;
    
    // Don't pass back to the player who just passed to you (anti-ping-pong)
    if (state.lastPassFrom === p && state.gameTime - state.lastPassTime < 3) return false;
    
    // Check if pass lane is blocked
    if (isPassLaneBlocked(handler, p, state)) return false;
    
    return true;
  });
  
  // Score each candidate based on multiple factors
  const scoredCandidates = candidates.map(p => {
    let score = 0;
    
    // Openness factor (distance from nearest defender)
    const defender = findDefender(p, state);
    const openness = defender ? dist(defender.pos, p.pos) : 10;
    score += openness * 2; // More weight for open players
    
    // Position factor (closer to basket is better for scoring threats)
    const distToBasket = dist(p.pos, basket);
    score += Math.max(0, (30 - distToBasket)) * 1.5;
    
    // Avoid recent pass targets (spread the ball around)
    const recentTarget = state.recentPassTargets.find(rt => rt.player === p);
    if (recentTarget && state.gameTime - recentTarget.time < 2) {
      score *= 0.3; // Heavy penalty for recent targets
    }
    
    // Skill factor (better shooters get ball more in perimeter)
    if (distToBasket > 15) {
      const shootingSkill = (p.player.skills.shooting.three_point + p.player.skills.shooting.mid_range) / 2;
      score += skillModifier(shootingSkill) * 3;
    } else {
      // Inside the arc, finishing ability matters more
      const finishingSkill = p.player.skills.finishing.layup;
      score += skillModifier(finishingSkill) * 2;
    }
    
    // Superstar factor
    if (p.player.isSuperstar) {
      score += 5;
    }
    
    return { player: p, score };
  });
  
  // Sort by score and return top candidates
  return scoredCandidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3) // Top 3 options
    .map(c => c.player);
}

function tick(state: GameState): GameState {
  const dt = 0.1; // game seconds per tick
  state.phaseTicks++;
  state.gameTime += dt;

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
            const shotDistance = (state.ball as any).shotDistance || dist(state.ball.flightFrom, basket);
            const pts = shotDistance > 22 ? 3 : 2;
            const shooterPossession = (state.ball as any).shooterPossession || state.possession;
            const shooterName = (state.ball as any).shooterName || 'Player';
            
            // Score BEFORE changing possession to fix scoring bug
            state.score[shooterPossession] += pts;
            const scoringEvent = `${shooterName} scores ${pts}!`;
            state.lastEvent = scoringEvent;
            
            // Change possession but don't overwrite the scoring event
            changePossessionAfterScore(state, scoringEvent);
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
    for (const p of state.players) {
      movePlayerToward(p, dt, state.gameTime, state.players);
    }
    return state;
  }

  // Enhanced Phase logic
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
      // Enhanced inbound with actual passing
      const ownBasket = getOwnBasket(state.possession);
      
      if (state.phaseTicks < 10) {
        // Stage 1: Players transition to their positions
        const inbounder = offTeam[0];
        inbounder.targetPos = { 
          x: ownBasket.x + (dir > 0 ? -5 : 5), 
          y: BASKET_Y + (state.rng() - 0.5) * 15
        };
        
        clearBallCarrier(state);
        inbounder.hasBall = true;
        state.ball.carrier = inbounder;
        
        for (let i = 1; i < offTeam.length; i++) {
          offTeam[i].targetPos = { 
            x: ownBasket.x + dir * (8 + i * 3), 
            y: BASKET_Y + (i - 2.5) * 7 
          };
        }
        
        // Defense applies pressure
        const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
        if (tacticD === 'press') {
          for (let i = 0; i < defTeam.length; i++) {
            const target = offTeam[Math.min(i, offTeam.length - 1)];
            defTeam[i].targetPos = {
              x: target.targetPos.x + (ownBasket.x - target.targetPos.x) * 0.4,
              y: target.targetPos.y
            };
          }
        }
      } else if (state.phaseTicks < 25) {
        // Stage 2: Receiver cuts toward ball
        const receiver = offTeam[1]; // Usually PG or best ball handler
        receiver.movement.isCutting = true;
        receiver.targetPos = {
          x: state.ball.pos.x + dir * 8,
          y: state.ball.pos.y + (state.rng() - 0.5) * 6
        };
      } else {
        // Stage 3: Actual inbound pass
        const inbounder = getBallHandler(state);
        if (inbounder) {
          const receiver = offTeam.find(p => p !== inbounder && dist(p.pos, inbounder.pos) < 15);
          
          if (receiver && state.rng() < 0.8) {
            passBall(state, inbounder, receiver);
            state.lastEvent = 'Inbound pass complete';
            state.phase = 'advance';
            state.phaseTicks = 0;
          }
        }
      }
      
      if (state.phaseTicks > 40) {
        // Force advance if inbound takes too long
        state.phase = 'advance';
        state.phaseTicks = 0;
      }
      break;
    }
    case 'advance': {
      const handler = getBallHandler(state);
      if (handler) {
        // Track 8-second violation
        state.advanceClockSeconds += dt;
        
        // Check if ball handler has crossed half court
        const crossedHalfCourt = (state.possession === 0 && handler.pos.x > HALF_X) || 
                                 (state.possession === 1 && handler.pos.x < HALF_X);
        
        if (crossedHalfCourt) {
          state.crossedHalfCourt = true;
        }
        
        // 8-second violation check
        if (!state.crossedHalfCourt && state.advanceClockSeconds > 8) {
          state.lastEvent = '8-second violation!';
          changePossession(state, '8-second violation!');
          return state;
        }
        
        // Backcourt violation check - after crossing half court, can't go back
        if (state.crossedHalfCourt) {
          const backCourt = (state.possession === 0 && handler.pos.x < HALF_X) || 
                           (state.possession === 1 && handler.pos.x > HALF_X);
          
          if (backCourt) {
            state.lastEvent = 'Backcourt violation!';
            changePossession(state, 'Backcourt violation!');
            return state;
          }
        }
        
        // PG dribbles up court with enhanced movement
        const targetX = state.play.type === 'fastbreak' ? 
          basket.x - dir * 20 : 
          HALF_X + dir * 12;
          
        handler.targetPos = { x: targetX, y: BASKET_Y };
        
        // Execute ball handler moves while advancing
        const defender = findDefender(handler, state);
        executeBallHandlerMoves(state, handler, defender);
        
        // Other players spread to offensive half
        for (let i = 0; i < offTeam.length; i++) {
          if (offTeam[i] === handler) continue;
          offTeam[i].targetPos = {
            x: HALF_X + dir * (8 + i * 4),
            y: BASKET_Y + (i - 2) * 8
          };
        }
        
        // Defense matches up during transition
        updateEnhancedDefense(state, defTeam, offTeam, basket, 
          state.possession === 0 ? state.awayTacticD : state.homeTacticD);
        
        if (Math.abs(handler.pos.x - HALF_X) > 8) {
          state.phase = 'setup';
          state.phaseTicks = 0;
        }
      }
      break;
    }
    case 'setup': {
      // Enhanced setup with intelligent positioning
      const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
      const spots = getOffenseSpots(basket.x, dir);
      
      // Set offensive positions with variation
      for (let i = 0; i < offTeam.length; i++) {
        offTeam[i].targetPos = {
          x: spots[i].x + (state.rng() - 0.5) * 4,
          y: spots[i].y + (state.rng() - 0.5) * 4
        };
      }
      
      // Set defensive positions
      updateEnhancedDefense(state, defTeam, offTeam, basket, tacticD);
      
      // Ball handler holds at top, surveys defense
      const handler = getBallHandler(state);
      if (handler) {
        handler.targetPos = {
          x: basket.x - dir * 28,
          y: BASKET_Y + (state.rng() - 0.5) * 4
        };
      }
      
      if (state.phaseTicks > 20) {
        setupEnhancedPlay(state, offTeam, basket, dir);
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

      // Execute specific play stages
      switch (state.play.type) {
        case 'pickandroll':
          executePickAndRollStages(state, offTeam, basket, dir);
          break;
        case 'motion':
          executeMotionOffenseStages(state, offTeam, basket, dir);
          break;
        case 'iso':
          executeIsoPlayStages(state, offTeam, basket, dir);
          break;
        case 'fastbreak':
          executeFastBreakStages(state, offTeam, basket, dir);
          break;
        case 'inside':
          executeInsidePlayStages(state, offTeam, basket, dir);
          break;
      }

      // Enhanced ball handler AI
      const defender = findDefender(handler, state);
      executeBallHandlerMoves(state, handler, defender);
      
      // Enhanced decision logic with shot selection intelligence and shot clock management
      const distToBasket = dist(handler.pos, basket);
      const isOpen = !defender || dist(defender.pos, handler.pos) > 6;
      const timeUrgency = state.phaseTicks > 150 || state.shotClock < 8;
      
      // Shot clock management
      if (state.shotClock < 2) {
        // Desperation time - shoot from anywhere
        attemptShot(state, handler, basket);
      } else if (state.shotClock < 6) {
        // Try to drive closer first, then desperation heave
        if (distToBasket > 15) {
          driveToBasket(state, handler, basket, dir);
        } else {
          attemptShot(state, handler, basket);
        }
      } else if (state.shotClock < 12) {
        // Quick play execution - get to best scorer
        const bestScorer = offTeam.reduce((best, p) => {
          if (p === handler) return best;
          const shootingSkill = (p.player.skills.shooting.three_point + 
                                p.player.skills.shooting.mid_range + 
                                p.player.skills.finishing.layup) / 3;
          const bestSkill = (best.player.skills.shooting.three_point + 
                            best.player.skills.shooting.mid_range + 
                            best.player.skills.finishing.layup) / 3;
          return shootingSkill > bestSkill ? p : best;
        }, handler);
        
        if (bestScorer !== handler && dist(handler.pos, bestScorer.pos) < 20) {
          const def = findDefender(bestScorer, state);
          const passLane = !isPassLaneBlocked(handler, bestScorer, state);
          if (passLane && (!def || dist(def.pos, bestScorer.pos) > 4)) {
            passBall(state, handler, bestScorer);
            return state;
          }
        }
        
        // Otherwise take the shot if decent opportunity
        if (isOpen && distToBasket < 25) {
          attemptShot(state, handler, basket);
        } else if (distToBasket < 15) {
          attemptShot(state, handler, basket);
        }
      } else if (timeUrgency) {
        // Regular time pressure
        if (isOpen && distToBasket < 25) {
          attemptShot(state, handler, basket);
        } else if (distToBasket < 12) {
          attemptShot(state, handler, basket); // Take contested shot near basket
        } else {
          // Look for emergency pass
          const openTeammates = getIntelligentPassTargets(state, handler, offTeam);
          if (openTeammates.length > 0) {
            passBall(state, handler, openTeammates[0]);
          } else {
            attemptShot(state, handler, basket);
          }
        }
      } else {
        // Normal action decision tree - much more active
        const roll = state.rng();
        
        // Enhanced shot selection based on openness and shooter quality
        const openness = !defender ? 12 : dist(defender.pos, handler.pos);
        let shotChance = 0;
        
        // Calculate shooter quality for this distance
        let shooterQuality = 0.5; // Default
        if (distToBasket > 22) {
          shooterQuality = skillModifier(handler.player.skills.shooting.three_point);
        } else if (distToBasket > 10) {
          shooterQuality = skillModifier(handler.player.skills.shooting.mid_range);
        } else {
          shooterQuality = skillModifier(handler.player.skills.finishing.layup);
        }
        
        // Shot selection based on openness and shooter ability
        if (openness > 8 && distToBasket < 28) {
          // Wide open - take the shot if decent shooter
          shotChance = shooterQuality > 0.4 ? 0.6 : 0.3;
        } else if (openness > 4 && distToBasket < 24) {
          // Open - take if good shooter or near basket
          shotChance = shooterQuality > 0.6 ? 0.4 : (distToBasket < 12 ? 0.3 : 0.1);
        } else if (openness > 2 && distToBasket < 18) {
          // Lightly contested - only take if superstar or shot clock pressure
          shotChance = handler.player.isSuperstar ? 0.25 : (state.shotClock < 8 ? 0.15 : 0.05);
        } else if (openness <= 2 && distToBasket < 25) {
          // Heavily contested - pass unless desperate
          shotChance = state.shotClock < 3 ? 0.3 : (handler.player.isSuperstar && distToBasket < 12 ? 0.1 : 0.02);
        }
        
        // Hot hand factor - consecutive makes increase aggression (simplified)
        // In a full implementation, you'd track recent shot history
        if (handler.player.isSuperstar) {
          shotChance *= 1.2; // Superstars are more aggressive
        }
        
        if (roll < shotChance) {
          attemptShot(state, handler, basket);
        }
        // Kick-out pass detection - look for players open due to help defense
        else if (distToBasket < 15) {
          // Handler is driving - check for help defenders and open teammates
          const helpDefenders = state.players.filter(p => 
            p.teamIdx !== state.possession && 
            dist(p.pos, handler.pos) < 8 &&
            p !== defender
          );
          
          if (helpDefenders.length > 0) {
            // Help is coming - look for kick-out opportunity
            const openTeammates = offTeam.filter(p => {
              if (p === handler) return false;
              const def = findDefender(p, state);
              const isOpen = !def || dist(def.pos, p.pos) > 8; // More open due to help
              const hasPassLane = !isPassLaneBlocked(handler, p, state);
              return isOpen && hasPassLane && dist(handler.pos, p.pos) < 25;
            });
            
            if (openTeammates.length > 0 && state.rng() < 0.6) {
              // Prioritize shooters for kick-out passes
              const bestKickOut = openTeammates.reduce((best, p) => {
                const pSkill = (p.player.skills.shooting.three_point + p.player.skills.shooting.mid_range) / 2;
                const bestSkill = (best.player.skills.shooting.three_point + best.player.skills.shooting.mid_range) / 2;
                return pSkill > bestSkill ? p : best;
              });
              
              passBall(state, handler, bestKickOut);
              return state;
            }
          }
        }
        // Enhanced pass opportunity with anti-ping-pong logic
        else if (roll < 0.7 && state.play.passCount < 5) {
          const passTargets = getIntelligentPassTargets(state, handler, offTeam);
          
          if (passTargets.length > 0) {
            passBall(state, handler, passTargets[0]);
          }
        }
        // Drive to basket
        else if (roll < 0.85 && distToBasket > 12) {
          driveToBasket(state, handler, basket, dir);
        }
        // Hold ball and look for better opportunity
        else {
          // Continue play execution
        }
      }

      // Enhanced steal mechanics
      if (defender && dist(defender.pos, handler.pos) < 3) {
        let stealChance = skillModifier(defender.player.skills.defense.steal) * 0.02; // Increased base chance
        
        const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
        if (tacticD === 'gamble') stealChance *= 2;
        if (tacticD === 'press') stealChance *= 1.5;
        
        if (state.rng() < stealChance) {
          clearBallCarrier(state);
          defender.hasBall = true;
          state.ball.carrier = defender;
          state.lastEvent = `${defender.player.name} steals the ball!`;
          changePossession(state, '');
        }
      }

      // Update enhanced defense
      updateEnhancedDefense(state, defTeam, offTeam, basket, 
        state.possession === 0 ? state.awayTacticD : state.homeTacticD);
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
      // Enhanced rebounding with body physics
      const reboundPos = { ...state.ball.pos };
      
      for (const p of state.players) {
        const distToRebound = dist(p.pos, reboundPos);
        // Players converge with collision avoidance
        p.targetPos = { 
          x: reboundPos.x + (state.rng() - 0.5) * 6, 
          y: reboundPos.y + (state.rng() - 0.5) * 6
        };
        
        // Box out mechanics - defenders try to get between offensive players and basket
        if (p.teamIdx !== state.possession) {
          const nearestOff = offTeam.reduce((closest, off) => 
            dist(p.pos, off.pos) < dist(p.pos, closest.pos) ? off : closest
          );
          
          if (dist(p.pos, nearestOff.pos) < 4) {
            // Box out - get between offensive player and rebound
            p.targetPos = {
              x: nearestOff.pos.x + (reboundPos.x - nearestOff.pos.x) * 0.5,
              y: nearestOff.pos.y + (reboundPos.y - nearestOff.pos.y) * 0.5
            };
          }
        }
      }
      
      if (state.phaseTicks > 12) {
        // Determine rebounder with enhanced logic
        const nearPlayers = [...state.players]
          .sort((a, b) => dist(a.pos, reboundPos) - dist(b.pos, reboundPos))
          .slice(0, 6); // Top 6 closest players compete
          
        let rebounder: SimPlayer | null = null;
        let bestReboundValue = 0;
        
        for (const p of nearPlayers) {
          const rebSkill = p.player.skills.athletic.rebounding;
          const height = p.player.physical.height;
          const position = dist(p.pos, reboundPos);
          const boxOutAdvantage = p.teamIdx !== state.possession ? 1.2 : 1.0; // Slight defensive rebounding advantage
          
          const reboundValue = skillModifier(rebSkill) * 
            (height / 200) * 
            (10 - position) * // Closer is better
            boxOutAdvantage *
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
          // Offensive rebound - reset shot clock to 14 (NBA rule)
          state.shotClock = 14;
          state.phase = 'setup';
          state.phaseTicks = 0;
        }
      }
      break;
    }
  }

  // Move all players with enhanced movement
  for (const p of state.players) {
    movePlayerToward(p, dt, state.gameTime, state.players);
    
    // Reset per-frame movement flags
    p.movement.isDefensiveSliding = false;
    p.movement.isCutting = false;
    p.movement.isScreening = false;
    
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

function isPassLaneBlocked(from: SimPlayer, to: SimPlayer, state: GameState): boolean {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const passLine = { from: from.pos, to: to.pos };
  
  for (const def of defTeam) {
    const distToLine = distanceToLine(def.pos, passLine);
    if (distToLine < 2.5) {
      return true;
    }
  }
  return false;
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
  // Store shooter name BEFORE clearing ball carrier to fix scoring bug
  const shooterName = handler.player.name;
  const shooterPossession = state.possession;
  
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
  
  // Enhanced shot contest system
  const nearestDef = state.players
    .filter(p => p.teamIdx !== state.possession)
    .reduce((best, d) => dist(d.pos, handler.pos) < dist(best.pos, handler.pos) ? d : best);
    
  const contestDistance = dist(nearestDef.pos, handler.pos);
  let contestModifier = 1.0;
  
  if (contestDistance < 3) {
    contestModifier = 0.6; // Heavy contest
  } else if (contestDistance < 5) {
    contestModifier = 0.8; // Light contest
  } else if (contestDistance < 6) {
    contestModifier = 0.9; // Minor contest
  }
  
  // Shot selection intelligence - better shooters take harder shots
  if (handler.player.isSuperstar) {
    contestModifier = Math.max(contestModifier, 0.8); // Superstars less affected by contest
  }
  
  // Time pressure affects accuracy
  if (state.shotClock < 3) {
    contestModifier *= 0.85;
  }
  
  const finalPct = basePct * skillModifier(shotSkill) * contestModifier * (1 + advantage);
  const willScore = state.rng() < finalPct;

  state.ball.inFlight = true;
  state.ball.flightFrom = { ...handler.pos };
  state.ball.flightTo = { ...basket };
  state.ball.flightProgress = 0;
  state.ball.flightDuration = 0.6 + distToBasket * 0.02;
  state.ball.isShot = true;
  state.ball.shotWillScore = willScore;
  
  // Store shot info in ball state to access later when shot lands
  (state.ball as any).shooterName = shooterName;
  (state.ball as any).shooterPossession = shooterPossession;
  (state.ball as any).shotDistance = distToBasket;
  
  clearBallCarrier(state);
  state.phase = 'shooting';
  state.play = { type: 'none', progress: 0, stage: 0, stageTimer: 0, passCount: 0, lastPassTime: 0 };
  
  const contestStr = contestDistance < 3 ? ' (contested)' : contestDistance < 6 ? ' (lightly contested)' : '';
  state.lastEvent = `${shooterName} shoots${contestStr} from ${distToBasket.toFixed(0)}ft`;
}

function passBall(state: GameState, from: SimPlayer, to: SimPlayer) {
  // Enhanced pass interception system
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  
  for (const def of defTeam) {
    const distToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    const reactionDistance = dist(def.pos, from.pos);
    
    if (distToLine < 2.5 && reactionDistance < 12) {
      let stealChance = skillModifier(def.player.skills.defense.steal) * 0.08;
      
      // Increase chance if defender is between passer and receiver
      if (distToLine < 1.5) stealChance *= 2;
      
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

  // Execute pass
  state.ball.inFlight = true;
  state.ball.flightFrom = { ...from.pos };
  state.ball.flightTo = { ...to.pos };
  state.ball.flightProgress = 0;
  const d = dist(from.pos, to.pos);
  state.ball.flightDuration = 0.15 + d * 0.012; // Faster passes
  state.ball.isShot = false;
  state.ball.shotWillScore = false;
  clearBallCarrier(state);
  
  // Track pass information to prevent ping-pong passing
  state.lastPassFrom = from;
  state.lastPassTime = state.gameTime;
  
  // Update recent pass targets list (keep last 3 seconds of passes)
  state.recentPassTargets = state.recentPassTargets.filter(p => state.gameTime - p.time < 3);
  state.recentPassTargets.push({ player: to, time: state.gameTime });
  
  state.lastEvent = `${from.player.name} passes to ${to.player.name}`;
  
  // Update play state
  state.play.lastPassTime = state.gameTime;
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
  // Enhanced drive with collision detection
  const defender = findDefender(handler, state);
  
  if (defender && dist(defender.pos, handler.pos) < 4) {
    // Can't drive directly through defender - try to go around
    const driveAngle = Math.atan2(basket.y - handler.pos.y, basket.x - handler.pos.x);
    const defAngle = Math.atan2(defender.pos.y - handler.pos.y, defender.pos.x - handler.pos.x);
    
    // Choose side to drive around defender
    const angleDiff = driveAngle - defAngle;
    const goLeft = Math.sin(angleDiff) > 0;
    
    handler.targetPos = {
      x: basket.x + (goLeft ? -4 : 4),
      y: basket.y + (goLeft ? -6 : 6),
    };
  } else {
    // Clear path to basket
    handler.targetPos = {
      x: basket.x + (handler.pos.x > basket.x ? 3 : -3),
      y: basket.y + (state.rng() - 0.5) * 8,
    };
  }
}

function changePossession(state: GameState, event: string) {
  state.possession = (1 - state.possession) as 0 | 1;
  state.phase = 'inbound';
  state.phaseTicks = 0;
  state.shotClock = 24;
  state.play = { type: 'none', progress: 0, stage: 0, stageTimer: 0, passCount: 0, lastPassTime: 0 };
  
  // Reset violation tracking
  state.crossedHalfCourt = false;
  state.advanceClockSeconds = 0;
  state.lastPassFrom = null;
  state.lastPassTime = 0;
  state.recentPassTargets = [];
  
  if (event) state.lastEvent = event;
  resetPositions(state);
}

function changePossessionAfterScore(state: GameState, scoringEvent: string) {
  state.possession = (1 - state.possession) as 0 | 1;
  state.phase = 'inbound';
  state.phaseTicks = 0;
  state.shotClock = 24;
  state.play = { type: 'none', progress: 0, stage: 0, stageTimer: 0, passCount: 0, lastPassTime: 0 };
  
  // Reset violation tracking
  state.crossedHalfCourt = false;
  state.advanceClockSeconds = 0;
  state.lastPassFrom = null;
  state.lastPassTime = 0;
  state.recentPassTargets = [];
  
  // DON'T overwrite the scoring event
  // state.lastEvent = scoringEvent; // Already set before this function call
  resetPositions(state);
}

function resetPositions(state: GameState) {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const dir = state.possession === 0 ? 1 : -1;
  const ownBasket = getOwnBasket(state.possession);

  clearBallCarrier(state);
  
  // Spread out for inbound - NEVER set .pos directly, only .targetPos for smooth transitions
  for (let i = 0; i < offTeam.length; i++) {
    offTeam[i].targetPos = { 
      x: ownBasket.x + dir * (5 + i * 2), 
      y: BASKET_Y + (i - 2) * 5 
    };
    offTeam[i].rollingToBasket = false;
    // Reset movement state
    offTeam[i].movement.isDefensiveSliding = false;
    offTeam[i].movement.isCutting = false;
    offTeam[i].movement.isScreening = false;
  }

  // Defense transitions - NEVER set .pos directly, only .targetPos for smooth transitions
  for (let i = 0; i < defTeam.length; i++) {
    defTeam[i].targetPos = { 
      x: ownBasket.x + dir * (12 + i * 2), 
      y: BASKET_Y + (i - 2) * 5 
    };
    // Reset movement state
    defTeam[i].movement.isDefensiveSliding = false;
    defTeam[i].movement.isCutting = false;
    defTeam[i].movement.isScreening = false;
  }

  state.ball.pos = { ...offTeam[0].pos };
  state.ball.inFlight = false;
}

// ── Drawing functions (keeping original style but enhanced) ──
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

    // Enhanced special effects
    if (sp.rollingToBasket) {
      // Rolling to basket indicator
      ctx.beginPath();
      ctx.arc(x, y, r + 8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    if (sp.movement.isDefensiveSliding) {
      // Defensive sliding indicator
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    
    if (sp.movement.isCutting) {
      // Cutting indicator
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Enhanced glow for ball carrier
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
    
    // Enhanced fatigue indicator
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

  if (state.ball.inFlight) {
    // Draw ball shadow
    ctx.beginPath();
    ctx.arc(bx, by + 3, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    // Enhanced elevated ball (arc effect)
    let elevation = 0;
    if (state.ball.jumpBall?.active) {
      elevation = state.ball.jumpBall.height;
    } else {
      const t = state.ball.flightProgress;
      elevation = Math.sin(t * Math.PI) * (state.ball.isShot ? 20 : 8);
    }
    
    ctx.beginPath();
    ctx.arc(bx, by - elevation, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#e69138';
    ctx.fill();
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    
    // Ball spin lines for shots
    if (state.ball.isShot) {
      const spinAngle = state.ball.flightProgress * Math.PI * 4;
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + Math.cos(spinAngle) * 4, by - elevation + Math.sin(spinAngle) * 2);
      ctx.lineTo(bx - Math.cos(spinAngle) * 4, by - elevation - Math.sin(spinAngle) * 2);
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
  // Enhanced scoreboard background
  ctx.fillStyle = 'rgba(13, 17, 23, 0.95)';
  ctx.fillRect(CANVAS_W / 2 - 220, 0, 440, 50);
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.strokeRect(CANVAS_W / 2 - 220, 0, 440, 50);

  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Home team
  ctx.fillStyle = '#f85149';
  ctx.fillText('Hawks', CANVAS_W / 2 - 150, 16);
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(String(state.score[0]), CANVAS_W / 2 - 80, 22);

  // Clock
  ctx.fillStyle = '#3fb950';
  ctx.font = 'bold 16px monospace';
  const min = Math.floor(state.clockSeconds / 60);
  const sec = Math.floor(state.clockSeconds % 60);
  ctx.fillText(`Q${state.quarter} ${min}:${sec.toString().padStart(2, '0')}`, CANVAS_W / 2, 16);
  
  // Enhanced shot clock display
  ctx.font = '10px monospace';
  ctx.fillStyle = state.shotClock < 5 ? '#f85149' : '#8b949e';
  ctx.fillText(`SC: ${Math.ceil(state.shotClock)}`, CANVAS_W / 2, 34);

  // Away team
  ctx.fillStyle = '#58a6ff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('Wolves', CANVAS_W / 2 + 150, 16);
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(String(state.score[1]), CANVAS_W / 2 + 80, 22);

  // Enhanced event text with background
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

  // Enhanced possession indicator
  const posX = state.possession === 0 ? CANVAS_W / 2 - 80 : CANVAS_W / 2 + 80;
  ctx.beginPath();
  ctx.arc(posX, 38, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#3fb950';
  ctx.fill();
  
  // Possession arrow
  ctx.fillStyle = state.possession === 0 ? '#f85149' : '#58a6ff';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('●', posX, 38);

  // Enhanced play indicator with stage info
  if (state.play.type !== 'none') {
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    const playText = `${state.play.type.toUpperCase()} - Stage ${state.play.stage + 1}`;
    ctx.fillText(playText, 10, CANVAS_H - 10);
    
    if (state.play.passCount > 0) {
      ctx.fillText(`Passes: ${state.play.passCount}`, 10, CANVAS_H - 25);
    }
  }
  
  // Phase indicator
  ctx.fillStyle = '#8b949e';
  ctx.font = '8px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`Phase: ${state.phase.toUpperCase()}`, CANVAS_W - 10, CANVAS_H - 10);
}

// ── React Component (unchanged structure) ──
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

      {/* Enhanced game info */}
      <div className="text-xs text-[var(--color-text-dim)] text-center max-w-4xl">
        <div className="mb-1">
          <span className="text-[var(--color-accent)]">Q{gs.quarter}</span>
          {' | '}
          <span style={{ color: gs.possession === 0 ? '#f85149' : '#58a6ff' }}>
            {gs.possession === 0 ? 'Hawks' : 'Wolves'} ball
          </span>
          {' | '}Phase: <span className="text-[var(--color-accent)]">{gs.phase}</span>
          {gs.play.type !== 'none' && 
            <span> | Play: <span className="text-yellow-400">{gs.play.type}</span> (Stage {gs.play.stage + 1})</span>
          }
        </div>
        <div>{gs.lastEvent}</div>
      </div>
    </div>
  );
}