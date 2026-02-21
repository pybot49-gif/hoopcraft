import { GameState } from './types';
import { getTeamBasket } from './utils';
import { addStat } from './stats';
import { changePossession } from './core';

export function handleFreeThrows(state: GameState): void {
  if (!state.freeThrows) return;
  const ft = state.freeThrows;
  
  if (state.phaseTicks === 1) {
    const basket = getTeamBasket(state.possession);
    ft.shooter.targetPos = { ...basket };
    ft.shooter.targetPos.x += (state.possession === 0 ? -1 : 1) * 15;
    state.lastEvent = `${ft.shooter.player.name} at the line (${ft.made}/${ft.total})`;
  }
  
  if (state.phaseTicks === 90 || state.phaseTicks === 180) {
    const ftSkill = ft.shooter.player.skills.shooting?.free_throw || 75;
    const ftPct = 0.5 + (ftSkill / 100) * 0.35;
    const made = state.rng() < ftPct;
    
    addStat(state, ft.shooter.id, 'fta');
    if (made) {
      state.score[state.possession] += 1;
      ft.made++;
      addStat(state, ft.shooter.id, 'ftm');
      addStat(state, ft.shooter.id, 'pts');
      state.lastEvent = `${ft.shooter.player.name} makes FT ${ft.made}/${ft.total} (${state.score[0]}-${state.score[1]})`;
    } else {
      state.lastEvent = `${ft.shooter.player.name} misses FT`;
    }
    
    const isLastFT = (state.phaseTicks === 90 && ft.total === 1) || state.phaseTicks === 180;
    
    if (isLastFT) {
      if (!made) {
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
        changePossession(state, '');
      }
      state.freeThrows = null;
    }
  }
}
