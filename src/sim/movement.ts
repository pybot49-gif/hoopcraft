import { GameState, SimPlayer, Vec2, SlotName } from './types';
import { dist, getBallHandler, findNearestDefender, checkIfOpen, clamp, getTeamBasket } from './utils';
import { COURT_W, COURT_H, HALF_X } from './constants';
import { getSlotPositions, findOpenSlot } from './playbook';

export function offBallMovement(state: GameState, offTeam: SimPlayer[], basketPos: Vec2, dir: number): void {
  const handler = getBallHandler(state);
  if (!handler) return;
  
  const slots = getSlotPositions(basketPos, dir);
  
  for (const player of offTeam) {
    if (player === handler) continue;
    if (player.isScreening || player.isCutting) continue;
    
    const defender = findNearestDefender(player, state);
    const defDist = defender ? dist(defender.pos, player.pos) : 20;
    const distToBasket = dist(player.pos, basketPos);
    const atTarget = !player.targetPos || dist(player.pos, player.targetPos) < 1.5;
    const isBig = player.player.position === 'C' || player.player.position === 'PF';
    
    const moveHash = (state.phaseTicks + player.courtIdx * 13) % 20;
    if (moveHash !== 0 && !atTarget) continue;
    if (moveHash !== 0) continue;
    
    const roll = state.rng();
    
    // ── CENTERS & PF: PAINT PRESENCE ──────────────────────────────────
    if (isBig) {
      const isCenter = player.player.position === 'C';
      const otherBigInDeepPaint = offTeam.some(p => 
        p !== player && 
        (p.player.position === 'C' || p.player.position === 'PF') &&
        dist(p.pos, basketPos) < 8
      );
      
      const wantsPaint = isCenter || player.currentRole === 'postUp';
      
      if (wantsPaint && !otherBigInDeepPaint) {
        if (distToBasket > 10) {
          const paintChance = isCenter ? 0.7 : 0.45;
          if (roll < paintChance) {
            const side = player.pos.y > basketPos.y ? 1 : -1;
            player.targetPos = {
              x: basketPos.x - dir * (4 + state.rng() * 4),
              y: basketPos.y + side * (3 + state.rng() * 4)
            };
            player.isCutting = true;
            continue;
          }
        }
        if (distToBasket < 10) {
          player.targetPos = {
            x: basketPos.x - dir * (3 + state.rng() * 4),
            y: player.pos.y + (state.rng() - 0.5) * 5
          };
          continue;
        }
      } else if (wantsPaint && otherBigInDeepPaint) {
        if (distToBasket < 10 || roll < 0.3) {
          const highPostTargets = [
            { x: basketPos.x - dir * 14, y: basketPos.y - 6 },
            { x: basketPos.x - dir * 14, y: basketPos.y + 6 },
            { x: basketPos.x - dir * 10, y: basketPos.y + (state.rng() > 0.5 ? 12 : -12) },
          ];
          player.targetPos = highPostTargets[Math.floor(state.rng() * highPostTargets.length)];
          player.isCutting = true;
          continue;
        }
      }
    }
    
    // ── BACKDOOR CUT ───────────────────────────────
    if (defender && defDist < 4 && distToBasket > 15) {
      const defToBall = dist(defender.pos, handler.pos);
      const playerToBall = dist(player.pos, handler.pos);
      if (defToBall < playerToBall && roll < 0.6) {
        player.targetPos = {
          x: basketPos.x - dir * 3,
          y: basketPos.y + (player.pos.y > basketPos.y ? 3 : -3)
        };
        player.isCutting = true;
        continue;
      }
    }
    
    // ── V-CUT ────────────────────
    if (defDist < 5 && roll < 0.5) {
      const jabDir = state.rng() > 0.5 ? 1 : -1;
      player.targetPos = {
        x: player.pos.x + dir * (3 + state.rng() * 3),
        y: Math.max(3, Math.min(47, player.pos.y + jabDir * (3 + state.rng() * 3)))
      };
      player.isCutting = true;
      continue;
    }
    
    // ── PIN DOWN SCREEN ───────────────────────────────────────────────
    if ((player.currentRole === 'screener' || player.currentRole === 'postUp') && roll < 0.35) {
      const teammate = offTeam.find(p => 
        p !== handler && p !== player && 
        dist(p.pos, basketPos) < 15 && 
        !checkIfOpen(p, state)
      );
      if (teammate) {
        const tmDef = findNearestDefender(teammate, state);
        if (tmDef) {
          player.targetPos = {
            x: tmDef.pos.x + dir * 1,
            y: tmDef.pos.y + (state.rng() > 0.5 ? 2 : -2)
          };
          player.isScreening = true;
          continue;
        }
      }
    }
    
    // ── RELOCATE — spacers drift to 3PT spots ──────────────────────────
    if (player.currentRole === 'spacer' && roll < 0.55) {
      const spots3pt = [
        { x: basketPos.x - dir * 23, y: basketPos.y },
        { x: basketPos.x - dir * 20, y: basketPos.y - 15 },
        { x: basketPos.x - dir * 20, y: basketPos.y + 15 },
        { x: basketPos.x - dir * 8, y: Math.max(3, basketPos.y - 22) },
        { x: basketPos.x - dir * 8, y: Math.min(47, basketPos.y + 22) },
      ];
      const teammates = offTeam.filter(p => p !== player);
      let bestSpot = spots3pt[0];
      let bestMinDist = 0;
      for (const spot of spots3pt) {
        const minD = Math.min(...teammates.map(t => dist(t.pos, spot)), 50);
        if (minD > bestMinDist) {
          bestMinDist = minD;
          bestSpot = spot;
        }
      }
      if (bestMinDist > 6) {
        player.targetPos = bestSpot;
        player.isCutting = true;
        continue;
      }
    }
    
    // ── CUTTER ─────────────────────────
    if (player.currentRole === 'cutter' && roll < 0.5) {
      if (distToBasket > 14) {
        player.targetPos = {
          x: basketPos.x - dir * (10 + state.rng() * 8),
          y: basketPos.y + (state.rng() - 0.5) * 14
        };
        player.isCutting = true;
        continue;
      } else {
        const side = player.pos.y > basketPos.y ? 1 : -1;
        player.targetPos = {
          x: basketPos.x - dir * (18 + state.rng() * 5),
          y: basketPos.y + side * (15 + state.rng() * 5)
        };
        player.isCutting = true;
        continue;
      }
    }
    
    // ── DEFAULT DRIFT ──
    if (atTarget) {
      const teammates = offTeam.filter(p => p !== player && p !== handler);
      let bestDrift = player.pos;
      let bestMinDist = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = {
          x: player.pos.x + (state.rng() - 0.5) * 8,
          y: Math.max(3, Math.min(47, player.pos.y + (state.rng() - 0.5) * 8))
        };
        const minTeammateDist = Math.min(...teammates.map(t => dist(t.pos, candidate)), 50);
        if (minTeammateDist > bestMinDist) {
          bestMinDist = minTeammateDist;
          bestDrift = candidate;
        }
      }
      if (bestMinDist > 5) {
        player.targetPos = bestDrift;
        player.isCutting = true;
      }
    }
  }
}

export function enforceFloorSpacing(state: GameState): void {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  
  for (let i = 0; i < offTeam.length; i++) {
    for (let j = i + 1; j < offTeam.length; j++) {
      const p1 = offTeam[i];
      const p2 = offTeam[j];
      if (p1.currentRole === 'ballHandler' || p2.currentRole === 'ballHandler') continue;
      if (p1.isCutting || p2.isCutting || p1.isScreening || p2.isScreening) continue;
      
      const distance = dist(p1.pos, p2.pos);
      const bothBigs = (p1.player.position === 'C' || p1.player.position === 'PF') &&
                       (p2.player.position === 'C' || p2.player.position === 'PF');
      const minDist = bothBigs ? 8 : 12;
      
      if (distance < minDist) {
        const rolePriority: Record<string, number> = { ballHandler: 4, screener: 3, postUp: 2, cutter: 1, spacer: 0 };
        const p1Priority = rolePriority[p1.currentRole || 'spacer'] ?? 0;
        const p2Priority = rolePriority[p2.currentRole || 'spacer'] ?? 0;
        const playerToRelocate = p1Priority <= p2Priority ? p1 : p2;
        findOpenSlot(playerToRelocate, state);
      }
    }
  }
}

export function fillEmptySlots(state: GameState): void {
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const basketPos = getTeamBasket(state.possession);
  const dir = state.possession === 0 ? 1 : -1;
  const slots = getSlotPositions(basketPos, dir);
  
  for (const [slotName, slotPos] of slots.entries()) {
    if (!state.slots.get(slotName)) {
      const ballHandler = getBallHandler(state);
      const availablePlayer = offTeam.find(p => 
        !p.currentSlot && 
        p !== ballHandler &&
        p.currentRole !== 'ballHandler'
      );
      
      if (availablePlayer) {
        state.slots.set(slotName, availablePlayer.id);
        availablePlayer.currentSlot = slotName;
        availablePlayer.targetPos = { ...slotPos };
      }
    }
  }
}

export function movePlayerToward(player: SimPlayer, dt: number, state: GameState): void {
  const dx = player.targetPos.x - player.pos.x;
  const dy = player.targetPos.y - player.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  
  if (d < 0.3) {
    player.vel.x *= 0.8;
    player.vel.y *= 0.8;
    return;
  }
  
  const speedAttr = player.player.physical.speed;
  const rawSpeed = 4 + (speedAttr / 100) * 18;
  let baseSpeed = rawSpeed * (1 - player.fatigue * 0.3);
  
  if (player.isDefensiveSliding) {
    const perimD = player.player.skills.defense?.perimeter_d || 70;
    baseSpeed *= 0.6 + (perimD / 100) * 0.2;
  }
  if (player.isCutting && !player.isDribbling) baseSpeed *= 1.2;
  if (player.isDribbling) {
    const handling = player.player.skills.playmaking?.ball_handling || 60;
    baseSpeed *= 0.55 + (handling / 100) * 0.2;
  }
  if (player.catchTimer > 0) baseSpeed *= 0.3;
  if ((state.phase === 'inbound' || state.phase === 'advance') && player.teamIdx !== state.possession) {
    baseSpeed *= 1.3;
  }
  
  if (player.hasBall && state.phase === 'action') {
    const nearDef = state.players.find(p => p.teamIdx !== player.teamIdx && dist(p.pos, player.pos) < 3);
    if (nearDef) {
      const defStr = nearDef.player.physical.strength || 70;
      const offStr = player.player.physical.strength || 70;
      baseSpeed *= 0.75 + (offStr - defStr + 30) / 300;
    }
  }
  
  if (d > 25) {
    baseSpeed *= 1.15;
    player.sprintTimer += dt;
  } else if (d < 5) {
    baseSpeed *= 0.7;
    player.sprintTimer = Math.max(0, player.sprintTimer - dt * 2);
  } else {
    player.sprintTimer = Math.max(0, player.sprintTimer - dt);
  }
  
  if (player.sprintTimer > 4) {
    baseSpeed *= 0.85;
  }
  
  const accelAttr = player.player.physical.acceleration;
  const accel = 5 + (accelAttr / 100) * 15;
  const targetVx = (dx / d) * baseSpeed;
  const targetVy = (dy / d) * baseSpeed;
  const blend = Math.min(1, accel * dt * 0.4);
  
  player.vel.x += (targetVx - player.vel.x) * blend;
  player.vel.y += (targetVy - player.vel.y) * blend;
  player.pos.x += player.vel.x * dt;
  player.pos.y += player.vel.y * dt;
  
  for (const other of state.players) {
    if (other === player) continue;
    const dx2 = player.pos.x - other.pos.x;
    const dy2 = player.pos.y - other.pos.y;
    const d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    
    if (d2 < 3.5 && d2 > 0.01 && other.isScreening && player.teamIdx !== other.teamIdx) {
      const screenStr = other.player.physical.strength;
      const defStr = player.player.physical.strength || 70;
      const blockFactor = 0.5 + (screenStr / 200);
      const pushStrength = (3.5 - d2) * blockFactor * 2.0;
      player.pos.x += (dx2 / d2) * pushStrength * dt;
      player.pos.y += (dy2 / d2) * pushStrength * dt;
      player.vel.x *= 0.3;
      player.vel.y *= 0.3;
    }
    else if (d2 < 2.5 && d2 > 0.01) {
      const pushStrength = (2.5 - d2) * 0.5;
      player.pos.x += (dx2 / d2) * pushStrength * dt;
      player.pos.y += (dy2 / d2) * pushStrength * dt;
    }
  }

  player.pos.x = clamp(player.pos.x, 1, COURT_W - 1);
  player.pos.y = clamp(player.pos.y, 1, COURT_H - 1);
  
  player.fatigue = Math.min(1, player.fatigue + dt * 0.001 * (1 - player.player.physical.stamina / 100));
}
