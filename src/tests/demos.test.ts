import { describe, expect, it } from 'vitest';
import { DEMOS } from '../core/demos';
import { World } from '../core/world';

function runDemo(id: string, ticks: number): World {
  const world = new World();
  DEMOS.find((d) => d.id === id)!.apply(world);
  for (let t = 0; t < ticks; t++) world.tick();
  return world;
}

describe('内置演示', () => {
  it('演示1：组合键竞争中 Shift+E 只触发冲刺，松开 Shift 不补触发交互', () => {
    const world = runDemo('combo-priority', 200);
    const s = world.sim.state;
    expect(s.interactCount).toBe(2); // 两次单独按 E
    const dashLogs = world.log.filter((l) => l.text.includes('冲刺'));
    const interactLogs = world.log.filter((l) => l.text.includes('交互'));
    expect(dashLogs.length).toBe(1);
    expect(interactLogs.length).toBe(2);
  });

  it('演示2：同一按键在游戏/菜单场景各走各的绑定', () => {
    const world = runDemo('menu-reuse', 200);
    expect(world.sim.state.interactCount).toBe(2); // 游戏场景两次
    expect(world.sim.state.confirmCount).toBe(1); // 菜单场景一次
    expect(world.sim.state.scene).toBe('game'); // Esc 返回游戏
  });

  it('演示3：录制后换键回放，结果与录制一致', () => {
    const world = new World();
    DEMOS.find((d) => d.id === 'rebind-replay')!.apply(world);
    // 确认绑定已被换掉
    expect(world.engine.bindings.game.interact?.code).toBe('KeyJ');
    while (!world.playback!.done) world.tick();
    const result = world.playback!.result!;
    expect(result.match).toBe(true);
    expect(result.final.interactCount).toBe(2);
  });
});
