import { resolveRound, rotatePriority, validateChoice } from './draft';
import { createRng, deriveSeed } from './rng';
import {
  scoreTeam,
  computeStandings,
  collectHoldings,
  SET_BONUS_PER_ITEM,
  setTierForCount,
} from './scoring';
import type { HeldSpecimen } from './scoring';
import { buildTeams, getTeam } from './teams';
import type {
  Choice,
  GameState,
  Phase,
  RoundResult,
  Scenario,
  Selection,
  Specimen,
  TeamControl,
  TeamId,
  Viewer,
} from './types';
import { TEAM_IDS } from './types';

const EMPTY_SELECTION: Selection = {
  primary: null,
  backup: null,
  confirmed: false,
  source: 'manual',
};

export function emptySelection(): Selection {
  return { ...EMPTY_SELECTION };
}

export function emptySelections(): Record<TeamId, Selection> {
  return {
    red: emptySelection(),
    blue: emptySelection(),
    gold: emptySelection(),
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

export function currentRound(state: GameState): Scenario['rounds'][number] {
  const round = state.rounds[state.roundIndex];
  if (!round) {
    throw new Error(`回合索引越界: ${state.roundIndex}`);
  }
  return round;
}

export function currentPriority(state: GameState): TeamId[] {
  return rotatePriority(TEAM_IDS, state.roundIndex);
}

export function selectionsAsChoices(
  selections: Record<TeamId, Selection>,
): Record<TeamId, Choice> {
  return {
    red: { primary: selections.red.primary, backup: selections.red.backup },
    blue: { primary: selections.blue.primary, backup: selections.blue.backup },
    gold: { primary: selections.gold.primary, backup: selections.gold.backup },
  };
}

/**
 * 自动队的"眼缘"幅度：策略分每差一档为 10 分，眼缘最多 12 分，
 * 因此只有相邻档位才会被种子偶尔翻转，选择既受策略主导又对种子敏感。
 */
const AFFINITY_SPAN = 12;

/** 自动队按策略给候选打分；分数只由种子、桌面与已持有标本决定。 */
export function autoPick(args: {
  teamId: TeamId;
  strategy: 'set' | 'value';
  table: readonly Specimen[];
  held: readonly HeldSpecimen[];
  seed: number;
  roundIndex: number;
}): Choice {
  const { teamId, strategy, table, held, seed, roundIndex } = args;
  if (table.length === 0) return { primary: null, backup: null };

  const rng = createRng(deriveSeed(seed, roundIndex, teamId, strategy));
  const affinity = new Map<string, number>();
  for (const specimen of table) {
    affinity.set(specimen.id, rng() * AFFINITY_SPAN);
  }

  const heldCounts = new Map<string, number>();
  for (const item of held) {
    heldCounts.set(
      item.specimen.category,
      (heldCounts.get(item.specimen.category) ?? 0) + 1,
    );
  }

  const scoreOf = (specimen: Specimen): number => {
    const charm = affinity.get(specimen.id) ?? 0;
    if (strategy === 'value') {
      return specimen.value * 10 + charm;
    }
    const count = heldCounts.get(specimen.category) ?? 0;
    const currentTier = setTierForCount(count);
    const nextCount = Math.min(count + 1, 4);
    const nextTier = setTierForCount(nextCount);
    const currentPerItem = currentTier === 'none' ? 0 : SET_BONUS_PER_ITEM[currentTier];
    const nextPerItem = nextTier === 'none' ? 0 : SET_BONUS_PER_ITEM[nextTier];
    const marginal = nextPerItem * nextCount - currentPerItem * count;
    // 已持有同品类的件数提供轻微倾向，使成套优先在加成相等时先补已有的套。
    return marginal * 10 + count * 3 + specimen.value + charm;
  };

  const ranked = [...table].sort((a, b) => {
    const delta = scoreOf(b) - scoreOf(a);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });

  const primary = ranked[0]?.id ?? null;
  const backup = ranked[1]?.id ?? null;
  return { primary, backup };
}

function withAutoPicks(state: GameState): GameState {
  const round = currentRound(state);
  const heldByTeam = {
    red: collectHoldings(state.history, 'red'),
    blue: collectHoldings(state.history, 'blue'),
    gold: collectHoldings(state.history, 'gold'),
  } satisfies Record<TeamId, HeldSpecimen[]>;

  const selections = { ...state.selections };
  for (const team of state.teams) {
    if (team.control !== 'auto') continue;
    const pick = autoPick({
      teamId: team.id,
      strategy: team.strategy,
      table: round.table,
      held: heldByTeam[team.id],
      seed: state.seed,
      roundIndex: state.roundIndex,
    });
    selections[team.id] = {
      primary: pick.primary,
      backup: pick.backup,
      confirmed: pick.primary !== null,
      source: 'auto',
    };
  }
  return { ...state, selections };
}

export interface CreateGameOptions {
  seed?: number;
  teamSetups?: Scenario['teamSetups'];
}

export function createGame(scenario: Scenario, options: CreateGameOptions = {}): GameState {
  assertScenario(scenario);
  const seed = options.seed ?? scenario.seed;
  const setups: Scenario['teamSetups'] = {};
  for (const teamId of TEAM_IDS) {
    const merged = { ...scenario.teamSetups?.[teamId], ...options.teamSetups?.[teamId] };
    if (Object.keys(merged).length > 0) setups[teamId] = merged;
  }
  const teams = buildTeams(setups);
  const now = timestamp();
  const base: GameState = {
    version: 1,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    scenarioTagline: scenario.tagline,
    seed: seed >>> 0,
    roundIndex: 0,
    phase: 'selecting',
    teams,
    rounds: scenario.rounds,
    selections: emptySelections(),
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  return withAutoPicks(base);
}

export function assertScenario(scenario: Scenario): void {
  if (!scenario.rounds.length) {
    throw new Error('场景至少需要一轮');
  }
  const seen = new Set<string>();
  for (const round of scenario.rounds) {
    if (!round.table.length) {
      throw new Error(`回合「${round.title}」没有标本`);
    }
    for (const specimen of round.table) {
      if (seen.has(specimen.id)) {
        throw new Error(`标本 id 重复: ${specimen.id}`);
      }
      seen.add(specimen.id);
    }
  }
}

export function canEdit(state: GameState, teamId: TeamId): boolean {
  if (state.phase !== 'selecting') return false;
  return getTeam(state.teams, teamId).control === 'manual';
}

export function setSelection(
  state: GameState,
  teamId: TeamId,
  patch: Partial<Pick<Selection, 'primary' | 'backup'>>,
): GameState {
  if (!canEdit(state, teamId)) return state;
  const selection = state.selections[teamId];
  const primary = patch.primary !== undefined ? patch.primary : selection.primary;
  const backup = patch.backup !== undefined ? patch.backup : selection.backup;
  const normalizedBackup = backup !== null && backup === primary ? null : backup;
  return {
    ...state,
    selections: {
      ...state.selections,
      [teamId]: {
        primary,
        backup: normalizedBackup,
        confirmed: false,
        source: 'manual',
      },
    },
    updatedAt: timestamp(),
  };
}

export function choiceErrors(state: GameState, teamId: TeamId): string[] {
  const team = getTeam(state.teams, teamId);
  const selection = state.selections[teamId];
  return validateChoice(
    team.name,
    { primary: selection.primary, backup: selection.backup },
    currentRound(state).table,
  ).errors;
}

export function confirmSelection(state: GameState, teamId: TeamId): GameState {
  if (!canEdit(state, teamId)) return state;
  if (choiceErrors(state, teamId).length > 0) return state;
  const selection = state.selections[teamId];
  return {
    ...state,
    selections: {
      ...state.selections,
      [teamId]: { ...selection, confirmed: true },
    },
    updatedAt: timestamp(),
  };
}

export function unconfirmSelection(state: GameState, teamId: TeamId): GameState {
  if (!canEdit(state, teamId)) return state;
  const selection = state.selections[teamId];
  if (!selection.confirmed) return state;
  return {
    ...state,
    selections: {
      ...state.selections,
      [teamId]: { ...selection, confirmed: false },
    },
    updatedAt: timestamp(),
  };
}

export interface OpenCheck {
  canOpen: boolean;
  pendingTeamIds: TeamId[];
  errors: string[];
}

export function checkOpen(state: GameState): OpenCheck {
  const pendingTeamIds: TeamId[] = [];
  const errors: string[] = [];
  if (state.phase !== 'selecting') {
    return { canOpen: false, pendingTeamIds, errors: ['本回合已经开牌'] };
  }
  for (const team of state.teams) {
    const selection = state.selections[team.id];
    if (!selection.confirmed) {
      pendingTeamIds.push(team.id);
    }
    for (const error of choiceErrors(state, team.id)) {
      errors.push(error);
    }
  }
  return {
    canOpen: pendingTeamIds.length === 0 && errors.length === 0,
    pendingTeamIds,
    errors,
  };
}

export function openRound(state: GameState): GameState {
  const check = checkOpen(state);
  if (!check.canOpen) {
    throw new Error(`还不能开牌: ${[...check.pendingTeamIds, ...check.errors].join('; ')}`);
  }
  const round = currentRound(state);
  const priority = currentPriority(state);
  const result = resolveRound({
    roundIndex: state.roundIndex,
    table: round.table,
    priority,
    choices: selectionsAsChoices(state.selections),
  });
  return {
    ...state,
    phase: 'opened',
    history: [...state.history, result],
    updatedAt: timestamp(),
  };
}

export function nextRound(state: GameState): GameState {
  if (state.phase !== 'opened') return state;
  if (state.roundIndex + 1 >= state.rounds.length) return state;
  const advanced: GameState = {
    ...state,
    roundIndex: state.roundIndex + 1,
    phase: 'selecting',
    selections: emptySelections(),
    updatedAt: timestamp(),
  };
  return withAutoPicks(advanced);
}

export function restartGame(state: GameState, seed = state.seed): GameState {
  const base: GameState = {
    ...state,
    seed: seed >>> 0,
    roundIndex: 0,
    phase: 'selecting',
    selections: emptySelections(),
    history: [],
    updatedAt: timestamp(),
  };
  return withAutoPicks(base);
}

export function setTeamControl(
  state: GameState,
  teamId: TeamId,
  control: TeamControl,
): GameState {
  if (state.phase !== 'selecting') return state;
  const teams = state.teams.map((team) =>
    team.id === teamId ? { ...team, control } : team,
  );
  const next: GameState = { ...state, teams, updatedAt: timestamp() };
  if (control === 'auto') return withAutoPicks(next);
  // 交回手动时清空自动选择，由操作者本人重新挑选并确认。
  return {
    ...next,
    selections: {
      ...next.selections,
      [teamId]: emptySelection(),
    },
  };
}

/** 配置动作只允许在开选前、且由旁观者或该队本人执行。 */
export function canConfigure(state: GameState, viewer: Viewer, teamId: TeamId): boolean {
  if (state.phase !== 'selecting') return false;
  return viewer === 'observer' || viewer === teamId;
}

export function setTeamStrategy(
  state: GameState,
  teamId: TeamId,
  strategy: 'set' | 'value',
): GameState {
  if (state.phase !== 'selecting') return state;
  const teams = state.teams.map((team) =>
    team.id === teamId ? { ...team, strategy } : team,
  );
  const next: GameState = { ...state, teams, updatedAt: timestamp() };
  const team = getTeam(teams, teamId);
  if (team.control === 'auto') return withAutoPicks(next);
  return next;
}

/** 演示脚本：仅为手动队填入场景预设；自动队保持自身选择。 */
export function applyDemoScript(state: GameState): GameState {
  if (state.phase !== 'selecting') return state;
  const round = currentRound(state);
  const recommendations = round.recommendations;
  if (!recommendations) return state;

  let next = state;
  for (const teamId of TEAM_IDS) {
    const rec = recommendations[teamId];
    if (!rec) continue;
    if (!canEdit(next, teamId)) continue;
    const tableIds = new Set(round.table.map((specimen) => specimen.id));
    if (!tableIds.has(rec.primary)) continue;
    if (rec.backup !== null && !tableIds.has(rec.backup)) continue;
    if (rec.backup === rec.primary) continue;
    next = setSelection(next, teamId, { primary: rec.primary, backup: rec.backup });
    if (choiceErrors(next, teamId).length === 0) {
      next = confirmSelection(next, teamId);
    }
  }
  return next;
}

export function lastResult(state: GameState): RoundResult | null {
  return state.history[state.history.length - 1] ?? null;
}

export function standings(state: GameState) {
  return computeStandings(state.history);
}

export function isFinalRound(state: GameState): boolean {
  return state.roundIndex >= state.rounds.length - 1;
}

export interface RoundView {
  phase: Phase;
  roundIndex: number;
  roundTitle: string;
  roundBrief: string;
  priority: TeamId[];
  table: Specimen[];
  selections: Record<TeamId, SelectionView>;
  result: RoundResult | null;
  allConfirmed: boolean;
  pendingTeamIds: TeamId[];
}

export interface SelectionView {
  primary: string | null;
  backup: string | null;
  confirmed: boolean;
  source: 'manual' | 'auto';
  hidden: boolean;
  isSelf: boolean;
}

/**
 * 按阶段和视角裁剪信息：
 * - 选牌阶段：各队只能看到自己的选择，公共信息（确认状态、桌面、优先顺序）可见；
 * - 开牌后：所有选择与裁定明细公开。
 */
export function toRoundView(state: GameState, viewer: Viewer): RoundView {
  const round = currentRound(state);
  const opened = state.phase === 'opened';
  const result = opened ? lastResult(state) : null;
  const check = checkOpen(state);
  const selections = {} as Record<TeamId, SelectionView>;
  for (const teamId of TEAM_IDS) {
    const selection = state.selections[teamId];
    const isSelf = viewer === teamId;
    const hidden = !opened && !isSelf;
    selections[teamId] = {
      primary: hidden ? null : selection.primary,
      backup: hidden ? null : selection.backup,
      confirmed: selection.confirmed,
      source: selection.source,
      hidden,
      isSelf,
    };
  }
  return {
    phase: state.phase,
    roundIndex: state.roundIndex,
    roundTitle: round.title,
    roundBrief: round.brief,
    priority: currentPriority(state),
    table: round.table,
    selections,
    result,
    allConfirmed: check.pendingTeamIds.length === 0 && check.errors.length === 0,
    pendingTeamIds: check.pendingTeamIds,
  };
}

export function scoreForTeam(state: GameState, teamId: TeamId) {
  return scoreTeam(state.history, teamId);
}

const GAME_VERSION = 1;

export interface SaveEnvelope {
  version: 1;
  saves: import('./types').SaveFile[];
}

export function isGameState(value: unknown): value is GameState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GameState>;
  return (
    candidate.version === GAME_VERSION &&
    typeof candidate.scenarioId === 'string' &&
    typeof candidate.seed === 'number' &&
    typeof candidate.roundIndex === 'number' &&
    (candidate.phase === 'selecting' || candidate.phase === 'opened') &&
    Array.isArray(candidate.teams) &&
    Array.isArray(candidate.rounds) &&
    Array.isArray(candidate.history) &&
    !!candidate.selections &&
    typeof candidate.selections === 'object'
  );
}

export function isViewer(value: unknown): value is Viewer {
  return value === 'observer' || value === 'red' || value === 'blue' || value === 'gold';
}

export function isSaveFile(value: unknown): value is import('./types').SaveFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<import('./types').SaveFile>;
  return (
    candidate.version === 1 &&
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.savedAt === 'string' &&
    isViewer(candidate.viewTeam) &&
    isGameState(candidate.game)
  );
}
