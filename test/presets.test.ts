import { describe, it, expect } from 'vitest';
import { PRESETS } from '../src/presets';

function run(sim: ReturnType<(typeof PRESETS)[number]['build']>, ticks: number) {
  for (let i = 0; i < ticks; i++) sim.tick();
}

describe('预设示例自检', () => {
  it('示例1:甲经绕行路径听到,乙强度不足,丙正常听到', () => {
    const sim = PRESETS[1].build();
    run(sim, 60);
    const [a, b, c] = sim.npcs;
    // 甲:绕墙到达,听到
    expect(a.heard.length).toBe(1);
    expect(a.heard[0].intensity).toBe(20 - 14); // 绕行 14 步
    expect(a.heard[0].time).toBe(14);
    // 乙:距离 16,强度 4 < 阈值 5
    expect(b.heard.length).toBe(0);
    expect(b.missed[0].reason).toBe('too-quiet');
    // 丙:开阔处听到
    expect(c.heard.length).toBe(1);
  });

  it('示例2:关门时甲强度不足;开门后重新发声甲能听到,旧事件不受影响', () => {
    const sim = PRESETS[2].build();
    run(sim, 30);
    const [a, b, c] = sim.npcs;
    expect(a.heard.length).toBe(0);
    expect(a.missed[0].reason).toBe('too-quiet'); // 20-16=4 < 8
    expect(b.heard.length).toBe(1);
    expect(c.missed[0].reason).toBe('unreachable'); // 强度耗尽到不了
    // 开门后在同一格再发一次
    sim.map.at(15, 10).doorOpen = true;
    sim.emit('impact', 8, 10);
    run(sim, 30);
    expect(a.heard.length).toBe(1);
    expect(a.heard[0].eventId).toBe(2);
    expect(a.heard[0].intensity).toBe(20 - 12); // 开门只耗 12
    // 旧事件 #1 的记录保持"未听到",不被改写
    expect(a.missed.some((m) => m.eventId === 1)).toBe(true);
  });

  it('示例3:甲先调查撞击,脚步到达后改查脚步', () => {
    const sim = PRESETS[3].build();
    const [a] = sim.npcs;
    run(sim, 8); // t=8:撞击 t=7 已到,脚步 t=10 未到
    expect(a.investigationTarget()!.eventId).toBe(1);
    run(sim, 5); // t=13:脚步已到达
    expect(a.heard.length).toBe(2);
    expect(a.investigationTarget()!.eventId).toBe(2);
  });
});
