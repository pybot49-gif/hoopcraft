# Hoopcraft Play System

> **Status:** Design Phase
> **Last Updated:** 2026-02-22
> **Authors:** Jacky, PyBot
> **Related:** [ai-architecture.md](./ai-architecture.md), [utility-system.md](./utility-system.md), [player-vision.md](./player-vision.md), [performance-budget.md](./performance-budget.md)

---

## Overview

Plays are **not animations or coordinate scripts**. A play is a collection of **intents, roles, relative actions, and decision rules**. The play says WHAT and WHY — the resolution engine figures out HOW and WHERE.

### Core Principle

```
Play = Intent + Roles + Relative Actions + Decision Rules

                    NOT this                         THIS
            ────────────────────          ────────────────────────────
Coordinates  "move to (47, 25)"           "move to screener's position"
Timing       "at 3.0 seconds"            "after screen contact"
Path         "follow this line"           "avoid defenders, reach target"
Outcome      "always shoot 3"             "if open shoot, else continue"
Speed        "run at 8 ft/s"             "speed based on fatigue + urgency"
```

A play only specifies **relationships between players and reactions to defense**. The resolution engine converts abstract intent into concrete positions, paths, and speeds every tick.

---

## What Is a Play?

### Human Coach Analogy

A coach draws this on a whiteboard:

```
"Klay, start at the baseline. Run off Draymond's screen toward the left wing.
If you're not open, keep going off Looney's screen to the right corner.
Whichever side you're open, catch and shoot."
```

This sentence contains:
1. **Goal:** Get Klay an open shot
2. **Method:** Two off-ball screens
3. **Route:** Relative to screener positions, not fixed coordinates
4. **Decision:** Stop wherever you're open
5. **Result:** Catch and shoot

The play does NOT say:
- Exact coordinates to run to
- Exact time to start running
- Exact speed to run at
- What to do if the play breaks down completely

---

## Three-Layer Play Specification

### Layer 1: Intent (What the play wants to achieve)

```typescript
interface PlayIntent {
  goal: PlayGoal;               // 'get_open_shot' | 'create_mismatch' | 'attack_paint' | 'reset'
  primaryBeneficiary: string;   // Which role benefits
  method: PlayMethod;           // 'off_ball_screens' | 'pick_and_roll' | 'isolation' | 'post_up'
  shotType: ShotType;           // Expected finish: 'catch_and_shoot' | 'layup' | 'post_move' | 'pullup'
}
```

### Layer 2: Actions (What each player does, relatively)

```typescript
interface PlayPhase {
  name: string;                           // Human-readable phase name
  assignments: Map<PlayRole, RoleAction>; // What each role does
  until: PhaseTrigger;                    // When this phase ends
  reads: PlayRead[];                      // Decision branches
}

interface RoleAction {
  do: ActionVerb;            // 'run_to' | 'set_screen' | 'space' | 'cut' | 'hold_ball' | etc.
  target?: string;           // Relative target: role name, zone name, 'basket'
  side?: string;             // 'use_screen' | 'left' | 'right'
  direction?: string;        // 'toward_left_wing' | 'toward_basket' | 'away_from_ball'
  read?: string;             // 'defender' | 'own_defender' | 'help_side'
  condition?: string;        // 'if_open' | 'if_contested'
  for?: string;              // Who this action benefits (screens)
  where?: string;            // Zone reference: 'weak_side_corner' | 'right_elbow'
  look_for?: string;         // Who to watch (ball handler watching runner)
  if_open?: string;          // Action if target is open
  else?: string;             // Fallback action
  then?: string;             // Follow-up action
  adjust?: string;           // 'balance_floor' | 'match_ball_side'
}
```

**Available Action Verbs:**

| Verb | Description | Requires |
|------|-------------|----------|
| `run_to` | Move toward a target | `target`, optional `side` |
| `set_screen` | Set a screen for someone | `for`, `direction` |
| `hold_screen` | Maintain screen position | `then` (roll/pop) |
| `use_screen` | Run off a screen | `target` (screener) |
| `curl_or_flare` | Read defender and curl/flare off screen | `around`, `read` |
| `cut` | Cut to basket or spot | `target` |
| `space` | Maintain floor spacing | `where`, optional `adjust` |
| `hold_ball` | Dribble in place, read | `look_for` |
| `hold_position` | Stay put | `where` |
| `pass` | Pass to someone | `target` |
| `shoot` | Attempt shot | optional `condition` |
| `dribble_toward` | Dribble toward target | `target` |
| `dribble_relocate` | Move with ball to new spot | `look_for` |
| `post_up` | Establish post position | `target` (basket/block) |
| `pop_or_roll` | Read defender, pop out or roll to rim | `read` |
| `prepare_screen` | Move into position for upcoming screen | `for` |
| `fill` | Fill a vacated spot | `target` (spot or zone) |
| `relocate` | Move to open spot after action | `target`, `speed` |
| `pin_down` | Set a down screen | `for` |
| `flare_screen` | Set a flare screen | `for` |
| `slip` | Fake screen and cut to basket | |
| `seal` | Seal defender for entry pass | `target` |

### Layer 3: Resolution Engine (Calculates actual positions)

The resolution engine runs every decision tick, converting abstract actions into concrete commands:

```typescript
function resolveAction(
  action: RoleAction,
  player: SimPlayer,
  state: GameState,
  playContext: PlayContext
): PlayerCommand {

  switch (action.do) {

    case 'run_to': {
      // "run_to screener1" → calculate actual position to run to
      const target = playContext.getPlayer(action.target);
      const screenSide = resolveScreenSide(action.side, player, target, state);

      // Don't run TO the screener — run to the "screen use point"
      const usePoint = calcScreenUsePoint(target, screenSide, state);

      return {
        type: 'move',
        targetPos: usePoint,
        speed: calcRunSpeed(player, state),
        path: avoidDefenders(player.pos, usePoint, state),
      };
    }

    case 'set_screen': {
      // "set_screen for runner toward_left_wing" → where to stand
      const runner = playContext.getPlayer(action.for);
      const runnerDefender = getDefender(runner, state);

      // Screen position = between runner's defender and the target direction
      const direction = resolveDirection(action.direction, state);
      const screenPos = calcOptimalScreenPosition(
        runner.pos,
        runnerDefender?.pos,
        direction,
        state
      );

      return {
        type: 'move_then_screen',
        targetPos: screenPos,
        speed: 'jog',
        screenAngle: calcScreenAngle(runnerDefender, direction),
      };
    }

    case 'curl_or_flare': {
      // "curl_or_flare around screener1, read defender"
      // Defender position determines curl vs flare
      const screener = playContext.getPlayer(action.around);
      const myDefender = getDefender(player, state);
      const basket = getTeamBasket(player.teamIdx);

      if (!myDefender) {
        // No one guarding me → curl straight to basket
        return { type: 'cut', targetPos: basket, speed: 'sprint' };
      }

      if (isTrailing(myDefender, player, screener) || isGoingOver(myDefender, screener)) {
        // Defender trailing or going over screen → CURL tight to basket
        const curlTarget = calcCurlPath(player.pos, screener.pos, basket);
        return { type: 'cut', targetPos: curlTarget, speed: 'sprint' };
      } else if (isGoingUnder(myDefender, screener)) {
        // Defender taking shortcut under screen → FLARE out for three
        const flareTarget = calcFlareSpot(player.pos, screener.pos);
        return { type: 'move', targetPos: flareTarget, speed: 'sprint' };
      } else {
        // Uncertain → straight cut through
        return { type: 'move', targetPos: calcStraightCut(player.pos, screener.pos), speed: 'sprint' };
      }
    }

    case 'space': {
      // "space weak_side_corner" → find best open spot in zone
      const idealZone = resolveZone(action.where, state);
      const openSpot = findBestOpenSpot(idealZone, player, state);
      return { type: 'move', targetPos: openSpot, speed: 'jog' };
    }

    case 'hold_ball': {
      // "hold_ball, look_for runner" → wait for runner to get open, then pass
      const target = playContext.getPlayer(action.look_for);
      const isOpen = checkIfOpen(target, state);

      if (isOpen && canPass(player, target, state)) {
        return { type: 'pass', target: target.id };
      }
      return { type: 'dribble', targetPos: player.pos };
    }

    case 'pop_or_roll': {
      // "pop_or_roll, read own_defender" → skill + defender determine choice
      const myDef = getDefender(player, state);
      const canShootThree = player.player.skills.shooting.three_point >= 60;

      if ((!myDef || dist(myDef.pos, player.pos) > 8) && canShootThree) {
        // Defender sagged off + I can shoot → pop for three
        return { type: 'move', targetPos: findOpenThreeSpot(player, state), speed: 'jog' };
      }
      // Default → roll to basket
      return { type: 'cut', targetPos: getTeamBasket(player.teamIdx), speed: 'sprint' };
    }

    case 'fill': {
      // "fill vacated_spot" → find the spot that was just left empty
      const vacated = playContext.getVacatedSpot(action.target);
      if (vacated) {
        return { type: 'move', targetPos: vacated, speed: 'jog' };
      }
      return { type: 'move', targetPos: findBestOpenSpot('perimeter', player, state), speed: 'jog' };
    }

    case 'seal': {
      // "seal defender for entry pass" → position between defender and passer
      const myDef = getDefender(player, state);
      const passer = getBallHandler(state);
      if (myDef && passer) {
        const sealPos = calcSealPosition(player.pos, myDef.pos, passer.pos);
        return { type: 'move', targetPos: sealPos, speed: 'walk' };
      }
      return { type: 'post', targetPos: getTeamBasket(player.teamIdx), speed: 'walk' };
    }
  }
}
```

### Resolution Helper Functions

```typescript
// Calculate where to stand to use a screen
function calcScreenUsePoint(screener: SimPlayer, side: string, state: GameState): Vec2 {
  const basket = getTeamBasket(screener.teamIdx);
  const screenToBasket = normalize(sub(basket, screener.pos));
  const perpendicular = { x: -screenToBasket.y, y: screenToBasket.x };

  // Use point is 2-3 feet to the side of the screener
  const sideDir = side === 'left' ? -1 : 1;
  return {
    x: screener.pos.x + perpendicular.x * sideDir * 2.5,
    y: screener.pos.y + perpendicular.y * sideDir * 2.5,
  };
}

// Calculate optimal screen position
function calcOptimalScreenPosition(
  runnerPos: Vec2,
  defenderPos: Vec2 | undefined,
  direction: Vec2,
  state: GameState
): Vec2 {
  if (!defenderPos) {
    // No defender visible → screen toward the direction
    return add(runnerPos, scale(direction, 3));
  }

  // Screen between defender and runner's intended path
  const defToRunner = normalize(sub(runnerPos, defenderPos));
  return {
    x: defenderPos.x + defToRunner.x * 2,
    y: defenderPos.y + defToRunner.y * 2,
  };
}

// Resolve abstract zone names to court positions
function resolveZone(zoneName: string, state: GameState): CourtZone {
  const basket = getTeamBasket(state.possession);
  const dir = state.possession === 0 ? 1 : -1;

  const zones: Record<string, CourtZone> = {
    'weak_side_corner':     { center: { x: basket.x - dir * 2, y: 3 }, radius: 4 },
    'strong_side_corner':   { center: { x: basket.x - dir * 2, y: 47 }, radius: 4 },
    'left_wing':            { center: { x: basket.x - dir * 15, y: 5 }, radius: 5 },
    'right_wing':           { center: { x: basket.x - dir * 15, y: 45 }, radius: 5 },
    'left_elbow':           { center: { x: basket.x - dir * 10, y: 15 }, radius: 4 },
    'right_elbow':          { center: { x: basket.x - dir * 10, y: 35 }, radius: 4 },
    'top_key':              { center: { x: basket.x - dir * 20, y: 25 }, radius: 5 },
    'paint':                { center: basket, radius: 8 },
    'short_corner_left':    { center: { x: basket.x - dir * 5, y: 10 }, radius: 3 },
    'short_corner_right':   { center: { x: basket.x - dir * 5, y: 40 }, radius: 3 },
    'high_post':            { center: { x: basket.x - dir * 12, y: 25 }, radius: 4 },
    'low_block_left':       { center: { x: basket.x - dir * 3, y: 19 }, radius: 3 },
    'low_block_right':      { center: { x: basket.x - dir * 3, y: 31 }, radius: 3 },
  };

  return zones[zoneName] || zones['top_key'];
}

// Resolve abstract directions
function resolveDirection(directionName: string, state: GameState): Vec2 {
  const basket = getTeamBasket(state.possession);
  const dir = state.possession === 0 ? 1 : -1;

  const directions: Record<string, Vec2> = {
    'toward_left_wing':    { x: -dir * 0.7, y: -0.7 },
    'toward_right_wing':   { x: -dir * 0.7, y: 0.7 },
    'toward_basket':       { x: dir, y: 0 },
    'toward_top_key':      { x: -dir, y: 0 },
    'toward_left_corner':  { x: dir * 0.3, y: -0.9 },
    'toward_right_corner': { x: dir * 0.3, y: 0.9 },
    'away_from_ball':      normalize(sub(basket, state.ball.pos)),
  };

  return directions[directionName] || { x: 0, y: 0 };
}
```

---

## Play Types

### Type 1: Set Plays (Full 5-Man Choreography with Reads)

The most complex — every player has specific actions and the play branches based on defense.

```typescript
interface SetPlay {
  name: string;
  category: PlayCategory;

  // Role assignments
  roles: {
    ballHandler: PositionFilter;
    screener1: PositionFilter;
    screener2: PositionFilter;
    shooter1: PositionFilter;
    shooter2: PositionFilter;
  };

  // Sequence of phases
  phases: PlayPhase[];

  // Entry conditions
  bestAgainst: DefenseType[];
  requiredSkills: SkillRequirement[];
  tempo: 'any' | 'halfcourt';
}
```

#### Example: Floppy Play (Off-Ball Double Screen)

The classic Curry/Klay action — runner goes off two screens, shoots wherever open:

```
FORMATION:
                 [PG] 🏀
                   
          [PF]           [C]          ← Screeners at elbows
                   
                 [SG]                 ← Runner at baseline
                   
          [SF]                        ← Spacer in corner
          
ACTION:
  SG runs off PF screen toward left wing...
    → if open: PG passes, SG shoots
    → if not: SG continues off C screen toward right corner...
      → if open: PG passes, SG shoots
      → if both fail: abort to motion
```

```typescript
const FLOPPY_RIGHT: SetPlay = {
  name: "Floppy Right",
  category: 'floppy',

  roles: {
    ballHandler: { positions: ['PG'], fallback: 'bestHandler' },
    runner:      { positions: ['SG'], fallback: 'bestShooter' },
    screener1:   { positions: ['PF'], fallback: 'bestScreener' },
    screener2:   { positions: ['C'], fallback: 'secondBig' },
    spacer:      { positions: ['SF'], fallback: 'remaining' },
  },

  phases: [
    // Phase 1: Setup — everyone gets in position
    {
      name: 'setup',
      assignments: {
        ballHandler: { do: 'hold_ball', where: 'top_key', look_for: 'runner' },
        runner:      { do: 'run_to', target: 'low_block_left', speed: 'jog' },
        screener1:   { do: 'hold_position', where: 'left_elbow' },
        screener2:   { do: 'hold_position', where: 'right_elbow' },
        spacer:      { do: 'space', where: 'weak_side_corner' },
      },
      until: { type: 'position', role: 'runner', within: 3 },
      reads: [],
    },

    // Phase 2: Runner goes off first screen
    {
      name: 'use_screen_1',
      assignments: {
        runner:      { do: 'curl_or_flare', around: 'screener1', read: 'defender' },
        screener1:   { do: 'set_screen', for: 'runner', direction: 'toward_left_wing' },
        screener2:   { do: 'prepare_screen', for: 'runner' },
        ballHandler: { do: 'hold_ball', look_for: 'runner', if_open: 'pass', else: 'wait' },
        spacer:      { do: 'space', where: 'weak_side_corner' },
      },
      until: { type: 'screen_cleared', role: 'runner', screener: 'screener1' },
      reads: [
        {
          name: "Runner open off screen 1",
          if: { type: 'player_open', role: 'runner', threshold: 0.6 },
          then: 'deliver_ball_1',
        },
        {
          name: "Defender went under — runner stops for pullup",
          if: { type: 'defender_went_under', for: 'runner' },
          then: 'pullup_off_screen',
        },
        {
          name: "Runner still covered",
          if: { type: 'default' },
          then: 'use_screen_2',
        },
      ],
    },

    // Phase 3a: Continue to second screen
    {
      name: 'use_screen_2',
      assignments: {
        runner:      { do: 'curl_or_flare', around: 'screener2', read: 'defender' },
        screener1:   { do: 'pop_or_roll', read: 'own_defender' },
        screener2:   { do: 'set_screen', for: 'runner', direction: 'toward_right_corner' },
        ballHandler: { do: 'dribble_relocate', look_for: 'runner' },
        spacer:      { do: 'space', adjust: 'balance_floor' },
      },
      until: { type: 'screen_cleared', role: 'runner', screener: 'screener2' },
      reads: [
        {
          name: "Runner open off screen 2",
          if: { type: 'player_open', role: 'runner', threshold: 0.6 },
          then: 'deliver_ball_2',
        },
        {
          name: "Screener1 popped open",
          if: { type: 'player_open', role: 'screener1', threshold: 0.7 },
          then: 'screener1_pop_shot',
        },
        {
          name: "Both screens failed",
          if: { type: 'default' },
          then: 'abort_to_motion',
        },
      ],
    },

    // Phase 3b: Deliver ball after screen 1
    {
      name: 'deliver_ball_1',
      assignments: {
        ballHandler: { do: 'pass', target: 'runner' },
        runner:      { do: 'shoot', condition: 'catch_and_shoot' },
        screener1:   { do: 'roll_or_pop', read: 'own_defender' },
        screener2:   { do: 'crash_boards' },
        spacer:      { do: 'space', where: 'weak_side_corner' },
      },
      until: { type: 'shot_or_pass' },
      reads: [
        {
          name: "Closeout hard — pump fake drive",
          if: { type: 'hard_closeout', on: 'runner' },
          then: 'pump_fake_drive',
        },
      ],
    },

    // Phase 3c: Deliver ball after screen 2
    {
      name: 'deliver_ball_2',
      assignments: {
        ballHandler: { do: 'pass', target: 'runner' },
        runner:      { do: 'shoot', condition: 'catch_and_shoot' },
        screener1:   { do: 'space', where: 'top_key' },
        screener2:   { do: 'roll_or_pop', read: 'own_defender' },
        spacer:      { do: 'relocate', target: 'open_three' },
      },
      until: { type: 'shot_or_pass' },
      reads: [],
    },

    // Phase 3d: Play broke down → motion
    {
      name: 'abort_to_motion',
      assignments: {
        ballHandler: { do: 'hold_ball', read: 'defense' },
        runner:      { do: 'space', where: 'strong_side_wing' },
        screener1:   { do: 'space', adjust: 'balance_floor' },
        screener2:   { do: 'post_up', target: 'low_block' },
        spacer:      { do: 'space', where: 'weak_side_corner' },
      },
      until: { type: 'play_complete' },
      reads: [],
    },
  ],

  bestAgainst: ['man'],
  requiredSkills: [
    { role: 'runner', skill: 'off_ball_movement', min: 60 },
    { role: 'runner', skill: 'catch_and_shoot', min: 55 },
  ],
  tempo: 'halfcourt',
};
```

#### Example: Horns Pick and Roll

```
FORMATION: Horns (1-4 High)

     [SG]                    [SF]        ← Wings in corners
         
              [PF]   [C]                 ← Bigs at elbows ("horns")
         
                 [PG]                    ← Ball handler at top
                   🏀

ACTION:
  C screens for PG...
    → Defense switches: feed C for mismatch post-up
    → Defense traps: escape pass to PF, attack 4v3
    → Defense drops: PG pull-up jumper
    → Standard: PG drives, C rolls, kick to open shooter
```

```typescript
const HORNS_PNR_RIGHT: SetPlay = {
  name: "Horns PnR Right",
  category: 'horns',

  roles: {
    ballHandler: { positions: ['PG'], fallback: 'bestHandler' },
    screener1:   { positions: ['C'], fallback: 'bestScreener' },
    screener2:   { positions: ['PF'], fallback: 'secondBig' },
    shooter1:    { positions: ['SG'], fallback: 'bestShooter' },
    shooter2:    { positions: ['SF'], fallback: 'secondShooter' },
  },

  phases: [
    {
      name: 'formation',
      assignments: {
        ballHandler: { do: 'dribble_toward', target: 'top_key' },
        screener1:   { do: 'run_to', target: 'right_elbow' },
        screener2:   { do: 'run_to', target: 'left_elbow' },
        shooter1:    { do: 'space', where: 'strong_side_corner' },
        shooter2:    { do: 'space', where: 'weak_side_corner' },
      },
      until: { type: 'position', role: 'screener1', within: 3 },
      reads: [],
    },
    {
      name: 'screen_action',
      assignments: {
        ballHandler: { do: 'use_screen', target: 'screener1' },
        screener1:   { do: 'set_screen', for: 'ballHandler', direction: 'toward_right_wing' },
        screener2:   { do: 'drift', target: 'short_corner_left' },
        shooter1:    { do: 'space', where: 'strong_side_corner' },
        shooter2:    { do: 'lift', where: 'weak_side_wing' },
      },
      until: { type: 'screen_contact' },
      reads: [
        {
          name: "Defense switches",
          if: { type: 'switch', between: ['ballHandler', 'screener1'] },
          then: 'switch_exploit',
        },
        {
          name: "Defense traps",
          if: { type: 'trap', on: 'ballHandler' },
          then: 'trap_escape',
        },
        {
          name: "Defense drops",
          if: { type: 'drop_coverage', by: 'screener1_defender' },
          then: 'pullup_jumper',
        },
        {
          name: "Standard coverage",
          if: { type: 'default' },
          then: 'pnr_continue',
        },
      ],
    },
    {
      name: 'pnr_continue',
      assignments: {
        ballHandler: { do: 'dribble_toward', target: 'basket', speed: 'sprint' },
        screener1:   { do: 'cut', target: 'basket', speed: 'sprint' },
        screener2:   { do: 'space', where: 'short_corner_left' },
        shooter1:    { do: 'drift', where: 'strong_side_wing' },
        shooter2:    { do: 'fill', target: 'top_key' },
      },
      until: { type: 'time', seconds: 2.0 },
      reads: [
        {
          name: "Help from corner",
          if: { type: 'help_rotation', from: 'shooter1_defender' },
          then: 'kick_to_corner',
        },
        {
          name: "Rolling big open",
          if: { type: 'player_open', role: 'screener1', threshold: 0.7 },
          then: 'lob_to_roller',
        },
      ],
    },
    {
      name: 'switch_exploit',
      assignments: {
        ballHandler: { do: 'pass', target: 'screener1' },
        screener1:   { do: 'post_up', target: 'low_block_right' },
        screener2:   { do: 'space', where: 'left_elbow' },
        shooter1:    { do: 'space', where: 'strong_side_corner' },
        shooter2:    { do: 'space', where: 'weak_side_wing' },
      },
      until: { type: 'time', seconds: 3.0 },
      reads: [],
    },
    {
      name: 'trap_escape',
      assignments: {
        ballHandler: { do: 'pass', target: 'screener2' },
        screener1:   { do: 'cut', target: 'basket', speed: 'sprint' },
        screener2:   { do: 'run_to', target: 'left_elbow' },
        shooter1:    { do: 'relocate', target: 'open_three' },
        shooter2:    { do: 'space', where: 'weak_side_corner' },
      },
      until: { type: 'pass' },
      reads: [
        {
          name: "4v3 advantage",
          if: { type: 'advantage', min: 1 },
          then: 'attack_advantage',
        },
      ],
    },
    {
      name: 'pullup_jumper',
      assignments: {
        ballHandler: { do: 'shoot', condition: 'open_midrange' },
        screener1:   { do: 'crash_boards' },
        screener2:   { do: 'crash_boards' },
        shooter1:    { do: 'space', where: 'strong_side_corner' },
        shooter2:    { do: 'space', where: 'weak_side_wing' },
      },
      until: { type: 'shot_or_pass' },
      reads: [],
    },
    {
      name: 'kick_to_corner',
      assignments: {
        ballHandler: { do: 'pass', target: 'shooter1' },
        screener1:   { do: 'crash_boards' },
        screener2:   { do: 'space', where: 'short_corner_left' },
        shooter1:    { do: 'shoot', condition: 'catch_and_shoot' },
        shooter2:    { do: 'space', where: 'top_key' },
      },
      until: { type: 'shot_or_pass' },
      reads: [
        {
          name: "Hard closeout",
          if: { type: 'hard_closeout', on: 'shooter1' },
          then: 'closeout_drive',
        },
      ],
    },
  ],

  bestAgainst: ['man', 'switch'],
  requiredSkills: [
    { role: 'ballHandler', skill: 'ball_handling', min: 60 },
    { role: 'screener1', skill: 'screen_setting', min: 50 },
  ],
  tempo: 'halfcourt',
};
```

### Type 2: Action Calls (2-3 Man Core + Spacing Rules)

Simpler than set plays — a core action with spacing rules for uninvolved players.

```typescript
interface ActionCall {
  name: string;
  coreAction: CoreAction;          // The 2-3 player action
  spacingRules: SpacingRule[];     // Rules for the other 2-3 players
  reads: ActionRead[];
}

interface CoreAction {
  type: 'pnr' | 'dho' | 'pindown' | 'iso' | 'postup' | 'stagger';
  primaryRole: string;
  secondaryRole: string;
  side: 'left' | 'right' | 'top';
}

interface SpacingRule {
  role: string;
  rule: 'space_corner' | 'space_wing' | 'space_top' | 'fill_vacated' | 'crash_boards';
  side: 'ball_side' | 'weak_side' | 'nearest';
  reaction?: {
    on: string;            // 'drive' | 'kick_out' | 'post_entry'
    do: string;            // 'drift' | 'cut_backdoor' | 'relocate'
  };
}
```

#### Example: Side Pick and Roll

```typescript
const SIDE_PNR_RIGHT: ActionCall = {
  name: "Side PnR Right",
  coreAction: {
    type: 'pnr',
    primaryRole: 'ballHandler',
    secondaryRole: 'screener',
    side: 'right',
  },
  spacingRules: [
    {
      role: 'shooter1',
      rule: 'space_corner',
      side: 'ball_side',
      reaction: { on: 'drive', do: 'drift_to_wing' },
    },
    {
      role: 'shooter2',
      rule: 'space_corner',
      side: 'weak_side',
      reaction: { on: 'kick_out', do: 'relocate_to_open_three' },
    },
    {
      role: 'spacer',
      rule: 'space_top',
      side: 'nearest',
      reaction: { on: 'drive', do: 'fill_vacated_wing' },
    },
  ],
  reads: [
    { if: 'switch', then: 'post_mismatch' },
    { if: 'trap', then: 'swing_weak_side' },
    { if: 'drop', then: 'pullup_midrange' },
    { if: 'ice', then: 'reject_screen_drive_middle' },
  ],
};
```

### Type 3: Motion Offense (Rules-Based, No Script)

No fixed choreography — players follow rules and the offense emerges:

```typescript
interface MotionOffense {
  name: string;
  formation: FormationType;        // '5-out' | '4-out-1-in' | 'horns' | 'triangle'
  rules: MotionRule[];
}

interface MotionRule {
  trigger: MotionTrigger;
  action: MotionAction;
  priority: number;                // Higher = checked first
  cooldown?: number;               // Seconds before this rule can fire again for same player
}

interface MotionTrigger {
  type: string;
  params?: Record<string, any>;
}

interface MotionAction {
  type: string;
  target?: string;
  speed?: string;
  condition?: {                    // Conditional action based on skill/situation
    skill?: string;
    above?: number;
    then: MotionAction;
    else: MotionAction;
  };
}
```

#### Example: 5-Out Motion

```typescript
const FIVE_OUT_MOTION: MotionOffense = {
  name: "5-Out Motion",
  formation: '5-out',

  rules: [
    // Rule 1: After passing, screen away
    {
      trigger: { type: 'just_passed', params: { withinSeconds: 0.5 } },
      action: { type: 'screen_away', target: 'furthest_from_ball' },
      priority: 3,
      cooldown: 4.0,
    },

    // Rule 2: If your defender helps on a drive, backdoor cut
    {
      trigger: { type: 'defender_helping', params: { myDefenderDist: 8 } },
      action: { type: 'backdoor_cut', target: 'basket' },
      priority: 4,
    },

    // Rule 3: After screening, pop or roll based on skill
    {
      trigger: { type: 'just_screened' },
      action: {
        type: 'conditional',
        condition: { skill: 'three_point', above: 60 },
        then: { type: 'pop', target: 'three_point_line' },
        else: { type: 'roll', target: 'basket' },
      },
      priority: 3,
    },

    // Rule 4: Fill empty perimeter spots
    {
      trigger: { type: 'spot_vacated', params: { zone: 'perimeter' } },
      action: { type: 'fill', target: 'vacated_spot' },
      priority: 2,
    },

    // Rule 5: Ball side — maintain spacing
    {
      trigger: { type: 'ball_on_my_side' },
      action: { type: 'space', target: 'nearest_open_spot' },
      priority: 1,
    },

    // Rule 6: Weak side — set screens for teammates
    {
      trigger: { type: 'ball_opposite_side' },
      action: { type: 'screen_nearest_teammate' },
      priority: 2,
      cooldown: 5.0,
    },

    // Rule 7: Teammate driving — react based on position
    {
      trigger: { type: 'teammate_driving' },
      action: {
        type: 'conditional',
        condition: { position: 'in_corner' },
        then: { type: 'stay', facing: 'ball' },
        else: { type: 'drift', target: 'open_three' },
      },
      priority: 3,
    },

    // Rule 8: Teammate posting — relocate for kick-out
    {
      trigger: { type: 'teammate_posting' },
      action: { type: 'relocate', target: 'open_three', speed: 'jog' },
      priority: 2,
    },

    // Rule 9: Stagnant — if ball hasn't moved in 3 seconds, initiate action
    {
      trigger: { type: 'ball_stagnant', params: { seconds: 3.0 } },
      action: { type: 'set_ball_screen' },
      priority: 2,
    },

    // Rule 10: Good spacing maintained — hold position
    {
      trigger: { type: 'good_spacing' },
      action: { type: 'hold_position', facing: 'ball' },
      priority: 0,
    },
  ],
};
```

#### Example: 4-Out 1-In Motion

```typescript
const FOUR_OUT_ONE_IN: MotionOffense = {
  name: "4-Out 1-In",
  formation: '4-out-1-in',

  rules: [
    // Center rules — paint presence
    {
      trigger: { type: 'i_am_center', params: { formation_role: 'inside' } },
      action: { type: 'duck_in', target: 'ball_side_block' },
      priority: 3,
    },
    {
      trigger: { type: 'ball_entered_paint' },
      action: { type: 'clear_to_short_corner' },
      priority: 2,
    },
    {
      trigger: { type: 'ball_on_wing', params: { my_role: 'inside' } },
      action: { type: 'seal', target: 'ball_side_block' },
      priority: 3,
    },

    // Perimeter rules — same as 5-out but with paint awareness
    {
      trigger: { type: 'just_passed', params: { withinSeconds: 0.5 } },
      action: {
        type: 'conditional',
        condition: { position: 'near_paint' },
        then: { type: 'clear_out', target: 'perimeter' },
        else: { type: 'screen_away', target: 'furthest_from_ball' },
      },
      priority: 3,
    },

    // Don't clog the paint if center is there
    {
      trigger: { type: 'paint_occupied_by_center' },
      action: { type: 'stay_perimeter' },
      priority: 4,
    },

    // Same rules as 5-out for perimeter players...
    // (backdoor, fill, spacing, drive reaction, etc.)
  ],
};
```

#### Example: Princeton Offense

```typescript
const PRINCETON_OFFENSE: MotionOffense = {
  name: "Princeton",
  formation: '4-out-1-in',

  rules: [
    // Core Princeton rule: pass and cut (backdoor or basket cut)
    {
      trigger: { type: 'just_passed', params: { withinSeconds: 0.3 } },
      action: {
        type: 'conditional',
        condition: { defender: 'overplaying' },
        then: { type: 'backdoor_cut', target: 'basket' },
        else: { type: 'basket_cut', target: 'basket', then: 'fill_opposite' },
      },
      priority: 4,
    },

    // Replace: when someone cuts, fill their spot
    {
      trigger: { type: 'teammate_cutting_from_my_area' },
      action: { type: 'fill', target: 'vacated_spot' },
      priority: 3,
    },

    // High post action: elbow entry triggers options
    {
      trigger: { type: 'ball_at_elbow', params: { my_role: 'inside' } },
      action: { type: 'face_up', read: 'defense' },
      priority: 4,
    },

    // Chin series: ball reversal triggers pin-down
    {
      trigger: { type: 'ball_reversed' },
      action: { type: 'pin_down', for: 'player_ball_reversed_from' },
      priority: 3,
      cooldown: 6.0,
    },
  ],
};
```

### Type 4: Freelance (Pure Utility AI)

No play — every player uses their individual utility function. This is the fallback when plays break down or shot clock is running out.

---

## Play Calling: Who and When

### The Coach

```typescript
interface CoachAI {
  playbook: Playbook;
  personality: CoachPersonality;
  gameState: CoachGameState;
}

interface CoachPersonality {
  aggressiveness: number;    // 0-100: push pace vs control
  playCallingFreq: number;   // How often to call set plays vs motion
  trustInStars: number;      // How much ISO/freedom for stars
  adaptSpeed: number;        // How fast to adjust strategy mid-game
}

interface Playbook {
  setPlays: SetPlay[];
  actions: ActionCall[];
  motionSystems: MotionOffense[];
  ato: SetPlay[];             // After timeout specials
  slob: SetPlay[];            // Sideline out of bounds
  blob: SetPlay[];            // Baseline out of bounds
  lastShot: SetPlay[];        // End of quarter/game
  pressBreakers: SetPlay[];   // Against full-court press
  zoneBeaters: SetPlay[];     // Against zone defense
}
```

### When Plays Are Called

| Situation | Who Decides | Type |
|-----------|-------------|------|
| Dead ball (after score) | Coach | Set play or motion |
| After timeout | Coach | ATO special (usually best play) |
| Live ball (PG crosses half) | PG (or Coach signal) | Action call or motion |
| Shot clock < 8, no play running | Coach signals | Quick hitter or ISO |
| Transition (fast break) | No call — read and react | Freelance |
| SLOB/BLOB | Coach | Special inbound play |
| End of quarter/game | Coach | Last shot play |
| Play broke down | PG audibles | Freelance or simple action |

### Play Selection Logic

```typescript
function selectPlay(
  coach: CoachAI,
  state: GameState,
  offTeam: SimPlayer[],
  defTeam: SimPlayer[]
): PlayCall {

  const context: PlaySelectionContext = {
    scoreDiff: getScoreDiff(state),
    shotClock: state.shotClock,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    defenseType: identifyDefense(defTeam, state),
    lastPlayResult: state.lastPlayResult,
    recentPlays: state.recentPlays.slice(-5),
    isAfterTimeout: state.isAfterTimeout,
    isInbound: state.inboundType,
  };

  // 1. Special situations override
  if (context.clockSeconds < 5 && context.quarter >= 4) {
    return pickBestFrom(coach.playbook.lastShot, context, offTeam);
  }
  if (context.isAfterTimeout) {
    return pickBestFrom(coach.playbook.ato, context, offTeam);
  }
  if (context.isInbound === 'sideline') {
    return pickBestFrom(coach.playbook.slob, context, offTeam);
  }
  if (context.isInbound === 'baseline') {
    return pickBestFrom(coach.playbook.blob, context, offTeam);
  }
  if (context.defenseType === 'zone') {
    return pickBestFrom(coach.playbook.zoneBeaters, context, offTeam);
  }

  // 2. Transition — no set play
  if (state.phase === 'advance' && state.advanceClock < 4) {
    return { type: 'transition' };
  }

  // 3. Score all options
  const candidates: ScoredPlay[] = [];

  // Set plays
  for (const play of coach.playbook.setPlays) {
    const score = scorePlayCandidate(play, context, offTeam, defTeam, coach);
    candidates.push({ play: { type: 'set', play }, score });
  }

  // Action calls
  for (const action of coach.playbook.actions) {
    const score = scoreActionCandidate(action, context, offTeam, defTeam, coach);
    candidates.push({ play: { type: 'action', action }, score });
  }

  // Motion systems
  for (const motion of coach.playbook.motionSystems) {
    candidates.push({ play: { type: 'motion', motion }, score: 0.45 });
  }

  // Freelance (always available, lowest base score)
  candidates.push({ play: { type: 'freelance' }, score: 0.30 });

  // Add noise and select
  for (const c of candidates) {
    c.score += (state.rng() - 0.5) * 0.15;
  }
  candidates.sort((a, b) => b.score - a.score);

  return candidates[0].play;
}

function scorePlayCandidate(
  play: SetPlay,
  context: PlaySelectionContext,
  offTeam: SimPlayer[],
  defTeam: SimPlayer[],
  coach: CoachAI
): number {
  let score = 0;

  // Defense matchup
  if (play.bestAgainst.includes(context.defenseType)) score += 0.30;

  // Personnel fit — do we have the right players?
  score += evaluatePersonnelFit(play, offTeam) * 0.25;

  // Recent success rate
  score += getRecentSuccessRate(play.name, coach.gameState) * 0.15;

  // Avoid repetition
  const timesRecent = context.recentPlays.filter(p => p === play.name).length;
  score -= timesRecent * 0.20;

  // Enough shot clock for this play?
  const estimatedDuration = estimatePlayDuration(play);
  if (context.shotClock < estimatedDuration + 4) score -= 0.15;

  // Coach personality
  if (play.category === 'isolation' && coach.personality.trustInStars > 70) score += 0.10;
  if (play.tempo === 'halfcourt' && coach.personality.aggressiveness < 40) score += 0.05;

  return score;
}
```

### PG Audibles

The point guard can override or modify the coach's call:

```typescript
function pgAudible(
  pg: SimPlayer,
  coachCall: PlayCall,
  state: GameState
): PlayCall {
  const pgBBIQ = pg.player.skills.mental.bbiq || 50;
  const pgCompliance = getComplianceScore(pg, state);

  // High compliance PGs rarely audible
  if (state.rng() < pgCompliance) return coachCall;

  // Low compliance + high BBIQ = smart audible
  // Low compliance + low BBIQ = bad audible
  if (pgBBIQ > 70) {
    // Smart audible — sees something coach didn't
    const betterPlay = findBetterPlayForSituation(pg, state);
    if (betterPlay && betterPlay.score > coachCall.score + 0.15) {
      return betterPlay;
    }
  } else {
    // Dumb audible — just calls ISO for himself
    return { type: 'action', action: ISO_PLAY, primaryOption: pg.id };
  }

  return coachCall;
}
```

---

## Play Execution Engine

How plays run tick-by-tick:

```typescript
interface PlayExecution {
  call: PlayCall;
  currentPhase: string;
  phaseTimer: number;
  roleAssignments: Map<string, SimPlayer>;

  // Tracking
  started: boolean;
  completed: boolean;
  broken: boolean;
  branchHistory: string[];
  result: 'score' | 'miss' | 'turnover' | 'foul' | 'ongoing';
}

function executePlayTick(
  exec: PlayExecution,
  state: GameState,
  dt: number
): void {
  if (exec.completed || exec.broken) return;

  exec.phaseTimer += dt;
  const phase = getPhase(exec.call, exec.currentPhase);
  if (!phase) { exec.completed = true; return; }

  // Apply each role's action
  for (const [roleName, action] of Object.entries(phase.assignments)) {
    const player = exec.roleAssignments.get(roleName);
    if (!player) continue;

    // Compliance check — does this player follow the play?
    const compliance = getComplianceScore(player, state);
    if (state.rng() < compliance) {
      // Follow the play
      const command = resolveAction(action, player, state, exec);
      applyCommand(player, command, state);
    } else {
      // Freelance — player's utility AI takes over
      // Player ignores the play assignment this tick
    }
  }

  // Check phase trigger
  if (checkPhaseTrigger(phase.until, exec, state)) {
    // Evaluate reads (branches)
    for (const read of phase.reads) {
      if (evaluateRead(read, exec, state)) {
        exec.branchHistory.push(read.then);
        exec.currentPhase = read.then;
        exec.phaseTimer = 0;
        if (read.stop) exec.completed = true;
        return;
      }
    }

    // No read matched — check for next sequential phase
    const nextPhase = getNextPhase(exec.call, exec.currentPhase);
    if (nextPhase) {
      exec.currentPhase = nextPhase.name;
      exec.phaseTimer = 0;
    } else {
      exec.completed = true;
    }
  }

  // Safety: play shouldn't run forever
  if (exec.phaseTimer > (phase.maxDuration || 5.0)) {
    exec.broken = true;
  }
}
```

### Phase Trigger Types

```typescript
function checkPhaseTrigger(
  trigger: PhaseTrigger,
  exec: PlayExecution,
  state: GameState
): boolean {
  switch (trigger.type) {
    case 'position':
      // Player reached their assigned spot
      const player = exec.roleAssignments.get(trigger.role);
      if (!player) return false;
      const targetPos = resolveTargetPos(trigger, exec, state);
      return dist(player.pos, targetPos) < (trigger.within || 3);

    case 'screen_contact':
      // Screen has been set and ball handler is using it
      return isScreenEngaged(exec, state);

    case 'screen_cleared':
      // Runner has gotten past the screen
      const runner = exec.roleAssignments.get(trigger.role);
      const screener = exec.roleAssignments.get(trigger.screener);
      return runner && screener && hasRunnerClearedScreen(runner, screener, state);

    case 'pass':
      // A pass was made
      return state.lastAction === 'pass';

    case 'shot_or_pass':
      // Shot attempted or pass made
      return state.lastAction === 'shot' || state.lastAction === 'pass';

    case 'time':
      // Fixed time elapsed
      return exec.phaseTimer >= trigger.seconds;

    case 'play_complete':
      // Catch-all: shot clock < 6 or action completed
      return state.shotClock < 6;
  }
}
```

### Read Evaluation

```typescript
function evaluateRead(
  read: PlayRead,
  exec: PlayExecution,
  state: GameState
): boolean {
  const condition = read.if;

  switch (condition.type) {
    case 'player_open':
      const player = exec.roleAssignments.get(condition.role);
      return player ? checkIfOpen(player, state) : false;

    case 'switch':
      return detectSwitch(
        exec.roleAssignments.get(condition.between[0]),
        exec.roleAssignments.get(condition.between[1]),
        state
      );

    case 'trap':
      const trapped = exec.roleAssignments.get(condition.on);
      return trapped ? countDefendersNear(trapped, state, 4) >= 2 : false;

    case 'drop_coverage':
      return detectDropCoverage(exec, condition.by, state);

    case 'help_rotation':
      return detectHelpRotation(condition.from, state);

    case 'hard_closeout':
      const target = exec.roleAssignments.get(condition.on);
      return target ? isDefenderClosingOutHard(target, state) : false;

    case 'defender_went_under':
      return detectDefenderWentUnder(exec, condition.for, state);

    case 'advantage':
      return getNumbersAdvantage(state) >= (condition.min || 1);

    case 'default':
      return true;
  }
}
```

---

## Variation Sources

Why the same play looks different every time:

### Source 1: Defensive Reads (Branch Selection)

Same Horns PnR, 5 different defenses = 5 different outcomes:

```
Run 1: Defense drops         → PG pull-up jumper from elbow
Run 2: Defense switches      → C posts up smaller guard
Run 3: Defense traps         → Swing pass → 4v3 attack
Run 4: Standard hedge        → C rolls, PG kicks to corner 3
Run 5: Help from weak side   → Skip pass to open wing
```

### Source 2: Entry Variations (Play Families)

Same concept, different starting points:

```typescript
interface PlayFamily {
  concept: string;
  entries: PlayEntry[];
}

const HORNS_FAMILY: PlayFamily = {
  concept: "Horns",
  entries: [
    { name: "Horns PnR Right",      mirror: false, screener: 'C' },
    { name: "Horns PnR Left",       mirror: true,  screener: 'C' },
    { name: "Horns PnR PF Right",   mirror: false, screener: 'PF' },
    { name: "Horns PnR PF Left",    mirror: true,  screener: 'PF' },
    { name: "Horns DHO Right",      action: 'dribble_handoff' },
    { name: "Horns DHO Left",       action: 'dribble_handoff', mirror: true },
    { name: "Horns Floppy",         action: 'pin_down_to_pnr' },
    { name: "Horns Split",          action: 'split_action' },
  ],
};
// 8 entries × 5 branches = 40 possible outcomes from one family
```

### Source 3: Player Execution Variance

Same play, same branch, but different execution because of:

```
Compliance variance:
  → Screener with 60% compliance sometimes sets bad angle
  → Bad angle changes defender reaction → different branch

Skill variance:
  → PG with 70 passing → ball arrives slightly late
  → Defender recovers → shooter contested instead of open

Tendency variance:
  → SG with high isoTendency → ignores "space corner" assignment
  → Freelances into dribble move instead

BBIQ variance:
  → Low BBIQ cutter → cuts too early
  → Play timing is off → play breaks down → improvise

Physical variance:
  → Slow center → can't get to screen position in time
  → PG has to hold ball longer → shot clock burns
```

### Source 4: Motion Rules (Infinite Variation)

Motion offense is rule-based, not scripted — every possession is unique:

```
Same 5-Out Motion, 5 different runs:

Run 1: PG passes wing → screens away → SG comes off screen → shoots 3
Run 2: PG passes wing → SG's defender helps → SG backdoor cuts → layup
Run 3: PG passes wing → ball stagnant 3s → C sets ball screen → PnR
Run 4: PG passes wing → screens away → PF pops → PF shoots mid-range
Run 5: PG passes wing → ball reversed → SF pin-down → SF curls for floater
```

**Same rules produce completely different sequences because defense is different each time.**

### Variation Math

```
Set play families:      ~6 families
Entries per family:     ×3-8 entries
Mirror (left/right):   ×2
Defensive branches:     ×3-7 per entry
Compliance noise:       continuous
Skill execution noise:  continuous
Motion systems:         3 systems × infinite variation
────────────────────────────────────────────────────
Unique-feeling possessions: effectively infinite
```

Conservative estimate with just 15 set plays:
- 15 plays × 2 mirrors × 5 avg branches = **150 scripted outcomes**
- 12 action calls × 2 mirrors × 3 branches = **72 more**
- 3 motion systems = **∞ emergent variations**
- Execution variance = every run is unique even with same play + branch

---

## Suggested Starting Playbook

### Set Plays (16)

```
Horns Family (4):
├─ Horns PnR Right
├─ Horns PnR Left
├─ Horns DHO Right
└─ Horns Split

Floppy Family (3):
├─ Floppy Right
├─ Floppy Left
└─ Floppy Hammer (back-screen variation)

Flex Family (3):
├─ Flex Basic
├─ Flex Stagger
└─ Flex Continuity (loops back into itself)

Elevator (2):
├─ Elevator Screen
└─ Elevator to PnR

Specials (4):
├─ ATO Box Set
├─ ATO Stack Alley
├─ SLOB Stagger
└─ BLOB Flex
```

### Action Calls (10)

```
PnR (4):      High Right, High Left, Side Right, Side Left
DHO (2):      Wing DHO, Elbow DHO
Pin-Down (2): Single Pin, Stagger Pin
ISO (1):      Wing Isolation
Post-Up (1):  Block Post-Up
```

### Motion Systems (3)

```
5-Out Motion:      Spacing-first, 3PT-heavy teams
4-Out 1-In:        Traditional, one big in paint
Princeton:         Pass-cut-replace, high BBIQ teams
```

### Coverage

| Game Situation | Coverage |
|----------------|----------|
| Halfcourt vs man | 16 set plays + 10 actions + 3 motions |
| Halfcourt vs zone | Zone-specific plays (TODO) |
| Halfcourt vs switch | Horns + ISO + post mismatch |
| Transition | Freelance (no play needed) |
| After timeout | 2 ATO specials |
| SLOB/BLOB | 2 inbound plays |
| End of game | Horns PnR + ISO (best plays for stars) |
| Press break | TODO |

---

## Open Questions

1. **Play creation tool** — Should we build a visual play designer? Or is code-based definition sufficient?
2. **Play learning** — Should the coach AI learn which plays work mid-game and adjust frequency?
3. **Defensive plays** — This doc covers offense. Defense needs its own system (man, zone, switching rules, trapping triggers).
4. **Continuity plays** — Plays that loop back (like Flex Continuity) — how to handle infinite loops?
5. **Personnel groupings** — Same play but different lineup = different role assignments. How smart should this be?
6. **Scouting report integration** — Should the coach have a pre-game plan based on opponent tendencies?
7. **Play success tracking** — How to measure if a play "worked"? (Score, good shot, turnover, shot clock violation)

---

*This document is a living design spec. Update as decisions are made.*
