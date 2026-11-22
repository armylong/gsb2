import type {
  Assignment,
  Choice,
  MissRecord,
  RoundResult,
  Specimen,
  TeamId,
  TraceEvent,
} from './types';

/** 每轮优先顺序按基础顺序左移: 第 0 轮红蓝金, 第 1 轮蓝金红, 依此循环. */
export function rotatePriority(base: readonly TeamId[], roundIndex: number): TeamId[] {
  const size = base.length;
  if (size === 0) return [];
  const shift = ((roundIndex % size) + size) % size;
  return [...base.slice(shift), ...base.slice(0, shift)];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateChoice(
  teamName: string,
  choice: Choice,
  table: readonly Specimen[],
): ValidationResult {
  const errors: string[] = [];
  const tableIds = new Set(table.map((specimen) => specimen.id));

  if (!choice.primary) {
    errors.push(`${teamName} 还没有选择首选标本`);
  } else if (!tableIds.has(choice.primary)) {
    errors.push(`${teamName} 的首选不在本回合桌面上`);
  }

  if (choice.backup !== null) {
    if (!tableIds.has(choice.backup)) {
      errors.push(`${teamName} 的备用不在本回合桌面上`);
    }
    if (choice.backup === choice.primary) {
      errors.push(`${teamName} 的备用不能与首选是同一件标本`);
    }
  }

  return { ok: errors.length === 0, errors };
}

interface ResolveInput {
  roundIndex: number;
  table: readonly Specimen[];
  priority: readonly TeamId[];
  choices: Record<TeamId, Choice>;
}

/**
 * 裁定顺序:
 * 1. 先按优先顺序处理所有首选, 已被分走的首选不能再给;
 * 2. 再按优先顺序处理未获得首选者的备用, 已经分给任何队的标本都不能被备用抢走;
 * 3. 每件标本最多归属一个队.
 */
export function resolveRound(input: ResolveInput): RoundResult {
  const { roundIndex, table, priority, choices } = input;
  const assignedBySpecimen = new Map<string, Assignment>();
  const assignedByTeam = new Map<TeamId, Assignment>();
  const trace: TraceEvent[] = [];
  let order = 0;

  const granted = (teamId: TeamId, specimenId: string, via: 'primary' | 'backup'): void => {
    order += 1;
    const assignment: Assignment = { teamId, specimenId, via, order };
    assignedBySpecimen.set(specimenId, assignment);
    assignedByTeam.set(teamId, assignment);
    trace.push({ pass: via, teamId, specimenId, outcome: 'granted' });
  };

  const attempted = (
    pass: 'primary' | 'backup',
    teamId: TeamId,
    specimenId: string | null,
  ): void => {
    if (specimenId === null) {
      trace.push({ pass, teamId, specimenId: null, outcome: 'no-request' });
      return;
    }
    const holder = assignedBySpecimen.get(specimenId);
    if (holder) {
      trace.push({
        pass,
        teamId,
        specimenId,
        outcome: 'taken',
        takenBy: holder.teamId,
      });
      return;
    }
    granted(teamId, specimenId, pass);
  };

  for (const teamId of priority) {
    attempted('primary', teamId, choices[teamId].primary);
  }

  for (const teamId of priority) {
    if (assignedByTeam.has(teamId)) continue;
    attempted('backup', teamId, choices[teamId].backup);
  }

  const traceByTeam = new Map<TeamId, TraceEvent[]>();
  for (const event of trace) {
    const list = traceByTeam.get(event.teamId);
    if (list) list.push(event);
    else traceByTeam.set(event.teamId, [event]);
  }

  const misses: MissRecord[] = [];
  for (const teamId of priority) {
    if (assignedByTeam.has(teamId)) continue;
    const choice = choices[teamId];
    const events = traceByTeam.get(teamId) ?? [];
    const primaryEvent = events.find((event) => event.pass === 'primary' && event.outcome === 'taken');
    const backupEvent = events.find((event) => event.pass === 'backup' && event.outcome === 'taken');
    const record: MissRecord = {
      teamId,
      primaryId: choice.primary,
      backupId: choice.backup,
      reason: choice.backup === null ? 'no-backup' : 'backup-taken',
    };
    if (primaryEvent?.takenBy) record.primaryTakenBy = primaryEvent.takenBy;
    if (backupEvent?.takenBy) record.backupTakenBy = backupEvent.takenBy;
    misses.push(record);
  }

  return {
    roundIndex,
    priority: [...priority],
    table: [...table],
    choices: {
      red: { ...choices.red },
      blue: { ...choices.blue },
      gold: { ...choices.gold },
    },
    assignments: [...assignedBySpecimen.values()].sort((a, b) => a.order - b.order),
    misses,
    trace,
  };
}
