import { createSurfaceModel, type RawSurfaceInput } from './mesh';
import type { SurfaceModel, Vec3 } from './types';
import { cross, dot, sub } from './vec';

export type ModelId = 'bowl' | 'flap';

export interface ModelPreset {
  label: string;
  modelId: ModelId;
  thickness: number;
  side: 1 | -1;
  expectValid: boolean;
  blurb: string;
}

function makeInput(
  id: string,
  name: string,
  subtitle: string,
  positions: Float32Array,
  indices: Uint32Array,
  options: {
    defaultThickness: number;
    maxThickness: number;
    notes: string[];
  },
): RawSurfaceInput {
  return {
    id,
    name,
    subtitle,
    positions,
    indices,
    concaveSide: 1,
    defaultThickness: options.defaultThickness,
    maxThickness: options.maxThickness,
    notes: options.notes,
  };
}

function triangleNormalSum(positions: Float32Array, indices: Uint32Array, t: number): Vec3 {
  const ia = indices[t];
  const ib = indices[t + 1];
  const ic = indices[t + 2];
  const a: Vec3 = [positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]];
  const b: Vec3 = [positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]];
  const c: Vec3 = [positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]];
  return cross(sub(b, a), sub(c, a));
}

function flipWinding(indices: Uint32Array): void {
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1];
    indices[t + 1] = indices[t + 2];
    indices[t + 2] = tmp;
  }
}

/**
 * 开口碗形片: 旋转抛物面, 外缘开口, 中心留一个半径 0.17 的孔。
 * z = depth * ((r / R)^2 - 1), 凹侧朝 +z。
 */
function buildBowl(): SurfaceModel {
  const radialSteps = 21;
  const angularSteps = 84;
  const innerRadius = 0.17;
  const outerRadius = 1.05;
  const depth = 0.52;

  const positions = new Float32Array((radialSteps + 1) * angularSteps * 3);
  for (let i = 0; i <= radialSteps; i++) {
    const u = i / radialSteps;
    const r = innerRadius + (outerRadius - innerRadius) * u;
    const z = depth * ((r / outerRadius) ** 2 - 1);
    for (let j = 0; j < angularSteps; j++) {
      const theta = (j / angularSteps) * Math.PI * 2;
      const index = i * angularSteps + j;
      positions[index * 3] = r * Math.cos(theta);
      positions[index * 3 + 1] = r * Math.sin(theta);
      positions[index * 3 + 2] = z;
    }
  }

  const at = (i: number, j: number): number => i * angularSteps + ((j + angularSteps) % angularSteps);
  const indices = new Uint32Array(radialSteps * angularSteps * 6);
  let write = 0;
  for (let i = 0; i < radialSteps; i++) {
    for (let j = 0; j < angularSteps; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i, j + 1);
      const d = at(i + 1, j + 1);
      indices[write++] = a;
      indices[write++] = b;
      indices[write++] = c;
      indices[write++] = b;
      indices[write++] = d;
      indices[write++] = c;
    }
  }

  // 参数化 u 沿半径增大、角向逆时针, 法线自然朝 -z; 翻一次让凹侧朝 +z
  let sumZ = 0;
  for (let t = 0; t < indices.length; t += 3) sumZ += triangleNormalSum(positions, indices, t)[2];
  if (sumZ < 0) flipWinding(indices);

  return createSurfaceModel(makeInput(
    'bowl',
    '开口碗形片',
    '旋转抛物面 · 外缘开口 + 中心孔 r=0.17',
    positions,
    indices,
    {
      defaultThickness: 0.055,
      maxThickness: 0.5,
      notes: [
        '外缘与中心孔两条边界都由侧壁封闭, 中心孔不会被填掉。',
        '碗面曲率半径远大于加厚量, 在本滑杆范围内两种方向都不会自相交, 用作"边界闭合"对照。',
        '凹角过厚的失效形态请看"凹角折片"预设。',
      ],
    },
  ));
}

/**
 * 凹角折片: 纸张绕过半径 0.16 的圆角折起 95°。
 * 平面展开时的轮廓是 L 形: 下片宽 1.35, 折起的手臂宽 0.72,
 * 在折线处形成一个内角 270° 的凹转角。
 * 向凹侧偏移时, 折角内侧的偏移半径 = 0.16 - t, t 超过 0.16 即反折穿插。
 */
function buildFlap(): SurfaceModel {
  const du = 0.03;
  const lowerColumns = 45; // u: 0 .. 1.35
  const lowerWidth = lowerColumns * du;
  const armColumns = 24; // u: 0 .. 0.72
  const armWidth = armColumns * du;

  const flatRows = 18;
  const flatLength = 0.58;
  const bendRadius = 0.16;
  const bendAngle = (95 * Math.PI) / 180;
  const bendLength = bendRadius * bendAngle;
  const armStraight = 0.86;
  const armRows = 24;
  const totalArmLength = bendLength + armStraight;

  const profile = (s: number): [number, number] => {
    if (s <= 0) return [s, 0];
    if (s <= bendLength) {
      const phi = s / bendRadius;
      return [bendRadius * Math.sin(phi), bendRadius * (1 - Math.cos(phi))];
    }
    const phi = bendAngle;
    const baseY = bendRadius * Math.sin(phi);
    const baseZ = bendRadius * (1 - Math.cos(phi));
    const extra = s - bendLength;
    return [baseY + Math.cos(phi) * extra, baseZ + Math.sin(phi) * extra];
  };

  const lowerVCount = flatRows + 1;
  const lowerVertexCount = (lowerColumns + 1) * lowerVCount;
  const armVertexCount = (armColumns + 1) * armRows;
  const positions = new Float32Array((lowerVertexCount + armVertexCount) * 3);

  const lowerIndex = (i: number, j: number): number => j * (lowerColumns + 1) + i;
  for (let j = 0; j <= flatRows; j++) {
    const s = (flatLength * j) / flatRows - flatLength;
    const [y, z] = profile(s);
    for (let i = 0; i <= lowerColumns; i++) {
      const u = (lowerWidth * i) / lowerColumns;
      const idx = lowerIndex(i, j);
      positions[idx * 3] = u;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
    }
  }

  const armStart = lowerVertexCount;
  const armIndex = (i: number, j: number): number => armStart + j * (armColumns + 1) + i;
  for (let j = 0; j < armRows; j++) {
    const s = (totalArmLength * (j + 1)) / armRows;
    const [y, z] = profile(s);
    for (let i = 0; i <= armColumns; i++) {
      const u = (armWidth * i) / armColumns;
      const idx = armIndex(i, j);
      positions[idx * 3] = u;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < flatRows; j++) {
    for (let i = 0; i < lowerColumns; i++) {
      const a = lowerIndex(i, j);
      const b = lowerIndex(i + 1, j);
      const c = lowerIndex(i, j + 1);
      const d = lowerIndex(i + 1, j + 1);
      indices.push(a, b, c, b, d, c);
    }
  }
  // 手臂从折线处接出: 第 0 行复用下片的折线行顶点 (u 0..0.72)
  for (let j = 0; j < armRows; j++) {
    for (let i = 0; i < armColumns; i++) {
      const a = j === 0 ? lowerIndex(i, flatRows) : armIndex(i, j - 1);
      const b = j === 0 ? lowerIndex(i + 1, flatRows) : armIndex(i + 1, j - 1);
      const c = armIndex(i, j);
      const d = armIndex(i + 1, j);
      indices.push(a, b, c, b, d, c);
    }
  }

  const indexArray = new Uint32Array(indices);
  // 下片中心三角形法线应朝 +z (凹侧)
  let lowerSumZ = 0;
  for (let t = 0; t < indexArray.length; t += 3) {
    const centroidY = (positions[indexArray[t] * 3 + 1] + positions[indexArray[t + 1] * 3 + 1] + positions[indexArray[t + 2] * 3 + 1]) / 3;
    if (centroidY < 0) lowerSumZ += triangleNormalSum(positions, indexArray, t)[2];
  }
  let armSumNormal = 0;
  const reference: Vec3 = [0, -Math.sin(bendAngle), Math.cos(bendAngle)];
  for (let t = 0; t < indexArray.length; t += 3) {
    const n = triangleNormalSum(positions, indexArray, t);
    armSumNormal += dot(n, reference);
  }
  const shouldFlip =
    (lowerSumZ < 0 && armSumNormal < 0) || (lowerSumZ >= 0 && armSumNormal < 0);
  if (shouldFlip) flipWinding(indexArray);

  return createSurfaceModel(makeInput(
    'flap',
    '凹角折片',
    'L 形展开面 · 95° 折角 · 圆角 r=0.16',
    positions,
    indexArray,
    {
      defaultThickness: 0.05,
      maxThickness: 0.6,
      notes: [
        '平面展开轮廓为 L 形, 折线处有内角 270° 的凹转角; 下片宽 1.35, 手臂宽 0.72。',
        '折线是半径 0.16 的圆角, 凹侧朝内。凹侧加厚超过 0.16 时偏移面在折角处反折并穿插。',
        '凸侧加厚时偏移半径变大, 要到约 0.6 手臂才会互相顶到, 可见失效对方向很敏感。',
        '厚到一定程度后, 凹转角两侧的侧壁也会翻转, 可与正常侧壁分开显示。',
      ],
    },
  ));
}

const cache = new Map<ModelId, SurfaceModel>();

export function getModel(id: ModelId): SurfaceModel {
  const cached = cache.get(id);
  if (cached) return cached;
  const model = id === 'bowl' ? buildBowl() : buildFlap();
  cache.set(id, model);
  return model;
}

export function listModels(): ModelId[] {
  return ['bowl', 'flap'];
}

export const PRESETS: ModelPreset[] = [
  {
    label: '边界闭合 · 碗形 t=0.055',
    modelId: 'bowl',
    thickness: 0.055,
    side: 1,
    expectValid: true,
    blurb: '外缘与中心孔都由侧壁接上, 实体闭合, 无自相交。',
  },
  {
    label: '薄折片 · t=0.045',
    modelId: 'flap',
    thickness: 0.045,
    side: 1,
    expectValid: true,
    blurb: '厚度小于折角圆角半径 0.16, 凹侧偏移面不穿插。',
  },
  {
    label: '凹角过厚 · t=0.42',
    modelId: 'flap',
    thickness: 0.42,
    side: 1,
    expectValid: false,
    blurb: '厚度大于圆角半径, 凹侧偏移面反折并穿过折角, 侧壁也会翻转。',
  },
];
