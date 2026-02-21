// Seeded PRNG (mulberry32)
export function createRng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = ReturnType<typeof createRng>;

export function skillToGrade(value: number): string {
  if (value >= 95) return 'S';
  if (value >= 85) return 'A';
  if (value >= 75) return 'B';
  if (value >= 65) return 'C';
  return 'D';
}

export function skillModifier(value: number): number {
  // Continuous curve: skill 60 → 0.75, skill 80 → 1.00, skill 100 → 1.20
  // Linear interpolation: 0.75 + (value - 60) * (0.45 / 40)
  const clamped = Math.max(40, Math.min(100, value));
  return 0.75 + (clamped - 60) * 0.01125;
}

export function formatTime(secondsRemaining: number): string {
  const min = Math.floor(secondsRemaining / 60);
  const sec = Math.floor(secondsRemaining % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

import type { Player } from './types';

export function getPlayerCategoryRatings(p: Player): { shooting: number; finishing: number; playmaking: number; defense: number; athletic: number; physical: number } {
  const avg = (nums: number[]) => nums.reduce((a, b) => a + b, 0) / nums.length;
  const s = p.skills;
  return {
    shooting: Math.round(avg(Object.values(s.shooting))),
    finishing: Math.round(avg(Object.values(s.finishing))),
    playmaking: Math.round(avg(Object.values(s.playmaking))),
    defense: Math.round(avg(Object.values(s.defense))),
    athletic: Math.round(avg(Object.values(s.athletic))),
    physical: Math.round(avg([p.physical.speed, p.physical.acceleration, p.physical.vertical, p.physical.strength, p.physical.stamina, p.physical.agility])),
  };
}

function gradePoint(value: number): number {
  const g = skillToGrade(value);
  switch (g) {
    case 'S': return 10;
    case 'A': return 9;
    case 'B': return 8;
    case 'C': return 7;
    default:  return 6; // D
  }
}

export function getPlayerOverall(p: Player): number {
  const allSkills: number[] = [
    ...Object.values(p.skills.shooting),
    ...Object.values(p.skills.finishing),
    ...Object.values(p.skills.playmaking),
    ...Object.values(p.skills.defense),
    ...Object.values(p.skills.athletic),
  ];
  // Overall based on top 10 skills (what defines a player)
  const sorted = allSkills.map(v => gradePoint(v)).sort((a, b) => b - a);
  const top10 = sorted.slice(0, 10);
  const avg = top10.reduce((s, v) => s + v, 0) / top10.length;
  return Math.min(99, Math.round(avg * 10));
}

export function pickWeighted<T>(items: { item: T; weight: number }[], rng: Rng): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const { item, weight } of items) {
    r -= weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1].item;
}
