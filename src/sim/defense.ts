import { GameState, SimPlayer, Vec2 } from './types';
import { dist, getBallHandler, normalizeVector, findNearestDefender, findDefenderOf, swapAssignments, getTeamBasket } from './utils';
import { BASKET_Y, HALF_X } from './constants';

export function updateDefenseAssignments(state: GameState): void {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const tactic = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
  const ballHandler = getBallHandler(state);
  const basket = getTeamBasket(state.possession);
  
  if (tactic === 'man') {
    if (state.defAssignments.size === 0) {
      for (let i = 0; i < Math.min(defTeam.length, offTeam.length); i++) {
        state.defAssignments.set(defTeam[i].id, offTeam[i].id);
      }
    }
    
    defTeam.forEach(defender => {
      const assignedOffPlayer = offTeam.find(p => p.id === state.defAssignments.get(defender.id));
      if (!assignedOffPlayer) return;
      
      if (assignedOffPlayer === ballHandler) {
        const basketDir = normalizeVector({
          x: basket.x - assignedOffPlayer.pos.x,
          y: basket.y - assignedOffPlayer.pos.y
        });
        
        const perimD = defender.player.skills.defense?.perimeter_d || 70;
        const gap = 4 - (perimD / 100) * 1.5;
        
        defender.targetPos = {
          x: assignedOffPlayer.pos.x + basketDir.x * gap,
          y: assignedOffPlayer.pos.y + basketDir.y * gap
        };
        defender.isDefensiveSliding = true;
      } else {
        const distFromBall = ballHandler ? dist(assignedOffPlayer.pos, ballHandler.pos) : 20;
        
        if (distFromBall < 15) {
          const denyPos = ballHandler ? {
            x: assignedOffPlayer.pos.x + (ballHandler.pos.x - assignedOffPlayer.pos.x) * 0.4,
            y: assignedOffPlayer.pos.y + (ballHandler.pos.y - assignedOffPlayer.pos.y) * 0.4
          } : assignedOffPlayer.pos;
          
          defender.targetPos = denyPos;
          defender.isDefensiveSliding = true;
        } else {
          defender.targetPos = {
            x: assignedOffPlayer.pos.x + (basket.x - assignedOffPlayer.pos.x) * 0.4,
            y: assignedOffPlayer.pos.y + (basket.y - assignedOffPlayer.pos.y) * 0.3
          };
          defender.isDefensiveSliding = true;
        }
      }
    });
    
  } else if (tactic === 'zone') {
    const dir = basket.x > HALF_X ? -1 : 1;
    const bx = basket.x;
    const by = basket.y;
    
    const basePositions = [
      { x: bx + dir * 20, y: by - 10 },
      { x: bx + dir * 20, y: by + 10 },
      { x: bx + dir * 10, y: by - 10 },
      { x: bx + dir * 10, y: by + 10 },
      { x: bx + dir * 4,  y: by },
    ];
    
    if (ballHandler) {
      const ballX = ballHandler.pos.x;
      const ballY = ballHandler.pos.y;
      const ballSide = ballY > by ? 1 : -1;
      const ballDepth = Math.abs(ballX - bx);
      
      const sideShift = ballSide * 5;
      basePositions.forEach(pos => pos.y += sideShift);
      
      if (Math.abs(ballY - by) > 15) {
        const cornerIdx = ballSide > 0 ? 3 : 2;
        const guardIdx = ballSide > 0 ? 1 : 0;
        basePositions[cornerIdx] = { x: ballX, y: ballY + (-ballSide * 3) };
        basePositions[guardIdx].y += ballSide * 4;
      }
      
      if (ballDepth < 18) {
        const collapseFactor = (18 - ballDepth) / 18;
        basePositions.forEach(pos => {
          pos.x = pos.x + (bx - pos.x) * collapseFactor * 0.4;
          pos.y = pos.y + (by - pos.y) * collapseFactor * 0.2;
        });
      }
      
      const [g0dist, g1dist] = [
        dist(basePositions[0], ballHandler.pos),
        dist(basePositions[1], ballHandler.pos)
      ];
      const closestGuardIdx = g0dist < g1dist ? 0 : 1;
      if (dist(basePositions[closestGuardIdx], ballHandler.pos) > 8) {
        const toHandler = normalizeVector({
          x: ballHandler.pos.x - basePositions[closestGuardIdx].x,
          y: ballHandler.pos.y - basePositions[closestGuardIdx].y
        });
        basePositions[closestGuardIdx].x += toHandler.x * 5;
        basePositions[closestGuardIdx].y += toHandler.y * 5;
      }
    }
    
    defTeam.forEach((defender, i) => {
      if (i < basePositions.length) {
        defender.targetPos = { ...basePositions[i] };
      }
    });
  }
}

export function handleScreenDefense(state: GameState): void {
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const tactic = state.possession === 0 ? state.awayTacticD : state.homeTacticD;
  
  for (const defender of defTeam) {
    const assignment = state.players.find(p => p.id === state.defAssignments.get(defender.id));
    if (!assignment) continue;
    
    const screener = state.players.find(p => 
      p.teamIdx === state.possession && p.isScreening && 
      dist(p.pos, defender.pos) < 4
    );
    
    if (screener) {
      if (tactic === 'man') {
        const screenerDefender = findDefenderOf(screener, state);
        if (screenerDefender) {
          const defHeight = defender.player.physical.height;
          const screenerDefHeight = screenerDefender.player.physical.height;
          const assignmentHeight = assignment.player.physical.height;
          const screenerHeight = screener.player.physical.height;
          
          const mismatch1 = Math.abs(defHeight - screenerHeight);
          const mismatch2 = Math.abs(screenerDefHeight - assignmentHeight);
          const maxMismatch = Math.max(mismatch1, mismatch2);
          
          const agilityBonus = (defender.player.physical.agility || 70) / 200;
          const switchChance = maxMismatch < 8 ? 0.7 : maxMismatch < 15 ? 0.3 : 0.1;
          
          if (state.rng() < switchChance) {
            swapAssignments(defender, screenerDefender, state);
          } else {
            const awayFromScreen = normalizeVector({
              x: assignment.pos.x - screener.pos.x,
              y: assignment.pos.y - screener.pos.y
            });
            defender.targetPos = {
              x: assignment.pos.x + awayFromScreen.x * 3,
              y: assignment.pos.y + awayFromScreen.y * 3
            };
          }
        }
      }
    }
  }
}

export function handleHelpDefense(state: GameState): void {
  const handler = getBallHandler(state);
  if (!handler) return;
  
  const basket = getTeamBasket(state.possession);
  const distToBasket = dist(handler.pos, basket);
  const defTeam = state.players.filter(p => p.teamIdx !== state.possession);
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  
  if (distToBasket < 15) {
    const ballDefender = findDefenderOf(handler, state);
    const helpCandidates = defTeam
      .filter(d => d !== ballDefender)
      .sort((a, b) => dist(a.pos, basket) - dist(b.pos, basket));
    
    if (helpCandidates.length > 0) {
      const helper = helpCandidates[0];
      helper.targetPos = {
        x: (handler.pos.x + basket.x) / 2,
        y: (handler.pos.y + basket.y) / 2
      };
      
      if (helpCandidates.length > 1) {
        const rotator = helpCandidates[1];
        const helperAssignment = state.defAssignments.get(helper.id);
        const abandonedPlayer = offTeam.find(p => p.id === helperAssignment);
        if (abandonedPlayer) {
          rotator.targetPos = {
            x: abandonedPlayer.pos.x + (basket.x - abandonedPlayer.pos.x) * 0.3,
            y: abandonedPlayer.pos.y + (basket.y - abandonedPlayer.pos.y) * 0.3
          };
          
          if (helpCandidates.length > 2) {
            const secondRotator = helpCandidates[2];
            const rotatorAssignment = state.defAssignments.get(rotator.id);
            const secondAbandoned = offTeam.find(p => p.id === rotatorAssignment);
            if (secondAbandoned) {
              secondRotator.targetPos = {
                x: secondAbandoned.pos.x + (basket.x - secondAbandoned.pos.x) * 0.4,
                y: secondAbandoned.pos.y + (basket.y - secondAbandoned.pos.y) * 0.4
              };
            }
          }
        }
      }
    }
  } else {
    for (const def of defTeam) {
      const assignedId = state.defAssignments.get(def.id);
      const assigned = offTeam.find(p => p.id === assignedId);
      if (assigned) {
        const defDist = dist(def.pos, assigned.pos);
        if (defDist > 10) {
          def.targetPos = {
            x: assigned.pos.x + (basket.x - assigned.pos.x) * 0.3,
            y: assigned.pos.y + (basket.y - assigned.pos.y) * 0.3
          };
        }
      }
    }
  }
}

export function isDefenderBetween(handler: SimPlayer, defender: SimPlayer, basket: Vec2): boolean {
  const hToB = dist(handler.pos, basket);
  const dToB = dist(defender.pos, basket);
  const hToD = dist(handler.pos, defender.pos);
  return dToB < hToB && hToD < hToB * 0.7;
}
