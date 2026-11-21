import { Euler, Quaternion, Vector3 } from 'three';
import { Rng } from './rng';
import type {
  GeneratedScene,
  RaySpec,
  SceneObject,
  ShapeKind,
  Specials,
} from './types';
import { closestPointOnBox, distanceSq, quatToMat3, rayBox, transformedAabb, type BoxLike, type Vec3 } from './geometry';

export const DEFAULT_SEED = 20260422;
export const DEFAULT_OBJECT_COUNT = 420;
export const WORLD = {
  min: { x: -40, y: -12, z: -34 },
  max: { x: 40, y: 24, z: 34 },
} as const;

/** 分组上限候选；1 近乎逐件，32 是较粗的分组。 */
export const CAPACITY_PRESETS = [1, 2, 4, 8, 16, 32] as const;

const RANDOM_PALETTE = [0x8d98a8, 0x9aa5b4, 0x7c8798, 0xa3adbb, 0x8693a4, 0x93a2b0];

const RAY_CLEARANCE_RADIUS = 1.3;
const AXIS_RAY_LENGTH = 120;

interface DemoSpec {
  id: number;
  label: string;
  kind: ShapeKind;
  position: [number, number, number];
  size: [number, number, number];
  euler?: [number, number, number];
  style: SceneObject['style'];
  color: number;
}

/**
 * 固定演示物件，id 0..5。第一个随机物件的 id 从 6 开始。
 * 演示布局沿 y=4 的主轴，位置刻意错开，避免互相遮挡。
 */
const DEMOS: DemoSpec[] = [
  {
    id: 0,
    label: '嵌套外壳',
    kind: 'box',
    position: [28, 4, 0],
    size: [6, 6, 6],
    style: 'shell',
    color: 0x8a94a6,
  },
  {
    id: 1,
    label: '嵌套内球',
    kind: 'sphere',
    position: [28, 4, 0],
    size: [3, 3, 3],
    style: 'normal',
    color: 0xb9c0cc,
  },
  {
    id: 2,
    label: '内部发射容器',
    kind: 'box',
    position: [-4, 4, 16],
    size: [9, 9, 9],
    style: 'wire',
    color: 0x7f8ca0,
  },
  {
    id: 3,
    label: '并列球 A',
    kind: 'sphere',
    position: [8.4, 4, -6],
    size: [3.6, 3.6, 3.6],
    style: 'normal',
    color: 0x96a1b0,
  },
  {
    id: 4,
    label: '并列球 B',
    kind: 'sphere',
    position: [11.6, 4, -6],
    size: [3.6, 3.6, 3.6],
    style: 'normal',
    color: 0x96a1b0,
  },
  {
    id: 5,
    label: 'AABB 误报球',
    kind: 'sphere',
    position: [-18, 4, 30],
    size: [4, 4, 4],
    style: 'wire',
    color: 0x9a93b5,
  },
];

const SPECIALS: Specials = {
  nestedOuterId: 0,
  nestedInnerId: 1,
  insideId: 2,
  tieIds: [3, 4],
  aabbFalsePositiveId: 5,
};

function makeObject(
  id: number,
  label: string,
  kind: ShapeKind,
  position: Vector3,
  quaternion: Quaternion,
  size: Vector3,
  style: SceneObject['style'],
  color: number,
): SceneObject {
  return {
    id,
    label,
    kind,
    position,
    quaternion,
    size,
    style,
    color,
    initial: {
      position: position.clone(),
      quaternion: quaternion.clone(),
      size: size.clone(),
    },
  };
}

export function demoObjects(): SceneObject[] {
  return DEMOS.map((d) => {
    const q = new Quaternion();
    if (d.euler) q.setFromEuler(new Euler(d.euler[0], d.euler[1], d.euler[2], 'XYZ'));
    return makeObject(
      d.id,
      d.label,
      d.kind,
      new Vector3(...d.position),
      q,
      new Vector3(...d.size),
      d.style,
      d.color,
    );
  });
}

/**
 * 固定演示射线。每条射线都带一条净空走廊，生成随机物件时避开，
 * 保证演示结果在默认种子上稳定。
 *
 * - nested: 沿 +x 穿过嵌套外壳中心，先后命中外壳与内球。
 * - inside: 起点在容器中心，t=0 命中容器自身。
 * - tie: 沿 +z 穿过两个等距球，命中距离完全相等。
 * - aabb: 沿 +x 从 AABB 的角落擦过，进包围盒但错过球体。
 */
export function demoRays(): RaySpec[] {
  const aabbSphere = DEMOS.find((d) => d.id === SPECIALS.aabbFalsePositiveId)!;
  const r = aabbSphere.size[0] / 2;
  const corner = r * 0.85;
  return [
    {
      origin: new Vector3(-8, 4, 0),
      direction: new Vector3(1, 0, 0),
      label: '嵌套：外壳 → 内球',
      tag: 'nested',
      clearance: { length: AXIS_RAY_LENGTH, radius: RAY_CLEARANCE_RADIUS },
    },
    {
      origin: new Vector3(-4, 4, 16),
      direction: new Vector3(0, 0, -1),
      label: '内部发射：容器内起点',
      tag: 'inside',
      clearance: { length: AXIS_RAY_LENGTH, radius: RAY_CLEARANCE_RADIUS },
    },
    {
      origin: new Vector3(10, 4, -28),
      direction: new Vector3(0, 0, 1),
      label: '并列：两个等距球',
      tag: 'tie',
      clearance: { length: AXIS_RAY_LENGTH, radius: RAY_CLEARANCE_RADIUS },
    },
    {
      origin: new Vector3(-34, aabbSphere.position[1] + corner, aabbSphere.position[2] + corner),
      direction: new Vector3(1, 0, 0),
      label: 'AABB 误报：擦过包围盒角落',
      tag: 'aabb',
      clearance: { length: AXIS_RAY_LENGTH, radius: RAY_CLEARANCE_RADIUS },
    },
  ];
}

function expandedBox(box: BoxLike, by: number): BoxLike {
  return {
    min: { x: box.min.x - by, y: box.min.y - by, z: box.min.z - by },
    max: { x: box.max.x + by, y: box.max.y + by, z: box.max.z + by },
  };
}

function aabbOf(obj: SceneObject): BoxLike {
  const half = { x: obj.size.x / 2, y: obj.size.y / 2, z: obj.size.z / 2 };
  return transformedAabb(
    { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    half,
    quatToMat3(obj.quaternion),
  );
}

function corridorBlocks(
  corridor: { origin: Vec3; dir: Vec3; length: number; radius: number },
  box: BoxLike,
): boolean {
  // 射线是否穿过“包围盒外扩 radius”的管道，且交点落在射线段内。
  const span = rayBox(corridor.origin, corridor.dir, expandedBox(box, corridor.radius));
  if (!span) return false;
  return span[1] >= 0 && span[0] <= corridor.length;
}

function sphereBlocks(
  sphere: { center: Vec3; radius: number },
  box: BoxLike,
): boolean {
  const cp = closestPointOnBox(sphere.center, box);
  return distanceSq(cp, sphere.center) < sphere.radius * sphere.radius;
}

function insideWorld(box: BoxLike): boolean {
  return (
    box.min.x >= WORLD.min.x &&
    box.min.y >= WORLD.min.y &&
    box.min.z >= WORLD.min.z &&
    box.max.x <= WORLD.max.x &&
    box.max.y <= WORLD.max.y &&
    box.max.z <= WORLD.max.z
  );
}

/**
 * 固定种子生成场景。
 *
 * - 默认 seed 生成的对象布局、尺寸、朝向完全一致；
 * - 演示物件（嵌套、内部发射、并列、AABB 误报）拥有固定 id 0..5；
 * - 随机物件会避开演示物件与演示射线走廊，保证演示结果稳定；
 * - 随机物件约 40% 成簇，用来制造疏密不同的分组。
 */
export function generateScene(
  seed = DEFAULT_SEED,
  count = DEFAULT_OBJECT_COUNT,
): GeneratedScene {
  const rng = new Rng(seed);
  const objects: SceneObject[] = demoObjects();
  const rays = demoRays();

  // 演示区保持净空。
  const keepOutSpheres = objects.map((obj) => {
    const box = aabbOf(obj);
    const half = new Vector3(
      (box.max.x - box.min.x) / 2,
      (box.max.y - box.min.y) / 2,
      (box.max.z - box.min.z) / 2,
    );
    return {
      center: obj.position,
      radius: half.length() + 1.4,
    };
  });
  const corridors = rays.map((r) => ({
    origin: { x: r.origin.x, y: r.origin.y, z: r.origin.z },
    dir: { x: r.direction.x, y: r.direction.y, z: r.direction.z },
    length: r.clearance?.length ?? AXIS_RAY_LENGTH,
    radius: r.clearance?.radius ?? 1.1,
  }));

  const clusters = Array.from({ length: 10 }, () => ({
    center: new Vector3(
      rng.between(WORLD.min.x + 8, WORLD.max.x - 8),
      rng.between(WORLD.min.y + 8, WORLD.max.y - 8),
      rng.between(WORLD.min.z + 8, WORLD.max.z - 8),
    ),
    radius: rng.between(5, 12),
  }));

  const occupied: { position: Vector3; radius: number; box: BoxLike }[] = objects.map(
    (obj) => ({
      position: obj.position,
      radius: Math.max(obj.size.x, obj.size.y, obj.size.z) / 2,
      box: aabbOf(obj),
    }),
  );

  let attempts = 0;
  const maxAttempts = count * 120;
  while (objects.length < count + DEMOS.length && attempts < maxAttempts) {
    attempts++;

    let position: Vector3;
    if (rng.next() < 0.4) {
      const cluster = rng.pick(clusters);
      position = new Vector3(
        cluster.center.x + rng.gaussian(0, cluster.radius),
        cluster.center.y + rng.gaussian(0, cluster.radius * 0.6),
        cluster.center.z + rng.gaussian(0, cluster.radius),
      );
    } else {
      position = new Vector3(
        rng.between(WORLD.min.x + 4, WORLD.max.x - 4),
        rng.between(WORLD.min.y + 4, WORLD.max.y - 4),
        rng.between(WORLD.min.z + 4, WORLD.max.z - 4),
      );
    }

    const kind: ShapeKind = rng.next() < 0.68 ? 'box' : 'sphere';
    const base = Math.exp(rng.gaussian(Math.log(2.1), 0.6));
    const sx = Math.min(Math.max(base * rng.between(0.6, 1.4), 0.5), 8);
    const sy = Math.min(Math.max(base * rng.between(0.6, 1.4), 0.5), 8);
    const sz = Math.min(Math.max(base * rng.between(0.6, 1.4), 0.5), 8);
    // 球体保持正球（椭球会让“AABB 误报”演示难以解释），盒体允许非等比。
    const sphereSize = Math.min(sx, sy, sz);
    const size = new Vector3(
      kind === 'sphere' ? sphereSize : sx,
      kind === 'sphere' ? sphereSize : sy,
      kind === 'sphere' ? sphereSize : sz,
    );

    const euler = new Euler(
      rng.between(-0.4, 0.4),
      rng.between(-Math.PI, Math.PI),
      rng.between(-0.4, 0.4),
      'YXZ',
    );
    const quaternion = new Quaternion().setFromEuler(euler);

    const id = objects.length;
    const obj = makeObject(
      id,
      `${kind === 'box' ? '箱体' : '球体'} ${String(id).padStart(3, '0')}`,
      kind,
      position,
      quaternion,
      size,
      'normal',
      rng.pick(RANDOM_PALETTE),
    );

    const box = aabbOf(obj);
    if (!insideWorld(box)) continue;

    const radius = Math.max(size.x, size.y, size.z) / 2;
    let blocked = false;

    for (const s of keepOutSpheres) {
      if (sphereBlocks(s, box)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    for (const c of corridors) {
      if (corridorBlocks(c, box)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    // 限制重叠：完全重合会让画面糊成一团；这里允许接触和少量穿插。
    for (const other of occupied) {
      const minGap = 0.9 * (radius + other.radius);
      if (position.distanceToSquared(other.position) < minGap * minGap) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    objects.push(obj);
    occupied.push({ position, radius, box });
  }

  if (objects.length !== count + DEMOS.length) {
    throw new Error(
      `场景生成失败：期望 ${count + DEMOS.length} 件，实际 ${objects.length} 件`,
    );
  }

  return {
    seed,
    objects,
    specials: SPECIALS,
    keepOut: keepOutSpheres,
    rays,
  };
}

/**
 * 构造同一批核查射线：固定演示射线 + 确定性随机射线。
 *
 * 随机射线包含四种来源：空中随机点、物件内部起点、瞄准物件中心的射线、
 * 以及环绕场景的“相机位”射线。
 */
export function buildRayBatch(scene: GeneratedScene, randomCount = 200): RaySpec[] {
  const rng = new Rng((scene.seed ^ 0x5bd1e995) >>> 0);
  const rays: RaySpec[] = [...scene.rays];
  const objects = scene.objects;
  const center = new Vector3(0, 6, 0);

  const push = (origin: Vector3, direction: Vector3, label: string, tag: string) => {
    const dir = direction.clone();
    if (dir.lengthSq() < 1e-12) return;
    dir.normalize();
    rays.push({ origin, direction: dir, label, tag });
  };

  for (let i = 0; i < randomCount; i++) {
    const mode = i % 4;
    if (mode === 0) {
      const origin = new Vector3(
        rng.between(WORLD.min.x - 10, WORLD.max.x + 10),
        rng.between(WORLD.min.y - 6, WORLD.max.y + 6),
        rng.between(WORLD.min.z - 10, WORLD.max.z + 10),
      );
      const target = new Vector3(
        rng.between(WORLD.min.x, WORLD.max.x),
        rng.between(WORLD.min.y, WORLD.max.y),
        rng.between(WORLD.min.z, WORLD.max.z),
      );
      push(origin, target.sub(origin), `随机 #${i}`, 'random');
    } else if (mode === 1) {
      const obj = rng.pick(objects);
      const jitter = new Vector3(
        rng.between(-0.25, 0.25) * obj.size.x,
        rng.between(-0.25, 0.25) * obj.size.y,
        rng.between(-0.25, 0.25) * obj.size.z,
      );
      const origin = obj.position.clone().add(jitter);
      const direction = new Vector3(
        rng.between(-1, 1),
        rng.between(-1, 1),
        rng.between(-1, 1),
      );
      push(origin, direction, `内部起点 #${i}`, 'inside');
    } else if (mode === 2) {
      const obj = rng.pick(objects);
      const back = new Vector3(
        rng.between(-1, 1),
        rng.between(-0.4, 1),
        rng.between(-1, 1),
      ).normalize();
      const origin = obj.position.clone().addScaledVector(back, rng.between(18, 55));
      push(origin, obj.position.clone().sub(origin), `瞄准中心 #${i}`, 'aim');
    } else {
      const theta = rng.between(0, Math.PI * 2);
      const phi = rng.between(0.15, Math.PI - 0.15);
      const radius = rng.between(55, 95);
      const origin = new Vector3(
        Math.cos(theta) * Math.sin(phi) * radius,
        center.y + Math.cos(phi) * radius * 0.7,
        Math.sin(theta) * Math.sin(phi) * radius,
      );
      const target = center.clone().add(
        new Vector3(rng.between(-14, 14), rng.between(-8, 8), rng.between(-14, 14)),
      );
      push(origin, target.sub(origin), `环绕位 #${i}`, 'orbit');
    }
  }

  return rays;
}

/** 复位所有物件到生成时状态（就地修改）。 */
export function resetObjects(objects: SceneObject[]): void {
  for (const obj of objects) {
    obj.position.copy(obj.initial.position);
    obj.quaternion.copy(obj.initial.quaternion);
    obj.size.copy(obj.initial.size);
  }
}

export { SPECIALS };
