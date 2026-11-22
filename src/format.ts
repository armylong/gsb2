import type {
  GameState,
  MissRecord,
  RoundResult,
  Specimen,
  Team,
  TeamId,
  Viewer,
} from './game/types';

export function specimenIndex(table: readonly Specimen[] | undefined): Map<string, Specimen> {
  return new Map((table ?? []).map((specimen) => [specimen.id, specimen]));
}

export function specimenName(table: readonly Specimen[] | undefined, id: string | null): string {
  if (!id) return '—';
  return specimenIndex(table).get(id)?.name ?? id;
}

export function teamById(teams: readonly Team[], id: TeamId): Team {
  return teams.find((team) => team.id === id) ?? teams[0]!;
}

export function viewerTeamId(viewer: Viewer): TeamId | null {
  return viewer === 'observer' ? null : viewer;
}

export function missReasonLabel(miss: MissRecord): string {
  return miss.reason === 'no-backup' ? '没有合适备选' : '备用已被别人拿走';
}

export function describeMiss(
  miss: MissRecord,
  round: RoundResult,
  teams: readonly Team[],
): { title: string; detail: string } {
  const primaryName = specimenName(round.table, miss.primaryId);
  const backupName = specimenName(round.table, miss.backupId);
  const primaryBy = miss.primaryTakenBy ? teamById(teams, miss.primaryTakenBy).name : null;
  const backupBy = miss.backupTakenBy ? teamById(teams, miss.backupTakenBy).name : null;
  if (miss.reason === 'no-backup') {
    return {
      title: `${teamById(teams, miss.teamId).name} 两手落空 · 没有合适备选`,
      detail: `首选「${primaryName}」${primaryBy ? `被${primaryBy}拿走` : '未拿到'}，本队没有提交备用。`,
    };
  }
  return {
    title: `${teamById(teams, miss.teamId).name} 两手落空 · 备用已被拿走`,
    detail: `首选「${primaryName}」${primaryBy ? `被${primaryBy}拿走` : '未拿到'}；备用「${backupName}」${
      backupBy ? `被${backupBy}拿走` : '未能获得'
    }。`,
  };
}

export function viewerLabel(viewer: Viewer, teams: readonly Team[]): string {
  if (viewer === 'observer') return '旁观';
  return teamById(teams, viewer).name;
}

export function roundStatusLabel(
  game: GameState,
  index: number,
): '已完成' | '进行中' | '待开始' {
  if (index < game.history.length) return '已完成';
  if (index === game.roundIndex) return '进行中';
  return '待开始';
}

export function teamOrderIndex(priority: readonly TeamId[], teamId: TeamId): number {
  const index = priority.indexOf(teamId);
  return index === -1 ? priority.length : index;
}

export function normalizeSeedInput(input: string, fallback: number): number {
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed)) >>> 0;
}
