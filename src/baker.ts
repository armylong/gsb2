import { Mesh, Raycaster, Vector3 } from 'three';
import { applyLightmapUV, buildSurfaceGeometry } from './scene.js';
import type { BakedLightmap, BakeSettings, ChartRect, SurfaceDef } from './types.js';

interface BakerState {
  surfaces: SurfaceDef[];
  meshes: Mesh[];
  rectById: Map<string, ChartRect>;
}

const N8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

function createBaker(surfaces: SurfaceDef[], rects: ChartRect[]): BakerState {
  const rectById = new Map(rects.map((r) => [r.surfaceId, r]));
  const meshes = surfaces.map((s) => {
    const geometry = buildSurfaceGeometry(s);
    const rect = rectById.get(s.id);
    if (rect) applyLightmapUV(geometry, rect);
    return new Mesh(geometry);
  });
  return { surfaces, meshes, rectById };
}

/** 局部 (u,v) -> 世界坐标 */
function surfacePoint(s: SurfaceDef, u: number, v: number, out: Vector3): Vector3 {
  out.set(
    s.origin[0] + s.uAxis[0] * s.width * u + s.vAxis[0] * s.height * v,
    s.origin[1] + s.uAxis[1] * s.width * u + s.vAxis[1] * s.height * v,
    s.origin[2] + s.uAxis[2] * s.width * u + s.vAxis[2] * s.height * v,
  );
  return out;
}

const _origin = new Vector3();
const _dir = new Vector3();
const _ray = new Raycaster();

/** 从 p 朝光源发阴影射线；near=bias 避免自交 */
function isOccluded(
  state: BakerState,
  p: Vector3,
  lightPos: Vector3,
  bias: number,
  lightRadius: number,
): boolean {
  _dir.copy(lightPos).sub(p);
  const dist = _dir.length();
  if (dist <= bias) return false;
  _dir.multiplyScalar(1 / dist);
  _origin.copy(p).addScaledVector(_dir, bias);
  _ray.set(_origin, _dir);
  _ray.near = 0;
  _ray.far = Math.max(0, dist - bias - lightRadius);
  const hits = _ray.intersectObjects(state.meshes, false);
  return hits.length > 0;
}

/** 线性 -> sRGB（每个通道 0..1） */
export function linearToSRGB(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * 逐纹素烘焙固定点光源照明。
 * 模型：ambient + 未遮挡时的距离衰减点光（与 three.js PointLight 衰减公式一致）。
 */
export function bakeLightmap(
  surfaces: SurfaceDef[],
  rects: ChartRect[],
  settings: BakeSettings,
): BakedLightmap {
  const t0 = performance.now();
  const state = createBaker(surfaces, rects);
  const size = settings.atlasSize;
  const total = size * size;

  const owner: (string | null)[] = new Array(total).fill(null);
  const linear = new Float32Array(total * 3); // 未归属纹素为 NaN
  const shadowed = new Uint8Array(total); // 1 = 处于阴影
  for (let i = 0; i < total; i++) linear[i * 3] = NaN;

  const lightPos = new Vector3(...settings.light.position);
  const lc = settings.light.color;
  const attenuationCutoff = settings.light.radius;

  // ---- Pass 1：逐纹素直射照明 + 阴影 ----
  for (const surface of state.surfaces) {
    const rect = state.rectById.get(surface.id);
    if (!rect) continue;
    for (let py = 0; py < rect.h; py++) {
      const u = (py + 0.5) / rect.h;
      for (let px = 0; px < rect.w; px++) {
        const idx = (rect.y + py) * size + rect.x + px;
        owner[idx] = surface.id;
        const v = (px + 0.5) / rect.w;
        const p = surfacePoint(surface, v, u, new Vector3());

        const inShadow = isOccluded(
          state,
          p,
          lightPos,
          settings.rayBias,
          attenuationCutoff,
        );
        shadowed[idx] = inShadow ? 1 : 0;

        let r = settings.light.ambient * surface.baseColor[0];
        let g = settings.light.ambient * surface.baseColor[1];
        let b = settings.light.ambient * surface.baseColor[2];

        if (!inShadow) {
          const d = p.distanceTo(lightPos);
          // three.js 物理衰减：I / d²（radius 仅作为阴影射线的末端余量）
          const attenuation = settings.light.intensity / Math.max(d * d, 1e-4);
          r += surface.baseColor[0] * lc[0] * attenuation;
          g += surface.baseColor[1] * lc[1] * attenuation;
          b += surface.baseColor[2] * lc[2] * attenuation;
        }
        linear[idx * 3] = r;
        linear[idx * 3 + 1] = g;
        linear[idx * 3 + 2] = b;
      }
    }
  }

  // ---- Pass 2：阴影边界检测 + bias 敏感度（遮挡边缘偏差指示） ----
  const boundary = new Array<boolean>(total).fill(false);
  // peter-panning 探测：大正 bias 会让阴影侧纹素重新变亮（阴影脱离遮挡体）。
  // 射线距离 1~4 世界单位，厘米~米级 bias 才能观察到边缘收缩。
  const biasTests = [0.05, 0.15, 0.35, 0.7, 1.0];
  let boundaryCount = 0;
  let biasSensitiveCount = 0;

  for (const surface of state.surfaces) {
    const rect = state.rectById.get(surface.id);
    if (!rect) continue;
    for (let py = 0; py < rect.h; py++) {
      for (let px = 0; px < rect.w; px++) {
        const x = rect.x + px;
        const y = rect.y + py;
        const idx = y * size + x;
        if (shadowed[idx]) continue;
        let shadowNeighbor = -1;
        for (const [dx, dy] of N8) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nIdx = ny * size + nx;
          // 只统计同一 chart 内部的邻域，避免把 padding 当阴影
          if (owner[nIdx] === surface.id && shadowed[nIdx]) {
            shadowNeighbor = nIdx;
            break;
          }
        }
        if (shadowNeighbor < 0) continue;
        boundary[idx] = true;
        boundaryCount++;

        // 在「亮侧边界纹素」与「相邻阴影纹素」两个位置上探测大 bias 翻转
        const pLight = surfacePoint(surface, (px + 0.5) / rect.w, (py + 0.5) / rect.h, new Vector3());
        const sy = Math.floor(shadowNeighbor / size) - rect.y;
        const sx = (shadowNeighbor % size) - rect.x;
        const pShadow = surfacePoint(surface, (sx + 0.5) / rect.w, (sy + 0.5) / rect.h, new Vector3());
        let flips = 0;
        for (const bias of biasTests) {
          const lightSideFlips = isOccluded(state, pLight, lightPos, bias, attenuationCutoff);
          const shadowSideOpens = !isOccluded(state, pShadow, lightPos, bias, attenuationCutoff);
          if (lightSideFlips || shadowSideOpens) {
            flips++;
          }
        }
        if (flips > 0) biasSensitiveCount++;
      }
    }
  }

  // ---- Pass 3：边缘扩张（dilate）：只填充未归属纹素，按已归属邻域均值传播 ----
  const work = new Float32Array(linear); // 每轮原地扩散
  for (let pass = 0; pass < settings.dilationPasses; pass++) {
    const snapshot = new Float32Array(work);
    let changed = false;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        if (owner[idx] !== null) continue;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        for (const [dx, dy] of N8) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nIdx = ny * size + nx;
          const nr = snapshot[nIdx * 3];
          if (!Number.isNaN(nr)) {
            sr += nr;
            sg += snapshot[nIdx * 3 + 1];
            sb += snapshot[nIdx * 3 + 2];
            n++;
          }
        }
        if (n > 0) {
          work[idx * 3] = sr / n;
          work[idx * 3 + 1] = sg / n;
          work[idx * 3 + 2] = sb / n;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // ---- 输出 RGBA（sRGB） ----
  // 未被扩张覆盖的纹素分两类：padding 环带空洞（洋红，真正的接缝缺陷）
  // 与图集闲置区域（深灰，不属于任何面、永不被采样）
  const rgba = new Uint8ClampedArray(total * 4);
  let texelCount = 0;
  let remainingHoles = 0;
  const inPadding = new Uint8Array(total);
  for (const rect of rects) {
    const x0 = Math.max(0, rect.x - settings.paddingPx);
    const y0 = Math.max(0, rect.y - settings.paddingPx);
    const x1 = Math.min(size, rect.x + rect.w + settings.paddingPx);
    const y1 = Math.min(size, rect.y + rect.h + settings.paddingPx);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) inPadding[y * size + x] = 1;
    }
  }
  for (let i = 0; i < total; i++) {
    const r = work[i * 3];
    const o = i * 4;
    if (Number.isNaN(r)) {
      if (inPadding[i]) {
        // 接缝缺陷：醒目洋红
        rgba[o] = 255;
        rgba[o + 1] = 0;
        rgba[o + 2] = 255;
      } else {
        // 闲置区域：中性深灰
        rgba[o] = 32;
        rgba[o + 1] = 34;
        rgba[o + 2] = 40;
      }
      rgba[o + 3] = 255;
      remainingHoles++;
    } else {
      rgba[o] = Math.round(linearToSRGB(r) * 255);
      rgba[o + 1] = Math.round(linearToSRGB(work[i * 3 + 1]) * 255);
      rgba[o + 2] = Math.round(linearToSRGB(work[i * 3 + 2]) * 255);
      rgba[o + 3] = 255;
      if (owner[i] !== null) texelCount++;
    }
  }

  // padding 环带空洞：落在某 chart 外扩 paddingPx 范围内、却仍未填充的纹素
  let paddingHoles = 0;
  for (let i = 0; i < total; i++) {
    if (inPadding[i] && Number.isNaN(work[i * 3])) paddingHoles++;
  }

  return {
    size,
    rgba,
    owner,
    rects,
    settings,
    linear: work,
    boundary,
    stats: {
      texelCount,
      boundaryCount,
      biasSensitiveCount,
      remainingHoles,
      paddingHoles,
      bakeMs: Math.round((performance.now() - t0) * 10) / 10,
    },
  };
}
