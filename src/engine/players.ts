import { Player, Team } from './types';

const hawksPlayers: Player[] = [
  {
    id: 'hawks-pg', name: 'Jay Carter', position: 'PG', isSuperstar: false,
    archetype: 'Floor General',
    physical: { height: 188, wingspan: 195, weight: 82, speed: 85, acceleration: 83, vertical: 72, strength: 60, stamina: 80, agility: 88, hand_size: 70 },
    skills: {
      shooting: { mid_range: 68, three_point: 50, close_shot: 62, free_throw: 72, catch_and_shoot: 55, pull_up: 65, fadeaway: 45, stepback: 50 },
      finishing: { layup: 70, euro_step: 65, floater: 68, dunk: 35, alley_oop: 40, reverse_layup: 60, post_move: 30 },
      playmaking: { passing: 90, ball_handling: 85, court_vision: 92, crossover: 78, pnr_read: 88, no_look_pass: 82, lob_pass: 80 },
      defense: { perimeter_d: 68, interior_d: 40, shot_contest: 60, block: 25, steal: 70, help_defense: 72, box_out: 45 },
      athletic: { rebounding: 35, hustle: 78, screens: 30, off_ball_movement: 65, conditioning: 82 },
    },
  },
  {
    id: 'hawks-sg', name: 'Devin Park', position: 'SG', isSuperstar: true,
    archetype: 'Sharpshooter',
    physical: { height: 193, wingspan: 198, weight: 88, speed: 75, acceleration: 78, vertical: 70, strength: 62, stamina: 75, agility: 80, hand_size: 72 },
    skills: {
      shooting: { mid_range: 88, three_point: 93, close_shot: 65, free_throw: 88, catch_and_shoot: 85, pull_up: 72, fadeaway: 70, stepback: 82 },
      finishing: { layup: 65, euro_step: 55, floater: 60, dunk: 40, alley_oop: 35, reverse_layup: 50, post_move: 45 },
      playmaking: { passing: 60, ball_handling: 72, court_vision: 65, crossover: 68, pnr_read: 55, no_look_pass: 45, lob_pass: 35 },
      defense: { perimeter_d: 50, interior_d: 35, shot_contest: 48, block: 20, steal: 42, help_defense: 50, box_out: 40 },
      athletic: { rebounding: 40, hustle: 60, screens: 35, off_ball_movement: 85, conditioning: 72 },
    },
  },
  {
    id: 'hawks-sf', name: 'Marcus Webb', position: 'SF', isSuperstar: false,
    archetype: 'Two-Way Wing',
    physical: { height: 201, wingspan: 210, weight: 98, speed: 78, acceleration: 76, vertical: 75, strength: 75, stamina: 82, agility: 76, hand_size: 78 },
    skills: {
      shooting: { mid_range: 65, three_point: 62, close_shot: 68, free_throw: 72, catch_and_shoot: 68, pull_up: 60, fadeaway: 50, stepback: 48 },
      finishing: { layup: 68, euro_step: 60, floater: 55, dunk: 62, alley_oop: 55, reverse_layup: 58, post_move: 50 },
      playmaking: { passing: 58, ball_handling: 62, court_vision: 60, crossover: 55, pnr_read: 50, no_look_pass: 40, lob_pass: 35 },
      defense: { perimeter_d: 82, interior_d: 65, shot_contest: 78, block: 55, steal: 72, help_defense: 80, box_out: 65 },
      athletic: { rebounding: 65, hustle: 82, screens: 55, off_ball_movement: 70, conditioning: 85 },
    },
  },
  {
    id: 'hawks-pf', name: 'Andre Russell', position: 'PF', isSuperstar: false,
    archetype: 'Slasher',
    physical: { height: 203, wingspan: 212, weight: 102, speed: 82, acceleration: 85, vertical: 85, strength: 78, stamina: 78, agility: 80, hand_size: 80 },
    skills: {
      shooting: { mid_range: 42, three_point: 25, close_shot: 70, free_throw: 62, catch_and_shoot: 30, pull_up: 35, fadeaway: 28, stepback: 22 },
      finishing: { layup: 82, euro_step: 72, floater: 55, dunk: 85, alley_oop: 78, reverse_layup: 68, post_move: 55 },
      playmaking: { passing: 48, ball_handling: 55, court_vision: 45, crossover: 50, pnr_read: 52, no_look_pass: 30, lob_pass: 25 },
      defense: { perimeter_d: 58, interior_d: 65, shot_contest: 62, block: 68, steal: 50, help_defense: 62, box_out: 70 },
      athletic: { rebounding: 72, hustle: 80, screens: 65, off_ball_movement: 72, conditioning: 78 },
    },
  },
  {
    id: 'hawks-c', name: 'Isaiah Okafor', position: 'C', isSuperstar: false,
    archetype: 'Paint Beast',
    physical: { height: 211, wingspan: 222, weight: 118, speed: 55, acceleration: 50, vertical: 62, strength: 88, stamina: 72, agility: 48, hand_size: 85 },
    skills: {
      shooting: { mid_range: 28, three_point: 10, close_shot: 72, free_throw: 58, catch_and_shoot: 15, pull_up: 18, fadeaway: 35, stepback: 10 },
      finishing: { layup: 72, euro_step: 30, floater: 35, dunk: 70, alley_oop: 62, reverse_layup: 55, post_move: 82 },
      playmaking: { passing: 45, ball_handling: 30, court_vision: 48, crossover: 20, pnr_read: 55, no_look_pass: 30, lob_pass: 20 },
      defense: { perimeter_d: 35, interior_d: 82, shot_contest: 75, block: 72, steal: 35, help_defense: 70, box_out: 82 },
      athletic: { rebounding: 85, hustle: 75, screens: 80, off_ball_movement: 50, conditioning: 70 },
    },
  },
];

const wolvesPlayers: Player[] = [
  {
    id: 'wolves-pg', name: 'Tyler Nguyen', position: 'PG', isSuperstar: false,
    archetype: 'Speed Demon',
    physical: { height: 183, wingspan: 188, weight: 75, speed: 92, acceleration: 90, vertical: 78, strength: 50, stamina: 82, agility: 92, hand_size: 65 },
    skills: {
      shooting: { mid_range: 58, three_point: 52, close_shot: 60, free_throw: 75, catch_and_shoot: 50, pull_up: 55, fadeaway: 40, stepback: 48 },
      finishing: { layup: 82, euro_step: 72, floater: 70, dunk: 45, alley_oop: 55, reverse_layup: 75, post_move: 20 },
      playmaking: { passing: 72, ball_handling: 85, court_vision: 70, crossover: 82, pnr_read: 68, no_look_pass: 62, lob_pass: 65 },
      defense: { perimeter_d: 65, interior_d: 30, shot_contest: 55, block: 18, steal: 75, help_defense: 60, box_out: 30 },
      athletic: { rebounding: 30, hustle: 85, screens: 25, off_ball_movement: 70, conditioning: 85 },
    },
  },
  {
    id: 'wolves-sg', name: 'Jordan Blake', position: 'SG', isSuperstar: false,
    archetype: 'Combo Guard',
    physical: { height: 191, wingspan: 196, weight: 86, speed: 78, acceleration: 76, vertical: 72, strength: 65, stamina: 78, agility: 78, hand_size: 72 },
    skills: {
      shooting: { mid_range: 68, three_point: 65, close_shot: 65, free_throw: 75, catch_and_shoot: 68, pull_up: 65, fadeaway: 55, stepback: 58 },
      finishing: { layup: 68, euro_step: 60, floater: 58, dunk: 50, alley_oop: 48, reverse_layup: 55, post_move: 35 },
      playmaking: { passing: 62, ball_handling: 68, court_vision: 60, crossover: 65, pnr_read: 55, no_look_pass: 45, lob_pass: 40 },
      defense: { perimeter_d: 55, interior_d: 42, shot_contest: 52, block: 28, steal: 55, help_defense: 55, box_out: 45 },
      athletic: { rebounding: 42, hustle: 68, screens: 40, off_ball_movement: 72, conditioning: 78 },
    },
  },
  {
    id: 'wolves-sf', name: 'Kai Thompson', position: 'SF', isSuperstar: true,
    archetype: 'Athletic Freak',
    physical: { height: 199, wingspan: 210, weight: 95, speed: 85, acceleration: 88, vertical: 93, strength: 75, stamina: 80, agility: 85, hand_size: 80 },
    skills: {
      shooting: { mid_range: 52, three_point: 38, close_shot: 72, free_throw: 68, catch_and_shoot: 42, pull_up: 48, fadeaway: 40, stepback: 35 },
      finishing: { layup: 82, euro_step: 80, floater: 62, dunk: 92, alley_oop: 85, reverse_layup: 72, post_move: 50 },
      playmaking: { passing: 55, ball_handling: 70, court_vision: 58, crossover: 72, pnr_read: 50, no_look_pass: 40, lob_pass: 35 },
      defense: { perimeter_d: 78, interior_d: 72, shot_contest: 80, block: 82, steal: 72, help_defense: 75, box_out: 60 },
      athletic: { rebounding: 72, hustle: 88, screens: 55, off_ball_movement: 75, conditioning: 82 },
    },
  },
  {
    id: 'wolves-pf', name: 'David Chen', position: 'PF', isSuperstar: false,
    archetype: 'Stretch Four',
    physical: { height: 206, wingspan: 212, weight: 100, speed: 68, acceleration: 65, vertical: 65, strength: 70, stamina: 75, agility: 65, hand_size: 75 },
    skills: {
      shooting: { mid_range: 72, three_point: 70, close_shot: 58, free_throw: 78, catch_and_shoot: 80, pull_up: 62, fadeaway: 55, stepback: 48 },
      finishing: { layup: 55, euro_step: 42, floater: 45, dunk: 48, alley_oop: 40, reverse_layup: 42, post_move: 45 },
      playmaking: { passing: 52, ball_handling: 48, court_vision: 50, crossover: 40, pnr_read: 48, no_look_pass: 30, lob_pass: 28 },
      defense: { perimeter_d: 52, interior_d: 55, shot_contest: 55, block: 42, steal: 38, help_defense: 55, box_out: 55 },
      athletic: { rebounding: 55, hustle: 62, screens: 60, off_ball_movement: 72, conditioning: 72 },
    },
  },
  {
    id: 'wolves-c', name: 'Omar Williams', position: 'C', isSuperstar: false,
    archetype: 'Rim Protector',
    physical: { height: 215, wingspan: 228, weight: 120, speed: 48, acceleration: 45, vertical: 60, strength: 90, stamina: 70, agility: 42, hand_size: 88 },
    skills: {
      shooting: { mid_range: 22, three_point: 8, close_shot: 55, free_throw: 52, catch_and_shoot: 10, pull_up: 12, fadeaway: 18, stepback: 8 },
      finishing: { layup: 60, euro_step: 18, floater: 22, dunk: 65, alley_oop: 55, reverse_layup: 40, post_move: 55 },
      playmaking: { passing: 38, ball_handling: 22, court_vision: 40, crossover: 15, pnr_read: 45, no_look_pass: 20, lob_pass: 15 },
      defense: { perimeter_d: 30, interior_d: 85, shot_contest: 80, block: 85, steal: 30, help_defense: 72, box_out: 82 },
      athletic: { rebounding: 78, hustle: 70, screens: 82, off_ball_movement: 35, conditioning: 68 },
    },
  },
];

export const metroHawks: Team = {
  id: 'hawks',
  name: 'Metro Hawks',
  color: '#f85149',
  players: hawksPlayers,
};

export const bayCityWolves: Team = {
  id: 'wolves',
  name: 'Bay City Wolves',
  color: '#58a6ff',
  players: wolvesPlayers,
};
