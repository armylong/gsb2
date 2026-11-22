import type { CategoryDef, CategoryId, TeamDef } from './types.ts';

export const CATEGORIES: Record<CategoryId, CategoryDef> = {
  rock: { id: 'rock', label: '岩矿', setSize: 3, setBonus: 5 },
  insect: { id: 'insect', label: '昆虫', setSize: 3, setBonus: 5 },
  plant: { id: 'plant', label: '植物', setSize: 3, setBonus: 5 },
};

export const TEAMS: TeamDef[] = [
  { id: 'A', label: '红隼队', autoStrategy: null, color: '#d64545' },
  { id: 'B', label: '蓝雀队', autoStrategy: 'valueFirst', color: '#3a6ee0' },
  { id: 'C', label: '绿蜥队', autoStrategy: 'setSeeker', color: '#2f9e5f' },
];

export const TEAM_IDS = TEAMS.map((t) => t.id);
