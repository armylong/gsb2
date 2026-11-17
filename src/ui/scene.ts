import * as THREE from 'three';
import type { CameraSample } from '../core/types';

/** Procedural ground: grid texture plus axis lines, no external assets. */
export function createGround(): THREE.Group {
  const group = new THREE.Group();

  const grid = new THREE.GridHelper(80, 80, 0x3a4656, 0x222a34);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.85;
  grid.position.y = 0;
  group.add(grid);

  // Solid thin plane underneath so depth reads clearly.
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 0.95, metalness: 0 }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.02;
  plane.receiveShadow = true;
  group.add(plane);

  // World axes pinned at the origin: X red, Y green, Z blue.
  const axes = new THREE.AxesHelper(3);
  axes.position.y = 0.01;
  group.add(axes);

  return group;
}

/** A handful of reference objects at known positions for spatial reading. */
export function createReferenceObjects(): THREE.Group {
  const group = new THREE.Group();
  const placements: { pos: THREE.Vector3; color: number; geo: THREE.BufferGeometry }[] = [
    { pos: new THREE.Vector3(8, 1, 8), color: 0xff7676, geo: new THREE.BoxGeometry(2, 2, 2) },
    { pos: new THREE.Vector3(-9, 1.5, -6), color: 0x76b7ff, geo: new THREE.CylinderGeometry(1, 1, 3, 24) },
    { pos: new THREE.Vector3(0, 0.5, 12), color: 0xffd166, geo: new THREE.SphereGeometry(1, 24, 18) },
    { pos: new THREE.Vector3(12, 2, -10), color: 0x8ef0c8, geo: new THREE.ConeGeometry(1.2, 4, 24) },
    { pos: new THREE.Vector3(-14, 1, 10), color: 0xc79bff, geo: new THREE.TorusGeometry(1.2, 0.4, 16, 32) },
    { pos: new THREE.Vector3(4, 6, -14), color: 0xff9f43, geo: new THREE.BoxGeometry(1.6, 1.6, 1.6) },
  ];
  for (const { pos, color, geo } of placements) {
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15 }),
    );
    mesh.position.copy(pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    // Stem to the ground so height is readable against the grid.
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, pos.y, 8),
      new THREE.MeshStandardMaterial({ color: 0x44505e, roughness: 0.8 }),
    );
    stem.position.set(pos.x, pos.y / 2, pos.z);
    group.add(stem);
  }
  return group;
}

export function createLights(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(12, 22, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  group.add(sun);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
  fill.position.set(-14, 8, -12);
  group.add(fill);
  return group;
}

/** The editable camera path as a tube line. */
export class PathLine {
  readonly object = new THREE.Group();
  private line: THREE.Line;
  private readonly pointMeshes: THREE.Mesh[] = [];
  private readonly pointGroup = new THREE.Group();
  private closed = false;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 3), 3));
    this.line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0x4da3ff, linewidth: 2 }),
    );
    this.object.add(this.line);
    this.object.add(this.pointGroup);
  }

  /** Rebuild geometry and control-point handles from the current path. */
  update(points: THREE.Vector3[], closed: boolean, densePoints: THREE.Vector3[]): void {
    this.closed = closed;
    const posAttr = new THREE.BufferAttribute(
      new Float32Array(densePoints.flatMap((p) => [p.x, p.y, p.z])),
      3,
    );
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry();
    this.line.geometry.setAttribute('position', posAttr);
    if (closed) {
      this.line.geometry.setDrawRange(0, densePoints.length);
    }

    // Reuse / grow / shrink handle meshes.
    while (this.pointMeshes.length < points.length) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 18, 14),
        new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x553d00, roughness: 0.4 }),
      );
      m.userData.isControlPoint = true;
      m.userData.index = this.pointMeshes.length;
      this.pointMeshes.push(m);
      this.pointGroup.add(m);
    }
    while (this.pointMeshes.length > points.length) {
      const m = this.pointMeshes.pop()!;
      this.pointGroup.remove(m);
      m.geometry.dispose();
    }
    points.forEach((p, i) => {
      const m = this.pointMeshes[i];
      m.position.copy(p);
      m.userData.index = i;
    });
  }

  get controlPointMeshes(): THREE.Mesh[] {
    return this.pointMeshes;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** Movable look-at target marker. */
export class TargetMarker {
  readonly object: THREE.Mesh;
  constructor() {
    this.object = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 24, 18),
      new THREE.MeshStandardMaterial({
        color: 0xff6b6b,
        emissive: 0x661414,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.object.userData.isTarget = true;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.05, 10, 32),
      new THREE.MeshBasicMaterial({ color: 0xff6b6b }),
    );
    ring.rotation.x = Math.PI / 2;
    this.object.add(ring);
  }

  setPosition(p: THREE.Vector3): void {
    this.object.position.copy(p);
  }
}

/** Camera rig gizmo showing position + full orientation (right/up/backward). */
export class CameraGizmo {
  readonly object = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly arrowR: THREE.ArrowHelper;
  private readonly arrowU: THREE.ArrowHelper;
  private readonly arrowB: THREE.ArrowHelper;

  constructor() {
    this.body = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 0.9, 20),
      new THREE.MeshStandardMaterial({ color: 0x36d399, emissive: 0x0c3a2c, roughness: 0.35 }),
    );
    // Cone points +Y by default; rotate so it points along local -Z (view dir).
    this.body.rotation.x = -Math.PI / 2;
    this.object.add(this.body);

    // Local axes: +X red (right), +Y green (up), +Z blue (backward).
    this.arrowR = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1.1, 0xff5555, 0.22, 0.12);
    this.arrowU = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1.1, 0x55ff77, 0.22, 0.12);
    this.arrowB = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1.3, 0x5599ff, 0.26, 0.14);
    this.object.add(this.arrowR, this.arrowU, this.arrowB);
  }

  update(sample: CameraSample): void {
    this.object.position.copy(sample.position);
    this.object.quaternion.copy(sample.quaternion);
  }

  /** Visual cue that the target-coincidence hold is active. */
  setHeld(held: boolean): void {
    const mat = this.body.material as THREE.MeshStandardMaterial;
    mat.emissive.setHex(held ? 0x4a2d6e : 0x0c3a2c);
    mat.color.setHex(held ? 0xb388ff : 0x36d399);
  }
}
