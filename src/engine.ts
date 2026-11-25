// 群岛潮汐传送 —— 纯逻辑引擎（无 DOM 依赖，可在 Node 自检中直接调用）

import { findGate, oppositeDir } from './data.js';
import type { Dir, Side, TransitInfo } from './types.js';

export function otherSide(side: Side): Side {
  return side === 'tide' ? 'ebb' : 'tide';
}

export interface TransitInput {
  islandId: string;
  gateId: string;
  side: Side;
}

export type TransitOutcome =
  | {
      ok: true;
      info: TransitInfo;
      nextIslandId: string;
      nextSide: Side;
      facing: Dir;
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * 尝试通过一扇门。
 * 封死门（单向门背面）拒绝；当前卡面下规则为 null 拒绝。
 * 成功时给出完整落点核对信息：落点岛、落点门、是否翻卡、翻卡前后卡面、新朝向。
 */
export function tryTransit(input: TransitInput): TransitOutcome {
  const gate = findGate(input.islandId, input.gateId);

  if (gate.sealed) {
    return {
      ok: false,
      reason: `「${gate.name}」是封死的门背面，这一侧无法通行`,
    };
  }

  const rule = input.side === 'tide' ? gate.tide : gate.ebb;
  if (!rule) {
    return {
      ok: false,
      reason: `「${gate.name}」在${input.side === 'tide' ? '潮' : '汐'}面下不接受通行`,
    };
  }

  const targetGate = findGate(rule.toIsland, rule.toGate);
  const sideAfter: Side = rule.flip ? otherSide(input.side) : input.side;
  // 到了新岛按规则确定朝向：面朝落点门的反方向，即从门口朝岛内看
  const facingAfter = oppositeDir(targetGate.dir);

  const info: TransitInfo = {
    fromIsland: input.islandId,
    fromGate: gate.id,
    fromGateName: gate.name,
    sideBefore: input.side,
    flipped: rule.flip,
    sideAfter,
    toIsland: rule.toIsland,
    toGate: targetGate.id,
    toGateName: targetGate.name,
    facingAfter,
  };

  return {
    ok: true,
    info,
    nextIslandId: rule.toIsland,
    nextSide: sideAfter,
    facing: facingAfter,
  };
}
