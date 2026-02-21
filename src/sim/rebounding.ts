import { GameState, SimPlayer, Vec2 } from './types';
import { dist, clearBallCarrier, getTeamBasket, getBallHandler } from './utils';
import { skillModifier } from '../engine/utils';
import { addStat } from './stats';
import { passBall } from './passing';
import { HALF_X } from './constants';

export function handleRebound(state: GameState, offTeam: SimPlayer[], defTeam: SimPlayer[]): void {
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
    for (let i = 0; i < defTeam.length; i++) {
      const def = defTeam[i];
      const matchup = offTeam[i] || offTeam[0];
      
      const phase = state.phaseTicks < 30 ? 'find' : 'seal';
      
      if (phase === 'find') {
        const mx = matchup.pos.x, my = matchup.pos.y;
        const rx = reboundPos.x, ry = reboundPos.y;
        const toRebX = rx - mx, toRebY = ry - my;
        const toRebD = Math.sqrt(toRebX * toRebX + toRebY * toRebY) || 1;
        def.targetPos = {
          x: mx + (toRebX / toRebD) * 3,
          y: my + (toRebY / toRebD) * 3
        };
      } else {
        def.targetPos = {
          x: reboundPos.x + (def.courtIdx - 2) * 3,
          y: reboundPos.y + (def.courtIdx % 2 === 0 ? -3 : 3)
        };
      }
    }
    
    for (const off of offTeam) {
      const isBig = off.player.position === 'C' || off.player.position === 'PF';
      if (isBig && dist(off.pos, reboundPos) < 18) {
        const angle = state.rng() * Math.PI * 2;
        off.targetPos = {
          x: reboundPos.x + Math.cos(angle) * 3,
          y: reboundPos.y + Math.sin(angle) * 3
        };
      } else {
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
      if (p.jumpZ === 0 && p.jumpVelZ === 0) {
        const vert = p.player.physical.vertical || 70;
        p.jumpVelZ = (vert / 100) * 12 + 4;
      }
    }
    
    for (const p of competitors) {
      const rebSkill = p.player.skills.athletic.rebounding;
      const height = p.player.physical.height;
      const vertical = p.player.physical.vertical;
      const proximity = Math.max(0.1, 15 - dist(p.pos, reboundPos));
      
      const isDefender = p.teamIdx !== state.possession;
      const boxOutBonus = isDefender ? 1.8 : 1.0;
      
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
    addStat(state, rebounder.id, 'reb');
    if (rebType === 'offensive') addStat(state, rebounder.id, 'oreb');
    state.lastEvent = `${rebounder.player.name} grabs the ${rebType} rebound!`;
    
    if (rebounder.teamIdx !== state.possession) {
      state.possession = rebounder.teamIdx;
      state.shotClock = 24;
      state.crossedHalfCourt = false;
      state.advanceClock = 0;
      
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
