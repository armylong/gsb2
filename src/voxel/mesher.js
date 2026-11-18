import { MATERIALS, isTransparent } from './materials.js';

const AIR = null;

/**
 * 六个方向的面定义。
 * 每个面的 4 个角点按逆时针（从面外侧看）排列，
 * 并用 (0,1,2)、(0,2,3) 切成两个三角形，保证法线朝外。
 */
export const FACE_DIRECTIONS = Object.freeze([
  {
    name: '+x',
    normal: [1, 0, 0],
    neighbor: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
    shade: 0.78,
  },
  {
    name: '-x',
    normal: [-1, 0, 0],
    neighbor: [-1, 0, 0],
    corners: [
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 0],
    ],
    shade: 0.64,
  },
  {
    name: '+y',
    normal: [0, 1, 0],
    neighbor: [0, 1, 0],
    corners: [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
    shade: 1,
  },
  {
    name: '-y',
    normal: [0, -1, 0],
    neighbor: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    shade: 0.5,
  },
  {
    name: '+z',
    normal: [0, 0, 1],
    neighbor: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    shade: 0.88,
  },
  {
    name: '-z',
    normal: [0, 0, -1],
    neighbor: [0, 0, -1],
    corners: [
      [1, 0, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    shade: 0.7,
  },
]);

/**
 * 判断 `current` 方块朝向 `neighbor` 的面是否需要绘制。
 *
 * 规则：
 * - 邻居是空气/世界外：要画。
 * - 邻居是不透明方块：不画（相邻实心方块之间没有内部面）。
 * - 当前不透明、邻居透明：要画（透过玻璃能看见实心表面）。
 * - 当前透明、邻居不透明：不画（该面贴着实心块，且实心侧面已绘制，避免共面闪面）。
 * - 两个透明方块相邻：不画（避免透明块内部的共面重叠）。
 */
export function isFaceVisible(currentMaterial, neighborMaterial) {
  if (neighborMaterial === AIR || neighborMaterial === undefined) return true;
  const currentIsTransparent = isTransparent(currentMaterial);
  const neighborIsTransparent = isTransparent(neighborMaterial);

  if (!currentIsTransparent) return neighborIsTransparent;
  return false;
}

/**
 * 收集指定块内所有可见面。
 *
 * 关键点：邻居通过世界坐标查询，而不是仅在块内数组里查，
 * 因此跨块边界的面也能得到正确判定；块边缘不会缺面。
 */
export function collectChunkFaces(world, chunk) {
  const opaque = [];
  const transparent = [];

  for (let y = chunk.minY; y < chunk.maxY; y += 1) {
    for (let z = chunk.minZ; z < chunk.maxZ; z += 1) {
      for (let x = chunk.minX; x < chunk.maxX; x += 1) {
        const material = world.get(x, y, z);
        if (material === AIR) continue;
        const list = isTransparent(material) ? transparent : opaque;

        for (const direction of FACE_DIRECTIONS) {
          const [nx, ny, nz] = direction.neighbor;
          const neighbor = world.get(x + nx, y + ny, z + nz);
          if (!isFaceVisible(material, neighbor)) continue;
          list.push({
            x,
            y,
            z,
            material,
            direction: direction.name,
            normal: direction.normal,
            shade: direction.shade,
            corners: direction.corners,
          });
        }
      }
    }
  }

  return { opaque, transparent };
}

/** 收集整个世界的可见面；用于校验分块结果与全局结果一致。 */
export function collectWorldFaces(world) {
  const opaque = [];
  const transparent = [];
  for (let y = 0; y < world.sizeY; y += 1) {
    for (let z = 0; z < world.sizeZ; z += 1) {
      for (let x = 0; x < world.sizeX; x += 1) {
        const material = world.get(x, y, z);
        if (material === AIR) continue;
        const target = isTransparent(material) ? transparent : opaque;
        for (const direction of FACE_DIRECTIONS) {
          const [nx, ny, nz] = direction.neighbor;
          if (!isFaceVisible(material, world.get(x + nx, y + ny, z + nz))) continue;
          target.push({
            x,
            y,
            z,
            material,
            direction: direction.name,
            normal: direction.normal,
            shade: direction.shade,
            corners: direction.corners,
          });
        }
      }
    }
  }
  return { opaque, transparent };
}

/** 面的稳定标识：位置 + 朝向 + 材质。 */
export function faceKey(face) {
  return `${face.x},${face.y},${face.z}:${face.direction}:${face.material}`;
}

/**
 * 检查“逐块生成”与“整世界生成”的可见面集合是否严格一致。
 *
 * 这是针对跨块缺面、重复面、旧面残留的运行时自检：
 * - missing：整世界有、分块没有（缺面）
 * - extra：分块有、整世界没有（残留/多余面）
 * - duplicated：同一面在分块结果中出现多次
 */
export function verifyChunkConsistency(world) {
  const global = collectWorldFaces(world);
  const globalFaces = [...global.opaque, ...global.transparent];

  const expected = new Map();
  for (const face of globalFaces) {
    const key = faceKey(face);
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }

  const counts = new Map();
  let chunkedTotal = 0;
  for (const chunk of world.chunks) {
    const faces = collectChunkFaces(world, chunk);
    for (const face of [...faces.opaque, ...faces.transparent]) {
      chunkedTotal += 1;
      const key = faceKey(face);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const missing = [];
  const extra = [];
  const duplicated = [];

  for (const [key, count] of expected) {
    const actual = counts.get(key) ?? 0;
    if (actual < count) missing.push(key);
    else if (actual > count) duplicated.push(key);
  }
  for (const key of counts.keys()) {
    if (!expected.has(key)) extra.push(key);
  }

  return {
    ok:
      missing.length === 0 &&
      extra.length === 0 &&
      duplicated.length === 0 &&
      globalFaces.length === chunkedTotal,
    globalCount: globalFaces.length,
    chunkedCount: chunkedTotal,
    missing,
    extra,
    duplicated,
  };
}

/** sRGB 十六进制转线性 RGB，保证顶点色在渲染时亮度正确。 */
export function srgbHexToLinearRgb(hex) {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

function srgbToLinear(channel) {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * 把面列表打包为可直接上传的 BufferGeometry 数据。
 * 每个面 4 个顶点、6 个索引；顶点色已含朝向明暗，透明面单独成组。
 */
export function buildGeometryData(faces) {
  const vertexCount = faces.length * 4;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(faces.length * 6);

  const colorCache = new Map();

  let vertexOffset = 0;
  let indexOffset = 0;

  for (const face of faces) {
    let linear = colorCache.get(face.material);
    if (!linear) {
      linear = srgbHexToLinearRgb(MATERIALS[face.material].color);
      colorCache.set(face.material, linear);
    }

    const [nx, ny, nz] = face.normal;
    const shade = face.shade;

    for (let i = 0; i < 4; i += 1) {
      const corner = face.corners[i];
      const p = (vertexOffset + i) * 3;
      positions[p] = face.x + corner[0];
      positions[p + 1] = face.y + corner[1];
      positions[p + 2] = face.z + corner[2];

      normals[p] = nx;
      normals[p + 1] = ny;
      normals[p + 2] = nz;

      colors[p] = linear[0] * shade;
      colors[p + 1] = linear[1] * shade;
      colors[p + 2] = linear[2] * shade;

      const uv = (vertexOffset + i) * 2;
      uvs[uv] = i === 1 || i === 2 ? 1 : 0;
      uvs[uv + 1] = i >= 2 ? 1 : 0;
    }

    const base = vertexOffset;
    indices[indexOffset] = base;
    indices[indexOffset + 1] = base + 1;
    indices[indexOffset + 2] = base + 2;
    indices[indexOffset + 3] = base;
    indices[indexOffset + 4] = base + 2;
    indices[indexOffset + 5] = base + 3;

    vertexOffset += 4;
    indexOffset += 6;
  }

  return { positions, normals, colors, uvs, indices, faceCount: faces.length };
}

/** 生成单个块的渲染数据（不依赖 three.js，便于测试）。 */
export function buildChunkGeometryData(world, chunk) {
  const faces = collectChunkFaces(world, chunk);

  // 透明面按材质拆分，渲染时每种材质用自己的 opacity，避免水把玻璃染成同色。
  const groups = new Map();
  for (const face of faces.transparent) {
    let list = groups.get(face.material);
    if (!list) {
      list = [];
      groups.set(face.material, list);
    }
    list.push(face);
  }

  const transparent = [];
  for (const [material, list] of groups) {
    transparent.push({ material, data: buildGeometryData(list) });
  }

  return {
    faces,
    opaque: buildGeometryData(faces.opaque),
    transparent,
    faceCount:
      faces.opaque.length + faces.transparent.length,
  };
}
