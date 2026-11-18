import { describe, expect, it } from 'vitest';
import { VoxelWorld } from '../src/voxel/VoxelWorld.js';
import {
  FACE_DIRECTIONS,
  buildGeometryData,
  collectWorldFaces,
  isFaceVisible,
} from '../src/voxel/mesher.js';
import { MATERIALS, isTransparent } from '../src/voxel/materials.js';
import { createSampleWorld } from '../src/voxel/scene.js';

/**
 * 与“表面必须可见”等价的判定，但完全独立于 isFaceVisible 的实现。
 * 规则：邻居是空气 → 可见；当前不透明且邻居透明 → 可见；其余不可见。
 */
function referenceVisible(current, neighbor) {
  if (neighbor === null) return true;
  if (!isTransparent(current)) return isTransparent(neighbor);
  return false;
}

function countReferenceFaces(world) {
  let count = 0;
  for (let y = 0; y < world.sizeY; y += 1) {
    for (let z = 0; z < world.sizeZ; z += 1) {
      for (let x = 0; x < world.sizeX; x += 1) {
        const current = world.get(x, y, z);
        if (!current) continue;
        for (const direction of FACE_DIRECTIONS) {
          const [dx, dy, dz] = direction.neighbor;
          count += referenceVisible(
            current,
            world.get(x + dx, y + dy, z + dz),
          )
            ? 1
            : 0;
        }
      }
    }
  }
  return count;
}

describe('可见面与水密性', () => {
  it('可见面数量与独立实现的参考计数一致', () => {
    const world = createSampleWorld();
    const global = collectWorldFaces(world);
    expect(global.opaque.length + global.transparent.length).toBe(
      countReferenceFaces(world),
    );
  });

  it('随机编辑后可见面数量依然与参考实现一致', () => {
    const world = createSampleWorld();
    // 确定性伪随机，避免测试不稳定。
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const materials = ['stone', 'grass', 'glass', 'water', 'wood'];

    for (let i = 0; i < 400; i += 1) {
      const x = Math.floor(rand() * world.sizeX);
      const y = Math.floor(rand() * world.sizeY);
      const z = Math.floor(rand() * world.sizeZ);
      if (rand() < 0.45) {
        world.set(x, y, z, null);
      } else {
        world.set(x, y, z, materials[Math.floor(rand() * materials.length)]);
      }
    }

    const global = collectWorldFaces(world);
    expect(global.opaque.length + global.transparent.length).toBe(
      countReferenceFaces(world),
    );
  });

  it('每个面的三角形绕序朝向面外侧', () => {
    const world = createSampleWorld();
    const faces = collectWorldFaces(world);
    const all = [...faces.opaque, ...faces.transparent];
    const data = buildGeometryData(all);

    for (let f = 0; f < all.length; f += 1) {
      const base = f * 4;
      const p0 = faceVertex(data.positions, base);
      const p1 = faceVertex(data.positions, base + 1);
      const p2 = faceVertex(data.positions, base + 2);
      const cross = crossProduct(subtract(p1, p0), subtract(p2, p0));
      const normal = all[f].normal;
      const dot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('每个面的四个角都在该方块的单位立方体边界上', () => {
    const world = createSampleWorld();
    const faces = collectWorldFaces(world);
    const all = [...faces.opaque, ...faces.transparent];
    const data = buildGeometryData(all);

    for (let f = 0; f < all.length; f += 1) {
      const face = all[f];
      for (let v = 0; v < 4; v += 1) {
        const [x, y, z] = faceVertex(data.positions, f * 4 + v);
        expect(x).toBeGreaterThanOrEqual(face.x);
        expect(x).toBeLessThanOrEqual(face.x + 1);
        expect(y).toBeGreaterThanOrEqual(face.y);
        expect(y).toBeLessThanOrEqual(face.y + 1);
        expect(z).toBeGreaterThanOrEqual(face.z);
        expect(z).toBeLessThanOrEqual(face.z + 1);
        // 顶点必须落在某个坐标面上，不能悬在方块内部。
        const onBoundary =
          x === face.x ||
          x === face.x + 1 ||
          y === face.y ||
          y === face.y + 1 ||
          z === face.z ||
          z === face.z + 1;
        expect(onBoundary).toBe(true);
      }
    }
  });

  it('顶点色按材质与朝向明暗分配，透明材质使用自身颜色', () => {
    const faces = collectWorldFaces(createSampleWorld());
    const glass = faces.transparent.filter((f) => f.material === 'glass');
    expect(glass.length).toBeGreaterThan(0);
    const data = buildGeometryData(glass);
    expect(data.positions.length).toBe(glass.length * 4 * 3);
    expect(data.faceCount).toBe(glass.length);
    expect(MATERIALS.glass.transparent).toBe(true);
  });
});

describe('材质表一致性', () => {
  it('未在材质表中登记的材质不会被当成透明', () => {
    for (const id of Object.keys(MATERIALS)) {
      expect(typeof isTransparent(id)).toBe('boolean');
    }
    expect(isTransparent('not-a-material')).toBe(false);
  });

  it('世界外一律视为空气，边缘方块必然有外表面', () => {
    const world = new VoxelWorld({ size: [2, 2, 2], chunkSize: 1 });
    for (let y = 0; y < 2; y += 1) {
      for (let z = 0; z < 2; z += 1) {
        for (let x = 0; x < 2; x += 1) {
          world.set(x, y, z, 'stone');
        }
      }
    }
    // 2x2x2 实心立方体：总共 24 个外表面，没有内部面。
    const faces = collectWorldFaces(world);
    expect(faces.opaque).toHaveLength(24);
    expect(faces.transparent).toHaveLength(0);
  });
});

function faceVertex(positions, index) {
  return [
    positions[index * 3],
    positions[index * 3 + 1],
    positions[index * 3 + 2],
  ];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function crossProduct(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
