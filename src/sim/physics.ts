import { GameState, SimPlayer } from './types';
import { dist, clearBallCarrier, getTeamBasket, getBallHandler } from './utils';
import { HALF_X, BASKET_Y } from './constants';
import { addStat } from './stats';
import { changePossession } from './core';

export function updateBallFlight(state: GameState, dt: number): void {
  const prevProgress = state.ball.flightProgress;
  state.ball.flightProgress += dt / state.ball.flightDuration;
  const t = Math.min(1, state.ball.flightProgress);
  if (state.gameTime > 520 && state.gameTime < 530) {
    console.warn(`[BALL] t=${t.toFixed(3)} prevP=${prevProgress.toFixed(3)} p=${state.ball.flightProgress.toFixed(3)} dur=${state.ball.flightDuration.toFixed(3)} isShot=${state.ball.isShot} inFlight=${state.ball.inFlight}`);
  }

  if (state.ball.jumpBall?.active) {
    const height = Math.sin(t * Math.PI) * 15;
    state.ball.jumpBall.height = height;
    state.ball.pos.y = BASKET_Y - height;

    if (t >= 1) {
      const centers = state.players.filter(p => p.player.position === 'C');
      if (centers.length >= 2) {
        const [c0, c1] = centers;
        const c0score = c0.player.physical.height + c0.player.physical.vertical * 0.5 + state.rng() * 20;
        const c1score = c1.player.physical.height + c1.player.physical.vertical * 0.5 + state.rng() * 20;
        const winner = c0score >= c1score ? c0 : c1;
        
        const winnerTeam = state.players.filter(p => p.teamIdx === winner.teamIdx && p !== winner);
        const tapTarget = winnerTeam.sort((a, b) => dist(a.pos, winner.pos) - dist(b.pos, winner.pos))[0];
        
        if (tapTarget) {
          state.ball.inFlight = true;
          state.ball.flightFrom = { x: HALF_X, y: BASKET_Y };
          state.ball.flightTo = { ...tapTarget.pos };
          state.ball.flightFromZ = 12;
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
    state.ball.pos.x = state.ball.flightFrom.x + (state.ball.flightTo.x - state.ball.flightFrom.x) * t;
    state.ball.pos.y = state.ball.flightFrom.y + (state.ball.flightTo.y - state.ball.flightFrom.y) * t;
    
    const fromZ = state.ball.flightFromZ;
    const peakZ = state.ball.flightPeakZ;
    const endZ = state.ball.isShot ? 10 : 5;
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
          const shooterId = (state.ball as any).shooterId;
          state.score[scoringTeam] += pts;
          if (shooterId) {
            addStat(state, shooterId, 'pts', pts);
            addStat(state, shooterId, 'fgm');
            addStat(state, shooterId, 'fga');
            if (pts === 3) { addStat(state, shooterId, 'tpm'); addStat(state, shooterId, 'tpa'); }
          }
          const isAlleyOop = (state.ball as any).isAlleyOop;
          const scoreType = isAlleyOop ? 'ALLEY-OOP DUNK!' 
            : pts === 3 ? '3-pointer' 
            : shotDistance < 3 ? 'at the rim' 
            : shotDistance < 8 ? 'layup' 
            : `${pts}pts`;
          let assistStr = '';
          if (state.lastPassFrom && state.lastPassFrom !== shooterId && 
              state.gameTime - state.lastPassTime < 7.0) {
            const assister = state.players.find(p => p.id === state.lastPassFrom);
            if (assister) {
              state.assists[scoringTeam]++;
              state.lastAssist = assister.player.name;
              addStat(state, assister.id, 'ast');
              assistStr = ` (ast: ${assister.player.name})`;
            }
          }
          state.lastEvent = `${shooterName} scores! ${scoreType}${assistStr} (${state.score[0]}-${state.score[1]})`;
          changePossession(state, '');
        } else {
          const missShooterId = (state.ball as any).shooterId;
          if (missShooterId) {
            addStat(state, missShooterId, 'fga');
            const basket2 = getTeamBasket(state.possession);
            if (dist(state.ball.flightFrom, basket2) > 22) addStat(state, missShooterId, 'tpa');
          }
          const basket = getTeamBasket(state.possession);
          const missType = state.ball.missType || 'rim_out';
          const dir = state.possession === 0 ? 1 : -1;
          
          let bounceTarget = { x: 0, y: 0 };
          switch (missType) {
            case 'airball':
              bounceTarget = { x: basket.x - dir * 4, y: basket.y + (state.rng() - 0.5) * 12 };
              break;
            case 'back_iron':
              bounceTarget = { x: basket.x - dir * (10 + state.rng() * 6), y: basket.y + (state.rng() - 0.5) * 14 };
              break;
            case 'front_rim':
              bounceTarget = { x: basket.x - dir * (2 + state.rng() * 4), y: basket.y + (state.rng() - 0.5) * 6 };
              break;
            default:
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
          const handling = closest.player.skills.playmaking?.ball_handling || 70;
          closest.catchTimer = 0.6 - (handling / 100) * 0.3;
          state.ball.carrier = closest;
        }
      }
    }
  }
}
