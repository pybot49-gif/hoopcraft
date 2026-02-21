import { GameState, PlayerBoxStats } from './types';

export function emptyBoxStats(): PlayerBoxStats {
  return { pts: 0, reb: 0, oreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, min: 0 };
}

export function addStat(state: GameState, playerId: string, stat: keyof PlayerBoxStats, value = 1) {
  let s = state.boxStats.get(playerId);
  if (!s) { s = emptyBoxStats(); state.boxStats.set(playerId, s); }
  (s[stat] as number) += value;
}
