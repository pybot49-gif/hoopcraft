import { PlayByPlayEntry } from '../engine/types';

export function PlayByPlay({ entries }: { entries: PlayByPlayEntry[] }) {
  return (
    <div className="mb-6">
      <h3 className="text-lg font-bold mb-2 text-[var(--color-accent)]">Play-by-Play</h3>
      <div className="max-h-96 overflow-y-auto bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
            <tr className="text-[var(--color-text-dim)]">
              <th className="px-2 py-1 text-left w-16">Time</th>
              <th className="px-2 py-1 text-left">Play</th>
              <th className="px-2 py-1 text-center w-20">Score</th>
            </tr>
          </thead>
          <tbody>
            {[...entries].reverse().map((e, i) => {
              const isSeparator = e.text.startsWith('---');
              return (
                <tr key={i} className={isSeparator ? 'bg-[#111820]' : 'hover:bg-[#161b22]'}>
                  <td className="px-2 py-0.5 text-[var(--color-text-dim)] whitespace-nowrap">
                    {!isSeparator && `Q${e.quarter} ${e.time}`}
                  </td>
                  <td className="px-2 py-0.5">
                    {isSeparator ? (
                      <span className="text-[var(--color-accent)] font-bold">{e.text}</span>
                    ) : (
                      <span className="text-[var(--color-text)]">
                        {e.playerName && e.teamColor ? (
                          <PlayText text={e.text} playerName={e.playerName} teamColor={e.teamColor} />
                        ) : (
                          e.text
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-0.5 text-center font-mono whitespace-nowrap">
                    {!isSeparator && (
                      <span>
                        <span className="text-[var(--color-text)]">{e.scoreHome}</span>
                        <span className="text-[var(--color-text-dim)]"> - </span>
                        <span className="text-[var(--color-text)]">{e.scoreAway}</span>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlayText({ text, playerName, teamColor }: { text: string; playerName: string; teamColor: string }) {
  // Highlight all occurrences of player names in team color
  // Split by the player's last name for highlighting
  const lastName = playerName.split(' ').pop() || playerName;
  const parts = text.split(new RegExp(`(${escapeRegex(playerName)}|${escapeRegex(lastName)})`, 'g'));
  
  return (
    <>
      {parts.map((part, i) => {
        if (part === playerName || part === lastName) {
          return <span key={i} style={{ color: teamColor, fontWeight: 'bold' }}>{part}</span>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
