import { QuarterScore, Team } from '../engine/types';

export function QuarterBreakdown({ quarters, home, away }: { quarters: QuarterScore[]; home: Team; away: Team }) {
  return (
    <div className="mb-6">
      <h3 className="text-lg font-bold mb-2 text-[var(--color-accent)]">Quarter Breakdown</h3>
      <table className="text-sm border-collapse">
        <thead>
          <tr className="text-[var(--color-text-dim)] border-b border-[var(--color-border)]">
            <th className="px-3 py-1 text-left">Team</th>
            {quarters.map((_, i) => <th key={i} className="px-3 py-1">Q{i + 1}</th>)}
            <th className="px-3 py-1 font-bold">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-[var(--color-border)]">
            <td className="px-3 py-1" style={{ color: home.color }}>{home.name}</td>
            {quarters.map((q, i) => <td key={i} className="px-3 py-1 text-center">{q.home}</td>)}
            <td className="px-3 py-1 text-center font-bold text-[var(--color-accent)]">{quarters.reduce((s, q) => s + q.home, 0)}</td>
          </tr>
          <tr>
            <td className="px-3 py-1" style={{ color: away.color }}>{away.name}</td>
            {quarters.map((q, i) => <td key={i} className="px-3 py-1 text-center">{q.away}</td>)}
            <td className="px-3 py-1 text-center font-bold text-[var(--color-accent)]">{quarters.reduce((s, q) => s + q.away, 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
