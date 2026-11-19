import * as THREE from 'three';
import { defaultMaterial } from './materials';
import type { BoxDef, SceneObjectDef, ShotParams, TargetDef } from './types';

let seq = 0;
export function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export function makeBox(
  partial: Partial<BoxDef> & Pick<BoxDef, 'name' | 'material'>,
): BoxDef {
  return {
    id: partial.id ?? uniqueId('box'),
    name: partial.name,
    position: partial.position ?? new THREE.Vector3(),
    rotation: partial.rotation ?? new THREE.Euler(),
    size: partial.size ?? new THREE.Vector3(2, 2, 2),
    material: partial.material,
  };
}

export function makeTarget(partial: Partial<TargetDef> & Pick<TargetDef, 'name'>): TargetDef {
  return {
    id: partial.id ?? uniqueId('target'),
    name: partial.name,
    position: partial.position ?? new THREE.Vector3(),
    rotation: partial.rotation ?? new THREE.Euler(),
    size: partial.size ?? new THREE.Vector2(3, 3),
  };
}

export interface Preset {
  key: string;
  label: string;
  description: string;
  boxes: BoxDef[];
  targets: TargetDef[];
  shot: ShotParams;
}

const baseShot = (over: Partial<ShotParams>): ShotParams => ({
  origin: new THREE.Vector3(-10, 0, 0),
  direction: new THREE.Vector3(1, 0, 0),
  initialEnergy: 100,
  maxRange: 60,
  maxInteractions: 8,
  minEnergy: 1,
  ...over,
});

/**
 * 现场 1: 斜穿。
 * 射线方位角 30° (dir = (sin30°, 0, cos30°)), 穿过绕 Y 轴旋转 45° 的可穿透盒中心。
 * 在盒子局部空间, 射线 x 分量 = -sin15°, 入射/出射都落在局部 x 两个面上,
 * 预期内部斜穿长度 = 2 / sin15° ≈ 7.7274 (盒子标称 x 厚度只有 2, 斜距远大于标称厚度)。
 * 取盒子尺寸 (2, 4, 8), 保证 z 方向 slab 不先裁剪。
 */
export function obliquePreset(): Preset {
  const boxes: BoxDef[] = [
    makeBox({
      id: 'ob-box',
      name: '斜穿盒(可穿透)',
      position: new THREE.Vector3(4, 0, 2),
      rotation: new THREE.Euler(0, Math.PI / 4, 0),
      size: new THREE.Vector3(2, 4, 8),
      material: { ...defaultMaterial('penetrable'), resistance: 5 },
    }),
  ];
  const targets: TargetDef[] = [
    makeTarget({
      id: 'ob-target',
      name: '斜穿后方靶面',
      position: new THREE.Vector3(8.932, 0, 10.542),
      rotation: new THREE.Euler(0, Math.PI / 6, 0),
      size: new THREE.Vector2(4, 4),
    }),
  ];
  return {
    key: 'oblique',
    label: '现场1: 斜穿',
    description:
      '旋转 45° 的可穿透盒, 射线以 30° 方位角斜穿, 验证内部长度按实际斜距 7.727 而非标称厚度 2。',
    boxes,
    targets,
    shot: baseShot({
      origin: new THREE.Vector3(-3, 0, -10.124),
      direction: new THREE.Vector3(Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)),
      initialEnergy: 100,
    }),
  };
}

/**
 * 现场 2: 反弹后穿透。
 * 射线沿 +x 击中绕 Y 轴 -45° 反弹盒的斜面 (入射角 45°), 反射后严格沿 +z,
 * 再沿 +z 穿透一块厚 1 的可穿透薄盒 (内部长度 1, 耗能 6), 最后命中 z 向靶面。
 * 反射点手算: (-1.414, 0, 0), 反射后能量 100 * (1-0.2) = 80。
 */
export function reflectThenPenetratePreset(): Preset {
  const boxes: BoxDef[] = [
    makeBox({
      id: 'rp-reflector',
      name: '45°反弹盒(可反弹)',
      position: new THREE.Vector3(1, 0, -2.4142),
      rotation: new THREE.Euler(0, -Math.PI / 4, 0),
      size: new THREE.Vector3(2, 6, 6),
      material: { ...defaultMaterial('reflective'), reflectLossRatio: 0.2, maxReflectAngleDeg: 60 },
    }),
    makeBox({
      id: 'rp-thin',
      name: '反弹路径薄盒(可穿透)',
      position: new THREE.Vector3(-0.8284, 0, 6),
      rotation: new THREE.Euler(),
      size: new THREE.Vector3(3, 3, 1),
      material: { ...defaultMaterial('penetrable'), resistance: 6 },
    }),
  ];
  const targets: TargetDef[] = [
    makeTarget({
      id: 'rp-target',
      name: '反弹后靶面',
      position: new THREE.Vector3(-0.8284, 0, 16),
      rotation: new THREE.Euler(0, Math.PI, 0),
      size: new THREE.Vector2(4, 4),
    }),
  ];
  return {
    key: 'reflect-penetrate',
    label: '现场2: 反弹后穿透',
    description: '45° 反射把 +x 方向折到 +z, 反射扣 20% 能量后再穿透薄盒并命中靶面。',
    boxes,
    targets,
    shot: baseShot({
      origin: new THREE.Vector3(-8, 0, 0),
      direction: new THREE.Vector3(1, 0, 0),
      initialEnergy: 100,
    }),
  };
}

/**
 * 现场 3: 能量耗尽, 停在材料内部。
 * 盒厚 4, 阻力 10, 初始能量 25 → 最多走 2.5, 停点距入口 2.5 (盒内)。
 */
export function exhaustPreset(): Preset {
  const boxes: BoxDef[] = [
    makeBox({
      id: 'ex-box',
      name: '高阻力厚盒(可穿透)',
      position: new THREE.Vector3(2, 0, 0),
      rotation: new THREE.Euler(),
      size: new THREE.Vector3(4, 4, 4),
      material: { ...defaultMaterial('penetrable'), resistance: 10 },
    }),
  ];
  const targets: TargetDef[] = [
    makeTarget({
      id: 'ex-target',
      name: '厚盒后方靶面(不应命中)',
      position: new THREE.Vector3(8, 0, 0),
      rotation: new THREE.Euler(0, Math.PI / 2, 0),
      size: new THREE.Vector2(4, 4),
    }),
  ];
  return {
    key: 'exhaust',
    label: '现场3: 能量耗尽',
    description: '能量只够在材料内部走 2.5 单位, 弹道停在盒内, 后方靶面不命中。',
    boxes,
    targets,
    shot: baseShot({
      origin: new THREE.Vector3(-6, 0, 0),
      direction: new THREE.Vector3(1, 0, 0),
      initialEnergy: 25,
      minEnergy: 1,
    }),
  };
}

/** 应用启动时的默认自由编辑场景: 三种材料各一块 + 两个靶面, 互不相交。 */
export function defaultScene(): { boxes: BoxDef[]; targets: TargetDef[]; shot: ShotParams } {
  const boxes: BoxDef[] = [
    makeBox({
      id: 'def-penetrable',
      name: '可穿透盒 A',
      position: new THREE.Vector3(2, 0, 0),
      rotation: new THREE.Euler(0, 0.3, 0),
      size: new THREE.Vector3(2, 3, 3),
      material: defaultMaterial('penetrable'),
    }),
    makeBox({
      id: 'def-reflective',
      name: '可反弹盒 B',
      position: new THREE.Vector3(-1, 1, -7),
      rotation: new THREE.Euler(0, Math.PI / 5, 0),
      size: new THREE.Vector3(1.5, 3, 3),
      material: defaultMaterial('reflective'),
    }),
    makeBox({
      id: 'def-blocking',
      name: '阻挡盒 C',
      position: new THREE.Vector3(5, -1, 4),
      rotation: new THREE.Euler(0.2, 0, 0.1),
      size: new THREE.Vector3(2, 2, 2),
      material: defaultMaterial('blocking'),
    }),
  ];
  const targets: TargetDef[] = [
    makeTarget({
      id: 'def-target-1',
      name: '主靶面',
      position: new THREE.Vector3(9, 0, 0),
      rotation: new THREE.Euler(0, Math.PI / 2, 0),
      size: new THREE.Vector2(4, 4),
    }),
    makeTarget({
      id: 'def-target-2',
      name: '侧靶面',
      position: new THREE.Vector3(0, 0, 9),
      rotation: new THREE.Euler(Math.PI / 2, 0, 0),
      size: new THREE.Vector2(3, 3),
    }),
  ];
  const shot = baseShot({
    origin: new THREE.Vector3(-8, 1, 2),
    direction: new THREE.Vector3(1, -0.05, -0.1),
  });
  return { boxes, targets, shot };
}

export function allPresets(): Preset[] {
  return [obliquePreset(), reflectThenPenetratePreset(), exhaustPreset()];
}

export function cloneDefs(defs: SceneObjectDef[]): SceneObjectDef[] {
  return defs.map((d) => {
    const base = {
      ...d,
      position: d.position.clone(),
      rotation: d.rotation.clone(),
    };
    if ('material' in d) {
      return { ...base, size: d.size.clone(), material: { ...d.material } } as BoxDef;
    }
    return { ...base, size: d.size.clone() } as TargetDef;
  });
}
