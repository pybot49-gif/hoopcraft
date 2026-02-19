import { OffenseTactic, DefenseTactic } from './types';

// Matchup matrix: offense advantage percentage
const matrix: Record<OffenseTactic, Record<DefenseTactic, number>> = {
  fast_break: { man: 0, zone: 15, press: -15, gamble: 0, fortress: 0 },
  motion:     { man: 15, zone: 0, press: -15, gamble: 0, fortress: 0 },
  shoot:      { man: 0, zone: -15, press: 0, gamble: 0, fortress: 15 },
  inside:     { man: 0, zone: 0, press: 15, gamble: -12, fortress: -15 },
  iso:        { man: 15, zone: -15, press: 0, gamble: 12, fortress: 0 },
};

export function getTacticAdvantage(offense: OffenseTactic, defense: DefenseTactic): number {
  return matrix[offense][defense] / 100;
}
