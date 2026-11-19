import { describe, expect, it } from 'vitest';
import { defaultBindings } from '../core/bindings';
import {
  MAX_TICKS,
  Recording,
  recordingHash,
  runReplay,
  validateRecording,
} from '../core/recording';
import { World } from '../core/world';

/** 用脚本按键在 World 上录一段像 */
function recordSession(): { world: World; rec: Recording } {
  const world = new World();
  world.startRecording('测试录像');
  const e = world.engine;
  // tick 由 world.tick() 推进；在指定 tick 前注入按键
  const script: [number, () => void][] = [
    [2, () => e.keyDown('KeyD')], // 向右走
    [10, () => e.keyDown('KeyE')], // 交互
    [12, () => e.keyUp('KeyE')],
    [20, () => e.keyDown('Space')], // 冲刺
    [22, () => e.keyUp('Space')],
    [40, () => e.keyUp('KeyD')],
    [45, () => e.keyDown('KeyS')],
    [60, () => e.keyUp('KeyS')],
  ];
  for (let t = 0; t < 120; t++) {
    while (script.length && script[0][0] === world.sim.state.tick) script.shift()![1]();
    world.tick();
  }
  const rec = world.stopRecording();
  if (!rec) throw new Error('录制失败');
  return { world, rec };
}

describe('录制与回放', () => {
  it('改键前后回放结果一致（回放不依赖当前绑定）', () => {
    const { world, rec } = recordSession();
    // 录制后换一套完全不同的按键
    const b = defaultBindings();
    b.game.moveUp = { code: 'ArrowUp', modifiers: [] };
    b.game.moveDown = { code: 'ArrowDown', modifiers: [] };
    b.game.moveLeft = { code: 'ArrowLeft', modifiers: [] };
    b.game.moveRight = { code: 'ArrowRight', modifiers: [] };
    b.game.interact = { code: 'KeyJ', modifiers: [] };
    b.game.dash = { code: 'KeyJ', modifiers: ['Shift'] };
    world.engine.bindings = b;

    world.startPlayback(rec);
    // 回放期间真实按键不应混入
    world.engine.keyDown('KeyJ');
    world.engine.keyDown('ArrowLeft');
    while (!world.playback!.done) world.tick();
    const result = world.playback!.result!;
    expect(result.match).toBe(true);
    expect(result.checkpointsChecked).toBeGreaterThan(0);
    expect(result.checkpointsPassed).toBe(result.checkpointsChecked);
    expect(result.final.interactCount).toBe(1);
    expect(result.final.x).toBeCloseTo(rec.final.x, 9);
    expect(result.final.y).toBeCloseTo(rec.final.y, 9);
  });

  it('播放速度不改变最终位置和交互次数', () => {
    const { rec } = recordSession();
    const runAtSpeed = (speed: number) => {
      const w = new World();
      w.startPlayback(rec);
      w.playback!.speed = speed;
      while (!w.playback!.done) w.tick();
      return w.playback!.result!.final;
    };
    const slow = runAtSpeed(0.5);
    const fast = runAtSpeed(4);
    expect(slow.x).toBe(fast.x);
    expect(slow.y).toBe(fast.y);
    expect(slow.interactCount).toBe(fast.interactCount);
    expect(slow.tick).toBe(fast.tick);
  });

  it('篡改核对点后回放能定位首个差异位置', () => {
    const { rec } = recordSession();
    const tampered: Recording = JSON.parse(JSON.stringify(rec));
    tampered.checkpoints[1].x += 5; // 第二个核对点被动过
    const result = runReplay(tampered);
    expect(result.match).toBe(false);
    expect(result.firstDivergence).not.toBeNull();
    expect(result.firstDivergence!.tick).toBe(tampered.checkpoints[1].tick);
  });

  it('修改录像事件后内容哈希变化，旧校验结果失效', () => {
    const { world, rec } = recordSession();
    const r1 = runReplay(rec);
    world.verifications.set(recordingHash(rec), r1);
    expect(world.verificationFor(rec)).not.toBeNull();
    world.mutateRecording(rec, (evs) => evs.splice(0, 1));
    expect(world.verificationFor(rec)).toBeNull();
  });
});

describe('坏录像拒绝', () => {
  const { rec } = (() => {
    // 构造一份合法录像作为篡改基底
    const world = new World();
    world.startRecording('基底');
    for (let t = 0; t < 60; t++) world.tick();
    return { rec: world.stopRecording()! };
  })();

  it('动作时间倒退被拒绝', () => {
    const bad = JSON.parse(JSON.stringify(rec));
    bad.events = [
      { tick: 10, type: 'down', action: 'moveUp' },
      { tick: 5, type: 'up', action: 'moveUp' },
    ];
    const r = validateRecording(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('倒退');
  });

  it('不存在的动作被拒绝', () => {
    const bad = JSON.parse(JSON.stringify(rec));
    bad.events = [{ tick: 1, type: 'edge', action: 'fly' }];
    expect(validateRecording(bad).ok).toBe(false);
  });

  it('不存在的场景与未知事件类型被拒绝', () => {
    const bad1 = JSON.parse(JSON.stringify(rec));
    bad1.events = [{ tick: 1, type: 'scene', scene: 'lobby' }];
    expect(validateRecording(bad1).ok).toBe(false);
    const bad2 = JSON.parse(JSON.stringify(rec));
    bad2.events = [{ tick: 1, type: 'teleport', action: 'dash' }];
    expect(validateRecording(bad2).ok).toBe(false);
  });

  it('超过 30 秒上限被拒绝', () => {
    const bad = JSON.parse(JSON.stringify(rec));
    bad.durationTicks = MAX_TICKS + 1;
    expect(validateRecording(bad).ok).toBe(false);
  });

  it('合法录像通过校验', () => {
    const r = validateRecording(JSON.parse(JSON.stringify(rec)));
    expect(r.ok).toBe(true);
  });
});
