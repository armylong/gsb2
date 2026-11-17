import * as THREE from 'three';
import {
  ArmParams,
  JointAngles,
  PEDESTAL_HEIGHT,
  deg2rad,
} from './kinematics';

const COLORS = {
  pedestal: 0x5b6472,
  base: 0x3d4450,
  link1: 0x4f9dde,
  link2: 0x53b987,
  link3: 0xe0a449,
  joint: 0xf0f3f7,
  end: 0xff5d73,
  axisX: 0xff5544,
  axisY: 0x55dd66,
  axisZ: 0x4499ff,
};

function makeLabel(text: string, color = '#ffffff'): THREE.Sprite {
  const pad = 10;
  const font = 'bold 26px system-ui, sans-serif';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = 40;
  canvas.width = w;
  canvas.height = h;
  const c2 = canvas.getContext('2d')!;
  c2.font = font;
  c2.fillStyle = 'rgba(16, 20, 27, 0.72)';
  c2.roundRect(0, 0, w, h, 8);
  c2.fill();
  c2.strokeStyle = 'rgba(255,255,255,0.25)';
  c2.lineWidth = 1;
  c2.roundRect(0.5, 0.5, w - 1, h - 1, 8);
  c2.stroke();
  c2.fillStyle = color;
  c2.textBaseline = 'middle';
  c2.fillText(text, pad, h / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(material);
  const scale = 0.0022;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.renderOrder = 20;
  return sprite;
}

function cylinderAlongX(radius: number, length: number, color: number): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radius, radius, length, 24);
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.45 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.z = -Math.PI / 2; // cylinder default axis is Y -> X
  mesh.castShadow = true;
  return mesh;
}

/**
 * Hierarchical robot arm. Every rotating part lives in its parent's frame:
 *
 * root (base transform, world Y yaw)
 *  └ j1Group (q1, Y axis)
 *     └ j2Group (q2, local Z axis), carries link1
 *        └ j3Group (q3, local Z axis), carries link2
 *           └ j4Group (q4, local Z axis), carries link3
 *              └ endGroup
 */
export class RobotArm {
  readonly root = new THREE.Group();
  private readonly j1Group = new THREE.Group();
  private readonly j2Group = new THREE.Group();
  private readonly j3Group = new THREE.Group();
  private readonly j4Group = new THREE.Group();
  private readonly endGroup = new THREE.Group();

  private readonly jointAxisArrows: THREE.ArrowHelper[] = [];
  private readonly localAxes = new THREE.Group();
  private readonly labels: THREE.Sprite[] = [];

  private params: ArmParams;
  private angles: JointAngles;

  constructor(params: ArmParams, angles: JointAngles) {
    this.params = params;
    this.angles = { ...angles };
    this.root.add(this.j1Group);
    this.j1Group.add(this.j2Group);
    this.j2Group.add(this.j3Group);
    this.j3Group.add(this.j4Group);
    this.j4Group.add(this.endGroup);
    this.buildMeshes();
    this.applyAngles();
  }

  getArmParams(): ArmParams {
    return this.params;
  }

  getAngles(): JointAngles {
    return { ...this.angles };
  }

  setAngles(a: JointAngles): void {
    this.angles = { ...a };
    this.applyAngles();
  }

  /** Rebuild all generated geometry after link-length changes (angles kept). */
  rebuild(params: ArmParams): void {
    this.params = params;
    this.disposeGenerated();
    this.buildMeshes();
    this.applyAngles();
  }

  setJointAxesVisible(visible: boolean): void {
    this.jointAxisArrows.forEach((a) => (a.visible = visible));
  }

  setLocalAxesVisible(visible: boolean): void {
    this.localAxes.visible = visible;
  }

  setLabelsVisible(visible: boolean): void {
    this.labels.forEach((l) => (l.visible = visible));
  }

  getEndWorldPosition(target = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateWorldMatrix(true, true);
    return this.endGroup.getWorldPosition(target);
  }

  getJointWorldPositions(): THREE.Vector3[] {
    this.root.updateWorldMatrix(true, true);
    return [this.j1Group, this.j2Group, this.j3Group, this.j4Group].map((g) =>
      g.getWorldPosition(new THREE.Vector3())
    );
  }

  getBaseWorldYaw(): number {
    // root.rotation.y is the only base orientation channel used.
    return THREE.MathUtils.radToDeg(this.root.rotation.y);
  }

  setBaseTransform(position: THREE.Vector3, yawDeg: number): void {
    this.root.position.copy(position);
    this.root.rotation.y = deg2rad(yawDeg);
  }

  private applyAngles(): void {
    this.j1Group.rotation.y = deg2rad(this.angles.q1);
    this.j2Group.rotation.z = deg2rad(this.angles.q2);
    this.j3Group.rotation.z = deg2rad(this.angles.q3);
    this.j4Group.rotation.z = deg2rad(this.angles.q4);
  }

  private disposeGenerated(): void {
    const groups = [this.j1Group, this.j2Group, this.j3Group, this.j4Group, this.endGroup];
    for (const g of groups) {
      this.disposeObject(g);
      g.children.length = 0;
    }
    this.disposeObject(this.root);
    // remove pedestal/labels/axes that were attached directly to root
    const keep = new Set<THREE.Object3D>([this.j1Group]);
    [...this.root.children].forEach((c) => {
      if (!keep.has(c)) this.root.remove(c);
    });
    this.jointAxisArrows.length = 0;
    this.labels.length = 0;
    this.disposeChildren(this.localAxes);
  }

  private disposeChildren(group: THREE.Object3D): void {
    [...group.children].forEach((c) => {
      this.disposeObject(c);
      group.remove(c);
    });
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
  }

  private buildMeshes(): void {
    const p = this.params;

    // J1 pivot sits on top of the pedestal; the whole rotating chain rises
    // with this group (must match PEDESTAL_HEIGHT used by the math FK).
    this.j1Group.position.set(0, PEDESTAL_HEIGHT, 0);

    // --- pedestal (fixed, attached to base root, not part of rotating chain) ---
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.14, PEDESTAL_HEIGHT, 32),
      new THREE.MeshStandardMaterial({ color: COLORS.pedestal, metalness: 0.3, roughness: 0.6 })
    );
    pedestal.position.y = PEDESTAL_HEIGHT / 2;
    pedestal.castShadow = true;
    this.root.add(pedestal);

    const basePlate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.17, 0.03, 32),
      new THREE.MeshStandardMaterial({ color: COLORS.base, metalness: 0.4, roughness: 0.5 })
    );
    basePlate.position.y = PEDESTAL_HEIGHT + 0.005;
    basePlate.castShadow = true;
    this.root.add(basePlate);

    // --- link 1: J2 frame -> J3 (child group positioned at link1 along X) ---
    const link1 = cylinderAlongX(0.045, p.link1, COLORS.link1);
    link1.position.x = p.link1 / 2;
    this.j2Group.add(link1);
    this.j3Group.position.set(p.link1, 0, 0);

    const link2 = cylinderAlongX(0.04, p.link2, COLORS.link2);
    link2.position.x = p.link2 / 2;
    this.j3Group.add(link2);
    this.j4Group.position.set(p.link2, 0, 0);

    const link3 = cylinderAlongX(0.035, p.link3, COLORS.link3);
    link3.position.x = p.link3 / 2;
    this.j4Group.add(link3);
    this.endGroup.position.set(p.link3, 0, 0);

    // --- joint markers ---
    const jointSphere = (r: number, color = COLORS.joint) =>
      new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 16),
        new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.35 })
      );

    const s1 = jointSphere(0.07);
    this.j1Group.add(s1);
    const s2 = jointSphere(0.06);
    this.j2Group.add(s2);
    const s3 = jointSphere(0.055);
    this.j3Group.add(s3);
    const s4 = jointSphere(0.05);
    this.j4Group.add(s4);

    // end-effector marker: sphere + short pointer
    const endSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 20, 14),
      new THREE.MeshStandardMaterial({
        color: COLORS.end,
        emissive: COLORS.end,
        emissiveIntensity: 0.45,
      })
    );
    this.endGroup.add(endSphere);
    const endPointer = new THREE.Mesh(
      new THREE.ConeGeometry(0.028, 0.09, 16),
      new THREE.MeshStandardMaterial({ color: COLORS.end, emissive: COLORS.end, emissiveIntensity: 0.3 })
    );
    endPointer.rotation.z = -Math.PI / 2;
    endPointer.position.x = 0.06;
    this.endGroup.add(endPointer);

    // --- joint axis arrows (each joint rotates around its own local axis) ---
    const axisLen = 0.2;
    const mkAxis = (
      parent: THREE.Object3D,
      dir: THREE.Vector3,
      color: number,
      origin = new THREE.Vector3()
    ) => {
      const arrow = new THREE.ArrowHelper(dir, origin, axisLen, color, 0.05, 0.03);
      (arrow as THREE.Object3D).renderOrder = 10;
      parent.add(arrow);
      this.jointAxisArrows.push(arrow);
    };
    mkAxis(this.j1Group, new THREE.Vector3(0, 1, 0), COLORS.axisY);
    mkAxis(this.j2Group, new THREE.Vector3(0, 0, 1), COLORS.axisZ);
    mkAxis(this.j3Group, new THREE.Vector3(0, 0, 1), COLORS.axisZ);
    mkAxis(this.j4Group, new THREE.Vector3(0, 0, 1), COLORS.axisZ);

    // --- local coordinate axes on the base frame ---
    const localAxisHelper = new THREE.AxesHelper(0.25);
    localAxisHelper.position.y = PEDESTAL_HEIGHT;
    this.localAxes.add(localAxisHelper);
    const localLabel = makeLabel('base local', '#9ad1ff');
    localLabel.position.set(0.28, PEDESTAL_HEIGHT, 0);
    this.localAxes.add(localLabel);
    this.root.add(this.localAxes);

    // --- text labels ---
    const l1 = makeLabel('J1 yaw');
    l1.position.set(0, 0.14, 0);
    this.j1Group.add(l1);
    const l2 = makeLabel('J2');
    l2.position.set(0, 0.12, 0);
    this.j2Group.add(l2);
    const l3 = makeLabel('J3');
    l3.position.set(0, 0.11, 0);
    this.j3Group.add(l3);
    const l4 = makeLabel('J4');
    l4.position.set(0, 0.1, 0);
    this.j4Group.add(l4);
    const endLabel = makeLabel('end', '#ff8ea0');
    endLabel.position.set(0.12, 0.07, 0);
    this.endGroup.add(endLabel);
    const baseLabel = makeLabel('base (world-movable)', '#ffc27d');
    baseLabel.position.set(0, 0.02, 0.22);
    this.root.add(baseLabel);
    this.labels.push(l1, l2, l3, l4, endLabel, baseLabel);
  }
}
