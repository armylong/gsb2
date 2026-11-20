import * as THREE from 'three';

/**
 * 场景内容：5 组“前平面 + 波纹背平面”，屏幕占比恒定。
 *
 * 每组的前后两个平面在屏幕上完全重合，间距 gap = gapRatio × 距离。
 * 背平面带有正弦波纹（振幅 = 0.7 × gap），使两个表面在深度上反复交叉，
 * 从而在深度精度不足的位置出现真正的像素争抢。
 *
 * “保持参考物比例”开启时，平面尺寸、间距、屏幕位置都随距离等比缩放，
 * 屏幕上看到的大小与相对间距完全不变——这样改变 near/far 或距离时，
 * 差异只来自深度精度本身。
 */

/** 固定的相对间距（gap / 距离）。可见的 5 组。 */
export const GAP_RATIOS = [2e-5, 1e-4, 3e-4, 1e-3, 3e-3] as const;

/** 相对间距标签，用于 UI 与图例。 */
export const GAP_LABELS = ['2×10⁻⁵', '1×10⁻⁴', '3×10⁻⁴', '1×10⁻³', '3×10⁻³'];

/** 各组在 NDC 中的横向中心与半宽/半高（不随画布比例改变屏幕占比）。 */
export const TILE_LAYOUT = [
  { centerNdcX: -0.72, halfNdcX: 0.13, halfNdcY: 0.2 },
  { centerNdcX: -0.36, halfNdcX: 0.13, halfNdcY: 0.2 },
  { centerNdcX: 0, halfNdcX: 0.13, halfNdcY: 0.2 },
  { centerNdcX: 0.36, halfNdcX: 0.13, halfNdcY: 0.2 },
  { centerNdcX: 0.72, halfNdcX: 0.13, halfNdcY: 0.2 },
] as const;

/** 关闭比例锁定时采用的参考距离（世界单位）。 */
export const REFERENCE_DISTANCE = 1000;

export const FRONT_COLOR = 0xd9743f;
export const BACK_COLOR = 0x3f86d9;

export interface SceneUpdate {
  distance: number;
  /** true：尺寸/间距/位置随距离等比缩放，屏幕观感恒定 */
  keepScreenScale: boolean;
  /** 间距倍率，1 表示使用 GAP_RATIOS 原值 */
  gapScale: number;
  fovDeg: number;
  /** 画布宽高比 */
  aspect: number;
}

export interface TilePair {
  index: number;
  gapRatio: number;
  gapWorld: number;
  front: THREE.Mesh;
  back: THREE.Mesh;
}

/**
 * 背平面带一个只沿水平方向的线性深度斜坡。
 *
 * 为什么不是波纹：正弦波纹会让两个表面在几何上互相穿插（谁在前由几何决定，
 * 与深度精度无关），那样测出来的“争抢”是假象。线性斜坡保证整个平面严格位于
 * 前平面之后，但不同像素的深度差从 0 连续增长到 gap —— 当某个像素的深度差
 * 小于一个深度码点时，两个表面就会被量化到同一个深度，出现真正的、纯精度导致的争抢。
 *
 * 斜坡范围为 [-0.5, +0.5]，配合缩放让相对视差在 [0, 0.7×gap] 之间。
 */
const SLOPE_SEGMENTS = 8;
const SLOPE_AMPLITUDE = 0.5;

function createSlopeGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1, SLOPE_SEGMENTS, 1);
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    positions.setZ(i, SLOPE_AMPLITUDE * positions.getX(i));
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

export class PairScene {
  readonly scene = new THREE.Scene();
  readonly tiles: TilePair[] = [];
  private readonly frontGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly frontMaterial = new THREE.MeshBasicMaterial({
    color: FRONT_COLOR,
    toneMapped: false,
  });
  private readonly backMaterial = new THREE.MeshBasicMaterial({
    color: BACK_COLOR,
    toneMapped: false,
  });
  private lastUpdate: SceneUpdate | null = null;

  constructor() {
    this.scene.background = null;
    for (let i = 0; i < GAP_RATIOS.length; i++) {
      const front = new THREE.Mesh(this.frontGeometry, this.frontMaterial);
      const back = new THREE.Mesh(createSlopeGeometry(), this.backMaterial);
      front.frustumCulled = false;
      back.frustumCulled = false;
      front.matrixAutoUpdate = true;
      back.matrixAutoUpdate = true;
      this.scene.add(back, front);
      this.tiles.push({
        index: i,
        gapRatio: GAP_RATIOS[i],
        gapWorld: 0,
        front,
        back,
      });
    }
  }

  /** 计算某个组的屏幕参考距离：锁定比例时用当前距离，否则用参考距离。 */
  private scaleDistance(update: SceneUpdate): number {
    return update.keepScreenScale ? update.distance : REFERENCE_DISTANCE;
  }

  update(update: SceneUpdate): void {
    const halfTan = Math.tan(THREE.MathUtils.degToRad(update.fovDeg) * 0.5);
    const scaleZ = this.scaleDistance(update);
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      const layout = TILE_LAYOUT[i];
      const width = 2 * layout.halfNdcX * halfTan * update.aspect * scaleZ;
      const height = 2 * layout.halfNdcY * halfTan * scaleZ;
      const x = layout.centerNdcX * halfTan * update.aspect * update.distance;
      const gap = tile.gapRatio * update.gapScale * scaleZ;

      tile.gapWorld = gap;
      tile.front.scale.set(width, height, 1);
      tile.front.position.set(x, 0, -update.distance);
      // 斜坡在几何里覆盖 [-0.5, 0.5]，这里把它的纵深压到 gap 本身，
      // 于是深度差从最近的 gap 连续增长到最远的 2×gap：
      // 处处在后方（不存在几何穿插），但总能找到深度差接近一个码点的像素。
      const slopeDepth = Math.max(gap, 1e-12);
      tile.back.scale.set(width, height, slopeDepth);
      tile.back.position.set(x, 0, -(update.distance + gap + slopeDepth * 0.5));
    }
    this.lastUpdate = update;
  }

  get updateState(): SceneUpdate | null {
    return this.lastUpdate;
  }

  /** 只让前/后平面可见，用于分量深度读取；不传则全部可见。 */
  setVisibility(mode: 'both' | 'front' | 'back'): void {
    for (const tile of this.tiles) {
      tile.front.visible = mode !== 'back';
      tile.back.visible = mode !== 'front';
    }
  }

  /** 设定绘制顺序：先画前平面或先画背平面。 */
  setDrawOrder(order: 'front-first' | 'back-first'): void {
    const frontOrder = order === 'front-first' ? 0 : 2;
    const backOrder = order === 'front-first' ? 2 : 0;
    for (const tile of this.tiles) {
      tile.front.renderOrder = frontOrder;
      tile.back.renderOrder = backOrder;
    }
  }

  dispose(): void {
    this.frontGeometry.dispose();
    this.frontMaterial.dispose();
    this.backMaterial.dispose();
    for (const tile of this.tiles) tile.back.geometry.dispose();
  }
}

/** 某个组的 NDC 矩形，用于把分析分辨率下的像素归属到组。 */
export function tileNdcRect(index: number): { x0: number; x1: number; y0: number; y1: number } {
  const layout = TILE_LAYOUT[index];
  return {
    x0: layout.centerNdcX - layout.halfNdcX,
    x1: layout.centerNdcX + layout.halfNdcX,
    y0: -layout.halfNdcY,
    y1: layout.halfNdcY,
  };
}

/**
 * NDC → 像素矩形（原点左上）。
 *
 * insetPx：向内收缩的像素数。两个平面在屏幕上边界完全重合，最外圈像素的
 * 覆盖判定会被光栅化规则影响（边缘像素可能只归属其中一个平面），
 * 那不是深度精度造成的争抢。统计时统一收缩若干像素剔除这类假信号。
 */
export function tilePixelRect(
  index: number,
  width: number,
  height: number,
  insetPx = 0,
): { x0: number; y0: number; x1: number; y1: number } {
  const r = tileNdcRect(index);
  const x0 = Math.round(((r.x0 + 1) / 2) * width);
  const x1 = Math.round(((r.x1 + 1) / 2) * width);
  const y0 = Math.round(((1 - r.y1) / 2) * height);
  const y1 = Math.round(((1 - r.y0) / 2) * height);
  // 收缩量不能把矩形压没。
  const inset = Math.max(0, Math.min(insetPx, Math.floor((x1 - x0) / 2) - 1, Math.floor((y1 - y0) / 2) - 1));
  return { x0: x0 + inset, y0: y0 + inset, x1: x1 - inset, y1: y1 - inset };
}
