#!/usr/bin/env node
// Build public/data/schedule-preseason-2026.json from the published 2026 NFL
// preseason matchups (entered from NFL.com/Google schedule cards; top team =
// away, bottom = home). Times are ET; August = EDT (-04:00). No reachable API
// for preseason from CI, so the matchups are embedded here. TV network + venue
// are layered in at runtime from ESPN in the browser.
import fs from 'fs';
import path from 'path';

const SEASON = 2026;
// [week, MM-DD, HH:MM(ET), away, home]
const G = [
  [1, '08-06', '20:00', 'CAR', 'ARI'],
  [2, '08-13', '19:00', 'DET', 'CIN'], [2, '08-13', '19:00', 'GB', 'PIT'], [2, '08-13', '19:30', 'IND', 'NE'],
  [2, '08-13', '20:00', 'LAC', 'HOU'], [2, '08-13', '20:00', 'ARI', 'LV'], [2, '08-13', '21:00', 'TEN', 'SF'],
  [2, '08-14', '19:00', 'MIA', 'WAS'], [2, '08-14', '19:00', 'DEN', 'ATL'], [2, '08-14', '19:00', 'TB', 'NYJ'],
  [2, '08-15', '13:00', 'CLE', 'CHI'], [2, '08-15', '13:00', 'CAR', 'BUF'], [2, '08-15', '13:00', 'MIN', 'NYG'],
  [2, '08-15', '16:00', 'LA', 'KC'], [2, '08-15', '16:00', 'JAX', 'NO'], [2, '08-15', '19:00', 'PHI', 'BAL'],
  [2, '08-15', '20:00', 'DAL', 'SEA'],
  [3, '08-20', '20:00', 'LV', 'HOU'], [3, '08-20', '22:00', 'SF', 'LAC'], [3, '08-21', '19:00', 'NYJ', 'PIT'],
  [3, '08-21', '19:30', 'CAR', 'JAX'], [3, '08-21', '21:00', 'GB', 'DEN'], [3, '08-22', '12:00', 'WAS', 'DET'],
  [3, '08-22', '13:00', 'ATL', 'IND'], [3, '08-22', '13:00', 'BUF', 'CLE'], [3, '08-22', '13:00', 'BAL', 'MIN'],
  [3, '08-22', '16:00', 'NYG', 'MIA'], [3, '08-22', '16:00', 'NO', 'LA'], [3, '08-22', '19:00', 'CHI', 'CIN'],
  [3, '08-22', '19:00', 'PHI', 'NE'], [3, '08-22', '19:30', 'KC', 'TB'], [3, '08-22', '22:00', 'DAL', 'ARI'],
  [3, '08-23', '20:00', 'SEA', 'TEN'],
  [4, '08-27', '19:00', 'PIT', 'BUF'], [4, '08-27', '20:00', 'NE', 'CLE'], [4, '08-27', '20:00', 'SF', 'LV'],
  [4, '08-27', '22:00', 'LA', 'LAC'], [4, '08-28', '18:00', 'WAS', 'BAL'], [4, '08-28', '19:00', 'ATL', 'MIA'],
  [4, '08-28', '19:00', 'HOU', 'CAR'], [4, '08-28', '19:30', 'TB', 'JAX'], [4, '08-28', '19:30', 'NYG', 'NYJ'],
  [4, '08-28', '20:00', 'CIN', 'PHI'], [4, '08-28', '20:00', 'ARI', 'GB'], [4, '08-28', '20:00', 'SEA', 'KC'],
  [4, '08-28', '20:00', 'NO', 'DAL'], [4, '08-28', '21:00', 'MIN', 'DEN'], [4, '08-29', '13:00', 'DET', 'IND'],
  [4, '08-29', '18:00', 'CHI', 'TEN'],
];

const games = G.map(([week, md, t, away, home]) => ({
  week, date: `${SEASON}-${md}T${t}:00-04:00`, away, home, venue: '', network: '',
}));

const out = path.join('public', 'data', `schedule-preseason-${SEASON}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ season: SEASON, source: 'manual', updated: new Date().toISOString(), games }, null, 0));
console.log(`Wrote ${out}: ${games.length} preseason games`);
