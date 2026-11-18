import { VoxelWorld } from './VoxelWorld.js';

export const DEFAULT_SIZE = Object.freeze([24, 16, 24]);
export const DEFAULT_CHUNK_SIZE = 6;

/**
 * 生成固定尺寸的初始样例。
 *
 * 场景刻意包含：
 * - 2..5 层高的起伏地形（会形成 1 格台阶，便于观察台阶侧面）；
 * - 水塘：水面与沙岸、地形直接相接，且跨越 x=6、z=6 的块边界；
 * - 玻璃箱：x 范围 10..14 跨越 x=12 块边界，z 范围 4..8 跨越 z=6 块边界；
 * - 树：树冠跨越 x=18 块边界。
 *
 * 全部由确定性函数生成，不使用随机数，保证“恢复样例”每次完全一致。
 */
export function createSampleWorld() {
  const world = new VoxelWorld({
    size: DEFAULT_SIZE,
    chunkSize: DEFAULT_CHUNK_SIZE,
  });
  fillSample(world);
  return world;
}

export function fillSample(world) {
  world.clear();
  const { sizeX, sizeY, sizeZ } = world;

  // 1. 基础地形：表层草地，下面泥土，再下面石头。
  for (let z = 0; z < sizeZ; z += 1) {
    for (let x = 0; x < sizeX; x += 1) {
      const height = terrainHeight(x, z);
      for (let y = 0; y < height && y < sizeY; y += 1) {
        let material = 'stone';
        if (y === height - 1) material = 'grass';
        else if (y >= height - 3) material = 'dirt';
        world.set(x, y, z, material);
      }
    }
  }

  // 2. 水塘：挖到水位 2，四周用沙子围边。
  //    范围跨越块边界（块大小 6，边界在 x=6 / z=6）。
  const pond = { minX: 2, maxX: 8, minZ: 2, maxZ: 8, level: 2 };
  for (let z = pond.minZ; z <= pond.maxZ; z += 1) {
    for (let x = pond.minX; x <= pond.maxX; x += 1) {
      const onRim =
        x === pond.minX ||
        x === pond.maxX ||
        z === pond.minZ ||
        z === pond.maxZ;
      // 先清空水位以上，形成池塘。
      for (let y = pond.level + 1; y < sizeY; y += 1) {
        if (world.hasBlock(x, y, z)) world.set(x, y, z, null);
      }
      for (let y = 0; y <= pond.level; y += 1) {
        // 池底保留泥土/石头，池壁铺沙，中间灌水。
        if (y === pond.level) {
          world.set(x, y, z, onRim ? 'sand' : 'water');
        } else if (onRim) {
          world.set(x, y, z, 'sand');
        }
      }
    }
  }

  // 3. 玻璃箱：建在一块平整地基上，避免嵌入坡面造成难以判读的共面。
  const glassFootprint = { minX: 10, maxX: 14, minZ: 4, maxZ: 8 };
  const padY = flattenPad(world, glassFootprint);
  addGlassBox(world, glassFootprint, padY, 4);

  // 4. 树：树冠跨越 x=18 块边界。
  const treePad = flattenPad(world, { minX: 16, maxX: 20, minZ: 15, maxZ: 19 });
  addTree(world, 17, 17, treePad);

  world.markAllDirty();
  return world;
}

/**
 * 把一块矩形区域整平到该区域最高地形高度，返回地表上方第一层的 y。
 * 高出目标高度的地形会被削平，低处会补土，保证结构稳定落地。
 */
function flattenPad(world, { minX, maxX, minZ, maxZ }) {
  let target = 0;
  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      target = Math.max(target, terrainHeight(x, z));
    }
  }
  target = Math.min(target, world.sizeY - 6);

  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const current = topSolidY(world, x, z);
      for (let y = target; y < world.sizeY; y += 1) {
        if (world.hasBlock(x, y, z)) world.set(x, y, z, null);
      }
      if (current < target) {
        for (let y = current; y < target; y += 1) {
          world.set(x, y, z, y === target - 1 ? 'grass' : 'dirt');
        }
      } else {
        // 削平后重新铺一层草地。
        world.set(x, target - 1, z, 'grass');
      }
    }
  }
  return target;
}

function topSolidY(world, x, z) {
  for (let y = world.sizeY - 1; y >= 0; y -= 1) {
    if (world.hasBlock(x, y, z)) return y + 1;
  }
  return 0;
}

/** 玻璃箱的外壳；底面与地面之间留出可见缝隙，方便检查透明交界面。 */
function addGlassBox(world, { minX, maxX, minZ, maxZ }, baseY, height) {
  for (let y = baseY; y < baseY + height; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const onShell =
          x === minX ||
          x === maxX ||
          z === minZ ||
          z === maxZ ||
          y === baseY ||
          y === baseY + height - 1;
        if (!onShell) continue;
        world.set(x, y, z, 'glass');
      }
    }
  }
}

function addTree(world, x, z, groundY) {
  const trunkTop = Math.min(groundY + 4, world.sizeY - 3);
  for (let y = groundY; y <= trunkTop; y += 1) {
    world.set(x, y, z, 'wood');
  }

  const crownY = trunkTop;
  for (let dy = -1; dy <= 2; dy += 1) {
    const radius = dy === 2 ? 1 : 2;
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
        const nx = x + dx;
        const ny = crownY + dy;
        const nz = z + dz;
        if (!world.inBounds(nx, ny, nz)) continue;
        if (world.hasBlock(nx, ny, nz)) continue;
        world.set(nx, ny, nz, 'leaves');
      }
    }
  }
}

/** 确定性高度场；低频起伏形成连贯的台地边缘，避免大量单格针状侧面。 */
export function terrainHeight(x, z) {
  const wave = Math.sin(x * 0.2) * 0.9 + Math.cos(z * 0.17) * 0.8;
  return Math.max(2, Math.min(5, Math.round(3.2 + wave)));
}
