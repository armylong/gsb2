import * as THREE from 'three';

/**
 * 角色根轨迹：记录 hips 世界位置，用线段串成拖尾。
 * 采样点仅在真实播放推进时追加；时间拖动不追加，避免重复累计。
 */
export class Trajectory {
  readonly line: THREE.Line;
  private readonly positions: number[] = [];
  private readonly geo: THREE.BufferGeometry;
  private readonly maxPoints = 2000;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxPoints * 3), 3));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.85 });
    this.line = new THREE.Line(this.geo, mat);
    this.line.frustumCulled = false;
  }

  setVisible(v: boolean): void {
    this.line.visible = v;
  }

  /** 追加一个轨迹点（世界坐标） */
  addPoint(x: number, y: number, z: number): void {
    this.positions.push(x, y, z);
    if (this.positions.length > this.maxPoints * 3) {
      this.positions.splice(0, this.positions.length - this.maxPoints * 3);
    }
    const attr = this.geo.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    arr.set(this.positions);
    attr.needsUpdate = true;
    this.geo.setDrawRange(0, this.positions.length / 3);
  }

  clear(): void {
    this.positions.length = 0;
    this.geo.setDrawRange(0, 0);
  }

  get pointCount(): number {
    return this.positions.length / 3;
  }
}
