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

type PossessionStage = 'early' | 'mid' | 'late' | 'desperation';

type RoleAction = 
  | { type: 'moveTo', slot: SlotName }
  | { type: 'screen', target: OffenseRole }
  | { type: 'cut', from: SlotName, to: SlotName }
  | { type: 'drive', direction: 'left' | 'right' | 'baseline' }
  | { type: 'hold' }
  | { type: 'postUp' }
  | { type: 'pop', slot: SlotName }
  | { type: 'roll' }
  | { type: 'relocate' }
  // NEW ball actions:
  | { type: 'passTo', target: OffenseRole }      // pass to specific role
  | { type: 'shootIfOpen' }                       // shoot if defender > 6ft
  | { type: 'readAndReact' }                      // smart decision based on defense
  | { type: 'callForBall' }                       // signal to handler, increase pass weight
  | { type: 'entryPass', target: OffenseRole };   // post entry pass

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
  isDribbling: boolean;       // actively dribbling (slower, can be stolen)
  catchTimer: number;         // seconds until player can act after catching (0 = ready)
  sprintTimer: number;        // seconds sprinting (affects speed decay)
}

type MissType = 'rim_out' | 'back_iron' | 'airball' | 'blocked' | 'front_rim' | null;

interface BallState {
  pos: Vec2;
  z: number; // height off the ground in feet (0 = floor, 10 = rim height)
  carrier: SimPlayer | null;
  inFlight: boolean;
  flightFrom: Vec2;
  flightTo: Vec2;
  flightFromZ: number;
  flightPeakZ: number; // apex of arc
  flightProgress: number;
  flightDuration: number;
  isShot: boolean;
  shotWillScore: boolean;
  missType: MissType;
  // For rebound bounce animation
  bouncing: boolean;
  bounceTarget: Vec2;
  bounceProgress: number;
  bounceZ: number; // z during bounce
  bounceVelZ: number; // vertical velocity during bounce
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
  phase: 'jumpball' | 'inbound' | 'advance' | 'setup' | 'action' | 'shooting' | 'rebound' | 'freethrow';
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
  dribbleTime: number;        // seconds current handler has held the ball
  crossedHalfCourt: boolean;
  advanceClock: number;
  possessionStage: PossessionStage;  // current stage
  playCompleted: boolean;  // has the primary play finished?
  freeThrows: { shooter: SimPlayer; made: number; total: number; andOne: boolean } | null;
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

function offBallMovement(state: GameState, offTeam: SimPlayer[], basketPos: Vec2, dir: number): void {
  const handler = getBallHandler(state);
  if (!handler) return;
  
  // Don't override play actions
  if (state.currentPlay) return;
  
  const slots = getSlotPositions(basketPos, dir);
  
  for (const player of offTeam) {
    if (player === handler) continue;
    if (player.isScreening || player.isCutting) continue;
    
    // Each player checks for movement every ~2.5 seconds, staggered
    const moveHash = (state.phaseTicks + player.courtIdx * 37) % 150;
    if (moveHash !== 0) continue;
    
    const defender = findNearestDefender(player, state);
    const defDist = defender ? dist(defender.pos, player.pos) : 20;
    const distToBasket = dist(player.pos, basketPos);
    const roll = state.rng();
    
    // 1. BACKDOOR CUT — defender overplaying (between player and ball, tight)
    if (defender && defDist < 4 && distToBasket > 15) {
      const defToBall = dist(defender.pos, handler.pos);
      const playerToBall = dist(player.pos, handler.pos);
      if (defToBall < playerToBall) {
        // Defender is between us and ball → backdoor!
        player.targetPos = {
          x: basketPos.x - dir * 3,
          y: basketPos.y + (player.pos.y > basketPos.y ? 3 : -3)
        };
        player.isCutting = true;
        continue;
      }
    }
    
    // 2. V-CUT — defender tight but not overplaying
    if (defDist < 5 && roll < 0.4) {
      const currentSlot = player.currentSlot;
      if (currentSlot) {
        const slotPos = slots.get(currentSlot);
        if (slotPos) {
          const jabDir = state.rng() > 0.5 ? 1 : -1;
          player.targetPos = {
            x: slotPos.x + dir * 5,
            y: slotPos.y + jabDir * 4
          };
          player.isCutting = true;
          // After jab, return to slot (handled by slot system next tick)
        }
      }
      continue;
    }
    
    // 3. PIN DOWN SCREEN — set screen for teammate near basket to get them open
    if (player.currentRole === 'screener' || player.currentRole === 'postUp') {
      const teammate = offTeam.find(p => 
        p !== handler && p !== player && 
        dist(p.pos, basketPos) < 15 && 
        !checkIfOpen(p, state)
      );
      if (teammate && roll < 0.3) {
        // Move next to teammate's defender to screen
        const tmDef = findNearestDefender(teammate, state);
        if (tmDef) {
          player.targetPos = {
            x: tmDef.pos.x + dir * 1,
            y: tmDef.pos.y + (state.rng() > 0.5 ? 2 : -2)
          };
          player.isScreening = true;
        }
        continue;
      }
    }
    
    // 4. FLARE / RELOCATE to 3pt line — shooter drifts to open spot
    if ((player.currentRole === 'spacer' || player.currentRole === 'cutter') && roll < 0.25) {
      findOpenSlot(player, state);
      continue;
    }
    
    // 5. DRIFT — subtle positional adjustment toward open space
    if (defDist > 8) {
      // Already open — small drift to stay in shooting pocket
      const currentSlot = player.currentSlot;
      if (currentSlot) {
        const slotPos = slots.get(currentSlot);
        if (slotPos) {
          player.targetPos = { ...slotPos };
        }
      }
    }
  }
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
// 3. POSSESSION STATE MACHINE (SYSTEM 1)
// ══════════════════════════════════════════════════════════════════════════

function getPossessionStage(shotClock: number): PossessionStage {
  if (shotClock > 18) return 'early';      // 0-6s into possession
  if (shotClock > 10) return 'mid';        // 6-14s
  if (shotClock > 4) return 'late';        // 14-20s  
  return 'desperation';                     // 20-24s
}

// ══════════════════════════════════════════════════════════════════════════
// 4. PLAYBOOK SYSTEM — Real NBA set plays
// ══════════════════════════════════════════════════════════════════════════

// 1. HORNS PnR — Two bigs at elbows, PG picks a side
// Used by: Warriors, Nuggets, most modern NBA teams
function createHornsPnR(): Play {
  return {
    name: 'Horns PnR',
    steps: [
      { id: 1, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'moveTo', slot: 'SLOT_TOP_KEY' }],
        ['screener', { type: 'moveTo', slot: 'SLOT_RIGHT_ELBOW' }],
        ['postUp', { type: 'moveTo', slot: 'SLOT_LEFT_ELBOW' }],
        ['spacer', { type: 'moveTo', slot: 'SLOT_RIGHT_CORNER' }],
        ['cutter', { type: 'moveTo', slot: 'SLOT_LEFT_CORNER' }],
      ])},
      { id: 2, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'drive', direction: 'right' }],
        ['screener', { type: 'screen', target: 'ballHandler' }],
        ['postUp', { type: 'pop', slot: 'SLOT_LEFT_WING' }],  // weak side big pops
        ['spacer', { type: 'hold' }],
        ['cutter', { type: 'hold' }],
      ])},
      { id: 3, duration: 3, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'readAndReact' }],
        ['screener', { type: 'roll' }],
        ['postUp', { type: 'callForBall' }],
        ['spacer', { type: 'hold' }],
        ['cutter', { type: 'hold' }],
      ])},
    ]
  };
}

// 2. FLEX — Continuous screening action, great for ball movement
// Used by: Classic college play, used at NBA level for catch-and-shoot
function createFlex(): Play {
  return {
    name: 'Flex',
    steps: [
      { id: 1, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'moveTo', slot: 'SLOT_LEFT_WING' }],
        ['spacer', { type: 'moveTo', slot: 'SLOT_RIGHT_WING' }],
        ['screener', { type: 'moveTo', slot: 'SLOT_LOW_POST_R' }],
        ['cutter', { type: 'moveTo', slot: 'SLOT_RIGHT_CORNER' }],
        ['postUp', { type: 'moveTo', slot: 'SLOT_LEFT_ELBOW' }],
      ])},
      { id: 2, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'passTo', target: 'spacer' }],  // swing to right wing
        ['screener', { type: 'screen', target: 'cutter' }],     // flex screen on baseline
        ['cutter', { type: 'cut', from: 'SLOT_RIGHT_CORNER', to: 'SLOT_LOW_POST_L' }], // baseline cut
        ['postUp', { type: 'hold' }],
        ['spacer', { type: 'hold' }],
      ])},
      { id: 3, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'readAndReact' }],
        ['screener', { type: 'pop', slot: 'SLOT_RIGHT_ELBOW' }],  // pop after screen
        ['cutter', { type: 'callForBall' }],
        ['postUp', { type: 'relocate' }],
        ['spacer', { type: 'hold' }],
      ])},
    ]
  };
}

// 3. UCLA CUT — PG passes to wing, cuts off high post screen to basket
// Used by: Lakers (Showtime), many modern teams
function createUCLACut(): Play {
  return {
    name: 'UCLA Cut',
    steps: [
      { id: 1, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'moveTo', slot: 'SLOT_LEFT_WING' }],
        ['screener', { type: 'moveTo', slot: 'SLOT_LEFT_ELBOW' }],  // high post
        ['spacer', { type: 'moveTo', slot: 'SLOT_RIGHT_WING' }],
        ['cutter', { type: 'moveTo', slot: 'SLOT_RIGHT_CORNER' }],
        ['postUp', { type: 'moveTo', slot: 'SLOT_LOW_POST_R' }],
      ])},
      { id: 2, duration: 1.5, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'passTo', target: 'spacer' }],     // pass to wing
        ['screener', { type: 'screen', target: 'ballHandler' }],   // screen for PG
        ['spacer', { type: 'hold' }],
        ['cutter', { type: 'hold' }],
        ['postUp', { type: 'hold' }],
      ])},
      { id: 3, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'cut', from: 'SLOT_LEFT_WING', to: 'SLOT_LOW_POST_L' }], // UCLA cut to basket
        ['screener', { type: 'pop', slot: 'SLOT_TOP_KEY' }],
        ['spacer', { type: 'readAndReact' }],   // wing now has ball, reads
        ['cutter', { type: 'hold' }],
        ['postUp', { type: 'hold' }],
      ])},
      { id: 4, duration: 3, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'readAndReact' }],
        ['screener', { type: 'callForBall' }],
        ['spacer', { type: 'hold' }],
        ['cutter', { type: 'relocate' }],
        ['postUp', { type: 'hold' }],
      ])},
    ]
  };
}

// 4. SPAIN PnR — PnR with a backscreen on the roller's defender
// Used by: Spain national team, Raptors, modern NBA innovation
function createSpainPnR(): Play {
  return {
    name: 'Spain PnR',
    steps: [
      { id: 1, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'moveTo', slot: 'SLOT_TOP_KEY' }],
        ['screener', { type: 'moveTo', slot: 'SLOT_RIGHT_ELBOW' }],
        ['cutter', { type: 'moveTo', slot: 'SLOT_LEFT_WING' }],
        ['spacer', { type: 'moveTo', slot: 'SLOT_RIGHT_CORNER' }],
        ['postUp', { type: 'moveTo', slot: 'SLOT_LEFT_CORNER' }],
      ])},
      { id: 2, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'drive', direction: 'right' }],
        ['screener', { type: 'screen', target: 'ballHandler' }],
        ['cutter', { type: 'screen', target: 'screener' }],   // backscreen on roller's defender!
        ['spacer', { type: 'hold' }],
        ['postUp', { type: 'hold' }],
      ])},
      { id: 3, duration: 3, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'readAndReact' }],
        ['screener', { type: 'roll' }],          // rolls free because of backscreen
        ['cutter', { type: 'pop', slot: 'SLOT_LEFT_WING' }],  // pops to 3pt line
        ['spacer', { type: 'hold' }],
        ['postUp', { type: 'hold' }],
      ])},
    ]
  };
}

// 5. FLOPPY — Shooter runs off staggered screens for catch-and-shoot
// Used by: Warriors (Steph Curry), any team with elite shooters
function createFloppy(): Play {
  return {
    name: 'Floppy',
    steps: [
      { id: 1, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'moveTo', slot: 'SLOT_TOP_KEY' }],
        ['screener', { type: 'moveTo', slot: 'SLOT_LOW_POST_L' }],
        ['postUp', { type: 'moveTo', slot: 'SLOT_LOW_POST_R' }],
        ['cutter', { type: 'moveTo', slot: 'SLOT_LEFT_ELBOW' }],  // shooter starts at FT line
        ['spacer', { type: 'moveTo', slot: 'SLOT_RIGHT_CORNER' }],
      ])},
      { id: 2, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'hold' }],
        ['screener', { type: 'screen', target: 'cutter' }],  // first screen
        ['postUp', { type: 'screen', target: 'cutter' }],    // staggered second screen
        ['cutter', { type: 'cut', from: 'SLOT_LEFT_ELBOW', to: 'SLOT_RIGHT_WING' }],  // run off screens
        ['spacer', { type: 'hold' }],
      ])},
      { id: 3, duration: 3, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'passTo', target: 'cutter' }],  // feed the shooter
        ['screener', { type: 'roll' }],
        ['postUp', { type: 'pop', slot: 'SLOT_RIGHT_ELBOW' }],
        ['cutter', { type: 'shootIfOpen' }],
        ['spacer', { type: 'hold' }],
      ])},
    ]
  };
}

// 6. PICK AND ROLL (Side) — Classic side PnR
function createSidePnR(): Play {
  return {
    name: 'Side PnR',
    steps: [
      { id: 1, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'moveTo', slot: 'SLOT_RIGHT_WING' }],
        ['screener', { type: 'moveTo', slot: 'SLOT_RIGHT_ELBOW' }],
        ['spacer', { type: 'moveTo', slot: 'SLOT_LEFT_CORNER' }],
        ['cutter', { type: 'moveTo', slot: 'SLOT_LEFT_WING' }],
        ['postUp', { type: 'moveTo', slot: 'SLOT_RIGHT_CORNER' }],
      ])},
      { id: 2, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'drive', direction: 'left' }],
        ['screener', { type: 'screen', target: 'ballHandler' }],
        ['spacer', { type: 'hold' }],
        ['cutter', { type: 'hold' }],
        ['postUp', { type: 'relocate' }],
      ])},
      { id: 3, duration: 3, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'readAndReact' }],
        ['screener', { type: 'roll' }],
        ['spacer', { type: 'callForBall' }],
        ['cutter', { type: 'relocate' }],
        ['postUp', { type: 'hold' }],
      ])},
    ]
  };
}

// 7. POST UP — Classic post entry
function createPostUp(): Play {
  return {
    name: 'Post Up',
    steps: [
      { id: 1, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'moveTo', slot: 'SLOT_LEFT_WING' }],
        ['postUp', { type: 'moveTo', slot: 'SLOT_LOW_POST_L' }],
        ['screener', { type: 'moveTo', slot: 'SLOT_TOP_KEY' }],
        ['spacer', { type: 'moveTo', slot: 'SLOT_RIGHT_WING' }],
        ['cutter', { type: 'moveTo', slot: 'SLOT_RIGHT_CORNER' }],
      ])},
      { id: 2, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'entryPass', target: 'postUp' }],
        ['postUp', { type: 'callForBall' }],
        ['screener', { type: 'hold' }],
        ['spacer', { type: 'hold' }],
        ['cutter', { type: 'hold' }],
      ])},
      { id: 3, duration: 3, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['postUp', { type: 'readAndReact' }],
        ['ballHandler', { type: 'relocate' }],
        ['screener', { type: 'hold' }],
        ['spacer', { type: 'hold' }],
        ['cutter', { type: 'relocate' }],
      ])},
    ]
  };
}

// 8. ISO CLEAR — Clear one side for 1-on-1
function createISO(): Play {
  return {
    name: 'ISO Clear',
    steps: [
      { id: 1, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'moveTo', slot: 'SLOT_RIGHT_WING' }],
        ['screener', { type: 'moveTo', slot: 'SLOT_LEFT_CORNER' }],
        ['spacer', { type: 'moveTo', slot: 'SLOT_LEFT_WING' }],
        ['cutter', { type: 'moveTo', slot: 'SLOT_LEFT_ELBOW' }],
        ['postUp', { type: 'moveTo', slot: 'SLOT_LEFT_CORNER' }],
      ])},
      { id: 2, duration: 4, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'readAndReact' }],
        ['screener', { type: 'hold' }],
        ['spacer', { type: 'hold' }],
        ['cutter', { type: 'hold' }],
        ['postUp', { type: 'hold' }],
      ])},
    ]
  };
}

// 9. FAST BREAK — Push pace in transition
function createFastBreak(): Play {
  return {
    name: 'Fast Break',
    steps: [
      { id: 1, duration: 1.5, trigger: 'position', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'drive', direction: 'baseline' }],
        ['cutter', { type: 'cut', from: 'SLOT_LEFT_WING', to: 'SLOT_LEFT_CORNER' }],
        ['spacer', { type: 'cut', from: 'SLOT_RIGHT_WING', to: 'SLOT_RIGHT_CORNER' }],
        ['screener', { type: 'hold' }],
        ['postUp', { type: 'hold' }],
      ])},
      { id: 2, duration: 2, trigger: 'time', actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', { type: 'readAndReact' }],
        ['cutter', { type: 'callForBall' }],
        ['spacer', { type: 'callForBall' }],
        ['screener', { type: 'relocate' }],
        ['postUp', { type: 'relocate' }],
      ])},
    ]
  };
}

const PLAYBOOK: Play[] = [
  createHornsPnR(),
  createFlex(),
  createUCLACut(),
  createSpainPnR(),
  createFloppy(),
  createSidePnR(),
  createPostUp(),
  createISO(),
  createFastBreak(),
];

// ══════════════════════════════════════════════════════════════════════════
// 5. ROLE ASSIGNMENT SYSTEM
// ══════════════════════════════════════════════════════════════════════════

function assignRoles(state: GameState): void {
  // Don't reassign roles while a play is running — play needs stable role assignments
  if (state.currentPlay && state.roles.size > 0) {
    // Only update ballHandler role to track who has the ball
    const ballHandler = getBallHandler(state);
    if (ballHandler && !state.roles.has(ballHandler.id)) {
      // Ball was passed — new handler gets ballHandler role, old handler keeps their role
      const oldHandler = [...state.roles.entries()].find(([_, r]) => r === 'ballHandler');
      if (oldHandler) {
        // Give old handler the new handler's old role (or spacer)
        const newHandlerOldRole = state.roles.get(ballHandler.id) || 'spacer';
        state.roles.set(oldHandler[0], newHandlerOldRole);
      }
      state.roles.set(ballHandler.id, 'ballHandler');
    }
    // Update player references
    state.players.forEach(p => { p.currentRole = state.roles.get(p.id); });
    return;
  }

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
    
    // Always assign all 5 roles so plays work properly
    // Screener: best screen-setting big
    const screenCandidates = [...centers, ...forwards];
    if (screenCandidates.length > 0) {
      state.roles.set(screenCandidates[0].id, 'screener');
    }
    
    // PostUp: second big (or same C if only one)
    const postCandidates = remainingPlayers
      .filter(p => !state.roles.has(p.id))
      .filter(p => p.player.position === 'C' || p.player.position === 'PF');
    if (postCandidates.length > 0) {
      state.roles.set(postCandidates[0].id, 'postUp');
    } else if (screenCandidates.length > 0 && !state.roles.has(screenCandidates[0].id)) {
      // Fallback: if no second big, a forward fills both roles
    }
    
    // Cutter: most athletic remaining player
    const cutterCandidates = remainingPlayers
      .filter(p => !state.roles.has(p.id))
      .sort((a, b) => b.player.physical.speed - a.player.physical.speed);
    if (cutterCandidates.length > 0) {
      state.roles.set(cutterCandidates[0].id, 'cutter');
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
// 6. DEFENSIVE ASSIGNMENT SYSTEM (SYSTEM 4)
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
        // On-ball defense: stay between ball handler and basket, 3-4ft gap
        const basketDir = normalizeVector({
          x: basket.x - assignedOffPlayer.pos.x,
          y: basket.y - assignedOffPlayer.pos.y
        });
        
        // Defensive lateral quickness matters — better defenders stay tighter
        const perimD = defender.player.skills.defense?.perimeter_d || 70;
        const gap = 4 - (perimD / 100) * 1.5; // elite=2.5ft, avg=3.5ft
        
        defender.targetPos = {
          x: assignedOffPlayer.pos.x + basketDir.x * gap,
          y: assignedOffPlayer.pos.y + basketDir.y * gap
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

function handleScreenDefense(state: GameState): void {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const tactic = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
  
  for (const defender of defTeam) {
    const assignment = state.players.find(p => p.id === state.defAssignments.get(defender.id));
    if (!assignment) continue;
    
    // Check if assignment is being screened
    const screener = state.players.find(p => 
      p.teamIdx === state.possession && p.isScreening && 
      dist(p.pos, defender.pos) < 4
    );
    
    if (screener) {
      if (tactic === 'man') {
        // 50% switch, 50% fight through
        if (state.rng() < 0.5) {
          // SWITCH: swap assignments
          const screenerDefender = findDefenderOf(screener, state);
          if (screenerDefender) {
            swapAssignments(defender, screenerDefender, state);
          }
        } else {
          // FIGHT THROUGH: go around screen
          defender.targetPos = {
            x: assignment.pos.x + (assignment.pos.x > screener.pos.x ? 3 : -3),
            y: assignment.pos.y
          };
        }
      }
      // zone: ignore screen, stay in zone
      // press: always switch
    }
  }
}

function handleHelpDefense(state: GameState): void {
  const handler = getBallHandler(state);
  if (!handler) return;
  
  const basket = getTeamBasket(state.possession);
  const distToBasket = dist(handler.pos, basket);
  
  // Help defense triggers when ball handler penetrates within 15ft
  if (distToBasket < 15) {
    const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
    const offTeam = state.players.filter(p => p.teamIdx === state.possession);
    
    const ballDefender = findDefenderOf(handler, state);
    const helpCandidates = defTeam
      .filter(d => d !== ballDefender)
      .sort((a, b) => dist(a.pos, basket) - dist(b.pos, basket));
    
    if (helpCandidates.length > 0) {
      // PRIMARY HELP: closest defender steps into driving lane
      const helper = helpCandidates[0];
      helper.targetPos = {
        x: (handler.pos.x + basket.x) / 2,
        y: (handler.pos.y + basket.y) / 2
      };
      
      // ROTATION: next defender rotates to cover helper's man
      if (helpCandidates.length > 1) {
        const rotator = helpCandidates[1];
        const helperAssignment = state.defAssignments.get(helper.id);
        const abandonedPlayer = offTeam.find(p => p.id === helperAssignment);
        if (abandonedPlayer) {
          rotator.targetPos = {
            x: abandonedPlayer.pos.x + (basket.x - abandonedPlayer.pos.x) * 0.3,
            y: abandonedPlayer.pos.y + (basket.y - abandonedPlayer.pos.y) * 0.3
          };
          
          // SECOND ROTATION: third defender covers rotator's man
          if (helpCandidates.length > 2) {
            const secondRotator = helpCandidates[2];
            const rotatorAssignment = state.defAssignments.get(rotator.id);
            const secondAbandoned = offTeam.find(p => p.id === rotatorAssignment);
            if (secondAbandoned) {
              secondRotator.targetPos = {
                x: secondAbandoned.pos.x + (basket.x - secondAbandoned.pos.x) * 0.4,
                y: secondAbandoned.pos.y + (basket.y - secondAbandoned.pos.y) * 0.4
              };
            }
          }
        }
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 7. INTELLIGENT BASKETBALL FUNCTIONS (SYSTEM 2 & 3)
// ══════════════════════════════════════════════════════════════════════════

function isDefenderBetween(handler: SimPlayer, defender: SimPlayer, basket: Vec2): boolean {
  // Is the defender between the handler and the basket?
  const hToB = dist(handler.pos, basket);
  const dToB = dist(defender.pos, basket);
  const hToD = dist(handler.pos, defender.pos);
  // Defender is "between" if they're closer to basket AND close to the line
  return dToB < hToB && hToD < hToB * 0.7;
}

function checkIfWideOpen(player: SimPlayer, state: GameState): boolean {
  const defender = findNearestDefender(player, state);
  return !defender || dist(defender.pos, player.pos) > 8;
}

function getOpenTeammates(state: GameState, handler: SimPlayer): SimPlayer[] {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  return offTeam.filter(p => {
    if (p === handler) return false;
    const defender = findNearestDefender(p, state);
    return !defender || dist(defender.pos, p.pos) > 6;
  });
}

function findBestScorer(team: SimPlayer[]): SimPlayer {
  return team.reduce((best, p) => {
    const scoringSkill = (p.player.skills.shooting.three_point + p.player.skills.shooting.mid_range + p.player.skills.finishing.layup) / 3;
    const bestScoringSkill = (best.player.skills.shooting.three_point + best.player.skills.shooting.mid_range + best.player.skills.finishing.layup) / 3;
    
    // Superstar bonus
    const pScore = scoringSkill + (p.player.isSuperstar ? 20 : 0);
    const bestScore = bestScoringSkill + (best.player.isSuperstar ? 20 : 0);
    
    return pScore > bestScore ? p : best;
  });
}

function findDefenderOf(offPlayer: SimPlayer, state: GameState): SimPlayer | null {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  return defTeam.find(def => state.defAssignments.get(def.id) === offPlayer.id) || null;
}

function swapAssignments(def1: SimPlayer, def2: SimPlayer, state: GameState): void {
  const assignment1 = state.defAssignments.get(def1.id);
  const assignment2 = state.defAssignments.get(def2.id);
  
  if (assignment1) state.defAssignments.set(def2.id, assignment1);
  if (assignment2) state.defAssignments.set(def1.id, assignment2);
}

function executeReadAndReact(handler: SimPlayer, state: GameState, basketPos: Vec2): void {
  const distToBasket = dist(handler.pos, basketPos);
  const isOpen = checkIfOpen(handler, state);
  const isWideOpen = checkIfWideOpen(handler, state);
  const openTeammates = getOpenTeammates(state, handler);
  const holdTime = state.dribbleTime; // how long this player has had the ball
  
  // Only make decisions periodically (~every 0.5s), not 60x/sec
  // Exception: immediate reactions (layup range, wide open catch-and-shoot)
  const isDecisionTick = Math.floor(state.gameTime * 2) !== Math.floor((state.gameTime - 1/60) * 2);
  
  // 1. Layup/dunk range — always finish immediately
  if (distToBasket < 5) {
    attemptShot(state, handler, basketPos);
    return;
  }
  
  // SUPERSTAR TENDENCIES — signature plays
  if (handler.player.isSuperstar) {
    const skills = handler.player.skills;
    // Sharpshooter superstar: pull-up 3 more aggressively
    if (skills.shooting.three_point >= 90 && distToBasket > 22 && distToBasket < 30 && isOpen) {
      attemptShot(state, handler, basketPos);
      return;
    }
    // Athletic freak superstar: attack basket relentlessly
    if (skills.finishing.dunk >= 90 && distToBasket < 20) {
      const defAhead = findNearestDefender(handler, state);
      const laneClear = !defAhead || dist(defAhead.pos, handler.pos) > 3;
      if (laneClear) {
        const sDir = state.possession === 0 ? 1 : -1;
        handler.targetPos = { x: basketPos.x - sDir * 1, y: basketPos.y };
        handler.isCutting = true;
        return;
      }
    }
  }
  
  // 2. Wide open catch-and-shoot — react immediately (no decision tick needed)
  if (isWideOpen && holdTime < 0.5 && distToBasket > 22 && distToBasket < 27) {
    const three = handler.player.skills.shooting.three_point;
    if (three >= 70 || state.rng() < 0.7) {
      attemptShot(state, handler, basketPos);
      return;
    }
  }
  
  // For all other decisions, only evaluate every ~0.5s (not every tick)
  if (!isDecisionTick) return;
  
  // 3. Read the defense and decide
  const defAhead = findNearestDefender(handler, state);
  const defDist = defAhead ? dist(defAhead.pos, handler.pos) : 20;
  const defBetween = defAhead ? isDefenderBetween(handler, defAhead, basketPos) : false;
  const laneClear = defDist > 4 || !defBetween;
  
  // Aggression increases the longer you hold the ball (triple threat → attack)
  // 0-1s: patient, look to pass if good option
  // 1-2s: look to drive or shoot
  // 2s+: must attack, no more passing
  const aggressive = holdTime > 1.5;
  const mustAttack = holdTime > 3 || state.shotClock < 6;
  
  // 3a. DRIVE when lane is open — layup/dunk is best shot in basketball
  if (laneClear && distToBasket > 5 && distToBasket < 28) {
    const dir = state.possession === 0 ? 1 : -1;
    handler.targetPos = {
      x: basketPos.x - dir * 1,
      y: basketPos.y + (state.rng() > 0.5 ? 2 : -2),
    };
    handler.isCutting = true;
    return;
  }
  
  // 3b. Open mid-range — take it if aggressive
  if (isOpen && distToBasket < 22 && distToBasket > 5 && (aggressive || mustAttack)) {
    attemptShot(state, handler, basketPos);
    return;
  }
  
  // 3c. Open 3 — take it
  if (isOpen && distToBasket > 22 && distToBasket < 27) {
    const three = handler.player.skills.shooting.three_point;
    if (three >= 65 || aggressive) {
      attemptShot(state, handler, basketPos);
      return;
    }
  }
  
  // 4. Pass to create a better shot (but only if not holding too long)
  if (!mustAttack) {
    // Roller cutting to basket
    const roller = state.players.find(p => p.currentRole === 'screener' && p.teamIdx === state.possession);
    if (roller && checkIfOpen(roller, state) && dist(roller.pos, basketPos) < 12) {
      passBall(state, handler, roller);
      return;
    }
    
    // Open 3pt shooter
    const openThreeShooter = openTeammates.find(p => {
      const d = dist(p.pos, basketPos);
      return d > 22 && d < 27 && p.player.skills.shooting.three_point >= 70;
    });
    if (openThreeShooter) {
      passBall(state, handler, openThreeShooter);
      return;
    }
    
    // Swing pass (only in first ~1.5s of holding ball)
    if (!aggressive && openTeammates.length > 0) {
      const closest = openTeammates.sort((a, b) => dist(a.pos, handler.pos) - dist(b.pos, handler.pos));
      passBall(state, handler, closest[0]);
      return;
    }
  }
  
  // 5. Must score — take whatever shot
  if (distToBasket < 25) {
    attemptShot(state, handler, basketPos);
    return;
  }
  
  // 6. Dribble toward basket to create opportunity
  handler.targetPos = { x: basketPos.x, y: basketPos.y + (state.rng() - 0.5) * 4 };
  handler.isCutting = true;
}

// ══════════════════════════════════════════════════════════════════════════
// 8. COURT VISION & PASS INTELLIGENCE
// ══════════════════════════════════════════════════════════════════════════

function getPassOptions(state: GameState, ballHandler: SimPlayer): SimPlayer[] {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const candidates = offTeam.filter(p => {
    if (p === ballHandler) return false;
    
    // Don't pass back to immediate last passer for 1.5s
    if (state.lastPassFrom === p.id && state.gameTime - state.lastPassTime < 1.5) return false;
    
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
// 9. TICK/SIMULATION LOGIC
// ══════════════════════════════════════════════════════════════════════════

function tick(state: GameState): GameState {
  const dt = 1 / 60; // 1 tick = 1/60th of a second (matches requestAnimationFrame)
  state.phaseTicks++;
  state.gameTime += dt;

  // Update clocks
  if (state.phase !== 'jumpball' && state.gameStarted) {
    state.clockSeconds -= dt;
    state.shotClock -= dt;
    // Advance clock only ticks during advance phase (after inbound pass)
    if (state.phase === 'advance') {
      state.advanceClock += dt;
    }
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

  // Update catch timers
  for (const p of state.players) {
    if (p.catchTimer > 0) {
      p.catchTimer = Math.max(0, p.catchTimer - dt);
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
      } else {
        // While shot is in flight: players crash boards or get back
        const basket = getTeamBasket(state.possession);
        for (const p of offTeam) {
          // Bigs crash offensive glass, guards get back for transition D
          const isBig = p.player.position === 'C' || p.player.position === 'PF';
          if (isBig) {
            p.targetPos = { x: basket.x, y: basket.y + (p.courtIdx % 2 === 0 ? -4 : 4) };
          } else {
            // Guards drift back toward half court (transition safety)
            p.targetPos = { x: HALF_X + (state.possession === 0 ? -8 : 8), y: p.pos.y };
          }
        }
        for (const d of defTeam) {
          // All defenders crash the boards / box out position
          d.targetPos = {
            x: basket.x - (state.possession === 0 ? 1 : -1) * (4 + d.courtIdx * 2),
            y: basket.y + (d.courtIdx - 2) * 4
          };
        }
      }
      break;
    case 'rebound':
      handleRebound(state, offTeam, defTeam);
      break;
    case 'freethrow':
      handleFreeThrows(state);
      break;
  }

  // Defense: only run full assignments during setup/action
  // During inbound/advance, defense retreats (targets set by handleInbound/handleAdvance/resetPossession)
  if (state.phase === 'action' || state.phase === 'setup') {
    updateDefenseAssignments(state);
    handleScreenDefense(state);
    handleHelpDefense(state);
    processHelpDefense(state);
  } else if (state.phase === 'inbound' || state.phase === 'advance') {
    // Defense retreats — targets already set, just let them move
    // Only update sliding state
    const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
    defTeam.forEach(d => { d.isDefensiveSliding = false; });
  }
  
  // Update offensive systems
  if (state.phase === 'action' || state.phase === 'setup') {
    assignRoles(state);
    // NOTE: updateCurrentPlay is called ONLY inside handleAction (not here)
    enforceFloorSpacing(state);
    fillEmptySlots(state);
  }
  // Off-ball movement during action only (not setup — players still positioning)
  if (state.phase === 'action') {
    offBallMovement(state, offTeam, basketPos, dir);
  }

  // Move all players
  for (const p of state.players) {
    movePlayerToward(p, dt, state);
  }
  
  // Reset per-frame flags AFTER movement (so next tick's phase handlers set them fresh)
  for (const p of state.players) {
    p.isDefensiveSliding = false;
    p.isCutting = false;
    p.isScreening = false;
    if (!p.hasBall) p.isDribbling = false;
  }

  // Ball follows carrier
  if (state.ball.carrier && !state.ball.inFlight && !state.ball.bouncing) {
    state.ball.pos = { ...state.ball.carrier.pos };
    state.ball.z = 4; // dribble height
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

  if (state.phaseTicks > 180) {
    // Execute jump ball (~3 seconds)
    executeJumpBall(state, centers);
  }
}

function handleInbound(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[], dir: number): void {
  const ownBasket = getOwnBasket(state.possession);
  const oppBasket = getTeamBasket(state.possession); // basket offense attacks
  
  // Defense retreats ENTIRE inbound phase — sprint back to their defensive half
  const defDir = state.possession === 0 ? 1 : -1;
  for (let i = 0; i < defTeam.length; i++) {
    // Stagger positions: guards further out, center near basket
    const depthOrder = [3, 4, 2, 1, 0]; // PG/SG further out, C closest to basket
    const depth = depthOrder[i] || i;
    defTeam[i].targetPos = {
      x: oppBasket.x - defDir * (6 + depth * 5),
      y: BASKET_Y + (i - 2) * 7
    };
  }
  
  // Stage 1 (0-2.5s): Set up inbound — ref handles ball, players get in position
  if (state.phaseTicks < 150) {
    // Inbounder stands OUT OF BOUNDS behind baseline
    const inbounder = offTeam[0];
    const baselineX = dir > 0 ? 0.5 : COURT_W - 0.5;
    inbounder.targetPos = { x: baselineX, y: BASKET_Y + 5 };
    
    // Give ball to inbounder
    if (!getBallHandler(state)) {
      clearBallCarrier(state);
      inbounder.hasBall = true;
      state.ball.carrier = inbounder;
    }
    
    // Receivers spread out to get open
    const receiverSpots = [
      { x: ownBasket.x + dir * 12, y: BASKET_Y - 8 },
      { x: ownBasket.x + dir * 15, y: BASKET_Y + 8 },
      { x: ownBasket.x + dir * 20, y: BASKET_Y },
      { x: ownBasket.x + dir * 10, y: BASKET_Y + 15 },
    ];
    for (let i = 1; i < offTeam.length; i++) {
      offTeam[i].targetPos = { ...receiverSpots[Math.min(i - 1, receiverSpots.length - 1)] };
    }
    
  // Stage 2 (2.5-4s): Receiver cuts toward ball
  } else if (state.phaseTicks < 240) {
    const inbounder = getBallHandler(state);
    if (inbounder) {
      const receiver = offTeam.find(p => p !== inbounder && p.player.position === 'PG') 
        || offTeam.find(p => p !== inbounder);
      if (receiver) {
        receiver.targetPos = {
          x: inbounder.pos.x + dir * 6,
          y: inbounder.pos.y + (state.rng() - 0.5) * 4
        };
      }
    }
    
  // Stage 3 (4s+): Execute inbound pass
  } else {
    const inbounder = getBallHandler(state);
    if (inbounder) {
      const receivers = offTeam
        .filter(p => p !== inbounder)
        .sort((a, b) => dist(a.pos, inbounder.pos) - dist(b.pos, inbounder.pos));
      
      if (receivers.length > 0) {
        passBall(state, inbounder, receivers[0]);
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
  
  // Ball handler advances — PG dribbles up the middle
  handler.targetPos = { x: basketPos.x - dir * 22, y: BASKET_Y };
  
  // Transition offense: wings run wide lanes, trailer fills middle
  const wings = offTeam.filter(p => p !== handler && (p.player.position === 'SF' || p.player.position === 'SG'));
  const bigs = offTeam.filter(p => p !== handler && (p.player.position === 'PF' || p.player.position === 'C'));
  const others = offTeam.filter(p => p !== handler && !wings.includes(p) && !bigs.includes(p));
  
  // Wings sprint wide lanes (fast break)
  wings.forEach((w, i) => {
    w.targetPos = {
      x: basketPos.x - dir * 18,
      y: BASKET_Y + (i === 0 ? -16 : 16) // wide lanes
    };
  });
  
  // Bigs trail — slower, fill lane behind
  bigs.forEach((b, i) => {
    b.targetPos = {
      x: basketPos.x - dir * (28 + i * 4), // trail behind
      y: BASKET_Y + (i === 0 ? -6 : 6)
    };
  });
  
  // Others fill gaps
  others.forEach((p, i) => {
    p.targetPos = {
      x: basketPos.x - dir * 24,
      y: BASKET_Y + (i === 0 ? -10 : 10)
    };
  });
  
  // Defense continues retreating — pack the paint, guards get to perimeter
  for (let i = 0; i < defTeam.length; i++) {
    const isGuard = defTeam[i].player.position === 'PG' || defTeam[i].player.position === 'SG';
    defTeam[i].targetPos = {
      x: basketPos.x - dir * (isGuard ? 18 : 8 + i * 2),
      y: BASKET_Y + (i - 2) * 6
    };
  }
  
  // Check if advanced enough (ball handler past half court + 8ft)
  if (Math.abs(handler.pos.x - HALF_X) > 8) {
    // Fast break detection: if most defenders haven't crossed half court, skip setup
    const defPastHalf = defTeam.filter(d => {
      return state.possession === 0 
        ? d.pos.x > HALF_X + 10  // team 0 attacks right
        : d.pos.x < HALF_X - 10; // team 1 attacks left
    }).length;
    
    if (defPastHalf <= 2) {
      // Fast break! Skip setup, go straight to action
      state.phase = 'action';
      state.phaseTicks = 0;
      state.advanceClock = 0;
      // Auto-select fast break play
      state.currentPlay = PLAYBOOK.find(p => p.name === 'Fast Break') || null;
      state.currentStep = 0;
      state.stepTimer = 0;
      state.lastEvent = `Fast break! ${handler.player.name} pushes the pace!`;
    } else {
      state.phase = 'setup';
      state.phaseTicks = 0;
      state.advanceClock = 0;
    }
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
  
  if (state.phaseTicks > 120) {
    // Select and start play (~2 seconds to set up)
    selectPlay(state, offTeam);
    state.phase = 'action';
    state.phaseTicks = 0;
  }
}

function handleAction(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[], basketPos: Vec2, dir: number): void {
  const handler = getBallHandler(state);
  if (!handler) return;
  
  // Can't act while catching the ball
  if (handler.catchTimer > 0) return;
  
  // Set dribble state and track how long this player has held the ball
  handler.isDribbling = true;
  state.dribbleTime += 1 / 60;
  
  // Update possession stage
  state.possessionStage = getPossessionStage(state.shotClock);
  
  // If a play is active, let the play drive decisions
  if (state.currentPlay) {
    updateCurrentPlay(state, basketPos, dir);
    // Play's readAndReact/passTo/shootIfOpen will handle ball decisions
    return; // DON'T also run random decisions
  }
  
  // No play active — use decision tree based on possession stage
  switch (state.possessionStage) {
    case 'early':
      // Select and run a play
      selectPlay(state, offTeam);
      return; // play will run next tick via updateCurrentPlay
      
    case 'mid':
      // Play finished, read & react
      executeReadAndReact(handler, state, basketPos);
      break;
      
    case 'late':
      // Give to best scorer, take shots
      const bestScorer = findBestScorer(offTeam);
      if (handler !== bestScorer && checkIfOpen(bestScorer, state)) {
        passBall(state, handler, bestScorer);
      } else {
        // More aggressive shot taking
        const distToBasket = dist(handler.pos, basketPos);
        if (distToBasket < 25) attemptShot(state, handler, basketPos);
        else executeReadAndReact(handler, state, basketPos);
      }
      break;
      
    case 'desperation':
      attemptShot(state, handler, basketPos);
      break;
  }
  
  // Steal attempts — check once per ~5 seconds (every 50 ticks)
  // NBA reference: best stealers ~2.0 steals/game, avg ~0.8/game
  // ~100 possessions/team → elite = 2%, avg = 0.8%
  // Skill 96 (S) → ~2.5%, skill 60 (D) → ~0.5%
  const nearestDefender = findNearestDefender(handler, state);
  if (nearestDefender && dist(nearestDefender.pos, handler.pos) < 2.5 && state.phaseTicks % 300 === 0) {
    const stealSkill = nearestDefender.player.skills.defense.steal;
    const stealChance = 0.001 + (stealSkill / 100) * 0.012; // D(60)=0.8%, S(96)=1.3%
    if (state.rng() < stealChance) {
      clearBallCarrier(state);
      nearestDefender.hasBall = true;
      state.ball.carrier = nearestDefender;
      state.lastEvent = `${nearestDefender.player.name} steals the ball!`;
      changePossession(state, '');
    }
  }
}

function handleFreeThrows(state: GameState): void {
  if (!state.freeThrows) return;
  const ft = state.freeThrows;
  
  // Position players along the lane
  if (state.phaseTicks === 1) {
    const basket = getTeamBasket(state.possession);
    ft.shooter.targetPos = { ...basket };
    ft.shooter.targetPos.x += (state.possession === 0 ? -1 : 1) * 15; // FT line
    state.lastEvent = `${ft.shooter.player.name} at the line (${ft.made}/${ft.total})`;
  }
  
  // Shoot each FT at ~1.5s intervals
  const ftIndex = ft.made + (state.phaseTicks > 90 ? 1 : 0);
  
  if (state.phaseTicks === 90 || state.phaseTicks === 180) {
    // Attempt a free throw
    const ftSkill = ft.shooter.player.skills.shooting?.free_throw || 75;
    const ftPct = 0.5 + (ftSkill / 100) * 0.35; // range: 50%-85%
    const made = state.rng() < ftPct;
    
    if (made) {
      state.score[state.possession] += 1;
      ft.made++;
      state.lastEvent = `${ft.shooter.player.name} makes FT ${ft.made}/${ft.total} (${state.score[0]}-${state.score[1]})`;
    } else {
      state.lastEvent = `${ft.shooter.player.name} misses FT`;
    }
    
    const isLastFT = (state.phaseTicks === 90 && ft.total === 1) || state.phaseTicks === 180;
    
    if (isLastFT) {
      if (!made) {
        // Last FT missed — rebound
        const basket = getTeamBasket(state.possession);
        state.ball.pos = { ...basket };
        state.ball.bounceTarget = { 
          x: basket.x + (state.rng() - 0.5) * 8,
          y: basket.y + (state.rng() - 0.5) * 6
        };
        state.ball.bouncing = true;
        state.ball.bounceProgress = 0;
        state.phase = 'rebound';
        state.phaseTicks = 0;
      } else {
        // Last FT made — other team inbounds
        changePossession(state, '');
      }
      state.freeThrows = null;
    }
  }
}

function handleRebound(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[]): void {
  const basket = getTeamBasket(state.possession);
  
  // Stage 1: Ball bouncing off rim with physics
  if (state.ball.bouncing) {
    state.ball.bounceProgress += 0.013;
    const t = Math.min(1, state.ball.bounceProgress);
    
    state.ball.pos.x = basket.x + (state.ball.bounceTarget.x - basket.x) * t;
    state.ball.pos.y = basket.y + (state.ball.bounceTarget.y - basket.y) * t;
    
    const dampedBounce = 10 * Math.exp(-3 * t) * Math.abs(Math.cos(6 * Math.PI * t));
    state.ball.z = Math.max(0, dampedBounce);
    
    if (t >= 1) {
      state.ball.bouncing = false;
      state.ball.z = 0;
    }
  }
  
  const reboundPos = state.ball.bouncing ? state.ball.bounceTarget : state.ball.pos;
  
  // Stage 2: Box out + crash boards (~1.5s)
  if (state.phaseTicks < 90) {
    // DEFENDERS: box out — get between their man and the rebound spot
    for (let i = 0; i < defTeam.length; i++) {
      const def = defTeam[i];
      const matchup = offTeam[i] || offTeam[0];
      
      const mx = matchup.pos.x, my = matchup.pos.y;
      const rx = reboundPos.x, ry = reboundPos.y;
      const toRebX = rx - mx, toRebY = ry - my;
      const toRebD = Math.sqrt(toRebX * toRebX + toRebY * toRebY) || 1;
      
      // Box out: stand between matchup and rebound
      def.targetPos = {
        x: mx + (toRebX / toRebD) * 2,
        y: my + (toRebY / toRebD) * 2
      };
    }
    
    // OFFENSIVE players: bigs crash, guards get back
    for (const off of offTeam) {
      const isBig = off.player.position === 'C' || off.player.position === 'PF';
      if (isBig && dist(off.pos, reboundPos) < 18) {
        const angle = state.rng() * Math.PI * 2;
        off.targetPos = {
          x: reboundPos.x + Math.cos(angle) * 3,
          y: reboundPos.y + Math.sin(angle) * 3
        };
      } else {
        // Guards stay back for transition
        off.targetPos = { x: HALF_X, y: off.pos.y };
      }
    }
    return;
  }
  
  // Stage 3: Ball is grabbed
  if (state.phaseTicks >= 90) {
    const nearPlayers = [...state.players]
      .filter(p => dist(p.pos, reboundPos) < 15)
      .sort((a, b) => dist(a.pos, reboundPos) - dist(b.pos, reboundPos));
    
    const competitors = nearPlayers.length > 0 
      ? nearPlayers.slice(0, 6) 
      : [...state.players].sort((a, b) => dist(a.pos, reboundPos) - dist(b.pos, reboundPos)).slice(0, 3);
      
    let rebounder = competitors[0];
    let bestValue = -1;
    
    for (const p of competitors) {
      const rebSkill = p.player.skills.athletic.rebounding;
      const height = p.player.physical.height;
      const vertical = p.player.physical.vertical;
      const proximity = Math.max(0.1, 15 - dist(p.pos, reboundPos));
      
      // NBA: ~70% defensive rebounds. Box-out is huge advantage
      const isDefender = p.teamIdx !== state.possession;
      const boxOutBonus = isDefender ? 1.8 : 1.0;
      
      // Bigs naturally better at rebounding
      const posBonus = p.player.position === 'C' ? 1.3 
        : p.player.position === 'PF' ? 1.15 : 1.0;
      
      const value = skillModifier(rebSkill) * (height / 180) * (vertical / 70) 
        * proximity * boxOutBonus * posBonus * (0.5 + state.rng() * 0.5);
      
      if (value > bestValue) {
        bestValue = value;
        rebounder = p;
      }
    }
    
    clearBallCarrier(state);
    rebounder.hasBall = true;
    state.ball.carrier = rebounder;
    
    const rebType = rebounder.teamIdx !== state.possession ? 'defensive' : 'offensive';
    state.lastEvent = `${rebounder.player.name} grabs the ${rebType} rebound!`;
    
    if (rebounder.teamIdx !== state.possession) {
      state.possession = rebounder.teamIdx;
      state.shotClock = 24;
      state.crossedHalfCourt = false;
      state.advanceClock = 0;
      
      // Outlet pass to PG
      const newOffTeam = state.players.filter(p => p.teamIdx === state.possession);
      const pg = newOffTeam.find(p => p.player.position === 'PG' && p !== rebounder);
      if (pg && rebounder.player.position !== 'PG') {
        passBall(state, rebounder, pg);
        state.lastEvent = `${rebounder.player.name} outlets to ${pg.player.name}!`;
      }
      
      state.phase = 'advance';
      state.phaseTicks = 0;
      state.currentPlay = null;
      state.slots.clear();
      state.roles.clear();
      state.defAssignments.clear();
      state.playCompleted = false;
    } else {
      state.shotClock = 14;
      state.phase = 'setup';
      state.phaseTicks = 0;
    }
  }
}
function updateCurrentPlay(state: GameState, basketPos: Vec2, dir: number): void {
  if (!state.currentPlay) return;
  
  state.stepTimer += 1 / 60;
  
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
  } else if (currentStep.trigger === 'position') {
    if (currentStep.triggerCondition) {
      shouldAdvance = currentStep.triggerCondition();
    } else {
      // No condition defined — fallback to time
      shouldAdvance = state.stepTimer >= currentStep.duration;
    }
  }
  
  // Safety: no step should last more than 5 seconds
  if (state.stepTimer >= 5) {
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
        // Drive straight to basket (fast break)
        driveTarget = { ...basketPos };
      }
      player.targetPos = driveTarget;
      player.isCutting = true; // sprint
      
      // Auto-shoot when arriving at basket during drive
      if (player.hasBall && dist(player.pos, basketPos) < 5) {
        attemptShot(state, player, basketPos);
      }
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
    
    // NEW ball actions:
    case 'passTo':
      const handler = getBallHandler(state);
      if (handler && handler === player) {
        const targetPlayer = state.players.find(p => p.currentRole === action.target && p.teamIdx === state.possession);
        if (targetPlayer && targetPlayer !== handler) {
          passBall(state, handler, targetPlayer);
        }
      }
      break;
      
    case 'shootIfOpen':
      const ballHandler = getBallHandler(state);
      if (ballHandler && ballHandler === player) {
        const isOpen = checkIfOpen(player, state); // defender > 6ft
        if (isOpen) {
          attemptShot(state, player, basketPos);
        }
      }
      break;
      
    case 'readAndReact':
      const currentHandler = getBallHandler(state);
      if (currentHandler && currentHandler === player) {
        executeReadAndReact(player, state, basketPos);
      }
      break;
      
    case 'callForBall':
      // This affects pass selection in readAndReact - player signals they want the ball
      // Implementation is handled in readAndReact logic
      break;
      
    case 'entryPass':
      const passer = getBallHandler(state);
      if (passer && passer === player) {
        const postPlayer = state.players.find(p => p.currentRole === action.target && p.teamIdx === state.possession);
        if (postPlayer && postPlayer !== passer) {
          // Check if entry pass lane is clear
          if (!isPassLaneBlocked(passer, postPlayer, state)) {
            passBall(state, passer, postPlayer);
          }
        }
      }
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
  
  // Speed with meaningful attribute differences
  // Speed 60 = 10 ft/s, Speed 80 = 16 ft/s, Speed 95 = 21 ft/s
  const speedAttr = player.player.physical.speed;
  const rawSpeed = 4 + (speedAttr / 100) * 18; // range: 4-22 ft/s
  let baseSpeed = rawSpeed * (1 - player.fatigue * 0.3);
  
  // Movement state modifiers
  if (player.isDefensiveSliding) {
    // Lateral defense: perimeter_d skill affects slide speed
    const perimD = player.player.skills.defense?.perimeter_d || 70;
    baseSpeed *= 0.6 + (perimD / 100) * 0.2; // range: 0.6 (bad) to 0.8 (elite)
  }
  if (player.isCutting) baseSpeed *= 1.2;
  if (player.isDribbling) baseSpeed *= 0.8;          // dribbling slows you down
  if (player.catchTimer > 0) baseSpeed *= 0.3;       // catching the ball — nearly stationary
  
  // Sprint/jog: far = sprint, close = controlled
  if (d > 25) {
    baseSpeed *= 1.15; // full sprint in transition
    player.sprintTimer += dt;
  } else if (d < 5) {
    baseSpeed *= 0.7; // controlled near destination
    player.sprintTimer = Math.max(0, player.sprintTimer - dt * 2);
  } else {
    player.sprintTimer = Math.max(0, player.sprintTimer - dt);
  }
  
  // Sprint fatigue: can't sprint forever (decays after ~4 sec continuous sprint)
  if (player.sprintTimer > 4) {
    baseSpeed *= 0.85;
  }
  
  const accelAttr = player.player.physical.acceleration;
  const accel = 5 + (accelAttr / 100) * 15; // range: 5-20
  const targetVx = (dx / d) * baseSpeed;
  const targetVy = (dy / d) * baseSpeed;
  const blend = Math.min(1, accel * dt * 0.4);
  
  player.vel.x += (targetVx - player.vel.x) * blend;
  player.vel.y += (targetVy - player.vel.y) * blend;
  player.pos.x += player.vel.x * dt;
  player.pos.y += player.vel.y * dt;
  
  // Collision avoidance — repulsion from nearby players
  for (const other of state.players) {
    if (other === player) continue;
    const dx2 = player.pos.x - other.pos.x;
    const dy2 = player.pos.y - other.pos.y;
    const d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    if (d2 < 2.5 && d2 > 0.01) {
      const pushStrength = (2.5 - d2) * 0.3;
      player.pos.x += (dx2 / d2) * pushStrength * dt;
      player.pos.y += (dy2 / d2) * pushStrength * dt;
    }
  }

  // Boundary constraints
  player.pos.x = clamp(player.pos.x, 1, COURT_W - 1);
  player.pos.y = clamp(player.pos.y, 1, COURT_H - 1);
  
  // Update fatigue
  player.fatigue = Math.min(1, player.fatigue + dt * 0.001 * (1 - player.player.physical.stamina / 100));
  
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
    // Regular flight with z-arc
    state.ball.pos.x = state.ball.flightFrom.x + (state.ball.flightTo.x - state.ball.flightFrom.x) * t;
    state.ball.pos.y = state.ball.flightFrom.y + (state.ball.flightTo.y - state.ball.flightFrom.y) * t;
    
    // Parabolic arc: z = fromZ + (peakZ-fromZ)*4*t*(1-t) for peak at t=0.5
    // At t=0: z = fromZ. At t=0.5: z = peakZ. At t=1: z ≈ fromZ (or rim height for shots)
    const fromZ = state.ball.flightFromZ;
    const peakZ = state.ball.flightPeakZ;
    const endZ = state.ball.isShot ? 10 : 5; // shots end at rim height, passes at chest
    // Quadratic bezier: z = (1-t)²*fromZ + 2*(1-t)*t*peakZ + t²*endZ  
    state.ball.z = (1-t)*(1-t)*fromZ + 2*(1-t)*t*peakZ + t*t*endZ;

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
          const scoreType = pts === 3 ? '3-pointer' : shotDistance < 5 ? 'layup' : `${pts}pts`;
          state.lastEvent = `${shooterName} scores! ${scoreType} (${state.score[0]}-${state.score[1]})`;
          changePossession(state, '');
        } else {
          // Miss — start bounce animation
          const basket = getTeamBasket(state.possession);
          const missType = state.ball.missType || 'rim_out';
          const dir = state.possession === 0 ? 1 : -1;
          
          // Where does the ball bounce to?
          let bounceTarget: Vec2;
          switch (missType) {
            case 'airball':
              bounceTarget = { x: basket.x - dir * 4, y: basket.y + (state.rng() - 0.5) * 12 };
              break;
            case 'back_iron':
              // Long rebound — bounces out toward perimeter
              bounceTarget = { x: basket.x - dir * (10 + state.rng() * 6), y: basket.y + (state.rng() - 0.5) * 14 };
              break;
            case 'front_rim':
              // Short rebound — stays near basket
              bounceTarget = { x: basket.x - dir * (2 + state.rng() * 4), y: basket.y + (state.rng() - 0.5) * 6 };
              break;
            default: // rim_out
              bounceTarget = { x: basket.x - dir * (4 + state.rng() * 8), y: basket.y + (state.rng() - 0.5) * 10 };
              break;
          }
          
          state.ball.bouncing = true;
          state.ball.bounceTarget = bounceTarget;
          state.ball.bounceProgress = 0;
          state.phase = 'rebound';
          state.phaseTicks = 0;
          
          const missTexts: Record<string, string[]> = {
            'airball': ['Airball!', 'Way off! Airball!'],
            'rim_out': ['Rims out!', 'Spins out!', 'In and out!'],
            'back_iron': ['Off the back iron!', 'Clanks off the rim!', 'Hits back iron, long rebound!'],
            'front_rim': ['Front rim!', 'Short! Off the front rim!'],
          };
          const texts = missTexts[missType] || ['Miss!'];
          state.lastEvent = texts[Math.floor(state.rng() * texts.length)];
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
          closest.isDribbling = true;
          // Catch delay: 0.3-0.6s depending on ball handling skill
          const handling = closest.player.skills.playmaking?.ball_handling || 70;
          closest.catchTimer = 0.6 - (handling / 100) * 0.3; // elite=0.3s, avg=0.4s
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
  const rng = state.rng;
  
  // Tactic-specific play selection with variety
  let candidates: string[];
  
  switch (tactic) {
    case 'fast_break':
      candidates = ['Fast Break'];
      break;
    case 'iso':
      candidates = ['ISO Clear'];
      break;
    case 'inside':
      candidates = ['Post Up', 'Horns PnR'];
      break;
    case 'shoot':
      // Shooting teams favor plays that generate open 3s
      candidates = ['Floppy', 'Horns PnR', 'Flex', 'Spain PnR'];
      break;
    case 'motion':
    default:
      // Balanced selection — variety is key
      candidates = ['Horns PnR', 'Side PnR', 'UCLA Cut', 'Flex', 'Spain PnR', 'Floppy'];
      break;
  }
  
  const playName = candidates[Math.floor(rng() * candidates.length)];
  const selectedPlay = PLAYBOOK.find(p => p.name === playName) || PLAYBOOK[0];
  
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
  state.ball.flightFromZ = 7; // release point ~7ft (overhead)
  // Arc height depends on distance — further = higher arc
  state.ball.flightPeakZ = 10 + distToBasket * 0.3; // rim is 10ft, arc goes above
  state.ball.flightProgress = 0;
  state.ball.flightDuration = 0.6 + distToBasket * 0.02;
  state.ball.isShot = true;
  state.ball.shotWillScore = willScore;
  
  // Determine miss type
  if (!willScore) {
    const missRoll = state.rng();
    if (distToBasket > 25 && missRoll < 0.15) {
      state.ball.missType = 'airball';
    } else if (missRoll < 0.35) {
      state.ball.missType = 'rim_out';
    } else if (missRoll < 0.55) {
      state.ball.missType = 'back_iron';
    } else if (missRoll < 0.75) {
      state.ball.missType = 'front_rim';
    } else {
      state.ball.missType = 'rim_out';
    }
  } else {
    state.ball.missType = null;
  }
  
  // FOUL CHECK — fouls happen more on drives/layups when contested
  // NBA: ~22 FTA/game per team, ~80-90 possessions, ~25% of shots are at rim
  const isFouled = (() => {
    if (contestDistance > 6) return false; // no contest = no foul
    let foulChance = 0;
    if (distToBasket < 5) foulChance = 0.15;       // layup/dunk — most fouls
    else if (distToBasket < 10) foulChance = 0.08;  // floater range
    else if (distToBasket < 22) foulChance = 0.03;  // mid-range
    else foulChance = 0.04;                          // 3pt foul (rarer but happens)
    if (contestDistance < 3) foulChance *= 1.5;      // heavily contested = more contact
    return state.rng() < foulChance;
  })();
  
  if (isFouled) {
    const pts = distToBasket > 22 ? 3 : 2;
    if (willScore) {
      // AND-ONE! Shot counts + 1 FT
      state.score[state.possession] += pts;
      state.lastEvent = `AND ONE! ${shooterName} scores ${pts} + FT! (${state.score[0]}-${state.score[1]})`;
      state.freeThrows = { shooter, made: 0, total: 1, andOne: true };
    } else {
      // Shooting foul — 2 or 3 FTs
      state.lastEvent = `Shooting foul on ${shooterName}! ${pts} free throws`;
      state.freeThrows = { shooter, made: 0, total: pts, andOne: false };
    }
    clearBallCarrier(state);
    shooter.hasBall = true;
    state.ball.carrier = shooter;
    state.phase = 'freethrow';
    state.phaseTicks = 0;
    state.currentPlay = null;
    return;
  }
  
  (state.ball as any).shooterName = shooterName;
  (state.ball as any).shooterPossession = state.possession;
  
  const contestStr = contestDistance < 3 ? ' (contested)' : contestDistance < 6 ? '' : ' (open)';
  const shotType = distToBasket > 22 ? '3PT' : distToBasket > 10 ? 'mid-range' : distToBasket > 5 ? 'floater' : 'layup';
  const playContext = state.currentPlay ? `[${state.currentPlay.name}] ` : '';
  
  clearBallCarrier(state);
  state.phase = 'shooting';
  state.currentPlay = null;
  
  state.lastEvent = `${playContext}${shooterName} ${shotType}${contestStr}`;
}

type PassType = 'chest' | 'bounce' | 'lob' | 'overhead';

function choosePassType(from: SimPlayer, to: SimPlayer, defTeam: SimPlayer[], rng: () => number): PassType {
  const passDist = dist(from.pos, to.pos);
  
  // Check if any defender is directly between passer and target
  let defenderInLane = false;
  for (const def of defTeam) {
    const dToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    if (dToLine < 3 && dist(def.pos, from.pos) < passDist) {
      defenderInLane = true;
      break;
    }
  }
  
  if (defenderInLane) {
    // Smart pass: go over or under the defender
    if (rng() < 0.4) return 'lob';      // high over defender
    if (rng() < 0.5) return 'bounce';    // under defender's hands
    return 'overhead';                    // overhead pass
  }
  
  // No defender in lane — standard pass
  if (passDist > 20) return 'overhead';   // long pass = overhead
  if (passDist < 8) return 'chest';       // short = chest
  return rng() < 0.7 ? 'chest' : 'bounce';
}

function getPassZ(passType: PassType, t: number, passDist: number): { fromZ: number; peakZ: number } {
  switch (passType) {
    case 'chest':    return { fromZ: 5, peakZ: 5.5 + passDist * 0.02 };
    case 'bounce':   return { fromZ: 4, peakZ: 2 };  // goes DOWN then back up
    case 'lob':      return { fromZ: 7, peakZ: 12 + passDist * 0.1 };  // high arc
    case 'overhead': return { fromZ: 8, peakZ: 9 + passDist * 0.05 };
  }
}

function passBall(state: GameState, from: SimPlayer, to: SimPlayer): void {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const passDist = dist(from.pos, to.pos);
  
  // Choose pass type based on situation (smart passing over/under defenders)
  const passType = choosePassType(from, to, defTeam, state.rng);
  const passZ = getPassZ(passType, 0, passDist);
  
  // Check for interception — z-coordinate matters!
  for (const def of defTeam) {
    const dToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    const defDist = dist(def.pos, from.pos);
    
    if (dToLine < 2 && defDist < passDist && defDist > 2) {
      // Defender is in the passing lane — but can they reach the ball?
      const stealSkill = def.player.skills.defense.steal;
      let baseChance = 0.0005 + (stealSkill / 100) * 0.006; // D(60)=0.4%, S(96)=0.6%
      
      // Z-factor: how reachable is the ball at this point?
      // Defender reach height ~8ft standing, ~9ft jumping
      const defReach = 8 + (def.player.physical.height / 200) * 1.5; // taller = higher reach
      
      if (passType === 'lob' && passZ.peakZ > defReach) {
        baseChance *= 0.1;  // Lob over defender — very hard to intercept
      } else if (passType === 'bounce') {
        baseChance *= 0.5;  // Bounce pass — harder to intercept (low)
      } else if (passType === 'overhead' && passZ.peakZ > defReach - 1) {
        baseChance *= 0.3;  // Overhead — mostly unreachable
      }
      // Chest pass at normal height — full chance
      
      if (state.rng() < baseChance) {
        clearBallCarrier(state);
        def.hasBall = true;
        state.ball.carrier = def;
        state.lastEvent = `${def.player.name} intercepts the ${passType} pass!`;
        changePossession(state, '');
        return;
      }
    }
  }

  // Execute pass
  state.ball.inFlight = true;
  state.ball.flightFrom = { ...from.pos };
  state.ball.flightTo = { ...to.pos };
  state.ball.flightFromZ = passZ.fromZ;
  state.ball.flightPeakZ = passZ.peakZ;
  state.ball.flightProgress = 0;
  state.ball.flightDuration = 0.15 + passDist * 0.012;
  state.ball.isShot = false;
  state.ball.shotWillScore = false;
  state.ball.missType = null;
  clearBallCarrier(state);
  
  state.lastPassFrom = from.id;
  state.lastPassTime = state.gameTime;
  state.dribbleTime = 0; // reset — new handler starts fresh
  state.lastEvent = `${from.player.name} ${passType} pass to ${to.player.name}`;
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
  state.dribbleTime = 0;
  state.possessionStage = 'early';
  state.playCompleted = false;
  
  // Reset player states
  state.players.forEach(p => {
    p.currentSlot = undefined;
    p.currentRole = undefined;
    p.isDefensiveSliding = false;
    p.isCutting = false;
    p.isScreening = false;
    p.isDribbling = false;
    p.catchTimer = 0;
    p.sprintTimer = 0;
  });
  
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const dir = state.possession === 0 ? 1 : -1;
  const ownBasket = getOwnBasket(state.possession);

  // Don't teleport — set targets and let players move naturally
  // Ball will follow carrier once assigned in inbound phase
  
  // Offensive players transition toward own baseline area
  for (let i = 0; i < offTeam.length; i++) {
    offTeam[i].targetPos = { 
      x: ownBasket.x + dir * (5 + i * 2), 
      y: BASKET_Y + (i - 2) * 5 
    };
  }

  // Defense retreats toward their basket (the one offense attacks)
  const oppBasket = getTeamBasket(state.possession);
  for (let i = 0; i < defTeam.length; i++) {
    defTeam[i].targetPos = { 
      x: oppBasket.x - dir * (15 + i * 3), 
      y: BASKET_Y + (i - 2) * 6 
    };
  }

  state.ball.inFlight = false;
  state.ball.bouncing = false;
  state.ball.missType = null;
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
        isDribbling: false,
        catchTimer: 0,
        sprintTimer: 0,
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
      z: 4, // held at waist height
      isShot: false,
      shotWillScore: false,
      missType: null,
      bouncing: false,
      bounceTarget: { x: 0, y: 0 },
      bounceProgress: 0,
      bounceZ: 0,
      bounceVelZ: 0,
      flightFromZ: 0,
      flightPeakZ: 0,
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
    dribbleTime: 0,
    crossedHalfCourt: false,
    advanceClock: 0,
    possessionStage: 'early',
    playCompleted: false,
    freeThrows: null,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 10. DRAWING FUNCTIONS
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
  // Z to pixels: 1 foot of height = 3 pixels up on screen
  const zPx = state.ball.z * 3;

  if (state.ball.inFlight || state.ball.bouncing) {
    // Ball shadow on ground (size shrinks with height)
    const shadowSize = Math.max(2, 6 - state.ball.z * 0.3);
    const shadowAlpha = Math.max(0.1, 0.4 - state.ball.z * 0.02);
    ctx.beginPath();
    ctx.arc(bx, by, shadowSize, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${shadowAlpha})`;
    ctx.fill();

    // Ball elevated by z
    let elevation = zPx;
    if (state.ball.jumpBall?.active) {
      elevation = state.ball.jumpBall.height * 3;
    }
    
    // Ball size slightly larger when closer (higher z = further from viewer in top-down)
    const ballSize = 5 + Math.max(0, (10 - state.ball.z) * 0.2);
    
    ctx.beginPath();
    ctx.arc(bx, by - elevation, ballSize, 0, Math.PI * 2);
    ctx.fillStyle = '#e69138';
    ctx.fill();
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    
    // Ball spin lines for shots
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
  
  // Possession stage indicator
  ctx.fillStyle = state.possessionStage === 'desperation' ? '#f85149' : 
                  state.possessionStage === 'late' ? '#e3b341' :
                  state.possessionStage === 'mid' ? '#3fb950' : '#58a6ff';
  ctx.font = '8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`Possession: ${state.possessionStage.toUpperCase()}`, 10, CANVAS_H - 25);
  
  // Phase indicator
  ctx.fillStyle = '#8b949e';
  ctx.font = '8px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`Phase: ${state.phase.toUpperCase()}`, CANVAS_W - 10, CANVAS_H - 10);
}

// ══════════════════════════════════════════════════════════════════════════
// 11. REACT COMPONENT
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