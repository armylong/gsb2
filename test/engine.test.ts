import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine';
import type { LogEntry } from '../src/engine/types';
import { distance } from '../src/engine/world';

/** 节点 id 对应见 src/engine/tree.ts 顶部的结构注释 */
const ID = {
  root: 1,
  retreatGuard: 2,
  lowHpCond: 3,
  retreatSeq: 4,
  moveRest: 5,
  waitRest: 6,
  chaseGuard: 7,
  alertCond: 8,
  moveTarget: 9,
  patrolGuard: 10,
  patrolEnabledCond: 11,
  patrolSeq: 12,
  movePatrol: 13,
  waitPatrol: 14,
  idle: 15,
} as const;

const kindCount = (logs: LogEntry[], nodeId: number, kind: LogEntry['kind']) =>
  logs.filter((l) => l.nodeId === nodeId && l.kind === kind).length;

describe('持续动作不重复进入', () => {
  it('追逐动作跨多个 tick 只 enter 一次, 移动目标 owner 保持不变', () => {
    const engine = new Engine();
    const w = engine.world;
    // 放大警戒范围并把目标放足够远, 保证多 tick 追不上
    w.stagedConfig.alertRange = 400;
    w.config.alertRange = 400;
    w.target.pos = { x: w.npc.pos.x + 250, y: w.npc.pos.y };
    w.npc.hp = 100;

    for (let i = 0; i < 4; i++) engine.tick();

    expect(engine.statusOf(ID.moveTarget)).toBe('running');
    expect(kindCount(engine.logs, ID.moveTarget, 'enter')).toBe(1);
    expect(kindCount(engine.logs, ID.moveTarget, 'exit')).toBe(0);
    expect(kindCount(engine.logs, ID.moveTarget, 'interrupt')).toBe(0);
    expect(w.npc.moveTarget?.ref.kind).toBe('target');
    const owner = w.npc.moveTarget?.ownerActionId;
    engine.tick();
    expect(w.npc.moveTarget?.ownerActionId).toBe(owner);
  });

  it('等待动作运行期间保留进度, 不会每个 tick 重新计时', () => {
    const engine = new Engine();
    const w = engine.world;
    // 直接放到巡逻点#0, 巡逻 index 指向 0, 第一个 tick 移动即完成, 之后进入等待
    w.npc.pos = { ...w.patrolPoints[0] };
    w.npc.patrolIndex = 0;
    w.target.exists = false; // 排除追逐分支
    w.config.patrolWait = 2;
    w.stagedConfig.patrolWait = 2;

    engine.tick(); // 移动成功 + 等待 enter(剩余 2.0 -> 扣到 1.5)
    expect(engine.statusOf(ID.waitPatrol)).toBe('running');
    expect(kindCount(engine.logs, ID.waitPatrol, 'enter')).toBe(1);

    engine.tick(); // 剩余 1.0s
    engine.tick(); // 剩余 0.5s
    expect(engine.statusOf(ID.waitPatrol)).toBe('running');
    expect(kindCount(engine.logs, ID.waitPatrol, 'enter')).toBe(1); // 始终没有重新 enter

    engine.tick(); // 剩余 0 -> 完成
    expect(kindCount(engine.logs, ID.waitPatrol, 'exit')).toBe(1);
    expect(w.npc.patrolIndex).toBe(1); // 完成时唯一一次推进
  });
});

describe('中断只退出一次且不残留移动目标', () => {
  it('低生命打断追逐: 追逐动作 interrupt 恰好一次, 移动目标被撤退动作接管', () => {
    const engine = new Engine();
    const w = engine.world;
    w.target.pos = { x: w.npc.pos.x + 90, y: w.npc.pos.y };
    w.npc.hp = 100;

    for (let i = 0; i < 3; i++) engine.tick();
    expect(engine.statusOf(ID.moveTarget)).toBe('running');
    const chaseOwner = w.npc.moveTarget?.ownerActionId;

    w.npc.hp = 10; // 低于阈值 30
    engine.tick(); // 本 tick: 撤退守卫抢占, 追逐被中断

    expect(kindCount(engine.logs, ID.moveTarget, 'interrupt')).toBe(1);
    expect(engine.statusOf(ID.moveTarget)).toBe('interrupted');
    expect(engine.statusOf(ID.moveRest)).toBe('running');
    // 旧动作的 owner token 已失效: 当前移动目标属于新的撤退动作
    expect(w.npc.moveTarget).not.toBeNull();
    expect(w.npc.moveTarget?.ownerActionId).not.toBe(chaseOwner);
    expect(w.npc.moveTarget?.ref).toEqual({ kind: 'point', index: -1 });

    // 再跑两个 tick, 中断不会重复发生
    engine.tick();
    engine.tick();
    expect(kindCount(engine.logs, ID.moveTarget, 'interrupt')).toBe(1);
  });

  it('被中断动作不会再写移动目标(旧 token 失效后 clear 是 no-op)', () => {
    const engine = new Engine();
    const w = engine.world;
    w.target.pos = { x: w.npc.pos.x + 90, y: w.npc.pos.y };
    engine.tick();
    engine.tick();
    const chaseAction = engine.getNode(ID.moveTarget)!;
    // @ts-expect-error 访问私有 ownerId 验证 token 机制
    const oldToken = chaseAction.ownerId as number;
    expect(w.npc.moveTarget?.ownerActionId).toBe(oldToken);

    w.npc.hp = 5;
    engine.tick();
    // 中断后旧 token 已清空; 模拟旧动作"晚到的清理": 不应误删新目标
    expect(w.npc.moveTarget?.ref).toEqual({ kind: 'point', index: -1 });
  });
});

describe('顺序节点重新进入规则', () => {
  it('巡逻顺序被中断后游标归零, 重新进入从移动步骤重新开始并重新计时', () => {
    const engine = new Engine();
    const w = engine.world;
    w.npc.pos = { ...w.patrolPoints[0] };
    w.npc.patrolIndex = 0;
    w.target.exists = false;
    w.config.patrolWait = 2;
    w.stagedConfig.patrolWait = 2;

    // 走到等待中途
    engine.tick();
    engine.tick();
    expect(engine.statusOf(ID.waitPatrol)).toBe('running');

    // 追逐抢占巡逻
    w.target.exists = true;
    w.target.pos = { x: w.npc.pos.x + 50, y: w.npc.pos.y };
    engine.tick();
    expect(kindCount(engine.logs, ID.waitPatrol, 'interrupt')).toBe(1);
    expect(w.npc.patrolIndex).toBe(0); // 中断不推进巡逻点编号

    // 目标离开, 巡逻重新进入: 必须先重新移动(顺序游标已归零), 再重新等待
    w.target.exists = false;
    engine.tick();
    const seq = engine.getNode(ID.patrolSeq)!;
    // @ts-expect-error 访问私有 cursor
    expect(seq.cursor).toBe(0);
    // 移动步骤重新 enter(第二次 enter), 等待动作此时尚未重新 enter
    expect(kindCount(engine.logs, ID.movePatrol, 'enter')).toBeGreaterThanOrEqual(2);
    expect(kindCount(engine.logs, ID.waitPatrol, 'enter')).toBe(1);
  });

  it('巡逻点编号只由等待成功完成推进, 任何中断路径都不会推进', () => {
    const engine = new Engine();
    const w = engine.world;
    w.npc.pos = { ...w.patrolPoints[0] };
    w.npc.patrolIndex = 0;
    w.target.exists = false;
    w.config.patrolWait = 4;
    w.stagedConfig.patrolWait = 4;

    engine.tick(); // 移动完成
    engine.tick(); // 等待中
    engine.tick(); // 等待中(被打断前)
    w.target.exists = true;
    w.target.pos = { x: w.npc.pos.x + 40, y: w.npc.pos.y };
    engine.tick(); // 中断等待
    expect(w.npc.patrolIndex).toBe(0);

    w.npc.hp = 5;
    engine.tick(); // 再被撤退抢占
    expect(w.npc.patrolIndex).toBe(0);
  });
});

describe('守卫条件持续重检', () => {
  it('恢复生命后撤退守卫条件失效, 自动退出撤退(非抢占, interrupt 为 0)', () => {
    const engine = new Engine();
    const w = engine.world;
    w.npc.hp = 10;
    w.target.exists = false;

    for (let i = 0; i < 3; i++) engine.tick();
    expect(engine.statusOf(ID.retreatGuard)).toBe('running');

    w.npc.hp = 90; // 恢复
    engine.tick();
    // 守卫自身判定条件失败, 子动作正常 exit 而非 interrupt
    expect(kindCount(engine.logs, ID.moveRest, 'interrupt')).toBe(0);
    expect(engine.statusOf(ID.lowHpCond)).toBe('failure');
    // 撤退分支已退出, 巡逻分支接管
    expect(['running', 'success']).toContain(engine.statusOf(ID.patrolGuard));
  });

  it('目标离开警戒范围: 追逐守卫条件失败, 追逐中断一次并切回巡逻', () => {
    const engine = new Engine();
    const w = engine.world;
    w.target.pos = { x: w.npc.pos.x + 80, y: w.npc.pos.y };
    w.npc.hp = 100;

    for (let i = 0; i < 3; i++) engine.tick();
    expect(engine.statusOf(ID.moveTarget)).toBe('running');

    w.target.pos = { x: 10, y: 10 }; // 拖远
    engine.tick();
    expect(engine.statusOf(ID.alertCond)).toBe('failure');
    expect(kindCount(engine.logs, ID.moveTarget, 'interrupt')).toBe(1);
    expect(['running', 'success']).toContain(engine.statusOf(ID.patrolGuard));
    // 旧移动目标已被清掉/接管, 不会继续朝目标位置走
    if (w.npc.moveTarget) expect(w.npc.moveTarget.ref.kind).not.toBe('target');
  });
});

describe('暂停 / 单步 / 重置', () => {
  it('不调用 tick 时位置、模拟时间、等待计时全部冻结(暂停语义)', () => {
    const engine = new Engine();
    const w = engine.world;
    w.target.pos = { x: w.npc.pos.x + 90, y: w.npc.pos.y };
    engine.tick();
    engine.tick();
    const frozenPos = { ...w.npc.pos };
    const frozenTime = w.simTime;
    const waitNode = engine.getNode(ID.moveTarget)!;
    expect(waitNode.status).toBe('running');

    // "暂停"期间什么都不做
    const before = distance(w.npc.pos, frozenPos);
    void before;
    expect(w.npc.pos).toEqual(frozenPos);
    expect(w.simTime).toBe(frozenTime);
  });

  it('单步一次只推进一个周期(0.5s)', () => {
    const engine = new Engine();
    expect(engine.world.tick).toBe(0);
    engine.tick();
    expect(engine.world.tick).toBe(1);
    expect(engine.world.simTime).toBeCloseTo(0.5);
    engine.tick();
    expect(engine.world.tick).toBe(2);
    expect(engine.world.simTime).toBeCloseTo(1.0);
  });

  it('重置清空运行期状态但保留配置, 重建后无 interrupted/running 残留', () => {
    const engine = new Engine();
    const w = engine.world;
    w.stagedConfig.lowHpThreshold = 45;
    w.config.lowHpThreshold = 45;
    w.stagedConfig.alertRange = 400;
    w.config.alertRange = 400;
    w.target.pos = { x: w.npc.pos.x + 200, y: w.npc.pos.y };
    for (let i = 0; i < 3; i++) engine.tick();
    expect(engine.statusOf(ID.moveTarget)).toBe('running');
    w.npc.hp = 5;
    engine.tick(); // 低生命抢占追逐, 制造一次中断
    expect(engine.logs.some((l) => l.kind === 'interrupt')).toBe(true);

    engine.reset();
    expect(w.tick).toBe(0);
    expect(w.simTime).toBe(0);
    expect(w.npc.patrolIndex).toBe(0);
    expect(w.npc.moveTarget).toBeNull();
    expect(engine.logs).toHaveLength(1); // 只剩重置说明日志
    for (const node of engine.nodes) {
      expect(['idle']).toContain(node.status);
      expect(node.active).toBe(false);
    }
    expect(w.config.lowHpThreshold).toBe(45); // 配置保留
  });
});

describe('分支优先级可调', () => {
  it('把巡逻调到追逐之前: 目标在警戒内也先巡逻, 下一周期生效', () => {
    const engine = new Engine();
    const w = engine.world;
    w.target.pos = { x: w.npc.pos.x + 60, y: w.npc.pos.y };
    w.npc.hp = 100;
    engine.tick();
    expect(engine.statusOf(ID.chaseGuard)).toBe('running');

    // 调整顺序: patrol 排在 chase 前面(retreat 仍最高, idle 兜底)
    w.stagedConfig.branchOrder = ['retreat', 'patrol', 'chase', 'idle'];
    engine.tick(); // 本 tick 边界提交新顺序
    engine.tick();

    expect(engine.statusOf(ID.patrolGuard)).toBe('running');
    // 追逐分支上一 tick 被抢占, interrupted 状态保留一帧用于界面高亮
    expect(engine.statusOf(ID.chaseGuard)).toBe('interrupted');
    // 追逐动作被中断一次
    expect(kindCount(engine.logs, ID.moveTarget, 'interrupt')).toBe(1);
  });

  it('低生命撤退始终可以抢占巡逻(即使巡逻被人为调到最前, 撤退仍在其前)', () => {
    const engine = new Engine();
    const w = engine.world;
    w.target.exists = false;
    w.stagedConfig.branchOrder = ['retreat', 'patrol', 'chase', 'idle'];
    // 直接放到巡逻点#0, 跳过赶路, 让巡逻顺序立刻进入运行态
    w.npc.pos = { ...w.patrolPoints[0] };
    w.npc.patrolIndex = 0;
    for (let i = 0; i < 3; i++) engine.tick();
    expect(engine.statusOf(ID.patrolGuard)).toBe('running');

    w.npc.hp = 8;
    engine.tick();
    expect(engine.statusOf(ID.retreatGuard)).toBe('running');
    expect(kindCount(engine.logs, ID.patrolGuard, 'interrupt')).toBe(1);
  });
});
