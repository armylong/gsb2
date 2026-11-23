import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { BakeSettings, SceneConfig, SurfaceDef } from './types.js';

/** 默认场景：墙角（地面 + 后墙 + 左墙），一个 AABB 遮挡盒，可移动点光源 */
export const DEFAULT_SCENE: SceneConfig = {
  room: { size: 4, wallHeight: 3 },
  occluder: { min: [0.6, 0, 0.8], max: [1.7, 1.2, 1.9] },
};

const WALL_COLOR: [number, number, number] = [0.72, 0.7, 0.66];
const FLOOR_COLOR: [number, number, number] = [0.62, 0.58, 0.5];
const BOX_COLOR: [number, number, number] = [0.42, 0.55, 0.62];

/**
 * 由 SceneConfig 程序化生成全部采样面。
 * 9 个面：地面、后墙、左墙 + 遮挡盒 6 面。面与面互不共面，打包后区域互不重叠。
 */
export function buildSurfaces(scene: SceneConfig): SurfaceDef[] {
  const { size, wallHeight } = scene.room;
  const [minX, minY, minZ] = scene.occluder.min;
  const [maxX, maxY, maxZ] = scene.occluder.max;
  const sx = maxX - minX;
  const sy = maxY - minY;
  const sz = maxZ - minZ;

  return [
    {
      id: 'floor',
      label: '地面',
      group: 'floor',
      origin: [0, 0, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 0, 1],
      normal: [0, 1, 0],
      width: size,
      height: size,
      baseColor: FLOOR_COLOR,
    },
    {
      id: 'wall-back',
      label: '后墙',
      group: 'wall',
      origin: [0, 0, size],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, -1],
      width: size,
      height: wallHeight,
      baseColor: WALL_COLOR,
    },
    {
      id: 'wall-left',
      label: '左墙',
      group: 'wall',
      origin: [0, 0, 0],
      uAxis: [0, 0, 1],
      vAxis: [0, 1, 0],
      normal: [1, 0, 0],
      width: size,
      height: wallHeight,
      baseColor: WALL_COLOR,
    },
    // ---- 遮挡盒 6 面 ----
    {
      id: 'box-top',
      label: '遮挡盒·顶面',
      group: 'occluder',
      origin: [minX, maxY, minZ],
      uAxis: [1, 0, 0],
      vAxis: [0, 0, 1],
      normal: [0, 1, 0],
      width: sx,
      height: sz,
      baseColor: BOX_COLOR,
    },
    {
      id: 'box-bottom',
      label: '遮挡盒·底面',
      group: 'occluder',
      origin: [minX, minY, minZ],
      uAxis: [1, 0, 0],
      vAxis: [0, 0, 1],
      normal: [0, -1, 0],
      width: sx,
      height: sz,
      baseColor: BOX_COLOR,
    },
    {
      id: 'box-front',
      label: '遮挡盒·前面 (-Z)',
      group: 'occluder',
      origin: [minX, minY, minZ],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, -1],
      width: sx,
      height: sy,
      baseColor: BOX_COLOR,
    },
    {
      id: 'box-back',
      label: '遮挡盒·后面 (+Z)',
      group: 'occluder',
      origin: [maxX, minY, maxZ],
      uAxis: [-1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, 1],
      width: sx,
      height: sy,
      baseColor: BOX_COLOR,
    },
    {
      id: 'box-right',
      label: '遮挡盒·右面 (+X)',
      group: 'occluder',
      origin: [maxX, minY, minZ],
      uAxis: [0, 0, 1],
      vAxis: [0, 1, 0],
      normal: [-1, 0, 0],
      width: sz,
      height: sy,
      baseColor: BOX_COLOR,
    },
    {
      id: 'box-left',
      label: '遮挡盒·左面 (-X)',
      group: 'occluder',
      origin: [minX, minY, maxZ],
      uAxis: [0, 0, -1],
      vAxis: [0, 1, 0],
      normal: [1, 0, 0],
      width: sz,
      height: sy,
      baseColor: BOX_COLOR,
    },
  ];
}

/** 为一个采样面构建平面 BufferGeometry（本地 uv 即 0..1 参数化） */
export function buildSurfaceGeometry(surface: SurfaceDef): BufferGeometry {
  const o = surface.origin;
  const u = surface.uAxis;
  const v = surface.vAxis;
  const p00 = [o[0], o[1], o[2]];
  const p10 = [o[0] + u[0] * surface.width, o[1] + u[1] * surface.width, o[2] + u[2] * surface.width];
  const p01 = [o[0] + v[0] * surface.height, o[1] + v[1] * surface.height, o[2] + v[2] * surface.height];
  const p11 = [
    o[0] + u[0] * surface.width + v[0] * surface.height,
    o[1] + u[1] * surface.width + v[1] * surface.height,
    o[2] + u[2] * surface.width + v[2] * surface.height,
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([...p00, ...p10, ...p01, ...p11], 3),
  );
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 按图集矩形给 geometry 写入第二套 UV（uv2，lightmap 采样用）。
 * 本地 (u,v) -> 图集 (uRect + u*wRect, vRect + v*hRect)，纹素中心采样。
 */
export function applyLightmapUV(geometry: BufferGeometry, rect: {
  uv: { u0: number; v0: number; u1: number; v1: number };
}): BufferGeometry {
  const local = [0, 0, 1, 0, 0, 1, 1, 1];
  const data = new Float32Array(8);
  for (let i = 0; i < 4; i++) {
    const u = local[i * 2];
    const v = local[i * 2 + 1];
    data[i * 2] = rect.uv.u0 + u * (rect.uv.u1 - rect.uv.u0);
    data[i * 2 + 1] = rect.uv.v0 + v * (rect.uv.v1 - rect.uv.v0);
  }
  geometry.setAttribute('uv2', new Float32BufferAttribute(data, 2));
  return geometry;
}

/** 各分辨率下的默认纹素密度（每世界单位多少纹素），密度随分辨率提高 */
export function defaultTexelsPerUnit(atlasSize: number): number {
  switch (atlasSize) {
    case 64:
      return 8;
    case 128:
      return 12;
    case 256:
      return 16;
    case 512:
      return 32;
    default:
      return 16;
  }
}

export function defaultSettings(partial?: Partial<BakeSettings>): BakeSettings {
  const base: BakeSettings = {
    atlasSize: 256,
    texelsPerUnit: defaultTexelsPerUnit(256),
    paddingPx: 4,
    dilationPasses: 8,
    rayBias: 0.002,
    light: {
      position: [2.6, 2.4, 2.6],
      color: [1, 0.96, 0.88],
      intensity: 12,
      radius: 0.12,
      ambient: 0.06,
    },
    scene: DEFAULT_SCENE,
  };
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    light: { ...base.light, ...(partial.light ?? {}) },
    scene: partial.scene ?? base.scene,
  };
}
