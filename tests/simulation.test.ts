import { describe, it, expect } from 'vitest';
import { Simulation } from '../src/core/simulation';
import { LAYOUTS } from '../src/core/layouts';
import { checkRouteClearance } from '../src/core/collision';

function simOf(id: string): Simulation {
  const layout = LAYOUTS.find((l) => l.id === id)!;
  return new Simulation(layout);
}

function run(s: Simulation, seconds: number): void {
  const dt = 1 / 60;
  s.play();
  for (let i = 0; i < seconds * 60; i++) s.step(dt);
}

describe('Simulation 状态机', () => {
  it('初始布局路线就绪且统计从 1 次寻路开始', () => {
    const s = simOf('dual-channel');
    expect(['ready', 'moving']).toContain(s.status);
    expect(s.repathCount).toBe(1);
    expect(s.route.length).toBeGreaterThanOrEqual(2);
  });

  it('播放后沿路线走到终点, 状态变为 arrived', () => {
    const s = simOf('dual-channel');
    run(s, 20);
    expect(s.status).toBe('arrived');
    expect(s.playing).toBe(false);
    expect(s.position.x).toBeCloseTo(s.goal.x, 6);
    expect(s.position.y).toBeCloseTo(s.goal.y, 6);
  });

  it('行进中关门: 旧路线立即丢弃, 绕行另一条通道', () => {
    const s = simOf('dual-channel');
    s.play();
    s.step(1);
    const viaTop = s.route.some((p) => p.y >= 6 && p.y <= 10);
    const closing = viaTop ? 'A-top' : 'A-bottom';
    s.setDoorOpen(closing, false);
    expect(['ready', 'moving']).toContain(s.status);
    expect(s.route.length).toBeGreaterThanOrEqual(2);
    // 新路线不能再经过被关闭的门洞
    const stillThroughClosed = s.route.some((p) =>
      viaTop ? p.y >= 6 && p.y <= 10 : p.y >= 20 && p.y <= 24,
    );
    expect(stillThroughClosed).toBe(false);
    run(s, 20);
    expect(s.status).toBe('arrived');
  });

  it('双门全关 -> no-path; 重开 -> 恢复可行', () => {
    const s = simOf('dual-channel');
    s.setDoorOpen('A-top', false);
    s.setDoorOpen('A-bottom', false);
    expect(s.status).toBe('no-path');
    expect(s.route.length).toBe(0);
    s.setDoorOpen('A-bottom', true);
    expect(['ready', 'moving']).toContain(s.status);
  });

  it('起点落在障碍内 -> start-invalid; 终点落在障碍内 -> goal-invalid', () => {
    const s = simOf('dual-channel');
    const o = s.obstacleList[0];
    s.setStart({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
    expect(s.status).toBe('start-invalid');
    s.setStart({ x: 4, y: 15 });
    s.setGoal({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
    expect(s.status).toBe('goal-invalid');
  });

  it('门占住角色位置 -> trapped, 暂停, 不传送', () => {
    const s = simOf('dual-channel');
    // 先让角色走到上门门洞(x∈[18,20])内, 再关门把它困住
    s.setStart({ x: 4, y: 8 });
    s.play();
    for (let i = 0; i < 60 * 5; i++) {
      s.step(1 / 60);
      if (s.position.x >= 18.2 && s.position.x <= 19.8) break;
      if (s.status !== 'moving') break;
    }
    expect(s.position.x).toBeGreaterThan(18);
    expect(s.position.x).toBeLessThan(20);
    const pos = { ...s.position };
    s.pause();
    s.setDoorOpen('A-top', false);
    expect(s.status).toBe('trapped');
    expect(s.playing).toBe(false);
    expect(s.position).toEqual(pos);
    s.play();
    s.step(1);
    expect(s.position).toEqual(pos);
    expect(s.status).toBe('trapped');
    s.setDoorOpen('A-top', true);
    expect(s.status).not.toBe('trapped');
    expect(s.position).toEqual(pos);
  });

  it('半径变化改变窄门可达性', () => {
    const s = simOf('narrow-door');
    s.setRadius(0.2);
    expect(['ready', 'moving']).toContain(s.status);
    s.setRadius(0.8);
    expect(s.status).toBe('no-path');
    s.setRadius(0.2);
    expect(['ready', 'moving']).toContain(s.status);
  });

  it('恢复布局: 障碍、门、统计与角色位置全部复原', () => {
    const s = simOf('dual-channel');
    const originalPos = { ...s.position };
    s.setGoal({ x: 36, y: 5 }); // 换个终点, 保证后续真的会走起来
    s.play();
    s.step(2);
    const movedPos = { ...s.position };
    expect(s.position).not.toEqual(originalPos);
    s.setDoorOpen('A-top', false);
    s.setRadius(0.7);
    s.moveObstacle(3, { x: 2, y: 2, w: 4, h: 3 });
    const countBeforeReset = s.repathCount;
    expect(countBeforeReset).toBeGreaterThan(1);

    s.resetLayout();
    expect(s.position).toEqual(originalPos);
    expect(s.position).not.toEqual(movedPos);
    expect(s.repathCount).toBe(1);
    expect(s.radius).toBe(0.4);
    expect(s.isDoorOpen('A-top')).toBe(true);
    expect(s.obstacleList[3].x).toBe(LAYOUTS[0].staticObstacles[3].x);
    expect(['ready', 'moving']).toContain(s.status);
  });

  it('剩余路程随行进递减, 到达后为 0', () => {
    const s = simOf('narrow-door');
    s.setRadius(0.2);
    const before = s.remainingDistance;
    expect(before).toBeGreaterThan(20);
    s.play();
    expect(s.status).toBe('moving');
    s.step(1);
    expect(s.remainingDistance).toBeLessThan(before);
    run(s, 20);
    expect(s.status).toBe('arrived');
    expect(s.remainingDistance).toBe(0);
  });

  it('每次活动路线都能通过独立碰撞校验(三个布局)', () => {
    for (const layout of LAYOUTS) {
      const s = new Simulation(layout);
      const check = checkRouteClearance(
        s.route,
        s.radius,
        s.activeObstacles(),
        s.width,
        s.height,
      );
      expect(check.ok, `${layout.id}: ${check.reason}`).toBe(true);
    }
  });
});
