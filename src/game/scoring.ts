import type {
  Category,
  CategoryBreakdown,
  GameState,
  ItemScoreLine,
  RoundResult,
  SetTier,
  Specimen,
  Standings,
  TeamId,
  TeamScore,
} from './types';
import { CATEGORY_ORDER, TEAM_IDS } from './types';

/** 同品类每多一件, 每件的成套加成: 2 件 / 3 件 / 4 件. */
export const SET_BONUS_PER_ITEM: Record<Exclude<SetTier, 'none'>, number> = {
  pair: 2,
  triad: 5,
  quad: 8,
};

export function setTierForCount(count: number): SetTier {
  if (count >= 4) return 'quad';
  if (count === 3) return 'triad';
  if (count === 2) return 'pair';
  return 'none';
}

export function tierLabel(tier: SetTier): string {
  switch (tier) {
    case 'pair':
      return '二件套';
    case 'triad':
      return '三件套';
    case 'quad':
      return '四件套';
    default:
      return '单件';
  }
}

export interface HeldSpecimen {
  specimen: Specimen;
  acquiredRound: number;
  via: 'primary' | 'backup';
}

/** 按获得时间汇总某队已经拿到的标本。 */
export function collectHoldings(
  history: readonly RoundResult[],
  teamId: TeamId,
): HeldSpecimen[] {
  const held: HeldSpecimen[] = [];
  for (const result of history) {
    for (const assignment of result.assignments) {
      if (assignment.teamId !== teamId) continue;
      const specimen = result.table.find((candidate) => candidate.id === assignment.specimenId);
      if (!specimen) continue;
      held.push({ specimen, acquiredRound: result.roundIndex, via: assignment.via });
    }
  }
  return held;
}

function countByCategory(held: readonly HeldSpecimen[]): Map<Category, HeldSpecimen[]> {
  const groups = new Map<Category, HeldSpecimen[]>();
  for (const item of held) {
    const list = groups.get(item.specimen.category);
    if (list) list.push(item);
    else groups.set(item.specimen.category, [item]);
  }
  return groups;
}

export interface ScoreDetail {
  score: TeamScore;
  bySpecimen: Map<string, ItemScoreLine>;
}

export function scoreTeam(history: readonly RoundResult[], teamId: TeamId): ScoreDetail {
  const held = collectHoldings(history, teamId);
  const groups = countByCategory(held);

  const categories: CategoryBreakdown[] = CATEGORY_ORDER.flatMap((category) => {
    const items = groups.get(category);
    if (!items) return [];
    const count = items.length;
    const tier = setTierForCount(count);
    const perItemBonus = tier === 'none' ? 0 : SET_BONUS_PER_ITEM[tier];
    return [
      {
        category,
        itemIds: items.map((item) => item.specimen.id),
        count,
        tier,
        perItemBonus,
        totalBonus: perItemBonus * count,
      },
    ];
  });

  const tierByCategory = new Map(categories.map((entry) => [entry.category, entry]));
  const items: ItemScoreLine[] = held.map((item) => {
    const breakdown = tierByCategory.get(item.specimen.category);
    const setBonus = breakdown?.perItemBonus ?? 0;
    const reasons = [`本体价值 ${item.specimen.value}`];
    if (setBonus > 0 && breakdown) {
      reasons.push(
        `${breakdown.category} ${breakdown.count} 件成套 (${tierLabel(breakdown.tier)}): +${setBonus}`,
      );
    } else {
      reasons.push(`${item.specimen.category} 单件, 无成套加成`);
    }
    reasons.push(
      item.via === 'primary'
        ? `第 ${item.acquiredRound + 1} 轮以首选获得`
        : `第 ${item.acquiredRound + 1} 轮以备用递补获得`,
    );
    return {
      specimenId: item.specimen.id,
      name: item.specimen.name,
      glyph: item.specimen.glyph,
      category: item.specimen.category,
      base: item.specimen.value,
      setBonus,
      total: item.specimen.value + setBonus,
      acquiredRound: item.acquiredRound,
      via: item.via,
      reasons,
    };
  });

  const baseTotal = items.reduce((sum, item) => sum + item.base, 0);
  const setBonusTotal = items.reduce((sum, item) => sum + item.setBonus, 0);

  return {
    score: {
      teamId,
      count: items.length,
      baseTotal,
      setBonusTotal,
      total: baseTotal + setBonusTotal,
      categories,
      items,
    },
    bySpecimen: new Map(items.map((item) => [item.specimenId, item])),
  };
}

export function computeStandings(history: readonly RoundResult[]): Standings {
  const scores = TEAM_IDS.map((teamId) => scoreTeam(history, teamId).score);
  const topScore = scores.reduce((best, score) => Math.max(best, score.total), 0);
  const tiedTeamIds = scores
    .filter((score) => score.total === topScore)
    .map((score) => score.teamId);
  return {
    scores,
    topScore,
    tiedTeamIds,
    isTie: tiedTeamIds.length > 1,
    roundsPlayed: history.length,
  };
}

export function totalForTeam(state: GameState, teamId: TeamId): number {
  return scoreTeam(state.history, teamId).score.total;
}
