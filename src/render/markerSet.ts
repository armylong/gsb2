/**
 * 地形标记:点选或坐标查询后放置。
 * 标记高度始终取自统一高度场 sampleHeight,与渲染层级无关,
 * 因此同一点在 LOD0/1/2 之间切换时标记不会明显升降。
 */
import * as THREE from 'three';
import { isInsideTerrain, sampleHeight } from '../terrain/heightfield';
import { HALF_TERRAIN } from '../terrain/config';

export interface QueryOutcome {
  ok: boolean;
  x: number;
  z: number;
  height: number | null;
  message: string;
}

export class MarkerSet {
  readonly group = new THREE.Group();
  private markers: THREE.Group[] = [];
  private readonly poleMaterial = new THREE.MeshBasicMaterial({ color: 0xff3b30 });

  constructor(private readonly seedAccessor: () => number) {}

  query(x: number, z: number): QueryOutcome {
    if (!isInsideTerrain(x, z)) {
      return {
        ok: false,
        x,
        z,
        height: null,
        message: `坐标 (${x.toFixed(1)}, ${z.toFixed(1)}) 位于地形范围 ±${HALF_TERRAIN} 之外,无高度数据(未误报为 0 或边界高度)`,
      };
    }
    const h = sampleHeight(x, z, this.seedAccessor());
    this.place(x, z, h);
    return {
      ok: true,
      x,
      z,
      height: h,
      message: `(${x.toFixed(1)}, ${z.toFixed(1)}) 高度=${h.toFixed(3)}(统一高度场,与 LOD 无关)`,
    };
  }

  place(x: number, z: number, h: number): void {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 10, 8), this.poleMaterial);
    pole.position.y = 5;
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffcc00 }),
    );
    ball.position.y = 10.4;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.3, 28),
      new THREE.MeshBasicMaterial({ color: 0xff3b30, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.15;
    g.add(pole, ball, ring);
    g.position.set(x, h, z);
    this.group.add(g);
    this.markers.push(g);
  }

  /** 取最近一次标记的屏幕投影信息,供 HTML 标签使用 */
  latestScreenPosition(camera: THREE.Camera, width: number, height: number): { x: number; y: number; visible: boolean } | null {
    const g = this.markers[this.markers.length - 1];
    if (!g) return null;
    const v = new THREE.Vector3(g.position.x, g.position.y + 12, g.position.z).project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * width,
      y: (-v.y * 0.5 + 0.5) * height,
      visible: v.z < 1,
    };
  }

  get latest(): THREE.Group | null {
    return this.markers[this.markers.length - 1] ?? null;
  }

  clear(): void {
    for (const g of this.markers) {
      this.group.remove(g);
      g.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material !== this.poleMaterial) o.material.dispose();
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    this.markers = [];
  }

  dispose(): void {
    this.clear();
    this.poleMaterial.dispose();
  }
}
