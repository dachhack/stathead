/**
 * Environment feature group: dome games, bye week, O-line quality, QB passer rating.
 * Derived from game schedules and PBP data.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

// Dome/retractable roof stadiums (team abbreviations)
const DOME_TEAMS = new Set([
  'DAL', 'IND', 'NO', 'DET', 'ATL', 'HOU', 'ARI', 'MIN', 'LV', 'LAC', 'LAR',
]);

export const environmentGroup: FeatureGroup = {
  def: {
    id: 'environment',
    label: 'Team Environment',
    featureKeys: ['teamDomeGames', 'byeWeek', 'teamSackRate', 'teamRushYPC'],
    dataDeps: ['games', 'pbp'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();

    // Dome games: count home games for dome teams + away games at dome teams
    const teamDomeGames = new Map<string, number>();
    const teamWeeks = new Map<string, Set<number>>();
    const vegasData = ctx.data.vegasBySeasonTeam;

    // Count dome games and track weeks from Vegas data (which has all games)
    for (const [key, v] of vegasData) {
      const [szn, team] = key.split(':');
      if (Number(szn) !== season) continue;
      // Dome teams get 8-9 home games in domes
      if (DOME_TEAMS.has(team)) {
        teamDomeGames.set(team, Math.round((v as any).games / 2));
      }
    }

    // Sack rate and rush YPC from PBP (scheme data)
    const teamSackRate = new Map<string, number>();
    const teamRushYPC = new Map<string, number>();
    const scheme = ctx.data.schemeByTeam;
    for (const [team, s] of scheme) {
      const totalPlays = (s as any).plays || 1;
      // Sack rate would need sack counts from PBP — approximate from pass plays
      teamSackRate.set(team, 0); // requires explicit sack counting from PBP

      const rushes = (s as any).rushes || 0;
      // Rush YPC would need total rush yards — not available in scheme agg
      teamRushYPC.set(team, 0);
    }

    for (const [pk, player] of ctx.players) {
      const team = player.team;
      results.set(pk, {
        teamDomeGames: teamDomeGames.get(team) || 0,
        byeWeek: 0, // requires week-by-week schedule parsing
        teamSackRate: teamSackRate.get(team) || 0,
        teamRushYPC: teamRushYPC.get(team) || 0,
      });
    }
    return results;
  },
};

registerGroup(environmentGroup);
