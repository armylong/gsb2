import { describe, expect, it } from 'vitest';
import { createDemoConfig } from '../src/engine/demo';
import { runDemoScenarios, runScenario, getScenarioSpecs, maxTransitionsPerTick } from '../src/engine/scenarios';
import { buildPreviewFrame, PreviewTimeline, previewTransitionStatuses } from '../src/engine/preview';
import { AnimationMachine } from '../src/engine/machine';
import { collectEvents, collectTransitions, collectWindows } from '../src/engine/log-format';

describe('内置示例', () => {
  const config = createDemoConfig();
  const reports = runDemoScenarios(config);

  it('三个示例全部通过自身断言', () => {
    for (const report of reports) {
      const failed = report.checks.filter((c) => !c.pass);
      expect(failed, `${report.name}: ${JSON.stringify(failed, null, 2)}`).toEqual([]);
      expect(report.passed).toBe(true);
    }
  });

  it('两个内置过渡场景使用同一配置', () => {
    expect(reports.map((r) => r.id)).toEqual([
      'attack-interrupted',
      'wait-progress',
      'loop-boundary',
    ]);
  });

  it('攻击打断场景的真实事件记录可核对', () => {
    const report = reports[0];
    const eventTimes = collectEvents(report.log).map((e) => `${e.eventId}@${e.atMs}`);
    expect(eventTimes).toEqual([
      'attack-lunge@140',
      'attack-window-open@240',
      'attack-window-mid@240',
      'hurt-recoil@420',
      'attack-lunge@940',
      'attack-window-open@1040',
      'attack-window-mid@1040',
      'hurt-recoil@1220',
    ]);
    const windows = collectWindows(report.log).map((w) => `${w.action}@${w.atMs}:${w.reason}`);
    expect(windows).toEqual([
      'open@240:event',
      'close@300:state-exit',
      'open@1040:event',
      'close@1100:state-exit',
    ]);
  });

  it('受击打断后重新进入攻击, 后续窗口关不会从旧计时补发', () => {
    const report = reports[0];
    const transitions = collectTransitions(report.log);
    expect(transitions.map((t) => `${t.transitionId}@${t.atMs}`)).toEqual([
      'attack-to-hurt@300',
      'hurt-to-idle@700',
      'idle-to-attack@800',
      'attack-to-hurt@1100',
      'hurt-to-idle@1500',
    ]);
  });
});

describe('竞争过渡与触发', () => {
  const config = createDemoConfig();

  it('同帧多个条件满足时只采用优先级最高者', () => {
    const machine = new AnimationMachine(config, {
      initialStateId: 'idle',
      initialInputs: { speed: 0.9, hurt: true, pendingAttacks: 1 },
    });
    machine.update(16);
    const transitions = collectTransitions(machine.log);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].transitionId).toBe('idle-to-hurt');
    expect(machine.pendingAttacks).toBe(1);
    expect(maxTransitionsPerTick(machine.log)).toBe(1);
  });

  it('只有实际采用时才消耗攻击触发', () => {
    const machine = new AnimationMachine(config, {
      initialStateId: 'idle',
      initialInputs: { speed: 0.9, hurt: true, pendingAttacks: 2 },
    });
    machine.update(16);
    expect(machine.pendingAttacks).toBe(2);
    machine.setHurt(false);
    machine.update(1000); // hurt 结束回 idle
    machine.update(16); // 现在攻击与跑步都可用, 攻击优先级更高
    const transitions = collectTransitions(machine.log);
    expect(transitions.at(-1)?.transitionId).toBe('idle-to-attack');
    expect(transitions.at(-1)?.consumedAttack).toBe(true);
    expect(machine.pendingAttacks).toBe(1);
  });

  it('未被采用的触发可以清除', () => {
    const machine = new AnimationMachine(config, {
      initialStateId: 'idle',
      initialInputs: { speed: 0, hurt: false, pendingAttacks: 3 },
    });
    machine.update(16); // idle→attack 会消耗一次
    expect(machine.pendingAttacks).toBe(2);
    machine.clearAttacks();
    expect(machine.pendingAttacks).toBe(0);
    expect(
      machine.log.some((e) => e.type === 'input' && e.action === 'clear-attacks'),
    ).toBe(true);
  });
});

describe('循环事件次数', () => {
  it('每个循环边界的事件恰好在正确时刻触发一次', () => {
    const config = createDemoConfig();
    const machine = new AnimationMachine(config, {
      initialStateId: 'run',
      initialInputs: { speed: 0.6 },
    });
    for (let i = 0; i < 180; i += 1) machine.update(10);
    const left = collectEvents(machine.log).filter((e) => e.eventId === 'run-step-l');
    const right = collectEvents(machine.log).filter((e) => e.eventId === 'run-step-r');
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect(left.map((e) => e.atMs)).toEqual([120, 1020]);
    expect(right.map((e) => e.atMs)).toEqual([570, 1470]);
    expect(left.map((e) => e.loopIndex)).toEqual([0, 1]);
  });
});

describe('预览无副作用', () => {
  it('预览不生成日志、不消费触发、不打开窗口', () => {
    const config = createDemoConfig();
    const timeline = new PreviewTimeline(config, 'attack', 250);
    const frame = timeline.frame;
    expect(frame.state.id).toBe('attack');
    expect(frame.elapsedMs).toBe(250);
    expect(frame.passedEventIds).toEqual([
      'attack-lunge',
      'attack-window-open',
      'attack-window-mid',
    ]);
    expect(frame.upcomingEventIds).toEqual(['attack-window-close', 'attack-recover']);

    // 完全相同的时间点用真实状态机运行, 会打开窗口; 预览不应有窗口概念
    const machine = new AnimationMachine(config, { initialStateId: 'attack' });
    machine.update(250);
    expect(machine.getSnapshot().attackWindowOpen).toBe(true);

    const before = JSON.stringify(machine.log);
    // 用预览反复拖动时间轴
    for (const t of [0, 120, 240, 420, 720, 3000]) timeline.seek(t);
    timeline.setState('hurt');
    timeline.seek(999);
    expect(JSON.stringify(machine.log)).toBe(before);
    expect(machine.getSnapshot().attackWindowOpen).toBe(true);
  });

  it('预览求值不修改真实机器输入', () => {
    const config = createDemoConfig();
    const machine = new AnimationMachine(config, {
      initialStateId: 'idle',
      initialInputs: { pendingAttacks: 5 },
    });
    const snapshotBefore = JSON.stringify(machine.getSnapshot().transitionStatuses);
    const result = previewTransitionStatuses(config, config.states[0], 100, {
      pendingAttacks: 5,
    });
    expect(result.winner?.transition.id).toBe('idle-to-attack');
    expect(JSON.stringify(machine.getSnapshot().transitionStatuses)).toBe(snapshotBefore);
    expect(machine.pendingAttacks).toBe(5);
    expect(machine.log).toHaveLength(2); // reset + 初始进入
  });

  it('预览帧是纯函数: 相同输入得到相同结果且不共享状态', () => {
    const config = createDemoConfig();
    const a = buildPreviewFrame(config, 'run', 1250);
    const b = buildPreviewFrame(config, 'run', 1250);
    expect(a).toEqual(b);
    expect(a.loopIndex).toBe(1);
    expect(a.elapsedMs).toBe(350);
    expect(a.progress).toBeCloseTo(350 / 900, 6);
    // 配置对象未被污染
    expect(JSON.stringify(config)).toBe(JSON.stringify(createDemoConfig()));
  });

  it('预览时间轴可切换状态并从 0 开始', () => {
    const config = createDemoConfig();
    const timeline = new PreviewTimeline(config, 'run', 5000);
    expect(timeline.frame.loopIndex).toBe(5);
    timeline.setState('hurt');
    expect(timeline.frame.state.id).toBe('hurt');
    expect(timeline.frame.elapsedMs).toBe(0);
  });
});

describe('场景重跑', () => {
  it('同一场景两次运行日志一致', () => {
    const config = createDemoConfig();
    for (const spec of getScenarioSpecs()) {
      const first = runScenario(spec, config);
      const second = runScenario(spec, config);
      expect(JSON.stringify(first.log)).toBe(JSON.stringify(second.log));
    }
  });
});
