import { GameState, SimPlayer, Vec2, TickSnapshot } from './types';
import { COURT_W, HALF_X, BASKET_Y } from './constants';
import { dist, getBallHandler, clearBallCarrier, getTeamBasket, getOwnBasket, findNearestDefender, checkIfOpen, getPossessionStage } from './utils';
import { createRng, skillModifier } from '../engine/utils';
import { metroHawks, bayCityWolves } from '../store/teamsSlice';
import { Team } from '../engine/types';

import { updateDefenseAssignments, handleScreenDefense, handleHelpDefense } from './defense';
import { offBallMovement, enforceFloorSpacing, fillEmptySlots, movePlayerToward } from './movement';
import { assignRoles, selectPlay, updateCurrentPlay, getSlotPositions, assignInitialSlots, resetRecentPlays, PLAY_FAST_BREAK, PLAY_SECONDARY_BREAK, PLAY_CHERRY_PICK } from './playbook';
import { executeReadAndReact, findBestScorer, getOpenTeammates, checkIfWideOpen } from './offense';
import { attemptShot } from './shooting';
import { handleRebound } from './rebounding';
import { handleFreeThrows } from './freethrows';
import { updateBallFlight } from './physics';
import { passBall } from './passing';
import { addStat, emptyBoxStats } from './stats';

const _tickLog: TickSnapshot[] = [];
(window as unknown as Record<string, unknown>).__hoopcraft_ticks = _tickLog;

// Expose analyze
(window as unknown as Record<string, unknown>).__hoopcraft_analyze = undefined;

export function changePossession(state: GameState, event: string): void {
  state.possession = (1 - state.possession) as 0 | 1;
  state.phase = 'inbound';
  state.phaseTicks = 0;
  state.shotClock = 24;
  state.currentPlay = null;
  state.deadBallTimer = 0.5;
  
  resetPossession(state);
  if (event) state.lastEvent = event;
}

export function resetPossession(state: GameState): void {
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
  state.hasFastBroken = false;
  state.passCount = 0;
  
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

  for (let i = 0; i < offTeam.length; i++) {
    offTeam[i].targetPos = { 
      x: ownBasket.x + dir * (5 + i * 2), 
      y: BASKET_Y + (i - 2) * 5 
    };
  }

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

function handleJumpBall(state: GameState): void {
  const centers = state.players.filter(p => p.player.position === 'C');
  if (centers.length >= 2) {
    centers[0].targetPos = { x: HALF_X - 2, y: BASKET_Y };
    centers[1].targetPos = { x: HALF_X + 2, y: BASKET_Y };
  }
  
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
    executeJumpBall(state, centers);
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

function handleInbound(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[], dir: number): void {
  const ownBasket = getOwnBasket(state.possession);
  const oppBasket = getTeamBasket(state.possession);
  
  const defDir = state.possession === 0 ? 1 : -1;
  for (let i = 0; i < defTeam.length; i++) {
    const depthOrder = [3, 4, 2, 1, 0];
    const depth = depthOrder[i] || i;
    defTeam[i].targetPos = {
      x: oppBasket.x - defDir * (6 + depth * 5),
      y: BASKET_Y + (i - 2) * 7
    };
  }
  
  if (state.phaseTicks < 90) {
    const inbounder = offTeam[0];
    const baselineX = dir > 0 ? 0.5 : COURT_W - 0.5;
    inbounder.targetPos = { x: baselineX, y: BASKET_Y + 5 };
    
    if (!getBallHandler(state)) {
      clearBallCarrier(state);
      inbounder.hasBall = true;
      state.ball.carrier = inbounder;
    }
    
    const receiverSpots = [
      { x: ownBasket.x + dir * 12, y: BASKET_Y - 8 },
      { x: ownBasket.x + dir * 15, y: BASKET_Y + 8 },
      { x: ownBasket.x + dir * 20, y: BASKET_Y },
      { x: ownBasket.x + dir * 10, y: BASKET_Y + 15 },
    ];
    for (let i = 1; i < offTeam.length; i++) {
      offTeam[i].targetPos = { ...receiverSpots[Math.min(i - 1, receiverSpots.length - 1)] };
    }
    
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
    
  } else {
    const inbounder = getBallHandler(state);
    if (inbounder) {
      const receivers = offTeam
        .filter(p => p !== inbounder)
        .map(p => {
          const nearDef = findNearestDefender(p, state);
          const openness = nearDef ? dist(nearDef.pos, p.pos) : 15;
          const pgBonus = p.player.position === 'PG' ? 10 : 0;
          const proximity = 20 - dist(p.pos, inbounder.pos);
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
  
  const crossedHalfCourt = (state.possession === 0 && handler.pos.x > HALF_X) || 
                          (state.possession === 1 && handler.pos.x < HALF_X);
  
  if (crossedHalfCourt) {
    state.crossedHalfCourt = true;
  }
  
  handler.targetPos = { x: basketPos.x - dir * 22, y: BASKET_Y };
  
  const wings = offTeam.filter(p => p !== handler && (p.player.position === 'SF' || p.player.position === 'SG'));
  const bigs = offTeam.filter(p => p !== handler && (p.player.position === 'PF' || p.player.position === 'C'));
  const others = offTeam.filter(p => p !== handler && !wings.includes(p) && !bigs.includes(p));
  
  wings.forEach((w, i) => {
    w.targetPos = {
      x: basketPos.x - dir * 18,
      y: BASKET_Y + (i === 0 ? -16 : 16)
    };
  });
  
  bigs.forEach((b, i) => {
    b.targetPos = {
      x: basketPos.x - dir * (28 + i * 4),
      y: BASKET_Y + (i === 0 ? -6 : 6)
    };
  });
  
  others.forEach((p, i) => {
    p.targetPos = {
      x: basketPos.x - dir * 24,
      y: BASKET_Y + (i === 0 ? -10 : 10)
    };
  });
  
  for (let i = 0; i < defTeam.length; i++) {
    const isGuard = defTeam[i].player.position === 'PG' || defTeam[i].player.position === 'SG';
    defTeam[i].targetPos = {
      x: basketPos.x - dir * (isGuard ? 18 : 8 + i * 2),
      y: BASKET_Y + (i - 2) * 6
    };
  }
  
  if (Math.abs(handler.pos.x - HALF_X) > 8) {
    const defPastHalf = defTeam.filter(d => {
      return state.possession === 0 
        ? d.pos.x > HALF_X + 5
        : d.pos.x < HALF_X - 5;
    }).length;
    
    const defDeepBehind = defTeam.filter(d => {
      return state.possession === 0 
        ? d.pos.x > HALF_X + 15
        : d.pos.x < HALF_X - 15;
    }).length;
    
    const defNotBack = defTeam.filter(d => {
      return state.possession === 0
        ? d.pos.x > HALF_X + 25
        : d.pos.x < HALF_X - 25;
    }).length;
    
    if (defDeepBehind >= 3 && defNotBack >= 2 && !state.hasFastBroken && state.phaseTicks < 20) {
      const offPastHalf = offTeam.filter(p => {
        return state.possession === 0
          ? p.pos.x > HALF_X + 5
          : p.pos.x < HALF_X - 5;
      }).length;
      
      state.phase = 'action';
      state.phaseTicks = 0;
      state.advanceClock = 0;
      state.hasFastBroken = true;
      
      if (offPastHalf >= 3) {
        state.currentPlay = PLAY_CHERRY_PICK;
        state.lastEvent = `Breakaway! ${handler.player.name} is all alone!`;
      } else if (offPastHalf >= defTeam.length - defDeepBehind + 2) {
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
  
  if (state.phaseTicks === 1) {
    assignInitialSlots(state, offTeam, slots);
  }
  
  offTeam.forEach(player => {
    if (player.currentSlot) {
      const slotPos = slots.get(player.currentSlot);
      if (slotPos) {
        player.targetPos = { ...slotPos };
      }
    }
  });
  
  if (state.phaseTicks > 120) {
    selectPlay(state, offTeam);
    state.phase = 'action';
    state.phaseTicks = 0;
  }
}

function handleAction(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[], basketPos: Vec2, dir: number): void {
  const handler = getBallHandler(state);
  if (!handler) return;
  
  if (handler.catchTimer > 0) return;
  
  handler.isDribbling = true;
  state.dribbleTime += 1 / 60;
  
  state.possessionStage = getPossessionStage(state.shotClock);
  
  const teamAvgFGA = offTeam.reduce((sum, p) => sum + (state.boxStats.get(p.id)?.fga || 0), 0) / 5;
  
  // Force shot when shot clock critically low — overrides play
  if (state.shotClock < 5) {
    state.currentPlay = null;
    attemptShot(state, handler, basketPos);
    return;
  }
  // Force shot after excessive passes — overrides play
  if (state.passCount >= 8) {
    state.currentPlay = null;
    attemptShot(state, handler, basketPos);
    return;
  }
  
  if (state.currentPlay) {
    updateCurrentPlay(state, basketPos, dir);
    return;
  }
  
  switch (state.possessionStage) {
    case 'early':
      selectPlay(state, offTeam);
      return;
      
    case 'mid':
      executeReadAndReact(handler, state, basketPos);
      break;
      
    case 'late': {
      const bestScorer = findBestScorer(offTeam);
      const bestStats = state.boxStats.get(bestScorer.id);
      const bestHogging = bestStats && teamAvgFGA > 4 && bestStats.fga > teamAvgFGA * 1.5;
      if (handler !== bestScorer && checkIfOpen(bestScorer, state) && !bestHogging) {
        passBall(state, handler, bestScorer);
        return;
      }
      const openTeammates = getOpenTeammates(state, handler);
      if (openTeammates.length > 0) {
        const openThree = openTeammates.find(p => {
          const d = dist(p.pos, basketPos);
          return d > 22 && d < 27 && p.player.skills.shooting.three_point >= 65;
        });
        if (openThree) {
          passBall(state, handler, openThree);
          return;
        }
        const bestOpen = openTeammates.sort((a, b) => {
          const aStats = state.boxStats.get(a.id) || emptyBoxStats();
          const bStats = state.boxStats.get(b.id) || emptyBoxStats();
          const aFGP = aStats.fga > 0 ? aStats.fgm / aStats.fga : 0.45;
          const bFGP = bStats.fga > 0 ? bStats.fgm / bStats.fga : 0.45;
          return bFGP - aFGP;
        })[0];
        const bestOpenStats = state.boxStats.get(bestOpen.id) || emptyBoxStats();
        if (bestOpenStats.fga < teamAvgFGA * 1.5) {
          passBall(state, handler, bestOpen);
          return;
        }
      }
      const distToBasket2 = dist(handler.pos, basketPos);
      if (distToBasket2 < 25) attemptShot(state, handler, basketPos);
      else executeReadAndReact(handler, state, basketPos);
      break;
    }
    case 'desperation':
      attemptShot(state, handler, basketPos);
      break;
    default:
      break;
  }
  
  // Steal attempts — per-possession check (once every ~2 seconds of action)
  if (state.phaseTicks % 120 === 60) {
    const nearestDef = findNearestDefender(handler, state);
    if (nearestDef) {
      const defDist = dist(nearestDef.pos, handler.pos);
      const stealSkill = nearestDef.player.skills.defense.steal;
      const handlingSkill = handler.player.skills.playmaking.ball_handling;
      // Base ~5% per check, scaled by proximity and skills
      let stealChance = 0.03 + (stealSkill / 100) * 0.06 - (handlingSkill / 100) * 0.02;
      if (defDist > 6) stealChance *= 0.2;
      else if (defDist > 4) stealChance *= 0.5;
      else if (defDist < 2) stealChance *= 2.0;
      // Driving into traffic = more vulnerable
      if (handler.isDriving && defDist < 4) stealChance *= 1.5;
      // Passing lanes — bad passers more vulnerable
      if (state.passCount > 3 && handlingSkill < 75) stealChance *= 1.3;
      stealChance = Math.max(0.01, Math.min(0.12, stealChance));
      if (state.rng() < stealChance) {
        addStat(state, handler.id, 'tov');
        clearBallCarrier(state);
        nearestDef.hasBall = true;
        state.ball.carrier = nearestDef;
        addStat(state, nearestDef.id, 'stl');
        state.lastEvent = `${nearestDef.player.name} steals the ball!`;
        changePossession(state, '');
        return;
      }
    }
  }
  
  // Turnover checks — once per ~3 seconds of action
  if (state.phaseTicks % 180 === 90) {
    const nearDef = findNearestDefender(handler, state);
    const defClose = nearDef && dist(nearDef.pos, handler.pos) < 4;
    
    // Driving: chance of charge, travel, or driving foul (→ FTs for defense)
    if (handler.isDriving && defClose && nearDef) {
      const roll = state.rng();
      if (roll < 0.03) {
        // Charge
        addStat(state, handler.id, 'tov');
        addStat(state, handler.id, 'pf');
        state.lastEvent = `Offensive foul! Charge on ${handler.player.name}!`;
        changePossession(state, '');
        return;
      } else if (roll < 0.04) {
        // Travel
        addStat(state, handler.id, 'tov');
        state.lastEvent = `Travel! ${handler.player.name} shuffles his feet!`;
        changePossession(state, '');
        return;
      } else if (roll < 0.08) {
        // Driving foul → FTs for the driver (like getting hacked going to basket)
        addStat(state, nearDef.id, 'pf');
        const ftCount = dist(handler.pos, getTeamBasket(state.possession)) > 22 ? 3 : 2;
        clearBallCarrier(state);
        handler.hasBall = true;
        state.ball.carrier = handler;
        handler.isDriving = false;
        state.ball.inFlight = false;
        state.ball.isShot = false;
        state.freeThrows = { shooter: handler, made: 0, total: ftCount, andOne: false };
        state.phase = 'freethrow';
        state.phaseTicks = 0;
        state.currentPlay = null;
        state.lastEvent = `Driving foul on ${nearDef.player.name}! ${ftCount} free throws!`;
        return;
      }
    }
    
    // General ball-handling error
    const handling = handler.player.skills.playmaking.ball_handling;
    let toChance = 0.015 - (handling / 100) * 0.01;
    if (handler.fatigue > 0.3) toChance *= 1.3;
    if (state.rng() < Math.max(0.002, toChance)) {
      addStat(state, handler.id, 'tov');
      state.lastEvent = `${handler.player.name} loses the handle!`;
      changePossession(state, '');
      return;
    }
  }
  
  // 3-second violation check — once per ~5 seconds
  if (state.phaseTicks % 300 === 0 && state.phaseTicks > 0) {
    const basket = getTeamBasket(state.possession);
    for (const p of offTeam) {
      if (p.hasBall) continue;
      const dBasket = dist(p.pos, basket);
      if (dBasket < 6 && state.rng() < 0.008) {
        addStat(state, p.id, 'tov');
        state.lastEvent = `3-second violation on ${p.player.name}!`;
        changePossession(state, '');
        return;
      }
    }
  }

  // Off-ball fouls — can lead to bonus FTs (check every ~3s)
  if (state.phaseTicks % 180 === 45) {
    const defTeamAll = state.players.filter(p => p.teamIdx !== state.possession);
    // Count team fouls this quarter for bonus
    const teamFouls = defTeamAll.reduce((sum, d) => sum + (state.boxStats.get(d.id)?.pf || 0), 0);
    const inBonus = teamFouls >= 5; // simplified bonus rule
    
    // Reaching foul on ball handler
    const nearDef = findNearestDefender(handler, state);
    if (nearDef && dist(nearDef.pos, handler.pos) < 3) {
      if (state.rng() < 0.08) {
        addStat(state, nearDef.id, 'pf');
        if (inBonus) {
          clearBallCarrier(state);
          handler.hasBall = true;
          state.ball.carrier = handler;
          state.ball.inFlight = false;
          state.ball.isShot = false;
          state.freeThrows = { shooter: handler, made: 0, total: 2, andOne: false };
          state.phase = 'freethrow';
          state.phaseTicks = 0;
          state.currentPlay = null;
          state.lastEvent = `Reaching foul on ${nearDef.player.name}! Bonus free throws!`;
          return;
        }
        state.lastEvent = `Reaching foul on ${nearDef.player.name}!`;
        return;
      }
    }
    for (const def of defTeamAll) {
      if (def === nearDef) continue;
      const assignedId = state.defAssignments.get(def.id);
      const assigned = state.players.find(p => p.id === assignedId);
      if (assigned && dist(def.pos, assigned.pos) < 2.5 && state.rng() < 0.04) {
        addStat(state, def.id, 'pf');
        if (inBonus) {
          const ftShooter = handler;
          clearBallCarrier(state);
          ftShooter.hasBall = true;
          state.ball.carrier = ftShooter;
          state.ball.inFlight = false;
          state.ball.isShot = false;
          state.freeThrows = { shooter: ftShooter, made: 0, total: 2, andOne: false };
          state.phase = 'freethrow';
          state.phaseTicks = 0;
          state.currentPlay = null;
          state.lastEvent = `Off-ball foul on ${def.player.name}! Bonus free throws!`;
          return;
        }
        state.lastEvent = `Off-ball foul on ${def.player.name}!`;
        return;
      }
    }
  }
}

export function tick(state: GameState): GameState {
  const dt = 1 / 60;
  state.phaseTicks++;
  state.gameTime += dt;

  // Freeze detector — force recovery if stuck
  // shooting: ball flight ~60-120 ticks, so 300 is generous
  // rebound: should resolve in ~120 ticks
  // freethrow: max 3 FTs at 270 ticks + buffer
  if (state.phase === 'shooting' && state.phaseTicks > 300) {
    state.ball.inFlight = false;
    state.ball.isShot = false;
    state.ball.bouncing = false;
    changePossession(state, '');
  } else if (state.phase === 'rebound' && state.phaseTicks > 300) {
    state.ball.bouncing = false;
    changePossession(state, '');
  } else if (state.phase === 'freethrow' && state.phaseTicks > 400) {
    state.freeThrows = null;
    changePossession(state, '');
  }

  // Collect tick data for analysis
  if (_tickLog.length < 200000) {
    _tickLog.push({
      t: state.gameTime, phase: state.phase, possession: state.possession, shotClock: state.shotClock,
      players: state.players.map(p => ({
        id: p.id, name: p.player.name, pos: p.player.position,
        x: Math.round(p.pos.x * 10) / 10, y: Math.round(p.pos.y * 10) / 10,
        vx: Math.round(p.vel.x * 10) / 10, vy: Math.round(p.vel.y * 10) / 10,
        hasBall: p.hasBall, role: p.currentRole, teamIdx: p.teamIdx,
        fatigue: Math.round(p.fatigue * 100) / 100,
        isCutting: p.isCutting, isScreening: p.isScreening,
        isDriving: p.isDriving, isDribbling: p.isDribbling,
        catchTimer: p.catchTimer,
      })),
      event: state.lastEvent, play: state.currentPlay?.name,
      ballX: Math.round(state.ball.pos.x * 10) / 10,
      ballY: Math.round(state.ball.pos.y * 10) / 10,
      ballInFlight: state.ball.inFlight,
      assists: [...state.assists] as [number, number],
    });
  }

  // Dead ball pause
  if (state.deadBallTimer > 0) {
    state.deadBallTimer -= dt;
    return state;
  }

  // Update clocks
  if (state.phase !== 'jumpball' && state.phase !== 'freethrow' && state.gameStarted) {
    state.clockSeconds -= dt;
    state.shotClock -= dt;
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

  // Sync safety
  if (state.ball.carrier && !state.ball.carrier.hasBall) {
    state.ball.carrier.hasBall = true;
  }
  const ballHolders = state.players.filter(p => p.hasBall);
  if (ballHolders.length > 1) {
    for (const p of state.players) {
      p.hasBall = (p === state.ball.carrier);
    }
  }

  // Violations
  if (state.shotClock <= 0 && state.gameStarted) {
    state.shotClockViolations[state.possession]++;
    console.warn(`[SCV] team=${state.possession} passCount=${state.passCount} phase=${state.phase} phaseTicks=${state.phaseTicks} gameTime=${state.gameTime.toFixed(1)}`);
    const ballHandler = state.players.find(p => p.hasBall);
    if (ballHandler) addStat(state, ballHandler.id, 'tov');
    changePossession(state, 'Shot clock violation');
    return state;
  }
  
  if (!state.crossedHalfCourt && state.advanceClock > 8) {
    const ballHandler = state.players.find(p => p.hasBall);
    if (ballHandler) addStat(state, ballHandler.id, 'tov');
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
    // Safety: if ball still in flight after impossibly long time, force reset
    if (state.ball.inFlight && state.ball.flightProgress > 5) {
      console.warn(`[BALL_STUCK] flightProgress=${state.ball.flightProgress.toFixed(2)} dur=${state.ball.flightDuration.toFixed(3)} phase=${state.phase}`);
      state.ball.inFlight = false;
      state.ball.isShot = false;
      changePossession(state, '');
    }
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
        const basket = getTeamBasket(state.possession);
        for (const p of offTeam) {
          const isBig = p.player.position === 'C' || p.player.position === 'PF';
          if (isBig) {
            p.targetPos = { x: basket.x, y: basket.y + (p.courtIdx % 2 === 0 ? -4 : 4) };
          } else {
            p.targetPos = { x: HALF_X + (state.possession === 0 ? -8 : 8), y: p.pos.y };
          }
        }
        for (const d of defTeam) {
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

  // Defense
  if (state.phase === 'action' || state.phase === 'setup') {
    updateDefenseAssignments(state);
    handleScreenDefense(state);
    handleHelpDefense(state);
  } else if (state.phase === 'inbound' || state.phase === 'advance') {
    const defTeam2 = state.players.filter(p => p.teamIdx !== state.possession);
    defTeam2.forEach(d => { d.isDefensiveSliding = false; });
  }
  
  // Update offensive systems
  if (state.phase === 'action' || state.phase === 'setup') {
    assignRoles(state);
    enforceFloorSpacing(state);
    fillEmptySlots(state);
  }
  if (state.phase === 'action' || state.phase === 'setup') {
    offBallMovement(state, offTeam, basketPos, dir);
    
    // Center paint magnetism
    for (const p of offTeam) {
      if (p.player.position !== 'C') continue;
      if (p.isScreening || p.hasBall) continue;
      const dBasket = dist(p.pos, basketPos);
      
      if ((state.phaseTicks + (p.courtIdx * 7)) % 30 !== 0) continue;
      
      const otherBigInDeepPaint = offTeam.some(op => 
        op !== p && (op.player.position === 'C' || op.player.position === 'PF') && dist(op.pos, basketPos) < 7
      );
      
      if (dBasket > 10 && !otherBigInDeepPaint) {
        const side = p.pos.y > basketPos.y ? 1 : -1;
        p.targetPos = {
          x: basketPos.x - dir * (5 + state.rng() * 4),
          y: basketPos.y + side * (4 + state.rng() * 4)
        };
        p.isCutting = true;
      } else if (dBasket > 12 && otherBigInDeepPaint) {
        p.targetPos = {
          x: basketPos.x - dir * (12 + state.rng() * 4),
          y: basketPos.y + (state.rng() - 0.5) * 10
        };
        p.isCutting = true;
      }
    }
  }

  // Move all players
  for (const p of state.players) {
    movePlayerToward(p, dt, state);
  }
  
  // Reset per-frame flags
  for (const p of state.players) {
    p.isDefensiveSliding = false;
    if (p.targetPos) {
      const atTarget = dist(p.pos, p.targetPos) < 1.5;
      if (atTarget) {
        p.isScreening = false;
        // Don't reset isCutting here — let movement logic control it
      }
    } else {
      p.isScreening = false;
    }
    if (!p.hasBall) { p.isDribbling = false; p.isDriving = false; }
    // Jump physics
    if (p.jumpZ > 0 || p.jumpVelZ > 0) {
      p.jumpVelZ -= 32 * dt;
      p.jumpZ += p.jumpVelZ * dt;
      if (p.jumpZ < 0) { p.jumpZ = 0; p.jumpVelZ = 0; }
    }
  }

  // Ball follows carrier
  if (state.ball.carrier && !state.ball.inFlight && !state.ball.bouncing) {
    state.ball.pos = { ...state.ball.carrier.pos };
    state.ball.z = 4 + (state.ball.carrier.jumpZ || 0);
  }

  return state;
}

export function initGameState(): GameState {
  resetRecentPlays();
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
        jumpZ: 0,
        jumpVelZ: 0,
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
      z: 4,
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
    hasFastBroken: false,
    freeThrows: null,
    passCount: 0,
    assists: [0, 0],
    lastAssist: null,
    deadBallTimer: 0,
    shotClockViolations: [0, 0],
    boxStats: new Map(allPlayers.map(p => [p.id, emptyBoxStats()])),
  };
}
