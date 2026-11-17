import * as THREE from 'three';
import type { LocalPose } from '../core/types';
import { BONE_NAMES } from '../core/skeleton';
import type { BoneName } from '../core/types';
import type { ProceduralCharacter } from './character';

/**
 * 把混合后的局部姿态写入 THREE.Bone 层级。
 * 每个 Bone 的 position/quaternion 都是相对父节点的局部量，
 * Three.js 沿骨架层级自动累乘 —— 父子关节的局部关系天然正确。
 */
export function applyPose(
  character: ProceduralCharacter,
  pose: LocalPose,
  rootZ: number,
): void {
  for (const name of BONE_NAMES) {
    const bone = character.bones.get(name)!;
    const t = pose.get(name)!;
    bone.quaternion.copy(t.quaternion);
    bone.position.copy(t.position);
  }
  // 根位移作用在整个角色组上（沿世界 +Z），不污染任何关节的局部位移
  character.root.position.set(0, 0, rootZ);
}

/**
 * 骨架叠加显示：在层级 Bone 的世界位置之间绘制线段与节点球，
 * 不是独立漂浮物 —— 每帧从 Bone 的世界矩阵读取位置。
 */
export class SkeletonOverlay {
  readonly group = new THREE.Group();
  private readonly lines: THREE.LineSegments;
  private readonly nodes: THREE.InstancedMesh;
  private readonly edgePairs: [BoneName, BoneName][];
  private readonly dummy = new THREE.Object3D();
  private selected: BoneName | null = null;
  private readonly selectedMarker: THREE.Mesh;

  constructor(private readonly character: ProceduralCharacter) {
    // 父子边列表
    this.edgePairs = [];
    for (const name of BONE_NAMES) {
      const bone = character.bones.get(name)!;
      if (bone.parent instanceof THREE.Bone) {
        this.edgePairs.push([bone.parent.name as BoneName, name]);
      }
    }

    const linePositions = new Float32Array(this.edgePairs.length * 2 * 3);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0x12243b, transparent: true, opacity: 0.9 });
    this.lines = new THREE.LineSegments(lineGeo, lineMat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);

    const nodeGeo = new THREE.SphereGeometry(0.018, 8, 8);
    const nodeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.nodes = new THREE.InstancedMesh(nodeGeo, nodeMat, BONE_NAMES.length);
    this.nodes.frustumCulled = false;
    this.group.add(this.nodes);

    this.selectedMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.9 }),
    );
    this.selectedMarker.visible = false;
    this.group.add(this.selectedMarker);

    this.group.visible = true;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  setSelected(name: BoneName | null): void {
    this.selected = name;
    this.selectedMarker.visible = name !== null;
  }

  get selectedBone(): BoneName | null {
    return this.selected;
  }

  /** 每帧从 Bone 世界矩阵刷新线条与节点 */
  update(): void {
    if (!this.group.visible) return;
    const posAttr = this.lines.geometry.attributes.position as THREE.BufferAttribute;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();

    this.edgePairs.forEach(([p, c], i) => {
      this.character.bones.get(p)!.getWorldPosition(a);
      this.character.bones.get(c)!.getWorldPosition(b);
      posAttr.setXYZ(i * 2, a.x, a.y, a.z);
      posAttr.setXYZ(i * 2 + 1, b.x, b.y, b.z);
    });
    posAttr.needsUpdate = true;

    BONE_NAMES.forEach((name, i) => {
      this.character.bones.get(name)!.getWorldPosition(a);
      this.dummy.position.copy(a);
      this.dummy.updateMatrix();
      this.nodes.setMatrixAt(i, this.dummy.matrix);
    });
    this.nodes.instanceMatrix.needsUpdate = true;

    if (this.selected) {
      this.character.bones.get(this.selected)!.getWorldPosition(a);
      this.selectedMarker.position.copy(a);
    }
  }
}
