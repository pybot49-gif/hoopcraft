import { GameState, SimPlayer, Vec2 } from './types';
import { dist, findNearestDefender, clearBallCarrier } from './utils';
import { skillModifier } from '../engine/utils';
import { getTacticAdvantage } from '../engine/tactics';
import { addStat } from './stats';

export function attemptShot(state: GameState, shooter: SimPlayer, basket: Vec2): void {
  const shooterName = shooter.player.name;
  const distToBasket = dist(shooter.pos, basket);
  
  let shotSkill: number;
  let basePct: number;
  let isDunk = false;
  
  if (distToBasket > 22) {
    const isCatchAndShoot = state.dribbleTime < 0.8;
    const threeSkill = shooter.player.skills.shooting.three_point;
    const casSkill = shooter.player.skills.shooting.catch_and_shoot;
    shotSkill = isCatchAndShoot ? Math.max(threeSkill, casSkill) : threeSkill;
    basePct = 0.33;
  } else if (distToBasket > 14) {
    shotSkill = shooter.player.skills.shooting.mid_range;
    basePct = 0.42;
  } else if (distToBasket > 8) {
    shotSkill = Math.max(shooter.player.skills.shooting.mid_range, shooter.player.skills.finishing.layup);
    basePct = 0.48;
  } else if (distToBasket > 3) {
    shotSkill = shooter.player.skills.finishing.layup;
    basePct = 0.62;
  } else {
    const dunkSkill = shooter.player.skills.finishing.dunk;
    const layupSkill = shooter.player.skills.finishing.layup;
    const nearDef = findNearestDefender(shooter, state);
    const defClose = nearDef && dist(nearDef.pos, shooter.pos) < 4;
    const defCanBlock = defClose && nearDef && nearDef.player.skills.defense.block >= 75;
    if (dunkSkill >= 70 && distToBasket < 2.5 && shooter.player.physical.vertical >= 65 && !defCanBlock) {
      isDunk = true;
      shotSkill = dunkSkill;
      basePct = 0.82;
    } else {
      shotSkill = layupSkill;
      basePct = 0.68;
    }
  }

  const tacticO = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  const tacticD = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
  const advantage = getTacticAdvantage(tacticO, tacticD);
  
  const nearestDef = findNearestDefender(shooter, state);
  const contestDistance = nearestDef ? dist(nearestDef.pos, shooter.pos) : 10;
  let contestModifier = 1.0;
  if (nearestDef && contestDistance < 6) {
    const contestSkill = nearestDef.player.skills.defense.shot_contest || 60;
    if (contestDistance < 3) {
      contestModifier = 0.55 + (1 - contestSkill / 100) * 0.2;
    } else {
      contestModifier = 0.75 + (1 - contestSkill / 100) * 0.2;
    }
  }
  
  if (shooter.player.isSuperstar) {
    contestModifier = Math.max(contestModifier, 0.75);
  }
  
  if (state.shotClock < 3) {
    contestModifier *= 0.85;
  }
  
  // BLOCK CHECK
  if (nearestDef && contestDistance < 8 && distToBasket < 18) {
    const blockSkill = nearestDef.player.skills.defense.block || 60;
    const defVertical = nearestDef.player.physical.vertical || 70;
    const shooterHeight = shooter.player.physical.height;
    const defHeight = nearestDef.player.physical.height;
    let blockChance = 0.01 + (blockSkill / 100) * 0.05 + (defVertical / 100) * 0.015;
    if (distToBasket < 6) blockChance *= 1.8;
    else if (distToBasket < 12) blockChance *= 1.2;
    else blockChance *= 0.5; // mid-range harder to block
    if (contestDistance > 5) blockChance *= 0.4;
    else if (contestDistance > 3) blockChance *= 0.7;
    if (defHeight > shooterHeight + 5) blockChance *= 1.3;
    if (isDunk) blockChance *= 0.3;
    if (blockSkill < 50) blockChance *= 0.2;
    blockChance = Math.min(0.15, blockChance);
    // Defender jumps to contest
    if (nearestDef.jumpZ === 0) {
      nearestDef.jumpVelZ = (defVertical / 100) * 14 + 4;
    }
    if (state.rng() < blockChance) {
      addStat(state, nearestDef.id, 'blk');
      addStat(state, shooter.id, 'fga');
      if (distToBasket > 22) addStat(state, shooter.id, 'tpa');
      state.lastEvent = `BLOCKED by ${nearestDef.player.name}!`;
      clearBallCarrier(state);
      const dir2 = state.possession === 0 ? 1 : -1;
      state.ball.pos = { ...shooter.pos };
      state.ball.bounceTarget = { 
        x: shooter.pos.x - dir2 * (3 + state.rng() * 6),
        y: shooter.pos.y + (state.rng() - 0.5) * 8 
      };
      state.ball.bouncing = true;
      state.ball.bounceProgress = 0;
      state.ball.z = 8;
      state.phase = 'rebound';
      state.phaseTicks = 0;
      return;
    }
  }

  const finalPct = basePct * skillModifier(shotSkill) * contestModifier * (1 + advantage);
  const willScore = state.rng() < finalPct;

  const vertical = shooter.player.physical.vertical || 70;
  if (isDunk) {
    shooter.jumpZ = 0;
    shooter.jumpVelZ = 18;
  } else {
    shooter.jumpZ = 0;
    shooter.jumpVelZ = (vertical / 100) * 14 + 6;
  }

  state.ball.inFlight = true;
  state.ball.flightFrom = { ...shooter.pos };
  state.ball.flightTo = { ...basket };
  state.ball.flightFromZ = 7;
  state.ball.flightPeakZ = 10 + distToBasket * 0.3;
  state.ball.flightProgress = 0;
  state.ball.flightDuration = 0.6 + distToBasket * 0.02;
  state.ball.isShot = true;
  state.ball.shotWillScore = willScore;
  
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
  
  // FOUL CHECK — shooting fouls
  const isFouled = (() => {
    if (contestDistance > 10) return false;
    let foulChance = 0;
    if (distToBasket < 5) foulChance = 0.18;
    else if (distToBasket < 10) foulChance = 0.12;
    else if (distToBasket < 22) foulChance = 0.06;
    else foulChance = 0.04;
    if (contestDistance < 3) foulChance *= 1.5;
    else if (contestDistance < 5) foulChance *= 1.2;
    else if (contestDistance > 7) foulChance *= 0.3;
    if (shooter.isDriving && distToBasket < 10) foulChance *= 1.3;
    return state.rng() < foulChance;
  })();
  
  if (isFouled) {
    // Reset ball flight — foul stops the shot sequence
    state.ball.inFlight = false;
    state.ball.isShot = false;
    const pts = distToBasket > 22 ? 3 : 2;
    if (nearestDef) addStat(state, nearestDef.id, 'pf');
    addStat(state, shooter.id, 'fga');
    if (distToBasket > 22) addStat(state, shooter.id, 'tpa');
    if (willScore) {
      addStat(state, shooter.id, 'fgm');
      addStat(state, shooter.id, 'pts', pts);
      if (distToBasket > 22) addStat(state, shooter.id, 'tpm');
      state.score[state.possession] += pts;
      // Assist tracking for and-one
      let assistStr = '';
      if (state.lastPassFrom && state.lastPassFrom !== shooter.id &&
          state.gameTime - state.lastPassTime < 7.0) {
        const assister = state.players.find(p => p.id === state.lastPassFrom);
        if (assister) {
          state.assists[state.possession]++;
          addStat(state, assister.id, 'ast');
          assistStr = ` (ast: ${assister.player.name})`;
        }
      }
      state.lastEvent = `AND ONE! ${shooterName} scores ${pts} + FT!${assistStr} (${state.score[0]}-${state.score[1]})`;
      state.freeThrows = { shooter, made: 0, total: 1, andOne: true };
    } else {
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
  (state.ball as any).shooterId = shooter.id;
  (state.ball as any).shooterPossession = state.possession;
  
  const contestStr = contestDistance < 3 ? ' (contested)' : contestDistance < 6 ? '' : ' (open)';
  const shotType = isDunk ? 'DUNK' : distToBasket > 22 ? '3PT' : distToBasket > 14 ? 'mid-range' : distToBasket > 8 ? 'floater' : 'layup';
  const playContext = state.currentPlay ? `[${state.currentPlay.name}] ` : '';
  
  clearBallCarrier(state);
  state.phase = 'shooting';
  state.currentPlay = null;
  
  state.lastEvent = `${playContext}${shooterName} ${shotType}${contestStr}`;
}
