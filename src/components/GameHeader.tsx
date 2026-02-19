import { GameResult, Team } from '../engine/types';

export function GameHeader({ result, home, away }: { result: GameResult; home: Team; away: Team }) {
  return (
    <div className="text-center mb-6">
      <div className="flex items-center justify-center gap-6 text-3xl font-bold mb-2">
        <span style={{ color: home.color }}>{home.name}</span>
        <span className="text-[var(--color-accent)]">{result.finalScoreHome}</span>
        <span className="text-[var(--color-text-dim)]">-</span>
        <span className="text-[var(--color-accent)]">{result.finalScoreAway}</span>
        <span style={{ color: away.color }}>{away.name}</span>
      </div>
      <div className="text-sm text-[var(--color-text-dim)]">Seed: {result.seed}</div>
    </div>
  );
}
