import { describe, expect, it } from 'vitest';
import {
  classifyVisibility,
  evaluateAnchorVisibility,
  normalize,
  surfaceTolerance,
} from '../src/core/visibility';
import {
  classifyChange,
  ViewChangeTracker,
  DEFAULT_THRESHOLDS,
  type CameraPose,
} from '../src/core/stability';

describe('遮挡判定', () => {
  const camera = { x: 0, y: 0, z: 10 };
  const forward = { x: 0, y: 0, z: -1 };
  const anchor = { x: 0, y: 0, z: 0 };

  it('没有命中是可见', () => {
    const result = classifyVisibility({
      cameraPosition: camera,
      cameraForward: forward,
      anchorPosition: anchor,
      nearestHitDistance: null,
      tolerance: 0.05,
    });
    expect(result.state).toBe('visible');
  });

  it('锚点贴在自己的表面（命中距离≈锚点距离）仍算可见', () => {
    const result = classifyVisibility({
      cameraPosition: camera,
      cameraForward: forward,
      anchorPosition: anchor,
      nearestHitDistance: 10, // 正好命中在锚点所在的表面
      tolerance: 0.06,
    });
    expect(result.state).toBe('visible');
  });

  it('锚点位于表面稍微内侧时，容差内不算遮挡', () => {
    const result = classifyVisibility({
      cameraPosition: camera,
      cameraForward: forward,
      anchorPosition: anchor,
      nearestHitDistance: 10 - 0.04,
      tolerance: 0.06,
    });
    expect(result.state).toBe('visible');
  });

  it('镜头绕到背后时实体先命中 → 被挡', () => {
    const result = classifyVisibility({
      cameraPosition: camera,
      cameraForward: forward,
      anchorPosition: anchor,
      nearestHitDistance: 8.2,
      tolerance: 0.06,
    });
    expect(result.state).toBe('occluded');
    expect(result.blockerDistance).toBe(8.2);
  });

  it('锚点在镜头背后 → behind', () => {
    const result = classifyVisibility({
      cameraPosition: camera,
      cameraForward: forward,
      anchorPosition: { x: 0, y: 0, z: 14 },
      nearestHitDistance: null,
      tolerance: 0.05,
    });
    expect(result.state).toBe('behind');
  });

  it('正侧方的锚点（dot≈0）视为 behind，避免投影无穷大', () => {
    const result = classifyVisibility({
      cameraPosition: camera,
      cameraForward: forward,
      anchorPosition: { x: 10, y: 0, z: 10 },
      nearestHitDistance: null,
      tolerance: 0.05,
    });
    expect(result.state).toBe('behind');
  });

  it('贴面容差随距离增长但保持有界', () => {
    expect(surfaceTolerance(1)).toBeLessThan(surfaceTolerance(20));
    expect(surfaceTolerance(20, 12)).toBeLessThan(0.2);
  });

  it('注入式判定把射线终点截到容差之前（贴面不误判）', () => {
    let farUsed = -1;
    const result = evaluateAnchorVisibility(
      camera,
      forward,
      anchor,
      (_from, _to, far) => {
        farUsed = far;
        return far; // 射线正好打到终点
      },
      12,
    );
    expect(farUsed).toBeLessThan(10);
    expect(result.state).toBe('visible');
  });

  it('注入式判定：远处实体挡住时为 occluded', () => {
    const result = evaluateAnchorVisibility(camera, forward, anchor, () => 4.5, 12);
    expect(result.state).toBe('occluded');
  });

  it('normalize 处理零向量', () => {
    expect(normalize({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    const n = normalize({ x: 3, y: 0, z: 4 });
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1);
  });
});

describe('视角变化分类', () => {
  const base: CameraPose = {
    position: { x: 0, y: 0, z: 10 },
    target: { x: 0, y: 0, z: 0 },
    fov: 40,
  };

  function orbit(theta: number, radius = 10): CameraPose {
    return {
      position: { x: Math.sin(theta) * radius, y: 0, z: Math.cos(theta) * radius },
      target: { x: 0, y: 0, z: 0 },
      fov: 40,
    };
  }

  it('首次调用视为跳转', () => {
    const tracker = new ViewChangeTracker();
    const result = tracker.update(base, 1);
    expect(result.kind).toBe('jump');
  });

  it('微小旋转是 smooth', () => {
    const a = orbit(0);
    const b = orbit(0.02); // ~1.1°
    const result = classifyChange(a, b, 1 / 60);
    expect(result.kind).toBe('smooth');
  });

  it('一整圈瞬移是 jump', () => {
    const result = classifyChange(orbit(0), orbit(Math.PI * 0.9), 1 / 60);
    expect(result.kind).toBe('jump');
  });

  it('快速拖拽（角速度超限）是 jump', () => {
    const result = classifyChange(orbit(0), orbit(0.4), 1 / 60); // 23°/frame ≈ 1378°/s
    expect(result.kind).toBe('jump');
  });

  it('缓慢拖拽（低于阈值）是 smooth', () => {
    // 0.03 rad over 0.1s ≈ 17°/s
    const result = classifyChange(orbit(0), orbit(0.03), 0.1);
    expect(result.kind).toBe('smooth');
  });

  it('镜头不动是 none', () => {
    const result = classifyChange(orbit(0), orbit(0), 1 / 60);
    expect(result.kind).toBe('none');
  });

  it('缩放幅度过大是 jump', () => {
    const result = classifyChange(orbit(0, 10), orbit(0, 5), 1 / 60);
    expect(result.kind).toBe('jump');
  });

  it('平移过大是 jump', () => {
    const a = orbit(0);
    const b: CameraPose = {
      position: { x: 12, y: 0, z: 10 },
      target: { x: 12, y: 0, z: 0 },
      fov: 40,
    };
    const result = classifyChange(a, b, 1 / 60);
    expect(result.kind).toBe('jump');
  });

  it('时间间隔过大时不参考速度，只看绝对变化', () => {
    const result = classifyChange(orbit(0), orbit(0.03), 2);
    expect(result.kind).toBe('smooth');
  });

  it('阈值可调：放宽后快速拖拽也算 smooth', () => {
    const result = classifyChange(orbit(0), orbit(0.4), 1 / 60, {
      ...DEFAULT_THRESHOLDS,
      maxAngularSpeed: 100000,
      maxSpeed: 100000,
      maxStepAngle: 90,
      maxStepDistance: 100,
      maxZoomRatio: 10,
    });
    expect(result.kind).toBe('smooth');
  });
});
