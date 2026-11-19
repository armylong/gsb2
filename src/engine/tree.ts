import { ReactiveSelector } from './ReactiveSelector';
import { GuardBranch } from './GuardBranch';
import { Sequence } from './Sequence';
import { LowHpCondition, PatrolEnabledCondition, TargetInAlertCondition } from './conditions';
import { IdleAction, MoveToAction, WaitAction } from './actions';
import type { BranchId } from './types';

export interface BuiltTree {
  root: ReactiveSelector;
  all: { id: number; name: string; kind: string }[];
  branches: Record<Exclude<BranchId, 'idle'>, GuardBranch>;
  idle: IdleAction;
}

/**
 * 行为树结构(共 15 个节点):
 * 1  根·优先选择(ReactiveSelector, 每 tick 从最高优先重检)
 * ├─ 2  守卫·低生命撤退        3 条件: HP<阈值
 * │   └─ 4  顺序·撤退          5 移动→休息点   6 休息等待
 * ├─ 7  守卫·范围内追逐        8 条件: 目标在警戒范围
 * │   └─ 9  移动→目标(持续动作)
 * ├─ 10 守卫·普通巡逻          11 条件: 巡逻启用
 * │   └─ 12 顺序·巡逻          13 移动→巡逻点  14 巡逻点等待
 * └─ 15 原地待命(兜底, 持续 running)
 */
export function buildTree(): BuiltTree {
  const lowHp = new LowHpCondition(3);
  const retreatSeq = new Sequence(4, '顺序·撤退', [
    new MoveToAction(5, '移动→休息点', () => ({ kind: 'point', index: -1 }), () => '休息点'),
    new WaitAction(6, '休息点等待', 'rest', (ctx) => ctx.world.config.restWait),
  ]);
  const retreat = new GuardBranch(2, '分支·低生命撤退', [lowHp], retreatSeq);

  const inAlert = new TargetInAlertCondition(8);
  const chase = new GuardBranch(
    7,
    '分支·范围内追逐',
    [inAlert],
    new MoveToAction(
      9,
      '移动→目标',
      () => ({ kind: 'target' }),
      (ctx) => `目标(${ctx.world.target.pos.x.toFixed(0)},${ctx.world.target.pos.y.toFixed(0)})`,
      'hold',
    ),
  );

  const patrolEnabled = new PatrolEnabledCondition(11);
  const patrolSeq = new Sequence(12, '顺序·巡逻', [
    new MoveToAction(
      13,
      '移动→巡逻点',
      (ctx) => ({ kind: 'point', index: ctx.world.npc.patrolIndex }),
      (ctx) => `巡逻点#${ctx.world.npc.patrolIndex}`,
    ),
    new WaitAction(14, '巡逻点等待', 'patrol', (ctx) => ctx.world.config.patrolWait),
  ]);
  const patrol = new GuardBranch(10, '分支·普通巡逻', [patrolEnabled], patrolSeq);

  const idle = new IdleAction(15);

  const root = new ReactiveSelector(1, '根·优先选择', [retreat, chase, patrol, idle]);

  const all = [
    { id: 1, name: root.name, kind: root.kind },
    ...flatten(retreat),
    ...flatten(chase),
    ...flatten(patrol),
    { id: idle.id, name: idle.name, kind: idle.kind },
  ];

  return { root, all, branches: { retreat, chase, patrol }, idle };
}

function flatten(node: { id: number; name: string; kind: string }): {
  id: number;
  name: string;
  kind: string;
}[] {
  const out = [{ id: node.id, name: node.name, kind: node.kind }];
  const withChildren = node as unknown as { getChildren?: () => unknown[] };
  for (const child of withChildren.getChildren?.() ?? []) {
    out.push(...flatten(child as { id: number; name: string; kind: string }));
  }
  return out;
}
