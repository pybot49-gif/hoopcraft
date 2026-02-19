import { PlayerGameStats, Team } from '../engine/types';
import { skillToGrade } from '../engine/utils';

function fgStr(made: number, att: number) {
  return att > 0 ? `${made}/${att}` : '0/0';
}

export function BoxScore({ stats, team }: { stats: PlayerGameStats[]; team: Team }) {
  return (
    <div className="mb-6">
      <h3 className="text-lg font-bold mb-2" style={{ color: team.color }}>{team.name}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-[var(--color-text-dim)] border-b border-[var(--color-border)]">
              {['Player', 'MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'STL', 'BLK', 'TO', '+/-'].map(h => (
                <th key={h} className="px-2 py-1 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.map(s => {
              const player = team.players.find(p => p.id === s.playerId)!;
              return (
                <tr key={s.playerId} className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface)]">
                  <td className="px-2 py-1 whitespace-nowrap">
                    {player.isSuperstar && <span className="text-yellow-400 mr-1">⭐</span>}
                    {player.name}
                    <span className="text-[var(--color-text-dim)] ml-1 text-[10px]">{player.position}</span>
                  </td>
                  <td className="px-2 py-1">{s.minutes.toFixed(1)}</td>
                  <td className="px-2 py-1 font-bold text-[var(--color-accent)]">{s.points}</td>
                  <td className="px-2 py-1">{fgStr(s.fgMade, s.fgAttempted)}</td>
                  <td className="px-2 py-1">{fgStr(s.threeMade, s.threeAttempted)}</td>
                  <td className="px-2 py-1">{fgStr(s.ftMade, s.ftAttempted)}</td>
                  <td className="px-2 py-1">{s.rebounds}</td>
                  <td className="px-2 py-1">{s.assists}</td>
                  <td className="px-2 py-1">{s.steals}</td>
                  <td className="px-2 py-1">{s.blocks}</td>
                  <td className="px-2 py-1">{s.turnovers}</td>
                  <td className="px-2 py-1" style={{ color: s.plusMinus >= 0 ? 'var(--color-accent)' : 'var(--color-red)' }}>
                    {s.plusMinus >= 0 ? '+' : ''}{s.plusMinus}
                  </td>
                </tr>
              );
            })}
            {/* Totals */}
            <tr className="font-bold border-t-2 border-[var(--color-accent)]">
              <td className="px-2 py-1">TOTAL</td>
              <td className="px-2 py-1"></td>
              <td className="px-2 py-1 text-[var(--color-accent)]">{stats.reduce((s, p) => s + p.points, 0)}</td>
              <td className="px-2 py-1">{fgStr(stats.reduce((s, p) => s + p.fgMade, 0), stats.reduce((s, p) => s + p.fgAttempted, 0))}</td>
              <td className="px-2 py-1">{fgStr(stats.reduce((s, p) => s + p.threeMade, 0), stats.reduce((s, p) => s + p.threeAttempted, 0))}</td>
              <td className="px-2 py-1">{fgStr(stats.reduce((s, p) => s + p.ftMade, 0), stats.reduce((s, p) => s + p.ftAttempted, 0))}</td>
              <td className="px-2 py-1">{stats.reduce((s, p) => s + p.rebounds, 0)}</td>
              <td className="px-2 py-1">{stats.reduce((s, p) => s + p.assists, 0)}</td>
              <td className="px-2 py-1">{stats.reduce((s, p) => s + p.steals, 0)}</td>
              <td className="px-2 py-1">{stats.reduce((s, p) => s + p.blocks, 0)}</td>
              <td className="px-2 py-1">{stats.reduce((s, p) => s + p.turnovers, 0)}</td>
              <td className="px-2 py-1"></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
