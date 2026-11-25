import {
  ArrowHelper,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Skeleton } from '../core/skeleton';

export interface PuppetPalette {
  body: number;
  head: number;
  joint: number;
  emissive: number;
}

export const SOURCE_PALETTE: PuppetPalette = {
  body: 0xe8a87c,
  head: 0xf2c4a3,
  joint: 0xc26b3f,
  emissive: 0xffd166,
};

export const TARGET_PALETTE: PuppetPalette = {
  body: 0x7ca8d8,
  head: 0xa8c8ec,
  joint: 0x3f6fae,
  emissive: 0x66f0ff,
};

const HEAD_JOINTS = new Set(['head']);
const Y_AXIS = new Vector3(0, 1, 0);

/** 单只纸偶的程序几何：扁平纸片骨块 + 关节球 + 纸片头，所有几何每帧按骨架世界量同步 */
export class PuppetView {
  readonly group = new Group();
  private readonly skeleton: Skeleton;
  private readonly palette: PuppetPalette;
  private readonly bodyMat: MeshStandardMaterial;
  private readonly headMat: MeshStandardMaterial;
  private readonly jointMat: MeshStandardMaterial;
  private readonly jointMeshes = new Map<string, Mesh>();
  private readonly boneMeshes = new Map<string, Mesh>();
  private readonly gizmo = new Group();
  private readonly arrows: ArrowHelper[] = [];
  private readonly boneArrow: ArrowHelper;
  private selected: string | null = null;

  constructor(skeleton: Skeleton, palette: PuppetPalette) {
    this.skeleton = skeleton;
    this.palette = palette;
    this.bodyMat = new MeshStandardMaterial({
      color: palette.body,
      roughness: 0.85,
      metalness: 0,
      flatShading: true,
    });
    this.headMat = new MeshStandardMaterial({
      color: palette.head,
      roughness: 0.9,
      metalness: 0,
      flatShading: true,
    });
    this.jointMat = new MeshStandardMaterial({
      color: palette.joint,
      roughness: 0.6,
      metalness: 0,
      flatShading: true,
    });
    this.buildBones();
    this.buildJoints();
    this.boneArrow = new ArrowHelper(
      new Vector3(0, 1, 0),
      new Vector3(),
      0.22,
      0xffee44,
      0.05,
      0.03,
    );
    this.gizmo.visible = false;
    this.group.add(this.gizmo);
  }

  private buildBones(): void {
    for (let i = 1; i < this.skeleton.count; i++) {
      const name = this.skeleton.jointNames[i];
      const isHead = HEAD_JOINTS.has(name);
      const thickness = isHead ? 0.16 : 0.05;
      const geo = isHead
        ? new BoxGeometry(0.14, 1, 0.03)
        : new BoxGeometry(thickness, 1, thickness * 0.45);
      const mesh = new Mesh(geo, isHead ? this.headMat : this.bodyMat);
      this.boneMeshes.set(name, mesh);
      this.group.add(mesh);
    }
  }

  private buildJoints(): void {
    const geo = new SphereGeometry(0.028, 12, 10);
    for (const name of this.skeleton.jointNames) {
      const mesh = new Mesh(geo, this.jointMat);
      this.jointMeshes.set(name, mesh);
      this.group.add(mesh);
    }
  }

  /** 点击拾取用：关节名 -> 网格 */
  pickMeshes(): { name: string; mesh: Mesh }[] {
    return [...this.jointMeshes.entries()].map(([name, mesh]) => ({ name, mesh }));
  }

  setSelected(name: string | null): void {
    this.selected = name;
    this.gizmo.visible = name !== null;
    if (name === null) return;
    this.gizmo.clear();
    const idx = this.skeleton.jointIndex(name);
    const origin = this.skeleton.worldPos[idx];
    const q = this.skeleton.worldRot[idx];
    const make = (axis: Vector3, color: number, len = 0.16): ArrowHelper =>
      new ArrowHelper(axis.clone().applyQuaternion(q), origin.clone(), len, color, 0.04, 0.025);
    this.arrows.length = 0;
    this.arrows.push(make(new Vector3(1, 0, 0), 0xff4444));
    this.arrows.push(make(new Vector3(0, 1, 0), 0x44dd55));
    this.arrows.push(make(new Vector3(0, 0, 1), 0x4477ff));
    for (const a of this.arrows) this.gizmo.add(a);
    this.gizmo.add(this.boneArrow);
  }

  /** 每帧同步：骨长恒定取自静止骨架，位置/朝向取自当前世界姿势 */
  update(): void {
    const sk = this.skeleton;
    for (const [name, mesh] of this.boneMeshes) {
      const i = sk.jointIndex(name);
      const p = sk.parentIndex[i];
      const from = sk.worldPos[p];
      const to = sk.worldPos[i];
      const dir = to.clone().sub(from);
      const len = dir.length();
      mesh.position.copy(from).add(to).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(Y_AXIS, dir.normalize());
      mesh.scale.set(1, len, 1);
    }
    for (const [name, mesh] of this.jointMeshes) {
      mesh.position.copy(sk.worldPos[sk.jointIndex(name)]);
      const active = name === this.selected;
      mesh.scale.setScalar(active ? 1.7 : 1);
      const mat = mesh.material as MeshStandardMaterial;
      mat.emissive = new Color(active ? this.palette.emissive : 0x000000);
      mat.emissiveIntensity = active ? 0.9 : 0;
    }
    if (this.selected !== null) {
      const idx = sk.jointIndex(this.selected);
      this.boneArrow.position.copy(sk.worldPos[idx]);
      this.boneArrow.setDirection(sk.outgoingBoneCurrentDirection(this.selected));
    }
  }

  dispose(): void {
    this.group.clear();
    this.bodyMat.dispose();
    this.headMat.dispose();
    this.jointMat.dispose();
    for (const m of this.boneMeshes.values()) m.geometry.dispose();
    for (const m of this.jointMeshes.values()) m.geometry.dispose();
  }
}
