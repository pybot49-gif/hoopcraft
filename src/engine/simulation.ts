import {
  Team, Player, PlayerGameStats, PlayByPlayEntry, QuarterScore, GameResult,
  OffenseTactic, DefenseTactic,
} from './types';
import { createRng, Rng, skillModifier, formatTime, pickWeighted } from './utils';
import { getTacticAdvantage } from './tactics';

const QUARTER_LENGTH = 720; // 12 min in seconds
const QUARTERS = 4;

interface GameState {
  homeTeam: Team;
  awayTeam: Team;
  homeTacticOff: OffenseTactic;
  homeTacticDef: DefenseTactic;
  awayTacticOff: OffenseTactic;
  awayTacticDef: DefenseTactic;
  homeStats: PlayerGameStats[];
  awayStats: PlayerGameStats[];
  scoreHome: number;
  scoreAway: number;
  playByPlay: PlayByPlayEntry[];
  rng: Rng;
  momentum: Record<string, number>;
  fatigue: Record<string, number>;
}

function initStats(team: Team): PlayerGameStats[] {
  return team.players.map(p => ({
    playerId: p.id, minutes: 0, points: 0,
    fgMade: 0, fgAttempted: 0, threeMade: 0, threeAttempted: 0,
    ftMade: 0, ftAttempted: 0,
    rebounds: 0, offRebounds: 0, defRebounds: 0,
    assists: 0, steals: 0, blocks: 0, turnovers: 0, fouls: 0, plusMinus: 0,
  }));
}

function getStat(stats: PlayerGameStats[], id: string) {
  return stats.find(s => s.playerId === id)!;
}

function fatigueModifier(currentFatigue: number, stamina: number): number {
  const pct = currentFatigue / stamina;
  if (pct < 0.30) return 0.85;
  return 1.0;
}

function superstarBonus(player: Player, momentum: Record<string, number>): number {
  if (!player.isSuperstar) return 0;
  return (momentum[player.id] || 0) >= 3 ? 0.10 : 0;
}

function addPBP(state: GameState, quarter: number, time: string, text: string, teamColor?: string, playerName?: string) {
  state.playByPlay.push({
    quarter, time, text,
    scoreHome: state.scoreHome,
    scoreAway: state.scoreAway,
    teamColor, playerName,
  });
}

function addPoints(state: GameState, isHome: boolean, pts: number) {
  if (isHome) state.scoreHome += pts;
  else state.scoreAway += pts;
}

function pickShooter(
  offTeam: Team, offTactic: OffenseTactic, momentum: Record<string, number>, rng: Rng, isFastBreak: boolean
): { shooter: Player; assister: Player | null; playType: string } {
  const players = offTeam.players;

  const weights = players.map(p => {
    let w = 10;
    const bonus = superstarBonus(p, momentum);
    if (p.isSuperstar && (momentum[p.id] || 0) >= 3) w += 15;

    switch (offTactic) {
      case 'shoot':
        w += (p.skills.shooting.three_point + p.skills.shooting.mid_range) / 5; break;
      case 'inside':
        w += (p.skills.finishing.layup + p.skills.finishing.dunk + p.skills.finishing.post_move) / 6; break;
      case 'iso':
        w += (p.skills.playmaking.ball_handling + p.skills.shooting.mid_range) / 5;
        if (p.isSuperstar) w += 15; break;
      case 'fast_break':
        w += p.physical.speed / 5; break;
      case 'motion':
        w += (p.skills.athletic.off_ball_movement + p.skills.shooting.catch_and_shoot) / 5; break;
    }
    w *= (1 + bonus);
    return { item: p, weight: Math.max(w, 1) };
  });

  const shooter = pickWeighted(weights, rng);

  let assister: Player | null = null;
  const potentialAssisters = players.filter(p => p.id !== shooter.id);
  if (rng() < 0.65) {
    const aWeights = potentialAssisters.map(p => ({
      item: p,
      weight: (p.skills.playmaking.passing + p.skills.playmaking.court_vision) / 2,
    }));
    assister = pickWeighted(aWeights, rng);
  }

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

function resolveShot(
  shooter: Player, playType: string, defender: Player,
  offTactic: OffenseTactic, defTactic: DefenseTactic,
  momentum: Record<string, number>, fatigue: Record<string, number>, rng: Rng
): { made: boolean; isThree: boolean; blocked: boolean } {
  const tacticAdv = getTacticAdvantage(offTactic, defTactic);
  const fatMod = fatigueModifier(fatigue[shooter.id] || 100, shooter.physical.stamina);
  const sBonus = superstarBonus(shooter, momentum);

  let baseChance: number;
  let isThree = false;

  switch (playType) {
    case 'three':
      baseChance = 0.34; isThree = true;
      baseChance *= skillModifier(shooter.skills.shooting.three_point); break;
    case 'midrange':
      baseChance = 0.42;
      baseChance *= skillModifier(shooter.skills.shooting.mid_range); break;
    case 'layup': case 'fastbreak_layup':
      baseChance = 0.55;
      baseChance *= skillModifier(shooter.skills.finishing.layup); break;
    case 'dunk': case 'fastbreak_dunk':
      baseChance = 0.65;
      baseChance *= skillModifier(shooter.skills.finishing.dunk); break;
    case 'post':
      baseChance = 0.45;
      baseChance *= skillModifier(shooter.skills.finishing.post_move); break;
    case 'floater':
      baseChance = 0.40;
      baseChance *= skillModifier(shooter.skills.finishing.floater); break;
    default:
      baseChance = 0.42;
  }

  const defSkill = isThree || playType === 'midrange'
    ? skillModifier(defender.skills.defense.perimeter_d)
    : skillModifier(defender.skills.defense.interior_d);
  const contestMod = skillModifier(defender.skills.defense.shot_contest);
  baseChance *= (1 - (defSkill * contestMod - 0.5) * 0.3);

  baseChance *= (1 + tacticAdv);
  baseChance *= fatMod;
  baseChance *= (1 + sBonus);
  if (playType.startsWith('fastbreak')) baseChance *= 1.15;
  baseChance = Math.max(0.15, Math.min(0.85, baseChance));

  const blockChance = skillModifier(defender.skills.defense.block) * 0.06 *
    (defender.physical.height > shooter.physical.height ? 1.2 : 0.8);
  if (rng() < blockChance) return { made: false, isThree, blocked: true };

  return { made: rng() < baseChance, isThree, blocked: false };
}

function getMatchupDefender(shooter: Player, defTeam: Team, rng: Rng): Player {
  const posIndex = defTeam.players.findIndex(p => p.position === shooter.position);
  if (posIndex >= 0 && rng() < 0.7) return defTeam.players[posIndex];
  return defTeam.players[Math.floor(rng() * defTeam.players.length)];
}

function shotDescription(playType: string, rng: Rng): string {
  const descs: Record<string, string[]> = {
    three: ['pulls up from deep', 'fires from three', 'launches a three-pointer', 'steps back and shoots from downtown'],
    midrange: ['hits the mid-range jumper', 'pulls up from the elbow', 'nails the fadeaway', 'shoots from mid-range'],
    layup: ['drives to the basket', 'takes it to the rim', 'attacks the lane', 'slices through the defense'],
    dunk: ['throws it down', 'rises up for the slam', 'explodes to the rim', 'hammers it home'],
    post: ['backs down in the post', 'works the post', 'goes to work in the paint', 'spins in the post'],
    floater: ['floats one up', 'drops a floater', 'tosses up a teardrop', 'releases a soft floater'],
    fastbreak_layup: ['races down the court for the layup', 'finishes in transition', 'gets the easy bucket in transition'],
    fastbreak_dunk: ['throws down the fast break dunk', 'finishes with authority in transition', 'slams it on the break'],
  };
  const arr = descs[playType] || ['takes the shot'];
  return arr[Math.floor(rng() * arr.length)];
}

function resultText(made: boolean, blocked: boolean, isThree: boolean, playType: string, rng: Rng): string {
  if (blocked) return 'BLOCKED!';
  if (!made) return ['No good.', 'Misses.', 'Rims out.', 'Off the mark.'][Math.floor(rng() * 4)];
  if (isThree) return ['BANG! Three pointer!', 'SPLASH! From downtown!', 'MONEY! Three ball!', 'DRAINS IT! Three!'][Math.floor(rng() * 4)];
  if (playType.includes('dunk')) return 'AND THE SLAM! What a play!';
  return ['Good!', 'Count it!', 'Scores!', 'Bucket!'][Math.floor(rng() * 4)];
}

function simulatePossession(
  state: GameState, quarter: number, clock: number, isHome: boolean
): { pointsScored: number; possessionTime: number } {
  const { rng, momentum, fatigue } = state;
  const offTeam = isHome ? state.homeTeam : state.awayTeam;
  const defTeam = isHome ? state.awayTeam : state.homeTeam;
  const offTactic = isHome ? state.homeTacticOff : state.awayTacticOff;
  const defTactic = isHome ? state.awayTacticDef : state.homeTacticDef;
  const offStats = isHome ? state.homeStats : state.awayStats;
  const defStats = isHome ? state.awayStats : state.homeStats;

  const possTime = 8 + Math.floor(rng() * 16);
  const timeStr = formatTime(Math.max(0, clock));
  const teamColor = offTeam.color;

  // Minutes + fatigue
  const minFraction = possTime / 60;
  offTeam.players.forEach(p => {
    getStat(offStats, p.id).minutes += minFraction;
    fatigue[p.id] = Math.max(0, (fatigue[p.id] ?? p.physical.stamina) - (1.2 + rng() * 0.8));
  });
  defTeam.players.forEach(p => {
    getStat(defStats, p.id).minutes += minFraction;
    fatigue[p.id] = Math.max(0, (fatigue[p.id] ?? p.physical.stamina) - (0.8 + rng() * 0.6));
  });

  // --- Steal check ---
  const ballHandler = offTeam.players.reduce((best, p) =>
    p.skills.playmaking.ball_handling > best.skills.playmaking.ball_handling ? p : best
  );
  const bestStealer = defTeam.players.reduce((best, p) =>
    p.skills.defense.steal > best.skills.defense.steal ? p : best
  );
  const stealChance = skillModifier(bestStealer.skills.defense.steal) * 0.07;

  if (rng() < stealChance) {
    getStat(defStats, bestStealer.id).steals += 1;
    getStat(offStats, ballHandler.id).turnovers += 1;
    addPBP(state, quarter, timeStr,
      `${bestStealer.name} picks ${ballHandler.name.split(' ').pop()}'s pocket! Turnover!`,
      defTeam.color, bestStealer.name);
    return { pointsScored: 0, possessionTime: Math.min(possTime, 6) };
  }

  // --- Turnover check ---
  const turnoverChance = 0.13 - skillModifier(ballHandler.skills.playmaking.ball_handling) * 0.03
    + (offTactic === 'fast_break' ? 0.02 : 0);

  if (rng() < turnoverChance) {
    const handler = pickWeighted(offTeam.players.map(p => ({
      item: p, weight: p.skills.playmaking.ball_handling > 60 ? 30 : 10,
    })), rng);
    getStat(offStats, handler.id).turnovers += 1;
    const texts = [`${handler.name} loses the handle. Turnover.`, `Bad pass by ${handler.name}. Turnover.`, `${handler.name} steps out of bounds. Turnover.`];
    addPBP(state, quarter, timeStr, texts[Math.floor(rng() * texts.length)], teamColor, handler.name);
    return { pointsScored: 0, possessionTime: possTime };
  }

  // --- Shot attempt ---
  const isFastBreak = offTactic === 'fast_break' && rng() < 0.25;
  const { shooter, assister, playType } = pickShooter(offTeam, offTactic, momentum, rng, isFastBreak);
  const defender = getMatchupDefender(shooter, defTeam, rng);
  const { made, isThree, blocked } = resolveShot(shooter, playType, defender, offTactic, defTactic, momentum, fatigue, rng);

  const shooterStats = getStat(offStats, shooter.id);
  const pts = isThree ? 3 : 2;

  shooterStats.fgAttempted += 1;
  if (isThree) shooterStats.threeAttempted += 1;

  if (blocked) {
    getStat(defStats, defender.id).blocks += 1;
  }

  let totalPoints = 0;

  if (made) {
    // --- MADE SHOT ---
    shooterStats.fgMade += 1;
    shooterStats.points += pts;
    if (isThree) shooterStats.threeMade += 1;
    totalPoints = pts;
    addPoints(state, isHome, pts);

    if (assister) getStat(offStats, assister.id).assists += 1;

    // Momentum
    momentum[shooter.id] = (momentum[shooter.id] || 0) + 1;
    offTeam.players.forEach(p => { if (p.id !== shooter.id) momentum[p.id] = Math.max(0, (momentum[p.id] || 0) - 0.5); });

    // Build PBP text
    const prefix = assister ? `${assister.name.split(' ').pop()} finds ${shooter.name}` : shooter.name;
    const desc = shotDescription(playType, rng);
    const res = resultText(true, false, isThree, playType, rng);
    addPBP(state, quarter, timeStr, `${prefix} ${desc}... ${res}`, teamColor, shooter.name);

    // And-1 chance (8% on drives/dunks/inside, 3% on jumpers)
    const andOneChance = ['layup', 'dunk', 'post', 'fastbreak_layup', 'fastbreak_dunk'].includes(playType) ? 0.08 : 0.03;
    if (rng() < andOneChance) {
      getStat(defStats, defender.id).fouls += 1;
      shooterStats.ftAttempted += 1;
      const ftMod = skillModifier(shooter.skills.shooting.free_throw);
      if (rng() < 0.55 + ftMod * 0.25) {
        shooterStats.ftMade += 1;
        shooterStats.points += 1;
        totalPoints += 1;
        addPoints(state, isHome, 1);
        addPBP(state, quarter, timeStr, `AND ONE! ${shooter.name} hits the free throw!`, teamColor, shooter.name);
      } else {
        addPBP(state, quarter, timeStr, `AND ONE! ${shooter.name} misses the free throw.`, teamColor, shooter.name);
      }
    }
  } else {
    // --- MISSED SHOT ---
    momentum[shooter.id] = Math.max(0, (momentum[shooter.id] || 0) - 1);

    const prefix = assister ? `${assister.name.split(' ').pop()} finds ${shooter.name}` : shooter.name;
    const desc = shotDescription(playType, rng);
    const res = resultText(false, blocked, isThree, playType, rng);

    // Shooting foul check (15% of non-blocked misses)
    if (!blocked && rng() < 0.15) {
      getStat(defStats, defender.id).fouls += 1;
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
      totalPoints = ftPoints;
      addPoints(state, isHome, ftPoints);
      const ftText = ftPoints === ftCount
        ? `Foul! ${shooter.name} hits all ${ftCount} free throws.`
        : `Foul! ${shooter.name} goes ${ftPoints}-${ftCount} from the line.`;
      addPBP(state, quarter, timeStr, ftText, teamColor, shooter.name);
      return { pointsScored: totalPoints, possessionTime: possTime };
    }

    // Rebound
    const offRebChance = 0.27;
    const isOffRebound = rng() < offRebChance;

    if (isOffRebound) {
      const rebounder = pickWeighted(offTeam.players.map(p => ({
        item: p,
        weight: p.skills.athletic.rebounding + p.physical.height / 5 + (p.skills.defense.box_out * 0.3),
      })), rng);
      const rebStats = getStat(offStats, rebounder.id);
      rebStats.rebounds += 1;
      rebStats.offRebounds += 1;

      addPBP(state, quarter, timeStr,
        `${prefix} ${desc}... ${res} ${rebounder.name.split(' ').pop()} grabs the offensive board!`,
        teamColor, shooter.name);

      // Second chance shot
      const newPlayType = rng() < 0.6 ? 'layup' : playType;
      const { made: made2, isThree: isThree2 } = resolveShot(shooter, newPlayType, defender, offTactic, defTactic, momentum, fatigue, rng);
      shooterStats.fgAttempted += 1;
      if (isThree2) shooterStats.threeAttempted += 1;

      if (made2) {
        const pts2 = isThree2 ? 3 : 2;
        shooterStats.fgMade += 1;
        shooterStats.points += pts2;
        if (isThree2) shooterStats.threeMade += 1;
        totalPoints = pts2;
        addPoints(state, isHome, pts2);

        const res2 = resultText(true, false, isThree2, newPlayType, rng);
        addPBP(state, quarter, timeStr,
          `${shooter.name} puts it back up... ${res2}`,
          teamColor, shooter.name);
      } else {
        // Second chance also missed — defensive rebound
        const defRebounder = pickWeighted(defTeam.players.map(p => ({
          item: p,
          weight: p.skills.athletic.rebounding + p.physical.height / 5 + (p.skills.defense.box_out * 0.3),
        })), rng);
        const defRebStats = getStat(defStats, defRebounder.id);
        defRebStats.rebounds += 1;
        defRebStats.defRebounds += 1;

        addPBP(state, quarter, timeStr,
          `${shooter.name} puts it back up... Misses again. ${defRebounder.name.split(' ').pop()} rebounds.`,
          undefined, undefined);
      }

      return { pointsScored: totalPoints, possessionTime: possTime + 6 };
    } else {
      // Defensive rebound
      const rebounder = pickWeighted(defTeam.players.map(p => ({
        item: p,
        weight: p.skills.athletic.rebounding + p.physical.height / 5 + (p.skills.defense.box_out * 0.3),
      })), rng);
      const rebStats = getStat(defStats, rebounder.id);
      rebStats.rebounds += 1;
      rebStats.defRebounds += 1;

      addPBP(state, quarter, timeStr,
        `${prefix} ${desc}... ${res} ${rebounder.name.split(' ').pop()} rebounds.`,
        teamColor, shooter.name);
    }
  }

  return { pointsScored: totalPoints, possessionTime: possTime };
}

function simulateQuarter(state: GameState, quarter: number, length: number, startHomeHasBall: boolean): { qHome: number; qAway: number } {
  let clock = length;
  let qHome = 0;
  let qAway = 0;
  let homeHasBall = startHomeHasBall;
  const baseHome = state.scoreHome;
  const baseAway = state.scoreAway;

  while (clock > 0) {
    const result = simulatePossession(state, quarter, clock, homeHasBall);
    if (homeHasBall) qHome += result.pointsScored;
    else qAway += result.pointsScored;

    clock -= result.possessionTime;

    // +/- tracking
    if (result.pointsScored > 0) {
      const scoringStats = homeHasBall ? state.homeStats : state.awayStats;
      const otherStats = homeHasBall ? state.awayStats : state.homeStats;
      scoringStats.forEach(s => s.plusMinus += result.pointsScored);
      otherStats.forEach(s => s.plusMinus -= result.pointsScored);
    }

    homeHasBall = !homeHasBall;
  }

  return { qHome, qAway };
}

export function simulateGame(
  homeTeam: Team, awayTeam: Team,
  homeTacticOff: OffenseTactic, homeTacticDef: DefenseTactic,
  awayTacticOff: OffenseTactic, awayTacticDef: DefenseTactic,
  seed: number
): GameResult {
  const rng = createRng(seed);
  const momentum: Record<string, number> = {};
  const fatigue: Record<string, number> = {};
  [...homeTeam.players, ...awayTeam.players].forEach(p => { fatigue[p.id] = p.physical.stamina; });

  const state: GameState = {
    homeTeam, awayTeam,
    homeTacticOff, homeTacticDef, awayTacticOff, awayTacticDef,
    homeStats: initStats(homeTeam), awayStats: initStats(awayTeam),
    scoreHome: 0, scoreAway: 0,
    playByPlay: [], rng, momentum, fatigue,
  };

  const quarterScores: QuarterScore[] = [];

  for (let q = 1; q <= QUARTERS; q++) {
    // Fatigue recovery between quarters
    if (q > 1) {
      [...homeTeam.players, ...awayTeam.players].forEach(p => {
        fatigue[p.id] = Math.min(p.physical.stamina, (fatigue[p.id] || 0) + p.physical.stamina * 0.15);
      });
    }

    addPBP(state, q, '12:00',
      q === 1 ? `--- TIP OFF! Quarter ${q} begins ---` : `--- Quarter ${q} begins ---`);

    const { qHome, qAway } = simulateQuarter(state, q, QUARTER_LENGTH, q % 2 === 1);
    quarterScores.push({ home: qHome, away: qAway });

    addPBP(state, q, '0:00',
      `--- End of Q${q} | ${homeTeam.name} ${state.scoreHome} - ${awayTeam.name} ${state.scoreAway} ---`);
  }

  // Overtime
  let otPeriod = 0;
  while (state.scoreHome === state.scoreAway) {
    otPeriod++;
    const q = QUARTERS + otPeriod;

    [...homeTeam.players, ...awayTeam.players].forEach(p => {
      fatigue[p.id] = Math.min(p.physical.stamina, (fatigue[p.id] || 0) + p.physical.stamina * 0.10);
    });

    addPBP(state, q, '5:00', `--- OVERTIME ${otPeriod}! ---`);

    const { qHome, qAway } = simulateQuarter(state, q, 300, otPeriod % 2 === 1);
    quarterScores.push({ home: qHome, away: qAway });

    addPBP(state, q, '0:00',
      `--- End of OT${otPeriod} | ${homeTeam.name} ${state.scoreHome} - ${awayTeam.name} ${state.scoreAway} ---`);

    if (otPeriod >= 5 && state.scoreHome === state.scoreAway) {
      if (rng() < 0.5) state.scoreHome += 1; else state.scoreAway += 1;
    }
  }

  // Round minutes
  state.homeStats.forEach(s => s.minutes = Math.round(s.minutes * 10) / 10);
  state.awayStats.forEach(s => s.minutes = Math.round(s.minutes * 10) / 10);

  return {
    homeStats: state.homeStats,
    awayStats: state.awayStats,
    playByPlay: state.playByPlay,
    quarterScores,
    finalScoreHome: state.scoreHome,
    finalScoreAway: state.scoreAway,
    seed,
  };
}
