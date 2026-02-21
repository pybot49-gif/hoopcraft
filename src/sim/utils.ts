import { Vec2, SimPlayer, GameState } from './types';
import { BASKET_X_LEFT, BASKET_X_RIGHT, BASKET_Y, COURT_W, COURT_H } from './constants';

export function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function normalizeVector(v: Vec2): Vec2 {
  const length = Math.sqrt(v.x * v.x + v.y * v.y);
  return length > 0 ? { x: v.x / length, y: v.y / length } : { x: 0, y: 0 };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function getTeamBasket(possession: 0 | 1): Vec2 {
  const bx = possession === 0 ? BASKET_X_RIGHT : BASKET_X_LEFT;
  return { x: bx, y: BASKET_Y };
}

export function getOwnBasket(possession: 0 | 1): Vec2 {
  const bx = possession === 0 ? BASKET_X_LEFT : BASKET_X_RIGHT;
  return { x: bx, y: BASKET_Y };
}

export function getBallHandler(state: GameState): SimPlayer | null {
  return state.ball.carrier;
}

export function clearBallCarrier(state: GameState): void {
  for (const p of state.players) {
    p.hasBall = false;
  }
  state.ball.carrier = null;
}

export function findNearestDefender(offensivePlayer: SimPlayer, state: GameState): SimPlayer | null {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  return defTeam.reduce((closest, def) => 
    dist(def.pos, offensivePlayer.pos) < dist(closest.pos, offensivePlayer.pos) ? def : closest
  );
}

export function checkIfOpen(player: SimPlayer, state: GameState): boolean {
  const defender = findNearestDefender(player, state);
  return !defender || dist(defender.pos, player.pos) > 6;
}

export function isPassLaneBlocked(from: SimPlayer, to: SimPlayer, state: GameState): boolean {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const passDist = dist(from.pos, to.pos);
  
  for (const def of defTeam) {
    const distToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    const defDistFromPasser = dist(def.pos, from.pos);
    if (defDistFromPasser > passDist) continue;
    const blockRadius = passDist > 20 ? 1.5 : 2.5;
    if (distToLine < blockRadius) {
      return true;
    }
  }
  return false;
}

export function distanceToLine(point: Vec2, line: { from: Vec2; to: Vec2 }): number {
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

export function findDefenderOf(offPlayer: SimPlayer, state: GameState): SimPlayer | null {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  return defTeam.find(def => state.defAssignments.get(def.id) === offPlayer.id) || null;
}

export function swapAssignments(def1: SimPlayer, def2: SimPlayer, state: GameState): void {
  const assignment1 = state.defAssignments.get(def1.id);
  const assignment2 = state.defAssignments.get(def2.id);
  
  if (assignment1) state.defAssignments.set(def2.id, assignment1);
  if (assignment2) state.defAssignments.set(def1.id, assignment2);
}

export function getPossessionStage(shotClock: number): import('./types').PossessionStage {
  if (shotClock > 18) return 'early';
  if (shotClock > 10) return 'mid';
  if (shotClock > 4) return 'late';
  return 'desperation';
}
