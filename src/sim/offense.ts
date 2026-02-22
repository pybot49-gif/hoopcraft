import { GameState, SimPlayer, Vec2 } from './types';
import { dist, getBallHandler, findNearestDefender, checkIfOpen, getTeamBasket } from './utils';
import { isDefenderBetween } from './defense';
import { passBall, findAlleyOopTarget, throwAlleyOop } from './passing';
import { attemptShot } from './shooting';
import { emptyBoxStats } from './stats';

export function checkIfWideOpen(player: SimPlayer, state: GameState): boolean {
  const defender = findNearestDefender(player, state);
  return !defender || dist(defender.pos, player.pos) > 8;
}

export function getOpenTeammates(state: GameState, handler: SimPlayer): SimPlayer[] {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  return offTeam.filter(p => {
    if (p === handler) return false;
    const defender = findNearestDefender(p, state);
    return !defender || dist(defender.pos, p.pos) > 6;
  });
}

export function findBestScorer(team: SimPlayer[]): SimPlayer {
  return team.reduce((best, p) => {
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

export function executeReadAndReact(handler: SimPlayer, state: GameState, basketPos: Vec2): void {
  const distToBasket = dist(handler.pos, basketPos);
  const isOpen = checkIfOpen(handler, state);
  const isWideOpen = checkIfWideOpen(handler, state);
  const openTeammates = getOpenTeammates(state, handler);
  const holdTime = state.dribbleTime;
  
  // Decision frequency: 4x per second (every ~15 ticks)
  const isDecisionTick = Math.floor(state.gameTime * 4) !== Math.floor((state.gameTime - 1/60) * 4);
  
  const mustAttack = holdTime > 3.5 || state.shotClock < 4;
  const shotClockPressure = state.shotClock < 7;
  const passFirst = holdTime < 1.0 && state.passCount === 0 && !mustAttack && !shotClockPressure;
  
  const handlerStats = state.boxStats.get(handler.id);
  const teamPlayers = state.players.filter(p => p.teamIdx === handler.teamIdx);
  const teamAvgFGA = teamPlayers.reduce((sum, p) => sum + (state.boxStats.get(p.id)?.fga || 0), 0) / 5;
  const teamTotalFGA = teamPlayers.reduce((sum, p) => sum + (state.boxStats.get(p.id)?.fga || 0), 0);
  const isHogging = handlerStats && teamAvgFGA > 3 && handlerStats.fga > teamAvgFGA * 1.4;
  const isHardCapped = handlerStats && (handlerStats.fga >= 22 || (teamTotalFGA > 20 && handlerStats.fga / teamTotalFGA > 0.28));
  
  const noPasses = state.passCount === 0;
  const fewPasses = state.passCount < 2;
  
  const defAhead = findNearestDefender(handler, state);
  const defDist = defAhead ? dist(defAhead.pos, handler.pos) : 20;
  const defBetween = defAhead ? isDefenderBetween(handler, defAhead, basketPos) : false;
  const laneClear = defDist > 6 && !defBetween;
  
  // TOO MANY PASSES — force a shot after 4+ passes
  // Too many passes — force a shot (but allow plays to develop)
  if (state.passCount >= 6) {
    attemptShot(state, handler, basketPos);
    return;
  }
  
  // SHOT CLOCK PRESSURE — force shot or drive
  if (shotClockPressure) {
    if (distToBasket < 30) {
      attemptShot(state, handler, basketPos);
      return;
    }
    handler.targetPos = { ...basketPos };
    handler.isCutting = true;
    handler.isDriving = true;
    return;
  }
  if (mustAttack) {
    attemptShot(state, handler, basketPos);
    return;
  }

  // CATCH-AND-SHOOT — just received a pass and open? Shoot immediately!
  // This is the key to higher assist rates
  if (holdTime < 0.8 && state.passCount >= 1 && isOpen && !isHogging) {
    const catchShoot = handler.player.skills.shooting.catch_and_shoot || 65;
    if (distToBasket > 22 && distToBasket < 27 && handler.player.skills.shooting.three_point >= 62) {
      if (state.rng() < 0.55 + (catchShoot / 100) * 0.25) {
        attemptShot(state, handler, basketPos);
        return;
      }
    } else if (distToBasket > 8 && distToBasket < 22) {
      if (state.rng() < 0.45 + (catchShoot / 100) * 0.20) {
        attemptShot(state, handler, basketPos);
        return;
      }
    }
  }

  // 0. COMMITTED DRIVE
  if (handler.isDriving) {
    if (distToBasket < 6) {
      const openPerimeter = openTeammates.find(p => {
        const d = dist(p.pos, basketPos);
        return d > 22 && d < 27 && p.player.skills.shooting.three_point >= 62;
      });
      if (!isHogging && openPerimeter && state.rng() < 0.35) {
        handler.isDriving = false;
        passBall(state, handler, openPerimeter);
        return;
      }
      handler.isDriving = false;
      attemptShot(state, handler, basketPos);
      return;
    }
    handler.targetPos = { ...basketPos };
    handler.isCutting = true;
    return;
  }
  
  // 1. At the rim
  if (distToBasket < 8) {
    const nearDef = findNearestDefender(handler, state);
    const contested = nearDef && dist(nearDef.pos, handler.pos) < 4;
    const justCaughtBall = holdTime < 0.5;
    const kickOutChance = contested ? 0.35 : justCaughtBall ? 0.2 : 0;
    if (kickOutChance > 0 && openTeammates.length > 0 && state.rng() < kickOutChance) {
      const perimeterTarget = openTeammates.find(p => {
        const d = dist(p.pos, basketPos);
        return d > 18 && p.player.skills.shooting.three_point >= 60;
      });
      const kickTarget = perimeterTarget || openTeammates[0];
      passBall(state, handler, kickTarget);
      return;
    }
    attemptShot(state, handler, basketPos);
    return;
  }
  
  // SUPERSTAR TENDENCIES
  if (handler.player.isSuperstar && !passFirst && !isHogging) {
    const skills = handler.player.skills;
    if (skills.shooting.three_point >= 90 && distToBasket > 22 && distToBasket < 30 && isOpen && !fewPasses) {
      attemptShot(state, handler, basketPos);
      return;
    }
    if (skills.finishing.dunk >= 90 && distToBasket < 20) {
      const sDefAhead = findNearestDefender(handler, state);
      const sLaneClear = !sDefAhead || dist(sDefAhead.pos, handler.pos) > 6;
      if (sLaneClear) {
        const sDir = state.possession === 0 ? 1 : -1;
        handler.targetPos = { x: basketPos.x - sDir * 1, y: basketPos.y };
        handler.isCutting = true;
        return;
      }
    }
  }
  
  // 2. Wide open catch-and-shoot — ALWAYS shoot if truly wide open (even if hogging)
  if (isWideOpen && holdTime < 0.5 && distToBasket > 22 && distToBasket < 27) {
    const moreOpenTeammate = openTeammates.find(p => {
      const pDef = findNearestDefender(p, state);
      const pOpen = pDef ? dist(pDef.pos, p.pos) : 15;
      const myDef = findNearestDefender(handler, state);
      const myOpen = myDef ? dist(myDef.pos, handler.pos) : 15;
      return pOpen > myOpen + 2 || dist(p.pos, basketPos) < distToBasket - 5;
    });
    if (moreOpenTeammate && state.rng() < 0.4) {
      passBall(state, handler, moreOpenTeammate);
      return;
    }
    
    const catchShoot = handler.player.skills.shooting.catch_and_shoot;
    const three = handler.player.skills.shooting.three_point;
    const bestShootingSkill = Math.max(catchShoot, three);
    if (bestShootingSkill >= 70 || (bestShootingSkill >= 60 && state.rng() < 0.35)) {
      if (isHardCapped && openTeammates.length > 0) {
        // Only pass if HARD capped (>25 FGA), not soft hogging — wide open 3 is too good to pass up
        passBall(state, handler, openTeammates[0]);
        return;
      }
      if (!fewPasses || state.rng() < 0.25) {
        attemptShot(state, handler, basketPos);
        return;
      }
    }
  }
  
  // 2b. Mid-range catch-and-shoot
  if (isOpen && holdTime < 1.0 && distToBasket > 10 && distToBasket <= 22 && !isHogging) {
    const midRange = handler.player.skills.shooting.mid_range;
    if (midRange >= 70 && state.rng() < 0.55) {
      attemptShot(state, handler, basketPos);
      return;
    }
  }
  
  // 2c. Close-range catch-and-finish
  if (holdTime < 0.8 && distToBasket < 10 && distToBasket > 3) {
    const finishing = handler.player.skills.finishing.layup;
    if (finishing >= 65) {
      attemptShot(state, handler, basketPos);
      return;
    }
  }
  
  if (!isDecisionTick) return;
  
  // === PASS-FIRST SECTION ===
  if (passFirst && openTeammates.length > 0 && state.rng() < 0.65) {
    const superstar = openTeammates.find(p => p.player.isSuperstar);
    if (superstar && state.rng() < 0.5) {
      passBall(state, handler, superstar);
      return;
    }
    
    const openThreeShooter = openTeammates.find(p => {
      const d = dist(p.pos, basketPos);
      return d > 22 && d < 27 && p.player.skills.shooting.three_point >= 62;
    });
    if (openThreeShooter) {
      passBall(state, handler, openThreeShooter);
      return;
    }
    
    const roller = state.players.find(p => p.currentRole === 'screener' && p.teamIdx === state.possession);
    if (roller && checkIfOpen(roller, state) && dist(roller.pos, basketPos) < 12) {
      passBall(state, handler, roller);
      return;
    }
    
    if (openTeammates.length > 0) {
      const bestTarget = openTeammates.sort((a, b) => {
        const aDef = findNearestDefender(a, state);
        const bDef = findNearestDefender(b, state);
        const aOpen = aDef ? dist(aDef.pos, a.pos) : 15;
        const bOpen = bDef ? dist(bDef.pos, b.pos) : 15;
        return bOpen - aOpen;
      })[0];
      passBall(state, handler, bestTarget);
      return;
    }
  }
  
  // Usage balancing — if hogging, prefer to pass (but not 90% forced)
  if ((isHogging || isHardCapped) && !mustAttack && openTeammates.length > 0) {
    const passProb = isHardCapped ? 0.85 : 0.65; // hard cap = very likely pass, soft hog = moderate
    if (state.rng() < passProb) {
      const target = openTeammates.sort((a, b) => {
        const aFGA = state.boxStats.get(a.id)?.fga || 0;
        const bFGA = state.boxStats.get(b.id)?.fga || 0;
        return aFGA - bFGA; // least used player
      })[0];
      passBall(state, handler, target);
      return;
    }
  }
  
  // 3d. ALLEY-OOP
  if (!mustAttack && handler.player.skills.playmaking.lob_pass >= 65) {
    const oopTarget = findAlleyOopTarget(state, handler, basketPos);
    if (oopTarget && state.rng() < 0.6) {
      throwAlleyOop(state, handler, oopTarget, basketPos);
      return;
    }
  }
  
  // 3. Read the defense — pass hunger
  // passHunger: 0 → 0.45, 1 → 0.30, 2 → 0.15, 3+ → 0.05
  const passHunger = Math.min(0.45, 0.05 + Math.max(0, 3 - state.passCount) * 0.13);
  
  if (!shotClockPressure && openTeammates.length > 0 && state.rng() < passHunger) {
    const superstar = openTeammates.find(p => p.player.isSuperstar);
    if (superstar && state.rng() < 0.45) {
      passBall(state, handler, superstar);
      return;
    }
    
    const openThreeShooter = openTeammates.find(p => {
      const d = dist(p.pos, basketPos);
      return d > 22 && d < 27 && p.player.skills.shooting.three_point >= 62;
    });
    if (openThreeShooter) {
      passBall(state, handler, openThreeShooter);
      return;
    }
    
    const roller = state.players.find(p => p.currentRole === 'screener' && p.teamIdx === state.possession);
    if (roller && checkIfOpen(roller, state) && dist(roller.pos, basketPos) < 12) {
      passBall(state, handler, roller);
      return;
    }
    
    const bestTarget = openTeammates.sort((a, b) => {
      const aDef = findNearestDefender(a, state);
      const bDef = findNearestDefender(b, state);
      const aOpen = aDef ? dist(aDef.pos, a.pos) : 15;
      const bOpen = bDef ? dist(bDef.pos, b.pos) : 15;
      return bOpen - aOpen;
    })[0];
    passBall(state, handler, bestTarget);
    return;
  }
  
  const aggressive = holdTime > 2;
  // Shot willingness increases with passes: 0→0.30, 1→0.50, 2→0.70, 3→0.85, 4+→0.95
  const shotWill = Math.min(0.95, 0.30 + state.passCount * 0.20);
  
  // 3a. DRIVE
  if (laneClear && distToBasket > 8 && distToBasket < 28 && (state.passCount >= 1 || holdTime > 2.0)) {
    handler.targetPos = { ...basketPos };
    handler.isCutting = true;
    handler.isDriving = true;
    return;
  }
  
  // 3b. Open mid-range
  if (isOpen && distToBasket < 22 && distToBasket > 8) {
    if (isHogging && openTeammates.length > 0) {
      passBall(state, handler, openTeammates[0]);
      return;
    }
    if (state.rng() < shotWill) {
      attemptShot(state, handler, basketPos);
      return;
    }
  }
  
  // 3c. Open 3
  if (isOpen && distToBasket > 22 && distToBasket < 27) {
    const three = handler.player.skills.shooting.three_point;
    if (three >= 60 || aggressive) {
      if (isHogging && openTeammates.length > 0) {
        passBall(state, handler, openTeammates[0]);
        return;
      }
      if (state.rng() < shotWill) {
        attemptShot(state, handler, basketPos);
        return;
      }
    }
    if (three < 60 && laneClear) {
      handler.targetPos = { ...basketPos };
      handler.isCutting = true;
      handler.isDriving = true;
      return;
    }
  }
  
  // 4. Default pass to open teammate
  if (openTeammates.length > 0 && state.passCount < 5) {
    passBall(state, handler, openTeammates[0]);
    return;
  }
  
  // 5. Just shoot — too many passes already
  if (distToBasket < 27) {
    attemptShot(state, handler, basketPos);
    return;
  }
  
  // 6. Dribble toward basket
  handler.targetPos = { x: basketPos.x, y: basketPos.y + (state.rng() - 0.5) * 4 };
  handler.isCutting = true;
  handler.isDriving = true;
}
