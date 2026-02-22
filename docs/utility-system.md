# Hoopcraft Utility System: Comprehensive Value Framework

> **Status:** Design Phase
> **Last Updated:** 2026-02-22
> **Authors:** Jacky, PyBot
> **Related:** [ai-architecture.md](./ai-architecture.md)

---

## Overview

The utility system quantifies **all contributions to winning**, not just box score stats. Every action — shooting, passing, screening, spacing, contesting, deflecting — produces a unified utility score that drives player decision-making.

### Core Principle

```
utility of action = how much this action changes the expected outcome of the possession
```

This includes:
- **Direct effects** — scoring, turnovers, fouls
- **Indirect effects** — good screen → teammate open → teammate scores
- **Hidden effects** — standing in corner → pulls defender → opens paint
- **Defensive effects** — contest → opponent misses → we get rebound

---

## Expected Possession Value (EPV)

The foundation. EPV estimates how many points this possession will produce given the current state.

```typescript
function estimateEPV(state: GameState): number {
  const handler = getBallHandler(state);

  // 1. Shot value: P(make) × points
  const shotEV = estimateShotEV(handler, state);

  // 2. Pass value: best teammate's potential shot EV
  const passEV = getOpenTeammates(state).reduce((best, tm) => {
    const tmShotEV = estimateShotEV(tm, state);
    const passSuccess = estimatePassSuccess(handler, tm, state);
    return Math.max(best, passSuccess * tmShotEV);
  }, 0);

  // 3. Drive value
  const driveEV = estimateDriveEV(handler, state);

  // 4. Turnover risk (negative)
  const tovRisk = estimateTurnoverRisk(handler, state);

  // EPV = best available option minus turnover cost
  return Math.max(shotEV, passEV, driveEV) * (1 - tovRisk);
}
```

**Every action's utility = EPV after action - EPV before action.**

A pass that improves EPV from 0.8 to 1.1 has utility +0.3. A bad dribble that drops EPV from 1.0 to 0.7 has utility -0.3.

---

## Value Channels

All basketball value flows through these channels:

```typescript
interface ActionValue {
  // ── DIRECT SCORING ──────────────────────────────────
  scoringEV: number;             // Expected points from this action

  // ── INDIRECT SCORING (creates future value) ─────────
  gravityValue: number;          // Pulling defenders by reputation/position
  spacingValue: number;          // Floor balance contribution
  playAdvancementValue: number;  // Moving the play/ball forward
  screenValue: number;           // Screen quality and aftermath
  hockeyAssistValue: number;     // Pass that led to the assist pass
  offBallMovementValue: number;  // Cuts, relocations, decoy runs
  decoyValue: number;            // Drawing attention without touching ball

  // ── DEFENSIVE VALUE ─────────────────────────────────
  contestValue: number;          // Shot contest quality
  deflectionValue: number;       // Passing lane disruption
  pressureValue: number;         // Ball handler pressure
  helpDefenseValue: number;      // Help positioning / rotation
  forcedTOValue: number;         // Forced turnovers (non-steal)
  forcedJumpBallValue: number;   // Tied up ball handler

  // ── TRANSITION & HUSTLE ─────────────────────────────
  transitionValue: number;       // Getting back on D / pushing pace
  reboundPositionValue: number;  // Box out, crash boards positioning
  looseballValue: number;        // Diving for loose balls, 50/50 hustle
}
```

---

## Channel Calculations

### 1. Scoring EV

The most direct value — expected points from taking a shot.

```typescript
function calcScoringEV(player: SimPlayer, state: GameState): number {
  const distToBasket = dist(player.pos, basket);
  const points = distToBasket > 22 ? 3 : 2;

  // Base make% from player skill
  const baseSkill = getShotSkillForDistance(player, distToBasket);
  const basePct = skillToPercentage(baseSkill);

  // Contest modifier
  const nearestDef = findNearestDefender(player, state);
  const contestLevel = nearestDef
    ? getContestLevel(nearestDef, player)  // 0 = wide open, 1 = smothered
    : 0;
  const contestedPct = basePct * (1 - contestLevel * 0.35);

  // Fatigue modifier
  const fatigueMod = 1 - player.fatigue * 0.15;

  // Hot/cold modifier
  const streakMod = player.isHot ? 1.08 : player.isCold ? 0.90 : 1.0;

  // Foul drawing value (expected FT points)
  const foulChance = contestLevel > 0.5 ? 0.12 : 0.04;
  const ftPct = player.skills.shooting.free_throw / 100;
  const foulEV = foulChance * ftPct * points;

  return (contestedPct * fatigueMod * streakMod * points) + foulEV;
}
```

### 2. Gravity Value

> "Steph Curry standing at the logo has value because someone has to guard him"

Gravity measures how much a player's presence and reputation pulls defenders, creating space for teammates.

```typescript
function calcGravityValue(player: SimPlayer, state: GameState): number {
  // How many defenders are "aware" of this player?
  const defenders = getOpponents(player, state);
  let gravityPull = 0;

  for (const def of defenders) {
    const distToPlayer = dist(def.pos, player.pos);
    if (distToPlayer > 20) continue;  // Too far to care

    const isAware = isDefenderAwareOf(def, player, state);
    if (!isAware) continue;

    // Threat level: known shooter in range > non-shooter in paint > guy in corner
    const inRange = isInShootingRange(player);
    const shootingRep = player.skills.shooting.three_point / 100;
    const cuttingThreat = player.skills.athleticism.speed / 100;
    const threatLevel = inRange
      ? 0.4 + shootingRep * 0.5       // Shooter in range: 0.4 - 0.9
      : 0.1 + cuttingThreat * 0.3;    // Non-shooter: 0.1 - 0.4

    // How much is this defender pulled toward me vs their assignment?
    const pullStrength = threatLevel * (1 - distToPlayer / 20);
    gravityPull += pullStrength;
  }

  // Value: more defenders watching me = more space for teammates
  // Diminishing returns above 2 defenders
  return Math.min(gravityPull * 0.15, 0.5);
}
```

**Emergent behavior:** High-gravity players (elite shooters) create value just by existing on the court — the system naturally accounts for "floor spacing" without hardcoding it.

### 3. Spacing Value

> "Five players' positions determine the entire offense's geometry"

```typescript
function calcSpacingValue(player: SimPlayer, state: GameState): number {
  const teammates = getTeammates(player, state);
  let value = 0;

  // 1. Voronoi area — how much court space does this player's position create?
  const voronoiArea = calcVoronoiArea(player.pos, teammates.map(t => t.pos));
  value += normalizeArea(voronoiArea) * 0.3;

  // 2. Paint clog penalty — two bigs in the paint kills spacing
  if (isInPaint(player.pos)) {
    const othersInPaint = teammates.filter(t => isInPaint(t.pos)).length;
    if (othersInPaint > 0) value -= 0.3;
  }

  // 3. Teammate proximity penalty — too close = bad
  const nearestTeammate = findNearestTeammate(player, state);
  if (nearestTeammate && dist(nearestTeammate.pos, player.pos) < 8) {
    value -= 0.15;
  }

  // 4. Hot zone bonus — corners, wings, elbow are high-value spots
  if (isCorner(player.pos)) value += 0.1;
  if (isWing(player.pos)) value += 0.08;
  if (isElbow(player.pos)) value += 0.06;

  // 5. Lane clearance — am I leaving the driving lane open?
  if (!isInDrivingLane(player.pos, state) && getDriveLaneWidth(state) > 8) {
    value += 0.05;
  }

  return value;
}
```

### 4. Screen Value

> "Good screens don't show in the box score but start every great play"

```typescript
function calcScreenValue(screener: SimPlayer, state: GameState): number {
  if (!screener.isScreening) return 0;

  const ballHandler = getBallHandler(state);
  if (!ballHandler) return 0;

  const handlerDefender = getDefender(ballHandler, state);
  if (!handlerDefender) return 0;

  let value = 0;

  // 1. Separation created — did the screen free the ball handler?
  const defenderDist = dist(handlerDefender.pos, ballHandler.pos);
  const separationScore = sigmoid(defenderDist, 4, 1.5);  // Inflection at 4ft
  value += separationScore * 0.3;

  // 2. Forced switch — did it create a mismatch?
  const switchedDefender = getDefender(ballHandler, state);
  if (switchedDefender !== handlerDefender) {
    const mismatch = evaluateMismatch(ballHandler, switchedDefender);
    value += mismatch * 0.3;  // Size/speed mismatch = high value
  }

  // 3. Screen angle quality — perpendicular to defender's path is best
  const angleQuality = calcScreenAngle(screener, ballHandler, handlerDefender);
  value += angleQuality * 0.15;

  // 4. Roll/pop quality — what happens after the screen?
  if (screener.isRolling) {
    const rollLaneOpen = calcRollLaneOpenness(screener, state);
    value += rollLaneOpen * 0.15;
  } else if (screener.isPopping) {
    const popOpenness = checkIfOpen(screener, state) ? 0.15 : 0.05;
    value += popOpenness;
  }

  // 5. Legal screen bonus — illegal screen = foul = negative value
  const isLegal = isLegalScreen(screener, state);
  if (!isLegal) value -= 0.4;

  return value;
}
```

### 5. Hockey Assist Value

> "A passes to B, B passes to C, C scores. A created the whole opportunity."

```typescript
function calcHockeyAssistValue(passer: SimPlayer, state: GameState): number {
  // Track the full pass chain for this possession
  const chain = state.passChain;  // [{from, to, epvDelta, time}, ...]

  // Find passes made by this player
  const myPasses = chain.filter(p => p.from === passer.id);
  let totalValue = 0;

  for (const pass of myPasses) {
    // How much did this pass improve EPV?
    const directEPVGain = pass.epvDelta;

    // Decay by chain distance to the eventual shot
    const stepsToShot = chain.length - chain.indexOf(pass) - 1;
    const decayFactor = Math.pow(0.5, stepsToShot);  // 50% per link

    // Credit = EPV improvement × decay
    totalValue += Math.max(0, directEPVGain) * decayFactor;
  }

  // Even without a score: EPV improvement from pass has value
  return totalValue;
}

// Track EPV changes on every pass
function onPass(state: GameState, from: SimPlayer, to: SimPlayer): void {
  const epvBefore = estimateEPV(state);
  // ... execute pass ...
  const epvAfter = estimateEPV(state);

  state.passChain.push({
    from: from.id,
    to: to.id,
    epvDelta: epvAfter - epvBefore,
    time: state.gameTime,
  });
}
```

### 6. Off-Ball Movement Value

> "Great movement without touching the ball — invisible but essential"

```typescript
function calcOffBallMovementValue(player: SimPlayer, state: GameState): number {
  if (player.hasBall) return 0;

  let value = 0;

  // 1. Cut quality — did my cut force help defense rotation?
  if (player.isCutting) {
    const myDefender = getDefender(player, state);
    if (myDefender) {
      const helpRotation = didCutForceHelpRotation(player, state);
      value += helpRotation ? 0.15 : 0.03;  // Even a failed cut has minor value

      // If cut created an open teammate (by pulling help):
      const newlyOpenTeammate = findNewlyOpenTeammate(state);
      if (newlyOpenTeammate) value += 0.20;
    }
  }

  // 2. Relocation — moved to open spot after pass/screen?
  if (player.justRelocated && checkIfOpen(player, state)) {
    const inRange = isInShootingRange(player);
    value += inRange ? 0.15 : 0.05;
  }

  // 3. Decoy value — drawing defensive attention
  const myDefender = getDefender(player, state);
  if (myDefender) {
    const defDistFromHelpPos = dist(myDefender.pos, getIdealHelpPosition(myDefender, state));
    // If my movement pulled my defender far from help position:
    value += clamp(defDistFromHelpPos * 0.01, 0, 0.15);
  }

  // 4. Call-for-ball timing — asking for ball when actually open is valuable
  if (player.isCallingForBall && checkIfOpen(player, state)) {
    value += 0.05;
  } else if (player.isCallingForBall && !checkIfOpen(player, state)) {
    value -= 0.05;  // Bad call = distracting
  }

  return value;
}
```

### 7. Contest Value

> "Changing an opponent's shot from 45% to 30% is worth ~0.3 expected points"

```typescript
function calcContestValue(defender: SimPlayer, shooter: SimPlayer, state: GameState): number {
  const distToShooter = dist(defender.pos, shooter.pos);
  const distToBasket = dist(shooter.pos, getTeamBasket(shooter.teamIdx));
  const points = distToBasket > 22 ? 3 : 2;

  // Expected make% open vs contested
  const openPct = getOpenShotPct(shooter, distToBasket);
  const contestedPct = getContestedShotPct(shooter, distToBasket, distToShooter);

  // Points saved by contesting
  const expectedPointsSaved = (openPct - contestedPct) * points;

  // Quality modifiers
  const verticalContest = defender.player.physical.vertical / 100;
  const heightAdvantage = (defender.player.physical.height - shooter.player.physical.height) / 12;
  const qualityMod = 1 + verticalContest * 0.2 + heightAdvantage * 0.1;

  // Foul risk — contesting too aggressively can backfire
  const foulRisk = distToShooter < 1.5 ? 0.20 : distToShooter < 3 ? 0.08 : 0.02;
  const foulCost = foulRisk * shooter.skills.shooting.free_throw / 100 * points;

  return (expectedPointsSaved * qualityMod) - foulCost;
}
```

### 8. Deflection / Passing Lane Disruption

> "Cutting off passes forces the offense to reset — time is the defense's friend"

```typescript
function calcDeflectionValue(defender: SimPlayer, state: GameState): number {
  const passingLanes = getActivePassingLanes(state);
  let totalValue = 0;

  for (const lane of passingLanes) {
    const distToLane = pointToLineDistance(defender.pos, lane.from, lane.to);
    if (distToLane > 4) continue;

    // Closer to lane = more disruptive
    const disruptionLevel = 1 - (distToLane / 4);

    // Value depends on how dangerous the pass would be
    const passReceiverThreat = lane.receiverShotEV || 0.5;

    // Deflection chance
    const deflectionChance = disruptionLevel *
      (defender.player.skills.defense.steal / 100) * 0.3;

    // Even without deflection: presence in lane forces offense to adjust
    const adjustmentCost = disruptionLevel * 0.05;  // Time wasted = value

    totalValue += (deflectionChance * passReceiverThreat) + adjustmentCost;
  }

  return totalValue;
}
```

### 9. Pressure Value (Ball Handler Pressure)

> "Making the ball handler uncomfortable reduces the entire offense's efficiency"

```typescript
function calcPressureValue(defender: SimPlayer, ballHandler: SimPlayer, state: GameState): number {
  if (!ballHandler.hasBall) return 0;

  const distToHandler = dist(defender.pos, ballHandler.pos);
  if (distToHandler > 8) return 0;

  // Close = more pressure
  const pressureLevel = Math.max(0, 1 - distToHandler / 8);

  // Pressure reduces handler's EPV options
  const baseEPV = estimateEPV(state);
  const pressuredEPV = estimatePressuredEPV(state, pressureLevel);
  const epvReduction = baseEPV - pressuredEPV;

  // Forcing bad decisions
  const handlerComposure = ballHandler.player.skills.playmaking.ball_handling / 100;
  const forceErrorChance = pressureLevel * (1 - handlerComposure) * 0.1;

  // Active hands bonus
  const activeHands = defender.player.skills.defense.steal / 100;
  const stripChance = pressureLevel * activeHands * 0.05;

  return epvReduction + forceErrorChance * 0.5 + stripChance * 0.8;
}
```

### 10. Help Defense Value

> "The right rotation at the right time is worth more than any individual stop"

```typescript
function calcHelpDefenseValue(defender: SimPlayer, state: GameState): number {
  // Am I in the right help position?
  const idealPos = getIdealHelpPosition(defender, state);
  const distToIdeal = dist(defender.pos, idealPos);

  // Close to ideal help position = ready to rotate
  const positioningScore = Math.max(0, 1 - distToIdeal / 12);

  // Can I actually help if needed?
  const ballHandler = getBallHandler(state);
  const distToBall = dist(defender.pos, ballHandler.pos);
  const canReachInTime = distToBall < 12;

  // Am I still close enough to recover to my man?
  const myMan = getAssignment(defender, state);
  const canRecover = myMan ? dist(defender.pos, myMan.pos) < 10 : true;

  // Best help = close to ideal, can reach ball, can recover
  let value = positioningScore * 0.3;
  if (canReachInTime) value += 0.1;
  if (canRecover) value += 0.1;

  // Penalty for being out of position (neither helping nor guarding)
  if (!canReachInTime && !canRecover) value -= 0.2;

  return value;
}
```

### 11. Forced Turnover Value (Non-Steal)

> "Trapping the ball handler, forcing a bad pass, forcing a jump ball — all valuable"

```typescript
function calcForcedTOValue(defender: SimPlayer, state: GameState): number {
  const handler = getBallHandler(state);
  if (!handler) return 0;

  let value = 0;

  // 1. Trap situation — two defenders on ball
  const defOnBall = getDefendersNear(handler, state, 4);
  if (defOnBall.includes(defender) && defOnBall.length >= 2) {
    const handlerPoise = handler.player.skills.playmaking.ball_handling / 100;
    value += (1 - handlerPoise) * 0.15;  // Bad handlers crack under traps
  }

  // 2. Forced pickup — made handler stop dribble
  if (handler.hasPickedUpDribble) {
    value += 0.10;  // Dead dribble = limited options
  }

  // 3. Forced jump ball potential
  const holdTime = state.dribbleTime;
  if (holdTime > 4 && dist(defender.pos, handler.pos) < 2) {
    value += 0.08;  // Tying up the ball
  }

  // 4. Baseline/sideline trap — pushed to boundary
  if (isNearBoundary(handler.pos) && dist(defender.pos, handler.pos) < 4) {
    value += 0.06;  // Limited escape options
  }

  return value;
}
```

### 12. Transition & Hustle Value

```typescript
function calcTransitionValue(player: SimPlayer, state: GameState): number {
  let value = 0;

  // OFFENSE: Pushing pace after turnover/rebound
  if (state.phase === 'advance' && player.teamIdx === state.possession) {
    const aheadOfBall = isAheadInTransition(player, state);
    if (aheadOfBall) value += 0.15;  // Running the floor

    const isLeaking = isLeakingOut(player, state);
    if (isLeaking && state.justTurnover) value += 0.20;  // Cherry-picking after steal
  }

  // DEFENSE: Getting back
  if (state.phase === 'advance' && player.teamIdx !== state.possession) {
    const isBackInPosition = isInDefensivePosition(player, state);
    if (isBackInPosition) value += 0.10;

    const isSprintingBack = magnitude(player.vel) > 15 && isMovingTowardOwnBasket(player, state);
    if (isSprintingBack) value += 0.08;

    // Penalty for not getting back
    if (!isBackInPosition && !isSprintingBack) value -= 0.15;
  }

  return value;
}

function calcReboundPositionValue(player: SimPlayer, state: GameState): number {
  if (state.phase !== 'shooting') return 0;

  // Is player boxing out?
  const assignment = getAssignment(player, state);
  if (assignment) {
    const isBoxingOut = isPlayerBoxingOut(player, assignment);
    if (isBoxingOut) return 0.15;
  }

  // Offensive boards: is player crashing?
  if (player.teamIdx === state.possession) {
    const crashingBoards = isMovingToward(player, state.ball.pos);
    if (crashingBoards) return 0.10;
  }

  return 0;
}

function calcLooseBallValue(player: SimPlayer, state: GameState): number {
  if (!state.ball.isLoose) return 0;

  const distToBall = dist(player.pos, state.ball.pos);
  const isHustling = magnitude(player.vel) > 12 && isMovingToward(player, state.ball.pos);

  // Diving for loose balls
  if (distToBall < 5 && isHustling) return 0.20;
  if (distToBall < 10 && isHustling) return 0.10;

  return 0;
}
```

---

## Unified Utility Score

### Utility Weights

Each value channel has a weight representing its importance to winning:

```typescript
interface UtilityWeights {
  // Direct
  scoringEV:            number;

  // Indirect Offense
  gravityValue:         number;
  spacingValue:         number;
  playAdvancementValue: number;
  screenValue:          number;
  hockeyAssistValue:    number;
  offBallMovementValue: number;
  decoyValue:           number;

  // Defense
  contestValue:         number;
  deflectionValue:      number;
  pressureValue:        number;
  helpDefenseValue:     number;
  forcedTOValue:        number;
  forcedJumpBallValue:  number;

  // Transition & Hustle
  transitionValue:      number;
  reboundPositionValue: number;
  looseballValue:       number;
}
```

### Personal vs Team Weights

**The key insight: personal utility and team utility use the SAME channels but DIFFERENT weights.**

```typescript
const PERSONAL_WEIGHTS: UtilityWeights = {
  // Personal utility optimizes box score / PER
  scoringEV:            1.00,   // Points = king for personal stats
  gravityValue:         0.05,   // Doesn't show in stats
  spacingValue:         0.05,   // Doesn't show in stats
  playAdvancementValue: 0.15,   // Only matters if it becomes an assist
  screenValue:          0.02,   // No box score credit
  hockeyAssistValue:    0.05,   // Not tracked traditionally
  offBallMovementValue: 0.05,   // Nobody notices
  decoyValue:           0.02,   // Literally invisible

  contestValue:         0.20,   // Blocks show in box score
  deflectionValue:      0.15,   // Steals show in box score
  pressureValue:        0.05,   // Not tracked
  helpDefenseValue:     0.05,   // Not tracked
  forcedTOValue:        0.10,   // Steals show
  forcedJumpBallValue:  0.05,   // Barely noticed

  transitionValue:      0.10,   // Fast break points show
  reboundPositionValue: 0.30,   // Rebounds show in box score
  looseballValue:       0.08,   // Sometimes noticed
};

const TEAM_WEIGHTS: UtilityWeights = {
  // Team utility optimizes +/- and winning
  scoringEV:            1.00,   // Still important
  gravityValue:         0.30,   // Huge for team offense
  spacingValue:         0.25,   // Huge for team offense
  playAdvancementValue: 0.35,   // Ball movement = good offense
  screenValue:          0.20,   // Screens create everything
  hockeyAssistValue:    0.25,   // Extra pass culture
  offBallMovementValue: 0.20,   // Movement creates openings
  decoyValue:           0.15,   // Drawing attention helps team

  contestValue:         0.40,   // Defense wins championships
  deflectionValue:      0.25,   // Disruption is huge
  pressureValue:        0.20,   // Makes offense uncomfortable
  helpDefenseValue:     0.30,   // Team defense > individual defense
  forcedTOValue:        0.35,   // Turnovers = transition points
  forcedJumpBallValue:  0.15,   // Possession value

  transitionValue:      0.20,   // Transition D is critical
  reboundPositionValue: 0.15,   // Important but not everything
  looseballValue:       0.15,   // Hustle wins games
};
```

### Blending via Compliance

```typescript
function calculateTotalUtility(
  action: Action,
  player: SimPlayer,
  coachPlay: PlayCall,
  state: GameState
): number {
  // 1. Calculate all value channels for this action
  const values = evaluateActionValues(action, player, state);

  // 2. Score with personal weights
  const personalScore = weightedSum(values, PERSONAL_WEIGHTS);

  // 3. Score with team weights
  const teamScore = weightedSum(values, TEAM_WEIGHTS);

  // 4. Apply tendencies
  const tendencyMod = getTendencyMultiplier(player, action);

  // 5. Blend based on compliance
  const compliance = getComplianceScore(player, state);
  const blendedScore = compliance * teamScore + (1 - compliance) * personalScore;

  // 6. Apply tendency and noise
  const noise = (state.rng() - 0.5) * 0.05;  // Small random variation
  return blendedScore * tendencyMod + noise;
}

function weightedSum(values: ActionValue, weights: UtilityWeights): number {
  let sum = 0;
  for (const key of Object.keys(weights)) {
    sum += (values[key] || 0) * weights[key];
  }
  return sum;
}
```

---

## Emergent Player Archetypes

The weight difference naturally produces recognizable player types:

### Selfish Star (Low Compliance)
```
Blend: 30% team + 70% personal
→ Chases scoring (1.00 weight), ignores screens (0.02 weight)
→ Doesn't value hockey assists (0.05) or spacing (0.05)
→ Stats: 28 PPG, 2 APG, terrible +/-
→ "Empty calories" player
```

### Glue Guy (High Compliance)
```
Blend: 85% team + 15% personal
→ Values screens (0.20), spacing (0.25), help D (0.30)
→ Gravity (0.30) + off-ball movement (0.20) always active
→ Stats: 8 PPG, 4 APG, elite +/-
→ "Winning player" that doesn't show up in box score
```

### Smart Star (High Compliance + High Skill)
```
Blend: 70% team + 30% personal
→ Scoring EV is high because skill is high
→ Also values playAdvancement (0.35) and hockeyAssist (0.25)
→ Stats: 25 PPG, 8 APG, elite +/-
→ "Best player in the league" type
```

### Defensive Anchor (High Compliance, Defensive Focus)
```
Blend: 80% team + 20% personal
→ Contest (0.40), help defense (0.30), pressure (0.20) dominate
→ Rebounds for personal stats (0.30 personal weight)
→ Stats: 10 PPG, 12 RPG, 2 BPG, DPOY candidate
```

---

## Value Tracking (Runtime Analytics)

Every action's value is logged for post-game analysis:

```typescript
interface ValueLog {
  tick: number;
  playerId: string;
  action: string;
  values: ActionValue;        // All channel values
  personalScore: number;      // Weighted personal
  teamScore: number;          // Weighted team
  blendedScore: number;       // Final score used
  compliance: number;         // Compliance at time of decision
  chosen: boolean;            // Was this the selected action?
}
```

This enables:
- **Post-game player grades** based on cumulative value generated
- **"Impact rating"** — total value created per minute
- **Hidden stats page** — hockey assists, gravity value, contest quality
- **Chemistry tracking** — do certain pairs generate more value together?
- **Coaching feedback** — "Player X ignored the play 40% of the time"

---

## Decision Pipeline (Complete)

```
 DECISION TICK (4x per second)
 │
 ├─ BALL HANDLER:
 │   │
 │   ├─ List candidate actions: [shoot, pass, drive, iso, dribble, postUp]
 │   │
 │   ├─ For each action:
 │   │   ├─ Calculate all value channels (scoringEV, gravity, spacing, ...)
 │   │   ├─ Personal score = Σ(channel × personal_weight)
 │   │   ├─ Team score = Σ(channel × team_weight)
 │   │   ├─ Apply tendency multiplier
 │   │   ├─ Blend = compliance × team + (1-compliance) × personal
 │   │   └─ Add noise
 │   │
 │   └─ Execute highest-scoring action
 │
 └─ OFF-BALL PLAYERS:
     │
     ├─ List candidate actions: [cut, spotUp, screen, moveToSpot, callForBall, postPosition]
     │
     ├─ For each action:
     │   ├─ Calculate all value channels
     │   ├─ Blend personal vs team (same as above)
     │   └─ Add noise
     │
     └─ Execute highest-scoring action
```

---

## Open Questions

1. **EPV estimation accuracy** — How complex does EPV need to be? Full Monte Carlo simulation or simplified heuristic?
2. **Weight tuning** — How do we validate that team weights are correct? Compare simulated stats to NBA averages?
3. **Noise level** — Too little = robotic, too much = random. What's the right amount?
4. **Computation budget** — Evaluating all channels for all actions for 10 players 4x/sec — is this fast enough?
5. **Cross-player value** — How to credit value when two players create it together (e.g., pick and roll)?
6. **Defensive scheme integration** — How does team defensive utility interact with coach's scheme (man vs zone)?
7. **Fatigue impact** — Should fatigue reduce all utility channels equally, or affect some more than others?
8. **Learning/adaptation** — Should players adjust weights mid-game based on what's working?

---

## References

- **EPV (Expected Possession Value)** — Cervone et al., 2014: "A Multiresolution Stochastic Process Model for Predicting Basketball Possession Outcomes"
- **Second Spectrum** — NBA's official tracking partner, real-time EPV calculation
- **RAPTOR (FiveThirtyEight)** — Blends box score and tracking data for player impact
- **Thinking Basketball (Ben Taylor)** — "Backpicks" player evaluation emphasizing off-ball value
- **Cleaning the Glass** — Shot quality and location-based analysis

---

*This document is a living design spec. Update as decisions are made.*
