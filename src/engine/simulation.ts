import {
  Team, Player, PlayerGameStats, PlayByPlayEntry, QuarterScore, GameResult,
  OffenseTactic, DefenseTactic,
} from './types';
import { createRng, Rng, skillModifier, formatTime, pickWeighted } from './utils';
import { getTacticAdvantage } from './tactics';

const QUARTER_LENGTH = 720; // 12 min in seconds
const SHOT_CLOCK = 24;
const QUARTERS = 4;

interface PossessionContext {
  offTeam: Team;
  defTeam: Team;
  offTactic: OffenseTactic;
  defTactic: DefenseTactic;
  offStats: PlayerGameStats[];
  defStats: PlayerGameStats[];
  scoreOff: number;
  scoreDef: number;
  quarter: number;
  clock: number;
  rng: Rng;
  playByPlay: PlayByPlayEntry[];
  isHome: boolean;
  momentum: Record<string, number>;
  fatigue: Record<string, number>;
}

function initStats(team: Team): PlayerGameStats[] {
  return team.players.map(p => ({
    playerId: p.id, minutes: 0, points: 0,
    fgMade: 0, fgAttempted: 0, threeMade: 0, threeAttempted: 0,
    ftMade: 0, ftAttempted: 0, rebounds: 0, assists: 0,
    steals: 0, blocks: 0, turnovers: 0, fouls: 0, plusMinus: 0,
  }));
}

function getStat(stats: PlayerGameStats[], id: string) {
  return stats.find(s => s.playerId === id)!;
}

function fatigueModifier(fatigue: number, stamina: number): number {
  const staminaPercent = fatigue / stamina;
  if (staminaPercent < 0.30) return 0.85;
  return 1.0;
}

function superstarBonus(player: Player, momentum: Record<string, number>): number {
  if (!player.isSuperstar) return 0;
  const m = momentum[player.id] || 0;
  if (m >= 3) return 0.10;
  return 0;
}

function pickShooter(ctx: PossessionContext, isFastBreak: boolean): { shooter: Player; assister: Player | null; playType: string } {
  const { offTeam, offTactic, rng, momentum } = ctx;
  const players = offTeam.players;

  // Build weights based on tactic and skills
  const weights = players.map(p => {
    let w = 10;
    const bonus = superstarBonus(p, momentum);
    if (p.isSuperstar && (momentum[p.id] || 0) >= 3) w += 15;

    switch (offTactic) {
      case 'shoot':
        w += (p.skills.shooting.three_point + p.skills.shooting.mid_range) / 5;
        break;
      case 'inside':
        w += (p.skills.finishing.layup + p.skills.finishing.dunk + p.skills.finishing.post_move) / 6;
        break;
      case 'iso':
        w += (p.skills.playmaking.ball_handling + p.skills.shooting.mid_range) / 5;
        if (p.isSuperstar) w += 15;
        break;
      case 'fast_break':
        w += p.physical.speed / 5;
        break;
      case 'motion':
        w += (p.skills.athletic.off_ball_movement + p.skills.shooting.catch_and_shoot) / 5;
        break;
    }
    w *= (1 + bonus);
    return { item: p, weight: Math.max(w, 1) };
  });

  const shooter = pickWeighted(weights, rng);

  // Determine if there's an assister
  let assister: Player | null = null;
  const potentialAssisters = players.filter(p => p.id !== shooter.id);
  if (rng() < 0.65) { // ~65% of made shots are assisted
    const aWeights = potentialAssisters.map(p => ({
      item: p,
      weight: (p.skills.playmaking.passing + p.skills.playmaking.court_vision) / 2,
    }));
    assister = pickWeighted(aWeights, rng);
  }

  // Determine play type
  let playType: string;
  if (isFastBreak) {
    playType = rng() < 0.5 ? 'fastbreak_layup' : 'fastbreak_dunk';
  } else {
    const options: { item: string; weight: number }[] = [];
    options.push({ item: 'three', weight: skillModifier(shooter.skills.shooting.three_point) * 40 });
    options.push({ item: 'midrange', weight: skillModifier(shooter.skills.shooting.mid_range) * 30 });
    options.push({ item: 'layup', weight: skillModifier(shooter.skills.finishing.layup) * 25 });
    options.push({ item: 'dunk', weight: skillModifier(shooter.skills.finishing.dunk) * (shooter.physical.vertical > 70 ? 15 : 5) });
    options.push({ item: 'post', weight: skillModifier(shooter.skills.finishing.post_move) * (shooter.position === 'C' || shooter.position === 'PF' ? 20 : 5) });
    options.push({ item: 'floater', weight: skillModifier(shooter.skills.finishing.floater) * 10 });
    playType = pickWeighted(options, rng);
  }

  return { shooter, assister, playType };
}

function resolveShot(ctx: PossessionContext, shooter: Player, playType: string, defender: Player): { made: boolean; isThree: boolean; blocked: boolean } {
  const { rng, offTactic, defTactic, momentum, fatigue } = ctx;
  const tacticAdv = getTacticAdvantage(offTactic, defTactic);
  const fatMod = fatigueModifier(fatigue[shooter.id] || 100, shooter.physical.stamina);
  const sBonus = superstarBonus(shooter, momentum);

  let baseChance: number;
  let isThree = false;

  switch (playType) {
    case 'three':
      baseChance = 0.34;
      isThree = true;
      baseChance *= skillModifier(shooter.skills.shooting.three_point);
      break;
    case 'midrange':
      baseChance = 0.42;
      baseChance *= skillModifier(shooter.skills.shooting.mid_range);
      break;
    case 'layup':
    case 'fastbreak_layup':
      baseChance = 0.55;
      baseChance *= skillModifier(shooter.skills.finishing.layup);
      break;
    case 'dunk':
    case 'fastbreak_dunk':
      baseChance = 0.65;
      baseChance *= skillModifier(shooter.skills.finishing.dunk);
      break;
    case 'post':
      baseChance = 0.45;
      baseChance *= skillModifier(shooter.skills.finishing.post_move);
      break;
    case 'floater':
      baseChance = 0.40;
      baseChance *= skillModifier(shooter.skills.finishing.floater);
      break;
    default:
      baseChance = 0.42;
  }

  // Defense impact
  const defSkill = isThree || playType === 'midrange'
    ? skillModifier(defender.skills.defense.perimeter_d)
    : skillModifier(defender.skills.defense.interior_d);
  const contestMod = skillModifier(defender.skills.defense.shot_contest);
  baseChance *= (1 - (defSkill * contestMod - 0.5) * 0.3);

  // Apply tactic, fatigue, superstar
  baseChance *= (1 + tacticAdv);
  baseChance *= fatMod;
  baseChance *= (1 + sBonus);

  // Fast break bonus
  if (playType.startsWith('fastbreak')) baseChance *= 1.15;

  // Clamp
  baseChance = Math.max(0.15, Math.min(0.85, baseChance));

  // Block check
  const blockChance = skillModifier(defender.skills.defense.block) * 0.06 *
    (defender.physical.height > shooter.physical.height ? 1.2 : 0.8);
  const blocked = rng() < blockChance;
  if (blocked) return { made: false, isThree, blocked: true };

  return { made: rng() < baseChance, isThree, blocked: false };
}

function getMatchupDefender(shooter: Player, defTeam: Team, rng: Rng): Player {
  // Position-based matchup with some randomness
  const posIndex = defTeam.players.findIndex(p => p.position === shooter.position);
  if (posIndex >= 0 && rng() < 0.7) return defTeam.players[posIndex];
  return defTeam.players[Math.floor(rng() * defTeam.players.length)];
}

function generatePlayText(
  shooter: Player, assister: Player | null, playType: string,
  made: boolean, blocked: boolean, isThree: boolean,
  offTeam: Team, scoreHome: number, scoreAway: number, isHome: boolean, rng: Rng
): string {
  const shooterName = shooter.name.split(' ').pop();
  const fullName = shooter.name;

  const shotDescriptions: Record<string, string[]> = {
    three: [`pulls up from deep`, `fires from three`, `launches a three-pointer`, `steps back and shoots from downtown`],
    midrange: [`hits the mid-range jumper`, `pulls up from the elbow`, `nails the fadeaway`, `shoots from mid-range`],
    layup: [`drives to the basket`, `takes it to the rim`, `attacks the lane`, `slices through the defense`],
    dunk: [`throws it down`, `rises up for the slam`, `explodes to the rim`, `hammers it home`],
    post: [`backs down in the post`, `works the post`, `goes to work in the paint`, `spins in the post`],
    floater: [`floats one up`, `drops a floater`, `tosses up a teardrop`, `releases a soft floater`],
    fastbreak_layup: [`races down the court for the layup`, `finishes in transition`, `gets the easy bucket in transition`],
    fastbreak_dunk: [`throws down the fast break dunk`, `finishes with authority in transition`, `slams it on the break`],
  };

  const desc = shotDescriptions[playType] || [`takes the shot`];
  const shotDesc = desc[Math.floor(rng() * desc.length)];

  let text = '';
  if (assister && made) {
    const assistName = assister.name.split(' ').pop();
    text = `${assistName} finds ${fullName}, who ${shotDesc}...`;
  } else {
    text = `${fullName} ${shotDesc}...`;
  }

  if (blocked) {
    text += ` BLOCKED!`;
  } else if (made) {
    if (isThree) {
      const excl = ['BANG!', 'SPLASH!', 'MONEY!', 'DRAINS IT!'][Math.floor(rng() * 4)];
      text += ` ${excl} Three pointer!`;
    } else if (playType.includes('dunk')) {
      text += ` AND THE SLAM! What a play!`;
    } else {
      text += ` ${['Good!', 'Count it!', 'Scores!', 'Bucket!'][Math.floor(rng() * 4)]}`;
    }
    const [h, a] = isHome ? [scoreHome, scoreAway] : [scoreAway, scoreHome];
    text += ` ${h}-${a}`;
  } else {
    text += ` ${['No good.', 'Misses.', 'Rims out.', 'Off the mark.'][Math.floor(rng() * 4)]}`;
  }

  return text;
}

function simulatePossession(ctx: PossessionContext): { pointsScored: number; possessionTime: number } {
  const { offTeam, defTeam, rng, offStats, defStats, quarter, clock, playByPlay, isHome, momentum, fatigue, offTactic } = ctx;

  // Time consumed: 8-24 seconds
  const possTime = 8 + Math.floor(rng() * 16);
  const timeStr = formatTime(Math.max(0, clock));

  // Add minutes for all players
  const minFraction = possTime / 60;
  offTeam.players.forEach(p => { getStat(offStats, p.id).minutes += minFraction; });
  defTeam.players.forEach(p => { getStat(defStats, p.id).minutes += minFraction; });

  // Drain fatigue
  offTeam.players.forEach(p => {
    fatigue[p.id] = Math.max(0, (fatigue[p.id] ?? p.physical.stamina) - (1.2 + rng() * 0.8));
  });
  defTeam.players.forEach(p => {
    fatigue[p.id] = Math.max(0, (fatigue[p.id] ?? p.physical.stamina) - (0.8 + rng() * 0.6));
  });

  // Turnover check (~13% of possessions)
  const ballHandler = offTeam.players.reduce((best, p) =>
    p.skills.playmaking.ball_handling > best.skills.playmaking.ball_handling ? p : best
  );
  const turnoverChance = 0.13 - skillModifier(ballHandler.skills.playmaking.ball_handling) * 0.03
    + (offTactic === 'fast_break' ? 0.02 : 0);

  // Steal check
  const bestStealer = defTeam.players.reduce((best, p) =>
    p.skills.defense.steal > best.skills.defense.steal ? p : best
  );
  const stealChance = skillModifier(bestStealer.skills.defense.steal) * 0.07;

  if (rng() < stealChance) {
    getStat(defStats, bestStealer.id).steals += 1;
    getStat(offStats, ballHandler.id).turnovers += 1;
    const stealerName = bestStealer.name;
    const handlerName = ballHandler.name.split(' ').pop();
    playByPlay.push({
      quarter, time: timeStr,
      text: `${stealerName} picks ${handlerName}'s pocket! Turnover!`,
      scoreHome: isHome ? ctx.scoreOff : ctx.scoreDef,
      scoreAway: isHome ? ctx.scoreDef : ctx.scoreOff,
    });
    return { pointsScored: 0, possessionTime: Math.min(possTime, 6) };
  }

  if (rng() < turnoverChance) {
    const handler = pickWeighted(offTeam.players.map(p => ({
      item: p,
      weight: p.skills.playmaking.ball_handling > 60 ? 30 : 10,
    })), rng);
    getStat(offStats, handler.id).turnovers += 1;
    const toTexts = [`${handler.name} loses the handle. Turnover.`, `Bad pass by ${handler.name}. Turnover.`, `${handler.name} steps out of bounds. Turnover.`];
    playByPlay.push({
      quarter, time: timeStr,
      text: toTexts[Math.floor(rng() * toTexts.length)],
      scoreHome: isHome ? ctx.scoreOff : ctx.scoreDef,
      scoreAway: isHome ? ctx.scoreDef : ctx.scoreOff,
    });
    return { pointsScored: 0, possessionTime: possTime };
  }

  // Fast break check
  const isFastBreak = offTactic === 'fast_break' && rng() < 0.25;

  // Pick shooter and play
  const { shooter, assister, playType } = pickShooter(ctx, isFastBreak);
  const defender = getMatchupDefender(shooter, defTeam, rng);
  const { made, isThree, blocked } = resolveShot(ctx, shooter, playType, defender);

  const shooterStats = getStat(offStats, shooter.id);
  const pts = isThree ? 3 : 2;

  shooterStats.fgAttempted += 1;
  if (isThree) shooterStats.threeAttempted += 1;

  if (blocked) {
    const blockerStats = getStat(defStats, defender.id);
    blockerStats.blocks += 1;
  }

  let pointsScored = 0;

  if (made) {
    shooterStats.fgMade += 1;
    shooterStats.points += pts;
    if (isThree) shooterStats.threeMade += 1;
    pointsScored = pts;

    if (assister) {
      getStat(offStats, assister.id).assists += 1;
    }

    // Momentum
    momentum[shooter.id] = (momentum[shooter.id] || 0) + 1;
    // Reset others' momentum
    offTeam.players.forEach(p => { if (p.id !== shooter.id) momentum[p.id] = Math.max(0, (momentum[p.id] || 0) - 0.5); });

    // And-1 chance (3%)
    if (rng() < 0.03) {
      const defStats2 = getStat(defStats, defender.id);
      defStats2.fouls += 1;
      const ftMod = skillModifier(shooter.skills.shooting.free_throw);
      if (rng() < 0.55 + ftMod * 0.25) {
        shooterStats.ftMade += 1;
        shooterStats.ftAttempted += 1;
        shooterStats.points += 1;
        pointsScored += 1;
      } else {
        shooterStats.ftAttempted += 1;
      }
    }
  } else {
    // Reset momentum on miss
    momentum[shooter.id] = Math.max(0, (momentum[shooter.id] || 0) - 1);

    // Rebound
    const offRebChance = 0.27; // ~27% offensive rebound rate
    const isOffRebound = rng() < offRebChance;

    if (isOffRebound) {
      const rebounder = pickWeighted(offTeam.players.map(p => ({
        item: p,
        weight: p.skills.athletic.rebounding + p.physical.height / 5 + (p.skills.defense.box_out * 0.3),
      })), rng);
      getStat(offStats, rebounder.id).rebounds += 1;
      playByPlay.push({
        quarter, time: timeStr,
        text: generatePlayText(shooter, assister, playType, false, blocked, isThree, offTeam, isHome ? ctx.scoreOff : ctx.scoreDef, isHome ? ctx.scoreDef : ctx.scoreOff, isHome, rng)
          + ` ${rebounder.name.split(' ').pop()} grabs the offensive board.`,
        scoreHome: isHome ? ctx.scoreOff : ctx.scoreDef,
        scoreAway: isHome ? ctx.scoreDef : ctx.scoreOff,
      });
      // Second chance - simplified: just take another shot
      const { made: made2, isThree: isThree2 } = resolveShot(ctx, shooter, rng() < 0.4 ? playType : 'layup', defender);
      shooterStats.fgAttempted += 1;
      if (isThree2) shooterStats.threeAttempted += 1;
      if (made2) {
        const pts2 = isThree2 ? 3 : 2;
        shooterStats.fgMade += 1;
        shooterStats.points += pts2;
        if (isThree2) shooterStats.threeMade += 1;
        pointsScored = pts2;
      }
      return { pointsScored, possessionTime: possTime + 6 };
    } else {
      const rebounder = pickWeighted(defTeam.players.map(p => ({
        item: p,
        weight: p.skills.athletic.rebounding + p.physical.height / 5 + (p.skills.defense.box_out * 0.3),
      })), rng);
      getStat(defStats, rebounder.id).rebounds += 1;
    }
  }

  // Foul chance on miss (shooting foul -> free throws) ~15% of misses
  if (!made && !blocked && rng() < 0.15) {
    const defStats2 = getStat(defStats, defender.id);
    defStats2.fouls += 1;
    const ftCount = isThree ? 3 : 2;
    const ftMod = skillModifier(shooter.skills.shooting.free_throw);
    let ftPoints = 0;
    for (let i = 0; i < ftCount; i++) {
      shooterStats.ftAttempted += 1;
      if (rng() < 0.55 + ftMod * 0.28) {
        shooterStats.ftMade += 1;
        shooterStats.points += 1;
        ftPoints += 1;
      }
    }
    pointsScored = ftPoints;
    const ftText = ftPoints === ftCount ? `${shooter.name} hits all ${ftCount} free throws.`
      : `${shooter.name} goes ${ftPoints}-${ftCount} from the line.`;
    playByPlay.push({
      quarter, time: timeStr,
      text: `Foul on the play! ${ftText}`,
      scoreHome: isHome ? ctx.scoreOff + ftPoints : ctx.scoreDef,
      scoreAway: isHome ? ctx.scoreDef : ctx.scoreOff + ftPoints,
    });
    return { pointsScored: ftPoints, possessionTime: possTime };
  }

  // Generate play-by-play
  const scoreH = isHome ? ctx.scoreOff + pointsScored : ctx.scoreDef;
  const scoreA = isHome ? ctx.scoreDef : ctx.scoreOff + pointsScored;
  playByPlay.push({
    quarter, time: timeStr,
    text: generatePlayText(shooter, assister, playType, made, blocked, isThree, offTeam, scoreH, scoreA, isHome, rng),
    scoreHome: scoreH,
    scoreAway: scoreA,
  });

  return { pointsScored, possessionTime: possTime };
}

export function simulateGame(
  homeTeam: Team, awayTeam: Team,
  homeTacticOff: OffenseTactic, homeTacticDef: DefenseTactic,
  awayTacticOff: OffenseTactic, awayTacticDef: DefenseTactic,
  seed: number
): GameResult {
  const rng = createRng(seed);
  const homeStats = initStats(homeTeam);
  const awayStats = initStats(awayTeam);
  const playByPlay: PlayByPlayEntry[] = [];
  const quarterScores: QuarterScore[] = [];
  const momentum: Record<string, number> = {};
  const fatigue: Record<string, number> = {};

  // Initialize fatigue
  [...homeTeam.players, ...awayTeam.players].forEach(p => {
    fatigue[p.id] = p.physical.stamina;
  });

  let totalHome = 0;
  let totalAway = 0;

  for (let q = 1; q <= QUARTERS; q++) {
    let clock = QUARTER_LENGTH;
    let qHome = 0;
    let qAway = 0;
    let homeHasBall = q % 2 === 1; // Alternate possession

    // Partial fatigue recovery between quarters
    if (q > 1) {
      [...homeTeam.players, ...awayTeam.players].forEach(p => {
        fatigue[p.id] = Math.min(p.physical.stamina, (fatigue[p.id] || 0) + p.physical.stamina * 0.15);
      });
    }

    playByPlay.push({
      quarter: q, time: '12:00',
      text: q === 1 ? `--- TIP OFF! Quarter ${q} begins ---` : `--- Quarter ${q} begins ---`,
      scoreHome: totalHome, scoreAway: totalAway,
    });

    while (clock > 0) {
      const ctx: PossessionContext = {
        offTeam: homeHasBall ? homeTeam : awayTeam,
        defTeam: homeHasBall ? awayTeam : homeTeam,
        offTactic: homeHasBall ? homeTacticOff : awayTacticOff,
        defTactic: homeHasBall ? awayTacticDef : homeTacticDef,
        offStats: homeHasBall ? homeStats : awayStats,
        defStats: homeHasBall ? awayStats : homeStats,
        scoreOff: homeHasBall ? totalHome + qHome : totalAway + qAway,
        scoreDef: homeHasBall ? totalAway + qAway : totalHome + qHome,
        quarter: q, clock, rng, playByPlay, isHome: homeHasBall, momentum, fatigue,
      };

      const result = simulatePossession(ctx);

      if (homeHasBall) {
        qHome += result.pointsScored;
      } else {
        qAway += result.pointsScored;
      }

      clock -= result.possessionTime;

      // Update +/- for the possession
      if (result.pointsScored > 0) {
        const scoringStats = homeHasBall ? homeStats : awayStats;
        const otherStats = homeHasBall ? awayStats : homeStats;
        scoringStats.forEach(s => s.plusMinus += result.pointsScored);
        otherStats.forEach(s => s.plusMinus -= result.pointsScored);
      }

      homeHasBall = !homeHasBall;
    }

    totalHome += qHome;
    totalAway += qAway;
    quarterScores.push({ home: qHome, away: qAway });

    playByPlay.push({
      quarter: q, time: '0:00',
      text: `--- End of Quarter ${q} | ${homeTeam.name} ${totalHome} - ${awayTeam.name} ${totalAway} ---`,
      scoreHome: totalHome, scoreAway: totalAway,
    });
  }

  // Overtime periods if tied (5 min each)
  let otPeriod = 0;
  while (totalHome === totalAway) {
    otPeriod++;
    const q = QUARTERS + otPeriod;
    let clock = 300; // 5 min OT
    let qHome = 0;
    let qAway = 0;
    let homeHasBall = otPeriod % 2 === 1;

    // OT fatigue recovery
    [...homeTeam.players, ...awayTeam.players].forEach(p => {
      fatigue[p.id] = Math.min(p.physical.stamina, (fatigue[p.id] || 0) + p.physical.stamina * 0.10);
    });

    playByPlay.push({
      quarter: q, time: '5:00',
      text: `--- OVERTIME ${otPeriod}! ---`,
      scoreHome: totalHome, scoreAway: totalAway,
    });

    while (clock > 0) {
      const ctx: PossessionContext = {
        offTeam: homeHasBall ? homeTeam : awayTeam,
        defTeam: homeHasBall ? awayTeam : homeTeam,
        offTactic: homeHasBall ? homeTacticOff : awayTacticOff,
        defTactic: homeHasBall ? awayTacticDef : homeTacticDef,
        offStats: homeHasBall ? homeStats : awayStats,
        defStats: homeHasBall ? awayStats : homeStats,
        scoreOff: homeHasBall ? totalHome + qHome : totalAway + qAway,
        scoreDef: homeHasBall ? totalAway + qAway : totalHome + qHome,
        quarter: q, clock, rng, playByPlay, isHome: homeHasBall, momentum, fatigue,
      };

      const result = simulatePossession(ctx);

      if (homeHasBall) {
        qHome += result.pointsScored;
      } else {
        qAway += result.pointsScored;
      }

      clock -= result.possessionTime;

      if (result.pointsScored > 0) {
        const scoringStats = homeHasBall ? homeStats : awayStats;
        const otherStats = homeHasBall ? awayStats : homeStats;
        scoringStats.forEach(s => s.plusMinus += result.pointsScored);
        otherStats.forEach(s => s.plusMinus -= result.pointsScored);
      }

      homeHasBall = !homeHasBall;
    }

    totalHome += qHome;
    totalAway += qAway;
    quarterScores.push({ home: qHome, away: qAway });

    playByPlay.push({
      quarter: q, time: '0:00',
      text: `--- End of OT${otPeriod} | ${homeTeam.name} ${totalHome} - ${awayTeam.name} ${totalAway} ---`,
      scoreHome: totalHome, scoreAway: totalAway,
    });

    // Safety: max 5 OT periods
    if (otPeriod >= 5 && totalHome === totalAway) {
      // Force break tie with a free throw
      if (rng() < 0.5) totalHome += 1; else totalAway += 1;
    }
  }

  // Round minutes
  homeStats.forEach(s => s.minutes = Math.round(s.minutes * 10) / 10);
  awayStats.forEach(s => s.minutes = Math.round(s.minutes * 10) / 10);

  return {
    homeStats, awayStats, playByPlay, quarterScores,
    finalScoreHome: totalHome, finalScoreAway: totalAway, seed,
  };
}
