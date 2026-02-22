# Hoopcraft Player Vision System

> **Status:** Design Phase
> **Last Updated:** 2026-02-22
> **Authors:** Jacky, PyBot
> **Related:** [ai-architecture.md](./ai-architecture.md), [utility-system.md](./utility-system.md)

---

## Overview

Vision is the **input layer** for the entire AI system. Players are not omniscient — they have field-of-view limits, attention budgets, memory decay, and varying ability to read the game. All of this feeds into the utility function.

### Design Principle

```
Real basketball:                  Current sim:
Player sees ~180° ahead          Player knows all 10 positions
Reaction takes time               Instant reaction
Can focus on 2-3 things           Processes everything
Experience helps anticipation     No anticipation
Communication aids awareness      No communication
```

The vision system bridges this gap with three layers:

```
┌──────────────────────────────────────────┐
│  RAW PERCEPTION (what I physically see)   │
│  Field of view, occlusion, distance       │
└──────────────────┬───────────────────────┘
                   │ filtered by attention
                   ▼
┌──────────────────────────────────────────┐
│  AWARENESS MAP (what I'm conscious of)    │
│  Attention budget, tracking, memory       │
└──────────────────┬───────────────────────┘
                   │ interpreted by BBIQ
                   ▼
┌──────────────────────────────────────────┐
│  GAME READS (what I understand)           │
│  Lanes, opportunities, threats, plays     │
└──────────────────────────────────────────┘
```

---

## Layer 1: Raw Perception

What the player can physically see, limited by field of view, distance, and occlusion.

### Data Structure

```typescript
interface RawPerception {
  // Field of view
  fov: number;                    // ~180° total, ~120° effective, ~60° detail
  facingAngle: number;            // Direction player is currently looking

  // Visible entities
  visiblePlayers: PerceivedPlayer[];
  ballVisible: boolean;
  basketVisible: boolean;
}

interface PerceivedPlayer {
  id: string;
  position: Vec2;                 // Perceived position (may have noise)
  velocity: Vec2;                 // Perceived movement direction
  confidence: number;             // 0-1: how certain is this information?
  lastSeen: number;               // Game time when last directly seen
  isTeammate: boolean;

  // Detail level (depends on distance + angle)
  canSeeStance: boolean;          // Close enough to read body language?
  canSeeEyes: boolean;            // Close enough to see where they're looking?
}
```

### Field of View Zones

```
                    ╱ · · · · · ╲
                  ╱ · · · · · · · ╲
                ╱ · FULL DETAIL · · ╲     ← 60° cone: read body language, eyes
              ╱ · · · · · · · · · · · ╲
            ╱ · · PERIPHERAL · · · · · ╲   ← 120°: see movement and positions
          ╱ · · · · · · · · · · · · · · ╲
        ╱ · · · WIDE PERIPHERAL · · · · · ╲ ← 180°: detect presence and motion
       ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
                      👤 (player facing up)

       BEHIND (>180°): blind spot — only audio cues + memory
```

### Distance × Angle → Confidence Matrix

| | Detail Cone (<30°) | Peripheral (30-60°) | Wide (60-90°) | Behind (>90°) |
|---|---|---|---|---|
| **Close (<10ft)** | 0.95 | 0.85 | 0.70 | 0.30 (audio) |
| **Medium (10-20ft)** | 0.80 | 0.60 | 0.45 | 0.10 (audio) |
| **Far (20-35ft)** | 0.60 | 0.40 | 0.25 | 0.00 |
| **Very Far (>35ft)** | 0.40 | 0.25 | 0.15 | 0.00 |

### Perception Calculation

```typescript
function calcPerception(player: SimPlayer, state: GameState): RawPerception {
  const visible: PerceivedPlayer[] = [];

  for (const other of state.players) {
    if (other === player) continue;

    const angle = angleTo(player.pos, player.facingAngle, other.pos);
    const distance = dist(player.pos, other.pos);

    // Behind me — only audio cues
    if (Math.abs(angle) > 90) {
      const audioAwareness = distance < 6 ? 0.30 : distance < 12 ? 0.10 : 0;
      if (audioAwareness > 0) {
        visible.push({
          id: other.id,
          position: addNoise(other.pos, 3.0, state.rng),  // Very rough
          velocity: { x: 0, y: 0 },  // Can't tell direction
          confidence: audioAwareness,
          lastSeen: player.memory.get(other.id)?.lastSeen || 0,
          isTeammate: other.teamIdx === player.teamIdx,
          canSeeStance: false,
          canSeeEyes: false,
        });
      }
      continue;
    }

    // Occlusion check — is another player blocking my view?
    const occluded = isOccluded(player, other, state);
    if (occluded) {
      visible.push({
        id: other.id,
        position: addNoise(other.pos, 2.0, state.rng),
        velocity: addNoise(other.vel, 3.0, state.rng),
        confidence: 0.20,
        lastSeen: player.memory.get(other.id)?.lastSeen || 0,
        isTeammate: other.teamIdx === player.teamIdx,
        canSeeStance: false,
        canSeeEyes: false,
      });
      continue;
    }

    // Detail level by distance and angle
    const inDetailCone = Math.abs(angle) < 30;
    const inPeripheral = Math.abs(angle) < 60;

    let confidence: number;
    if (distance < 10 && inDetailCone) confidence = 0.95;
    else if (distance < 10 && inPeripheral) confidence = 0.85;
    else if (distance < 10) confidence = 0.70;
    else if (distance < 20 && inDetailCone) confidence = 0.80;
    else if (distance < 20 && inPeripheral) confidence = 0.60;
    else if (distance < 20) confidence = 0.45;
    else if (inDetailCone) confidence = 0.60;
    else if (inPeripheral) confidence = 0.40;
    else confidence = 0.25;

    // Position noise inversely proportional to confidence
    const posNoise = (1 - confidence) * 2;  // 0-2 feet of error

    visible.push({
      id: other.id,
      position: addNoise(other.pos, posNoise, state.rng),
      velocity: addNoise(other.vel, posNoise * 1.5, state.rng),
      confidence,
      lastSeen: state.gameTime,
      isTeammate: other.teamIdx === player.teamIdx,
      canSeeStance: distance < 12 && inDetailCone,
      canSeeEyes: distance < 8 && inDetailCone,
    });
  }

  return {
    fov: 180,
    facingAngle: player.facingAngle,
    visiblePlayers: visible,
    ballVisible: isBallVisible(player, state),
    basketVisible: isBasketVisible(player, state),
  };
}
```

### Facing Direction

Where a player looks depends on their role and situation:

```typescript
function updateFacingDirection(player: SimPlayer, state: GameState): number {
  // Ball handler: faces the basket (with glances to sides)
  if (player.hasBall) {
    const basket = getTeamBasket(player.teamIdx);
    return angleToPoint(player.pos, basket);
  }

  // Defender on ball: faces their assignment
  const assignment = getDefensiveAssignment(player, state);
  if (assignment && assignment.hasBall) {
    return angleToPoint(player.pos, assignment.pos);
  }

  // Off-ball offense: split vision between ball and basket
  if (player.teamIdx === state.possession) {
    const ball = state.ball.pos;
    const basket = getTeamBasket(player.teamIdx);
    // Bias toward ball (60%) with some basket awareness (40%)
    return lerpAngle(
      angleToPoint(player.pos, ball),
      angleToPoint(player.pos, basket),
      0.4
    );
  }

  // Off-ball defense: "see man, see ball" — split between assignment and ball
  if (assignment) {
    const ball = state.ball.pos;
    const manAngle = angleToPoint(player.pos, assignment.pos);
    const ballAngle = angleToPoint(player.pos, ball);
    // Classic defensive positioning: between man and ball
    return lerpAngle(manAngle, ballAngle, 0.5);
  }

  // Default: face the ball
  return angleToPoint(player.pos, state.ball.pos);
}
```

### Head on a Swivel

Good defenders and playmakers periodically scan the court:

```typescript
function applyScanBehavior(player: SimPlayer, baseFacing: number, state: GameState): number {
  const awareness = player.player.skills.mental.awareness || 50;
  const bbiq = player.player.skills.mental.bbiq || 50;

  // Scan frequency: high awareness = scan more often
  const scanFrequency = 0.5 + (awareness / 100) * 1.5;  // 0.5-2.0 Hz
  const scanAmplitude = 20 + (awareness / 100) * 30;     // 20-50 degrees

  // Periodic scan
  const scanPhase = Math.sin(state.gameTime * scanFrequency * Math.PI * 2);
  const scanOffset = scanPhase * scanAmplitude;

  // BBIQ affects scan timing — smart players scan during dead moments
  const isDeadMoment = !player.hasBall && state.dribbleTime > 1.0;
  const scanBonus = isDeadMoment && bbiq > 60 ? 15 : 0;

  return baseFacing + scanOffset + scanBonus;
}
```

---

## Layer 2: Awareness Map

Raw perception filtered through attention and augmented with memory. This is what the player is "conscious of."

### Data Structure

```typescript
interface AwarenessMap {
  // Actively tracked entities (limited by attention budget)
  tracked: TrackedEntity[];

  // Spatial awareness
  openSpaces: Zone[];              // Areas with no defenders
  congestedAreas: Zone[];          // Crowded areas to avoid

  // Attention
  attentionFocus: string[];        // Player IDs being tracked, ordered by priority
  attentionCapacity: number;       // How many things can be tracked simultaneously

  // Memory of unseen/untracked players
  memory: PlayerMemory[];
  memoryDecay: number;             // How fast memory fades (seconds)
}

interface TrackedEntity {
  playerId: string;
  perceivedPos: Vec2;
  perceivedVel: Vec2;
  confidence: number;
  threat: number;                  // Defensive threat level (0-1)
  opportunity: number;             // Offensive opportunity level (0-1)
}

interface PlayerMemory {
  playerId: string;
  lastKnownPos: Vec2;
  lastKnownVel: Vec2;
  lastSeen: number;                // Game time
  predictedPos: Vec2;              // Extrapolated current position
  confidence: number;              // Decays over time
}
```

### Attention Budget

The most important constraint — humans can only actively track 2-4 things at once:

```typescript
function updateAwareness(
  player: SimPlayer,
  perception: RawPerception,
  state: GameState
): AwarenessMap {
  const bbiq = player.player.skills.mental.bbiq || 50;

  // Attention capacity: low BBIQ = 2 slots, high BBIQ = 4 slots
  const attentionCapacity = Math.floor(2 + (bbiq / 100) * 2);

  // Score every perceived player by priority
  const priorities: { target: PerceivedPlayer; priority: number }[] = [];

  for (const p of perception.visiblePlayers) {
    let priority = 0;

    // Ball carrier — always highest priority
    if (playerHasBall(p.id, state)) priority += 5.0;

    // My defensive assignment — must track
    if (isMyAssignment(player, p.id, state)) priority += 4.0;

    // Immediate threat (close defender when I have ball)
    if (player.hasBall && !p.isTeammate) {
      const proximity = Math.max(0, 1 - dist(p.position, player.pos) / 10);
      priority += proximity * 3.0;
    }

    // Open teammate (passing target when I have ball)
    if (player.hasBall && p.isTeammate) {
      const openness = getPerceivedOpenness(p, perception);
      priority += openness * 2.0;
    }

    // Screener approaching — need to see this
    if (isApproachingScreen(p, player, state)) priority += 2.0;

    // Cutting teammate — time-sensitive opportunity
    if (p.isTeammate && isPerceivedCutting(p)) priority += 1.5;

    // Player in my zone (zone defense)
    if (isInMyZone(p, player, state)) priority += 1.5;

    // High confidence = easier to track (less effort)
    priority += p.confidence * 0.5;

    // Distance penalty — far = less relevant
    priority -= dist(player.pos, p.position) / 25;

    priorities.push({ target: p, priority });
  }

  // Sort and take top N
  priorities.sort((a, b) => b.priority - a.priority);
  const trackedTargets = priorities.slice(0, attentionCapacity);

  // Everything else goes to memory
  const memory = updateMemory(player, perception, state, bbiq);

  // Detect spatial zones
  const openSpaces = detectOpenSpaces(perception, state);
  const congested = detectCongestedAreas(perception, state);

  return {
    tracked: trackedTargets.map(t => ({
      playerId: t.target.id,
      perceivedPos: t.target.position,
      perceivedVel: t.target.velocity,
      confidence: t.target.confidence,
      threat: calcThreatLevel(t.target, player, state),
      opportunity: calcOpportunityLevel(t.target, player, state),
    })),
    openSpaces,
    congestedAreas: congested,
    attentionFocus: trackedTargets.map(t => t.target.id),
    attentionCapacity,
    memory,
    memoryDecay: 2 + (bbiq / 100) * 4,  // 2-6 seconds
  };
}
```

### Memory System

What happens to players we can't see or aren't tracking:

```typescript
function updateMemory(
  player: SimPlayer,
  perception: RawPerception,
  state: GameState,
  bbiq: number
): PlayerMemory[] {
  const memories = [...player.memories];

  for (const mem of memories) {
    const currentlyVisible = perception.visiblePlayers.find(p => p.id === mem.playerId);

    if (currentlyVisible && currentlyVisible.confidence > 0.5) {
      // Refresh memory with current perception
      mem.lastKnownPos = currentlyVisible.position;
      mem.lastKnownVel = currentlyVisible.velocity;
      mem.lastSeen = state.gameTime;
      mem.confidence = currentlyVisible.confidence;
      mem.predictedPos = currentlyVisible.position;
    } else {
      // Predict where they went based on last known velocity
      const timeSinceSeen = state.gameTime - mem.lastSeen;

      mem.predictedPos = {
        x: mem.lastKnownPos.x + mem.lastKnownVel.x * Math.min(timeSinceSeen, 2),
        y: mem.lastKnownPos.y + mem.lastKnownVel.y * Math.min(timeSinceSeen, 2),
      };
      // Cap prediction at 2 seconds of velocity — beyond that, too uncertain

      // Confidence decays over time
      // High BBIQ = slower decay (better mental model of where people go)
      const decayRate = 0.15 + (1 - bbiq / 100) * 0.35;  // 0.15-0.50 per second
      mem.confidence = Math.max(0.05, mem.confidence - decayRate * (1 / 60));
    }
  }

  return memories;
}
```

### Attention Overload

When too much happens at once, low-BBIQ players lose track:

```typescript
function checkAttentionOverload(
  player: SimPlayer,
  awareness: AwarenessMap,
  state: GameState
): number {
  const bbiq = player.player.skills.mental.bbiq || 50;

  // Count simultaneous events demanding attention
  let attentionDemand = 0;
  attentionDemand += player.hasBall ? 2 : 0;           // Ball handling takes focus
  attentionDemand += isBeingPressured(player, state) ? 1 : 0;
  attentionDemand += isScreenComing(player, state) ? 1 : 0;
  attentionDemand += state.shotClock < 5 ? 1 : 0;      // Clock pressure
  attentionDemand += isCrowdLoud(state) ? 0.5 : 0;     // Crowd noise

  const capacity = 2 + (bbiq / 100) * 3;  // 2-5

  // Overload ratio: >1 means overloaded
  const overload = attentionDemand / capacity;

  if (overload > 1.0) {
    // Reduce confidence on all tracked entities
    // Increase reaction time
    // More likely to make mistakes
    return Math.min(overload, 2.0);  // Cap at 2x overload
  }

  return overload;
}
```

---

## Layer 3: Game Reads

The awareness map interpreted into actionable basketball intelligence. This is where BBIQ matters most — the same visual information produces different reads for different players.

### Master Data Structure

```typescript
interface GameReads {
  // ── OFFENSIVE READS ─────────────────────────
  passingLanes: PassingLane[];          // Safe routes to pass
  cuttingLanes: CuttingLane[];          // Open paths to cut/drive
  pathToHoop: DrivePath | null;         // Best route to basket
  shootingWindow: ShootingWindow;       // Current shot quality
  hotSpots: HotSpot[];                  // Preferred shooting locations
  screenOpportunities: ScreenRead[];    // Screens to use or set

  // ── PLAY EXECUTION READS ────────────────────
  playRole: PlayRoleRead;              // What the play wants me to do
  playProgress: number;                // How far along is the play? (0-1)
  playBroken: boolean;                 // Did defense blow up the play?
  freelanceOpportunity: number;        // Utility delta: freelance vs play

  // ── DEFENSIVE READS ─────────────────────────
  myMatchup: MatchupRead;             // My assignment's tendencies + threat
  helpNeeded: HelpRead | null;        // Does a teammate need help?
  trapOpportunity: TrapRead | null;   // Can we trap the ball handler?
  closeoutTarget: CloseoutRead | null;// Shooter I need to close out on
  boxOutTarget: BoxOutRead | null;    // Who to box out for rebound

  // ── TRANSITION READS ────────────────────────
  fastBreakLane: TransitionLane | null; // Open lane in transition
  leakOpportunity: boolean;            // Should I cherry-pick?
  getBackUrgency: number;              // How urgent to get back on D? (0-1)
}
```

### Passing Lane Reads

Passing lanes are the most complex read — combining risk, reward, and timing:

```typescript
interface PassingLane {
  targetPlayer: string;
  targetPos: Vec2;

  // Route quality
  distance: number;               // Pass distance in feet
  angle: number;                  // Relative to my facing direction
  passType: 'chest' | 'bounce' | 'lob' | 'skip';  // Best pass type for this lane

  // Risk assessment
  interceptors: Interceptor[];    // Defenders who could steal
  riskScore: number;              // 0 = safe, 1 = guaranteed turnover
  windowDuration: number;         // How long this lane stays open (seconds)
  isClosing: boolean;             // Is a defender moving into the lane?

  // Value assessment
  receiverOpenness: number;       // How open is the receiver? (0-1)
  receiverShotEV: number;         // If they catch, what's their shot value?
  receiverCanShoot: boolean;      // Are they in shooting position to catch-and-shoot?
  advancesPlay: boolean;          // Does this pass move the play forward?
}

interface Interceptor {
  playerId: string;
  distToLane: number;             // Distance from passing lane
  interceptChance: number;        // Probability of stealing the pass
  isMovingIntoLane: boolean;      // Actively closing the lane?
}
```

#### Calculation

```typescript
function readPassingLanes(
  player: SimPlayer,
  awareness: AwarenessMap,
  state: GameState
): PassingLane[] {
  const lanes: PassingLane[] = [];
  const bbiq = player.player.skills.mental.bbiq || 50;

  // Candidates: tracked teammates + memorized teammates (if confident enough)
  const candidates = [
    ...awareness.tracked.filter(t => isTeammate(t.playerId, player, state)),
    ...awareness.memory.filter(m =>
      m.confidence > 0.3 && isTeammate(m.playerId, player, state)
    ),
  ];

  for (const target of candidates) {
    const targetPos = 'perceivedPos' in target ? target.perceivedPos : target.predictedPos;
    const targetConf = target.confidence;

    // Find interceptors along the pass path
    const interceptors = findInterceptors(player.pos, targetPos, awareness, state);

    // Base risk from interceptors
    const interceptRisk = interceptors.reduce(
      (max, i) => Math.max(max, i.interceptChance), 0
    );

    // Confidence penalty — passing to a memorized (unseen) player is risky
    const memoryPenalty = targetConf < 0.7 ? (1 - targetConf) * 0.3 : 0;

    // Angle penalty — behind-the-back passes are harder
    const passAngle = angleTo(player.pos, player.facingAngle, targetPos);
    const anglePenalty = Math.abs(passAngle) > 90 ? 0.2 : Math.abs(passAngle) > 60 ? 0.1 : 0;

    // BBIQ affects risk assessment accuracy
    // Low BBIQ = underestimates risk OR overestimates risk (noisy assessment)
    const riskNoise = (1 - bbiq / 100) * 0.2;
    const perceivedRisk = clamp(
      interceptRisk + memoryPenalty + anglePenalty + (state.rng() - 0.5) * riskNoise,
      0, 1
    );

    // Receiver value
    const receiver = state.players.find(p => p.id === (target.playerId || target.id));
    const receiverOpenness = getPerceivedOpenness(target, awareness);
    const receiverShotEV = receiver ? estimateReceiverShotEV(receiver, targetPos, state) : 0;

    // Window duration — how long before a defender closes the lane
    const closingDefender = interceptors.find(i => i.isMovingIntoLane);
    const windowDuration = closingDefender
      ? closingDefender.distToLane / 8  // ~8 ft/s defender speed
      : 3.0;  // Open lane stays open ~3 seconds

    // Best pass type for this lane
    const passType = selectPassType(player.pos, targetPos, interceptors);

    lanes.push({
      targetPlayer: target.playerId || target.id,
      targetPos,
      distance: dist(player.pos, targetPos),
      angle: passAngle,
      passType,
      interceptors,
      riskScore: perceivedRisk,
      windowDuration,
      isClosing: !!closingDefender,
      receiverOpenness,
      receiverShotEV,
      receiverCanShoot: receiverOpenness > 0.5 && isInShootingRange(targetPos, state),
      advancesPlay: doesPassAdvancePlay(player, receiver, state),
    });
  }

  return lanes.sort((a, b) => {
    const aValue = a.receiverShotEV * (1 - a.riskScore);
    const bValue = b.receiverShotEV * (1 - b.riskScore);
    return bValue - aValue;
  });
}

function findInterceptors(
  from: Vec2,
  to: Vec2,
  awareness: AwarenessMap,
  state: GameState
): Interceptor[] {
  const interceptors: Interceptor[] = [];
  const passSpeed = 25;  // ~25 ft/s average pass speed
  const passTime = dist(from, to) / passSpeed;

  const defenders = [
    ...awareness.tracked.filter(t => !isTeammate(t.playerId, null, state)),
    ...awareness.memory.filter(m =>
      m.confidence > 0.4 && !isTeammate(m.playerId, null, state)
    ),
  ];

  for (const def of defenders) {
    const defPos = 'perceivedPos' in def ? def.perceivedPos : def.predictedPos;
    const defVel = 'perceivedVel' in def ? def.perceivedVel : { x: 0, y: 0 };
    const distToLane = pointToLineDistance(defPos, from, to);

    if (distToLane > 8) continue;  // Too far to intercept

    // Time for defender to reach the passing lane
    const reachTime = Math.max(0, distToLane - 2) / 12;  // ~12 ft/s lunge speed
    // Add reaction time
    const totalTime = reachTime + 0.2;

    const canIntercept = totalTime < passTime;
    const interceptChance = canIntercept
      ? clamp(1 - totalTime / passTime, 0, 0.8)
      : 0;

    // Is this defender actively moving into the lane?
    const movingToward = dotProduct(defVel, normalize(sub(to, from)));
    const isClosing = movingToward > 2;

    if (interceptChance > 0.05 || distToLane < 4) {
      interceptors.push({
        playerId: def.playerId || def.id,
        distToLane,
        interceptChance,
        isMovingIntoLane: isClosing,
      });
    }
  }

  return interceptors;
}

function selectPassType(from: Vec2, to: Vec2, interceptors: Interceptor[]): string {
  const distance = dist(from, to);
  const hasCloseInterceptor = interceptors.some(i => i.distToLane < 3);
  const hasLowInterceptor = interceptors.some(i => i.distToLane < 5);

  if (distance < 10 && !hasCloseInterceptor) return 'chest';
  if (hasLowInterceptor && distance < 15) return 'bounce';  // Under defender's hands
  if (hasCloseInterceptor && distance < 20) return 'lob';    // Over defender
  if (distance > 25) return 'skip';                           // Cross-court skip pass
  return 'chest';
}
```

### Cutting Lane / Path to Hoop Reads

```typescript
interface CuttingLane {
  path: Vec2[];                   // Waypoints to follow
  entryPoint: Vec2;               // Where to start the cut
  exitPoint: Vec2;                // Destination (basket or open spot)

  // Quality
  width: number;                  // Narrowest point in feet
  isClosing: boolean;             // Is help defense collapsing?
  timeAvailable: number;          // Seconds before lane closes

  // Obstacles
  obstacles: DefenderObstacle[];
  requiresBeatDefender: boolean;  // Must blow by someone?

  // Value
  expectedFinishEV: number;       // Expected points if reaching basket
  drawFoulChance: number;         // Probability of drawing a foul
  kickOutOptions: number;         // Teammates available if drive collapses
}

interface DrivePath {
  route: Vec2[];                  // Optimal path considering defenders
  preferredSide: 'left' | 'right';
  distToBasket: number;

  // Obstacles along path
  primaryDefender: DefenderObstacle;
  helpDefenders: DefenderObstacle[];

  // Decision points along the drive
  pullUpSpot: Vec2 | null;        // Where to pull up for jumper if drive stalls
  floaterZone: Vec2 | null;       // Where to attempt a floater over help
  finishZone: Vec2;               // Where layup/dunk happens

  // Escape routes if drive dies
  kickOutTargets: PassingLane[];  // Passing options if trapped
}

interface DefenderObstacle {
  playerId: string;
  position: Vec2;
  distToPath: number;             // Distance from driving path
  canReach: boolean;              // Can they get to the path in time?
  isHelpDefender: boolean;        // Primary defender vs help?
}
```

#### Calculation

```typescript
function readDrivePath(
  player: SimPlayer,
  awareness: AwarenessMap,
  state: GameState
): DrivePath | null {
  if (!player.hasBall) return null;

  const basket = getTeamBasket(player.teamIdx);
  const distToBasket = dist(player.pos, basket);
  if (distToBasket > 30 || distToBasket < 4) return null;  // Too far or already there

  // Try both sides
  const leftPath = sampleDrivePath(player, basket, 'left', awareness, state);
  const rightPath = sampleDrivePath(player, basket, 'right', awareness, state);

  // Pick the more open side
  const leftClear = leftPath ? assessPathClearance(leftPath, awareness) : 0;
  const rightClear = rightPath ? assessPathClearance(rightPath, awareness) : 0;

  const bestPath = leftClear > rightClear ? leftPath : rightPath;
  if (!bestPath) return null;

  // Find obstacles
  const obstacles = findPathObstacles(bestPath.route, awareness, state);

  // Find decision points
  const pullUpSpot = findPullUpSpot(bestPath.route, obstacles, player);
  const floaterZone = findFloaterZone(bestPath.route, obstacles);

  // Kick-out options if drive collapses
  const kickOuts = readPassingLanes(player, awareness, state)
    .filter(l => l.receiverCanShoot && l.riskScore < 0.3);

  return {
    route: bestPath.route,
    preferredSide: leftClear > rightClear ? 'left' : 'right',
    distToBasket,
    primaryDefender: obstacles.find(o => !o.isHelpDefender) || obstacles[0],
    helpDefenders: obstacles.filter(o => o.isHelpDefender),
    pullUpSpot,
    floaterZone,
    finishZone: bestPath.route[bestPath.route.length - 1],
    kickOutTargets: kickOuts,
  };
}

function readCuttingLanes(
  player: SimPlayer,
  awareness: AwarenessMap,
  state: GameState
): CuttingLane[] {
  if (player.hasBall) return [];  // Cuts are off-ball

  const basket = getTeamBasket(player.teamIdx);
  const lanes: CuttingLane[] = [];

  // Sample potential cut angles
  const cutAngles = [-45, -20, 0, 20, 45];

  for (const angleDeg of cutAngles) {
    const direction = rotateVector(normalize(sub(basket, player.pos)), angleDeg);
    const path = samplePath(player.pos, basket, direction, 5);

    // Measure lane width at each segment
    let minWidth = Infinity;
    const obstacles: DefenderObstacle[] = [];

    for (let i = 0; i < path.length - 1; i++) {
      const segment = { from: path[i], to: path[i + 1] };

      // Check tracked defenders
      for (const tracked of awareness.tracked) {
        if (isTeammate(tracked.playerId, player, state)) continue;
        const d = pointToLineDistance(tracked.perceivedPos, segment.from, segment.to);
        minWidth = Math.min(minWidth, d * 2);
        if (d < 5) {
          obstacles.push({
            playerId: tracked.playerId,
            position: tracked.perceivedPos,
            distToPath: d,
            canReach: true,
            isHelpDefender: !isMyDefender(tracked.playerId, player, state),
          });
        }
      }

      // Check memory for help defenders we can't see
      for (const mem of awareness.memory) {
        if (mem.confidence < 0.3) continue;
        if (isTeammate(mem.playerId, player, state)) continue;
        const d = pointToLineDistance(mem.predictedPos, segment.from, segment.to);
        if (d < 6) {
          obstacles.push({
            playerId: mem.playerId,
            position: mem.predictedPos,
            distToPath: d,
            canReach: mem.confidence > 0.5,
            isHelpDefender: true,
          });
        }
      }
    }

    if (minWidth < 2) continue;  // Lane too narrow

    lanes.push({
      path,
      entryPoint: path[0],
      exitPoint: path[path.length - 1],
      width: minWidth,
      isClosing: obstacles.some(o => isMovingTowardPath(o, path, state)),
      timeAvailable: estimateLaneLifetime(obstacles, path, state),
      obstacles,
      requiresBeatDefender: obstacles.some(o => o.distToPath < 3 && !o.isHelpDefender),
      expectedFinishEV: calcFinishEV(player, dist(path[path.length - 1], basket), obstacles.length),
      drawFoulChance: calcFoulChance(player, obstacles),
      kickOutOptions: countKickOutOptions(player, awareness, state),
    });
  }

  return lanes.sort((a, b) => b.expectedFinishEV - a.expectedFinishEV);
}
```

### Hot Spot Reads

Where on the court each player is most effective:

```typescript
interface HotSpot {
  zone: CourtZone;                // Court area definition
  offensiveValue: number;         // My shooting efficiency from here
  defensiveValue: number;         // My assignment's efficiency here (what I must guard)
  distFromCurrent: number;        // How far am I from this spot?
  isOccupied: boolean;            // Is a teammate already there?
  defenderPresence: number;       // How guarded is this spot? (0-1)
}

function readHotSpots(
  player: SimPlayer,
  awareness: AwarenessMap,
  state: GameState
): HotSpot[] {
  const zones = getCourtZones();
  // Zones: left_corner, right_corner, left_wing, right_wing,
  //        left_elbow, right_elbow, top_key, paint_left,
  //        paint_right, short_corner_left, short_corner_right, etc.

  return zones.map(zone => {
    // My offensive value here
    const myPct = getPlayerZonePct(player, zone);
    const offValue = myPct * zone.pointValue;

    // Defensive: my assignment's threat from here
    const matchup = getDefensiveAssignment(player, state);
    const defValue = matchup ? getPlayerZonePct(matchup, zone) * zone.pointValue : 0;

    // Is a teammate already occupying this spot?
    const occupied = awareness.tracked.some(t =>
      isTeammate(t.playerId, player, state) &&
      dist(t.perceivedPos, zone.center) < zone.radius
    );

    // Defender near this spot?
    const defNear = awareness.tracked.some(t =>
      !isTeammate(t.playerId, player, state) &&
      dist(t.perceivedPos, zone.center) < 6
    );

    return {
      zone,
      offensiveValue: offValue,
      defensiveValue: defValue,
      distFromCurrent: dist(player.pos, zone.center),
      isOccupied: occupied,
      defenderPresence: defNear ? 0.7 : 0.1,
    };
  }).sort((a, b) => b.offensiveValue - a.offensiveValue);
}
```

### Shooting Window Reads

```typescript
interface ShootingWindow {
  quality: number;                // 0-1: overall shot quality
  contestLevel: number;           // 0 = wide open, 1 = smothered
  isClosing: boolean;             // Is a defender closing out?
  timeToContest: number;          // Seconds before defender arrives
  optimalReleaseWindow: number;   // Seconds of good shooting window left
  shotType: 'catch_and_shoot' | 'pull_up' | 'post_fade' | 'step_back' | 'layup' | 'dunk';
}

function readShootingWindow(
  player: SimPlayer,
  awareness: AwarenessMap,
  state: GameState
): ShootingWindow {
  const basket = getTeamBasket(player.teamIdx);
  const distToBasket = dist(player.pos, basket);

  // Find closest defender in awareness
  const closestDef = awareness.tracked
    .filter(t => !isTeammate(t.playerId, player, state))
    .sort((a, b) => dist(a.perceivedPos, player.pos) - dist(b.perceivedPos, player.pos))[0];

  const defDist = closestDef ? dist(closestDef.perceivedPos, player.pos) : 20;
  const contestLevel = closestDef ? Math.max(0, 1 - defDist / 8) : 0;

  // Is defender closing out?
  const isClosing = closestDef
    ? isMovingToward(closestDef.perceivedPos, closestDef.perceivedVel, player.pos)
    : false;

  // Time before defender arrives
  const closeoutSpeed = closestDef ? magnitude(closestDef.perceivedVel) : 0;
  const timeToContest = defDist > 4
    ? (defDist - 4) / Math.max(closeoutSpeed, 8)
    : 0;

  // Quality = f(distance skill, contest, catch-and-shoot bonus)
  const distSkill = getShotSkillForDistance(player, distToBasket) / 100;
  const contestPenalty = contestLevel * 0.35;
  const catchBonus = state.dribbleTime < 0.5 && state.passCount > 0 ? 0.05 : 0;
  const quality = clamp(distSkill - contestPenalty + catchBonus, 0, 1);

  // Shot type
  const holdTime = state.dribbleTime;
  let shotType: string;
  if (distToBasket < 4) shotType = player.player.physical.vertical > 75 ? 'dunk' : 'layup';
  else if (holdTime < 0.5 && state.passCount > 0) shotType = 'catch_and_shoot';
  else if (player.isDriving) shotType = 'pull_up';
  else shotType = 'pull_up';

  return {
    quality,
    contestLevel,
    isClosing,
    timeToContest,
    optimalReleaseWindow: isClosing ? timeToContest : 2.0,
    shotType,
  };
}
```

### Screen Reads

```typescript
// For ball handler: what screens are available?
interface ScreenRead {
  screenerId: string;
  screenerPos: Vec2;
  screenAngle: number;

  // Expected outcomes
  separationExpected: number;     // How much space the screen creates
  switchLikely: boolean;          // Will defense switch? → mismatch opportunity
  trapLikely: boolean;            // Will defense trap? → need escape route

  // Options off the screen
  pullUpSpot: Vec2;               // Where to shoot coming off screen
  driveLane: CuttingLane | null;  // Drive option off screen
  rollMan: PassingLane | null;    // Pass to rolling screener
  popMan: PassingLane | null;     // Pass to popping screener
  rejectOption: CuttingLane | null; // Reject screen, go opposite
}

// For screener: how/where to set the screen?
interface ScreenSetRead {
  targetDefender: string;          // Who am I screening?
  optimalPosition: Vec2;           // Best spot for the screen
  optimalAngle: number;            // Best angle to set screen

  // After screen
  rollLane: CuttingLane | null;    // Path to basket after screen
  popSpot: HotSpot | null;        // Where to pop for jumper
  slipOpportunity: boolean;        // Can I slip early for easy bucket?
  slipLane: CuttingLane | null;    // Path if slipping
}
```

### Play Role Reads

How well the player understands what the play wants them to do:

```typescript
interface PlayRoleRead {
  // Assignment
  assignedRole: PlayRole;          // 'ballHandler' | 'screener' | 'shooter' | 'cutter' | 'spacer'
  assignedPosition: Vec2;          // Where I should be right now
  assignedAction: string;          // What to do when triggered

  // Timing
  timing: number;                  // 0-1: where we are in the play
  myTrigger: number;               // At what timing do I act?
  isMyTurn: boolean;               // Should I be acting now?

  // Read quality (BBIQ dependent)
  canSeePlayDeveloping: boolean;   // Do I have vision of the key action?
  playTimingRead: number;          // 0-1: how well I read the timing
  playMatchesReality: number;      // 0 = defense blew it up, 1 = going perfectly

  // Freelance assessment
  freelanceOpportunity: number;    // How much better would freelancing be? (utility delta)
  playBroken: boolean;             // Should we abandon the play?
}

function readPlayRole(
  player: SimPlayer,
  awareness: AwarenessMap,
  coachPlay: PlayCall,
  state: GameState
): PlayRoleRead {
  const bbiq = player.player.skills.mental.bbiq || 50;
  const sysPro = player.player.skills.mental.systemProficiency || 50;

  const myRole = coachPlay.getRole(player);
  const mySpot = coachPlay.getPosition(player, state);
  const playTiming = coachPlay.getProgress(state);

  // Can I see the key action? (e.g., can I see the PnR developing?)
  const keyAction = coachPlay.getKeyAction(state);
  const canSeeKey = keyAction
    ? awareness.tracked.some(t => t.playerId === keyAction.playerId)
    : true;

  // Timing read quality — high BBIQ + system proficiency = better timing
  const timingRead = clamp(
    (bbiq * 0.6 + sysPro * 0.4) / 100 + (state.rng() - 0.5) * 0.1,
    0.2, 1.0
  );

  // Is the play working? Check if key players are in position
  const playAccuracy = coachPlay.evaluateExecution(state);

  // Freelance assessment — what's the utility delta?
  const playUtility = estimatePlayUtility(player, coachPlay, state);
  const freelanceUtility = estimateFreelanceUtility(player, awareness, state);
  const freelanceDelta = freelanceUtility - playUtility;

  // Play broken? If execution is too low and multiple reads fail
  const playBroken = playAccuracy < 0.3 || state.shotClock < 6;

  return {
    assignedRole: myRole,
    assignedPosition: mySpot,
    assignedAction: coachPlay.getAction(player),
    timing: playTiming,
    myTrigger: coachPlay.getTriggerTiming(player),
    isMyTurn: Math.abs(playTiming - coachPlay.getTriggerTiming(player)) < 0.1,
    canSeePlayDeveloping: canSeeKey,
    playTimingRead: timingRead,
    playMatchesReality: playAccuracy,
    freelanceOpportunity: freelanceDelta,
    playBroken,
  };
}
```

### Defensive Reads

```typescript
interface MatchupRead {
  assignmentId: string;
  assignmentPos: Vec2;

  // Scouting knowledge (known pre-game + observed in-game)
  preferredHand: 'left' | 'right' | 'both';
  shootingThreat: number;          // 0-1: how dangerous from range?
  driveThreat: number;             // 0-1: how dangerous attacking rim?
  postThreat: number;              // 0-1: how dangerous in the post?
  hotZones: CourtZone[];           // Their preferred shooting spots

  // Current situation
  hasBall: boolean;
  distToBasket: number;
  isInHotSpot: boolean;            // Are they in their preferred zone?
  isCutting: boolean;
  isSettingScreen: boolean;
  isCallingForBall: boolean;

  // My positioning quality
  optimalDefPosition: Vec2;        // Where I should be
  currentGap: number;              // Distance between me and optimal position
  amBetweenManAndBasket: boolean;  // Am I in correct position?
}

interface HelpRead {
  needsHelpFor: string;            // Teammate being beaten
  rotationTarget: Vec2;            // Where to rotate to
  urgency: number;                 // 0-1: how critical?
  canRecover: boolean;             // Can I get back to my man after?
  leaveOpen: string;               // Who I'm leaving open to help
  leaveOpenThreat: number;         // How dangerous is the player I'm leaving?
}

interface TrapRead {
  targetPlayer: string;            // Ball handler to trap
  trapSpot: Vec2;                  // Where to trap
  partnerDefender: string;         // Who's trapping with me
  escapeRoutes: PassingLane[];     // Ball handler's escape options (we want to minimize these)
  rotationNeeded: string[];        // Teammates who need to rotate
}

interface CloseoutRead {
  targetPlayer: string;            // Shooter to close out on
  targetPos: Vec2;
  shootingThreat: number;          // How dangerous is this shooter?
  distToTarget: number;
  canContestInTime: boolean;       // Can I get there before they shoot?
  closeoutPath: Vec2[];            // Path to contest (avoid fouling)
  foulRisk: number;                // Probability of fouling if I close out hard
}

interface BoxOutRead {
  targetPlayer: string;            // Who to box out
  targetPos: Vec2;
  myPosition: Vec2;                // Where to establish position
  reboundAngle: number;            // Expected rebound direction
  isEstablished: boolean;          // Am I already in box-out position?
}
```

### Transition Reads

```typescript
interface TransitionLane {
  lane: Vec2[];                    // Path in transition
  advantage: number;               // Numbers advantage (e.g., 3v2 = +1)
  isOpen: boolean;                 // Clear path to basket?
  speed: 'full' | 'secondary';    // Full break vs secondary break
}

function readTransition(
  player: SimPlayer,
  awareness: AwarenessMap,
  state: GameState
): {
  fastBreakLane: TransitionLane | null;
  leakOpportunity: boolean;
  getBackUrgency: number;
} {
  const basket = getTeamBasket(player.teamIdx);

  if (player.teamIdx === state.possession) {
    // OFFENSE: look for fast break
    const defendersBack = awareness.tracked
      .filter(t => !isTeammate(t.playerId, player, state))
      .filter(t => isPastHalfCourt(t.perceivedPos, state.possession))
      .length;

    const teammatesAhead = awareness.tracked
      .filter(t => isTeammate(t.playerId, player, state))
      .filter(t => isPastHalfCourt(t.perceivedPos, state.possession))
      .length;

    // Also check memory — are defenders we can't see still back?
    const memorizedDefBack = awareness.memory
      .filter(m => !isTeammate(m.playerId, player, state) && m.confidence > 0.3)
      .filter(m => isPastHalfCourt(m.predictedPos, state.possession))
      .length;

    const totalDefBack = defendersBack + memorizedDefBack;
    const advantage = (teammatesAhead + 1) - totalDefBack;  // +1 for self

    const hasLane = advantage > 0 || totalDefBack < 3;

    return {
      fastBreakLane: hasLane ? {
        lane: [player.pos, basket],
        advantage,
        isOpen: totalDefBack < 2,
        speed: state.advanceClock < 3 ? 'full' : 'secondary',
      } : null,
      leakOpportunity: totalDefBack < 2 && dist(player.pos, basket) < 30,
      getBackUrgency: 0,
    };
  } else {
    // DEFENSE: get back urgency
    const ownBasket = getOwnBasket(player.teamIdx);
    const distToOwnBasket = dist(player.pos, ownBasket);
    const ballDist = dist(state.ball.pos, ownBasket);

    // Urgency based on ball position vs my position
    const ballCloser = ballDist < distToOwnBasket;
    const urgency = ballCloser ? 0.9 : clamp(distToOwnBasket / 50, 0.2, 0.8);

    return {
      fastBreakLane: null,
      leakOpportunity: false,
      getBackUrgency: urgency,
    };
  }
}
```

---

## BBIQ Impact Summary

Basketball IQ is the single most important attribute for vision quality:

```typescript
function getVisionQuality(player: SimPlayer): VisionQuality {
  const bbiq = player.player.skills.mental.bbiq || 50;
  const awareness = player.player.skills.mental.awareness || 50;
  const experience = player.player.skills.mental.experience || 50;

  return {
    // Layer 1: Perception
    scanFrequency: 0.5 + (awareness / 100) * 1.5,   // 0.5-2.0 Hz
    scanAmplitude: 20 + (awareness / 100) * 30,       // 20-50 degrees

    // Layer 2: Awareness
    attentionSlots: Math.floor(2 + (bbiq / 100) * 2), // 2-4 simultaneous tracks
    memoryRetention: 2 + (bbiq / 100) * 4,             // 2-6 seconds before fade
    anticipation: bbiq / 100,                           // Predict future positions

    // Layer 3: Reads
    passingLaneAccuracy: 0.5 + (bbiq / 100) * 0.4,     // Risk assessment quality
    cuttingLaneAccuracy: 0.5 + (bbiq / 100) * 0.4,
    helpRotationSpeed: 0.3 + (bbiq / 100) * 0.7,       // How fast I read help D need
    playReadAccuracy: 0.3 + (experience / 100) * 0.5,   // System understanding
    timingAccuracy: 0.4 + (bbiq / 100) * 0.4,           // Cut/screen timing

    // Decision quality
    reactionTime: 0.30 - (bbiq / 100) * 0.15,          // 0.15-0.30 seconds
    decisionNoise: 0.20 - (bbiq / 100) * 0.15,         // 0.05-0.20 utility noise

    // Deception reading
    canReadPumpFake: bbiq > 60,
    canReadNoLookPass: bbiq > 70,
    canReadBackdoorCut: bbiq > 50,
    canReadScreenSlip: bbiq > 65,
    canReadZoneRotation: bbiq > 55,
  };
}
```

### BBIQ Archetypes

| BBIQ | Attention | Memory | Reads | Behavior |
|------|-----------|--------|-------|----------|
| **30** (Low) | 2 slots | 2s decay | Noisy, inaccurate | Tunnel vision, late rotations, falls for fakes |
| **50** (Average) | 3 slots | 4s decay | Decent | Makes obvious reads, misses subtle ones |
| **70** (High) | 3 slots | 5s decay | Good | Reads help D, finds open shooters, anticipates |
| **90** (Elite) | 4 slots | 6s decay | Excellent | Sees the play 2 steps ahead, never fooled by fakes |

---

## Vision → Utility Pipeline (Complete)

```
 DECISION TICK (4x per second)
 │
 ├─ 1. UPDATE FACING DIRECTION
 │   └─ Based on role, ball position, assignment
 │
 ├─ 2. RAW PERCEPTION
 │   ├─ FOV scan: who's in my field of view?
 │   ├─ Distance + angle → confidence level
 │   ├─ Occlusion check: is my view blocked?
 │   └─ Audio cues for players behind me
 │
 ├─ 3. AWARENESS UPDATE
 │   ├─ Priority scoring: what's most important to track?
 │   ├─ Attention budget: top N entities by priority
 │   ├─ Memory update: predict positions of unseen players
 │   ├─ Overload check: am I processing too much?
 │   └─ Spatial zones: detect open/congested areas
 │
 ├─ 4. GAME READS (BBIQ-dependent quality)
 │   ├─ Passing lanes → risk + value assessment
 │   ├─ Cutting lanes → path to hoop evaluation
 │   ├─ Hot spots → where should I be?
 │   ├─ Shooting window → current shot quality
 │   ├─ Screen reads → use, set, or slip
 │   ├─ Play role → what coach wants vs what I see
 │   ├─ Defensive matchup → my assignment's threat
 │   ├─ Help defense → does teammate need rotation?
 │   ├─ Closeout targets → who to contest
 │   ├─ Box out targets → rebound positioning
 │   └─ Transition → fast break or get back
 │
 ├─ 5. READS → UTILITY CHANNELS
 │   │
 │   │  Read                    →  Utility Channel
 │   │  ─────────────────────────────────────────────
 │   │  passingLane.riskScore   →  pass utility (risk)
 │   │  passingLane.receiverEV  →  pass utility (value)
 │   │  cuttingLane.width       →  drive/cut utility
 │   │  hotSpot.offensiveValue  →  spotUp/moveToSpot utility
 │   │  shootingWindow.quality  →  shoot utility
 │   │  screenRead.separation   →  screen utility (use)
 │   │  screenSetRead.angle     →  screen utility (set)
 │   │  playRole.timing         →  moveToSpot utility
 │   │  playRole.playBroken     →  freelance boost
 │   │  matchup.hasBall         →  pressure utility
 │   │  helpRead.urgency        →  help defense utility
 │   │  closeout.canContest     →  contest utility
 │   │  boxOut.isEstablished    →  rebound position utility
 │   │  transition.advantage    →  transition utility
 │   │
 │   ├─ Personal utility (personal weights)
 │   ├─ Team utility (team weights)
 │   └─ Blend via compliance
 │
 └─ 6. EXECUTE ACTION
     └─ Highest utility action with skill-check for success/failure
```

---

## Open Questions

1. **Facing direction updates** — Should facing update every tick or only on decision ticks? Performance impact?
2. **Communication system** — Teammates calling out screens ("Screen left!"), switches, help needs. How does verbal communication expand awareness beyond FOV?
3. **Deception interaction** — Pump fakes, no-look passes, jab steps. How do these exploit the vision system? (e.g., no-look pass = defender reads passer's eyes → wrong direction)
4. **Performance budget** — 10 players × (perception + awareness + reads) × 4/sec. Need profiling and possible simplifications.
5. **Head tracking animation** — Should the vision system drive head/eye animations for visual fidelity?
6. **Learning during game** — Should the scouting report (matchup tendencies) update based on observed behavior? "He keeps going left — overplay that side"
7. **Crowd/arena effects** — Road games = louder crowd = harder to communicate = worse awareness?
8. **Fatigue impact on vision** — Tired players have slower scan frequency, shorter attention span?

---

*This document is a living design spec. Update as decisions are made.*
