import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store';
import { setHomeOffense, setHomeDefense, setAwayOffense, setAwayDefense, metroHawks, bayCityWolves } from './store/teamsSlice';
import { setResult, setSeed } from './store/gameSlice';
import { simulateGame } from './engine/simulation';
import { OffenseTactic, DefenseTactic } from './engine/types';
import { GameHeader } from './components/GameHeader';
import { BoxScore } from './components/BoxScore';
import { PlayByPlay } from './components/PlayByPlay';
import { QuarterBreakdown } from './components/QuarterBreakdown';
import { TacticSelector } from './components/TacticSelector';
import { CourtView } from './components/CourtView';

type ViewMode = 'text' | 'court';

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('text');
  const dispatch = useDispatch();
  const { homeOffense, homeDefense, awayOffense, awayDefense } = useSelector((s: RootState) => s.teams);
  const { result, seed } = useSelector((s: RootState) => s.game);

  const handleSimulate = () => {
    const r = simulateGame(metroHawks, bayCityWolves, homeOffense, homeDefense, awayOffense, awayDefense, seed);
    dispatch(setResult(r));
  };

  const handleResimulate = () => {
    const newSeed = Date.now();
    dispatch(setSeed(newSeed));
    const r = simulateGame(metroHawks, bayCityWolves, homeOffense, homeDefense, awayOffense, awayDefense, newSeed);
    dispatch(setResult(r));
  };

  return (
    <div className="min-h-screen p-4 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-center text-[var(--color-accent)] mb-1">🏀 HoopCraft</h1>
      <p className="text-center text-[var(--color-text-dim)] text-xs mb-2">Basketball Simulation Engine Prototype</p>

      {/* View Mode Tabs */}
      <div className="flex justify-center gap-2 mb-4">
        <button onClick={() => setViewMode('text')}
          className={`px-4 py-1.5 rounded text-sm font-bold transition-colors border ${
            viewMode === 'text'
              ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-dim)]'
              : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]'
          }`}>
          📊 Text Sim
        </button>
        <button onClick={() => setViewMode('court')}
          className={`px-4 py-1.5 rounded text-sm font-bold transition-colors border ${
            viewMode === 'court'
              ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-dim)]'
              : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]'
          }`}>
          🏟️ Court View
        </button>
      </div>

      {viewMode === 'court' ? (
        <CourtView />
      ) : (
      <>
      {/* Controls */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 mb-6">
        <div className="flex flex-col md:flex-row gap-6 justify-between mb-4">
          <TacticSelector teamName={metroHawks.name} teamColor={metroHawks.color}
            offense={homeOffense} defense={homeDefense}
            onOffenseChange={(t: OffenseTactic) => dispatch(setHomeOffense(t))}
            onDefenseChange={(t: DefenseTactic) => dispatch(setHomeDefense(t))} />
          <TacticSelector teamName={bayCityWolves.name} teamColor={bayCityWolves.color}
            offense={awayOffense} defense={awayDefense}
            onOffenseChange={(t: OffenseTactic) => dispatch(setAwayOffense(t))}
            onDefenseChange={(t: DefenseTactic) => dispatch(setAwayDefense(t))} />
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs text-[var(--color-text-dim)]">
            Seed:
            <input type="number" value={seed} onChange={e => dispatch(setSeed(Number(e.target.value)))}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] rounded px-2 py-1 text-sm ml-1 w-36" />
          </label>
          <button onClick={handleSimulate}
            className="bg-[var(--color-accent-dim)] hover:bg-[var(--color-accent)] text-white font-bold px-4 py-1.5 rounded text-sm transition-colors">
            Simulate Game
          </button>
          {result && (
            <button onClick={handleResimulate}
              className="border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-black font-bold px-4 py-1.5 rounded text-sm transition-colors">
              New Game
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      {result && (
        <>
          <GameHeader result={result} home={metroHawks} away={bayCityWolves} />
          <QuarterBreakdown quarters={result.quarterScores} home={metroHawks} away={bayCityWolves} />
          <BoxScore stats={result.homeStats} team={metroHawks} />
          <BoxScore stats={result.awayStats} team={bayCityWolves} />
          <PlayByPlay entries={result.playByPlay} />
        </>
      )}
      </>
      )}
    </div>
  );
}
