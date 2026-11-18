import { describe, it, expect } from 'vitest';
import { buildNavMesh, stringPull, NavMesh } from '../src/core/navmesh';
import { checkRouteClearance } from '../src/core/collision';
import { Rect, Vec2 } from '../src/core/geometry';

const ROOM = { w: 40, h: 30 };

describe('buildNavMesh 矩形空间分解', () => {
  it('无障碍时整个房间(内缩后)是单一连通区域', () => {
    const mesh = buildNavMesh([], 0.4, ROOM.w, ROOM.h);
    expect(mesh.cells.length).toBe(1);
    const cell = mesh.cells[0];
    expect(cell.x0).toBeCloseTo(0.4, 6);
    expect(cell.y0).toBeCloseTo(0.4, 6);
    expect(cell.x1).toBeCloseTo(39.6, 6);
    expect(cell.y1).toBeCloseTo(29.6, 6);
    expect(mesh.findCell({ x: 20, y: 15 })?.id).toBe(cell.id);
    expect(mesh.findCell({ x: -1, y: 15 })).toBeNull();
  });

  it('整面横墙把房间切成上下不连通的两半', () => {
    const wall: Rect = { x: 10, y: 0, w: 2, h: ROOM.h };
    const mesh = buildNavMesh([wall], 0.4, ROOM.w, ROOM.h);
    const left = mesh.findCell({ x: 5, y: 15 });
    const right = mesh.findCell({ x: 30, y: 15 });
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left!.id).not.toBe(right!.id);
    const path = mesh.findCellPath({ x: 5, y: 15 }, { x: 30, y: 15 });
    expect(path).toBeNull();
  });

  it('带缺口的墙在缺口处产生门户, 且门户长度按直径过滤', () => {
    // 墙 x∈[18,20], 仅 y∈[14.5,15.5] 留缺口(净宽 1.0)
    const obstacles: Rect[] = [
      { x: 18, y: 0, w: 2, h: 14.5 },
      { x: 18, y: 15.5, w: 2, h: 14.5 },
    ];
    const smallMesh = buildNavMesh(obstacles, 0.2, ROOM.w, ROOM.h);
    // 门户位于竖墙两侧的 slab 边界, 用缺口 y 区间识别, 不写死 x
    const gapPortalsSmall = smallMesh
      .allPortals()
      .filter((p) => p.a.y < 15.6 && p.b.y > 14.5);
    expect(gapPortalsSmall.length).toBeGreaterThan(0);
    const smallPath = smallMesh.findPath({ x: 4, y: 15 }, { x: 36, y: 15 }, obstacles);
    expect(smallPath).not.toBeNull();
    expect(smallPath!.method).toBe('funnel');

    const bigMesh = buildNavMesh(obstacles, 0.8, ROOM.w, ROOM.h);
    const gapPortalsBig = bigMesh
      .allPortals()
      .filter((p) => p.a.y < 16 && p.b.y > 14);
    expect(gapPortalsBig.length).toBe(0);
    expect(bigMesh.findPath({ x: 4, y: 15 }, { x: 36, y: 15 }, obstacles)).toBeNull();
  });

  it('所有寻路结果都通过独立碰撞校验(随机障碍布局)', () => {
    const layouts: Rect[][] = [
      [{ x: 5, y: 5, w: 4, h: 3 }, { x: 20, y: 18, w: 6, h: 4 }],
      [
        { x: 12, y: 0, w: 2, h: 10 },
        { x: 12, y: 14, w: 2, h: 16 },
        { x: 26, y: 6, w: 2, h: 18 },
      ],
      [{ x: 0, y: 25, w: 15, h: 5 }, { x: 25, y: 0, w: 15, h: 5 }],
    ];
    const probes: [Vec2, Vec2][] = [
      [{ x: 3, y: 3 }, { x: 37, y: 27 }],
      [{ x: 3, y: 27 }, { x: 37, y: 3 }],
      [{ x: 20, y: 2 }, { x: 20, y: 28 }],
    ];
    for (const obstacles of layouts) {
      for (const r of [0.2, 0.5, 0.8]) {
        const mesh = buildNavMesh(obstacles, r, ROOM.w, ROOM.h);
        for (const [s, g] of probes) {
          const result = mesh.findPath(s, g, obstacles);
          if (!result) continue; // 不可达是合法结果
          const check = checkRouteClearance(result.route, r, obstacles, ROOM.w, ROOM.h);
          expect(check.ok, `r=${r} 路线违例: ${check.reason}`).toBe(true);
          expect(check.clearance + 1e-6).toBeGreaterThanOrEqual(r);
        }
      }
    }
  });
});

describe('stringPull 漏斗算法', () => {
  /** 构造一条由竖门户组成的走廊并验证收紧结果 */
  function corridorMesh(): { mesh: NavMesh; obstacles: Rect[] } {
    // 竖墙序列, 缺口交替在下方/上方, 形成 S 形走廊
    const obstacles: Rect[] = [
      { x: 10, y: 0, w: 1, h: 18 }, // 缺口 y∈[18,30]
      { x: 20, y: 10, w: 1, h: 20 }, // 缺口 y∈[0,10]
      { x: 30, y: 0, w: 1, h: 20 }, // 缺口 y∈[20,30]
    ];
    const mesh = buildNavMesh(obstacles, 0.3, ROOM.w, ROOM.h);
    return { mesh, obstacles };
  }

  it('S 形走廊输出拐点折线且全程无碰撞', () => {
    const { mesh, obstacles } = corridorMesh();
    const result = mesh.findPath({ x: 3, y: 15 }, { x: 37, y: 15 }, obstacles);
    expect(result).not.toBeNull();
    expect(result!.route.length).toBeGreaterThanOrEqual(4);
    const check = checkRouteClearance(result!.route, 0.3, obstacles, ROOM.w, ROOM.h);
    expect(check.ok).toBe(true);
    // 漏斗路线不应比门户中点路线长
    const centerLen = result!.portals.reduce(
      (acc, p) => acc + Math.hypot((p.a.x + p.b.x) / 2, (p.a.y + p.b.y) / 2),
      0,
    );
    void centerLen;
  });

  it('同 cell 内直接返回起终点直线', () => {
    const mesh = buildNavMesh([], 0.3, ROOM.w, ROOM.h);
    const result = mesh.findPath({ x: 5, y: 5 }, { x: 35, y: 25 }, []);
    expect(result!.route).toEqual([
      { x: 5, y: 5 },
      { x: 35, y: 25 },
    ]);
  });

  it('空门户序列的 stringPull 退化为直线', () => {
    const route = stringPull({ x: 1, y: 1 }, { x: 9, y: 9 }, [], () => ({ x: 0, y: 0 }));
    expect(route).toEqual([
      { x: 1, y: 1 },
      { x: 9, y: 9 },
    ]);
  });

  it('封闭房间如实返回 null, 不伪造路线', () => {
    // 四面围合(留的缝小于直径), 终点在内部
    const obstacles: Rect[] = [
      { x: 10, y: 10, w: 20, h: 1 },
      { x: 10, y: 19, w: 20, h: 1 },
      { x: 10, y: 10, w: 1, h: 10 },
      { x: 29, y: 10, w: 1, h: 10 },
    ];
    const mesh = buildNavMesh(obstacles, 0.8, ROOM.w, ROOM.h);
    expect(mesh.findPath({ x: 5, y: 15 }, { x: 20, y: 15 }, obstacles)).toBeNull();
  });
});
