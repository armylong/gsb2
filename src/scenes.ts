import { Vec2 } from 'planck';
import { Sim } from './sim';

export type SceneName = 'ramp' | 'collision' | 'stack';

export const SCENE_LABELS: Record<SceneName, string> = {
  ramp: '摩擦斜坡',
  collision: '双球弹性碰撞',
  stack: '密集堆叠',
};

/** 斜坡角度(度),测试与界面共用 */
export const RAMP_ANGLE_DEG = 18;
/** 碰撞场景小球的初速度(m/s) */
export const COLLISION_SPEED = 4;

/**
 * 加载预设场景。每次调用都先清空世界,
 * 因此“重置”就是重新加载当前场景,参数恢复初始值。
 */
export function loadScene(sim: Sim, name: SceneName): void {
  sim.clear();
  if (name === 'ramp') buildRamp(sim);
  else if (name === 'collision') buildCollision(sim);
  else buildStack(sim);
}

/** 摩擦斜坡:两个摩擦系数不同的滑块,便于对照滑动距离 */
function buildRamp(sim: Sim): void {
  // 地面
  sim.addStaticBox(10, -0.5, 20, 0.5, 0, 0.6);
  // 斜坡(静态斜面)
  const theta = (RAMP_ANGLE_DEG * Math.PI) / 180;
  const rcx = 5.5;
  const rcy = 1.6;
  const halfLen = 3.2;
  const halfThick = 0.15;
  sim.addStaticBox(rcx, rcy, halfLen, halfThick, theta, 0.5);
  // 沿斜面方向与法向放置滑块
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  const place = (s: number) => ({
    x: rcx + ux * s + nx * (halfThick + 0.25),
    y: rcy + uy * s + ny * (halfThick + 0.25),
  });
  // 低摩擦滑块(会下滑)
  const p1 = place(-1.6);
  sim.addRect(p1.x, p1.y, 0.25, 0.25, theta, { friction: 0.15, restitution: 0 });
  // 高摩擦滑块(基本停住)
  const p2 = place(0.2);
  sim.addRect(p2.x, p2.y, 0.25, 0.25, theta, { friction: 0.55, restitution: 0 });
}

/** 双球弹性碰撞:无摩擦地面,恢复系数 1,等质量对心碰撞 */
function buildCollision(sim: Sim): void {
  sim.addStaticBox(10, -0.5, 20, 0.5, 0, 0);
  const a = sim.addCircle(5, 0.5, 0.5, { friction: 0, restitution: 1 });
  const b = sim.addCircle(11, 0.5, 0.5, { friction: 0, restitution: 1 });
  if (a !== null) {
    sim.getBody(a)?.setLinearVelocity(new Vec2(COLLISION_SPEED, 0));
  }
  void b;
}

/** 密集堆叠:5-4-3-2-1 金字塔,共 15 个箱子 */
function buildStack(sim: Sim): void {
  sim.addStaticBox(10, -0.5, 20, 0.5, 0, 0.8);
  const halfW = 0.4;
  const halfH = 0.25;
  const stepX = 0.82;
  const stepY = 0.52; // 层间留 0.02m 间隙,落定时有微小下沉
  const baseX = 10;
  for (let row = 0; row < 5; row++) {
    const count = 5 - row;
    const y = halfH + row * stepY + 0.001;
    const startX = baseX - ((count - 1) / 2) * stepX;
    for (let i = 0; i < count; i++) {
      sim.addRect(startX + i * stepX, y, halfW, halfH, 0, { friction: 0.6, restitution: 0 });
    }
  }
}
