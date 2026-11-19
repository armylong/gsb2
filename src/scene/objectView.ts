import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { BoxDef, MaterialKind, TargetDef } from '../sim/types';

export const MATERIAL_COLORS: Record<MaterialKind, number> = {
  penetrable: 0x4ea1ff,
  reflective: 0xffb02e,
  blocking: 0xe63946,
};

function makeLabel(text: string): CSS2DObject {
  const div = document.createElement('div');
  div.textContent = text;
  div.style.cssText =
    'color:#d7dde8;background:rgba(13,17,23,0.78);padding:2px 7px;border-radius:6px;' +
    'font-size:11px;white-space:nowrap;border:1px solid #2a3140;pointer-events:none;';
  const label = new CSS2DObject(div);
  label.center.set(0.5, 1);
  return label;
}

/** 长方体视图: 实体半透明盒 + 边线, 同步位置/旋转/尺寸/材料。 */
export class BoxView {
  readonly def: BoxDef;
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private readonly edges: THREE.LineSegments;
  private readonly label: CSS2DObject;
  private readonly material: THREE.MeshStandardMaterial;

  constructor(def: BoxDef) {
    this.def = def;
    this.material = new THREE.MeshStandardMaterial({
      color: MATERIAL_COLORS[def.material.kind],
      transparent: true,
      opacity: def.material.kind === 'blocking' ? 0.72 : 0.38,
      roughness: 0.55,
      metalness: def.material.kind === 'reflective' ? 0.65 : 0.1,
    });
    const geo = new THREE.BoxGeometry(def.size.x, def.size.y, def.size.z);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.userData.objectId = def.id;

    this.edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );

    this.label = makeLabel(def.name);
    this.group.add(this.mesh, this.edges, this.label);
    this.syncTransform();
  }

  syncTransform(): void {
    this.group.position.copy(this.def.position);
    this.group.rotation.copy(this.def.rotation);
    const s = this.def.size;
    this.mesh.scale.set(s.x, s.y, s.z);
    this.edges.scale.set(s.x, s.y, s.z);
    this.label.position.set(0, s.y / 2 + 0.35, 0);
  }

  syncMaterial(): void {
    this.material.color.setHex(MATERIAL_COLORS[this.def.material.kind]);
    this.material.opacity = this.def.material.kind === 'blocking' ? 0.72 : 0.38;
    this.material.metalness = this.def.material.kind === 'reflective' ? 0.65 : 0.1;
    this.material.needsUpdate = true;
  }

  setHighlight(on: boolean): void {
    const edgeMat = this.edges.material as THREE.LineBasicMaterial;
    edgeMat.color.setHex(on ? 0x00ff9d : 0xffffff);
    this.material.emissive.setHex(on ? 0x114433 : 0x000000);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.edges.geometry.dispose();
    this.material.dispose();
    (this.edges.material as THREE.Material).dispose();
    this.label.element.remove();
  }
}

/** 靶面视图: 程序生成的环形靶贴图 + 细边框 + 正面法线箭头。 */
export class TargetView {
  readonly def: TargetDef;
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private readonly label: CSS2DObject;

  constructor(def: TargetDef) {
    this.def = def;
    const texture = makeTargetTexture();
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
    });
    const geo = new THREE.PlaneGeometry(def.size.x, def.size.y);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.userData.objectId = def.id;

    const borderPts = [
      new THREE.Vector3(-def.size.x / 2, -def.size.y / 2, 0),
      new THREE.Vector3(def.size.x / 2, -def.size.y / 2, 0),
      new THREE.Vector3(def.size.x / 2, def.size.y / 2, 0),
      new THREE.Vector3(-def.size.x / 2, def.size.y / 2, 0),
    ];
    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(borderPts),
      new THREE.LineBasicMaterial({ color: 0xffffff }),
    );

    const normalArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 0),
      Math.max(0.8, Math.min(def.size.x, def.size.y) * 0.3),
      0x00ff9d,
    );

    this.label = makeLabel(def.name);
    this.label.position.set(0, def.size.y / 2 + 0.35, 0);

    this.group.add(this.mesh, border, normalArrow, this.label);
    this.syncTransform();
  }

  syncTransform(): void {
    this.group.position.copy(this.def.position);
    this.group.rotation.copy(this.def.rotation);
  }

  setHighlight(on: boolean): void {
    const mat = this.mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = on ? 1 : 0.92;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.label.element.remove();
  }
}

/** 程序生成靶纸贴图: 同心圆 + 十字线, 全部 Canvas 绘制, 无外部素材。 */
function makeTargetTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4f1e8';
  ctx.fillRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const rings = [110, 92, 74, 56, 38, 20];
  rings.forEach((r, i) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 === 0 ? '#e63946' : '#f4f1e8';
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd23f';
  ctx.fill();
  ctx.strokeStyle = '#222';
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, 8);
  ctx.lineTo(cx, size - 8);
  ctx.moveTo(8, cy);
  ctx.lineTo(size - 8, cy);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
