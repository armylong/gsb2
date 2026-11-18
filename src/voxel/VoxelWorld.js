import { MATERIAL_IDS, isKnownMaterial, isTransparent } from './materials.js';

const AIR = 0;

/** 材质 id 与 Uint8Array 中的紧凑编号互转（0 保留给空气）。 */
export const MATERIAL_CODE = new Map(MATERIAL_IDS.map((id, index) => [id, index + 1]));
export const CODE_MATERIAL = [null, ...MATERIAL_IDS];

/**
 * 固定尺寸体素世界。
 *
 * - 数据用 Uint8Array 存储，空位为 0。
 * - 每个方块落在哪个块由 chunkSize 决定；修改方块时同时标记相邻块，
 *   这是跨块边界不出现缺面/残留面的关键。
 * - 世界外一律视为空气，因此世界边缘会正常生成外表面。
 */
export class VoxelWorld {
  constructor({ size = [16, 12, 16], chunkSize = 4 } = {}) {
    if (!Array.isArray(size) || size.length !== 3) {
      throw new TypeError('size 必须是 [x, y, z]');
    }
    if (!size.every((n) => Number.isInteger(n) && n > 0)) {
      throw new TypeError('size 的三个分量必须是正整数');
    }
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new TypeError('chunkSize 必须是正整数');
    }

    this.size = [...size];
    this.sizeX = size[0];
    this.sizeY = size[1];
    this.sizeZ = size[2];
    this.chunkSize = chunkSize;
    this.cells = new Uint8Array(this.sizeX * this.sizeY * this.sizeZ);
    this.version = 0;

    this.chunks = buildChunkDescriptors(this.sizeX, this.sizeY, this.sizeZ, chunkSize);
    this.chunkByKey = new Map(this.chunks.map((chunk) => [chunk.key, chunk]));
    this.dirtyChunks = new Set(this.chunks.map((chunk) => chunk.key));
  }

  index(x, y, z) {
    return x + this.sizeX * (z + this.sizeZ * y);
  }

  inBounds(x, y, z) {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      Number.isInteger(z) &&
      x >= 0 &&
      x < this.sizeX &&
      y >= 0 &&
      y < this.sizeY &&
      z >= 0 &&
      z < this.sizeZ
    );
  }

  /** 越界返回 null（世界外即空气）。 */
  get(x, y, z) {
    if (!this.inBounds(x, y, z)) return null;
    const code = this.cells[this.index(x, y, z)];
    return code === AIR ? null : CODE_MATERIAL[code];
  }

  /** 只判断是否有方块，避免材质字符串分配。 */
  hasBlock(x, y, z) {
    return this.inBounds(x, y, z) && this.cells[this.index(x, y, z)] !== AIR;
  }

  /** 修改一个方块；材质为 null 表示删除。返回是否真的发生变化。 */
  set(x, y, z, material) {
    if (!this.inBounds(x, y, z)) {
      throw new RangeError(`坐标超出场景范围: (${x}, ${y}, ${z})`);
    }
    let code = AIR;
    if (material !== null && material !== undefined) {
      if (!isKnownMaterial(material)) {
        throw new TypeError(`未知材质: ${String(material)}`);
      }
      code = MATERIAL_CODE.get(material);
    }

    const index = this.index(x, y, z);
    if (this.cells[index] === code) return false;

    this.cells[index] = code;
    this.version += 1;
    this.markDirtyAround(x, y, z);
    return true;
  }

  /** 安全的添加：越界或已有方块时返回 false。 */
  add(x, y, z, material) {
    if (!this.inBounds(x, y, z) || this.hasBlock(x, y, z)) return false;
    return this.set(x, y, z, material);
  }

  /** 安全的删除：越界或为空时返回 false。 */
  remove(x, y, z) {
    if (!this.inBounds(x, y, z) || !this.hasBlock(x, y, z)) return false;
    return this.set(x, y, z, null);
  }

  /**
   * 标记受影响的块：自身所在块 + 相邻 6 个方块所在的块。
   * 只标记 6 邻域，因为一个方块的变化只可能影响这些块内的面。
   */
  markDirtyAround(x, y, z) {
    this.dirtyChunks.add(this.chunkKeyAt(x, y, z));
    const neighbors = [
      [x + 1, y, z],
      [x - 1, y, z],
      [x, y + 1, z],
      [x, y - 1, z],
      [x, y, z + 1],
      [x, y, z - 1],
    ];
    for (const [nx, ny, nz] of neighbors) {
      if (this.inBounds(nx, ny, nz)) {
        this.dirtyChunks.add(this.chunkKeyAt(nx, ny, nz));
      }
    }
  }

  chunkKeyAt(x, y, z) {
    return chunkKey(
      Math.floor(x / this.chunkSize),
      Math.floor(y / this.chunkSize),
      Math.floor(z / this.chunkSize),
    );
  }

  markAllDirty() {
    for (const chunk of this.chunks) this.dirtyChunks.add(chunk.key);
  }

  /** 清空全部方块，并让所有块重建。 */
  clear() {
    this.cells.fill(AIR);
    this.version += 1;
    this.markAllDirty();
    return this;
  }

  /** 取出并清空脏块列表，渲染层据此只重建必要的块。 */
  consumeDirtyChunks() {
    const dirty = [];
    for (const key of this.dirtyChunks) {
      const chunk = this.chunkByKey.get(key);
      if (chunk) dirty.push(chunk);
    }
    this.dirtyChunks.clear();
    return dirty;
  }

  /** 遍历块内的所有格子；max 为开区间。 */
  forEachCellInChunk(chunk, callback) {
    for (let y = chunk.minY; y < chunk.maxY; y += 1) {
      for (let z = chunk.minZ; z < chunk.maxZ; z += 1) {
        for (let x = chunk.minX; x < chunk.maxX; x += 1) {
          callback(x, y, z, this.get(x, y, z));
        }
      }
    }
  }

  /**
   * 从当前数据重新统计，不做增量缓存，保证批量重置/载入后统计与格子一致。
   */
  getStats() {
    const byMaterial = {};
    for (const id of MATERIAL_IDS) byMaterial[id] = 0;

    let total = 0;
    let transparent = 0;
    for (let index = 0; index < this.cells.length; index += 1) {
      const code = this.cells[index];
      if (code === AIR) continue;
      const id = CODE_MATERIAL[code];
      total += 1;
      byMaterial[id] += 1;
    }
    for (const [id, count] of Object.entries(byMaterial)) {
      if (count > 0 && isTransparentMaterialId(id)) transparent += count;
    }

    return {
      total,
      transparent,
      opaque: total - transparent,
      byMaterial,
      chunks: this.chunks.length,
      chunkSize: this.chunkSize,
    };
  }

  /** 深拷贝为可序列化快照，用于“恢复初始样例”。 */
  toSnapshot() {
    return {
      size: [...this.size],
      chunkSize: this.chunkSize,
      cells: Array.from(this.cells),
    };
  }

  loadSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.cells)) {
      throw new TypeError('快照格式不正确');
    }
    if (
      !Array.isArray(snapshot.size) ||
      snapshot.size.length !== 3 ||
      snapshot.size[0] !== this.sizeX ||
      snapshot.size[1] !== this.sizeY ||
      snapshot.size[2] !== this.sizeZ
    ) {
      throw new TypeError('快照尺寸与当前场景不一致');
    }
    if (snapshot.cells.length !== this.cells.length) {
      throw new TypeError('快照格子数量与当前场景不一致');
    }

    for (let i = 0; i < snapshot.cells.length; i += 1) {
      const code = snapshot.cells[i];
      if (!Number.isInteger(code) || code < 0 || code >= CODE_MATERIAL.length) {
        throw new TypeError(`快照包含非法材质编号: ${String(code)}`);
      }
      this.cells[i] = code;
    }

    this.version += 1;
    this.markAllDirty();
    return this;
  }
}

function isTransparentMaterialId(id) {
  return isTransparent(id);
}

function chunkKey(cx, cy, cz) {
  return `${cx},${cy},${cz}`;
}

function buildChunkDescriptors(sizeX, sizeY, sizeZ, chunkSize) {
  const chunks = [];
  const countX = Math.ceil(sizeX / chunkSize);
  const countY = Math.ceil(sizeY / chunkSize);
  const countZ = Math.ceil(sizeZ / chunkSize);

  for (let cz = 0; cz < countZ; cz += 1) {
    for (let cy = 0; cy < countY; cy += 1) {
      for (let cx = 0; cx < countX; cx += 1) {
        const minX = cx * chunkSize;
        const minY = cy * chunkSize;
        const minZ = cz * chunkSize;
        const maxX = Math.min(minX + chunkSize, sizeX);
        const maxY = Math.min(minY + chunkSize, sizeY);
        const maxZ = Math.min(minZ + chunkSize, sizeZ);
        chunks.push({
          key: chunkKey(cx, cy, cz),
          cx,
          cy,
          cz,
          minX,
          minY,
          minZ,
          maxX,
          maxY,
          maxZ,
          sizeX: maxX - minX,
          sizeY: maxY - minY,
          sizeZ: maxZ - minZ,
          center: [
            (minX + maxX) / 2,
            (minY + maxY) / 2,
            (minZ + maxZ) / 2,
          ],
        });
      }
    }
  }
  return chunks;
}
