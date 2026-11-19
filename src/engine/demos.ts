import type { Engine } from './engine';

export interface DemoEvent {
  /** 在第几个 tick 处理(事件在该 tick 的树判断之前生效) */
  atTick: number;
  label: string;
  apply: (engine: Engine) => void;
}

export interface Demo {
  id: string;
  title: string;
  description: string;
  build: (engine: Engine) => DemoEvent[];
}

/**
 * 三组演示。每个演示先 reset, 再布置初始局面与定时事件;
 * 运行时由 UI 在对应 tick 前调用 apply, 日志会记录"为什么选中该分支 / 放弃原动作"。
 */
export const DEMOS: Demo[] = [
  {
    id: 'patrol-detect',
    title: '演示1 · 巡逻中发现目标',
    description:
      'NPC 正常巡逻; 目标在第 4 周期被拖入警戒范围, 追逐分支条件成立, 抢占巡逻(等待/移动中断一次), 移动目标切换为目标。',
    build(engine) {
      engine.reset();
      const w = engine.world;
      // NPC 已在巡逻点#0 且下一个目标就是它: 第 1 周期移动完成进入等待, 保证 tick4 时正处于巡逻运行中
      w.npc.pos = { ...w.patrolPoints[0] };
      w.npc.patrolIndex = 0;
      w.target.exists = true;
      // 目标先放在警戒范围外(距巡逻点#0 足够远)
      w.target.pos = { x: 430, y: 300 };
      return [
        {
          atTick: 4,
          label: '目标被拖入警戒范围',
          apply: (e) => {
            e.world.target.pos = {
              x: e.world.npc.pos.x + 60,
              y: e.world.npc.pos.y + 40,
            };
            e.pushLog({
              nodeId: 0,
              nodeName: '演示脚本',
              kind: 'info',
              detail: '事件: 目标进入警戒范围, 等待本 tick 优先选择重检',
            });
          },
        },
      ];
    },
  },
  {
    id: 'chase-lowhp',
    title: '演示2 · 追逐中低生命',
    description:
      '目标先在警戒范围内, NPC 进入追逐; 第 4 周期生命被调到阈值以下, 低生命撤退分支抢占追逐, 旧追逐动作中断并清空移动目标; 之后恢复生命, 守卫条件失效, 自动退出撤退。',
    build(engine) {
      engine.reset();
      const w = engine.world;
      w.target.pos = { x: w.npc.pos.x + 80, y: w.npc.pos.y };
      w.target.exists = true;
      w.npc.hp = 90;
      return [
        {
          atTick: 4,
          label: 'NPC 生命降到 20',
          apply: (e) => {
            e.world.npc.hp = 20;
            e.pushLog({
              nodeId: 0,
              nodeName: '演示脚本',
              kind: 'info',
              detail: '事件: HP 降至 20 < 撤退阈值, 等待本 tick 重检抢占',
            });
          },
        },
        {
          atTick: 14,
          label: 'NPC 生命恢复到 80',
          apply: (e) => {
            e.world.npc.hp = 80;
            e.pushLog({
              nodeId: 0,
              nodeName: '演示脚本',
              kind: 'info',
              detail: '事件: HP 恢复至 80 ≥ 撤退阈值, 撤退守卫条件将失效',
            });
          },
        },
      ];
    },
  },
  {
    id: 'target-leave',
    title: '演示3 · 目标离开警戒范围',
    description:
      'NPC 追逐目标; 第 5 周期目标被拖出警戒范围, 追逐守卫的条件持续重检失败, 追逐动作中断(非抢占式退出), NPC 回到巡逻分支。',
    build(engine) {
      engine.reset();
      const w = engine.world;
      w.target.pos = { x: w.npc.pos.x + 70, y: w.npc.pos.y };
      w.target.exists = true;
      w.npc.hp = 100;
      return [
        {
          atTick: 5,
          label: '目标被拖出警戒范围',
          apply: (e) => {
            e.world.target.pos = { x: 20, y: 20 };
            e.pushLog({
              nodeId: 0,
              nodeName: '演示脚本',
              kind: 'info',
              detail: '事件: 目标离开警戒范围, 追逐守卫条件本 tick 将判定失败',
            });
          },
        },
      ];
    },
  },
];
