# Hoopcraft Performance Budget & Optimization

> **Status:** Design Phase
> **Last Updated:** 2026-02-22
> **Authors:** Jacky, PyBot
> **Related:** [ai-architecture.md](./ai-architecture.md), [utility-system.md](./utility-system.md), [player-vision.md](./player-vision.md)

---

## Overview

Performance analysis of the proposed AI system: vision, awareness, game reads, and utility evaluation. The conclusion: **computation is not the bottleneck** — GC pressure and max-speed mode are the real concerns, both solvable with standard techniques.

---

## Tick Structure

```
Game runs at 60 ticks/sec (physics)
AI decisions at 4 ticks/sec (every 15th tick)
Render at 30-60 fps (browser requestAnimationFrame)
Max speed mode: 2000 ticks/frame (analysis only)
```

Key insight: **not every tick needs full AI**. Physics runs every tick, AI only on decision ticks.

```typescript
function tick(state: GameState) {
  state.phaseTicks++;
  state.gameTime += 1/60;

  // PHYSICS: every tick (~1,000 ops, cheap)
  updatePositions(state);
  updateBall(state);
  checkCollisions(state);

  // AI: only on decision ticks (every 15th tick)
  const isDecisionTick = state.phaseTicks % 15 === 0;
  if (isDecisionTick) {
    for (const player of state.players) {
      const perception = perceive(player, state);
      const awareness = updateAwareness(player, perception, state);
      const reads = generateReads(player, awareness, state);
      const action = evaluateUtility(player, reads, state);
      player.currentAction = action;
    }
  }

  // EXECUTE: every tick (use cached action, ~100 ops/player)
  for (const player of state.players) {
    executeAction(player, player.currentAction, state);
  }
}
```

---

## Per-Layer Cost Breakdown

### Layer 1: Raw Perception

Each player scans the other 9 players for FOV, distance, and occlusion.

```
Per player:
  FOV scan:       9 targets × (1 atan2 + 1 sqrt + comparisons) ≈ 135 ops
  Occlusion:      9 targets × 8 potential blockers × ~10 ops    ≈ 720 ops
  Position noise: 9 targets × 4 ops                             ≈ 36 ops
  ──────────────────────────────────────────────────────────────────────
  Per player total:                                              ≈ 891 ops

Total (10 players): ~8,500 ops/decision-tick
```

**Hotspot:** Occlusion raycasting (72 line-segment checks per player). Optimizable with spatial hashing.

### Layer 2: Awareness Map

Attention budget filtering, priority scoring, memory updates.

```
Per player:
  Priority scoring:     9 players × ~10 conditions             ≈ 90 ops
  Sort by priority:     9 × log₂(9)                            ≈ 30 ops
  Memory update:        ~5 unseen × (predict + decay)           ≈ 40 ops
  Spatial zone detect:  ~6 zones × 10 proximity checks          ≈ 60 ops
  ──────────────────────────────────────────────────────────────────────
  Per player total:                                             ≈ 220 ops

Total (10 players): ~2,200 ops/decision-tick
```

**Cheapest layer.** Mostly comparisons and simple arithmetic.

### Layer 3: Game Reads

The heaviest layer — interpreting awareness into actionable basketball intelligence.

```
Passing Lanes (1-2 ball handlers):
  4 teammates × 5 defenders × ~15 ops (intercept calc)         ≈ 300 ops
  + pass type selection, window calc                            ≈ 100 ops
  Per handler:                                                  ≈ 400 ops

Cutting Lanes (3-4 off-ball players):
  5 angles × 5 waypoints × ~5 defender checks × ~10 ops        ≈ 1,250 ops
  Per player: 1,250 × 4 players:                               ≈ 5,000 ops

Drive Path (1 ball handler):
  2 sides × 5 waypoints × 5 defenders × ~10 ops                ≈ 500 ops
  + kick-out analysis                                           ≈ 100 ops
  Per handler:                                                  ≈ 600 ops

Hot Spots (all 10 players):
  12 zones × (2 lookups + 3 distance checks) × 10              ≈ 600 ops

Shooting Window (1 ball handler):
  Closest defender sort + contest calc                          ≈ 50 ops

Screen Reads (2-3 involved players):
  ~150 ops per player                                           ≈ 400 ops

Play Role (all 10 players):
  ~30 ops per player                                            ≈ 300 ops

Defensive Reads (5 defenders):
  Matchup: ~20, Help: ~60, Closeout: ~30 per defender           ≈ 550 ops

Transition (all 10 players):
  ~20 ops per player                                            ≈ 200 ops
  ──────────────────────────────────────────────────────────────────────
Total:                                                          ≈ 8,100 ops/decision-tick
```

**Hotspot:** Cutting lane sampling (5,000 ops). Can be cached and only recalculated on significant state changes.

### Utility Evaluation

Scoring all actions through all value channels, applying tendencies and compliance.

```
Ball handler (1 player):
  6 actions × 17 channels × ~10 ops per channel                ≈ 1,020 ops
  + tendency multipliers (6 × 2)                                ≈ 12 ops
  + compliance blend (6 × 3)                                    ≈ 18 ops
  + noise (6 × 1)                                               ≈ 6 ops
  Per handler:                                                  ≈ 1,060 ops

Off-ball offense (4 players):
  5 actions × 17 channels × ~10 ops                             ≈ 850 ops
  4 players:                                                    ≈ 3,400 ops

Defenders (5 players):
  5 actions × 17 channels × ~10 ops                             ≈ 850 ops
  5 players:                                                    ≈ 4,250 ops
  ──────────────────────────────────────────────────────────────────────
Total:                                                          ≈ 8,700 ops/decision-tick
```

---

## Grand Total

| Layer | Ops/Decision-Tick | % of Total |
|-------|-------------------|------------|
| Raw Perception | 8,500 | 31% |
| Awareness Map | 2,200 | 8% |
| Game Reads | 8,100 | 29% |
| Utility Evaluation | 8,700 | 32% |
| **Total** | **~27,500** | 100% |

### Per-Second Cost

```
Decision ticks per second:  4
AI ops per second:          27,500 × 4 = 110,000

Physics per second:         1,000 ops × 60 ticks = 60,000
Execute per second:         100 ops × 10 players × 60 ticks = 60,000

Grand total per second:     ~230,000 ops
```

### vs CPU Capacity

```
V8 (Chrome/Node) throughput:  ~500M - 1B simple ops/sec

Our budget:                   ~230K ops/sec
CPU utilization:              0.02 - 0.05%

Even at 10x pessimistic (each "op" = 10 real JS instructions):
  2.3M actual ops/sec
  CPU utilization:            0.2 - 0.5%
```

**Verdict: Computation is trivially cheap at normal speed.**

---

## Max Speed Mode Analysis

Max speed mode runs 2000 ticks per animation frame for fast simulation (analysis, testing).

### Without Decision Tick Separation

```
If AI runs every tick:
  27,500 ops × 2000 ticks/frame = 55M ops/frame
  At 30fps: 55M × 30 = 1.65B ops/sec
  CPU utilization: 30-50%
  ⚠️ Will cause frame drops and potential freezing
```

### With Decision Tick Separation (Recommended)

```
Decision ticks per frame:   2000 / 15 = ~133
AI ops per frame:           133 × 27,500 = 3.66M
Physics per frame:          2000 × 1,000 = 2M
Execute per frame:          2000 × 10 × 100 = 2M
──────────────────────────────────────────────
Total per frame:            ~7.66M ops

At 30fps: 230M ops/sec
CPU utilization: ~5%
✅ Completely fine
```

---

## Hidden Costs

### 1. Object Allocation (GC Pressure)

**The real enemy is not computation — it's garbage collection.**

Every decision tick creates temporary objects:

```
Per decision tick:
  10 × RawPerception         = 10 objects, each containing:
    9 × PerceivedPlayer       = 90 objects
  10 × AwarenessMap           = 10 objects, each containing:
    ~4 × TrackedEntity        = 40 objects
    ~5 × PlayerMemory         = 50 objects
  10 × GameReads              = 10 objects, each containing:
    ~4 × PassingLane          = 40 objects
    ~3 × CuttingLane          = 30 objects
    assorted reads            = ~50 objects
  10 × utility score arrays   = 10 objects
  ─────────────────────────────────────────
  Total: ~340 objects per decision tick
```

**Normal speed (4 ticks/sec):** 1,360 objects/sec → V8 handles easily

**Max speed (133 decision ticks/frame × 30fps):**
```
133 × 340 = 45,220 objects/frame
× 30fps = 1.36M objects/sec
⚠️ GC pauses possible — 50-100ms stalls
```

#### Solution: Object Pooling

```typescript
class PerceptionPool {
  private pool: RawPerception[] = [];
  private index = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      this.pool.push({
        fov: 0,
        facingAngle: 0,
        visiblePlayers: new Array(9),  // Pre-allocated
        ballVisible: false,
        basketVisible: false,
      });
      // Pre-allocate PerceivedPlayer objects too
      for (let j = 0; j < 9; j++) {
        this.pool[i].visiblePlayers[j] = {
          id: '', position: {x:0,y:0}, velocity: {x:0,y:0},
          confidence: 0, lastSeen: 0, isTeammate: false,
          canSeeStance: false, canSeeEyes: false,
        };
      }
    }
  }

  acquire(playerIndex: number): RawPerception {
    return this.pool[playerIndex];  // Reuse, don't create
  }

  resetAll(): void {
    // Called once per decision tick — reset all objects
    this.index = 0;
  }
}

// Similar pools for AwarenessMap, GameReads, ActionScores
```

**With pooling:** 0 allocations per tick → no GC pressure → no stalls

### 2. Expensive Math Functions

`Math.sqrt` and `Math.atan2` are 10-20x slower than basic arithmetic:

```
Math.sqrt:  ~5ns per call
Math.atan2: ~8ns per call
Add/Sub:    ~0.3ns per call

Our usage per decision tick:
  ~200 × dist() calls (using sqrt)    = 1,000ns = 1μs
  ~100 × angleTo() calls (using atan2) = 800ns  = 0.8μs
  Total: ~1.8μs per decision tick

Budget per decision tick: 250ms / 4 = 62.5ms
Usage: 0.003%
```

**Not a problem**, but easy wins available:

#### Solution: Squared Distance for Comparisons

```typescript
// BEFORE: uses sqrt
function isWithinRange(a: Vec2, b: Vec2, range: number): boolean {
  return dist(a, b) < range;  // sqrt inside
}

// AFTER: no sqrt needed
function isWithinRange(a: Vec2, b: Vec2, range: number): boolean {
  return distSq(a, b) < range * range;  // Pure arithmetic
}

function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
```

Eliminates ~150 of 200 sqrt calls (only need exact distance for UI display and passing lane geometry).

#### Solution: Angle Lookup Table

```typescript
// Pre-compute atan2 to avoid per-call cost
const ANGLE_TABLE_SIZE = 256;
const angleTable = new Float32Array(ANGLE_TABLE_SIZE * ANGLE_TABLE_SIZE);

function initAngleTable() {
  for (let y = 0; y < ANGLE_TABLE_SIZE; y++) {
    for (let x = 0; x < ANGLE_TABLE_SIZE; x++) {
      const nx = (x / ANGLE_TABLE_SIZE) * 2 - 1;  // -1 to 1
      const ny = (y / ANGLE_TABLE_SIZE) * 2 - 1;
      angleTable[y * ANGLE_TABLE_SIZE + x] = Math.atan2(ny, nx);
    }
  }
}

function fastAngle(dx: number, dy: number): number {
  const maxDist = Math.max(Math.abs(dx), Math.abs(dy), 0.001);
  const nx = Math.floor(((dx / maxDist) + 1) * 0.5 * (ANGLE_TABLE_SIZE - 1));
  const ny = Math.floor(((dy / maxDist) + 1) * 0.5 * (ANGLE_TABLE_SIZE - 1));
  return angleTable[ny * ANGLE_TABLE_SIZE + nx];
}
```

### 3. Cache Invalidation Strategy

Not everything needs recalculating every decision tick:

```typescript
interface CachedReads {
  // Recalc EVERY decision tick (4/sec):
  shootingWindow: ShootingWindow;    // Changes with every step
  passingLanes: PassingLane[];       // Defenders move fast
  pressureLevel: number;             // Immediate threat

  // Recalc every 2nd decision tick (2/sec):
  cuttingLanes: CuttingLane[];       // Lanes shift but not that fast
  helpNeeded: HelpRead | null;       // Help situations develop
  hotSpots: HotSpot[];               // Spots don't change much

  // Recalc every 4th decision tick (1/sec):
  playRole: PlayRoleRead;            // Play progresses slowly
  matchupRead: MatchupRead;          // Matchup doesn't change mid-possession
  transitionRead: TransitionRead;    // Only relevant at possession change

  // Recalc on EVENT only:
  boxOutTarget: BoxOutRead;          // Only when shot goes up
  closeoutTarget: CloseoutRead;      // Only on pass/catch
}

function generateReads(player: SimPlayer, awareness: AwarenessMap, state: GameState): GameReads {
  const tickMod = state.phaseTicks % 60;  // 60 = 1 second of ticks

  // Always update (critical reads)
  const shootingWindow = readShootingWindow(player, awareness, state);
  const passingLanes = readPassingLanes(player, awareness, state);

  // Every 2nd decision tick
  const cuttingLanes = (tickMod % 30 === 0)
    ? readCuttingLanes(player, awareness, state)
    : player.cachedReads.cuttingLanes;

  // Every 4th decision tick
  const playRole = (tickMod % 60 === 0)
    ? readPlayRole(player, awareness, state)
    : player.cachedReads.playRole;

  // Event-driven only
  const boxOut = state.ball.isShot
    ? readBoxOut(player, awareness, state)
    : player.cachedReads.boxOutTarget;

  return { shootingWindow, passingLanes, cuttingLanes, playRole, boxOut, ... };
}
```

**Savings from tiered caching:**

```
Without caching: 8,100 ops/decision-tick
With caching:
  Always (4/sec):  ~1,050 ops (passing lanes + shooting window + pressure)
  2/sec:           ~2,750 ops (cutting lanes + help + hot spots) → amortized 1,375
  1/sec:           ~1,050 ops (play role + matchup + transition) → amortized 263
  Event:           ~250 ops (box out + closeout) → amortized ~50
  ──────────────────────────────────────────────────────────────────────
  Effective: ~2,740 ops/decision-tick (66% reduction)
```

---

## Optimization Priority Table

| Priority | Issue | Solution | Impact |
|----------|-------|----------|--------|
| **P0** | AI on every tick | Decision ticks (every 15th) | **15x** reduction in AI cost |
| **P1** | Object allocation | Object pooling | Eliminates GC pauses |
| **P2** | Redundant reads | Tiered cache invalidation | **66%** reduction in reads |
| **P3** | Unnecessary sqrt | `distSq` for comparisons | 2-3x faster distance checks |
| **P4** | Occlusion O(n²) | Spatial hash grid | Occlusion from O(n²) to O(n) |
| **P5** | Off-ball complexity | Simplified off-ball reads | 50% reduction for 8 players |
| **P6** | atan2 calls | Lookup table | 10x faster angle calc |

### Implementation Order

**Phase 1 (at launch):** P0 + P1 — decision tick separation and object pooling. These two alone make the system viable at any speed.

**Phase 2 (if needed):** P2 + P3 — tiered caching and distSq. Low-effort, high-impact.

**Phase 3 (unlikely needed):** P4 + P5 + P6 — only if profiling shows bottlenecks.

---

## Performance Targets

| Mode | Target | Current Estimate | Status |
|------|--------|-----------------|--------|
| Normal play (4 AI ticks/sec) | < 2ms/frame AI budget | ~0.07ms | ✅ 30x headroom |
| Fast forward (30x) | < 5ms/frame AI budget | ~2.1ms | ✅ Fine |
| Max speed (2000 ticks/frame) | < 16ms/frame total | ~7.7ms | ✅ Fine with P0 |
| Max speed without P0 | < 16ms/frame total | ~55ms | ❌ Needs P0 |

---

## Profiling Strategy

When the system is implemented, profile with:

```typescript
// Built-in performance tracking
const perfCounters = {
  perception: { totalMs: 0, calls: 0 },
  awareness:  { totalMs: 0, calls: 0 },
  reads:      { totalMs: 0, calls: 0 },
  utility:    { totalMs: 0, calls: 0 },
  physics:    { totalMs: 0, calls: 0 },
};

function profiledPerceive(player: SimPlayer, state: GameState): RawPerception {
  const start = performance.now();
  const result = perceive(player, state);
  perfCounters.perception.totalMs += performance.now() - start;
  perfCounters.perception.calls++;
  return result;
}

// Expose to analysis tool
(window as any).__hoopcraft_perf = perfCounters;
```

Report every 1000 ticks:
```
AI Performance (last 1000 ticks, 67 decision ticks):
  Perception:  0.42ms total  (6.3μs avg)
  Awareness:   0.18ms total  (2.7μs avg)
  Reads:       0.38ms total  (5.7μs avg)
  Utility:     0.41ms total  (6.1μs avg)
  ─────────────────────────────────────────
  AI Total:    1.39ms / 1000 ticks
  Physics:     3.20ms / 1000 ticks
  Headroom:    95.4%
```

---

## Summary

```
Q: Can we afford vision + awareness + reads + utility for 10 players at 4 decisions/sec?
A: Yes. Easily. 0.02% CPU at normal speed, ~5% at max speed.

Q: What's the real risk?
A: GC pressure from object allocation in max-speed mode.

Q: What must we do at launch?
A: Decision tick separation (P0) + object pooling (P1). Everything else is optional.

Q: Will we ever hit CPU limits?
A: Extremely unlikely with current design. 500x headroom at normal speed.
```

---

*This document is a living design spec. Update with real profiling data once implemented.*
