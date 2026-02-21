import { Player, OffenseTactic, DefenseTactic } from '../engine/types';

export interface Vec2 { x: number; y: number }

export type SlotName = 
  | 'SLOT_LEFT_CORNER' 
  | 'SLOT_LEFT_WING' 
  | 'SLOT_LEFT_ELBOW' 
  | 'SLOT_TOP_KEY' 
  | 'SLOT_RIGHT_ELBOW' 
  | 'SLOT_RIGHT_WING' 
  | 'SLOT_RIGHT_CORNER' 
  | 'SLOT_LOW_POST_L' 
  | 'SLOT_LOW_POST_R';

export type OffenseRole = 'ballHandler' | 'screener' | 'cutter' | 'spacer' | 'postUp';

export type PossessionStage = 'early' | 'mid' | 'late' | 'desperation';

export type RoleAction = 
  | { type: 'moveTo', slot: SlotName }
  | { type: 'screen', target: OffenseRole }
  | { type: 'cut', from: SlotName, to: SlotName }
  | { type: 'drive', direction: 'left' | 'right' | 'baseline' }
  | { type: 'hold' }
  | { type: 'postUp' }
  | { type: 'pop', slot: SlotName }
  | { type: 'roll' }
  | { type: 'relocate' }
  | { type: 'passTo', target: OffenseRole }
  | { type: 'shootIfOpen' }
  | { type: 'readAndReact' }
  | { type: 'callForBall' }
  | { type: 'entryPass', target: OffenseRole };

export interface PlayStep {
  id: number;
  duration: number;
  actions: Map<OffenseRole, RoleAction>;
  trigger: 'time' | 'position' | 'pass';
  triggerCondition?: () => boolean;
}

export interface Play {
  name: string;
  steps: PlayStep[];
}

export interface ManDefenseState {
  assignments: Map<string, string>;
}

export interface SimPlayer {
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
  isDribbling: boolean;
  isDriving: boolean;
  catchTimer: number;
  sprintTimer: number;
  jumpZ: number;
  jumpVelZ: number;
}

export type MissType = 'rim_out' | 'back_iron' | 'airball' | 'blocked' | 'front_rim' | null;

export interface PlayerBoxStats {
  pts: number;
  reb: number;
  oreb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  pf: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  min: number;
}

export interface BallState {
  pos: Vec2;
  z: number;
  carrier: SimPlayer | null;
  inFlight: boolean;
  flightFrom: Vec2;
  flightTo: Vec2;
  flightFromZ: number;
  flightPeakZ: number;
  flightProgress: number;
  flightDuration: number;
  isShot: boolean;
  shotWillScore: boolean;
  missType: MissType;
  bouncing: boolean;
  bounceTarget: Vec2;
  bounceProgress: number;
  bounceZ: number;
  bounceVelZ: number;
  jumpBall?: {
    active: boolean;
    height: number;
    winner: SimPlayer | null;
  };
}

export interface GameState {
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
  
  slots: Map<SlotName, string | null>;
  roles: Map<string, OffenseRole>;
  defAssignments: Map<string, string>;
  currentPlay: Play | null;
  currentStep: number;
  stepTimer: number;
  lastPassFrom: string | null;
  lastPassTime: number;
  dribbleTime: number;
  crossedHalfCourt: boolean;
  advanceClock: number;
  possessionStage: PossessionStage;
  playCompleted: boolean;
  freeThrows: { shooter: SimPlayer; made: number; total: number; andOne: boolean } | null;
  hasFastBroken: boolean;
  passCount: number;
  deadBallTimer: number;
  assists: [number, number];
  lastAssist: string | null;
  boxStats: Map<string, PlayerBoxStats>;
}

export type PassType = 'chest' | 'bounce' | 'lob' | 'overhead';

export type PlayDef = { name: string; category: string; steps: PlayStep[] };

export interface TickPlayerSnapshot {
  id: string; name: string; pos: string; x: number; y: number;
  hasBall: boolean; role?: string; teamIdx: number;
  vx: number; vy: number; fatigue: number;
  isCutting: boolean; isScreening: boolean; isDriving: boolean; isDribbling: boolean;
  catchTimer: number;
}

export interface TickSnapshot {
  t: number; phase: string; possession: number; shotClock: number;
  players: TickPlayerSnapshot[];
  event?: string; play?: string;
  ballX: number; ballY: number; ballInFlight: boolean;
  assists: [number, number];
}
