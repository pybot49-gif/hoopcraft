import { GameState, SimPlayer, Vec2, PassType } from './types';
import { dist, distanceToLine, clearBallCarrier, findNearestDefender, getBallHandler, getTeamBasket, checkIfOpen } from './utils';
import { skillModifier } from '../engine/utils';
import { changePossession } from './core';

export function choosePassType(from: SimPlayer, to: SimPlayer, defTeam: SimPlayer[], rng: () => number): PassType {
  const passDist = dist(from.pos, to.pos);
  
  let defenderInLane = false;
  for (const def of defTeam) {
    const dToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    if (dToLine < 3 && dist(def.pos, from.pos) < passDist) {
      defenderInLane = true;
      break;
    }
  }
  
  if (defenderInLane) {
    if (rng() < 0.4) return 'lob';
    if (rng() < 0.5) return 'bounce';
    return 'overhead';
  }
  
  if (passDist > 20) return 'overhead';
  if (passDist < 8) return 'chest';
  return rng() < 0.7 ? 'chest' : 'bounce';
}

export function getPassZ(passType: PassType, t: number, passDist: number): { fromZ: number; peakZ: number } {
  switch (passType) {
    case 'chest':    return { fromZ: 5, peakZ: 5.5 + passDist * 0.02 };
    case 'bounce':   return { fromZ: 4, peakZ: 2 };
    case 'lob':      return { fromZ: 7, peakZ: 12 + passDist * 0.1 };
    case 'overhead': return { fromZ: 8, peakZ: 9 + passDist * 0.05 };
  }
}

export function getPassOptions(state: GameState, ballHandler: SimPlayer): SimPlayer[] {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const candidates = offTeam.filter(p => {
    if (p === ballHandler) return false;
    if (state.lastPassFrom === p.id && state.gameTime - state.lastPassTime < 1.5) return false;
    if (isPassLaneBlockedLocal(ballHandler, p, state)) return false;
    return true;
  });
  
  const scoredCandidates = candidates.map(candidate => {
    let score = 0;
    const defender = findNearestDefender(candidate, state);
    const openness = defender ? dist(defender.pos, candidate.pos) : 12;
    score += openness * 2;
    
    const basket = getTeamBasket(state.possession);
    const distToBasket = dist(candidate.pos, basket);
    score += Math.max(0, (30 - distToBasket)) * 1.5;
    
    if (distToBasket > 15) {
      const shootingSkill = (candidate.player.skills.shooting.three_point + candidate.player.skills.shooting.mid_range) / 2;
      score += skillModifier(shootingSkill) * 3;
    }
    
    if (candidate.player.isSuperstar) {
      score += 5;
    }
    
    const courtVision = ballHandler.player.skills.playmaking.court_vision || 50;
    if (courtVision < 30) {
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

function isPassLaneBlockedLocal(from: SimPlayer, to: SimPlayer, state: GameState): boolean {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const passDist = dist(from.pos, to.pos);
  
  for (const def of defTeam) {
    const dToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    const defDistFromPasser = dist(def.pos, from.pos);
    if (defDistFromPasser > passDist) continue;
    const blockRadius = passDist > 20 ? 1.5 : 2.5;
    if (dToLine < blockRadius) return true;
  }
  return false;
}

export function findAlleyOopTarget(state: GameState, passer: SimPlayer, basketPos: Vec2): SimPlayer | null {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession && p !== passer);
  
  let bestTarget: SimPlayer | null = null;
  let bestScore = 0;
  
  for (const p of offTeam) {
    const oopSkill = p.player.skills.finishing.alley_oop;
    const dunkSkill = p.player.skills.finishing.dunk;
    const vertical = p.player.physical.vertical;
    const distToBasket = dist(p.pos, basketPos);
    
    if (distToBasket > 12) continue;
    if (oopSkill < 65 || dunkSkill < 65 || vertical < 65) continue;
    
    const nearDef = findNearestDefender(p, state);
    const defDist = nearDef ? dist(nearDef.pos, p.pos) : 20;
    const rimProtector = nearDef && dist(nearDef.pos, basketPos) < 5 && nearDef.player.skills.defense.block >= 75;
    if (rimProtector) continue;
    
    const lobSkill = passer.player.skills.playmaking.lob_pass;
    const passDist = dist(passer.pos, p.pos);
    if (passDist < 8 || passDist > 35) continue;
    
    const score = (oopSkill / 100) * 3 + (dunkSkill / 100) * 2 + (vertical / 100) * 2
      + (lobSkill / 100) * 2 + (defDist > 5 ? 2 : 0) + (p.isCutting ? 3 : 0)
      + (p.player.isSuperstar ? 2 : 0);
    
    if (score > bestScore) {
      bestScore = score;
      bestTarget = p;
    }
  }
  
  return bestScore > 10 ? bestTarget : null;
}

export function throwAlleyOop(state: GameState, passer: SimPlayer, target: SimPlayer, basketPos: Vec2): void {
  const lobSkill = passer.player.skills.playmaking.lob_pass;
  const oopSkill = target.player.skills.finishing.alley_oop;
  const dunkSkill = target.player.skills.finishing.dunk;
  const vertical = target.player.physical.vertical;
  
  const successChance = 0.15
    + skillModifier(lobSkill) * 0.20
    + skillModifier(oopSkill) * 0.20
    + skillModifier(dunkSkill) * 0.10
    + (vertical / 100) * 0.15;
  
  const willScore = state.rng() < Math.min(0.85, successChance);
  
  const passDist = dist(passer.pos, basketPos);
  
  target.jumpZ = 0;
  target.jumpVelZ = 20;

  state.ball.inFlight = true;
  state.ball.flightFrom = { ...passer.pos };
  state.ball.flightTo = { ...basketPos };
  state.ball.flightFromZ = 8;
  state.ball.flightPeakZ = 16 + passDist * 0.1;
  state.ball.flightProgress = 0;
  state.ball.flightDuration = 0.5 + passDist * 0.015;
  state.ball.isShot = true;
  state.ball.shotWillScore = willScore;
  state.ball.missType = willScore ? null : (state.rng() < 0.5 ? 'rim_out' : 'back_iron');
  (state.ball as any).shooterName = target.player.name;
  (state.ball as any).shooterId = target.id;
  (state.ball as any).isAlleyOop = true;
  
  clearBallCarrier(state);
  
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

export function passBall(state: GameState, from: SimPlayer, to: SimPlayer): void {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const passDist = dist(from.pos, to.pos);
  
  const passType = choosePassType(from, to, defTeam, state.rng);
  const passZ = getPassZ(passType, 0, passDist);
  
  // Check for interception
  for (const def of defTeam) {
    const dToLine = distanceToLine(def.pos, { from: from.pos, to: to.pos });
    const defDist = dist(def.pos, from.pos);
    
    if (dToLine < 2 && defDist < passDist && defDist > 2) {
      const stealSkill = def.player.skills.defense.steal;
      let baseChance = 0.0005 + (stealSkill / 100) * 0.006;
      
      const defReach = 8 + (def.player.physical.height / 200) * 1.5;
      
      if (passType === 'lob' && passZ.peakZ > defReach) {
        baseChance *= 0.1;
      } else if (passType === 'bounce') {
        baseChance *= 0.5;
      } else if (passType === 'overhead' && passZ.peakZ > defReach - 1) {
        baseChance *= 0.3;
      }
      
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
  state.dribbleTime = 0;
  state.passCount++;
  state.lastEvent = `${from.player.name} ${passType} pass to ${to.player.name}`;
}
