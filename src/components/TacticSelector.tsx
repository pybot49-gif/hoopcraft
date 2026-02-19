import { OffenseTactic, DefenseTactic } from '../engine/types';

const offOptions: OffenseTactic[] = ['fast_break', 'motion', 'shoot', 'inside', 'iso'];
const defOptions: DefenseTactic[] = ['man', 'zone', 'press', 'gamble', 'fortress'];

const labels: Record<string, string> = {
  fast_break: 'Fast Break', motion: 'Motion', shoot: 'Shoot', inside: 'Inside', iso: 'Isolation',
  man: 'Man-to-Man', zone: 'Zone', press: 'Press', gamble: 'Gamble', fortress: 'Fortress',
};

interface Props {
  teamName: string;
  teamColor: string;
  offense: OffenseTactic;
  defense: DefenseTactic;
  onOffenseChange: (t: OffenseTactic) => void;
  onDefenseChange: (t: DefenseTactic) => void;
}

export function TacticSelector({ teamName, teamColor, offense, defense, onOffenseChange, onDefenseChange }: Props) {
  const selectClass = "bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] rounded px-2 py-1 text-sm";
  return (
    <div className="flex flex-col gap-2">
      <span className="font-bold text-sm" style={{ color: teamColor }}>{teamName}</span>
      <div className="flex gap-3 flex-wrap">
        <label className="text-xs text-[var(--color-text-dim)]">
          OFF:
          <select className={selectClass + " ml-1"} value={offense} onChange={e => onOffenseChange(e.target.value as OffenseTactic)}>
            {offOptions.map(o => <option key={o} value={o}>{labels[o]}</option>)}
          </select>
        </label>
        <label className="text-xs text-[var(--color-text-dim)]">
          DEF:
          <select className={selectClass + " ml-1"} value={defense} onChange={e => onDefenseChange(e.target.value as DefenseTactic)}>
            {defOptions.map(d => <option key={d} value={d}>{labels[d]}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}
