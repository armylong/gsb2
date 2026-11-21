import { mulberry32 } from './math.ts';
import type { Actor, PathKey, Rect, Vec2 } from './types.ts';

/**
 * 分段线性路径求值(确定性, 无随机):
 * 到达末尾后按 loop 决定环绕还是停在终点。
 */
export function evalPath(path: PathKey[], t: number, loop: boolean): Vec2 {
  if (path.length === 1) return { x: path[0].x, y: path[0].y };
  const first = path[0].t;
  const last = path[path.length - 1].t;

  let tt = t;
  if (loop) {
    const span = last - first;
    if (span > 0) tt = first + (((t - first) % span) + span) % span;
  }

  if (tt <= first) return { x: path[0].x, y: path[0].y };
  if (tt >= last) {
    const e = path[path.length - 1];
    return { x: e.x, y: e.y };
  }
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (tt >= a.t && tt <= b.t) {
      const u = (tt - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  const e = path[path.length - 1];
  return { x: e.x, y: e.y };
}

export interface Scenario {
  world: Rect;
  duration: number;
  actors: Actor[];
}

/**
 * 程序内置样例: 两个活动角色 + 一个备选跟随对象。
 * 路径在程序里由确定性 PRNG 生成, 同 seed 永远得到同样的样例。
 */
export function generateScenario(seed = 14416): Scenario {
  const rnd = mulberry32(seed);
  const world: Rect = { x: 0, y: 0, w: 1800, h: 1100 };
  const duration = 16;

  const jitter = (amp: number) => (rnd() - 0.5) * 2 * amp;
  const mk = (t: number, nx: number, ny: number, amp = 0): PathKey => ({
    t,
    x: nx * world.w + jitter(amp),
    y: ny * world.h + jitter(amp),
  });

  // 角色 A: 横向横穿 —— 用来观察水平平移与边缘出入
  const actorA: Actor = {
    id: 'A',
    name: '角色 A (横穿)',
    color: '#4f8cff',
    shape: 'circle',
    radius: 26,
    loop: true,
    path: [
      mk(0, 0.06, 0.3, 24),
      mk(3, 0.35, 0.22, 24),
      mk(6, 0.66, 0.35, 24),
      mk(9, 0.94, 0.28, 24),
      mk(12, 0.55, 0.45, 24),
      mk(16, 0.06, 0.3, 24),
    ],
  };

  // 角色 B: 纵向巡逻且与 A 拉开 —— 用来触发超距裁切
  const actorB: Actor = {
    id: 'B',
    name: '角色 B (纵巡)',
    color: '#ff7a45',
    shape: 'square',
    radius: 24,
    loop: true,
    path: [
      mk(0, 0.9, 0.92, 20),
      mk(4, 0.82, 0.55, 20),
      mk(8, 0.92, 0.12, 20),
      mk(12, 0.78, 0.6, 20),
      mk(16, 0.9, 0.92, 20),
    ],
  };

  // 角色 C: 中央徘徊, 默认不在跟随名单, 用于切换名单测试
  const actorC: Actor = {
    id: 'C',
    name: '角色 C (中央, 备选)',
    color: '#37b24d',
    shape: 'triangle',
    radius: 22,
    loop: true,
    path: [
      mk(0, 0.45, 0.5, 30),
      mk(4, 0.55, 0.62, 30),
      mk(8, 0.42, 0.45, 30),
      mk(12, 0.52, 0.58, 30),
      mk(16, 0.45, 0.5, 30),
    ],
  };

  return { world, duration, actors: [actorA, actorB, actorC] };
}
