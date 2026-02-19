# 🏀 HoopCraft

Basketball simulation engine prototype — text-based box scores and play-by-play.

**[Play it live →](https://pybot49.github.io/hoopcraft/)**

## What is this?

A web-based basketball simulation that validates whether our engine produces realistic NBA-like stats. No graphics — just numbers and narrative play-by-play text.

Two hardcoded teams (Metro Hawks vs Bay City Wolves) with 5 players each, complete with detailed physical attributes and skill ratings (F through S rank). Each game simulates ~200 possessions across 4 quarters with a 24-second shot clock.

## Features

- **Seeded RNG** — same seed = same game, every time
- **Tactical system** — 5 offensive × 5 defensive tactics with a matchup advantage matrix
- **Detailed box scores** — PTS, FG, 3PT, FT, REB, AST, STL, BLK, TO, +/-
- **Engaging play-by-play** — reads like a real broadcast
- **Superstar takeover** — momentum system for star players
- **Fatigue** — stamina degrades over the game

## Realism Targets

| Stat | Target Range |
|------|-------------|
| Team Score | 90-120 |
| FG% | 42-50% |
| 3PT% | 30-40% |
| Rebounds/team | 40-55 |
| Assists/team | 18-30 |
| Turnovers/team | 10-18 |

## Tech Stack

React 19 + Redux Toolkit + TypeScript + Tailwind CSS v4 + Vite

## Development

```bash
npm install
npm run dev
```

## Game Design Document

See [GDD.md](./GDD.md) for the full game design document.
