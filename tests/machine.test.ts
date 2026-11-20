import { describe, expect, it } from 'vitest';
import { createDemoConfig } from '../src/engine/demo';
import { AnimationMachine } from '../src/engine/machine';
import { collectEvents, collectTransitions, collectWindows } from '../src/engine/log-format';
import type { LogEntry } from '../src/engine/types';

function make(overrides: { stateId?: string; inputs?: Record<string, unknown> } = {}) {
  return new AnimationMachine(createDemoConfig(), {
    initialStateId: overrides.stateId,
    initialInputs: overrides.inputs as never,
  });
}

describe('过渡竞争与优先级', () => {
  it('同时满足多条时只选优先级最高的一条', () => {
    const machine = make({ stateId: 'idle', inputs: { pendingAttacks: 1, hurt: true } });
    machine.update(16);
    const transitions = collectTransitions(machine.log);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].transitionId).toBe('idle-to-hurt');
    expect(transitions[0].priority).toBe(100);
    // idle-to-attack (30) 也满足, 但不应被采用, 触发不应被消耗
    expect(machine.pendingAttacks).toBe(1);
  });

  it('同优先级按 transitions 数组中的稳定次序选择', () => {
    const config = createDemoConfig();
    // 插入两条同优先级竞争过渡, 靠前的应胜出
    config.transitions.unshift(
      {
        id: 'idle-a-first',
        from: 'idle',
        to: 'victory',
        priority: 55,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: null, hurt: null, attackTrigger: false },
      },
      {
        id: 'idle-b-second',
        from: 'idle',
        to: 'run',
        priority: 55,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: null, hurt: null, attackTrigger: false },
      },
    );
    const machine = new AnimationMachine(config, { initialStateId: 'idle' });
    machine.update(16);
    const transitions = collectTransitions(machine.log);
    expect(transitions.map((t) => t.transitionId)).toEqual(['idle-a-first']);
    expect(transitions[0].orderIndex).toBe(0);
  });

  it('一个更新周期最多切换一次', () => {
    const machine = make({ stateId: 'idle', inputs: { speed: 1, hurt: true, pendingAttacks: 2 } });
    machine.update(5000);
    const transitions = collectTransitions(machine.log);
    expect(transitions).toHaveLength(1);
  });

  it('优先级高的过渡不满足时回落到次高', () => {
    const machine = make({ stateId: 'idle', inputs: { speed: 0, hurt: false, pendingAttacks: 0 } });
    machine.update(16);
    expect(collectTransitions(machine.log)).toHaveLength(0);
    machine.setSpeed(0.5);
    machine.update(16);
    expect(collectTransitions(machine.log)[0].transitionId).toBe('idle-to-run');
  });

  it('等待进度不满足时只差该条件的过渡不会提前切换', () => {
    const machine = make({ stateId: 'attack' });
    machine.update(200);
    expect(machine.getSnapshot().stateId).toBe('attack');
    const status = machine.getSnapshot().transitionStatuses.find(
      (s) => s.transition.id === 'attack-to-idle',
    );
    expect(status?.reasons).toContain('wait-progress');
    expect(status?.currentProgress).toBeCloseTo(200 / 720, 5);
  });
});

describe('攻击触发消耗', () => {
  it('只在实际采用攻击触发过渡时消耗', () => {
    const machine = make({ stateId: 'run', inputs: { pendingAttacks: 1, speed: 0 } });
    // run 上唯一满足攻击触发的是 run-to-attack; run-to-idle 速度条件不满足
    machine.update(16);
    const transitions = collectTransitions(machine.log);
    expect(transitions[0].transitionId).toBe('run-to-attack');
    expect(transitions[0].consumedAttack).toBe(true);
    expect(machine.pendingAttacks).toBe(0);
  });

  it('竞争失败时不消耗, 且可由用户清除', () => {
    const machine = make({ stateId: 'idle', inputs: { pendingAttacks: 2, speed: 0.9 } });
    machine.update(16);
    // idle→run 优先级 10, idle→attack 30, attack 应胜出并消耗一次
    expect(collectTransitions(machine.log)[0].transitionId).toBe('idle-to-attack');
    expect(machine.pendingAttacks).toBe(1);

    // 进入 attack 后无攻击触发过渡, 待处理触发保留
    machine.clearAttacks();
    expect(machine.pendingAttacks).toBe(0);
    expect(machine.log.some((e) => e.type === 'input' && e.action === 'clear-attacks')).toBe(true);
  });

  it('多个待处理触发按次消耗', () => {
    // 去掉攻击→胜利的收尾过渡, 让两次攻击都自然回到待机
    const config = createDemoConfig();
    config.transitions = config.transitions.filter((t) => t.id !== 'attack-to-victory');
    const machine = new AnimationMachine(config, {
      initialStateId: 'idle',
      initialInputs: { pendingAttacks: 2 },
    });
    machine.update(16);
    expect(machine.pendingAttacks).toBe(1);
    machine.update(600); // 攻击自然结束 → 待机
    machine.update(16); // 再次攻击
    expect(machine.pendingAttacks).toBe(0);
    expect(
      collectTransitions(machine.log).filter((t) => t.transitionId === 'idle-to-attack'),
    ).toHaveLength(2);
  });

  it('攻击结束时待处理触发可用于收尾过渡', () => {
    const machine = make({ stateId: 'idle', inputs: { pendingAttacks: 2 } });
    machine.update(16); // idle → attack, 消耗 1
    expect(machine.getSnapshot().stateId).toBe('attack');
    machine.update(600); // 到达 80% 进度, attack → victory 消耗第二个
    const transitions = collectTransitions(machine.log);
    expect(transitions.map((t) => t.transitionId)).toEqual([
      'idle-to-attack',
      'attack-to-victory',
    ]);
    expect(machine.pendingAttacks).toBe(0);
  });

  it('无待处理触发时攻击过渡不满足', () => {
    const machine = make({ stateId: 'idle', inputs: { pendingAttacks: 0 } });
    machine.update(16);
    const status = machine.getSnapshot().transitionStatuses.find(
      (s) => s.transition.id === 'idle-to-attack',
    );
    expect(status?.eligible).toBe(false);
    expect(status?.reasons).toEqual(['attack-trigger']);
  });
});

describe('受击打断与中断清理', () => {
  it('受击打断攻击并关闭已开启窗口, 之后的事件不再发生', () => {
    const machine = make({ stateId: 'attack' });
    machine.update(300);
    expect(machine.getSnapshot().attackWindowOpen).toBe(true);
    machine.setHurt(true);
    machine.update(16);
    const snap = machine.getSnapshot();
    expect(snap.stateId).toBe('hurt');
    expect(snap.attackWindowOpen).toBe(false);
    expect(snap.elapsedMs).toBe(16);

    machine.update(2000);
    const events = collectEvents(machine.log);
    expect(events.some((e) => e.eventId === 'attack-window-close')).toBe(false);
    expect(events.some((e) => e.eventId === 'attack-recover')).toBe(false);
    const windows = collectWindows(machine.log);
    expect(windows.map((w) => `${w.action}:${w.reason}`)).toEqual([
      'open:event',
      'close:state-exit',
    ]);
  });

  it('重新进入动作从零计时, 不残留旧回调', () => {
    const machine = make({ stateId: 'attack' });
    machine.update(300);
    machine.setHurt(true);
    machine.update(16);
    machine.setHurt(false);
    machine.update(400); // hurt 到 65% 进度 → idle
    expect(machine.getSnapshot().stateId).toBe('idle');
    machine.queueAttack(1);
    machine.update(16);
    expect(machine.getSnapshot().stateId).toBe('attack');
    const enter = machine.log.filter(
      (e) => e.type === 'state-enter' && e.stateId === 'attack',
    );
    expect(enter).toHaveLength(2);
    expect(enter[1].atMs).toBeGreaterThan(enter[0].atMs);
    // 新的攻击事件按新时间线触发: 140ms 弓步(last enter + 140)
    const lastEnterAt = enter[1].type === 'state-enter' ? enter[1].atMs : 0;
    machine.update(200);
    const lunge = collectEvents(machine.log).filter((e) => e.eventId === 'attack-lunge');
    expect(lunge).toHaveLength(2);
    expect(lunge[1].atMs).toBe(lastEnterAt + 140);
  });

  it('中断记录包含被跳过的事件与强制关窗标记', () => {
    const machine = make({ stateId: 'attack', inputs: { hurt: false } });
    machine.update(300);
    machine.setHurt(true);
    machine.update(1);
    const interrupt = machine.log.find((e) => e.type === 'interrupt');
    expect(interrupt).toBeTruthy();
    if (interrupt?.type === 'interrupt') {
      expect(interrupt.forcedWindowClose).toBe(true);
      expect(interrupt.skippedEventIds).toEqual([
        'attack-window-close',
        'attack-recover',
      ]);
    }
  });
});

describe('等待进度切换点', () => {
  it('大步推进时恰在进度阈值处切换, 阈值后的事件被跳过', () => {
    const machine = make({ stateId: 'attack' });
    machine.update(1000);
    const transition = collectTransitions(machine.log).find(
      (t) => t.transitionId === 'attack-to-idle',
    );
    expect(transition?.atMs).toBe(576);
    expect(transition?.fromElapsedMs).toBe(576);
    const events = collectEvents(machine.log);
    expect(events.find((e) => e.eventId === 'attack-window-close')?.atMs).toBe(420);
    expect(events.some((e) => e.eventId === 'attack-recover')).toBe(false);
    const snap = machine.getSnapshot();
    expect(snap.stateId).toBe('idle');
    expect(snap.elapsedMs).toBe(424);
  });
});

describe('循环与事件', () => {
  it('一次推进跨过多个循环边界不遗漏不重复', () => {
    const machine = make({ stateId: 'run', inputs: { speed: 0.6 } });
    machine.update(3000);
    const footsteps = collectEvents(machine.log).filter((e) => e.kind === 'footstep');
    expect(footsteps.map((e) => e.atMs)).toEqual([120, 570, 1020, 1470, 1920, 2370, 2820]);
    expect(new Set(footsteps.map((e) => e.eventId + e.atMs)).size).toBe(7);
    expect(machine.getSnapshot().loopIndex).toBe(3);
    expect(machine.getSnapshot().elapsedMs).toBe(300);
  });

  it('同一时刻事件按数组顺序稳定触发', () => {
    const machine = make({ stateId: 'attack' });
    machine.update(240);
    const at240 = collectEvents(machine.log).filter((e) => e.atMs === 240);
    expect(at240.map((e) => e.eventId)).toEqual(['attack-window-open', 'attack-window-mid']);
  });

  it('多次小步推进与一次大步推进的真事件一致(除时钟粒度外)', () => {
    const big = make({ stateId: 'run', inputs: { speed: 0.6 } });
    big.update(2700);
    const small = make({ stateId: 'run', inputs: { speed: 0.6 } });
    for (let i = 0; i < 270; i += 1) small.update(10);
    const key = (log: readonly LogEntry[]) =>
      log
        .filter((e): e is Extract<LogEntry, { type: 'event' }> => e.type === 'event')
        .map((e) => `${e.eventId}@${e.atMs}`);
    expect(key(small.log)).toEqual(key(big.log));
  });

  it('循环状态以当前圈计进度', () => {
    const config = createDemoConfig();
    config.transitions.push({
      id: 'run-half-exit',
      from: 'run',
      to: 'idle',
      priority: 999,
      waitForProgress: true,
      progress: 0.5,
      conditions: { speed: null, hurt: null, attackTrigger: false },
    });
    const machine = new AnimationMachine(config, {
      initialStateId: 'run',
      initialInputs: { speed: 0.6 },
    });
    machine.update(3000);
    // 第一圈 450ms 就应切换, 之后 run→idle 完成; 不会被累计时间误判
    const transition = collectTransitions(machine.log)[0];
    expect(transition.transitionId).toBe('run-half-exit');
    expect(transition.atMs).toBe(450);
  });
});

describe('重置与确定性', () => {
  it('reset 回到确定初态并复现相同记录', () => {
    const machine = make({ stateId: 'idle', inputs: { pendingAttacks: 1 } });
    machine.update(100);
    machine.queueAttack(1);
    machine.update(300);
    const first = JSON.stringify(machine.log);
    machine.reset();
    machine.update(100);
    machine.queueAttack(1);
    machine.update(300);
    expect(JSON.stringify(machine.log)).toBe(first);
  });
});
