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
  isDriving: boolean;         // committed to driving to basket — don't reconsider
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
    
    // Each player checks for movement every ~1.5 seconds, staggered
    const moveHash = (state.phaseTicks + player.courtIdx * 37) % 90;
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
  
  // Check for players too close — enforce minimum spacing
  // Ball handler exempt; bigs near basket can be closer (8ft), perimeter players need 12ft
  for (let i = 0; i < offTeam.length; i++) {
    for (let j = i + 1; j < offTeam.length; j++) {
      const p1 = offTeam[i];
      const p2 = offTeam[j];
      if (p1.currentRole === 'ballHandler' || p2.currentRole === 'ballHandler') continue;
      if (p1.isCutting || p2.isCutting || p1.isScreening || p2.isScreening) continue;
      
      const distance = dist(p1.pos, p2.pos);
      const bothBigs = (p1.player.position === 'C' || p1.player.position === 'PF') &&
                       (p2.player.position === 'C' || p2.player.position === 'PF');
      const minDist = bothBigs ? 8 : 12; // Perimeter players need more space
      
      if (distance < minDist) {
        // Relocate the less important role (spacer > cutter > postUp > screener)
        const rolePriority: Record<string, number> = { ballHandler: 4, screener: 3, postUp: 2, cutter: 1, spacer: 0 };
        const p1Priority = rolePriority[p1.currentRole || 'spacer'] ?? 0;
        const p2Priority = rolePriority[p2.currentRole || 'spacer'] ?? 0;
        const playerToRelocate = p1Priority <= p2Priority ? p1 : p2;
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
// 4. PLAYBOOK SYSTEM — 25+ Real NBA Set Plays
// ══════════════════════════════════════════════════════════════════════════
// Organized by category. Each play defines actions for all 5 roles.
// Categories: PnR (8), Motion/Passing (5), Post (4), Shooting (4), Transition (4)

type PlayDef = { name: string; category: string; steps: PlayStep[] };

function makePlay(name: string, category: string, steps: Array<{
  dur: number; trigger: 'time' | 'pass' | 'position';
  bh: RoleAction; sc: RoleAction; cu: RoleAction; sp: RoleAction; pu: RoleAction;
}>): PlayDef {
  return {
    name, category,
    steps: steps.map((s, i) => ({
      id: i + 1, duration: s.dur, trigger: s.trigger,
      actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', s.bh], ['screener', s.sc], ['cutter', s.cu], ['spacer', s.sp], ['postUp', s.pu]
      ])
    }))
  };
}

// ─── PICK & ROLL PLAYS (8) ──────────────────────────────────────────────

const PLAY_HORNS_PNR = makePlay('Horns PnR', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'pop',slot:'SLOT_LEFT_WING'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'callForBall'} },
]);

const PLAY_HORNS_SPLIT = makePlay('Horns Split', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'} },
  { dur: 1.5, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_TOP_KEY',to:'SLOT_LOW_POST_R'}, sc: {type:'readAndReact'}, cu: {type:'hold'}, sp: {type:'relocate'}, pu: {type:'screen',target:'ballHandler'} },
]);

const PLAY_SIDE_PNR = makePlay('Side PnR', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'relocate'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_SPAIN_PNR = makePlay('Spain PnR', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'screen',target:'screener'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'pop',slot:'SLOT_LEFT_WING'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_DRAG_PNR = makePlay('Drag Screen', 'pnr', [
  { dur: 1.5, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_WING'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'roll'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'relocate'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'callForBall'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_STEP_UP_PNR = makePlay('Step-Up PnR', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LOW_POST_L'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'roll'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'relocate'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'callForBall'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_DOUBLE_DRAG = makePlay('Double Drag', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'roll'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'screen',target:'ballHandler'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'callForBall'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'roll'} },
]);

const PLAY_PICK_AND_POP = makePlay('Pick & Pop', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'pop',slot:'SLOT_TOP_KEY'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── MOTION / PASSING PLAYS (5) ────────────────────────────────────────

const PLAY_FLEX = makePlay('Flex', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LOW_POST_R'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'spacer'}, sc: {type:'screen',target:'cutter'}, cu: {type:'cut',from:'SLOT_RIGHT_CORNER',to:'SLOT_LOW_POST_L'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'pop',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'relocate'} },
]);

const PLAY_UCLA_CUT = makePlay('UCLA Cut', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 1.5, trigger: 'time', bh: {type:'passTo',target:'spacer'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_LOW_POST_L'}, sc: {type:'pop',slot:'SLOT_TOP_KEY'}, cu: {type:'hold'}, sp: {type:'readAndReact'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'callForBall'}, sc: {type:'hold'}, cu: {type:'relocate'}, sp: {type:'readAndReact'}, pu: {type:'hold'} },
]);

const PLAY_PRINCETON_CHIN = makePlay('Princeton Chin', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'cut',from:'SLOT_LEFT_CORNER',to:'SLOT_LOW_POST_L'}, sp: {type:'hold'}, pu: {type:'screen',target:'cutter'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_TOP_KEY',to:'SLOT_RIGHT_CORNER'}, sc: {type:'readAndReact'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'pop',slot:'SLOT_TOP_KEY'} },
]);

const PLAY_SWING = makePlay('Swing Offense', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'cutter'}, sc: {type:'hold'}, cu: {type:'hold'}, sp: {type:'cut',from:'SLOT_LEFT_CORNER',to:'SLOT_LEFT_WING'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_TOP_KEY',to:'SLOT_LEFT_ELBOW'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'passTo',target:'spacer'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'callForBall'}, sc: {type:'roll'}, cu: {type:'hold'}, sp: {type:'readAndReact'}, pu: {type:'relocate'} },
]);

const PLAY_TRIANGLE = makePlay('Triangle', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LOW_POST_L'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_TOP_KEY'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'postUp'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_RIGHT_CORNER'}, sc: {type:'readAndReact'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── POST PLAYS (4) ────────────────────────────────────────────────────

const PLAY_POST_UP = makePlay('Post Up', 'post', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_TOP_KEY'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_L'} },
  { dur: 2, trigger: 'time', bh: {type:'entryPass',target:'postUp'}, sc: {type:'hold'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'callForBall'} },
  { dur: 3, trigger: 'time', bh: {type:'relocate'}, sc: {type:'hold'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'readAndReact'} },
]);

const PLAY_HIGH_LOW = makePlay('High-Low', 'post', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'callForBall'} },
  { dur: 3, trigger: 'time', bh: {type:'relocate'}, sc: {type:'entryPass',target:'postUp'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'readAndReact'} },
]);

const PLAY_POST_SPLIT = makePlay('Post Split', 'post', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_TOP_KEY'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_L'} },
  { dur: 2, trigger: 'time', bh: {type:'entryPass',target:'postUp'}, sc: {type:'hold'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'callForBall'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_LOW_POST_R'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'readAndReact'} },
]);

const PLAY_ELBOW_POST = makePlay('Elbow Post', 'post', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'cut',from:'SLOT_RIGHT_WING',to:'SLOT_LOW_POST_R'}, sc: {type:'readAndReact'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── SHOOTING PLAYS (4) ────────────────────────────────────────────────

const PLAY_FLOPPY = makePlay('Floppy', 'shooting', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LOW_POST_L'}, cu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'cutter'}, cu: {type:'cut',from:'SLOT_LEFT_ELBOW',to:'SLOT_RIGHT_WING'}, sp: {type:'hold'}, pu: {type:'screen',target:'cutter'} },
  { dur: 3, trigger: 'time', bh: {type:'passTo',target:'cutter'}, sc: {type:'roll'}, cu: {type:'shootIfOpen'}, sp: {type:'hold'}, pu: {type:'pop',slot:'SLOT_RIGHT_ELBOW'} },
]);

const PLAY_HAMMER = makePlay('Hammer', 'shooting', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'screen',target:'spacer'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'relocate'}, sp: {type:'callForBall'}, pu: {type:'hold'} },
]);

const PLAY_IVERSON_CUT = makePlay('Iverson Cut', 'shooting', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'cutter'}, cu: {type:'cut',from:'SLOT_TOP_KEY',to:'SLOT_RIGHT_WING'}, sp: {type:'hold'}, pu: {type:'screen',target:'cutter'} },
  { dur: 3, trigger: 'time', bh: {type:'passTo',target:'cutter'}, sc: {type:'pop',slot:'SLOT_LEFT_WING'}, cu: {type:'shootIfOpen'}, sp: {type:'relocate'}, pu: {type:'hold'} },
]);

const PLAY_STAGGER_SCREEN = makePlay('Stagger Screen', 'shooting', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LOW_POST_R'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'spacer'}, cu: {type:'hold'}, sp: {type:'cut',from:'SLOT_RIGHT_CORNER',to:'SLOT_LEFT_WING'}, pu: {type:'screen',target:'spacer'} },
  { dur: 3, trigger: 'time', bh: {type:'passTo',target:'spacer'}, sc: {type:'roll'}, cu: {type:'relocate'}, sp: {type:'shootIfOpen'}, pu: {type:'pop',slot:'SLOT_TOP_KEY'} },
]);

// ─── TRANSITION PLAYS (4) ──────────────────────────────────────────────

const PLAY_FAST_BREAK = makePlay('Fast Break', 'transition', [
  { dur: 1.5, trigger: 'time', bh: {type:'drive',direction:'baseline'}, sc: {type:'relocate'}, cu: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_LEFT_CORNER'}, sp: {type:'cut',from:'SLOT_RIGHT_WING',to:'SLOT_RIGHT_CORNER'}, pu: {type:'relocate'} },
  { dur: 2, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'relocate'}, cu: {type:'callForBall'}, sp: {type:'callForBall'}, pu: {type:'relocate'} },
]);

const PLAY_SECONDARY_BREAK = makePlay('Secondary Break', 'transition', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'relocate'} },
]);

const PLAY_EARLY_OFFENSE = makePlay('Early Offense', 'transition', [
  { dur: 1.5, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'cut',from:'SLOT_LEFT_CORNER',to:'SLOT_LOW_POST_L'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'cut',from:'SLOT_RIGHT_WING',to:'SLOT_RIGHT_ELBOW'}, sc: {type:'readAndReact'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_CHERRY_PICK = makePlay('Cherry Pick', 'transition', [
  { dur: 1, trigger: 'time', bh: {type:'drive',direction:'baseline'}, sc: {type:'relocate'}, cu: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_LOW_POST_L'}, sp: {type:'relocate'}, pu: {type:'relocate'} },
  { dur: 2, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'hold'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── ISO PLAYS (2) ─────────────────────────────────────────────────────

const PLAY_ISO = makePlay('ISO Clear', 'iso', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, cu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, sp: {type:'moveTo',slot:'SLOT_LEFT_WING'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 4, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'hold'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_ISO_SCREEN_AWAY = makePlay('ISO Screen Away', 'iso', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_LEFT_WING'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'cutter'}, cu: {type:'cut',from:'SLOT_LEFT_CORNER',to:'SLOT_LEFT_WING'}, sp: {type:'relocate'}, pu: {type:'hold'} },
  { dur: 4, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'pop',slot:'SLOT_TOP_KEY'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── MASTER PLAYBOOK ───────────────────────────────────────────────────

const PLAYBOOK: PlayDef[] = [
  // PnR (8)
  PLAY_HORNS_PNR, PLAY_HORNS_SPLIT, PLAY_SIDE_PNR, PLAY_SPAIN_PNR,
  PLAY_DRAG_PNR, PLAY_STEP_UP_PNR, PLAY_DOUBLE_DRAG, PLAY_PICK_AND_POP,
  // Motion (5)
  PLAY_FLEX, PLAY_UCLA_CUT, PLAY_PRINCETON_CHIN, PLAY_SWING, PLAY_TRIANGLE,
  // Post (4)
  PLAY_POST_UP, PLAY_HIGH_LOW, PLAY_POST_SPLIT, PLAY_ELBOW_POST,
  // Shooting (4)
  PLAY_FLOPPY, PLAY_HAMMER, PLAY_IVERSON_CUT, PLAY_STAGGER_SCREEN,
  // Transition (4)
  PLAY_FAST_BREAK, PLAY_SECONDARY_BREAK, PLAY_EARLY_OFFENSE, PLAY_CHERRY_PICK,
  // ISO (2)
  PLAY_ISO, PLAY_ISO_SCREEN_AWAY,
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
  
  // Find ball handler — prefer PG as primary ball handler
  let ballHandler = getBallHandler(state);
  if (ballHandler) {
    // If a non-PG has the ball but PG is nearby, PG still gets ballHandler role
    // (PG will seek the ball via off-ball movement / play design)
    const pg = offTeam.find(p => p.player.position === 'PG');
    if (pg && pg !== ballHandler && !pg.isCutting) {
      // PG gets ballHandler role — will call for ball or run point
      state.roles.set(pg.id, 'ballHandler');
      // Actual ball carrier gets a secondary role
      const carrierPos = ballHandler.player.position;
      if (carrierPos === 'C' || carrierPos === 'PF') {
        state.roles.set(ballHandler.id, 'postUp');
      } else {
        state.roles.set(ballHandler.id, 'spacer');
      }
      ballHandler = pg; // For remaining role assignment, treat PG as handler
    } else {
      state.roles.set(ballHandler.id, 'ballHandler');
    }
  }
  
  // Assign roles based on tactic and player attributes
  const remainingPlayers = offTeam.filter(p => !state.roles.has(p.id));
  
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
    // Only rebuild assignments if empty (possession change / init)
    // Switches happen via handleScreenDefense, not here
    if (state.defAssignments.size === 0) {
      // Position-based assignment: match by roster index
      for (let i = 0; i < Math.min(defTeam.length, offTeam.length); i++) {
        state.defAssignments.set(defTeam[i].id, offTeam[i].id);
      }
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
    // 2-3 Zone defense — reactive to ball position
    const dir = basket.x > HALF_X ? -1 : 1; // direction away from basket (toward half court)
    const bx = basket.x;
    const by = basket.y;
    
    // Base zone positions (2 guards up, 3 across the baseline)
    const basePositions = [
      { x: bx + dir * 20, y: by - 10 }, // Left guard (top)
      { x: bx + dir * 20, y: by + 10 }, // Right guard (top)
      { x: bx + dir * 10, y: by - 10 }, // Left forward (mid)
      { x: bx + dir * 10, y: by + 10 }, // Right forward (mid)
      { x: bx + dir * 4,  y: by },      // Center (paint)
    ];
    
    if (ballHandler) {
      const ballX = ballHandler.pos.x;
      const ballY = ballHandler.pos.y;
      const ballSide = ballY > by ? 1 : -1; // right side = 1, left = -1
      const ballDepth = Math.abs(ballX - bx); // how deep into offense
      
      // 1. Entire zone shifts toward ball side (strong shift)
      const sideShift = ballSide * 5;
      basePositions.forEach(pos => pos.y += sideShift);
      
      // 2. If ball is in the corner, collapse that side
      if (Math.abs(ballY - by) > 15) {
        // Ball in corner — nearest forward closes out, guard drops
        const cornerIdx = ballSide > 0 ? 3 : 2; // right or left forward
        const guardIdx = ballSide > 0 ? 1 : 0;
        basePositions[cornerIdx] = { x: ballX, y: ballY + (-ballSide * 3) };
        // Guard drops to cover the gap
        basePositions[guardIdx].y += ballSide * 4;
      }
      
      // 3. If ball penetrates inside 3pt line (< 20ft), zone collapses
      if (ballDepth < 18) {
        const collapseFactor = (18 - ballDepth) / 18; // 0 at perimeter, 1 at basket
        basePositions.forEach(pos => {
          pos.x = pos.x + (bx - pos.x) * collapseFactor * 0.4;
          pos.y = pos.y + (by - pos.y) * collapseFactor * 0.2;
        });
      }
      
      // 4. Guard nearest to ball handler must close out (contest shooter)
      const [g0dist, g1dist] = [
        dist(basePositions[0], ballHandler.pos),
        dist(basePositions[1], ballHandler.pos)
      ];
      const closestGuardIdx = g0dist < g1dist ? 0 : 1;
      if (dist(basePositions[closestGuardIdx], ballHandler.pos) > 8) {
        // Close out to ball handler
        const toHandler = normalizeVector({
          x: ballHandler.pos.x - basePositions[closestGuardIdx].x,
          y: ballHandler.pos.y - basePositions[closestGuardIdx].y
        });
        basePositions[closestGuardIdx].x += toHandler.x * 5;
        basePositions[closestGuardIdx].y += toHandler.y * 5;
      }
    }
    
    defTeam.forEach((defender, i) => {
      if (i < basePositions.length) {
        defender.targetPos = { ...basePositions[i] };
      }
    });
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
        // Smart switching based on size mismatch risk
        const screenerDefender = findDefenderOf(screener, state);
        if (screenerDefender) {
          // Would switching create a bad mismatch?
          // Big guarding a PG after switch = BBQ chicken. PG guarding C in post = disaster.
          const defHeight = defender.player.physical.height;
          const screenerDefHeight = screenerDefender.player.physical.height;
          const assignmentHeight = assignment.player.physical.height;
          const screenerHeight = screener.player.physical.height;
          
          // Height difference if we switch: defender guards screener, screener's def guards our man
          const mismatch1 = Math.abs(defHeight - screenerHeight); // our def vs screener
          const mismatch2 = Math.abs(screenerDefHeight - assignmentHeight); // their def vs our man
          const maxMismatch = Math.max(mismatch1, mismatch2);
          
          // Switch if mismatch is small (<8cm). Fight through if mismatch is big.
          // Also factor in agility — agile defenders can fight through better
          const agilityBonus = (defender.player.physical.agility || 70) / 200; // 0.25-0.5
          const switchChance = maxMismatch < 8 ? 0.7 : maxMismatch < 15 ? 0.3 : 0.1;
          
          if (state.rng() < switchChance) {
            swapAssignments(defender, screenerDefender, state);
          } else {
            // FIGHT THROUGH: go around the screen
            const awayFromScreen = normalizeVector({
              x: assignment.pos.x - screener.pos.x,
              y: assignment.pos.y - screener.pos.y
            });
            defender.targetPos = {
              x: assignment.pos.x + awayFromScreen.x * 3,
              y: assignment.pos.y + awayFromScreen.y * 3
            };
          }
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
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  
  // Help defense triggers when ball handler penetrates within 15ft
  if (distToBasket < 15) {
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
          
          // SECOND ROTATION
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
  } else {
    // Ball handler NOT driving — all defenders RECOVER to their assignments
    // This prevents defenders from staying in help position after the drive is over
    for (const def of defTeam) {
      const assignedId = state.defAssignments.get(def.id);
      const assigned = offTeam.find(p => p.id === assignedId);
      if (assigned) {
        const defDist = dist(def.pos, assigned.pos);
        // If defender is far from their man (>10ft), they were helping — recover
        if (defDist > 10) {
          def.targetPos = {
            x: assigned.pos.x + (basket.x - assigned.pos.x) * 0.3,
            y: assigned.pos.y + (basket.y - assigned.pos.y) * 0.3
          };
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
    // Use the player's best scoring skills (shooters vs finishers)
    const shootingMax = Math.max(p.player.skills.shooting.three_point, p.player.skills.shooting.mid_range);
    const finishingMax = Math.max(p.player.skills.finishing.layup, p.player.skills.finishing.dunk, p.player.skills.finishing.post_move);
    const scoringSkill = Math.max(shootingMax, finishingMax);
    
    const bestShootMax = Math.max(best.player.skills.shooting.three_point, best.player.skills.shooting.mid_range);
    const bestFinishMax = Math.max(best.player.skills.finishing.layup, best.player.skills.finishing.dunk, best.player.skills.finishing.post_move);
    const bestScoringSkill = Math.max(bestShootMax, bestFinishMax);
    
    const pScore = scoringSkill + (p.player.isSuperstar ? 15 : 0);
    const bestScore = bestScoringSkill + (best.player.isSuperstar ? 15 : 0);
    
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
  
  // 0. COMMITTED DRIVE — once driving, keep going until at rim or completely stopped
  if (handler.isDriving) {
    if (distToBasket < 6) {
      // Arrived at rim — finish!
      handler.isDriving = false;
      attemptShot(state, handler, basketPos);
      return;
    }
    // Still driving — keep going toward basket, don't reconsider
    handler.targetPos = { ...basketPos };
    handler.isCutting = true;
    return;
  }
  
  // 1. At the rim — always finish (layup/dunk)
  if (distToBasket < 8) {
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
  //    BUT only if you're actually a shooter! Non-shooters should pass or drive.
  if (isWideOpen && holdTime < 0.5 && distToBasket > 22 && distToBasket < 27) {
    const catchShoot = handler.player.skills.shooting.catch_and_shoot;
    const three = handler.player.skills.shooting.three_point;
    const bestShootingSkill = Math.max(catchShoot, three);
    // Good shooters (≥75) shoot immediately. Decent (65-74) sometimes. Bad (<65) never from 3.
    if (bestShootingSkill >= 75 || (bestShootingSkill >= 65 && state.rng() < 0.3)) {
      attemptShot(state, handler, basketPos);
      return;
    }
    // Non-shooter wide open? Drive or pass instead (fall through to decision tree)
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
  if (laneClear && distToBasket > 8 && distToBasket < 28) {
    // Commit to drive — won't reconsider until reaching basket
    handler.targetPos = { ...basketPos };
    handler.isCutting = true;
    handler.isDriving = true;
    return;
  }
  
  // 3b. Open mid-range — take it if aggressive (and can't drive)
  if (isOpen && distToBasket < 22 && distToBasket > 8 && (aggressive || mustAttack)) {
    attemptShot(state, handler, basketPos);
    return;
  }
  
  // 3c. Open 3 — only take if you can actually shoot
  if (isOpen && distToBasket > 22 && distToBasket < 27) {
    const three = handler.player.skills.shooting.three_point;
    // Good shooters take open 3s. Non-shooters only when desperate.
    if (three >= 70 || (three >= 65 && aggressive) || mustAttack) {
      attemptShot(state, handler, basketPos);
      return;
    }
    // Non-shooter open at 3pt line → drive instead if lane is clear
    if (three < 65 && laneClear) {
      handler.targetPos = { ...basketPos };
      handler.isCutting = true;
      handler.isDriving = true;
      return;
    }
  }
  
  // 3d. ALLEY-OOP — if a teammate is cutting to the rim and we can lob it
  if (!mustAttack && handler.player.skills.playmaking.lob_pass >= 65) {
    const oopTarget = findAlleyOopTarget(state, handler, basketPos);
    if (oopTarget && state.rng() < 0.6) { // 60% chance to attempt when opportunity exists
      throwAlleyOop(state, handler, oopTarget, basketPos);
      return;
    }
  }
  
  // 4. Pass to create a better shot (but only if not holding too long)
  if (!mustAttack) {
    // SUPERSTAR TARGETING — feed the star! (~40% chance to look for superstar first)
    if (state.rng() < 0.4) {
      const superstar = openTeammates.find(p => p.player.isSuperstar);
      if (superstar) {
        passBall(state, handler, superstar);
        return;
      }
    }
    
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
  handler.isDriving = true;
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

// ══════════════════════════════════════════════════════════════════════════
// ANALYSIS DATA COLLECTION
// ══════════════════════════════════════════════════════════════════════════
// Exposes window.__hoopcraft_ticks (tick log) and window.__hoopcraft_analyze()
// Used by scripts/analyze.mjs (Playwright) for automated game analysis.

interface TickSnapshot {
  t: number; phase: string; possession: number; shotClock: number;
  players: { id: string; name: string; pos: string; x: number; y: number; hasBall: boolean; role?: string; teamIdx: number }[];
  event?: string; play?: string;
}
const _tickLog: TickSnapshot[] = [];
(window as unknown as Record<string, unknown>).__hoopcraft_ticks = _tickLog;

function tick(state: GameState): GameState {
  const dt = 1 / 60; // 1 tick = 1/60th of a second (matches requestAnimationFrame)
  state.phaseTicks++;
  state.gameTime += dt;

  // Collect tick data for analysis (cap at 200K ticks ≈ 55min game time)
  if (_tickLog.length < 200000) {
    _tickLog.push({
      t: state.gameTime, phase: state.phase, possession: state.possession, shotClock: state.shotClock,
      players: state.players.map(p => ({
        id: p.id, name: p.player.name, pos: p.player.position,
        x: Math.round(p.pos.x * 10) / 10, y: Math.round(p.pos.y * 10) / 10,
        hasBall: p.hasBall, role: p.currentRole, teamIdx: p.teamIdx,
      })),
      event: state.lastEvent, play: state.currentPlay?.name,
    });
  }

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

  // Sync safety: ensure hasBall and carrier are consistent
  if (state.ball.carrier && !state.ball.carrier.hasBall) {
    state.ball.carrier.hasBall = true;
  }
  const ballHolders = state.players.filter(p => p.hasBall);
  if (ballHolders.length > 1) {
    // Multiple players think they have the ball — fix by keeping only carrier
    for (const p of state.players) {
      p.hasBall = (p === state.ball.carrier);
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
    // NOTE: removed processHelpDefense — was duplicate of handleHelpDefense
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
  // Off-ball movement during action AND setup (players shouldn't stand idle during setup)
  if (state.phase === 'action' || state.phase === 'setup') {
    offBallMovement(state, offTeam, basketPos, dir);
  }
  // During advance, wings and trailers already have targets from handleAdvance
  // During inbound, receivers already have targets from handleInbound

  // Move all players
  for (const p of state.players) {
    movePlayerToward(p, dt, state);
  }
  
  // Reset per-frame flags AFTER movement (so next tick's phase handlers set them fresh)
  for (const p of state.players) {
    p.isDefensiveSliding = false;
    p.isCutting = false;
    p.isScreening = false;
    if (!p.hasBall) { p.isDribbling = false; p.isDriving = false; }
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
  
  // Stage 1 (0-1.5s): Set up inbound — ref handles ball, players get in position
  if (state.phaseTicks < 90) {
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
    
  // Stage 2 (1.5-2.5s): Receiver cuts toward ball
  } else if (state.phaseTicks < 150) {
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
    
  // Stage 3 (4s+): Execute inbound pass — prefer PG, then most open player
  } else {
    const inbounder = getBallHandler(state);
    if (inbounder) {
      const receivers = offTeam
        .filter(p => p !== inbounder)
        .map(p => {
          const nearDef = findNearestDefender(p, state);
          const openness = nearDef ? dist(nearDef.pos, p.pos) : 15;
          const pgBonus = p.player.position === 'PG' ? 10 : 0;
          const proximity = 20 - dist(p.pos, inbounder.pos); // closer = better
          return { player: p, score: openness + pgBonus + proximity };
        })
        .sort((a, b) => b.score - a.score);
      
      if (receivers.length > 0) {
        passBall(state, inbounder, receivers[0].player);
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
        ? d.pos.x > HALF_X + 5  // team 0 attacks right — tighter check
        : d.pos.x < HALF_X - 5; // team 1 attacks left — tighter check
    }).length;
    
    if (defPastHalf <= 1) { // Was <= 2, too easy to trigger. NBA ~15-20% transition
      // Fast break! Count advantage
      const offPastHalf = offTeam.filter(p => {
        return state.possession === 0
          ? p.pos.x > HALF_X + 5
          : p.pos.x < HALF_X - 5;
      }).length;
      
      state.phase = 'action';
      state.phaseTicks = 0;
      state.advanceClock = 0;
      
      if (defPastHalf === 0 && offPastHalf >= 1) {
        // Uncontested — just attack the rim
        state.currentPlay = PLAY_CHERRY_PICK;
        state.lastEvent = `Breakaway! ${handler.player.name} is all alone!`;
      } else if (offPastHalf >= defPastHalf + 2) {
        // 3v1 or 4v2 — use secondary break with passing
        state.currentPlay = PLAY_SECONDARY_BREAK;
        state.lastEvent = `Fast break! ${offPastHalf}v${defPastHalf}!`;
      } else {
        state.currentPlay = PLAY_FAST_BREAK;
        state.lastEvent = `Fast break! ${handler.player.name} pushes the pace!`;
      }
      state.currentStep = 0;
      state.stepTimer = 0;
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
  
  // Steal attempts — check once per ~5 seconds (every 300 ticks)
  const nearestDefender = findNearestDefender(handler, state);
  if (nearestDefender && dist(nearestDefender.pos, handler.pos) < 2.5 && state.phaseTicks % 300 === 0) {
    const stealSkill = nearestDefender.player.skills.defense.steal;
    const handlingSkill = handler.player.skills.playmaking.ball_handling;
    // Better handlers are harder to steal from
    const stealChance = 0.003 + (stealSkill / 100) * 0.01 - (handlingSkill / 100) * 0.004;
    if (state.rng() < Math.max(0.002, stealChance)) {
      clearBallCarrier(state);
      nearestDefender.hasBall = true;
      state.ball.carrier = nearestDefender;
      state.lastEvent = `${nearestDefender.player.name} steals the ball!`;
      changePossession(state, '');
      return;
    }
  }
  
  // Off-ball fouls — check once per ~8 seconds (every 480 ticks)
  // NBA: ~20 fouls/team/game, minus shooting fouls (~8-10), leaves ~10-12 non-shooting fouls
  if (state.phaseTicks % 480 === 240) {
    const defTeamAll = state.players.filter(p => p.teamIdx !== state.possession);
    // Reach-in on ball handler
    if (nearestDefender && dist(nearestDefender.pos, handler.pos) < 3) {
      if (state.rng() < 0.08) {
        state.lastEvent = `Reaching foul on ${nearestDefender.player.name}!`;
        // Side-out, same team keeps possession (simplified — no bonus tracking)
        return;
      }
    }
    // Off-ball hold/push — any defender tight on their man
    for (const def of defTeamAll) {
      if (def === nearestDefender) continue;
      const assignedId = state.defAssignments.get(def.id);
      const assigned = state.players.find(p => p.id === assignedId);
      if (assigned && dist(def.pos, assigned.pos) < 2.5 && state.rng() < 0.03) {
        state.lastEvent = `Off-ball foul on ${def.player.name}!`;
        return;
      }
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
    // DEFENDERS: box out — back into offensive player, seal them off
    for (let i = 0; i < defTeam.length; i++) {
      const def = defTeam[i];
      const matchup = offTeam[i] || offTeam[0];
      
      // Move TOWARD the rebound spot but stay between matchup and ball
      // First 0.5s: find matchup. After: push them away from ball
      const phase = state.phaseTicks < 30 ? 'find' : 'seal';
      
      if (phase === 'find') {
        // Move to matchup position (between them and rebound)
        const mx = matchup.pos.x, my = matchup.pos.y;
        const rx = reboundPos.x, ry = reboundPos.y;
        const toRebX = rx - mx, toRebY = ry - my;
        const toRebD = Math.sqrt(toRebX * toRebX + toRebY * toRebY) || 1;
        def.targetPos = {
          x: mx + (toRebX / toRebD) * 3,
          y: my + (toRebY / toRebD) * 3
        };
      } else {
        // Seal: back into matchup and move toward rebound
        def.targetPos = {
          x: reboundPos.x + (def.courtIdx - 2) * 3,
          y: reboundPos.y + (def.courtIdx % 2 === 0 ? -3 : 3)
        };
      }
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
      // Roll to basket — sprint toward rim (alley-oop eligible)
      player.targetPos = {
        x: basketPos.x - dir * 5,
        y: basketPos.y + (state.rng() - 0.5) * 4
      };
      player.isCutting = true; // makes them eligible for alley-oop detection
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
  const passDist = dist(from.pos, to.pos);
  
  for (const def of defTeam) {
    const distToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    const defDistFromPasser = dist(def.pos, from.pos);
    // Defender must be between passer and target (not behind passer)
    if (defDistFromPasser > passDist) continue;
    // Shorter passes need tighter blocking; long passes have more room to go over
    const blockRadius = passDist > 20 ? 1.5 : 2.5;
    if (distToLine < blockRadius) {
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
  if (player.isCutting && !player.isDribbling) baseSpeed *= 1.2; // only sprint if not dribbling
  if (player.isDribbling) {
    // Dribbling significantly limits speed — ball handling skill matters
    const handling = player.player.skills.playmaking?.ball_handling || 60;
    baseSpeed *= 0.55 + (handling / 100) * 0.2; // range: 0.55 (bad handler) to 0.75 (elite)
  }
  if (player.catchTimer > 0) baseSpeed *= 0.3;       // catching the ball — nearly stationary
  
  // Being tightly guarded slows you down (body contact, can't get a clean step)
  if (player.hasBall && state.phase === 'action') {
    const nearDef = state.players.find(p => p.teamIdx !== player.teamIdx && dist(p.pos, player.pos) < 3);
    if (nearDef) {
      const defStr = nearDef.player.physical.strength || 70;
      const offStr = player.player.physical.strength || 70;
      // Stronger defender = harder to move. Range: 0.75 (weak off vs strong def) to 0.95 (strong off vs weak def)
      baseSpeed *= 0.75 + (offStr - defStr + 30) / 300;
    }
  }
  
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
  
  // Collision avoidance + screen physics
  for (const other of state.players) {
    if (other === player) continue;
    const dx2 = player.pos.x - other.pos.x;
    const dy2 = player.pos.y - other.pos.y;
    const d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    
    // Screen physics: when a DEFENDER runs into an offensive SCREENER,
    // the defender gets physically blocked (strong repulsion + speed kill)
    if (d2 < 3.5 && d2 > 0.01 && other.isScreening && player.teamIdx !== other.teamIdx) {
      // Screener's strength vs defender's strength determines how much they're blocked
      const screenStr = other.player.physical.strength;
      const defStr = player.player.physical.strength || 70;
      const blockFactor = 0.5 + (screenStr / 200); // 0.8-1.0 for strong screeners
      const pushStrength = (3.5 - d2) * blockFactor * 2.0;
      player.pos.x += (dx2 / d2) * pushStrength * dt;
      player.pos.y += (dy2 / d2) * pushStrength * dt;
      // Kill velocity — defender has to re-accelerate after hitting screen
      player.vel.x *= 0.3;
      player.vel.y *= 0.3;
    }
    // Normal collision avoidance (weaker)
    else if (d2 < 2.5 && d2 > 0.01) {
      const pushStrength = (2.5 - d2) * 0.5;
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
        // Determine tip-off winner based on height + vertical + rng
        const [c0, c1] = centers;
        const c0score = c0.player.physical.height + c0.player.physical.vertical * 0.5 + state.rng() * 20;
        const c1score = c1.player.physical.height + c1.player.physical.vertical * 0.5 + state.rng() * 20;
        const winner = c0score >= c1score ? c0 : c1;
        
        // Jumper TAPS the ball to a teammate — not grab!
        const winnerTeam = state.players.filter(p => p.teamIdx === winner.teamIdx && p !== winner);
        // Find closest teammate to tap to
        const tapTarget = winnerTeam.sort((a, b) => dist(a.pos, winner.pos) - dist(b.pos, winner.pos))[0];
        
        if (tapTarget) {
          // Ball flies from center to teammate (tap animation)
          state.ball.inFlight = true;
          state.ball.flightFrom = { x: HALF_X, y: BASKET_Y };
          state.ball.flightTo = { ...tapTarget.pos };
          state.ball.flightFromZ = 12; // tapped at apex
          state.ball.flightPeakZ = 13;
          state.ball.flightProgress = 0;
          state.ball.flightDuration = 0.4;
          state.ball.isShot = false;
          state.ball.jumpBall = { active: false, height: 0, winner: null };
          clearBallCarrier(state);
          state.possession = winner.teamIdx;
          state.lastEvent = `${winner.player.name} tips it to ${tapTarget.player.name}!`;
          state.phase = 'advance';
          state.phaseTicks = 0;
          state.gameStarted = true;
        } else {
          // Fallback: winner gets ball
          clearBallCarrier(state);
          winner.hasBall = true;
          state.ball.carrier = winner;
          state.possession = winner.teamIdx;
          state.lastEvent = `${winner.player.name} wins the tip-off!`;
          state.phase = 'advance';
          state.phaseTicks = 0;
          state.gameStarted = true;
          state.ball.inFlight = false;
          state.ball.jumpBall!.active = false;
        }
      } else {
        state.ball.inFlight = false;
        state.ball.jumpBall!.active = false;
      }
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
          const isAlleyOop = (state.ball as any).isAlleyOop;
          const scoreType = isAlleyOop ? 'ALLEY-OOP DUNK!' 
            : pts === 3 ? '3-pointer' 
            : shotDistance < 3 ? 'at the rim' 
            : shotDistance < 8 ? 'layup' 
            : `${pts}pts`;
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
          const isAlleyOopMiss = (state.ball as any).isAlleyOop;
          if (isAlleyOopMiss) {
            state.lastEvent = ['Alley-oop attempt! Can\'t finish!', 'Lob is off! Alley-oop fails!', 'Alley-oop bobbled!'][Math.floor(state.rng() * 3)];
          } else {
            const texts = missTexts[missType] || ['Miss!'];
            state.lastEvent = texts[Math.floor(state.rng() * texts.length)];
          }
        }
        state.ball.isShot = false;
        (state.ball as any).isAlleyOop = false;
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

// Track recently used plays to ensure variety (reset on game init)
let recentPlays: string[] = [];

function selectPlay(state: GameState, offTeam: SimPlayer[]): void {
  const tactic = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  const rng = state.rng;
  
  // Filter plays by tactic category preference
  let categoryWeights: Record<string, number>;
  
  switch (tactic) {
    case 'fast_break':
      categoryWeights = { transition: 5, pnr: 2, motion: 1, shooting: 1, post: 0, iso: 0 };
      break;
    case 'iso':
      categoryWeights = { iso: 5, pnr: 2, shooting: 1, motion: 1, post: 0, transition: 1 };
      break;
    case 'inside':
      categoryWeights = { post: 5, pnr: 3, motion: 2, shooting: 1, iso: 0, transition: 1 };
      break;
    case 'shoot':
      categoryWeights = { shooting: 5, pnr: 3, motion: 2, post: 1, iso: 1, transition: 1 };
      break;
    case 'motion':
    default:
      categoryWeights = { pnr: 3, motion: 3, shooting: 2, post: 2, iso: 1, transition: 1 };
      break;
  }
  
  // Build weighted candidate list, excluding recently used
  const candidates: PlayDef[] = [];
  for (const play of PLAYBOOK) {
    if (recentPlays.includes(play.name)) continue; // avoid repeats
    if (play.category === 'transition') continue; // transition only via fast break detection
    const weight = categoryWeights[play.category] || 1;
    for (let i = 0; i < weight; i++) candidates.push(play);
  }
  
  // Fallback: if all filtered out, use any non-transition play
  const pool = candidates.length > 0 ? candidates : PLAYBOOK.filter(p => p.category !== 'transition');
  const selectedPlay = pool[Math.floor(rng() * pool.length)];
  
  // Track recent plays (keep last 4 to avoid repeating)
  recentPlays.push(selectedPlay.name);
  if (recentPlays.length > 4) recentPlays.shift();
  
  state.currentPlay = selectedPlay;
  state.currentStep = 0;
  state.stepTimer = 0;
}

function attemptShot(state: GameState, shooter: SimPlayer, basket: Vec2): void {
  const shooterName = shooter.player.name;
  const distToBasket = dist(shooter.pos, basket);
  
  // Determine shot type and skill used
  let shotSkill: number;
  let basePct: number;
  let isDunk = false;
  
  if (distToBasket > 22) {
    // 3-pointer — use catch_and_shoot if player just caught the ball
    const isCatchAndShoot = state.dribbleTime < 0.8; // shot within 0.8s of receiving
    const threeSkill = shooter.player.skills.shooting.three_point;
    const casSkill = shooter.player.skills.shooting.catch_and_shoot;
    shotSkill = isCatchAndShoot ? Math.max(threeSkill, casSkill) : threeSkill;
    basePct = 0.33; // NBA avg ~36%, base before skill modifier
  } else if (distToBasket > 14) {
    // Long mid-range
    shotSkill = shooter.player.skills.shooting.mid_range;
    basePct = 0.42;
  } else if (distToBasket > 8) {
    // Short mid-range / floater
    shotSkill = Math.max(shooter.player.skills.shooting.mid_range, shooter.player.skills.finishing.layup);
    basePct = 0.48;
  } else if (distToBasket > 3) {
    // Close range — layup/runner territory
    shotSkill = shooter.player.skills.finishing.layup;
    basePct = 0.62;
  } else {
    // At the rim — layup or dunk
    const dunkSkill = shooter.player.skills.finishing.dunk;
    const layupSkill = shooter.player.skills.finishing.layup;
    // Dunk if athletic enough, close enough, and no shot-blocker right there
    const nearDef = findNearestDefender(shooter, state);
    const defClose = nearDef && dist(nearDef.pos, shooter.pos) < 4;
    const defCanBlock = defClose && nearDef && nearDef.player.skills.defense.block >= 75;
    if (dunkSkill >= 70 && distToBasket < 2.5 && shooter.player.physical.vertical >= 65 && !defCanBlock) {
      isDunk = true;
      shotSkill = dunkSkill;
      basePct = 0.82; // dunks are very high percentage
    } else {
      shotSkill = layupSkill;
      basePct = 0.68; // point-blank layup (slightly contested)
    }
  }

  const tacticO = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
  const advantage = getTacticAdvantage(tacticO, tacticD);
  
  // Contest factor — distance + defender's contest skill matters
  const nearestDef = findNearestDefender(shooter, state);
  const contestDistance = nearestDef ? dist(nearestDef.pos, shooter.pos) : 10;
  let contestModifier = 1.0;
  if (nearestDef && contestDistance < 6) {
    const contestSkill = nearestDef.player.skills.defense.shot_contest || 60;
    // Tight contest (< 3ft): 55-75% depending on defender skill
    // Medium (3-6ft): 75-95%
    if (contestDistance < 3) {
      contestModifier = 0.55 + (1 - contestSkill / 100) * 0.2;
    } else {
      contestModifier = 0.75 + (1 - contestSkill / 100) * 0.2;
    }
  }
  
  if (shooter.player.isSuperstar) {
    contestModifier = Math.max(contestModifier, 0.75); // superstars create own shot
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
  const shotType = isDunk ? 'DUNK' : distToBasket > 22 ? '3PT' : distToBasket > 14 ? 'mid-range' : distToBasket > 8 ? 'floater' : 'layup';
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

// ══════════════════════════════════════════════════════════════════════════
// ALLEY-OOP SYSTEM
// ══════════════════════════════════════════════════════════════════════════

function findAlleyOopTarget(state: GameState, passer: SimPlayer, basketPos: Vec2): SimPlayer | null {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession && p !== passer);
  
  let bestTarget: SimPlayer | null = null;
  let bestScore = 0;
  
  for (const p of offTeam) {
    const oopSkill = p.player.skills.finishing.alley_oop;
    const dunkSkill = p.player.skills.finishing.dunk;
    const vertical = p.player.physical.vertical;
    const distToBasket = dist(p.pos, basketPos);
    
    // Must be near the basket (cutting to rim / rolling)
    if (distToBasket > 12) continue;
    // Must be athletic enough to catch and finish
    if (oopSkill < 65 || dunkSkill < 65 || vertical < 65) continue;
    
    // Check if there's a clear lane (no defender right at the rim blocking)
    const nearDef = findNearestDefender(p, state);
    const defDist = nearDef ? dist(nearDef.pos, p.pos) : 20;
    // Defender must not be between target and basket (rim protector)
    const rimProtector = nearDef && dist(nearDef.pos, basketPos) < 5 && nearDef.player.skills.defense.block >= 75;
    if (rimProtector) continue; // too risky — shot blocker at rim
    
    // Check passer's lob ability
    const lobSkill = passer.player.skills.playmaking.lob_pass;
    const passDist = dist(passer.pos, p.pos);
    if (passDist < 8 || passDist > 35) continue; // too close or too far for a lob
    
    // Score this opportunity
    const score = (oopSkill / 100) * 3 + (dunkSkill / 100) * 2 + (vertical / 100) * 2
      + (lobSkill / 100) * 2 + (defDist > 5 ? 2 : 0) + (p.isCutting ? 3 : 0)
      + (p.player.isSuperstar ? 2 : 0);
    
    if (score > bestScore) {
      bestScore = score;
      bestTarget = p;
    }
  }
  
  // Only attempt if opportunity is good enough
  return bestScore > 10 ? bestTarget : null;
}

function throwAlleyOop(state: GameState, passer: SimPlayer, target: SimPlayer, basketPos: Vec2): void {
  const lobSkill = passer.player.skills.playmaking.lob_pass;
  const oopSkill = target.player.skills.finishing.alley_oop;
  const dunkSkill = target.player.skills.finishing.dunk;
  const vertical = target.player.physical.vertical;
  
  // Success chance: depends on passer lob + receiver oop + vertical
  // Elite PG + elite finisher = ~75%. Average + average = ~35%.
  const successChance = 0.15
    + skillModifier(lobSkill) * 0.20
    + skillModifier(oopSkill) * 0.20
    + skillModifier(dunkSkill) * 0.10
    + (vertical / 100) * 0.15;
  
  const willScore = state.rng() < Math.min(0.85, successChance);
  
  // Lob pass: very high arc targeting above the rim
  const passDist = dist(passer.pos, basketPos);
  
  state.ball.inFlight = true;
  state.ball.flightFrom = { ...passer.pos };
  state.ball.flightTo = { ...basketPos }; // lob goes to the BASKET, not the player
  state.ball.flightFromZ = 8;
  state.ball.flightPeakZ = 16 + passDist * 0.1; // very high arc
  state.ball.flightProgress = 0;
  state.ball.flightDuration = 0.5 + passDist * 0.015; // slightly slower than normal pass
  state.ball.isShot = true; // treated as a shot attempt
  state.ball.shotWillScore = willScore;
  state.ball.missType = willScore ? null : (state.rng() < 0.5 ? 'rim_out' : 'back_iron');
  (state.ball as any).shooterName = target.player.name;
  (state.ball as any).isAlleyOop = true;
  
  clearBallCarrier(state);
  
  // Target sprints to basket to catch it
  target.targetPos = { ...basketPos };
  target.isCutting = true;
  
  state.dribbleTime = 0;
  state.lastPassFrom = passer.id;
  state.lastPassTime = state.gameTime;
  
  const playContext = state.currentPlay ? `[${state.currentPlay.name}] ` : '';
  state.lastEvent = `${playContext}${passer.player.name} ALLEY-OOP to ${target.player.name}!`;
  
  state.phase = 'shooting';
  state.currentPlay = null;
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
    p.isDriving = false;
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
  recentPlays = []; // Reset play history for new game
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
        isDriving: false,
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