import type { Team, TeamId, TeamSetup } from './types';

export const BASE_TEAMS: readonly Team[] = [
  {
    id: 'red',
    name: '赤陶队',
    sigil: '赤',
    color: '#a8442f',
    control: 'manual',
    strategy: 'set',
  },
  {
    id: 'blue',
    name: '青玉队',
    sigil: '青',
    color: '#2f5f8f',
    control: 'manual',
    strategy: 'value',
  },
  {
    id: 'gold',
    name: '鎏金队',
    sigil: '金',
    color: '#98701f',
    control: 'manual',
    strategy: 'value',
  },
];

export function getTeam(teams: Team[], id: TeamId): Team {
  const team = teams.find((candidate) => candidate.id === id);
  if (!team) {
    throw new Error(`未知队伍: ${id}`);
  }
  return team;
}

export function teamNames(teams: Team[]): Record<TeamId, string> {
  return {
    red: getTeam(teams, 'red').name,
    blue: getTeam(teams, 'blue').name,
    gold: getTeam(teams, 'gold').name,
  };
}

export function buildTeams(
  overrides?: Partial<Record<TeamId, Partial<TeamSetup>>>,
): Team[] {
  return BASE_TEAMS.map((team) => {
    const override = overrides?.[team.id];
    return {
      ...team,
      ...(override?.control ? { control: override.control } : {}),
      ...(override?.strategy ? { strategy: override.strategy } : {}),
    };
  });
}
