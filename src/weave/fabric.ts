import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  type WeaveState,
  warpCenterY,
  weftCenterY,
  mod,
  heightRange,
} from './weaveMath';

class WarpCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly state: WeaveState,
    private readonly i: number,
    private readonly x: number,
    private readonly zMin: number,
    private readonly zMax: number,
  ) {
    super();
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const z = this.zMin + t * (this.zMax - this.zMin);
    const y = warpCenterY(this.state.model, this.state.yarn, this.i, z);
    return target.set(this.x, y, z);
  }
}

class WeftCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly state: WeaveState,
    private readonly j: number,
    private readonly z: number,
    private readonly xMin: number,
    private readonly xMax: number,
  ) {
    super();
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const x = this.xMin + t * (this.xMax - this.xMin);
    const y = weftCenterY(this.state.model, this.state.yarn, this.j, x);
    return target.set(x, y, this.z);
  }
}

/** 程序生成的纤维纹理：沿管长方向的细条纹 + 微弱合股斜纹，作凹凸/粗糙度贴图 */
export function makeFiberTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, w, h);

  // 沿管长（纹理 U 方向，即水平方向）的随机纤维丝
  for (let k = 0; k < 900; k++) {
    const y = Math.random() * h;
    const x = Math.random() * w;
    const len = 20 + Math.random() * 90;
    const shade = 90 + Math.floor(Math.random() * 90);
    ctx.strokeStyle = `rgba(${shade},${shade},${shade},${0.25 + Math.random() * 0.35})`;
    ctx.lineWidth = Math.random() < 0.85 ? 1 : 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (Math.random() - 0.5) * 1.6);
    ctx.stroke();
  }
  // 合股斜纹（两组方向，很淡）
  ctx.lineWidth = 1;
  for (let x = -h; x < w; x += 14) {
    ctx.strokeStyle = 'rgba(160,160,160,0.35)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + h, h);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(96,96,96,0.3)';
    ctx.beginPath();
    ctx.moveTo(x + 7, h);
    ctx.lineTo(x + h + 7, 0);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export interface FabricLayout {
  nW: number;
  nF: number;
  /** 全局线号 g 与世界坐标的换算：worldX = g * sw - cx */
  cx: number;
  cz: number;
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
}

export function computeLayout(state: WeaveState): FabricLayout {
  const { model, yarn, repsX, repsZ } = state;
  const nW = model.sizeW * repsX;
  const nF = model.sizeF * repsZ;
  const cx = ((nW - 1) * yarn.warp.spacing) / 2;
  const cz = ((nF - 1) * yarn.weft.spacing) / 2;
  return {
    nW,
    nF,
    cx,
    cz,
    xMin: -cx - yarn.warp.spacing * 0.5,
    xMax: nW * yarn.warp.spacing - cx - yarn.warp.spacing * 0.5,
    zMin: -cz - yarn.weft.spacing * 0.5,
    zMax: nF * yarn.weft.spacing - cz - yarn.weft.spacing * 0.5,
  };
}

function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * 构建整块布的几何：每根物理线是一条完整的 TubeGeometry，
 * 跨多少个循环都不断开 —— 长浮线、循环接缝处的连续性由几何本身保证。
 */
export function buildFabricGeometry(state: WeaveState): THREE.BufferGeometry {
  const { model, yarn } = state;
  const layout = computeLayout(state);
  const geos: THREE.BufferGeometry[] = [];
  const radialSegments = 10;
  const samplesPerCell = 8;

  const pushTube = (
    curve: THREE.Curve<THREE.Vector3>,
    length: number,
    cellSize: number,
    radius: number,
    hex: string,
    variationSeed: number,
  ) => {
    const tubularSegments = Math.max(16, Math.ceil((length / cellSize) * samplesPerCell));
    const geo = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);

    // UV 的 U 轴沿管长，缩放到「每个交叉间距一次纹理重复」
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const repeats = length / cellSize;
    for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * repeats);

    // 顶点色：调色板颜色 × 每根线的确定性轻微明暗差异
    const base = new THREE.Color(hex);
    const variation = 0.94 + hash01(variationSeed) * 0.12;
    const colors = new Float32Array(geo.getAttribute('position').count * 3);
    for (let k = 0; k < colors.length; k += 3) {
      colors[k] = base.r * variation;
      colors[k + 1] = base.g * variation;
      colors[k + 2] = base.b * variation;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geos.push(geo);
  };

  // 经线：全局线号 0..nW-1，颜色按循环内线号取（接缝绝不变色）
  for (let g = 0; g < layout.nW; g++) {
    const i = mod(g, model.sizeW);
    const x = g * yarn.warp.spacing - layout.cx;
    const length = layout.zMax - layout.zMin;
    const curve = new WarpCurve(state, g, x, layout.zMin, layout.zMax);
    const hex = yarn.warp.colors[mod(i, yarn.warp.colors.length)];
    pushTube(curve, length, yarn.weft.spacing, yarn.warp.radius, hex, g + 1);
  }

  // 纬线
  for (let h = 0; h < layout.nF; h++) {
    const j = mod(h, model.sizeF);
    const z = h * yarn.weft.spacing - layout.cz;
    const length = layout.xMax - layout.xMin;
    const curve = new WeftCurve(state, h, z, layout.xMin, layout.xMax);
    const hex = yarn.weft.colors[mod(j, yarn.weft.colors.length)];
    pushTube(curve, length, yarn.warp.spacing, yarn.weft.radius, hex, 1000 + h);
  }

  const merged = mergeGeometries(geos, false)!;
  merged.computeBoundingSphere();
  geos.forEach((g) => g.dispose());
  return merged;
}

/** 循环边界线框：每个重复单元一个矩形，用于肉眼核对接缝两侧的穿插/颜色 */
export function buildTileBounds(state: WeaveState): THREE.LineSegments {
  const { model, yarn, repsX, repsZ } = state;
  const layout = computeLayout(state);
  const y = heightRange(yarn).max + 0.03;
  const positions: number[] = [];
  const tx = model.sizeW * yarn.warp.spacing;
  const tz = model.sizeF * yarn.weft.spacing;

  const addRect = (x0: number, x1: number, z0: number, z1: number) => {
    positions.push(x0, y, z0, x1, y, z0);
    positions.push(x1, y, z0, x1, y, z1);
    positions.push(x1, y, z1, x0, y, z1);
    positions.push(x0, y, z1, x0, y, z0);
  };

  for (let rx = 0; rx < repsX; rx++) {
    for (let rz = 0; rz < repsZ; rz++) {
      const u0 = rx * tx - yarn.warp.spacing * 0.5 - layout.cx;
      const u1 = (rx + 1) * tx - yarn.warp.spacing * 0.5 - layout.cx;
      const v0 = rz * tz - yarn.weft.spacing * 0.5 - layout.cz;
      const v1 = (rz + 1) * tz - yarn.weft.spacing * 0.5 - layout.cz;
      addRect(u0, u1, v0, v1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x35e0d0, transparent: true, opacity: 0.7 });
  return new THREE.LineSegments(geo, mat);
}
