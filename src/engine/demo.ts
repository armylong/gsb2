import type { MachineConfig } from './types';

let seq = 0;

/** 生成只在本进程内唯一的 id; 不承担持久化语义。 */
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function newEventId(): string {
  return uid('ev');
}

export function newTransitionId(): string {
  return uid('tr');
}

/**
 * 内置示例: 三个可复现场景共用这一份配置。
 *
 * 设计要点:
 * - `attack` 的 hit-window-open (240ms) 到 hit-window-close (420ms) 之间为攻击窗口;
 *   受击过渡 `attack -> hurt` 优先级 100 > 自然退出 20, 能打断攻击并关闭窗口。
 * - `run -> attack` 与 `run -> hurt` 竞争时, 受击优先级更高。
 * - `run` 为 900ms 循环状态, 每圈有两次脚步事件; 大跨步推进时必须逐圈补齐计数。
 * - `attack` 内 240ms 有两个同刻事件, 顺序由事件数组决定 (窗口开在前)。
 */
export function createDemoConfig(): MachineConfig {
  return {
    version: 1,
    name: '几何角色示例',
    initialState: 'idle',
    states: [
      {
        id: 'idle',
        name: '待机',
        durationMs: 1400,
        loop: true,
        visual: 'idle',
        events: [
          { id: 'idle-breathe-a', name: '呼吸起', kind: 'marker', timeMs: 300 },
          { id: 'idle-breathe-b', name: '呼吸落', kind: 'marker', timeMs: 1000 },
        ],
      },
      {
        id: 'run',
        name: '跑步',
        durationMs: 900,
        loop: true,
        visual: 'run',
        events: [
          { id: 'run-step-l', name: '左脚落地', kind: 'footstep', timeMs: 120 },
          { id: 'run-step-r', name: '右脚落地', kind: 'footstep', timeMs: 570 },
        ],
      },
      {
        id: 'attack',
        name: '攻击',
        durationMs: 720,
        loop: false,
        visual: 'attack',
        events: [
          { id: 'attack-lunge', name: '弓步发力', kind: 'footstep', timeMs: 140 },
          { id: 'attack-window-open', name: '攻击窗口开', kind: 'window-open', timeMs: 240 },
          { id: 'attack-window-mid', name: '攻窗口中段', kind: 'marker', timeMs: 240 },
          { id: 'attack-window-close', name: '攻击窗口关', kind: 'window-close', timeMs: 420 },
          { id: 'attack-recover', name: '收势', kind: 'marker', timeMs: 600 },
        ],
      },
      {
        id: 'hurt',
        name: '受击',
        durationMs: 520,
        loop: false,
        visual: 'hurt',
        events: [
          { id: 'hurt-recoil', name: '受击回弹', kind: 'marker', timeMs: 120 },
          { id: 'hurt-settle', name: '受击站定', kind: 'marker', timeMs: 420 },
        ],
      },
      {
        id: 'victory',
        name: '胜利',
        durationMs: 1100,
        loop: false,
        visual: 'victory',
        events: [{ id: 'victory-pose', name: '胜利姿势', kind: 'marker', timeMs: 500 }],
      },
    ],
    transitions: [
      {
        id: 'idle-to-run',
        from: 'idle',
        to: 'run',
        priority: 10,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: { op: 'gte', value: 0.25 }, hurt: null, attackTrigger: false },
      },
      {
        id: 'idle-to-attack',
        from: 'idle',
        to: 'attack',
        priority: 30,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: null, hurt: null, attackTrigger: true },
      },
      {
        id: 'idle-to-hurt',
        from: 'idle',
        to: 'hurt',
        priority: 100,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: null, hurt: true, attackTrigger: false },
      },
      {
        id: 'run-to-attack',
        from: 'run',
        to: 'attack',
        priority: 40,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: null, hurt: null, attackTrigger: true },
      },
      {
        id: 'run-to-hurt',
        from: 'run',
        to: 'hurt',
        priority: 100,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: null, hurt: true, attackTrigger: false },
      },
      {
        id: 'run-to-idle',
        from: 'run',
        to: 'idle',
        priority: 10,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: { op: 'lte', value: 0.1 }, hurt: null, attackTrigger: false },
      },
      {
        id: 'attack-to-victory',
        from: 'attack',
        to: 'victory',
        priority: 25,
        waitForProgress: true,
        progress: 0.8,
        conditions: { speed: null, hurt: false, attackTrigger: true },
      },
      {
        id: 'attack-to-hurt',
        from: 'attack',
        to: 'hurt',
        priority: 100,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: null, hurt: true, attackTrigger: false },
      },
      {
        id: 'attack-to-idle',
        from: 'attack',
        to: 'idle',
        priority: 20,
        waitForProgress: true,
        progress: 0.8,
        conditions: { speed: null, hurt: null, attackTrigger: false },
      },
      {
        id: 'hurt-to-idle',
        from: 'hurt',
        to: 'idle',
        priority: 20,
        waitForProgress: true,
        progress: 0.65,
        conditions: { speed: null, hurt: false, attackTrigger: false },
      },
      {
        id: 'hurt-to-run',
        from: 'hurt',
        to: 'run',
        priority: 15,
        waitForProgress: true,
        progress: 0.65,
        conditions: { speed: { op: 'gte', value: 0.25 }, hurt: false, attackTrigger: false },
      },
      {
        id: 'victory-to-hurt',
        from: 'victory',
        to: 'hurt',
        priority: 100,
        waitForProgress: false,
        progress: 0,
        conditions: { speed: null, hurt: true, attackTrigger: false },
      },
      {
        id: 'victory-to-idle',
        from: 'victory',
        to: 'idle',
        priority: 10,
        waitForProgress: true,
        progress: 0.9,
        conditions: { speed: null, hurt: false, attackTrigger: false },
      },
    ],
  };
}
