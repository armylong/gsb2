import { Grid, MAX_HEIGHT, MAX_WIDTH } from './Grid';

export interface GeneratorOptions {
  width: number;
  height: number;
  /** 随机种子（同种子结果一致）。 */
  seed: number;
}

/** 确定性的 mulberry32 伪随机数发生器。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 程序生成实心地形：底层地基 + 两侧山壁 + 内部随机空洞，
 * 并雕刻一条带细桥的空腔和一根悬臂，保证同时具备
 * 地基、细桥、悬臂与空洞四种结构。
 * 尺寸不超过 100x60。
 */
export function generateTerrain(opts: GeneratorOptions): Grid {
  const width = Math.min(opts.width, MAX_WIDTH);
  const height = Math.min(opts.height, MAX_HEIGHT);
  if (width < 24 || height < 16) {
    throw new Error('程序生成需要至少 24x16 的地图');
  }
  const rand = mulberry32(opts.seed);
  const grid = new Grid(width, height);

  // 1. 整体填实，后续雕刻。
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.solid[y][x] = 1;
  }

  // 2. 随机空洞（椭圆），不碰最底两行地基与最外圈。
  const cavityCount = 4 + Math.floor(rand() * 4);
  for (let i = 0; i < cavityCount; i++) {
    const cx = 3 + Math.floor(rand() * (width - 6));
    const cy = 3 + Math.floor(rand() * (height - 8));
    const rx = 2 + Math.floor(rand() * 4);
    const ry = 1 + Math.floor(rand() * 3);
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (!grid.inBounds(x, y) || y >= height - 2) continue;
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) grid.solid[y][x] = 0;
      }
    }
  }

  // 3. 中央大空腔：从山体中挖出房间，只留一条 1 格高的细桥横跨两侧。
  const roomX0 = Math.floor(width * 0.28);
  const roomX1 = Math.floor(width * 0.72);
  const roomTop = Math.floor(height * 0.25);
  const roomBottom = height - 3;
  const bridgeY = Math.floor((roomTop + roomBottom) / 2);
  for (let y = roomTop; y <= roomBottom; y++) {
    for (let x = roomX0; x <= roomX1; x++) {
      if (y === bridgeY) continue; // 细桥行整体保留，连接两侧山壁
      grid.solid[y][x] = 0;
    }
  }

  // 4. 悬臂：从左侧山壁向空腔伸出一条 2 格长的悬空梁（根部与山壁正交相连）。
  const armY = roomTop + 1;
  for (let x = roomX0 - 1; x <= roomX0 + 1; x++) {
    grid.solid[armY][x] = 1;
  }

  // 5. 最底行地基强制实心。
  for (let x = 0; x < width; x++) {
    grid.solid[height - 1][x] = 1;
    grid.solid[height - 2][x] = 1;
  }

  return grid;
}
