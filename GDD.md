# 🏀 Courtside Dynasty — Game Design Document

**Version:** 1.0  
**Date:** 2026-02-19  
**Platform:** iOS / Android  
**Engine:** Unity 2022 LTS (C#)  
**Genre:** Basketball Simulation / Management  

> *Football Manager depth meets Retro Bowl accessibility meets Kairosoft charm.*

---

## Table of Contents

1. [Game Overview](#1-game-overview)
2. [Match Simulation Engine](#2-match-simulation-engine)
3. [Tactical System (五行相剋)](#3-tactical-system)
4. [Player Synergy & Chemistry](#4-player-synergy--chemistry)
5. [Pick and Roll Sub-System](#5-pick-and-roll-sub-system)
6. [Player Attributes](#6-player-attributes)
7. [Traits System](#7-traits-system)
8. [Superstar Takeover](#8-superstar-takeover)
9. [Roster Management](#9-roster-management)
10. [Draft System](#10-draft-system)
11. [Trade System](#11-trade-system)
12. [Training & Development](#12-training--development)
13. [Business & Finance](#13-business--finance)
14. [Fame, Awards & Legacy](#14-fame-awards--legacy)
15. [Season Structure](#15-season-structure)
16. [Visual Style & Art](#16-visual-style--art)
17. [Tech Stack & Architecture](#17-tech-stack--architecture)
18. [Target Audience](#18-target-audience)
19. [Monetization](#19-monetization)
20. [Development Phases](#20-development-phases)
21. [Appendix: Formulas & Tables](#21-appendix-formulas--tables)

---

## 1. Game Overview

### Concept

The player takes the role of General Manager and Head Coach of a basketball franchise. They manage every aspect — roster construction, tactical schemes, in-game adjustments, scouting, drafting, trading, training, and finances — while watching games play out in a charming isometric pixel art simulation.

### Pillars

| Pillar | Description |
|--------|-------------|
| **Depth** | FM-level management: salary cap, scouting uncertainty, tactical rock-paper-scissors, player chemistry |
| **Accessibility** | One-thumb mobile UX, clean menus, optional complexity layers |
| **Charm** | Kairosoft-style pixel art, personality-rich players, emergent stories |
| **Authenticity** | Real basketball strategy — PnR reads, tactical matchups, momentum swings, takeover moments |

### Core Loop

```
Off-Season                          Regular Season                    Playoffs
┌──────────────┐    ┌──────────────────────────────────┐    ┌──────────────┐
│ Draft         │    │ Set Lineup & Tactics              │    │ Best of 7    │
│ Free Agency   │───▶│ Watch/Sim Games (82 or shortened) │───▶│ Series       │
│ Training Camp │    │ Mid-game Adjustments              │    │ Championship │
│ Trades        │    │ Trades (before deadline)          │    └──────────────┘
└──────────────┘    │ Training between games            │           │
       ▲            └──────────────────────────────────┘           │
       └──────────────────────────────────────────────────────────┘
```

---

## 2. Match Simulation Engine

### 2.1 Architecture: Logic ≠ Rendering

The simulation engine is **purely numerical**. It resolves every possession as a series of probability rolls. The rendering layer reads the result log and plays corresponding animations. This means:

- The engine can run a full game in <50ms (SIM mode)
- Animations are cosmetic — they never affect outcomes
- The same engine powers both watched games and background simulations

```csharp
// Core architecture
public class MatchEngine
{
    SimState state;         // Clock, score, possession, momentum, fouls
    ProbabilityEngine prob; // All dice rolls
    ResultLog log;          // Sequence of events for renderer
    
    public MatchResult Simulate(Team home, Team away, Tactics homeTac, Tactics awayTac)
    {
        state = new SimState(home, away);
        while (!state.IsGameOver())
        {
            Tick(); // 0.5s game-time per tick
        }
        return new MatchResult(state, log);
    }
}
```

### 2.2 Tick System

- **Tick duration:** 0.5 seconds of game time
- **Quarter:** 12 minutes = 1,440 ticks per quarter
- **Full game:** 5,760 ticks (excluding stoppages)
- **Shot clock:** 24 seconds = 48 ticks; resets to 14 on offensive rebound

Each tick, the engine evaluates the current **possession phase** and advances accordingly.

### 2.3 Possession Flow

```
┌─────────┐    ┌────────────┐    ┌─────────────┐    ┌──────────────────┐    ┌─────────┐    ┌────────┐
│ INBOUND  │───▶│ TRANSITION │───▶│ HALF_COURT   │───▶│ ACTION_SELECTION │───▶│ RESOLVE │───▶│ RESULT │
└─────────┘    └────────────┘    └─────────────┘    └──────────────────┘    └─────────┘    └────────┘
     │              │                   │                    │                    │              │
  Baseline/     Fast break          Set up           Pick play type:        Roll dice:      Score/
  Sideline      opportunity?        offense          Shot/Drive/Pass/       Hit/Miss/       Miss/
  after score   (2-4 ticks)        (4-8 ticks)      PnR/Post/ISO          TO/Foul/        Turnover/
                                                                           Block            Foul
```

**Phase Details:**

| Phase | Duration (ticks) | Description |
|-------|-----------------|-------------|
| `INBOUND` | 1-2 | Ball enters play. After made basket = baseline inbound. After dead ball = sideline. |
| `TRANSITION` | 2-6 | Fast break window. Fast Break tactic gets 4-6 ticks; others get 2-3. If fast break triggers, resolve immediately with transition bonuses. |
| `HALF_COURT` | 4-10 | Offense sets up. Duration varies by tactic (Motion uses more ticks to create openings). |
| `ACTION_SELECTION` | 1 | Engine picks play type based on tactic weights + player tendencies + shot clock. |
| `RESOLVE` | 1 | Probability roll determines outcome. |
| `RESULT` | 1-3 | Process result: score change, rebound, free throws, turnover, etc. |

### 2.4 Action Selection Weights

Each offensive tactic has different probability weights for play types:

| Play Type | Fast Break | Motion | Shoot | Inside | ISO |
|-----------|-----------|--------|-------|--------|-----|
| Spot-up 3pt | 15% | 25% | 40% | 5% | 10% |
| Mid-range | 10% | 20% | 10% | 15% | 25% |
| Drive | 25% | 15% | 10% | 10% | 30% |
| Post-up | 5% | 10% | 5% | 35% | 10% |
| Pick & Roll | 15% | 20% | 25% | 20% | 15% |
| Fast break layup | 25% | 5% | 5% | 10% | 5% |
| Catch & shoot | 5% | 5% | 5% | 5% | 5% |

### 2.5 Shot Resolution

Every shot is a probability roll:

```csharp
public ShotResult ResolveShot(Player shooter, Player defender, ShotType type, 
                                TacticMatchup matchup, SimState state)
{
    // 1. Base percentage from player stat
    float base = GetBaseShotPct(shooter, type);
    // shooting_3pt 80 → base 38%, shooting_mid 80 → base 45%, finishing 80 → base 55%
    
    // 2. Defensive contest
    float contest = GetContestModifier(defender, type);
    // Ranges from -2% (poor defender) to -15% (elite defender)
    
    // 3. Tactical matchup bonus
    float tacticMod = matchup.OffenseAdvantage; // from matrix: -15% to +15%
    
    // 4. Synergy modifier  
    float synergyMod = GetSynergyModifier(state.OffensiveSynergy);
    // 90+ synergy: +20%. <40 synergy: -15%
    
    // 5. Momentum / Takeover
    float momentumMod = state.ShooterInTakeover ? 0.10f : 0f;
    
    // 6. Fatigue
    float fatigueMod = -((100 - shooter.CurrentStamina) * 0.002f);
    // At 50 stamina: -10% penalty
    
    // 7. Clutch (last 2 min of Q4 or OT, margin ≤ 5)
    float clutchMod = state.IsClutch ? (shooter.Clutch - 50) * 0.002f : 0f;
    
    float finalPct = base + contest + tacticMod + synergyMod + momentumMod + fatigueMod + clutchMod;
    finalPct = Mathf.Clamp(finalPct, 0.05f, 0.95f); // Floor 5%, cap 95%
    
    float roll = Random.Range(0f, 1f);
    return roll < finalPct ? ShotResult.Made : ShotResult.Missed;
}
```

**Base Shot Percentages** (stat → percentage mapping):

| Stat Value | 3pt Base | Mid Base | Close/Finish Base | Free Throw Base |
|-----------|----------|----------|-------------------|-----------------|
| 99 | 45% | 55% | 70% | 95% |
| 90 | 42% | 52% | 65% | 90% |
| 80 | 38% | 48% | 58% | 85% |
| 70 | 34% | 44% | 52% | 78% |
| 60 | 30% | 40% | 46% | 72% |
| 50 | 26% | 35% | 40% | 65% |
| 40 | 22% | 30% | 34% | 58% |

**Formula:** `base_pct = floor_pct + (stat / 100) * range`

```
3pt:        floor=10%, range=35%  → base = 0.10 + (stat/100) * 0.35
Mid:        floor=18%, range=38%  → base = 0.18 + (stat/100) * 0.38
Close:      floor=20%, range=50%  → base = 0.20 + (stat/100) * 0.50
Free throw: floor=40%, range=55%  → base = 0.40 + (stat/100) * 0.55
```

### 2.6 Defensive Contest

```csharp
float GetContestModifier(Player defender, ShotType type)
{
    float defStat = type == ShotType.ThreePoint || type == ShotType.MidRange
        ? defender.PerimeterDefense
        : defender.InteriorDefense;
    
    // defStat 40 → -2%, defStat 70 → -8%, defStat 99 → -15%
    return -(0.02f + (defStat / 100f) * 0.13f);
}
```

### 2.7 Turnover Resolution

Turnovers are checked each possession during `HALF_COURT` and `RESOLVE` phases:

```csharp
float turnoverChance = BASE_TURNOVER_RATE; // 0.12 (12% per possession)

// Ball handler skill reduces
turnoverChance -= (ballHandler.BallHandling / 100f) * 0.08f;

// Press defense increases
if (defensiveTactic == DefenseTactic.Press)
    turnoverChance += 0.05f;

// Gamble defense
if (defensiveTactic == DefenseTactic.Gamble)
    turnoverChance += 0.03f;

// Low synergy increases
if (offensiveSynergy < 40)
    turnoverChance += 0.04f;

// Fatigue
turnoverChance += (100 - ballHandler.CurrentStamina) * 0.001f;

turnoverChance = Mathf.Clamp(turnoverChance, 0.03f, 0.30f);
```

**Steal attribution:** When a turnover occurs, check if it's a steal:

```csharp
float stealChance = 0.4f; // 40% of turnovers are steals
if (defensiveTactic == DefenseTactic.Gamble) stealChance = 0.65f;
if (defensiveTactic == DefenseTactic.Press) stealChance = 0.55f;

// Attribute steal to defender with highest steal rating (weighted random)
```

### 2.8 Rebounding

After a missed shot:

```csharp
float offReboundChance = 0.25f; // League average ~25% OREB rate

// Adjust by team rebounding strength
float offRebStr = OffensiveLineupAvg(p => p.Strength * 0.4f + p.Vertical * 0.3f + p.Height * 0.3f);
float defRebStr = DefensiveLineupAvg(p => p.Strength * 0.3f + p.Vertical * 0.2f + p.Height * 0.3f + p.InteriorDefense * 0.2f);

offReboundChance *= offRebStr / defRebStr;
offReboundChance = Mathf.Clamp(offReboundChance, 0.10f, 0.45f);

// Trait: box_out_king on defense → -5% OREB chance
// Trait: offensive_rebound_beast → +8% OREB chance (individual)
```

### 2.9 Foul System

- **Personal fouls:** 6 per player → foul out
- **Team fouls:** 5 per quarter → bonus free throws
- Foul probability checked on drives, post-ups, and contested shots near the rim:

```csharp
float foulChance = 0.15f; // Base 15% on drives/inside shots

// Aggressive defenders foul more
foulChance += defender.Aggression * 0.001f;

// Foul drawers get more calls
foulChance += shooter.FoulDrawing * 0.001f;

// Trait: foul_baiter → +5% foul drawing
```

### 2.10 Game Clock & Playback

| Speed | Tick Rate | 12-min Quarter | Full Game |
|-------|----------|----------------|-----------|
| 1× (Watch) | Real-time (0.5s/tick) | ~12 min | ~50 min |
| 3× | 0.167s/tick | ~4 min | ~17 min |
| 10× | 0.05s/tick | ~1.2 min | ~5 min |
| SIM | Instant | <0.01s | <0.05s |

**Mid-game controls:**
- Pause anytime
- Call timeout (7 per game, 2 in last 2 min): opens tactics/lineup screen
- Auto-timeout: AI assistant suggests timeout on runs (opponent 8-0 run)

### 2.11 Possession Counter

A typical game produces ~95-105 possessions per team. The engine targets ~100 possessions per team by calibrating transition/half-court phase durations.

---

## 3. Tactical System

### 3.1 The Five Offenses (五行攻)

| Tactic | Icon | Archetype | Style | Avg Ticks in Half-Court |
|--------|------|-----------|-------|------------------------|
| **Fast Break** | ⚡ | Showtime Lakers, Nash Suns | Push tempo, run in transition, quick shots | 3-5 |
| **Motion** | 🔄 | 2014 Spurs, Warriors | Ball movement, screens, open looks | 8-12 |
| **Shoot** | 🎯 | Morey Ball Rockets | 3pt volume, spacing, PnR-to-kick | 5-8 |
| **Inside** | 🏋️ | Shaq Lakers, Grit & Grind | Post-ups, offensive rebounds, paint scoring | 6-10 |
| **ISO** | ⭐ | Harden, KD, MJ | Star player creates, high usage | 4-7 |

### 3.2 The Five Defenses (五行守)

| Tactic | Icon | Archetype | Style |
|--------|------|-----------|-------|
| **Man-to-Man** | 🛡️ | Standard NBA | Individual assignments, balanced |
| **Zone** | 🧱 | 2-3 / 3-2 zones | Area coverage, clogs passing lanes, weak vs ball movement |
| **Press** | 🔥 | Full-court pressure | Forces turnovers in transition, exhausting |
| **Gamble** | 🎰 | Aggressive switches/steals | High risk/reward, jumps passing lanes |
| **Fortress** | 🏰 | Pack the paint | Protects rim, concedes perimeter |

### 3.3 Matchup Matrix

**Offense vs Defense — modifier applied to offensive efficiency (positive = offense advantage):**

|  | 🛡️ Man | 🧱 Zone | 🔥 Press | 🎰 Gamble | 🏰 Fortress |
|--|--------|---------|----------|-----------|-------------|
| ⚡ **Fast Break** | 0% | **+15%** | **-15%** | 0% | 0% |
| 🔄 **Motion** | **+15%** | 0% | **-15%** | 0% | 0% |
| 🎯 **Shoot** | 0% | **-15%** | 0% | 0% | **+15%** |
| 🏋️ **Inside** | 0% | 0% | **+15%** | **-12%** | **-15%** |
| ⭐ **ISO** | **+15%** | **-15%** | 0% | **+12%** | 0% |

**Reading the matrix:**
- Fast Break vs Zone: offense gets +15% efficiency → Zone can't set up against the tempo
- Inside vs Fortress: offense gets -15% → Fortress packs the paint, exactly where Inside wants to go
- ISO vs Gamble: offense gets +12% → ISO reads the over-aggressive defense and exploits

### 3.4 Counter-Play Cycle

```
        Fast Break
       /          \
    beats        loses to
     Zone ←─── Press
      │            │
    beats        beats
      │            │
    Shoot       Motion
      │            │
    beats        beats
      │            │
   Fortress    Man-to-Man
      │            │
    beats        beaten by
      │            │
    Inside ──→ ISO (beats Gamble too)
```

This creates a **dynamic metagame**: if the opponent plays Zone all game, you switch to Fast Break. They counter with Press, you go Inside. They switch to Fortress, you go Shoot. No single combination dominates.

### 3.5 Tactic Switching

- Players can set **primary** and **secondary** tactics for each half
- Mid-game: call a timeout to change tactics
- **Auto-adjust option**: AI assistant switches tactics based on matchup (togglable)
- Switching costs: 2-3 possessions of reduced synergy as players adjust

---

## 4. Player Synergy & Chemistry

### 4.1 Tactic Affinity

Each player has affinity scores (0-100) for each offensive tactic:

```csharp
public class TacticAffinity
{
    public int FastBreak;  // High for: fast guards, athletic wings
    public int Motion;     // High for: high-IQ players, good passers
    public int Shoot;      // High for: 3pt shooters, floor spacers
    public int Inside;     // High for: big men, strong rebounders
    public int ISO;        // High for: elite ball handlers, scorers
}
```

**Example Players:**

| Player Archetype | Fast | Motion | Shoot | Inside | ISO |
|-----------------|------|--------|-------|--------|-----|
| Elite PG (Nash-type) | 90 | 85 | 70 | 20 | 60 |
| 3&D Wing | 50 | 75 | 90 | 25 | 30 |
| Traditional Center | 20 | 40 | 15 | 95 | 25 |
| Star ISO Scorer | 60 | 50 | 55 | 30 | 95 |
| Versatile Forward | 65 | 70 | 65 | 60 | 55 |

### 4.2 Team Synergy Calculation

```csharp
public float CalculateTeamSynergy(Player[] lineup, OffenseTactic tactic)
{
    // 1. Weighted average of lineup affinities
    //    Starters weighted by usage/minutes
    float affinityAvg = 0f;
    float totalWeight = 0f;
    foreach (var p in lineup)
    {
        float weight = GetUsageWeight(p); // PG/Star = 1.5, role player = 0.8
        affinityAvg += p.TacticAffinity[tactic] * weight;
        totalWeight += weight;
    }
    affinityAvg /= totalWeight;
    
    // 2. Role fit bonus: do players fit the roles this tactic needs?
    float roleFit = CalculateRoleFit(lineup, tactic);
    // e.g., Shoot tactic needs at least 3 players with shooting_3pt > 65
    // Returns 0-15 bonus
    
    // 3. Chemistry bonus: teammates who've played together
    float chemistry = CalculateChemistry(lineup);
    // +1 per 10 games played together, max +10
    
    float synergy = affinityAvg + roleFit + chemistry;
    return Mathf.Clamp(synergy, 0f, 100f);
}
```

### 4.3 Synergy Effects

| Synergy Range | Label | Effect |
|--------------|-------|--------|
| 90-100 | 🔥 Elite | +20% efficiency, unlock **Special Plays**, +5 morale/game |
| 70-89 | ✅ Good | +10% efficiency, smooth execution |
| 50-69 | ➡️ Average | No modifier |
| 40-49 | ⚠️ Poor | -10% efficiency, +3% turnover rate |
| 0-39 | ❌ Terrible | -15% efficiency, +6% turnover rate, -3 morale/game |

**Special Plays** (unlocked at 90+ synergy):

| Tactic | Special Play | Effect |
|--------|-------------|--------|
| Fast Break | **Alley-Oop Fest** | 10% chance per fast break → uncontested alley-oop (85% make rate) |
| Motion | **Extra Pass** | 5% of possessions → wide-open 3 (+15% to shot) |
| Shoot | **Heat Check** | After 2 consecutive 3s, next attempt gets +10% |
| Inside | **Seal & Feed** | Post-up gets +12% when center has position |
| ISO | **Takeover Accelerator** | Momentum builds 1.5× faster |

### 4.4 Chemistry Building

Chemistry between two players increases by:
- +1 per game played together in the starting lineup
- +0.5 per game in the rotation together
- +2 for each playoff win together
- -5 for each trade rumor involving one of them
- -10 on trade (chemistry resets with new teammates)

Max chemistry between any pair: 100. Team chemistry = average of all starting 5 pairs (10 pairs).

---

## 5. Pick and Roll Sub-System

### 5.1 Overview

Pick and Roll (PnR) is the most common play in basketball. It's not a tactic — it's a **play action** that occurs within every tactic at different frequencies and styles.

### 5.2 PnR by Tactic

| Tactic | PnR Frequency | PnR Style | Description |
|--------|--------------|-----------|-------------|
| Fast Break | 15% | Speed PnR | Quick high screen in transition, screener sprints to rim |
| Motion | 20% | PnR-to-Motion | Screen triggers off-ball movement, multiple reads |
| Shoot | 25% | PnR Pop | Screener pops to 3pt line for kick-out |
| Inside | 20% | PnR Roll | Screener rolls hard to rim, lob/feed opportunity |
| ISO | 15% | High Screen | Clear-out screen, handler creates 1-on-1 space |

### 5.3 PnR Resolution Flow

```
Ball Handler initiates PnR
         │
    ┌────▼────┐
    │ SCREEN  │ ← Quality = screener.strength * 0.5 + screener.height * 0.3 + screen_iq * 0.2
    │ SET     │   (trait: brick_wall → +20 screen quality)
    └────┬────┘
         │
    ┌────▼──────────────┐
    │ DEFENSIVE REACTION │ ← AI picks based on defensive tactic + personnel
    │ (5 options)        │
    └────┬──────────────┘
         │
    ┌────▼────────────┐
    │ BALL HANDLER     │ ← Read quality = basketball_iq * 0.6 + passing * 0.2 + ball_handling * 0.2
    │ READS & DECIDES  │   (trait: elite_pnr_handler → +15 read quality)
    └────┬────────────┘
         │
    ┌────▼────┐
    │ RESOLVE │
    └─────────┘
```

### 5.4 Defensive Reactions

| Reaction | When Used | Effect |
|----------|----------|--------|
| **Fight Over** | Man-to-Man, good perimeter D | Defender goes over screen. Handler gets slight advantage but defender recovers. |
| **Switch** | Zone, versatile defenders | Switch assignments. Creates mismatch if size differential. |
| **Drop** | Fortress, rim-protecting C | Big drops to paint. Concedes mid-range pull-up. |
| **Trap** | Press, Gamble | Double-team handler. Creates open man if handler reads it. |
| **Steal Attempt** | Gamble | Defender goes under screen for steal. High risk/reward. |

### 5.5 PnR Outcome Matrix

```csharp
public PnRResult ResolvePnR(Player handler, Player screener, Player hedgeDefender,
                              Player screenerDefender, DefenseReaction reaction, 
                              PnRStyle style)
{
    float readQuality = handler.BasketballIQ * 0.6f + handler.Passing * 0.2f + handler.BallHandling * 0.2f;
    if (handler.HasTrait(Trait.ElitePnRHandler)) readQuality += 15f;
    
    float screenQuality = screener.Strength * 0.5f + screener.Height * 0.3f + screener.OffensiveIQ * 0.2f;
    if (screener.HasTrait(Trait.BrickWall)) screenQuality += 20f;

    switch (reaction)
    {
        case DefenseReaction.FightOver:
            // Handler pull-up or drive
            if (readQuality > 70)
                return PnRResult.HandlerOpenMidRange; // pull-up J
            else
                return PnRResult.ContestedShot;
                
        case DefenseReaction.Switch:
            // Check for mismatch
            float sizeDiff = Mathf.Abs(handler.Height - screenerDefender.Height);
            if (sizeDiff > 15 && handler.Height < screenerDefender.Height)
                return PnRResult.HandlerExploitsMismatch; // small on big
            else if (sizeDiff > 15)
                return PnRResult.ScreenerPostMismatch; // big on small
            else
                return PnRResult.NeutralSwitch;
                
        case DefenseReaction.Drop:
            // Mid-range is open
            if (handler.ShootingMid > 65)
                return PnRResult.HandlerOpenMidRange;
            else
                return PnRResult.HandlerDrive; // attacks the drop
                
        case DefenseReaction.Trap:
            if (readQuality > 75)
            {
                // Great read → finds open man
                if (style == PnRStyle.Pop && screener.Shooting3pt > 60)
                    return PnRResult.ScreenerOpenThree;
                else if (screener.HasTrait(Trait.ShortRollPasser))
                    return PnRResult.ShortRollToOpenMan;
                else
                    return PnRResult.RollManOpen;
            }
            else
                return PnRResult.Turnover; // trapped, bad read
                
        case DefenseReaction.StealAttempt:
            float stealChance = hedgeDefender.Steal * 0.01f;
            if (Random.Range(0f,1f) < stealChance)
                return PnRResult.Stolen;
            else
                return PnRResult.HandlerWideOpen; // gamble failed
    }
}
```

### 5.6 Roll vs Pop Decision

```csharp
bool ShouldPop(Player screener, PnRStyle style)
{
    if (style == PnRStyle.Pop) return true;
    if (style == PnRStyle.Roll) return false;
    
    // For neutral styles, decide by screener stats
    float popScore = screener.Shooting3pt * 0.6f + screener.ShootingMid * 0.4f;
    float rollScore = screener.Finishing * 0.5f + screener.Vertical * 0.3f + screener.Strength * 0.2f;
    
    if (screener.HasTrait(Trait.PopShooter)) popScore += 20f;
    if (screener.HasTrait(Trait.LobThreat)) rollScore += 20f;
    
    return popScore > rollScore;
}
```

### 5.7 PnR-Specific Traits

| Trait | Who | Effect |
|-------|-----|--------|
| `elite_pnr_handler` | Ball Handler | +15 read quality, better passing out of traps |
| `lob_thrower` | Ball Handler | Can throw lobs to rolling screener (requires `lob_threat` on screener) |
| `brick_wall` | Screener | +20 screen quality, defenders take 1 extra tick to recover |
| `pop_shooter` | Screener | +10% on 3pt shots off PnR pop |
| `lob_threat` | Screener | Eligible for alley-oop finishes off PnR roll |
| `short_roll_passer` | Screener | Can catch in short roll area and make reads to cutters |

---

## 6. Player Attributes

### 6.1 Attribute Categories

**25 total attributes**, rated 25-99.

#### Physical (6)

| Attribute | Abbr | Description | Affects |
|-----------|------|-------------|---------|
| `speed` | SPD | Straight-line speed | Fast break, transition, blowby |
| `acceleration` | ACC | Burst quickness | First step, defensive recovery |
| `strength` | STR | Physical power | Post defense, screen quality, rebounding |
| `vertical` | VER | Jumping ability | Blocks, dunks, rebounds, alley-oops |
| `stamina` | STA | Endurance | Fatigue rate, minutes capacity |
| `height` | HGT | Height in cm (170-220) | Rebounding, blocks, contest, mismatches |

> **Height** is special: it's generated at player creation and doesn't change. Stored as cm. Converted to a 25-99 scale for calculations: `heightRating = (height_cm - 170) / 50 * 74 + 25`.

#### Offense (8)

| Attribute | Abbr | Description |
|-----------|------|-------------|
| `shooting_close` | SCL | Layups, floaters, close-range |
| `shooting_mid` | SMD | Mid-range jump shots |
| `shooting_3pt` | S3P | Three-point shooting |
| `free_throw` | SFT | Free throw accuracy |
| `finishing` | FIN | Dunks, contested finishes at rim |
| `ball_handling` | BHD | Dribbling, reducing turnovers |
| `passing` | PAS | Pass accuracy, assist creation |
| `offensive_iq` | OIQ | Play selection, off-ball movement, reading defense |

#### Defense (5)

| Attribute | Abbr | Description |
|-----------|------|-------------|
| `perimeter_defense` | PDf | On-ball D vs guards/wings |
| `interior_defense` | IDf | Post defense, paint protection |
| `steal` | STL | Active hands, passing lane reads |
| `block` | BLK | Shot-blocking ability |
| `defensive_iq` | DIQ | Help defense, rotations, positioning |

#### Intangibles (6)

| Attribute | Abbr | Description |
|-----------|------|-------------|
| `clutch` | CLT | Performance in high-pressure moments |
| `consistency` | CON | Variance in game-to-game performance |
| `aggression` | AGG | Tendency to attack/gamble (double-edged) |
| `foul_drawing` | FDR | Ability to draw fouls |
| `leadership` | LDR | Morale boost to teammates, locker room presence |

### 6.2 Overall Rating Calculation

```csharp
// Position-weighted overall
public int CalculateOverall(Player p)
{
    float[] weights = GetPositionWeights(p.Position);
    // PG weights: ball_handling=1.2, passing=1.1, speed=1.0, shooting_3pt=0.9, perimeter_defense=0.8...
    // C weights: interior_defense=1.2, strength=1.1, height=1.0, rebounding(derived)=1.0, finishing=0.9...
    
    float weightedSum = 0f;
    float totalWeight = 0f;
    for (int i = 0; i < NUM_ATTRIBUTES; i++)
    {
        weightedSum += p.Attributes[i] * weights[i];
        totalWeight += weights[i];
    }
    return Mathf.RoundToInt(weightedSum / totalWeight);
}
```

**Position weight profiles:**

| Attribute | PG | SG | SF | PF | C |
|-----------|-----|-----|-----|-----|-----|
| speed | 1.0 | 0.9 | 0.8 | 0.6 | 0.4 |
| strength | 0.4 | 0.5 | 0.7 | 0.9 | 1.0 |
| shooting_3pt | 0.9 | 1.1 | 0.8 | 0.6 | 0.3 |
| finishing | 0.5 | 0.6 | 0.7 | 0.9 | 1.1 |
| ball_handling | 1.2 | 0.9 | 0.6 | 0.4 | 0.2 |
| passing | 1.1 | 0.7 | 0.7 | 0.6 | 0.5 |
| perimeter_defense | 0.9 | 1.0 | 0.9 | 0.6 | 0.3 |
| interior_defense | 0.2 | 0.3 | 0.5 | 0.9 | 1.2 |
| block | 0.2 | 0.3 | 0.5 | 0.8 | 1.1 |

### 6.3 Stat Ranges by Player Tier

| Tier | Overall | Example | Top Stat | Lowest Stat |
|------|---------|---------|----------|-------------|
| Superstar | 90-99 | LeBron, Curry | 95-99 | 45-60 |
| All-Star | 82-89 | Jimmy Butler | 85-92 | 40-55 |
| Starter | 72-81 | Solid starter | 78-85 | 35-50 |
| Rotation | 62-71 | 6th-8th man | 70-80 | 30-45 |
| Bench | 50-61 | End of bench | 60-72 | 25-40 |
| G-League | 35-49 | Barely roster | 50-65 | 25-35 |

---

## 7. Traits System

### 7.1 Overview

Traits are binary abilities that modify specific game situations. Each player can have 0-4 traits. Traits are either innate (generated at creation) or earned through development.

### 7.2 Offensive Traits

| Trait | ID | Effect | Requirement |
|-------|----|--------|-------------|
| **Catch & Shoot** | `catch_and_shoot` | +8% on catch-and-shoot 3s (no dribbles) | shooting_3pt ≥ 70 |
| **Pull-Up Shooter** | `pull_up_shooter` | +6% on pull-up jumpers off the dribble | shooting_mid ≥ 72, ball_handling ≥ 65 |
| **Ankle Breaker** | `ankle_breaker` | 8% chance on ISO drives to freeze defender (+20% to finish) | ball_handling ≥ 85 |
| **Lob Finisher** | `lob_finisher` | Can receive alley-oops, +10% on lob finishes | vertical ≥ 80, finishing ≥ 70 |
| **Post Spinner** | `post_spinner` | +12% on post moves, creates space | strength ≥ 75, offensive_iq ≥ 70 |
| **Foul Baiter** | `foul_baiter` | +5% foul drawing rate, refs less likely to call non-shooting fouls on defense | foul_drawing ≥ 80 |
| **Takeover Gene** | `takeover_gene` | Takeover threshold lowered to momentum 70 (from 80) | clutch ≥ 80 |
| **Fast Break King** | `fast_break_king` | +15% efficiency in transition, 10% chance for highlight dunk | speed ≥ 82, finishing ≥ 75 |

### 7.3 Defensive Traits

| Trait | ID | Effect | Requirement |
|-------|----|--------|-------------|
| **Rim Protector** | `rim_protector` | +10% block chance, -8% opponent FG% at rim in paint | block ≥ 80, interior_defense ≥ 78 |
| **Chase-Down Block** | `chase_down_block` | 5% chance to block fast break layups from behind | speed ≥ 78, block ≥ 70 |
| **Lockdown** | `lockdown` | When guarding a player, -5% to all their shots | perimeter_defense ≥ 85 |
| **Passing Lane Thief** | `passing_lane_thief` | +20% steal chance from passing lanes (not on-ball) | steal ≥ 80, defensive_iq ≥ 75 |
| **Box-Out King** | `box_out_king` | -5% opponent OREB% when this player is on court | strength ≥ 78, interior_defense ≥ 70 |
| **Offensive Rebound Beast** | `offensive_rebound_beast` | +8% personal OREB chance, +3% team OREB | strength ≥ 80, vertical ≥ 75, aggression ≥ 70 |

### 7.4 Mental Traits

| Trait | ID | Effect |
|-------|----|--------|
| **Hot Hand** | `hot_hand` | After 2 consecutive makes, +8% on next shot (stacks once to +12%) |
| **Cold Streak** | `cold_streak` | After 3 consecutive misses, -6% on next shot (negative trait) |
| **Big Game Player** | `big_game_player` | +10% to all stats in playoffs |
| **Frontrunner** | `frontrunner` | +8% when leading by 10+, -5% when trailing by 10+ |

### 7.5 Trait Acquisition

- **At creation:** Prospects generated with 0-3 traits based on their stats meeting requirements
- **Development:** Players with stats exceeding trait requirements for 2+ consecutive seasons have a 25% chance per off-season to learn that trait
- **Max traits:** 4 (if a player would gain a 5th, they can't — creates interesting roster decisions)

---

## 8. Superstar Takeover

### 8.1 Momentum System

Every player tracks individual **momentum** (0-100), starting at 50 each game.

```csharp
// Momentum changes per event
MomentumDelta = {
    MadeShot        = +8,
    Made3Pointer    = +12,
    MadeDunk        = +15,
    MadeAndOne      = +18,
    Assist          = +6,
    Steal           = +10,
    Block           = +10,
    MissedShot      = -5,
    Turnover        = -12,
    GotBlocked      = -8,
    Fouled          = -3,
    OpponentRun     = -2 per point in opponent run,
    TimeOnBench     = -3 per minute
};
```

Momentum decays naturally: **-1 per 24 ticks** (12 seconds) of no events.

### 8.2 Takeover Activation

```csharp
bool CanActivateTakeover(Player p)
{
    int threshold = p.HasTrait(Trait.TakeoverGene) ? 70 : 80;
    return p.Momentum >= threshold && p.Clutch >= 75;
}
```

### 8.3 Takeover Effects

When active:
- **Shooting:** +10% to all shot types
- **Ball demand:** Player's usage rate increases by 30% (engine routes more plays to them)
- **ISO tendency:** Play selection shifts toward ISO regardless of team tactic
- **Teammates defer:** Other players' assist rate to takeover player +15%
- **Visual:** Player sprite glows, fire trail on movement, crowd noise intensifies

### 8.4 Takeover Deactivation

```csharp
// Deactivates when:
// - 2 consecutive missed shots
// - Turnover
// - Foul out (obviously)
// - Half-time reset (momentum drops to 60 if was in takeover)

void CheckTakeoverEnd(Player p, GameEvent evt)
{
    if (evt == GameEvent.Miss) p.ConsecutiveMisses++;
    else p.ConsecutiveMisses = 0;
    
    if (p.ConsecutiveMisses >= 2 || evt == GameEvent.Turnover)
    {
        p.TakeoverActive = false;
        p.Momentum = 50; // Reset to neutral
    }
}
```

### 8.5 Emergent Moments

The system naturally creates:
- **"Kobe 81"**: Elite scorer with takeover_gene + hot_hand stays in takeover for extended stretches
- **"LeBron Game 6"**: Big_game_player in playoffs with high clutch can sustain takeover through crucial moments
- **"Heat Check"**: Player in takeover takes increasingly difficult shots — they might hit or deactivate spectacularly

---

## 9. Roster Management

### 9.1 Roster Structure

| Slot | Count | Description |
|------|-------|-------------|
| Starting 5 | 5 | Main lineup |
| Rotation | 3-5 | Regular substitutes |
| Bench | 2-4 | Emergency / development |
| **Total** | **12** | Max roster size |

### 9.2 Rotation Settings

```csharp
public class RotationSettings
{
    // Minutes per game target for each player (must total ~240)
    public Dictionary<Player, int> TargetMinutes;
    
    // Substitution patterns
    public SubPattern[] Patterns; 
    // e.g., "Sub PG at 6:00 Q1", "Small ball lineup in Q4"
    
    // Auto-sub rules
    public bool AutoSubOnFatigue;   // Sub when stamina < 30
    public bool AutoSubOnFouls;     // Sub on 4th foul before Q4
}
```

### 9.3 Stamina & Fatigue

```csharp
// Stamina drain per tick
float drainPerTick = 0.03f; // Base: ~3.6 per minute
drainPerTick *= (100f / player.Stamina); // Low stamina stat → drains faster
if (defensiveTactic == DefenseTactic.Press) drainPerTick *= 1.3f; // Press is exhausting

// Recovery on bench
float recoveryPerTick = 0.08f; // ~9.6 per minute on bench
```

A player with 80 stamina can play ~34 minutes before hitting critical fatigue (<30 stamina = -15% all stats).

### 9.4 Player Contracts

```csharp
public class Contract
{
    public int SalaryPerYear;    // In thousands (e.g., 25000 = $25M)
    public int YearsRemaining;   // 1-5
    public bool PlayerOption;    // Player can opt out
    public bool TeamOption;      // Team can decline final year
    public int NoTradeClause;    // 0=none, 1=partial (veto list), 2=full
}
```

### 9.5 Morale System

Each player has **morale** (0-100, starts at 70):

| Event | Morale Change |
|-------|--------------|
| Win | +2 |
| Loss | -1 |
| Win streak (3+) | +1 per game extra |
| Lose streak (3+) | -2 per game extra |
| Playing time meets expectation | +1/game |
| Playing time below expectation | -3/game |
| Star role, getting touches | +2/game |
| Benched unexpectedly | -10 |
| Team makes playoff | +10 |
| Trade rumor | -5 |
| New max contract | +15 |
| Asked to take pay cut | -8 |

**Morale effects:**

| Morale | Effect |
|--------|--------|
| 90-100 | +5% all stats, positive locker room presence |
| 70-89 | Normal |
| 50-69 | -3% all stats, occasional public complaints |
| 30-49 | -8% all stats, demands trade |
| 0-29 | -15% all stats, refuses to play hard, toxic locker room |

**Leadership** stat: high-leadership players provide a morale buffer — nearby teammates' morale can't drop below `leadership / 3` (e.g., leadership 90 → floor of 30).

---

## 10. Draft System

### 10.1 Draft Structure

- **2 rounds**, 30 picks each (30 teams)
- Draft order: reverse standings (lottery for non-playoff teams)
- **Draft lottery:** Bottom 3 teams have 14%, 14%, 14% chance at #1 pick. Remaining odds distributed.

### 10.2 Prospect Generation

```csharp
public Player GenerateProspect(int draftClass)
{
    // 1. Determine tier
    float tierRoll = Random.Range(0f, 1f);
    ProspectTier tier;
    if (tierRoll < 0.03f) tier = ProspectTier.Generational;  // 3%
    else if (tierRoll < 0.12f) tier = ProspectTier.Elite;     // 9%
    else if (tierRoll < 0.30f) tier = ProspectTier.Lottery;   // 18%
    else if (tierRoll < 0.55f) tier = ProspectTier.FirstRound; // 25%
    else if (tierRoll < 0.80f) tier = ProspectTier.SecondRound;// 25%
    else tier = ProspectTier.Undrafted;                        // 20%
    
    // 2. Generate base stats by tier
    int baseOverall = tier switch {
        ProspectTier.Generational => Random.Range(78, 85),
        ProspectTier.Elite        => Random.Range(72, 79),
        ProspectTier.Lottery      => Random.Range(65, 73),
        ProspectTier.FirstRound   => Random.Range(58, 66),
        ProspectTier.SecondRound  => Random.Range(50, 59),
        ProspectTier.Undrafted    => Random.Range(40, 51),
    };
    
    // 3. Generate potential (ceiling)
    int potential = baseOverall + tier switch {
        ProspectTier.Generational => Random.Range(12, 20),
        ProspectTier.Elite        => Random.Range(10, 18),
        ProspectTier.Lottery      => Random.Range(8, 16),
        ProspectTier.FirstRound   => Random.Range(5, 13),
        ProspectTier.SecondRound  => Random.Range(3, 10),
        ProspectTier.Undrafted    => Random.Range(1, 8),
    };
    potential = Mathf.Min(potential, 99);
    
    // 4. Age: 19-22
    int age = Random.Range(19, 23);
    
    // 5. Generate position, name, attributes (distributed around baseOverall with variance)
    // 6. Generate 0-3 traits based on stat profile
    // 7. Generate tactic affinities based on attribute profile
}
```

### 10.3 Scouting

- **Scout staff:** 1-3 scouts (hireable)
- **Scouting actions per month:** 4 per scout
- Each scout action reveals more info about a prospect:

| Scout Level | Information Revealed |
|------------|---------------------|
| 0 (unscouted) | Name, position, height, projected round |
| 1 (1 action) | 3 random attributes (exact values ±8), scout grade (A+ to D) |
| 2 (2 actions) | All physical attributes (±5), 3 offensive attributes (±5) |
| 3 (3 actions) | All attributes (±3), traits revealed, potential range (±8) |
| 4 (4 actions) | All attributes (±1), potential (±3), personality/morale tendencies |

**Scout grade accuracy:** Scouts have a `scouting_accuracy` attribute (60-95). Lower accuracy = wider error margins on all revealed stats.

### 10.4 Draft Night UI

- Prospect cards with pixel art portraits
- Radar chart showing revealed stats
- Scout report text with personality notes
- "Big board" ranking
- Trade picks on draft night (pick swaps, future picks)

---

## 11. Trade System

### 11.1 Trade Valuation

```csharp
public float CalculateTradeValue(Player p)
{
    float value = 0f;
    
    // Base value from overall
    value += p.Overall * 2.0f; // 80 OVR = 160 base
    
    // Age curve (peak at 27)
    float ageFactor = 1.0f - Mathf.Abs(p.Age - 27) * 0.06f;
    ageFactor = Mathf.Clamp(ageFactor, 0.3f, 1.1f);
    value *= ageFactor;
    
    // Potential bonus for young players
    if (p.Age <= 23)
        value += (p.Potential - p.Overall) * 1.5f;
    
    // Contract value (negative for overpaid, positive for underpaid)
    float fairSalary = GetFairSalary(p.Overall);
    float contractDelta = fairSalary - p.Contract.SalaryPerYear;
    value += contractDelta * 0.01f * p.Contract.YearsRemaining;
    
    // Star premium
    if (p.Overall >= 88) value *= 1.5f; // Stars are extra valuable
    
    return value;
}
```

### 11.2 AI Trade Logic

AI teams will:
- **Accept** trades where they receive ≥95% of value they send out
- **Counter-offer** when value gap is 80-94%
- **Reject** when value gap is <80%
- **Prioritize** positional needs (team missing a center values centers more)
- **Salary match** within 125% rule (can't receive >125% of salary sent out)
- **Protect** franchise players (won't trade 90+ OVR player unless rebuilding)

### 11.3 Trade Types

| Type | Description |
|------|-------------|
| Player for player | Direct swap |
| Player for picks | Sell high on aging star |
| Pick for pick | Move up/down in draft |
| 3-team trade | Complex deals (rare, AI-initiated) |
| Salary dump | Attach pick to move bad contract |

### 11.4 Trade Deadline

- Occurs at game 55 of 82 (approximately 2/3 through season)
- Flurry of AI trade activity in final 5 games before deadline
- Buyout market after deadline (released players can sign with any team for minimum)

---

## 12. Training & Development

### 12.1 Training System

Between games, allocate training focus:

| Focus Area | Attributes Trained | Sessions/Week |
|-----------|-------------------|---------------|
| Shooting | shooting_close, shooting_mid, shooting_3pt, free_throw | 3 |
| Ball Skills | ball_handling, passing, offensive_iq | 3 |
| Defense | perimeter_defense, interior_defense, steal, block, defensive_iq | 3 |
| Physical | speed, acceleration, strength, vertical, stamina | 2 |
| Scrimmage | All attributes (minor gains), +chemistry | 2 |

### 12.2 Training Gains

```csharp
float CalculateTrainingGain(Player p, AttributeType attr, TrainingFocus focus)
{
    float baseGain = 0.15f; // Per session
    
    // Age modifier
    float ageMod = p.Age switch {
        <= 22 => 1.5f,   // Young players grow fast
        <= 25 => 1.2f,   // Prime development
        <= 28 => 1.0f,   // Peak years
        <= 31 => 0.6f,   // Declining development
        <= 34 => 0.3f,   // Minimal gains
        _     => 0.1f,   // Veteran
    };
    
    // Diminishing returns: harder to improve high stats
    float dimReturns = 1.0f - (p.GetAttribute(attr) / 100f) * 0.7f;
    // Stat at 90 → 0.37 multiplier. Stat at 50 → 0.65 multiplier.
    
    // Potential ceiling
    if (p.GetAttribute(attr) >= p.Potential)
        dimReturns *= 0.1f; // Almost impossible to exceed potential
    
    return baseGain * ageMod * dimReturns;
}
```

### 12.3 Off-Season Training Camp

- 8 weeks of intensive training (3 sessions/week = 24 sessions)
- Can focus on 2 areas per player
- Young players (≤23) gain ~2-5 overall points per off-season
- Peak players (24-30) gain ~0-2 points
- Veterans (31+) typically decline 1-3 points per season

### 12.4 Natural Development & Decline

```csharp
void ApplySeasonalDevelopment(Player p)
{
    if (p.Age <= 25)
    {
        // Growth toward potential
        float growthRate = (p.Potential - p.Overall) * 0.15f;
        // Randomly distribute growth across attributes
        DistributeGrowth(p, growthRate);
    }
    else if (p.Age >= 30)
    {
        // Decline
        float declineRate = (p.Age - 29) * 0.8f; // 30→0.8, 35→4.8
        // Physical stats decline first, then shooting
        ApplyDecline(p, declineRate);
    }
    
    // Age up
    p.Age++;
}
```

### 12.5 Decline Priority

Physical stats decline first, IQ declines last:
1. `speed`, `acceleration`, `vertical` (first to go)
2. `stamina`, `strength`
3. `shooting_close`, `finishing`
4. `perimeter_defense`
5. `shooting_mid`, `shooting_3pt` (shooters age gracefully)
6. `offensive_iq`, `defensive_iq`, `passing` (last to decline)

---

## 13. Business & Finance

### 13.1 Revenue Streams

| Source | Base Revenue/Season | Modifier |
|--------|-------------------|----------|
| **Ticket Sales** | $30M | ×(wins/41) × stadium_capacity_pct |
| **Merchandise** | $10M | ×(1 + star_power/100) |
| **Sponsorships** | $15M | ×(market_size) × (1 + wins/82) |
| **TV Revenue** | $25M | Fixed (shared league revenue) |
| **Playoffs** | $5M/round | Only if you make playoffs |

### 13.2 Expenses

| Expense | Amount |
|---------|--------|
| **Player Salaries** | Sum of all contracts |
| **Staff Salaries** | $5-15M (coaches, scouts, trainers) |
| **Stadium Operations** | $10-20M (based on upgrades) |
| **Luxury Tax** | 150% of salary over cap |

### 13.3 Salary Cap

- **Salary Cap:** $120M
- **Luxury Tax Line:** $140M
- **Hard Cap (apron):** $160M (cannot exceed)
- **Minimum Salary:** $1M
- **Maximum Salary:** $40M (35% of cap)
- **Rookie Scale:** Predetermined salaries based on draft position

| Pick | Year 1 Salary | Year 2 | Year 3 | Year 4 (Team Option) |
|------|--------------|--------|--------|---------------------|
| #1 | $8M | $8.5M | $9M | $9.5M |
| #5 | $5M | $5.3M | $5.6M | $6M |
| #10 | $3.5M | $3.7M | $3.9M | $4.1M |
| #15 | $2.5M | $2.6M | $2.8M | $3M |
| #30 | $1.5M | $1.6M | $1.7M | $1.8M |
| 2nd rd | $1M | $1.1M | — | — |

### 13.4 Stadium Upgrades

| Upgrade | Cost | Effect |
|---------|------|--------|
| Seating Expansion (3 levels) | $20M/$40M/$80M | +20%/+40%/+60% ticket revenue |
| Luxury Boxes | $30M | +$5M sponsorship revenue |
| Training Facility | $25M | +10% training gains |
| Medical Center | $15M | -30% injury duration |
| Fan Experience | $10M | +15% merchandise revenue |
| Jumbotron | $5M | +5% ticket revenue, morale +2 for home games |

### 13.5 Star Power

```csharp
float teamStarPower = lineup.Sum(p => {
    if (p.Overall >= 90) return 30f;
    if (p.Overall >= 85) return 15f;
    if (p.Overall >= 80) return 8f;
    return 2f;
});
// Affects merchandise sales and market appeal
```

---

## 14. Fame, Awards & Legacy

### 14.1 Awards

| Award | Criteria |
|-------|----------|
| **MVP** | Highest: (PPG×2 + APG×1.5 + RPG×1.2 + SPG×2 + BPG×2) × team_wins/82 |
| **DPOY** | Highest: (SPG×3 + BPG×3 + DWS×2) × team_defensive_rating_rank |
| **ROY** | Highest overall stat line among 1st/2nd year players |
| **6MOY** | Best non-starter by PPG + efficiency |
| **MIP** | Largest overall rating increase year-over-year |
| **All-Star** (10 per conf) | Fan vote (40%) + player vote (30%) + media (30%) → top performers + market size |
| **All-NBA** (3 teams) | Top 15 players by season performance |
| **All-Defensive** (2 teams) | Top 10 defenders |

### 14.2 Career Tracking

Track for every player across all seasons:
- Games played, minutes, all counting stats
- Per-game averages, per-36 averages
- Advanced: PER, Win Shares, True Shooting %
- Awards won, All-Star selections
- Playoff stats separately

### 14.3 Hall of Fame

Players become eligible 3 seasons after retirement. Hall of Fame score:

```csharp
float hofScore = 
    allStarSelections * 10 +
    mvpAwards * 25 +
    championshipsWon * 15 +
    allNBATeams * 8 +
    careerPointsPerGame * 2 +
    seasonsPlayed * 2 +
    (peakOverall >= 90 ? 15 : 0);

// Inducted if hofScore >= 80
```

### 14.4 Legacy Rating

Players get a **legacy tier** visible in their profile:

| Tier | Score | Label |
|------|-------|-------|
| 🐐 GOAT | 200+ | All-time great |
| 🏆 Legend | 150-199 | Hall of Fame lock |
| ⭐ Star | 100-149 | All-Star career |
| 👍 Solid | 60-99 | Good career |
| 📋 Journeyman | 30-59 | Serviceable |
| 🔚 Forgettable | <30 | Barely remembered |

---

## 15. Season Structure

### 15.1 Calendar

| Phase | Duration (in-game) | Activities |
|-------|-------------------|------------|
| **Pre-Season** | 2 weeks | Training camp, set rotation, exhibition games |
| **Regular Season** | 82 games (or 40-game short option) | Games every 1-2 days, training between |
| **Trade Deadline** | Game 55 | Last day for trades |
| **All-Star Break** | Game 41 | All-Star game (simulated showcase) |
| **Playoffs** | 4 rounds × best-of-7 | 16 teams, seeded 1-8 per conference |
| **Draft Lottery** | Post-season | Determine draft order |
| **Draft** | 2 rounds | Pick prospects |
| **Free Agency** | 3 weeks | Sign available players |
| **Off-Season Training** | 8 weeks | Training camp, development |

### 15.2 Shortened Season Option

For faster play: 40-game season with proportionally adjusted stats. Same playoff format. Ideal for mobile sessions.

### 15.3 Playoffs

```
Conference Bracket (1v8, 2v7, 3v6, 4v5):

Round 1 (Best of 7) → Conference Semis (Bo7) → Conference Finals (Bo7) → Finals (Bo7)

Home court: Higher seed gets games 1,2,5,7 at home
```

### 15.4 Dynasty Mode

- Play unlimited consecutive seasons
- Track franchise history: championships, retired numbers, records
- Franchise milestones: "First Championship," "Dynasty (3-peat)," "Rebuilding Complete"
- Can sim entire seasons at once (instant) or play through

---

## 16. Visual Style & Art

### 16.1 Isometric Court

- **Tile size:** 64×32 pixels (standard isometric)
- **Court dimensions:** ~30×16 tiles (full court)
- **Camera:** Fixed isometric, no rotation
- **Floor:** Hardwood texture with painted lines, team-colored accents
- **Surroundings:** Pixel art crowd, scoreboard, bench area

### 16.2 Player Sprites

```
Modular Sprite System:
├── Body Type (3): Small (PG/SG), Medium (SF/SG), Large (PF/C)
├── Skin Tone (6): Palette swap
├── Hair Style (12): Various pixel art hairstyles
├── Jersey (30 teams): Palette swap per team (home/away)
└── Accessories (optional): Headband, arm sleeve, goggles
```

- **Directions:** 8-directional movement (N, NE, E, SE, S, SW, W, NW)
- **Animations per direction:**
  - Idle (2 frames)
  - Run (6 frames)
  - Dribble (8 frames)
  - Shoot (jump shot: 5 frames, layup: 6 frames, dunk: 8 frames)
  - Pass (4 frames)
  - Defense stance (2 frames)
  - Block (4 frames)
  - Celebrate (4 frames)

**Total frames per body type:** ~400 frames × 8 directions ≈ 3,200 frames  
**Packed into sprite atlases:** 3 body types × 1 atlas = 3 base atlases, palette-swapped at runtime.

### 16.3 Visual Juice

| Event | Visual Effect |
|-------|-------------|
| Score | "+2" / "+3" popup floating text, brief screen flash |
| Dunk | Screen shake (4px, 200ms), impact particles |
| 3-pointer | Ball trail, net swoosh particle |
| Block | "REJECTED!" popup, shockwave effect |
| Steal | Speed lines on stealing player |
| Hot streak (3+ makes) | 🔥 Fire effect on player |
| Takeover | Golden glow aura, afterimage trail |
| Buzzer beater | Slow-motion effect (ticks rendered at 0.25×), dramatic zoom |
| Clutch shot | Heart-rate UI overlay, crowd crescendo |

### 16.4 UI Layout (Mobile)

```
┌─────────────────────────────────────────┐
│  HOME 87        Q3  4:23        AWAY 82 │  ← Score bar
│  ⚡ Fast Break   🔥 Press               │  ← Tactic indicators  
├─────────────────────────────────────────┤
│                                         │
│          ISOMETRIC COURT VIEW           │
│         (takes ~70% of screen)          │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│ [1×] [3×] [10×] [SIM]   [⏸] [TIMEOUT] │  ← Controls
│ PG:Jones 🔥  SG:Smith  SF:Brown        │  ← Active lineup
│ PF:Davis  C:Wilson  Momentum: ████░░   │
└─────────────────────────────────────────┘
```

---

## 17. Tech Stack & Architecture

### 17.1 Engine & Tools

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Engine | Unity 2022 LTS | C#, mobile-proven, sprite support |
| Rendering | Sprite-based (SpriteRenderer) | Custom animation system, not Animator |
| Court | Isometric Tilemap | Built-in Unity support |
| Simulation | Pure C# | No MonoBehaviour, runs on thread |
| Data | JSON + ScriptableObjects | Easy modding, human-readable saves |
| UI | Unity UI Toolkit | Modern, performant mobile UI |
| Audio | FMOD / Unity Audio | Crowd ambience, whistle, swoosh SFX |
| Analytics | Unity Analytics | Track balance, find exploits |

### 17.2 Architecture

```
┌──────────────────────────────────────────┐
│                  UI Layer                 │
│   (Menus, HUD, Lineup Screen, Draft)     │
├──────────────────────────────────────────┤
│              Rendering Layer             │
│  (SpriteAnimator, CourtRenderer,         │
│   EffectsManager, CameraController)      │
├──────────────────────────────────────────┤
│            Game Manager Layer            │
│  (SeasonManager, RosterManager,          │
│   TradeManager, DraftManager)            │
├──────────────────────────────────────────┤
│           Simulation Engine              │
│  (MatchEngine, ProbabilityEngine,        │
│   TacticResolver, PnRResolver)           │
│  ← Runs on separate thread (no Unity)   │
├──────────────────────────────────────────┤
│              Data Layer                  │
│  (PlayerDB, TeamDB, SeasonDB,            │
│   SaveManager ← JSON serialization)      │
└──────────────────────────────────────────┘
```

### 17.3 Save System

```csharp
[Serializable]
public class SaveData
{
    public int SaveVersion;
    public SeasonData CurrentSeason;
    public TeamData[] AllTeams;        // 30 teams
    public PlayerData[] AllPlayers;    // ~450 players
    public DraftData NextDraft;
    public FinanceData Finances;
    public SettingsData Settings;
    public HistoryData[] SeasonHistory; // Past seasons
}

// Save to: Application.persistentDataPath + "/saves/save_{slot}.json"
// Auto-save after every game
// 3 manual save slots
// Cloud save via platform (Game Center / Google Play)
```

### 17.4 Performance Targets

| Metric | Target |
|--------|--------|
| FPS (gameplay) | 60 FPS |
| FPS (menus) | 60 FPS |
| SIM full game | <100ms |
| SIM full season (82 games) | <5s |
| App size | <150MB |
| RAM usage | <300MB |
| Battery (1hr play) | <15% drain |
| Save file size | <2MB |

---

## 18. Target Audience

### 18.1 Primary Audiences

| Segment | Description | What They Want |
|---------|-------------|---------------|
| **Basketball Manager Fans** | Play Basketball GM, Franchise Ball | Deep management, realistic sim |
| **Retro Bowl Players** | 10M+ downloads, casual management | Accessible, satisfying, quick sessions |
| **Football Manager Mobile** | FM fans wanting basketball equivalent | Tactical depth, long-term dynasty |
| **Kairosoft Fans** | Love pixel art management sims | Charm, progression, "one more turn" |

### 18.2 Market Gap

No current mobile game combines:
- ✅ Deep basketball management (FM-level)
- ✅ Visual match simulation (not just text)
- ✅ Charming pixel art aesthetic
- ✅ Tactical rock-paper-scissors system
- ✅ Premium (no gacha/energy)

**Closest competitors and their gaps:**

| Game | What It Does | What It's Missing |
|------|-------------|-------------------|
| Basketball GM (web) | Deep management | No visual sim, no mobile, ugly UI |
| Retro Bowl | Great mobile feel | Football, not basketball; shallow management |
| NBA 2K Mobile | Visual basketball | Gacha, P2W, no management depth |
| Kairosoft Basketball | Pixel art charm | Very shallow sim, no real tactics |

### 18.3 Session Length

- **Quick session (5-10 min):** SIM a few games, check results, make a trade
- **Medium session (20-30 min):** Watch a game at 3×, adjust tactics, manage roster
- **Long session (60+ min):** Draft night, watch playoff game at 1×, deep management

---

## 19. Monetization

### 19.1 Pricing Strategy

**Recommended: Option B (Retro Bowl model)**

| Tier | Price | Content |
|------|-------|---------|
| **Free** | $0 | Full game, 1 save slot, limited customization |
| **Unlock** | $2.99 | 3 save slots, all customization, coordinator hiring, advanced stats |

### 19.2 Optional Cosmetic IAP

| Item | Price | Content |
|------|-------|---------|
| Court Pack | $0.99 | 5 alternate court designs (outdoor, all-star, etc.) |
| Jersey Pack | $0.99 | Retro jerseys, city editions |
| Mascot Pack | $0.99 | Animated mascots on sideline |
| Sound Pack | $0.99 | Commentary voice lines, crowd chants |
| Full Cosmetic Bundle | $2.99 | Everything above |

### 19.3 Anti-Monetization Principles

- ❌ NO pay-to-win
- ❌ NO gacha / loot boxes
- ❌ NO energy system / timers
- ❌ NO forced ads
- ❌ NO premium currency
- ✅ Pay once, play forever
- ✅ All gameplay content available in free tier
- ✅ Cosmetic-only optional purchases

---

## 20. Development Phases

### Phase 1: Engine Prototype (Month 1-2)

**Goal:** Validate the match simulation engine produces realistic basketball.

| Task | Duration | Deliverable |
|------|----------|-------------|
| Implement MatchEngine (tick system, possession flow) | 2 weeks | Core simulation loop |
| Implement ProbabilityEngine (shot resolution, turnovers, rebounds) | 2 weeks | All dice rolls working |
| Implement Tactical system (5v5 matchup matrix) | 1 week | Tactics affect outcomes |
| Run 10,000 game simulations | 1 week | Statistical validation report |
| Balance stat curves until box scores look realistic | 2 weeks | Avg PPG ~110, realistic stat lines |

**Validation targets (per-team averages over 10K games):**

| Stat | Target | Acceptable Range |
|------|--------|-----------------|
| Points/Game | 110 | 105-115 |
| FG% | 46% | 44-48% |
| 3P% | 36% | 34-38% |
| FT% | 77% | 75-80% |
| Rebounds/Game | 44 | 42-46 |
| Assists/Game | 25 | 23-27 |
| Turnovers/Game | 14 | 12-16 |
| Steals/Game | 8 | 7-9 |
| Blocks/Game | 5 | 4-6 |

### Phase 2: Core Management + Court (Month 3-4)

| Task | Duration |
|------|----------|
| Roster management UI (lineup, rotation, contracts) | 2 weeks |
| Season structure (schedule, standings, playoffs) | 2 weeks |
| Basic isometric court rendering | 2 weeks |
| Connect simulation results to animations | 2 weeks |

### Phase 3: Full Management (Month 5-6)

| Task | Duration |
|------|----------|
| Draft system (prospect generation, scouting, draft night UI) | 2 weeks |
| Trade system (AI valuation, proposals, deadline) | 2 weeks |
| Training & development system | 1 week |
| Business/finance management | 1 week |
| Free agency | 1 week |
| Awards & career tracking | 1 week |

### Phase 4: Art & Polish (Month 7)

| Task | Duration |
|------|----------|
| Player sprite system (3 body types × 8 directions × all animations) | 2 weeks |
| Court art, crowd, UI design | 1 week |
| Visual effects (score popups, screen shake, takeover glow, fire) | 1 week |

### Phase 5: Testing & Launch (Month 8)

| Task | Duration |
|------|----------|
| Balance pass (run 100K sims, adjust) | 1 week |
| Beta testing (TestFlight / Google Play beta) | 2 weeks |
| Bug fixes, performance optimization | 1 week |
| **Launch** | 🚀 |

---

## 21. Appendix: Formulas & Tables

### A. Complete Shot Probability Formula

```
FinalPct = BasePct(stat, shotType)
         + ContestMod(defenderStat, shotType)        // -2% to -15%
         + TacticMod(offTactic, defTactic)            // -15% to +15%
         + SynergyMod(teamSynergy)                    // -15% to +20%
         + TakeoverMod(inTakeover)                    // 0% or +10%
         + FatigueMod(stamina)                         // 0% to -10%
         + ClutchMod(clutchStat, isClutchTime)        // -5% to +5%
         + TraitMod(applicableTraits)                  // varies
         + HotColdMod(consecutiveMakes/Misses)         // -6% to +12%
         + HomeCourtMod(isHome)                        // +2%

Clamped to [5%, 95%]
```

### B. Turnover Probability Formula

```
TOPct = 0.12 (base 12%)
      - ballHandler.BallHandling / 100 * 0.08         // -0 to -8%
      + (Press ? 0.05 : 0)                            // +5% if pressed
      + (Gamble ? 0.03 : 0)                           // +3% if gambled
      + (synergy < 40 ? 0.04 : 0)                     // +4% if bad synergy
      + (100 - stamina) * 0.001                        // fatigue
      
Clamped to [3%, 30%]
```

### C. Rebound Probability

```
OffRebPct = 0.25 (base 25%)
          × (offRebStrength / defRebStrength)          // team matchup
          + traitBonuses                                // ±5-8%
          
Clamped to [10%, 45%]
```

### D. Momentum Change Table

| Event | Change |
|-------|--------|
| Made 2pt shot | +8 |
| Made 3pt shot | +12 |
| Made dunk | +15 |
| And-one (made + FT) | +18 |
| Assist | +6 |
| Steal | +10 |
| Block | +10 |
| Offensive rebound | +5 |
| Missed shot | -5 |
| Turnover | -12 |
| Got blocked | -8 |
| Personal foul | -3 |
| Opponent run (per point) | -2 |
| Time on bench (per minute) | -3 |
| Natural decay (per 12s) | -1 |

### E. Morale Change Table

| Event | Change |
|-------|--------|
| Win | +2 |
| Loss | -1 |
| Win streak bonus (3+) | +1/game |
| Lose streak penalty (3+) | -2/game |
| Playing time met | +1/game |
| Playing time not met | -3/game |
| Star getting touches | +2/game |
| Unexpected bench | -10 |
| Make playoffs | +10 |
| Trade rumor | -5 |
| New max contract | +15 |
| Pay cut request | -8 |
| Championship win | +25 |

### F. Age Development Curve

```
Age 19-22: Growth phase     (+2 to +5 OVR per season toward potential)
Age 23-25: Late development (+1 to +3 OVR per season)
Age 26-29: Peak             (+0 to +1 OVR, stable)
Age 30-32: Early decline    (-1 to -2 OVR per season, physicals first)
Age 33-35: Decline          (-2 to -4 OVR per season)
Age 36+:   Steep decline    (-3 to -6 OVR per season)
```

### G. Salary Cap Quick Reference

| Category | Amount |
|----------|--------|
| Salary Cap | $120M |
| Luxury Tax Line | $140M |
| Hard Cap (Apron) | $160M |
| Minimum Salary | $1M |
| Maximum Salary | $40M |
| Mid-Level Exception | $10M |
| Rookie Minimum | $1M |
| Veteran Minimum | $2M |

### H. Draft Prospect Tier Distribution

| Tier | % of Draft Class | Base OVR | Potential Upside |
|------|-----------------|----------|------------------|
| Generational | 3% | 78-85 | +12 to +20 |
| Elite | 9% | 72-79 | +10 to +18 |
| Lottery | 18% | 65-73 | +8 to +16 |
| First Round | 25% | 58-66 | +5 to +13 |
| Second Round | 25% | 50-59 | +3 to +10 |
| Undrafted | 20% | 40-51 | +1 to +8 |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-02-19 | — | Initial GDD |

---

*This document is a living specification. All numbers are subject to balance testing and iteration. The simulation engine (Phase 1) will produce statistical validation data that may require adjusting base percentages, modifiers, and weights throughout development.*
