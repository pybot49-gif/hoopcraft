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

export function pickWeighted<T>(items: { item: T; weight: number }[], rng: Rng): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const { item, weight } of items) {
    r -= weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1].item;
}
