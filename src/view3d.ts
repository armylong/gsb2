import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Calibration } from './calibration';
import type { PlacedBox } from './types';

/**
 * 独立三维视图:显示重建的地面、已放置的盒子、
 * 标定出的相机位置与视锥,以及参考线段的地面位置。
 */
export class View3D {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private group: THREE.Group; // 随标定更新的内容

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x23242a);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
    this.camera.position.set(4.5, 3.5, 6.5);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.4, 2.5);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(4, 8, 3);
    this.scene.add(dir);

    // 静态地面网格(世界坐标)
    const grid = new THREE.GridHelper(24, 24, 0x555566, 0x3a3b44);
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(1.2);
    this.scene.add(axes);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    const resize = () => {
      const parent = canvas.parentElement!;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      this.renderer.setSize(w, h, false);
      this.renderer.setPixelRatio(window.devicePixelRatio);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(canvas.parentElement!);
    resize();

    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  update(
    cal: Calibration | null,
    boxes: PlacedBox[],
    imgW: number,
    imgH: number,
    refGround: { a: { x: number; z: number }; b: { x: number; z: number } } | null,
  ) {
    // 清空旧内容
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.group.clear();

    // 盒子
    for (const b of boxes) {
      const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
      const mat = new THREE.MeshLambertMaterial({
        color: 0xb04cb0, transparent: true, opacity: 0.85,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(b.gx, b.h / 2, b.gz);
      this.group.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0xff8cff }),
      );
      edges.position.copy(mesh.position);
      this.group.add(edges);
    }

    // 参考线段的地面位置
    if (refGround) {
      const pts = [
        new THREE.Vector3(refGround.a.x, 0.01, refGround.a.z),
        new THREE.Vector3(refGround.b.x, 0.01, refGround.b.z),
      ];
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x5cc45c }),
      );
      this.group.add(line);
    }

    // 标定相机:位置 (0,h,0),朝向由 R 给出,画出图像视锥
    if (cal) {
      const h = cal.cameraHeight;
      const C = new THREE.Vector3(0, h, 0);
      const R = cal.R;
      // 世界方向 = R^T * (dx, dy, f)
      const rayWorld = (dx: number, dy: number): THREE.Vector3 => {
        const rx = dx, ry = dy, rz = cal.focal;
        return new THREE.Vector3(
          R[0][0] * rx + R[1][0] * ry + R[2][0] * rz,
          R[0][1] * rx + R[1][1] * ry + R[2][1] * rz,
          R[0][2] * rx + R[1][2] * ry + R[2][2] * rz,
        );
      };
      const DEPTH = 2.2;
      const cornerPts: THREE.Vector3[] = [];
      for (const [px, py] of [
        [0, 0], [imgW, 0], [imgW, imgH], [0, imgH],
      ] as const) {
        const d = rayWorld(px - imgW / 2, py - imgH / 2).normalize();
        cornerPts.push(C.clone().add(d.multiplyScalar(DEPTH)));
      }
      const frustumPts: THREE.Vector3[] = [];
      for (const cp of cornerPts) {
        frustumPts.push(C.clone(), cp);
      }
      for (let i = 0; i < 4; i++) {
        frustumPts.push(cornerPts[i], cornerPts[(i + 1) % 4]);
      }
      const frustum = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(frustumPts),
        new THREE.LineBasicMaterial({ color: 0xffd050 }),
      );
      this.group.add(frustum);

      // 相机位置标记
      const camMark = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffd050 }),
      );
      camMark.position.copy(C);
      this.group.add(camMark);

      // 光轴
      const axisEnd = C.clone().add(rayWorld(0, 0).normalize().multiplyScalar(DEPTH * 1.4));
      const axis = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([C.clone(), axisEnd]),
        new THREE.LineBasicMaterial({ color: 0xffd050 }),
      );
      this.group.add(axis);
    }
  }
}
