import { useState } from 'react';
import { Player, PlayerGameStats, Team } from '../engine/types';
import { skillToGrade, getPlayerOverall, getPlayerCategoryRatings } from '../engine/utils';

function fgStr(made: number, att: number) {
  return att > 0 ? `${made}/${att}` : '0/0';
}

function gradeColor(grade: string): string {
  switch (grade) {
    case 'S': return '#ff6b6b';
    case 'A': return '#ffd93d';
    case 'B': return '#3fb950';
    case 'C': return '#58a6ff';
    case 'D': return '#7d8590';
    case 'E': return '#484f58';
    default: return '#30363d';
  }
}

function SkillBadge({ name, value }: { name: string; value: number }) {
  const grade = skillToGrade(value);
  return (
    <span className="inline-flex items-center gap-1 mr-2 mb-1 text-[10px]">
      <span className="text-[var(--color-text-dim)]">{name}</span>
      <span className="font-bold px-1 rounded" style={{ color: gradeColor(grade), border: `1px solid ${gradeColor(grade)}` }}>{grade}</span>
    </span>
  );
}

function HexagonChart({ ratings }: { ratings: Record<string, number> }) {
  const labels = ['Shooting', 'Finishing', 'Playmaking', 'Defense', 'Athletic', 'Physical'];
  const keys = ['shooting', 'finishing', 'playmaking', 'defense', 'athletic', 'physical'];
  const cx = 120, cy = 110, maxR = 80;

  const pointsForValue = (values: number[]) => {
    return values.map((v, i) => {
      const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
      const r = (v / 100) * maxR;
      return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
    }).join(' ');
  };

  const values = keys.map(k => (ratings as Record<string, number>)[k] || 0);

  // Grid rings at 25, 50, 75, 100
  const rings = [25, 50, 75, 100].map(v =>
    pointsForValue(Array(6).fill(v))
  );

  // Label positions
  const labelPositions = labels.map((_, i) => {
    const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
    const r = maxR + 20;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });

  return (
    <svg viewBox="0 0 240 230" className="w-full max-w-[240px] mx-auto">
      {/* Grid rings */}
      {rings.map((pts, i) => (
        <polygon key={i} points={pts} fill="none" stroke="#21262d" strokeWidth="1" />
      ))}
      {/* Axes */}
      {Array(6).fill(0).map((_, i) => {
        const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
        return <line key={i} x1={cx} y1={cy} x2={cx + maxR * Math.cos(angle)} y2={cy + maxR * Math.sin(angle)} stroke="#21262d" strokeWidth="1" />;
      })}
      {/* Data polygon */}
      <polygon points={pointsForValue(values)} fill="rgba(63,185,80,0.25)" stroke="#3fb950" strokeWidth="2" />
      {/* Data points */}
      {values.map((v, i) => {
        const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
        const r = (v / 100) * maxR;
        return <circle key={i} cx={cx + r * Math.cos(angle)} cy={cy + r * Math.sin(angle)} r="3" fill="#3fb950" />;
      })}
      {/* Labels */}
      {labelPositions.map((pos, i) => (
        <text key={i} x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="middle" fill="#7d8590" fontSize="9" fontFamily="monospace">
          {labels[i]} {values[i]}
        </text>
      ))}
    </svg>
  );
}

function PlayerModal({ player, onClose }: { player: Player; onClose: () => void }) {
  const p = player;
  const overall = getPlayerOverall(p);
  const cats = getPlayerCategoryRatings(p);

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[#0d1117] border border-[var(--color-border)] rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto p-4" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="text-lg font-bold text-[var(--color-accent)]">
              {p.isSuperstar && <span className="text-yellow-400 mr-1">⭐</span>}
              {p.name}
            </h3>
            <p className="text-xs text-[var(--color-text-dim)]">{p.position} · {p.archetype}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-center">
              <div className="text-2xl font-bold" style={{ color: overall >= 80 ? '#3fb950' : overall >= 65 ? '#d29922' : '#f85149' }}>{overall}</div>
              <div className="text-[10px] text-[var(--color-text-dim)]">OVR</div>
            </div>
            <button onClick={onClose} className="text-[var(--color-text-dim)] hover:text-white text-xl ml-2">✕</button>
          </div>
        </div>

        {/* Hexagon Chart */}
        <HexagonChart ratings={cats} />

        <div className="mb-3">
          <h4 className="text-xs font-bold text-[var(--color-text-dim)] mb-1 uppercase">Physical</h4>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Height</span><span>{p.physical.height} cm</span></div>
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Wingspan</span><span>{p.physical.wingspan} cm</span></div>
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Weight</span><span>{p.physical.weight} kg</span></div>
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Speed</span><span>{p.physical.speed}</span></div>
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Acceleration</span><span>{p.physical.acceleration}</span></div>
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Vertical</span><span>{p.physical.vertical}</span></div>
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Strength</span><span>{p.physical.strength}</span></div>
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Stamina</span><span>{p.physical.stamina}</span></div>
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Agility</span><span>{p.physical.agility}</span></div>
            <div className="flex justify-between"><span className="text-[var(--color-text-dim)]">Hand Size</span><span>{p.physical.hand_size}</span></div>
          </div>
        </div>

        {([
          ['🎯 Shooting', p.skills.shooting as unknown as Record<string, number>],
          ['🏀 Finishing', p.skills.finishing as unknown as Record<string, number>],
          ['🎭 Playmaking', p.skills.playmaking as unknown as Record<string, number>],
          ['🛡️ Defense', p.skills.defense as unknown as Record<string, number>],
          ['💪 Athletic', p.skills.athletic as unknown as Record<string, number>],
        ] as [string, Record<string, number>][]).map(([label, skills]) => {
          const skillEntries = Object.entries(skills);
          const learned = skillEntries.filter(([, v]) => skillToGrade(v) !== 'D' && skillToGrade(v) !== 'E' && skillToGrade(v) !== 'F');
          if (learned.length === 0) return null;
          return (
            <div key={label} className="mb-2">
              <h4 className="text-xs font-bold text-[var(--color-text-dim)] mb-1 uppercase">{label}</h4>
              <div className="flex flex-wrap">
                {learned.map(([k, v]) => (
                  <SkillBadge key={k} name={k.replace(/_/g, ' ')} value={v} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BoxScore({ stats, team }: { stats: PlayerGameStats[]; team: Team }) {
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  return (
    <div className="mb-6">
      <h3 className="text-lg font-bold mb-2" style={{ color: team.color }}>{team.name}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-[var(--color-text-dim)] border-b border-[var(--color-border)]">
              {['Player', 'MIN', 'PTS', 'FG', '3PT', 'FT', 'OREB', 'DREB', 'REB', 'AST', 'STL', 'BLK', 'TO', '+/-'].map(h => (
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
                    <button onClick={() => setSelectedPlayer(player)} className="hover:text-[var(--color-accent)] hover:underline cursor-pointer text-left">
                      {player.isSuperstar && <span className="text-yellow-400 mr-1">⭐</span>}
                      {player.name}
                    </button>
                    <span className="text-[var(--color-text-dim)] ml-1 text-[10px]">{player.position}</span>
                  </td>
                  <td className="px-2 py-1">{s.minutes.toFixed(1)}</td>
                  <td className="px-2 py-1 font-bold text-[var(--color-accent)]">{s.points}</td>
                  <td className="px-2 py-1">{fgStr(s.fgMade, s.fgAttempted)}</td>
                  <td className="px-2 py-1">{fgStr(s.threeMade, s.threeAttempted)}</td>
                  <td className="px-2 py-1">{fgStr(s.ftMade, s.ftAttempted)}</td>
                  <td className="px-2 py-1">{s.offRebounds}</td>
                  <td className="px-2 py-1">{s.defRebounds}</td>
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
              <td className="px-2 py-1">{stats.reduce((s, p) => s + p.offRebounds, 0)}</td>
              <td className="px-2 py-1">{stats.reduce((s, p) => s + p.defRebounds, 0)}</td>
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
      {selectedPlayer && <PlayerModal player={selectedPlayer} onClose={() => setSelectedPlayer(null)} />}
    </div>
  );
}
