# Hoopcraft AI Architecture: Utility + Tendency + Compliance System

> **Status:** Design Phase
> **Last Updated:** 2026-02-22
> **Authors:** Jacky, PyBot

---

## Overview

A three-layer AI system for realistic basketball player decision-making:

1. **Coach AI** — Team-level strategy and play calling
2. **Compliance Filter** — How much each player follows vs freelances
3. **Player AI** — Individual decision-making via blended utility scoring

The goal: players that feel human — they follow plays but not like robots, have personalities, make smart (and sometimes dumb) decisions, and produce realistic team and individual statistics.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  COACH AI (Team Brain)                       │
│  Issues plays, adjusts strategy, reads game  │
└──────────────────┬──────────────────────────┘
                   │ Play Commands
                   ▼
┌─────────────────────────────────────────────┐
│  COMPLIANCE FILTER (per player)              │
│  Chemistry × System Proficiency × Selfless   │
│  → How much player follows vs freelances     │
└──────────────────┬──────────────────────────┘
                   │ Weighted blend
                   ▼
┌─────────────────────────────────────────────┐
│  PLAYER AI (Individual Brain)                │
│  Personal Utility vs Team Utility → Action   │
└─────────────────────────────────────────────┘
```

---

## Layer 1: Coach AI (Team Brain)

The Coach AI operates at the **possession level**, not per-tick. It doesn't control individual players — it calls plays and sets strategy, like a real coach.

### When the Coach Decides

- Every new possession (after score, turnover, rebound)
- After timeouts
- When score differential changes significantly (run/counter-run)
- When shot clock < 8 and no play is running
- At quarter/half transitions

### Coach Decision Output

```typescript
interface CoachDecision {
  play: PlayCall;               // "Horns 1-4 High", "PnR Left", "Motion Weak"
  tempo: 'push' | 'control' | 'slow';
  primaryOption: PlayerId;      // Who the play is designed for
  secondaryOption: PlayerId;    // Backup option
  defenseScheme: 'man' | 'zone' | 'switch' | 'trap';
  emphasis: 'paint' | 'three' | 'midrange' | 'balanced';
}
```

### Coach Intelligence Factors

- **Score differential** — Down big → push tempo, up big → slow down
- **Matchups** — Exploit mismatches (size, speed)
- **Hot/cold players** — Feed the hot hand
- **Foul trouble** — Protect players in foul trouble
- **Time/quarter** — Clutch time adjustments
- **Opponent tendencies** — Adjust defense to opponent's attack patterns

### Future Considerations

- Coach personality (aggressive vs conservative)
- Adaptive strategy (learns during game)
- Substitution patterns
- Timeout usage

---

## Layer 2: Compliance Filter

The most important layer — this is what makes players feel human instead of robotic.

### Compliance Factors

```typescript
interface ComplianceFactors {
  systemProficiency: number;  // 0-100: How well player knows the playbook
  chemistry: number;          // 0-100: Connection with teammates
  coachTrust: number;         // 0-100: Coach's trust → player's freedom
  selflessness: number;       // 0-100: Team-first vs me-first personality
  bbiq: number;               // 0-100: Basketball IQ — quality of freelancing
  mood: number;               // Dynamic: affected by game flow
}
```

### Compliance Score Calculation

```typescript
function getComplianceScore(player: Player, gameContext: Context): number {
  const base = (
    player.systemProficiency * 0.25 +
    player.chemistry * 0.20 +
    player.selflessness * 0.25 +
    player.bbiq * 0.15 +
    player.coachTrust * 0.15
  ) / 100;

  // Context modifiers
  let mod = 1.0;
  if (gameContext.scoreDiff < -15) mod *= 0.85;   // Losing big → more freelance
  if (gameContext.shotClock < 6) mod *= 0.80;      // Shot clock pressure → go solo
  if (player.isHot) mod *= 0.90;                   // Hot streak → want the ball
  if (gameContext.clutch) mod *= 0.90;              // Clutch time → stars take over
  if (gameContext.scoreDiff > 20) mod *= 1.10;      // Blowout → stay disciplined

  return clamp(base * mod, 0.10, 0.95);
  // Never 100% (not a robot)
  // Never 0% (minimum play awareness)
}
```

### How Compliance Blends Utility

```typescript
function decideAction(player, coachPlay, gameState): Action {
  const compliance = getComplianceScore(player, gameState);

  const teamScores = evaluateTeamUtility(player, coachPlay, gameState);
  const personalScores = evaluatePersonalUtility(player, gameState);

  // Blend: high compliance → team-first, low compliance → me-first
  const blended = allActions.map(action => ({
    action,
    score: compliance * teamScores[action] + (1 - compliance) * personalScores[action]
  }));

  return pickBest(blended);
}
```

### Player Archetypes (Compliance Examples)

| Archetype | Selfless | SysPro | Chemistry | BBIQ | Compliance | Behavior |
|-----------|----------|--------|-----------|------|------------|----------|
| Veteran role player | 85 | 90 | 85 | 75 | ~85% | Spots up, follows play, shoots open 3s |
| Young star | 50 | 40 | 55 | 70 | ~50% | Takes over, ignores plays when hot |
| Rookie | 60 | 25 | 35 | 55 | ~40% | Lost on offense, freelances out of confusion |
| LeBron type | 80 | 95 | 90 | 99 | ~85% normal, ~55% clutch | Runs system but takes over when it matters |
| Kobe type | 30 | 85 | 70 | 95 | ~55% | Freelances but freelances brilliantly |
| New trade acquisition | 65 | 20 | 30 | 70 | ~40% | Doesn't know system yet, defaults to ISO |

---

## Layer 3: Player AI (Individual Brain)

Each player evaluates available actions through two lenses every decision tick (4x per second):

### Available Actions

| Action | Description |
|--------|-------------|
| `shoot` | Take a shot from current position |
| `pass` | Pass to a teammate |
| `drive` | Attack the basket off the dribble |
| `postUp` | Post up in the paint |
| `screen` | Set a screen for a teammate |
| `cut` | Cut to the basket without the ball |
| `spotUp` | Move to an open spot (spacing) |
| `moveToSpot` | Go to play-assigned position |
| `isoPlay` | Create own shot (isolation) |
| `dribble` | Hold ball, read defense |

### Personal Utility (What benefits ME?)

Optimizes for individual performance metrics (PER, points, efficiency):

```typescript
function evaluatePersonalUtility(player, state): ActionScores {
  return {
    shoot: curves.shoot({
      openness: getOpenness(player, state),
      distToBasket: getDist(player.pos, basket),
      shotSkill: getShotSkillForDistance(player, distToBasket),
      hotStreak: player.isHot ? 1.3 : 1.0,
      coldStreak: player.isCold ? 0.7 : 1.0,
      recentFGA: inverseCurve(player.recentFGA),  // Shot fewer → want more
      confidence: player.confidence,
    }),

    drive: curves.drive({
      laneClear: isLaneClear(player, state),
      athleticism: player.skills.athleticism,
      distToBasket: getDist(player.pos, basket),
      foulDrawing: player.skills.drawFoul * 0.1,  // FTs boost stats
    }),

    pass: curves.pass({
      teammateOpenness: getBestTeammateOpenness(state),
      passSkill: player.skills.passing,
      assistChance: estimateAssistChance(state) * 0.5,  // Assists help PER
      // Note: personal utility for passing is LOW unless assist likely
    }),

    isoPlay: curves.iso({
      skill: player.skills.isolation,
      mismatch: detectMismatch(player, state),
      starPower: player.isSuperstar ? 0.3 : 0,
      // ISO = highest personal utility action for scorers
    }),

    screen: curves.screen({
      // Almost zero personal utility — screens don't show in box score
      value: 0.05,
    }),

    moveToSpot: curves.move({
      // Low personal utility — standing in corner doesn't score points
      value: 0.1,
    }),
  };
}
```

### Team Utility (What benefits the TEAM?)

Optimizes for team success (efficiency, play execution, +/-):

```typescript
function evaluateTeamUtility(player, coachPlay, state): ActionScores {
  const myRole = coachPlay.getRole(player);

  return {
    shoot: curves.shoot({
      openness: getOpenness(player, state),
      isDesignedShot: coachPlay.primaryShooter === player.id ? 1.5 : 0.8,
      shotQuality: estimateShotQuality(player, state),
      // Team says: only shoot GOOD shots
    }),

    pass: curves.pass({
      teammateOpenness: getBestTeammateOpenness(state),
      playProgression: doesPassAdvancePlay(player, coachPlay, state) ? 1.4 : 1.0,
      toPrimaryOption: isPrimaryOption(target, coachPlay) ? 1.3 : 1.0,
      // Team says: move the ball, find the best shot
    }),

    screen: curves.screen({
      myRole: myRole === 'screener' ? 1.5 : 0.3,
      screenAngle: getScreenQuality(player, state),
      // Team says: screens create open shots for others
    }),

    moveToSpot: curves.spacing({
      distToAssignedSpot: getDist(player.pos, myRole.targetPos),
      spacingValue: getSpacingContribution(player, state),
      // Team says: be where the play needs you
    }),

    drive: curves.drive({
      laneClear: isLaneClear(player, state),
      isDesignedAction: coachPlay.action === 'drive' && coachPlay.primaryOption === player.id,
      // Team says: only drive if the play calls for it or lane is wide open
    }),

    isoPlay: curves.iso({
      // Low team utility unless it's a designed ISO play
      isDesignedISO: coachPlay.play.type === 'isolation' && coachPlay.primaryOption === player.id,
      value: 0.1,  // Generally bad for team offense
    }),
  };
}
```

---

## Response Curves

Each utility factor maps through a response curve (not linear) to produce natural-feeling behavior.

### Curve Types

```
LINEAR:        y = mx + b
SIGMOID:       y = 1 / (1 + e^(-k(x-mid)))
EXPONENTIAL:   y = a * e^(bx)
STEP:          y = x > threshold ? high : low
QUADRATIC:     y = ax² + bx + c
LOGISTIC:      y = L / (1 + e^(-k(x-x0)))
```

### Key Curves

#### Shot Clock → Urgency

```
  1.0 |                              ●●●
      |                           ●●●
  0.5 |                      ●●●
      |               ●●●●●●
  0.1 |●●●●●●●●●●●●●
      └──────────────────────────────
       24  20  16  12   8   4   0  (shot clock seconds)
```
Type: Sigmoid, inflection at ~8 seconds

#### Defender Distance → Openness

```
  1.0 |                    ●●●●●●●●●●●
      |               ●●●●
  0.5 |          ●●●●
      |     ●●●●
  0.0 |●●●●
      └──────────────────────────────
       0   2   4   6   8  10  12+ (feet)
```
Type: Sigmoid, inflection at ~5 feet

#### Distance to Basket → Shoot Desire (varies by player type)

```
  Shaq type:                     Curry type:
  1.0 |●●●●                     1.0 |●●                    ●●●●
      |    ●●●●                     |  ●●●●            ●●●●
  0.5 |        ●●●●             0.5 |      ●●●●    ●●●●
      |            ●●●●             |          ●●●●
  0.0 |                ●●●●●●   0.0 |
      └────────────────────      └──────────────────────────
       0  5  10  15  20  25       0  5  10  15  20  25  30 (feet)
```

#### Hold Time → Dribble Desire (inverse)

```
  1.0 |●●●●●●
      |      ●●●●
  0.5 |          ●●●
      |             ●●
  0.0 |               ●●●●●●●●●
      └──────────────────────────
       0   1   2   3   4   5+ (seconds)
```
Type: Exponential decay

---

## Tendency System

Tendencies are per-player multipliers on top of utility scores. They represent play style preferences independent of skill.

### Offensive Tendencies

```typescript
interface OffensiveTendencies {
  // Shot selection (0-100)
  threePointTendency: number;     // How often attempts 3s when available
  midRangeTendency: number;       // How often pulls up from mid
  attackRimTendency: number;      // How often drives to basket
  postUpTendency: number;         // How often posts up
  pullUpJumperTendency: number;   // Off-dribble jumper frequency

  // Playmaking (0-100)
  passFirstTendency: number;      // Look to pass before shoot
  flashyPassTendency: number;     // Behind-back, no-look (turnover risk)
  alleyOopTendency: number;       // Throw lobs frequency
  pickAndRollTendency: number;    // Use screens frequency

  // Style (0-100)
  isoTendency: number;            // Preference for isolation plays
  catchAndShootTendency: number;  // Shoot immediately after catch vs create
  stepBackTendency: number;       // Use step-back moves
  euroStepTendency: number;       // Use euro-step at rim
}
```

### Defensive Tendencies

```typescript
interface DefensiveTendencies {
  stealTendency: number;          // Gamble for steals
  blockTendency: number;          // Go for blocks
  helpDefenseTendency: number;    // Leave man to help
  closeOutAggression: number;     // How hard close out on shooters
  foulProneness: number;          // Likelihood of committing fouls
}
```

### How Tendencies Modify Utility

```typescript
function applyTendencies(baseUtility: ActionScores, tendencies: Tendencies): ActionScores {
  return {
    shoot: baseUtility.shoot * tendencyMultiplier(tendencies.shotTendencyForDistance),
    pass: baseUtility.pass * tendencyMultiplier(tendencies.passFirstTendency),
    drive: baseUtility.drive * tendencyMultiplier(tendencies.attackRimTendency),
    postUp: baseUtility.postUp * tendencyMultiplier(tendencies.postUpTendency),
    iso: baseUtility.iso * tendencyMultiplier(tendencies.isoTendency),
    screen: baseUtility.screen,  // No tendency modifier — purely team utility
    moveToSpot: baseUtility.moveToSpot,  // No tendency modifier
  };
}

// Tendency 50 = neutral (1.0x), 100 = strong preference (1.5x), 0 = avoids (0.5x)
function tendencyMultiplier(tendency: number): number {
  return 0.5 + (tendency / 100) * 1.0;  // Maps 0-100 to 0.5-1.5
}
```

---

## Decision Pipeline (Full Flow)

Every decision tick (4x per second), for the ball handler:

```
1. COACH LAYER
   └→ Current play call + assignments

2. EVALUATE ALL ACTIONS
   ├→ Personal Utility scores (optimizes PER)
   └→ Team Utility scores (optimizes +/-)

3. APPLY TENDENCIES
   ├→ Personal scores × tendency multipliers
   └→ Team scores × tendency multipliers

4. COMPLIANCE BLEND
   └→ Final score = compliance × team + (1-compliance) × personal

5. NOISE + SELECTION
   ├→ Add small random noise (prevents robotic repetition)
   └→ Pick highest scoring action

6. EXECUTE
   └→ Skill check determines success/failure
```

### Off-Ball Players

Off-ball players follow the same pipeline but with different available actions:

| Action | On-Ball | Off-Ball |
|--------|---------|----------|
| shoot | ✅ | ❌ |
| pass | ✅ | ❌ |
| drive | ✅ | ❌ |
| dribble | ✅ | ❌ |
| isoPlay | ✅ | ❌ |
| cut | ❌ | ✅ |
| spotUp | ❌ | ✅ |
| screen | ❌ | ✅ |
| moveToSpot | ❌ | ✅ |
| callForBall | ❌ | ✅ |
| postPosition | ❌ | ✅ |

---

## Emergent Behaviors

This system should naturally produce:

### Realistic Team Play
- High-chemistry teams → smooth ball movement → high assist rate
- Low-chemistry teams → ISO-heavy → lower efficiency
- Well-coached teams → better shot selection → higher eFG%

### Player Personality
- Selfish star + low system proficiency = ball-dominant, low assists
- Unselfish star + high BBIQ = makes teammates better (LeBron effect)
- Veteran role player = reliable, does exactly what coach asks

### Dynamic Game Flow
- Losing team → lower compliance → more hero ball
- Hot player → team feeds them (coach adjusts + player demands ball)
- Clutch time → stars assert themselves regardless of play call
- Blowout → bench players stay disciplined, starters coast

### Chemistry Effects
- New teammates → mistimed cuts, bad passes, blown plays
- Long-tenured lineup → telepathic passing, backdoor cuts, hockey assists
- Chemistry builds over games/season (future feature)

---

## Implementation Plan

### Phase 1: Foundation
- [ ] Response curve framework (curve types, evaluation, visualization)
- [ ] Action evaluator interface
- [ ] Basic utility functions for shoot/pass/drive

### Phase 2: Personal Utility
- [ ] All personal utility functions
- [ ] Tendency system (per-player)
- [ ] Hot/cold streak tracking

### Phase 3: Team Utility
- [ ] Play role assignments
- [ ] Team utility functions
- [ ] Spacing evaluation

### Phase 4: Coach AI
- [ ] Play calling logic
- [ ] Tempo/strategy adjustment
- [ ] Situational awareness (score, time, foul trouble)

### Phase 5: Compliance Layer
- [ ] Player personality attributes
- [ ] Compliance score calculation
- [ ] Blend function (personal ↔ team)
- [ ] Dynamic mood/confidence system

### Phase 6: Off-Ball AI
- [ ] Cut/screen/spot-up decisions
- [ ] Call-for-ball logic
- [ ] Off-ball movement quality tied to BBIQ

### Phase 7: Polish & Tuning
- [ ] Debug visualizer (show utility scores in real-time)
- [ ] Statistical validation against NBA averages
- [ ] Per-player tendency profiles
- [ ] Curve tuning tools

---

## Open Questions

1. **How granular should tendencies be?** NBA 2K has 50+ per player — do we need that many?
2. **Should coach AI be configurable?** (Different coach personalities)
3. **How does chemistry build over time?** (Season simulation)
4. **Should there be a "crowd energy" factor?** (Home court advantage)
5. **How do we handle substitution logic?** (Part of coach AI?)
6. **Should plays have "reads" built in?** (If defender does X, player does Y)
7. **How much noise is right?** Too little = robotic, too much = random

---

## References & Inspiration

- **NBA 2K**: Tendency + Attribute system — data-driven, per-player shot distributions mapped from real NBA tracking data
- **Football Manager**: Slice-based (0.25s) decision system — every player decides every slice, can change mid-slice. Defense works as a unit.
- **Utility AI (Game AI Pro)**: Score all actions, pick highest. Response curves for natural feel.
- **Finite State Machines**: Simple but rigid — used in early sports games
- **Behavior Trees**: Structured but order-dependent — better for action games than sports sims
- **GOAP**: Too heavy for real-time sports sim — better for strategy/RPG

---

*This document is a living design spec. Update as decisions are made.*
