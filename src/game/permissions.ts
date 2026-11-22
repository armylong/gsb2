import type { RoundState, TeamChoices, TeamId } from './types.ts';

export type ViewAs = TeamId | 'public';

/**
 * 阶段权限：
 * - 开选前（未开牌）：任何视角只能看到公共信息（标本、优先顺序、确认状态），
 *   以及本队自己的首选/备用；别队的选择一律隐藏。
 * - 开牌后：所有队的选择、分配来由、空手原因全部公开。
 */
export function canSeeChoices(round: RoundState, viewAs: ViewAs): boolean {
  if (round.log) return true;
  return viewAs !== 'public';
}

export function visibleChoices(
  round: RoundState,
  viewAs: ViewAs,
): Partial<Record<TeamId, TeamChoices>> {
  const out: Partial<Record<TeamId, TeamChoices>> = {};
  (Object.keys(round.choices) as TeamId[]).forEach((id) => {
    // 开牌后全部公开；开选前只有「本队视角 + 正是该队」才能看到具体选择
    if (round.log || (viewAs !== 'public' && id === viewAs)) {
      out[id] = round.choices[id];
    } else {
      out[id] = {
        primaryId: null,
        backupId: null,
        confirmed: round.choices[id].confirmed,
      };
    }
  });
  return out;
}

export function allConfirmed(round: RoundState): boolean {
  return (Object.keys(round.choices) as TeamId[]).every((id) => round.choices[id].confirmed);
}
