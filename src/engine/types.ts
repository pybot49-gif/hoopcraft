export interface PhysicalAttributes {
  height: number;
  wingspan: number;
  weight: number;
  speed: number;
  acceleration: number;
  vertical: number;
  strength: number;
  stamina: number;
  agility: number;
  hand_size: number;
}

export interface ShootingSkills {
  mid_range: number;
  three_point: number;
  close_shot: number;
  free_throw: number;
  catch_and_shoot: number;
  pull_up: number;
  fadeaway: number;
  stepback: number;
}

export interface FinishingSkills {
  layup: number;
  euro_step: number;
  floater: number;
  dunk: number;
  alley_oop: number;
  reverse_layup: number;
  post_move: number;
}

export interface PlaymakingSkills {
  passing: number;
  ball_handling: number;
  court_vision: number;
  crossover: number;
  pnr_read: number;
  no_look_pass: number;
  lob_pass: number;
}

export interface DefenseSkills {
  perimeter_d: number;
  interior_d: number;
  shot_contest: number;
  block: number;
  steal: number;
  help_defense: number;
  box_out: number;
}

export interface AthleticSkills {
  rebounding: number;
  hustle: number;
  screens: number;
  off_ball_movement: number;
  conditioning: number;
}

export interface PlayerSkills {
  shooting: ShootingSkills;
  finishing: FinishingSkills;
  playmaking: PlaymakingSkills;
  defense: DefenseSkills;
  athletic: AthleticSkills;
}

export type Position = 'PG' | 'SG' | 'SF' | 'PF' | 'C';

export interface Player {
  id: string;
  name: string;
  position: Position;
  physical: PhysicalAttributes;
  skills: PlayerSkills;
  isSuperstar: boolean;
  archetype: string;
}

export interface Team {
  id: string;
  name: string;
  color: string;
  players: Player[];
}

export type OffenseTactic = 'fast_break' | 'motion' | 'shoot' | 'inside' | 'iso';
export type DefenseTactic = 'man' | 'zone' | 'press' | 'gamble' | 'fortress';

export interface PlayerGameStats {
  playerId: string;
  minutes: number;
  points: number;
  fgMade: number;
  fgAttempted: number;
  threeMade: number;
  threeAttempted: number;
  ftMade: number;
  ftAttempted: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fouls: number;
  plusMinus: number;
}

export interface PlayByPlayEntry {
  quarter: number;
  time: string;
  text: string;
  scoreHome: number;
  scoreAway: number;
}

export interface QuarterScore {
  home: number;
  away: number;
}

export interface GameResult {
  homeStats: PlayerGameStats[];
  awayStats: PlayerGameStats[];
  playByPlay: PlayByPlayEntry[];
  quarterScores: QuarterScore[];
  finalScoreHome: number;
  finalScoreAway: number;
  seed: number;
}
