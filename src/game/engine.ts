import { CATEGORIES, TEAMS, TEAM_IDS } from './constants.ts';
import { decisionRng, hashSeed } from './rng.ts';
import { generateSandboxRound, SCENARIOS } from './scenarios.ts';
import type {
  CategoryId,
  GameState,
  PickLog,
  RoundState,
  ScenarioId,
  Specimen,
  TeamChoices,
  TeamId,
} from './types.ts';

export const STATE_VERSION = 1;

// ---------- 优先顺序轮换：每轮整体左旋一位 ----------

export function priorityForRound(roundIndex: number): TeamId[] {
  const shift = roundIndex % TEAM_IDS.length;
  return [...TEAM_IDS.slice(shift), ...TEAM_IDS.slice(0, shift)];
}

function emptyChoices(): TeamChoices {
  return { primaryId: null, backupId: null, confirmed: false };
}

function makeRound(
  index: number,
  specimens: Specimen[],
  presets?: Partial<Record<TeamId, TeamChoices>>,
): RoundState {
  const choices = {
    A: { ...emptyChoices(), ...(presets?.A ?? {}) },
    B: { ...emptyChoices(), ...(presets?.B ?? {}) },
    C: { ...emptyChoices(), ...(presets?.C ?? {}) },
  } as Record<TeamId, TeamChoices>;
  return {
    index,
    specimens,
    priority: priorityForRound(index),
    choices,
    log: null,
    allocations: null,
  };
}

// ---------- 自动队伍的两种简单偏好（同种子可重复） ----------

/** 截至当前轮之前，各队每个品类已到手的件数 */
export function ownedCountsBefore(
  state: Pick<GameState, 'rounds'>,
  roundIndex: number,
): Record<TeamId, Record<CategoryId, number>> {
  const zero = (): Record<CategoryId, number> => ({ rock: 0, insect: 0, plant: 0 });
  const owned = { A: zero(), B: zero(), C: zero() } as Record<TeamId, Record<CategoryId, number>>;
  state.rounds.slice(0, roundIndex).forEach((round) => {
    round.log?.forEach((entry) => {
      if (!entry.wonSpecimenId) return;
      const spec = round.specimens.find((s) => s.id === entry.wonSpecimenId);
      if (spec) owned[entry.teamId][spec.category] += 1;
    });
  });
  return owned;
}

/**
 * valueFirst（蓝雀队）：单件分值优先，平手交给种子随机数；
 * setSeeker（绿蜥队）：距成套越近越优先（已成套则开启下一套计数），其次分值，再交给随机数。
 * 两种策略都返回两个不同标本：首选与备用。
 */
export function autoPick(
  teamId: TeamId,
  strategy: 'valueFirst' | 'setSeeker',
  round: RoundState,
  seed: number,
  owned: Record<CategoryId, number>,
): { primaryId: string; backupId: string } {
  const rng = decisionRng(seed, round.index, teamId, strategy);
  const setSize = (cat: CategoryId): number => CATEGORIES[cat].setSize;
  const distanceToSet = (cat: CategoryId): number => setSize(cat) - (owned[cat] % setSize(cat));

  const scored = round.specimens.map((spec) => {
    const tie = rng();
    if (strategy === 'valueFirst') {
      return { spec, key: spec.value * 1000 + tie * 10 };
    }
    // setSeeker：距离越小（越接近成套）越靠前；同分看单件分值
    const distance = distanceToSet(spec.category);
    return { spec, key: -distance * 100000 + spec.value * 1000 + tie * 10 };
  });
  scored.sort((x, y) => y.key - x.key);
  return { primaryId: scored[0].spec.id, backupId: scored[1].spec.id };
}

// ---------- 开牌：按本轮优先顺序处理撞选 ----------

/**
 * 规则：
 * 1. 按 priority 逐队处理；首选未被占用即拿走。
 * 2. 首选落空的队再看备用；备用已被占用则记「备选已被别人拿走」。
 * 3. 备用与首选相同视为未交备用；同一件标本最多分给一个队。
 */
export function resolveRound(round: RoundState): PickLog[] {
  const takenBy = new Map<string, TeamId>();
  const log: PickLog[] = [];

  round.priority.forEach((teamId, priorityIndex) => {
    const choice = round.choices[teamId];
    const primary = choice.primaryId;
    // 备用若与首选相同，视作没有有效备用（同一件不可能给两次）
    const backup = choice.backupId && choice.backupId !== primary ? choice.backupId : null;

    let outcome: PickLog['outcome'];
    let wonSpecimenId: string | null = null;
    let missReason: PickLog['missReason'] = null;
    let primaryTakenBy: TeamId | null = null;
    let backupTakenBy: TeamId | null = null;

    if (primary && !takenBy.has(primary)) {
      takenBy.set(primary, teamId);
      wonSpecimenId = primary;
      outcome = 'primaryWon';
    } else {
      if (primary) primaryTakenBy = takenBy.get(primary) ?? null;
      if (backup && !takenBy.has(backup)) {
        takenBy.set(backup, teamId);
        wonSpecimenId = backup;
        outcome = 'backupWon';
      } else if (backup) {
        backupTakenBy = takenBy.get(backup) ?? null;
        outcome = 'missedBackupTaken';
        missReason = 'backupTaken';
      } else {
        outcome = 'missedNoBackup';
        missReason = 'noBackup';
      }
    }

    log.push({
      teamId,
      priorityIndex,
      primaryId: primary,
      backupId: backup,
      outcome,
      wonSpecimenId,
      missReason,
      primaryTakenBy,
      backupTakenBy,
    });
  });

  return log;
}

export function allocationsFromLog(log: PickLog[]): Record<TeamId, string | null> {
  return {
    A: log.find((e) => e.teamId === 'A')?.wonSpecimenId ?? null,
    B: log.find((e) => e.teamId === 'B')?.wonSpecimenId ?? null,
    C: log.find((e) => e.teamId === 'C')?.wonSpecimenId ?? null,
  };
}

// ---------- 可重复性指纹 ----------

export function computeFingerprint(
  seed: number,
  round: RoundState,
  log: PickLog[],
): string {
  const choiceText = TEAM_IDS.map((id) => {
    const c = round.choices[id];
    return `${id}:${c.primaryId ?? '∅'}>${c.backupId ?? '∅'}`;
  }).join('|');
  const resultText = log
    .map((e) => `${e.teamId}=${e.wonSpecimenId ?? '∅'}:${e.outcome}`)
    .join('|');
  return hashSeed(`fp|${seed}|r${round.index}|${round.priority.join('>')}|${choiceText}|${resultText}`)
    .toString(16)
    .padStart(8, '0');
}

// ---------- 计分：品类成套，可逐件展开来由 ----------

export interface ScoredItem {
  specimen: Specimen;
  roundIndex: number;
  base: number;
  setBonus: number;
  total: number;
  note: string;
}

export interface TeamScore {
  teamId: TeamId;
  total: number;
  items: ScoredItem[];
  setsCompleted: number;
  missedRounds: { roundIndex: number; reason: 'noBackup' | 'backupTaken' }[];
}

export function scoreGame(rounds: RoundState[]): Record<TeamId, TeamScore> {
  const zero = (): Record<CategoryId, number> => ({ rock: 0, insect: 0, plant: 0 });
  const counts = { A: zero(), B: zero(), C: zero() } as Record<TeamId, Record<CategoryId, number>>;
  const result: Record<TeamId, TeamScore> = {
    A: { teamId: 'A', total: 0, items: [] as ScoredItem[], setsCompleted: 0, missedRounds: [] as TeamScore['missedRounds'] },
    B: { teamId: 'B', total: 0, items: [] as ScoredItem[], setsCompleted: 0, missedRounds: [] as TeamScore['missedRounds'] },
    C: { teamId: 'C', total: 0, items: [] as ScoredItem[], setsCompleted: 0, missedRounds: [] as TeamScore['missedRounds'] },
  };

  rounds.forEach((round) => {
    if (!round.log) return;
    // log 本身按优先顺序排列，同一轮内谁先成套也由此确定
    round.log.forEach((entry) => {
      const score = result[entry.teamId];
      if (!entry.wonSpecimenId) {
        if (entry.missReason) {
          score.missedRounds.push({ roundIndex: round.index, reason: entry.missReason });
        }
        return;
      }
      const specimen = round.specimens.find((s) => s.id === entry.wonSpecimenId);
      if (!specimen) return;
      const cat = specimen.category;
      counts[entry.teamId][cat] += 1;
      const catDef = CATEGORIES[cat];
      let bonus = 0;
      let note = `单件基础分 ${specimen.value}`;
      if (counts[entry.teamId][cat] % catDef.setSize === 0) {
        bonus = catDef.setBonus;
        score.setsCompleted += 1;
        note = `单件基础分 ${specimen.value}；凑成第 ${score.setsCompleted} 套「${catDef.label}」+${bonus}`;
      }
      const item: ScoredItem = {
        specimen,
        roundIndex: round.index,
        base: specimen.value,
        setBonus: bonus,
        total: specimen.value + bonus,
        note,
      };
      score.items.push(item);
      score.total += item.total;
    });
  });

  return result;
}

export function tiedTeamIds(scores: Record<TeamId, TeamScore>): TeamId[] {
  const max = Math.max(...TEAM_IDS.map((id) => scores[id].total));
  const leaders = TEAM_IDS.filter((id) => scores[id].total === max);
  return leaders.length > 1 ? leaders : [];
}

// ---------- 开局：内置回合 / 沙盒 ----------

export function buildGame(scenarioId: ScenarioId, seedOverride?: number): GameState {
  const scenario = SCENARIOS[scenarioId];
  const seed = seedOverride ?? scenario.seed;

  let rounds: RoundState[];
  if (scenarioId === 'sandbox') {
    rounds = Array.from({ length: scenario.totalRounds }, (_, i) =>
      makeRound(i, generateSandboxRound(seed, i)),
    );
    // 自动队在开局即按种子与偏好定选并确认；手动 A 队留空
    const partial: Pick<GameState, 'rounds'> = { rounds };
    rounds.forEach((round) => {
      const owned = ownedCountsBefore(partial, round.index);
      TEAMS.filter((t) => t.autoStrategy).forEach((team) => {
        const pick = autoPick(team.id, team.autoStrategy!, round, seed, owned[team.id]);
        round.choices[team.id] = { ...pick, confirmed: true };
      });
    });
  } else {
    rounds = scenario.rounds.map((setup, i) => makeRound(i, setup.specimens, setup.presets));
  }

  return {
    version: STATE_VERSION,
    scenarioId,
    seed,
    teams: TEAMS.map((t) => ({ ...t })),
    categories: {
      rock: { ...CATEGORIES.rock },
      insect: { ...CATEGORIES.insect },
      plant: { ...CATEGORIES.plant },
    },
    rounds,
    currentRound: 0,
    fingerprint: null,
  };
}
