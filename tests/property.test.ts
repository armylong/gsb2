import { describe, expect, it } from 'vitest';
import { createDemoConfig } from '../src/engine/demo';
import { AnimationMachine } from '../src/engine/machine';
import type { LogEntry } from '../src/engine/types';

/** 线性同余伪随机, 保证测试可复现 */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

describe('随机时间步性质', () => {
  it('时钟单调、事件有序且单周期最多一次切换', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = rng(seed);
      const machine = new AnimationMachine(createDemoConfig(), {
        initialStateId: seed % 2 === 0 ? 'run' : 'idle',
        initialInputs: { speed: 0.5, pendingAttacks: seed % 3 },
      });
      let lastClock = 0;
      const transitionsPerTick = new Map<number, number>();
      for (let step = 0; step < 400; step += 1) {
        const roll = random();
        if (roll < 0.05) machine.setHurt(!machine.getSnapshot().hurt);
        else if (roll < 0.1) machine.setSpeed(Math.round(random() * 10) / 10);
        else if (roll < 0.13) machine.queueAttack();
        else if (roll < 0.15) machine.clearAttacks();

        const dt = Math.round(random() * 700);
        const before = machine.log.length;
        machine.update(dt);
        const snapshot = machine.getSnapshot();

        expect(snapshot.clockMs).toBeGreaterThanOrEqual(lastClock);
        lastClock = snapshot.clockMs;

        let switched = 0;
        for (let i = before; i < machine.log.length; i += 1) {
          const entry = machine.log[i];
          if (entry.type === 'transition') {
            switched += 1;
            transitionsPerTick.set(entry.tick, (transitionsPerTick.get(entry.tick) ?? 0) + 1);
          }
        }
        expect(switched, `seed ${seed} step ${step} 单周期切换 ${switched} 次`).toBeLessThanOrEqual(1);
      }

      const events = machine.log.filter(
        (entry): entry is Extract<LogEntry, { type: 'event' }> => entry.type === 'event',
      );
      let lastAt = -1;
      for (const event of events) {
        expect(event.atMs).toBeGreaterThanOrEqual(lastAt);
        lastAt = event.atMs;
      }

      // 同一状态进入、同一圈内同一个事件不应重复出现
      const seen = new Set<string>();
      let entryIndex = 0;
      const entryKeys = new Map<number, string>();
      for (const entry of machine.log) {
        if (entry.type === 'state-enter') entryIndex += 1;
        entryKeys.set(entry.seq, `${entryIndex}`);
        if (entry.type === 'event') {
          const key = `${entryKeys.get(entry.seq)}:${entry.stateId}:${entry.loopIndex}:${entry.eventId}`;
          // 进入编号 + 圈号唯一确定一次触发
          expect(seen.has(key), `重复事件 ${key}`).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it('窗口开启与关闭严格交替', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const random = rng(seed * 97);
      const machine = new AnimationMachine(createDemoConfig(), {
        initialStateId: 'idle',
        initialInputs: { pendingAttacks: 2 },
      });
      for (let step = 0; step < 300; step += 1) {
        const roll = random();
        if (roll < 0.04) machine.setHurt(!machine.getSnapshot().hurt);
        else if (roll < 0.07) machine.queueAttack();
        machine.update(Math.round(random() * 400));
      }
      let open = false;
      for (const entry of machine.log) {
        if (entry.type !== 'window') continue;
        if (entry.action === 'open') {
          expect(open, `seed ${seed} 在未关闭时重复开窗`).toBe(false);
          open = true;
        } else {
          expect(open, `seed ${seed} 在未开窗时关窗`).toBe(true);
          open = false;
        }
      }
      expect(machine.getSnapshot().attackWindowOpen).toBe(open);
    }
  });

  it('快照一致: 状态时间不会超过单次时长', () => {
    const random = rng(12345);
    const machine = new AnimationMachine(createDemoConfig(), {
      initialStateId: 'run',
      initialInputs: { speed: 0.6 },
    });
    for (let step = 0; step < 500; step += 1) {
      machine.update(Math.round(random() * 1200));
      const snapshot = machine.getSnapshot();
      expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(snapshot.elapsedMs).toBeLessThanOrEqual(snapshot.state.durationMs + 1e-9);
      expect(snapshot.progress).toBeGreaterThanOrEqual(0);
      expect(snapshot.progress).toBeLessThanOrEqual(1);
      expect(Number.isFinite(snapshot.clockMs)).toBe(true);
    }
  });
});
