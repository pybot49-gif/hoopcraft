import { PlayByPlayEntry } from '../engine/types';

export function PlayByPlay({ entries }: { entries: PlayByPlayEntry[] }) {
  return (
    <div className="mb-6">
      <h3 className="text-lg font-bold mb-2 text-[var(--color-accent)]">Play-by-Play</h3>
      <div className="max-h-96 overflow-y-auto bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3">
        {[...entries].reverse().map((e, i) => (
          <div key={i} className={`text-xs py-0.5 ${e.text.startsWith('---') ? 'text-[var(--color-accent)] font-bold my-2' : 'text-[var(--color-text)]'}`}>
            {!e.text.startsWith('---') && (
              <span className="text-[var(--color-text-dim)] mr-2">Q{e.quarter} {e.time}</span>
            )}
            {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}
