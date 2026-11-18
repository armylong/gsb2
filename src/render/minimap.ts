import * as THREE from 'three';
import type { AABB } from '../math/aabb';
import type { Vec3 } from '../math/vector';
import type { Waypoint } from '../math/levels';

/**
 * 俯视辅助图：独立正交相机 + 独立场景，避免与主场景相互影响。
 * 标注：障碍俯视轮廓、角色观察点、期望相机（空心菱形）、实际相机（实心圆）、
 * 碰撞范围（虚线圆）、检查路线航点与连线。
 */
export class Minimap {
  readonly camera: THREE.OrthographicCamera;
  readonly scene = new THREE.Scene();
  private markers = new THREE.Group();
  private viewHeight = 26;
  private collisionCircle: THREE.LineLoop;
  private desiredMarker: THREE.Mesh;
  private actualMarker: THREE.Mesh;
  private pivotMarker: THREE.Mesh;

  constructor() {
    this.scene.background = new THREE.Color(0x11161d);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    this.camera.position.set(0, 100, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);

    const amb = new THREE.AmbientLight(0xffffff, 1.2);
    this.scene.add(amb);
    this.scene.add(this.markers);

    this.pivotMarker = this.makeDisc(0.28, 0xffd166);
    this.desiredMarker = this.makeDiamond(0.4, 0x4cc9f0);
    this.actualMarker = this.makeDisc(0.32, 0xef476f);
    this.collisionCircle = this.makeCircle(1, 0xef476f);
    this.markers.add(this.pivotMarker, this.desiredMarker, this.actualMarker, this.collisionCircle);
  }

  private makeDisc(r: number, color: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(r, 24),
      new THREE.MeshBasicMaterial({ color }),
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  private makeDiamond(s: number, color: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(s, s),
      new THREE.MeshBasicMaterial({ color, wireframe: true, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.PI / 4;
    return m;
  }

  private makeCircle(r: number, color: number): THREE.LineLoop {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  }

  /** 重建静态内容（障碍 + 航点），切换预设时调用 */
  setLevel(boxes: AABB[], waypoints: Waypoint[]): void {
    // 清除除动态 marker 外的所有对象
    for (let i = this.markers.children.length - 1; i >= 0; i--) {
      const c = this.markers.children[i];
      if (c === this.pivotMarker || c === this.desiredMarker ||
          c === this.actualMarker || c === this.collisionCircle) continue;
      this.markers.remove(c);
    }
    this.scene.children
      .filter((c) => c.type === 'Mesh' || c.type === 'LineSegments')
      .forEach((c) => this.scene.remove(c));

    for (const box of boxes) {
      if (box.name === '地面') continue;
      const w = box.max.x - box.min.x;
      const d = box.max.z - box.min.z;
      const color = box.isCeiling ? 0xb08968 : 0x8fa3b8;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: box.isCeiling ? 0.45 : 0.8,
          side: THREE.DoubleSide,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(
        (box.min.x + box.max.x) / 2,
        box.isCeiling ? 0.02 : 0.03,
        (box.min.z + box.max.z) / 2,
      );
      this.scene.add(mesh);
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: 0xdde3ea }),
      );
      edge.position.copy(mesh.position);
      edge.rotation.copy(mesh.rotation);
      this.scene.add(edge);
    }

    // 航点连线 + 编号点
    const linePts = waypoints.map((w) => new THREE.Vector3(w.pos.x, 0.06, w.pos.z));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(linePts),
      new THREE.LineBasicMaterial({ color: 0x6ee7b7, transparent: true, opacity: 0.7 }),
    );
    this.scene.add(line);
    waypoints.forEach((w) => {
      const dot = this.makeDisc(0.18, 0x6ee7b7);
      dot.position.set(w.pos.x, 0.07, w.pos.z);
      this.scene.add(dot);
    });
  }

  update(
    pivot: Vec3,
    desired: Vec3,
    actual: Vec3,
    radius: number,
    aspect: number,
  ): void {
    this.pivotMarker.position.set(pivot.x, 0.1, pivot.z);
    this.desiredMarker.position.set(desired.x, 0.12, desired.z);
    this.actualMarker.position.set(actual.x, 0.13, actual.z);
    this.collisionCircle.position.set(actual.x, 0.11, actual.z);
    this.collisionCircle.scale.setScalar(radius);
    this.resize(aspect);
  }

  resize(aspect: number): void {
    this.camera.left = (-this.viewHeight * aspect) / 2;
    this.camera.right = (this.viewHeight * aspect) / 2;
    this.camera.top = this.viewHeight / 2;
    this.camera.bottom = -this.viewHeight / 2;
    this.camera.updateProjectionMatrix();
  }
}
