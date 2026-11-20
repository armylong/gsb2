/**
 * 顶点权重热力图:每个顶点一个点,颜色按"当前选中骨骼"的权重映射。
 * 色带:蓝(0) -> 青 -> 绿 -> 黄 -> 红(1)。
 * 点位由 CPU 蒙皮结果每帧更新,与变形网格重合。
 */

import * as THREE from 'three';
import { BONE_COUNT, WeightModel } from '../weights/WeightModel';

const STOPS: Array<[number, THREE.Color]> = [
  [0.0, new THREE.Color(0x2b3a9e)],
  [0.25, new THREE.Color(0x16a6c9)],
  [0.5, new THREE.Color(0x35c24b)],
  [0.75, new THREE.Color(0xe8c820)],
  [1.0, new THREE.Color(0xd9342b)],
];

const _color = new THREE.Color();

export function rampColor(t: number, out: THREE.Color): THREE.Color {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i];
    const [t1, c1] = STOPS[i + 1];
    if (x >= t0 && x <= t1) {
      const k = (x - t0) / (t1 - t0);
      return out.copy(c0).lerp(c1, k);
    }
  }
  return out.copy(STOPS[STOPS.length - 1][1]);
}

export class Heatmap {
  readonly points: THREE.Points;
  private readonly colors: Float32Array;
  private readonly vertexCount: number;

  constructor(vertexCount: number) {
    this.vertexCount = vertexCount;
    const positions = new Float32Array(vertexCount * 3);
    this.colors = new Float32Array(vertexCount * 3);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.11,
      vertexColors: true,
      sizeAttenuation: true,
      depthTest: true,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = true;
  }

  /** 按选中骨骼的权重重算颜色 */
  updateColors(model: WeightModel, selectedBone: number): void {
    for (let v = 0; v < this.vertexCount; v++) {
      const w = model.get(v, selectedBone);
      rampColor(w, _color);
      this.colors[v * 3 + 0] = _color.r;
      this.colors[v * 3 + 1] = _color.g;
      this.colors[v * 3 + 2] = _color.b;
    }
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** 每帧用 CPU 蒙皮结果更新点位 */
  updatePositions(worldPositions: Float32Array): void {
    const attr = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    (attr.array as Float32Array).set(worldPositions);
    attr.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.points.visible = visible;
  }

  get visible(): boolean {
    return this.points.visible;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

export const BONE_COLORS: THREE.Color[] = [
  new THREE.Color(0xe74c3c),
  new THREE.Color(0x2ecc71),
  new THREE.Color(0x3498db),
];

export function boneName(b: number): string {
  if (b < 0 || b >= BONE_COUNT) return '未知骨骼';
  return `骨骼 ${b}（${['根部', '肘部', '尾部'][b]}）`;
}
