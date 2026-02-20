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
  if (value >= 90) return 'S';
  if (value >= 75) return 'A';
  if (value >= 60) return 'B';
  if (value >= 45) return 'C';
  if (value >= 30) return 'D';
  if (value >= 15) return 'E';
  return 'F';
}

export function skillModifier(value: number): number {
  if (value >= 90) return 1.05;
  if (value >= 75) return 0.95;
  if (value >= 60) return 0.88;
  if (value >= 45) return 0.78;
  if (value >= 30) return 0.65;
  if (value >= 15) return 0.5;
  return 0.3;
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

export function getPlayerOverall(p: Player): number {
  const cats = getPlayerCategoryRatings(p);
  // Weighted by position
  let weights: Record<string, number>;
  switch (p.position) {
    case 'PG': weights = { shooting: 0.20, finishing: 0.10, playmaking: 0.30, defense: 0.15, athletic: 0.10, physical: 0.15 }; break;
    case 'SG': weights = { shooting: 0.30, finishing: 0.15, playmaking: 0.15, defense: 0.15, athletic: 0.10, physical: 0.15 }; break;
    case 'SF': weights = { shooting: 0.20, finishing: 0.15, playmaking: 0.10, defense: 0.20, athletic: 0.15, physical: 0.20 }; break;
    case 'PF': weights = { shooting: 0.15, finishing: 0.20, playmaking: 0.05, defense: 0.20, athletic: 0.15, physical: 0.25 }; break;
    case 'C':  weights = { shooting: 0.05, finishing: 0.20, playmaking: 0.05, defense: 0.25, athletic: 0.15, physical: 0.30 }; break;
    default:   weights = { shooting: 0.17, finishing: 0.17, playmaking: 0.17, defense: 0.17, athletic: 0.16, physical: 0.16 };
  }
  const vals = cats as unknown as Record<string, number>;
  return Math.round(Object.entries(weights).reduce((sum, [k, w]) => sum + vals[k] * w, 0));
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
