import { useRef, useEffect, useState, useCallback } from 'react';
import { metroHawks, bayCityWolves } from '../store/teamsSlice';
import { Player, Team, OffenseTactic, DefenseTactic } from '../engine/types';
import { skillModifier, createRng } from '../engine/utils';
import { getTacticAdvantage } from '../engine/tactics';

// ══════════════════════════════════════════════════════════════════════════
// 1. CONSTANTS & TYPES
// ══════════════════════════════════════════════════════════════════════════

// Court dimensions (NBA full court in feet, scaled to canvas)
const COURT_W = 94;
const COURT_H = 50;
const SCALE = 10;
const CANVAS_W = COURT_W * SCALE;
const CANVAS_H = COURT_H * SCALE;

// Court landmarks
const BASKET_X_LEFT = 5.25;
const BASKET_X_RIGHT = COURT_W - 5.25;
const BASKET_Y = COURT_H / 2;
const THREE_PT_RADIUS = 23.75;
const PAINT_W = 16;
const PAINT_H = 19;
const FT_CIRCLE_R = 6;
const CENTER_CIRCLE_R = 6;
const HALF_X = COURT_W / 2;

// Basketball types
interface Vec2 { x: number; y: number }

type SlotName = 
  | 'SLOT_LEFT_CORNER' 
  | 'SLOT_LEFT_WING' 
  | 'SLOT_LEFT_ELBOW' 
  | 'SLOT_TOP_KEY' 
  | 'SLOT_RIGHT_ELBOW' 
  | 'SLOT_RIGHT_WING' 
  | 'SLOT_RIGHT_CORNER' 
  | 'SLOT_LOW_POST_L' 
  | 'SLOT_LOW_POST_R';

type OffenseRole = 'ballHandler' | 'screener' | 'cutter' | 'spacer' | 'postUp';

type RoleAction = 
  | { type: 'moveTo', slot: SlotName }
  | { type: 'screen', target: OffenseRole }
  | { type: 'cut', from: SlotName, to: SlotName }
  | { type: 'drive', direction: 'left' | 'right' | 'baseline' }
  | { type: 'hold' }
  | { type: 'postUp' }
  | { type: 'pop', slot: SlotName }
  | { type: 'roll' }
  | { type: 'relocate' };

interface PlayStep {
  id: number;
  duration: number;
  actions: Map<OffenseRole, RoleAction>;
  trigger: 'time' | 'position' | 'pass';
  triggerCondition?: () => boolean;
}

interface Play {
  name: string;
  steps: PlayStep[];
}

interface ManDefenseState {
  assignments: Map<string, string>; // defenderPlayerId → offensivePlayerId
}

interface SimPlayer {
  player: Player;
  id: string;
  pos: Vec2;
  vel: Vec2;
  targetPos: Vec2;
  teamIdx: 0 | 1;
  hasBall: boolean;
  fatigue: number;
  courtIdx: number;
  currentSlot?: SlotName;
  currentRole?: OffenseRole;
  lastMoveTime: number;
  isDefensiveSliding: boolean;
  isCutting: boolean;
  isScreening: boolean;
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

interface GameState {
  players: SimPlayer[];
  ball: BallState;
  score: [number, number];
  quarter: number;
  clockSeconds: number;
  shotClock: number;
  possession: 0 | 1;
  phase: 'jumpball' | 'inbound' | 'advance' | 'setup' | 'action' | 'shooting' | 'rebound';
  phaseTicks: number;
  running: boolean;
  speed: number;
  homeTacticO: OffenseTactic;
  homeTacticD: DefenseTactic;
  awayTacticO: OffenseTactic;
  awayTacticD: DefenseTactic;
  rng: () => number;
  lastEvent: string;
  gameStarted: boolean;
  gameTime: number;
  
  // New basketball systems
  slots: Map<SlotName, string | null>;
  roles: Map<string, OffenseRole>;
  defAssignments: Map<string, string>;
  currentPlay: Play | null;
  currentStep: number;
  stepTimer: number;
  lastPassFrom: string | null;
  lastPassTime: number;
  crossedHalfCourt: boolean;
  advanceClock: number;
}

// ══════════════════════════════════════════════════════════════════════════
// 2. COURT SLOTS & FLOOR SPACING ENGINE
// ══════════════════════════════════════════════════════════════════════════

function getSlotPositions(basketPos: Vec2, dir: number): Map<SlotName, Vec2> {
  const slots = new Map<SlotName, Vec2>();
  
  slots.set('SLOT_LEFT_CORNER', { x: basketPos.x - dir * 22, y: basketPos.y - 22 });
  slots.set('SLOT_LEFT_WING', { x: basketPos.x - dir * 22, y: basketPos.y - 12 });
  slots.set('SLOT_LEFT_ELBOW', { x: basketPos.x - dir * 15, y: basketPos.y - 7 });
  slots.set('SLOT_TOP_KEY', { x: basketPos.x - dir * 26, y: basketPos.y });
  slots.set('SLOT_RIGHT_ELBOW', { x: basketPos.x - dir * 15, y: basketPos.y + 7 });
  slots.set('SLOT_RIGHT_WING', { x: basketPos.x - dir * 22, y: basketPos.y + 12 });
  slots.set('SLOT_RIGHT_CORNER', { x: basketPos.x - dir * 22, y: basketPos.y + 22 });
  slots.set('SLOT_LOW_POST_L', { x: basketPos.x - dir * 7, y: basketPos.y - 5 });
  slots.set('SLOT_LOW_POST_R', { x: basketPos.x - dir * 7, y: basketPos.y + 5 });
  
  return slots;
}

function enforceFloorSpacing(state: GameState): void {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  
  // Check for players within 10ft of each other (too close)
  for (let i = 0; i < offTeam.length; i++) {
    for (let j = i + 1; j < offTeam.length; j++) {
      const p1 = offTeam[i];
      const p2 = offTeam[j];
      const distance = dist(p1.pos, p2.pos);
      
      if (distance < 10 && p1.currentRole !== 'ballHandler' && p2.currentRole !== 'ballHandler') {
        // One player needs to relocate
        const playerToRelocate = p1.fatigue > p2.fatigue ? p1 : p2;
        findOpenSlot(playerToRelocate, state);
      }
    }
  }
}

function findOpenSlot(player: SimPlayer, state: GameState): void {
  const basketPos = getTeamBasket(state.possession);
  const dir = state.possession === 0 ? 1 : -1;
  const slots = getSlotPositions(basketPos, dir);
  
  // Find closest open slot
  let closestSlot: SlotName | null = null;
  let closestDistance = Infinity;
  
  for (const [slotName, slotPos] of slots.entries()) {
    if (!state.slots.get(slotName)) {  // Slot is open
      const distance = dist(player.pos, slotPos);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestSlot = slotName;
      }
    }
  }
  
  if (closestSlot) {
    // Clear player's old slot
    if (player.currentSlot) {
      state.slots.set(player.currentSlot, null);
    }
    
    // Assign new slot
    state.slots.set(closestSlot, player.id);
    player.currentSlot = closestSlot;
    player.targetPos = { ...slots.get(closestSlot)! };
  }
}

function fillEmptySlots(state: GameState): void {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const basketPos = getTeamBasket(state.possession);
  const dir = state.possession === 0 ? 1 : -1;
  const slots = getSlotPositions(basketPos, dir);
  
  // Find unoccupied slots
  for (const [slotName, slotPos] of slots.entries()) {
    if (!state.slots.get(slotName)) {
      // Find closest player without a slot (excluding ball handler)
      const ballHandler = getBallHandler(state);
      const availablePlayer = offTeam.find(p => 
        !p.currentSlot && 
        p !== ballHandler &&
        p.currentRole !== 'ballHandler'
      );
      
      if (availablePlayer) {
        state.slots.set(slotName, availablePlayer.id);
        availablePlayer.currentSlot = slotName;
        availablePlayer.targetPos = { ...slotPos };
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 3. PLAYBOOK SYSTEM  
// ══════════════════════════════════════════════════════════════════════════

function createPickAndRollRight(): Play {
  const step1: PlayStep = {
    id: 1,
    duration: 2,
    actions: new Map([
      ['ballHandler', { type: 'moveTo', slot: 'SLOT_TOP_KEY' }],
      ['screener', { type: 'screen', target: 'ballHandler' }],
      ['spacer', { type: 'relocate' }],
    ]),
    trigger: 'time'
  };
  
  const step2: PlayStep = {
    id: 2,
    duration: 2,
    actions: new Map([
      ['ballHandler', { type: 'drive', direction: 'right' }],
      ['screener', { type: 'roll' }],
      ['spacer', { type: 'relocate' }],
    ]),
    trigger: 'time'
  };
  
  const step3: PlayStep = {
    id: 3,
    duration: 3,
    actions: new Map([
      ['ballHandler', { type: 'hold' }], // Read & react
      ['screener', { type: 'roll' }],
      ['spacer', { type: 'hold' }],
    ]),
    trigger: 'time'
  };
  
  return {
    name: 'Pick and Roll (Right)',
    steps: [step1, step2, step3]
  };
}

function createMotionOffense(): Play {
  const step1: PlayStep = {
    id: 1,
    duration: 2,
    actions: new Map([
      ['ballHandler', { type: 'moveTo', slot: 'SLOT_TOP_KEY' }],
      ['spacer', { type: 'relocate' }],
      ['cutter', { type: 'relocate' }],
    ]),
    trigger: 'time'
  };
  
  const step2: PlayStep = {
    id: 2,
    duration: 2,
    actions: new Map([
      ['ballHandler', { type: 'hold' }],
      ['cutter', { type: 'cut', from: 'SLOT_LEFT_WING', to: 'SLOT_RIGHT_CORNER' }],
      ['screener', { type: 'screen', target: 'cutter' }],
    ]),
    trigger: 'pass'
  };
  
  const step3: PlayStep = {
    id: 3,
    duration: 2,
    actions: new Map([
      ['ballHandler', { type: 'hold' }],
      ['screener', { type: 'pop', slot: 'SLOT_LEFT_ELBOW' }],
      ['spacer', { type: 'hold' }],
    ]),
    trigger: 'time'
  };
  
  return {
    name: 'Motion Offense',
    steps: [step1, step2, step3]
  };
}

function createIsoPlay(): Play {
  const step1: PlayStep = {
    id: 1,
    duration: 2,
    actions: new Map([
      ['ballHandler', { type: 'moveTo', slot: 'SLOT_RIGHT_WING' }],
      ['spacer', { type: 'relocate' }], // Clear out to opposite side
    ]),
    trigger: 'time'
  };
  
  const step2: PlayStep = {
    id: 2,
    duration: 4,
    actions: new Map([
      ['ballHandler', { type: 'hold' }], // 1v1 work
      ['spacer', { type: 'hold' }],
    ]),
    trigger: 'time'
  };
  
  return {
    name: 'ISO Clear',
    steps: [step1, step2]
  };
}

function createPostUpPlay(): Play {
  const step1: PlayStep = {
    id: 1,
    duration: 2,
    actions: new Map([
      ['ballHandler', { type: 'moveTo', slot: 'SLOT_TOP_KEY' }],
      ['postUp', { type: 'moveTo', slot: 'SLOT_LOW_POST_L' }],
      ['spacer', { type: 'relocate' }],
    ]),
    trigger: 'time'
  };
  
  const step2: PlayStep = {
    id: 2,
    duration: 2,
    actions: new Map([
      ['ballHandler', { type: 'hold' }], // Entry pass opportunity
      ['postUp', { type: 'postUp' }],
      ['spacer', { type: 'hold' }],
    ]),
    trigger: 'pass'
  };
  
  const step3: PlayStep = {
    id: 3,
    duration: 3,
    actions: new Map([
      ['postUp', { type: 'hold' }], // Post moves
      ['spacer', { type: 'hold' }],
    ]),
    trigger: 'time'
  };
  
  return {
    name: 'Post Up',
    steps: [step1, step2, step3]
  };
}

function createFastBreak(): Play {
  const step1: PlayStep = {
    id: 1,
    duration: 1,
    actions: new Map([
      ['ballHandler', { type: 'drive', direction: 'baseline' }], // Push pace
      ['cutter', { type: 'cut', from: 'SLOT_LEFT_WING', to: 'SLOT_LEFT_CORNER' }],
      ['spacer', { type: 'cut', from: 'SLOT_RIGHT_WING', to: 'SLOT_RIGHT_CORNER' }],
    ]),
    trigger: 'position'
  };
  
  const step2: PlayStep = {
    id: 2,
    duration: 2,
    actions: new Map([
      ['ballHandler', { type: 'hold' }], // Attack or pull up
      ['cutter', { type: 'hold' }],
      ['spacer', { type: 'hold' }],
    ]),
    trigger: 'time'
  };
  
  return {
    name: 'Fast Break',
    steps: [step1, step2]
  };
}

const PLAYBOOK: Play[] = [
  createPickAndRollRight(),
  createMotionOffense(),
  createIsoPlay(),
  createPostUpPlay(),
  createFastBreak(),
];

// ══════════════════════════════════════════════════════════════════════════
// 4. ROLE ASSIGNMENT SYSTEM
// ══════════════════════════════════════════════════════════════════════════

function assignRoles(state: GameState): void {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const tactic = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  
  // Clear existing roles
  state.roles.clear();
  
  // Find ball handler
  const ballHandler = getBallHandler(state);
  if (ballHandler) {
    state.roles.set(ballHandler.id, 'ballHandler');
  }
  
  // Assign roles based on tactic and player attributes
  const remainingPlayers = offTeam.filter(p => p !== ballHandler);
  
  if (tactic === 'iso' && ballHandler?.player.isSuperstar) {
    // ISO: superstar ballHandler, everyone else is spacer
    remainingPlayers.forEach(p => state.roles.set(p.id, 'spacer'));
  } else {
    // Normal role assignment
    const centers = remainingPlayers.filter(p => p.player.position === 'C');
    const forwards = remainingPlayers.filter(p => p.player.position === 'PF');
    const guards = remainingPlayers.filter(p => p.player.position === 'PG' || p.player.position === 'SG');
    const wings = remainingPlayers.filter(p => p.player.position === 'SF');
    
    // Assign screener (usually C/PF)
    if (centers.length > 0) {
      state.roles.set(centers[0].id, 'screener');
    } else if (forwards.length > 0) {
      state.roles.set(forwards[0].id, 'screener');
    }
    
    // Assign post up player for inside offense
    if (tactic === 'inside' && centers.length > 0) {
      state.roles.set(centers[0].id, 'postUp');
    }
    
    // Assign cutters (athletic wings/guards)
    const athleticPlayers = remainingPlayers
      .filter(p => !state.roles.has(p.id))
      .sort((a, b) => b.player.physical.speed - a.player.physical.speed);
    
    if (athleticPlayers.length > 0) {
      state.roles.set(athleticPlayers[0].id, 'cutter');
    }
    
    // Everyone else becomes spacer
    remainingPlayers
      .filter(p => !state.roles.has(p.id))
      .forEach(p => state.roles.set(p.id, 'spacer'));
  }
  
  // Update player role references
  offTeam.forEach(p => {
    p.currentRole = state.roles.get(p.id);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 5. DEFENSIVE ASSIGNMENT SYSTEM  
// ══════════════════════════════════════════════════════════════════════════

function updateDefenseAssignments(state: GameState): void {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const tactic = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
  const ballHandler = getBallHandler(state);
  const basket = getTeamBasket(state.possession);
  
  if (tactic === 'man') {
    // Man-to-man defense
    state.defAssignments.clear();
    
    // Direct assignment by position/index
    for (let i = 0; i < Math.min(defTeam.length, offTeam.length); i++) {
      state.defAssignments.set(defTeam[i].id, offTeam[i].id);
    }
    
    // Position each defender
    defTeam.forEach(defender => {
      const assignedOffPlayer = offTeam.find(p => p.id === state.defAssignments.get(defender.id));
      if (!assignedOffPlayer) return;
      
      if (assignedOffPlayer === ballHandler) {
        // On-ball defense: tight coverage, between player and basket
        const basketDir = normalizeVector({
          x: basket.x - assignedOffPlayer.pos.x,
          y: basket.y - assignedOffPlayer.pos.y
        });
        
        defender.targetPos = {
          x: assignedOffPlayer.pos.x + basketDir.x * 2,
          y: assignedOffPlayer.pos.y + basketDir.y * 2
        };
        defender.isDefensiveSliding = true;
      } else {
        // Off-ball defense
        const distFromBall = ballHandler ? dist(assignedOffPlayer.pos, ballHandler.pos) : 20;
        
        if (distFromBall < 15) {
          // Deny position (1 pass away)
          const denyPos = ballHandler ? {
            x: assignedOffPlayer.pos.x + (ballHandler.pos.x - assignedOffPlayer.pos.x) * 0.4,
            y: assignedOffPlayer.pos.y + (ballHandler.pos.y - assignedOffPlayer.pos.y) * 0.4
          } : assignedOffPlayer.pos;
          
          defender.targetPos = denyPos;
        } else {
          // Help position (2+ passes away)
          defender.targetPos = {
            x: assignedOffPlayer.pos.x + (basket.x - assignedOffPlayer.pos.x) * 0.4,
            y: assignedOffPlayer.pos.y + (basket.y - assignedOffPlayer.pos.y) * 0.3
          };
        }
      }
    });
    
  } else if (tactic === 'zone') {
    // 2-3 Zone defense
    const zonePositions = [
      { x: basket.x - (basket.x > HALF_X ? 20 : -20), y: basket.y - 12 }, // Left guard
      { x: basket.x - (basket.x > HALF_X ? 20 : -20), y: basket.y + 12 }, // Right guard
      { x: basket.x - (basket.x > HALF_X ? 12 : -12), y: basket.y - 8 },  // Left forward
      { x: basket.x - (basket.x > HALF_X ? 12 : -12), y: basket.y + 8 },  // Right forward
      { x: basket.x - (basket.x > HALF_X ? 4 : -4), y: basket.y },         // Center
    ];
    
    // Shift toward ball
    if (ballHandler) {
      const ballSide = ballHandler.pos.y > basket.y ? 1 : -1; // 1 = right side, -1 = left side
      zonePositions.forEach(pos => {
        pos.y += ballSide * 2; // Shift toward ball side
      });
    }
    
    defTeam.forEach((defender, i) => {
      if (i < zonePositions.length) {
        defender.targetPos = { ...zonePositions[i] };
      }
    });
  }
}

function processHelpDefense(state: GameState): void {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const ballHandler = getBallHandler(state);
  const basket = getTeamBasket(state.possession);
  
  if (!ballHandler) return;
  
  // Check if ball handler is driving (close to basket)
  const distToBasket = dist(ballHandler.pos, basket);
  if (distToBasket < 15) {
    // Find help defender
    const helpDefender = defTeam.find(def => {
      const assignedPlayer = state.players.find(p => p.id === state.defAssignments.get(def.id));
      return assignedPlayer && assignedPlayer !== ballHandler && dist(def.pos, ballHandler.pos) < 12;
    });
    
    if (helpDefender) {
      // Help on ball handler
      const helpPos = {
        x: ballHandler.pos.x + (basket.x - ballHandler.pos.x) * 0.6,
        y: ballHandler.pos.y + (basket.y - ballHandler.pos.y) * 0.6
      };
      helpDefender.targetPos = helpPos;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 6. COURT VISION & PASS INTELLIGENCE
// ══════════════════════════════════════════════════════════════════════════

function getPassOptions(state: GameState, ballHandler: SimPlayer): SimPlayer[] {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const candidates = offTeam.filter(p => {
    if (p === ballHandler) return false;
    
    // Anti-ping-pong: don't pass back to recent passer
    if (state.lastPassFrom === p.id && state.gameTime - state.lastPassTime < 3) return false;
    
    // Check if pass lane is blocked
    if (isPassLaneBlocked(ballHandler, p, state)) return false;
    
    return true;
  });
  
  // Score each candidate
  const scoredCandidates = candidates.map(candidate => {
    let score = 0;
    
    // Openness factor
    const defender = findNearestDefender(candidate, state);
    const openness = defender ? dist(defender.pos, candidate.pos) : 12;
    score += openness * 2;
    
    // Position factor
    const basket = getTeamBasket(state.possession);
    const distToBasket = dist(candidate.pos, basket);
    score += Math.max(0, (30 - distToBasket)) * 1.5;
    
    // Skill factor
    if (distToBasket > 15) {
      const shootingSkill = (candidate.player.skills.shooting.three_point + candidate.player.skills.shooting.mid_range) / 2;
      score += skillModifier(shootingSkill) * 3;
    }
    
    // Superstar factor
    if (candidate.player.isSuperstar) {
      score += 5;
    }
    
    // Court vision affects how well ball handler finds open man
    const courtVision = ballHandler.player.skills.playmaking.court_vision || 50;
    if (courtVision < 30) {
      // Low court vision - prefer closer players
      const distance = dist(ballHandler.pos, candidate.pos);
      score += Math.max(0, (25 - distance)) * 2;
    }
    
    return { player: candidate, score };
  });
  
  return scoredCandidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(c => c.player);
}

// ══════════════════════════════════════════════════════════════════════════
// 7. TICK/SIMULATION LOGIC
// ══════════════════════════════════════════════════════════════════════════

function tick(state: GameState): GameState {
  const dt = 0.1;
  state.phaseTicks++;
  state.gameTime += dt;

  // Update clocks
  if (state.phase !== 'jumpball' && state.gameStarted) {
    state.clockSeconds -= dt;
    state.shotClock -= dt;
    state.advanceClock += dt;
  }

  // Game clock management
  if (state.clockSeconds <= 0 && state.gameStarted) {
    state.clockSeconds = 0;
    if (state.quarter < 4) {
      state.quarter++;
      state.clockSeconds = 12 * 60;
      state.possession = (state.quarter % 2 === 0 ? 1 : 0) as 0 | 1;
      state.phase = 'inbound';
      state.phaseTicks = 0;
      state.shotClock = 24;
      resetPossession(state);
      return state;
    } else {
      state.running = false;
      return state;
    }
  }

  // Violations
  if (state.shotClock <= 0 && state.gameStarted) {
    changePossession(state, 'Shot clock violation');
    return state;
  }
  
  if (!state.crossedHalfCourt && state.advanceClock > 8) {
    changePossession(state, '8-second violation');
    return state;
  }
  
  const ballHandler = getBallHandler(state);
  if (ballHandler && state.crossedHalfCourt) {
    const backCourt = (state.possession === 0 && ballHandler.pos.x < HALF_X) || 
                     (state.possession === 1 && ballHandler.pos.x > HALF_X);
    if (backCourt) {
      changePossession(state, 'Backcourt violation');
      return state;
    }
  }

  // Handle ball in flight
  if (state.ball.inFlight) {
    updateBallFlight(state, dt);
    // Continue moving players during flight
    for (const p of state.players) {
      movePlayerToward(p, dt, state);
    }
    return state;
  }

  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const basketPos = getTeamBasket(state.possession);
  const dir = state.possession === 0 ? 1 : -1;

  // Main simulation phases
  switch (state.phase) {
    case 'jumpball':
      handleJumpBall(state);
      break;
    case 'inbound':
      handleInbound(state, offTeam, defTeam, dir);
      break;
    case 'advance':
      handleAdvance(state, offTeam, defTeam, basketPos, dir);
      break;
    case 'setup':
      handleSetup(state, offTeam, defTeam, basketPos, dir);
      break;
    case 'action':
      handleAction(state, offTeam, defTeam, basketPos, dir);
      break;
    case 'shooting':
      if (!state.ball.inFlight) {
        state.phase = 'action';
        state.phaseTicks = 0;
      }
      break;
    case 'rebound':
      handleRebound(state, offTeam, defTeam);
      break;
  }

  // Update all systems
  if (state.phase === 'action' || state.phase === 'setup') {
    assignRoles(state);
    updateDefenseAssignments(state);
    processHelpDefense(state);
    
    if (state.currentPlay) {
      updateCurrentPlay(state, basketPos, dir);
    }
    
    enforceFloorSpacing(state);
    fillEmptySlots(state);
  }

  // Move all players
  for (const p of state.players) {
    movePlayerToward(p, dt, state);
    
    // Reset per-frame flags
    p.isDefensiveSliding = false;
    p.isCutting = false;
    p.isScreening = false;
  }

  // Ball follows carrier
  if (state.ball.carrier && !state.ball.inFlight) {
    state.ball.pos = { ...state.ball.carrier.pos };
  }

  return state;
}

function handleJumpBall(state: GameState): void {
  // Position players for jump ball
  const centers = state.players.filter(p => p.player.position === 'C');
  if (centers.length >= 2) {
    centers[0].targetPos = { x: HALF_X - 2, y: BASKET_Y };
    centers[1].targetPos = { x: HALF_X + 2, y: BASKET_Y };
  }
  
  // Other players form circle
  const otherPlayers = state.players.filter(p => !centers.includes(p));
  otherPlayers.forEach((p, i) => {
    const angle = (i / otherPlayers.length) * Math.PI * 2;
    const radius = 12;
    p.targetPos = {
      x: HALF_X + Math.cos(angle) * radius,
      y: BASKET_Y + Math.sin(angle) * radius
    };
  });

  if (state.phaseTicks > 30) {
    // Execute jump ball
    executeJumpBall(state, centers);
  }
}

function handleInbound(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[], dir: number): void {
  const ownBasket = getOwnBasket(state.possession);
  
  if (state.phaseTicks < 10) {
    // Inbounder positions
    const inbounder = offTeam[0];
    inbounder.targetPos = { 
      x: ownBasket.x + (dir > 0 ? -5 : 5), 
      y: BASKET_Y + (state.rng() - 0.5) * 15
    };
    
    clearBallCarrier(state);
    inbounder.hasBall = true;
    state.ball.carrier = inbounder;
    
    // Position other offensive players
    for (let i = 1; i < offTeam.length; i++) {
      offTeam[i].targetPos = { 
        x: ownBasket.x + dir * (8 + i * 3), 
        y: BASKET_Y + (i - 2.5) * 7 
      };
    }
  } else {
    // Execute inbound pass
    const inbounder = getBallHandler(state);
    if (inbounder) {
      const receiver = offTeam.find(p => p !== inbounder && dist(p.pos, inbounder.pos) < 15);
      if (receiver && state.rng() < 0.8) {
        passBall(state, inbounder, receiver);
        state.phase = 'advance';
        state.phaseTicks = 0;
      }
    }
  }
}

function handleAdvance(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[], basketPos: Vec2, dir: number): void {
  const handler = getBallHandler(state);
  if (!handler) return;
  
  // Check half-court crossing
  const crossedHalfCourt = (state.possession === 0 && handler.pos.x > HALF_X) || 
                          (state.possession === 1 && handler.pos.x < HALF_X);
  
  if (crossedHalfCourt) {
    state.crossedHalfCourt = true;
  }
  
  // Ball handler advances
  const targetX = basketPos.x - dir * 20;
  handler.targetPos = { x: targetX, y: BASKET_Y };
  
  // Other players spread out
  for (let i = 0; i < offTeam.length; i++) {
    if (offTeam[i] === handler) continue;
    offTeam[i].targetPos = {
      x: HALF_X + dir * (8 + i * 4),
      y: BASKET_Y + (i - 2) * 8
    };
  }
  
  // Check if advanced enough
  if (Math.abs(handler.pos.x - HALF_X) > 8) {
    state.phase = 'setup';
    state.phaseTicks = 0;
    state.advanceClock = 0; // Reset advance clock
  }
}

function handleSetup(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[], basketPos: Vec2, dir: number): void {
  const slots = getSlotPositions(basketPos, dir);
  
  // Initial slot assignment
  if (state.phaseTicks === 1) {
    assignInitialSlots(state, offTeam, slots);
  }
  
  // Position players in slots
  offTeam.forEach(player => {
    if (player.currentSlot) {
      const slotPos = slots.get(player.currentSlot);
      if (slotPos) {
        player.targetPos = { ...slotPos };
      }
    }
  });
  
  if (state.phaseTicks > 20) {
    // Select and start play
    selectPlay(state, offTeam);
    state.phase = 'action';
    state.phaseTicks = 0;
  }
}

function handleAction(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[], basketPos: Vec2, dir: number): void {
  const handler = getBallHandler(state);
  if (!handler) return;
  
  // Update current play if one is active
  if (state.currentPlay) {
    updateCurrentPlay(state, basketPos, dir);
  }
  
  // Ball handler decision making
  const distToBasket = dist(handler.pos, basketPos);
  const isOpen = checkIfOpen(handler, state);
  const timeUrgency = state.shotClock < 8;
  
  const roll = state.rng();
  const possessionAge = 24 - state.shotClock; // seconds into possession
  
  if (state.shotClock < 2) {
    // Desperation shot
    attemptShot(state, handler, basketPos);
  } else if (state.shotClock < 6 && distToBasket < 25) {
    // Shot clock pressure — just shoot if reasonable
    attemptShot(state, handler, basketPos);
  } else if (isOpen && distToBasket < 25 && roll < 0.15) {
    // Open shot — take it
    attemptShot(state, handler, basketPos);
  } else if (distToBasket < 8 && roll < 0.20) {
    // Close to basket — high chance to score
    attemptShot(state, handler, basketPos);
  } else if (possessionAge > 12 && distToBasket < 28 && roll < 0.10) {
    // Late in possession — be more aggressive
    attemptShot(state, handler, basketPos);
  } else if (roll < 0.08) {
    // Look for pass
    const passOptions = getPassOptions(state, handler);
    if (passOptions.length > 0) {
      passBall(state, handler, passOptions[0]);
    }
  } else if (roll < 0.12 && distToBasket > 15) {
    // Drive toward basket
    handler.targetPos = {
      x: basketPos.x + (handler.pos.x > basketPos.x ? 3 : -3),
      y: basketPos.y + (state.rng() - 0.5) * 8,
    };
  }
  
  // Steal attempts
  const nearestDefender = findNearestDefender(handler, state);
  if (nearestDefender && dist(nearestDefender.pos, handler.pos) < 3) {
    const stealChance = skillModifier(nearestDefender.player.skills.defense.steal) * 0.02;
    if (state.rng() < stealChance) {
      clearBallCarrier(state);
      nearestDefender.hasBall = true;
      state.ball.carrier = nearestDefender;
      state.lastEvent = `${nearestDefender.player.name} steals the ball!`;
      changePossession(state, '');
    }
  }
}

function handleRebound(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[]): void {
  const reboundPos = { ...state.ball.pos };
  
  // Players converge on rebound
  for (const p of state.players) {
    p.targetPos = { 
      x: reboundPos.x + (state.rng() - 0.5) * 6, 
      y: reboundPos.y + (state.rng() - 0.5) * 6
    };
  }
  
  if (state.phaseTicks > 12) {
    // Determine rebounder
    const nearPlayers = state.players
      .sort((a, b) => dist(a.pos, reboundPos) - dist(b.pos, reboundPos))
      .slice(0, 6);
      
    let rebounder = nearPlayers[0];
    let bestValue = 0;
    
    for (const p of nearPlayers) {
      const rebSkill = p.player.skills.athletic.rebounding;
      const height = p.player.physical.height;
      const position = dist(p.pos, reboundPos);
      const value = skillModifier(rebSkill) * (height / 200) * (10 - position) * state.rng();
      
      if (value > bestValue) {
        bestValue = value;
        rebounder = p;
      }
    }
    
    clearBallCarrier(state);
    rebounder.hasBall = true;
    state.ball.carrier = rebounder;
    state.ball.pos = { ...rebounder.pos };
    state.lastEvent = `${rebounder.player.name} grabs the rebound`;
    
    if (rebounder.teamIdx !== state.possession) {
      changePossession(state, '');
    } else {
      // Offensive rebound
      state.shotClock = 14;
      state.phase = 'setup';
      state.phaseTicks = 0;
    }
  }
}

function updateCurrentPlay(state: GameState, basketPos: Vec2, dir: number): void {
  if (!state.currentPlay) return;
  
  state.stepTimer += 0.1;
  
  const currentStep = state.currentPlay.steps[state.currentStep];
  if (!currentStep) return;
  
  // Execute role actions for current step
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const slots = getSlotPositions(basketPos, dir);
  
  for (const player of offTeam) {
    if (!player.currentRole) continue;
    
    const action = currentStep.actions.get(player.currentRole);
    if (!action) continue;
    
    executeRoleAction(player, action, state, slots, basketPos, dir);
  }
  
  // Check if step should advance
  let shouldAdvance = false;
  
  if (currentStep.trigger === 'time' && state.stepTimer >= currentStep.duration) {
    shouldAdvance = true;
  } else if (currentStep.trigger === 'pass' && state.gameTime - state.lastPassTime < 0.5) {
    shouldAdvance = true;
  } else if (currentStep.trigger === 'position' && currentStep.triggerCondition?.()) {
    shouldAdvance = true;
  }
  
  if (shouldAdvance && state.currentStep < state.currentPlay.steps.length - 1) {
    state.currentStep++;
    state.stepTimer = 0;
  } else if (shouldAdvance) {
    // Play complete
    state.currentPlay = null;
    state.currentStep = 0;
    state.stepTimer = 0;
  }
}

function executeRoleAction(player: SimPlayer, action: RoleAction, state: GameState, slots: Map<SlotName, Vec2>, basketPos: Vec2, dir: number): void {
  switch (action.type) {
    case 'moveTo':
      const slotPos = slots.get(action.slot);
      if (slotPos) {
        player.targetPos = { ...slotPos };
        if (player.currentSlot) {
          state.slots.set(player.currentSlot, null);
        }
        player.currentSlot = action.slot;
        state.slots.set(action.slot, player.id);
      }
      break;
    case 'screen':
      const targetPlayer = state.players.find(p => p.currentRole === action.target);
      if (targetPlayer) {
        player.targetPos = {
          x: targetPlayer.pos.x + dir * 3,
          y: targetPlayer.pos.y + (state.rng() > 0.5 ? 3 : -3)
        };
        player.isScreening = true;
      }
      break;
    case 'cut':
      const fromPos = slots.get(action.from);
      const toPos = slots.get(action.to);
      if (toPos) {
        player.targetPos = { ...toPos };
        player.isCutting = true;
      }
      break;
    case 'drive':
      let driveTarget = { ...basketPos };
      if (action.direction === 'left') {
        driveTarget.y -= 6;
      } else if (action.direction === 'right') {
        driveTarget.y += 6;
      } else if (action.direction === 'baseline') {
        driveTarget.x -= dir * 2;
      }
      player.targetPos = driveTarget;
      break;
    case 'roll':
      player.targetPos = {
        x: basketPos.x - dir * 8,
        y: basketPos.y + (state.rng() - 0.5) * 6
      };
      break;
    case 'pop':
      const popPos = slots.get(action.slot);
      if (popPos) {
        player.targetPos = { ...popPos };
      }
      break;
    case 'relocate':
      findOpenSlot(player, state);
      break;
    case 'hold':
      // Stay in current position
      break;
    case 'postUp':
      player.targetPos = {
        x: basketPos.x - dir * 8,
        y: basketPos.y + (state.rng() - 0.5) * 6
      };
      break;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function normalizeVector(v: Vec2): Vec2 {
  const length = Math.sqrt(v.x * v.x + v.y * v.y);
  return length > 0 ? { x: v.x / length, y: v.y / length } : { x: 0, y: 0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function getTeamBasket(possession: 0 | 1): Vec2 {
  const bx = possession === 0 ? BASKET_X_RIGHT : BASKET_X_LEFT;
  return { x: bx, y: BASKET_Y };
}

function getOwnBasket(possession: 0 | 1): Vec2 {
  const bx = possession === 0 ? BASKET_X_LEFT : BASKET_X_RIGHT;
  return { x: bx, y: BASKET_Y };
}

function getBallHandler(state: GameState): SimPlayer | null {
  return state.ball.carrier;
}

function clearBallCarrier(state: GameState): void {
  for (const p of state.players) {
    p.hasBall = false;
  }
  state.ball.carrier = null;
}

function findNearestDefender(offensivePlayer: SimPlayer, state: GameState): SimPlayer | null {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  return defTeam.reduce((closest, def) => 
    dist(def.pos, offensivePlayer.pos) < dist(closest.pos, offensivePlayer.pos) ? def : closest
  );
}

function checkIfOpen(player: SimPlayer, state: GameState): boolean {
  const defender = findNearestDefender(player, state);
  return !defender || dist(defender.pos, player.pos) > 6;
}

function isPassLaneBlocked(from: SimPlayer, to: SimPlayer, state: GameState): boolean {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  
  for (const def of defTeam) {
    const distToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    if (distToLine < 2.5) {
      return true;
    }
  }
  return false;
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

function movePlayerToward(player: SimPlayer, dt: number, state: GameState): void {
  const dx = player.targetPos.x - player.pos.x;
  const dy = player.targetPos.y - player.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  
  if (d < 0.3) {
    player.vel.x *= 0.8;
    player.vel.y *= 0.8;
    return;
  }
  
  // Calculate speed with new system
  let baseSpeed = (player.player.physical.speed / 100) * 5 * (1 - player.fatigue * 0.3);
  
  if (player.isDefensiveSliding) baseSpeed *= 0.7;
  if (player.isCutting) baseSpeed *= 1.1;
  if (player.hasBall) baseSpeed *= 0.8;
  
  const accel = (player.player.physical.acceleration / 100) * 15;
  const targetVx = (dx / d) * baseSpeed;
  const targetVy = (dy / d) * baseSpeed;
  const blend = Math.min(1, accel * dt * 0.12);
  
  player.vel.x += (targetVx - player.vel.x) * blend;
  player.vel.y += (targetVy - player.vel.y) * blend;
  player.pos.x += player.vel.x * dt;
  player.pos.y += player.vel.y * dt;
  
  // Boundary constraints
  player.pos.x = clamp(player.pos.x, 1, COURT_W - 1);
  player.pos.y = clamp(player.pos.y, 1, COURT_H - 1);
  
  // Update fatigue
  player.fatigue = Math.min(1, player.fatigue + dt * 0.001 * (1 - player.player.physical.stamina / 100));
  
  // Idle movement
  const t = state.gameTime * 0.5 + player.courtIdx * 1.2;
  player.pos.x += Math.sin(t) * 0.1;
  player.pos.y += Math.cos(t * 1.3) * 0.05;
}

function updateBallFlight(state: GameState, dt: number): void {
  state.ball.flightProgress += dt / state.ball.flightDuration;
  const t = Math.min(1, state.ball.flightProgress);

  if (state.ball.jumpBall?.active) {
    // Jump ball animation
    const height = Math.sin(t * Math.PI) * 15;
    state.ball.jumpBall.height = height;
    state.ball.pos.y = BASKET_Y - height;

    if (t >= 1) {
      const centers = state.players.filter(p => p.player.position === 'C');
      if (centers.length >= 2) {
        const winner = centers[Math.random() < 0.5 ? 0 : 1];
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
    // Regular flight
    state.ball.pos.x = state.ball.flightFrom.x + (state.ball.flightTo.x - state.ball.flightFrom.x) * t;
    state.ball.pos.y = state.ball.flightFrom.y + (state.ball.flightTo.y - state.ball.flightFrom.y) * t;

    if (t >= 1) {
      state.ball.inFlight = false;
      if (state.ball.isShot) {
        if (state.ball.shotWillScore) {
          const basket = getTeamBasket(state.possession);
          const shotDistance = dist(state.ball.flightFrom, basket);
          const pts = shotDistance > 22 ? 3 : 2;
          const shooterName = (state.ball as any).shooterName || 'Player';
          
          const scoringTeam = state.possession;
          state.score[scoringTeam] += pts;
          state.lastEvent = `${shooterName} scores ${pts}! (${state.score[0]}-${state.score[1]})`;
          changePossession(state, '');
        } else {
          state.phase = 'rebound';
          state.phaseTicks = 0;
          state.lastEvent = 'Miss! Rebound...';
        }
        state.ball.isShot = false;
      } else {
        // Pass completed
        const offTeam = state.players.filter(p => p.teamIdx === state.possession);
        let closest: SimPlayer | null = null;
        let closestD = Infinity;
        for (const p of offTeam) {
          const d = dist(p.pos, state.ball.pos);
          if (d < closestD) {
            closestD = d;
            closest = p;
          }
        }
        if (closest) {
          clearBallCarrier(state);
          closest.hasBall = true;
          state.ball.carrier = closest;
        }
      }
    }
  }
}

function executeJumpBall(state: GameState, centers: SimPlayer[]): void {
  if (centers.length < 2) return;
  
  state.ball.inFlight = true;
  state.ball.flightFrom = { x: HALF_X, y: BASKET_Y };
  state.ball.flightTo = { x: HALF_X, y: BASKET_Y };
  state.ball.flightProgress = 0;
  state.ball.flightDuration = 1.0;
  state.ball.isShot = false;
  state.ball.jumpBall = { active: true, height: 0, winner: null };
  state.lastEvent = 'Jump ball!';
}

function assignInitialSlots(state: GameState, offTeam: SimPlayer[], slots: Map<SlotName, Vec2>): void {
  state.slots.clear();
  
  const slotNames: SlotName[] = [
    'SLOT_TOP_KEY',
    'SLOT_LEFT_WING',
    'SLOT_RIGHT_WING',
    'SLOT_LEFT_ELBOW',
    'SLOT_RIGHT_ELBOW',
    'SLOT_LEFT_CORNER',
    'SLOT_RIGHT_CORNER',
    'SLOT_LOW_POST_L',
    'SLOT_LOW_POST_R'
  ];
  
  // Assign players to slots
  for (let i = 0; i < Math.min(offTeam.length, slotNames.length); i++) {
    const player = offTeam[i];
    const slot = slotNames[i];
    
    state.slots.set(slot, player.id);
    player.currentSlot = slot;
  }
}

function selectPlay(state: GameState, offTeam: SimPlayer[]): void {
  const tactic = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  
  let selectedPlay: Play;
  
  switch (tactic) {
    case 'fast_break':
      selectedPlay = PLAYBOOK.find(p => p.name === 'Fast Break')!;
      break;
    case 'iso':
      selectedPlay = PLAYBOOK.find(p => p.name === 'ISO Clear')!;
      break;
    case 'inside':
      selectedPlay = PLAYBOOK.find(p => p.name === 'Post Up')!;
      break;
    default:
      // Default to motion or pick and roll
      selectedPlay = state.rng() < 0.5 
        ? PLAYBOOK.find(p => p.name === 'Motion Offense')!
        : PLAYBOOK.find(p => p.name === 'Pick and Roll (Right)')!;
      break;
  }
  
  state.currentPlay = selectedPlay;
  state.currentStep = 0;
  state.stepTimer = 0;
}

function attemptShot(state: GameState, shooter: SimPlayer, basket: Vec2): void {
  const shooterName = shooter.player.name;
  const distToBasket = dist(shooter.pos, basket);
  
  let shotSkill: number;
  if (distToBasket > 22) {
    shotSkill = shooter.player.skills.shooting.three_point;
  } else if (distToBasket > 10) {
    shotSkill = shooter.player.skills.shooting.mid_range;
  } else {
    shotSkill = shooter.player.skills.finishing.layup;
  }

  const tacticO = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
  const advantage = getTacticAdvantage(tacticO, tacticD);
  
  let basePct = distToBasket > 22 ? 0.35 : distToBasket > 10 ? 0.45 : 0.60;
  
  // Contest factor
  const nearestDef = findNearestDefender(shooter, state);
  const contestDistance = nearestDef ? dist(nearestDef.pos, shooter.pos) : 10;
  let contestModifier = contestDistance < 3 ? 0.6 : contestDistance < 5 ? 0.8 : 1.0;
  
  if (shooter.player.isSuperstar) {
    contestModifier = Math.max(contestModifier, 0.8);
  }
  
  if (state.shotClock < 3) {
    contestModifier *= 0.85;
  }
  
  const finalPct = basePct * skillModifier(shotSkill) * contestModifier * (1 + advantage);
  const willScore = state.rng() < finalPct;

  state.ball.inFlight = true;
  state.ball.flightFrom = { ...shooter.pos };
  state.ball.flightTo = { ...basket };
  state.ball.flightProgress = 0;
  state.ball.flightDuration = 0.6 + distToBasket * 0.02;
  state.ball.isShot = true;
  state.ball.shotWillScore = willScore;
  
  (state.ball as any).shooterName = shooterName;
  (state.ball as any).shooterPossession = state.possession;
  
  clearBallCarrier(state);
  state.phase = 'shooting';
  state.currentPlay = null;
  
  const contestStr = contestDistance < 3 ? ' (contested)' : contestDistance < 6 ? ' (lightly contested)' : '';
  state.lastEvent = `${shooterName} shoots${contestStr} from ${distToBasket.toFixed(0)}ft`;
}

function passBall(state: GameState, from: SimPlayer, to: SimPlayer): void {
  // Check for interception
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  
  for (const def of defTeam) {
    const distToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    if (distToLine < 2.5 && dist(def.pos, from.pos) < 12) {
      const stealChance = skillModifier(def.player.skills.defense.steal) * 0.08;
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
  state.ball.flightDuration = 0.15 + d * 0.012;
  state.ball.isShot = false;
  state.ball.shotWillScore = false;
  clearBallCarrier(state);
  
  state.lastPassFrom = from.id;
  state.lastPassTime = state.gameTime;
  state.lastEvent = `${from.player.name} passes to ${to.player.name}`;
}

function changePossession(state: GameState, event: string): void {
  state.possession = (1 - state.possession) as 0 | 1;
  state.phase = 'inbound';
  state.phaseTicks = 0;
  state.shotClock = 24;
  state.currentPlay = null;
  
  resetPossession(state);
  if (event) state.lastEvent = event;
}

function resetPossession(state: GameState): void {
  // Clear all basketball systems
  state.slots.clear();
  state.roles.clear();
  state.defAssignments.clear();
  state.crossedHalfCourt = false;
  state.advanceClock = 0;
  state.lastPassFrom = null;
  state.lastPassTime = 0;
  
  // Reset player states
  state.players.forEach(p => {
    p.currentSlot = undefined;
    p.currentRole = undefined;
    p.isDefensiveSliding = false;
    p.isCutting = false;
    p.isScreening = false;
  });
  
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const dir = state.possession === 0 ? 1 : -1;
  const ownBasket = getOwnBasket(state.possession);

  clearBallCarrier(state);
  
  // Position for inbound
  for (let i = 0; i < offTeam.length; i++) {
    offTeam[i].targetPos = { 
      x: ownBasket.x + dir * (5 + i * 2), 
      y: BASKET_Y + (i - 2) * 5 
    };
  }

  for (let i = 0; i < defTeam.length; i++) {
    defTeam[i].targetPos = { 
      x: ownBasket.x + dir * (12 + i * 2), 
      y: BASKET_Y + (i - 2) * 5 
    };
  }

  state.ball.pos = { ...offTeam[0].pos };
  state.ball.inFlight = false;
}

function initGameState(): GameState {
  const rng = createRng(Date.now());
  const allPlayers: SimPlayer[] = [];

  const makeTeamPlayers = (team: Team, teamIdx: 0 | 1) => {
    team.players.slice(0, 5).forEach((p, i) => {
      allPlayers.push({
        player: p,
        id: `${teamIdx}-${i}`,
        pos: { x: HALF_X, y: 15 + i * 5 },
        vel: { x: 0, y: 0 },
        targetPos: { x: HALF_X, y: 15 + i * 5 },
        teamIdx: teamIdx as 0 | 1,
        hasBall: false,
        fatigue: 0,
        courtIdx: i,
        lastMoveTime: 0,
        isDefensiveSliding: false,
        isCutting: false,
        isScreening: false,
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
    shotClock: 24,
    possession: 0,
    phase: 'jumpball',
    phaseTicks: 0,
    running: false,
    speed: 1,
    homeTacticO: 'motion',
    homeTacticD: 'man',
    awayTacticO: 'motion',
    awayTacticD: 'man',
    rng,
    lastEvent: 'Ready for tip-off...',
    gameStarted: false,
    gameTime: 0,
    
    // New basketball systems
    slots: new Map(),
    roles: new Map(),
    defAssignments: new Map(),
    currentPlay: null,
    currentStep: 0,
    stepTimer: 0,
    lastPassFrom: null,
    lastPassTime: 0,
    crossedHalfCourt: false,
    advanceClock: 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 8. DRAWING FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

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
    const y = sp.pos.y * s;
    const r = 12;

    // Role indicators
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

    // Ball carrier glow
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
    
    // Role indicator
    if (sp.currentRole) {
      ctx.font = '6px monospace';
      ctx.fillStyle = '#3fb950';
      const roleAbbrev = sp.currentRole === 'ballHandler' ? 'BH' : 
                        sp.currentRole === 'screener' ? 'SC' :
                        sp.currentRole === 'cutter' ? 'CT' :
                        sp.currentRole === 'spacer' ? 'SP' : 'PU';
      ctx.fillText(roleAbbrev, x, y + r + 20);
    }
    
    // Fatigue indicator
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
    // Ball shadow
    ctx.beginPath();
    ctx.arc(bx, by + 3, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    // Elevated ball
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
  // Scoreboard background
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
  
  // Shot clock
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

  // Event text
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

  // Possession indicator
  const posX = state.possession === 0 ? CANVAS_W / 2 - 80 : CANVAS_W / 2 + 80;
  ctx.beginPath();
  ctx.arc(posX, 38, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#3fb950';
  ctx.fill();
  
  ctx.fillStyle = state.possession === 0 ? '#f85149' : '#58a6ff';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('●', posX, 38);

  // Play indicator
  if (state.currentPlay) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    const playText = `${state.currentPlay.name} - Step ${state.currentStep + 1}`;
    ctx.fillText(playText, 10, CANVAS_H - 10);
  }
  
  // Phase indicator
  ctx.fillStyle = '#8b949e';
  ctx.font = '8px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`Phase: ${state.phase.toUpperCase()}`, CANVAS_W - 10, CANVAS_H - 10);
}

// ══════════════════════════════════════════════════════════════════════════
// 9. REACT COMPONENT
// ══════════════════════════════════════════════════════════════════════════

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
    </div>
  );
}